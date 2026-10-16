// Settings and summary cache, kept in the app's userData folder. App passwords, Microsoft
// sign-ins and the API key are encrypted with the macOS Keychain via Electron's safeStorage.
//
// settings.json (version 2):
//   { version: 2, apiKey, limit, demo, msClientId, accounts: [
//       { id, kind: 'imap', provider, user, pass, imapHost, imapPort, imapSecurity, smtpHost, smtpPort, smtpSecurity }
//     | { id, kind: 'microsoft', email, name, refreshToken } ] }
// pass, refreshToken and apiKey hold encrypted text (base64). Version 1 kept a single IMAP
// account's fields at the top level; it is read as accounts[0] and rewritten on the next save.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { PROVIDERS } = require('./mail');
const { CLIENT_ID_RE } = require('./config');

const file = (name) => path.join(app.getPath('userData'), name);

function userError(message, cause) {
  return new Error(message, cause ? { cause } : undefined);
}

function readJson(name, fallback) {
  let text;
  try {
    text = fs.readFileSync(file(name), 'utf8');
  } catch {
    return fallback; // not created yet
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
  } catch (err) {
    // Keep the damaged file for inspection instead of silently overwriting it.
    console.error(`${name} is damaged, starting fresh:`, err.message);
    try {
      fs.renameSync(file(name), file(`${name}.damaged`));
    } catch {}
    return fallback;
  }
}

