/* global clearmail */
'use strict';

// Shared by the other renderer scripts. They are classic scripts loaded in this order:
// common.js, brief.js, people.js, settings.js, app.js, so they all see these names.
// Nothing in this file touches the page while it loads, so the tests can load it alone.
//
// Safety rules for every renderer file:
// - Pages are built with el() and text nodes only: no innerHTML, and email HTML is never shown.
// - ClearMail only reads. Nothing here can send, delete, move or mark email: the user replies
//   in Outlook (or their Mail app), and Copy subject helps them find the email there.

const $ = (id) => document.getElementById(id);

const DAY = 86400000;
const LINK_CHIPS = 4; // links shown before "+N more"
const BUCKETS = ['needs-you', 'worth-knowing', 'noise'];
const BUCKET_LABEL = { 'needs-you': 'Needs you', 'worth-knowing': 'Worth knowing', noise: 'Noise' };
const CATEGORIES = ['person', 'receipt', 'newsletter', 'promo', 'notification'];

const state = {
  tab: 'brief', // 'brief' | 'people'
  emails: [], // EmailViews from the last BriefView, tidied
  byId: new Map(),
  accounts: [], // [{ id, email, kind, error, needsSignIn }]
  counts: { needsYou: 0, needsYouNew: 0, worthKnowing: 0, noise: 0, done: 0 },
  demo: false,
  demoReason: null,
  generatedAt: null,
  sinceLabel: '',
  loaded: false,
  loading: false,
  loadError: null,

  // Per email, in memory only.
  reading: new Map(), // id -> 'original' | 'cleaned' while Read is open
  copied: null, // id of the email whose subject was just copied ("✓ Copied" for a moment)
  allLinks: new Set(), // ids showing every link
  busy: new Set(), // ids waiting for a sorting change to come back
  open: new Set(), // collapsed parts of the Brief the user opened ('earlier', 'noise', 'done', 'group:<sender>')
  menu: null, // id of the email whose ⋯ menu is open
  readNoteShown: false, // the "ClearMail only reads" note, shown in the first session Read is used

  // By person
  selected: null,
  search: '',
  filter: 'all',
  keepVisible: null,
};

// ---------- building the page ----------

// Elements are always built from text: never from HTML. Event handlers must be functions,
// and inline styles are never set (the CSP forbids them).
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) {
      if (typeof v === 'function') node.addEventListener(k.slice(2), v);
    } else if (k === 'class') {
      node.className = v;
    } else if (k !== 'style') {
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Errors from the main process arrive as "Error invoking remote method 'x': message".
const errText = (err) =>
  String(err?.message || err || '').replace(/^Error invoking remote method '[^']+': /, '').replace(/^(?:Error: )+/, '').trim()
  || 'Something went wrong. Please try again.';

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) return Date.parse(v);
  return NaN;
}

