// Who the user has written to and which emails they have already replied to, built from
// each account's Sent folder (see fetchSentHistory in src/mail.js and src/microsoft.js).
// Pure functions over the history.json shape: no files, no network, nothing shared.
//
// history.json holds one History per account id:
//   { cursor, syncedAt, me: [address], people: { address: { n, last } },
//     replies: { 'c:' + conversationId | 'm:' + messageId: ISO } }
// `me` is the account's own address plus any other address it sends from (aliases).
// `people` counts the emails sent to each address; `replies` keeps the newest time the
// user wrote in a conversation (Outlook) or answered a message (IMAP's In-Reply-To).

/**
 * @typedef {{ n: number, last: string }} Person  emails sent to them, and the newest one's date
 * @typedef {Object} History
 * @property {object|null} cursor  the backend's SentBatch cursor, passed back on the next sync
 * @property {string|null} syncedAt  ISO; null until the Sent folder has been read once
 * @property {string[]} me  lower-cased
 * @property {Object<string, Person>} people  by lower-cased address
 * @property {Object<string, string>} replies  'c:'+conversationId or 'm:'+messageId -> ISO
 *
 * @typedef {{ from: string, to: string[], date: string, conversationId: string|null,
 *   inReplyTo: string|null }} SentEntry
 * @typedef {{ cursor: object, full: boolean, entries: SentEntry[] }} SentBatch
 */

