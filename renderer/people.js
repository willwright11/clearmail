'use strict';

// The By person tab: one conversation per sender, read-only like the rest of ClearMail.
// Unread dots come from Outlook (or the mail server) and ClearMail never changes them.

const convoKey = (m) => (m.from.address || m.from.name).toLowerCase();
const byDate = (a, b) => new Date(a.date) - new Date(b.date);
const BUCKET_RANK = { 'needs-you': 0, 'worth-knowing': 1, noise: 2 };

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
    const live = c.emails.filter((m) => !m.done);
    c.needs = live.filter((m) => m.triage.bucket === 'needs-you');
    // The conversation's bucket is its most important email's (or Worth knowing when all are done).
    c.bucket = live.reduce((b, m) => (BUCKET_RANK[m.triage.bucket] < BUCKET_RANK[b] ? m.triage.bucket : b), live.length ? 'noise' : 'worth-knowing');
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
      ...m.attachments.map((a) => a.filename), m.cleanedBody, m.original.slice(0, 200000),
    ].join('\n').toLowerCase());
  }
  return searchCache.get(m);
}

function visibleConversations() {
  const q = state.search.trim().toLowerCase();
  return conversations().filter((c) => {
    if (c.key !== state.keepVisible && state.filter !== 'all') {
      if (state.filter === 'needs-you' ? !c.needs.length : c.bucket !== state.filter) return false;
    }
    return !q || c.name.toLowerCase().includes(q) || c.key.includes(q) || c.emails.some((m) => searchText(m).includes(q));
  });
}

// ---------- the list of people ----------

function chatItem(c, tabbable) {
  const selected = state.selected === c.key;
  const flag = c.needs.length ? el('span', { class: 'flag needs' }, 'Needs you')
    : c.bucket === 'noise' ? el('span', { class: 'flag noise' }, 'Noise') : null;
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
      c.unread ? el('span', { class: 'badge', title: 'Unread in Outlook' }, c.unread, el('span', { class: 'sr-only' }, ' unread')) : null)));
}

function emptyListText() {
  if (!state.loaded) return state.loading ? 'Checking your email…' : 'Nothing to show yet.';
  if (!state.emails.length) return 'Your inbox is empty.';
  if (state.search.trim()) return 'No matches.';
  return state.filter === 'needs-you' ? 'Nothing needs you right now.' : 'Nothing here.';
}

function renderSidebar() {
  const list = $('chat-list');
  // Keep the list's scroll position and keyboard focus across redraws.
  const focusedKey = document.activeElement?.closest?.('#chat-list .chat')?.dataset.key;
  const scroll = list.scrollTop;
  const convos = visibleConversations();
  const tabKey = convos.some((c) => c.key === state.selected) ? state.selected : convos[0]?.key;
  list.replaceChildren(...convos.map((c) => chatItem(c, c.key === tabKey)));
  if (!convos.length) list.append(el('li', { class: 'none', role: 'presentation' }, emptyListText()));
  list.scrollTop = scroll;
  list.setAttribute('aria-busy', String(state.loading));
  if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
}

// ---------- one conversation ----------