const initials = (name) =>
  name.replace(/["'<>]/g, '').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';

function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// The colour is set through the CSSOM, which the CSP allows (a style attribute it would block).
function avatar(name, key) {
  const a = el('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(name));
  a.style.setProperty('--h', hue(key));
  return a;
}

// ---------- dates ----------

// Building a date formatter is slow, so each set of options gets one, made once.
const formatters = new Map();
function formatDate(d, options) {
  const key = JSON.stringify(options);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat([], options));
  return formatters.get(key).format(d);
}

const clock = (d) => formatDate(d, { hour: '2-digit', minute: '2-digit' });

// Calendar days between today and d. Rounded, so a 23- or 25-hour DST day still counts as one.
function daysAgo(d) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return Math.round((today - day) / DAY);
}

const sameYear = (d) => d.getFullYear() === new Date().getFullYear();

function timeLabel(iso) {
  const d = new Date(iso);
  const days = daysAgo(d);
  if (days === 0) return clock(d);
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return formatDate(d, { weekday: 'long' });
  // Older, or dated in the future (a wrong clock): show the actual date.
  return formatDate(d, { day: 'numeric', month: 'short', year: sameYear(d) ? undefined : 'numeric' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const days = daysAgo(d);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return formatDate(d, { weekday: 'long', day: 'numeric', month: 'long', year: sameYear(d) ? undefined : 'numeric' });
}

// "today at 07:30", "tomorrow at 07:30", "Monday at 07:30", "12 Nov at 07:30"
function whenLabel(t) {
  const d = new Date(t);
  const ahead = -daysAgo(d);
  const time = clock(d);
  if (ahead === 0) return `today at ${time}`;
  if (ahead === 1) return `tomorrow at ${time}`;
  if (ahead === -1) return `yesterday at ${time}`;
  if (ahead > 1 && ahead < 7) return `${formatDate(d, { weekday: 'long' })} at ${time}`;
  return `${formatDate(d, { day: 'numeric', month: 'short' })} at ${time}`;
}

const fullDate = (iso) => new Date(iso).toLocaleString();
const fileSize = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- notices ----------

// A short message under the top bar. action: { label, run } adds a button, such as Undo.
// ms: how long it stays.
let noticeTimer = null;
function notice(text, action = null, ms = action ? 12000 : 10000) {
  const n = $('notice');
  if (!n) return;
  n.replaceChildren(...(text ? [
    el('span', { class: 'notice-text' }, text),
    action ? el('button', {
      type: 'button', class: 'notice-action', onclick: (e) => {
        e.stopPropagation();
        notice('');
        action.run();
      },
    }, action.label) : null,
  ].filter(Boolean) : [])); // (replaceChildren would show a null as the text "null")
  n.hidden = !text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => notice(''), ms);
}

function openLink(url) {
  Promise.resolve().then(() => clearmail.openLink(url)).catch((err) => notice(`Couldn't open the link: ${errText(err)}`));
}

// ---------- data from the main process (checked, so a bad field can't break the UI) ----------

function tidySummary(raw, email) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const words = s.words && typeof s.words === 'object' ? { original: num(s.words.original) || 0, short: num(s.words.short) || 0 } : null;
  return {
    gist: str(s.gist) || email.subject || '(no text)',
    category: CATEGORIES.includes(s.category) ? s.category : 'person',
    urgency: ['high', 'normal', 'low'].includes(s.urgency) ? s.urgency : 'normal',
    key_points: arr(s.key_points).map(str).filter(Boolean),
    action_items: arr(s.action_items)
      .map((a) => (typeof a === 'string' ? { task: a, due: '' } : { task: str(a?.task), due: str(a?.due) }))
      .filter((a) => a.task),
    dates: arr(s.dates)
      .map((d) => ({ what: str(d?.what), when: str(d?.when) }))
      .filter((d) => d.what || d.when)
      .map((d) => (d.when ? d : { what: '', when: d.what })),
    questions: arr(s.questions).map(str).filter(Boolean),
    amounts: arr(s.amounts).map(str).filter(Boolean),
    words: words && words.original ? words : null,
  };
}

function tidyDeadline(d) {
  if (!d || typeof d !== 'object' || !str(d.label)) return null;
  return { label: str(d.label), daysAway: num(d.daysAway), uncertain: Boolean(d.uncertain), time: str(d.time), day: str(d.day) };
}

// An email whose sorting is missing or broken goes to Worth knowing: never hidden as noise.
function tidyTriage(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    bucket: BUCKETS.includes(t.bucket) ? t.bucket : 'worth-knowing',
    reasons: arr(t.reasons).map(str).filter(Boolean).slice(0, 3),
    codes: arr(t.codes).map(str).filter(Boolean),
    deadline: tidyDeadline(t.deadline),
    caution: str(t.caution) || null,
  };
}

function tidyEmail(m) {
  const from = m?.from || {};
  const date = new Date(m?.date);
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const received = new Date(m?.receivedAt);
  const links = arr(m?.links ?? m?.cleaned?.links);
  const email = {
    id: str(m?.id),
    accountId: str(m?.accountId),
    accountEmail: str(m?.accountEmail), // the user's address it was sent to
    from: { name: str(from.name) || str(from.address) || 'Unknown sender', address: str(from.address) },
    subject: str(m?.subject),
    date: iso,
    receivedAt: Number.isNaN(received.getTime()) ? iso : received.toISOString(),
    seen: Boolean(m?.seen), // Outlook's read state: shown, never changed
    attachments: arr(m?.attachments).map((a) => ({ filename: str(a?.filename) || 'attachment', size: Number(a?.size) || 0 })),
    original: str(m?.original),
    cleanedBody: str(m?.cleanedBody ?? m?.cleaned?.body),
    links: links.filter((l) => typeof l?.url === 'string').map((l) => ({ url: l.url, label: str(l.label) || l.url })),
    triage: tidyTriage(m?.triage),
    isNew: Boolean(m?.isNew),
    done: Boolean(m?.done),
    notNoise: Boolean(m?.notNoise),
    senderRule: m?.senderRule === 'important' || m?.senderRule === 'noise' ? m.senderRule : null,
    canOpen: Boolean(m?.canOpen),
  };
  email.summary = tidySummary(m?.summary, email);
  if (!email.summary.amounts.length) email.summary.amounts = arr(m?.cleaned?.amounts).map(str).filter(Boolean);
  return email;
}

