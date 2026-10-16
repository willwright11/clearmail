// Outlook.com and Microsoft 365 through Microsoft Graph. Microsoft has turned off
// app-password IMAP and SMTP, so ClearMail signs in with OAuth 2.0 in the user's own
// browser (authorization code + PKCE, as a public client with no secret) and then reads
// and sends mail with Graph. Nothing in this file logs tokens, codes or email content.

const crypto = require('crypto');
const http = require('http');
const { htmlToText } = require('./cleaner');

const SCOPES = 'openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';

const DEFAULT_ENDPOINTS = { login: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com' };
const DEFAULT_TIMING = {
  requestTimeoutMs: 60 * 1000, // one HTTP request, including reading the answer
  attempts: 3, // tries for a request Microsoft throttles (429/503)
  maxRetryWaitMs: 20 * 1000, // a longer Retry-After gives up straight away instead
  backoffMs: 1000, // first wait when Microsoft gives no Retry-After; doubles each time
};
let endpoints = { ...DEFAULT_ENDPOINTS };
let timing = { ...DEFAULT_TIMING };

const REFRESH_EARLY_MS = 5 * 60 * 1000; // refresh access tokens this long before they expire
const PAGE_SIZE = 100; // messages per Graph page
const BATCH_LIMIT = 20; // Graph's limit for one JSON batch
const TEXT_LIMIT = 1024 * 1024; // characters of body text kept per email, as mail.js does
const MESSAGE_FIELDS = 'id,internetMessageId,subject,from,sender,replyTo,sentDateTime,receivedDateTime,isRead,body';
const ATTACHMENT_FIELDS = 'name,size,isInline,contentType'; // never contentBytes: no attachment is downloaded
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

const MSG = {
  noClientId: 'To add an Outlook account, ClearMail needs a Microsoft app ID (the "Application (client) ID"). Add it in Settings. See "Using Outlook" in the README for the 5-minute setup.',
  badClientId: 'The Microsoft app ID in Settings doesn\'t look right. It should look like 1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f. Copy the "Application (client) ID" again (see "Using Outlook" in the README).',
  signInAgain: 'Microsoft needs you to sign in to this account again. Use "Sign in again" to reconnect it.',
  signInUnfinished: "Signing in to Microsoft didn't finish. Please try again.",
  noAccess: 'Microsoft didn\'t let ClearMail into this mailbox. Use "Sign in again" and allow access when asked. If that doesn\'t help, your organisation may be blocking ClearMail.',
  admin: "Your organisation (for example your university's IT team) has to approve ClearMail before it can read this mailbox. You can ask them to approve it, or forward this mailbox's email to your personal Outlook account and read it there instead.",
  cancelled: 'Signing in to Microsoft was cancelled.',
  signInTimeout: 'Signing in to Microsoft took too long, so ClearMail stopped waiting. Please try again.',
  timeout: 'Microsoft took too long to respond. Check your internet connection and try again.',
  network: "Couldn't reach Microsoft. Check your internet connection and try again.",
  busy: 'Microsoft is getting too many requests right now. Wait a minute, then try again.',
  loginDown: "Microsoft's sign-in service is having problems. Please try again in a moment.",
  graphDown: "Microsoft's mail service is having problems. Please try again in a moment.",
  notPublic: 'Microsoft treated ClearMail as a website instead of a Mac app. In the app registration, add the redirect URI http://localhost under "Mobile and desktop applications" (see "Using Outlook" in the README).',
  unknownApp: 'Microsoft doesn\'t recognise the app ID in Settings. Check the "Application (client) ID" was copied correctly, and that the app registration allows personal Microsoft accounts and work or school accounts.',
  badRedirect: 'ClearMail\'s app registration is missing its redirect URI. Add http://localhost under "Mobile and desktop applications" (see "Using Outlook" in the README).',
  noBrowser: "ClearMail couldn't open your web browser to sign in to Microsoft.",
  noCode: "Microsoft didn't send ClearMail a sign-in code. Please try again.",
  noRefresh: "Microsoft didn't let ClearMail stay signed in, so it can't check your mail. Please try again.",
  noEmail: "Microsoft didn't say which email address you signed in with. Please try again.",
  noMailbox: "ClearMail can't reach the mailbox of this Microsoft account. The account may not have an Outlook mailbox, or your organisation may keep its email on its own servers.",
  gone: 'This email is no longer in your Outlook inbox (it may have been moved or deleted). Refresh and try again.',
  truncated: 'This email is very long, so ClearMail only shows the start of it. Open it in Outlook to read the rest.',
};

const ACTION = {
  signIn: "Couldn't sign in to Microsoft",
  load: "Couldn't load your Outlook inbox",
  seen: "Couldn't mark the email as read",
  reply: "Couldn't send your reply",
};

// AADSTS codes (https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes).
const ADMIN_CODES = new Set([65001, 90094, 90095, 50105, 53003, 530032]); // the organisation must allow it
const CANCEL_CODES = new Set([65004]); // the user declined
const SIGN_IN_CODES = new Set([50076, 50078, 50079, 50133, 50173, 54005, 70000, 70008, 700082]); // fresh sign-in fixes it
const NOT_PUBLIC_CODES = new Set([7000218, 700025]); // redirect URI registered as "Web"
const UNKNOWN_APP_CODES = new Set([700016, 70001, 7000112]);
const REDIRECT_CODES = new Set([50011]);
const SIGN_IN_ERRORS = ['invalid_grant', 'interaction_required', 'login_required', 'consent_required'];

// Marks errors made here, so the outer catch passes them on untouched.
const OURS = Symbol('clearmail.microsoft');

function fail(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  err[OURS] = true;
  return err;
}

// Anything unexpected (a bug, odd data) still reaches the user as a sentence.
function friendly(err, action) {
  if (err && err[OURS]) return err;
  return fail('server', `${action}. Please try again.`, err);
}

// Graph error text is short English, but keep it to one tidy line.
const said = (value) => String(value || '').replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 200);

