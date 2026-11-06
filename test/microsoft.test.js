// src/microsoft.js against local mock servers standing in for login.microsoftonline.com and
// graph.microsoft.com. The "browser" is the test's openUrl, which visits the redirect URI.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const ms = require('../src/microsoft');
const { startMicrosoft, graphMessage, sentMessage } = require('./helpers/microsoft-server');

// Whatever the module prints is kept, to check that no token or code ever reaches a log.
const printed = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => printed.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.cause?.message}` : String(a))).join(' '));
}

const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const CODES = ['needs-sign-in', 'admin-approval', 'no-client-id', 'cancelled', 'timeout', 'network', 'throttled', 'server'];
const TIMING = { requestTimeoutMs: 2000, backoffMs: 1, maxRetryWaitMs: 1000 };
const RAW_EMAIL_KEYS = [
  'attachments', 'cc', 'conversationId', 'date', 'flagged', 'focused', 'from', 'headers', 'html', 'id', 'importance', 'inReplyTo',
  'messageId', 'receivedAt', 'references', 'replyTo', 'seen', 'subject', 'text', 'to', 'uid', 'webLink',
];
const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const BLOCKED = /stopped a request that would have changed your mailbox/;

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

// A $batch answering each single-message headers GET with headers[id] (404 for other ids).
function headerBatch(headers = {}) {
  return (payload) => ({
    json: {
      responses: payload.requests.map((r) => {
        const m = /^\/me\/messages\/([^/?]+)\?\$select=internetMessageHeaders$/.exec(r.url);
        const id = m && decodeURIComponent(m[1]);
        if (r.method !== 'GET' || !id || !Object.hasOwn(headers, id)) return { id: r.id, status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'Not found.' } } };
        return { id: r.id, status: 200, headers: { 'Content-Type': 'application/json' }, body: { id, internetMessageHeaders: headers[id] } };
      }).reverse(), // Graph answers in any order
    },
  });
}

// Graph's $orderby=receivedDateTime desc (Graph sorts; the tests list messages in any order).
const when = (m) => Date.parse(m.receivedDateTime || m.sentDateTime) || 0;
const newestFirst = (a, b) => when(b) - when(a);

// Sent Items as Graph pages them: newest first, $top at a time, $filter by sentDateTime.
// A broken date sorts and filters as the newest, so the client has to cope with it.
function sentWith(list) {
  const sent = (x) => (Number.isNaN(Date.parse(x.sentDateTime)) ? Infinity : Date.parse(x.sentDateTime));
  return (request) => {
    const q = request.query;
    let all = [...list].sort((a, b) => (sent(b) === sent(a) ? 0 : sent(b) > sent(a) ? 1 : -1));
    const filter = q.get('$filter');
    if (filter) {
      const m = /^sentDateTime gt (\S+)$/.exec(filter);
      if (!m) return { status: 400, json: { error: { code: 'BadRequest', message: 'Invalid filter clause' } } };
      all = all.filter((x) => sent(x) > Date.parse(m[1]));
    }
    const top = Number(q.get('$top'));
    const skip = Number(q.get('$skip') || 0);
    const next = new URL(`${graph.base}${request.path}`);
    for (const [k, v] of q) next.searchParams.set(k, v);
    next.searchParams.set('$skip', String(skip + top));
    return { json: { value: all.slice(skip, skip + top), ...(skip + top < all.length ? { '@odata.nextLink': next.toString() } : {}) } };
  };
}

// Graph serving the inbox, headers through $batch, Sent Items and replies.
function graphWith({ messages = [], headers = {}, batch, reply, sent } = {}) {
  return (request) => {
    if (request.method === 'GET' && request.path === '/v1.0/me/mailFolders/inbox/messages') return { json: { value: [...messages].sort(newestFirst) } };
    if (request.method === 'POST' && request.path === '/v1.0/$batch') return (batch || headerBatch(headers))(JSON.parse(request.text), request);
    if (request.method === 'GET' && request.path === '/v1.0/me/mailFolders/sentitems/messages' && sent) return sent(request);
    if (request.method === 'POST' && /^\/v1\.0\/me\/messages\/[^/]+\/reply$/.test(request.path) && reply) return reply(request);
    return null;
  };
}

const inboxCalls = () => graph.requests.filter((r) => r.path === '/v1.0/me/mailFolders/inbox/messages');
const batchCalls = () => graph.requests.filter((r) => r.path === '/v1.0/$batch');
const batchIds = (request) => JSON.parse(request.text).requests.map((r) => decodeURIComponent(/^\/me\/messages\/([^/?]+)/.exec(r.url)[1]));
const idToken = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

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

const ECHOED = 'openid profile email https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send';

function signInServers({
  me = { displayName: 'Will Wright', mail: null, userPrincipalName: 'WillW6311@Outlook.com' },
  tokens = { scope: ECHOED, id_token: idToken({ tid: PERSONAL_TENANT }) },
} = {}) {
  login.handler = (request) => {
    if (request.method !== 'POST' || request.path !== '/common/oauth2/v2.0/token') return null;
    const f = form(request);
    const grant = issued.get(f.get('code'));
    issued.delete(f.get('code'));
    const ok = grant && f.get('grant_type') === 'authorization_code' && f.get('client_id') === CLIENT_ID &&
      grant.challenge === sha256(f.get('code_verifier') || '') && grant.redirect === f.get('redirect_uri') && !f.has('client_secret');
    if (!ok) return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS54005: OAuth2 Authorization code was already redeemed.', error_codes: [54005] } };
    return { json: { token_type: 'Bearer', access_token: 'SECRET-at-signin', refresh_token: 'SECRET-rt-signin', expires_in: 3600, ...tokens } };
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
  assert.deepStrictEqual(result, {
    email: 'willw6311@outlook.com',
    name: 'Will Wright',
    refreshToken: 'SECRET-rt-signin',
    // What Microsoft says the token may do, as short names: read and send, never change.
    grantedScopes: ['Mail.Read', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile'],
    personal: true, // the id_token's tenant is the one for personal accounts
  });
  assert.strictEqual(ms.grantsMailboxChanges(result.grantedScopes), false);

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
  signInServers({
    me: { displayName: '', mail: 'CVWW@lunet.lboro.ac.uk', userPrincipalName: 'cvww@lboro.ac.uk' },
    tokens: { scope: 'Mail.Read Mail.Send User.Read openid profile email', id_token: idToken({ tid: 'B1C2D3E4-0000-4000-8000-000000000001' }) },
  });
  const b = browser(async (b, p) => {
    issued.set('SECRET-code-2', { challenge: p.get('code_challenge'), redirect: p.get('redirect_uri') });
    await b.back('code=SECRET-code-2');
  });
  const result = await ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl });
  assert.deepStrictEqual(result, {
    email: 'cvww@lunet.lboro.ac.uk',
    name: 'cvww@lunet.lboro.ac.uk',
    refreshToken: 'SECRET-rt-signin',
    grantedScopes: ['Mail.Read', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile'],
    personal: false, // a university tenant
  });
  assert.strictEqual(b.params.get('login_hint'), null);
  await assertClosed(b.port);
});

test('signIn: an old consent that still grants Mail.ReadWrite shows in grantedScopes', async () => {
  fresh();
  // No id_token: an Outlook.com address is taken as a personal account.
  signInServers({ tokens: { scope: `${ECHOED} https://graph.microsoft.com/Mail.ReadWrite` } });
  const b = browser(async (b, p) => {
    issued.set('SECRET-code-legacy', { challenge: p.get('code_challenge'), redirect: p.get('redirect_uri') });
    await b.back('code=SECRET-code-legacy');
  });
  const result = await ms.signIn({ clientId: CLIENT_ID, openUrl: b.openUrl });
  assert.deepStrictEqual(result.grantedScopes, ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile']);
  assert.strictEqual(ms.grantsMailboxChanges(result.grantedScopes), true);
  assert.strictEqual(result.personal, true);
  // ClearMail itself still only asked to read and send.
  assert.ok(!b.params.get('scope').includes('ReadWrite'));
  await assertClosed(b.port);
});

