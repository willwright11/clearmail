// main.js and preload.js together, under a fake electron: the IPC contract the renderer uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearmail-main-'));
const handlers = new Map();
const listeners = new Map();
const menus = [];
let exposed = null;
let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.webContents = {
      isDestroyed: () => false,
      send: (channel, data) => (listeners.get(channel) || []).forEach((fn) => fn({}, structuredClone(data))),
      setWindowOpenHandler() {},
      on() {},
    };
    FakeWindow.all.push(this);
  }
  loadFile(file) { this.file = file; }
  on() {}
  isDestroyed() { return false; }
  static getAllWindows() { return FakeWindow.all; }
  static fromWebContents() { return null; }
}
FakeWindow.all = [];

const fakeElectron = {
  app: {
    getPath: () => dir,
    whenReady: () => ready,
    isReady: () => true,
    on() {},
    quit() {},
    requestSingleInstanceLock: () => true,
  },
  BrowserWindow: FakeWindow,
  Menu: { buildFromTemplate: (template) => ({ template }), setApplicationMenu: (menu) => menus.push(menu) },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  shell: { openExternal: async () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (buf) => buf.toString().replace(/^enc:/, ''),
  },
  contextBridge: { exposeInMainWorld: (key, api) => { exposed = { key, api }; } },
  // What Electron does with a handler's error: the renderer gets err.toString() behind a prefix.
  ipcRenderer: {
    async invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`No handler registered for '${channel}'`);
      try {
        return await fn({ sender: null }, ...structuredClone(args));
      } catch (err) {
        throw new Error(`Error invoking remote method '${channel}': ${err.toString()}`);
      }
    },
    on: (channel, fn) => listeners.set(channel, [...(listeners.get(channel) || []), fn]),
    removeListener: (channel, fn) => listeners.set(channel, (listeners.get(channel) || []).filter((f) => f !== fn)),
  },
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? fakeElectron : realLoad.call(this, request, ...rest);
};
console.error = () => {}; // main logs every failed IPC call
require('../main');
require('../preload');
readyResolve();

const demo = require('../src/demo');
const api = () => exposed.api;
const message = (err) => err.message.replace(/^Error invoking remote method '[^']+': /, '');

test.before(() => ready.then(() => new Promise((resolve) => setImmediate(resolve))));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('preload exposes the contract API and every channel it uses has a handler', () => {
  assert.strictEqual(exposed.key, 'clearmail');
  assert.deepStrictEqual(Object.keys(api()).sort(), ['getSettings', 'loadInbox', 'markSeen', 'onAiStatus', 'onSummary', 'openLink', 'reply', 'saveSettings']);
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const channels = [...source.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length >= 6);
  for (const channel of channels) assert.ok(handlers.has(channel), `no handler for ${channel}`);
  assert.strictEqual(FakeWindow.all[0].file, path.join(__dirname, '..', 'renderer', 'index.html'));
});

test('the app menu has no Reload, so ⌘R reaches the page (drafts are not thrown away)', () => {
  assert.strictEqual(menus.length, 1);
  const roles = JSON.stringify(menus[0].template);
  assert.ok(!/"role":"(?:reload|forceReload|viewMenu)"/.test(roles), roles);
  assert.match(roles, /"role":"editMenu"/); // copy and paste still work
});

test('first run: public settings have every contract field and demo is active', async () => {
  const s = await api().getSettings();
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'demoActive', 'demoChosen', 'demoReason', 'hasApiKey', 'hasPass', 'imapHost', 'imapPort', 'imapSecurity', 'limit',
    'provider', 'providers', 'secretsLocked', 'smtpHost', 'smtpPort', 'smtpSecurity', 'user',
  ]);
  assert.strictEqual(s.demoChosen, false);
  assert.strictEqual(s.demoActive, true);
  assert.strictEqual(s.demoReason, 'no-account');
  assert.deepStrictEqual(s.providers, { gmail: 'Gmail', icloud: 'iCloud', yahoo: 'Yahoo' });
});

test('demo inbox: every email has the EmailView shape, and the original is the uncleaned text', async () => {
  const res = await api().loadInbox();
  assert.strictEqual(res.demo, true);
  assert.strictEqual(res.demoReason, 'no-account');
  assert.strictEqual(res.aiEnabled, false);
  assert.strictEqual(res.aiError, null);
  assert.strictEqual(res.emails.length, demo.length);
  for (const m of res.emails) {
    assert.deepStrictEqual(Object.keys(m).sort(), ['attachments', 'cleaned', 'date', 'from', 'id', 'messageId', 'original', 'replyTo', 'seen', 'subject', 'summary']);
    assert.strictEqual(m.original, demo.find((d) => d.id === m.id).text);
    assert.ok(Array.isArray(m.cleaned.links) && Array.isArray(m.summary.key_points));
    assert.ok(!('errorKind' in m.summary));
  }
});

test('demo: opened emails stay read after a refresh, and replies are not really sent', async () => {
  const unread = (await api().loadInbox()).emails.filter((m) => !m.seen).map((m) => m.id);
  assert.ok(unread.length > 1);
  assert.strictEqual(await api().markSeen(unread.slice(0, 2)), undefined);
  const again = await api().loadInbox();
  for (const id of unread.slice(0, 2)) assert.strictEqual(again.emails.find((m) => m.id === id).seen, true);
  assert.strictEqual(again.emails.find((m) => m.id === unread[2]).seen, false);
  assert.deepStrictEqual(await api().reply(unread[0], 'Thanks!'), { demo: true });
});

test('errors reach the renderer as plain sentences', async () => {
  await assert.rejects(api().reply('demo-1', '  '), (err) => message(err) === 'Type a reply first.');
  await assert.rejects(api().saveSettings({ provider: 'outlook' }), (err) => message(err) === 'Choose your email provider from the list.');
  await assert.rejects(api().saveSettings({ provider: 'gmail', user: 'someone' }), (err) => message(err) === 'Enter your full email address, like name@example.com.');
});

test('an address without a password is not demo: loading says what is missing', async () => {
  const s = await api().saveSettings({ provider: 'gmail', user: 'me@gmail.com', pass: '', apiKey: '', limit: '', demo: false });
  assert.strictEqual(s.demoActive, false);
  assert.strictEqual(s.demoReason, null);
  await assert.rejects(api().loadInbox(), (err) => message(err) === 'Add your email address and app password in Settings.');
  const chosen = await api().saveSettings({ demo: true });
  assert.strictEqual(chosen.demoReason, 'chosen');
  assert.strictEqual((await api().loadInbox()).demoReason, 'chosen');
});
