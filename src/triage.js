// Sorts each email into Needs you / Worth knowing / Noise, with the reasons in plain English.
// Pure functions: no files, no network, no clock (the caller passes `now`) and nothing here can
// change the mailbox. Deadlines arrive already found (src/dates.js runs in main); this file
// only weighs them.
//
// The safety rule: an email only becomes noise with positive evidence that it is bulk,
// automated or a promotion, or because the user chose "Always noise". Every protective signal
// (flagged, marked important, already replied, a person asking, an obligation deadline,
// a payment due, someone the user has written to) is checked first. Noise is only collapsed
// in the app, never deleted.

const { splitSentences } = require('./cleaner');

/**
 * @typedef {{ name: string, address: string }} Address  (addresses are lower-case)
 *
 * @typedef {object} MailHeaders  null on the email when the backend couldn't read them
 * @property {*} listUnsubscribe  truthy when the email has a List-Unsubscribe header
 * @property {*} listId  truthy when it has a List-Id header
 * @property {string|null} precedence  e.g. 'bulk', 'list', 'junk'
 * @property {string|null} autoSubmitted  e.g. 'auto-generated', 'no'
 *
 * @typedef {object} Deadline  (from src/dates.js findDeadlines)
 * @property {string} text  the words as written, e.g. 'Friday 6th November'
 * @property {string} sentence  the sentence it was found in
 * @property {'subject'|'ask'|'body'} source
 * @property {string|null} cue  the cue word before it, e.g. 'by', 'due'
 * @property {string} day  'YYYY-MM-DD'
 * @property {string|null} time  e.g. '10am'
 * @property {'day'|'week'|'month'} precision
 * @property {boolean} uncertain
 * @property {boolean} relative
 *
 * @typedef {object} TriageInput  the RawEmail v3 fields plus `cleaned` and `deadlines`
 * @property {string} id
 * @property {Address} from
 * @property {Address[]} to
 * @property {Address[]} cc
 * @property {string} subject
 * @property {string} date  when it was sent (ISO)
 * @property {string} receivedAt  when it arrived (ISO)
 * @property {boolean} seen
 * @property {boolean} flagged
 * @property {'low'|'normal'|'high'} importance
 * @property {boolean|null} focused  Outlook's Focused (true) / Other (false); null over IMAP
 * @property {MailHeaders|null} headers
 * @property {string|null} webLink
 * @property {{ body: string, questions: string[], actions: string[], amounts: string[], category: string, urgency: string }} cleaned
 *   what cleaner.clean() returned
 * @property {Deadline[]} deadlines
 *
 * @typedef {object} TriageContext
 * @property {number|Date} now
 * @property {string} [today]  'YYYY-MM-DD' (local) for now; worked out from now when missing
 * @property {Set<string>} me  the user's own addresses, lower-case
 * @property {Object<string, 'important'|'noise'>} rules  keyed by address or '@domain'
 * @property {Set<string>} notNoise  ids of emails the user marked Not noise
 * @property {(address: string) => number} wroteTo  how many times the user has written to them
 * @property {boolean} historyKnown  whether the Sent history could be read
 * @property {(input: TriageInput) => (string|number|null)} repliedAt  when the user last replied
 *   in this email's conversation, or null
 *
 * @typedef {object} TriageDeadline
 * @property {string} text
 * @property {string} day  'YYYY-MM-DD'
 * @property {string|null} time
 * @property {string} label  e.g. 'today', 'tomorrow', 'Fri 6 Nov', 'Sun 31 Jan 2027'
 * @property {number} daysAway  negative when it has passed
 * @property {boolean} uncertain
 *
 * @typedef {object} TriageResult
 * @property {'needs-you'|'worth-knowing'|'noise'} bucket
 * @property {string[]} reasons  plain English, the lead reason first (at most 3)
 * @property {string[]} codes  one code per reason (see REASON_TEXT)
 * @property {TriageDeadline|null} deadline
 * @property {string|null} caution
 */

