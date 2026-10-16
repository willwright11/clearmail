// src/microsoft.js against local mock servers standing in for login.microsoftonline.com and
// graph.microsoft.com. The "browser" is the test's openUrl, which visits the redirect URI.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const ms = require('../src/microsoft');

// Whatever the module prints is kept, to check that no token or code ever reaches a log.
const printed = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => printed.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.cause?.message}` : String(a))).join(' '));
}

const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const CODES = ['needs-sign-in', 'admin-approval', 'no-client-id', 'cancelled', 'timeout', 'network', 'throttled', 'server'];
const TIMING = { requestTimeoutMs: 2000, backoffMs: 1, maxRetryWaitMs: 1000 };
const RAW_EMAIL_KEYS = ['attachments', 'date', 'from', 'html', 'id', 'messageId', 'references', 'replyTo', 'seen', 'subject', 'text', 'uid'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');

// A JSON server on a free port. Each test sets mock.handler(request) -> { status, json, headers }
// (or { hang: true } to never answer); every request is kept in mock.requests.
async function mockServer() {
  const mock = { requests: [], handler: () => null };
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://mock');
    const request = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, text: Buffer.concat(chunks).toString() };
    mock.requests.push(request);
    let out;
    try {
      out = (await mock.handler(request)) || { status: 404, json: { error: { code: 'NoRoute', message: `No route for ${req.method} ${url.pathname}` } } };
    } catch (err) {
      out = { status: 500, json: { error: { code: 'MockFailed', message: err.message } } };
    }
    if (out.hang) return;
    res.writeHead(out.status || 200, { 'Content-Type': 'application/json', ...out.headers });
    res.end(out.json === undefined ? '' : JSON.stringify(out.json));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.base = `http://127.0.0.1:${server.address().port}`;
  mock.close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
  return mock;
}

let login;
let graph;
let nextId = 1;

test.before(async () => {
  login = await mockServer();
  graph = await mockServer();
  ms._setEndpoints({ login: login.base, graph: `${graph.base}/` });
  ms._setTiming(TIMING);
});
test.after(() => Promise.all([login.close(), graph.close()]));

// Every test starts with no cached tokens and empty request logs.
function fresh() {
  ms._reset();
  ms._setTiming(TIMING);
  login.requests = [];
  graph.requests = [];
  login.handler = refreshWith();
  graph.handler = () => null;
}

const account = (over = {}) => ({ id: `acc-${nextId++}`, kind: 'microsoft', email: 'willw6311@outlook.com', name: 'Will', refreshToken: 'SECRET-rt-1', ...over });
const opts = (over = {}) => ({ clientId: CLIENT_ID, ...over });
const form = (request) => new URLSearchParams(request.text);
const tokenCalls = () => login.requests.filter((r) => r.path === '/common/oauth2/v2.0/token');

// Token endpoint answering refresh-token grants with fn(form) (default: a fresh token).
function refreshWith(fn = () => ({ json: { token_type: 'Bearer', access_token: 'SECRET-at-1', expires_in: 3600 } })) {
  return (request) => {
    if (request.method !== 'POST' || request.path !== '/common/oauth2/v2.0/token') return null;
    return fn(form(request), request);
  };
}

// Graph serving the inbox (and $batch / reply when given).
function graphWith({ messages = [], batch, reply } = {}) {
  return (request) => {
    if (request.method === 'GET' && request.path === '/v1.0/me/mailFolders/inbox/messages') return { json: { value: messages } };
    if (request.method === 'POST' && request.path === '/v1.0/$batch' && batch) return batch(JSON.parse(request.text), request);
    if (request.method === 'POST' && /^\/v1\.0\/me\/messages\/[^/]+\/reply$/.test(request.path) && reply) return reply(request);
    return null;
  };
}

// Checks a rejection is one of the contract's errors, written for a person, with no secret in it.
function rejectsWith(promise, code, pattern) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof Error);
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    assert.ok(CODES.includes(err.code));
    assert.ok(err.message.length > 20 && !/undefined|\[object|NaN|^Error/.test(err.message), err.message);
    if (pattern) assert.match(err.message, pattern);
    for (let e = err; e; e = e.cause) assert.ok(!/SECRET/.test(String(e.message)), `secret leaked in: ${e.message}`);
    return true;
  });
}

// Resolves once nothing is listening on the port any more.
function assertClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.destroy();
      reject(new Error(`the sign-in server on port ${port} is still open`));
    });
    socket.on('error', (err) => (err.code === 'ECONNREFUSED' ? resolve() : reject(err)));
  });
}

// ---------- sign-in ----------

