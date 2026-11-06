const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, clipboard, Notification, powerMonitor, net, nativeTheme } = require('electron');
const mail = require('./src/mail');
const microsoft = require('./src/microsoft');
const store = require('./src/store');
const config = require('./src/config');
const demo = require('./src/demo');
const { buildSentBatch } = require('./src/demo-sent');
const history = require('./src/history');
const brief = require('./src/brief');
const view = require('./src/view');
const { orderForLocale } = require('./src/dates');
const { isValidRuleKey } = require('./src/triage');

// ClearMail is a read-only summary of the inbox. It can't send, delete, move, flag or mark
// anything as read: the backends only read the inbox and the Sent folder (which is how a
// reply the user makes in Outlook or Mail is noticed). Sorting marks stay in ClearMail.

const FORCE_DEMO = process.argv.includes('--demo');
const DEMO_ACCOUNT = 'demo'; // the accountId of the sample emails
const REUSE_MS = 60 * 1000; // a load this recent is reused instead of fetching again
const HISTORY_EVERY_MS = 5 * 60 * 1000; // the Sent folder is read at most this often per account (Refresh reads it now)
const HISTORY_WAIT_MS = 15 * 1000; // how long a load waits for it before sorting without it
const MAX_IDS = 5000;
const NO_CLIENT_ID = 'ClearMail needs a Microsoft app ID (the "Application (client) ID") before it can use Outlook. Add it in Settings. See "Using Outlook" in the README for the 5-minute setup.';
const EMAIL_GONE = 'This email is no longer in your inbox. Refresh and try again.';
const passLocked = (user) => `ClearMail couldn't unlock the saved app password for ${user} from the macOS Keychain. Quit and reopen ClearMail and choose Always Allow when asked, or enter the password again in Settings.`;
const signInLocked = (email) => `ClearMail couldn't unlock your saved Microsoft sign-in for ${email} from the macOS Keychain. Quit and reopen ClearMail and choose Always Allow when asked, or click "Sign in again".`;
const signInAgain = (email) => `Microsoft needs you to sign in to ${email} again. Use "Sign in again" to reconnect it.`;
const reconnect = (email) => `ClearMail no longer needs permission to send email or change your mailbox. Click "Sign in again" to reconnect ${email}.`;

// The error codes src/microsoft.js uses, with wording for when its error has no message.
const MS_ERRORS = {
  'needs-sign-in': 'Microsoft needs you to sign in to this account again. Use "Sign in again" to reconnect it.',
  'admin-approval': "Your organisation (for example your university's IT team) has to approve ClearMail before it can open this mailbox. You can ask them to approve it for your account, or keep reading this mailbox in Outlook as usual.",
  'no-client-id': NO_CLIENT_ID,
  cancelled: 'Signing in was cancelled.',
  timeout: 'Signing in took too long, so ClearMail stopped waiting. Please try again.',
  network: "Couldn't reach Microsoft. Check your internet connection and try again.",
  throttled: 'Microsoft is busy right now. Wait a minute and try again.',
  server: 'Microsoft had a problem. Please try again in a few minutes.',
};

// Only these pages are ever opened from Settings (never a URL from the window).
const SYSTEM_SETTINGS = {
  notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  'login-items': 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
};
const CONSENT_PAGES = { personal: 'https://account.live.com/consent/Manage', work: 'https://myapps.microsoft.com' };
const OUTLOOK_WEB = { personal: 'https://outlook.live.com/mail/0/inbox', work: 'https://outlook.office.com/mail/inbox' };
const LOGIN_STATUSES = ['enabled', 'requires-approval', 'not-registered', 'not-found'];
const MESSAGE_ID_RE = /^<[^<>\s"\\]{1,900}@[^<>\s"\\]{1,200}>$/;

let win = null;
let settings = { accounts: [], limit: 60, demo: false, msClientId: '', brief: { ...brief.BRIEF_DEFAULTS } }; // until the app is ready
let marks = store.emptyState(); // state.json: sorting rules, Done, Not noise, the brief
let histories = {}; // history.json: who the user has written to, per account id
// The emails the window is showing. Each remembers the account it came from (as it was when
// loaded), so Open knows where to find it and a failed refresh keeps only that mailbox's emails.
let inbox = { demo: null, demoReason: null, entries: new Map(), accounts: [], key: null, at: 0 };
let prepared = new Map(); // email id -> cleaned text, deadlines and short version (src/view.js)
let loadGen = 0; // bumped by every fetch; older fetches give way to newer ones
let latestLoad = null;
let demoHistory = history.emptyHistory(); // the sample Sent folder
const historySyncing = new Map(); // account id -> its Sent folder read in progress
const needsSignIn = new Set(); // Microsoft account ids whose last call said to sign in again
let signInRun = null; // AbortController of the Microsoft sign-in waiting in the browser
let scheduler = null; // the morning brief (src/brief.js)
let notification = null; // the last one shown, kept so it isn't garbage-collected before a click
const briefRun = { lastError: null, notificationsBlocked: false };