// ---------- HTTP ----------

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(fail('cancelled', MSG.cancelled));
  const onAbort = () => {
    clearTimeout(timer);
    reject(fail('cancelled', MSG.cancelled));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

// One request with a time limit. Resolves { status, headers, data } for every HTTP answer
// (data is the parsed JSON body or null); rejects only when no answer arrived.
async function send(url, init, signal) {
  const timeout = AbortSignal.timeout(timing.requestTimeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, headers: res.headers, data };
  } catch (err) {
    if (signal?.aborted) throw fail('cancelled', MSG.cancelled, err);
    if (timeout.aborted) throw fail('timeout', MSG.timeout, err);
    throw fail('network', MSG.network, err);
  }
}

// Milliseconds to wait before retrying: Retry-After (seconds or a date), else a doubling backoff.
function retryDelay(value, attempt) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const when = text ? Date.parse(text) : NaN;
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return timing.backoffMs * 2 ** (attempt - 1);
}

const isBusy = (status) => status === 429 || status === 503;

// Retries a throttled request as Microsoft asks, a few times and never for long. Gives
// back the last answer, so the caller turns a 429/503 that won't clear into 'throttled'.
async function withRetry(request, signal) {
  for (let attempt = 1; ; attempt++) {
    const res = await request();
    if (!isBusy(res.status)) return res;
    const wait = retryDelay(res.headers.get('retry-after'), attempt);
    if (attempt >= timing.attempts || wait > timing.maxRetryWaitMs) return res;
    await sleep(wait, signal);
  }
}

// ---------- errors from Microsoft ----------

function stsCodes(data) {
  const codes = Array.isArray(data?.error_codes) ? data.error_codes.map(Number) : [];
  for (const m of String(data?.error_description || '').matchAll(/AADSTS(\d+)/g)) codes.push(Number(m[1]));
  return codes;
}

