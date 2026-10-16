/* global clearmail */
'use strict';

const $ = (id) => document.getElementById(id);

const DAY = 86400000;
const FLAG_DAYS = 30; // older mail isn't flagged, so a first load doesn't bury "Needs me"
const LINK_CHIPS = 4; // links shown before "+N more"
const DONE_KEY = 'clearmail.done';

const state = {
  emails: [],
  accounts: [], // from the last load: [{ id, email, kind, error, needsSignIn }]
  sent: {}, // conversation key -> [{ body, date, emailId, accountEmail, status: 'pending'|'sent'|'demo'|'failed', error }]
  drafts: {}, // conversation key -> unsent reply text
  filter: 'all',
  search: '',
  selected: null,
  keepVisible: null, // the open conversation stays in a filtered list until the selection changes
  unreadMark: null, // { id, count }: the first email that was unread when the conversation was opened
  demo: false,
  demoReason: null,
  aiEnabled: false,
  aiError: null,
  loaded: false,
  loading: false,
  loadError: null,
  expanded: new Map(), // email id -> 'original' | 'cleaned'
  allLinks: new Set(), // email ids showing every link
  done: loadDone(), // email id -> when the user marked it done
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
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

const initials = (name) =>
  name.replace(/["'<>]/g, '').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';

function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatar(name, key) {
  const a = el('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(name));
  a.style.setProperty('--h', hue(key));
  return a;
}

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

const fileSize = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

let noticeTimer = null;
function notice(text) {
  const n = $('notice');
  n.textContent = text;
  n.hidden = !text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => notice(''), 10000);
}

function openLink(url) {
  Promise.resolve().then(() => clearmail.openLink(url)).catch((err) => notice(`Couldn't open the link: ${errText(err)}`));
}

// ---------- data from the main process (checked, so a bad field can't break the UI) ----------

const CATEGORIES = ['person', 'receipt', 'newsletter', 'promo', 'notification'];

function tidySummary(raw, email) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    source: s.source === 'ai' ? 'ai' : 'offline',
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
    reply_suggestions: arr(s.reply_suggestions).map(str).filter(Boolean),
    error: str(s.error),
  };
}

function tidyEmail(m) {
  const from = m?.from || {};
  const c = m?.cleaned || {};
  const date = new Date(m?.date);
  const email = {
    ...m,
    id: str(m?.id),
    accountId: str(m?.accountId),
    accountEmail: str(m?.accountEmail), // the address it was sent to
    from: { name: str(from.name) || str(from.address) || 'Unknown sender', address: str(from.address) },
    replyTo: m?.replyTo?.address ? { name: str(m.replyTo.name), address: str(m.replyTo.address) } : null,
    subject: str(m?.subject),
    date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    seen: Boolean(m?.seen),
    attachments: arr(m?.attachments).map((a) => ({ filename: str(a?.filename) || 'attachment', size: Number(a?.size) || 0 })),
    original: str(m?.original),
    cleaned: {
      ...c,
      body: str(c.body),
      amounts: arr(c.amounts).map(str).filter(Boolean),
      links: arr(c.links).filter((l) => typeof l?.url === 'string').map((l) => ({ url: l.url, label: str(l.label) || l.url })),
      stats: { rawWords: Number(c.stats?.rawWords) || 0, keptWords: Number(c.stats?.keptWords) || 0, saved: Number(c.stats?.saved) || 0 },
    },
  };
  email.summary = tidySummary(m?.summary, email);
  return email;
}

const tidyAccount = (a) => ({
  id: str(a?.id),
  email: str(a?.email),
  kind: a?.kind === 'microsoft' ? 'microsoft' : 'imap',
  error: str(a?.error) || null,
  needsSignIn: a?.kind === 'microsoft' && Boolean(a?.needsSignIn),
});

// With more than one account, bubbles and the composer say which address is involved.
const multiAccount = () => state.accounts.length > 1;

// ---------- "needs me" flags ----------
// Separate from unread: a flag stays until the user marks the email done (saved in this browser).

function loadDone() {
  try {
    const data = JSON.parse(localStorage.getItem(DONE_KEY) || '{}');
    // An email marked done more than FLAG_DAYS ago is too old to be flagged anyway.
    const cutoff = Date.now() - FLAG_DAYS * DAY;
    return new Map(Object.entries(data && typeof data === 'object' ? data : {}).filter(([, at]) => Number(at) > cutoff));
  } catch {
    return new Map();
  }
}

function saveDone() {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(Object.fromEntries(state.done)));
  } catch (err) {
    console.warn('Could not save done flags:', err);
  }
}

// Before ClearMail had several accounts, email ids had no "account:" prefix. Flags saved
// then move to the new id, so emails already dealt with aren't flagged again.
function adoptOldDone(emails) {
  let changed = false;
  for (const m of emails) {
    const prefix = `${m.accountId}:`;
    if (!m.accountId || !m.id.startsWith(prefix) || state.done.has(m.id)) continue;
    const old = m.id.slice(prefix.length);
    if (old.includes(':') || !state.done.has(old)) continue;
    state.done.set(m.id, state.done.get(old));
    state.done.delete(old);
    changed = true;
  }
  if (changed) saveDone();
}

const UPDATE_CATEGORIES = new Set(['receipt', 'newsletter', 'promo', 'notification']);
const CATEGORY_LABEL = { receipt: '🧾 Receipt', newsletter: '📰 Newsletter', promo: '🏷️ Promo', notification: '🔔 Automated' };

const isUpdate = (m) => UPDATE_CATEGORIES.has(m.summary.category);
const recent = (m) => Date.now() - new Date(m.date) < FLAG_DAYS * DAY;
// Questions and to-dos in newsletters and promos are marketing ("Need a new drill?"), not asks.
const asks = (m) => !isUpdate(m) && (m.summary.action_items.length > 0 || m.summary.questions.length > 0);
const flaggable = (m) => recent(m) && (m.summary.urgency === 'high' || asks(m));
const isFlagged = (m) => flaggable(m) && !state.done.has(m.id);

function markDone(ids, on) {
  for (const id of ids) {
    if (on) state.done.set(id, Date.now());
    else state.done.delete(id);
  }
  saveDone();
  renderSidebar();
  for (const m of state.emails) if (ids.includes(m.id)) updateBubble(m);
}

// ---------- conversations ----------

const convoKey = (m) => (m.from.address || m.from.name).toLowerCase();
const byDate = (a, b) => new Date(a.date) - new Date(b.date);