// Plays the browser. openUrl records the authorize URL and runs visit(b, params), which
// can "come back" to the loopback redirect with b.get(query).
function browser(visit = async () => {}) {
  const b = { pages: [], opened: 0 };
  b.openUrl = (url) => {
    b.opened++;
    b.url = new URL(url);
    b.params = b.url.searchParams;
    b.port = Number(new URL(b.params.get('redirect_uri')).port);
    b.done = visit(b, b.params);
    return b.done;
  };
  b.get = async (query) => {
    const res = await fetch(`http://127.0.0.1:${b.port}${query}`);
    const page = { status: res.status, type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy'), text: await res.text() };
    b.pages.push(page);
    return page;
  };
  b.back = (query) => b.get(`/?${query}&state=${encodeURIComponent(b.params.get('state'))}`);
  return b;
}

// Codes "Microsoft" has issued, so the token endpoint can check PKCE and the redirect URI.
const issued = new Map();

function signInServers({ me = { displayName: 'Will Wright', mail: null, userPrincipalName: 'WillW6311@Outlook.com' } } = {}) {
  login.handler = (request) => {
    if (request.method !== 'POST' || request.path !== '/common/oauth2/v2.0/token') return null;
    const f = form(request);
    const grant = issued.get(f.get('code'));
    issued.delete(f.get('code'));
    const ok = grant && f.get('grant_type') === 'authorization_code' && f.get('client_id') === CLIENT_ID &&
      grant.challenge === sha256(f.get('code_verifier') || '') && grant.redirect === f.get('redirect_uri') && !f.has('client_secret');
    if (!ok) return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS54005: OAuth2 Authorization code was already redeemed.', error_codes: [54005] } };
    return { json: { token_type: 'Bearer', access_token: 'SECRET-at-signin', refresh_token: 'SECRET-rt-signin', expires_in: 3600, scope: 'Mail.ReadWrite' } };
  };
  graph.handler = (request) => (request.method === 'GET' && request.path === '/v1.0/me' ? { json: me } : null);
}

test('signIn: authorization code + PKCE through a one-off loopback page', async () => {
  fresh();
  signInServers();
  const b = browser(async (b, p) => {
    issued.set('SECRET-code-1', { challenge: p.get('code_challenge'), redirect: p.get('redirect_uri') });
    // Stray requests and a forged state are turned away without ending the sign-in.
    assert.strictEqual((await b.get('/favicon.ico')).status, 404);
    assert.strictEqual((await b.get('/?code=SECRET-code-1&state=forged')).status, 400);
    assert.strictEqual((await b.get('/?code=SECRET-code-1')).status, 400);
    const done = await b.back('code=SECRET-code-1');
    assert.strictEqual(done.status, 200);
    assert.match(done.type, /^text\/html/);
    assert.match(done.csp, /default-src 'none'/);
    assert.match(done.text, /signed in/);
    assert.match(done.text, /close this tab and go back to ClearMail/);
    // The state is single-use: turned away, or nothing is listening any more.
    const again = await b.back('code=SECRET-code-1').catch(() => null);
    assert.ok(again === null || again.status === 400);
  });
  const result = await ms.signIn({ clientId: ` ${CLIENT_ID} `, openUrl: b.openUrl, loginHint: 'willw6311@outlook.com' });
  await b.done;
  assert.deepStrictEqual(result, { email: 'willw6311@outlook.com', name: 'Will Wright', refreshToken: 'SECRET-rt-signin' });

  // The authorize request.
  assert.strictEqual(`${b.url.origin}${b.url.pathname}`, `${login.base}/common/oauth2/v2.0/authorize`);
  const p = b.params;
  assert.strictEqual(p.get('client_id'), CLIENT_ID);
  assert.strictEqual(p.get('response_type'), 'code');
  assert.strictEqual(p.get('response_mode'), 'query');
  assert.strictEqual(p.get('prompt'), 'select_account');
  assert.strictEqual(p.get('login_hint'), 'willw6311@outlook.com');
  assert.strictEqual(p.get('scope'), ms.SCOPES);
  assert.strictEqual(p.get('code_challenge_method'), 'S256');
  assert.match(p.get('code_challenge'), /^[\w-]{43}$/);
  assert.ok(p.get('state').length >= 32);
  assert.match(p.get('redirect_uri'), /^http:\/\/localhost:\d+$/);
  assert.ok(!b.url.search.includes('+'), 'spaces are sent as %20');

  // The code exchange (PKCE checked by the mock) and the profile lookup.
  const exchange = form(tokenCalls()[0]);
  assert.strictEqual(exchange.get('scope'), ms.SCOPES);
  assert.ok(!exchange.has('client_secret'));
  assert.strictEqual(graph.requests.length, 1);
  assert.strictEqual(graph.requests[0].headers.authorization, 'Bearer SECRET-at-signin');
  assert.strictEqual(graph.requests[0].query.get('$select'), 'displayName,mail,userPrincipalName');
  await assertClosed(b.port);
});

test('signIn: the work address comes from mail when there is one', async () => {
  fresh();
  signInServers({ me: { displayName: '', mail: 'CVWW@lunet.lboro.ac.uk', userPrincipalName: 'cvww@lboro.ac.uk' } });
  const b = browser(async (b, p) => {
    issued.set('SECRET-code-2', { challenge: p.get('code_challenge'), redirect: p.get('redirect_uri') });
    await b.back('code=SECRET-code-2');
  });
  const result = await ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl });
  assert.deepStrictEqual(result, { email: 'cvww@lunet.lboro.ac.uk', name: 'cvww@lunet.lboro.ac.uk', refreshToken: 'SECRET-rt-signin' });
  assert.strictEqual(b.params.get('login_hint'), null);
  await assertClosed(b.port);
});

