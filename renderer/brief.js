'use strict';

// The Brief tab: Needs you (cards), Worth knowing (compact cards, older ones under Earlier),
// Noise (collapsed, grouped by sender) and Done (collapsed, with Undo). Nothing is ever
// deleted: noise is only folded away, and every email can be read and moved back.

function renderBrief() {
  const view = $('view-brief');
  keepFocus(view, $('brief'), () => $('brief').replaceChildren(...briefSections()));
  for (const t of $('brief').querySelectorAll('textarea')) autosize(t);
}

function briefSections() {
  if (!state.loaded) {
    return [emptyState(state.loadError ? "ClearMail couldn't check your email yet. See the message above." : 'Checking your email…')];
  }
  if (!state.emails.length) return [emptyState('No email to show. Your inbox is empty.')];
  const live = state.emails.filter((m) => !m.done);
  const inBucket = (b) => live.filter((m) => m.triage.bucket === b);
  return [
    needsSection(inBucket('needs-you')),
    worthSection(inBucket('worth-knowing')),
    noiseSection(inBucket('noise')),
    doneSection(state.emails.filter((m) => m.done)),
  ];
}

const emptyState = (text, tip) => el('div', { class: 'empty-state' }, el('p', {}, text), tip ? el('p', { class: 'tip' }, tip) : null);

function secHead(id, title, count) {
  return el('h2', { class: 'sec-head', id },
    el('span', { class: 'sec-title' }, title),
    count != null ? el('span', { class: `sec-count${count ? '' : ' zero'}`, 'aria-label': plural(count, 'email') }, count) : null);
}

// A <details> that remembers being opened across redraws.
function foldable(key, attrs, summary, body) {
  const d = el('details', { ...attrs, open: state.open.has(key) }, el('summary', {}, summary), body);
  d.addEventListener('toggle', () => {
    if (d.open) state.open.add(key);
    else state.open.delete(key);
  });
  return d;
}

// ---------- the sections ----------

function needsSection(list) {
  return el('section', { class: 'sec sec-needs', 'aria-labelledby': 'h-needs' },
    secHead('h-needs', 'Needs you', list.length),
    list.length ? el('div', { class: 'cards' }, list.map((m) => card(m, false)))
      : emptyState('Nothing needs you right now.', 'Tip: flag an email in Outlook to put it here.'));
}

function worthSection(list) {
  const fresh = list.filter((m) => m.isNew);
  const earlier = list.filter((m) => !m.isNew);
  return el('section', { class: 'sec sec-worth', 'aria-labelledby': 'h-worth' },
    secHead('h-worth', 'Worth knowing', list.length),
    fresh.length ? el('div', { class: 'cards' }, fresh.map((m) => card(m, true)))
      : emptyState(state.sinceLabel ? `No new email ${state.sinceLabel}.` : 'No new email since your last brief.'),
    earlier.length ? foldable('earlier', { class: 'earlier' },
      [el('span', { class: 'fold-title' }, 'Earlier'), el('span', { class: 'fold-sub' }, plural(earlier.length, 'email'))],
      el('div', { class: 'cards' }, earlier.map((m) => card(m, true)))) : null);
}

// What kind of noise an email is, for "23 hidden: 12 newsletters, 8 promotions, 3 automated".
const NOISE_KINDS = [
  ['newsletter', 'newsletter', 'newsletters'],
  ['promo', 'promotion', 'promotions'],
  ['automated', 'automated', 'automated'],
  ['code', 'old sign-in code', 'old sign-in codes'],
  ['rule', 'from senders you chose', 'from senders you chose'],
];

function noiseKind(m) {
  const { codes } = m.triage;
  if (codes.includes('promo') || m.summary.category === 'promo') return 'promo';
  if (codes.includes('old-code')) return 'code';
  if (codes.includes('newsletter') || m.summary.category === 'newsletter') return 'newsletter';
  if (codes.includes('rule-noise') && m.summary.category === 'person') return 'rule';
  return 'automated';
}