// An OAuth error, from the sign-in redirect or the token endpoint. Only the error name
// and AADSTS numbers are kept: the description can hold the user's address.
function authError(data, context) {
  const error = said(data?.error);
  const codes = stsCodes(data);
  const has = (set) => codes.some((c) => set.has(c));
  const cause = new Error(`Microsoft sign-in error ${error || 'unknown'}${codes.length ? ` (AADSTS${codes.join(', AADSTS')})` : ''}`);
  if (has(ADMIN_CODES)) return fail('admin-approval', MSG.admin, cause);
  if (has(CANCEL_CODES) || error === 'access_denied') return fail('cancelled', MSG.cancelled, cause);
  if (has(NOT_PUBLIC_CODES)) return fail('server', MSG.notPublic, cause);
  if (has(UNKNOWN_APP_CODES) || error === 'unauthorized_client') return fail('server', MSG.unknownApp, cause);
  if (has(REDIRECT_CODES)) return fail('server', MSG.badRedirect, cause);
  if (has(SIGN_IN_CODES) || SIGN_IN_ERRORS.includes(error)) {
    return fail('needs-sign-in', context === 'sign-in' ? MSG.signInUnfinished : MSG.signInAgain, cause);
  }
  if (error === 'temporarily_unavailable' || error === 'server_error') return fail('server', MSG.loginDown, cause);
  const ref = codes.length ? ` (Microsoft error AADSTS${codes[0]})` : '';
  return fail('server', `${context === 'sign-in' ? ACTION.signIn : 'Microsoft sign-in failed'}${ref}. Please try again.`, cause);
}

// A Graph answer that wasn't a success, as a sentence for the user. `item` is set for one
// message inside a batch: a refusal there says nothing about the sign-in as a whole.
function graphError(res, action, { item = false } = {}) {
  const error = res.data && res.data.error && typeof res.data.error === 'object' ? res.data.error : {};
  const code = said(error.code);
  const text = said(error.message);
  const cause = new Error(`Microsoft Graph HTTP ${res.status}${code ? ` ${code}` : ''}${text ? `: ${text}` : ''}`);
  if (/^Mailbox(?:NotEnabled|NotSupported)ForRESTAPI$|^MailboxInfoStale$/i.test(code)) return fail('server', MSG.noMailbox, cause);
  if (res.status === 401 && !item) return fail('needs-sign-in', MSG.signInAgain, cause);
  if (res.status === 403 && !item) return fail('needs-sign-in', MSG.noAccess, cause);
  if (res.status === 404 && /ItemNotFound/i.test(code)) return fail('server', MSG.gone, cause);
  if (isBusy(res.status)) return fail('throttled', MSG.busy, cause);
  if (res.status >= 500) return fail('server', MSG.graphDown, cause);
  return fail('server', text ? `${action}. Microsoft said: "${text}"` : `${action}. Please try again.`, cause);
}

function checkClientId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw fail('no-client-id', MSG.noClientId);
  if (!GUID_RE.test(id)) throw fail('no-client-id', MSG.badClientId);
  return id;
}

// ---------- tokens ----------