const tidyAccount = (a) => ({
  id: str(a?.id),
  email: str(a?.email),
  kind: a?.kind === 'microsoft' ? 'microsoft' : 'imap',
  error: str(a?.error) || null,
  needsSignIn: a?.kind === 'microsoft' && Boolean(a?.needsSignIn),
});

const isView = (v) => Boolean(v && typeof v === 'object' && Array.isArray(v.emails));

// With more than one account, each email says which of the user's addresses it was sent to.
const multiAccount = () => state.accounts.length > 1;
const accountOf = (m) => state.accounts.find((a) => a.id === m.accountId) || null;
const ruleKey = (m) => m.from.address.trim().toLowerCase();

// ---------- the BriefView ----------

function applyView(view) {
  const emails = arr(view.emails).map(tidyEmail).filter((m) => m.id);
  state.emails = emails;
  state.byId = new Map(emails.map((m) => [m.id, m]));
  state.accounts = arr(view.accounts).map(tidyAccount).filter((a) => a.id);
  const c = view.counts && typeof view.counts === 'object' ? view.counts : {};
  for (const k of Object.keys(state.counts)) state.counts[k] = num(c[k]) ?? 0;
  state.demo = Boolean(view.demo);
  state.demoReason = str(view.demoReason) || null;
  const generated = toMs(view.generatedAt);
  state.generatedAt = Number.isNaN(generated) ? Date.now() : generated;
  state.sinceLabel = str(view.sinceLabel);
  state.loaded = true;
  state.loadError = null;
  // Forget the open parts of emails that have gone.
  for (const id of [...state.reading.keys()]) if (!state.byId.has(id)) state.reading.delete(id);
  for (const id of [...state.busy]) if (!state.byId.has(id)) state.busy.delete(id);
  if (state.menu && !state.byId.has(state.menu)) state.menu = null;
}

// Every request that returns a BriefView goes through here or load(), so an older answer
// never replaces a newer one. A sorting change made while the inbox is loading waits for
// the load, so the load can't bring back the old sorting afterwards.
let viewGen = 0;
let loadRun = null;
let loadAgain = false;
let actionsInFlight = 0;
let refreshWanted = false; // main said the inbox changed while something else was on its way

async function viewAction(task) {
  actionsInFlight++;
  try {
    if (loadRun) await loadRun.catch(() => {});
    const gen = ++viewGen;
    const view = await task();
    if (gen === viewGen && isView(view)) {
      applyView(view);
      renderAll();
    }
    return view;
  } finally {
    actionsInFlight--;
    if (!actionsInFlight && !loadRun && refreshWanted) {
      refreshWanted = false;
      load();
    }
  }
}

// inbox:updated. Shown straight away unless a load or a sorting change is on its way, in which
// case the inbox is fetched again (main reuses its recent load) once they're done, so an older
// view never replaces a newer one.
function inboxUpdated(data) {
  if (loadRun || actionsInFlight) {
    refreshWanted = true;
    return;
  }
  if (!isView(data)) {
    load();
    return;
  }
  ++viewGen;
  applyView(data);
  renderAll();
  if (typeof settingsLoaded === 'function') settingsLoaded();
}

// force: fetch from the server even if the last load is recent.
function load({ force = false } = {}) {
  if (loadRun) {
    if (force) loadAgain = true;
    return loadRun;
  }
  const gen = ++viewGen;
  state.loading = true;
  renderAll();
  loadRun = (async () => {
    try {
      const view = await clearmail.loadInbox({ force });
      if (gen === viewGen) {
        if (!isView(view)) throw new Error("ClearMail couldn't read your inbox. Please try again.");
        applyView(view);
      }
    } catch (err) {
      if (gen === viewGen) {
        state.loadError = errText(err);
        checkSignIns(gen);
      }
    } finally {
      state.loading = false;
      loadRun = null;
      renderAll();
      if (typeof settingsLoaded === 'function') settingsLoaded();
      if (loadAgain) {
        loadAgain = false;
        load({ force: true });
      } else if (refreshWanted && !actionsInFlight) {
        refreshWanted = false;
        load();
      }
    }
  })();
  return loadRun;
}

