// main.js and preload.js together, under a fake electron: the IPC contract the renderer uses.
// The IMAP and Microsoft backends are stubbed so each test decides what the servers answer.
process.env.TZ = 'Europe/London';
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearmail-main-'));
const handlers = new Map();
const listeners = new Map();
const menus = [];
const opened = []; // URLs given to shell.openExternal
const keychain = { denyDecrypt: false };
const notifications = []; // every Notification shown
const appEvents = new EventEmitter();
const loginItems = { set: [], status: 'requires-approval', wasOpenedAtLogin: false };
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
  show() { this.shown = (this.shown || 0) + 1; }
  isMinimized() { return false; }
  isDestroyed() { return false; }
  static getAllWindows() { return FakeWindow.all; }
  static fromWebContents() { return null; }
}
FakeWindow.all = [];

class FakeNotification extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
  }
  static isSupported() { return true; }
  show() { notifications.push(this); }
}

const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' });

const fakeElectron = {
  app: {
    getPath: () => dir,
    whenReady: () => ready,
    isReady: () => true,
    on: (event, fn) => appEvents.on(event, fn),
    quit() {},
    focus() {},
    requestSingleInstanceLock: () => true,
    getLocale: () => 'en-GB',
    setLoginItemSettings: (s) => loginItems.set.push(s),
    getLoginItemSettings: () => ({ openAtLogin: true, status: loginItems.status, wasOpenedAtLogin: loginItems.wasOpenedAtLogin }),
  },
  BrowserWindow: FakeWindow,
  Menu: { buildFromTemplate: (template) => ({ template }), setApplicationMenu: (menu) => menus.push(menu) },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  shell: { openExternal: async (url) => { opened.push(url); } },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  Notification: FakeNotification,
  powerMonitor,
  net: { isOnline: () => true },
  nativeTheme: { shouldUseDarkColors: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (buf) => {
      if (keychain.denyDecrypt) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return buf.toString().replace(/^enc:/, '');
    },
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

// Backends: each call is recorded, then answered by the function the test put in place.
const calls = [];
const realMail = require('../src/mail');
const realMicrosoft = require('../src/microsoft');
const imap = {};
const ms = {};
const msErr = (code, message) => Object.assign(new Error(message), { code });
const emptySent = (kind) => ({ cursor: kind === 'imap' ? { kind, path: 'Sent', uidValidity: '1', lastUid: 0, fullAt: Date.now() } : { kind, since: null, fullAt: Date.now() }, full: true, entries: [] });
function resetBackends() {
  for (const fn of ['signIn', 'fetchInbox', 'sendReply']) ms[fn] = async () => { throw msErr('server', `${fn} was not expected`); };
  ms.fetchSentHistory = async () => emptySent('graph');
  for (const fn of ['fetchInbox', 'sendReply']) imap[fn] = async () => { throw new Error(`${fn} was not expected`); };
  imap.fetchSentHistory = async () => emptySent('imap');
}
resetBackends();
const record = (name, impl) => (...args) => {
  calls.push([name, ...args]);
  return impl()(...args);
};
const fakeMail = {
  PROVIDERS: realMail.PROVIDERS,
  fetchInbox: record('imap.fetchInbox', () => imap.fetchInbox),
  fetchSentHistory: record('imap.fetchSentHistory', () => imap.fetchSentHistory),
  sendReply: record('imap.sendReply', () => imap.sendReply),
};
const forgotten = [];
const fakeMicrosoft = {
  SCOPES: realMicrosoft.SCOPES,
  safeWebLink: realMicrosoft.safeWebLink,
  grantsMailboxChanges: realMicrosoft.grantsMailboxChanges,
  signIn: record('ms.signIn', () => ms.signIn),
  fetchInbox: record('ms.fetchInbox', () => ms.fetchInbox),
  fetchSentHistory: record('ms.fetchSentHistory', () => ms.fetchSentHistory),
  sendReply: record('ms.sendReply', () => ms.sendReply),
  forgetAccount: (id) => forgotten.push(id),
};
const fakeConfig = { msClientId: '' };
const callsOf = (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const pushes = []; // [channel, data] for every push the window got
for (const channel of ['reply:result', 'inbox:updated', 'brief:show']) listeners.set(channel, [(_e, data) => pushes.push([channel, data])]);
const pushesOf = (channel) => pushes.filter((p) => p[0] === channel).map((p) => p[1]);

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  // What main.js requires; store.js keeps the real mail.js and config.js.
  if (request === './src/mail') return fakeMail;
  if (request === './src/microsoft') return fakeMicrosoft;
  if (request === './src/config') return fakeConfig;
  return realLoad.call(this, request, ...rest);
};
console.error = () => {}; // main logs every failed IPC call
console.warn = () => {};
// Left over from ClearMail 0.2: the AI summary cache is deleted at startup.
fs.writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify({ 'demo-2': { at: 1, summary: { gist: 'Cached by AI' } } }));
require('../main');
require('../preload');
readyResolve();

const demo = require('../src/demo');
const api = () => exposed.api;
const message = (err) => err.message.replace(/^Error invoking remote method '[^']+': /, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const BUILT_IN_ID = '11111111-2222-3333-4444-555555555555';
const OWN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OUTLOOK = 'willw6311@outlook.com';
const UNI = 'cvww@lunet.lboro.ac.uk';
const SCOPES = ['Mail.Read', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile'];

function rawEmail(id, extra = {}) {
  const date = extra.date || hoursAgo(1);
  return {
    id, messageId: `<${id}@example.com>`, uid: null, from: { name: 'Ann', address: 'ann@example.com' }, replyTo: null,
    to: [], cc: [], subject: `About ${id}`, date, receivedAt: date, text: `Hello, this is ${id}.`, html: '', seen: false, flagged: false,
    references: [], attachments: [], headers: null, importance: 'normal', focused: null, conversationId: null, inReplyTo: null, webLink: null,
    ...extra,
  };
}

const EMAIL_VIEW = ['accountEmail', 'accountId', 'attachments', 'canOpen', 'cleanedBody', 'date', 'done', 'from', 'id', 'isNew', 'links', 'notNoise',
  'original', 'receivedAt', 'replyTo', 'seen', 'senderRule', 'subject', 'summary', 'triage'];
const ids = (res) => res.emails.map((m) => m.id);
const find = (res, id) => res.emails.find((m) => m.id === id);

let gmailId = null;
let outlookId = null;

test.before(() => ready.then(tick));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('preload exposes exactly the contract API, and every channel it uses has a handler', () => {
  assert.strictEqual(exposed.key, 'clearmail');
  assert.deepStrictEqual(Object.keys(api()).sort(), [
    'briefStatus', 'cancelSignIn', 'getSettings', 'importDone', 'loadInbox', 'onBriefShow', 'onInboxUpdated', 'onReplyResult', 'openConsentPage',
    'openEmail', 'openLink', 'openSystemSettings', 'removeAccount', 'reply', 'saveAccount', 'saveSettings', 'setDone', 'setNotNoise', 'setRule',
    'signInMicrosoft', 'testBrief', 'undoReply',
  ]);
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const channels = [...source.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(channels.length, 19);
  for (const channel of channels) assert.ok(handlers.has(channel), `no handler for ${channel}`);
  assert.deepStrictEqual([...handlers.keys()].sort(), [...new Set(channels)].sort(), 'no handler the window cannot reach');
  assert.ok(!handlers.has('email:markSeen'));
  assert.strictEqual(FakeWindow.all[0].file, path.join(__dirname, '..', 'renderer', 'index.html'));
  const prefs = FakeWindow.all[0].options.webPreferences;
  assert.deepStrictEqual([prefs.contextIsolation, prefs.nodeIntegration, prefs.sandbox], [true, false, true]);
});

test('the app menu has no Reload, so ⌘R reaches the page (drafts are not thrown away)', () => {
  assert.strictEqual(menus.length, 1);
  const roles = JSON.stringify(menus[0].template);
  assert.ok(!/"role":"(?:reload|forceReload|viewMenu)"/.test(roles), roles);
  assert.match(roles, /"role":"editMenu"/); // copy and paste still work
});

test('first run: the 0.2 AI cache is gone, public settings have every contract field, and demo is active', async () => {
  assert.ok(!fs.existsSync(path.join(dir, 'summaries.json')), 'summaries.json was deleted');
  const s = await api().getSettings();
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'accounts', 'brief', 'canSee', 'demoActive', 'demoChosen', 'demoReason', 'limit', 'msClientId', 'msClientIdBuiltIn', 'providers', 'rules', 'secretsLocked',
  ]);
  assert.deepStrictEqual(s.accounts, []);
  assert.deepStrictEqual([s.demoChosen, s.demoActive, s.demoReason], [false, true, 'no-account']);
  assert.deepStrictEqual(s.brief, { enabled: false, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], openAtLogin: false });
  assert.deepStrictEqual([s.rules, s.canSee, s.msClientId, s.msClientIdBuiltIn], [{}, null, '', false]);
  assert.deepStrictEqual(s.providers, { gmail: 'Gmail', icloud: 'iCloud', yahoo: 'Yahoo' });
  assert.ok(!('hasApiKey' in s));
});