async function tokenRequest(params, context, signal) {
  const res = await withRetry(() => send(`${endpoints.login}/common/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  }, signal), signal);
  if (res.status === 200 && typeof res.data?.access_token === 'string' && res.data.access_token) return res.data;
  if (isBusy(res.status)) throw fail('throttled', MSG.busy, new Error(`Microsoft sign-in HTTP ${res.status}`));
  if (res.data && typeof res.data.error === 'string') throw authError(res.data, context);
  throw fail('server', MSG.loginDown, new Error(`Microsoft sign-in HTTP ${res.status}`));
}

// Access tokens live only in memory, one session per account id. `known` holds every
// refresh token this session has used or been given, so a caller that hasn't saved the
// newest one yet still shares the session; any other token means a fresh sign-in.
const sessions = new Map();

function sessionFor(account) {
  const key = String(account.id || account.email || '');
  let s = sessions.get(key);
  if (!s || !s.known.includes(account.refreshToken)) {
    s = { token: null, expiresAt: 0, refreshToken: account.refreshToken, known: [account.refreshToken], pending: null };
    sessions.set(key, s);
  }
  return s;
}

function tellNewToken(onRefreshToken, token) {
  if (typeof onRefreshToken !== 'function') return;
  try {
    Promise.resolve(onRefreshToken(token)).catch(() => {});
  } catch {}
}

async function refresh(s, { clientId, onRefreshToken }) {
  const data = await tokenRequest({
    client_id: checkClientId(clientId),
    grant_type: 'refresh_token',
    refresh_token: s.refreshToken,
    scope: SCOPES,
  }, 'refresh');
  s.token = data.access_token;
  s.expiresAt = Date.now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
  // Microsoft may hand out a new refresh token; the old one should then be thrown away.
  const next = data.refresh_token;
  if (typeof next === 'string' && next && next !== s.refreshToken) {
    s.refreshToken = next;
    s.known.push(next);
    if (s.known.length > 20) s.known.splice(1, 1);
    tellNewToken(onRefreshToken, next);
  }
  return s.token;
}

// A valid access token for the account. Calls made at the same time share one refresh.
async function accessToken(account, opts) {
  if (!account || typeof account.refreshToken !== 'string' || !account.refreshToken) throw fail('needs-sign-in', MSG.signInAgain);
  const s = sessionFor(account);
  if (s.token && Date.now() < s.expiresAt - REFRESH_EARLY_MS) return s.token;
  if (!s.pending) s.pending = refresh(s, opts).finally(() => { s.pending = null; });
  return s.pending;
}

function dropToken(account, token) {
  const s = sessions.get(String(account.id || account.email || ''));
  if (s && s.token === token) {
    s.token = null;
    s.expiresAt = 0;
  }
}

// A Graph call as this account. target is a path under /v1.0 or a full nextLink URL.
async function graph(account, opts, method, target, { body, headers } = {}) {
  const url = /^https?:\/\//.test(target) ? target : `${endpoints.graph}/v1.0${target}`;
  for (let attempt = 1; ; attempt++) {
    const token = await accessToken(account, opts);
    const res = await withRetry(() => send(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    // An access token can stop working before it expires (a password change, say): refresh once.
    if (res.status === 401 && attempt === 1) {
      dropToken(account, token);
      continue;
    }
    return res;
  }
}

// ---------- sign-in ----------

const PAGE_STYLE = 'body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:32em;margin:15vh auto;padding:0 16px;text-align:center;color:#111b21;background:#fff}h1{font-size:22px}@media (prefers-color-scheme:dark){body{color:#e9edef;background:#0b141a}}';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A small static page for the browser tab. Resolves once it has been sent (or given up on).
function page(res, status, title, message) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ClearMail</title><style>${PAGE_STYLE}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    res.on('close', done);
    res.on('error', done);
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    });
    res.end(html, done);
  });
}

function sameState(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A loopback server that lives for one sign-in. It answers only GET / with the expected
// state, once; anything else gets an error page and doesn't end the sign-in.
function startLoopback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let waiter = null;

    server.on('request', (req, res) => {
      let url = null;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {}
      if (!url || req.method !== 'GET' || url.pathname !== '/') {
        page(res, 404, 'Not found', 'There is nothing here.');
        return;
      }
      if (!waiter || !sameState(url.searchParams.get('state'), waiter.state)) {
        page(res, 400, "This sign-in link isn't valid", 'Go back to ClearMail and start signing in again.');
        return;
      }
      waiter.resolve({ params: url.searchParams, respond: (status, title, message) => page(res, status, title, message) });
    });

    const fails = (err) => {
      if (waiter) waiter.reject(fail('network', "ClearMail couldn't wait for Microsoft to finish signing you in. Please try again.", err));
    };
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', fails); // never let a server error go unhandled
      resolve({
        port: server.address().port,
        // Resolves with the callback's query once the browser comes back with our state.
        waitFor(state, timeoutMs, signal) {
          return new Promise((done, failed) => {
            const finish = () => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              waiter = null;
            };
            const onAbort = () => {
              finish();
              failed(fail('cancelled', MSG.cancelled));
            };
            const timer = setTimeout(() => {
              finish();
              failed(fail('timeout', MSG.signInTimeout));
            }, timeoutMs);
            waiter = {
              state,
              resolve: (value) => { finish(); done(value); },
              reject: (err) => { finish(); failed(err); },
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
        fail: (err) => waiter?.reject(err),
        close() {
          waiter?.reject(fail('cancelled', MSG.cancelled));
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

async function finishSignIn(params, { clientId, verifier, redirectUri, signal }) {
  if (params.get('error')) {
    throw authError({ error: params.get('error'), error_description: params.get('error_description') }, 'sign-in');
  }
  const code = params.get('code');
  if (!code) throw fail('server', MSG.noCode);
  const tokens = await tokenRequest({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: SCOPES,
  }, 'sign-in', signal);
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw fail('server', MSG.noRefresh);
  const me = await withRetry(() => send(`${endpoints.graph}/v1.0/me?$select=displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  }, signal), signal);
  if (me.status !== 200) {
    const err = graphError(me, ACTION.signIn);
    if (err.code === 'needs-sign-in') err.message = MSG.signInUnfinished; // there is no account to "sign in again" yet
    throw err;
  }
  const email = String(me.data?.mail || me.data?.userPrincipalName || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw fail('server', MSG.noEmail);
  const name = String(me.data?.displayName || '').trim() || email;
  return { email, name, refreshToken: tokens.refresh_token };
}