// Electron sends err.toString() to the renderer; an empty name leaves just the message.
function ipcError(message, cause, code) {
  const err = new Error(message || 'Something went wrong. Please try again.', cause ? { cause } : undefined);
  err.name = '';
  if (code) err.code = code;
  return err;
}

function send(channel, data) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    title: 'ClearMail',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme?.shouldUseDarkColors ? '#14171b' : '#f5f6f8', // the page's own background, so opening doesn't flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // A closed window must not be used again (on macOS the app keeps running for the brief).
  win.on('closed', () => { win = null; });

  // Never navigate the app window away; send links to the default browser.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  return win;
}

// Electron's default menu binds ⌘R to reloading the whole page. Without it, ⌘R reaches the
// page and refreshes the inbox (as the Refresh button does).
function setMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
    },
    { role: 'windowMenu' },
  ]));
}

// ---------- state ----------

function demoState() {
  if (FORCE_DEMO) return { active: true, reason: 'flag' };
  if (settings.demo) return { active: true, reason: 'chosen' };
  // An account without a password is not demo: loading then says what is missing.
  if (!settings.accounts.length) return { active: true, reason: 'no-account' };
  return { active: false, reason: null };
}

const addressOf = (account) => (account.kind === 'microsoft' ? account.email : account.user) || '';
const accountExists = (accountId) => accountId === DEMO_ACCOUNT || settings.accounts.some((a) => a.id === accountId);
const isPersonal = (account) => (typeof account.personal === 'boolean' ? account.personal : store.MICROSOFT_MAIL_RE.test(account.email || ''));

// The accounts whose emails, marks and history may be kept (the sample emails' too).
const knownAccountIds = () => new Set([DEMO_ACCOUNT, ...settings.accounts.map((a) => a.id)]);

// The user's first names ("will"), so an ask like "Will, could you…" reads as meant for
// them: from each account's display name, or the sample user's in demo mode.
const userNames = (demoActive) => view.firstNames(demoActive ? [demo.ME.name] : settings.accounts.map((a) => a.name));

// state.json. Marks older than 60 days are only dropped for emails ClearMail knows have gone
// (their account loaded this session without them), so a Done email still in the inbox stays
// done however old, and nothing is lost before the first load or while an account fails.
function saveMarks(next = marks) {
  const loaded = new Set(inbox.accounts.filter((r) => !r.error).map((r) => r.account.id));
  if (inbox.demo) loaded.add(DEMO_ACCOUNT);
  const keep = new Set(inbox.entries.keys());
  for (const list of [next.done, next.notNoise]) {
    for (const id of Object.keys(list || {})) if (!loaded.has(id.slice(0, id.indexOf(':')))) keep.add(id);
  }
  marks = store.saveState(next, { keep, accountIds: knownAccountIds() });
}

// history.json. An account that is no longer in Settings is dropped, so nothing written for it
// late (a Sent folder read that finished after it was removed) outlives it.
function saveHistories() {
  const known = knownAccountIds();
  for (const id of Object.keys(histories)) if (!known.has(id)) delete histories[id];
  try {
    store.saveHistory(histories, { accountIds: known });
  } catch (err) {
    console.error('Could not save the sent-email history:', err.message);
  }
}

// What "What ClearMail can see" in Settings shows: counts only, from the last load.
function canSee() {
  if (inbox.demo !== false) return null;
  const real = [...inbox.entries.values()].filter((e) => e.accountId !== DEMO_ACCOUNT);
  return {
    emails: real.length,
    withListHeaders: real.filter((e) => e.raw.headers && (e.raw.headers.listUnsubscribe || e.raw.headers.listId)).length,
    focusedOther: real.some((e) => typeof e.raw.focused === 'boolean'),
    people: history.historyCounts(histories).people,
  };
}

function publicView() {
  const d = demoState();
  return {
    ...store.publicSettings(settings, { needsSignIn }),
    demoActive: d.active,
    demoReason: d.reason,
    providers: Object.fromEntries(Object.entries(mail.PROVIDERS).map(([k, v]) => [k, v.label])),
    msClientIdBuiltIn: Boolean(config.msClientId),
    rules: { ...marks.rules },
    canSee: canSee(),
  };
}

// ---------- Microsoft accounts ----------

// The app ID typed in Settings wins over the one built into the app.
const clientId = () => settings.msClientId || config.msClientId || '';

// Microsoft hands out a new refresh token now and then. The old one keeps working, so
// failing to save the new one only shortens how long the sign-in lasts.
function keepRefreshToken(accountId, token) {
  try {
    const next = store.setRefreshToken(accountId, token);
    if (next) settings = next;
  } catch (err) {
    console.error('Could not save a renewed Microsoft sign-in:', err.message);
  }
}

