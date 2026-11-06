// End to end: the real main.js, preload.js, src/store.js, src/view.js and src/microsoft.js
// together under a fake electron, against test/helpers/microsoft-server.js standing in for
// Microsoft's sign-in and Graph at their real https addresses. The test plays the user's
// browser. The IMAP backend is stubbed here (test/mail.test.js runs it against mock servers).
//
// The stand-in answers anything that would change a mailbox with 405 and records it, so
// these tests also check that ClearMail only ever reads, and replies when the user sends.
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
const pushes = []; // [channel, data] pushed to the window
let api = null;
let microsoft = null; // the mock Microsoft
const fakeElectron = {
  app: {
    getPath: () => dir, whenReady: () => Promise.resolve(), isReady: () => true, on() {}, quit() {}, focus() {}, requestSingleInstanceLock: () => true,
    getLocale: () => 'en-GB', setLoginItemSettings() {}, getLoginItemSettings: () => ({ status: 'not-registered', wasOpenedAtLogin: false }),
  },
  BrowserWindow: class {
    constructor() { this.webContents = { isDestroyed: () => false, send: (channel, data) => pushes.push([channel, structuredClone(data)]), setWindowOpenHandler() {}, on() {} }; }
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bySubject = (res, subject) => res.emails.find((m) => m.subject === subject);
const pushesOf = (channel) => pushes.filter((p) => p[0] === channel).map((p) => p[1]);

function portClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
  });
}

const ids = {}; // account ids by address
const userReplies = []; // Graph message ids the user pressed Send for (and didn't undo)

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

