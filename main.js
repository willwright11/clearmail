const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const { clean } = require('./src/cleaner');
const { summarize, heuristicSummary, normalizeSummary, originalText } = require('./src/summarize');
const mail = require('./src/mail');
const store = require('./src/store');
const demoEmails = require('./src/demo');

const FORCE_DEMO = process.argv.includes('--demo');
const WORKERS = 4;
const PASS_LOCKED = "ClearMail couldn't unlock your saved app password from the macOS Keychain. Quit and reopen ClearMail and choose Always Allow when asked, or enter the password again in Settings.";
const KEY_LOCKED = "ClearMail couldn't unlock your saved Claude API key from the macOS Keychain. Quit and reopen ClearMail and choose Always Allow when asked, or paste the key again in Settings.";

let win = null;
let settings = {};
// The inbox the UI is showing, with the account it came from, so mark-as-read and
// replies always go to that account even if settings change meanwhile.
let inbox = { account: null, demo: true, emails: new Map() };
let loadGen = 0; // bumped by every inbox load; older loads give way to newer ones
let latestLoad = null;
let summaryRun = 0; // bumped by every summary run; older runs stop taking new work
const inFlight = new Set(); // email ids being summarised right now
let aiProblem = null; // { key, message, sticky }: why AI is off for this key
let summaryCache = {};
let prepared = new Map(); // email id -> cleaned text etc. from the last load
let saveTimer = null;
let seenChain = Promise.resolve();
const demoSeen = new Set(); // demo emails opened this session, so a refresh keeps them read

// Electron sends err.toString() to the renderer; an empty name leaves just the message.
function ipcError(message, cause) {
  const err = new Error(message || 'Something went wrong. Please try again.', cause ? { cause } : undefined);
  err.name = '';
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
  // An address without a password is not demo: loading then says what is missing.
  if (!settings.user) return { active: true, reason: 'no-account' };
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
    ...store.publicSettings(settings),
    demoActive: demo.active,
    demoReason: demo.reason,
    providers: Object.fromEntries(Object.entries(mail.PROVIDERS).map(([k, v]) => [k, v.label])),
  };
}

const accountOf = (s) => ({
  provider: s.provider,
  user: s.user,
  pass: s.pass,
  imapHost: s.imapHost,
  imapPort: s.imapPort,
  imapSecurity: s.imapSecurity,
  smtpHost: s.smtpHost,
  smtpPort: s.smtpPort,
  smtpSecurity: s.smtpSecurity,
});

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
function prepare(email, previous, next) {
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
  return { email, cleaned: done.cleaned, original: done.original, summary: cachedSummary(email.id, done.offline) };
}

function toView({ email, cleaned, original, summary }) {
  const date = new Date(email.date);
  return {
    id: String(email.id),
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

async function loadInbox(gen) {
  if (aiProblem && !aiProblem.sticky) aiProblem = null; // retry account-level failures on refresh
  const demo = demoState();
  const account = accountOf(settings);
  let raw;
  try {
    if (demo.active) raw = demoEmails.map((e) => ({ ...e, seen: e.seen || demoSeen.has(e.id) }));
    else if (settings.locked?.pass && !settings.pass) throw ipcError(PASS_LOCKED);
    else raw = await mail.fetchInbox(account, { limit: settings.limit });
  } catch (err) {
    if (gen !== loadGen) return latestLoad;
    throw err.name === '' ? err : ipcError(err.message, err); // mail.js errors are written for the user
  }
  // A newer load started while this one was downloading: answer with that one instead.
  if (gen !== loadGen) return latestLoad;

  const next = new Map();
  const items = raw.map((email) => prepare(email, prepared, next));
  prepared = next;
  inbox = { account, demo: demo.active, emails: new Map(raw.map((e) => [String(e.id), e])) };
  if (store.cache.prune(summaryCache, new Set(inbox.emails.keys()))) saveCacheSoon();
  startSummaries(items);
  return { demo: demo.active, demoReason: demo.reason, ...aiState(), emails: items.map(toView) };
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
      if (summaryCache[id] || inFlight.has(id)) continue;
      inFlight.add(id);
      try {
        const { errorKind, ...summary } = await summarize({ apiKey, email: item.email, cleaned: item.cleaned, original: item.original });
        if (summary.source === 'ai') remember(id, { summary });
        else if (errorKind === 'permanent') remember(id, { failed: summary.error });
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

handle('settings:get', "Couldn't read your settings.", () => publicView());

handle('settings:save', "Couldn't save your settings. Please try again.", (_e, input) => {
  const before = settings;
  try {
    settings = store.saveSettings(input);
  } catch (err) {
    throw ipcError(err.message, err); // store.js errors are written for the user
  }
  if (settings.apiKey !== before.apiKey) aiProblem = null;
  return publicView();
});

handle('inbox:load', "Couldn't load your inbox. Please try again.", () => {
  const gen = ++loadGen;
  latestLoad = loadInbox(gen);
  return latestLoad;
});

// Mark-as-read runs one batch at a time, so fast browsing never opens a pile of IMAP logins.
function queueMarkSeen(account, uids) {
  const run = seenChain.then(() => mail.markSeen(account, uids));
  seenChain = run.catch(() => {});
  return run;
}

handle('email:markSeen', "Couldn't mark the email as read.", async (_e, ids) => {
  const { account, demo, emails } = inbox;
  const wanted = [...new Set([].concat(ids || []).filter((id) => typeof id === 'string'))];
  const targets = wanted.map((id) => emails.get(id)).filter((m) => m && !m.seen);
  if (!targets.length) return;
  if (!demo) {
    try {
      await queueMarkSeen(account, targets.map((m) => m.uid));
    } catch (err) {
      throw ipcError(err.message, err);
    }
  }
  for (const m of targets) {
    m.seen = true; // only once the server has confirmed it
    if (demo) demoSeen.add(m.id);
  }
});

handle('email:reply', "Couldn't send your reply. Please try again.", async (_e, payload) => {
  const { id, body } = payload || {};
  if (typeof body !== 'string' || !body.trim()) throw ipcError('Type a reply first.');
  const { account, demo, emails } = inbox;
  const email = typeof id === 'string' ? emails.get(id) : null;
  if (!email) throw ipcError('This email is no longer in your inbox. Refresh and try again.');
  if (demo) return { demo: true };
  try {
    await mail.sendReply(account, email, body);
  } catch (err) {
    throw ipcError(err.message, err);
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
    if (saveTimer) saveCacheNow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
