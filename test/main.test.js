// main.js and preload.js together, under a fake electron: the IPC contract the renderer uses.
// The IMAP and Microsoft backends are stubbed so each test decides what the servers answer.
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
const opened = []; // URLs given to shell.openExternal
const keychain = { denyDecrypt: false };
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
  shell: { openExternal: async (url) => { opened.push(url); } },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
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
const imap = { fetchInbox: null, markSeen: null, sendReply: null }; // null: the real mail.js
const ms = {};
const msErr = (code, message) => Object.assign(new Error(message), { code });
function resetMs() {
  for (const fn of ['signIn', 'fetchInbox', 'markSeen', 'sendReply']) ms[fn] = async () => { throw msErr('server', `${fn} was not expected`); };
}
resetMs();
const record = (name, impl) => (...args) => {
  calls.push([name, ...args]);
  return impl()(...args);
};
const fakeMail = {
  ...realMail,
  fetchInbox: record('imap.fetchInbox', () => imap.fetchInbox || realMail.fetchInbox),
  markSeen: record('imap.markSeen', () => imap.markSeen || realMail.markSeen),
  sendReply: record('imap.sendReply', () => imap.sendReply || realMail.sendReply),
};
const forgotten = [];
const fakeMicrosoft = {
  SCOPES: 'openid profile email offline_access',
  signIn: record('ms.signIn', () => ms.signIn),
  fetchInbox: record('ms.fetchInbox', () => ms.fetchInbox),
  markSeen: record('ms.markSeen', () => ms.markSeen),
  sendReply: record('ms.sendReply', () => ms.sendReply),
  forgetAccount: (id) => forgotten.push(id),
  _setEndpoints() {},
};
const fakeConfig = { msClientId: '' };
const callsOf = (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

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
// A summary cached before ClearMail had several accounts, filed under the bare email id.
fs.writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify({ 'demo-2': { at: 1, summary: { gist: 'Cached before accounts', category: 'person', urgency: 'normal' } } }));
require('../main');
require('../preload');
readyResolve();

const demo = require('../src/demo');
const api = () => exposed.api;
const message = (err) => err.message.replace(/^Error invoking remote method '[^']+': /, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const BUILT_IN_ID = '11111111-2222-3333-4444-555555555555';
const OWN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OUTLOOK = 'willw6311@outlook.com';
const UNI = 'cvww@lunet.lboro.ac.uk';

function rawEmail(id, extra = {}) {
  return {
    id, messageId: `<${id}@example.com>`, uid: null, from: { name: 'Ann', address: 'ann@example.com' }, replyTo: null,
    subject: `About ${id}`, date: hoursAgo(1), text: `Hello, this is ${id}.`, html: '', seen: false, references: [], attachments: [],
    ...extra,
  };
}

let gmailId = null;
let outlookId = null;

test.before(() => ready.then(tick));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('preload exposes the contract API and every channel it uses has a handler', () => {
  assert.strictEqual(exposed.key, 'clearmail');
  assert.deepStrictEqual(Object.keys(api()).sort(), [
    'cancelSignIn', 'getSettings', 'loadInbox', 'markSeen', 'onAiStatus', 'onSummary', 'openLink', 'removeAccount', 'reply',
    'saveAccount', 'saveSettings', 'signInMicrosoft',
  ]);
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const channels = [...source.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length >= 10);
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
    'accounts', 'demoActive', 'demoChosen', 'demoReason', 'hasApiKey', 'limit', 'msClientId', 'msClientIdBuiltIn', 'providers', 'secretsLocked',
  ]);
  assert.deepStrictEqual(s.accounts, []);
  assert.strictEqual(s.demoChosen, false);
  assert.strictEqual(s.demoActive, true);
  assert.strictEqual(s.demoReason, 'no-account');
  assert.strictEqual(s.msClientId, '');
  assert.strictEqual(s.msClientIdBuiltIn, false);
  assert.deepStrictEqual(s.providers, { gmail: 'Gmail', icloud: 'iCloud', yahoo: 'Yahoo' });
});