// What the account's token may do, so Settings can warn about an old consent that still
// allows changing or sending mail (Mail.ReadWrite or Mail.Send).
function keepGrantedScopes(accountId, scopes) {
  try {
    const next = store.setGrantedScopes(accountId, scopes);
    if (next) settings = next;
  } catch (err) {
    console.error('Could not save what Microsoft allows ClearMail to do:', err.message);
  }
}

// Options for every src/microsoft.js call made for this account.
function msOptions(account) {
  if (account.upgrade === 'reconnect') throw ipcError(reconnect(account.email), null, 'needs-sign-in');
  if (!account.refreshToken) {
    const text = account.locked ? signInLocked(account.email) : signInAgain(account.email);
    throw ipcError(text, null, 'needs-sign-in');
  }
  const id = clientId();
  if (!id) throw ipcError(NO_CLIENT_ID, null, 'no-client-id');
  return {
    clientId: id,
    onRefreshToken: (token) => keepRefreshToken(account.id, token),
    onGrantedScopes: (scopes) => keepGrantedScopes(account.id, scopes),
  };
}

// src/microsoft.js writes its errors for the user when they carry one of its codes;
// anything else is a bug, so the user gets the fallback and the details go to the log.
function msError(err, fallback) {
  const code = err?.code;
  if (!code || !Object.hasOwn(MS_ERRORS, code)) return ipcError(fallback, err);
  const text = typeof err.message === 'string' && err.message.trim() ? err.message.trim() : MS_ERRORS[code];
  return ipcError(text, err, code);
}

// A failed call for an account, as an error for the user. Notes Microsoft accounts that
// need signing in again, so Settings and the error box can offer the button.
function accountError(account, err, fallback) {
  const microsoftAccount = account.kind === 'microsoft';
  if (microsoftAccount && err?.code === 'needs-sign-in') needsSignIn.add(account.id);
  if (err?.name === '') return err; // already written for the user
  if (!microsoftAccount) return ipcError(err?.message || fallback, err); // mail.js errors are written for the user
  // The plain "sign in again" names the account. A more specific reason (such as the
  // organisation blocking ClearMail) is kept as it is.
  if (err?.code === 'needs-sign-in' && (!err.message || /^Microsoft needs you to sign in to this account again\b/.test(err.message))) {
    return ipcError(signInAgain(account.email), err, err.code);
  }
  return msError(err, fallback);
}

function signedIn(account) {
  if (account.kind === 'microsoft') needsSignIn.delete(account.id);
}

// An IMAP account whose password the Keychain won't unlock says so, instead of "add a password".
function imapReady(account) {
  // An Outlook account saved by the first ClearMail version, which offered Outlook over IMAP.
  if (store.MICROSOFT_MAIL_RE.test(account.user || '')) {
    throw ipcError('Outlook no longer works with app passwords. In Settings, remove this account and use "Add Outlook or Microsoft 365" instead.');
  }
  if (account.locked && !account.pass) throw ipcError(passLocked(account.user));
  return account;
}

// A removed account's emails, sorting marks and Sent history go with it.
function forgetAccount(accountId) {
  const prefix = `${accountId}:`;
  for (const id of [...prepared.keys()]) if (id.startsWith(prefix)) prepared.delete(id);
  for (const id of [...inbox.entries.keys()]) if (id.startsWith(prefix)) inbox.entries.delete(id);
  inbox.accounts = inbox.accounts.filter((r) => r.account.id !== accountId);
  const next = { ...marks, done: { ...marks.done }, notNoise: { ...marks.notNoise } };
  for (const list of [next.done, next.notNoise]) for (const id of Object.keys(list)) if (id.startsWith(prefix)) delete list[id];
  try {
    saveMarks(next);
  } catch (err) {
    console.error('Could not save after removing an account:', err.message);
  }
  if (Object.hasOwn(histories, accountId)) {
    delete histories[accountId];
    saveHistories();
  }
  needsSignIn.delete(accountId);
  if (typeof microsoft.forgetAccount === 'function') microsoft.forgetAccount(accountId); // its access token and cached headers
}

// ---------- loading the inbox ----------

// Waits for promise, but no longer than ms. Never rejects.
const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  Promise.resolve(promise).catch(() => {}).finally(() => {
    clearTimeout(timer);
    resolve();
  });
});