function conversations() {
  const map = new Map();
  for (const m of state.emails) {
    const key = convoKey(m);
    if (!map.has(key)) map.set(key, { key, emails: [] });
    map.get(key).emails.push(m);
  }
  const list = [...map.values()].map((c) => {
    c.emails.sort(byDate);
    c.latest = c.emails[c.emails.length - 1];
    // Named after the newest email, e.g. "Jane via GitHub" from a shared notifications address.
    c.name = c.latest.from.name;
    c.address = c.latest.from.address;
    c.unread = c.emails.filter((m) => !m.seen).length;
    const flagged = c.emails.filter(isFlagged);
    c.action = flagged.length > 0;
    c.urgent = flagged.some((m) => m.summary.urgency === 'high');
    c.todo = flagged.some((m) => !isUpdate(m) && m.summary.action_items.length > 0);
    c.isUpdate = c.emails.every(isUpdate);
    return c;
  });
  return list.sort((a, b) => byDate(b.latest, a.latest));
}

const selectedConvo = () => conversations().find((c) => c.key === state.selected);

const searchCache = new WeakMap();
function searchText(m) {
  if (!searchCache.has(m)) {
    const s = m.summary;
    searchCache.set(m, [
      m.from.name, m.from.address, m.accountEmail, m.subject, s.gist, ...s.key_points, ...s.questions,
      ...s.action_items.map((a) => `${a.task} ${a.due}`), ...s.dates.map((d) => `${d.what} ${d.when}`),
      ...m.attachments.map((a) => a.filename), m.cleaned.body, m.original.slice(0, 200000),
    ].join('\n').toLowerCase());
  }
  return searchCache.get(m);
}

function visibleConversations() {
  const q = state.search.trim().toLowerCase();
  return conversations().filter((c) => {
    if (c.key !== state.keepVisible) {
      if (state.filter === 'action' && !c.action) return false;
      if (state.filter === 'person' && c.isUpdate) return false;
      if (state.filter === 'updates' && !c.isUpdate) return false;
    }
    return !q || c.name.toLowerCase().includes(q) || c.key.includes(q) || c.emails.some((m) => searchText(m).includes(q));
  });
}

// ---------- rendering: sidebar ----------

function chatItem(c, tabbable) {
  const selected = state.selected === c.key;
  const flag = c.urgent ? el('span', { class: 'flag urgent' }, 'Urgent')
    : c.todo ? el('span', { class: 'flag action' }, 'To do')
      : c.action ? el('span', { class: 'flag ask' }, 'Asked you') : null;
  return el('li', {
    class: `chat${selected ? ' selected' : ''}${c.unread ? ' unread' : ''}`,
    role: 'option',
    'aria-selected': String(selected),
    tabindex: tabbable ? 0 : -1,
    'data-key': c.key,
    onclick: () => select(c.key),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(c.key);
      }
    },
  },
  avatar(c.name, c.key),
  el('div', { class: 'chat-body' },
    el('div', { class: 'chat-top' },
      el('span', { class: 'chat-name' }, c.name),
      el('span', { class: 'chat-time' }, timeLabel(c.latest.date))),
    el('div', { class: 'chat-bottom' },
      el('span', { class: 'chat-preview' }, flag, c.latest.summary.gist),
      c.unread ? el('span', { class: 'badge' }, c.unread, el('span', { class: 'sr-only' }, ' unread')) : null)));
}

function emptyListText() {
  if (!state.loaded) return state.loading ? 'Loading your inbox…' : 'Nothing to show yet.';
  if (!state.emails.length) return 'Your inbox is empty.';
  if (state.search.trim()) return 'No matches.';
  return state.filter === 'action' ? 'Nothing needs you right now 🎉' : 'Nothing here.';
}

function renderSidebar() {
  const list = $('chat-list');
  // Keep the list's scroll position and keyboard focus across re-renders.
  const focusedKey = document.activeElement?.closest?.('#chat-list .chat')?.dataset.key;
  const scroll = list.scrollTop;
  const convos = visibleConversations();
  const tabKey = convos.some((c) => c.key === state.selected) ? state.selected : convos[0]?.key;
  list.replaceChildren(...convos.map((c) => chatItem(c, c.key === tabKey)));
  if (!convos.length) list.append(el('li', { class: 'none', role: 'presentation' }, emptyListText()));
  list.scrollTop = scroll;
  list.setAttribute('aria-busy', String(state.loading));
  if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
  $('refresh').classList.toggle('busy', state.loading);

  const actionCount = conversations().filter((c) => c.action).length;
  const nv = $('needs-you');
  nv.hidden = actionCount === 0;
  nv.textContent = `${actionCount} ${actionCount === 1 ? 'conversation needs' : 'conversations need'} something from you`;

  renderLoadError();
  renderBanner();
}

// Summaries arrive in bursts: redraw the sidebar at most once per frame.
let sidebarQueued = false;
function renderSidebarSoon() {
  if (sidebarQueued) return;
  sidebarQueued = true;
  requestAnimationFrame(() => {
    sidebarQueued = false;
    renderSidebar();
  });
}

// One account's load error, naming the account unless the message already does.
function accountProblem(a) {
  if (!a.email || a.error.toLowerCase().includes(a.email.toLowerCase())) return a.error;
  return `Couldn't load ${a.email}. ${a.error}`;
}

function renderLoadError() {
  const box = $('load-error');
  const lines = state.loadError
    ? [state.loaded ? `Couldn't refresh your inbox. ${state.loadError} The list below is from the last time it loaded.`
      : `Couldn't load your inbox. ${state.loadError}`]
    : state.accounts.filter((a) => a.error).map(accountProblem); // the other accounts loaded fine
  const signIns = state.accounts.filter((a) => a.needsSignIn);
  const key = JSON.stringify([lines, signIns.map((a) => a.id)]);
  if (box.dataset.text === key) return; // unchanged: don't make screen readers announce it again
  box.dataset.text = key;
  box.hidden = !lines.length && !signIns.length;
  box.replaceChildren(...(box.hidden ? [] : [
    ...lines.map((text) => el('p', {}, text)),
    el('div', { class: 'load-error-actions' },
      signIns.map((a) => el('button', { type: 'button', class: 'strong', onclick: () => openSettings({ signIn: a.id }) },
        signIns.length === 1 ? 'Sign in again' : `Sign in again: ${a.email}`)),
      el('button', { type: 'button', onclick: () => load() }, 'Try again'),
      el('button', { type: 'button', onclick: () => openSettings() }, 'Open Settings')),
  ]));
}

const DEMO_TEXT = {
  flag: 'Demo mode: sample emails (ClearMail was started with --demo).',
  chosen: 'Demo mode: sample emails. Untick Demo mode in Settings to see your inbox.',
  'no-account': 'Demo mode: sample emails. Add your email account in Settings.',
};