test('demo inbox: a BriefView sorted into Needs you, Worth knowing and Noise, with the uncleaned original', async () => {
  const res = await api().loadInbox();
  assert.deepStrictEqual(Object.keys(res).sort(), ['accounts', 'counts', 'demo', 'demoReason', 'emails', 'generatedAt', 'since', 'sinceLabel']);
  assert.deepStrictEqual([res.demo, res.demoReason, res.accounts], [true, 'no-account', []]);
  assert.strictEqual(res.sinceLabel, 'in the last 24 hours');
  assert.strictEqual(res.emails.length, demo.length);
  const byBucket = { 'needs-you': [], 'worth-knowing': [], noise: [] };
  for (const m of res.emails) {
    assert.deepStrictEqual(Object.keys(m).sort(), EMAIL_VIEW);
    assert.deepStrictEqual([m.accountId, m.accountEmail, m.done, m.notNoise, m.senderRule, m.canOpen], ['demo', '', false, false, null, false]);
    // The sample emails are built for the time of the load, so their times may differ by a minute.
    const digitless = (text) => text.replace(/\d+/g, '#');
    assert.strictEqual(digitless(m.original), digitless(demo.find((d) => `demo:${d.id}` === m.id).text));
    assert.ok(Array.isArray(m.links) && typeof m.cleanedBody === 'string');
    assert.deepStrictEqual(Object.keys(m.summary).sort(), ['action_items', 'amounts', 'category', 'dates', 'gist', 'key_points', 'questions', 'urgency', 'words']);
    assert.deepStrictEqual(Object.keys(m.triage).sort(), ['bucket', 'caution', 'codes', 'deadline', 'reasons']);
    byBucket[m.triage.bucket].push(Number(m.id.split('-')[1]));
  }
  assert.deepStrictEqual(byBucket['needs-you'].sort((a, b) => a - b), [2, 3, 7, 8, 13, 15]);
  assert.deepStrictEqual(byBucket['worth-knowing'].sort((a, b) => a - b), [1, 4, 5, 14]);
  assert.deepStrictEqual(byBucket.noise.sort((a, b) => a - b), [6, 9, 10, 11, 12, 16, 17]);
  // Display order: the buckets one after another, Needs you by deadline (overdue and soonest first).
  const buckets = res.emails.map((m) => m.triage.bucket);
  assert.deepStrictEqual(buckets, [...buckets].sort((a, b) => ['needs-you', 'worth-knowing', 'noise'].indexOf(a) - ['needs-you', 'worth-knowing', 'noise'].indexOf(b)));
  const away = res.emails.filter((m) => m.triage.bucket === 'needs-you').map((m) => m.triage.deadline?.daysAway ?? Infinity);
  assert.deepStrictEqual(away, [...away].sort((a, b) => a - b));
  assert.match(find(res, 'demo:demo-1').triage.reasons[0], /already replied/);
  assert.match(find(res, 'demo:demo-2').triage.reasons.join(' '), /written to them 6 times/);
  assert.strictEqual(res.counts.needsYou, 6);
  assert.strictEqual(calls.length, 0, 'demo mode never reaches a server');
});

