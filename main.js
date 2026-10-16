const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const { clean } = require('./src/cleaner');
const { summarize, heuristicSummary, normalizeSummary, originalText } = require('./src/summarize');
const mail = require('./src/mail');
const microsoft = require('./src/microsoft');
const store = require('./src/store');
const config = require('./src/config');
const demoEmails = require('./src/demo');

const FORCE_DEMO = process.argv.includes('--demo');
const WORKERS = 4;
const DEMO_ACCOUNT = 'demo'; // the accountId of the sample emails
const KEY_LOCKED = "ClearMail couldn't unlock your saved Claude API key from the macOS Keychain. Quit and reopen ClearMail and choose Always Allow when asked, or paste the key again in Settings.";
const NO_CLIENT_ID = 'ClearMail needs a Microsoft app ID (the "Application (client) ID") before it can use Outlook. Add it in Settings. See "Using Outlook" in the README for the 5-minute setup.';
const ACCOUNT_GONE = 'That account has been removed from ClearMail. Refresh to update your chats.';
const passLocked = (user) => `ClearMail couldn't unlock the saved app password for ${user} from the macOS Keychain. Quit and reopen ClearMail and choose Always Allow when asked, or enter the password again in Settings.`;
const signInLocked = (email) => `ClearMail couldn't unlock your saved Microsoft sign-in for ${email} from the macOS Keychain. Quit and reopen ClearMail and choose Always Allow when asked, or click "Sign in again".`;
const signInAgain = (email) => `Microsoft needs you to sign in to ${email} again. Use "Sign in again" to reconnect it.`;

// The error codes src/microsoft.js uses, with wording for when its error has no message.
const MS_ERRORS = {
  'needs-sign-in': 'Microsoft needs you to sign in to this account again. Use "Sign in again" to reconnect it.',
  'admin-approval': "Your organisation (for example your university's IT team) has to approve ClearMail before it can open this mailbox. Ask them to approve it, or forward this mailbox's email to your personal Outlook account instead.",
  'no-client-id': NO_CLIENT_ID,
  cancelled: 'Signing in was cancelled.',
  timeout: 'Signing in took too long, so ClearMail stopped waiting. Please try again.',
  network: "Couldn't reach Microsoft. Check your internet connection and try again.",
  throttled: 'Microsoft is busy right now. Wait a minute and try again.',
  server: 'Microsoft had a problem. Please try again in a few minutes.',
};

let win = null;
let settings = { accounts: [], apiKey: '', limit: 60, demo: false, msClientId: '', locked: {} }; // until the app is ready
// The inbox the UI is showing. Each email remembers the account it came from (as it was
// when loaded), so mark-as-read and replies always go to that account.
let inbox = { demo: true, emails: new Map() };
let loadGen = 0; // bumped by every inbox load; older loads give way to newer ones
let latestLoad = null;
let summaryRun = 0; // bumped by every summary run; older runs stop taking new work
const inFlight = new Set(); // email ids being summarised right now
let aiProblem = null; // { key, message, sticky }: why AI is off for this key
let summaryCache = {};
let prepared = new Map(); // email id -> cleaned text etc. from the last load
let saveTimer = null;
const seenChains = new Map(); // account id -> its mark-as-read queue
const demoSeen = new Set(); // demo emails opened this session, so a refresh keeps them read
const needsSignIn = new Set(); // Microsoft account ids whose last call said to sign in again
let signInRun = null; // AbortController of the Microsoft sign-in waiting in the browser

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
    backgroundColor: '#0b141a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // A closed window must not be used again (on macOS the app keeps running).
  win.on('closed', () => { win = null; });

  // Never navigate the app window away; send links to the default browser.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Electron's default menu binds ⌘R to reloading the page, which would throw away unsent
// drafts and replies still sending. Without it, ⌘R reaches the page and refreshes the inbox.
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