test('signIn: closing or declining in the browser is "cancelled", and the page says so', async () => {
  fresh();
  signInServers();
  const b = browser(async (b) => {
    const page = await b.back(`error=access_denied&error_description=${encodeURIComponent('AADSTS65004: User declined to consent to access the app.')}`);
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /didn&#39;t finish/);
    assert.match(page.text, /Need admin approval/);
  });
  // Also what "Approval required" -> "Back to app" sends, so the message mentions approval.
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl }), 'cancelled', /didn't finish.*"Need admin approval".*University and work accounts/s);
  await b.done;
  assert.strictEqual(tokenCalls().length, 0);
  await assertClosed(b.port);
});

test('signIn: an organisation that must approve ClearMail first is "admin-approval"', async () => {
  fresh();
  signInServers();
  const b = browser(async (b) => {
    const page = await b.back(`error=consent_required&error_description=${encodeURIComponent('AADSTS90094: Admin consent is required.')}`);
    assert.strictEqual(page.status, 400);
    assert.match(page.text, /organisation/);
  });
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl }), 'admin-approval', /organisation.*approve ClearMail.*for your account/s);
  await b.done;
  await assertClosed(b.port);
});

test('signIn: a code Microsoft will not redeem fails in plain English', async () => {
  fresh();
  signInServers();
  const b = browser(async (b) => {
    const page = await b.back('code=SECRET-never-issued');
    assert.strictEqual(page.status, 400);
    assert.match(page.text, /didn&#39;t finish/);
  });
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl }), 'needs-sign-in', /didn't finish/);
  await b.done;
  await assertClosed(b.port);
});

test('signIn: a redirect URI registered as a website gets a setup hint', async () => {
  fresh();
  signInServers();
  login.handler = () => ({ status: 401, json: { error: 'invalid_client', error_description: "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.", error_codes: [7000218] } });
  const b = browser((b) => b.back('code=SECRET-code-3'));
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl }), 'server', /Mobile and desktop applications/);
  await assertClosed(b.port);
});

test('signIn: a redirect URI registered as a single-page app gets a setup hint', async () => {
  fresh();
  signInServers();
  login.handler = () => ({ status: 400, json: { error: 'invalid_request', error_description: "AADSTS9002327: Tokens issued for the 'Single-Page Application' client-type may only be redeemed via cross-origin requests.", error_codes: [9002327] } });
  const b = browser((b) => b.back('code=SECRET-code-spa'));
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl }), 'server', /Single-page application.*Mobile and desktop applications/s);
  await assertClosed(b.port);
});

test('signIn: gives up after timeoutMs, and Cancel (abort) stops it', async () => {
  fresh();
  const waiting = browser();
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: waiting.openUrl, timeoutMs: 50 }), 'timeout', /stopped waiting for Microsoft.*AADSTS700016.*Mobile and desktop applications/s);
  await assertClosed(waiting.port);

  const controller = new AbortController();
  const cancelled = browser(async () => {
    await delay(20);
    controller.abort();
  });
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: cancelled.openUrl, signal: controller.signal }), 'cancelled');
  await assertClosed(cancelled.port);

  const early = browser();
  await rejectsWith(ms.signIn({ clientId: CLIENT_ID, openUrl: early.openUrl, signal: AbortSignal.abort() }), 'cancelled');
  assert.strictEqual(early.opened, 0);
});

