// Outlook.com and Microsoft 365 through Microsoft Graph. Microsoft has turned off
// app-password IMAP and SMTP, so ClearMail signs in with OAuth 2.0 in the user's own
// browser (authorization code + PKCE, as a public client with no secret) and then reads
// mail and sends replies with Graph. Nothing in this file logs tokens, codes or email content.
//
// ClearMail reads and replies, and never changes the mailbox. It asks Microsoft for
// Mail.Read and Mail.Send only: Mail.ReadWrite (which can mark as read, move or delete) is
// never requested. graph() also refuses, before anything is sent, every request that isn't a
// read (GET, or a $batch of GETs) or a reply the user wrote (POST /me/messages/{id}/reply).

const crypto = require('crypto');
const http = require('http');
const { htmlToText } = require('./cleaner');

/**
 * An email as both backends return it (src/mail.js builds the same shape).
 * @typedef {{ name: string, address: string }} Address  the address is lower-cased
 * @typedef {{ listUnsubscribe: string|null, listId: string|null, precedence: string|null,
 *   autoSubmitted: string|null }} MailHeaders  raw values (precedence and autoSubmitted lower-cased)
 * @typedef {Object} RawEmail
 * @property {string} id
 * @property {string|null} messageId
 * @property {number|null} uid  IMAP only
 * @property {Address} from
 * @property {Address|null} replyTo
 * @property {Address[]} to
 * @property {Address[]} cc
 * @property {string} subject
 * @property {string} date  ISO: when it was sent
 * @property {string} receivedAt  ISO: when it arrived
 * @property {string} text
 * @property {string} html  kept as data, never rendered
 * @property {boolean} seen  the mailbox's own read state (ClearMail never changes it)
 * @property {boolean} flagged
 * @property {string[]} references
 * @property {{ filename: string, size: number }[]} attachments
 * @property {MailHeaders|null} headers  null while unknown
 * @property {'low'|'normal'|'high'} importance
 * @property {boolean|null} focused  Outlook's Focused (true) or Other (false); null over IMAP
 * @property {string|null} conversationId  Graph only
 * @property {string|null} inReplyTo
 * @property {string|null} webLink  Graph only: https on an Outlook web host, else null
 *
 * What fetchSentHistory returns. `full` means the entries are the whole history (start
 * again from them); otherwise they are only what was sent since the cursor passed in.
 * @typedef {{ from: string, to: string[], date: string, conversationId: string|null,
 *   inReplyTo: string|null }} SentEntry  addresses lower-cased; to holds To, Cc and Bcc
 * @typedef {{ cursor: { kind: 'graph', since: string|null, fullAt: number }, full: boolean,
 *   entries: SentEntry[] }} SentBatch
 *
 * Options every mail call takes. onRefreshToken gets each new refresh token Microsoft hands
 * out; onGrantedScopes gets the permissions a refreshed token carries, when they change.
 * @typedef {{ clientId: string, onRefreshToken?: (token: string) => any,
 *   onGrantedScopes?: (scopes: string[]) => any }} GraphOptions
 */

