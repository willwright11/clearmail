const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { clean } = require('./src/cleaner');
const { summarize, heuristicSummary } = require('./src/summarize');
const mail = require('./src/mail');
const store = require('./src/store');
const demoEmails = require('./src/demo');

const FORCE_DEMO = process.argv.includes('--demo');

let win;
let emails = []; // last loaded inbox, keyed lookups by id
let settings = {};

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

  // Never navigate the app window away; send links to the default browser.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function isDemo() {
  return FORCE_DEMO || settings.demo || !settings.user || !settings.pass;
}

function toView(email, summary, cleaned) {
  const { html, text, ...meta } = email;
  return { ...meta, cleaned, summary, original: text || cleaned.body };
}

// Summarise with a small concurrency limit, pushing each result to the UI as it lands.
async function summariseAll(items) {
  const cache = store.cache.get();
  const apiKey = settings.apiKey;
  const queue = items.filter(({ email }) => !(cache[email.id] && cache[email.id].source === 'ai'));
  if (!apiKey || !queue.length) return;

  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const { email, cleaned } = queue.shift();
      const summary = await summarize({ apiKey, email, cleaned });
      if (summary.source === 'ai') cache[email.id] = summary;
      win?.webContents.send('summary:update', { id: email.id, summary });
    }
  });
  await Promise.all(workers);
  store.cache.set(cache);
}

ipcMain.handle('settings:get', () => ({
  ...store.publicSettings(settings),
  demo: isDemo(),
  providers: Object.fromEntries(Object.entries(mail.PROVIDERS).map(([k, v]) => [k, v.label])),
}));

ipcMain.handle('settings:save', (_e, next) => {
  settings = store.saveSettings(next);
  return store.publicSettings(settings);
});

ipcMain.handle('inbox:load', async () => {
  emails = isDemo() ? demoEmails : await mail.fetchInbox(settings, { limit: Number(settings.limit) || 60 });
  const cache = store.cache.get();
  const items = emails.map((email) => {
    const cleaned = clean({ text: email.text, html: email.html, subject: email.subject, from: email.from.address });
    return { email, cleaned, summary: cache[email.id] || heuristicSummary(cleaned, email.subject) };
  });
  summariseAll(items).catch((err) => console.error('summarise failed', err));
  return { demo: isDemo(), aiEnabled: Boolean(settings.apiKey), emails: items.map((i) => toView(i.email, i.summary, i.cleaned)) };
});

ipcMain.handle('email:markSeen', async (_e, id) => {
  const email = emails.find((m) => m.id === id);
  if (!email || isDemo()) return;
  email.seen = true;
  await mail.markSeen(settings, email.uid).catch((err) => console.error('markSeen failed', err));
});

ipcMain.handle('email:reply', async (_e, { id, body }) => {
  const email = emails.find((m) => m.id === id);
  if (!email) throw new Error('Email not found');
  if (isDemo()) return { demo: true };
  await mail.sendReply(settings, email, body);
  return { sent: true };
});

ipcMain.handle('link:open', async (_e, url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Open', 'Cancel'],
    defaultId: 0,
    message: `Open this link?`,
    detail: url,
  });
  if (response === 0) shell.openExternal(url);
});

app.whenReady().then(() => {
  settings = store.loadSettings();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