test('signIn: without a usable client ID nothing opens; a browser that will not open fails cleanly', async () => {
  fresh();
  const b = browser();
  await rejectsWith(ms.signIn({ clientId: '', openUrl: b.openUrl }), 'no-client-id', /Application \(client\) ID.*Using Outlook/);
  await rejectsWith(ms.signIn({ openUrl: b.openUrl }), 'no-client-id');
  await rejectsWith(ms.signIn({ clientId: 'paste-the-id-here', openUrl: b.openUrl }), 'no-client-id', /doesn't look right/);
  assert.strictEqual(b.opened, 0);

  let port;
  await rejectsWith(ms.signIn({
    clientId: CLIENT_ID,
    openUrl: (url) => {
      port = Number(new URL(new URL(url).searchParams.get('redirect_uri')).port);
      throw new Error('no default browser');
    },
  }), 'server', /web browser/);
  await assertClosed(port);
});

// ---------- inbox ----------

const MESSAGES = [
  {
    id: 'AAMk-new=',
    internetMessageId: '<exam-1@lboro.ac.uk>',
    subject: 'Exam timetable',
    from: { emailAddress: { name: 'Exams Office', address: 'Exams@Lboro.ac.uk' } },
    replyTo: [{ emailAddress: { name: '', address: 'No-Reply@lboro.ac.uk' } }],
    sentDateTime: '2026-10-15T09:00:00Z',
    receivedDateTime: '2026-10-15T09:00:05Z',
    isRead: false,
    body: { contentType: 'text', content: 'Hi Will,\r\nYour exam is on Monday.\r\n' },
    attachments: [
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'timetable.pdf', size: 52000, isInline: false, contentType: 'application/pdf' },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', size: 3000, isInline: true, contentType: 'image/png' },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'notes.pdf', size: 900, isInline: true, contentType: 'application/pdf' },
      { '@odata.type': '#microsoft.graph.itemAttachment', name: 'Forwarded email', size: 4100, isInline: false, contentType: null },
    ],
  },
  {
    id: 'AAMk-old',
    internetMessageId: null,
    subject: null,
    from: null,
    sender: { emailAddress: { address: 'Friend@Outlook.com' } },
    replyTo: [],
    sentDateTime: null,
    receivedDateTime: '2026-10-14T08:00:00Z',
    isRead: true,
    // Graph ignored the plain-text request: the text is made from the HTML, which is kept.
    body: { contentType: 'html', content: '<p>Lunch <b>tomorrow</b>?</p>' },
    attachments: [],
  },
  { id: 'AAMk-mid', subject: 'Nobody', sentDateTime: '2026-10-14T12:00:00Z', isRead: false, body: { contentType: 'text', content: '' } },
];

test('fetchInbox: Graph messages become the same RawEmail shape mail.js returns, oldest first', async () => {
  fresh();
  graph.handler = graphWith({ messages: MESSAGES });
  const emails = await ms.fetchInbox(account(), opts());
  assert.deepStrictEqual(emails.map((e) => e.id), ['AAMk-old', 'AAMk-mid', 'AAMk-new=']);
  for (const e of emails) assert.deepStrictEqual(Object.keys(e).sort(), RAW_EMAIL_KEYS);

  const [old, mid, latest] = emails;
  assert.deepStrictEqual(latest, {
    id: 'AAMk-new=',
    messageId: '<exam-1@lboro.ac.uk>',
    uid: null,
    from: { name: 'Exams Office', address: 'exams@lboro.ac.uk' },
    replyTo: { name: 'no-reply@lboro.ac.uk', address: 'no-reply@lboro.ac.uk' },
    subject: 'Exam timetable',
    date: '2026-10-15T09:00:00.000Z',
    text: 'Hi Will,\nYour exam is on Monday.\n',
    html: '',
    seen: false,
    references: [],
    // Inline images are part of the body; an inline PDF and an attached email are still attachments.
    attachments: [{ filename: 'timetable.pdf', size: 52000 }, { filename: 'notes.pdf', size: 900 }, { filename: 'Forwarded email', size: 4100 }],
  });
  assert.deepStrictEqual(old.from, { name: 'friend@outlook.com', address: 'friend@outlook.com' });
  assert.strictEqual(old.replyTo, null);
  assert.strictEqual(old.messageId, null);
  assert.strictEqual(old.subject, '');
  assert.strictEqual(old.date, '2026-10-14T08:00:00.000Z');
  assert.strictEqual(old.seen, true);
  assert.match(old.text, /Lunch\s+tomorrow\?/);
  assert.strictEqual(old.html, '<p>Lunch <b>tomorrow</b>?</p>');
  assert.deepStrictEqual(mid.from, { name: 'Unknown sender', address: '' });
  assert.deepStrictEqual(mid.attachments, []);

  // The request: newest first, only the needed fields, plain-text bodies, no attachment content.
  assert.strictEqual(graph.requests.length, 1);
  const r = graph.requests[0];
  assert.strictEqual(r.headers.authorization, 'Bearer SECRET-at-1');
  assert.strictEqual(r.headers.prefer, 'outlook.body-content-type="text"');
  assert.strictEqual(r.query.get('$top'), '60');
  assert.strictEqual(r.query.get('$orderby'), 'receivedDateTime desc');
  for (const field of ['id', 'internetMessageId', 'subject', 'from', 'sender', 'replyTo', 'sentDateTime', 'isRead', 'body']) {
    assert.ok(r.query.get('$select').split(',').includes(field), field);
  }
  assert.strictEqual(r.query.get('$expand'), 'attachments($select=name,size,isInline,contentType)');
  assert.ok(!/contentBytes/.test(r.query.toString()));

  // The token came from the refresh token: a public client, so no secret.
  const refresh = form(tokenCalls()[0]);
  assert.strictEqual(refresh.get('grant_type'), 'refresh_token');
  assert.strictEqual(refresh.get('refresh_token'), 'SECRET-rt-1');
  assert.strictEqual(refresh.get('client_id'), CLIENT_ID);
  assert.strictEqual(refresh.get('scope'), ms.SCOPES);
  assert.ok(!refresh.has('client_secret'));
});