function bubble(m, convo) {
  const s = m.summary;
  const view = state.reading.get(m.id);
  const busy = state.busy.has(m.id);
  const canDone = m.done || m.triage.bucket === 'needs-you';
  return el('article', { class: `bubble${m.done ? ' done' : ''}${m.seen ? '' : ' unread'}`, 'data-id': m.id, 'data-view': view || '' },
    el('div', { class: 'bubble-meta' },
      bucketBadge(m),
      m.seen ? null : unreadDot(),
      m.from.name !== convo.name ? el('span', { class: 'from' }, m.from.name) : null,
      el('span', { class: 'subject' }, m.subject)),
    el('p', { class: 'gist' }, s.gist),
    shortVersion(m),
    chipsFor(m),
    whyLine(m),
    m.triage.caution ? el('p', { class: 'caution', role: 'note' }, el('b', {}, 'Careful: '), m.triage.caution) : null,
    view ? el('div', { class: 'read' },
      wordsLine(m),
      fullEmail(m, view, (mode) => {
        state.reading.set(m.id, mode);
        renderAll();
      }),
      readNote()) : null,
    el('div', { class: 'bubble-foot' },
      el('div', { class: 'foot-actions' },
        el('button', {
          class: 'linkish', type: 'button', 'aria-expanded': String(Boolean(view)), 'data-act': 'full',
          onclick: () => {
            if (view) state.reading.delete(m.id);
            else state.reading.set(m.id, 'original');
            renderAll();
          },
        }, view ? 'Hide full email' : 'Read full email'),
        canDone ? el('button', {
          class: `linkish done-btn${m.done ? ' is-done' : ''}`, type: 'button', 'aria-pressed': String(m.done), 'data-act': 'done', disabled: busy,
          title: m.done ? 'Undo: put it back' : 'Mark it done: nothing changes in your mailbox',
          onclick: () => setDone([m.id], !m.done, { quiet: m.done }),
        }, m.done ? '✓ Done' : 'Mark done') : null,
        copyButton(m, 'linkish')),
      multiAccount() && m.accountEmail ? el('span', { class: 'to', title: `Sent to your address ${m.accountEmail}` }, `to ${m.accountEmail}`) : null,
      s.words && s.words.original > s.words.short ? el('span', { class: 'saved', title: `${s.words.original} words → ${s.words.short}` }, `✂︎ ${s.words.original - s.words.short} words cut`) : null,
      el('time', { datetime: m.date, title: fullDate(m.date) }, clock(new Date(m.date)))));
}

function renderHead(convo) {
  const av = $('convo-avatar');
  av.textContent = initials(convo.name);
  av.style.setProperty('--h', hue(convo.key));
  $('convo-name').textContent = convo.name;
  $('convo-sub').textContent = convo.address;
  $('convo-done').hidden = !convo.needs.length;
}

function renderConversation(scroll = 'keep') {
  const convo = selectedConvo();
  const show = Boolean(convo);
  $('empty').hidden = show;
  $('convo-head').hidden = !show;
  $('messages').hidden = !show;
  if (!convo) return;
  renderHead(convo);

  const msgs = $('messages');
  const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
  keepFocus(msgs, $('conversation'), () => {
    const nodes = [];
    let lastDay = '';
    for (const m of convo.emails) {
      const day = dayLabel(m.date);
      if (day !== lastDay) {
        nodes.push(el('div', { class: 'day' }, el('span', {}, day)));
        lastDay = day;
      }
      nodes.push(bubble(m, convo));
    }
    msgs.replaceChildren(...nodes);
  });
  if (scroll === 'bottom' || (scroll === 'follow' && atBottom)) msgs.scrollTop = msgs.scrollHeight;
}

function renderPeople() {
  renderSidebar();
  renderConversation('follow');
}

// focus: 'list' (the person in the list) or 'none'.
function select(key, { focus = 'list' } = {}) {
  const convo = conversations().find((c) => c.key === key);
  if (!convo) return;
  const changed = key !== state.selected;
  state.selected = key;
  state.keepVisible = key;
  if (changed) {
    for (const m of convo.emails) state.reading.delete(m.id);
    state.allLinks.clear();
  }
  renderSidebar();
  renderConversation('bottom');
  if (focus === 'list') $('chat-list').querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

function setFilter(filter) {
  state.filter = filter;
  state.keepVisible = null;
  for (const b of $('filters').querySelectorAll('[data-filter]')) {
    b.classList.toggle('active', b.dataset.filter === filter);
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  }
  renderSidebar();
}

// The selected person may have gone after a reload (their emails were removed).
function dropMissingSelection() {
  if (state.selected && !conversations().some((c) => c.key === state.selected)) state.selected = null;
}