test('demo: a reply is held for 5 seconds, then "sent" without reaching a server, and the email moves to Done', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queued = await api().reply('demo:demo-3', 'Yes, see you Sunday!');
  assert.strictEqual(queued.queued, true);
  assert.ok(Math.abs(queued.sendAt - (Date.now() + 5000)) < 1000);
  t.mock.timers.tick(4999);
  await settle();
  assert.deepStrictEqual(pushesOf('reply:result'), []);
  t.mock.timers.tick(1);
  await settle();
  assert.deepStrictEqual(pushesOf('reply:result'), [{ id: 'demo:demo-3', ok: true, demo: true }]);
  const updated = pushesOf('inbox:updated').at(-1);
  assert.strictEqual(find(updated, 'demo:demo-3').done, true);
  assert.strictEqual(updated.emails.at(-1).id, 'demo:demo-3', 'Done comes last');
  assert.strictEqual(calls.length, 0, 'demo mode never reaches a server');
  // Undo done: it comes back with "You've already replied".
  const back = await api().setDone(['demo:demo-3'], false);
  assert.deepStrictEqual([find(back, 'demo:demo-3').done, find(back, 'demo:demo-3').triage.codes[0]], [false, 'replied']);
  pushes.length = 0;
});

test('errors reach the renderer as plain sentences', async () => {
  await assert.rejects(api().reply('demo:demo-1', '  '), (err) => message(err) === 'Type a reply first.');
  await assert.rejects(api().reply('demo:nope', 'Hi'), (err) => message(err) === 'This email is no longer in your inbox. Refresh and try again.');
  await assert.rejects(api().reply('demo:demo-1', 'x'.repeat(100001)), (err) => /too long/.test(message(err)));
  await assert.rejects(api().saveAccount({ provider: 'outlook', user: 'a@b.com' }), (err) => message(err) === 'Choose your email provider from the list.');
  await assert.rejects(api().saveAccount({ provider: 'gmail', user: 'someone' }), (err) => message(err) === 'Enter your full email address, like name@example.com.');
  await assert.rejects(api().saveSettings({ msClientId: 'my app' }), (err) => /^That doesn't look like an Application \(client\) ID\./.test(message(err)));
  await assert.rejects(api().saveSettings({ brief: { time: '7.30' } }), (err) => message(err) === 'Choose a time for the morning brief, like 07:30.');
  await assert.rejects(api().saveSettings({ brief: { enabled: true, days: [] } }), (err) => /at least one day/.test(message(err)));
  await assert.rejects(api().removeAccount(42), (err) => message(err) === "Couldn't remove the account. Please try again.");
  await assert.rejects(api().setRule('@gmail.com', 'noise'), (err) => /public email service/.test(message(err)));
  await assert.rejects(api().setRule('ann@example.com', 'delete'), (err) => /didn't understand/.test(message(err)));
  await assert.rejects(api().openSystemSettings('file:///etc'), (err) => message(err) === "Couldn't open System Settings.");
  await assert.rejects(api().openEmail('demo:demo-1'), (err) => /Sample emails only exist in ClearMail/.test(message(err)));
  assert.deepStrictEqual(opened, []);
});

test('an account without a password is not demo: loading says what is missing', async () => {
  imap.fetchInbox = realMail.fetchInbox; // its own check, before connecting anywhere
  const s = await api().saveAccount({ provider: 'gmail', user: 'me@gmail.com', pass: '' });
  assert.deepStrictEqual([s.demoActive, s.demoReason, s.accounts.length], [false, null, 1]);
  assert.deepStrictEqual([s.accounts[0].kind, s.accounts[0].email, s.accounts[0].hasPass], ['imap', 'me@gmail.com', false]);
  gmailId = s.accounts[0].id;
  await assert.rejects(api().loadInbox(), (err) => message(err) === 'Add your email address and app password in Settings.');
  assert.strictEqual(callsOf('imap.fetchInbox').length, 1, 'the real check happens in mail.js');
  const chosen = await api().saveSettings({ demo: true });
  assert.strictEqual(chosen.demoReason, 'chosen');
  assert.strictEqual((await api().loadInbox()).demoReason, 'chosen');
  assert.strictEqual((await api().saveSettings({ demo: false })).demoActive, false);
  assert.strictEqual((await api().saveAccount({ id: gmailId, pass: 'app-pw' })).accounts[0].hasPass, true);
});

test('Microsoft sign-in needs an app ID: built in, or typed in Settings (which wins)', async () => {
  await assert.rejects(api().signInMicrosoft(), (err) => /needs a Microsoft app ID/.test(message(err)) && /Using Outlook/.test(message(err)));
  assert.strictEqual(callsOf('ms.signIn').length, 0);

  fakeConfig.msClientId = BUILT_IN_ID;
  assert.strictEqual((await api().getSettings()).msClientIdBuiltIn, true);
  const own = await api().saveSettings({ msClientId: OWN_ID });
  assert.strictEqual(own.msClientId, OWN_ID);
  ms.signIn = async () => { throw msErr('cancelled', 'Signing in to Microsoft was cancelled.'); };
  await assert.rejects(api().signInMicrosoft(), (err) => message(err) === 'Signing in to Microsoft was cancelled.');
  assert.strictEqual(callsOf('ms.signIn').at(-1)[0].clientId, OWN_ID);
  assert.strictEqual((await api().saveSettings({ msClientId: '' })).msClientId, '');
});

test('signing in adds a Microsoft account that can read and reply; the browser only ever opens an https page', async () => {
  ms.signIn = async (opts) => {
    await opts.openUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x');
    return { email: OUTLOOK, name: 'Will', refreshToken: 'rt-outlook-1', grantedScopes: SCOPES, personal: true };
  };
  const s = await api().signInMicrosoft();
  const [opts] = callsOf('ms.signIn').at(-1);
  assert.strictEqual(opts.clientId, BUILT_IN_ID);
  assert.strictEqual(opts.loginHint, undefined);
  assert.ok(opts.signal instanceof AbortSignal);
  assert.deepStrictEqual(opened, ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x']);
  const account = s.accounts.find((a) => a.kind === 'microsoft');
  assert.deepStrictEqual(
    [account.email, account.name, account.provider, account.signedIn, account.needsSignIn, account.upgrade, account.personal, account.grantedScopes],
    [OUTLOOK, 'Will', 'microsoft', true, false, null, true, SCOPES],
  );
  assert.ok(!JSON.stringify(s).includes('rt-outlook-1'));
  const disk = readJson('settings.json');
  assert.deepStrictEqual([disk.version, disk.accounts[1].grant], [3, 'read+reply']);
  outlookId = account.id;

  let refused = null;
  ms.signIn = async (o) => {
    try {
      await o.openUrl('file:///etc/passwd');
    } catch (err) {
      refused = err;
    }
    throw msErr('server', "ClearMail couldn't open your web browser to sign in to Microsoft.");
  };
  await assert.rejects(api().signInMicrosoft(), (err) => message(err) === "ClearMail couldn't open your web browser to sign in to Microsoft.");
  assert.ok(refused);
  assert.strictEqual(opened.length, 1);
});

test('one sign-in at a time, and Cancel stops it', async () => {
  ms.signIn = (opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(msErr('cancelled', 'Signing in to Microsoft was cancelled.')));
  });
  const first = api().signInMicrosoft();
  await tick();
  await assert.rejects(api().signInMicrosoft(), (err) => /already waiting for you to sign in/.test(message(err)));
  assert.strictEqual(await api().cancelSignIn(), undefined);
  await assert.rejects(first, (err) => message(err) === 'Signing in to Microsoft was cancelled.');
  assert.strictEqual(await api().cancelSignIn(), undefined, 'cancelling with nothing to cancel is fine');
});

test('sign-in failures are plain sentences; unexpected errors get a fallback', async () => {
  const admin = "Your organisation (for example your university's IT team) has to approve ClearMail before it can read this mailbox.";
  for (const [thrown, expected] of [
    [msErr('admin-approval', admin), admin],
    [msErr('timeout', ''), 'Signing in took too long, so ClearMail stopped waiting. Please try again.'],
    [new TypeError("Cannot read properties of undefined (reading 'x')"), "Couldn't sign in to Microsoft. Please try again."],
  ]) {
    ms.signIn = async () => { throw thrown; };
    await assert.rejects(api().signInMicrosoft(), (err) => message(err) === expected);
  }
  ms.signIn = async () => ({ email: '', refreshToken: 'x' });
  await assert.rejects(api().signInMicrosoft(), (err) => /didn't tell ClearMail the email address/.test(message(err)));
  assert.strictEqual((await api().getSettings()).accounts.length, 2);
});

test('two accounts: one failing never hides the other, and both Sent folders are read', async () => {
  imap.fetchInbox = async () => [rawEmail('fp-1-7', { uid: 7, date: hoursAgo(5) })];
  ms.fetchInbox = async () => { throw msErr('needs-sign-in', 'Microsoft needs you to sign in to this account again.'); };
  let res = await api().loadInbox({ force: true });
  assert.strictEqual(res.demo, false);
  assert.deepStrictEqual(ids(res), [`${gmailId}:fp-1-7`]);
  assert.deepStrictEqual(res.accounts, [
    { id: gmailId, email: 'me@gmail.com', kind: 'imap', error: null, needsSignIn: false, readOnly: true },
    { id: outlookId, email: OUTLOOK, kind: 'microsoft', error: `Microsoft needs you to sign in to ${OUTLOOK} again. Use "Sign in again" to reconnect it.`, needsSignIn: true, readOnly: true },
  ]);
  assert.strictEqual((await api().getSettings()).accounts[1].needsSignIn, true);
  const [account, opts] = callsOf('ms.fetchInbox').at(-1);
  assert.deepStrictEqual([account.id, account.email, account.refreshToken], [outlookId, OUTLOOK, 'rt-outlook-1']);
  assert.deepStrictEqual([opts.clientId, opts.limit, typeof opts.onRefreshToken, typeof opts.onGrantedScopes], [BUILT_IN_ID, 60, 'function', 'function']);
  assert.strictEqual(callsOf('imap.fetchInbox').at(-1)[1].limit, 60);
  assert.deepStrictEqual(callsOf('imap.fetchSentHistory').at(-1).map((a) => a?.user ?? a), ['me@gmail.com', null], 'first sync: no cursor');

  imap.fetchInbox = async () => { throw new Error('Your email provider rejected the login. Check your email address and app password in Settings.'); };
  ms.fetchInbox = async () => [rawEmail('AAMkAD=', { date: hoursAgo(2) })];
  res = await api().loadInbox({ force: true });
  // The Gmail account keeps the email it showed last time, as a failed refresh of one account does.
  assert.deepStrictEqual(res.emails.map((m) => [m.id, m.accountId, m.accountEmail]).sort(), [
    [`${gmailId}:fp-1-7`, gmailId, 'me@gmail.com'],
    [`${outlookId}:AAMkAD=`, outlookId, OUTLOOK],
  ].sort());
  assert.match(res.accounts[0].error, /rejected the login/);
  assert.deepStrictEqual([res.accounts[1].error, res.accounts[1].needsSignIn], [null, false]);
  assert.strictEqual((await api().getSettings()).accounts[1].needsSignIn, false);
  // Not once the account points at another mailbox: those emails aren't its emails.
  await api().saveAccount({ id: gmailId, user: 'other@gmail.com' });
  res = await api().loadInbox();
  assert.deepStrictEqual(ids(res), [`${outlookId}:AAMkAD=`]);
  await api().saveAccount({ id: gmailId, user: 'me@gmail.com', pass: 'app-pw' });

  ms.fetchInbox = async () => { throw msErr('network', "Couldn't reach Microsoft. Check your internet connection and try again."); };
  await assert.rejects(api().loadInbox({ force: true }), (err) => message(err) === "ClearMail couldn't load any of your accounts. "
    + 'me@gmail.com: Your email provider rejected the login. Check your email address and app password in Settings. '
    + `${OUTLOOK}: Couldn't reach Microsoft. Check your internet connection and try again.`);
});

test('a load less than a minute old is reused; Refresh (force) fetches again', async () => {
  imap.fetchInbox = async () => [rawEmail('fp-1-8', { uid: 8 })];
  ms.fetchInbox = async () => [rawEmail('AAMk/1=')];
  await api().loadInbox({ force: true });
  const before = calls.length;
  const again = await api().loadInbox();
  assert.strictEqual(calls.length, before, 'nothing fetched');
  assert.strictEqual(again.emails.length, 2);
  await api().loadInbox({ force: true });
  assert.strictEqual(callsOf('imap.fetchInbox').length + callsOf('ms.fetchInbox').length > 0, true);
  assert.ok(calls.length > before);
  // A sent-history read happens at most every few minutes, even when forced.
  const sentReads = callsOf('imap.fetchSentHistory').length;
  await api().loadInbox({ force: true });
  assert.strictEqual(callsOf('imap.fetchSentHistory').length, sentReads);
});

test('a reply waits 5 seconds, then goes from the account that received the email, to that email only', async (t) => {
  const gmailInbox = [rawEmail('fp-1-7', { uid: 7, date: hoursAgo(5) }), rawEmail('fp-1-8', { uid: 8, replyTo: { name: 'Ann (work)', address: 'ann@work.example' } })];
  const outlookInbox = [rawEmail('AAMk/6=', { date: hoursAgo(6), conversationId: 'conv-6' }), rawEmail('AAMk/2=', { date: hoursAgo(3), conversationId: 'conv-2' })];
  imap.fetchInbox = async () => structuredClone(gmailInbox);
  ms.fetchInbox = async () => structuredClone(outlookInbox);
  const res = await api().loadInbox({ force: true });
  assert.strictEqual(res.emails.length, 4);
  assert.deepStrictEqual(res.emails.map((m) => m.accountEmail).sort(), ['me@gmail.com', 'me@gmail.com', OUTLOOK, OUTLOOK]);
  assert.deepStrictEqual(find(res, `${gmailId}:fp-1-8`).replyTo, { name: 'Ann (work)', address: 'ann@work.example' });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  imap.sendReply = async () => ({ sent: true, filedInSent: Promise.resolve(true) });
  ms.sendReply = async () => ({ sent: true });
  // The window can only say which email and what text: a recipient it adds is ignored.
  const queued = await exposed.api.reply(`${gmailId}:fp-1-8`, 'Thanks Ann');
  await handlers.get('email:reply')({}, { id: `${outlookId}:AAMk/2=`, body: 'Thanks from Outlook', to: 'attacker@evil.example', account: gmailId });
  assert.strictEqual(queued.queued, true);
  t.mock.timers.tick(4999);
  await settle();
  assert.strictEqual(callsOf('imap.sendReply').length + callsOf('ms.sendReply').length, 0, 'nothing is sent before 5 seconds');
  t.mock.timers.tick(1);
  await settle();
  const [replyAccount, original, body] = callsOf('imap.sendReply').at(-1);
  assert.deepStrictEqual([replyAccount.id, replyAccount.user, replyAccount.pass, original.id, original.messageId, body],
    [gmailId, 'me@gmail.com', 'app-pw', 'fp-1-8', '<fp-1-8@example.com>', 'Thanks Ann']);
  assert.deepStrictEqual(original, gmailInbox[1], 'the email exactly as loaded decides where the reply goes');
  assert.deepStrictEqual(original.replyTo, { name: 'Ann (work)', address: 'ann@work.example' });
  const [msAccount, msOriginal, msBody, msOpts] = callsOf('ms.sendReply').at(-1);
  assert.deepStrictEqual([msAccount.email, msBody, msOpts.clientId], [OUTLOOK, 'Thanks from Outlook', BUILT_IN_ID]);
  assert.deepStrictEqual(msOriginal, outlookInbox[1], 'the recipient the window tried to add was ignored');
  assert.strictEqual(callsOf('ms.sendReply').length + callsOf('imap.sendReply').length, 2, 'once each');
  assert.deepStrictEqual(pushesOf('reply:result').sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: `${gmailId}:fp-1-8`, ok: true }, { id: `${outlookId}:AAMk/2=`, ok: true }].sort((a, b) => a.id.localeCompare(b.id)));
  // Replied emails are done, and "You've already replied" (until the next Sent sync says the same).
  const updated = pushesOf('inbox:updated').at(-1);
  for (const id of [`${gmailId}:fp-1-8`, `${outlookId}:AAMk/2=`]) {
    assert.strictEqual(find(updated, id).done, true);
    assert.strictEqual(find(updated, id).triage.codes[0], 'replied');
  }
  assert.ok(Object.hasOwn(readJson('state.json').done, `${gmailId}:fp-1-8`));
  const hist = readJson('history.json');
  assert.ok(Object.keys(hist[outlookId].replies).includes('c:conv-2'));
  assert.ok(Object.keys(hist[gmailId].replies).includes('m:<fp-1-8@example.com>'));
  assert.deepStrictEqual(hist[gmailId].people, {}, 'a reply sent here is counted by the next Sent sync, not twice');
  await assert.rejects(api().reply('AAMk/2=', 'hi'), (err) => message(err) === 'This email is no longer in your inbox. Refresh and try again.');

  // An account edited to another address since the load: the reply still comes from the address the email was sent to.
  await api().saveAccount({ id: gmailId, user: 'new@gmail.com', pass: 'new-pw' });
  await api().reply(`${gmailId}:fp-1-7`, 'Still from me');
  t.mock.timers.tick(5000);
  await settle();
  assert.deepStrictEqual(callsOf('imap.sendReply').at(-1)[0].user, 'me@gmail.com');
  await api().saveAccount({ id: gmailId, user: 'me@gmail.com', pass: 'app-pw' });
  pushes.length = 0;
});