test('fetchInbox: follows nextLink only as far as the limit, and never off Graph', async () => {
  fresh();
  const msg = (n) => ({ id: `m${n}`, subject: `#${n}`, sentDateTime: `2026-10-0${n}T10:00:00Z`, isRead: true, body: { contentType: 'text', content: `${n}` } });
  graph.handler = (request) => {
    const page = request.query.get('$skiptoken');
    if (!page) return { json: { value: [msg(9), msg(8)], '@odata.nextLink': `${graph.base}/v1.0/me/mailFolders/inbox/messages?$skiptoken=p2` } };
    if (page === 'p2') return { json: { value: [msg(8), msg(7), msg(6)], '@odata.nextLink': `${graph.base}/v1.0/me/mailFolders/inbox/messages?$skiptoken=p3` } };
    return { json: { value: [msg(1)] } };
  };
  const emails = await ms.fetchInbox(account(), opts({ limit: 3 }));
  assert.deepStrictEqual(emails.map((e) => e.id), ['m7', 'm8', 'm9']);
  assert.strictEqual(graph.requests.length, 2);
  assert.strictEqual(graph.requests[0].query.get('$top'), '3');
  assert.strictEqual(graph.requests[1].headers.authorization, 'Bearer SECRET-at-1');

  fresh();
  graph.handler = () => ({ json: { value: [msg(5)], '@odata.nextLink': 'https://evil.example/v1.0/steal-the-token' } });
  assert.deepStrictEqual((await ms.fetchInbox(account(), opts())).map((e) => e.id), ['m5']);
  assert.strictEqual(graph.requests.length, 1);
});