// When every account failed, the load doesn't list them: Settings says which ones
// Microsoft wants signed in again, so the error box can offer the button.
async function checkSignIns(gen) {
  let s;
  try {
    s = await clearmail.getSettings();
  } catch {
    return; // the error box already says what went wrong
  }
  if (gen !== viewGen || !state.loadError) return;
  state.accounts = arr(s?.accounts).map((a) => tidyAccount({ ...a, error: null })).filter((a) => a.id);
  renderChrome();
}

// ---------- sorting changes (Done, Not noise, sender rules) ----------
// Each one is saved by main, which sorts the emails again without fetching them.

async function setDone(ids, on, { quiet = false } = {}) {
  const list = ids.map((id) => state.byId.get(id)).filter(Boolean);
  if (!list.length) return;
  const before = list.map((m) => [m, m.done]);
  for (const m of list) m.done = on; // shown straight away; main's answer confirms it
  renderAll();
  try {
    await viewAction(() => clearmail.setDone(list.map((m) => m.id), on));
  } catch (err) {
    for (const [m, was] of before) m.done = was;
    renderAll();
    notice(`${on ? "Couldn't mark it done" : "Couldn't undo that"}: ${errText(err)}`);
    return;
  }
  if (!quiet && on) {
    notice(list.length === 1 ? 'Marked done.' : `Marked ${list.length} emails done.`,
      { label: 'Undo', run: () => setDone(list.map((m) => m.id), false, { quiet: true }) });
  }
}

async function withBusy(ids, task) {
  for (const id of ids) state.busy.add(id);
  renderAll();
  try {
    return await task();
  } finally {
    for (const id of ids) state.busy.delete(id);
    renderAll();
  }
}

// rule: 'important', 'noise' or null to remove the rule.
async function setRule(m, rule, { quiet = false } = {}) {
  const address = ruleKey(m);
  if (!address) return;
  const was = m.senderRule;
  const ids = state.emails.filter((x) => ruleKey(x) === address).map((x) => x.id);
  try {
    await withBusy(ids, () => viewAction(() => clearmail.setRule(address, rule)));
  } catch (err) {
    notice(`Couldn't change how emails from ${m.from.name} are sorted: ${errText(err)}`);
    return;
  }
  state.menu = null;
  renderAll();
  if (quiet) return;
  const text = rule === 'important' ? `Emails from ${m.from.name} will always go to Needs you.`
    : rule === 'noise' ? `Emails from ${m.from.name} will go to Noise. Nothing is deleted.`
      : `Emails from ${m.from.name} are sorted as usual again.`;
  notice(text, { label: 'Undo', run: () => setRule(m, was, { quiet: true }) });
}

async function setNotNoise(ids, on, { quiet = false } = {}) {
  const list = ids.filter((id) => state.byId.has(id));
  if (!list.length) return;
  try {
    await withBusy(list, async () => {
      // One call per email (the channel takes one id); only the last answer is shown.
      for (const id of list) await viewAction(() => clearmail.setNotNoise(id, on));
    });
  } catch (err) {
    notice(`Couldn't move it: ${errText(err)}`);
    return;
  }
  state.menu = null;
  renderAll();
  if (quiet) return;
  const text = on ? (list.length === 1 ? 'Moved out of Noise.' : `Moved ${list.length} emails out of Noise.`) : 'Put back in Noise.';
  notice(text, { label: 'Undo', run: () => setNotNoise(list, !on, { quiet: true }) });
}

// Opens the email in Outlook on the web (Microsoft) or the Mail app (other accounts). Main
// works out the address from the email's id; the page never sends one.
function openInMailApp(m) {
  state.menu = null;
  renderAll();
  Promise.resolve().then(() => clearmail.openEmail(m.id)).catch((err) => notice(`Couldn't open the email: ${errText(err)}`));
}