test('signing in through the browser adds the Outlook account, asking only to read and send', async () => {
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
  assert.deepStrictEqual(p.get('scope').split(' ').sort(), ['email', `${GRAPH}Mail.Read`, `${GRAPH}Mail.Send`, `${GRAPH}User.Read`, 'offline_access', 'openid', 'profile']);
  assert.ok(!/ReadWrite/i.test(p.get('scope')), 'never asks for permission to change the mailbox');
  assert.strictEqual(visit.status, 200);
  assert.match(visit.page, /You(?:&#39;|')re signed in/);
  assert.ok(await portClosed(Number(new URL(p.get('redirect_uri')).port)), 'the sign-in web server is closed');

  const account = byEmail(s, OUTLOOK);
  assert.deepStrictEqual(
    [account.kind, account.name, account.provider, account.signedIn, account.needsSignIn, account.hasPass, account.personal, account.upgrade],
    ['microsoft', 'Will Wright', 'microsoft', true, false, false, true, null],
  );
  assert.deepStrictEqual(account.grantedScopes, ['Mail.Read', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile']);
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
  assert.deepStrictEqual(library.replyTo, { name: 'Library', address: 'library@lboro.ac.uk' });
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

test('a reply waits 5 seconds, can be undone, and goes out from the account that received the email', async () => {
  const res = await api.loadInbox();
  const get = (subject) => bySubject(res, subject);
  const requests = microsoft.requests.length;
  pushes.length = 0;
  await api.reply(get('Project meeting').id, 'Thursday at 3pm works for me.');
  await api.reply(get('Quote for the kitchen').id, 'Signed copy attached tomorrow.');
  await api.reply(get('Climbing on Saturday').id, 'Yes!');
  await api.reply(get('Sunday lunch?').id, 'Sent to Dad by mistake');
  assert.deepStrictEqual(await api.undoReply(get('Sunday lunch?').id), { undone: true });
  userReplies.push(['AAMkADU1-u1', UNI], ['AAMkAGI2-o1/Zx+Q==', OUTLOOK]);

  await delay(4500);
  assert.ok(!microsoft.requests.slice(requests).some((r) => r.method !== 'GET' && /\/reply$/.test(r.path)), 'nothing is sent before 5 seconds');
  assert.ok(!imap.calls.some((c) => c[0] === 'sendReply'));
  for (let i = 0; i < 100 && pushesOf('reply:result').length < 3; i++) await delay(20);

  assert.deepStrictEqual(pushesOf('reply:result').map((r) => r.ok), [true, true, true]);
  assert.deepStrictEqual(microsoft.replies.map((r) => [r.mailbox, r.id]).sort(), [[UNI, 'AAMkADU1-u1'], [OUTLOOK, 'AAMkAGI2-o1/Zx+Q==']]);
  assert.deepStrictEqual(microsoft.replies.find((r) => r.id === 'AAMkADU1-u1').body, {
    message: { toRecipients: [{ emailAddress: { address: SARAH[1], name: SARAH[0] } }], body: { contentType: 'text', content: 'Thursday at 3pm works for me.' } },
  });
  for (const r of microsoft.replies) assert.deepStrictEqual(r.to, [SARAH[1]], 'to the one address the reply box named');
  assert.deepStrictEqual(imap.calls.filter((c) => c[0] === 'sendReply'), [['sendReply', GMAIL, 'fp-1-41', 'Yes!']]);
  assert.ok(!microsoft.replies.some((r) => r.id === 'AAMkAGI2-o3'), 'the undone reply was never sent');

  // Replied emails move to Done, with "You've already replied".
  const after = await api.loadInbox();
  for (const subject of ['Project meeting', 'Quote for the kitchen', 'Climbing on Saturday']) {
    assert.strictEqual(bySubject(after, subject).done, true, subject);
    assert.strictEqual(bySubject(after, subject).triage.codes[0], 'replied', subject);
  }
  assert.strictEqual(bySubject(after, 'Sunday lunch?').done, false);
});

test('a reply goes to exactly the address the reply box names, even when an email lists several Reply-To addresses', async () => {
  // A crafted email: Graph, left to itself, would reply to both Reply-To addresses.
  const box = microsoft.mailbox(OUTLOOK);
  box.messages.push(graphMessage({
    id: 'AAMkAGI2-o5', from: ['Kestrel Bank', 'alerts@kestrelbank.example'], subject: 'Verify your payee', minutesAgo: 6000,
    replyTo: [['Kestrel Bank Support', 'support@kestrel-help.example'], ['Collections', 'collector@attacker.example']],
    text: 'Please reply with your sort code to verify your payee.',
  }));
  try {
    const res = await api.loadInbox({ force: true });
    const bank = bySubject(res, 'Verify your payee');
    const library = bySubject(res, 'Library loan overdue');
    assert.deepStrictEqual(bank.replyTarget, { name: 'Kestrel Bank Support', address: 'support@kestrel-help.example' });
    assert.strictEqual(bank.replyNote, 'Replies go to support@kestrel-help.example, not the address it came from.');
    assert.deepStrictEqual([library.replyTarget, library.replyNote], [{ name: 'Library', address: 'library@lboro.ac.uk' }, null]);
    const before = microsoft.replies.length;
    await api.reply(bank.id, 'My sort code is 12-34-56');
    await api.reply(library.id, 'Returned it today.');
    userReplies.push(['AAMkAGI2-o5', OUTLOOK], ['AAMkADU1-u2', UNI]);
    for (let i = 0; i < 400 && microsoft.replies.length < before + 2; i++) await delay(20);
    const sent = microsoft.replies.slice(before);
    assert.deepStrictEqual(sent.map((r) => r.id).sort(), ['AAMkADU1-u2', 'AAMkAGI2-o5']);
    assert.deepStrictEqual(sent.find((r) => r.id === 'AAMkAGI2-o5').to, [bank.replyTarget.address], 'never the attacker\'s address');
    assert.deepStrictEqual(sent.find((r) => r.id === 'AAMkADU1-u2').to, [library.replyTarget.address]);
  } finally {
    box.messages = box.messages.filter((m) => m.id !== 'AAMkAGI2-o5');
  }
});

test('every Graph call was a read, a batch of reads, or a reply the user sent', () => {
  assert.deepStrictEqual(microsoft.refused, [], 'the stand-in refused nothing');
  for (const r of microsoft.requests) {
    const what = `${r.method} ${r.path}`;
    if (r.method === 'GET') continue;
    if (what === 'POST /common/oauth2/v2.0/token' || what === 'POST /v1.0/$batch') continue;
    const reply = /^POST \/v1\.0\/me\/messages\/([^/]+)\/reply$/.exec(what);
    assert.ok(reply, `unexpected ${what}`);
    assert.ok(userReplies.some(([id, mailbox]) => id === decodeURIComponent(reply[1]) && mailbox === r.mailbox), `a reply nobody sent: ${what}`);
  }
  assert.ok(microsoft.batchRequests.length > 0);
  for (const r of microsoft.batchRequests) {
    assert.strictEqual(r.method, 'GET');
    assert.match(r.url, /^\/me\/messages\/[^/?]+\?\$select=internetMessageHeaders$/);
  }
  const replies = microsoft.requests.filter((r) => r.method === 'POST' && /\/reply$/.test(r.path));
  assert.strictEqual(replies.length, userReplies.length, 'one request per reply sent');
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
  // Its emails stay as they were last loaded; replying asks to sign in again and sends nothing.
  const kept = res.emails.filter((m) => m.accountId === ids[UNI]);
  assert.deepStrictEqual(kept.map((m) => m.subject).sort(), ['Library loan overdue', 'Project meeting']);
  const replies = microsoft.replies.length;
  await assert.rejects(api.reply(kept.find((m) => m.subject === 'Library loan overdue').id, 'Hello?'), (err) => message(err) === uni.error);
  assert.strictEqual(microsoft.replies.length, replies);

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
  await assert.rejects(api.reply(uniEmail.id, 'hi'), (err) => /no longer in your inbox/.test(message(err)));
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
  assert.deepStrictEqual([disk.accounts[1].smtpHost, disk.accounts[1].smtpPort, disk.accounts[1].smtpSecurity], ['smtp.example.org', 587, 'starttls']);
  let s = await api.getSettings();
  const outlook = byEmail(s, OUTLOOK);
  assert.deepStrictEqual([outlook.needsSignIn, outlook.upgrade, outlook.signedIn], [true, 'reconnect', false]);

  imap.inbox = [];
  const res = await api.loadInbox({ force: true });
  const row = res.accounts.find((a) => a.email === OUTLOOK);
  assert.deepStrictEqual([row.needsSignIn, row.error], [true, `ClearMail no longer needs permission to change your mailbox. Click "Sign in again" to reconnect ${OUTLOOK}.`]);
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
    assert.ok(!/Could you send the signed quote|Thursday at 3pm works/.test(text), `email text in ${name}`);
  }
});