test('fetchInbox: a long body is cut with a note, and an unreadable answer is an error, not an empty inbox', async () => {
  fresh();
  graph.handler = graphWith({ messages: [{ id: 'big', sentDateTime: '2026-10-01T00:00:00Z', body: { contentType: 'text', content: 'x'.repeat(1024 * 1024 + 10) } }] });
  const [big] = await ms.fetchInbox(account(), opts());
  assert.ok(big.text.startsWith('x'.repeat(1000)));
  assert.match(big.text, /\n\n\[This email is very long.*Open it in Outlook/);

  fresh();
  graph.handler = () => ({ status: 200, json: { not: 'graph' } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'server', /Couldn't load your Outlook inbox/);
});

// ---------- tokens ----------

test('tokens: concurrent calls share one refresh, a rotated refresh token is handed back once, and the access token is cached', async () => {
  fresh();
  let n = 0;
  login.handler = refreshWith(async () => {
    n++;
    await delay(30);
    return { json: { access_token: `SECRET-at-${n}`, refresh_token: 'SECRET-rt-2', expires_in: 3600 } };
  });
  graph.handler = graphWith();
  const rotated = [];
  const acct = account();
  const o = opts({ onRefreshToken: (token) => rotated.push(token) });
  await Promise.all([ms.fetchInbox(acct, o), ms.fetchInbox(acct, o), ms.fetchInbox(acct, o)]);
  assert.strictEqual(tokenCalls().length, 1);
  assert.deepStrictEqual(rotated, ['SECRET-rt-2']);
  assert.deepStrictEqual(graph.requests.map((r) => r.headers.authorization), Array(3).fill('Bearer SECRET-at-1'));

  // Still valid for an hour: no refresh, even though main hasn't saved the new token yet.
  await ms.fetchInbox(acct, o);
  await ms.fetchInbox({ ...acct, refreshToken: 'SECRET-rt-2' }, o);
  assert.strictEqual(tokenCalls().length, 1);

  // Signed in again (a refresh token this session never saw): the old access token is dropped.
  await ms.fetchInbox({ ...acct, refreshToken: 'SECRET-rt-new' }, o);
  assert.strictEqual(tokenCalls().length, 2);
  assert.strictEqual(form(tokenCalls()[1]).get('refresh_token'), 'SECRET-rt-new');

  // A removed account's token is forgotten.
  ms.forgetAccount(acct.id);
  await ms.fetchInbox({ ...acct, refreshToken: 'SECRET-rt-2' }, o);
  assert.strictEqual(tokenCalls().length, 3);
});

test('tokens: refreshed 5 minutes before expiry, always with the newest refresh token', async () => {
  fresh();
  login.handler = refreshWith(() => ({ json: { access_token: 'SECRET-at-short', refresh_token: 'SECRET-rt-2', expires_in: 240 } }));
  graph.handler = graphWith();
  const rotated = [];
  const acct = account();
  const o = opts({ onRefreshToken: (token) => rotated.push(token) });
  await ms.fetchInbox(acct, o);
  await ms.fetchInbox(acct, o); // main still passes the old token
  assert.deepStrictEqual(tokenCalls().map((r) => form(r).get('refresh_token')), ['SECRET-rt-1', 'SECRET-rt-2']);
  assert.deepStrictEqual(rotated, ['SECRET-rt-2']);
});

test('tokens: a 401 from Graph refreshes once and retries; a second 401 means signing in again', async () => {
  fresh();
  let n = 0;
  login.handler = refreshWith(() => ({ json: { access_token: `SECRET-at-${++n}`, expires_in: 3600 } }));
  graph.handler = (request) => (request.headers.authorization === 'Bearer SECRET-at-1'
    ? { status: 401, json: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } } }
    : { json: { value: [] } });
  assert.deepStrictEqual(await ms.fetchInbox(account(), opts()), []);
  assert.strictEqual(tokenCalls().length, 2);
  assert.strictEqual(graph.requests.length, 2);

  fresh();
  graph.handler = () => ({ status: 401, json: { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'needs-sign-in', /Sign in again/);
  assert.strictEqual(graph.requests.length, 2);
});

test('a failing onRefreshToken never breaks the call', async () => {
  fresh();
  login.handler = refreshWith(() => ({ json: { access_token: 'SECRET-at-1', refresh_token: 'SECRET-rt-9', expires_in: 3600 } }));
  graph.handler = graphWith();
  assert.deepStrictEqual(await ms.fetchInbox(account(), opts({ onRefreshToken: () => { throw new Error('disk full'); } })), []);
  assert.deepStrictEqual(await ms.fetchInbox(account(), opts({ onRefreshToken: async () => { throw new Error('disk full'); } })), []);
});

// ---------- mark as read ----------

test('markSeen: PATCH isRead in JSON batches of at most 20, matched by id whatever the order', async () => {
  fresh();
  const batches = [];
  graph.handler = graphWith({
    batch: (payload) => {
      batches.push(payload.requests);
      return { json: { responses: payload.requests.map((r) => ({ id: r.id, status: 200, headers: {}, body: { isRead: true } })).reverse() } };
    },
  });
  const ids = [...Array.from({ length: 24 }, (_, i) => `id-${i}`), 'AAMk+/x=', 'id-3', 7, null, ''];
  assert.strictEqual(await ms.markSeen(account(), ids, opts()), undefined);
  assert.deepStrictEqual(batches.map((b) => b.length), [20, 5]);
  const all = batches.flat();
  for (const r of all) {
    assert.strictEqual(r.method, 'PATCH');
    assert.deepStrictEqual(r.headers, { 'Content-Type': 'application/json' });
    assert.deepStrictEqual(r.body, { isRead: true });
  }
  for (const b of batches) assert.strictEqual(new Set(b.map((r) => r.id)).size, b.length);
  assert.deepStrictEqual(all.map((r) => r.url), [...Array.from({ length: 24 }, (_, i) => `/me/messages/id-${i}`), '/me/messages/AAMk%2B%2Fx%3D']);
  const post = graph.requests.find((r) => r.path === '/v1.0/$batch');
  assert.match(post.headers['content-type'], /^application\/json/);
  assert.strictEqual(post.headers.authorization, 'Bearer SECRET-at-1');

  graph.requests = [];
  await ms.markSeen(account(), [], opts());
  await ms.markSeen(account(), undefined, opts());
  assert.strictEqual(graph.requests.length, 0);
});

test('markSeen: any refused message rejects, and later batches are not sent', async () => {
  fresh();
  let posts = 0;
  graph.handler = graphWith({
    batch: (payload) => {
      posts++;
      return {
        json: {
          responses: payload.requests.map((r) => (r.url === '/me/messages/id-2'
            ? { id: r.id, status: 400, body: { error: { code: 'ErrorInvalidIdMalformed', message: 'Id is malformed.' } } }
            : { id: r.id, status: 200, body: {} })),
        },
      };
    },
  });
  const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
  await rejectsWith(ms.markSeen(account(), ids, opts()), 'server', /^Couldn't mark the email as read\. Microsoft said: "Id is malformed\."$/);
  assert.strictEqual(posts, 1);

  // One message Microsoft won't touch is that message's problem, not a reason to sign in again.
  fresh();
  graph.handler = graphWith({ batch: (payload) => ({ json: { responses: payload.requests.map((r) => ({ id: r.id, status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } })) } }) });
  await rejectsWith(ms.markSeen(account(), ['a'], opts()), 'server', /Microsoft said: "Access is denied\."/);

  // A batch Graph answers without all our ids is not taken as done.
  fresh();
  graph.handler = graphWith({ batch: () => ({ json: { responses: [] } }) });
  await rejectsWith(ms.markSeen(account(), ['a'], opts()), 'server', /mark the email as read/);
});

test('markSeen: throttled messages are retried on their own; deleted ones count as done', async () => {
  fresh();
  const batches = [];
  graph.handler = graphWith({
    batch: (payload) => {
      batches.push(payload.requests.map((r) => r.url));
      return {
        json: {
          responses: payload.requests.map((r) => {
            if (r.url === '/me/messages/busy' && batches.length === 1) return { id: r.id, status: 429, headers: { 'Retry-After': '0' }, body: { error: { code: 'ApplicationThrottled' } } };
            if (r.url === '/me/messages/gone') return { id: r.id, status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'Not found.' } } };
            return { id: r.id, status: 200, body: {} };
          }),
        },
      };
    },
  });
  await ms.markSeen(account(), ['ok', 'busy', 'gone'], opts());
  assert.deepStrictEqual(batches, [['/me/messages/ok', '/me/messages/busy', '/me/messages/gone'], ['/me/messages/busy']]);

  fresh();
  graph.handler = graphWith({ batch: (payload) => ({ json: { responses: payload.requests.map((r) => ({ id: r.id, status: 429, headers: { 'retry-after': '0' } })) } }) });
  await rejectsWith(ms.markSeen(account(), ['a', 'b'], opts()), 'throttled', /too many requests/);
  assert.strictEqual(graph.requests.length, 3);
});

// ---------- reply ----------

test('sendReply: replies through Outlook with the text as typed', async () => {
  fresh();
  graph.handler = graphWith({ reply: () => ({ status: 202 }) });
  const original = { id: 'AAMk=+', from: { name: 'Exams Office', address: 'exams@lboro.ac.uk' }, subject: 'Exam timetable' };
  assert.deepStrictEqual(await ms.sendReply(account(), original, 'Thanks!\nSee you Monday.', opts()), { sent: true });
  assert.strictEqual(graph.requests.length, 1);
  const r = graph.requests[0];
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.path, '/v1.0/me/messages/AAMk%3D%2B/reply');
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.strictEqual(r.headers.authorization, 'Bearer SECRET-at-1');
  assert.deepStrictEqual(JSON.parse(r.text), { message: { body: { contentType: 'text', content: 'Thanks!\nSee you Monday.' } } });
});