test('demo inbox: every email has the EmailView shape, and the original is the uncleaned text', async () => {
  const res = await api().loadInbox();
  assert.strictEqual(res.demo, true);
  assert.strictEqual(res.demoReason, 'no-account');
  assert.strictEqual(res.aiEnabled, false);
  assert.strictEqual(res.aiError, null);
  assert.deepStrictEqual(res.accounts, []);
  assert.strictEqual(res.emails.length, demo.length);
  for (const m of res.emails) {
    assert.deepStrictEqual(Object.keys(m).sort(), [
      'accountEmail', 'accountId', 'attachments', 'cleaned', 'date', 'from', 'id', 'messageId', 'original', 'replyTo', 'seen', 'subject', 'summary',
    ]);
    assert.strictEqual(m.accountId, 'demo');
    assert.strictEqual(m.accountEmail, '');
    assert.strictEqual(m.original, demo.find((d) => `demo:${d.id}` === m.id).text);
    assert.ok(Array.isArray(m.cleaned.links) && Array.isArray(m.summary.key_points));
    assert.ok(!('errorKind' in m.summary));
  }
  // The summary saved under the old id is found under the new one, and moved there on disk.
  const adopted = res.emails.find((m) => m.id === 'demo:demo-2').summary;
  assert.deepStrictEqual([adopted.source, adopted.gist], ['ai', 'Cached before accounts']);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'summaries.json'), 'utf8'))), ['demo:demo-2']);
});

test('demo: opened emails stay read after a refresh, and replies are not really sent', async () => {
  const unread = (await api().loadInbox()).emails.filter((m) => !m.seen).map((m) => m.id);
  assert.ok(unread.length > 1);
  assert.strictEqual(await api().markSeen(unread.slice(0, 2)), undefined);
  const again = await api().loadInbox();
  for (const id of unread.slice(0, 2)) assert.strictEqual(again.emails.find((m) => m.id === id).seen, true);
  assert.strictEqual(again.emails.find((m) => m.id === unread[2]).seen, false);
  assert.deepStrictEqual(await api().reply(unread[0], 'Thanks!'), { demo: true });
  assert.strictEqual(calls.length, 0, 'demo mode never reaches a server');
});