test('Undo within 5 seconds means the reply is never sent; one reply at a time per email', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  imap.fetchInbox = async () => [rawEmail('fp-1-30', { uid: 30 })];
  ms.fetchInbox = async () => [];
  await api().loadInbox({ force: true });
  const id = `${gmailId}:fp-1-30`;
  const before = callsOf('imap.sendReply').length;
  await api().reply(id, 'Oops, wrong person');
  await assert.rejects(api().reply(id, 'Second'), (err) => /already waiting to be sent/.test(message(err)));
  t.mock.timers.tick(4900);
  assert.deepStrictEqual(await api().undoReply(id), { undone: true });
  t.mock.timers.tick(10000);
  await settle();
  assert.strictEqual(callsOf('imap.sendReply').length, before, 'never sent');
  assert.deepStrictEqual(pushesOf('reply:result'), []);
  assert.deepStrictEqual(await api().undoReply(id), { undone: false }, 'nothing left to undo');

  // Too late: once the 5 seconds are up, Undo says so.
  imap.sendReply = async () => ({ sent: true, filedInSent: Promise.resolve(true) });
  await api().reply(id, 'This one goes');
  t.mock.timers.tick(5000);
  assert.deepStrictEqual(await api().undoReply(id), { undone: false });
  await settle();
  assert.strictEqual(callsOf('imap.sendReply').length, before + 1);
  pushes.length = 0;
});

