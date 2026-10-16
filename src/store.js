// Settings and summary cache, kept in the app's userData folder. Passwords and the
// API key are encrypted with the macOS Keychain via Electron's safeStorage.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { PROVIDERS } = require('./mail');

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

const SECRET_FIELDS = ['pass', 'apiKey'];
const PROVIDER_KEYS = [...Object.keys(PROVIDERS), 'custom'];
const SECURITY = ['tls', 'starttls'];
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const KIND_LABEL = { imap: 'IMAP (incoming)', smtp: 'SMTP (outgoing)' };

const isText = (v) => typeof v === 'string';
const presetFor = (provider) => (Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null);

// '' for "use the default", null for invalid.
function toPort(value) {
  if (value === '' || value == null) return '';
  const n = Number(isText(value) ? value.trim() : value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

// Same rule mail.js uses when no security mode is saved: 993/465 (or no port) mean TLS.
const defaultSecurity = (port) => (port === '' || [993, 465].includes(port) ? 'tls' : 'starttls');

// Plain (non-secret) settings with defaults filled in. Migrates older files; never throws.
function normalise(raw) {
  const s = {};
  // Outlook is no longer offered (Microsoft turned off app-password IMAP): treat it as custom.
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
  const limit = Number(raw.limit);
  s.limit = Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT;
  s.demo = raw.demo === true;
  return s;
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

function fromRaw(raw) {
  const s = normalise(raw);
  s.locked = {};
  for (const f of SECRET_FIELDS) {
    const { value, locked } = decrypt(raw[f]);
    s[f] = value;
    s.locked[f] = locked;
  }
  return s;
}

/**
 * Settings for the main process: plain fields, decrypted secrets ('' when missing or
 * locked), and locked: { pass, apiKey } for secrets that exist but couldn't be decrypted.
 */
function loadSettings() {
  return fromRaw(readJson('settings.json', {}));
}

// Where the password would be sent. Preset providers ignore the custom host fields.
function serverIdentity(s) {
  const preset = presetFor(s.provider);
  const host = (kind) => (preset ? preset[kind].host : s[`${kind}Host`]).toLowerCase();
  return [s.provider, s.user.toLowerCase(), host('imap'), host('smtp')].join('\n');
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

/**
 * Validates the settings form and saves it. Only known keys are read; missing keys keep
 * their saved value. A blank pass or apiKey keeps the saved one, except that the saved
 * password is dropped when the provider, address or server changes, so it is never sent
 * to a different server. Returns the new settings (as loadSettings) or throws a
 * user-friendly Error, in which case nothing is written.
 */
function saveSettings(input) {
  if (!input || typeof input !== 'object') throw userError("ClearMail couldn't read the settings form. Please try again.");
  const raw = readJson('settings.json', {});
  const current = fromRaw(raw);
  const next = normalise(raw);
  const has = (key) => input[key] !== undefined;

  if (has('provider')) {
    if (!PROVIDER_KEYS.includes(input.provider)) throw userError('Choose your email provider from the list.');
    next.provider = input.provider;
  }
  if (has('user')) {
    const user = isText(input.user) ? input.user.trim() : null;
    if (user === null || user.length > 254 || /[\s\x00-\x1f\x7f]/.test(user)) throw userError('Enter your email address without spaces.');
    next.user = user;
  }
  if (next.user && next.provider !== 'custom' && !EMAIL_RE.test(next.user)) {
    throw userError('Enter your full email address, like name@example.com.');
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
  if (has('limit') && input.limit !== '') {
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw userError(`Choose how many emails to load: a number from 1 to ${MAX_LIMIT}.`);
    }
    next.limit = limit;
  }
  if (has('demo')) next.demo = input.demo === true;

  const sameServer = serverIdentity(current) === serverIdentity(next);
  const secrets = { pass: secretInput(input.pass, 'app password'), apiKey: secretInput(input.apiKey, 'Claude API key') };
  if (secrets.apiKey && !/^[\x21-\x7e]+$/.test(secrets.apiKey)) {
    throw userError("That Claude API key doesn't look right. Copy it again from console.anthropic.com.");
  }

  // Encrypt everything before writing anything, so a Keychain failure changes nothing.
  const out = { ...next };
  next.locked = {};
  for (const f of SECRET_FIELDS) {
    const keepOld = secrets[f] === '' && (f !== 'pass' || sameServer);
    if (secrets[f]) {
      out[f] = encrypt(secrets[f]);
      next[f] = secrets[f];
      next.locked[f] = false;
    } else if (keepOld) {
      // Write back the stored ciphertext untouched, so a locked secret is never erased.
      out[f] = isText(raw[f]) ? raw[f] : '';
      next[f] = current[f];
      next.locked[f] = current.locked[f];
    } else {
      out[f] = '';
      next[f] = '';
      next.locked[f] = false;
    }
  }
  try {
    writeJson('settings.json', out);
  } catch (err) {
    throw userError(`ClearMail couldn't save your settings (${err.code || err.message}). Check there is free disk space and try again.`, err);
  }
  return next;
}

/** Settings safe to send to the UI: secrets replaced with "is it set?" flags. */
function publicSettings(s) {
  return {
    provider: s.provider,
    user: s.user,
    imapHost: s.imapHost,
    imapPort: s.imapPort,
    imapSecurity: s.imapSecurity,
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    smtpSecurity: s.smtpSecurity,
    limit: s.limit,
    demoChosen: Boolean(s.demo),
    hasPass: Boolean(s.pass),
    hasApiKey: Boolean(s.apiKey),
    secretsLocked: Boolean(s.locked && (s.locked.pass || s.locked.apiKey)),
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

module.exports = { loadSettings, saveSettings, publicSettings, cache };
