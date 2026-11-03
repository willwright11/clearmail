/* global clearmail */
'use strict';

// Starts the app: the top bar, the two tabs, keyboard shortcuts, messages from the main
// process, and the first load.

const DEMO_TEXT = {
  flag: 'Demo mode: sample emails (ClearMail was started with --demo).',
  chosen: 'Demo mode: sample emails. Untick Demo mode in Settings to see your inbox.',
  'no-account': 'Demo mode: sample emails. Add your email account in Settings.',
};

// ---------- the top bar and status line ----------

function statusText() {
  const tab = state.tab === 'brief' ? 'Brief' : 'By person';
  if (!state.loaded) return state.loading ? 'Checking your email…' : tab;
  const parts = [tab];
  if (state.tab === 'brief' && state.sinceLabel) parts.push(state.sinceLabel);
  parts.push(state.loading ? 'checking for new email…' : `updated ${clock(new Date(state.generatedAt))}`);
  return parts.join(' · ');
}

// One account's load error, naming the account unless the message already does. An
// account that failed keeps the emails it had, so say they may be out of date.
function accountProblem(a) {
  const text = !a.email || a.error.toLowerCase().includes(a.email.toLowerCase()) ? a.error : `Couldn't load ${a.email}. ${a.error}`;
  return state.emails.some((m) => m.accountId === a.id) ? `${text} Its emails below are from the last time it loaded.` : text;
}

function renderLoadError() {
  const box = $('load-error');
  const lines = state.loadError
    ? [state.loaded ? `Couldn't refresh your inbox. ${state.loadError} What you see is from the last time it loaded.`
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
      el('button', { type: 'button', onclick: () => load({ force: true }) }, 'Try again'),
      el('button', { type: 'button', onclick: () => openSettings() }, 'Open Settings')),
  ]));
}

function renderChrome() {
  $('status-line').textContent = statusText();
  $('refresh').classList.toggle('busy', state.loading);
  $('refresh').setAttribute('aria-busy', String(state.loading));
  const demo = state.demo ? DEMO_TEXT[state.demoReason] || DEMO_TEXT['no-account'] : '';
  $('demo-banner').textContent = demo;
  $('demo-banner').hidden = !demo;
  renderLoadError();
  for (const tab of ['brief', 'people']) {
    const on = state.tab === tab;
    $(`tab-${tab}`).setAttribute('aria-selected', String(on));
    $(`tab-${tab}`).tabIndex = on ? 0 : -1;
    $(`view-${tab}`).hidden = !on;
  }
}

// Redraws whatever is on screen. The tab that's hidden is drawn when it's shown.
function renderAll() {
  renderChrome();
  dropMissingSelection();
  if (state.tab === 'brief') renderBrief();
  else renderPeople();
}

function showTab(tab, { focus = false } = {}) {
  if (tab !== 'brief' && tab !== 'people') return;
  state.tab = tab;
  state.menu = null;
  renderAll();
  if (focus) $(`tab-${tab}`).focus();
}

// ---------- moving the old "done" flags out of this window ----------
// ClearMail 0.2 kept them in the page's localStorage. They now live with main (state.json),
// so they're handed over once and then removed here.

async function importOldDone() {
  let raw = null;
  try {
    raw = localStorage.getItem('clearmail.done');
  } catch {
    return;
  }
  if (!raw) return;
  let map = null;
  try {
    map = JSON.parse(raw);
  } catch { /* unreadable: nothing to hand over */ }
  if (map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length) {
    try {
      await clearmail.importDone(map);
    } catch {
      return; // tried again next time ClearMail opens
    }
  }
  try {
    localStorage.removeItem('clearmail.done');
  } catch { /* harmless: main ignores ids it already has */ }
}

// ---------- wiring ----------

function wire() {
  $('tab-brief').addEventListener('click', () => showTab('brief'));
  $('tab-people').addEventListener('click', () => showTab('people'));
  // Arrow keys move between the two tabs, as in any tab list.
  $('tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    showTab(state.tab === 'brief' ? 'people' : 'brief', { focus: true });
  });
  $('refresh').addEventListener('click', () => load({ force: true }));
  $('open-settings').addEventListener('click', () => openSettings());
  $('notice').addEventListener('click', () => notice(''));

  // By person
  $('filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (btn) setFilter(btn.dataset.filter);
  });
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderSidebar();
  });
  $('convo-done').addEventListener('click', () => {
    const convo = selectedConvo();
    if (convo) setDone(convo.needs.map((m) => m.id), true);
  });

  // A click anywhere else closes the ⋯ menu.
  document.addEventListener('click', (e) => {
    if (state.menu && !e.target.closest?.('.menu-wrap')) closeMenu({ focus: false });
  });

  document.addEventListener('keydown', (e) => {
    if ($('settings').open || e.isComposing) return; // the dialog handles its own keys
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && !e.altKey && !e.shiftKey) {
      const go = {
        r: () => load({ force: true }),
        ',': () => openSettings(),
        1: () => showTab('brief', { focus: true }),
        2: () => showTab('people', { focus: true }),
        f: () => {
          showTab('people');
          $('search').focus();
        },
      }[e.key];
      if (go) {
        e.preventDefault();
        go();
        return;
      }
    }
    if (e.key === 'Escape' && state.menu) {
      e.preventDefault();
      closeMenu();
      return;
    }
    // Up and down move through the people list (not while typing or reading an email).
    if (state.tab !== 'people' || cmd || e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const active = document.activeElement;
    if (active?.matches('input, textarea, select') || active?.closest('#conversation')) return;
    const list = visibleConversations();
    if (!list.length) return;
    const i = list.findIndex((c) => c.key === state.selected);
    const next = list[i === -1 ? 0 : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault();
    const inList = Boolean(active?.closest('#chat-list'));
    select(next.key, { focus: inList ? 'list' : 'none' });
    if (!inList) active?.blur?.();
  });

  // From the main process.
  clearmail.onReplyResult((data) => handleReplyResult(data));
  clearmail.onInboxUpdated((data) => inboxUpdated(data));
  // The morning brief notification was clicked.
  clearmail.onBriefShow(() => {
    showTab('brief');
    $('view-brief').scrollTop = 0;
    load();
  });

  wireSettings();
}

wire();
renderAll();
importOldDone().finally(() => load());