const SCOPES = 'openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send';
const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/';
// A permission that could change the mailbox. Asked for by ClearMail 0.2, so an old consent
// can still carry it; the account then shows how to take it back.
const WRITE_SCOPE_RE = /^Mail\.ReadWrite(?:\.Shared)?$/i;
// The `tid` of every personal Microsoft account (Outlook.com, Hotmail, Live).
const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const DEFAULT_ENDPOINTS = { login: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com' };
const DEFAULT_TIMING = {
  requestTimeoutMs: 60 * 1000, // one HTTP request, including reading the answer
  attempts: 3, // tries for a request Microsoft throttles (429/503)
  maxRetryWaitMs: 20 * 1000, // a longer Retry-After gives up straight away instead
  backoffMs: 1000, // first wait when Microsoft gives no Retry-After; doubles each time
  headerBudgetMs: 15 * 1000, // time a load may spend on mailing-list headers before showing the emails without them
};
let endpoints = { ...DEFAULT_ENDPOINTS };
let timing = { ...DEFAULT_TIMING };

const REFRESH_EARLY_MS = 5 * 60 * 1000; // refresh access tokens this long before they expire
const PAGE_SIZE = 50; // messages per Graph page (big pages can time out at Microsoft's end)
const BATCH_LIMIT = 20; // Graph's limit for one JSON batch
const TEXT_LIMIT = 1024 * 1024; // characters of body text kept per email, as mail.js does
const MESSAGE_FIELDS = 'id,internetMessageId,subject,from,sender,replyTo,toRecipients,ccRecipients,sentDateTime,receivedDateTime,' +
  'isRead,importance,inferenceClassification,flag,conversationId,webLink,body';
const ATTACHMENT_FIELDS = 'name,size,isInline,contentType'; // never contentBytes: no attachment is downloaded
const SENT_FIELDS = 'id,from,toRecipients,ccRecipients,bccRecipients,conversationId,sentDateTime';
const SENT_LIMIT = 500; // sent emails read at most per sync
const SENT_FULL_EVERY_MS = 30 * 24 * 3600 * 1000; // the sent history is rebuilt from scratch this often
const HEADER_CACHE_LIMIT = 10000; // emails whose mailing-list headers are remembered (they never change)
const ADDRESS_LIMIT = 500; // recipients kept per email
// Where an email's "Open in Outlook on the web" link may point.
const WEB_LINK_HOSTS = new Set(['outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft']);
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const PERSONAL_DOMAIN_RE = /@(?:outlook|hotmail|live|msn|passport)\.[a-z.]+$/i;

const MSG = {
  noClientId: 'To add an Outlook account, ClearMail needs a Microsoft app ID (the "Application (client) ID"). Add it in Settings. See "Using Outlook" in the README for the 5-minute setup.',
  badClientId: 'The Microsoft app ID in Settings doesn\'t look right. It should look like 1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f. Copy the "Application (client) ID" again (see "Using Outlook" in the README).',
  signInAgain: 'Microsoft needs you to sign in to this account again. Use "Sign in again" to reconnect it.',
  signInUnfinished: "Signing in to Microsoft didn't finish. Please try again.",
  noAccess: 'Microsoft didn\'t let ClearMail into this mailbox. Use "Sign in again" and allow access when asked. If that doesn\'t help, your organisation may be blocking ClearMail.',
  admin: "Your organisation (for example your university's IT team) has to approve ClearMail before it can read this mailbox. You can ask them to approve it for your account, or keep reading this mailbox in Outlook as usual.",
  cancelled: 'Signing in to Microsoft was cancelled.',
  // Microsoft never returns to ClearMail after "Approval required" → "Back to app" (it sends a
  // plain refusal), nor at all for a wrong app ID or redirect URI, so these say what to check.
  signInDeclined: 'Signing in to Microsoft didn\'t finish. If Microsoft said "Need admin approval" or "Approval required", your organisation (for example your university\'s IT team) has to approve ClearMail first: see "University and work accounts" in the README.',
  signInTimeout: 'ClearMail stopped waiting for Microsoft. If Microsoft\'s page showed an error such as AADSTS700016 or AADSTS50011, the app registration needs fixing: check the Application (client) ID and that http://localhost is under "Mobile and desktop applications" (see "If something goes wrong" in the README). Otherwise, please try again.',
  timeout: 'Microsoft took too long to respond. Check your internet connection and try again.',
  network: "Couldn't reach Microsoft. Check your internet connection and try again.",
  busy: 'Microsoft is getting too many requests right now. Wait a minute, then try again.',
  loginDown: "Microsoft's sign-in service is having problems. Please try again in a moment.",
  graphDown: "Microsoft's mail service is having problems. Please try again in a moment.",
  spa: 'Microsoft treated ClearMail as a web page app. In the app registration, remove http://localhost from "Single-page application" and add it under "Mobile and desktop applications" instead (see "Using Outlook" in the README).',
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
  blocked: 'ClearMail stopped a request that would have changed your mailbox. ClearMail only reads your email and sends the replies you write, so nothing was changed.',
};

const ACTION = {
  signIn: "Couldn't sign in to Microsoft",
  load: "Couldn't load your Outlook inbox",
  history: "Couldn't read your sent emails",
  reply: "Couldn't send your reply",
};

// AADSTS codes (https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes).
const ADMIN_CODES = new Set([65001, 90094, 90095, 50105, 53003, 530032]); // the organisation must allow it
const CANCEL_CODES = new Set([65004]); // the user declined
const SIGN_IN_CODES = new Set([50076, 50078, 50079, 50133, 50173, 54005, 70000, 70008, 700082]); // fresh sign-in fixes it
const NOT_PUBLIC_CODES = new Set([7000218, 700025]); // redirect URI registered as "Web"
const SPA_CODES = new Set([9002326, 9002327]); // redirect URI registered as "Single-page application"
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
    // Graph and the token endpoint never redirect; following one could carry the token away.
    const res = await fetch(url, { ...init, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
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
  if (has(CANCEL_CODES) || error === 'access_denied') {
    return fail('cancelled', context === 'sign-in' ? MSG.signInDeclined : MSG.cancelled, cause);
  }
  if (has(SPA_CODES)) return fail('server', MSG.spa, cause);
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

// ---------- permissions ----------

/**
 * The permissions in a token response's `scope`, as short names ("Mail.Read", not
 * "https://graph.microsoft.com/Mail.Read"), sorted. null when Microsoft didn't list any.
 * @param {unknown} value
 * @returns {string[]|null}
 */
function scopeList(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const out = new Set();
  for (const word of value.trim().split(/\s+/)) {
    const name = word.toLowerCase().startsWith(GRAPH_SCOPE_PREFIX) ? word.slice(GRAPH_SCOPE_PREFIX.length) : word;
    if (/^[\w.-]{1,100}$/.test(name)) out.add(name);
  }
  return [...out].sort();
}

/**
 * Whether these granted permissions could change the mailbox (an old Mail.ReadWrite
 * consent). ClearMail never uses it, but the user may want to take it back.
 * @param {string[]|null|undefined} grantedScopes
 */
function grantsMailboxChanges(grantedScopes) {
  return Array.isArray(grantedScopes) && grantedScopes.some((s) => typeof s === 'string' && WRITE_SCOPE_RE.test(s));
}

// The tenant of the id_token, read without checking its signature: it only decides which
// Microsoft page ClearMail points to, never what ClearMail may do.
function tenantOf(idToken) {
  const part = typeof idToken === 'string' ? idToken.split('.')[1] : '';
  if (!part || part.length > 16384) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof claims?.tid === 'string' ? claims.tid.toLowerCase() : null;
  } catch {
    return null;
  }
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

const accountKey = (account) => String(account.id || account.email || '');

function sessionFor(account) {
  const key = accountKey(account);
  let s = sessions.get(key);
  if (!s || !s.known.includes(account.refreshToken)) {
    s = { token: null, expiresAt: 0, refreshToken: account.refreshToken, known: [account.refreshToken], pending: null, scopes: null };
    sessions.set(key, s);
  }
  return s;
}

// Calls back main without letting its failure break the mail call.
function tell(callback, value) {
  if (typeof callback !== 'function') return;
  try {
    Promise.resolve(callback(value)).catch(() => {});
  } catch {}
}

async function refresh(s, { clientId, onRefreshToken, onGrantedScopes }) {
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
    tell(onRefreshToken, next);
  }
  // What the token is valid for, so Settings can warn about an old Mail.ReadWrite consent.
  const scopes = scopeList(data.scope);
  if (scopes && scopes.join(' ') !== (s.scopes || []).join(' ')) {
    s.scopes = scopes;
    tell(onGrantedScopes, [...scopes]);
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
  const s = sessions.get(accountKey(account));
  if (s && s.token === token) {
    s.token = null;
    s.expiresAt = 0;
  }
}

// ---------- the write guard ----------

const REPLY_PATH_RE = /^\/me\/messages\/[^/]+\/reply$/;

// A $batch ClearMail may send: 1–20 GETs of Graph paths, with no bodies.
function getOnlyBatch(body) {
  const list = body && typeof body === 'object' ? body.requests : null;
  return Array.isArray(list) && list.length > 0 && list.length <= BATCH_LIMIT && list.every((r) => r && typeof r === 'object' &&
    r.method === 'GET' && r.body === undefined && typeof r.url === 'string' && /^\/[^/\\]/.test(r.url));
}

// The only requests ClearMail makes: a read (GET, or a $batch of GETs) or a reply
// (POST /me/messages/{id}/reply), and only to Graph itself. Anything else would change
// the mailbox, or send the token elsewhere, so it is never sent.
function allowed(method, url, body) {
  let target;
  let base;
  try {
    target = new URL(url);
    base = new URL(endpoints.graph);
  } catch {
    return false;
  }
  if (target.origin !== base.origin || target.username || target.password) return false;
  const root = `${base.pathname.replace(/\/+$/, '')}/v1.0/`;
  if (!target.pathname.startsWith(root)) return false;
  const path = target.pathname.slice(root.length - 1); // dot segments are already resolved by URL
  if (method === 'GET') return body === undefined;
  if (method !== 'POST') return false;
  if (path === '/$batch') return !target.search && getOnlyBatch(body);
  return REPLY_PATH_RE.test(path) && !target.search;
}

// A Graph call as this account. target is a path under /v1.0 or a full nextLink URL.
async function graph(account, opts, method, target, { body, headers, signal } = {}) {
  const verb = String(method || '').toUpperCase();
  const url = /^https?:\/\//i.test(target) ? target : `${endpoints.graph}/v1.0${target}`;
  if (!allowed(verb, url, body)) throw fail('server', MSG.blocked, new Error(`Refused to send ${verb} to Microsoft Graph`));
  for (let attempt = 1; ; attempt++) {
    const token = await accessToken(account, opts);
    const res = await withRetry(() => send(url, {
      method: verb,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, signal), signal);
    // An access token can stop working before it expires (a password change, say): refresh once.
    if (res.status === 401 && attempt === 1) {
      dropToken(account, token);
      continue;
    }
    return res;
  }
}

// Up to 20 GETs in one JSON batch. Throttled ones are retried on their own, as Microsoft
// asks; any that stay throttled come back with their 429. Answers are in the order of
// `paths` as { status, body } (status 0: Microsoft didn't answer that one).
async function batchGet(account, opts, paths, action, { signal } = {}) {
  const out = paths.map(() => ({ status: 0, body: null }));
  let pending = paths.map((url, i) => ({ id: String(i + 1), method: 'GET', url }));
  for (let attempt = 1; pending.length; attempt++) {
    const res = await graph(account, opts, 'POST', '/$batch', { body: { requests: pending }, signal });
    if (res.status !== 200) throw graphError(res, action);
    const answers = new Map((Array.isArray(res.data?.responses) ? res.data.responses : []).map((r) => [String(r?.id), r]));
    const busy = [];
    let wait = 0;
    for (const request of pending) {
      const answer = answers.get(request.id);
      const status = Number(answer?.status) || 0;
      out[Number(request.id) - 1] = { status, body: answer?.body ?? null };
      if (!isBusy(status)) continue;
      const headers = answer.headers && typeof answer.headers === 'object' ? answer.headers : {};
      const after = Object.entries(headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
      wait = Math.max(wait, retryDelay(after, attempt));
      busy.push(request);
    }
    if (!busy.length || attempt >= timing.attempts || wait > timing.maxRetryWaitMs) break;
    await sleep(wait, signal);
    pending = busy;
  }
  return out;
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
  const tenant = tenantOf(tokens.id_token);
  return {
    email,
    name,
    refreshToken: tokens.refresh_token,
    grantedScopes: scopeList(tokens.scope) || [],
    // Decides which Microsoft page lists the app's permissions (personal or work account).
    personal: tenant ? tenant === PERSONAL_TENANT : PERSONAL_DOMAIN_RE.test(email),
  };
}

/**
 * Signs in to a Microsoft account in the system browser. grantedScopes are the
 * permissions Microsoft granted, as short names; personal is true for Outlook.com-style
 * accounts and false for work or school ones.
 * @param {{ clientId: string, openUrl: (url: string) => any, loginHint?: string,
 *   timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ email: string, name: string, refreshToken: string, grantedScopes: string[], personal: boolean }>}
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

// A Graph recipient list as unique addresses, in order.
function addressList(...lists) {
  const out = new Map();
  for (const recipient of lists.flatMap((list) => (Array.isArray(list) ? list : []))) {
    const found = toAddress(recipient);
    if (found && !out.has(found.address) && out.size < ADDRESS_LIMIT) out.set(found.address, found);
  }
  return [...out.values()];
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

/**
 * The email's "Open in Outlook on the web" link, if it is https on one of Outlook's own
 * web hosts; null otherwise, so ClearMail never opens anywhere else.
 * @param {unknown} value
 * @returns {string|null}
 */
function safeWebLink(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !WEB_LINK_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const IMPORTANCE = new Set(['low', 'normal', 'high']);
const importanceOf = (value) => (IMPORTANCE.has(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'normal');

function focusedOf(value) {
  const kind = String(value || '').toLowerCase();
  return kind === 'focused' ? true : kind === 'other' ? false : null;
}

const idOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function toRawEmail(msg) {
  return {
    id: msg.id,
    messageId: idOrNull(msg.internetMessageId),
    uid: null,
    from: toAddress(msg.from) || toAddress(msg.sender) || { name: 'Unknown sender', address: '' },
    replyTo: [].concat(msg.replyTo || []).map(toAddress).find(Boolean) || null,
    to: addressList(msg.toRecipients),
    cc: addressList(msg.ccRecipients),
    subject: String(msg.subject ?? ''),
    date: isoDate(msg.sentDateTime, msg.receivedDateTime),
    receivedAt: isoDate(msg.receivedDateTime, msg.sentDateTime),
    ...bodyOf(msg.body),
    seen: msg.isRead === true,
    flagged: String(msg.flag?.flagStatus || '').toLowerCase() === 'flagged',
    references: [],
    attachments: [].concat(msg.attachments || []).filter(isAttachment)
      .map((a) => ({ filename: String(a.name || 'attachment'), size: Number(a.size) || 0 })),
    headers: null, // filled in from the header cache once known
    importance: importanceOf(msg.importance),
    focused: focusedOf(msg.inferenceClassification),
    conversationId: idOrNull(msg.conversationId),
    inReplyTo: null, // from the headers too
    webLink: safeWebLink(msg.webLink),
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

// ---------- mailing-list headers ----------

// Graph only returns internetMessageHeaders for one message at a time, so they are fetched
// in batches the first time an email is seen and remembered: they never change.
// `${account}\n${message id}` -> { headers, inReplyTo }, oldest first.
const headerCache = new Map();

const headerKey = (account, id) => `${accountKey(account)}\n${id}`;

function tidyHeader(value) {
  if (value == null) return null;
  const text = String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  return text || null;
}

const lowerHeader = (value) => tidyHeader(value)?.toLowerCase() ?? null;

// The first <message-id> in a header value.
function messageIdOf(value) {
  const text = tidyHeader(value);
  if (!text) return null;
  return /<[^<>\s]+>/.exec(text)?.[0] ?? text.split(' ')[0];
}

function headersOf(list) {
  const lines = Array.isArray(list) ? list : [];
  const value = (name) => lines.find((h) => h && String(h.name || '').toLowerCase() === name)?.value;
  return {
    headers: {
      listUnsubscribe: tidyHeader(value('list-unsubscribe')),
      listId: tidyHeader(value('list-id')),
      precedence: lowerHeader(value('precedence')),
      autoSubmitted: lowerHeader(value('auto-submitted')),
    },
    inReplyTo: messageIdOf(value('in-reply-to')),
  };
}

function rememberHeaders(key, value) {
  headerCache.delete(key);
  headerCache.set(key, value);
  while (headerCache.size > HEADER_CACHE_LIMIT) headerCache.delete(headerCache.keys().next().value);
}

// Microsoft won't give this email's headers, and asking again won't change that.
const refusedForGood = (status) => status >= 400 && status < 500 && ![404, 408, 409, 429].includes(status);

// Fetches the headers of the emails not yet cached, newest first, for at most
// headerBudgetMs. They only help sorting, so a failure or running out of time just leaves
// those emails' headers unknown (null) until the next load. An email Microsoft refuses for
// good stays unknown without being asked for again.
async function loadHeaders(account, opts, ids) {
  const budget = AbortSignal.timeout(timing.headerBudgetMs);
  try {
    for (let i = 0; i < ids.length && !budget.aborted; i += BATCH_LIMIT) {
      const chunk = ids.slice(i, i + BATCH_LIMIT);
      const paths = chunk.map((id) => `/me/messages/${encodeURIComponent(id)}?$select=internetMessageHeaders`);
      const answers = await batchGet(account, opts, paths, ACTION.load, { signal: budget });
      answers.forEach((answer, j) => {
        const key = headerKey(account, chunk[j]);
        if (answer.status >= 200 && answer.status < 300 && answer.body && typeof answer.body === 'object') {
          rememberHeaders(key, headersOf(answer.body.internetMessageHeaders));
        } else if (refusedForGood(answer.status)) {
          rememberHeaders(key, { headers: null, inReplyTo: null });
        }
      });
    }
  } catch {}
}

// ---------- reading ----------

function mailOptions({ clientId, onRefreshToken, onGrantedScopes } = {}) {
  return { clientId, onRefreshToken, onGrantedScopes };
}

/**
 * The newest `limit` inbox messages, oldest first, in the shape mail.js fetchInbox returns.
 * Reading never marks anything as read.
 * @param {{ id: string, refreshToken: string }} account
 * @param {GraphOptions & { limit?: number }} options
 * @returns {Promise<RawEmail[]>}
 */
async function fetchInbox(account, { limit = 60, ...options } = {}) {
  const max = Math.min(Math.max(Math.floor(Number(limit)) || 60, 1), 500);
  const opts = mailOptions(options);
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
    const emails = [...found.values()];
    await loadHeaders(account, opts, emails.map((e) => e.id).filter((id) => !headerCache.has(headerKey(account, id))));
    for (const email of emails) {
      const key = headerKey(account, email.id);
      const known = headerCache.get(key);
      if (!known) continue;
      rememberHeaders(key, known); // still in the inbox: keep it cached
      email.headers = known.headers ? { ...known.headers } : null;
      email.inReplyTo = known.inReplyTo;
    }
    return emails.sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (err) {
    throw friendly(err, ACTION.load);
  }
}

// One sent email, or null without a usable date (it can't say when the user wrote).
function sentEntry(msg) {
  const date = new Date(typeof msg.sentDateTime === 'string' ? msg.sentDateTime : NaN);
  if (Number.isNaN(date.getTime())) return null;
  const from = toAddress(msg.from) || toAddress(msg.sender);
  return {
    from: from ? from.address : '',
    to: addressList(msg.toRecipients, msg.ccRecipients, msg.bccRecipients).map((a) => a.address),
    date: date.toISOString(),
    conversationId: idOrNull(msg.conversationId),
    inReplyTo: null, // Graph threads replies by conversationId
  };
}

// A cursor from an earlier sync that can be continued, or null for a full rebuild.
function continuable(cursor, now) {
  if (!cursor || typeof cursor !== 'object' || cursor.kind !== 'graph') return null;
  const since = typeof cursor.since === 'string' ? Date.parse(cursor.since) : NaN;
  const fullAt = Number(cursor.fullAt);
  if (Number.isNaN(since) || !Number.isFinite(fullAt) || fullAt > now || now - fullAt >= SENT_FULL_EVERY_MS) return null;
  return { since: new Date(since).toISOString(), fullAt };
}

/**
 * Who the user has written to, from Sent Items: the newest 500 on the first sync (and every
 * 30 days), then only what was sent since the cursor. Reads only.
 * @param {{ id: string, refreshToken: string }} account
 * @param {SentBatch['cursor']|null} cursor  from the last SentBatch
 * @param {GraphOptions} options
 * @returns {Promise<SentBatch>}
 */
async function fetchSentHistory(account, cursor, options = {}) {
  const opts = mailOptions(options);
  const now = Date.now();
  const last = continuable(cursor, now);
  try {
    let next = `${endpoints.graph}/v1.0/me/mailFolders/sentitems/messages?$top=${PAGE_SIZE}&$orderby=sentDateTime%20desc&$select=${SENT_FIELDS}` +
      (last ? `&$filter=${encodeURIComponent(`sentDateTime gt ${last.since}`)}` : '');
    const seen = new Set();
    const entries = [];
    while (next && seen.size < SENT_LIMIT) {
      const res = await graph(account, opts, 'GET', next);
      // No Sent Items folder: nothing has been sent from here.
      if (res.status === 404 && /ItemNotFound/i.test(said(res.data?.error?.code))) break;
      if (res.status !== 200) throw graphError(res, ACTION.history);
      if (!Array.isArray(res.data?.value)) throw fail('server', `${ACTION.history}. Microsoft's answer couldn't be read. Please try again.`);
      const before = seen.size;
      for (const msg of res.data.value) {
        if (seen.size >= SENT_LIMIT) break;
        // New mail sent between pages can repeat a message on the next page.
        if (!msg || typeof msg.id !== 'string' || !msg.id || seen.has(msg.id)) continue;
        seen.add(msg.id);
        const entry = sentEntry(msg);
        if (entry) entries.push(entry);
      }
      next = seen.size > before ? nextPage(res.data['@odata.nextLink']) : null;
    }
    const newest = entries.reduce((max, e) => (e.date > max ? e.date : max), last ? last.since : '');
    return {
      cursor: { kind: 'graph', since: newest || null, fullAt: last ? last.fullAt : now },
      full: !last,
      entries,
    };
  } catch (err) {
    throw friendly(err, ACTION.history);
  }
}

// ---------- replying ----------

/**
 * Replies to the sender (or Reply-To) of rawEmail. Outlook threads the reply and files
 * it in Sent Items itself. The body is sent as plain text, like mail.js replies: Graph's
 * `comment` would run the lines together when the original is HTML.
 * @param {{ id: string, refreshToken: string }} account
 * @param {RawEmail} rawEmail
 * @param {string} body
 * @param {GraphOptions} options
 */
async function sendReply(account, rawEmail, body, options = {}) {
  try {
    const id = rawEmail && typeof rawEmail.id === 'string' ? rawEmail.id : '';
    if (!id) throw fail('server', MSG.gone);
    const res = await graph(account, mailOptions(options), 'POST', `/me/messages/${encodeURIComponent(id)}/reply`, {
      body: { message: { body: { contentType: 'text', content: String(body ?? '') } } },
    });
    if (res.status < 200 || res.status >= 300) throw graphError(res, ACTION.reply);
    return { sent: true };
  } catch (err) {
    throw friendly(err, ACTION.reply);
  }
}

/** Forgets the cached access token and headers of an account (when it is removed). */
function forgetAccount(id) {
  const key = String(id || '');
  sessions.delete(key);
  for (const cached of [...headerCache.keys()]) if (cached.startsWith(`${key}\n`)) headerCache.delete(cached);
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
  headerCache.clear();
}

module.exports = {
  SCOPES,
  PERSONAL_TENANT,
  signIn,
  fetchInbox,
  fetchSentHistory,
  sendReply,
  forgetAccount,
  safeWebLink,
  grantsMailboxChanges,
  scopeList,
  _graph: graph,
  _setEndpoints,
  _setTiming,
  _reset,
};