// Writes a temp file and renames it over the old one, so a crash mid-write can't corrupt it.
function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = file(`${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

// ---------- settings ----------

const SECRET_OF = { imap: 'pass', microsoft: 'refreshToken' }; // each account kind's secret
const IMAP_FIELDS = ['provider', 'user', 'imapHost', 'imapPort', 'imapSecurity', 'smtpHost', 'smtpPort', 'smtpSecurity'];
const PROVIDER_KEYS = [...Object.keys(PROVIDERS), 'custom'];
const SECURITY = ['tls', 'starttls'];
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 500;
const MAX_ACCOUNTS = 20;
const ID_RE = /^[0-9a-f]{8,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
// Microsoft's own consumer domains, which can no longer use an app password.
const MICROSOFT_MAIL_RE = /@(?:outlook|hotmail|live|msn)\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i;
const KIND_LABEL = { imap: 'IMAP (incoming)', smtp: 'SMTP (outgoing)' };
const GONE = 'That account is no longer in ClearMail. Close Settings and try again.';

const isText = (v) => typeof v === 'string';
const presetFor = (provider) => (Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null);
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// '' for "use the default", null for invalid.
function toPort(value) {
  if (value === '' || value == null) return '';
  const n = Number(isText(value) ? value.trim() : value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

// Same rule mail.js uses when no security mode is saved: 993/465 (or no port) mean TLS.
const defaultSecurity = (port) => (port === '' || [993, 465].includes(port) ? 'tls' : 'starttls');

const clientIdOf = (value) => (isText(value) && CLIENT_ID_RE.test(value.trim()) ? value.trim().toLowerCase() : '');

// The plain fields of an IMAP account with defaults filled in. Migrates older files; never throws.
function normaliseImap(raw) {
  const s = {};
  // Outlook is no longer an IMAP choice (Microsoft turned off app-password IMAP): treat it as custom.
  s.provider = PROVIDER_KEYS.includes(raw.provider) ? raw.provider : raw.provider ? 'custom' : 'gmail';
  s.user = isText(raw.user) ? raw.user.trim() : '';
  for (const kind of ['imap', 'smtp']) {
    s[`${kind}Host`] = isText(raw[`${kind}Host`]) ? raw[`${kind}Host`].trim() : '';
    s[`${kind}Port`] = toPort(raw[`${kind}Port`]) || '';
    const saved = raw[`${kind}Security`];
    const legacy = raw[`${kind}Secure`]; // older versions saved a boolean
    s[`${kind}Security`] = SECURITY.includes(saved) ? saved
      : legacy === false ? 'starttls' : legacy === true ? 'tls' : defaultSecurity(s[`${kind}Port`]);
  }
  return s;
}

function normaliseMicrosoft(raw) {
  return {
    email: isText(raw.email) ? raw.email.trim() : '',
    name: isText(raw.name) ? raw.name.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) : '',
  };
}

// Where an IMAP password would be sent. Preset providers ignore the custom host fields.
function serverIdentity(a) {
  const preset = presetFor(a.provider);
  const host = (kind) => (preset ? preset[kind].host : a[`${kind}Host`]).toLowerCase();
  return [a.provider, a.user.toLowerCase(), host('imap'), host('smtp')].join('\n');
}

/** Which mailbox an account reads: the same value means the same mailbox. */
function accountIdentity(a) {
  if (a.kind === 'microsoft') return `microsoft\n${String(a.email || '').toLowerCase()}`;
  const preset = presetFor(a.provider);
  return `imap\n${String(a.user || '').toLowerCase()}\n${(preset ? preset.imap.host : String(a.imapHost || '')).toLowerCase()}`;
}

// An id for an account saved without a usable one (version 1 files). Derived from the
// account, so it stays the same on every launch until the file is next written.
function derivedId(index, kind, plain, used) {
  for (let n = 0; ; n++) {
    const seed = `${index}\n${kind}\n${accountIdentity({ kind, ...plain })}\n${n}`;
    const id = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
    if (!used.has(id)) return id;
  }
}

function newId(doc) {
  const used = new Set(doc.accounts.map((a) => a.id));
  let id;
  do id = crypto.randomBytes(8).toString('hex'); while (used.has(id));
  return id;
}

/**
 * The settings file as plain fields plus secrets still encrypted:
 * { general: { limit, demo, msClientId }, apiKey: Secret, accounts: [{ id, kind, ...fields, secret: Secret }] }
 * where Secret = { cipher, value? } (value is set once the plain text is known).
 */
function readDoc() {
  const raw = readJson('settings.json', {});
  let list = Array.isArray(raw.accounts) ? raw.accounts : [];
  if (!Array.isArray(raw.accounts) && ((isText(raw.user) && raw.user.trim()) || (isText(raw.pass) && raw.pass))) {
    list = [{ ...raw, kind: 'imap', id: undefined }]; // version 1: one IMAP account at the top level
  }
  const used = new Set();
  const accounts = [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const kind = entry.kind === undefined ? 'imap' : entry.kind;
    if (!Object.hasOwn(SECRET_OF, kind)) {
      console.warn('Skipping a saved account of an unknown kind.');
      return;
    }
    const plain = kind === 'imap' ? normaliseImap(entry) : normaliseMicrosoft(entry);
    const id = isText(entry.id) && ID_RE.test(entry.id) && !used.has(entry.id) ? entry.id : derivedId(index, kind, plain, used);
    used.add(id);
    const cipher = entry[SECRET_OF[kind]];
    accounts.push({ id, kind, ...plain, secret: { cipher: isText(cipher) ? cipher : '' } });
  });
  const limit = Number(raw.limit);
  return {
    general: {
      limit: Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT,
      demo: raw.demo === true,
      msClientId: clientIdOf(raw.msClientId),
    },
    apiKey: { cipher: isText(raw.apiKey) ? raw.apiKey : '' },
    accounts: accounts.slice(0, MAX_ACCOUNTS),
  };
}

// A failed decrypt (e.g. Keychain access denied) is reported as locked, never as "no secret".
function decrypt(value) {
  if (!value || !isText(value)) return { value: '', locked: false };
  try {
    return { value: safeStorage.decryptString(Buffer.from(value, 'base64')), locked: false };
  } catch (err) {
    console.warn('Could not decrypt a saved secret:', err.message);
    return { value: '', locked: true };
  }
}

function encrypt(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw userError("ClearMail can't reach the macOS Keychain, so it can't store your password or key safely. Quit and reopen ClearMail, then try again.");
  }
  try {
    return safeStorage.encryptString(value).toString('base64');
  } catch (err) {
    throw userError("ClearMail couldn't save your password or key in the macOS Keychain. Quit and reopen ClearMail, then try again.", err);
  }
}

const openSecret = (secret) => (secret.value !== undefined ? { value: secret.value, locked: false } : decrypt(secret.cipher));

function setSecret(secret, value) {
  secret.cipher = encrypt(value);
  secret.value = value;
}

function clearSecret(secret) {
  secret.cipher = '';
  secret.value = '';
}

/**
 * Settings for the main process: { accounts, apiKey, limit, demo, msClientId, locked: { apiKey } }.
 * Each account has its decrypted secret (pass or refreshToken; '' when missing or locked)
 * and locked: true when a saved secret exists but couldn't be decrypted.
 */
function toSettings(doc) {
  const accounts = doc.accounts.map(({ secret, ...plain }) => {
    const { value, locked } = openSecret(secret);
    return { ...plain, [SECRET_OF[plain.kind]]: value, locked };
  });
  const apiKey = openSecret(doc.apiKey);
  return { accounts, apiKey: apiKey.value, ...doc.general, locked: { apiKey: apiKey.locked } };
}

// Only what is listed here reaches the disk. Untouched secrets keep their exact stored
// ciphertext, so a secret the Keychain won't unlock right now is never erased.
function writeDoc(doc) {
  const out = {
    version: 2,
    accounts: doc.accounts.map(({ secret, ...plain }) => ({ ...plain, [SECRET_OF[plain.kind]]: secret.cipher })),
    apiKey: doc.apiKey.cipher,
    ...doc.general,
  };
  try {
    writeJson('settings.json', out);
  } catch (err) {
    throw userError(`ClearMail couldn't save your settings (${err.code || err.message}). Check there is free disk space and try again.`, err);
  }
}