test('quitting while a reply waits sends nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  imap.fetchInbox = async () => [rawEmail('fp-1-31', { uid: 31 })];
  await api().loadInbox({ force: true });
  const before = callsOf('imap.sendReply').length;
  await api().reply(`${gmailId}:fp-1-31`, 'Never sent');
  appEvents.emit('before-quit', { preventDefault() {} });
  t.mock.timers.tick(60000);
  await settle();
  assert.strictEqual(callsOf('imap.sendReply').length, before);
  assert.deepStrictEqual(pushesOf('reply:result'), []);
  assert.deepStrictEqual(await api().undoReply(`${gmailId}:fp-1-31`), { undone: false });
});

test('a failed send comes back as a plain sentence, and the email is not marked done', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  imap.fetchInbox = async () => [rawEmail('fp-1-32', { uid: 32 })];
  await api().loadInbox({ force: true });
  imap.sendReply = async () => { throw new Error("Couldn't send your reply: your email provider rejected the login."); };
  await api().reply(`${gmailId}:fp-1-32`, 'Hello');
  t.mock.timers.tick(5000);
  await settle();
  assert.deepStrictEqual(pushesOf('reply:result'), [{ id: `${gmailId}:fp-1-32`, ok: false, error: "Couldn't send your reply: your email provider rejected the login." }]);
  assert.ok(!Object.hasOwn(readJson('state.json').done, `${gmailId}:fp-1-32`));
  pushes.length = 0;
});