const openLabel = (m) => (accountOf(m)?.kind === 'imap' ? 'Open in Mail' : 'Open in Outlook on the web');

// ---------- finding the email in Outlook ----------
// ClearMail only reads, so the user replies in Outlook (or their Mail app). Copy subject puts
// the email's subject on the clipboard for Outlook's search. Only the id goes to main, which
// copies that email's own subject: the page never chooses the text.

const COPIED_TEXT = "Copied. Paste it into Outlook's search to find the email.";
const COPIED_MS = 3000;
let copiedTimer = null;

async function copySubject(m) {
  try {
    await clearmail.copySubject(m.id);
  } catch (err) {
    notice(errText(err));
    return;
  }
  // The button says "✓ Copied" and the notice says what to do next, both for a moment.
  state.copied = m.id;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    state.copied = null;
    renderAll();
  }, COPIED_MS);
  renderAll();
  notice(COPIED_TEXT, null, COPIED_MS);
}

// cls: the button's look ('btn' in the Brief, 'linkish' in By person).
function copyButton(m, cls) {
  const copied = state.copied === m.id;
  return el('button', {
    type: 'button', class: `${cls}${copied ? ' is-copied' : ''}`, 'data-act': 'copy-subject',
    title: "Copy the subject, then paste it into Outlook's search to find the email and reply there",
    'aria-label': `Copy the subject of the email from ${m.from.name}`,
    onclick: () => copySubject(m),
  }, copied ? '✓ Copied' : 'Copy subject');
}

// ---------- pieces shared by the Brief and By person ----------

// The deadline chip: red if it's due within a day or has passed, amber within 3 days.
function deadlineChip(d) {
  if (!d) return null;
  const away = d.daysAway;
  const tone = away != null && away <= 1 ? 'red' : away != null && away <= 3 ? 'amber' : 'plain';
  const text = `${away != null && away < 0 ? 'Was due' : 'Due'} ${d.label}${d.time ? ` ${d.time}` : ''}${d.uncertain ? ' ?' : ''}`;
  return el('span', {
    class: `chip-static deadline ${tone}`,
    title: d.uncertain ? "ClearMail isn't sure about this date. Check the email." : null,
  }, text);
}

// Chips for the deadline, amounts, attachments and links. links: false leaves the links out.
function chipsFor(m, { deadline = true, links: showLinks = true } = {}) {
  const all = state.allLinks.has(m.id);
  const links = showLinks ? (all ? m.links : m.links.slice(0, LINK_CHIPS)) : [];
  const more = showLinks ? m.links.length - links.length : 0;
  const toggleLinks = (on) => {
    if (on) state.allLinks.add(m.id);
    else state.allLinks.delete(m.id);
    renderAll();
  };
  const chips = [
    deadline ? deadlineChip(m.triage.deadline) : null,
    ...m.summary.amounts.map((a) => el('span', { class: 'chip-static money' }, a)),
    ...m.attachments.map((a) => el('span', { class: 'chip-static' }, `📎 ${a.filename}${a.size ? ` (${fileSize(a.size)})` : ''}`)),
    ...links.map((l, i) => el('button', { class: 'chip-link', type: 'button', title: l.url, 'data-act': `link-${i}`, onclick: () => openLink(l.url) }, `🔗 ${l.label}`)),
    more > 0 ? el('button', { class: 'chip-more', type: 'button', 'aria-expanded': 'false', 'data-act': 'links', onclick: () => toggleLinks(true) },
      `+${plural(more, 'more link', 'more links')}`) : null,
    showLinks && all && m.links.length > LINK_CHIPS ? el('button', { class: 'chip-more', type: 'button', 'aria-expanded': 'true', 'data-act': 'links', onclick: () => toggleLinks(false) },
      'Fewer links') : null,
  ].filter(Boolean);
  return chips.length ? el('div', { class: 'chips' }, chips) : null;
}

function box(icon, title, items, cls) {
  if (!items.length) return null;
  return el('div', { class: `box ${cls}` },
    el('div', { class: 'box-title' }, `${icon} ${title}`),
    el('ul', {}, items));
}

