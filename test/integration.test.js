// End to end: the real main.js, preload.js, src/store.js, src/view.js and src/microsoft.js
// together under a fake electron, against test/helpers/microsoft-server.js standing in for
// Microsoft's sign-in and Graph at their real https addresses. The test plays the user's
// browser. The IMAP backend is stubbed here (test/mail.test.js runs it against mock servers).
//
// The stand-in answers anything that would change a mailbox (or send from it) with 405 and
// records it, so these tests also check that ClearMail only ever reads.
process.env.TZ = 'Europe/London';
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const util = require('util');
const Module = require('module');
const { startMicrosoft, graphMessage, sentMessage } = require('./helpers/microsoft-server');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearmail-e2e-'));
const CLIENT_ID = '0b5f6c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
const OUTLOOK = 'willw6311@outlook.com';
const UNI = 'cvww@lunet.lboro.ac.uk';
const GMAIL = 'will.wright@gmail.com';
const SARAH = ['Sarah Collins', 'sarah.collins@brightside.co.uk'];
const GRAPH = 'https://graph.microsoft.com/';

// Everything printed is kept, to check no token or sign-in code ever reaches a log.
const printed = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => printed.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '));
}

// ---------- fake electron ----------

const handlers = new Map();
const opened = []; // what main asked shell.openExternal to open
const copied = []; // what main put on the clipboard
let api = null;
let microsoft = null; // the mock Microsoft
const fakeElectron = {
  app: {
    getPath: () => dir, whenReady: () => Promise.resolve(), isReady: () => true, on() {}, quit() {}, focus() {}, requestSingleInstanceLock: () => true,
    getLocale: () => 'en-GB', setLoginItemSettings() {}, getLoginItemSettings: () => ({ status: 'not-registered', wasOpenedAtLogin: false }),
  },
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
      if (url.startsWith('https://login.microsoftonline.com/')) microsoft.openBrowser(url);
    },
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  clipboard: { writeText: (text) => copied.push(text) },
  Notification: class extends EventEmitter { static isSupported() { return true; } show() {} },
  powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' }),
  net: { isOnline: () => true },
  nativeTheme: { shouldUseDarkColors: false },
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
      PROVIDERS: real.PROVIDERS,
      fetchInbox: async (account, opts) => { imap.calls.push(['fetchInbox', account.user, opts]); return structuredClone(imap.inbox); },
      fetchSentHistory: async (account, cursor) => {
        imap.calls.push(['fetchSentHistory', account.user, cursor]);
        return { cursor: { kind: 'imap', path: '[Gmail]/Sent Mail', uidValidity: '7', lastUid: 3, fullAt: Date.now() }, full: !cursor, entries: [] };
      },
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bySubject = (res, subject) => res.emails.find((m) => m.subject === subject);
// A scope as Microsoft compares it: Graph's prefix dropped.
const shortScope = (s) => (s.startsWith(GRAPH) ? s.slice(GRAPH.length) : s);

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
      graphMessage({ id: 'AAMkAGI2-o1/Zx+Q==', from: SARAH, to: [['Will Wright', OUTLOOK]], subject: 'Quote for the kitchen', minutesAgo: 300, text: 'Hi Will,\r\n\r\nCould you send the signed quote back by Friday?\r\n\r\nThanks,\r\nSarah' }),
      graphMessage({ id: 'AAMkAGI2-o2', from: ['Amazon.co.uk', 'shipment-tracking@amazon.co.uk'], subject: 'Your order has shipped', minutesAgo: 2000, isRead: true, text: 'Your parcel is on its way and arrives Tuesday.' }),
      graphMessage({
        id: 'AAMkAGI2-o3', from: ['Dad', 'dad@example.com'], subject: 'Sunday lunch?', minutesAgo: 30, text: 'Are you coming on Sunday? Menu attached.',
        attachments: [
          { name: 'image001.png', size: 4000, isInline: true, contentType: 'image/png' },
          { name: 'Menu.pdf', size: 20480, isInline: false, contentType: 'application/pdf' },
        ],
      }),
      graphMessage({
        id: 'AAMkAGI2-o4', from: ['Weekly Deals', 'deals@shop.example'], subject: 'New in this week', minutesAgo: 600, focused: false,
        text: 'New arrivals in our shop this week.', headers: { 'List-Unsubscribe': '<https://shop.example/unsubscribe>', 'List-Id': '<deals.shop.example>' },
      }),
    ],
    sent: [
      sentMessage({ id: 'S1', to: [SARAH], minutesAgo: 5000, conversationId: 'conv-old-quote' }),
      sentMessage({ id: 'S2', to: [SARAH], cc: [['Dad', 'dad@example.com']], minutesAgo: 4000 }),
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
    id: 'fp-1-41', messageId: '<g41@mail.gmail.com>', uid: 41, from: { name: 'Priya', address: 'priya@example.com' }, replyTo: null, to: [{ name: 'Will', address: GMAIL }], cc: [],
    subject: 'Climbing on Saturday', date: hoursAgo(3), receivedAt: hoursAgo(3), text: 'Are you still up for climbing on Saturday?', html: '', seen: false, flagged: false,
    references: [], attachments: [], headers: { listUnsubscribe: null, listId: null, precedence: null, autoSubmitted: null }, importance: 'normal', focused: null,
    conversationId: null, inReplyTo: null, webLink: null,
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
  assert.ok(res.emails.some((m) => m.triage.bucket === 'needs-you') && res.emails.some((m) => m.triage.bucket === 'noise'));

  if (!s.msClientIdBuiltIn) {
    await assert.rejects(api.signInMicrosoft(), (err) => /needs a Microsoft app ID/.test(message(err)));
    assert.strictEqual(opened.length, 0);
  }
  const saved = await api.saveSettings({ msClientId: ` ${CLIENT_ID.toUpperCase()} ` });
  assert.strictEqual(saved.msClientId, CLIENT_ID);
});