function aiState() {
  if (settings.locked?.apiKey) return { aiEnabled: false, aiError: KEY_LOCKED };
  if (!settings.apiKey) return { aiEnabled: false, aiError: null };
  if (aiProblem && aiProblem.key === settings.apiKey) return { aiEnabled: false, aiError: aiProblem.message };
  return { aiEnabled: true, aiError: null };
}

function publicView() {
  const demo = demoState();
  return {
    ...store.publicSettings(settings, { needsSignIn }),
    demoActive: demo.active,
    demoReason: demo.reason,
    providers: Object.fromEntries(Object.entries(mail.PROVIDERS).map(([k, v]) => [k, v.label])),
    msClientIdBuiltIn: Boolean(config.msClientId),
  };
}

const addressOf = (account) => (account.kind === 'microsoft' ? account.email : account.user) || '';

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

// Options for every src/microsoft.js call made for this account.
function msOptions(account) {
  if (!account.refreshToken) {
    const text = account.locked ? signInLocked(account.email) : signInAgain(account.email);
    throw ipcError(text, null, 'needs-sign-in');
  }
  const id = clientId();
  if (!id) throw ipcError(NO_CLIENT_ID, null, 'no-client-id');
  return { clientId: id, onRefreshToken: (token) => keepRefreshToken(account.id, token) };
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
// need signing in again, so Settings and the chat list can offer the button.
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

// The account to act for: the one the email came from. Its saved details are used (a
// Microsoft sign-in may have been renewed meanwhile), unless an IMAP account was edited
// to point at another mailbox since the load: then the details it was loaded with are.
function accountFor(entry) {
  const current = settings.accounts.find((a) => a.id === entry.accountId);
  if (!current) throw ipcError(ACCOUNT_GONE);
  return store.accountIdentity(current) === store.accountIdentity(entry.account) ? current : entry.account;
}

// ---------- summary cache ----------

function saveCacheNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    store.cache.save(summaryCache);
  } catch (err) {
    console.error('Could not save the summary cache:', err.message);
  }
}

// Written shortly after each change, so quitting or crashing mid-run loses almost nothing.
function saveCacheSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveCacheNow, 1000);
}

function remember(id, entry) {
  summaryCache[id] = { at: Date.now(), ...entry };
  saveCacheSoon();
}

function cachedSummary(id, offline) {
  const entry = summaryCache[id];
  if (entry?.summary) return normalizeSummary({ ...entry.summary, source: 'ai' }, offline);
  if (entry?.failed) return { ...offline, error: entry.failed };
  return offline;
}

// Summaries saved before ClearMail had several accounts are filed under the bare email
// id. Move them under the new id instead of paying for them again.
function adoptOldSummary(id, rawId) {
  const old = summaryCache[rawId];
  if (!old || summaryCache[id] || rawId.includes(':')) return;
  summaryCache[id] = old;
  delete summaryCache[rawId];
  saveCacheSoon();
}

// A removed account's summaries and cleaned text are dropped with it.
function forgetAccount(accountId) {
  const prefix = `${accountId}:`;
  let changed = false;
  for (const id of Object.keys(summaryCache)) {
    if (id.startsWith(prefix)) {
      delete summaryCache[id];
      changed = true;
    }
  }
  if (changed) saveCacheSoon();
  for (const id of [...prepared.keys()]) if (id.startsWith(prefix)) prepared.delete(id);
  for (const id of [...inbox.emails.keys()]) if (id.startsWith(prefix)) inbox.emails.delete(id);
  needsSignIn.delete(accountId);
  seenChains.delete(accountId);
  if (typeof microsoft.forgetAccount === 'function') microsoft.forgetAccount(accountId); // its access token
}

const accountExists = (accountId) => accountId === DEMO_ACCOUNT || settings.accounts.some((a) => a.id === accountId);

// ---------- inbox ----------

function emptyCleaned(original) {
  const n = original.split(/\s+/).filter(Boolean).length;
  return {
    body: original, keyPoints: [], questions: [], actions: [], dates: [], times: [], amounts: [], links: [],
    category: 'person', urgency: 'normal', stats: { rawWords: n, keptWords: n, saved: 0 },
  };
}