function accountsLine() {
  const n = state.accounts.length;
  if (state.demo || state.loadError || n < 2) return null;
  const failed = state.accounts.filter((a) => a.error).length;
  return el('div', { class: failed ? 'ai-off' : null },
    failed ? `⚠︎ ${n - failed} of ${n} accounts loaded` : `Mail from ${n} accounts`);
}

function renderBanner() {
  const banner = $('mode-banner');
  const ai = state.aiError ? el('div', { class: 'ai-off' }, `⚠︎ AI summaries off: ${state.aiError}`)
    : el('div', {}, state.aiEnabled ? 'AI summaries on' : 'Offline mode: add a Claude key in Settings for AI summaries');
  const demo = state.demo ? el('div', {}, DEMO_TEXT[state.demoReason] || DEMO_TEXT['no-account']) : null;
  banner.replaceChildren(...[demo, accountsLine(), ai].filter(Boolean));
}

// ---------- rendering: conversation ----------

function section(icon, title, items, cls) {
  if (!items.length) return null;
  return el('div', { class: `box ${cls}` },
    el('div', { class: 'box-title' }, `${icon} ${title}`),
    el('ul', {}, items));
}

function viewButton(m, mode, label, current) {
  return el('button', {
    class: 'tab', type: 'button', 'aria-pressed': String(current === mode), 'data-act': `view-${mode}`,
    onclick: () => { state.expanded.set(m.id, mode); updateBubble(m); },
  }, label);
}

function fullEmail(m, view) {
  const c = m.cleaned;
  const text = view === 'cleaned'
    ? c.body || 'Nothing was left after cleaning. Switch to Original email to read it.'
    : m.original || c.body || 'This email has no text.';
  return el('div', { class: 'full-wrap' },
    el('div', { class: 'full-tabs', role: 'group', 'aria-label': 'Full email view' },
      viewButton(m, 'original', 'Original email', view),
      viewButton(m, 'cleaned', 'Cleaned', view)),
    el('div', { class: 'full', tabindex: 0, 'aria-label': view === 'cleaned' ? 'Cleaned email' : 'Original email' }, text));
}

function bubble(m, convo) {
  const s = m.summary;
  const c = m.cleaned;
  const view = state.expanded.get(m.id);
  const done = state.done.has(m.id);

  const actions = s.action_items.map((a) =>
    el('li', {}, a.task, a.due ? el('span', { class: 'due' }, a.due) : null));
  const dates = s.dates.map((d) => el('li', {}, d.what ? `${d.what}: ` : '', el('b', {}, d.when)));
  const questions = s.questions.map((q) => el('li', {}, q));

  const allLinks = state.allLinks.has(m.id);
  const links = allLinks ? c.links : c.links.slice(0, LINK_CHIPS);
  const moreLinks = c.links.length - links.length;
  const toggleLinks = (on) => {
    if (on) state.allLinks.add(m.id);
    else state.allLinks.delete(m.id);
    updateBubble(m);
  };
  const chips = [
    ...c.amounts.map((a) => el('span', { class: 'chip-static money' }, `💷 ${a}`)),
    ...m.attachments.map((a) => el('span', { class: 'chip-static' }, `📎 ${a.filename}${a.size ? ` (${fileSize(a.size)})` : ''}`)),
    ...links.map((l, i) => el('button', { class: 'chip-link', type: 'button', title: l.url, 'data-act': `link-${i}`, onclick: () => openLink(l.url) }, `🔗 ${l.label}`)),
    moreLinks > 0 ? el('button', { class: 'chip-more', type: 'button', 'aria-expanded': 'false', 'data-act': 'links', onclick: () => toggleLinks(true) },
      `+${moreLinks} more link${moreLinks === 1 ? '' : 's'}`) : null,
    allLinks && c.links.length > LINK_CHIPS ? el('button', { class: 'chip-more', type: 'button', 'aria-expanded': 'true', 'data-act': 'links', onclick: () => toggleLinks(false) },
      'Fewer links') : null,
  ].filter(Boolean);

  return el('article', { class: `bubble in${s.urgency === 'high' ? ' urgent' : ''}${done ? ' done' : ''}`, 'data-id': m.id, 'data-view': view || '' },
    el('div', { class: 'bubble-meta' },
      CATEGORY_LABEL[s.category] ? el('span', { class: 'cat' }, CATEGORY_LABEL[s.category]) : null,
      m.from.name !== convo.name ? el('span', { class: 'from' }, m.from.name) : null,
      el('span', { class: 'subject' }, m.subject)),
    s.urgency === 'high' ? el('div', { class: 'urgent-tag' }, '⚠︎ Time-sensitive') : null,
    el('p', { class: 'gist' }, s.gist),
    s.key_points.length ? el('ul', { class: 'points' }, s.key_points.map((p) => el('li', {}, p))) : null,
    section('📌', 'You need to', actions, 'todo'),
    section('❓', 'They asked', questions, 'ask'),
    section('📅', 'Dates', dates, 'dates'),
    chips.length ? el('div', { class: 'chips' }, chips) : null,
    s.error ? el('p', { class: 'bubble-note' }, `⚠︎ Offline summary: ${s.error}`) : null,
    view ? fullEmail(m, view) : null,
    el('div', { class: 'bubble-foot' },
      el('div', { class: 'foot-actions' },
        el('button', {
          class: 'linkish', type: 'button', 'aria-expanded': String(Boolean(view)), 'data-act': 'full',
          onclick: () => {
            if (view) state.expanded.delete(m.id);
            else state.expanded.set(m.id, 'original');
            updateBubble(m);
            if (!view) document.querySelector(`[data-id="${CSS.escape(m.id)}"] .full-wrap`)?.scrollIntoView({ block: 'nearest' });
          },
        }, view ? 'Hide full email' : 'Read full email'),
        flaggable(m) ? el('button', {
          class: `linkish done-btn${done ? ' is-done' : ''}`, type: 'button', 'aria-pressed': String(done), 'data-act': 'done',
          title: done ? 'Flag it again' : 'Clear the "needs me" flag for this email',
          onclick: () => markDone([m.id], !done),
        }, done ? '✓ Done' : 'Mark done') : null),
      multiAccount() && m.accountEmail ? el('span', { class: 'to', title: `Sent to your address ${m.accountEmail}` }, `to ${m.accountEmail}`) : null,
      c.stats.saved > 0 ? el('span', { class: 'saved', title: `${c.stats.rawWords} words → ${c.stats.keptWords}` }, `✂︎ ${c.stats.saved} words cut`) : null,
      el('time', { datetime: m.date, title: new Date(m.date).toLocaleString() }, clock(new Date(m.date)))),
  );
}