function loadSettings() {
  return toSettings(readDoc());
}

// The trimmed new secret, '' for "keep the saved one", or null for "remove it".
function secretInput(value, label) {
  if (value === null) return null;
  if (value === undefined || value === '') return '';
  if (!isText(value)) throw userError(`Your ${label} must be text.`);
  // Passwords are saved exactly as typed (a space can be part of one); keys are trimmed.
  const v = label === 'app password' ? value : value.trim();
  if (!v.trim()) return '';
  if (v.length > 4096 || /[\x00-\x1f\x7f]/.test(v)) throw userError(`Your ${label} contains characters that can't be used. Paste it again.`);
  return v;
}

const formError = (what) => userError(`ClearMail couldn't read the ${what}. Please try again.`);

/**
 * Saves the General settings: { apiKey, limit, demo, msClientId }. Missing keys keep their
 * saved value; a blank apiKey keeps the saved key and null removes it. Returns the new
 * settings (as loadSettings) or throws a user-friendly Error, in which case nothing is written.
 */
function saveSettings(input) {
  if (!input || typeof input !== 'object') throw formError('settings form');
  const doc = readDoc();
  const has = (key) => input[key] !== undefined;

  if (has('limit') && input.limit !== '') {
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw userError(`Choose how many emails to load: a number from 1 to ${MAX_LIMIT}.`);
    }
    doc.general.limit = limit;
  }
  if (has('demo')) doc.general.demo = input.demo === true;
  if (has('msClientId')) {
    const id = input.msClientId === null ? '' : isText(input.msClientId) ? input.msClientId.trim() : null;
    if (id === null || (id && !CLIENT_ID_RE.test(id))) {
      throw userError("That doesn't look like an Application (client) ID. Copy it from your app's Overview page: it looks like 1a2b3c4d-1234-5678-9abc-1234567890ab.");
    }
    doc.general.msClientId = id.toLowerCase();
  }
  const apiKey = secretInput(input.apiKey, 'Claude API key');
  if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw userError("That Claude API key doesn't look right. Copy it again from console.anthropic.com.");
  }
  // Encrypt before writing anything, so a Keychain failure changes nothing.
  if (apiKey) setSecret(doc.apiKey, apiKey);
  else if (apiKey === null) clearSecret(doc.apiKey);
  writeDoc(doc);
  return toSettings(doc);
}

/**
 * Adds (no id) or edits an IMAP account. Only known keys are read; missing keys keep
 * their saved value. A blank pass keeps the saved one, except that it is dropped when the
 * provider, address or server changes, so it is never sent to a different server; null
 * removes it. Returns the new settings or throws a user-friendly Error (nothing written).
 */