function noiseSummary(list) {
  if (!list.length) return 'Nothing hidden';
  const counts = new Map();
  for (const m of list) counts.set(noiseKind(m), (counts.get(noiseKind(m)) || 0) + 1);
  const parts = NOISE_KINDS.filter(([k]) => counts.get(k)).map(([k, one, many]) => `${counts.get(k)} ${counts.get(k) === 1 ? one : many}`);
  return `${list.length} hidden: ${parts.join(', ')}`;
}

function noiseSection(list) {
  // Grouped by sender, in the order main sorted them (the newest group first).
  const groups = new Map();
  for (const m of list) {
    const key = ruleKey(m) || m.from.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return el('section', { class: 'sec sec-noise', 'aria-labelledby': 'h-noise' },
    el('h2', { class: 'sr-only', id: 'h-noise' }, 'Noise'),
    foldable('noise', { class: 'fold-sec' },
      [el('span', { class: 'sec-title' }, 'Noise'), el('span', { class: 'fold-sub' }, noiseSummary(list))],
      list.length ? el('div', { class: 'noise-groups' },
        el('p', { class: 'hint' }, 'Hidden, not deleted. Everything here is still in your mailbox.'),
        [...groups].map(([key, emails]) => noiseGroup(key, emails)))
        : emptyState('No noise right now.')));
}

function noiseGroup(key, emails) {
  const first = emails[0];
  const busy = emails.some((m) => state.busy.has(m.id));
  const ruled = first.senderRule === 'noise';
  return el('div', { class: 'noise-group', 'data-sender': key },
    el('div', { class: 'group-head' },
      el('div', { class: 'group-who' },
        el('span', { class: 'group-name', title: first.from.address }, first.from.name),
        el('span', { class: 'group-count' }, plural(emails.length, 'email')),
        first.triage.reasons[0] ? el('span', { class: 'group-why' }, first.triage.reasons[0]) : null),
      el('div', { class: 'group-actions' },
        ruleKey(first) ? el('button', {
          type: 'button', class: 'btn small', 'data-act': 'group-rule', disabled: busy,
          'aria-label': ruled ? `Stop sending ${first.from.name} to Noise` : `Always send ${first.from.name} to Noise`,
          onclick: () => setRule(first, ruled ? null : 'noise'),
        }, ruled ? 'Stop: Always noise' : 'Always noise') : null,
        el('button', {
          type: 'button', class: 'btn small', 'data-act': 'group-not-noise', disabled: busy,
          'aria-label': `${first.from.name}: not noise`, onclick: () => setNotNoise(emails.map((m) => m.id), true),
        }, 'Not noise'))),
    el('ul', { class: 'noise-rows' }, emails.map(noiseRow)));
}

function noiseRow(m) {
  const reading = state.reading.get(m.id);
  const busy = state.busy.has(m.id);
  return el('li', { class: 'noise-row', 'data-id': m.id },
    el('div', { class: 'row-main' },
      m.seen ? null : unreadDot(),
      el('span', { class: 'row-subject' }, m.subject || m.summary.gist),
      el('time', { class: 'when', datetime: m.receivedAt, title: fullDate(m.receivedAt) }, timeLabel(m.receivedAt)),
      el('button', {
        type: 'button', class: 'linkish', 'data-act': 'read', 'aria-expanded': String(Boolean(reading)),
        onclick: () => toggleRead(m),
      }, reading ? 'Hide' : 'Read'),
      el('button', {
        type: 'button', class: 'linkish', 'data-act': 'not-noise', disabled: busy, onclick: () => setNotNoise([m.id], true),
      }, 'Not noise')),
    reading ? readPanel(m, reading, { reply: true }) : null,
    composerIfOpen(m),
    replyStates(m));
}

function doneSection(list) {
  return el('section', { class: 'sec sec-done', 'aria-labelledby': 'h-done' },
    el('h2', { class: 'sr-only', id: 'h-done' }, 'Done'),
    foldable('done', { class: 'fold-sec' },
      [el('span', { class: 'sec-title' }, 'Done'), el('span', { class: 'fold-sub' }, list.length ? plural(list.length, 'email') : 'Nothing yet')],
      list.length ? el('ul', { class: 'done-rows' }, list.map(doneRow))
        : emptyState('Emails you mark Done go here.')));
}

function doneRow(m) {
  const reading = state.reading.get(m.id);
  return el('li', { class: 'done-row', 'data-id': m.id },
    el('div', { class: 'row-main' },
      el('span', { class: 'row-from' }, m.from.name),
      el('span', { class: 'row-subject' }, m.subject || m.summary.gist),
      el('time', { class: 'when', datetime: m.receivedAt, title: fullDate(m.receivedAt) }, timeLabel(m.receivedAt)),
      el('button', {
        type: 'button', class: 'linkish', 'data-act': 'read', 'aria-expanded': String(Boolean(reading)),
        onclick: () => toggleRead(m),
      }, reading ? 'Hide' : 'Read'),
      el('button', {
        type: 'button', class: 'linkish', 'data-act': 'undo-done', 'aria-label': `Undo done: ${m.subject || m.from.name}`,
        onclick: () => setDone([m.id], false, { quiet: true }),
      }, 'Undo')),
    reading ? readPanel(m, reading, { reply: false }) : null,
    replyStates(m));
}

// ---------- cards ----------

const unreadDot = () => el('span', { class: 'dot', role: 'img', 'aria-label': 'Unread in Outlook', title: 'Unread in Outlook' });

// compact: the smaller Worth knowing card.
function card(m, compact) {
  const t = m.triage;
  const reading = state.reading.get(m.id);
  return el('article', {
    class: `card${compact ? ' compact' : ''}${state.busy.has(m.id) ? ' busy' : ''}`,
    'data-id': m.id, 'aria-label': `${m.from.name}: ${m.subject || m.summary.gist}`,
  },
  el('div', { class: 'card-top' },
    m.seen ? null : unreadDot(),
    el('span', { class: 'sender', title: m.from.address }, m.from.name),
    m.isNew && !compact ? el('span', { class: 'new-tag' }, 'New') : null,
    multiAccount() && m.accountEmail ? el('span', { class: 'to', title: `Sent to your address ${m.accountEmail}` }, `to ${m.accountEmail}`) : null,
    el('time', { class: 'when', datetime: m.receivedAt, title: fullDate(m.receivedAt) }, timeLabel(m.receivedAt))),
  m.subject ? el('div', { class: 'subject' }, m.subject) : null,
  el('p', { class: 'gist' }, m.summary.gist),
  chipsFor(m, { links: !compact }),
  whyLine(m),
  t.caution ? el('p', { class: 'caution', role: 'note' }, el('b', {}, 'Careful: '), t.caution) : null,
  cardActions(m, reading),
  reading ? readPanel(m, reading, { reply: !state.composing.has(m.id) }) : null,
  composerIfOpen(m),
  replyStates(m));
}

// Reply is off when the email has no address to reply to (main would refuse it anyway).
function replyButton(m, act, { composing = false } = {}) {
  const canReply = Boolean(replyTarget(m));
  return el('button', {
    type: 'button', class: 'btn', 'data-act': act, 'aria-expanded': act === 'reply' ? String(composing) : null,
    disabled: !canReply, title: canReply ? null : NO_REPLY_ADDRESS,
    'aria-label': canReply ? `Reply to ${targetName(m)}` : NO_REPLY_ADDRESS,
    onclick: () => (composing ? focusComposer(m.id) : openComposer(m)),
  }, 'Reply');
}

function cardActions(m, reading) {
  const busy = state.busy.has(m.id);
  const composing = state.composing.has(m.id);
  return el('div', { class: 'card-actions' },
    el('button', {
      type: 'button', class: 'btn', 'data-act': 'read', 'aria-expanded': String(Boolean(reading)),
      onclick: () => toggleRead(m),
    }, reading ? 'Hide' : 'Read'),
    replyButton(m, 'reply', { composing }),
    el('button', {
      type: 'button', class: 'btn', 'data-act': 'done', disabled: busy,
      title: 'Mark it done: it moves to Done, nothing changes in your mailbox', onclick: () => setDone([m.id], true),
    }, '✓ Done'),
    moreMenu(m));
}

// The ⋯ menu: Always important, Always noise, Put back in Noise, Open in Outlook / Mail.
function moreMenu(m) {
  const open = state.menu === m.id;
  const busy = state.busy.has(m.id);
  const hasAddress = Boolean(ruleKey(m));
  const item = (act, label, run, disabled = false) => el('button', {
    type: 'button', role: 'menuitem', 'data-act': act, disabled: disabled || busy, tabindex: -1,
    onclick: run,
  }, label);
  const items = open ? [
    m.senderRule === 'important'
      ? item('menu-important', 'Stop: Always important', () => setRule(m, null), !hasAddress)
      : item('menu-important', 'Always important', () => setRule(m, 'important'), !hasAddress),
    m.senderRule === 'noise'
      ? item('menu-noise', 'Stop: Always noise', () => setRule(m, null), !hasAddress)
      : item('menu-noise', 'Always noise', () => setRule(m, 'noise'), !hasAddress),
    m.notNoise ? item('menu-noise-again', 'Put back in Noise', () => setNotNoise([m.id], false)) : null,
    m.canOpen ? item('menu-open', openLabel(m), () => openInMailApp(m)) : null,
  ].filter(Boolean) : [];
  return el('div', { class: 'menu-wrap' },
    el('button', {
      type: 'button', class: 'btn icon', 'data-act': 'more', 'aria-haspopup': 'menu', 'aria-expanded': String(open),
      'aria-label': `More for the email from ${m.from.name}`, title: 'More',
      onclick: () => toggleMenu(m.id),
    }, '⋯'),
    open ? el('div', { class: 'menu', role: 'menu', 'aria-label': `Email from ${m.from.name}`, onkeydown: menuKeys }, items) : null);
}

function toggleMenu(id) {
  state.menu = state.menu === id ? null : id;
  renderBrief();
  if (state.menu) $('brief').querySelector('.menu [role="menuitem"]:not(:disabled)')?.focus();
}

function closeMenu({ focus = true } = {}) {
  const id = state.menu;
  if (!id) return;
  state.menu = null;
  renderBrief();
  if (focus) $('brief').querySelector(`[data-id="${CSS.escape(id)}"] [data-act="more"]`)?.focus();
}

function menuKeys(e) {
  const items = [...e.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  } else if (e.key === 'Tab') {
    closeMenu({ focus: false });
  }
}

// ---------- Read and Reply ----------

function readPanel(m, view, { reply }) {
  return el('div', { class: 'read' },
    shortVersion(m),
    wordsLine(m),
    fullEmail(m, view, (mode) => {
      state.reading.set(m.id, mode);
      renderAll();
    }),
    readNote(),
    reply ? replyButton(m, 'read-reply') : null);
}

function toggleRead(m) {
  if (state.reading.has(m.id)) state.reading.delete(m.id);
  else state.reading.set(m.id, 'original');
  renderAll();
}

function openComposer(m) {
  state.composing.add(m.id);
  state.menu = null;
  renderAll();
  focusComposer(m.id);
}

function closeComposer(m) {
  state.composing.delete(m.id);
  renderAll();
  document.querySelector(`.view:not([hidden]) [data-id="${CSS.escape(m.id)}"] [data-act="reply"]`)?.focus();
}

const composerIfOpen = (m) => (state.composing.has(m.id) ? composer(m, { onClose: () => closeComposer(m) }) : null);

// Replies still waiting or that failed, and the last one sent.
function replyStates(m) {
  const list = repliesFor(m.id);
  const shown = list.filter((r, i) => r.status === 'pending' || r.status === 'failed' || i === list.length - 1);
  const nodes = shown.map((r) => replyState(m, r)).filter(Boolean);
  return nodes.length ? el('div', { class: 'reply-states', 'data-reply-for': m.id }, nodes) : null;
}