const TICKS = {
  pending: ['🕓', 'Sending…'],
  sent: ['✓✓', 'Sent'],
  demo: ['✓', 'Demo mode: not really sent'],
};

function outBubble(key, r) {
  const tick = TICKS[r.status];
  return el('article', { class: `bubble out ${r.status}` },
    el('p', {}, r.body),
    el('div', { class: 'bubble-foot' },
      r.status === 'failed' ? el('span', { class: 'err' }, `Not sent: ${r.error}`) : null,
      r.status === 'failed' ? el('button', { class: 'retry', type: 'button', onclick: () => deliver(key, r) }, 'Retry') : null,
      multiAccount() && r.accountEmail ? el('span', { class: 'to' }, `from ${r.accountEmail}`) : null,
      el('time', { datetime: r.date }, clock(new Date(r.date))),
      tick ? el('span', { class: `ticks ${r.status}`, title: tick[1], role: 'img', 'aria-label': tick[1] }, tick[0]) : null));
}

function renderHead(convo) {
  const av = $('convo-avatar');
  av.textContent = initials(convo.name);
  av.style.setProperty('--h', hue(convo.key));
  $('convo-name').textContent = convo.name;
  $('convo-sub').textContent = convo.address;
  $('convo-done').hidden = !convo.action;
  $('reply-input').placeholder = `Reply to ${convo.latest.replyTo?.address || convo.address || convo.name}`;
  // Replies go out from the account that received the newest email.
  const from = multiAccount() ? convo.latest.accountEmail : '';
  const line = $('reply-from');
  if (line.dataset.from !== from) {
    line.dataset.from = from;
    line.hidden = !from;
    line.replaceChildren(...(from ? ['Replying from ', el('b', {}, from)] : []));
  }
}

function renderSuggestions(convo) {
  $('suggestions').replaceChildren(...convo.latest.summary.reply_suggestions.map((t) =>
    el('button', { class: 'chip', type: 'button', onclick: () => useSuggestion(t) }, t)));
}

// scroll: 'keep' (stay where the user is), 'bottom', or 'unread' (first unread email, else bottom).
function renderConversation(scroll = 'keep') {
  const convo = selectedConvo();
  const show = Boolean(convo);
  $('empty').hidden = show;
  $('convo-head').hidden = !show;
  $('messages').hidden = !show;
  $('composer').hidden = !show;
  if (!convo) return;
  renderHead(convo);

  const timeline = [
    ...convo.emails.map((m) => ({ date: m.date, m })),
    ...(state.sent[convo.key] || []).map((r) => ({ date: r.date, r })),
  ].sort(byDate);

  const msgs = $('messages');
  const top = msgs.scrollTop;
  const nodes = [];
  let lastDay = '';
  for (const item of timeline) {
    const day = dayLabel(item.date);
    if (day !== lastDay) {
      nodes.push(el('div', { class: 'day' }, el('span', {}, day)));
      lastDay = day;
    }
    if (item.m && item.m.id === state.unreadMark?.id) {
      const n = state.unreadMark.count;
      nodes.push(el('div', { class: 'unread-divider', role: 'separator' }, el('span', {}, `${n} unread email${n === 1 ? '' : 's'}`)));
    }
    nodes.push(item.m ? bubble(item.m, convo) : outBubble(convo.key, item.r));
  }
  msgs.replaceChildren(...nodes);
  const mark = msgs.querySelector('.unread-divider');
  if (scroll === 'unread' && mark) msgs.scrollTop = mark.offsetTop - 8;
  else if (scroll !== 'keep') msgs.scrollTop = msgs.scrollHeight;
  else msgs.scrollTop = top;

  renderSuggestions(convo);
}

// Redraws one bubble in place, so the scroll position and keyboard focus stay put.
function updateBubble(m) {
  const convo = selectedConvo();
  if (!convo || convoKey(m) !== convo.key) return;
  renderHead(convo);
  if (convo.latest.id === m.id) renderSuggestions(convo);
  const old = $('messages').querySelector(`[data-id="${CSS.escape(m.id)}"]`);
  if (!old) return;
  const fresh = bubble(m, convo);
  const act = old.contains(document.activeElement) ? document.activeElement.dataset.act : null;
  const fullTop = old.dataset.view === fresh.dataset.view ? old.querySelector('.full')?.scrollTop : 0;
  old.replaceWith(fresh);
  const full = fresh.querySelector('.full');
  if (full) full.scrollTop = fullTop || 0;
  if (act) fresh.querySelector(`[data-act="${act}"]`)?.focus();
}

// ---------- actions ----------

// One call for all of the conversation's unread emails; shown unread again if the server refuses.
function markSeen(convo) {
  const unread = convo.emails.filter((m) => !m.seen);
  if (!unread.length) return;
  for (const m of unread) m.seen = true;
  const ids = unread.map((m) => m.id);
  Promise.resolve().then(() => clearmail.markSeen(ids)).catch((err) => {
    for (const m of state.emails) if (ids.includes(m.id)) m.seen = false;
    notice(`Couldn't mark as read on the server: ${errText(err)}`);
    renderSidebar();
  });
}