function saveAccount(input) {
  if (!input || typeof input !== 'object') throw formError('account form');
  const doc = readDoc();
  const has = (key) => input[key] !== undefined;

  let target = null;
  if (input.id !== undefined && input.id !== null && input.id !== '') {
    target = doc.accounts.find((a) => a.id === input.id) || null;
    if (!target) throw userError(GONE);
    if (target.kind !== 'imap') throw userError('Outlook and Microsoft 365 accounts have nothing to edit. Use "Sign in again" if it stopped working.');
  } else if (doc.accounts.length >= MAX_ACCOUNTS) {
    throw userError(`ClearMail can hold up to ${MAX_ACCOUNTS} accounts. Remove one first.`);
  }
  const before = target ? pick(target, IMAP_FIELDS) : normaliseImap({});
  const next = { ...before };

  if (has('provider')) {
    if (!PROVIDER_KEYS.includes(input.provider)) throw userError('Choose your email provider from the list.');
    next.provider = input.provider;
  }
  if (has('user')) {
    const user = isText(input.user) ? input.user.trim() : null;
    if (user === null || user.length > 254 || /[\s\x00-\x1f\x7f]/.test(user)) throw userError('Enter your email address without spaces.');
    next.user = user;
  }
  if (!next.user) throw userError('Enter your email address.');
  if (next.provider !== 'custom' && !EMAIL_RE.test(next.user)) {
    throw userError('Enter your full email address, like name@example.com.');
  }
  if (next.user.toLowerCase() !== before.user.toLowerCase() && MICROSOFT_MAIL_RE.test(next.user)) {
    throw userError('Outlook and Hotmail addresses can\'t use an app password any more. Close this form and choose "Add Outlook or Microsoft 365" instead.');
  }
  for (const kind of ['imap', 'smtp']) {
    const [hostKey, portKey, secKey] = [`${kind}Host`, `${kind}Port`, `${kind}Security`];
    if (has(hostKey)) {
      const host = isText(input[hostKey]) ? input[hostKey].trim() : null;
      if (host === null || (host && !HOST_RE.test(host))) {
        throw userError(`The ${KIND_LABEL[kind]} server name doesn't look right. It should look like ${kind}.example.com.`);
      }
      next[hostKey] = host;
    }
    if (has(portKey)) {
      const port = toPort(input[portKey]);
      if (port === null) throw userError(`The ${KIND_LABEL[kind]} port must be a number from 1 to 65535.`);
      next[portKey] = port;
    }
    if (has(secKey) && input[secKey] !== '') {
      if (!SECURITY.includes(input[secKey])) throw userError(`Choose TLS or STARTTLS for the ${KIND_LABEL[kind]} server.`);
      next[secKey] = input[secKey];
    }
  }
  const twin = doc.accounts.find((a) => a !== target && accountIdentity(a) === accountIdentity({ kind: 'imap', ...next }));
  if (twin) throw userError(`${next.user} is already in ClearMail.`);

  const pass = secretInput(input.pass, 'app password');
  const secret = target ? target.secret : { cipher: '' };
  // Encrypt before writing anything, so a Keychain failure changes nothing.
  if (pass) setSecret(secret, pass);
  else if (pass === null || !target || serverIdentity(before) !== serverIdentity(next)) clearSecret(secret);

  if (target) Object.assign(target, next);
  else doc.accounts.push({ id: newId(doc), kind: 'imap', ...next, secret });
  writeDoc(doc);
  return toSettings(doc);
}

/** Removes an account and its saved secret. An unknown id changes nothing. */
function removeAccount(id) {
  const doc = readDoc();
  const index = doc.accounts.findIndex((a) => a.id === id);
  if (index === -1) return toSettings(doc);
  doc.accounts.splice(index, 1);
  writeDoc(doc);
  return toSettings(doc);
}

const validToken = (t) => isText(t) && t.length > 0 && t.length <= 65536 && /^[\x21-\x7e]+$/.test(t);

/**
 * Saves a Microsoft sign-in: { id?, email, name, refreshToken }. With id, that account is
 * signed in again (and must be the same address); without, an account with the same address
 * is updated, or a new one is added. Returns the new settings or throws a user-friendly Error.
 */
function saveMicrosoftAccount({ id, email, name, refreshToken } = {}) {
  const address = isText(email) ? email.trim() : '';
  if (!EMAIL_RE.test(address) || address.length > 254 || /[\x00-\x1f\x7f]/.test(address)) {
    throw userError("Microsoft didn't tell ClearMail the email address of this account, so it couldn't be added. Please try again.");
  }
  if (!validToken(refreshToken)) throw userError("Microsoft didn't finish signing you in. Please try again.");
  const doc = readDoc();
  const same = (a) => a.kind === 'microsoft' && a.email.toLowerCase() === address.toLowerCase();
  let target;
  if (id) {
    target = doc.accounts.find((a) => a.id === id && a.kind === 'microsoft');
    if (!target) throw userError('That account was removed from ClearMail while you were signing in. Add it again if you still want it.');
    if (!same(target)) {
      throw userError(`You signed in as ${address}, but this account is ${target.email}. Click "Sign in again" and choose ${target.email}.`);
    }
  } else {
    target = doc.accounts.find(same);
    if (!target && doc.accounts.length >= MAX_ACCOUNTS) throw userError(`ClearMail can hold up to ${MAX_ACCOUNTS} accounts. Remove one first.`);
  }
  const secret = target ? target.secret : { cipher: '' };
  setSecret(secret, refreshToken); // encrypt before writing anything
  const fields = normaliseMicrosoft({ email: address, name });
  if (target) Object.assign(target, { name: fields.name || target.name });
  else doc.accounts.push({ id: newId(doc), kind: 'microsoft', ...fields, secret });
  writeDoc(doc);
  return toSettings(doc);
}

