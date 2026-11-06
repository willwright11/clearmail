// Turns loaded emails into what the window shows: each email is cleaned, its deadlines are
// found, it gets a short version, and it is sorted into Needs you / Worth knowing / Noise.
// Pure functions: no files, no network, no Electron. main.js passes in the clock, the
// user's rules and marks (state.json) and who they have written to (history.json).

const { clean } = require('./cleaner');
const { heuristicSummary, originalText } = require('./summarize');
const { findDeadlines } = require('./dates');
const { triageAll, sortBucket, BUCKETS } = require('./triage');
const { briefCounts } = require('./brief');

/**
 * What prepareEmail() keeps for each email. An email never changes for its id, so it is
 * worked out once and reused by every later load (`key` notices one that couldn't be read
 * last time).
 * @typedef {object} Prepared
 * @property {string} key
 * @property {string} original  the full text as received (HTML converted to text)
 * @property {object} cleaned  cleaner.clean()
 * @property {object[]} deadlines  dates.findDeadlines()
 * @property {object} summary  EmailSummary v2 (summarize.heuristicSummary())
 *
 * One loaded email: the RawEmail from a backend plus where it came from.
 * @typedef {object} Item
 * @property {string} id  '<account id>:<backend id>'
 * @property {string} accountId
 * @property {string} accountEmail  the user's address it was sent to ('' in demo mode)
 * @property {object} raw  RawEmail v3
 * @property {Prepared} prep
 * @property {boolean} canOpen  main can open it in Outlook on the web or Mail
 *
 * @typedef {object} EmailView  one email as the window gets it (IPC contract H)
 * @property {string} id
 * @property {string} accountId
 * @property {string} accountEmail
 * @property {{ name: string, address: string }} from
 * @property {string} subject
 * @property {string} date  ISO
 * @property {string} receivedAt  ISO
 * @property {boolean} seen  the mailbox's own read state, never changed by ClearMail
 * @property {{ filename: string, size: number }[]} attachments
 * @property {string} original
 * @property {string} cleanedBody
 * @property {{ url: string, label: string }[]} links
 * @property {object} summary
 * @property {object} triage  TriageResult
 * @property {boolean} isNew  arrived since the last brief
 * @property {boolean} done
 * @property {boolean} notNoise
 * @property {'important'|'noise'|null} senderRule  the rule for this sender's address
 * @property {boolean} canOpen
 */

const str = (v) => (typeof v === 'string' ? v : '');

// When the cleaner chokes on an email, it is shown uncleaned rather than lost.
function emptyCleaned(original) {
  const n = original.split(/\s+/).filter(Boolean).length;
  return {
    body: original, keyPoints: [], questions: [], actions: [], dates: [], times: [], amounts: [], links: [], forwarded: [],
    category: 'person', urgency: 'normal', stats: { rawWords: n, keptWords: n, saved: 0 },
  };
}

function prepareKey(raw, order, names) {
  return [String(raw.text || '').length, String(raw.html || '').length, str(raw.subject).length, str(raw.date), order, names.join(',')].join(':');
}

/**
 * The user's first names, for asks like "Will, could you…": the first word of each
 * account's display name, lower-cased, letters only, at least 2 letters. Each once.
 * @param {string[]} displayNames  e.g. ['Will Wright', '']
 * @returns {string[]}  e.g. ['will']
 */
function firstNames(displayNames) {
  const out = new Set();
  for (const name of [].concat(displayNames || [])) {
    const first = typeof name === 'string' ? name.trim().split(/\s+/)[0] : '';
    const letters = first.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (letters.length >= 2) out.add(letters);
  }
  return [...out];
}

const namesOf = (names) => (Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n) : []);

/**
 * Cleans one email, finds its deadlines and writes its short version. Reuses `previous`
 * when it was made from the same email. Never throws.
 * @param {object} raw  RawEmail
 * @param {{ order?: 'dmy'|'mdy', previous?: Prepared|null, names?: string[] }} [options]  names: the
 *   user's first names (firstNames()), so an ask that names them leads the short version
 * @returns {Prepared}
 */
function prepareEmail(raw, { order = 'dmy', previous = null, names = [] } = {}) {
  const userNames = namesOf(names);
  const key = prepareKey(raw, order, userNames);
  if (previous && previous.key === key) return previous;
  const original = originalText(raw);
  let cleaned;
  try {
    // original is already text, so clean() needn't convert the HTML again. Mailing-list
    // headers are left to triage, where they can't hide a real question.
    cleaned = clean({ text: original, html: raw.html, subject: raw.subject, from: raw.from?.address || '' });
  } catch (err) {
    console.error('Could not clean an email:', err?.message);
    cleaned = emptyCleaned(original);
  }
  let deadlines = [];
  try {
    // A forwarded or quoted email's relative dates ("tomorrow") count from that email's own date.
    const forwarded = Array.isArray(cleaned.forwarded) ? cleaned.forwarded : [];
    deadlines = findDeadlines({ subject: raw.subject, body: cleaned.body, questions: cleaned.questions, actions: cleaned.actions, forwarded }, raw.date, { order });
  } catch (err) {
    console.error('Could not read the dates in an email:', err?.message);
  }
  let summary;
  try {
    summary = heuristicSummary(cleaned, raw.subject, original, { deadlines, names: userNames });
  } catch (err) {
    console.error('Could not shorten an email:', err?.message);
    summary = heuristicSummary(emptyCleaned(original), raw.subject, original);
  }
  return { key, original, cleaned, deadlines, summary };
}