const NEEDS = 'needs-you';
const WORTH = 'worth-knowing';
const NOISE = 'noise';
const BUCKETS = [NEEDS, WORTH, NOISE];

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MAX_TEXT = 20000; // characters of each body that are scanned (keeps big emails quick)

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Senders that never read replies, and automatic notification addresses.
const NOREPLY_RE = /(?:^|[-._+])(?:no[-_]?reply|do[-_]?not[-_]?reply)(?:[-._+@]|$)|^(?:notifications?|notify|alerts?|mailer(?:-daemon)?|bounces?)[-._+@]|@(?:mailer|notifications?|notify|alerts?|bounces?)\./i;
// Marketing copy. In bulk or automated mail these sentences never count as a deadline or a
// payment ("Today only: 30% off, ends midnight" is not something the user owes).
const MARKETING_RE = /\d\s?%\s?off\b|\b(?:sale|offer ends|today only|last chance|limited[- ]time|while stocks? lasts?|shop now|deals?|vouchers?)\b/i;
// What turns a date in bulk or automated mail into something the user has to do.
const OBLIGATION_RE = /\byour (?:payment|bill|tax|return|account|statement|renewal|policy|subscription|appointment|booking|order|application|card|direct debit|balance|invoice|coursework|assignment|exam)\b|\baction required\b|\byou (?:must|need to|have to|owe)\b|\b(?:payment|amount|balance) (?:is )?due\b|\bdue (?:on|by|in)\b|\boverdue\b|\bfinal (?:notice|reminder|demand)\b|\bwill be (?:taken|collected|charged|debited)\b|\bsubmit|\bhand in\b|\bregister by\b/i;
// Strong "you owe this" wording. Protects bulk or automated mail even when no date was found
// in it (a tax reminder must never become noise just because its date wasn't recognised).
const STRONG_OBLIGATION_RE = /\baction required\b|\bfinal (?:notice|reminder|demand)\b|\boverdue\b|\b(?:payment|amount|balance) (?:is )?(?:now )?due\b|\byou owe\b/i;
const MONEY_RE = /[£$€]\s?\d/;
// "due to high demand" means "because of", unless it's "the amount due to…".
const DUE_CUE_RE = /\bdue\b(?! to\b)|\b(?:amount|balance|payment|sum) due to\b|\b(?:owe[sd]?|overdue|pay by|minimum payment|direct debit|will be (?:taken|collected))\b/i;
// Subjects of security notices.
const SECURITY_RE = /\b(?:new sign[- ]?in|sign[- ]?in (?:attempt|alert|activity|request)|new (?:login|log[- ]in)|login (?:attempt|alert)|security (?:alert|notice|notification|warning|code|info(?:rmation)?)|verification code|password (?:reset|change|changed|updated)|reset your password|unusual (?:sign[- ]?in |login )?activity|suspicious (?:activity|sign[- ]?in|login))\b/i;
// One-time codes: "Your verification code is 482913", "482913 is your code".
const OTP_RE = /\b(?:(?:verification|security|sign[- ]?in|log[- ]?in|login|one[- ]time|authentication|access|confirmation|single[- ]use)\s+(?:code|passcode|pin)|passcode|otp)\b\D{0,40}?\b\d{4,8}\b|\b\d{4,8}\b is your (?:[\w-]+ ){0,3}(?:code|passcode|otp)\b/i;
const CODE_RE = /\bcode\b\D{0,40}?\b\d{4,8}\b/i; // a bare "code 1234" only counts in a security notice
// Asks to sign in, verify an account, give bank or card details, buy gift cards, change
// payment details, move money or pay.
const CAUTION_RE = new RegExp([
  String.raw`\b(?:sign|log) ?in (?:to|at|here|now)\b`,
  String.raw`\bverify (?:your )?(?:account|identity|email|details|information)\b`,
  String.raw`\b(?:enter|confirm|reset|update|change|send|give|share|provide) (?:us )?(?:your |the )?(?:password|passcode|pin)\b`,
  String.raw`\b(?:bank|card|payment|account) (?:details|information|info|number)\b`,
  String.raw`\bsort code\b|\bcvv\b|\bgift ?cards?\b`,
  String.raw`\b(?:transfer|send|wire|move) (?:the |some )?(?:money|funds|payment|deposit)\b|\b(?:bank|wire|money) transfer\b`,
  String.raw`\bpay (?:now|today|immediately|online|by|before|the|your|any|it|this|a|£|\$|€)`,
  String.raw`\b(?:minimum|outstanding) payment\b|\bpayment (?:is )?(?:due|required|overdue|needed)\b|\bmake (?:a|the|your) payment\b`,
].join('|'), 'i');

