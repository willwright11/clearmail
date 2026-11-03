// What ClearMail keeps in the app's userData folder, each file readable by the user only (0600).
// App passwords and Microsoft sign-ins are encrypted with the macOS Keychain via Electron's
// safeStorage. No email text is ever written to disk.
//
// settings.json (version 3):
//   { version: 3, limit, demo, msClientId, brief: { enabled, time, days, openAtLogin }, accounts: [
//       { id, kind: 'imap', provider, user, pass, imapHost, imapPort, imapSecurity, smtpHost, smtpPort, smtpSecurity }
//     | { id, kind: 'microsoft', email, name, refreshToken, grant, grantedScopes, personal, upgrade } ] }
// pass and refreshToken hold encrypted text (base64). grant is 'read+reply' for a sign-in made
// by ClearMail 0.3 or later (Mail.Read and Mail.Send only); migrate() clears older sign-ins,
// which were granted Mail.ReadWrite, and marks them upgrade: 'reconnect'. Version 1 kept a
// single IMAP account's fields at the top level; it is read as accounts[0].
//
// state.json: { rules: { address|'@domain': 'important'|'noise' }, done: { emailId: ms },
//   notNoise: { emailId: ms }, brief: { lastSlot, lastAt, lastSince }, migrated: { localDone } }
// history.json: { accountId: History } (see src/history.js): who the user has written to.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { PROVIDERS } = require('./mail');
const { CLIENT_ID_RE } = require('./config');
const { normalizeBriefSettings, BRIEF_DEFAULTS } = require('./brief');
const { isValidRuleKey } = require('./triage');
const { normalizeHistory } = require('./history');

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
// Only the user can read the files (0600): they hold who the user writes to.
function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = file(`${name}.tmp`);
  fs.rmSync(tmp, { force: true }); // a leftover from a crash could have other permissions
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
const VERSION = 3;
// What a Microsoft sign-in made by ClearMail 0.3 or later was granted: read and reply only.
const GRANT = 'read+reply';
const ID_RE = /^[0-9a-f]{8,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const SCOPE_RE = /^[\w.-]{1,100}$/;
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

// Permissions as Microsoft listed them (short names, e.g. 'Mail.Read'), sorted and capped.
function scopesOf(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((s) => isText(s) && SCOPE_RE.test(s)))].sort().slice(0, 50);
}