test('scopes: ClearMail asks to read and send mail, never to change the mailbox', () => {
  assert.strictEqual(ms.SCOPES, 'openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send');
  assert.ok(!/ReadWrite|Mail\.Send\.Shared|MailboxSettings/i.test(ms.SCOPES));
  assert.strictEqual(ms.markSeen, undefined, 'there is no way to mark as read');

  assert.deepStrictEqual(ms.scopeList(' https://graph.microsoft.com/Mail.Read  Mail.Read profile https://graph.microsoft.com/User.Read '), ['Mail.Read', 'User.Read', 'profile']);
  assert.strictEqual(ms.scopeList(''), null);
  assert.strictEqual(ms.scopeList(undefined), null);
  assert.strictEqual(ms.grantsMailboxChanges(['Mail.Read', 'mail.readwrite']), true);
  assert.strictEqual(ms.grantsMailboxChanges(['Mail.ReadWrite.Shared']), true);
  assert.strictEqual(ms.grantsMailboxChanges(['Mail.Read', 'Mail.Send', 'Mail.ReadBasic']), false);
  assert.strictEqual(ms.grantsMailboxChanges(null), false);
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

// Mailing-list headers as Graph gives them for one message.
const NEWSLETTER_HEADERS = [
  { name: 'Received', value: 'from mail.example by outlook.com' },
  { name: 'list-unsubscribe', value: '<https://news.example/u?id=1>,\r\n <mailto:unsub@news.example>' },
  { name: 'List-Id', value: 'Weekly Builder <weekly.builder.example>' },
  { name: 'Precedence', value: 'Bulk' },
  { name: 'Auto-Submitted', value: 'Auto-Generated' },
  { name: 'In-Reply-To', value: '  <parent-1@lboro.ac.uk> ' },
];

test('fetchInbox: Graph messages become RawEmail v3, the same shape mail.js returns, oldest first', async () => {
  fresh();
  const messages = MESSAGES.map((m, i) => (i === 0 ? {
    ...m,
    toRecipients: [{ emailAddress: { name: 'Will', address: 'WillW6311@Outlook.com' } }, { emailAddress: { name: '', address: 'tom@example.com' } }, { emailAddress: { address: 'TOM@example.com' } }],
    ccRecipients: [{ emailAddress: { name: 'Ann', address: 'Ann@Example.com' } }, { emailAddress: { name: 'nobody' } }],
    importance: 'High',
    inferenceClassification: 'other',
    flag: { flagStatus: 'flagged' },
    conversationId: 'AAQkConv1=',
    webLink: 'https://outlook.live.com/owa/?ItemID=AAMk-new%3D&exvsurl=1&viewmodel=ReadMessageItem',
  } : m));
  graph.handler = graphWith({ messages, headers: { 'AAMk-new=': NEWSLETTER_HEADERS, 'AAMk-old': [] } });
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
    // Lower-cased, once each, and only real addresses.
    to: [{ name: 'Will', address: 'willw6311@outlook.com' }, { name: 'tom@example.com', address: 'tom@example.com' }],
    cc: [{ name: 'Ann', address: 'ann@example.com' }],
    subject: 'Exam timetable',
    date: '2026-10-15T09:00:00.000Z',
    receivedAt: '2026-10-15T09:00:05.000Z',
    text: 'Hi Will,\nYour exam is on Monday.\n',
    html: '',
    seen: false,
    flagged: true,
    references: [],
    // Inline images are part of the body; an inline PDF and an attached email are still attachments.
    attachments: [{ filename: 'timetable.pdf', size: 52000 }, { filename: 'notes.pdf', size: 900 }, { filename: 'Forwarded email', size: 4100 }],
    headers: {
      listUnsubscribe: '<https://news.example/u?id=1>, <mailto:unsub@news.example>',
      listId: 'Weekly Builder <weekly.builder.example>',
      precedence: 'bulk',
      autoSubmitted: 'auto-generated',
    },
    importance: 'high',
    focused: false, // Outlook filed it under Other
    conversationId: 'AAQkConv1=',
    inReplyTo: '<parent-1@lboro.ac.uk>',
    webLink: 'https://outlook.live.com/owa/?ItemID=AAMk-new%3D&exvsurl=1&viewmodel=ReadMessageItem',
  });
  assert.deepStrictEqual(old.from, { name: 'friend@outlook.com', address: 'friend@outlook.com' });
  assert.strictEqual(old.replyTo, null);
  assert.strictEqual(old.messageId, null);
  assert.strictEqual(old.subject, '');
  assert.strictEqual(old.date, '2026-10-14T08:00:00.000Z');
  assert.strictEqual(old.receivedAt, '2026-10-14T08:00:00.000Z');
  assert.strictEqual(old.seen, true);
  assert.match(old.text, /Lunch\s+tomorrow\?/);
  assert.strictEqual(old.html, '<p>Lunch <b>tomorrow</b>?</p>');
  // Headers Graph answered with but without list headers: known, and none of them set.
  assert.deepStrictEqual(old.headers, { listUnsubscribe: null, listId: null, precedence: null, autoSubmitted: null });
  assert.deepStrictEqual(mid.from, { name: 'Unknown sender', address: '' });
  assert.deepStrictEqual(mid.attachments, []);
  // Graph didn't give this one's headers: unknown, not "no headers".
  assert.deepStrictEqual([mid.headers, mid.inReplyTo], [null, null]);
  assert.deepStrictEqual([mid.to, mid.cc, mid.importance, mid.focused, mid.flagged, mid.conversationId, mid.webLink], [[], [], 'normal', null, false, null, null]);

  // The request: newest first, the needed fields, plain-text bodies, no attachment content, 50 a page.
  assert.strictEqual(inboxCalls().length, 1);
  const r = inboxCalls()[0];
  assert.strictEqual(r.headers.authorization, 'Bearer SECRET-at-1');
  assert.strictEqual(r.headers.prefer, 'outlook.body-content-type="text"');
  assert.strictEqual(r.query.get('$top'), '50');
  assert.strictEqual(r.query.get('$orderby'), 'receivedDateTime desc');
  const select = r.query.get('$select').split(',');
  for (const field of ['id', 'internetMessageId', 'subject', 'from', 'sender', 'replyTo', 'toRecipients', 'ccRecipients', 'sentDateTime', 'receivedDateTime',
    'isRead', 'importance', 'inferenceClassification', 'flag', 'conversationId', 'webLink', 'body']) {
    assert.ok(select.includes(field), field);
  }
  assert.ok(!select.includes('internetMessageHeaders'), 'not documented on a list');
  assert.strictEqual(r.query.get('$expand'), 'attachments($select=name,size,isInline,contentType)');
  assert.ok(!/contentBytes/.test(r.query.toString()));

  // The headers: one $batch of single-message GETs, newest first.
  assert.strictEqual(batchCalls().length, 1);
  const batch = JSON.parse(batchCalls()[0].text).requests;
  assert.deepStrictEqual(batch.map((x) => [x.id, x.method, x.url]), [
    ['1', 'GET', '/me/messages/AAMk-new%3D?$select=internetMessageHeaders'],
    ['2', 'GET', '/me/messages/AAMk-mid?$select=internetMessageHeaders'],
    ['3', 'GET', '/me/messages/AAMk-old?$select=internetMessageHeaders'],
  ]);
  assert.ok(batch.every((x) => x.body === undefined));

  // The token came from the refresh token: a public client, so no secret.
  const refresh = form(tokenCalls()[0]);
  assert.strictEqual(refresh.get('grant_type'), 'refresh_token');
  assert.strictEqual(refresh.get('refresh_token'), 'SECRET-rt-1');
  assert.strictEqual(refresh.get('client_id'), CLIENT_ID);
  assert.strictEqual(refresh.get('scope'), ms.SCOPES);
  assert.ok(!refresh.has('client_secret'));
});