test('signing in through the browser adds the Outlook account, asking only to read', async () => {
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
  assert.deepStrictEqual(p.get('scope').split(' ').map(shortScope).sort(), ['Mail.Read', 'User.Read', 'email', 'offline_access', 'openid', 'profile']);
  assert.ok(!/Mail\.Send|ReadWrite/i.test(p.get('scope')), 'never asks for permission to send or to change the mailbox');
  assert.strictEqual(visit.status, 200);
  assert.match(visit.page, /You(?:&#39;|')re signed in/);
  assert.ok(await portClosed(Number(new URL(p.get('redirect_uri')).port)), 'the sign-in web server is closed');

  const account = byEmail(s, OUTLOOK);
  assert.deepStrictEqual(
    [account.kind, account.name, account.provider, account.signedIn, account.needsSignIn, account.hasPass, account.personal, account.upgrade],
    ['microsoft', 'Will Wright', 'microsoft', true, false, false, true, null],
  );
  assert.deepStrictEqual(account.grantedScopes, ['Mail.Read', 'User.Read', 'email', 'openid', 'profile']);
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
  assert.strictEqual(byEmail(s, UNI).personal, false, 'a work or school account');
  s = await api.saveAccount({ provider: 'gmail', user: GMAIL, pass: 'SECRET-app-password' });
  assert.deepStrictEqual(s.accounts.map((a) => [a.email, a.kind]), [[OUTLOOK, 'microsoft'], [UNI, 'microsoft'], [GMAIL, 'imap']]);
  for (const a of s.accounts) ids[a.email] = a.id;

  // Signing in to an address already added updates it instead of adding a copy.
  microsoft.choose = () => ({ email: OUTLOOK });
  s = await api.signInMicrosoft();
  await microsoft.browsing;
  assert.strictEqual(s.accounts.length, 3);
});

test('one Brief: every account loads, ids carry the account, and the emails are sorted with reasons', async () => {
  const res = await api.loadInbox({ force: true });
  assert.deepStrictEqual([res.demo, res.demoReason], [false, null]);
  assert.deepStrictEqual(res.accounts, [
    { id: ids[OUTLOOK], email: OUTLOOK, kind: 'microsoft', error: null, needsSignIn: false, readOnly: true },
    { id: ids[UNI], email: UNI, kind: 'microsoft', error: null, needsSignIn: false, readOnly: true },
    { id: ids[GMAIL], email: GMAIL, kind: 'imap', error: null, needsSignIn: false, readOnly: true },
  ]);
  assert.deepStrictEqual(res.emails.map((m) => m.subject).sort(), [
    'Climbing on Saturday', 'Library loan overdue', 'New in this week', 'Project meeting', 'Quote for the kitchen', 'Sunday lunch?', 'Your order has shipped',
  ]);
  for (const m of res.emails) {
    const address = Object.keys(ids).find((a) => ids[a] === m.accountId);
    assert.strictEqual(m.accountEmail, address);
    assert.ok(m.id.startsWith(`${m.accountId}:`));
  }
  const quote = bySubject(res, 'Quote for the kitchen');
  assert.strictEqual(quote.id, `${ids[OUTLOOK]}:AAMkAGI2-o1/Zx+Q==`);
  assert.deepStrictEqual(quote.from, { name: 'Sarah Collins', address: SARAH[1] });
  assert.strictEqual(quote.original, 'Hi Will,\n\nCould you send the signed quote back by Friday?\n\nThanks,\nSarah');
  assert.strictEqual(quote.canOpen, true);
  // Sorted with what Graph, the mailing-list headers and the Sent folder say.
  assert.strictEqual(quote.triage.bucket, 'needs-you');
  assert.deepStrictEqual(quote.triage.codes.slice(0, 1), ['asks-question']);
  assert.ok(quote.triage.reasons.includes("You've written to them 2 times"), quote.triage.reasons.join(' / '));
  assert.ok(quote.triage.deadline, 'by Friday');
  assert.strictEqual(bySubject(res, 'Sunday lunch?').triage.bucket, 'needs-you');
  assert.ok(bySubject(res, 'Sunday lunch?').triage.reasons.includes("You've written to them once"));
  const deals = bySubject(res, 'New in this week');
  assert.deepStrictEqual([deals.triage.bucket, deals.isNew], ['noise', true]);
  assert.strictEqual(bySubject(res, 'Climbing on Saturday').triage.bucket, 'needs-you');
  assert.strictEqual(bySubject(res, 'Project meeting').from.address, SARAH[1], 'Sarah writes to both Microsoft accounts');
  assert.deepStrictEqual(bySubject(res, 'Sunday lunch?').attachments, [{ filename: 'Menu.pdf', size: 20480 }], 'inline images are not attachments');
  const library = bySubject(res, 'Library loan overdue');
  assert.match(library.original, /Your library loan is overdue\. Please return it by 20 October\./);
  assert.ok(!/<b>/.test(library.original), 'HTML is shown as text');
  assert.notStrictEqual(library.triage.bucket, 'noise', 'an overdue notice is never hidden');
  assert.deepStrictEqual([bySubject(res, 'Your order has shipped').seen, bySubject(res, 'Sunday lunch?').seen], [true, false]);
  assert.deepStrictEqual(imap.calls.find((c) => c[0] === 'fetchInbox'), ['fetchInbox', GMAIL, { limit: 60 }]);
  assert.deepStrictEqual(imap.calls.find((c) => c[0] === 'fetchSentHistory'), ['fetchSentHistory', GMAIL, null]);

  // Mailing-list headers come one message at a time inside GET-only batches, once per email.
  const batched = microsoft.batches.filter((b) => b.mailbox === OUTLOOK).flatMap((b) => b.ids).sort();
  assert.deepStrictEqual(batched, ['AAMkAGI2-o1/Zx+Q==', 'AAMkAGI2-o2', 'AAMkAGI2-o3', 'AAMkAGI2-o4']);
  const s = await api.getSettings();
  assert.deepStrictEqual(s.canSee, { emails: 7, withListHeaders: 1, focusedOther: true, people: 2 });
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

test('Copy subject and Done stay in ClearMail: nothing reaches Microsoft or the mailbox', async () => {
  const res = await api.loadInbox();
  const quote = bySubject(res, 'Quote for the kitchen');
  const climbing = bySubject(res, 'Climbing on Saturday');
  const requests = microsoft.requests.length;
  const imapCalls = imap.calls.length;
  copied.length = 0;
  assert.deepStrictEqual(await api.copySubject(quote.id), { copied: true });
  assert.deepStrictEqual(await api.copySubject(climbing.id), { copied: true });
  assert.deepStrictEqual(copied, ['Quote for the kitchen', 'Climbing on Saturday'], 'ready to paste into Outlook\'s search');
  const done = await api.setDone([quote.id], true);
  assert.strictEqual(bySubject(done, 'Quote for the kitchen').done, true);
  assert.strictEqual(microsoft.requests.length, requests, 'no request to Microsoft');
  assert.strictEqual(imap.calls.length, imapCalls, 'none to the mail server');
  assert.strictEqual(bySubject(await api.loadInbox(), 'Quote for the kitchen').seen, false, 'still unread in Outlook');
});

test('a reply made in Outlook is noticed as soon as Refresh is pressed', async () => {
  const before = await api.loadInbox();
  assert.strictEqual(bySubject(before, 'Project meeting').triage.bucket, 'needs-you');
  // The user found the email in Outlook (by its subject) and replied there.
  microsoft.mailbox(UNI).sent.push(sentMessage({ id: 'S-u1', to: [SARAH], minutesAgo: 1, conversationId: 'conv-AAMkADU1-u1' }));
  const sentReads = microsoft.requests.filter((r) => r.path === '/v1.0/me/mailFolders/sentitems/messages').length;
  const res = await api.loadInbox({ force: true });
  assert.ok(microsoft.requests.filter((r) => r.path === '/v1.0/me/mailFolders/sentitems/messages').length > sentReads, 'the Sent folders were read again');
  const meeting = bySubject(res, 'Project meeting');
  assert.notStrictEqual(meeting.triage.bucket, 'needs-you');
  assert.deepStrictEqual([meeting.triage.codes[0], meeting.triage.reasons[0]], ['replied', "You've already replied"]);
  assert.strictEqual(meeting.done, false);
  assert.strictEqual(bySubject(res, 'Climbing on Saturday').triage.bucket, 'needs-you', 'other emails are as they were');
  assert.deepStrictEqual(microsoft.refused, [], 'and ClearMail itself sent nothing');
});

test('every Graph call was a read or a batch of reads, and Microsoft was never asked for more', () => {
  assert.deepStrictEqual(microsoft.refused, [], 'the stand-in refused nothing');
  const graphCalls = microsoft.requests.filter((r) => r.path !== '/common/oauth2/v2.0/token');
  assert.ok(graphCalls.length > 10);
  for (const r of graphCalls) {
    const what = `${r.method} ${r.path}`;
    assert.ok(r.method === 'GET' || what === 'POST /v1.0/$batch', `unexpected ${what}`);
  }
  assert.ok(microsoft.batchRequests.length > 0);
  for (const r of microsoft.batchRequests) {
    assert.strictEqual(r.method, 'GET');
    assert.match(r.url, /^\/me\/messages\/[^/?]+\?\$select=internetMessageHeaders$/);
  }
  // Every sign-in page and every token ClearMail asked for: read only.
  const asked = [...microsoft.visits.map((v) => v.params.get('scope')), ...microsoft.tokenScopes.map((t) => t.requested)];
  assert.ok(asked.length > 3);
  for (const scope of asked) {
    assert.ok(!/Mail\.Send|ReadWrite/i.test(scope), scope);
    assert.deepStrictEqual(scope.split(' ').map(shortScope).sort(), ['Mail.Read', 'User.Read', 'email', 'offline_access', 'openid', 'profile']);
  }
});

test('a revoked sign-in only affects that account, and "Sign in again" fixes it', async () => {
  microsoft.revokeAll(UNI); // e.g. the university password was changed
  let res = await api.loadInbox({ force: true });
  const uni = res.accounts.find((a) => a.email === UNI);
  assert.deepStrictEqual(uni, {
    id: ids[UNI], email: UNI, kind: 'microsoft', needsSignIn: true, readOnly: true,
    error: `Microsoft needs you to sign in to ${UNI} again. Use "Sign in again" to reconnect it.`,
  });
  assert.ok(res.accounts.filter((a) => a.email !== UNI).every((a) => !a.error));
  assert.ok(res.emails.some((m) => m.accountId === ids[OUTLOOK]));
  assert.strictEqual(byEmail(await api.getSettings(), UNI).needsSignIn, true);
  // Its emails stay as they were last loaded, and Copy subject still works for them.
  const kept = res.emails.filter((m) => m.accountId === ids[UNI]);
  assert.deepStrictEqual(kept.map((m) => m.subject).sort(), ['Library loan overdue', 'Project meeting']);
  copied.length = 0;
  assert.deepStrictEqual(await api.copySubject(kept.find((m) => m.subject === 'Library loan overdue').id), { copied: true });
  assert.deepStrictEqual(copied, ['Library loan overdue']);

  microsoft.choose = () => ({ email: UNI });
  const s = await api.signInMicrosoft({ accountId: ids[UNI] });
  await microsoft.browsing;
  assert.strictEqual(microsoft.visits.at(-1).params.get('login_hint'), UNI);
  assert.deepStrictEqual([s.accounts.length, byEmail(s, UNI).id, byEmail(s, UNI).needsSignIn], [3, ids[UNI], false]);
  res = await api.loadInbox({ force: true });
  assert.ok(res.accounts.every((a) => !a.error && !a.needsSignIn));
  assert.ok(res.emails.some((m) => m.accountId === ids[UNI]));
});

test('a mailbox Microsoft refuses says why, and recovers by itself', async () => {
  microsoft.mailbox(OUTLOOK).forbidden = true;
  let res;
  try {
    res = await api.loadInbox({ force: true });
  } finally {
    microsoft.mailbox(OUTLOOK).forbidden = false;
  }
  const outlook = res.accounts.find((a) => a.email === OUTLOOK);
  assert.match(outlook.error, /didn't let ClearMail into this mailbox.*organisation may be blocking ClearMail/);
  assert.strictEqual(outlook.needsSignIn, true);
  res = await api.loadInbox({ force: true });
  assert.ok(res.accounts.every((a) => !a.error && !a.needsSignIn));
});

test('Graph pages are followed up to the limit', async () => {
  microsoft.pageSize = 1;
  await api.saveSettings({ limit: 2 });
  const before = microsoft.requests.length;
  const res = await api.loadInbox();
  const pages = microsoft.requests.slice(before).filter((r) => r.path === '/v1.0/me/mailFolders/inbox/messages');
  assert.deepStrictEqual(pages.map((r) => r.mailbox).sort(), [OUTLOOK, OUTLOOK, UNI, UNI].sort());
  assert.deepStrictEqual(res.emails.filter((m) => m.accountId === ids[OUTLOOK]).map((m) => m.subject).sort(), ['Quote for the kitchen', 'Sunday lunch?'], 'the newest two');
  microsoft.pageSize = 1000;
  await api.saveSettings({ limit: 60 });
});

test('sign-in problems reach the user as plain sentences; Cancel stops waiting', async () => {
  microsoft.choose = () => ({ error: 'access_denied', description: 'AADSTS90094: An administrator of Loughborough University has set a policy that prevents you from granting ClearMail the permissions it is requesting.' });
  await assert.rejects(api.signInMicrosoft(), (err) => /^Your organisation \(for example your university's IT team\) has to approve ClearMail/.test(message(err))
    && /keep reading this mailbox in Outlook/.test(message(err)) && !/forward/.test(message(err)));
  await microsoft.browsing;
  assert.match(microsoft.visits.at(-1).page, /Signing in didn(?:&#39;|')t finish/);

  microsoft.choose = () => ({ hang: true }); // the user leaves the browser tab open
  const count = opened.length;
  const waiting = api.signInMicrosoft();
  while (opened.length === count) await delay(5); // the browser has opened
  await assert.rejects(api.signInMicrosoft(), (err) => /already waiting for you to sign in/.test(message(err)));
  await api.cancelSignIn();
  await assert.rejects(waiting, (err) => message(err) === 'Signing in to Microsoft was cancelled.');
  assert.ok(await portClosed(Number(new URL(microsoft.visits.at(-1).params.get('redirect_uri')).port)));
  assert.strictEqual((await api.getSettings()).accounts.length, 3, 'nothing was added');
});

test('after a restart, the saved sign-ins, sorting and Sent history are still there', async () => {
  const latest = { [OUTLOOK]: microsoft.mailbox(OUTLOOK).latestRefreshToken, [UNI]: microsoft.mailbox(UNI).latestRefreshToken };
  const used = microsoft.refreshTokensUsed.length;
  await launch();
  const s = await api.getSettings();
  assert.deepStrictEqual(s.accounts.map((a) => [a.email, a.needsSignIn, a.locked]), [[OUTLOOK, false, false], [UNI, false, false], [GMAIL, false, false]]);
  assert.strictEqual(s.msClientId, CLIENT_ID);
  const res = await api.loadInbox();
  assert.ok(res.accounts.every((a) => !a.error));
  assert.strictEqual(res.emails.length, 7);
  assert.strictEqual(bySubject(res, 'Quote for the kitchen').done, true, 'Done is kept');
  assert.ok(bySubject(res, 'Sunday lunch?').triage.reasons.includes("You've written to them once"), 'the Sent history is kept');
  // The first refresh after the restart used the newest token each account had been given.
  const after = microsoft.refreshTokensUsed.slice(used);
  assert.deepStrictEqual(after.map((r) => r.token).sort(), [latest[OUTLOOK], latest[UNI]].sort());
  // The Sent folder carried on from where it was (only newer mail is asked for).
  const sent = microsoft.requests.filter((r) => r.path === '/v1.0/me/mailFolders/sentitems/messages');
  assert.ok(sent.length >= 2);
  assert.deepStrictEqual(microsoft.refused, []);
});

test('removing an account drops it, its emails and its history; the others stay', async () => {
  const before = await api.loadInbox();
  const uniEmail = before.emails.find((m) => m.accountId === ids[UNI]);
  const uniToken = ciphertext(microsoft.mailbox(UNI).latestRefreshToken);
  const s = await api.removeAccount(ids[UNI]);
  assert.deepStrictEqual(s.accounts.map((a) => a.email), [OUTLOOK, GMAIL]);
  assert.ok(!settingsFile().includes(UNI) && !settingsFile().includes(uniToken));
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8')), ids[UNI]));
  assert.ok(!fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(`${ids[UNI]}:`));
  await assert.rejects(api.copySubject(uniEmail.id), (err) => message(err) === 'This email is no longer in your inbox. Refresh and try again.');
  const requests = microsoft.requests.length;
  const res = await api.loadInbox({ force: true });
  assert.ok(!res.emails.some((m) => m.accountId === ids[UNI]));
  assert.ok(!microsoft.requests.slice(requests).some((r) => r.mailbox === UNI));
  assert.deepStrictEqual(res.accounts.map((a) => a.email), [OUTLOOK, GMAIL]);

  await api.removeAccount(ids[OUTLOOK]);
  const last = await api.removeAccount(ids[GMAIL]);
  assert.deepStrictEqual([last.accounts, last.demoActive, last.demoReason], [[], true, 'no-account']);
  assert.strictEqual((await api.loadInbox()).demo, true);
});

test('upgrading from 0.2: the old Outlook sign-in is never used, the API key and AI cache go, and Sign in again reconnects', async () => {
  // A 0.2 settings file: its Outlook sign-in was granted Mail.ReadWrite.
  const old = microsoft.issueRefreshToken(OUTLOOK);
  microsoft.mailbox(OUTLOOK).legacyConsent = true; // and Microsoft still remembers that consent
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    version: 2, apiKey: ciphertext('sk-ant-0.2-key'), limit: 60, demo: false, msClientId: CLIENT_ID,
    accounts: [
      { id: 'a1a1a1a1a1a1a1a1', kind: 'microsoft', email: OUTLOOK, name: 'Will Wright', refreshToken: ciphertext(old) },
      { id: 'c3c3c3c3c3c3c3c3', kind: 'imap', provider: 'custom', user: 'me@example.org', pass: ciphertext('pw'), imapHost: 'imap.example.org', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.example.org', smtpPort: 587, smtpSecurity: 'starttls' },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify({ x: { at: 1, summary: { gist: 'From Claude' } } }));
  const used = microsoft.refreshTokensUsed.length;
  await launch();

  const disk = JSON.parse(settingsFile());
  assert.strictEqual(disk.version, 3);
  assert.ok(!('apiKey' in disk));
  assert.ok(!fs.existsSync(path.join(dir, 'summaries.json')));
  assert.ok(!settingsFile().includes(ciphertext(old)), 'the old sign-in is deleted');
  // The IMAP account keeps its settings for reading; its SMTP settings (for sending) go.
  assert.deepStrictEqual([disk.accounts[1].imapHost, disk.accounts[1].imapPort, disk.accounts[1].imapSecurity], ['imap.example.org', 993, 'tls']);
  assert.ok(!Object.keys(disk.accounts[1]).some((k) => /^smtp/i.test(k)), Object.keys(disk.accounts[1]).join(' '));
  let s = await api.getSettings();
  const outlook = byEmail(s, OUTLOOK);
  assert.deepStrictEqual([outlook.needsSignIn, outlook.upgrade, outlook.signedIn], [true, 'reconnect', false]);

  imap.inbox = [];
  const res = await api.loadInbox({ force: true });
  const row = res.accounts.find((a) => a.email === OUTLOOK);
  assert.deepStrictEqual([row.needsSignIn, row.error], [true, `ClearMail no longer needs permission to send email or change your mailbox. Click "Sign in again" to reconnect ${OUTLOOK}.`]);
  assert.strictEqual(microsoft.refreshTokensUsed.length, used, 'the old token was never sent to Microsoft');

  microsoft.choose = () => ({ email: OUTLOOK });
  s = await api.signInMicrosoft({ accountId: 'a1a1a1a1a1a1a1a1' });
  await microsoft.browsing;
  const back = byEmail(s, OUTLOOK);
  assert.deepStrictEqual([back.needsSignIn, back.upgrade], [false, null]);
  // Microsoft still grants the old permission from the 0.2 consent: Settings can say so.
  assert.ok(back.grantedScopes.includes('Mail.ReadWrite'), back.grantedScopes.join(' '));
  opened.length = 0;
  await api.openConsentPage('a1a1a1a1a1a1a1a1');
  assert.deepStrictEqual(opened, ['https://account.live.com/consent/Manage']);
  // Even so, ClearMail only reads.
  await api.loadInbox({ force: true });
  assert.deepStrictEqual(microsoft.refused, []);
  microsoft.mailbox(OUTLOOK).legacyConsent = false;
});

test('no token or sign-in code was ever logged or saved in plain text', () => {
  assert.ok(printed.length > 0, 'the failures above were logged');
  for (const line of printed) assert.ok(!line.includes('SECRET'), `secret in the log: ${line}`);
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!text.includes('SECRET'), `secret in ${name}`);
    assert.ok(!/Could you send the signed quote|Can we move the project meeting/.test(text), `email text in ${name}`);
  }
});