// Cleaning is the slow part of a load. An email never changes for its id, so refreshes
// reuse the work (the lengths catch an email that couldn't be read last time).
function prepare(entry, previous, next) {
  const email = { ...entry.raw, id: entry.id, seen: entry.seen };
  const key = `${String(email.text || '').length}:${String(email.html || '').length}`;
  let done = previous.get(email.id);
  if (!done || done.key !== key) {
    const original = originalText(email);
    let cleaned;
    try {
      // original is already the text (or the HTML as text), so clean() needn't convert it again.
      cleaned = clean({ text: original, html: email.html, subject: email.subject, from: email.from?.address || '', bulk: email.bulk });
    } catch (err) {
      // Never lose an email because the cleaner choked on it: show it uncleaned.
      console.error('Could not clean an email:', err);
      cleaned = emptyCleaned(original);
    }
    done = { key, cleaned, original, offline: heuristicSummary(cleaned, email.subject, original) };
  }
  next.set(email.id, done);
  adoptOldSummary(email.id, String(entry.raw.id));
  return { entry, email, cleaned: done.cleaned, original: done.original, summary: cachedSummary(email.id, done.offline) };
}

function toView({ entry, email, cleaned, original, summary }) {
  const date = new Date(email.date);
  return {
    id: entry.id,
    accountId: entry.accountId,
    accountEmail: entry.accountEmail,
    messageId: email.messageId || null,
    from: { name: String(email.from?.name || email.from?.address || 'Unknown sender'), address: String(email.from?.address || '') },
    replyTo: email.replyTo?.address ? { name: String(email.replyTo.name || email.replyTo.address), address: String(email.replyTo.address) } : null,
    subject: String(email.subject || ''),
    date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    seen: Boolean(email.seen),
    attachments: (email.attachments || []).map((a) => ({ filename: String(a.filename || 'attachment'), size: Number(a.size) || 0 })),
    cleaned,
    summary,
    original,
  };
}

// An IMAP account whose password the Keychain won't unlock says so, instead of "add a password".
function imapReady(account) {
  if (account.locked && !account.pass) throw ipcError(passLocked(account.user));
  return account;
}

function fetchAccount(account, limit) {
  if (account.kind === 'imap') return mail.fetchInbox(imapReady(account), { limit });
  return microsoft.fetchInbox(account, { ...msOptions(account), limit });
}

// Never rejects: one account failing must not hide the others.
async function loadAccount(account, limit) {
  try {
    const raw = await fetchAccount(account, limit);
    signedIn(account);
    return { account, raw: Array.isArray(raw) ? raw : [], error: null };
  } catch (err) {
    const error = accountError(account, err, "Couldn't load this account. Please try again.");
    console.warn(`Couldn't load a ${account.kind} account:`, error.message);
    return { account, raw: [], error: error.message };
  }
}