test('fetchInbox: an "Open in Outlook" link is kept only if it is https on an Outlook web host', async () => {
  fresh();
  const links = {
    personal: 'https://outlook.live.com/owa/?ItemID=a&exvsurl=1',
    office: 'https://outlook.office.com/owa/?ItemID=b',
    office365: 'https://outlook.office365.com/owa/?ItemID=c',
    cloud: 'https://outlook.cloud.microsoft/mail/inbox/id/d',
    caps: 'HTTPS://Outlook.Live.com/owa/?ItemID=e',
    http: 'http://outlook.live.com/owa/?ItemID=f',
    lookalike: 'https://outlook.live.com.evil.example/owa/',
    other: 'https://evil.example/?https://outlook.live.com/',
    login: 'https://user:pass@outlook.live.com/owa/',
    port: 'https://outlook.live.com:8443/owa/',
    script: 'javascript:alert(1)//outlook.live.com',
    file: 'file:///etc/passwd',
    junk: 'not a url',
    number: 42,
  };
  graph.handler = graphWith({ messages: Object.entries(links).map(([id, webLink], i) => ({ id, webLink, sentDateTime: `2026-10-0${(i % 9) + 1}T10:00:00Z`, body: { content: '' } })) });
  const got = Object.fromEntries((await ms.fetchInbox(account(), opts())).map((e) => [e.id, e.webLink]));
  assert.deepStrictEqual(got, {
    personal: links.personal,
    office: links.office,
    office365: links.office365,
    cloud: links.cloud,
    caps: 'https://outlook.live.com/owa/?ItemID=e',
    http: null,
    lookalike: null,
    other: null,
    login: null,
    port: null,
    script: null,
    file: null,
    junk: null,
    number: null,
  });
  assert.strictEqual(ms.safeWebLink('https://outlook.office365.com/owa/'), 'https://outlook.office365.com/owa/');
  assert.strictEqual(ms.safeWebLink(`https://outlook.live.com/${'x'.repeat(5000)}`), null);
  assert.strictEqual(ms.safeWebLink(undefined), null);
});

test('fetchInbox: headers are fetched once per email, 20 to a batch, and only for emails not seen before', async () => {
  fresh();
  const msg = (n) => ({ id: `m${n}`, subject: `#${n}`, sentDateTime: new Date(Date.UTC(2026, 9, 1, n)).toISOString(), body: { content: `${n}` } });
  const messages = Array.from({ length: 25 }, (_, i) => msg(i));
  const headers = Object.fromEntries(messages.map((m) => [m.id, [{ name: 'List-Id', value: `<list-${m.id}.example>` }]]));
  delete headers.m3; // Microsoft couldn't find this one just now
  graph.handler = graphWith({ messages, headers });
  const acct = account();
  let emails = await ms.fetchInbox(acct, opts());
  assert.deepStrictEqual(batchCalls().map((r) => batchIds(r).length), [20, 5]);
  assert.deepStrictEqual(batchIds(batchCalls()[0])[0], 'm24', 'newest first');
  assert.strictEqual(emails.find((e) => e.id === 'm7').headers.listId, '<list-m7.example>');
  assert.strictEqual(emails.find((e) => e.id === 'm3').headers, null);

  // A refresh asks only for the new email and the one that failed.
  messages.push(msg(30));
  headers.m30 = [];
  graph.requests = [];
  emails = await ms.fetchInbox(acct, opts());
  assert.deepStrictEqual(batchCalls().map(batchIds), [['m30', 'm3']]);
  assert.deepStrictEqual(emails.find((e) => e.id === 'm30').headers, { listUnsubscribe: null, listId: null, precedence: null, autoSubmitted: null });
  assert.strictEqual(emails.find((e) => e.id === 'm7').headers.listId, '<list-m7.example>', 'still known from the first load');

  // Everything is known now except m3: no batch for anything else.
  graph.requests = [];
  await ms.fetchInbox(acct, opts());
  assert.deepStrictEqual(batchCalls().map(batchIds), [['m3']]);

  // Each account keeps its own: another account's same ids are fetched for it.
  graph.requests = [];
  await ms.fetchInbox(account(), opts());
  assert.deepStrictEqual(batchCalls().map((r) => batchIds(r).length), [20, 6]);

  // A removed account's headers are forgotten with it.
  ms.forgetAccount(acct.id);
  graph.requests = [];
  await ms.fetchInbox(acct, opts());
  assert.deepStrictEqual(batchCalls().map((r) => batchIds(r).length), [20, 6]);
});