// The rest of the short version: key points, what they asked, what to do and the dates.
function shortVersion(m) {
  const s = m.summary;
  return [
    s.key_points.length ? el('ul', { class: 'points' }, s.key_points.map((p) => el('li', {}, p))) : null,
    box('📌', 'You need to', s.action_items.map((a) => el('li', {}, a.task, a.due ? el('span', { class: 'due' }, a.due) : null)), 'todo'),
    box('❓', 'They asked', s.questions.map((q) => el('li', {}, q)), 'ask'),
    box('📅', 'Dates', s.dates.map((d) => el('li', {}, d.what ? `${d.what}: ` : '', el('b', {}, d.when))), 'dates'),
  ];
}

const wordsLine = (m) => (m.summary.words
  ? el('p', { class: 'words' }, `Short version: ${m.summary.words.short} of ${m.summary.words.original} words`)
  : null);

// The whole email as text (HTML is never shown), with a switch to the cleaned version.
function fullEmail(m, view, onView) {
  const text = view === 'cleaned'
    ? m.cleanedBody || 'Nothing was left after cleaning. Switch to Original to read it.'
    : m.original || m.cleanedBody || 'This email has no text.';
  const tab = (mode, label) => el('button', {
    class: 'tab', type: 'button', 'aria-pressed': String(view === mode), 'data-act': `view-${mode}`,
    onclick: () => onView(mode),
  }, label);
  return el('div', { class: 'full-wrap' },
    el('div', { class: 'full-tabs', role: 'group', 'aria-label': 'Show the email' },
      tab('original', 'Original'),
      tab('cleaned', 'Cleaned')),
    el('div', { class: 'full', tabindex: 0, 'data-act': 'full-text', 'aria-label': view === 'cleaned' ? 'Cleaned email' : 'Original email' }, text));
}

// Shown in the first session the user opens an email in ClearMail.
function readNote() {
  let seen = false;
  try {
    seen = localStorage.getItem('clearmail.readNote') === '1';
    if (!seen) localStorage.setItem('clearmail.readNote', '1');
  } catch { /* storage unavailable: show it this time */ }
  if (!seen) state.readNoteShown = true;
  return state.readNoteShown
    ? el('p', { class: 'read-note' }, 'ClearMail only reads your email. To reply, find it in Outlook (Copy subject helps) and reply there. Emails stay unread in Outlook.')
    : null;
}

// The "Why:" line. A deadline reason after the first is left out when the deadline chip
// already says it ("Due tomorrow" twice reads oddly).
const DEADLINE_CODES = new Set(['deadline-soon', 'overdue', 'deadline-later', 'deadline-past']);
function whyLine(m) {
  const { reasons, codes, deadline } = m.triage;
  const shown = reasons.filter((r, i) => i === 0 || !deadline || !DEADLINE_CODES.has(codes[i]));
  return shown.length ? el('p', { class: 'why' }, el('span', { class: 'why-label' }, 'Why: '), shown.join(' · ')) : null;
}

function bucketBadge(m) {
  if (m.done) return el('span', { class: 'bucket-badge b-done', title: 'You marked it done' }, '✓ Done');
  const b = m.triage.bucket;
  return el('span', { class: `bucket-badge b-${b}`, title: m.triage.reasons.join(' · ') || BUCKET_LABEL[b] }, BUCKET_LABEL[b]);
}

// ---------- re-rendering without losing your place ----------

// Redraws a part of the page, keeping its scroll position and the keyboard focus (and the
// scroll position of a full email that has the focus).
function keepFocus(scroller, container, render) {
  const a = document.activeElement;
  const inside = a && container.contains(a) && a !== container;
  const holder = inside ? a.closest('[data-id], [data-sender]') : null;
  const memo = inside ? {
    key: holder ? ['id', 'sender'].map((k) => holder.dataset[k] && `[data-${k}="${CSS.escape(holder.dataset[k])}"]`).find(Boolean) : '',
    act: a.dataset.act,
    scroll: a.scrollTop,
  } : null;
  const top = scroller.scrollTop;
  render();
  scroller.scrollTop = top;
  if (!memo || (a.isConnected && document.activeElement === a)) return; // still there: leave it alone
  const target = memo.act ? container.querySelector(`${memo.key || ''} [data-act="${CSS.escape(memo.act)}"]`.trim()) : null;
  if (target && !target.disabled) {
    target.focus({ preventScroll: true });
    target.scrollTop = memo.scroll;
  } else if (document.activeElement === document.body) {
    container.focus({ preventScroll: true }); // the button went (e.g. the email moved to Done): stay nearby
  }
}