/**
 * Signs in to a Microsoft account in the system browser.
 * @param {{ clientId: string, openUrl: (url: string) => any, loginHint?: string,
 *   timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ email: string, name: string, refreshToken: string }>}
 */
async function signIn({ clientId, openUrl, loginHint, timeoutMs = 300000, signal } = {}) {
  try {
    const client = checkClientId(clientId);
    if (typeof openUrl !== 'function') throw new TypeError('signIn needs an openUrl function');
    if (signal?.aborted) throw fail('cancelled', MSG.cancelled);
    const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300000;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    const loopback = await startLoopback();
    try {
      // Microsoft ignores the port of a localhost redirect URI, so registering
      // http://localhost covers whichever port this sign-in got.
      const redirectUri = `http://localhost:${loopback.port}`;
      const query = new URLSearchParams({
        client_id: client,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: SCOPES,
        state,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      const hint = typeof loginHint === 'string' ? loginHint.trim() : '';
      if (hint) query.set('login_hint', hint);
      const url = `${endpoints.login}/common/oauth2/v2.0/authorize?${query.toString().replace(/\+/g, '%20')}`;

      const callback = loopback.waitFor(state, wait, signal);
      // Not awaited before the callback: opening the browser may only settle after it.
      Promise.resolve().then(() => openUrl(url)).catch((err) => loopback.fail(fail('server', MSG.noBrowser, err)));
      const { params, respond } = await callback;
      try {
        const account = await finishSignIn(params, { clientId: client, verifier, redirectUri, signal });
        await respond(200, "You're signed in", 'You can close this tab and go back to ClearMail.');
        return account;
      } catch (err) {
        const out = friendly(err, ACTION.signIn);
        await respond(out.code === 'cancelled' ? 200 : 400, "Signing in didn't finish", `${out.message} You can close this tab and go back to ClearMail.`);
        throw out;
      }
    } finally {
      loopback.close();
    }
  } catch (err) {
    throw friendly(err, ACTION.signIn);
  }
}

// ---------- mail ----------

function toAddress(recipient) {
  const entry = recipient && recipient.emailAddress;
  if (!entry || !entry.address) return null;
  const address = String(entry.address).trim().toLowerCase();
  if (!address) return null;
  return { name: String(entry.name || '').trim() || address, address };
}

function isoDate(...candidates) {
  for (const value of candidates) {
    const date = value ? new Date(value) : null;
    if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function capText(text) {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n[${MSG.truncated}]` : text;
}

// The body arrives as plain text (we ask for it). If Graph sends HTML anyway, it is
// converted here as mail.js does, and kept as html so nothing is lost. It is never rendered.
function bodyOf(body) {
  const content = typeof body?.content === 'string' ? body.content : '';
  if (String(body?.contentType || '').toLowerCase() === 'html') {
    let text = '';
    try {
      text = htmlToText(content);
    } catch {}
    return { text: capText(text), html: content };
  }
  return { text: capText(content.replace(/\r\n?/g, '\n')), html: '' };
}

// Same rule as mail.js: images embedded in the body are not attachments.
const isAttachment = (a) => a && typeof a === 'object' && !(a.isInline && (!a.contentType || /^image\//i.test(a.contentType)));

function toRawEmail(msg) {
  const messageId = typeof msg.internetMessageId === 'string' ? msg.internetMessageId.trim() : '';
  return {
    id: msg.id,
    messageId: messageId || null,
    uid: null,
    from: toAddress(msg.from) || toAddress(msg.sender) || { name: 'Unknown sender', address: '' },
    replyTo: [].concat(msg.replyTo || []).map(toAddress).find(Boolean) || null,
    subject: String(msg.subject ?? ''),
    date: isoDate(msg.sentDateTime, msg.receivedDateTime),
    ...bodyOf(msg.body),
    seen: msg.isRead === true,
    references: [],
    attachments: [].concat(msg.attachments || []).filter(isAttachment)
      .map((a) => ({ filename: String(a.name || 'attachment'), size: Number(a.size) || 0 })),
  };
}

// Only follow a nextLink back to Graph itself: the access token must never go elsewhere.
function nextPage(link) {
  if (typeof link !== 'string') return null;
  try {
    return new URL(link).origin === new URL(endpoints.graph).origin ? link : null;
  } catch {
    return null;
  }
}

/**
 * The newest `limit` inbox messages, oldest first, in the shape mail.js fetchInbox returns.
 * @param {{ id: string, refreshToken: string }} account
 * @param {{ clientId: string, limit?: number, onRefreshToken?: (token: string) => any }} options
 */
async function fetchInbox(account, { clientId, limit = 60, onRefreshToken } = {}) {
  const max = Math.min(Math.max(Math.floor(Number(limit)) || 60, 1), 500);
  const opts = { clientId, onRefreshToken };
  try {
    let next = `${endpoints.graph}/v1.0/me/mailFolders/inbox/messages?$top=${Math.min(max, PAGE_SIZE)}` +
      `&$orderby=receivedDateTime%20desc&$select=${MESSAGE_FIELDS}&$expand=attachments($select=${ATTACHMENT_FIELDS})`;
    const found = new Map();
    while (next && found.size < max) {
      const res = await graph(account, opts, 'GET', next, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      if (res.status !== 200) throw graphError(res, ACTION.load);
      // Not Graph's answer (a Wi-Fi login page, say): don't show it as an empty inbox.
      if (!Array.isArray(res.data?.value)) throw fail('server', `${ACTION.load}. Microsoft's answer couldn't be read. Please try again.`);
      const list = res.data.value;
      const before = found.size;
      for (const msg of list) {
        if (found.size >= max) break;
        // New mail arriving between pages can repeat a message on the next page.
        if (msg && typeof msg.id === 'string' && msg.id && !found.has(msg.id)) found.set(msg.id, toRawEmail(msg));
      }
      // A page with nothing new would only lead to more of the same.
      next = found.size > before ? nextPage(res.data['@odata.nextLink']) : null;
    }
    return [...found.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (err) {
    throw friendly(err, ACTION.load);
  }
}

// Marks up to 20 messages read in one JSON batch, retrying the throttled ones.
async function markBatch(account, opts, ids) {
  let pending = ids.map((id, i) => ({
    id: String(i + 1),
    method: 'PATCH',
    url: `/me/messages/${encodeURIComponent(id)}`,
    headers: { 'Content-Type': 'application/json' },
    body: { isRead: true },
  }));
  for (let attempt = 1; pending.length; attempt++) {
    const res = await graph(account, opts, 'POST', '/$batch', { body: { requests: pending } });
    if (res.status !== 200) throw graphError(res, ACTION.seen);
    const answers = new Map((Array.isArray(res.data?.responses) ? res.data.responses : []).map((r) => [String(r?.id), r]));
    const busy = [];
    let wait = 0;
    for (const request of pending) {
      const answer = answers.get(request.id);
      const status = Number(answer?.status);
      if (!answer) throw fail('server', `${ACTION.seen}. Microsoft didn't confirm it. Please try again.`);
      if (status >= 200 && status < 300) continue;
      // Deleted or moved meanwhile: there is nothing left to mark (IMAP ignores these too).
      if (status === 404) continue;
      if (isBusy(status)) {
        const headers = answer.headers && typeof answer.headers === 'object' ? answer.headers : {};
        const after = Object.entries(headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
        wait = Math.max(wait, retryDelay(after, attempt));
        busy.push(request);
        continue;
      }
      throw graphError({ status, data: answer.body }, ACTION.seen, { item: true });
    }
    if (busy.length && (attempt >= timing.attempts || wait > timing.maxRetryWaitMs)) {
      throw fail('throttled', MSG.busy, new Error(`Microsoft Graph throttled ${busy.length} of a batch`));
    }
    if (busy.length) await sleep(wait);
    pending = busy;
  }
}

/** Marks messages (Graph ids) as read; rejects if Microsoft refused any of them. */
async function markSeen(account, ids, { clientId, onRefreshToken } = {}) {
  const list = [...new Set([].concat(ids || []).filter((id) => typeof id === 'string' && id))];
  if (!list.length) return;
  try {
    for (let i = 0; i < list.length; i += BATCH_LIMIT) {
      await markBatch(account, { clientId, onRefreshToken }, list.slice(i, i + BATCH_LIMIT));
    }
  } catch (err) {
    throw friendly(err, ACTION.seen);
  }
}

/**
 * Replies to the sender (or Reply-To) of rawEmail. Outlook threads the reply and files
 * it in Sent Items itself. The body is sent as plain text, like mail.js replies: Graph's
 * `comment` would run the lines together when the original is HTML.
 */
async function sendReply(account, rawEmail, body, { clientId, onRefreshToken } = {}) {
  try {
    const id = rawEmail && typeof rawEmail.id === 'string' ? rawEmail.id : '';
    if (!id) throw fail('server', MSG.gone);
    const res = await graph(account, { clientId, onRefreshToken }, 'POST', `/me/messages/${encodeURIComponent(id)}/reply`, {
      body: { message: { body: { contentType: 'text', content: String(body ?? '') } } },
    });
    if (res.status < 200 || res.status >= 300) throw graphError(res, ACTION.reply);
    return { sent: true };
  } catch (err) {
    throw friendly(err, ACTION.reply);
  }
}

/** Forgets the cached access token of an account (when it is removed). */
function forgetAccount(id) {
  sessions.delete(String(id || ''));
}

// ---------- test hooks ----------

function _setEndpoints({ login, graph: graphUrl } = {}) {
  endpoints = {
    login: String(login || DEFAULT_ENDPOINTS.login).replace(/\/+$/, ''),
    graph: String(graphUrl || DEFAULT_ENDPOINTS.graph).replace(/\/+$/, ''),
  };
}

function _setTiming(overrides = {}) {
  timing = { ...DEFAULT_TIMING, ...overrides };
}

function _reset() {
  sessions.clear();
}

module.exports = { SCOPES, signIn, fetchInbox, markSeen, sendReply, forgetAccount, _setEndpoints, _setTiming, _reset };