const CAUTION_TEXT = "Asks for a password, bank details or payment. Check it's genuine: go to the company's app or website yourself, not a link in the email.";

// Public webmail domains: an "Always noise" rule for the whole domain would hide real people.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'btinternet.com',
  'sky.com', 'virginmedia.com', 'talktalk.net', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
]);

/** Plain-English text for every reason code. Each takes the reason's details. */
const REASON_TEXT = {
  'flagged': (p) => (p.outlook ? 'Flagged in Outlook' : 'You flagged it'),
  'rule-important': (p) => `You marked ${p.name} as always important`,
  'rule-noise': () => 'You chose Always noise',
  'from-me': () => 'Sent from your own address',
  'replied': () => "You've already replied",
  'cc-only': () => "You're only CC'd",
  'group': (p) => `Sent to ${p.count} people`,
  'asks-action': () => 'Asks you to do something',
  'asks-question': () => 'Asks you a question',
  'urgent': () => "Says it's urgent",
  'deadline-soon': (p) => `Due ${p.label}${p.uncertain ? '?' : ''}`,
  'overdue': (p) => `Was due ${p.label}${p.uncertain ? '?' : ''}`,
  'deadline-later': (p) => `Deadline ${p.label}${p.uncertain ? '?' : ''}`,
  'deadline-past': (p) => `Was due ${p.label}${p.uncertain ? '?' : ''}`,
  'payment-due': (p) => (!p.label ? 'Payment due' : `${p.daysAway < 0 ? 'Payment was due' : 'Payment due'} ${p.label}${p.uncertain ? '?' : ''}`),
  'old-ask': (p) => `From ${p.weeks} weeks ago`,
  'obligation': () => 'Says you need to act',
  'security': () => 'Security alert about your account',
  'old-code': () => 'Old sign-in code (these expire quickly)',
  'known-contact': (p) => `You've written to them ${p.count === 1 ? 'once' : `${p.count} times`}`,
  'first-contact': () => "You haven't written to them before",
  'receipt': () => 'Receipt or order update',
  'promo': () => 'Promotion',
  'usually-read': () => 'A newsletter you usually open',
  'newsletter': (p) => (p.count >= 2 ? `Newsletter you haven't opened in ${p.count} emails` : 'Newsletter or mass email'),
  'outlook-other': () => 'Outlook filed it under Other',
  'ignored': (p) => `You haven't opened their last ${p.count} emails`,
  'automated': () => 'Sent automatically',
  'high-importance': () => 'Marked important by the sender',
  'not-noise': () => 'You marked it Not noise',
  'fyi': () => 'No question or request for you',
};

// Lead reasons that already say when it's due, so the deadline isn't repeated after them.
const DEADLINE_CODES = new Set(['deadline-soon', 'overdue', 'deadline-later', 'deadline-past', 'payment-due']);
const ASK_CODES = new Set(['asks-action', 'asks-question']);

// ---------- small helpers ----------

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value) return Date.parse(value);
  return NaN;
}

const pad = (n) => String(n).padStart(2, '0');

// The local calendar day of a time, as 'YYYY-MM-DD'.
function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' to a UTC midnight, or NaN for anything that isn't a real day.
function dayUTC(day) {
  const m = DAY_KEY_RE.exec(typeof day === 'string' ? day : '');
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : NaN;
}

// Whole days from one day key to another, worked out on UTC midnights so DST can't skew it.
function daysBetween(fromDay, toDay) {
  return Math.round((dayUTC(toDay) - dayUTC(fromDay)) / DAY);
}

function addressOf(a) {
  return a && typeof a.address === 'string' ? a.address.trim().toLowerCase() : '';
}

