// The short version of an email, made entirely offline from what cleaner.js found: a
// headline ("gist") of at most 25 words, the key points, the asks and the deadlines.
// Nothing here leaves the computer. tighten() rewrites wordy phrases ("in order to" → "to"),
// but only when every fact in the sentence survives, so a shorter sentence never says
// something different. Every summary leaving this file has the same shape (normalizeSummary).

const { htmlToText, splitSentences, countWords, DATE_SOURCE, MONEY_SOURCE } = require('./cleaner');

/**
 * @typedef {object} EmailSummary  (v2)
 * @property {string} gist  at most 25 words
 * @property {string[]} key_points
 * @property {{ task: string, due: string }[]} action_items  due: the deadline written in it, or ''
 * @property {string[]} questions
 * @property {{ what: string, when: string, day: string|null }[]} dates  the deadlines
 *   (dates.findDeadlines): what it is for, the date as written, and 'YYYY-MM-DD'
 * @property {string[]} amounts
 * @property {'person'|'receipt'|'newsletter'|'promo'|'notification'} category
 * @property {'high'|'normal'|'low'} urgency
 * @property {{ original: number, short: number }} words  for "Short version: 38 of 205 words".
 *   short counts the gist, key points, actions and questions.
 */

const MAX_GIST_WORDS = 25;
const MAX_SENTENCE = 3000; // characters; tighten leaves anything longer alone
const MAX_ITEMS = 20;
const MAX_TEXT = 2000;
const CATEGORIES = ['person', 'receipt', 'newsletter', 'promo', 'notification'];
const URGENCIES = ['high', 'normal', 'low'];

const DATE_RE = new RegExp(DATE_SOURCE, 'g'); // one capture group: never wrap this source
const DATE_TEST = new RegExp(DATE_SOURCE);
const MONEY_RE = new RegExp(MONEY_SOURCE, 'gi');
const MONEY_TEST = new RegExp(MONEY_SOURCE, 'i');

// ---------- facts (what tighten must never change) ----------

