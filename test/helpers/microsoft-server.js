// A stand-in for login.microsoftonline.com and graph.microsoft.com on a local port, plus a
// fake web browser that signs in by following the authorize URL back to ClearMail's
// loopback redirect. installFetch() routes fetch calls for the real Microsoft addresses
// here, so src/microsoft.js runs with its production endpoints. Used by
// test/integration.test.js; not a test file itself.
//
// It checks what Microsoft checks (PKCE S256, redirect URI, no client secret, the client
// ID) and answers in Microsoft's formats. Tokens, codes and nothing else start "SECRET-",
// so a test can make sure none of them is ever logged or saved in plain text.
const crypto = require('crypto');
const http = require('http');

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com';
const realFetch = globalThis.fetch;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');

/**
 * A Graph message. from/replyTo are [name, address]; minutesAgo sets the dates;
 * attachments are { name, size, isInline, contentType }.
 */
function graphMessage({ id, from, replyTo, subject, text, minutesAgo = 60, isRead = false, attachments = [], html = false }) {
  const when = new Date(Date.now() - minutesAgo * 60000).toISOString();
  const address = ([name, addr]) => ({ emailAddress: { name, address: addr } });
  return {
    id,
    internetMessageId: `<${id}@mail.example>`,
    subject,
    from: address(from),
    sender: address(from),
    replyTo: replyTo ? [address(replyTo)] : [],
    sentDateTime: when,
    receivedDateTime: when,
    isRead,
    body: { contentType: html ? 'html' : 'text', content: text },
    attachments,
  };
}

async function startMicrosoft({ clientId }) {
  const ms = {
    requests: [], // { method, path, mailbox } for every request
    replies: [], // { mailbox, id, body }
    batches: [], // { mailbox, ids }
    visits: [], // the authorize pages the browser opened: { url, params, status, page }
    refreshTokensUsed: [], // { mailbox, token } for every refresh-token grant
    mailboxes: new Map(),
    // What the user does in the browser, given the authorize URL's query:
    // { email } signs in, { error, description } comes back with an error, { hang: true } never returns.
    choose: () => ({ hang: true }),
    pageSize: 1000,
  };
  const codes = new Map(); // code -> { email, challenge, method, redirectUri }
  const accessTokens = new Map(); // token -> email
  const refreshTokens = new Map(); // token -> email
  const revoked = new Set(); // tokens that no longer work
  let n = 0;

  ms.addMailbox = ({ email, displayName, mail = email, userPrincipalName = email, messages = [] }) => {
    const box = { email, displayName, mail, userPrincipalName, messages, forbidden: false, latestRefreshToken: null };
    ms.mailboxes.set(email, box);
    return box;
  };
  ms.mailbox = (email) => ms.mailboxes.get(email);
  // Like a password change or an admin revoking the sign-in: every token so far stops working.
  ms.revokeAll = (email) => {
    for (const [token, owner] of [...accessTokens, ...refreshTokens]) if (owner === email) revoked.add(token);
  };

  function issue(email) {
    const at = `SECRET-at-${++n}`;
    const rt = `SECRET-rt-${++n}`;
    accessTokens.set(at, email);
    refreshTokens.set(rt, email);
    ms.mailbox(email).latestRefreshToken = rt;
    return { token_type: 'Bearer', scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read', expires_in: 3599, ext_expires_in: 3599, access_token: at, refresh_token: rt };
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
      return { json: issue(grant.email) };
    }
    if (form.get('grant_type') === 'refresh_token') {
      const rt = form.get('refresh_token');
      const email = refreshTokens.get(rt);
      if (email) ms.refreshTokensUsed.push({ mailbox: email, token: rt });
      if (!email || revoked.has(rt)) return oauthError('invalid_grant', 70008, 'The refresh token has expired or is invalid due to sign-in frequency checks.');
      return { json: issue(email) }; // Microsoft hands out a new refresh token; the old one keeps working
    }
    return oauthError('unsupported_grant_type', 70003, 'Unsupported grant type.');
  }

  function graph(request, email) {
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
      const top = Math.min(Number(query.get('$top')), ms.pageSize); // Graph may send smaller pages
      const skip = Number(query.get('$skip') || 0);
      const all = [...box.messages].sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
      const page = all.slice(skip, skip + top).map((m) => structuredClone(m));
      const more = skip + top < all.length;
      const next = new URL(`${GRAPH}/v1.0/me/mailFolders/inbox/messages`);
      for (const [k, v] of query) next.searchParams.set(k, v);
      next.searchParams.set('$skip', String(skip + top));
      return { json: { '@odata.context': 'x', value: page, ...(more ? { '@odata.nextLink': next.toString() } : {}) } };
    }
    if (method === 'POST' && path === '/v1.0/$batch') {
      const { requests } = JSON.parse(request.text);
      const ids = [];
      const responses = requests.map((r) => {
        const m = /^\/me\/messages\/([^/?]+)$/.exec(r.url);
        const id = m && decodeURIComponent(m[1]);
        const msg = box.messages.find((x) => x.id === id);
        if (r.method !== 'PATCH' || !msg) return { id: r.id, status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } };
        Object.assign(msg, r.body);
        ids.push(id);
        return { id: r.id, status: 200, headers: { 'Content-Type': 'application/json' }, body: { id, isRead: msg.isRead } };
      });
      ms.batches.push({ mailbox: email, ids });
      return { json: { responses: responses.reverse() } }; // Graph answers in any order
    }
    const reply = /^\/v1\.0\/me\/messages\/([^/]+)\/reply$/.exec(path);
    if (method === 'POST' && reply) {
      const id = decodeURIComponent(reply[1]);
      if (!box.messages.some((x) => x.id === id)) return graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
      ms.replies.push({ mailbox: email, id, body: JSON.parse(request.text) });
      return { status: 202 };
    }
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
      codes.set(code, { email: choice.email, challenge: params.get('code_challenge'), method: params.get('code_challenge_method'), redirectUri: params.get('redirect_uri') });
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

module.exports = { startMicrosoft, graphMessage };