function addressList(list) {
  return (Array.isArray(list) ? list : []).map(addressOf).filter(Boolean);
}

// The sender's name for a reason line: it comes from the email, so it is kept short.
function displayName(a) {
  const name = a && typeof a.name === 'string' ? a.name.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim() : '';
  const shown = name || addressOf(a) || 'this sender';
  return shown.length > 60 ? `${shown.slice(0, 59)}…` : shown;
}

const textOf = (v) => (typeof v === 'string' ? v : '');
const listOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

// When the email arrived: receivedAt, else the sent date, else now (so it still sorts sensibly).
function receivedTime(input, now) {
  const t = toMs(input && (input.receivedAt || input.date));
  return Number.isNaN(t) ? now : t;
}

/**
 * The deadline's day as people say it: 'today', 'tomorrow', 'yesterday', 'Fri 6 Nov', or with
 * the year when it isn't this year ('Sun 31 Jan 2027'). Week and month deadlines read
 * 'the week of Mon 9 Nov' and 'in March' / 'end of March'.
 */
function deadlineLabel(d, today) {
  const t = dayUTC(d.day);
  const date = new Date(t);
  const year = date.getUTCFullYear();
  const yearPart = String(year) === String(today).slice(0, 4) ? '' : ` ${year}`;
  const short = (x) => `${SHORT_DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${SHORT_MONTHS[x.getUTCMonth()]}`;
  if (d.precision === 'month') {
    const last = new Date(Date.UTC(year, date.getUTCMonth() + 1, 0)).getUTCDate();
    return `${date.getUTCDate() === last ? 'end of' : 'in'} ${MONTHS[date.getUTCMonth()]}${yearPart}`;
  }
  if (d.precision === 'week') return `the week of ${short(date)}${yearPart}`;
  const n = daysBetween(today, d.day);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return `${short(date)}${yearPart}`;
}

// ---------- context and rules ----------

function toSet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  if (v && typeof v === 'object') return new Set(Object.keys(v));
  return new Set();
}

const PREPARED = Symbol('prepared');

// Fills in anything missing, so a partial context never throws.
function prepareContext(ctx = {}) {
  if (ctx && ctx[PREPARED]) return ctx;
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  let now = toMs(c.now);
  if (Number.isNaN(now)) now = Date.now();
  const today = DAY_KEY_RE.test(c.today || '') ? c.today : localDayKey(now);
  const me = new Set([...toSet(c.me)].map((a) => String(a).trim().toLowerCase()).filter(Boolean));
  const rules = c.rules instanceof Map ? Object.fromEntries(c.rules) : c.rules && typeof c.rules === 'object' ? c.rules : {};
  const call = (fn, arg, fallback) => {
    if (typeof fn !== 'function') return fallback;
    try {
      return fn(arg);
    } catch {
      return fallback;
    }
  };
  return {
    [PREPARED]: true,
    now,
    today,
    me,
    rules,
    notNoise: toSet(c.notNoise),
    historyKnown: c.historyKnown === true,
    wroteTo: (addr) => {
      const n = Number(call(c.wroteTo, addr, 0));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    },
    repliedAt: (input) => call(c.repliedAt, input, null),
  };
}

/**
 * Whether a key can be stored as a sorting rule: a lower-case email address, or '@domain'.
 * Whole-domain rules for public webmail (gmail.com, outlook.com…) are refused, because they
 * would sweep up every person on that service.
 */