/**
 * The email as triage reads it: the RawEmail v3 fields with the account-prefixed id, plus
 * `cleaned` and `deadlines`.
 * @param {Item} item
 */
function toTriageInput(item) {
  return { ...item.raw, id: item.id, cleaned: item.prep.cleaned, deadlines: item.prep.deadlines };
}

function isoOr(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

const addressOf = (a) => (a && typeof a.address === 'string' ? a.address.trim().toLowerCase() : '');

// The user's rule for exactly this address ('@domain' rules are changed in Settings).
function ruleFor(address, rules) {
  const rule = address && rules && Object.hasOwn(rules, address) ? rules[address] : null;
  return rule === 'important' || rule === 'noise' ? rule : null;
}

/**
 * One email for the window.
 * @param {Item} item
 * @param {{ triage: object, done?: boolean, notNoise?: boolean, senderRule?: string|null, isNew?: boolean, now?: number }} extra
 * @returns {EmailView}
 */
function buildEmailView(item, { triage, done = false, notNoise = false, senderRule = null, isNew = false, now = Date.now() }) {
  const { raw, prep } = item;
  const date = isoOr(raw.date, new Date(now).toISOString());
  return {
    id: item.id,
    accountId: item.accountId,
    accountEmail: item.accountEmail || '',
    from: { name: String(raw.from?.name || raw.from?.address || 'Unknown sender'), address: String(raw.from?.address || '') },
    subject: String(raw.subject || ''),
    date,
    receivedAt: isoOr(raw.receivedAt, date),
    seen: Boolean(raw.seen),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map((a) => ({ filename: String(a?.filename || 'attachment'), size: Number(a?.size) || 0 })),
    original: prep.original,
    cleanedBody: str(prep.cleaned.body),
    links: (Array.isArray(prep.cleaned.links) ? prep.cleaned.links : []).filter((l) => typeof l?.url === 'string').map((l) => ({ url: l.url, label: str(l.label) || l.url })),
    summary: prep.summary,
    triage,
    isNew: Boolean(isNew),
    done: Boolean(done),
    notNoise: Boolean(notNoise),
    senderRule: senderRule === 'important' || senderRule === 'noise' ? senderRule : null,
    canOpen: Boolean(item.canOpen),
  };
}

// Never hidden as noise because something went wrong: a missing result reads Worth knowing.
const FALLBACK_TRIAGE = Object.freeze({ bucket: 'worth-knowing', reasons: [], codes: [], deadline: null, caution: null });

/**
 * The whole Brief (IPC contract H's BriefView). Emails come in display order: Needs you,
 * Worth knowing and Noise (each sorted by triage's sortBucket), then Done, most recently
 * done first.
 * @param {object} options
 * @param {number} options.now
 * @param {boolean} options.demo
 * @param {string|null} options.demoReason
 * @param {number} options.since  start of the brief's window (ms)
 * @param {string} options.sinceLabel
 * @param {object[]} options.accounts  [{ id, email, kind, error, needsSignIn }]
 * @param {Item[]} options.items
 * @param {{ me: Set<string>, wroteTo: Function, historyKnown: boolean, repliedAt: Function }} options.history
 * @param {{ rules: object, done: object, notNoise: object }} options.marks  from state.json
 * @param {string[]} [options.names]  the user's first names (firstNames())
 */
function buildBriefView({ now, demo, demoReason, since, sinceLabel, accounts, items, history, marks, names = [] }) {
  const rules = marks?.rules || {};
  const done = marks?.done || {};
  const notNoise = marks?.notNoise || {};
  const results = triageAll(items.map(toTriageInput), {
    now,
    me: history?.me,
    rules,
    notNoise: new Set(Object.keys(notNoise)),
    wroteTo: history?.wroteTo,
    historyKnown: history?.historyKnown === true,
    repliedAt: history?.repliedAt,
    names: namesOf(names),
  });
  const views = items.map((item) => {
    const triage = results.get(item.id) || FALLBACK_TRIAGE;
    const received = Date.parse(item.raw.receivedAt || item.raw.date);
    return buildEmailView(item, {
      triage,
      done: Object.hasOwn(done, item.id),
      notNoise: Object.hasOwn(notNoise, item.id),
      senderRule: ruleFor(addressOf(item.raw.from), rules),
      isNew: !Number.isNaN(received) && received > since,
      now,
    });
  });

  const live = views.filter((v) => !v.done);
  const ordered = BUCKETS.flatMap((bucket) => sortBucket(live.filter((v) => v.triage.bucket === bucket), bucket));
  const finished = views.filter((v) => v.done).sort((a, b) => (Number(done[b.id]) || 0) - (Number(done[a.id]) || 0));
  const emails = [...ordered, ...finished];

  return {
    demo: Boolean(demo),
    demoReason: demoReason || null,
    generatedAt: new Date(now).toISOString(),
    since: new Date(since).toISOString(),
    sinceLabel: str(sinceLabel),
    accounts: accounts.map((a) => ({
      id: a.id, email: a.email, kind: a.kind, error: a.error || null, needsSignIn: Boolean(a.needsSignIn),
      readOnly: true, // ClearMail only reads this mailbox
    })),
    counts: briefCounts(emails, { since, now }),
    emails,
  };
}

module.exports = { prepareEmail, toTriageInput, buildEmailView, buildBriefView, emptyCleaned, firstNames };