// focus: 'reply' (the reply box), 'list' (the chat in the sidebar) or 'none'.
function select(key, { focus = 'reply' } = {}) {
  const convo = conversations().find((c) => c.key === key);
  if (!convo) return;
  const changed = key !== state.selected;
  state.selected = key;
  state.keepVisible = key;
  if (changed) {
    state.expanded.clear();
    state.allLinks.clear();
    const first = convo.emails.find((m) => !m.seen);
    state.unreadMark = first ? { id: first.id, count: convo.unread } : null;
  }
  markSeen(convo);
  renderSidebar();
  renderConversation(changed ? 'unread' : 'bottom');

  const input = $('reply-input');
  if (changed) input.value = state.drafts[key] || ''; // each conversation keeps its own draft
  autosize();
  if (focus === 'reply') input.focus();
  else if (focus === 'list') $('chat-list').querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

let loadGen = 0;
async function load() {
  const gen = ++loadGen;
  state.loading = true;
  renderSidebar();
  try {
    const res = await clearmail.loadInbox();
    if (gen !== loadGen) return;
    state.emails = arr(res?.emails).map(tidyEmail);
    state.accounts = arr(res?.accounts).map(tidyAccount).filter((a) => a.id);
    adoptOldDone(state.emails);
    state.demo = Boolean(res.demo);
    state.demoReason = res.demoReason || null;
    state.aiEnabled = Boolean(res.aiEnabled);
    state.aiError = res.aiError || null;
    state.loaded = true;
    state.loadError = null;
    if (state.selected && !conversations().some((c) => c.key === state.selected)) {
      state.selected = null;
      state.unreadMark = null;
    }
    renderConversation();
    // New mail in the conversation on screen counts as read, as in a chat app, but only
    // while the window is in front: mail that arrives while the user is away stays unread.
    const open = conversations().find((c) => c.key === state.selected);
    if (open && open.unread && document.hasFocus()) markSeen(open);
  } catch (err) {
    if (gen !== loadGen) return;
    state.loadError = errText(err);
    checkSignIns(gen);
  } finally {
    if (gen === loadGen) {
      state.loading = false;
      renderSidebar();
      if ($('settings').open && settingsView) renderAccounts(); // fresh account statuses
    }
  }
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
  if (gen !== loadGen || !state.loadError) return;
  state.accounts = arr(s?.accounts).map((a) => tidyAccount({ ...a, error: null })).filter((a) => a.id);
  renderLoadError();
  renderBanner();
}

async function deliver(key, entry) {
  entry.status = 'pending';
  entry.error = null;
  if (state.selected === key) renderConversation();
  try {
    const res = await clearmail.reply(entry.emailId, entry.body);
    entry.status = res?.demo ? 'demo' : 'sent';
    // A successful retry clears its own "wasn't sent" notice (and nothing else).
    if (entry.notice && $('notice').textContent === entry.notice) notice('');
  } catch (err) {
    entry.status = 'failed';
    entry.error = errText(err);
    const name = conversations().find((c) => c.key === key)?.name || key;
    entry.notice = `Your reply to ${name} wasn't sent: ${entry.error}`;
    notice(entry.notice);
  }
  if (state.selected === key) renderConversation();
}

function sendReply(e) {
  e?.preventDefault();
  const input = $('reply-input');
  const body = input.value.trim();
  const convo = selectedConvo();
  if (!body || !convo) return;
  input.value = '';
  delete state.drafts[convo.key];
  autosize();
  const entry = { body, date: new Date().toISOString(), emailId: convo.latest.id, accountEmail: convo.latest.accountEmail, status: 'pending' };
  (state.sent[convo.key] ||= []).push(entry);
  renderConversation('bottom');
  deliver(convo.key, entry);
}

function useSuggestion(text) {
  const input = $('reply-input');
  input.value = text;
  if (state.selected) state.drafts[state.selected] = text;
  input.focus();
  autosize();
}

function autosize() {
  const t = $('reply-input');
  if (!t.offsetParent) return; // hidden: measuring now would collapse it
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

// ---------- settings ----------
// Accounts are saved as soon as they are added, edited, removed or signed in to. The
// General part is saved with "Save & reload". Closing Settings reloads the inbox if
// anything about the accounts changed.

const PORTS = { imap: { tls: '993', starttls: '143' }, smtp: { tls: '465', starttls: '587' } };
let settingsOpening = false;
let saving = false;
let settingsView = null; // what Settings shows (getSettings: never any secret)
let accountsChanged = false; // reload the inbox when Settings closes
let signIn = null; // { accountId, cancelled } while the Microsoft sign-in is open in the browser
let setupFor = null; // { accountId } while asking for the Microsoft app ID before signing in
let confirmRemove = null; // id of the account whose Remove waits for "Remove" or "Keep"
let editing = null; // the IMAP account in the account form, or null when adding one
let accountBusy = false; // an account change is on its way to the main process
const fresh = new Map(); // account id -> 'Added.' | 'Saved.' | 'Signed in.' since Settings opened

const dialogOpen = () => $('settings').open;

function showBox(id, text) {
  const box = $(id);
  box.textContent = text;
  box.hidden = !text;
  if (text) box.scrollIntoView({ block: 'nearest' });
}

const showSettingsError = (text) => showBox('settings-error', text);
const showFormError = (text) => showBox('account-error', text);
const showSetupError = (text) => showBox('ms-setup-error', text);

function accountsMessage({ ok = '', error = '' } = {}) {
  showBox('accounts-status', ok);
  showBox('accounts-error', error);
}

// An account was added, changed or removed: the inbox must load again.
function accountsDidChange() {
  accountsChanged = true;
  if (!dialogOpen()) {
    accountsChanged = false;
    load();
  }
}

function tidySettings(s) {
  const v = s && typeof s === 'object' ? s : {};
  return {
    accounts: arr(v.accounts).filter((a) => typeof a?.id === 'string' && a.id).map((a) => ({
      ...a,
      kind: a.kind === 'microsoft' ? 'microsoft' : 'imap',
      email: str(a.email) || str(a.user) || '(no address)',
      name: str(a.name),
    })),
    limit: v.limit,
    demoChosen: Boolean(v.demoChosen),
    demoActive: Boolean(v.demoActive),
    demoReason: v.demoReason || null,
    hasApiKey: Boolean(v.hasApiKey),
    secretsLocked: Boolean(v.secretsLocked),
    providers: v.providers && typeof v.providers === 'object' ? v.providers : {},
    msClientId: str(v.msClientId),
    msClientIdBuiltIn: Boolean(v.msClientIdBuiltIn),
  };
}

const hasClientId = () => Boolean(settingsView?.msClientId || settingsView?.msClientIdBuiltIn);

function kindLabel(a) {
  if (a.kind === 'microsoft') return 'Outlook';
  const providers = settingsView?.providers || {};
  return (Object.hasOwn(providers, a.provider) && str(providers[a.provider])) || 'Other';
}

// What an account's row says: { tone: 'ok'|'warn'|'muted', text, signIn (offer the button) }.
function accountStatus(a) {
  const note = fresh.get(a.id);
  const loaded = note ? null : state.accounts.find((x) => x.id === a.id); // a fresh change makes the last load's news stale
  if (a.kind === 'microsoft') {
    if (a.locked && !a.signedIn) {
      return { tone: 'warn', text: "ClearMail couldn't unlock this sign-in from the macOS Keychain. Sign in again to fix it.", signIn: true };
    }
    if (a.needsSignIn) {
      return { tone: 'warn', text: loaded?.error || (a.signedIn ? 'Microsoft needs you to sign in again.' : "Signing in wasn't finished."), signIn: true };
    }
  } else if (!a.hasPass) {
    return a.locked
      ? { tone: 'warn', text: "ClearMail couldn't unlock the saved app password from the macOS Keychain. Click Edit and type it again." }
      : { tone: 'warn', text: 'No app password saved yet. Click Edit to add it.' };
  }
  if (loaded?.error) return { tone: 'warn', text: loaded.error };
  if (settingsView?.demoActive) return { tone: 'muted', text: 'Not loaded while Demo mode is on.' };
  if (note) return { tone: 'ok', text: `${note} Its email loads when you close Settings.` };
  if (loaded) return { tone: 'ok', text: '✓ Working' };
  return { tone: 'muted', text: 'Not loaded yet.' };
}

function focusAccount(id, act, fallback = true) {
  const row = id ? $('account-list').querySelector(`[data-id="${CSS.escape(id)}"]`) : null;
  const exact = act ? row?.querySelector(`[data-act="${act}"]:not(:disabled)`) : null;
  const target = exact || (fallback ? row?.querySelector('button:not(:disabled)') || $('add-microsoft') : null);
  if (target && !target.closest('[hidden]')) target.focus();
}

function accountRow(a) {
  const status = accountStatus(a);
  const busy = Boolean(signIn) || accountBusy;
  const confirming = confirmRemove === a.id;
  const keep = () => {
    confirmRemove = null;
    renderAccounts();
    focusAccount(a.id, 'remove');
  };
  return el('li', { class: 'account', 'data-id': a.id },
    avatar(a.email, a.email),
    el('div', { class: 'account-main' },
      el('div', { class: 'account-top' },
        el('span', { class: 'account-email', title: a.name ? `${a.name} <${a.email}>` : a.email }, a.email),
        el('span', { class: `kind kind-${a.kind}` }, kindLabel(a))),
      el('p', { class: `account-status is-${status.tone}` }, status.text),
      status.signIn ? el('button', {
        type: 'button', class: 'small-btn primary', 'data-act': 'signin', disabled: busy,
        'aria-label': `Sign in again to ${a.email}`, onclick: () => startSignIn(a.id),
      }, 'Sign in again') : null,
      confirming ? el('div', { class: 'account-confirm', role: 'group', 'aria-label': `Remove ${a.email}?` },
        el('p', {}, `Remove ${a.email} from ClearMail? Its emails leave your chats. Nothing is deleted from the mailbox itself.`),
        el('div', { class: 'confirm-actions' },
          el('button', { type: 'button', class: 'small-btn danger', 'data-act': 'remove-yes', disabled: busy, onclick: () => removeAccount(a.id) }, 'Remove'),
          el('button', { type: 'button', class: 'small-btn', 'data-act': 'remove-no', onclick: keep }, 'Keep'))) : null),
    el('div', { class: 'account-actions' },
      a.kind === 'imap' ? el('button', {
        type: 'button', class: 'linkish', 'data-act': 'edit', disabled: busy, 'aria-label': `Edit ${a.email}`, onclick: () => openAccountForm(a),
      }, 'Edit') : null,
      el('button', {
        type: 'button', class: 'linkish danger-text', 'data-act': 'remove', disabled: busy || confirming,
        'aria-label': `Remove ${a.email}`, onclick: () => askRemove(a.id),
      }, 'Remove')));
}

function renderAccounts() {
  if (!settingsView) return;
  const list = $('account-list');
  // Rebuilding the list mustn't lose the keyboard focus.
  const active = document.activeElement;
  const focusId = active?.closest?.('#account-list .account')?.dataset.id;
  const focusAct = active?.dataset?.act;
  list.replaceChildren(...settingsView.accounts.map(accountRow));
  if (!settingsView.accounts.length) {
    list.append(el('li', { class: 'account-empty' }, 'No accounts yet. Add one below to see your own email instead of the sample emails.'));
  }
  if (focusId) focusAccount(focusId, focusAct, false);

  $('secrets-locked').hidden = !settingsView.secretsLocked;
  $('ms-wait').hidden = !signIn;
  $('ms-cancel').disabled = Boolean(signIn?.cancelled);
  $('ms-wait').querySelector('.ms-wait-text').textContent = signIn?.cancelled ? 'Cancelling…' : 'Finish signing in in your browser…';
  $('ms-setup').hidden = !setupFor;
  $('add-buttons').hidden = Boolean(signIn || setupFor);
  for (const id of ['add-microsoft', 'add-imap']) $(id).disabled = accountBusy;
}

function applySettings(s) {
  const before = settingsView?.msClientId || '';
  settingsView = tidySettings(s);
  // The app ID field in Advanced follows a newly saved ID, unless the user is editing it.
  const field = $('settings-form').elements.msClientId;
  if (field.value.trim() === before) field.value = settingsView.msClientId;
  $('ms-id-hint').textContent = settingsView.msClientIdBuiltIn
    ? 'This copy of ClearMail has a Microsoft app ID built in. Only fill this in to use a different one.'
    : 'Needed for Outlook and Microsoft 365 accounts. See "Using Outlook" in the README for the 5-minute setup.';
  renderAccounts();
}

// options.signIn: an account id to sign in again straight away.
async function openSettings(options = {}) {
  if (dialogOpen()) {
    if (options.signIn) startSignIn(options.signIn);
    return;
  }
  if (settingsOpening) return;
  settingsOpening = true;
  let s;
  try {
    s = await clearmail.getSettings();
  } catch (err) {
    notice(`Couldn't open Settings: ${errText(err)}`);
    return;
  } finally {
    settingsOpening = false;
  }
  accountsChanged = false;
  fresh.clear();
  setupFor = null;
  confirmRemove = null;
  editing = null;
  settingsView = null;
  const f = $('settings-form').elements;
  f.limit.value = s?.limit ?? '';
  f.apiKey.value = '';
  f.apiKey.placeholder = s?.hasApiKey ? '•••••••• saved (leave blank to keep)' : 'sk-ant-… (optional)';
  f.demo.checked = Boolean(s?.demoChosen);
  f.msClientId.value = '';
  $('demo-flag').hidden = s?.demoReason !== 'flag';
  $('advanced').open = false;
  $('settings-cancel').textContent = 'Close';
  $('account-form').hidden = true;
  $('settings-main').hidden = false;
  applySettings(s);
  accountsMessage();
  showSettingsError('');
  $('settings').returnValue = '';
  $('settings').showModal();
  $('settings').scrollTop = 0;
  if (options.signIn) startSignIn(options.signIn);
}

// ---------- settings: Microsoft sign-in ----------

// accountId: sign that account in again; null adds a new account.
async function startSignIn(accountId = null) {
  if (!settingsView || signIn || accountBusy) return;
  if (accountId && !settingsView.accounts.some((a) => a.id === accountId && a.kind === 'microsoft')) return;
  accountsMessage();
  confirmRemove = null;
  if (!hasClientId()) {
    showSetup(accountId);
    return;
  }
  const run = { accountId, cancelled: false };
  signIn = run;
  setupFor = null;
  renderAccounts();
  $('ms-cancel').focus();
  const before = new Set(settingsView.accounts.map((a) => a.id));
  const waiting = new Set(settingsView.accounts.filter((a) => a.needsSignIn).map((a) => a.id));
  let s;
  try {
    s = await clearmail.signInMicrosoft(accountId ? { accountId } : {});
  } catch (err) {
    if (signIn === run) signIn = null;
    const text = errText(err);
    if (!dialogOpen()) {
      if (!run.cancelled) notice(`Couldn't sign in to Microsoft: ${text}`);
      return;
    }
    renderAccounts();
    if (!run.cancelled) accountsMessage({ error: text }); // cancelling needs no message
    focusAccount(accountId, 'signin');
    return;
  }
  if (signIn === run) signIn = null;
  const view = tidySettings(s);
  // The account signed in to: the one asked for, a new one, or one that needed it.
  const account = view.accounts.find((a) => a.id === accountId)
    || view.accounts.find((a) => a.kind === 'microsoft' && !before.has(a.id))
    || view.accounts.find((a) => waiting.has(a.id) && !a.needsSignIn);
  if (account) fresh.set(account.id, 'Signed in.');
  const text = account ? `Signed in to ${account.email}.` : 'Signed in.';
  if (!dialogOpen()) notice(text);
  accountsDidChange();
  if (!dialogOpen()) return;
  applySettings(s);
  accountsMessage({ ok: `${text} Its email loads when you close Settings.` });
  focusAccount(account?.id);
}

function cancelSignIn() {
  if (!signIn || signIn.cancelled) return;
  signIn.cancelled = true;
  renderAccounts();
  Promise.resolve().then(() => clearmail.cancelSignIn()).catch((err) => {
    if (dialogOpen()) accountsMessage({ error: `Couldn't cancel signing in: ${errText(err)}` });
  });
}

// No Microsoft app ID yet: ask for one, then sign in.
function showSetup(accountId) {
  setupFor = { accountId };
  $('ms-client-id').value = '';
  showSetupError('');
  renderAccounts();
  $('ms-client-id').focus();
}

function hideSetup() {
  setupFor = null;
  renderAccounts();
  $('add-microsoft').focus();
}

$('ms-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!setupFor || accountBusy) return;
  const id = $('ms-client-id').value.trim();
  if (!id) {
    showSetupError('Paste the Application (client) ID first.');
    $('ms-client-id').focus();
    return;
  }
  accountBusy = true;
  $('ms-setup-save').disabled = true;
  showSetupError('');
  let s;
  try {
    s = await clearmail.saveSettings({ msClientId: id });
  } catch (err) {
    showSetupError(errText(err));
    return;
  } finally {
    accountBusy = false;
    $('ms-setup-save').disabled = false;
  }
  const target = setupFor;
  setupFor = null;
  accountsDidChange(); // Outlook accounts may load now
  if (!dialogOpen()) return;
  applySettings(s);
  if (target) startSignIn(target.accountId);
});

$('ms-setup-cancel').addEventListener('click', hideSetup);
$('ms-cancel').addEventListener('click', cancelSignIn);
$('add-microsoft').addEventListener('click', () => startSignIn(null));

// ---------- settings: removing an account ----------

function askRemove(id) {
  confirmRemove = id;
  accountsMessage();
  renderAccounts();
  focusAccount(id, 'remove-no');
}

// A removed account's emails leave the chats straight away.
function dropAccount(id) {
  state.emails = state.emails.filter((m) => m.accountId !== id);
  state.accounts = state.accounts.filter((a) => a.id !== id);
  let changed = false;
  for (const key of [...state.done.keys()]) {
    if (key.startsWith(`${id}:`)) {
      state.done.delete(key);
      changed = true;
    }
  }
  if (changed) saveDone();
  if (state.selected && !conversations().some((c) => c.key === state.selected)) {
    state.selected = null;
    state.unreadMark = null;
  }
  renderSidebar();
  renderConversation();
}

async function removeAccount(id) {
  if (accountBusy || signIn) return;
  const account = settingsView.accounts.find((a) => a.id === id);
  accountBusy = true;
  renderAccounts();
  let s;
  try {
    s = await clearmail.removeAccount(id);
  } catch (err) {
    accountBusy = false;
    renderAccounts();
    accountsMessage({ error: errText(err) });
    focusAccount(id, 'remove-yes');
    return;
  }
  accountBusy = false;
  confirmRemove = null;
  fresh.delete(id);
  dropAccount(id);
  accountsDidChange();
  if (!dialogOpen()) return;
  applySettings(s);
  accountsMessage({ ok: `Removed ${account?.email || 'the account'}.` });
  $('add-microsoft').focus();
}

// ---------- settings: Gmail, iCloud, Yahoo and other IMAP accounts ----------

function fillProviders(selected) {
  const providers = settingsView?.providers || {};
  const sel = $('provider');
  sel.replaceChildren(
    ...Object.entries(providers).map(([k, label]) => el('option', { value: k }, str(label) || k)),
    el('option', { value: 'custom' }, 'Other (custom server)'),
  );
  sel.value = Object.hasOwn(providers, selected) || selected === 'custom' ? selected : Object.keys(providers)[0] || 'custom';
}

// account: the IMAP account to edit, or null to add one.
function openAccountForm(account = null) {
  if (signIn || accountBusy) return;
  editing = account;
  confirmRemove = null;
  accountsMessage();
  const f = $('account-form').elements;
  fillProviders(account?.provider);
  for (const name of ['user', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort']) f[name].value = account?.[name] ?? '';
  for (const kind of ['imap', 'smtp']) {
    const mode = account?.[`${kind}Security`] === 'starttls' ? 'starttls' : 'tls';
    f[`${kind}Security`].value = mode;
    f[`${kind}Port`].placeholder = PORTS[kind][mode];
  }
  f.pass.value = '';
  f.pass.placeholder = account?.hasPass ? '•••••••• saved (leave blank to keep)' : 'app password';
  $('custom-server').hidden = $('provider').value !== 'custom';
  $('account-title').textContent = account ? `Edit ${account.email}` : 'Add an email account';
  $('account-save').textContent = account ? 'Save changes' : 'Add account';
  showFormError('');
  $('settings-main').hidden = true;
  $('account-form').hidden = false;
  $('settings').scrollTop = 0;
  $('provider').focus();
}

// focusId: the account to put the keyboard focus on afterwards.
function closeAccountForm(focusId = editing?.id) {
  editing = null;
  $('account-form').hidden = true;
  $('settings-main').hidden = false;
  renderAccounts();
  if (focusId) focusAccount(focusId, 'edit');
  else $('add-imap').focus();
}

// Picking a security mode suggests its usual port, unless the user typed their own.
for (const kind of ['imap', 'smtp']) {
  const f = $('account-form').elements;
  f[`${kind}Security`].addEventListener('change', (e) => {
    const port = f[`${kind}Port`];
    const mode = e.target.value;
    const other = PORTS[kind][mode === 'tls' ? 'starttls' : 'tls'];
    if (!port.value || port.value === other) port.value = PORTS[kind][mode];
    port.placeholder = PORTS[kind][mode];
  });
}

$('provider').addEventListener('change', (e) => { $('custom-server').hidden = e.target.value !== 'custom'; });
$('add-imap').addEventListener('click', () => openAccountForm(null));
$('account-cancel').addEventListener('click', () => closeAccountForm());

// Save is the form's only submit button, so Enter in any field saves.
$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (accountBusy) return;
  const f = e.target.elements;
  const target = editing;
  const input = { provider: f.provider.value, user: f.user.value.trim(), pass: f.pass.value };
  if (target) input.id = target.id;
  if (input.provider === 'custom') {
    for (const kind of ['imap', 'smtp']) {
      input[`${kind}Host`] = f[`${kind}Host`].value.trim();
      input[`${kind}Port`] = f[`${kind}Port`].value;
      input[`${kind}Security`] = f[`${kind}Security`].value;
    }
  }
  const before = new Set(settingsView.accounts.map((a) => a.id));
  accountBusy = true;
  $('account-save').disabled = true;
  showFormError('');
  let s;
  try {
    s = await clearmail.saveAccount(input);
  } catch (err) {
    showFormError(errText(err));
    return;
  } finally {
    accountBusy = false;
    $('account-save').disabled = false;
  }
  const view = tidySettings(s);
  const saved = target ? view.accounts.find((a) => a.id === target.id) : view.accounts.find((a) => !before.has(a.id));
  if (saved) fresh.set(saved.id, target ? 'Saved.' : 'Added.');
  accountsDidChange();
  if (!dialogOpen()) return;
  applySettings(s);
  // Still on the form the user saved (Esc may have left it meanwhile).
  if (!$('account-form').hidden && editing === target) closeAccountForm(saved?.id);
  accountsMessage({ ok: `${target ? 'Saved' : 'Added'} ${saved?.email || input.user}. Its email loads when you close Settings.` });
});

// ---------- settings: general ----------

$('settings-form').addEventListener('input', () => { $('settings-cancel').textContent = 'Cancel'; });
$('settings-cancel').addEventListener('click', () => $('settings').close('cancel'));

// Save is the form's only submit button, so Enter in any field saves.
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (saving) return;
  const f = e.target.elements;
  const input = {
    apiKey: f.apiKey.value.trim(),
    limit: f.limit.value,
    demo: f.demo.checked,
  };
  const msClientId = f.msClientId.value.trim();
  if (msClientId !== (settingsView?.msClientId || '')) input.msClientId = msClientId;
  saving = true;
  $('settings-save').disabled = true;
  showSettingsError('');
  try {
    await clearmail.saveSettings(input);
  } catch (err) {
    if (dialogOpen()) showSettingsError(errText(err));
    else notice(`Settings not saved: ${errText(err)}`);
    return;
  } finally {
    saving = false;
    $('settings-save').disabled = false;
  }
  $('settings').close('save');
});

