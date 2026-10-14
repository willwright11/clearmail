/* global clearmail */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  emails: [],
  sent: {}, // conversation key -> [{ body, date }]
  filter: 'all',
  search: '',
  selected: null,
  demo: false,
  aiEnabled: false,
  expanded: new Set(),
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

const initials = (name) =>
  name.replace(/["'<>]/g, '').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function hue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatar(name, key) {
  const a = el('div', { class: 'avatar' }, initials(name));
  a.style.setProperty('--h', hue(key));
  return a;
}

function timeLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const days = Math.floor((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

const UPDATE_CATEGORIES = new Set(['receipt', 'newsletter', 'promo', 'notification']);
const CATEGORY_LABEL = { receipt: '🧾 Receipt', newsletter: '📰 Newsletter', promo: '🏷️ Promo', notification: '🔔 Automated' };

const needsAction = (m) => !m.seen && (m.summary.urgency === 'high' || m.summary.action_items.length > 0 || m.summary.questions.length > 0);

// ---------- conversations ----------

function conversations() {
  const map = new Map();
  for (const m of state.emails) {
    const key = m.from.address || m.from.name;
    if (!map.has(key)) map.set(key, { key, name: m.from.name, emails: [] });
    map.get(key).emails.push(m);
  }
  const list = [...map.values()].map((c) => {
    c.emails.sort((a, b) => new Date(a.date) - new Date(b.date));
    c.latest = c.emails[c.emails.length - 1];
    c.unread = c.emails.filter((m) => !m.seen).length;
    c.action = c.emails.some(needsAction);
    c.todo = c.emails.some((m) => !m.seen && m.summary.action_items.length > 0);
    c.urgent = c.emails.some((m) => !m.seen && m.summary.urgency === 'high');
    c.isUpdate = c.emails.every((m) => UPDATE_CATEGORIES.has(m.summary.category));
    return c;
  });
  return list.sort((a, b) => new Date(b.latest.date) - new Date(a.latest.date));
}

function visibleConversations() {
  const q = state.search.trim().toLowerCase();
  return conversations().filter((c) => {
    if (state.filter === 'action' && !c.action) return false;
    if (state.filter === 'person' && c.isUpdate) return false;
    if (state.filter === 'updates' && !c.isUpdate) return false;
    if (!q) return true;
    return [c.name, c.key, ...c.emails.flatMap((m) => [m.subject, m.summary.gist])]
      .some((s) => (s || '').toLowerCase().includes(q));
  });
}

// ---------- rendering: sidebar ----------

function renderSidebar() {
  const list = $('chat-list');
  list.replaceChildren();
  const convos = visibleConversations();

  for (const c of convos) {
    const preview = c.latest.summary.gist;
    const li = el(
      'li',
      { class: `chat${state.selected === c.key ? ' selected' : ''}${c.unread ? ' unread' : ''}`, tabindex: 0, onclick: () => select(c.key) },
      avatar(c.name, c.key),
      el('div', { class: 'chat-body' },
        el('div', { class: 'chat-top' },
          el('span', { class: 'chat-name' }, c.name),
          el('span', { class: 'chat-time' }, timeLabel(c.latest.date))),
        el('div', { class: 'chat-bottom' },
          el('span', { class: 'chat-preview' },
            c.urgent ? el('span', { class: 'flag urgent' }, 'Urgent')
              : c.todo ? el('span', { class: 'flag action' }, 'To do')
                : c.action ? el('span', { class: 'flag ask' }, 'Asked you') : null,
            preview),
          c.unread ? el('span', { class: 'badge' }, c.unread) : null)),
    );
    list.append(li);
  }
  if (!convos.length) list.append(el('li', { class: 'none' }, state.emails.length ? 'Nothing here 🎉' : 'Loading…'));

  const actionCount = conversations().filter((c) => c.action).length;
  const nv = $('needs-you');
  nv.hidden = actionCount === 0;
  nv.textContent = `${actionCount} ${actionCount === 1 ? 'conversation needs' : 'conversations need'} something from you`;

  const banner = $('mode-banner');
  banner.textContent = state.demo
    ? 'Demo mode: sample emails. Connect your inbox in Settings.'
    : state.aiEnabled ? 'AI summaries on' : 'Offline mode: add a Claude key in Settings for AI summaries';
}

// ---------- rendering: conversation ----------

function section(icon, title, items, cls) {
  if (!items.length) return null;
  return el('div', { class: `box ${cls}` },
    el('div', { class: 'box-title' }, `${icon} ${title}`),
    el('ul', {}, items));
}

function bubble(m) {
  const s = m.summary;
  const c = m.cleaned;
  const expanded = state.expanded.has(m.id);

  const actions = s.action_items.map((a) =>
    el('li', {}, a.task, a.due ? el('span', { class: 'due' }, a.due) : null));
  const dates = s.dates.map((d) => el('li', {}, d.what ? `${d.what}: ` : '', el('b', {}, d.when)));
  const questions = s.questions.map((q) => el('li', {}, q));

  const chips = [
    ...c.amounts.map((a) => el('span', { class: 'chip-static money' }, `💷 ${a}`)),
    ...(m.attachments || []).map((a) => el('span', { class: 'chip-static' }, `📎 ${a.filename}`)),
    ...c.links.slice(0, 4).map((l) => el('button', { class: 'chip-link', title: l.url, onclick: () => clearmail.openLink(l.url) }, `🔗 ${l.label}`)),
  ];

  return el('article', { class: `bubble in${s.urgency === 'high' ? ' urgent' : ''}`, 'data-id': m.id },
    el('div', { class: 'bubble-meta' },
      CATEGORY_LABEL[s.category] ? el('span', { class: 'cat' }, CATEGORY_LABEL[s.category]) : null,
      el('span', { class: 'subject' }, m.subject)),
    s.urgency === 'high' ? el('div', { class: 'urgent-tag' }, '⚠︎ Time-sensitive') : null,
    el('p', { class: 'gist' }, s.gist),
    s.key_points.length ? el('ul', { class: 'points' }, s.key_points.map((p) => el('li', {}, p))) : null,
    section('📌', 'You need to', actions, 'todo'),
    section('❓', 'They asked', questions, 'ask'),
    section('📅', 'Dates', dates, 'dates'),
    chips.length ? el('div', { class: 'chips' }, chips) : null,
    expanded ? el('div', { class: 'full' }, c.body || m.original) : null,
    el('div', { class: 'bubble-foot' },
      el('button', { class: 'linkish', onclick: () => toggle(m.id) }, expanded ? 'Hide full email' : 'Read full email'),
      c.stats.saved > 0 ? el('span', { class: 'saved', title: `${c.stats.rawWords} words → ${c.stats.keptWords}` }, `✂︎ ${c.stats.saved} words cut`) : null,
      s.error ? el('span', { class: 'err', title: s.error }, '⚠︎ offline') : null,
      el('time', {}, new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
  );
}

function renderConversation() {
  const convo = conversations().find((c) => c.key === state.selected);
  const show = Boolean(convo);
  $('empty').hidden = show;
  $('convo-head').hidden = !show;
  $('messages').hidden = !show;
  $('composer').hidden = !show;
  if (!convo) return;

  const av = $('convo-avatar');
  av.textContent = initials(convo.name);
  av.style.setProperty('--h', hue(convo.key));
  $('convo-name').textContent = convo.name;
  $('convo-sub').textContent = convo.key;

  const timeline = [
    ...convo.emails.map((m) => ({ type: 'in', date: m.date, m })),
    ...(state.sent[convo.key] || []).map((r) => ({ type: 'out', date: r.date, r })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  const msgs = $('messages');
  msgs.replaceChildren();
  let lastDay = '';
  for (const item of timeline) {
    const day = dayLabel(item.date);
    if (day !== lastDay) {
      msgs.append(el('div', { class: 'day' }, el('span', {}, day)));
      lastDay = day;
    }
    msgs.append(item.type === 'in'
      ? bubble(item.m)
      : el('article', { class: `bubble out${item.r.failed ? ' failed' : ''}` },
        el('p', {}, item.r.body),
        el('div', { class: 'bubble-foot' },
          item.r.failed ? el('span', { class: 'err' }, `Not sent: ${item.r.failed}`) : null,
          el('time', {}, new Date(item.r.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
          item.r.failed ? null : el('span', { class: 'ticks' }, item.r.demo ? '✓' : '✓✓'))));
  }
  msgs.scrollTop = msgs.scrollHeight;

  const sugg = $('suggestions');
  sugg.replaceChildren(...convo.latest.summary.reply_suggestions.map((t) =>
    el('button', { class: 'chip', onclick: () => { $('reply-input').value = t; $('reply-input').focus(); autosize(); } }, t)));
}

function render() {
  renderSidebar();
  renderConversation();
}

// ---------- actions ----------

function select(key) {
  state.selected = key;
  state.expanded.clear();
  const convo = conversations().find((c) => c.key === key);
  for (const m of convo?.emails || []) {
    if (!m.seen) {
      m.seen = true;
      clearmail.markSeen(m.id);
    }
  }
  render();
  $('reply-input').focus();
}

function toggle(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderConversation();
  const node = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  node?.scrollIntoView({ block: 'nearest' });
}

async function load() {
  $('chat-list').replaceChildren(el('li', { class: 'none' }, 'Loading your inbox…'));
  try {
    const res = await clearmail.loadInbox();
    state.emails = res.emails;
    state.demo = res.demo;
    state.aiEnabled = res.aiEnabled;
    if (state.selected && !state.emails.some((m) => (m.from.address || m.from.name) === state.selected)) state.selected = null;
    render();
  } catch (err) {
    $('chat-list').replaceChildren(el('li', { class: 'none error' }, `Couldn't load your inbox: ${err.message.replace(/^Error invoking remote method '[^']+': /, '')}`));
  }
}

async function sendReply(e) {
  e?.preventDefault();
  const input = $('reply-input');
  const body = input.value.trim();
  const convo = conversations().find((c) => c.key === state.selected);
  if (!body || !convo) return;
  input.value = '';
  autosize();
  const entry = { body, date: new Date().toISOString() };
  (state.sent[convo.key] ||= []).push(entry);
  renderConversation();
  try {
    const res = await clearmail.reply(convo.latest.id, body);
    entry.demo = res.demo;
  } catch (err) {
    entry.failed = err.message.replace(/^Error invoking remote method '[^']+': /, '');
  }
  renderConversation();
}

function autosize() {
  const t = $('reply-input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

// ---------- settings ----------

async function openSettings() {
  const s = await clearmail.getSettings();
  const form = $('settings-form');
  const sel = $('provider');
  sel.replaceChildren(
    ...Object.entries(s.providers).map(([k, label]) => el('option', { value: k }, label)),
    el('option', { value: 'custom' }, 'Other (custom server)'),
  );
  sel.value = s.provider || 'gmail';
  for (const name of ['user', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort']) form.elements[name].value = s[name] || '';
  form.elements.pass.value = '';
  form.elements.apiKey.value = '';
  form.elements.pass.placeholder = s.hasPass ? '•••••••• (saved)' : 'app password';
  form.elements.apiKey.placeholder = s.hasApiKey ? '•••••••• (saved)' : 'sk-ant-…';
  form.elements.demo.checked = s.demo;
  $('custom-server').hidden = sel.value !== 'custom';
  $('settings').showModal();
}

$('provider').addEventListener('change', (e) => { $('custom-server').hidden = e.target.value !== 'custom'; });

$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  const f = $('settings-form').elements;
  await clearmail.saveSettings({
    provider: f.provider.value,
    user: f.user.value.trim(),
    pass: f.pass.value,
    apiKey: f.apiKey.value.trim(),
    imapHost: f.imapHost.value.trim(),
    imapPort: f.imapPort.value,
    smtpHost: f.smtpHost.value.trim(),
    smtpPort: f.smtpPort.value,
    demo: f.demo.checked,
  });
  load();
});

// ---------- wiring ----------

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  for (const b of $('filters').children) b.classList.toggle('active', b === btn);
  renderSidebar();
});
$('needs-you').addEventListener('click', () => $('filters').querySelector('[data-filter="action"]').click());
$('search').addEventListener('input', (e) => { state.search = e.target.value; renderSidebar(); });
$('refresh').addEventListener('click', load);
$('open-settings').addEventListener('click', openSettings);
$('reply-form').addEventListener('submit', sendReply);
$('reply-input').addEventListener('input', autosize);
$('reply-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) sendReply(e);
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 'r') { e.preventDefault(); load(); }
  if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); }
  if (e.metaKey && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const list = visibleConversations();
    if (!list.length) return;
    const i = list.findIndex((c) => c.key === state.selected);
    const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    select(next.key);
    document.activeElement?.blur();
    e.preventDefault();
  }
});

clearmail.onSummary(({ id, summary }) => {
  const m = state.emails.find((x) => x.id === id);
  if (!m) return;
  m.summary = summary;
  if (summary.source === 'ai') state.aiEnabled = true;
  renderSidebar();
  if ((m.from.address || m.from.name) === state.selected) renderConversation();
});

load();