// Reads the account's Sent folder (only what is new since last time), at most every few
// minutes, or straight away when forced: after replying in Outlook or Mail, Refresh then
// shows "You've already replied". Never rejects: without it, sorting just knows less about
// who the user writes to.
function syncHistory(account, { force = false } = {}) {
  if (historySyncing.has(account.id)) return historySyncing.get(account.id);
  const known = histories[account.id];
  const last = Date.parse(known?.syncedAt || '');
  if (!force && !Number.isNaN(last) && Date.now() - last < HISTORY_EVERY_MS) return Promise.resolve();
  const identity = store.accountIdentity(account);
  const run = (async () => {
    try {
      const cursor = known?.cursor || null;
      const batch = account.kind === 'imap'
        ? await mail.fetchSentHistory(imapReady(account), cursor)
        : await microsoft.fetchSentHistory(account, cursor, msOptions(account));
      // Not for an account removed or pointed at another mailbox meanwhile.
      const current = settings.accounts.find((a) => a.id === account.id);
      if (!current || store.accountIdentity(current) !== identity) return;
      histories[account.id] = history.mergeSent(histories[account.id] || null, batch, { accountEmail: addressOf(account), now: Date.now() });
      saveHistories();
    } catch (err) {
      console.warn(`Couldn't read the sent emails of a ${account.kind} account:`, err?.message);
    } finally {
      historySyncing.delete(account.id);
    }
  })();
  historySyncing.set(account.id, run);
  return run;
}

function fetchAccount(account, limit) {
  if (account.kind === 'imap') return mail.fetchInbox(imapReady(account), { limit });
  return microsoft.fetchInbox(account, { ...msOptions(account), limit });
}

// Never rejects: one account failing must not hide the others.
async function loadAccount(account, limit, force) {
  try {
    const [raw] = await Promise.all([fetchAccount(account, limit), within(syncHistory(account, { force }), HISTORY_WAIT_MS)]);
    signedIn(account);
    return { account, raw: Array.isArray(raw) ? raw : [], error: null };
  } catch (err) {
    const error = accountError(account, err, "Couldn't load this account. Please try again.");
    console.warn(`Couldn't load a ${account.kind} account:`, error.message);
    return { account, raw: [], error: error.message };
  }
}

// What a load depends on: a load for the same key that is recent enough is reused.
function fetchKey() {
  const d = demoState();
  return JSON.stringify([d.active, d.reason, settings.limit, clientId(), settings.accounts.map((a) => [
    a.id, store.accountIdentity(a), a.kind === 'imap' ? Boolean(a.pass) : Boolean(a.refreshToken) && !a.upgrade,
  ])]);
}

function localeOrder() {
  try {
    return orderForLocale(app.getLocale());
  } catch {
    return 'dmy';
  }
}

async function fetchInbox(gen, force) {
  const d = demoState();
  const key = fetchKey();
  let results;
  if (d.active) {
    // Built for now, so the sample deadlines always look current.
    const now = Date.now();
    const raw = demo.build(now);
    demoHistory = history.mergeSent(null, buildSentBatch({ now, emails: raw }), { accountEmail: demo.ME.address, now });
    results = [{ account: { id: DEMO_ACCOUNT, kind: 'demo' }, raw, error: null }];
  } else {
    const limit = settings.limit;
    results = await Promise.all(settings.accounts.map((account) => loadAccount(account, limit, force)));
  }
  // A newer load started while this one was downloading: answer with that one instead.
  if (gen !== loadGen) return latestLoad || currentView();
  // An account removed while it was loading is left out.
  results = results.filter((r) => accountExists(r.account.id));
  if (!d.active && results.length && results.every((r) => r.error)) {
    if (results.length === 1) throw ipcError(results[0].error);
    throw ipcError(`ClearMail couldn't load any of your accounts. ${results.map((r) => `${addressOf(r.account)}: ${r.error}`).join(' ')}`);
  }

  const entries = new Map();
  for (const { account, raw, error } of results) {
    if (error) {
      // An account that couldn't load this time keeps the emails it showed last time, so a
      // network blip doesn't empty it.
      for (const entry of inbox.entries.values()) {
        const same = entry.accountId === account.id && store.accountIdentity(entry.account) === store.accountIdentity(account);
        if (same && !entries.has(entry.id)) entries.set(entry.id, entry);
      }
      continue;
    }
    for (const email of raw) {
      if (!email || email.id == null) continue;
      // Prefixed with the account, so ids are unique across accounts and stable across refreshes.
      const id = `${account.id}:${email.id}`;
      if (entries.has(id)) continue;
      const accountEmail = account.kind === 'demo' ? '' : addressOf(account);
      entries.set(id, { id, accountId: account.id, accountEmail, account, raw: email });
    }
  }
  const order = localeOrder();
  const names = userNames(d.active);
  const next = new Map();
  for (const entry of entries.values()) next.set(entry.id, view.prepareEmail(entry.raw, { order, names, previous: prepared.get(entry.id) }));
  prepared = next;
  inbox = {
    demo: d.active,
    demoReason: d.reason,
    entries,
    accounts: d.active ? [] : results.map(({ account, error }) => ({ account, error })),
    key,
    at: Date.now(),
  };
  return currentView();
}

/**
 * Fetches the inbox from every account and sorts it. A load less than a minute old is
 * reused unless force is set; a load already on its way is shared. A forced load (Refresh)
 * also reads the Sent folders now, rather than at most every few minutes.
 */
