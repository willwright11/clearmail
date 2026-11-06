// Finds the dates in an email and works out which of them are deadlines. Pure: no clock
// (the caller passes the email's sent date as `ref`), no files, no network, and nothing
// beyond cleaner.js. Days are local calendar days ('YYYY-MM-DD'), always built with
// new Date(y, m, d), so a clock change can never move a date onto the wrong day.
//
// When unsure it says so (`uncertain: true`) rather than guessing quietly, and a date only
// counts as a deadline when the words around it say so ("by", "due", "deadline"…) or it
// sits inside something the sender asked the user to do.

const { DATE_SOURCE, realDate, splitSentences } = require('./cleaner');

/**
 * @typedef {object} Deadline
 * @property {string} text  the date as written, without a leading 'by'/'on'/'in'
 *   ('Friday 6th November', 'end of the week', 'within 28 days')
 * @property {string} sentence  the sentence it was found in
 * @property {'subject'|'ask'|'body'} source  'ask' when the sentence is one of the email's
 *   questions or actions (cleaner.clean())
 * @property {string|null} cue  the deadline word, e.g. 'by', 'due', 'deadline', or null
 *   when the date only counts because it sits inside an ask
 * @property {string} day  'YYYY-MM-DD' (local)
 * @property {string|null} time  e.g. '10am' or '12 noon', when one is written next to the date
 *   ("Wednesday at 10am", "no later than 5pm on 10 November")
 * @property {'day'|'week'|'month'} precision  'week': "next week" (day is the Monday);
 *   'month': "in December", "next month" (day is the 1st, 15th or last day)
 * @property {boolean} uncertain  a guess: "next Friday", a weekday that doesn't match the
 *   date, a weekday that is the same as the day the email was sent, "by the 15th" (which
 *   month?), or "within 28 days" in a forwarded message whose date isn't known
 * @property {boolean} relative  worked out from the sent date ("within 28 days")
 *
 * @typedef {object} FoundDate  what findDates() returns: a Deadline's date fields plus
 * @property {number} index  where the date starts in the sentence
 * @property {boolean} past  it reads as something that already happened ("we met on Friday")
 */

const DAY_MS = 86_400_000;
const MAX_BODY = 20_000; // characters of the body that are searched
const MAX_SENTENCE = 2_000;
const MAX_ASKS = 50;

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, twenty: 20, thirty: 30,
};

// The cleaner's date finder (shared, so the dates the app shows and the deadlines agree).
// matchAll() copies a global regex, so this one's lastIndex is never shared state.
const DATE_RE = new RegExp(DATE_SOURCE, 'g');
// "in 3 days", "within 28 days", "within two working days", "in a fortnight"
const RELATIVE_RE = new RegExp(
  `\\b(in|within)[ \\t]+(?:the[ \\t]+next[ \\t]+)?(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})[ \\t]+((?:working|business)[ \\t]+days?|days?|weeks?|fortnights?|months?)\\b`,
  'gi',
);
const TIME = String.raw`(\d{1,2}(?:[:.]\d{2})?[ \t]?(?:[ap]\.?m\b\.?)|\d{1,2}:\d{2}\b|(?:12[ \t]+)?(?:noon|midday|midnight)\b)`;
const TIME_AFTER = new RegExp(String.raw`^,?[ \t]+(?:(?:at|by|before|after|from|around|for|until|till)[ \t]+)?${TIME}`, 'i');
// A time just before the date ("5pm on 10 November", "at 12 noon on Friday"). It is the
// deadline's time, and the cue word is looked for before it ("no later than 5pm on…").
const TIME_BEFORE = new RegExp(String.raw`(?<![^ \t(])(?:at[ \t]+)?${TIME}(?:[ \t]+on)?,?[ \t]+$`, 'i');
const YEAR_AFTER = /^,?[ \t]+(\d{4})\b/;