function isValidRuleKey(key) {
  if (typeof key !== 'string' || key.length > 254 || key !== key.trim().toLowerCase()) return false;
  if (/[\s\u0000-\u001f\u007f<>"',;]/.test(key)) return false;
  if (key.startsWith('@')) {
    const domain = key.slice(1);
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain) && !FREEMAIL.has(domain);
  }
  return /^[^@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(key);
}

// The user's rule for this sender: the address rule wins over a rule for the whole domain.
function senderRule(addr, rules) {
  if (!addr) return null;
  const pick = (key) => (Object.hasOwn(rules, key) && (rules[key] === 'important' || rules[key] === 'noise') ? rules[key] : null);
  const own = pick(addr);
  if (own) return { rule: own, key: addr };
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  const forDomain = domain ? pick(`@${domain}`) : null;
  return forDomain ? { rule: forDomain, key: `@${domain}` } : null;
}

// ---------- signals ----------

function headerText(v) {
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (Array.isArray(v)) return v.length ? headerText(v[0]) : '';
  return '';
}

// Everything the rules look at, worked out once per email.
function signals(input, c, stats) {
  const m = input && typeof input === 'object' ? input : {};
  const cleaned = m.cleaned && typeof m.cleaned === 'object' ? m.cleaned : {};
  const from = addressOf(m.from);
  const subject = textOf(m.subject);
  const body = (textOf(cleaned.body) || textOf(m.text)).slice(0, MAX_TEXT);
  const category = textOf(cleaned.category) || 'person';
  const headers = m.headers && typeof m.headers === 'object' ? m.headers : {};

  const to = addressList(m.to);
  const cc = addressList(m.cc);
  const overlaps = (list) => list.some((a) => c.me.has(a));
  const addressing = overlaps(to) ? 'to' : overlaps(cc) ? 'cc' : 'unknown';
  const recipients = new Set([...to, ...cc]).size;

  const precedence = headerText(headers.precedence);
  const autoSubmitted = headerText(headers.autoSubmitted);
  const isBulk = Boolean(headers.listUnsubscribe) || Boolean(headers.listId)
    || ['bulk', 'list', 'junk'].includes(precedence) || category === 'newsletter' || category === 'promo';
  const isAutomated = autoSubmitted.startsWith('auto-') || category === 'notification' || category === 'receipt' || NOREPLY_RE.test(from);
  const isPerson = !isBulk && !isAutomated;

  // Marketing sentences are only ignored in bulk or automated mail; a person's words all count.
  const sentences = [subject, ...splitSentences(body)].filter(Boolean);
  const counted = isPerson ? sentences : sentences.filter((s) => !MARKETING_RE.test(s));
  const moneyDue = counted.some((s) => MONEY_RE.test(s) && DUE_CUE_RE.test(s));
  const obligation = !isPerson && counted.some((s) => STRONG_OBLIGATION_RE.test(s));

  // Deadlines: a person's needs a cue word or to sit inside an ask; bulk or automated mail's
  // needs obligation wording ("your tax return", "payment due") and no marketing.
  const qualifying = [];
  for (const d of Array.isArray(m.deadlines) ? m.deadlines : []) {
    if (!d || typeof d !== 'object' || Number.isNaN(dayUTC(d.day))) continue;
    if (isPerson) {
      if (!(d.cue || d.source === 'ask')) continue;
    } else {
      const sentence = textOf(d.sentence) || (d.source === 'subject' ? subject : '');
      if (!OBLIGATION_RE.test(sentence) || MARKETING_RE.test(sentence)) continue;
    }
    qualifying.push({ d, daysAway: daysBetween(c.today, d.day) });
  }
  const byDay = (a, b) => a.daysAway - b.daysAway || Number(Boolean(a.d.uncertain)) - Number(Boolean(b.d.uncertain));
  const current = qualifying.filter((q) => q.daysAway >= -14).sort(byDay)[0] || null;
  const past = qualifying.filter((q) => q.daysAway < -14).sort(byDay).pop() || null;
  const describe = (q) => q && {
    text: textOf(q.d.text),
    day: q.d.day,
    time: typeof q.d.time === 'string' && q.d.time ? q.d.time : null,
    label: deadlineLabel(q.d, c.today),
    daysAway: q.daysAway,
    uncertain: q.d.uncertain === true,
  };

  const questions = isPerson ? listOf(cleaned.questions) : [];
  const actions = isPerson ? listOf(cleaned.actions) : [];
  const received = receivedTime(m, c.now);
  const ageMs = Math.max(0, c.now - received);
  const replied = toMs(c.repliedAt(m));
  const st = (stats instanceof Map && stats.get(from)) || null;
  const all = `${subject}\n${body}`;
  const security = SECURITY_RE.test(subject);
  const wrote = c.wroteTo(from);
  const fromMe = Boolean(from) && c.me.has(from);

  return {
    id: m.id,
    from,
    fromName: displayName(m.from),
    flagged: m.flagged === true,
    outlook: typeof m.focused === 'boolean' || Boolean(m.webLink),
    rule: senderRule(from, c.rules),
    notNoise: m.id != null && c.notNoise.has(m.id),
    fromMe,
    replied: !Number.isNaN(replied) && replied > received,
    addressing,
    recipients,
    group: recipients > 10 && addressing !== 'cc',
    isBulk,
    isAutomated,
    isPerson,
    questions: questions.length > 0,
    actions: actions.length > 0,
    asks: questions.length > 0 || actions.length > 0,
    urgent: textOf(cleaned.urgency) === 'high',
    deadline: describe(current),
    pastDeadline: describe(past),
    moneyDue,
    obligation,
    ageMs,
    receipt: category === 'receipt',
    promo: category === 'promo',
    security,
    otp: OTP_RE.test(all) || (security && CODE_RE.test(all)),
    focused: typeof m.focused === 'boolean' ? m.focused : null,
    importance: textOf(m.importance).toLowerCase(),
    wrote,
    historyKnown: c.historyKnown,
    usuallyRead: Boolean(st && st.usuallyRead),
    ignored: Boolean(st && st.ignored),
    unreadRun: st ? st.unreadRun : m.seen === true ? 0 : 1,
    caution: wrote === 0 && !fromMe && CAUTION_RE.test(all) ? CAUTION_TEXT : null,
  };
}

const inRange = (d, lo, hi) => Boolean(d) && d.daysAway >= lo && d.daysAway <= hi;
const dueCode = (d) => (d.daysAway < 0 ? 'overdue' : d.daysAway <= 14 ? 'deadline-soon' : 'deadline-later');

// The ordered rules: the first that matches decides the bucket and the lead reason.
// Rules that would make it noise are skipped for an email the user marked Not noise.
function decide(s) {
  const noiseOk = !s.notNoise;
  if (s.flagged) return [NEEDS, 'flagged'];                                                    // 1
  if (s.rule && s.rule.rule === 'important') return [NEEDS, 'rule-important'];                 // 2
  if (s.rule && s.rule.rule === 'noise' && noiseOk) return [NOISE, 'rule-noise'];              // 3
  if (s.fromMe) return [WORTH, 'from-me'];                                                     // 4
  if (s.replied) return [WORTH, 'replied'];                                                    // 5
  if (s.isPerson && s.addressing === 'cc' && (s.asks || s.deadline)) return [WORTH, 'cc-only']; // 6
  if (s.isPerson && s.group && s.asks && !(s.deadline && s.deadline.daysAway <= 7)) return [WORTH, 'group']; // 7
  if (s.isPerson && s.ageMs <= 14 * DAY && (s.asks || inRange(s.deadline, -3, 7) || s.urgent)) { // 8
    if (s.actions) return [NEEDS, 'asks-action'];
    if (s.questions) return [NEEDS, 'asks-question'];
    return [NEEDS, inRange(s.deadline, -3, 7) ? dueCode(s.deadline) : 'urgent'];
  }
  if (s.isPerson && s.asks && s.ageMs > 14 * DAY) return [WORTH, 'old-ask'];                     // 9
  if (!s.isPerson && s.deadline && s.deadline.daysAway <= 14) {                                 // 10
    return [NEEDS, s.moneyDue ? 'payment-due' : dueCode(s.deadline)];
  }
  // 11: a payment with no date, or one within the next two weeks (a later one moves up as it nears)
  if (!s.isPerson && s.moneyDue && !(s.deadline && s.deadline.daysAway > 14)) return [NEEDS, 'payment-due'];
  // 12: a deadline further off, or one that passed more than two weeks ago (still never noise)
  if (!s.isPerson && inRange(s.deadline, 15, 400)) return [WORTH, 'deadline-later'];
  if (!s.isPerson && !s.deadline && s.pastDeadline) return [WORTH, 'deadline-past'];
  // 12b (added): "action required", "overdue", "you owe"… with no usable date: never noise
  if (!s.isPerson && s.obligation) return [WORTH, 'obligation'];
  if (!s.isPerson && s.security && s.ageMs <= 2 * DAY) return [WORTH, 'security'];             // 13
  if (!s.isPerson && s.otp && s.ageMs > DAY && noiseOk) return [NOISE, 'old-code'];             // 14
  if (s.wrote > 0) return [WORTH, 'known-contact'];                                            // 15
  if (s.receipt) return [WORTH, 'receipt'];                                                    // 16
  if (s.promo && noiseOk) return [NOISE, 'promo'];                                             // 17
  if (s.isBulk && s.usuallyRead) return [WORTH, 'usually-read'];                               // 18
  if (s.isBulk && noiseOk) return [NOISE, 'newsletter'];                                       // 19
  if (s.isAutomated && s.focused === false && noiseOk) return [NOISE, 'outlook-other'];         // 20
  if (s.isAutomated && s.ignored && noiseOk) return [NOISE, 'ignored'];                        // 21
  if (s.isAutomated) return [WORTH, s.notNoise ? 'not-noise' : 'automated'];                    // 22
  return [WORTH, s.notNoise && !s.isPerson ? 'not-noise' : 'fyi'];                             // 23
}

// The details each reason's text needs.
function params(code, s) {
  switch (code) {
    case 'flagged': return { outlook: s.outlook };
    case 'rule-important': return { name: s.rule.key.startsWith('@') ? `everyone at ${s.rule.key.slice(1)}` : s.fromName };
    case 'group': return { count: s.recipients };
    case 'deadline-soon': case 'overdue': case 'deadline-later': return s.deadline || {};
    case 'deadline-past': return s.pastDeadline || {};
    case 'payment-due': return s.deadline || {};
    case 'old-ask': return { weeks: Math.max(2, Math.floor(s.ageMs / (7 * DAY))) };
    case 'known-contact': return { count: s.wrote };
    case 'newsletter': case 'ignored': return { count: s.unreadRun };
    default: return {};
  }
}

// Up to two supporting reasons after the lead, in this order: the deadline, what they ask,
// whether the user knows them, CC, ignored, marked important, filed under Other.
function supporting(s, lead) {
  const out = [];
  const add = (code) => {
    if (code !== lead && !out.includes(code)) out.push(code);
  };
  if (s.deadline && !DEADLINE_CODES.has(lead)) add(dueCode(s.deadline));
  // After "You've already replied", "You're only CC'd" or "Sent to 20 people" the ask isn't really for the user.
  if (s.asks && !ASK_CODES.has(lead) && !['replied', 'cc-only', 'group'].includes(lead)) add(s.actions ? 'asks-action' : 'asks-question');
  if (s.wrote > 0) add('known-contact');
  else if (s.isPerson && s.historyKnown) add('first-contact');
  if (s.addressing === 'cc') add('cc-only');
  if (s.ignored && lead !== 'newsletter') add('ignored');
  if (s.importance === 'high') add('high-importance');
  if (s.focused === false) add('outlook-other');
  return out.slice(0, 2);
}

/**
 * Sorts one email.
 * @param {TriageInput} input
 * @param {TriageContext} ctx
 * @param {Map<string, object>} [stats]  from senderStats() over the whole loaded inbox
 * @returns {TriageResult}
 */
function triage(input, ctx, stats) {
  const c = prepareContext(ctx);
  const s = signals(input, c, stats);
  const [bucket, lead] = decide(s);
  const codes = [lead, ...supporting(s, lead)];
  return {
    bucket,
    reasons: codes.map((code) => REASON_TEXT[code](params(code, s))),
    codes,
    deadline: s.deadline,
    caution: s.caution,
  };
}

/**
 * Per-sender read pattern across the loaded emails. Only emails older than 24 hours count
 * towards "ignored" and "usually read", so a newsletter that arrived this morning doesn't.
 * @returns {Map<string, {total: number, older: number, read: number, unreadRun: number, ignored: boolean, usuallyRead: boolean}>}
 *   keyed by lower-case sender address. unreadRun counts unread emails back from the newest.
 */
function senderStats(inputs, now) {
  let t = toMs(now);
  if (Number.isNaN(t)) t = Date.now();
  const bySender = new Map();
  for (const m of Array.isArray(inputs) ? inputs : []) {
    const addr = addressOf(m && m.from);
    if (!addr) continue;
    if (!bySender.has(addr)) bySender.set(addr, []);
    bySender.get(addr).push({ time: receivedTime(m, t), seen: m.seen === true });
  }
  const unreadRun = (list) => {
    let n = 0;
    while (n < list.length && !list[n].seen) n++;
    return n;
  };
  const stats = new Map();
  for (const [addr, list] of bySender) {
    list.sort((a, b) => b.time - a.time);
    const older = list.filter((e) => t - e.time > DAY);
    const read = older.filter((e) => e.seen).length;
    stats.set(addr, {
      total: list.length,
      older: older.length,
      read,
      unreadRun: unreadRun(list),
      ignored: unreadRun(older) >= 3,
      usuallyRead: older.length >= 3 && read / older.length >= 0.5,
    });
  }
  return stats;
}

/**
 * Sorts every loaded email.
 * @param {TriageInput[]} inputs
 * @param {TriageContext} ctx
 * @returns {Map<string, TriageResult>} keyed by email id
 */
function triageAll(inputs, ctx) {
  const c = prepareContext(ctx);
  const list = Array.isArray(inputs) ? inputs.filter((m) => m && m.id != null) : [];
  const stats = senderStats(list, c.now);
  const results = new Map();
  for (const m of list) {
    if (!results.has(m.id)) results.set(m.id, triage(m, c, stats));
  }
  return results;
}

/**
 * Orders the emails of one bucket for display. Items carry `triage` (a TriageResult) and
 * `receivedAt` or `date`; Worth knowing also uses `isNew`, Needs you uses `flagged` (or the
 * flagged reason). Returns a new array.
 * - Needs you: overdue, then the soonest deadline, then flagged, then newest.
 * - Worth knowing: new since the last brief, then newest.
 * - Noise: grouped by sender (the group with the newest email first), newest first in each.
 */
function sortBucket(items, bucket) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const time = (it) => {
    const t = toMs(it.receivedAt || it.date);
    return Number.isNaN(t) ? 0 : t;
  };
  const newest = (a, b) => time(b) - time(a);
  const triageOf = (it) => (it.triage && typeof it.triage === 'object' ? it.triage : {});
  if (bucket === NEEDS) {
    const away = (it) => (triageOf(it).deadline && Number.isFinite(triageOf(it).deadline.daysAway) ? triageOf(it).deadline.daysAway : null);
    const flagged = (it) => it.flagged === true || (Array.isArray(triageOf(it).codes) && triageOf(it).codes.includes('flagged'));
    return list.slice().sort((a, b) => {
      const [da, db] = [away(a), away(b)];
      if ((da === null) !== (db === null)) return da === null ? 1 : -1;
      if (da !== null && da !== db) return da - db;
      if (flagged(a) !== flagged(b)) return flagged(a) ? -1 : 1;
      return newest(a, b);
    });
  }
  if (bucket === NOISE) {
    const sender = (it) => addressOf(it.from) || displayName(it.from);
    const latest = new Map();
    for (const it of list) latest.set(sender(it), Math.max(latest.get(sender(it)) ?? -Infinity, time(it)));
    return list.slice().sort((a, b) => {
      const [ga, gb] = [sender(a), sender(b)];
      if (ga !== gb) return latest.get(gb) - latest.get(ga) || (ga < gb ? -1 : 1);
      return newest(a, b);
    });
  }
  return list.slice().sort((a, b) => Number(b.isNew === true) - Number(a.isNew === true) || newest(a, b));
}

module.exports = {
  triage,
  triageAll,
  senderStats,
  sortBucket,
  REASON_TEXT,
  isValidRuleKey,
  BUCKETS,
  CAUTION_TEXT,
  deadlineLabel,
  daysBetween,
};