function loadInbox({ force = false } = {}) {
  const key = fetchKey();
  if (!force && inbox.key === key && Date.now() - inbox.at < REUSE_MS) return Promise.resolve(currentView());
  if (!force && latestLoad && latestLoad.key === key) return latestLoad;
  const gen = ++loadGen;
  const run = fetchInbox(gen, force);
  run.key = key;
  latestLoad = run;
  const clear = () => {
    if (latestLoad === run) latestLoad = null;
  };
  run.then(clear, clear);
  return run;
}

// Whose Sent history the sorting uses: the loaded accounts', or the sample one in demo mode.
function historyContext() {
  if (inbox.demo) return history.historyContext([demoHistory], { accountEmails: [demo.ME.address] });
  const list = settings.accounts.map((a) => histories[a.id]).filter(Boolean);
  return history.historyContext(list, { accountEmails: settings.accounts.map(addressOf).filter(Boolean) });
}

function canOpen(entry) {
  if (entry.accountId === DEMO_ACCOUNT) return false;
  if (entry.account.kind === 'microsoft') return true;
  return MESSAGE_ID_RE.test(String(entry.raw.messageId || ''));
}

/** The BriefView for what is loaded now, sorted again (no fetching). */
function currentView() {
  const now = Date.now();
  const window = brief.briefWindow(now, marks.brief);
  const d = inbox.demo === null ? demoState() : { active: inbox.demo, reason: inbox.demoReason };
  const items = [...inbox.entries.values()].filter((e) => prepared.has(e.id)).map((entry) => ({
    id: entry.id,
    accountId: entry.accountId,
    accountEmail: entry.accountEmail,
    raw: entry.raw,
    prep: prepared.get(entry.id),
    canOpen: canOpen(entry),
  }));
  return view.buildBriefView({
    now,
    demo: d.active,
    demoReason: d.reason,
    since: window.since,
    sinceLabel: window.label,
    accounts: inbox.accounts.filter((r) => accountExists(r.account.id)).map(({ account, error }) => {
      const current = settings.accounts.find((a) => a.id === account.id) || account;
      return {
        id: account.id,
        email: addressOf(account),
        kind: account.kind,
        error,
        needsSignIn: account.kind === 'microsoft' && (needsSignIn.has(account.id) || current.upgrade === 'reconnect'),
      };
    }),
    items,
    history: historyContext(),
    marks,
    names: userNames(d.active),
  });
}

// ---------- the morning brief ----------

// Shows a notification. It never names a sender or subject (it can show on the lock screen).
function notify(text) {
  if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) {
    briefRun.lastError = "This Mac doesn't let ClearMail show notifications.";
    return false;
  }
  const n = new Notification({ title: text.title, body: text.body, ...(text.subtitle ? { subtitle: text.subtitle } : {}) });
  n.on('click', () => showBrief());
  n.on('show', () => { briefRun.notificationsBlocked = false; });
  n.on('failed', (_e, error) => {
    briefRun.notificationsBlocked = true;
    briefRun.lastError = "macOS didn't show the notification. Turn on notifications for ClearMail in System Settings → Notifications.";
    console.warn('A notification could not be shown:', error);
  });
  n.show();
  notification = n;
  return true;
}

// The notification was clicked: show the Brief.
function showBrief() {
  if (!win) createWindow();
  if (win.isMinimized?.()) win.restore();
  win.show?.();
  try {
    app.focus({ steal: true });
  } catch {}
  if (win.webContents.isLoading?.()) win.webContents.once('did-finish-load', () => send('brief:show'));
  else send('brief:show');
}

// Called by the scheduler when the brief is due. Resolves { ok }.
async function deliverBrief(slot, { final = false } = {}) {
  const now = Date.now();
  if (final) {
    // Three tries failed: say so, and that day is over.
    notify(brief.failedBriefText());
    briefRun.lastError = "ClearMail couldn't check your email for the morning brief.";
    try {
      saveMarks({ ...marks, brief: { ...marks.brief, lastSlot: slot } });
    } catch (err) {
      console.error('Could not save the brief state:', err.message);
    }
    return { ok: true };
  }
  const window = brief.briefWindow(now, marks.brief);
  let result;
  try {
    result = await loadInbox({ force: true });
  } catch (err) {
    briefRun.lastError = err?.name === '' ? err.message : "ClearMail couldn't check your email.";
    return { ok: false };
  }
  const counts = brief.briefCounts(result.emails, { since: window.since, now });
  const failedAccounts = result.accounts.filter((a) => a.error).map((a) => a.email);
  notify(brief.briefText(counts, { failedAccounts, sinceLabel: window.label }));
  if (!briefRun.notificationsBlocked) briefRun.lastError = null;
  try {
    saveMarks({ ...marks, brief: { lastSlot: slot, lastAt: now, lastSince: window.since } });
  } catch (err) {
    console.error('Could not save the brief state:', err.message);
  }
  send('inbox:updated', currentView());
  return { ok: true };
}