// Words that make a date a deadline when they come in the 4 words before it.
const CUE_WORDS = new Set([
  'by', 'before', 'due', 'deadline', 'deadlines', 'until', 'till', 'within', 'expires', 'expire', 'expiring',
  'expiry', 'closes', 'close', 'closing', 'must', 'submit', 'pay', 'payable', 'reply', 'respond', 'confirm',
  'return', 'appeal', 'renew',
]);
// "I'm away until Monday" or "closed until Friday" describe a state, not something to do.
const STATE_BEFORE_UNTIL = /\b(?:away|off|closed|shut|out|leave|holiday|holidays|unavailable|offline|abroad|there|here|working|busy|staying|site)[ \t,]*$/i;
// Things that already happened: "we met on Friday", "the parcel I sent on Monday".
const PAST_RE = /\b(?:had|was|were|did|went|met|sent|spoke|saw|came|got|gave|took|made|said|told|wrote|rang|called|looked|discussed|visited|finished|started|arrived|received|delivered|happened|left|agreed|mentioned|attended|ordered|bought|paid|asked|emailed|posted|completed|collected|replied|ago|yesterday)\b/i;
const FUTURE_RE = /\b(?:will|shall|going to|can|could|would|should|must|need|needs|please|next|coming|upcoming|due)\b|'ll\b|’ll\b/i;
// Where clauses start (the last one before a date is the date's own clause).
const CLAUSE_BREAKS = /,(?!\d)|[;:()—–]|\s-\s|\b(?:and|but|so|because|then|which|while|whereas|or)\b/gi;

// ---------- days ----------