const QUOTED_RE = /"[^"\n]*"|“[^”\n]*”/g;
const LINK_LABEL_RE = /\[[^\]\n]+\]/g;
const EMAIL_RE = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/gi;
const NUMBER_RE = /\S*\d\S*/g;
const NEGATION_RE = /\b(?:not|no|never|without|unless|except|cannot)\b|n['’]t\b/gi;
const NEGATION_WORD = /^(?:not|no|never|without|unless|except|cannot)$|n['’]t$/i;
const SELF = /^I(?:['’](?:m|ve|d|ll))?$/; // "I" is capitalised but isn't a name
const DATE_PREP = /^(?:on|by|before|until|till|from|in|during)[ \t]+/i;
const edges = (w) => w.replace(/^[^\p{L}\p{N}£$€]+|[^\p{L}\p{N}%]+$/gu, '');

/**
 * The facts in a sentence, as a sorted list: numbers, money, %, dates and times, [link]
 * labels, email addresses, "quoted text", capitalised words (names) and the negations
 * not / no / never / n't / without / unless / except. The sentence's first word is left out
 * of the names (its capital is just grammar) and returned separately.
 * @returns {{ facts: string[], names: string[], first: string|null }}
 */
function factTokens(sentence) {
  const s = String(sentence ?? '');
  const facts = [];
  const add = (re, tag, norm = (x) => x) => {
    for (const m of s.matchAll(re)) facts.push(`${tag}:${norm(m[0])}`);
  };
  add(QUOTED_RE, 'q');
  add(LINK_LABEL_RE, 'l');
  add(EMAIL_RE, 'e', (x) => x.toLowerCase());
  add(MONEY_RE, 'm', (x) => x.replace(/\s+/g, ''));
  add(DATE_RE, 'd', (x) => x.replace(DATE_PREP, '').replace(/\s+/g, ' ').toLowerCase());
  add(NUMBER_RE, 'n', edges);
  add(NEGATION_RE, 'x', (x) => x.toLowerCase().replace('’', "'"));
  const names = [];
  let first = null;
  for (const [w] of s.matchAll(/\S+/g)) {
    const word = edges(w);
    if (!/\p{L}/u.test(word)) continue;
    const isName = /\p{Lu}/u.test(word) && !SELF.test(word);
    if (first === null) first = isName ? word : '';
    else if (isName) names.push(word);
  }
  return { facts: facts.sort(), names: names.sort(), first: first || null };
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether `after` keeps exactly the facts of `before`. A name that a removal moved to the
 * front ("Furthermore, Sarah will…" → "Sarah will…") still counts as the same name.
 */
function sameFacts(before, after) {
  const a = factTokens(before);
  const b = factTokens(after);
  if (!same(a.facts, b.facts)) return false;
  return same(a.names, b.names) || (b.first !== null && same(a.names, [...b.names, b.first].sort()));
}

// A sentence's first letter is just grammar: lower it while rewriting (unless the word is
// an acronym like HMRC), so "In order to" at the start reads like "in order to" mid-sentence.
function lowerFirst(s) {
  const m = /\p{L}[\p{L}'’-]*/u.exec(s);
  if (!m || (m[0].match(/\p{Lu}/gu) || []).length !== 1 || !/^\p{Lu}/u.test(m[0])) return { text: s, lowered: false };
  return { text: s.slice(0, m.index) + m[0][0].toLowerCase() + s.slice(m.index + 1), lowered: true };
}

function upperFirst(s) {
  const m = /\p{L}[\p{L}'’-]*/u.exec(s);
  if (!m || /\p{Lu}/u.test(m[0])) return s; // already capitalised, or "iPhone"
  return s.slice(0, m.index) + m[0][0].toUpperCase() + s.slice(m.index + 1);
}

// ---------- tighten ----------

// A roundabout request ("we need you to sign") is only rewritten where it opens a clause: at
// the start, after a full stop, semicolon, colon or dash, or after a comma (and "so", "and" or
// "but") that doesn't carry on a condition. "If we need you to sign anything, we will write",
// "Let us know if we need you to…" and "If prices change, and we need you to sign again, …"
// stay as they are: they aren't asking for anything.
const CONDITION = /\b(?:if|when|whenever|unless|whether|once|until|till|in case|should|where|while|as soon as|after|before|provided)\b/i;
function opensClause(s, offset) {
  const before = s.slice(0, offset);
  if (/(?:^|[.!?;:—–])[ \t]*$/.test(before)) return true;
  return /,[ \t]*(?:(?:so|and|but)[ \t]+)?$/.test(before) && !CONDITION.test(before.split(/[.!?;:—–]/).pop());
}
const request = (to) => (m, offset, s) => (opensClause(s, offset) ? to : m);

const BASIS = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly', annual: 'annually', regular: 'regularly' };

// Case-insensitive, whole words. Each entry is [pattern, replacement]; '' removes the phrase.
const PHRASES = [
  // Throat-clearing that adds nothing.
  [/\b(?:please be advised|please note|kindly note|i would like to inform you|i(?: am|'m|’m) writing to inform you|we(?: are|'re|’re) pleased to inform you|we regret to inform you|it is important to note|it should be noted) that[ \t]+/gi, ''],
  [/(?:^|,[ \t]*)as (?:previously |I |we )?mentioned(?: (?:above|before|earlier|previously))?,[ \t]*/gi, (m, offset) => (offset === 0 ? '' : ' ')],
  [/^(?:additionally|furthermore|moreover|basically|actually|literally),[ \t]*/i, ''],
  [/\breally (?=appreciate)/gi, ''],
  [/\b(i) just (?=wanted\b)/gi, (m, i) => `${i} `],
  [/\bjust (?=a quick\b)/gi, ''],
  // Long ways of saying short things.
  [/\bin order to\b/gi, 'to'],
  [/\b(?:due to|owing to|in light of) the fact that\b/gi, 'because'],
  [/\bdespite the fact that\b/gi, 'although'],
  [/\bat (?:this point in time|the present time|this moment in time)\b/gi, 'now'],
  [/\bin the near future\b/gi, 'soon'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bin the event that\b/gi, 'if'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\b(?:with regards? to|in regards? to|in relation to|with respect to|in reference to)\b/gi, 'about'],
  [/\ba number of\b/gi, 'several'],
  [/\bthe majority of(?=[ \t]+(?:the|our|your|their|his|her|its|my|these|those|this|that|them|us|you)\b)/gi, 'most of'],
  [/\bthe majority of\b/gi, 'most'],
  [/\bon an? (daily|weekly|monthly|yearly|annual|regular) basis\b/gi, (m, w) => BASIS[w.toLowerCase()]],
  [/\bat your earliest convenience\b/gi, 'as soon as you can'],
  [/\buntil such time as\b/gi, 'until'],
  [/\beach and every\b/gi, 'every'],
  [/\bfirst and foremost\b/gi, 'first'],
  [/\bare you able to\b/gi, 'can you'],
  [/\b(?:is|are) able to\b/gi, 'can'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\bmake a decision\b/gi, 'decide'],
  [/\b(?:take into consideration|give consideration to)\b/gi, 'consider'],
  // Roundabout requests, where they open a clause (see opensClause). "Would it be possible to
  // get a copy?" doesn't say who would get it, so only "…for you to" becomes "could you".
  [/\b(?:we would need you to|we need you to|i need you to|we would like you to)\b/gi, request('please')],
  [/\b(?:would you be able to|would it be possible for you to|i was wondering if you could)\b/gi, request('could you')],
];

// Spaces and commas left behind by a removal.
const tidy = (s) => s
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/[ \t]+,/g, ',')
  .replace(/,(?:[ \t]*,)+/g, ',')
  .replace(/,(?=[ \t]*(?:[.!?;:]|$))/g, '')
  .replace(/^[\s,;:]+/, '')
  .replace(/[ \t]+([.!?])$/, '$1')
  .trim();

// Whether a negation is within the 3 words before `offset` ("not in order to" stays).
function negatedBefore(s, offset) {
  return s.slice(Math.max(0, offset - 80), offset).trim().split(/\s+/).slice(-3).some((w) => NEGATION_WORD.test(w.replace(/[^\p{L}'’]/gu, '')));
}

function applyPhrase(s, [re, to]) {
  const quotes = [...s.matchAll(QUOTED_RE)].map((m) => [m.index, m.index + m[0].length]);
  return s.replace(re, (...args) => {
    const match = args[0];
    const offset = args[args.length - 2];
    if (quotes.some(([a, b]) => offset < b && offset + match.length > a)) return match; // quoted words stay
    if (negatedBefore(s, offset)) return match;
    return typeof to === 'function' ? to(...args) : to;
  });
}

function tightenSentence(sentence) {
  if (sentence.length > MAX_SENTENCE) return sentence; // not a sentence anyone reads as one; left as it is
  const { text: start, lowered } = lowerFirst(sentence);
  const finish = (t) => (lowered ? upperFirst(t) : t);
  let cur = start;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const phrase of PHRASES) {
      const replaced = applyPhrase(cur, phrase);
      if (replaced === cur) continue;
      const next = tidy(replaced);
      // The guards: every fact survives and a real sentence is left.
      if (next === cur || countWords(next) < 3 || !sameFacts(sentence, finish(next))) continue;
      cur = next;
      changed = true;
    }
    if (!changed) break;
  }
  return cur === start ? sentence : finish(cur);
}

/**
 * A shorter way of saying the same sentence: wordy phrases replaced ("in order to" → "to",
 * "would you be able to" → "could you"), throat-clearing removed ("Please note that").
 * Uncertainty ("I think", "perhaps") stays. A replacement is skipped when a negation is in
 * the 3 words before it, or when it would change any fact (see factTokens) or leave fewer
 * than 3 words. Running it twice changes nothing more.
 */
function tighten(text) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!s.trim()) return s;
  if (s.includes('\n')) return s.split('\n').map(tighten).join('\n');
  const parts = splitSentences(s);
  if (parts.length < 2) return tightenSentence(s);
  const out = parts.map(tightenSentence);
  return out.every((p, i) => p === parts[i]) ? s : out.join(' ');
}

// ---------- the gist ----------

// Words a long sentence can be cut before: the start of a new clause.
const CLAUSE_WORDS = new Set(['so', 'because', 'which', 'but', 'while', 'and', 'as', 'since', 'although', 'then', 'whereas']);

/**
 * At most `max` words. A longer sentence is cut at the last clause boundary that fits (so it
 * keeps as many of its facts as possible), else after `max` words; either way it ends in "…".
 */
function shorten(text, max = MAX_GIST_WORDS) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  for (let i = max; i >= 4; i--) {
    const prev = words[i - 1];
    const next = words[i];
    if (/[.!?]["')\]]*$/.test(prev)) return words.slice(0, i).join(' ');
    if (/[,;:)]$/.test(prev) || /^[—–-]$/.test(next) || CLAUSE_WORDS.has(next.toLowerCase())) {
      return `${words.slice(0, i).join(' ').replace(/[\s,;:—–-]+$/, '')}…`;
    }
  }
  return `${words.slice(0, max).join(' ')}…`;
}

// A direct request to the reader, as opposed to a sentence that only mentions "due" or "send".
const DIRECT_ASK = /\b(?:please|could you|can you|would you|will you|need you to|you need to|you must|make sure|remember to|don't forget|do you|are you|did you|have you|let me know)\b/i;

// The asks in email order.
function inOrder(body, actions, questions) {
  const where = (s) => {
    const i = body.indexOf(s);
    return i < 0 ? Infinity : i;
  };
  return [...actions, ...questions].map((s, n) => ({ s, at: where(s), n })).sort((a, b) => a.at - b.at || a.n - b.n).map((a) => a.s);
}

// The first thing the sender asks: a direct request first, in email order.
function firstAsk(body, actions, questions) {
  const direct = inOrder(body, actions, questions).find((s) => DIRECT_ASK.test(s.replace(/’/g, "'")));
  return direct || actions[0] || questions[0] || '';
}

// The user's first names, lower case ("will"), as the app passes them.
const namesOf = (v) => list(v).filter((n) => typeof n === 'string').map((n) => n.toLowerCase()).filter((n) => /^\p{L}{2,30}$/u.test(n)).slice(0, MAX_ITEMS);

/**
 * Whether an ask speaks to the user by name: "Will, could you…", "Could you, Will, …",
 * "…, Will?". The name needs its capital and a comma (or a colon or dash after it at the
 * start), so "Will you send it?" and "the will of the client" don't count.
 */
function addressesUser(sentence, names) {
  const s = String(sentence).trim();
  return names.some((n) => {
    const name = n[0].toUpperCase() + n.slice(1);
    return new RegExp(`^(?:(?:[Hh]i|[Hh]ey|[Oo]k(?:ay)?|[Ss]o|[Aa]nd|[Aa]lso|[Oo]h)[ \\t,]+)?${name}(?:[ \\t]*[,:]|[ \\t]+[—–-])|,[ \\t]*${name}[ \\t]*(?:[,?!.…]|$)`).test(s);
  });
}

// The first ask that names the user: in an email to several people, theirs ("Will, could you
// send me the invoice?"), not someone else's.
const namedAsk = (body, actions, questions, names) => (names.length ? inOrder(body, actions, questions).find((s) => addressesUser(s, names)) || '' : '');

const MARKETING = /\d\s?%\s?off\b|\b(?:sale|offers?|deals?|vouchers?|cashback|discounts?|promo(?:tion)?s?|coupons?|shop now|free delivery|today only|last chance|limited[- ]time)\b/i;
const OBLIGATION = /\b(?:due|owe|overdue|must|deadline|pay by|required|renew|submit(?:ted)?)\b/i;
// "It expires in 10 minutes" means little on its own; "Your code is 482913" says it all.
const LEANS_ON_CONTEXT = /^(?:it|this|that|they|these|those|he|she)\b/i;

// The most informative key point: money, a deadline, a date, numbers and "due" win;
// marketing, very long sentences and ones that lean on the sentence before lose; earlier
// wins a tie.
function bestFact(keyPoints, deadlineSentences) {
  const score = (s, i) =>
    (MONEY_TEST.test(s) ? 3 : 0) +
    (deadlineSentences.some((d) => overlaps(d, s)) ? 3 : 0) +
    (DATE_TEST.test(s) ? 2 : 0) +
    (/\d/.test(s) ? 1 : 0) +
    (OBLIGATION.test(s) ? 2 : 0) -
    (MARKETING.test(s) ? 4 : 0) -
    (LEANS_ON_CONTEXT.test(s) ? 1 : 0) -
    (countWords(s) > MAX_GIST_WORDS ? 3 : 0) -
    i * 0.5;
  let best = '';
  let top = -Infinity;
  keyPoints.forEach((s, i) => {
    const v = score(s, i);
    if (v > top) [best, top] = [s, v];
  });
  return best;
}

// ---------- helpers ----------

const text = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : typeof v === 'number' ? String(v) : '');
const list = (v) => (Array.isArray(v) ? v : []);
const texts = (v) => list(v).map(text).filter(Boolean).slice(0, MAX_ITEMS);
const firstWords = (s, n) => {
  const all = String(s).trim().split(/\s+/);
  return all.length > n ? `${all.slice(0, n).join(' ')}…` : all.join(' ');
};
const plain = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').replace(/[\s.!?…]+$/, '').trim();
const squash = (s) => String(s).replace(/^\s*(?:[•\-*]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
function overlaps(a, b) {
  const x = squash(a);
  const y = squash(b);
  return Boolean(x && y) && (x === y || (y.length >= 12 && x.includes(y)) || (x.length >= 12 && y.includes(x)));
}
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const countOf = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// What a deadline is for, from its sentence: "The VAT return is due on 7 December" → "The
// VAT return is due". The words before the date in its clause, at most 10 of them.
const TRAILING_LINKS = /(?:[ \t]+(?:by|on|before|until|till|from|at|of|for|in|within|no later than|the|this|next))+[ \t]*$/i;
const LEADING_LINKS = /^(?:so that|so|and|but|then|also|which|because)[ \t]+/i;
function deadlinePurpose(d) {
  const sentence = tighten(text(d.sentence));
  const at = d.text ? sentence.toLowerCase().indexOf(String(d.text).toLowerCase()) : -1;
  if (at < 0) return '';
  let start = 0;
  const before = sentence.slice(0, at);
  for (const m of before.matchAll(/,(?!\d)|[;:()—–]|\s-\s|\b(?:and|but|so that|so|because|which|then)\b/gi)) start = m.index;
  let what = before.slice(start).replace(/^[,;:()—–\s-]+/, '').replace(LEADING_LINKS, '').replace(TRAILING_LINKS, '').trim();
  if (countWords(what) < 2) {
    // "…, so by 10 November": use the start of the sentence instead.
    what = sentence.split(/,(?!\d)|[;:—–]|\s-\s/)[0].replace(TRAILING_LINKS, '').trim();
    if (what.toLowerCase().includes(String(d.text).toLowerCase())) what = what.slice(0, what.toLowerCase().indexOf(String(d.text).toLowerCase())).replace(TRAILING_LINKS, '').trim();
  }
  const words = what.replace(/[\s,;:.!?]+$/, '').split(/\s+/).filter(Boolean);
  if (words.length < 2) return '';
  return capitalise(abbreviate(words));
}

// About 10 words at most. A long one keeps its start (what) and its end (the verb): "Your
// online Self Assessment … must be submitted". A "not" or "unless" is never cut out of the
// middle, which would reverse the meaning: from the first one on is kept instead ("£480 will
// be taken from … unless you cancel it", "… not send the original documents or your passport to us").
function abbreviate(words) {
  if (words.length <= 10) return words.join(' ');
  const neg = words.findIndex((w, i) => i >= 5 && i < words.length - 3 && NEGATION_WORD.test(w.replace(/[^\p{L}'’]/gu, '')));
  if (neg < 0) return `${words.slice(0, 5).join(' ')} … ${words.slice(-3).join(' ')}`;
  const tail = words.slice(neg);
  const head = words.slice(0, Math.min(5, Math.max(0, 10 - tail.length)));
  return `${head.length ? `${head.join(' ')} ` : ''}… ${abbreviate(tail)}`;
}

// The date as written, with its time: "Wednesday at 10am".
function deadlineWhen(d) {
  const when = text(d.text);
  const time = text(d.time);
  return time && !when.toLowerCase().includes(time.toLowerCase()) ? `${when} at ${time}` : when;
}

// ---------- the summary ----------

/**
 * The offline short version of an email.
 * @param {object} cleaned  what cleaner.clean() returned
 * @param {string} subject
 * @param {string} [original]  the full original text (originalText), for the word count and
 *   for when the cleaner kept nothing
 * @param {{ deadlines?: object[], names?: string[] }} [opts]  deadlines: dates.findDeadlines()
 *   for this email; these become `dates`. Without them, the cleaner's dates are listed as
 *   written (day: null). names: the user's first names, lower case ('will'): an ask that
 *   speaks to them by name ("Will, could you…") leads the gist.
 * @returns {EmailSummary}
 */
function heuristicSummary(cleaned, subject, original = '', opts = {}) {
  const c = cleaned && typeof cleaned === 'object' ? cleaned : {};
  const body = typeof c.body === 'string' ? c.body : '';
  const actions = texts(c.actions);
  const questions = texts(c.questions);
  const keyPoints = texts(c.keyPoints);
  const deadlines = Array.isArray(opts?.deadlines) ? opts.deadlines.filter((d) => d && typeof d === 'object') : null;
  const deadlineSentences = (deadlines || []).map((d) => text(d.sentence)).filter(Boolean);
  const names = namesOf(opts?.names);

  // Person mail leads with what they ask, an ask that names the user first ("Will, could
  // you…", in a group's mail too); anything else with its most informative fact.
  const personal = c.category === 'person' || !CATEGORIES.includes(c.category);
  const lead = (personal || c.category === 'newsletter' ? namedAsk(body, actions, questions, names) : '')
    || (personal ? firstAsk(body, actions, questions) : '')
    || bestFact(keyPoints, deadlineSentences);
  const gist = lead ? shorten(tighten(lead)) : text(subject) || '(no text)';
  const gistPlain = plain(gist);
  const cutFrom = (s) => gist.endsWith('…') && plain(tighten(s)).startsWith(plain(gist.slice(0, -1)));
  // A cut gist that kept every fact makes the full sentence a repeat; one that lost facts doesn't.
  const factCount = (s) => factTokens(s).facts.length;
  const repeats = (s) => plain(tighten(s)) === gistPlain || (cutFrom(s) && factCount(gist.slice(0, -1)) >= factCount(s));

  const asks = [...actions, ...questions];
  const keyPointsOut = keyPoints
    .filter((p) => !asks.some((a) => squash(a).includes(squash(p))) && !repeats(p))
    .map(tighten);
  // The cleaner kept nothing: show the start of the original rather than nothing at all.
  if (!keyPoints.length && !body.trim() && String(original || '').trim()) keyPointsOut.push(firstWords(original, 40));

  // The deadline written in a task (also when the same date was first found in another sentence).
  const dueFor = (task) => {
    const all = deadlines || [];
    const d = all.find((x) => overlaps(text(x.sentence), task)) || all.find((x) => text(x.text) && task.toLowerCase().includes(text(x.text).toLowerCase()));
    return d ? deadlineWhen(d) : '';
  };
  const actionItems = actions
    .filter((a) => plain(tighten(a)) !== gistPlain)
    .map((a) => ({ task: tighten(a), due: dueFor(a) }));
  const questionsOut = questions.filter((q) => plain(tighten(q)) !== gistPlain).map(tighten);

  const dates = deadlines
    ? deadlines.map((d) => ({ what: deadlinePurpose(d), when: deadlineWhen(d), day: DAY_KEY.test(d.day) ? d.day : null }))
    : texts(c.dates).map((when) => ({ what: '', when, day: null }));
  const seenDates = new Set();
  const uniqueDates = dates.filter((d) => {
    const key = `${d.day}|${plain(d.when)}`;
    if (!d.when || seenDates.has(key)) return false;
    seenDates.add(key);
    return true;
  });

  const originalWords = countWords(String(original || '')) || countOf(c.stats?.rawWords) || countWords(body);
  const shortWords = countWords([gist, ...keyPointsOut, ...actionItems.map((a) => a.task), ...questionsOut].join(' '));

  return normalizeSummary({
    gist,
    key_points: keyPointsOut,
    action_items: actionItems,
    questions: questionsOut,
    dates: uniqueDates,
    amounts: c.amounts,
    category: c.category,
    urgency: c.urgency,
    words: { original: originalWords, short: Math.min(shortWords, originalWords) },
  });
}

/** Coerces anything into the EmailSummary v2 shape. fallback fills a bad gist/category/urgency. */
function normalizeSummary(raw, fallback = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  const pick = (value, allowed, alt, dflt) => (allowed.includes(value) ? value : allowed.includes(alt) ? alt : dflt);
  const words = s.words && typeof s.words === 'object' ? s.words : {};
  return {
    gist: shorten(text(s.gist) || text(fb.gist) || '(no text)'),
    key_points: texts(s.key_points),
    action_items: list(s.action_items)
      .map((a) => (typeof a === 'string' ? { task: text(a), due: '' } : { task: text(a?.task), due: text(a?.due) }))
      .filter((a) => a.task)
      .slice(0, MAX_ITEMS),
    questions: texts(s.questions),
    dates: list(s.dates)
      .map((d) => ({ what: text(d?.what), when: text(d?.when), day: DAY_KEY.test(d?.day) ? d.day : null }))
      .filter((d) => d.what || d.when)
      .map((d) => (d.when ? d : { ...d, what: '', when: d.what }))
      .slice(0, MAX_ITEMS),
    amounts: texts(s.amounts),
    category: pick(s.category, CATEGORIES, fb.category, 'person'),
    urgency: pick(s.urgency, URGENCIES, fb.urgency, 'normal'),
    words: { original: countOf(words.original), short: countOf(words.short) },
  };
}

/** The full uncleaned text: the text part, or the HTML converted to text. */
function originalText(email) {
  const e = email && typeof email === 'object' ? email : {};
  if (e.text && String(e.text).trim()) return String(e.text);
  try {
    return e.html ? htmlToText(e.html) : '';
  } catch {
    return '';
  }
}

module.exports = { heuristicSummary, normalizeSummary, originalText, tighten, factTokens, sameFacts, MAX_GIST_WORDS };