test('errors reach the renderer as plain sentences', async () => {
  await assert.rejects(api().reply('demo:demo-1', '  '), (err) => message(err) === 'Type a reply first.');
  await assert.rejects(api().saveAccount({ provider: 'outlook', user: 'a@b.com' }), (err) => message(err) === 'Choose your email provider from the list.');
  await assert.rejects(api().saveAccount({ provider: 'gmail', user: 'someone' }), (err) => message(err) === 'Enter your full email address, like name@example.com.');
  await assert.rejects(api().saveSettings({ msClientId: 'my app' }), (err) => /^That doesn't look like an Application \(client\) ID\./.test(message(err)));
  await assert.rejects(api().removeAccount(42), (err) => message(err) === "Couldn't remove the account. Please try again.");
});

test('an account without a password is not demo: loading says what is missing', async () => {
  const s = await api().saveAccount({ provider: 'gmail', user: 'me@gmail.com', pass: '' });
  assert.strictEqual(s.demoActive, false);
  assert.strictEqual(s.demoReason, null);
  assert.strictEqual(s.accounts.length, 1);
  assert.deepStrictEqual([s.accounts[0].kind, s.accounts[0].email, s.accounts[0].hasPass], ['imap', 'me@gmail.com', false]);
  gmailId = s.accounts[0].id;
  await assert.rejects(api().loadInbox(), (err) => message(err) === 'Add your email address and app password in Settings.');
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

test('signing in adds a Microsoft account; the browser only ever opens an https page', async () => {
  ms.signIn = async (opts) => {
    await opts.openUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x');
    return { email: OUTLOOK, name: 'Will', refreshToken: 'rt-outlook-1' };
  };
  const s = await api().signInMicrosoft();
  const [opts] = callsOf('ms.signIn').at(-1);
  assert.strictEqual(opts.clientId, BUILT_IN_ID);
  assert.strictEqual(opts.loginHint, undefined);
  assert.ok(opts.signal instanceof AbortSignal);
  assert.deepStrictEqual(opened, ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x']);
  const account = s.accounts.find((a) => a.kind === 'microsoft');
  assert.deepStrictEqual([account.email, account.name, account.provider, account.signedIn, account.needsSignIn], [OUTLOOK, 'Will', 'microsoft', true, false]);
  assert.ok(!JSON.stringify(s).includes('rt-outlook-1'));
  outlookId = account.id;

  let refused = null;
  ms.signIn = async (opts) => {
    try {
      await opts.openUrl('file:///etc/passwd');
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

test('two accounts: one failing never hides the other', async () => {
  imap.fetchInbox = async () => [rawEmail('fp-1-7', { uid: 7, date: hoursAgo(5) })];
  ms.fetchInbox = async () => { throw msErr('needs-sign-in', 'Microsoft needs you to sign in to this account again.'); };
  let res = await api().loadInbox();
  assert.strictEqual(res.demo, false);
  assert.deepStrictEqual(res.emails.map((m) => m.id), [`${gmailId}:fp-1-7`]);
  assert.deepStrictEqual(res.accounts, [
    { id: gmailId, email: 'me@gmail.com', kind: 'imap', error: null, needsSignIn: false },
    { id: outlookId, email: OUTLOOK, kind: 'microsoft', error: `Microsoft needs you to sign in to ${OUTLOOK} again. Use "Sign in again" to reconnect it.`, needsSignIn: true },
  ]);
  assert.strictEqual((await api().getSettings()).accounts[1].needsSignIn, true);
  const [account, opts] = callsOf('ms.fetchInbox').at(-1);
  assert.deepStrictEqual([account.id, account.email, account.refreshToken], [outlookId, OUTLOOK, 'rt-outlook-1']);
  assert.deepStrictEqual([opts.clientId, opts.limit, typeof opts.onRefreshToken], [BUILT_IN_ID, 60, 'function']);
  assert.strictEqual(callsOf('imap.fetchInbox').at(-1)[1].limit, 60);

  imap.fetchInbox = async () => { throw new Error('Your email provider rejected the login. Check your email address and app password in Settings.'); };
  ms.fetchInbox = async () => [rawEmail('AAMkAD=', { date: hoursAgo(2) })];
  res = await api().loadInbox();
  // The Gmail account keeps the email it showed last time, as a failed refresh of one account does.
  assert.deepStrictEqual(res.emails.map((m) => [m.id, m.accountId, m.accountEmail]), [
    [`${gmailId}:fp-1-7`, gmailId, 'me@gmail.com'],
    [`${outlookId}:AAMkAD=`, outlookId, OUTLOOK],
  ]);
  assert.match(res.accounts[0].error, /rejected the login/);
  assert.deepStrictEqual([res.accounts[1].error, res.accounts[1].needsSignIn], [null, false]);
  assert.strictEqual((await api().getSettings()).accounts[1].needsSignIn, false);
  // Not once the account points at another mailbox: those emails aren't its emails.
  await api().saveAccount({ id: gmailId, user: 'other@gmail.com' });
  res = await api().loadInbox();
  assert.deepStrictEqual(res.emails.map((m) => m.id), [`${outlookId}:AAMkAD=`]);
  await api().saveAccount({ id: gmailId, user: 'me@gmail.com', pass: 'app-pw' });

  ms.fetchInbox = async () => { throw msErr('network', "Couldn't reach Microsoft. Check your internet connection and try again."); };
  await assert.rejects(api().loadInbox(), (err) => message(err) === "ClearMail couldn't load any of your accounts. "
    + 'me@gmail.com: Your email provider rejected the login. Check your email address and app password in Settings. '
    + `${OUTLOOK}: Couldn't reach Microsoft. Check your internet connection and try again.`);
});

test('ids carry the account: mark-as-read and replies go to the account each email came from', async () => {
  imap.fetchInbox = async () => [rawEmail('fp-1-7', { uid: 7, date: hoursAgo(5) }), rawEmail('fp-1-8', { uid: 8, date: hoursAgo(1) })];
  ms.fetchInbox = async () => [rawEmail('AAMk/6=', { date: hoursAgo(6) }), rawEmail('AAMk/2=', { date: hoursAgo(3) })];
  const res = await api().loadInbox();
  // Oldest first across both accounts.
  assert.deepStrictEqual(res.emails.map((m) => m.id), [`${outlookId}:AAMk/6=`, `${gmailId}:fp-1-7`, `${outlookId}:AAMk/2=`, `${gmailId}:fp-1-8`]);
  assert.deepStrictEqual(res.emails.map((m) => m.accountEmail), [OUTLOOK, 'me@gmail.com', OUTLOOK, 'me@gmail.com']);

  imap.markSeen = async () => {};
  ms.markSeen = async () => {};
  const before = calls.length;
  await api().markSeen(res.emails.map((m) => m.id));
  const [[imapAccount, uids]] = callsOf('imap.markSeen');
  assert.deepStrictEqual([imapAccount.id, imapAccount.user, imapAccount.pass, uids], [gmailId, 'me@gmail.com', 'app-pw', [7, 8]]);
  const [[msAccount, graphIds, opts]] = callsOf('ms.markSeen');
  assert.deepStrictEqual([msAccount.id, graphIds, opts.clientId], [outlookId, ['AAMk/6=', 'AAMk/2='], BUILT_IN_ID]);
  assert.strictEqual(calls.length, before + 2, 'one call per account');
  await api().markSeen(res.emails.map((m) => m.id));
  assert.strictEqual(calls.length, before + 2, 'emails already read are not sent again');

  imap.sendReply = async () => ({ sent: true, filedInSent: Promise.resolve(true) });
  ms.sendReply = async () => ({ sent: true });
  assert.deepStrictEqual(await api().reply(`${gmailId}:fp-1-8`, 'Thanks Ann'), { sent: true });
  const [replyAccount, original, body] = callsOf('imap.sendReply').at(-1);
  assert.deepStrictEqual([replyAccount.user, original.id, original.messageId, body], ['me@gmail.com', 'fp-1-8', '<fp-1-8@example.com>', 'Thanks Ann']);
  assert.deepStrictEqual(await api().reply(`${outlookId}:AAMk/2=`, 'Thanks from Outlook'), { sent: true });
  const [msReplyAccount, msOriginal, msBody, msOpts] = callsOf('ms.sendReply').at(-1);
  assert.deepStrictEqual([msReplyAccount.email, msOriginal.id, msBody, msOpts.clientId], [OUTLOOK, 'AAMk/2=', 'Thanks from Outlook', BUILT_IN_ID]);
  await assert.rejects(api().reply('AAMk/2=', 'hi'), (err) => message(err) === 'This email is no longer in your inbox. Refresh and try again.');

  // An account edited to another address since the load: the reply still comes from the address the email was sent to.
  await api().saveAccount({ id: gmailId, user: 'new@gmail.com', pass: 'new-pw' });
  await api().reply(`${gmailId}:fp-1-7`, 'Still from me');
  assert.deepStrictEqual(callsOf('imap.sendReply').at(-1)[0].user, 'me@gmail.com');
  await api().saveAccount({ id: gmailId, user: 'me@gmail.com', pass: 'app-pw' });
});

test('mark-as-read: one account failing rejects, and the other account still gets marked', async () => {
  imap.fetchInbox = async () => [rawEmail('fp-1-9', { uid: 9 })];
  ms.fetchInbox = async () => [rawEmail('AAMk/9=')];
  const ids = (await api().loadInbox()).emails.map((m) => m.id);
  imap.markSeen = async () => { throw new Error("Your mail server didn't let ClearMail mark the email as read."); };
  ms.markSeen = async () => {};
  await assert.rejects(api().markSeen(ids), (err) => message(err) === "Your mail server didn't let ClearMail mark the email as read.");
  const msCalls = callsOf('ms.markSeen').length;
  await assert.rejects(api().markSeen(ids));
  assert.strictEqual(callsOf('ms.markSeen').length, msCalls, 'the Outlook email was already marked read');

  // Microsoft asking for a new sign-in shows up in Settings.
  ms.fetchInbox = async () => [rawEmail('AAMk/10=')];
  const [id] = (await api().loadInbox()).emails.filter((m) => m.accountId === outlookId).map((m) => m.id);
  ms.markSeen = async () => { throw msErr('needs-sign-in', 'Microsoft needs you to sign in to this account again.'); };
  await assert.rejects(api().markSeen([id]), (err) => message(err) === `Microsoft needs you to sign in to ${OUTLOOK} again. Use "Sign in again" to reconnect it.`);
  assert.strictEqual((await api().getSettings()).accounts[1].needsSignIn, true);
});

test('a renewed Microsoft refresh token is saved encrypted and used from then on', async () => {
  imap.fetchInbox = async () => [];
  ms.fetchInbox = async (_account, opts) => {
    opts.onRefreshToken('rt-outlook-2');
    return [];
  };
  await api().loadInbox();
  const disk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!disk.includes('rt-outlook-2'));
  assert.ok(disk.includes(Buffer.from('enc:rt-outlook-2').toString('base64')));
  ms.fetchInbox = async () => [];
  await api().loadInbox();
  assert.strictEqual(callsOf('ms.fetchInbox').at(-1)[0].refreshToken, 'rt-outlook-2');
  assert.strictEqual((await api().getSettings()).accounts[1].needsSignIn, false, 'a working load clears "sign in again"');
});

test('"Sign in again" must sign in to the same address, and never adds a copy', async () => {
  ms.signIn = async () => ({ email: 'someone.else@outlook.com', name: 'X', refreshToken: 'rt-other' });
  await assert.rejects(api().signInMicrosoft({ accountId: outlookId }), (err) => message(err)
    === `You signed in as someone.else@outlook.com, but this account is ${OUTLOOK}. Click "Sign in again" and choose ${OUTLOOK}.`);
  assert.strictEqual(callsOf('ms.signIn').at(-1)[0].loginHint, OUTLOOK);
  await assert.rejects(api().signInMicrosoft({ accountId: 'ffffffffffffffff' }), (err) => /no longer in ClearMail/.test(message(err)));

  ms.signIn = async () => ({ email: 'WillW6311@Outlook.com', name: 'Will', refreshToken: 'rt-outlook-3' });
  const s = await api().signInMicrosoft({ accountId: outlookId });
  assert.deepStrictEqual(s.accounts.map((a) => a.id), [gmailId, outlookId]);
  const again = await api().signInMicrosoft();
  assert.deepStrictEqual(again.accounts.map((a) => a.id), [gmailId, outlookId], 'an address already added is updated');
  ms.fetchInbox = async () => [];
  await api().loadInbox();
  assert.strictEqual(callsOf('ms.fetchInbox').at(-1)[0].refreshToken, 'rt-outlook-3');

  ms.signIn = async () => ({ email: UNI, name: 'Will W', refreshToken: 'rt-uni' });
  const three = await api().signInMicrosoft();
  assert.deepStrictEqual(three.accounts.map((a) => a.email), ['me@gmail.com', OUTLOOK, UNI]);
  assert.ok(!JSON.stringify(three).includes('rt-'));
});

test('a Keychain-locked account says so instead of failing silently', async () => {
  keychain.denyDecrypt = true;
  const s = await api().saveSettings({});
  assert.strictEqual(s.secretsLocked, true);
  assert.deepStrictEqual(s.accounts.map((a) => [a.locked, a.needsSignIn]), [[true, false], [true, true], [true, true]]);
  const before = calls.length;
  await assert.rejects(api().loadInbox(), (err) => {
    const text = message(err);
    return text.startsWith("ClearMail couldn't load any of your accounts.")
      && text.includes("couldn't unlock the saved app password for me@gmail.com")
      && text.includes(`couldn't unlock your saved Microsoft sign-in for ${UNI}`);
  });
  assert.strictEqual(calls.length, before, 'no server is contacted without the secret');
  keychain.denyDecrypt = false;
  assert.strictEqual((await api().saveSettings({})).secretsLocked, false);
});

test('removing an account forgets it, even while its inbox is loading', async () => {
  const uniId = (await api().getSettings()).accounts[2].id;
  imap.fetchInbox = async () => [rawEmail('fp-1-20', { uid: 20 })];
  ms.fetchInbox = async () => [rawEmail('AAMk/20=')];
  const ids = (await api().loadInbox()).emails.map((m) => m.id);
  assert.strictEqual(ids.length, 3);

  let release;
  ms.fetchInbox = (account) => (account.id === uniId ? new Promise((resolve) => { release = () => resolve([rawEmail('AAMk/late=')]); }) : Promise.resolve([]));
  const loading = api().loadInbox();
  await tick();
  const s = await api().removeAccount(uniId);
  assert.deepStrictEqual(s.accounts.map((a) => a.email), ['me@gmail.com', OUTLOOK]);
  assert.deepStrictEqual(forgotten, [uniId]);
  release();
  const res = await loading;
  assert.deepStrictEqual(res.accounts.map((a) => a.email), ['me@gmail.com', OUTLOOK]);
  assert.ok(!res.emails.some((m) => m.accountId === uniId));
  await assert.rejects(api().reply(ids.find((id) => id.startsWith(`${uniId}:`)), 'hi'), (err) => /no longer in your inbox/.test(message(err)));
  assert.strictEqual((await api().removeAccount(uniId)).accounts.length, 2, 'removing twice is fine');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes(Buffer.from('enc:rt-uni').toString('base64')));
});
