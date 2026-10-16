// End to end: the real main.js, preload.js, src/store.js and src/microsoft.js together under
// a fake electron, against test/helpers/microsoft-server.js standing in for Microsoft's
// sign-in and Graph at their real https addresses. The test plays the user's browser. The
// IMAP backend is stubbed here (test/mail.test.js runs it against mock servers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const util = require('util');
const Module = require('module');
const { startMicrosoft, graphMessage } = require('./helpers/microsoft-server');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearmail-e2e-'));
const CLIENT_ID = '0b5f6c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
const OUTLOOK = 'willw6311@outlook.com';
const UNI = 'cvww@lunet.lboro.ac.uk';
const GMAIL = 'will.wright@gmail.com';
const SARAH = ['Sarah Collins', 'sarah.collins@brightside.co.uk'];

// Everything printed is kept, to check no token or sign-in code ever reaches a log.
const printed = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => printed.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '));
}

// ---------- fake electron ----------

const handlers = new Map();
const opened = []; // what main asked shell.openExternal to open
let api = null;
let microsoft = null; // the mock Microsoft
const fakeElectron = {
  app: { getPath: () => dir, whenReady: () => Promise.resolve(), isReady: () => true, on() {}, quit() {}, requestSingleInstanceLock: () => true },
  BrowserWindow: class {
    constructor() { this.webContents = { isDestroyed: () => false, send() {}, setWindowOpenHandler() {}, on() {} }; }
    loadFile() {}
    on() {}
    isDestroyed() { return false; }
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  },
  Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  shell: {
    openExternal: async (url) => {
      opened.push(url);
      microsoft.openBrowser(url);
    },
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (buf) => buf.toString().replace(/^enc:/, ''),
  },
  contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } },
  // What Electron does with a handler's error: the renderer gets err.toString() behind a prefix.
  ipcRenderer: {
    async invoke(channel, ...args) {
      try {
        return await handlers.get(channel)({ sender: null }, ...structuredClone(args));
      } catch (err) {
        throw new Error(`Error invoking remote method '${channel}': ${err.toString()}`);
      }
    },
    on() {},
    removeListener() {},
  },
};

// The Gmail account's IMAP backend: what main.js asks of src/mail.js is recorded here.
const imap = { calls: [], inbox: [] };
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron;
  const real = realLoad.call(this, request, parent, ...rest);
  if (request === './src/mail' && parent?.filename === path.join(ROOT, 'main.js')) {
    return {
      ...real,
      fetchInbox: async (account, opts) => { imap.calls.push(['fetchInbox', account.user, opts]); return structuredClone(imap.inbox); },
      markSeen: async (account, uids) => { imap.calls.push(['markSeen', account.user, uids]); },
      sendReply: async (account, raw, body) => { imap.calls.push(['sendReply', account.user, raw.id, body]); return { sent: true, filedInSent: Promise.resolve(true) }; },
    };
  }
  return real;
};

// Starts ClearMail: fresh copies of its modules (nothing kept in memory), the same userData folder.
async function launch() {
  for (const id of Object.keys(require.cache)) {
    const own = id.startsWith(ROOT + path.sep) && !id.includes(`${path.sep}node_modules${path.sep}`) && !id.includes(`${path.sep}test${path.sep}`);
    if (own) delete require.cache[id];
  }
  handlers.clear();
  delete process.env.CLEARMAIL_MS_CLIENT_ID;
  require('../main');
  require('../preload');
  await new Promise((resolve) => setImmediate(resolve)); // app.whenReady()
}

const message = (err) => err.message.replace(/^Error invoking remote method '[^']+': /, '');
const settingsFile = () => fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
const ciphertext = (secret) => Buffer.from(`enc:${secret}`).toString('base64');
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const byEmail = (s, email) => s.accounts.find((a) => a.email === email);

function portClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
  });
}

const ids = {}; // account ids by address