test('sendReply: failures are sentences, and a reply that may have gone is not sent twice', async () => {
  fresh();
  graph.handler = graphWith({ reply: () => ({ status: 404, json: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } }) });
  await rejectsWith(ms.sendReply(account(), { id: 'moved' }, 'Hi', opts()), 'server', /no longer in your Outlook inbox/);

  fresh();
  graph.handler = graphWith({ reply: () => ({ status: 500, json: { error: { code: 'InternalServerError', message: 'Oops' } } }) });
  await rejectsWith(ms.sendReply(account(), { id: 'x' }, 'Hi', opts()), 'server', /mail service is having problems/);
  assert.strictEqual(graph.requests.length, 1);

  fresh();
  ms._setTiming({ ...TIMING, requestTimeoutMs: 100 });
  graph.handler = () => ({ hang: true });
  await rejectsWith(ms.sendReply(account(), { id: 'x' }, 'Hi', opts()), 'timeout', /took too long/);
  assert.strictEqual(graph.requests.length, 1);

  fresh();
  await rejectsWith(ms.sendReply(account(), {}, 'Hi', opts()), 'server');
  assert.strictEqual(graph.requests.length, 0);
});

// ---------- error codes ----------

test('errors: an expired or revoked refresh token means signing in again', async () => {
  fresh();
  login.handler = refreshWith(() => ({
    status: 400,
    json: { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired due to inactivity. User: willw6311@outlook.com', error_codes: [700082] },
  }));
  await rejectsWith(ms.fetchInbox(account(), opts()), 'needs-sign-in', /sign in to this account again/);
  await rejectsWith(ms.markSeen(account(), ['a'], opts()), 'needs-sign-in');
  await rejectsWith(ms.sendReply(account(), { id: 'a' }, 'Hi', opts()), 'needs-sign-in');
  assert.strictEqual(graph.requests.length, 0);

  // MFA newly required by the organisation: a fresh sign-in sorts it out.
  login.handler = refreshWith(() => ({ status: 400, json: { error: 'interaction_required', error_description: 'AADSTS50076: Due to a configuration change...', error_codes: [50076] } }));
  await rejectsWith(ms.fetchInbox(account(), opts()), 'needs-sign-in');

  // No refresh token at all.
  await rejectsWith(ms.fetchInbox(account({ refreshToken: '' }), opts()), 'needs-sign-in');
});

test('errors: AADSTS65001 (no consent) means the organisation has to approve ClearMail', async () => {
  fresh();
  login.handler = refreshWith(() => ({
    status: 400,
    json: { error: 'invalid_grant', error_description: "AADSTS65001: The user or administrator has not consented to use the application with ID '...'.", error_codes: [65001] },
  }));
  await rejectsWith(ms.fetchInbox(account(), opts()), 'admin-approval', /university's IT team.*approve it for your account/s);
  assert.doesNotMatch((await ms.fetchInbox(account(), opts()).catch((e) => e)).message, /forward/);
});

test('errors: throttling honours Retry-After a few times, then says so', async () => {
  fresh();
  graph.handler = () => ({ status: 429, headers: { 'Retry-After': '0' }, json: { error: { code: 'ApplicationThrottled', message: 'Too many requests.' } } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'throttled', /too many requests/);
  assert.strictEqual(graph.requests.length, 3);

  // Asked to wait longer than the cap: no point keeping the user waiting.
  fresh();
  graph.handler = () => ({ status: 429, headers: { 'Retry-After': '3600' }, json: { error: { code: 'ApplicationThrottled' } } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'throttled');
  assert.strictEqual(graph.requests.length, 1);

  // 503 without Retry-After backs off, and a throttle that clears is invisible.
  fresh();
  let n = 0;
  graph.handler = () => (++n < 3 ? { status: 503, json: { error: { code: 'ServiceUnavailable' } } } : { json: { value: [] } });
  assert.deepStrictEqual(await ms.fetchInbox(account(), opts()), []);
  assert.strictEqual(graph.requests.length, 3);

  // The token endpoint too.
  fresh();
  login.handler = refreshWith(() => ({ status: 429, headers: { 'Retry-After': '0' }, json: { error: 'temporarily_unavailable' } }));
  await rejectsWith(ms.fetchInbox(account(), opts()), 'throttled');
  assert.strictEqual(tokenCalls().length, 3);
});

test('errors: client ID, network, timeout and Graph refusals', async () => {
  fresh();
  await rejectsWith(ms.fetchInbox(account(), {}), 'no-client-id', /Settings/);
  await rejectsWith(ms.markSeen(account(), ['a'], { clientId: '  ' }), 'no-client-id');
  assert.strictEqual(tokenCalls().length, 0);

  // Nothing listening.
  const closed = await mockServer();
  await closed.close();
  ms._setEndpoints({ login: login.base, graph: closed.base });
  try {
    await rejectsWith(ms.fetchInbox(account(), opts()), 'network', /internet connection/);
  } finally {
    ms._setEndpoints({ login: login.base, graph: graph.base });
  }

  fresh();
  ms._setTiming({ ...TIMING, requestTimeoutMs: 100 });
  login.handler = () => ({ hang: true });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'timeout', /took too long/);

  fresh();
  graph.handler = () => ({ status: 403, json: { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'needs-sign-in', /didn't let ClearMail into this mailbox/);

  fresh();
  graph.handler = () => ({ status: 404, json: { error: { code: 'MailboxNotEnabledForRESTAPI', message: 'The mailbox is either inactive, soft-deleted, or is hosted on-premise.' } } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'server', /can't reach the mailbox/);

  fresh();
  graph.handler = () => ({ status: 400, json: { error: { code: 'BadRequest', message: 'Invalid filter clause' } } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'server', /^Couldn't load your Outlook inbox\. Microsoft said: "Invalid filter clause"$/);

  fresh();
  graph.handler = () => ({ status: 400, json: { error: null } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'server', /^Couldn't load your Outlook inbox\. Please try again\.$/);

  // A redirect is not followed with the token.
  fresh();
  graph.handler = () => ({ status: 302, headers: { Location: `${login.base}/elsewhere` } });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'server', /Couldn't load your Outlook inbox/);
  assert.ok(!login.requests.some((r) => r.path === '/elsewhere'));

  fresh();
  graph.handler = () => ({ status: 502 });
  await rejectsWith(ms.fetchInbox(account(), opts()), 'server', /having problems/);
});

test('nothing was logged, and no token or code was ever printed', () => {
  assert.ok(printed.every((line) => !/SECRET/.test(line)), printed.join('\n'));
  assert.deepStrictEqual(printed, []);
});