test('sorting changes are saved in state.json and sort again without fetching', async () => {
  imap.fetchInbox = async () => [
    rawEmail('fp-2-1', { uid: 41, from: { name: 'Weekly Deals', address: 'deals@shop.example' }, headers: { listUnsubscribe: '<https://shop.example/u>', listId: null, precedence: 'bulk', autoSubmitted: null }, text: 'New arrivals this week.' }),
    rawEmail('fp-2-2', { uid: 42, from: { name: 'Priya', address: 'priya@example.com' }, text: 'Could you send me the receipts?' }),
  ];
  const res = await api().loadInbox({ force: true });
  const deals = `${gmailId}:fp-2-1`;
  const priya = `${gmailId}:fp-2-2`;
  assert.deepStrictEqual([find(res, deals).triage.bucket, find(res, priya).triage.bucket], ['noise', 'needs-you']);
  const before = calls.length;

  let v = await api().setRule('Priya@Example.com', 'noise');
  assert.deepStrictEqual([find(v, priya).triage.bucket, find(v, priya).triage.reasons[0], find(v, priya).senderRule], ['noise', 'You chose Always noise', 'noise']);
  v = await api().setNotNoise(priya, true);
  assert.deepStrictEqual([find(v, priya).triage.bucket, find(v, priya).notNoise], ['needs-you', true]);
  v = await api().setRule('priya@example.com', null);
  assert.strictEqual(find(v, priya).senderRule, null);
  v = await api().setRule('deals@shop.example', 'important');
  assert.strictEqual(find(v, deals).triage.bucket, 'needs-you');
  v = await api().setDone([deals, 'not-an-id'], true);
  assert.strictEqual(find(v, deals).done, true);
  assert.strictEqual(v.counts.done, 1);
  assert.strictEqual(calls.length, before, 'nothing was fetched and nothing reached a server');

  const state = readJson('state.json');
  assert.deepStrictEqual(state.rules, { 'deals@shop.example': 'important' });
  assert.deepStrictEqual(Object.keys(state.notNoise), [priya]);
  assert.ok(Object.hasOwn(state.done, deals));
  assert.ok(!Object.hasOwn(state.done, 'not-an-id'));
  assert.strictEqual(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(dir, 'history.json')).mode & 0o777, 0o600);
  assert.deepStrictEqual((await api().getSettings()).rules, { 'deals@shop.example': 'important' });

  v = await api().setDone([deals], false);
  assert.strictEqual(find(v, deals).done, false);
  await api().setRule('deals@shop.example', null);
  await api().setNotNoise(priya, false);
  await assert.rejects(api().setNotNoise('nope:1', true), (err) => /no longer in your inbox/.test(message(err)));
});

test('the Done marks ClearMail 0.2 kept in the window move to state.json once', async () => {
  const old = Date.now() - 90 * 86400_000;
  const res = await api().importDone({
    [`${gmailId}:fp-old-1`]: Date.now() - 1000, 'demo:demo-4': 'yesterday', 'not an id': 1, ['x'.repeat(3000)]: 1,
    [`${gmailId}:fp-2-2`]: old, [`${gmailId}:long-gone`]: old,
  });
  assert.deepStrictEqual(res, { imported: 4 });
  const state = readJson('state.json');
  assert.ok(Object.hasOwn(state.done, `${gmailId}:fp-old-1`) && Object.hasOwn(state.done, 'demo:demo-4'));
  // Over 60 days old: kept while its email is still in the inbox (or its account hasn't
  // loaded this session); dropped once its account loaded without it.
  assert.ok(Object.hasOwn(state.done, `${gmailId}:fp-2-2`), 'still in the inbox');
  assert.ok(Object.hasOwn(state.done, 'demo:demo-4'), 'the sample inbox is not loaded now');
  assert.ok(!Object.hasOwn(state.done, `${gmailId}:long-gone`), 'gone from a mailbox that loaded');
  assert.ok(Number.isFinite(state.migrated.localDone));
  assert.deepStrictEqual(await api().importDone(null), { imported: 0 });
});