// The brief only runs for real accounts: in demo mode it is off (the test brief still works).
const briefSettings = () => (demoState().active ? { ...settings.brief, enabled: false } : settings.brief);

function startScheduler() {
  scheduler = brief.createBriefScheduler({
    now: () => Date.now(),
    getSettings: briefSettings,
    getBriefState: () => marks.brief,
    deliver: deliverBrief,
    isOnline: () => (typeof net?.isOnline === 'function' ? net.isOnline() : true),
    isLocked: () => powerMonitor.getSystemIdleState(60) === 'locked',
  });
  scheduler.start();
  // A wall-clock poll survives sleep, but checking on wake means the brief isn't a minute late.
  for (const event of ['resume', 'unlock-screen', 'user-did-become-active']) powerMonitor.on(event, () => scheduler.check(event));
}

// Turning the brief on (or changing its time or days) after today's time has passed starts
// tomorrow, rather than popping up a brief straight away (also later, when Demo mode is
// turned off).
function skipTodayIfPassed(before) {
  const now = Date.now();
  const after = settings.brief;
  const changed = after.enabled && (!before.enabled || before.time !== after.time || before.days.join() !== after.days.join());
  const due = changed && brief.dueBrief(now, after, marks.brief.lastSlot);
  if (!due) return;
  try {
    saveMarks({ ...marks, brief: { ...marks.brief, lastSlot: due.slot } });
  } catch (err) {
    console.error('Could not save the brief state:', err.message);
  }
}

// What macOS says about opening ClearMail at login.
function loginItem() {
  if (!settings.brief.openAtLogin) return { status: 'off', message: null };
  try {
    const s = app.getLoginItemSettings();
    const status = LOGIN_STATUSES.includes(s?.status) ? s.status : s?.openAtLogin ? 'enabled' : 'not-registered';
    return { status, message: null };
  } catch (err) {
    console.warn('Could not read the login item:', err.message);
    return { status: 'not-found', message: null };
  }
}

function applyLoginItem() {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.brief.openAtLogin) });
  } catch (err) {
    console.warn('Could not change the login item:', err.message);
  }
}

function openedAtLogin() {
  try {
    return process.platform === 'darwin' && Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
  } catch {
    return false;
  }
}

function briefStatus() {
  const s = settings.brief;
  const paused = s.enabled && demoState().active;
  const next = paused ? null : brief.nextBriefTime(Date.now(), s, marks.brief.lastSlot);
  return {
    enabled: s.enabled,
    paused: paused ? 'The morning brief is paused while ClearMail shows sample emails (Demo mode).' : null,
    nextAt: next,
    lastAt: marks.brief.lastAt,
    lastError: briefRun.lastError,
    notificationsBlocked: briefRun.notificationsBlocked,
    loginItem: loginItem(),
  };
}

// ---------- IPC ----------

// Errors meant for the user are made with ipcError. Anything else is a bug: the user
// gets the fallback sentence and the details go to the log.
function handle(channel, fallback, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`${channel} failed:`, err?.cause || err);
      throw err?.name === '' ? err : ipcError(fallback, err);
    }
  });
}

// Runs a store.js change; its errors are written for the user.
function saveWith(fn) {
  try {
    settings = fn();
  } catch (err) {
    throw ipcError(err.message, err);
  }
  return publicView();
}

// Runs a change to state.json; its errors are written for the user.
function markWith(change) {
  const next = { ...marks, rules: { ...marks.rules }, done: { ...marks.done }, notNoise: { ...marks.notNoise } };
  change(next);
  try {
    saveMarks(next);
  } catch (err) {
    throw ipcError(err.message, err);
  }
  return currentView();
}

const loadedEntry = (id) => (typeof id === 'string' ? inbox.entries.get(id) || null : null);

handle('settings:get', "Couldn't read your settings.", () => publicView());

handle('settings:save', "Couldn't save your settings. Please try again.", (_e, input) => {
  const before = settings.brief;
  const result = saveWith(() => store.saveSettings(input));
  if (before.openAtLogin !== settings.brief.openAtLogin) applyLoginItem();
  skipTodayIfPassed(before);
  return result;
});

handle('account:save', "Couldn't save the account. Please try again.", (_e, input) => {
  const before = settings.accounts.find((a) => a.id === input?.id);
  const result = saveWith(() => store.saveAccount(input));
  const after = before && settings.accounts.find((a) => a.id === before.id);
  // Pointed at another mailbox: what was known about the old one's Sent folder no longer applies.
  if (before && after && store.accountIdentity(before) !== store.accountIdentity(after) && Object.hasOwn(histories, before.id)) {
    delete histories[before.id];
    saveHistories();
  }
  return result;
});

