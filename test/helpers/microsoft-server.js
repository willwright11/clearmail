// A stand-in for login.microsoftonline.com and graph.microsoft.com on a local port, plus a
// fake web browser that signs in by following the authorize URL back to ClearMail's
// loopback redirect. installFetch() routes fetch calls for the real Microsoft addresses
// here, so src/microsoft.js runs with its production endpoints. Used by
// test/integration.test.js and test/microsoft.test.js; not a test file itself.
//
// It checks what Microsoft checks (PKCE S256, redirect URI, no client secret, the client
// ID, refresh scopes within what was first granted) and answers in Microsoft's formats.
// Tokens, codes and nothing else start "SECRET-", so a test can make sure none of them is
// ever logged or saved in plain text.
//
// ClearMail may only read and reply. Graph here serves GETs, $batch of GETs and
// POST /me/messages/{id}/reply; anything else (PATCH, DELETE, /move, /send, a PATCH inside a
// $batch...) gets 405 and is recorded in ms.refused, so a test can assert it stays empty.
const crypto = require('crypto');
const http = require('http');

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com';
const GRAPH_PREFIX = `${GRAPH}/`;
const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const WORK_TENANT = '5b3c2f1e-8d7a-4c6b-9e0f-1a2b3c4d5e6f';
// Scopes every sign-in may ask for without the app registration listing them.
const OIDC = new Set(['openid', 'profile', 'email', 'offline_access']);
// What ClearMail 0.2 asked for: an old consent still grants Mail.ReadWrite.
const LEGACY_SCOPE = 'openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';
const realFetch = globalThis.fetch;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const address = ([name, addr]) => ({ emailAddress: { name, address: addr } });
const minutesAgoIso = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

// Scope names as Microsoft compares them: Graph's prefix dropped, case ignored.
const scopeName = (s) => (s.toLowerCase().startsWith(GRAPH_PREFIX.toLowerCase()) ? s.slice(GRAPH_PREFIX.length) : s).toLowerCase();
const scopeWords = (text) => String(text || '').split(/\s+/).filter(Boolean);

/**
 * A Graph inbox message. from/replyTo are [name, address]; to/cc are lists of them;
 * minutesAgo sets the dates; attachments are { name, size, isInline, contentType };
 * headers are extra internet headers ({ 'List-Unsubscribe': '<https://...>' }), only
 * served by a single-message GET as Graph does. focused: true (Focused), false (Other)
 * or null (no inferenceClassification).
 */