// Esc steps back one level: stops a sign-in, leaves the account form or setup, or
// keeps an account the user was about to remove, before it closes Settings.
$('settings').addEventListener('cancel', (e) => {
  if (signIn) {
    e.preventDefault();
    cancelSignIn();
  } else if (!$('account-form').hidden) {
    e.preventDefault();
    closeAccountForm();
  } else if (setupFor) {
    e.preventDefault();
    hideSetup();
  } else if (confirmRemove) {
    e.preventDefault();
    const id = confirmRemove;
    confirmRemove = null;
    renderAccounts();
    focusAccount(id, 'remove');
  }
});

$('settings').addEventListener('close', () => {
  if (signIn) cancelSignIn(); // closes the browser sign-in's waiting page in ClearMail
  setupFor = null;
  confirmRemove = null;
  editing = null;
  $('account-form').hidden = true;
  $('settings-main').hidden = false;
  const reload = $('settings').returnValue === 'save' || accountsChanged;
  accountsChanged = false;
  if (reload) load();
});

// ---------- wiring ----------

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  state.keepVisible = null;
  for (const b of $('filters').children) {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  }
  renderSidebar();
});
$('needs-you').addEventListener('click', () => $('filters').querySelector('[data-filter="action"]').click());
$('search').addEventListener('input', (e) => { state.search = e.target.value; renderSidebar(); });
$('refresh').addEventListener('click', () => load());
$('open-settings').addEventListener('click', () => openSettings());
$('notice').addEventListener('click', () => notice(''));
$('convo-done').addEventListener('click', () => {
  const convo = selectedConvo();
  if (convo) markDone(convo.emails.filter(isFlagged).map((m) => m.id), true);
  $('reply-input').focus();
});
$('reply-form').addEventListener('submit', sendReply);
$('reply-input').addEventListener('input', (e) => {
  if (state.selected) state.drafts[state.selected] = e.target.value;
  autosize();
});
$('reply-input').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // Enter that confirms an IME (e.g. Japanese) candidate
  if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) sendReply(e);
});