handle('account:remove', "Couldn't remove the account. Please try again.", (_e, id) => {
  if (typeof id !== 'string' || !id) throw ipcError("Couldn't remove the account. Please try again.");
  const result = saveWith(() => store.removeAccount(id));
  forgetAccount(id);
  return result;
});

// Opens the Microsoft sign-in page in the browser and waits for it. With accountId, that
// account is signed in again; otherwise a new account is added (or an existing one with
// the same address is updated).
handle('microsoft:signIn', "Couldn't sign in to Microsoft. Please try again.", async (_e, options) => {
  if (signInRun) throw ipcError('ClearMail is already waiting for you to sign in. Finish signing in in your browser, or click Cancel.');
  const accountId = typeof options?.accountId === 'string' && options.accountId ? options.accountId : null;
  const target = accountId ? settings.accounts.find((a) => a.id === accountId && a.kind === 'microsoft') : null;
  if (accountId && !target) throw ipcError('That account is no longer in ClearMail. Close Settings and try again.');
  const id = clientId();
  if (!id) throw ipcError(NO_CLIENT_ID, null, 'no-client-id');

  const run = new AbortController();
  signInRun = run;
  let result;
  try {
    result = await microsoft.signIn({
      clientId: id,
      // Only ever opens a secure web page, in the user's own browser.
      openUrl: (url) => {
        if (!/^https:\/\//i.test(String(url))) throw new Error('Refusing to open a sign-in page that is not https.');
        return shell.openExternal(String(url));
      },
      loginHint: target?.email || undefined,
      signal: run.signal,
    });
  } catch (err) {
    throw msError(err, "Couldn't sign in to Microsoft. Please try again.");
  } finally {
    if (signInRun === run) signInRun = null;
  }
  const { email, name, refreshToken, grantedScopes, personal } = result || {};
  saveWith(() => store.saveMicrosoftAccount({ id: target?.id, email, name, refreshToken, grantedScopes, personal }));
  const address = String(email).trim().toLowerCase();
  for (const a of settings.accounts) if (a.kind === 'microsoft' && a.email.toLowerCase() === address) needsSignIn.delete(a.id);
  return publicView();
});

handle('microsoft:cancelSignIn', "Couldn't cancel signing in.", () => {
  if (signInRun) signInRun.abort();
});

// Microsoft's page for taking back an old permission: fixed addresses, never one from the window.
handle('microsoft:openConsentPage', "Couldn't open Microsoft's permissions page.", async (_e, accountId) => {
  const account = settings.accounts.find((a) => a.id === accountId && a.kind === 'microsoft');
  if (!account) throw ipcError('That account is no longer in ClearMail. Close Settings and try again.');
  await shell.openExternal(isPersonal(account) ? CONSENT_PAGES.personal : CONSENT_PAGES.work);
});

handle('inbox:load', "Couldn't load your inbox. Please try again.", (_e, options) => loadInbox({ force: options?.force === true }));

// Opens the email in Outlook on the web (its own link, if it is on Outlook's web hosts) or,
// for other accounts, in Mail (message: link by Message-ID). Main builds the address.
handle('email:open', "Couldn't open the email.", async (_e, id) => {
  const entry = loadedEntry(id);
  if (!entry) throw ipcError(EMAIL_GONE);
  if (entry.accountId === DEMO_ACCOUNT) throw ipcError('Sample emails only exist in ClearMail, so there is nothing to open.');
  if (entry.account.kind === 'microsoft') {
    const link = microsoft.safeWebLink(entry.raw.webLink) || (isPersonal(entry.account) ? OUTLOOK_WEB.personal : OUTLOOK_WEB.work);
    await shell.openExternal(link);
    return;
  }
  const messageId = String(entry.raw.messageId || '');
  if (!MESSAGE_ID_RE.test(messageId)) throw ipcError("This email can't be opened in Mail. Find it in your mail app instead.");
  await shell.openExternal(`message://${encodeURIComponent(messageId)}`);
});

// Copies the email's subject, so the user can paste it into Outlook's (or Mail's) search
// and reply there. Only the id comes from the window: the text is always the email's own
// subject, with its spacing tidied as the window shows it.
handle('email:copySubject', "Couldn't copy the subject. Please try again.", (_e, id) => {
  const entry = loadedEntry(id);
  if (!entry) throw ipcError(EMAIL_GONE);
  const subject = String(entry.raw.subject || '').replace(/\s+/g, ' ').trim();
  clipboard.writeText(subject || '(no subject)');
  return { copied: true };
});

handle('link:open', "Couldn't open the link.", async (e, url) => {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return;
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return;
  const options = {
    type: 'question',
    buttons: ['Open', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Open this link?',
    detail: parsed.href,
  };
  const parent = BrowserWindow.fromWebContents(e.sender);
  const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  if (response === 0) await shell.openExternal(parsed.href);
});

// Sorting changes: saved in state.json, then everything loaded is sorted again (no fetching).

handle('triage:setRule', "Couldn't change how that sender is sorted. Please try again.", (_e, payload) => {
  const key = typeof payload?.address === 'string' ? payload.address.trim().toLowerCase() : '';
  const rule = payload?.rule ?? null;
  if (rule !== null && rule !== 'important' && rule !== 'noise') throw ipcError("ClearMail didn't understand that sorting choice. Please try again.");
  if (rule === null) return markWith((next) => { delete next.rules[key]; });
  if (!isValidRuleKey(key)) {
    throw ipcError(key.startsWith('@')
      ? "ClearMail can't make a rule for everyone at a public email service like Gmail or Outlook. Make one for the sender's own address instead."
      : "This sender's address can't be used for a rule.");
  }
  if (!Object.hasOwn(marks.rules, key) && Object.keys(marks.rules).length >= store.STATE_LIMITS.rules) {
    throw ipcError(`You have ${store.STATE_LIMITS.rules} sorting rules, the most ClearMail keeps. Remove some in Settings first.`);
  }
  return markWith((next) => { next.rules[key] = rule; });
});

handle('triage:notNoise', "Couldn't move that email. Please try again.", (_e, payload) => {
  const id = payload?.id;
  if (payload?.on === true) {
    if (!loadedEntry(id)) throw ipcError(EMAIL_GONE);
    return markWith((next) => { next.notNoise[id] = Date.now(); });
  }
  return markWith((next) => { if (typeof id === 'string') delete next.notNoise[id]; });
});

handle('triage:done', "Couldn't change that. Please try again.", (_e, payload) => {
  const ids = [...new Set((Array.isArray(payload?.ids) ? payload.ids : []).filter((id) => typeof id === 'string'))].slice(0, MAX_IDS);
  const on = payload?.on === true;
  return markWith((next) => {
    for (const id of ids) {
      if (!on) delete next.done[id];
      else if (loadedEntry(id) && !Object.hasOwn(next.done, id)) next.done[id] = Date.now();
    }
  });
});

// ClearMail 0.2 kept the Done marks in the window's own storage: they move here, once.
handle('triage:importDone', "Couldn't move your Done emails.", (_e, map) => {
  const now = Date.now();
  let imported = 0;
  markWith((next) => {
    for (const [id, at] of Object.entries(map && typeof map === 'object' && !Array.isArray(map) ? map : {})) {
      if (imported >= MAX_IDS) break;
      if (!store.isEmailId(id) || Object.hasOwn(next.done, id)) continue;
      next.done[id] = Number.isFinite(at) && at > 0 ? Math.min(at, now) : now;
      imported++;
    }
    next.migrated = { ...next.migrated, localDone: now };
  });
  return { imported };
});

// "Send a test brief now": the real notification (so macOS asks for permission while the
// user is looking), without counting as today's brief.
handle('brief:test', "Couldn't send a test brief.", async () => {
  const now = Date.now();
  const window = brief.briefWindow(now, marks.brief);
  let text;
  try {
    const result = inbox.key ? currentView() : await loadInbox();
    const failedAccounts = result.accounts.filter((a) => a.error).map((a) => a.email);
    text = brief.briefText(brief.briefCounts(result.emails, { since: window.since, now }), { failedAccounts, sinceLabel: window.label });
  } catch {
    text = { title: 'Morning brief', body: "This is how ClearMail's morning brief will look." };
  }
  briefRun.lastError = null;
  if (!notify({ ...text, title: 'Morning brief (test)' })) return { ok: false, error: briefRun.lastError };
  return { ok: true };
});

handle('brief:status', "Couldn't read the morning brief settings.", () => briefStatus());

handle('system:openSettings', "Couldn't open System Settings.", async (_e, which) => {
  if (!Object.hasOwn(SYSTEM_SETTINGS, which)) throw ipcError("Couldn't open System Settings.");
  await shell.openExternal(SYSTEM_SETTINGS[which]);
});

// ---------- app ----------

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// One copy at a time, so two windows never overwrite each other's settings.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!app.isReady()) return;
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    store.migrate();
    settings = store.loadSettings();
    // Anything kept for an account that is no longer in Settings is dropped.
    marks = store.loadState({ accountIds: knownAccountIds() });
    histories = store.loadHistory({ accountIds: knownAccountIds() });
    setMenu();
    // Opened at login for the brief: no window until the user asks for one.
    if (!(settings.brief.enabled && settings.brief.openAtLogin && openedAtLogin())) createWindow();
    startScheduler();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });

  app.on('will-quit', () => {
    scheduler?.stop();
    if (signInRun) signInRun.abort(); // closes the sign-in's local web server
  });

  // On macOS ClearMail keeps running with no window, so the morning brief still comes.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