function normaliseMicrosoft(raw) {
  return {
    email: isText(raw.email) ? raw.email.trim() : '',
    name: isText(raw.name) ? raw.name.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) : '',
    grant: raw.grant === GRANT ? GRANT : '',
    grantedScopes: scopesOf(raw.grantedScopes),
    personal: typeof raw.personal === 'boolean' ? raw.personal : null,
    upgrade: raw.upgrade === 'reconnect' ? 'reconnect' : null,
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
 * { version, hadApiKey, general: { limit, demo, msClientId, brief }, accounts: [{ id, kind, ...fields, secret: Secret }] }
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
    version: Number(raw.version) || (list.length ? 1 : 0),
    hadApiKey: Object.hasOwn(raw, 'apiKey'),
    general: {
      limit: Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT,
      demo: raw.demo === true,
      msClientId: clientIdOf(raw.msClientId),
      brief: normalizeBriefSettings(raw.brief, { lenient: true }),
    },
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
    throw userError("ClearMail can't reach the macOS Keychain, so it can't store your password or sign-in safely. Quit and reopen ClearMail, then try again.");
  }
  try {
    return safeStorage.encryptString(value).toString('base64');
  } catch (err) {
    throw userError("ClearMail couldn't save your password or sign-in in the macOS Keychain. Quit and reopen ClearMail, then try again.", err);
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
 * Settings for the main process: { accounts, limit, demo, msClientId, brief }.
 * Each account has its decrypted secret (pass or refreshToken; '' when missing or locked)
 * and locked: true when a saved secret exists but couldn't be decrypted. A Microsoft sign-in
 * from before 0.3 (granted Mail.ReadWrite) is never used, even if migrate() couldn't clear it.
 */
function toSettings(doc) {
  const accounts = doc.accounts.map(({ secret, ...plain }) => {
    if (plain.kind === 'microsoft' && plain.grant !== GRANT) {
      return { ...plain, refreshToken: '', locked: false, upgrade: secret.cipher || plain.upgrade ? 'reconnect' : null };
    }
    const { value, locked } = openSecret(secret);
    return { ...plain, [SECRET_OF[plain.kind]]: value, locked };
  });
  return { accounts, ...doc.general, brief: { ...doc.general.brief, days: [...doc.general.brief.days] } };
}

// Only what is listed here reaches the disk. Untouched secrets keep their exact stored
// ciphertext, so a secret the Keychain won't unlock right now is never erased.
function writeDoc(doc) {
  const out = {
    version: VERSION,
    accounts: doc.accounts.map(({ secret, ...plain }) => ({ ...plain, [SECRET_OF[plain.kind]]: secret.cipher })),
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

/**
 * Brings files from ClearMail 0.2 up to date, once, at startup. Writes only if something
 * changed, and never throws (a failure is logged and tried again next launch):
 * - the Claude API key and the AI summary cache (summaries.json) are deleted;
 * - each Microsoft sign-in made before 0.3 was granted Mail.ReadWrite (which can mark as
 *   read, move and delete), so it is thrown away and the account asks to sign in again;
 * - IMAP accounts, with their SMTP settings for replies, are kept as they are.
 * @returns {{ changed: boolean, reconnect: string[] }}
 */
function migrate() {
  const out = { changed: false, reconnect: [] };
  for (const name of ['summaries.json', 'summaries.json.tmp']) {
    try {
      if (fs.existsSync(file(name))) {
        fs.rmSync(file(name), { force: true });
        out.changed = true;
      }
    } catch (err) {
      console.warn(`Could not delete ${name}:`, err.message);
    }
  }
  if (!fs.existsSync(file('settings.json'))) return out;
  const doc = readDoc();
  let write = doc.version !== VERSION || doc.hadApiKey;
  for (const a of doc.accounts) {
    if (a.kind !== 'microsoft' || a.grant === GRANT) continue;
    if (a.secret.cipher) {
      clearSecret(a.secret);
      a.upgrade = 'reconnect';
      out.reconnect.push(a.id);
      write = true;
    }
    if (a.grantedScopes.length) {
      a.grantedScopes = [];
      write = true;
    }
  }
  if (write) {
    try {
      writeDoc(doc);
      out.changed = true;
    } catch (err) {
      console.error('Could not update the settings file:', err.message);
    }
  }
  return out;
}

// The trimmed new secret, '' for "keep the saved one", or null for "remove it".
function secretInput(value, label) {
  if (value === null) return null;
  if (value === undefined || value === '') return '';
  if (!isText(value)) throw userError(`Your ${label} must be text.`);
  // Passwords are saved exactly as typed (a space can be part of one).
  const v = value;
  if (!v.trim()) return '';
  if (v.length > 4096 || /[\x00-\x1f\x7f]/.test(v)) throw userError(`Your ${label} contains characters that can't be used. Paste it again.`);
  return v;
}

const formError = (what) => userError(`ClearMail couldn't read the ${what}. Please try again.`);

/**
 * Saves the General settings and the morning brief: { limit, demo, msClientId, brief }.
 * Missing keys keep their saved value; brief may be partial. Returns the new settings (as
 * loadSettings) or throws a user-friendly Error, in which case nothing is written.
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
  // Its messages are written for the user ("Choose a time for the morning brief, like 07:30.").
  if (has('brief')) doc.general.brief = normalizeBriefSettings(input.brief, { base: doc.general.brief });
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
 * Saves a Microsoft sign-in: { id?, email, name, refreshToken, grantedScopes, personal }.
 * With id, that account is signed in again (and must be the same address); without, an
 * account with the same address is updated, or a new one is added. The sign-in is recorded
 * as read+reply (ClearMail 0.3 only asks for Mail.Read and Mail.Send), which ends a pending
 * 'reconnect'. Returns the new settings or throws a user-friendly Error.
 */
function saveMicrosoftAccount({ id, email, name, refreshToken, grantedScopes, personal } = {}) {
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
  const fields = normaliseMicrosoft({ email: address, name, grant: GRANT, grantedScopes, personal });
  if (target) Object.assign(target, { ...fields, email: target.email, name: fields.name || target.name });
  else doc.accounts.push({ id: newId(doc), kind: 'microsoft', ...fields, secret });
  writeDoc(doc);
  return toSettings(doc);
}

/**
 * Stores a new refresh token Microsoft handed out for a signed-in account. Returns the new
 * settings, or null when the account is gone, still needs its 0.3 sign-in, or the token is
 * unusable (nothing written). Throws a user-friendly Error if it can't be saved.
 */
function setRefreshToken(id, refreshToken) {
  if (!validToken(refreshToken)) return null;
  const doc = readDoc();
  const target = doc.accounts.find((a) => a.id === id && a.kind === 'microsoft');
  if (!target || target.grant !== GRANT) return null;
  setSecret(target.secret, refreshToken);
  writeDoc(doc);
  return toSettings(doc);
}

/**
 * Stores the permissions Microsoft says a signed-in account's token carries, so Settings can
 * warn about an old Mail.ReadWrite consent. Returns the new settings, or null when nothing
 * changed or the account is gone.
 */
function setGrantedScopes(id, grantedScopes) {
  const doc = readDoc();
  const target = doc.accounts.find((a) => a.id === id && a.kind === 'microsoft');
  if (!target || target.grant !== GRANT) return null;
  const scopes = scopesOf(grantedScopes);
  if (scopes.join(' ') === target.grantedScopes.join(' ')) return null;
  target.grantedScopes = scopes;
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
    // No usable sign-in (never finished, from before 0.3, or locked in the Keychain) also needs a new sign-in.
    needsSignIn: !imap && (!a.refreshToken || a.upgrade === 'reconnect' || needsSignIn.has(a.id)),
    locked: Boolean(a.locked),
    grantedScopes: imap ? [] : [...(a.grantedScopes || [])],
    upgrade: imap ? null : a.upgrade || null,
    personal: imap ? null : typeof a.personal === 'boolean' ? a.personal : MICROSOFT_MAIL_RE.test(a.email || ''),
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
    secretsLocked: s.accounts.some((a) => a.locked),
    msClientId: s.msClientId || '',
    brief: { ...(s.brief || BRIEF_DEFAULTS), days: [...(s.brief || BRIEF_DEFAULTS).days] },
  };
}

// ---------- state.json: sorting rules, Done, Not noise and the brief ----------

const STATE_FILE = 'state.json';
const STATE_LIMITS = { rules: 2000, marks: 5000, markDays: 60 };
const DAY_MS = 24 * 3600 * 1000;
// An email id: '<account id or demo>:<the backend's id>'.
const EMAIL_ID_RE = /^(?:[0-9a-f]{8,64}|demo):\S/;
const isEmailId = (id) => isText(id) && id.length <= 2048 && EMAIL_ID_RE.test(id);

function emptyState() {
  return { rules: {}, done: {}, notNoise: {}, brief: { lastSlot: null, lastAt: null, lastSince: null }, migrated: {} };
}

const timeOf = (v) => (Number.isFinite(v) && v > 0 ? v : null);

// { id: ms } with valid ids, at most `limit` (the newest), none older than markDays unless
// the email is still loaded (`keep`), so a Done email still in the inbox stays done.
function marksOf(raw, { now, keep }) {
  const oldest = now - STATE_LIMITS.markDays * DAY_MS;
  const entries = Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
    .filter(([id, at]) => isEmailId(id) && Number.isFinite(at))
    .map(([id, at]) => [id, Math.min(at, now)])
    .filter(([id, at]) => at >= oldest || keep.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, STATE_LIMITS.marks);
  return Object.fromEntries(entries);
}

/**
 * state.json with anything malformed dropped and the caps applied: at most 2000 rules, and
 * at most 5000 Done and 5000 Not noise marks, none older than 60 days unless its email is in
 * `keep`. Never throws.
 */
function normalizeState(raw, { now = Date.now(), keep = new Set() } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rules = {};
  for (const [key, rule] of Object.entries(r.rules && typeof r.rules === 'object' ? r.rules : {})) {
    if (Object.keys(rules).length >= STATE_LIMITS.rules) break;
    if (isValidRuleKey(key) && (rule === 'important' || rule === 'noise')) rules[key] = rule;
  }
  const b = r.brief && typeof r.brief === 'object' ? r.brief : {};
  const m = r.migrated && typeof r.migrated === 'object' ? r.migrated : {};
  return {
    rules,
    done: marksOf(r.done, { now, keep }),
    notNoise: marksOf(r.notNoise, { now, keep }),
    brief: { lastSlot: timeOf(b.lastSlot), lastAt: timeOf(b.lastAt), lastSince: timeOf(b.lastSince) },
    migrated: timeOf(m.localDone) ? { localDone: m.localDone } : {},
  };
}

function loadState() {
  return normalizeState(readJson(STATE_FILE, {}));
}

/** Saves state.json (normalised); returns what was saved. Throws a user-friendly Error. */
function saveState(state, options) {
  const out = normalizeState(state, options);
  try {
    writeJson(STATE_FILE, out);
  } catch (err) {
    throw userError(`ClearMail couldn't save that change (${err.code || err.message}). Check there is free disk space and try again.`, err);
  }
  return out;
}

// ---------- history.json: who the user has written to, per account ----------

const HISTORY_FILE = 'history.json';

/** { accountId: History } as saved, each normalised and capped by src/history.js. */
function loadHistory() {
  const out = {};
  for (const [id, h] of Object.entries(readJson(HISTORY_FILE, {}))) if (ID_RE.test(id)) out[id] = normalizeHistory(h);
  return out;
}

/** Saves history.json; returns what was saved. Throws a user-friendly Error. */
function saveHistory(histories) {
  const out = {};
  for (const [id, h] of Object.entries(histories || {})) if (ID_RE.test(id)) out[id] = normalizeHistory(h);
  try {
    writeJson(HISTORY_FILE, out);
  } catch (err) {
    throw userError(`ClearMail couldn't save your sent-email history (${err.code || err.message}).`, err);
  }
  return out;
}

module.exports = {
  MICROSOFT_MAIL_RE,
  GRANT,
  STATE_LIMITS,
  migrate,
  loadSettings,
  saveSettings,
  saveAccount,
  removeAccount,
  saveMicrosoftAccount,
  setRefreshToken,
  setGrantedScopes,
  publicSettings,
  accountIdentity,
  isEmailId,
  emptyState,
  normalizeState,
  loadState,
  saveState,
  loadHistory,
  saveHistory,
};