test('Open in Outlook on the web uses only Outlook\'s own link; Open in Mail uses the Message-ID', async () => {
  imap.fetchInbox = async () => [rawEmail('fp-3-1', { uid: 51 }), rawEmail('fp-3-2', { uid: 52, messageId: 'no brackets' })];
  ms.fetchInbox = async () => [
    rawEmail('AAMk/ok=', { webLink: 'https://outlook.live.com/owa/?ItemID=AAMk%2Fok%3D&exvsurl=1&viewmodel=ReadMessageItem' }),
    rawEmail('AAMk/evil=', { webLink: 'https://evil.example/owa/?ItemID=1' }),
  ];
  const res = await api().loadInbox({ force: true });
  assert.deepStrictEqual([`${gmailId}:fp-3-1`, `${gmailId}:fp-3-2`, `${outlookId}:AAMk/ok=`].map((id) => find(res, id).canOpen), [true, false, true]);
  opened.length = 0;
  await api().openEmail(`${outlookId}:AAMk/ok=`);
  await api().openEmail(`${outlookId}:AAMk/evil=`);
  await api().openEmail(`${gmailId}:fp-3-1`);
  await assert.rejects(api().openEmail(`${gmailId}:fp-3-2`), (err) => /can't be opened in Mail/.test(message(err)));
  assert.deepStrictEqual(opened, [
    'https://outlook.live.com/owa/?ItemID=AAMk%2Fok%3D&exvsurl=1&viewmodel=ReadMessageItem',
    'https://outlook.live.com/mail/0/inbox', // not the email's own link: it isn't on an Outlook host
    'message://%3Cfp-3-1%40example.com%3E',
  ]);
  opened.length = 0;
});

test('a renewed refresh token and the permissions Microsoft reports are saved', async () => {
  imap.fetchInbox = async () => [];
  ms.fetchInbox = async (_account, opts) => {
    opts.onRefreshToken('rt-outlook-2');
    opts.onGrantedScopes(['Mail.Read', 'Mail.ReadWrite', 'Mail.Send']);
    return [];
  };
  await api().loadInbox({ force: true });
  const disk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!disk.includes('rt-outlook-2'));
  assert.ok(disk.includes(Buffer.from('enc:rt-outlook-2').toString('base64')));
  ms.fetchInbox = async () => [];
  await api().loadInbox({ force: true });
  assert.strictEqual(callsOf('ms.fetchInbox').at(-1)[0].refreshToken, 'rt-outlook-2');
  const outlook = (await api().getSettings()).accounts[1];
  assert.deepStrictEqual(outlook.grantedScopes, ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send'], 'Settings can warn about the old consent');
  assert.strictEqual(outlook.needsSignIn, false, 'a working load clears "sign in again"');

  await api().openConsentPage(outlookId);
  assert.deepStrictEqual(opened, ['https://account.live.com/consent/Manage']);
  await assert.rejects(api().openConsentPage(gmailId), (err) => /no longer in ClearMail/.test(message(err)));
  opened.length = 0;
});

test('"Sign in again" must sign in to the same address, and never adds a copy', async () => {
  ms.signIn = async () => ({ email: 'someone.else@outlook.com', name: 'X', refreshToken: 'rt-other', grantedScopes: SCOPES, personal: true });
  await assert.rejects(api().signInMicrosoft({ accountId: outlookId }), (err) => message(err)
    === `You signed in as someone.else@outlook.com, but this account is ${OUTLOOK}. Click "Sign in again" and choose ${OUTLOOK}.`);
  assert.strictEqual(callsOf('ms.signIn').at(-1)[0].loginHint, OUTLOOK);
  await assert.rejects(api().signInMicrosoft({ accountId: 'ffffffffffffffff' }), (err) => /no longer in ClearMail/.test(message(err)));

  ms.signIn = async () => ({ email: 'WillW6311@Outlook.com', name: 'Will', refreshToken: 'rt-outlook-3', grantedScopes: SCOPES, personal: true });
  const s = await api().signInMicrosoft({ accountId: outlookId });
  assert.deepStrictEqual(s.accounts.map((a) => a.id), [gmailId, outlookId]);
  assert.deepStrictEqual(s.accounts[1].grantedScopes, SCOPES, 'the old consent warning goes once Microsoft stops granting it');
  const again = await api().signInMicrosoft();
  assert.deepStrictEqual(again.accounts.map((a) => a.id), [gmailId, outlookId], 'an address already added is updated');
  ms.fetchInbox = async () => [];
  await api().loadInbox({ force: true });
  assert.strictEqual(callsOf('ms.fetchInbox').at(-1)[0].refreshToken, 'rt-outlook-3');

  ms.signIn = async () => ({ email: UNI, name: 'Will W', refreshToken: 'rt-uni', grantedScopes: SCOPES, personal: false });
  const three = await api().signInMicrosoft();
  assert.deepStrictEqual(three.accounts.map((a) => a.email), ['me@gmail.com', OUTLOOK, UNI]);
  assert.strictEqual(three.accounts[2].personal, false);
  assert.ok(!JSON.stringify(three).includes('rt-'));
});

test('a Keychain-locked account says so instead of failing silently', async () => {
  keychain.denyDecrypt = true;
  const s = await api().saveSettings({});
  assert.strictEqual(s.secretsLocked, true);
  assert.deepStrictEqual(s.accounts.map((a) => [a.locked, a.needsSignIn]), [[true, false], [true, true], [true, true]]);
  const before = calls.length;
  await assert.rejects(api().loadInbox({ force: true }), (err) => {
    const text = message(err);
    return text.startsWith("ClearMail couldn't load any of your accounts.")
      && text.includes("couldn't unlock the saved app password for me@gmail.com")
      && text.includes(`couldn't unlock your saved Microsoft sign-in for ${UNI}`);
  });
  assert.strictEqual(calls.length, before, 'no server is contacted without the secret');
  keychain.denyDecrypt = false;
  assert.strictEqual((await api().saveSettings({})).secretsLocked, false);
});

test('the morning brief: settings, login item, test brief, status and System Settings pages', async () => {
  // Turning the brief on after today's time has passed starts tomorrow, even when it was
  // turned on in Demo mode and Demo mode is turned off later: no brief pops up straight away.
  const earlier = new Date(Date.now() - 3600_000);
  if (earlier.getDate() === new Date().getDate()) {
    const hhmm = `${String(earlier.getHours()).padStart(2, '0')}:${String(earlier.getMinutes()).padStart(2, '0')}`;
    await api().saveSettings({ demo: true });
    await api().saveSettings({ brief: { enabled: true, time: hhmm, days: [0, 1, 2, 3, 4, 5, 6] } });
    await api().saveSettings({ demo: false });
    const first = await api().briefStatus();
    assert.ok(first.nextAt > Date.now() + 60_000 && new Date(first.nextAt).getDate() !== new Date().getDate(), new Date(first.nextAt).toString());
    await api().saveSettings({ brief: { enabled: false } });
  }
  loginItems.set.length = 0;
  let s = await api().saveSettings({ brief: { enabled: true, time: '07:30', days: [1, 2, 3, 4, 5], openAtLogin: true } });
  assert.deepStrictEqual(s.brief, { enabled: true, time: '07:30', days: [1, 2, 3, 4, 5], openAtLogin: true });
  assert.deepStrictEqual(loginItems.set, [{ openAtLogin: true }]);
  let status = await api().briefStatus();
  assert.deepStrictEqual(Object.keys(status).sort(), ['enabled', 'lastAt', 'lastError', 'loginItem', 'nextAt', 'notificationsBlocked', 'paused']);
  assert.deepStrictEqual([status.enabled, status.paused, status.loginItem], [true, null, { status: 'requires-approval', message: null }]);
  assert.ok(status.nextAt > Date.now() - 1000 && status.nextAt < Date.now() + 8 * 86400_000);
  assert.ok([1, 2, 3, 4, 5].includes(new Date(status.nextAt).getDay()));

  // A test brief: counts only, never a name or subject, and it isn't today's brief.
  imap.fetchInbox = async () => [rawEmail('fp-4-1', { uid: 61, from: { name: 'Priya Shah', address: 'priya@example.com' }, subject: 'Secret project', text: 'Can you call me?' })];
  ms.fetchInbox = async () => [];
  await api().loadInbox({ force: true });
  notifications.length = 0;
  assert.deepStrictEqual(await api().testBrief(), { ok: true });
  assert.strictEqual(notifications.length, 1);
  const shown = notifications[0].options;
  assert.strictEqual(shown.title, 'Morning brief (test)');
  assert.match(shown.body, /^1 needs you/);
  assert.ok(!/Priya|Secret/.test(JSON.stringify(shown)));
  assert.strictEqual(readJson('state.json').brief.lastAt, null, 'a test brief is not the day\'s brief');
  // Clicking it shows the Brief.
  notifications[0].emit('click');
  assert.deepStrictEqual(pushesOf('brief:show'), [undefined]);
  // macOS refusing it shows up in Settings.
  notifications[0].emit('failed', {}, 'not allowed');
  status = await api().briefStatus();
  assert.strictEqual(status.notificationsBlocked, true);
  assert.match(status.lastError, /System Settings → Notifications/);

  opened.length = 0;
  await api().openSystemSettings('notifications');
  await api().openSystemSettings('login-items');
  assert.deepStrictEqual(opened, [
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  ]);
  opened.length = 0;

  s = await api().saveSettings({ brief: { openAtLogin: false } });
  assert.deepStrictEqual(loginItems.set.at(-1), { openAtLogin: false });
  assert.deepStrictEqual((await api().briefStatus()).loginItem, { status: 'off', message: null });
  // In demo mode the brief is paused (the test brief still works).
  await api().saveSettings({ demo: true });
  status = await api().briefStatus();
  assert.deepStrictEqual([status.enabled, status.nextAt], [true, null]);
  assert.match(status.paused, /paused while ClearMail shows sample emails/);
  await api().saveSettings({ demo: false });
  pushes.length = 0;
});

test('the morning brief arrives when it is due: counts only, saved once, and the inbox updates', async (t) => {
  // Turning the brief on above (after 07:30) counted today as done, so this is tomorrow's:
  // due two minutes after this time tomorrow; then the clock moves on and the Mac wakes up.
  const soon = new Date(Date.now() + 2 * 60_000);
  const time = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
  await api().saveSettings({ brief: { enabled: true, time, days: [0, 1, 2, 3, 4, 5, 6] } });
  imap.fetchInbox = async () => [rawEmail('fp-5-1', { uid: 71, from: { name: 'Dad', address: 'dad@example.com' }, subject: 'Sunday?', text: 'Are you coming on Sunday?' })];
  ms.fetchInbox = async () => { throw msErr('network', "Couldn't reach Microsoft. Check your internet connection and try again."); };
  notifications.length = 0;
  const fetches = callsOf('imap.fetchInbox').length;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 3600_000 + 3 * 60_000 });
  powerMonitor.emit('resume');
  for (let i = 0; i < 50 && !notifications.length; i++) await tick();
  t.mock.timers.reset();
  assert.strictEqual(notifications.length, 1);
  const shown = notifications[0].options;
  assert.strictEqual(shown.title, 'Morning brief');
  assert.match(shown.body, /^1 needs you/);
  assert.match(shown.subtitle, /^Couldn't check (?:2 of your accounts|willw6311@outlook\.com or cvww@lunet\.lboro\.ac\.uk)$/);
  assert.ok(!/Dad|Sunday/.test(JSON.stringify(shown)));
  assert.strictEqual(callsOf('imap.fetchInbox').length, fetches + 1, 'the brief checks for new email first');
  await settle();
  const saved = readJson('state.json').brief;
  assert.ok(saved.lastSlot && saved.lastAt && saved.lastSince);
  assert.ok(pushesOf('inbox:updated').length >= 1);
  // Once a day: waking up again sends nothing more.
  powerMonitor.emit('resume');
  await settle();
  assert.strictEqual(notifications.length, 1);
  await api().saveSettings({ brief: { enabled: false } });
  pushes.length = 0;
});