test('fetchInbox: throttled header requests are retried on their own, and given up on without failing the load', async () => {
  fresh();
  const messages = ['a', 'b', 'c'].map((id, i) => ({ id, sentDateTime: `2026-10-0${i + 1}T10:00:00Z`, body: { content: id } }));
  const answer = headerBatch({ a: [{ name: 'Precedence', value: 'list' }], b: [], c: [] });
  let calls = 0;
  graph.handler = graphWith({
    messages,
    batch: (payload) => {
      calls++;
      const out = answer(payload);
      for (const r of out.json.responses) {
        if (calls === 1 && r.id === payload.requests.find((x) => x.url.startsWith('/me/messages/a?')).id) {
          Object.assign(r, { status: 429, headers: { 'Retry-After': '0' }, body: { error: { code: 'ApplicationThrottled' } } });
        }
      }
      return out;
    },
  });
  let emails = await ms.fetchInbox(account(), opts());
  assert.deepStrictEqual(batchCalls().map(batchIds), [['c', 'b', 'a'], ['a']]);
  assert.strictEqual(emails.find((e) => e.id === 'a').headers.precedence, 'list');

  // Throttled every time: three tries, then the emails show without their headers.
  fresh();
  graph.handler = graphWith({
    messages,
    batch: (payload) => ({ json: { responses: payload.requests.map((r) => ({ id: r.id, status: 429, headers: { 'retry-after': '0' } })) } }),
  });
  emails = await ms.fetchInbox(account(), opts());
  assert.strictEqual(batchCalls().length, 3);
  assert.deepStrictEqual(emails.map((e) => e.headers), [null, null, null]);

  // One email Microsoft refuses for good (not a passing problem): not asked for again.
  fresh();
  const refusing = headerBatch({ a: [], b: [] });
  graph.handler = graphWith({
    messages,
    batch: (payload) => {
      const out = refusing(payload);
      for (const r of out.json.responses) {
        if (payload.requests.find((x) => x.id === r.id).url.startsWith('/me/messages/c?')) Object.assign(r, { status: 403, body: { error: { code: 'ErrorAccessDenied' } } });
      }
      return out;
    },
  });
  const acct = account();
  emails = await ms.fetchInbox(acct, opts());
  assert.deepStrictEqual(emails.map((e) => [e.id, e.headers === null]), [['a', false], ['b', false], ['c', true]]);
  graph.requests = [];
  emails = await ms.fetchInbox(acct, opts());
  assert.deepStrictEqual(batchCalls(), []);
  assert.deepStrictEqual(emails.map((e) => [e.id, e.headers === null]), [['a', false], ['b', false], ['c', true]]);

  // A batch Microsoft refuses outright, or a Retry-After longer than the cap: the same.
  for (const batch of [
    () => ({ status: 500, json: { error: { code: 'InternalServerError', message: 'Oops' } } }),
    (payload) => ({ json: { responses: payload.requests.map((r) => ({ id: r.id, status: 429, headers: { 'Retry-After': '3600' } })) } }),
    () => ({ json: { nothing: true } }),
  ]) {
    fresh();
    graph.handler = graphWith({ messages, batch });
    emails = await ms.fetchInbox(account(), opts());
    assert.deepStrictEqual(emails.map((e) => [e.id, e.headers]), [['a', null], ['b', null], ['c', null]]);
    assert.strictEqual(batchCalls().length, 1);
  }
});

test('fetchInbox: headers get 15 seconds; after that the emails show without them, and the next load tries again', async () => {
  fresh();
  ms._setTiming({ ...TIMING, headerBudgetMs: 150 });
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, sentDateTime: new Date(Date.UTC(2026, 9, 1, i)).toISOString(), body: { content: '' } }));
  graph.handler = graphWith({ messages, batch: () => ({ hang: true }) });
  const started = Date.now();
  let emails = await ms.fetchInbox(account(), opts());
  assert.ok(Date.now() - started < 1500, 'did not wait for Microsoft');
  assert.strictEqual(emails.length, 30);
  assert.ok(emails.every((e) => e.headers === null));
  assert.strictEqual(batchCalls().length, 1, 'no second batch once the time is up');

  // Slow batches: as many as fit in the time.
  fresh();
  ms._setTiming({ ...TIMING, headerBudgetMs: 150 });
  const answer = headerBatch(Object.fromEntries(messages.map((m) => [m.id, []])));
  graph.handler = graphWith({ messages, batch: async (payload) => { await delay(200); return answer(payload); } });
  const acct = account();
  emails = await ms.fetchInbox(acct, opts());
  assert.ok(emails.every((e) => e.headers === null));
  ms._setTiming(TIMING);
  graph.handler = graphWith({ messages, batch: answer });
  emails = await ms.fetchInbox(acct, opts());
  assert.ok(emails.every((e) => e.headers !== null));
});