const LIMITS = { people: 5000, replies: 5000, me: 50 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const KEY_LIMIT = 1000; // characters in a reply key (conversation ids can be long)

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A lower-cased email address, or null.
function addressOf(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return address.length <= 320 && EMAIL_RE.test(address) ? address : null;
}

// A date as ISO, or null.
function isoOf(value) {
  if (typeof value !== 'string' && !(value instanceof Date) && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

// A Message-ID as written in headers: <id@host>.
function messageKey(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id) return null;
  const key = `m:${id.startsWith('<') ? id : `<${id}>`}`;
  return key.length <= KEY_LIMIT ? key : null;
}

function conversationKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const key = `c:${value.trim()}`;
  return key.length <= KEY_LIMIT ? key : null;
}

// ---------- shape ----------

/** @returns {History} */
function emptyHistory() {
  return { cursor: null, syncedAt: null, me: [], people: {}, replies: {} };
}

// Keeps the newest `limit` entries of an object by the date fn(value) gives.
function newest(object, limit, dateOf) {
  const entries = Object.entries(object);
  if (entries.length <= limit) return object;
  entries.sort((a, b) => (dateOf(b[1]) > dateOf(a[1]) ? 1 : dateOf(b[1]) < dateOf(a[1]) ? -1 : 0));
  return Object.fromEntries(entries.slice(0, limit));
}

function capped(history) {
  return {
    ...history,
    me: history.me.slice(0, LIMITS.me),
    people: newest(history.people, LIMITS.people, (p) => p.last),
    replies: newest(history.replies, LIMITS.replies, (iso) => iso),
  };
}

// Only the fields a backend cursor uses, with the right types.
function cursorOf(value) {
  if (!isObject(value)) return null;
  const fullAt = Number(value.fullAt);
  if (!Number.isFinite(fullAt)) return null;
  if (value.kind === 'graph') {
    return { kind: 'graph', since: isoOf(value.since), fullAt };
  }
  if (value.kind === 'imap') {
    const lastUid = Number(value.lastUid);
    return {
      kind: 'imap',
      path: typeof value.path === 'string' && value.path ? value.path.slice(0, 1000) : null,
      uidValidity: value.uidValidity == null ? null : String(value.uidValidity).slice(0, 40),
      lastUid: Number.isInteger(lastUid) && lastUid >= 0 ? lastUid : 0,
      fullAt,
    };
  }
  return null;
}

/**
 * One account's history as read from disk, with anything malformed dropped and the caps
 * applied. Never throws.
 * @param {unknown} raw
 * @returns {History}
 */
function normalizeHistory(raw) {
  if (!isObject(raw)) return emptyHistory();
  const me = [...new Set((Array.isArray(raw.me) ? raw.me : []).map(addressOf).filter(Boolean))];
  const people = {};
  for (const [key, value] of Object.entries(isObject(raw.people) ? raw.people : {})) {
    const address = addressOf(key);
    const n = Number(value?.n);
    const last = isoOf(value?.last);
    if (address && Number.isInteger(n) && n > 0 && last) people[address] = { n: Math.min(n, 1e6), last };
  }
  const replies = {};
  for (const [key, value] of Object.entries(isObject(raw.replies) ? raw.replies : {})) {
    const iso = isoOf(value);
    if (/^[cm]:\S/.test(key) && key.length <= KEY_LIMIT && iso) replies[key] = iso;
  }
  return capped({ cursor: cursorOf(raw.cursor), syncedAt: isoOf(raw.syncedAt), me, people, replies });
}

// ---------- updating ----------

/**
 * The history after a sync. A `full` batch replaces what was there; otherwise its entries
 * are added. The account's own address and every address it sent from go into `me`, and
 * are never counted as people. Doesn't change `history`.
 * @param {History|null} history
 * @param {SentBatch} batch
 * @param {{ accountEmail?: string, now?: number|Date }} options
 * @returns {History}
 */
function mergeSent(history, batch, { accountEmail, now = Date.now() } = {}) {
  const base = !history || batch?.full ? emptyHistory() : normalizeHistory(history);
  const entries = Array.isArray(batch?.entries) ? batch.entries.filter(isObject) : [];
  const me = new Set([addressOf(accountEmail), ...base.me, ...entries.map((e) => addressOf(e.from))].filter(Boolean));
  const people = { ...base.people };
  const replies = { ...base.replies };
  for (const address of me) delete people[address]; // an alias found later isn't a person
  for (const entry of entries) {
    const date = isoOf(entry.date);
    if (!date) continue;
    const sentTo = new Set((Array.isArray(entry.to) ? entry.to : []).map(addressOf).filter((a) => a && !me.has(a)));
    for (const address of sentTo) {
      const known = people[address];
      people[address] = { n: Math.min((known ? known.n : 0) + 1, 1e6), last: later(known?.last, date) };
    }
    for (const key of [conversationKey(entry.conversationId), messageKey(entry.inReplyTo)]) {
      if (key) replies[key] = later(replies[key], date);
    }
  }
  return capped({
    cursor: cursorOf(batch?.cursor) ?? base.cursor,
    syncedAt: isoOf(now instanceof Date ? now : new Date(Number(now))) ?? new Date().toISOString(),
    me: [...me],
    people,
    replies,
  });
}

/**
 * Records a reply the user just sent from ClearMail, so the email shows "You've already
 * replied" before the next Sent sync. Only `replies` changes: the sync counts the person
 * (counting here too would count them twice), and repeating this is harmless.
 * @param {History|null} history
 * @param {{ conversationId?: string|null, messageId?: string|null }} email  the email replied to
 * @param {number|Date|string} [at]  when the reply went
 * @returns {History}
 */
function noteReply(history, email, at = Date.now()) {
  const base = normalizeHistory(history);
  const date = isoOf(at instanceof Date || typeof at === 'string' ? at : new Date(Number(at)));
  if (!date || !isObject(email)) return base;
  const replies = { ...base.replies };
  for (const key of [conversationKey(email.conversationId), messageKey(email.messageId)]) {
    if (key) replies[key] = later(replies[key], date);
  }
  return capped({ ...base, replies });
}

// ---------- questions triage asks ----------

// One History, a list of them, or history.json's { accountId: History } map, as a list.
function historyList(histories) {
  if (!histories) return [];
  if (Array.isArray(histories)) return histories.filter(isObject);
  if (!isObject(histories)) return [];
  if (isObject(histories.people) || isObject(histories.replies) || Array.isArray(histories.me)) return [histories];
  return Object.values(histories).filter(isObject);
}

/**
 * The user's own addresses: the accounts' addresses plus every address they sent from.
 * @param {History|History[]|Object<string, History>} histories
 * @param {string[]} [accountEmails]
 * @returns {Set<string>}
 */
function meSet(histories, accountEmails = []) {
  const out = new Set([].concat(accountEmails || []).map(addressOf).filter(Boolean));
  for (const h of historyList(histories)) for (const a of Array.isArray(h.me) ? h.me : []) if (addressOf(a)) out.add(addressOf(a));
  return out;
}

/**
 * How many emails the user has sent to this address, over all accounts (0 if never).
 * Upper and lower case are the same address.
 */
function wroteTo(histories, address) {
  const key = addressOf(address);
  if (!key) return 0;
  let n = 0;
  for (const h of historyList(histories)) {
    const person = isObject(h.people) && Object.hasOwn(h.people, key) ? h.people[key] : null;
    if (person && Number.isInteger(person.n) && person.n > 0) n += person.n;
  }
  return n;
}

/**
 * When the user replied to this email, or null. Only a reply after the email arrived
 * counts: something the user wrote earlier in the same conversation isn't an answer to it.
 * @param {History|History[]|Object<string, History>} histories
 * @param {{ conversationId?: string|null, messageId?: string|null, receivedAt?: string, date?: string }} email
 * @returns {string|null} ISO
 */
function repliedAt(histories, email) {
  if (!isObject(email)) return null;
  const received = isoOf(email.receivedAt) || isoOf(email.date);
  if (!received) return null;
  const keys = [conversationKey(email.conversationId), messageKey(email.messageId)].filter(Boolean);
  let found = null;
  for (const h of historyList(histories)) {
    if (!isObject(h.replies)) continue;
    for (const key of keys) {
      const at = Object.hasOwn(h.replies, key) ? isoOf(h.replies[key]) : null;
      if (at && at > received) found = later(found, at);
    }
  }
  return found;
}

/** Whether any account's Sent folder has been read at least once. */
function historyKnown(histories) {
  return historyList(histories).some((h) => Boolean(isoOf(h.syncedAt)));
}

/**
 * Everything triage needs from the histories (TriageContext's me, wroteTo, historyKnown and
 * repliedAt), with the people of every account merged once for quick lookups.
 * @param {History|History[]|Object<string, History>} histories
 * @param {{ accountEmails?: string[] }} [options]
 */
function historyContext(histories, { accountEmails = [] } = {}) {
  const list = historyList(histories);
  const people = new Map();
  for (const h of list) {
    for (const [address, person] of Object.entries(isObject(h.people) ? h.people : {})) {
      if (Number.isInteger(person?.n) && person.n > 0) people.set(address, (people.get(address) || 0) + person.n);
    }
  }
  return {
    me: meSet(list, accountEmails),
    historyKnown: historyKnown(list),
    wroteTo: (address) => people.get(addressOf(address)) || 0,
    repliedAt: (email) => repliedAt(list, email),
  };
}

/** Counts for the "What ClearMail can see" readout: people written to, replies known. */
function historyCounts(histories) {
  const people = new Set();
  let replies = 0;
  for (const h of historyList(histories)) {
    for (const address of Object.keys(isObject(h.people) ? h.people : {})) people.add(address);
    replies += Object.keys(isObject(h.replies) ? h.replies : {}).length;
  }
  return { people: people.size, replies };
}

module.exports = {
  LIMITS,
  emptyHistory,
  normalizeHistory,
  mergeSent,
  noteReply,
  meSet,
  wroteTo,
  repliedAt,
  historyKnown,
  historyContext,
  historyCounts,
};