test('removing an account forgets it, even while its inbox is loading', async () => {
  const uniId = (await api().getSettings()).accounts[2].id;
  imap.fetchInbox = async () => [rawEmail('fp-1-20', { uid: 20 })];
  ms.fetchInbox = async () => [rawEmail('AAMk/20=')];
  const loaded = await api().loadInbox({ force: true });
  const uniEmail = loaded.emails.find((m) => m.accountId === uniId).id;
  assert.strictEqual(loaded.emails.length, 3);
  await api().setDone([uniEmail], true);
  assert.ok(Object.hasOwn(readJson('state.json').done, uniEmail));

  let release;
  ms.fetchInbox = (account) => (account.id === uniId ? new Promise((resolve) => { release = () => resolve([rawEmail('AAMk/late=')]); }) : Promise.resolve([]));
  const loading = api().loadInbox({ force: true });
  await tick();
  const s = await api().removeAccount(uniId);
  assert.deepStrictEqual(s.accounts.map((a) => a.email), ['me@gmail.com', OUTLOOK]);
  assert.deepStrictEqual(forgotten, [uniId]);
  release();
  const res = await loading;
  assert.deepStrictEqual(res.accounts.map((a) => a.email), ['me@gmail.com', OUTLOOK]);
  assert.ok(!res.emails.some((m) => m.accountId === uniId));
  await assert.rejects(api().reply(uniEmail, 'hi'), (err) => /no longer in your inbox/.test(message(err)));
  assert.strictEqual((await api().removeAccount(uniId)).accounts.length, 2, 'removing twice is fine');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes(Buffer.from('enc:rt-uni').toString('base64')));
  assert.ok(!Object.keys(readJson('state.json').done).some((id) => id.startsWith(`${uniId}:`)), 'its Done marks went too');
  assert.ok(!Object.hasOwn(readJson('history.json'), uniId), 'and its Sent history');
});

test('nothing secret or from an email is written to disk in plain text', () => {
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const secret of ['app-pw', 'new-pw', 'rt-outlook', 'rt-uni', 'Thanks Ann', 'Hello, this is']) assert.ok(!text.includes(secret), `${secret} in ${name}`);
  }
});