test('fetchInbox: follows nextLink only as far as the limit, and never off Graph', async () => {
  fresh();
  const msg = (n) => ({ id: `m${n}`, subject: `#${n}`, sentDateTime: `2026-10-0${n}T10:00:00Z`, isRead: true, body: { contentType: 'text', content: `${n}` } });
  const pages = (request) => {
    if (request.path !== '/v1.0/me/mailFolders/inbox/messages') return graphWith()(request);
    const page = request.query.get('$skiptoken');
    if (!page) return { json: { value: [msg(9), msg(8)], '@odata.nextLink': `${graph.base}/v1.0/me/mailFolders/inbox/messages?$skiptoken=p2` } };
    if (page === 'p2') return { json: { value: [msg(8), msg(7), msg(6)], '@odata.nextLink': `${graph.base}/v1.0/me/mailFolders/inbox/messages?$skiptoken=p3` } };
    return { json: { value: [msg(1)] } };
  };
  graph.handler = pages;
  const emails = await ms.fetchInbox(account(), opts({ limit: 3 }));
  assert.deepStrictEqual(emails.map((e) => e.id), ['m7', 'm8', 'm9']);
  assert.strictEqual(inboxCalls().length, 2);
  assert.strictEqual(inboxCalls()[0].query.get('$top'), '3');
  assert.strictEqual(inboxCalls()[1].headers.authorization, 'Bearer SECRET-at-1');

  // A bigger limit is read 50 at a time.
  fresh();
  graph.handler = pages;
  await ms.fetchInbox(account(), opts({ limit: 200 }));
  assert.strictEqual(inboxCalls()[0].query.get('$top'), '50');

  fresh();
  graph.handler = (request) => (request.path === '/v1.0/me/mailFolders/inbox/messages'
    ? { json: { value: [msg(5)], '@odata.nextLink': 'https://evil.example/v1.0/steal-the-token' } }
    : graphWith()(request));
  assert.deepStrictEqual((await ms.fetchInbox(account(), opts())).map((e) => e.id), ['m5']);
  assert.strictEqual(inboxCalls().length, 1);
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

// ---------- sent history ----------

const sentItem = (n, over = {}) => ({
  id: `s${n}`,
  from: { emailAddress: { name: 'Will', address: 'WillW6311@Outlook.com' } },
  toRecipients: [{ emailAddress: { name: 'Sarah', address: `Sarah${n % 7}@Example.com` } }],
  ccRecipients: [],
  bccRecipients: [],
  conversationId: `conv-${n % 50}`,
  sentDateTime: new Date(Date.UTC(2026, 8, 1) + n * 3600_000).toISOString(),
  ...over,
});

test('fetchSentHistory: the first sync reads the newest 500 sent emails, 50 a page, recipients only', async () => {
  fresh();
  const items = Array.from({ length: 520 }, (_, i) => sentItem(i));
  items[519] = sentItem(519, {
    toRecipients: [{ emailAddress: { name: 'Sarah', address: 'SARAH@example.com' } }],
    ccRecipients: [{ emailAddress: { name: 'Tom', address: 'tom@example.com' } }, { emailAddress: { address: 'sarah@example.com' } }],
    bccRecipients: [{ emailAddress: { name: 'Dad', address: 'dad@example.com' } }],
    conversationId: 'AAQkLast=',
  });
  graph.handler = graphWith({ sent: sentWith(items) });
  const before = Date.now();
  const batch = await ms.fetchSentHistory(account(), null, opts());
  assert.strictEqual(batch.full, true);
  assert.strictEqual(batch.entries.length, 500);
  assert.deepStrictEqual(batch.entries[0], {
    from: 'willw6311@outlook.com',
    to: ['sarah@example.com', 'tom@example.com', 'dad@example.com'],
    date: items[519].sentDateTime,
    conversationId: 'AAQkLast=',
    inReplyTo: null,
  });
  assert.strictEqual(batch.entries.at(-1).date, items[20].sentDateTime, 'the oldest 20 are left out');
  assert.deepStrictEqual(batch.cursor.kind, 'graph');
  assert.strictEqual(batch.cursor.since, items[519].sentDateTime);
  assert.ok(batch.cursor.fullAt >= before && batch.cursor.fullAt <= Date.now());

  const calls = graph.requests.filter((r) => r.path === '/v1.0/me/mailFolders/sentitems/messages');
  assert.strictEqual(calls.length, 10);
  assert.ok(calls.every((r) => r.method === 'GET'));
  assert.strictEqual(calls[0].query.get('$top'), '50');
  assert.strictEqual(calls[0].query.get('$orderby'), 'sentDateTime desc');
  assert.strictEqual(calls[0].query.get('$filter'), null);
  assert.deepStrictEqual(calls[0].query.get('$select').split(',').sort(), ['bccRecipients', 'ccRecipients', 'conversationId', 'from', 'id', 'sentDateTime', 'toRecipients']);
  assert.ok(!/body/i.test(calls[0].query.get('$select')), 'no email content');
  assert.strictEqual(graph.requests.length, 10, 'nothing else was asked for');
});

test('fetchSentHistory: later syncs read only what was sent since, and rebuild every 30 days', async () => {
  fresh();
  const items = Array.from({ length: 30 }, (_, i) => sentItem(i));
  graph.handler = graphWith({ sent: sentWith(items) });
  const acct = account();
  const first = await ms.fetchSentHistory(acct, null, opts());
  assert.deepStrictEqual([first.full, first.entries.length], [true, 30]);

  items.push(sentItem(30), sentItem(31, { sentDateTime: 'not a date' }), sentItem(32));
  graph.requests = [];
  const second = await ms.fetchSentHistory(acct, first.cursor, opts());
  assert.strictEqual(second.full, false);
  assert.deepStrictEqual(second.entries.map((e) => e.date), [items[32].sentDateTime, items[30].sentDateTime], 'one with no date is skipped');
  assert.strictEqual(graph.requests[0].query.get('$filter'), `sentDateTime gt ${items[29].sentDateTime}`);
  assert.deepStrictEqual(second.cursor, { kind: 'graph', since: items[32].sentDateTime, fullAt: first.cursor.fullAt });

  // Nothing new: nothing to add, and the cursor stays.
  const third = await ms.fetchSentHistory(acct, second.cursor, opts());
  assert.deepStrictEqual([third.full, third.entries, third.cursor], [false, [], second.cursor]);

  // 30 days on, or a cursor that doesn't fit: everything again.
  for (const cursor of [
    { ...second.cursor, fullAt: Date.now() - 31 * 24 * 3600_000 },
    { ...second.cursor, fullAt: Date.now() + 3600_000 },
    { ...second.cursor, since: 'yesterday' },
    { kind: 'imap', lastUid: 4, uidValidity: '1', fullAt: Date.now() },
    { kind: 'graph', since: null, fullAt: Date.now() },
    'junk',
  ]) {
    graph.requests = [];
    const again = await ms.fetchSentHistory(acct, cursor, opts());
    assert.deepStrictEqual([again.full, again.entries.length], [true, 32], JSON.stringify(cursor));
    assert.strictEqual(graph.requests[0].query.get('$filter'), null);
  }
});

test('fetchSentHistory: no Sent Items is an empty history; other failures are sentences', async () => {
  fresh();
  graph.handler = graphWith({ sent: () => ({ status: 404, json: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } }) });
  const empty = await ms.fetchSentHistory(account(), null, opts());
  assert.deepStrictEqual([empty.full, empty.entries, empty.cursor.since], [true, [], null]);

  fresh();
  graph.handler = graphWith({ sent: () => ({ status: 403, json: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } }) });
  await rejectsWith(ms.fetchSentHistory(account(), null, opts()), 'needs-sign-in', /didn't let ClearMail into this mailbox/);

  fresh();
  graph.handler = graphWith({ sent: () => ({ status: 400, json: { error: { code: 'BadRequest', message: 'Invalid filter clause' } } }) });
  await rejectsWith(ms.fetchSentHistory(account(), null, opts()), 'server', /^Couldn't read your sent emails\. Microsoft said: "Invalid filter clause"$/);

  fresh();
  graph.handler = graphWith({ sent: () => ({ json: { value: 'nope' } }) });
  await rejectsWith(ms.fetchSentHistory(account(), null, opts()), 'server', /Couldn't read your sent emails/);
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

test('tokens: the permissions of each refreshed token are reported when they change', async () => {
  fresh();
  let scope = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid profile email';
  login.handler = refreshWith(() => ({ json: { access_token: 'SECRET-at-1', expires_in: 1, scope } }));
  graph.handler = graphWith({ sent: sentWith([]) });
  const reported = [];
  const acct = account();
  const o = opts({ onGrantedScopes: (scopes) => reported.push(scopes) });
  await ms.fetchInbox(acct, o);
  await ms.fetchInbox(acct, o); // the 1-second token is refreshed again: the same permissions aren't reported twice
  assert.strictEqual(tokenCalls().length, 2);
  assert.deepStrictEqual(reported, [['Mail.Read', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile']]);

  // An old consent shows up: Settings can warn about it.
  scope += ' https://graph.microsoft.com/Mail.ReadWrite';
  await ms.fetchSentHistory(acct, null, o);
  assert.strictEqual(reported.length, 2);
  assert.ok(ms.grantsMailboxChanges(reported[1]));

  // No scope in the answer says nothing new; a failing callback breaks nothing.
  scope = undefined;
  await ms.fetchInbox(acct, opts({ onGrantedScopes: () => { throw new Error('disk full'); } }));
  assert.strictEqual(reported.length, 2);
  scope = 'Mail.Read';
  assert.deepStrictEqual(await ms.fetchInbox(acct, opts({ onGrantedScopes: async () => { throw new Error('disk full'); } })), []);
});

// ---------- read and reply only ----------

test('write guard: nothing that could change the mailbox is ever sent to Microsoft', async () => {
  fresh();
  graph.handler = () => ({ json: {} });
  const acct = account();
  const refused = [
    ['PATCH', '/me/messages/AAMk', { isRead: true }],
    ['patch', '/me/messages/AAMk', { isRead: true }],
    ['DELETE', '/me/messages/AAMk'],
    ['PUT', '/me/messages/AAMk', {}],
    ['POST', '/me/messages/AAMk/move', { destinationId: 'deleteditems' }],
    ['POST', '/me/messages/AAMk/copy', { destinationId: 'archive' }],
    ['POST', '/me/messages/AAMk/forward', { toRecipients: [] }],
    ['POST', '/me/messages/AAMk/send'],
    ['POST', '/me/messages/AAMk/createReply'],
    ['POST', '/me/messages/AAMk/replyAll', { comment: 'hi' }],
    ['POST', '/me/messages', { subject: 'draft' }],
    ['POST', '/me/sendMail', { message: {} }],
    ['POST', '/me/mailFolders', { displayName: 'x' }],
    ['POST', '/me/messages/AAMk/reply/../move', { destinationId: 'deleteditems' }],
    ['POST', '/me/messages/AAMk/reply?x=1', { message: {} }],
    ['POST', '/me/messages/a/b/reply', { message: {} }],
    ['POST', '/$batch', { requests: [{ id: '1', method: 'PATCH', url: '/me/messages/AAMk', body: { isRead: true } }] }],
    ['POST', '/$batch', { requests: [{ id: '1', method: 'GET', url: '/me/messages/a' }, { id: '2', method: 'DELETE', url: '/me/messages/b' }] }],
    ['POST', '/$batch', { requests: [{ id: '1', method: 'get', url: '/me/messages/a' }] }],
    ['POST', '/$batch', { requests: [{ id: '1', method: 'GET', url: 'https://evil.example/me/messages/a' }] }],
    ['POST', '/$batch', { requests: [{ id: '1', method: 'GET', url: '//evil.example/x' }] }],
    ['POST', '/$batch', { requests: [{ id: '1', method: 'GET', url: '/me/messages/a', body: {} }] }],
    ['POST', '/$batch', { requests: Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1), method: 'GET', url: `/me/messages/${i}` })) }],
    ['POST', '/$batch', { requests: [] }],
    ['POST', '/$batch'],
    ['POST', '/$batch?x=1', { requests: [{ id: '1', method: 'GET', url: '/me/messages/a' }] }],
    ['GET', '/me/messages/AAMk', {}], // a GET with a body
    ['GET', 'https://evil.example/v1.0/me/messages'],
    ['POST', 'https://evil.example/v1.0/me/messages/AAMk/reply', { message: {} }],
    ['GET', `${graph.base}/beta/me/messages`],
  ];
  for (const [method, target, body] of refused) {
    await rejectsWith(ms._graph(acct, opts(), method, target, body === undefined ? {} : { body }), 'server', BLOCKED);
  }
  // Refused before anything was sent: no token was even fetched.
  assert.strictEqual(tokenCalls().length, 0);
  assert.strictEqual(graph.requests.length, 0);

  // What ClearMail does use still works.
  const ok = [
    ['GET', '/me/mailFolders/inbox/messages?$top=1'],
    ['get', '/me/messages/AAMk%2B%2F%3D'],
    ['GET', `${graph.base}/v1.0/me/mailFolders/sentitems/messages?$skip=50`],
    ['POST', '/$batch', { requests: [{ id: '1', method: 'GET', url: '/me/messages/a?$select=internetMessageHeaders' }] }],
    ['POST', '/me/messages/AAMk%2B%2F%3D/reply', { message: { body: { contentType: 'text', content: 'Hi' } } }],
    ['POST', '/me/messages/AAMk/reply'],
  ];
  for (const [method, target, body] of ok) {
    assert.strictEqual((await ms._graph(acct, opts(), method, target, body === undefined ? {} : { body })).status, 200, `${method} ${target}`);
  }
  assert.deepStrictEqual(graph.requests.map((r) => r.method), ['GET', 'GET', 'GET', 'POST', 'POST', 'POST']);
});

// ---------- reply ----------

const ANN = { name: 'Ann', address: 'ann@example.com' };

test('sendReply: replies through Outlook with the text as typed, to the one address the reply box shows', async () => {
  fresh();
  graph.handler = graphWith({ reply: () => ({ status: 202 }) });
  const original = { id: 'AAMk=+', from: { name: 'Exams Office', address: 'exams@lboro.ac.uk' }, replyTo: null, subject: 'Exam timetable' };
  assert.deepStrictEqual(await ms.sendReply(account(), original, 'Thanks!\nSee you Monday.', opts()), { sent: true });
  assert.strictEqual(graph.requests.length, 1);
  const r = graph.requests[0];
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.path, '/v1.0/me/messages/AAMk%3D%2B/reply');
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.strictEqual(r.headers.authorization, 'Bearer SECRET-at-1');
  assert.deepStrictEqual(JSON.parse(r.text), {
    message: {
      toRecipients: [{ emailAddress: { address: 'exams@lboro.ac.uk', name: 'Exams Office' } }],
      body: { contentType: 'text', content: 'Thanks!\nSee you Monday.' },
    },
  });
});

test('sendReply: always names its one recipient, so Graph never adds a Reply-To address the user wasn\'t shown', async () => {
  // Left to itself, Graph replies to every Reply-To address. ClearMail shows one, so it sends to that one.
  const bank = { id: 'b1', from: { name: 'Kestrel Bank', address: 'alerts@kestrelbank.example' }, replyTo: { name: 'Kestrel Bank Support', address: 'support@kestrelbank.example' }, subject: 'Payee' };
  const cases = [
    [bank, [{ emailAddress: { address: 'support@kestrelbank.example', name: 'Kestrel Bank Support' } }]],
    // A Reply-To that is no address is skipped, as the reply box skips it: From it is.
    [{ ...bank, replyTo: { name: 'Fraud Team', address: 'fraud-team' } }, [{ emailAddress: { address: 'alerts@kestrelbank.example', name: 'Kestrel Bank' } }]],
    [{ ...bank, replyTo: null, from: { name: 'help@x.example', address: 'Help@X.example' } }, [{ emailAddress: { address: 'help@x.example' } }]],
  ];
  for (const [original, to] of cases) {
    fresh();
    graph.handler = graphWith({ reply: () => ({ status: 202 }) });
    await ms.sendReply(account(), original, 'My sort code is 12-34-56', opts());
    assert.deepStrictEqual(JSON.parse(graph.requests[0].text).message.toRecipients, to);
  }
  // No address to reply to: nothing is sent at all.
  fresh();
  await rejectsWith(ms.sendReply(account(), { id: 'n1', from: { name: 'Mail Delivery System', address: '' }, replyTo: { name: 'x', address: 'nobody' } }, 'Hi', opts()),
    'server', /^This email has no address to reply to\.$/);
  assert.strictEqual(graph.requests.length, 0);
});

test('fetchInbox: the Reply-To kept is the first real address Graph lists', async () => {
  fresh();
  const message = {
    ...MESSAGES[2], id: 'AAMk-rt', from: { emailAddress: { name: 'Kestrel Bank', address: 'alerts@kestrelbank.example' } },
    replyTo: [
      { emailAddress: { name: 'Fraud Team', address: 'fraud-team' } },
      { emailAddress: { name: 'Support', address: 'Support@KestrelBank.example' } },
      { emailAddress: { name: 'x', address: 'collector@attacker.example' } },
    ],
  };
  graph.handler = graphWith({ messages: [message], headers: { 'AAMk-rt': [] } });
  const [email] = await ms.fetchInbox(account(), opts());
  assert.deepStrictEqual(email.replyTo, { name: 'Support', address: 'support@kestrelbank.example' });
});

test('sendReply: failures are sentences, and a reply that may have gone is not sent twice', async () => {
  fresh();
  graph.handler = graphWith({ reply: () => ({ status: 404, json: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } }) });
  await rejectsWith(ms.sendReply(account(), { id: 'moved', from: ANN }, 'Hi', opts()), 'server', /no longer in your Outlook inbox/);

  fresh();
  graph.handler = graphWith({ reply: () => ({ status: 500, json: { error: { code: 'InternalServerError', message: 'Oops' } } }) });
  await rejectsWith(ms.sendReply(account(), { id: 'x', from: ANN }, 'Hi', opts()), 'server', /mail service is having problems/);
  assert.strictEqual(graph.requests.length, 1);

  fresh();
  ms._setTiming({ ...TIMING, requestTimeoutMs: 100 });
  graph.handler = () => ({ hang: true });
  await rejectsWith(ms.sendReply(account(), { id: 'x', from: ANN }, 'Hi', opts()), 'timeout', /took too long/);
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
  await rejectsWith(ms.fetchSentHistory(account(), null, opts()), 'needs-sign-in');
  await rejectsWith(ms.sendReply(account(), { id: 'a', from: ANN }, 'Hi', opts()), 'needs-sign-in');
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
  await rejectsWith(ms.fetchSentHistory(account(), null, { clientId: '  ' }), 'no-client-id');
  await rejectsWith(ms.sendReply(account(), { id: 'a', from: ANN }, 'Hi', { clientId: 'nope' }), 'no-client-id');
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

// ---------- the shared Microsoft stand-in (test/helpers/microsoft-server.js) ----------

test('against the Microsoft stand-in: sign in, read, read Sent and reply, and nothing else reaches the mailbox', async () => {
  fresh();
  const stand = await startMicrosoft({ clientId: CLIENT_ID });
  stand.installFetch();
  ms._setEndpoints({}); // the real Microsoft addresses, routed to the stand-in
  try {
    const me = 'willw6311@outlook.com';
    stand.addMailbox({
      email: me,
      displayName: 'Will Wright',
      messages: [
        graphMessage({ id: 'o1', from: ['Sarah', 'sarah@example.com'], to: [['Will', me]], subject: 'Quote', text: 'Could you sign it by Friday?', minutesAgo: 30, flagged: true }),
        graphMessage({
          id: 'o2', from: ['Weekly Builder', 'news@builder.example'], subject: 'Issue 12', text: 'News', minutesAgo: 90, focused: false,
          headers: { 'List-Unsubscribe': '<https://builder.example/u>', 'List-Id': '<weekly.builder.example>' }, inReplyTo: '<x@y>',
        }),
      ],
      sent: [sentMessage({ id: 's1', to: [['Sarah', 'Sarah@Example.com']], cc: [['Tom', 'tom@example.com']], minutesAgo: 10, conversationId: 'conv-o1' })],
    });
    stand.choose = () => ({ email: me });
    const signedIn = await ms.signIn({ clientId: CLIENT_ID, openUrl: stand.openBrowser });
    await stand.browsing;
    assert.deepStrictEqual([signedIn.email, signedIn.personal, signedIn.grantedScopes], [me, true, ['Mail.Read', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile']]);

    const scopes = [];
    const acct = { id: 'acc-stand', email: me, refreshToken: signedIn.refreshToken };
    const o = opts({ onGrantedScopes: (s) => scopes.push(s) });
    const emails = await ms.fetchInbox(acct, o);
    assert.deepStrictEqual(emails.map((e) => [e.id, e.flagged, e.focused, e.conversationId]), [['o2', false, false, 'conv-o2'], ['o1', true, true, 'conv-o1']]);
    assert.deepStrictEqual(emails[0].headers, { listUnsubscribe: '<https://builder.example/u>', listId: '<weekly.builder.example>', precedence: null, autoSubmitted: null });
    assert.strictEqual(emails[0].inReplyTo, '<x@y>');
    assert.match(emails[1].webLink, /^https:\/\/outlook\.live\.com\/owa\//);
    assert.deepStrictEqual(emails[1].to, [{ name: 'Will', address: me }]);
    assert.deepStrictEqual(stand.batches, [{ mailbox: me, ids: ['o1', 'o2'] }]);

    const sent = await ms.fetchSentHistory(acct, null, o);
    assert.deepStrictEqual(sent.entries, [{ from: me, to: ['sarah@example.com', 'tom@example.com'], date: sent.entries[0].date, conversationId: 'conv-o1', inReplyTo: null }]);
    assert.deepStrictEqual(await ms.sendReply(acct, emails[1], 'Signed, thanks.', o), { sent: true });
    assert.deepStrictEqual(stand.replies, [{
      mailbox: me, id: 'o1', to: ['sarah@example.com'],
      body: { message: { toRecipients: [{ emailAddress: { address: 'sarah@example.com', name: 'Sarah' } }], body: { contentType: 'text', content: 'Signed, thanks.' } } },
    }]);
    assert.deepStrictEqual(scopes, [['Mail.Read', 'Mail.Send', 'User.Read', 'email', 'openid', 'profile']]);

    // Every call was a read, a $batch of reads, or the one reply.
    const graphCalls = stand.requests.filter((r) => r.path !== '/common/oauth2/v2.0/token');
    assert.ok(graphCalls.every((r) => r.method === 'GET' || r.path === '/v1.0/$batch' || r.path === '/v1.0/me/messages/o1/reply'), JSON.stringify(graphCalls));
    assert.ok(stand.batchRequests.every((r) => r.method === 'GET'));
    assert.deepStrictEqual(stand.refused, []);

    // An unknown token gets nowhere.
    const direct = await fetch('https://graph.microsoft.com/v1.0/me/messages/o1', { method: 'PATCH', headers: { Authorization: 'Bearer nobody' } });
    assert.strictEqual(direct.status, 401);
  } finally {
    ms._setEndpoints({ login: login.base, graph: graph.base });
    await stand.close();
  }
});

test('against the Microsoft stand-in: an old consent is reported, and a 0.2 sign-in must be renewed', async () => {
  fresh();
  const stand = await startMicrosoft({ clientId: CLIENT_ID });
  stand.installFetch();
  ms._setEndpoints({});
  try {
    const uni = 'cvww@lunet.lboro.ac.uk';
    stand.addMailbox({ email: uni, displayName: 'Will', legacyConsent: true, messages: [] });
    stand.choose = () => ({ email: uni });
    const signedIn = await ms.signIn({ clientId: CLIENT_ID, openUrl: stand.openBrowser });
    await stand.browsing;
    assert.strictEqual(signedIn.personal, false);
    assert.ok(ms.grantsMailboxChanges(signedIn.grantedScopes), 'the old consent shows');
    assert.ok(!/ReadWrite/.test(stand.visits.at(-1).params.get('scope')), 'but ClearMail never asked for it');

    // A refresh token ClearMail 0.2 saved was granted for Mail.ReadWrite: Microsoft won't
    // refresh it for Mail.Read, so the account has to sign in again.
    const old = stand.issueRefreshToken(uni);
    await rejectsWith(ms.fetchInbox({ id: 'acc-old', email: uni, refreshToken: old }, opts()), 'needs-sign-in', /sign in to this account again/);

    // Refreshed tokens carry the old consent too, and main hears about it.
    const scopes = [];
    const acct = { id: 'acc-uni', email: uni, refreshToken: signedIn.refreshToken };
    const routed = globalThis.fetch;
    let bearer = null;
    globalThis.fetch = (input, init) => {
      bearer = init?.headers?.Authorization || bearer;
      return routed(input, init);
    };
    await ms.fetchInbox(acct, opts({ onGrantedScopes: (s) => scopes.push(s) }));
    globalThis.fetch = routed;
    assert.ok(ms.grantsMailboxChanges(scopes[0]));
    assert.deepStrictEqual(stand.tokenScopes.map((t) => t.grant), ['authorization_code', 'refresh_token']);

    // The stand-in itself turns away anything that would change the mailbox (also inside a
    // $batch) with a 405, and notes it, so other tests can check ms.refused stays empty.
    const call = (method, path, body) => fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method, headers: { Authorization: bearer, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    assert.strictEqual((await call('PATCH', '/me/messages/x', { isRead: true })).status, 405);
    assert.strictEqual((await call('DELETE', '/me/messages/x')).status, 405);
    assert.strictEqual((await call('POST', '/me/messages/x/move', { destinationId: 'deleteditems' })).status, 405);
    const batch = await (await call('POST', '/$batch', { requests: [{ id: '1', method: 'PATCH', url: '/me/messages/x', body: { isRead: true } }] })).json();
    assert.strictEqual(batch.responses[0].status, 405);
    assert.deepStrictEqual(stand.refused.map((r) => `${r.method} ${r.path}`), [
      'PATCH /v1.0/me/messages/x', 'DELETE /v1.0/me/messages/x', 'POST /v1.0/me/messages/x/move', 'PATCH /v1.0/me/messages/x',
    ]);
  } finally {
    ms._setEndpoints({ login: login.base, graph: graph.base });
    await stand.close();
  }
});

test('nothing was logged, and no token or code was ever printed', () => {
  assert.ok(printed.every((line) => !/SECRET/.test(line)), printed.join('\n'));
  assert.deepStrictEqual(printed, []);
});