const pad = (n) => String(n).padStart(2, '0');
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDate(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 'YYYY-MM-DD' as a UTC midnight, or NaN when it isn't a real day.
function utcOf(key) {
  const m = DAY_KEY_RE.exec(typeof key === 'string' ? key : '');
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : NaN;
}

/**
 * The local calendar day of a Date, a timestamp or an ISO string, as 'YYYY-MM-DD'.
 * A 'YYYY-MM-DD' string is returned as it is (if it is a real day). Anything else: null.
 */
function dayKey(value) {
  if (typeof value === 'string' && DAY_KEY_RE.test(value)) return Number.isNaN(utcOf(value)) ? null : value;
  const d = toDate(value);
  return d ? keyOf(d) : null;
}

/** Whole days from one day to another (negative when `to` is earlier); NaN if either is invalid. */
function daysBetween(from, to) {
  const a = utcOf(dayKey(from));
  const b = utcOf(dayKey(to));
  return Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.round((b - a) / DAY_MS);
}

/**
 * A day as people say it: 'today', 'tomorrow', 'yesterday', 'Fri 6 Nov', or with the year
 * when it isn't this year ('Sun 31 Jan 2027'). '' for an invalid day.
 */
function formatDay(day, today = Date.now()) {
  const key = dayKey(day);
  if (!key) return '';
  const now = dayKey(today);
  const n = now ? daysBetween(now, key) : NaN;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  const u = new Date(utcOf(key));
  const text = `${SHORT_DAYS[u.getUTCDay()]} ${u.getUTCDate()} ${SHORT_MONTHS[u.getUTCMonth()]}`;
  return now && now.slice(0, 4) === key.slice(0, 4) ? text : `${text} ${key.slice(0, 4)}`;
}

/** 'mdy' for locales that write the month first (en-US and a few others), else 'dmy'. */
function orderForLocale(locale) {
  return /^(?:en-(?:US|PH|AS|GU|MP|PR|UM|VI)|es-US)\b/i.test(String(locale || '')) ? 'mdy' : 'dmy';
}

// A real local day, or null (31 February, month 13…).
function makeDay(y, m, d) {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

const addDays = (base, n) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);

function addMonths(base, n) {
  const last = new Date(base.getFullYear(), base.getMonth() + n + 1, 0).getDate();
  return new Date(base.getFullYear(), base.getMonth() + n, Math.min(base.getDate(), last));
}

function addWorkingDays(base, n) {
  let d = base;
  for (let left = n; left > 0;) {
    d = addDays(d, 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
}

// A day and month with no year: the year that puts it within 60 days before to 305 days
// after the email was sent.
function nearestYear(ref, m, d) {
  const lo = addDays(ref, -60);
  const hi = addDays(ref, 305);
  for (const y of [ref.getFullYear() - 1, ref.getFullYear(), ref.getFullYear() + 1]) {
    const dt = makeDay(y, m, d);
    if (dt && dt >= lo && dt <= hi) return dt;
  }
  return null;
}

// An explicit year far from the sent date is a reference number, not a deadline.
const plausibleYear = (y, ref) => y >= ref.getFullYear() - 5 && y <= ref.getFullYear() + 20;

const monthOf = (word) => {
  const w = String(word || '').toLowerCase();
  const i = MONTH_INDEX[w.slice(0, 3)];
  return i === undefined || !/^[a-z]+$/.test(w) ? -1 : i;
};
const WEEKDAY_WORD = /^(?:mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thu(?:rs?)?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i;
const weekdayOf = (word) => (WEEKDAY_WORD.test(String(word || '')) ? DAY_INDEX[String(word).toLowerCase().slice(0, 3)] : -1);

// ---------- reading one date ----------

const RELATIVE_WORD = /^(today|tonight|tomorrow|this weekend|this week|this morning|this afternoon|this evening|next week|next month|end of (?:the )?day|end of (?:the )?week|end of (?:the )?month|eod|eow|cob)$/i;
const WEEKDAY_FORM = /^(?:(this|next|on|by|before|until|till|from)[ \t]+)?([a-z]+)\.?(?:,?[ \t]+(\d{1,2})(?:st|nd|rd|th)?(?:[ \t]+(?:of[ \t]+)?([a-z]+)\.?(?:,?[ \t]+(\d{4}))?)?)?$/i;
const DAY_MONTH_FORM = /^(\d{1,2})(?:st|nd|rd|th)?[ \t]+(?:of[ \t]+)?([a-z]+)\.?(?:,?[ \t]+(\d{4}))?$/i;
const MONTH_DAY_FORM = /^([a-z]+)\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?(?:,?[ \t]+(\d{4}))?$/i;
const MONTH_YEAR_FORM = /^([a-z]+)\.?[ \t]+(\d{4})$/i;
const PREP_MONTH_FORM = /^(in|by|until|till|before|from|during|early|late|mid|end of|start of)[ \t-]+([a-z]+)\.?$/i;
const SLASH_FORM = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?$/;
const DOT_DASH_FORM = /^(\d{1,2})([.-])(\d{1,2})\2(\d{4}|\d{2})$/;
const ISO_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_NUMBER = /^(?:(?:on|by|before|until|till|from)[ \t]+)?([a-z]+)\.?,?[ \t]+(\d{1,2})$/i;
const THE_DAY_FORM = /^(?:(?:by|before|on|until|till)[ \t]+)?the[ \t]+(\d{1,2})(?:st|nd|rd|th)(?:[ \t]+of[ \t]+(this|next)[ \t]+month)?$/i;
const NUMERIC_TAIL = /^([/.-])\d{1,2}(?:\1(?:\d{4}|\d{2}))?(?![\d/])/;

const result = (day, extra = {}) => (day ? { day, precision: 'day', uncertain: false, ...extra } : null);
// A date worked out from the sent date ("tomorrow", "Friday", "by the 15th"), so it is only as
// good as that date. See findDeadlines(): a forwarded message with no date of its own.
const anchored = (r) => (r ? { ...r, anchored: true } : null);

// "Friday", "this Friday", "next Friday", "last Friday" and (in a past-tense clause) a
// bare "on Friday", which then means the one just gone.
function weekdayDate(ref, dow, prep, { past, last }) {
  const p = (prep || '').toLowerCase();
  if (last) {
    const back = (ref.getDay() - dow + 7) % 7 || 7;
    return result(addDays(ref, -back), { uncertain: true });
  }
  if (p === 'next') {
    const monday = addDays(ref, 7 - ((ref.getDay() + 6) % 7));
    return result(addDays(monday, (dow + 6) % 7), { uncertain: true });
  }
  if (past && p !== 'this') {
    const back = (ref.getDay() - dow + 7) % 7;
    return result(addDays(ref, -back), { uncertain: true });
  }
  const ahead = (dow - ref.getDay() + 7) % 7;
  return result(addDays(ref, ahead), { uncertain: ahead === 0 });
}

// "Friday 17th" with no month: the next 17th, preferring one that is a Friday.
function weekdayAndDayNumber(ref, dow, d) {
  const options = [];
  for (let k = -1; k <= 2; k++) {
    const first = new Date(ref.getFullYear(), ref.getMonth() + k, 1);
    const dt = makeDay(first.getFullYear(), first.getMonth(), d);
    if (dt && dt >= addDays(ref, -7) && dt <= addDays(ref, 62)) options.push(dt);
  }
  const match = options.find((dt) => dt.getDay() === dow);
  if (match) return result(match);
  const next = options.find((dt) => dt >= ref);
  return next ? result(next, { uncertain: true }) : null;
}

// "by the 15th": the next 15th on or after the sent date, marked uncertain as the month is
// only implied; "the 15th of this month" or "of next month" says which.
function dayOfMonthDate(ref, d, which) {
  const monthStart = (k) => new Date(ref.getFullYear(), ref.getMonth() + k, 1);
  if (which) {
    const first = monthStart(which.toLowerCase() === 'next' ? 1 : 0);
    return result(makeDay(first.getFullYear(), first.getMonth(), d));
  }
  for (let k = 0; k < 3; k++) {
    const first = monthStart(k);
    const dt = makeDay(first.getFullYear(), first.getMonth(), d);
    if (dt && dt >= ref) return result(dt, { uncertain: true });
  }
  return null;
}

function relativeWordDate(ref, word) {
  const w = word.toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:today|tonight|this (?:morning|afternoon|evening)|end of (?:the )?day|eod|cob)$/.test(w)) return result(ref);
  if (w === 'tomorrow') return result(addDays(ref, 1));
  if (/^(?:this week|end of (?:the )?week|eow)$/.test(w)) return result(addDays(ref, (5 - ref.getDay() + 7) % 7));
  if (w === 'this weekend') return result(ref.getDay() === 0 ? ref : addDays(ref, 6 - ref.getDay()));
  if (w === 'next week') return result(addDays(ref, 7 - ((ref.getDay() + 6) % 7)), { precision: 'week' });
  if (/^end of (?:the )?month$/.test(w)) return result(new Date(ref.getFullYear(), ref.getMonth() + 1, 0));
  if (w === 'next month') return result(new Date(ref.getFullYear(), ref.getMonth() + 1, 1), { precision: 'month' });
  return null;
}

// "in December", "early March", "end of March", "October 2026": the next such month
// (this one included) unless a year is given.
function monthDate(ref, m, year, which) {
  const y = year ?? (m >= ref.getMonth() ? ref.getFullYear() : ref.getFullYear() + 1);
  if (year != null && !plausibleYear(year, ref)) return null;
  const last = new Date(y, m + 1, 0).getDate();
  const d = which === 'end' ? last : which === 'mid' ? 15 : 1;
  return result(new Date(y, m, d), { precision: 'month' });
}

// A day and month, with or without a year, and an optional weekday to check it against.
function calendarDate(ref, m, d, year, dow = -1) {
  if (m < 0) return null;
  let dt;
  if (year != null) {
    if (!plausibleYear(year, ref)) return null;
    dt = makeDay(year, m, d);
  } else {
    dt = nearestYear(ref, m, d);
  }
  if (!dt) return null;
  return result(dt, { uncertain: dow >= 0 && dt.getDay() !== dow });
}

function numericDate(ref, a, b, yearText, order) {
  let d;
  let m;
  if (a > 12 && b > 12) return null;
  if (a > 12) [d, m] = [a, b];
  else if (b > 12) [m, d] = [a, b];
  else if (order === 'mdy') [m, d] = [a, b];
  else [d, m] = [a, b];
  const year = yearText ? (yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText)) : null;
  return calendarDate(ref, m - 1, d, year);
}

/**
 * Reads one date the cleaner's DATE_RE found. `before`/`after` are the sentence text around
 * it; `past` says the clause reads as the past. Returns { day: Date, precision, uncertain,
 * anchored? } or null.
 */
function readDate(text, ref, order, { before, after, past }) {
  const t = text.replace(/\s+/g, ' ').trim();
  let m = RELATIVE_WORD.exec(t);
  if (m) {
    if (/tomorrow/i.test(t) && /\bthe day after[ \t]+$/i.test(before)) return anchored(result(addDays(ref, 2)));
    return anchored(relativeWordDate(ref, t));
  }
  if ((m = THE_DAY_FORM.exec(t))) return anchored(dayOfMonthDate(ref, Number(m[1]), m[2]));
  if ((m = ISO_FORM.exec(t))) {
    const y = Number(m[1]);
    return plausibleYear(y, ref) ? result(makeDay(y, Number(m[2]) - 1, Number(m[3]))) : null;
  }
  if ((m = SLASH_FORM.exec(t))) return numericDate(ref, Number(m[1]), Number(m[2]), m[3], order);
  if ((m = DOT_DASH_FORM.exec(t))) return numericDate(ref, Number(m[1]), Number(m[3]), m[4], order);
  if ((m = PREP_MONTH_FORM.exec(t)) && monthOf(m[2]) >= 0) {
    const yr = YEAR_AFTER.exec(after);
    const which = /^(?:late|end of)$/i.test(m[1]) ? 'end' : /^mid$/i.test(m[1]) ? 'mid' : 'start';
    return monthDate(ref, monthOf(m[2]), yr ? Number(yr[1]) : null, which);
  }
  if ((m = WEEKDAY_FORM.exec(t)) && weekdayOf(m[2]) >= 0) {
    const dow = weekdayOf(m[2]);
    if (!m[3]) return anchored(weekdayDate(ref, dow, m[1], { past, last: /\blast[ \t]+$/i.test(before) }));
    if (!m[4]) return anchored(weekdayAndDayNumber(ref, dow, Number(m[3])));
    return calendarDate(ref, monthOf(m[4]), Number(m[3]), m[5] ? Number(m[5]) : null, dow);
  }
  if ((m = DAY_MONTH_FORM.exec(t))) return calendarDate(ref, monthOf(m[2]), Number(m[1]), m[3] ? Number(m[3]) : null);
  if ((m = MONTH_YEAR_FORM.exec(t)) && monthOf(m[1]) >= 0) return monthDate(ref, monthOf(m[1]), Number(m[2]), 'start');
  if ((m = MONTH_DAY_FORM.exec(t))) return calendarDate(ref, monthOf(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
  return null;
}

function relativeDate(ref, count, unit) {
  const n = /^\d+$/.test(count) ? Number(count) : NUMBER_WORDS[count.toLowerCase()];
  if (!n || n > 400) return null;
  const u = unit.toLowerCase();
  let day;
  if (/^(?:working|business)/.test(u)) day = addWorkingDays(ref, n);
  else if (u.startsWith('day')) day = addDays(ref, n);
  else if (u.startsWith('week')) day = addDays(ref, 7 * n);
  else if (u.startsWith('fortnight')) day = addDays(ref, 14 * n);
  else day = addMonths(ref, n);
  return result(day);
}

// ---------- context: cue words, past tense, times ----------

// The deadline word in the 4 words before the date (or the date's own 'by'/'until'), or a
// "deadline"/"at the latest" right after it. `before` stops short of any time written just
// before the date, so "no later than 5pm on 10 November" is read as "no later than 10 November".
function cueFor(text, before, after) {
  const own = /^(by|before|until|till|within)\b/i.exec(text);
  if (own && !(/^(?:until|till)$/i.test(own[1]) && STATE_BEFORE_UNTIL.test(before))) return own[1].toLowerCase();
  if (/\bno later than[ \t]*$/i.test(before)) return 'no later than';
  const words = [...before.matchAll(/\S+/g)].slice(-4);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i][0].toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    if (!CUE_WORDS.has(w)) continue;
    if ((w === 'until' || w === 'till') && STATE_BEFORE_UNTIL.test(before.slice(0, words[i].index))) continue;
    return w;
  }
  if (/\b(?:last day|closing date|cut-?off)\b[^.!?]{0,40}$/i.test(before)) return 'deadline';
  // "The deadline for all new applications is (12 noon on) Friday"
  if (/\bdeadline\b(?:[ \t]+(?:for|to|of)\b[^.!?;:]{0,60})?[ \t]+(?:is|was|will be)[ \t]*$/i.test(before)) return 'deadline';
  if (/^[ \t,]*(?:(?:is|was|will be)[ \t]+(?:the[ \t]+)?)?(?:deadline|last day|cut-?off|at the latest)\b/i.test(after)) return 'deadline';
  return null;
}

// Whether the clause around a date reads as something that already happened.
function isPast(before) {
  let start = 0;
  for (const m of before.matchAll(CLAUSE_BREAKS)) start = m.index + m[0].length;
  const clause = before.slice(start);
  const near = [...clause.matchAll(/\S+/g)].slice(-4).map((w) => w[0]).join(' ');
  if (PAST_RE.test(near)) return true;
  return PAST_RE.test(clause) && !FUTURE_RE.test(clause);
}

// "5 pm" is written "5pm"; "12 noon" keeps its space.
const timeText = (t) => t.replace(/\s+/g, ' ').replace(/(\d) (?=[ap]\.?m)/i, '$1');

function timeNear(before, after) {
  const a = TIME_AFTER.exec(after);
  if (a) return { time: timeText(a[1]), length: a[0].length };
  const b = TIME_BEFORE.exec(before);
  return b ? { time: timeText(b[1]), length: 0 } : null;
}

// The date as written, without a leading 'on'/'by'/'in' ("by Friday" is "Friday").
const bareText = (text, relative) => (relative ? text : text.replace(/^(?:on|by|before|until|till|from|in|during)[ \t]+/i, '')).replace(/\s+/g, ' ').trim();

// ---------- finding ----------

// A sent date as a local day: a 'YYYY-MM-DD' is that day here (new Date() would read it as
// UTC midnight, which is the day before west of London). null when it isn't a date.
function dayRef(value) {
  if (typeof value === 'string' && DAY_KEY_RE.test(value)) {
    if (Number.isNaN(utcOf(value))) return null;
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = typeof value === 'string' || value instanceof Date || typeof value === 'number' ? toDate(value) : null;
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
}

const refDay = (ref) => dayRef(ref) || dayRef(new Date());

/**
 * Every date in one sentence, in order.
 * @param {string} sentence
 * @param {Date|number|string} ref  when the email was sent (now if missing or invalid)
 * @param {{ order?: 'dmy'|'mdy' }} [opts]  how to read 10/11: 'dmy' (UK, the default) or 'mdy'
 * @returns {FoundDate[]}
 */
function findDates(sentence, ref, opts = {}) {
  return scan(sentence, ref, opts).map(({ anchored: _, ...d }) => d);
}

// findDates(), plus `anchored`: the date was worked out from `ref` ("within 28 days", "Friday").
function scan(sentence, ref, opts = {}) {
  const s = (typeof sentence === 'string' ? sentence : '').slice(0, MAX_SENTENCE);
  if (!s.trim()) return [];
  const base = refDay(ref);
  const order = opts && opts.order === 'mdy' ? 'mdy' : 'dmy';

  const spans = [];
  for (const m of s.matchAll(DATE_RE)) {
    const end = m.index + m[0].length;
    // "Friday, 13/11": DATE_RE stops at "Friday, 13"; the numeric date is the real one.
    const w = WEEKDAY_NUMBER.exec(m[0]);
    const tail = w && weekdayOf(w[1]) >= 0 ? NUMERIC_TAIL.exec(s.slice(end)) : null;
    if (tail) {
      const tailIndex = end - w[2].length;
      if (realDate(s.slice(tailIndex, end + tail[0].length))) {
        spans.push({ index: m.index, end: end + tail[0].length, kind: 'date', checkDay: weekdayOf(w[1]), tailIndex });
      }
      continue;
    }
    if (realDate(m[0])) spans.push({ index: m.index, end, kind: 'date' });
  }
  for (const m of s.matchAll(RELATIVE_RE)) {
    spans.push({ index: m.index, end: m.index + m[0].length, kind: 'relative', count: m[2], unit: m[3] });
  }
  spans.sort((a, b) => a.index - b.index || b.end - a.end);
  const kept = [];
  for (const sp of spans) {
    const prev = kept[kept.length - 1];
    if (prev && sp.index < prev.end) continue; // overlaps the one before
    // "Friday 2026-11-13": a weekday on its own just before a numeric date checks it.
    if (prev && prev.kind === 'date' && sp.kind === 'date' && /^,?[ \t]+$/.test(s.slice(prev.end, sp.index))) {
      const head = s.slice(prev.index, prev.end).trim();
      const tail = s.slice(sp.index, sp.end);
      const w = /^(?:(?:on|by|before|until|till|from)[ \t]+)?([a-z]+)\.?$/i.exec(head);
      if (w && weekdayOf(w[1]) >= 0 && /^\d/.test(tail)) {
        prev.end = sp.end;
        prev.checkDay = weekdayOf(w[1]);
        prev.tailIndex = sp.index;
        continue;
      }
    }
    kept.push({ ...sp });
  }

  const out = [];
  for (const sp of kept) {
    const raw = s.slice(sp.index, sp.end);
    const before = s.slice(Math.max(0, sp.index - 400), sp.index); // plenty for the words around it
    let after = s.slice(sp.end);
    const past = isPast(before);
    let found;
    let text = raw;
    if (sp.kind === 'relative') {
      found = anchored(relativeDate(base, sp.count, sp.unit));
    } else {
      const own = sp.tailIndex != null ? s.slice(sp.tailIndex, sp.end) : raw;
      found = readDate(own, base, order, { before, after, past });
      if (found && sp.checkDay != null) found.uncertain = found.uncertain || found.day.getDay() !== sp.checkDay;
      // "in December 2026": the year after a month belongs to it.
      const yr = PREP_MONTH_FORM.test(own.trim()) ? YEAR_AFTER.exec(after) : null;
      if (yr) {
        text = `${raw}${after.slice(0, yr[0].length)}`;
        after = after.slice(yr[0].length);
      }
      if (/tomorrow/i.test(raw) && /\bthe day after[ \t]+$/i.test(before)) text = `the day after ${raw}`;
    }
    if (!found || !found.day) continue;
    const time = timeNear(before, after);
    const lead = TIME_BEFORE.exec(before); // "no later than [5pm on] 10 November"
    out.push({
      text: bareText(text, sp.kind === 'relative'),
      index: sp.index,
      day: keyOf(found.day),
      time: time ? time.time : null,
      precision: found.precision,
      uncertain: Boolean(found.uncertain),
      relative: sp.kind === 'relative',
      cue: cueFor(raw, lead ? before.slice(0, lead.index) : before, after.slice(time ? time.length : 0)),
      past: past || found.day < base,
      anchored: Boolean(found.anchored),
    });
  }
  return out;
}

const strings = (v, max) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, max);
const squash = (s) => s.replace(/^\s*(?:[•\-*]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
// The same sentence, or one containing the other (list markers and spacing aside).
function overlaps(a, b) {
  const x = squash(a);
  const y = squash(b);
  return x === y || (y.length >= 12 && x.includes(y)) || (x.length >= 12 && y.includes(x));
}

// Where the forwarded messages start in the body (cleaner.clean()'s `forwarded`), in order:
// [{ at, ref }], ref the local day it was sent, or null when that isn't known.
function forwardedParts(list, length) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p === 'object' && Number.isInteger(p.at) && p.at >= 0 && p.at < length)
    .slice(0, MAX_ASKS)
    .map((p) => ({ at: p.at, ref: dayRef(p.date) }))
    .sort((a, b) => a.at - b.at);
}

/**
 * The deadlines in an email: dates with a cue word ("by", "due", "deadline"…) in the 4 words
 * before them, or inside one of the sender's questions or actions (unless that part reads as
 * the past, like "the parcel I sent on Monday"). In the order they appear.
 *
 * A forwarded message counts its dates from the day it was sent, not the day it was forwarded:
 * a council's "appeal within 28 days of this notice", forwarded three weeks later, is due in a
 * week. When that day isn't known, its "within 28 days", "Friday" and the like are uncertain.
 *
 * @param {{ subject?: string, body?: string, questions?: string[], actions?: string[],
 *   forwarded?: { at: number, date: string|null }[] }} email  body, questions, actions and
 *   forwarded as cleaner.clean() returned them
 * @param {Date|number|string} ref  when the email was sent (now if missing or invalid)
 * @param {{ order?: 'dmy'|'mdy' }} [opts]  see orderForLocale()
 * @returns {Deadline[]}
 */
function findDeadlines(email, ref, opts = {}) {
  const e = email && typeof email === 'object' ? email : {};
  const asks = [...strings(e.actions, MAX_ASKS), ...strings(e.questions, MAX_ASKS)].map((a) => a.slice(0, MAX_SENTENCE));
  const body = (typeof e.body === 'string' ? e.body : '').slice(0, MAX_BODY);
  // The email itself, then each forwarded message, with the date its dates count from.
  const parts = [
    { at: 0, ref, known: true },
    ...forwardedParts(e.forwarded, body.length).map((p) => ({ at: p.at, ref: p.ref || ref, known: Boolean(p.ref) })),
  ];
  const partAt = (i) => parts.reduce((found, p) => (p.at <= i ? p : found), parts[0]);

  const units = [];
  const subject = (typeof e.subject === 'string' ? e.subject : '').slice(0, 500).replace(/^\s*(?:(?:re|fwd?|aw|wg|sv|tr|rv)\s*:\s*)+/i, '');
  if (subject.trim()) units.push({ sentence: subject.trim(), source: 'subject', part: parts[0] });
  const covered = new Set();
  parts.forEach((p, k) => {
    for (const s of splitSentences(body.slice(p.at, k + 1 < parts.length ? parts[k + 1].at : body.length))) {
      const i = asks.findIndex((a) => overlaps(s, a));
      if (i >= 0) covered.add(i);
      units.push({ sentence: s, source: i >= 0 ? 'ask' : 'body', part: p });
    }
  });
  asks.forEach((a, i) => {
    if (!covered.has(i)) units.push({ sentence: a, source: 'ask', part: partAt(body.indexOf(a)) });
  });

  const out = [];
  const seen = new Set();
  for (const u of units) {
    for (const d of scan(u.sentence, u.part.ref, opts)) {
      if (!d.cue && (u.source !== 'ask' || d.past)) continue;
      const key = `${d.day}|${d.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        text: d.text,
        sentence: u.sentence,
        source: u.source,
        cue: d.cue,
        day: d.day,
        time: d.time,
        precision: d.precision,
        uncertain: d.uncertain || (d.anchored && !u.part.known),
        relative: d.relative,
      });
    }
  }
  return out;
}

module.exports = { findDates, findDeadlines, dayKey, daysBetween, formatDay, orderForLocale };