function graphMessage({
  id, from, replyTo, to = [], cc = [], subject, text, minutesAgo = 60, isRead = false, attachments = [], html = false,
  importance = 'normal', focused = true, flagged = false, conversationId, webLink, headers = {}, inReplyTo = null,
}) {
  const when = minutesAgoIso(minutesAgo);
  const internetMessageId = `<${id}@mail.example>`;
  const internetMessageHeaders = [
    { name: 'Message-ID', value: internetMessageId },
    { name: 'Subject', value: String(subject ?? '') },
    ...(inReplyTo ? [{ name: 'In-Reply-To', value: inReplyTo }] : []),
    ...Object.entries(headers).map(([name, value]) => ({ name, value })),
  ];
  return {
    id,
    internetMessageId,
    subject,
    from: address(from),
    sender: address(from),
    replyTo: replyTo ? [address(replyTo)] : [],
    toRecipients: to.map(address),
    ccRecipients: cc.map(address),
    sentDateTime: when,
    receivedDateTime: when,
    isRead,
    importance,
    ...(focused === null ? {} : { inferenceClassification: focused ? 'focused' : 'other' }),
    flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
    conversationId: conversationId || `conv-${id}`,
    webLink: webLink || `https://outlook.live.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
    body: { contentType: html ? 'html' : 'text', content: text },
    attachments,
    internetMessageHeaders,
  };
}

/**
 * A message in Sent Items. to/cc/bcc are lists of [name, address]; from defaults to the
 * mailbox's own address when served.
 */
function sentMessage({ id, from, to = [], cc = [], bcc = [], minutesAgo = 60, conversationId, subject = '' }) {
  return {
    id,
    ...(from ? { from: address(from) } : {}),
    subject,
    toRecipients: to.map(address),
    ccRecipients: cc.map(address),
    bccRecipients: bcc.map(address),
    conversationId: conversationId || `conv-${id}`,
    sentDateTime: minutesAgoIso(minutesAgo),
  };
}

// Only the $select-ed fields (and id), like Graph; attachments only with $expand.
function project(message, query) {
  const fields = new Set(['id', ...String(query.get('$select') || '').split(',').filter(Boolean)]);
  const out = {};
  for (const field of fields) if (Object.hasOwn(message, field)) out[field] = structuredClone(message[field]);
  if (/^attachments\(/.test(query.get('$expand') || '')) out.attachments = structuredClone(message.attachments || []);
  return out;
}

async function startMicrosoft({ clientId }) {
  const ms = {
    requests: [], // { method, path, mailbox } for every request
    replies: [], // { mailbox, id, body }
    batches: [], // { mailbox, ids }: the messages each $batch read
    batchRequests: [], // { mailbox, method, url } for every request inside a $batch
    refused: [], // { mailbox, method, path }: calls that would have changed a mailbox (405)
    visits: [], // the authorize pages the browser opened: { url, params, status, page }
    refreshTokensUsed: [], // { mailbox, token } for every refresh-token grant
    tokenScopes: [], // { mailbox, grant, requested, granted } for every token issued
    mailboxes: new Map(),
    // What the user does in the browser, given the authorize URL's query:
    // { email } signs in, { error, description } comes back with an error, { hang: true } never returns.
    choose: () => ({ hang: true }),
    pageSize: 1000,
    // An old consent that still grants Mail.ReadWrite on every token (also per mailbox).
    legacyConsent: false,
  };
  const codes = new Map(); // code -> { email, challenge, method, redirectUri, scope }
  const accessTokens = new Map(); // token -> email
  const refreshTokens = new Map(); // token -> { email, scope: the scopes first asked for }
  const revoked = new Set(); // tokens that no longer work
  let n = 0;

  ms.addMailbox = ({ email, displayName, mail = email, userPrincipalName = email, messages = [], sent = [], personal, legacyConsent }) => {
    const box = {
      email, displayName, mail, userPrincipalName, messages, sent, forbidden: false, latestRefreshToken: null,
      personal: personal ?? /@(?:outlook|hotmail|live)\./i.test(email),
      legacyConsent,
    };
    ms.mailboxes.set(email, box);
    return box;
  };
  ms.mailbox = (email) => ms.mailboxes.get(email);
  // Like a password change or an admin revoking the sign-in: every token so far stops working.
  ms.revokeAll = (email) => {
    for (const [token, owner] of accessTokens) if (owner === email) revoked.add(token);
    for (const [token, grant] of refreshTokens) if (grant.email === email) revoked.add(token);
  };
  // A refresh token as an earlier ClearMail saved it (by default with 0.2's Mail.ReadWrite grant).
  ms.issueRefreshToken = (email, { scope = LEGACY_SCOPE } = {}) => {
    const rt = `SECRET-rt-${++n}`;
    refreshTokens.set(rt, { email, scope });
    return rt;
  };

  // Microsoft lists the Graph permissions the access token carries (with their prefix)
  // and the sign-in ones it granted; an old consent adds what it granted then.
  function grantedScope(email, requested) {
    const words = scopeWords(requested).filter((s) => s !== 'offline_access');
    const box = ms.mailbox(email);
    if ((box.legacyConsent ?? ms.legacyConsent) && !words.some((s) => scopeName(s) === 'mail.readwrite')) {
      words.push(`${GRAPH_PREFIX}Mail.ReadWrite`);
    }
    return words.join(' ');
  }

  function issue(email, scope, grant) {
    const box = ms.mailbox(email);
    const at = `SECRET-at-${++n}`;
    const rt = `SECRET-rt-${++n}`;
    accessTokens.set(at, email);
    refreshTokens.set(rt, { email, scope });
    box.latestRefreshToken = rt;
    const granted = grantedScope(email, scope);
    ms.tokenScopes.push({ mailbox: email, grant, requested: scope, granted });
    // The id_token's middle part is the claims; its signature is never checked by ClearMail.
    const idToken = `SECRET-idt.${b64({ tid: box.personal ? PERSONAL_TENANT : WORK_TENANT, preferred_username: email, name: box.displayName })}.sig`;
    return { token_type: 'Bearer', scope: granted, expires_in: 3599, ext_expires_in: 3599, access_token: at, refresh_token: rt, id_token: idToken };
  }

  const oauthError = (error, code, text) => ({ status: 400, json: { error, error_description: `AADSTS${code}: ${text} Trace ID: 0000`, error_codes: [code] } });
  const graphError = (status, code, message) => ({ status, json: { error: { code, message } } });

  function token(form) {
    if (form.get('client_id') !== clientId) return oauthError('unauthorized_client', 700016, 'Application not found in the directory.');
    if (form.has('client_secret')) return oauthError('invalid_request', 90014, 'A public client must not send a secret.');
    if (!/\boffline_access\b/.test(form.get('scope') || '')) return oauthError('invalid_request', 90014, 'Missing scope.');
    if (form.get('grant_type') === 'authorization_code') {
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code')); // a code works once
      if (!grant) return oauthError('invalid_grant', 70000, 'The provided authorization code is invalid.');
      if (grant.method !== 'S256' || sha256(form.get('code_verifier') || '') !== grant.challenge) return oauthError('invalid_grant', 501481, 'The Code_Verifier does not match the code_challenge.');
      if (form.get('redirect_uri') !== grant.redirectUri) return oauthError('invalid_grant', 50148, 'The redirect_uri does not match.');
      return { json: issue(grant.email, grant.scope, 'authorization_code') };
    }
    if (form.get('grant_type') === 'refresh_token') {
      const rt = form.get('refresh_token');
      const grant = refreshTokens.get(rt);
      if (grant) ms.refreshTokensUsed.push({ mailbox: grant.email, token: rt });
      if (!grant || revoked.has(rt)) return oauthError('invalid_grant', 70008, 'The refresh token has expired or is invalid due to sign-in frequency checks.');
      // A refresh may only ask for what the first sign-in asked for (or less).
      const first = new Set(scopeWords(grant.scope).map(scopeName));
      const outside = scopeWords(form.get('scope')).filter((s) => !OIDC.has(scopeName(s)) && !first.has(scopeName(s)));
      if (outside.length) return oauthError('invalid_grant', 70000, 'The request was denied because one or more scopes requested are unauthorized or expired. The user must first sign in and grant the client application access to the requested scope.');
      return { json: issue(grant.email, grant.scope, 'refresh_token') }; // Microsoft hands out a new refresh token; the old one keeps working
    }
    return oauthError('unsupported_grant_type', 70003, 'Unsupported grant type.');
  }

  const notFound = () => graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');

  // One page of a newest-first list, with a nextLink that skips ahead like Graph's.
  function listPage(all, path, query) {
    const top = Math.min(Number(query.get('$top')) || 10, ms.pageSize); // Graph may send smaller pages
    const skip = Number(query.get('$skip') || 0);
    const page = all.slice(skip, skip + top).map((m) => project(m, query));
    const next = new URL(`${GRAPH}${path}`);
    for (const [k, v] of query) next.searchParams.set(k, v);
    next.searchParams.set('$skip', String(skip + top));
    return { json: { '@odata.context': 'x', value: page, ...(skip + top < all.length ? { '@odata.nextLink': next.toString() } : {}) } };
  }

  function refuse(email, method, path) {
    ms.refused.push({ mailbox: email, method, path });
    return graphError(405, 'ErrorInvalidRequest', `ClearMail's stand-in Microsoft refuses ${method} ${path}: ClearMail may only read and reply.`);
  }

  function graph(request, email, { inBatch = false } = {}) {
    const box = ms.mailbox(email);
    const { method, path, query } = request;
    if (method === 'GET' && path === '/v1.0/me') {
      return { json: { displayName: box.displayName, mail: box.mail, userPrincipalName: box.userPrincipalName } };
    }
    if (box.forbidden) return graphError(403, 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.');
    if (method === 'GET' && path === '/v1.0/me/mailFolders/inbox/messages') {
      if (request.headers.prefer !== 'outlook.body-content-type="text"') return graphError(400, 'BadRequest', 'Expected the text body Prefer header.');
      if (query.get('$orderby') !== 'receivedDateTime desc') return graphError(400, 'BadRequest', 'Unexpected $orderby.');
      if (!/^attachments\(\$select=[^)]*\)$/.test(query.get('$expand') || '') || /contentBytes/.test(query.get('$expand'))) {
        return graphError(400, 'BadRequest', 'Unexpected $expand.');
      }
      // Graph only documents internet headers for one message at a time.
      if (/internetMessageHeaders/.test(query.get('$select') || '')) return graphError(400, 'BadRequest', 'internetMessageHeaders is not supported on a list.');
      const all = [...box.messages].sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
      return listPage(all, path, query);
    }
    if (method === 'GET' && path === '/v1.0/me/mailFolders/sentitems/messages') {
      if (query.get('$orderby') !== 'sentDateTime desc') return graphError(400, 'BadRequest', 'Unexpected $orderby.');
      let all = [...box.sent].map((m) => (m.from ? m : { ...m, from: address([box.displayName, box.mail || box.userPrincipalName]) }));
      const filter = query.get('$filter');
      if (filter) {
        const m = /^sentDateTime gt (\d{4}-\d\d-\d\dT[\d:.]+Z)$/.exec(filter);
        if (!m) return graphError(400, 'BadRequest', 'Invalid filter clause');
        all = all.filter((x) => new Date(x.sentDateTime) > new Date(m[1]));
      }
      all.sort((a, b) => new Date(b.sentDateTime) - new Date(a.sentDateTime));
      return listPage(all, path, query);
    }
    const one = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(path);
    if (method === 'GET' && one) {
      const msg = box.messages.find((x) => x.id === decodeURIComponent(one[1]));
      return msg ? { json: project(msg, query) } : notFound();
    }
    if (method === 'POST' && path === '/v1.0/$batch' && !inBatch) {
      const { requests } = JSON.parse(request.text);
      const ids = [];
      const responses = requests.map((r) => {
        ms.batchRequests.push({ mailbox: email, method: r.method, url: r.url });
        const url = new URL(r.url, 'http://graph.local');
        const inner = { method: String(r.method || '').toUpperCase(), path: `/v1.0${url.pathname}`, query: url.searchParams, headers: r.headers || {}, text: r.body === undefined ? '' : JSON.stringify(r.body) };
        const out = inner.method === 'GET' ? graph(inner, email, { inBatch: true }) : refuse(email, inner.method, inner.path);
        const m = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(inner.path);
        if (m && (out.status || 200) === 200) ids.push(decodeURIComponent(m[1]));
        return { id: r.id, status: out.status || 200, headers: { 'Content-Type': 'application/json' }, body: out.json };
      });
      ms.batches.push({ mailbox: email, ids });
      return { json: { responses: responses.reverse() } }; // Graph answers in any order
    }
    const reply = /^\/v1\.0\/me\/messages\/([^/]+)\/reply$/.exec(path);
    if (method === 'POST' && reply && !inBatch) {
      const id = decodeURIComponent(reply[1]);
      if (!box.messages.some((x) => x.id === id)) return notFound();
      ms.replies.push({ mailbox: email, id, body: JSON.parse(request.text) });
      return { status: 202 };
    }
    if (method !== 'GET') return refuse(email, method, path);
    return graphError(404, 'NoRoute', `No route for ${method} ${path}`);
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://mock');
    const request = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, text: Buffer.concat(chunks).toString() };
    let out;
    let mailbox = null;
    if (request.method === 'POST' && request.path === '/common/oauth2/v2.0/token') {
      out = token(new URLSearchParams(request.text));
    } else {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      mailbox = accessTokens.get(bearer) || null;
      out = !mailbox || revoked.has(bearer)
        ? graphError(401, 'InvalidAuthenticationToken', 'Access token has expired or is not yet valid.')
        : graph(request, mailbox);
    }
    ms.requests.push({ method: request.method, path: request.path, mailbox });
    res.writeHead(out.status || 200, out.json === undefined ? {} : { 'Content-Type': 'application/json' });
    res.end(out.json === undefined ? '' : JSON.stringify(out.json));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ms.base = `http://127.0.0.1:${server.address().port}`;

  // The browser: shell.openExternal(url) in the fake electron calls this. It doesn't wait
  // for the round trip, like a real browser; ms.browsing settles once ClearMail's page is shown.
  ms.openBrowser = (url) => {
    const u = new URL(url);
    if (u.origin !== LOGIN || u.pathname !== '/common/oauth2/v2.0/authorize') throw new Error(`The browser was sent to ${u.origin}${u.pathname}`);
    const params = u.searchParams;
    const visit = { url, params };
    ms.visits.push(visit);
    const choice = ms.choose(params);
    if (choice.hang) return;
    const back = new URL(params.get('redirect_uri'));
    if (back.protocol !== 'http:' || back.hostname !== 'localhost') throw new Error('The redirect URI is not http://localhost');
    back.hostname = '127.0.0.1'; // ClearMail's loopback server listens on IPv4
    if (choice.error) {
      back.search = new URLSearchParams({ error: choice.error, error_description: choice.description || '', state: params.get('state') }).toString();
    } else {
      const code = `SECRET-code-${++n}`;
      codes.set(code, {
        email: choice.email, challenge: params.get('code_challenge'), method: params.get('code_challenge_method'),
        redirectUri: params.get('redirect_uri'), scope: params.get('scope') || '',
      });
      back.search = new URLSearchParams({ code, state: params.get('state'), session_state: 'abc' }).toString();
    }
    ms.browsing = realFetch(back).then(async (res) => {
      visit.status = res.status;
      visit.page = await res.text();
    });
  };

  // Calls to the real Microsoft addresses come here instead.
  ms.installFetch = () => {
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.origin === LOGIN || url.origin === GRAPH) return realFetch(`${ms.base}${url.pathname}${url.search}`, init);
      return realFetch(input, init);
    };
  };
  ms.close = () => {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return ms;
}

module.exports = { startMicrosoft, graphMessage, sentMessage, PERSONAL_TENANT, LEGACY_SCOPE };