async function loadInbox(gen) {
  if (aiProblem && !aiProblem.sticky) aiProblem = null; // retry account-level failures on refresh
  const demo = demoState();
  let results;
  if (demo.active) {
    const raw = demoEmails.map((e) => ({ ...e, seen: e.seen || demoSeen.has(e.id) }));
    results = [{ account: { id: DEMO_ACCOUNT, kind: 'demo' }, raw, error: null }];
  } else {
    const limit = settings.limit;
    results = await Promise.all(settings.accounts.map((account) => loadAccount(account, limit)));
  }
  // A newer load started while this one was downloading: answer with that one instead.
  if (gen !== loadGen) return latestLoad;
  // An account removed while it was loading is left out.
  results = results.filter((r) => accountExists(r.account.id));
  if (!demo.active && results.length && results.every((r) => r.error)) {
    if (results.length === 1) throw ipcError(results[0].error);
    throw ipcError(`ClearMail couldn't load any of your accounts. ${results.map((r) => `${addressOf(r.account)}: ${r.error}`).join(' ')}`);
  }

  const entries = new Map();
  for (const { account, raw } of results) {
    for (const email of raw) {
      if (!email || email.id == null) continue;
      // Prefixed with the account, so ids are unique across accounts and stable across refreshes.
      const id = `${account.id}:${email.id}`;
      if (entries.has(id)) continue;
      const accountEmail = account.kind === 'demo' ? '' : addressOf(account);
      entries.set(id, { id, accountId: account.id, accountEmail, account, raw: email, seen: Boolean(email.seen) });
    }
  }
  // Oldest first across all accounts (the sort is stable, so ties keep each account's order).
  const time = (entry) => {
    const t = new Date(entry.raw.date).getTime();
    return Number.isNaN(t) ? Date.now() : t;
  };
  const list = [...entries.values()].sort((a, b) => time(a) - time(b));

  const next = new Map();
  const items = list.map((entry) => prepare(entry, prepared, next));
  prepared = next;
  inbox = { demo: demo.active, emails: new Map(list.map((entry) => [entry.id, entry])) };
  if (store.cache.prune(summaryCache, new Set(inbox.emails.keys()))) saveCacheSoon();
  startSummaries(items);
  return {
    demo: demo.active,
    demoReason: demo.reason,
    ...aiState(),
    accounts: demo.active ? [] : results.map(({ account, error }) => ({
      id: account.id,
      email: addressOf(account),
      kind: account.kind,
      error,
      needsSignIn: account.kind === 'microsoft' && needsSignIn.has(account.id),
    })),
    emails: items.map(toView),
  };
}

// ---------- AI summaries ----------

// Summarises with a small concurrency limit, pushing each result to the UI as it lands
// and caching it straight away. A newer run (or a new key) makes this one stop taking work.
function startSummaries(items) {
  const run = ++summaryRun;
  const apiKey = settings.apiKey;
  if (!aiState().aiEnabled) return;
  const queue = items.filter(({ email }) => !summaryCache[email.id] && !inFlight.has(email.id));
  const current = () => run === summaryRun && settings.apiKey === apiKey && aiState().aiEnabled;

  const worker = async () => {
    while (queue.length && current()) {
      const item = queue.shift();
      const id = item.email.id;
      if (summaryCache[id] || inFlight.has(id) || !accountExists(item.entry.accountId)) continue;
      inFlight.add(id);
      try {
        const { errorKind, ...summary } = await summarize({ apiKey, email: item.email, cleaned: item.cleaned, original: item.original });
        const keep = accountExists(item.entry.accountId); // not if its account was removed meanwhile
        if (keep && summary.source === 'ai') remember(id, { summary });
        else if (keep && errorKind === 'permanent') remember(id, { failed: summary.error });
        send('summary:update', { id, summary });
        if (errorKind === 'auth' || errorKind === 'account') {
          queue.length = 0;
          if (settings.apiKey === apiKey && aiProblem?.key !== apiKey) {
            // Several workers can hit the same rejected key; tell the UI once.
            aiProblem = { key: apiKey, message: summary.error, sticky: errorKind === 'auth' };
            send('ai:status', aiState());
          }
        } else if (errorKind === 'busy') {
          queue.length = 0; // no point hammering; the next refresh tries again
        }
      } catch (err) {
        console.error('Summary failed:', err);
      } finally {
        inFlight.delete(id);
      }
    }
  };
  Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker)).catch((err) => console.error('Summaries failed:', err));
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

handle('settings:get', "Couldn't read your settings.", () => publicView());

handle('settings:save', "Couldn't save your settings. Please try again.", (_e, input) => {
  const before = settings;
  const view = saveWith(() => store.saveSettings(input));
  if (settings.apiKey !== before.apiKey) aiProblem = null;
  return view;
});

handle('account:save', "Couldn't save the account. Please try again.", (_e, input) => saveWith(() => store.saveAccount(input)));

