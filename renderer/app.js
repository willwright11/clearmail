/* global clearmail */
'use strict';

const $ = (id) => document.getElementById(id);

const DAY = 86400000;
const FLAG_DAYS = 30; // older mail isn't flagged, so a first load doesn't bury "Needs me"
const LINK_CHIPS = 4; // links shown before "+N more"
const DONE_KEY = 'clearmail.done';

const state = {
  emails: [],
  sent: {}, // conversation key -> [{ body, date, emailId, status: 'pending'|'sent'|'demo'|'failed', error }]
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
      m.from.name, m.from.address, m.subject, s.gist, ...s.key_points, ...s.questions,
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

function renderLoadError() {
  const box = $('load-error');
  const text = !state.loadError ? ''
    : state.loaded ? `Couldn't refresh your inbox. ${state.loadError} The list below is from the last time it loaded.`
      : `Couldn't load your inbox. ${state.loadError}`;
  if (box.dataset.text === text) return; // unchanged: don't make screen readers announce it again
  box.dataset.text = text;
  box.hidden = !text;
  box.replaceChildren(...(text ? [
    el('p', {}, text),
    el('div', { class: 'load-error-actions' },
      el('button', { type: 'button', onclick: () => load() }, 'Try again'),
      el('button', { type: 'button', onclick: () => openSettings() }, 'Open Settings')),
  ] : []));
}

const DEMO_TEXT = {
  flag: 'Demo mode: sample emails (ClearMail was started with --demo).',
  chosen: 'Demo mode: sample emails. Untick Demo mode in Settings to see your inbox.',
  'no-account': 'Demo mode: sample emails. Connect your inbox in Settings.',
};

function renderBanner() {
  const banner = $('mode-banner');
  const ai = state.aiError ? el('div', { class: 'ai-off' }, `⚠︎ AI summaries off: ${state.aiError}`)
    : el('div', {}, state.aiEnabled ? 'AI summaries on' : 'Offline mode: add a Claude key in Settings for AI summaries');
  banner.replaceChildren(...(state.demo ? [el('div', {}, DEMO_TEXT[state.demoReason] || DEMO_TEXT['no-account'])] : []), ai);
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
  } finally {
    if (gen === loadGen) {
      state.loading = false;
      renderSidebar();
    }
  }
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
  const entry = { body, date: new Date().toISOString(), emailId: convo.latest.id, status: 'pending' };
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

const PORTS = { imap: { tls: '993', starttls: '143' }, smtp: { tls: '465', starttls: '587' } };
let settingsOpening = false;
let saving = false;

function showSettingsError(text) {
  const box = $('settings-error');
  box.textContent = text;
  box.hidden = !text;
  if (text) box.scrollIntoView({ block: 'nearest' });
}

async function openSettings() {
  if (settingsOpening || $('settings').open) return;
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
  const f = $('settings-form').elements;
  const providers = s.providers || {};
  const sel = $('provider');
  sel.replaceChildren(
    ...Object.entries(providers).map(([k, label]) => el('option', { value: k }, label)),
    el('option', { value: 'custom' }, 'Other (custom server)'),
  );
  sel.value = Object.hasOwn(providers, s.provider) || s.provider === 'custom' ? s.provider : Object.keys(providers)[0] || 'custom';
  for (const name of ['user', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'limit']) f[name].value = s[name] ?? '';
  for (const kind of ['imap', 'smtp']) {
    const mode = s[`${kind}Security`] === 'starttls' ? 'starttls' : 'tls';
    f[`${kind}Security`].value = mode;
    f[`${kind}Port`].placeholder = PORTS[kind][mode];
  }
  f.pass.value = '';
  f.apiKey.value = '';
  f.pass.placeholder = s.hasPass ? '•••••••• saved (leave blank to keep)' : 'app password';
  f.apiKey.placeholder = s.hasApiKey ? '•••••••• saved (leave blank to keep)' : 'sk-ant-… (optional)';
  f.demo.checked = Boolean(s.demoChosen);
  $('demo-flag').hidden = s.demoReason !== 'flag';
  $('secrets-locked').hidden = !s.secretsLocked;
  $('custom-server').hidden = sel.value !== 'custom';
  showSettingsError('');
  $('settings').showModal();
  $('settings-form').scrollTop = 0;
}

// Picking a security mode suggests its usual port, unless the user typed their own.
for (const kind of ['imap', 'smtp']) {
  const f = $('settings-form').elements;
  f[`${kind}Security`].addEventListener('change', (e) => {
    const port = f[`${kind}Port`];
    const mode = e.target.value;
    const other = PORTS[kind][mode === 'tls' ? 'starttls' : 'tls'];
    if (!port.value || port.value === other) port.value = PORTS[kind][mode];
    port.placeholder = PORTS[kind][mode];
  });
}

$('provider').addEventListener('change', (e) => { $('custom-server').hidden = e.target.value !== 'custom'; });
$('settings-cancel').addEventListener('click', () => $('settings').close('cancel'));

// Save is the form's only submit button, so Enter in any field saves.
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (saving) return;
  const f = e.target.elements;
  const input = {
    provider: f.provider.value,
    user: f.user.value.trim(),
    pass: f.pass.value,
    apiKey: f.apiKey.value.trim(),
    limit: f.limit.value,
    demo: f.demo.checked,
  };
  if (input.provider === 'custom') {
    for (const kind of ['imap', 'smtp']) {
      input[`${kind}Host`] = f[`${kind}Host`].value.trim();
      input[`${kind}Port`] = f[`${kind}Port`].value;
      input[`${kind}Security`] = f[`${kind}Security`].value;
    }
  }
  saving = true;
  $('settings-save').disabled = true;
  showSettingsError('');
  try {
    await clearmail.saveSettings(input);
  } catch (err) {
    if ($('settings').open) showSettingsError(errText(err));
    else notice(`Settings not saved: ${errText(err)}`);
    return;
  } finally {
    saving = false;
    $('settings-save').disabled = false;
  }
  $('settings').close('save');
  load();
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