/**
 * Stores a new refresh token Microsoft handed out for a signed-in account. Returns the new
 * settings, or null when the account is gone or the token is unusable (nothing written).
 * Throws a user-friendly Error if it can't be saved.
 */
function setRefreshToken(id, refreshToken) {
  if (!validToken(refreshToken)) return null;
  const doc = readDoc();
  const target = doc.accounts.find((a) => a.id === id && a.kind === 'microsoft');
  if (!target) return null;
  setSecret(target.secret, refreshToken);
  writeDoc(doc);
  return toSettings(doc);
}

function publicAccount(a, needsSignIn) {
  const imap = a.kind === 'imap';
  return {
    id: a.id,
    kind: a.kind,
    email: imap ? a.user : a.email,
    name: imap ? '' : a.name,
    provider: imap ? a.provider : 'microsoft',
    user: imap ? a.user : a.email,
    imapHost: imap ? a.imapHost : '',
    imapPort: imap ? a.imapPort : '',
    imapSecurity: imap ? a.imapSecurity : '',
    smtpHost: imap ? a.smtpHost : '',
    smtpPort: imap ? a.smtpPort : '',
    smtpSecurity: imap ? a.smtpSecurity : '',
    hasPass: imap && Boolean(a.pass),
    signedIn: !imap && Boolean(a.refreshToken),
    // No usable sign-in (never finished, or locked in the Keychain) also needs a new sign-in.
    needsSignIn: !imap && (!a.refreshToken || needsSignIn.has(a.id)),
    locked: Boolean(a.locked),
  };
}

/**
 * Settings safe to send to the UI: secrets replaced with "is it set?" flags.
 * needsSignIn: ids of Microsoft accounts whose last call said to sign in again.
 */
function publicSettings(s, { needsSignIn = new Set() } = {}) {
  return {
    accounts: s.accounts.map((a) => publicAccount(a, needsSignIn)),
    limit: s.limit,
    demoChosen: Boolean(s.demo),
    hasApiKey: Boolean(s.apiKey),
    secretsLocked: Boolean(s.locked?.apiKey || s.accounts.some((a) => a.locked)),
    msClientId: s.msClientId || '',
  };
}

// ---------- summary cache ----------
// { [emailId]: { at, summary } } for AI summaries, or { at, failed } for emails the AI
// can never summarise (refusals and the like), so they are not sent and billed again.

const CACHE_FILE = 'summaries.json';
const CACHE_MAX = 1000;

const cache = {
  load() {
    const out = {};
    for (const [id, entry] of Object.entries(readJson(CACHE_FILE, {}))) {
      const ok = entry && Number.isFinite(entry.at) && ((entry.summary && typeof entry.summary === 'object') || isText(entry.failed));
      if (ok) out[id] = entry;
    }
    return out;
  },
  save(entries) {
    writeJson(CACHE_FILE, entries);
  },
  /** Keeps every id in keepIds plus the newest other entries, up to max in total. */
  prune(entries, keepIds, max = CACHE_MAX) {
    const ids = Object.keys(entries);
    if (ids.length <= max) return false;
    const keep = new Set(ids.filter((id) => keepIds.has(id)));
    const others = ids.filter((id) => !keep.has(id)).sort((a, b) => entries[b].at - entries[a].at);
    for (const id of others.slice(0, Math.max(0, max - keep.size))) keep.add(id);
    for (const id of ids) if (!keep.has(id)) delete entries[id];
    return true;
  },
};

module.exports = {
  MICROSOFT_MAIL_RE,
  loadSettings,
  saveSettings,
  saveAccount,
  removeAccount,
  saveMicrosoftAccount,
  setRefreshToken,
  publicSettings,
  accountIdentity,
  cache,
};