document.addEventListener('keydown', (e) => {
  if ($('settings').open || e.isComposing) return; // the dialog handles its own keys
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.key === 'r') { e.preventDefault(); load(); }
  if (cmd && e.key === ',') { e.preventDefault(); openSettings(); }
  if (cmd && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  if (cmd || e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const active = document.activeElement;
  if (active?.matches('input, textarea, select') || active?.closest('#conversation')) return; // typing, or scrolling messages
  const list = visibleConversations();
  if (!list.length) return;
  const i = list.findIndex((c) => c.key === state.selected);
  const next = list[i === -1 ? 0 : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  e.preventDefault();
  const inList = Boolean(active?.closest('#chat-list'));
  select(next.key, { focus: inList ? 'list' : 'none' });
  if (!inList) active?.blur?.();
});

clearmail.onSummary((data) => {
  const m = state.emails.find((x) => x.id === data?.id);
  if (!m) return;
  m.summary = tidySummary(data.summary, m);
  searchCache.delete(m);
  renderSidebarSoon();
  updateBubble(m); // only that bubble, so the view doesn't jump while reading
});

clearmail.onAiStatus?.((data) => {
  state.aiEnabled = Boolean(data?.aiEnabled);
  state.aiError = data?.aiError || null;
  renderBanner();
});

load();