handle('account:remove', "Couldn't remove the account. Please try again.", (_e, id) => {
  if (typeof id !== 'string' || !id) throw ipcError("Couldn't remove the account. Please try again.");
  const view = saveWith(() => store.removeAccount(id));
  forgetAccount(id);
  return view;
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
  const { email, name, refreshToken } = result || {};
  saveWith(() => store.saveMicrosoftAccount({ id: target?.id, email, name, refreshToken }));
  const address = String(email).trim().toLowerCase();
  for (const a of settings.accounts) if (a.kind === 'microsoft' && a.email.toLowerCase() === address) needsSignIn.delete(a.id);
  return publicView();
});

handle('microsoft:cancelSignIn', "Couldn't cancel signing in.", () => {
  if (signInRun) signInRun.abort();
});

handle('inbox:load', "Couldn't load your inbox. Please try again.", () => {
  const gen = ++loadGen;
  latestLoad = loadInbox(gen);
  return latestLoad;
});

// Mark-as-read runs one batch at a time per account, so fast browsing never opens a pile
// of IMAP logins or Microsoft requests.
function queueFor(accountId, fn) {
  const run = (seenChains.get(accountId) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  seenChains.set(accountId, tail);
  tail.then(() => {
    if (seenChains.get(accountId) === tail) seenChains.delete(accountId);
  });
  return run;
}

async function markAccountSeen(list) {
  const account = accountFor(list[0]);
  try {
    if (account.kind === 'imap') {
      await queueFor(account.id, () => mail.markSeen(imapReady(account), list.map((m) => m.raw.uid)));
    } else {
      await queueFor(account.id, () => microsoft.markSeen(account, list.map((m) => m.raw.id), msOptions(account)));
      signedIn(account);
    }
  } catch (err) {
    throw accountError(account, err, "Couldn't mark the email as read.");
  }
  for (const m of list) m.seen = true; // only once the server has confirmed it
}

handle('email:markSeen', "Couldn't mark the email as read.", async (_e, ids) => {
  const { demo, emails } = inbox;
  const wanted = [...new Set([].concat(ids || []).filter((id) => typeof id === 'string'))];
  const targets = wanted.map((id) => emails.get(id)).filter((m) => m && !m.seen);
  if (!targets.length) return;
  if (demo) {
    for (const m of targets) {
      m.seen = true;
      demoSeen.add(m.raw.id);
    }
    return;
  }
  // Each account's emails go to that account's server, all at once.
  const byAccount = new Map();
  for (const m of targets) byAccount.set(m.accountId, [...(byAccount.get(m.accountId) || []), m]);
  const results = await Promise.allSettled([...byAccount.values()].map(markAccountSeen));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
});

handle('email:reply', "Couldn't send your reply. Please try again.", async (_e, payload) => {
  const { id, body } = payload || {};
  if (typeof body !== 'string' || !body.trim()) throw ipcError('Type a reply first.');
  const { demo, emails } = inbox;
  const entry = typeof id === 'string' ? emails.get(id) : null;
  if (!entry) throw ipcError('This email is no longer in your inbox. Refresh and try again.');
  if (demo) return { demo: true };
  // Sent from the account that received the email.
  const account = accountFor(entry);
  try {
    if (account.kind === 'imap') {
      await mail.sendReply(imapReady(account), entry.raw, body);
    } else {
      await microsoft.sendReply(account, entry.raw, body, msOptions(account));
      signedIn(account);
    }
  } catch (err) {
    throw accountError(account, err, "Couldn't send your reply. Please try again.");
  }
  return { sent: true };
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

// ---------- app ----------

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// One copy at a time, so two windows never overwrite each other's settings or cache.
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
    settings = store.loadSettings();
    summaryCache = store.cache.load();
    setMenu();
    createWindow();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });

  app.on('will-quit', () => {
    if (signInRun) signInRun.abort(); // closes the sign-in's local web server
    if (saveTimer) saveCacheNow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