test.before(async () => {
  microsoft = await startMicrosoft({ clientId: CLIENT_ID });
  microsoft.installFetch();
  microsoft.addMailbox({
    email: OUTLOOK,
    displayName: 'Will Wright',
    messages: [
      graphMessage({ id: 'AAMkAGI2-o1/Zx+Q==', from: SARAH, subject: 'Quote for the kitchen', minutesAgo: 300, text: 'Hi Will,\r\n\r\nCould you send the signed quote back by Friday?\r\n\r\nThanks,\r\nSarah' }),
      graphMessage({ id: 'AAMkAGI2-o2', from: ['Amazon.co.uk', 'shipment-tracking@amazon.co.uk'], subject: 'Your order has shipped', minutesAgo: 2000, isRead: true, text: 'Your parcel is on its way and arrives Tuesday.' }),
      graphMessage({
        id: 'AAMkAGI2-o3', from: ['Dad', 'dad@example.com'], subject: 'Sunday lunch?', minutesAgo: 30, text: 'Are you coming on Sunday? Menu attached.',
        attachments: [
          { name: 'image001.png', size: 4000, isInline: true, contentType: 'image/png' },
          { name: 'Menu.pdf', size: 20480, isInline: false, contentType: 'application/pdf' },
        ],
      }),
    ],
  });
  microsoft.addMailbox({
    email: UNI,
    displayName: 'Will Wright',
    mail: null, // some university accounts only have a userPrincipalName
    userPrincipalName: 'CVWW@lunet.lboro.ac.uk',
    messages: [
      graphMessage({ id: 'AAMkADU1-u1', from: SARAH, subject: 'Project meeting', minutesAgo: 120, text: 'Can we move the project meeting to 3pm on Thursday?' }),
      graphMessage({
        id: 'AAMkADU1-u2', from: ['Student Services', 'noreply@lboro.ac.uk'], replyTo: ['Library', 'library@lboro.ac.uk'], subject: 'Library loan overdue',
        minutesAgo: 1500, html: true, text: '<p>Your library loan is <b>overdue</b>. Please return it by 20 October.</p>',
      }),
    ],
  });
  imap.inbox = [{
    id: 'fp-1-41', messageId: '<g41@mail.gmail.com>', uid: 41, from: { name: 'Priya', address: 'priya@example.com' }, replyTo: null, subject: 'Climbing on Saturday',
    date: hoursAgo(3), text: 'Are you still up for climbing on Saturday?', html: '', seen: false, references: [], attachments: [],
  }];
  await launch();
});

test.after(async () => {
  await microsoft.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('first run shows the sample emails, and Outlook asks for an app ID first', async () => {
  const s = await api.getSettings();
  assert.deepStrictEqual([s.accounts, s.demoActive, s.demoReason], [[], true, 'no-account']);
  const res = await api.loadInbox();
  assert.deepStrictEqual([res.demo, res.accounts], [true, []]);
  assert.ok(res.emails.length > 5 && res.emails.every((m) => m.id.startsWith('demo:') && m.accountId === 'demo'));

  if (!s.msClientIdBuiltIn) {
    await assert.rejects(api.signInMicrosoft(), (err) => /needs a Microsoft app ID/.test(message(err)));
    assert.strictEqual(opened.length, 0);
  }
  const saved = await api.saveSettings({ msClientId: ` ${CLIENT_ID.toUpperCase()} ` });
  assert.strictEqual(saved.msClientId, CLIENT_ID);
});

test('signing in through the browser adds the Outlook account', async () => {
  microsoft.choose = () => ({ email: OUTLOOK });
  const s = await api.signInMicrosoft();
  await microsoft.browsing;

  // The real Microsoft sign-in page, opened in the browser through main's https-only check.
  assert.strictEqual(opened.length, 1);
  assert.ok(opened[0].startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'));
  const visit = microsoft.visits.at(-1);
  const p = visit.params;
  assert.deepStrictEqual(
    [p.get('client_id'), p.get('response_type'), p.get('response_mode'), p.get('prompt'), p.get('code_challenge_method'), p.get('login_hint')],
    [CLIENT_ID, 'code', 'query', 'select_account', 'S256', null],
  );
  assert.match(p.get('redirect_uri'), /^http:\/\/localhost:\d+$/);
  for (const scope of ['offline_access', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send']) {
    assert.ok(p.get('scope').split(' ').includes(scope), scope);
  }
  assert.strictEqual(visit.status, 200);
  assert.match(visit.page, /You(?:&#39;|')re signed in/);
  assert.ok(await portClosed(Number(new URL(p.get('redirect_uri')).port)), 'the sign-in web server is closed');

  const account = byEmail(s, OUTLOOK);
  assert.deepStrictEqual(
    [account.kind, account.name, account.provider, account.signedIn, account.needsSignIn, account.hasPass],
    ['microsoft', 'Will Wright', 'microsoft', true, false, false],
  );
  assert.deepStrictEqual([s.demoActive, s.demoReason], [false, null]);
  ids[OUTLOOK] = account.id;
  // Only the encrypted sign-in is saved.
  assert.ok(!JSON.stringify(s).includes('SECRET'));
  assert.ok(!settingsFile().includes('SECRET'));
  assert.ok(settingsFile().includes(ciphertext(microsoft.mailbox(OUTLOOK).latestRefreshToken)));
});

test('a second Microsoft account (university) and a Gmail account join it', async () => {
  microsoft.choose = () => ({ email: UNI });
  let s = await api.signInMicrosoft();
  await microsoft.browsing;
  assert.strictEqual(byEmail(s, UNI).kind, 'microsoft', 'the userPrincipalName is used, lower-cased');
  s = await api.saveAccount({ provider: 'gmail', user: GMAIL, pass: 'SECRET-app-password' });
  assert.deepStrictEqual(s.accounts.map((a) => [a.email, a.kind]), [[OUTLOOK, 'microsoft'], [UNI, 'microsoft'], [GMAIL, 'imap']]);
  for (const a of s.accounts) ids[a.email] = a.id;

  // Signing in to an address already added updates it instead of adding a copy.
  microsoft.choose = () => ({ email: OUTLOOK });
  s = await api.signInMicrosoft();
  await microsoft.browsing;
  assert.strictEqual(s.accounts.length, 3);
});

test('one chat list: every account loads, ids carry the account, oldest first', async () => {
  const res = await api.loadInbox();
  assert.deepStrictEqual([res.demo, res.demoReason], [false, null]);
  assert.deepStrictEqual(res.accounts, [
    { id: ids[OUTLOOK], email: OUTLOOK, kind: 'microsoft', error: null, needsSignIn: false },
    { id: ids[UNI], email: UNI, kind: 'microsoft', error: null, needsSignIn: false },
    { id: ids[GMAIL], email: GMAIL, kind: 'imap', error: null, needsSignIn: false },
  ]);
  assert.deepStrictEqual(res.emails.map((m) => m.subject), [
    'Your order has shipped', 'Library loan overdue', 'Quote for the kitchen', 'Climbing on Saturday', 'Project meeting', 'Sunday lunch?',
  ]);
  for (const m of res.emails) {
    const address = Object.keys(ids).find((a) => ids[a] === m.accountId);
    assert.strictEqual(m.accountEmail, address);
    assert.ok(m.id.startsWith(`${m.accountId}:`));
  }
  const get = (subject) => res.emails.find((m) => m.subject === subject);
  assert.strictEqual(get('Quote for the kitchen').id, `${ids[OUTLOOK]}:AAMkAGI2-o1/Zx+Q==`);
  assert.deepStrictEqual(get('Quote for the kitchen').from, { name: 'Sarah Collins', address: SARAH[1] });
  assert.strictEqual(get('Quote for the kitchen').original, 'Hi Will,\n\nCould you send the signed quote back by Friday?\n\nThanks,\nSarah');
  assert.strictEqual(get('Project meeting').from.address, SARAH[1], 'Sarah writes to both Microsoft accounts');
  assert.deepStrictEqual(get('Sunday lunch?').attachments, [{ filename: 'Menu.pdf', size: 20480 }], 'inline images are not attachments');
  const library = get('Library loan overdue');
  assert.match(library.original, /Your library loan is overdue\. Please return it by 20 October\./);
  assert.ok(!/<b>/.test(library.original), 'HTML is shown as text');
  assert.deepStrictEqual(library.replyTo, { name: 'Library', address: 'library@lboro.ac.uk' });
  assert.deepStrictEqual([get('Your order has shipped').seen, get('Sunday lunch?').seen], [true, false]);
  assert.deepStrictEqual(imap.calls.at(-1), ['fetchInbox', GMAIL, { limit: 60 }]);
});

test('Microsoft\'s renewed sign-ins are saved encrypted as soon as they arrive', () => {
  const disk = settingsFile();
  for (const email of [OUTLOOK, UNI]) {
    const latest = microsoft.mailbox(email).latestRefreshToken;
    assert.ok(microsoft.refreshTokensUsed.some((r) => r.mailbox === email), `${email} was refreshed`);
    assert.ok(disk.includes(ciphertext(latest)), `${email}'s newest refresh token is saved`);
  }
  assert.ok(!disk.includes('SECRET'));
});

test('mark as read goes to each account, in one request each', async () => {
  const res = await api.loadInbox();
  const unread = res.emails.filter((m) => !m.seen);
  assert.strictEqual(unread.length, 5);
  microsoft.batches.length = 0;
  imap.calls.length = 0;
  await api.markSeen(unread.map((m) => m.id));
  const batches = Object.fromEntries(microsoft.batches.map((b) => [b.mailbox, b.ids.sort()]));
  assert.deepStrictEqual(batches, { [OUTLOOK]: ['AAMkAGI2-o1/Zx+Q==', 'AAMkAGI2-o3'], [UNI]: ['AAMkADU1-u1', 'AAMkADU1-u2'] });
  assert.deepStrictEqual(imap.calls, [['markSeen', GMAIL, [41]]]);
  assert.ok(microsoft.mailbox(OUTLOOK).messages.every((m) => m.isRead));

  await api.markSeen(unread.map((m) => m.id));
  assert.strictEqual(microsoft.batches.length, 2, 'emails already read are not sent again');
  const again = await api.loadInbox();
  assert.ok(again.emails.filter((m) => m.accountId !== ids[GMAIL]).every((m) => m.seen));
});

test('a reply goes out from the account that received the email', async () => {
  const res = await api.loadInbox();
  const get = (subject) => res.emails.find((m) => m.subject === subject);
  assert.deepStrictEqual(await api.reply(get('Project meeting').id, 'Thursday at 3pm works for me.'), { sent: true });
  assert.deepStrictEqual(microsoft.replies.at(-1), {
    mailbox: UNI, id: 'AAMkADU1-u1', body: { message: { body: { contentType: 'text', content: 'Thursday at 3pm works for me.' } } },
  });
  assert.deepStrictEqual(await api.reply(get('Quote for the kitchen').id, 'Signed copy attached tomorrow.'), { sent: true });
  assert.deepStrictEqual([microsoft.replies.at(-1).mailbox, microsoft.replies.at(-1).id], [OUTLOOK, 'AAMkAGI2-o1/Zx+Q==']);
  assert.deepStrictEqual(await api.reply(get('Climbing on Saturday').id, 'Yes!'), { sent: true });
  assert.deepStrictEqual(imap.calls.at(-1), ['sendReply', GMAIL, 'fp-1-41', 'Yes!']);
  assert.strictEqual(microsoft.replies.length, 2);
});

test('a revoked sign-in only affects that account, and "Sign in again" fixes it', async () => {
  microsoft.revokeAll(UNI); // e.g. the university password was changed
  let res = await api.loadInbox();
  const uni = res.accounts.find((a) => a.email === UNI);
  assert.deepStrictEqual(uni, {
    id: ids[UNI], email: UNI, kind: 'microsoft', needsSignIn: true,
    error: `Microsoft needs you to sign in to ${UNI} again. Use "Sign in again" to reconnect it.`,
  });
  assert.ok(res.accounts.filter((a) => a.email !== UNI).every((a) => !a.error));
  assert.ok(res.emails.some((m) => m.accountId === ids[OUTLOOK]));
  assert.strictEqual(byEmail(await api.getSettings(), UNI).needsSignIn, true);
  // Its chats stay as they were last loaded; replying asks to sign in again and sends nothing.
  const kept = res.emails.filter((m) => m.accountId === ids[UNI]);
  assert.deepStrictEqual(kept.map((m) => m.subject).sort(), ['Library loan overdue', 'Project meeting']);
  const replies = microsoft.replies.length;
  await assert.rejects(api.reply(kept[0].id, 'Hello?'), (err) => message(err) === uni.error);
  assert.strictEqual(microsoft.replies.length, replies);

  microsoft.choose = () => ({ email: UNI });
  const s = await api.signInMicrosoft({ accountId: ids[UNI] });
  await microsoft.browsing;
  assert.strictEqual(microsoft.visits.at(-1).params.get('login_hint'), UNI);
  assert.deepStrictEqual([s.accounts.length, byEmail(s, UNI).id, byEmail(s, UNI).needsSignIn], [3, ids[UNI], false]);
  res = await api.loadInbox();
  assert.ok(res.accounts.every((a) => !a.error && !a.needsSignIn));
  assert.ok(res.emails.some((m) => m.accountId === ids[UNI]));
});

test('a mailbox Microsoft refuses says why, and recovers by itself', async () => {
  microsoft.mailbox(OUTLOOK).forbidden = true;
  let res;
  try {
    res = await api.loadInbox();
  } finally {
    microsoft.mailbox(OUTLOOK).forbidden = false;
  }
  const outlook = res.accounts.find((a) => a.email === OUTLOOK);
  assert.match(outlook.error, /didn't let ClearMail into this mailbox.*organisation may be blocking ClearMail/);
  assert.strictEqual(outlook.needsSignIn, true);
  res = await api.loadInbox();
  assert.ok(res.accounts.every((a) => !a.error && !a.needsSignIn));
});

test('Graph pages are followed up to the limit', async () => {
  microsoft.pageSize = 1;
  await api.saveSettings({ limit: 2 });
  const before = microsoft.requests.length;
  const res = await api.loadInbox();
  const pages = microsoft.requests.slice(before).filter((r) => r.path === '/v1.0/me/mailFolders/inbox/messages');
  assert.deepStrictEqual(pages.map((r) => r.mailbox).sort(), [OUTLOOK, OUTLOOK, UNI, UNI].sort());
  assert.deepStrictEqual(res.emails.filter((m) => m.accountId === ids[OUTLOOK]).map((m) => m.subject), ['Quote for the kitchen', 'Sunday lunch?'], 'the newest two');
  microsoft.pageSize = 1000;
  await api.saveSettings({ limit: 60 });
});

test('sign-in problems reach the user as plain sentences; Cancel stops waiting', async () => {
  microsoft.choose = () => ({ error: 'access_denied', description: 'AADSTS90094: An administrator of Loughborough University has set a policy that prevents you from granting ClearMail the permissions it is requesting.' });
  await assert.rejects(api.signInMicrosoft(), (err) => /^Your organisation \(for example your university's IT team\) has to approve ClearMail/.test(message(err))
    && /forward this mailbox's email to your personal Outlook account/.test(message(err)));
  await microsoft.browsing;
  assert.match(microsoft.visits.at(-1).page, /Signing in didn(?:&#39;|')t finish/);

  microsoft.choose = () => ({ hang: true }); // the user leaves the browser tab open
  const count = opened.length;
  const waiting = api.signInMicrosoft();
  while (opened.length === count) await new Promise((r) => setTimeout(r, 5)); // the browser has opened
  await assert.rejects(api.signInMicrosoft(), (err) => /already waiting for you to sign in/.test(message(err)));
  await api.cancelSignIn();
  await assert.rejects(waiting, (err) => message(err) === 'Signing in to Microsoft was cancelled.');
  assert.ok(await portClosed(Number(new URL(microsoft.visits.at(-1).params.get('redirect_uri')).port)));
  assert.strictEqual((await api.getSettings()).accounts.length, 3, 'nothing was added');
});

test('after a restart, the saved sign-ins still work without signing in again', async () => {
  const latest = { [OUTLOOK]: microsoft.mailbox(OUTLOOK).latestRefreshToken, [UNI]: microsoft.mailbox(UNI).latestRefreshToken };
  const used = microsoft.refreshTokensUsed.length;
  await launch();
  const s = await api.getSettings();
  assert.deepStrictEqual(s.accounts.map((a) => [a.email, a.needsSignIn, a.locked]), [[OUTLOOK, false, false], [UNI, false, false], [GMAIL, false, false]]);
  assert.strictEqual(s.msClientId, CLIENT_ID);
  const res = await api.loadInbox();
  assert.ok(res.accounts.every((a) => !a.error));
  assert.strictEqual(res.emails.length, 6);
  // The first refresh after the restart used the newest token each account had been given.
  const after = microsoft.refreshTokensUsed.slice(used);
  assert.deepStrictEqual(after.map((r) => r.token).sort(), [latest[OUTLOOK], latest[UNI]].sort());
});

test('removing an account drops it and its emails; the others stay', async () => {
  const before = await api.loadInbox();
  const uniEmail = before.emails.find((m) => m.accountId === ids[UNI]);
  const uniToken = ciphertext(microsoft.mailbox(UNI).latestRefreshToken);
  const s = await api.removeAccount(ids[UNI]);
  assert.deepStrictEqual(s.accounts.map((a) => a.email), [OUTLOOK, GMAIL]);
  assert.ok(!settingsFile().includes(UNI) && !settingsFile().includes(uniToken));
  await assert.rejects(api.reply(uniEmail.id, 'hi'), (err) => /no longer in your inbox/.test(message(err)));
  const requests = microsoft.requests.length;
  const res = await api.loadInbox();
  assert.ok(!res.emails.some((m) => m.accountId === ids[UNI]));
  assert.ok(!microsoft.requests.slice(requests).some((r) => r.mailbox === UNI));
  assert.deepStrictEqual(res.accounts.map((a) => a.email), [OUTLOOK, GMAIL]);

  await api.removeAccount(ids[OUTLOOK]);
  const last = await api.removeAccount(ids[GMAIL]);
  assert.deepStrictEqual([last.accounts, last.demoActive, last.demoReason], [[], true, 'no-account']);
  assert.strictEqual((await api.loadInbox()).demo, true);
});

test('no token or sign-in code was ever logged or saved in plain text', () => {
  assert.ok(printed.length > 0, 'the failures above were logged');
  for (const line of printed) assert.ok(!line.includes('SECRET'), `secret in the log: ${line}`);
  for (const name of fs.readdirSync(dir)) {
    assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes('SECRET'), `secret in ${name}`);
  }
});
