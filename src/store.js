// Settings and summary cache, kept in the app's userData folder. Passwords and the
// API key are encrypted with the macOS Keychain via Electron's safeStorage.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2));
}

const SECRET_FIELDS = ['pass', 'apiKey'];

function encrypt(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage (Keychain) is not available');
  return safeStorage.encryptString(value).toString('base64');
}

function decrypt(value) {
  if (!value) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

function loadSettings() {
  const s = readJson('settings.json', {});
  for (const f of SECRET_FIELDS) s[f] = decrypt(s[f]);
  return s;
}

function saveSettings(next) {
  const current = loadSettings();
  const merged = { ...current, ...next };
  // Blank secret fields in the form mean "keep the existing one".
  for (const f of SECRET_FIELDS) if (!next[f]) merged[f] = current[f];
  const out = { ...merged };
  for (const f of SECRET_FIELDS) out[f] = encrypt(merged[f]);
  writeJson('settings.json', out);
  return merged;
}

/** Settings safe to send to the UI: secrets replaced with "is it set?" flags. */
function publicSettings(s) {
  const { pass, apiKey, ...rest } = s;
  return { ...rest, hasPass: Boolean(pass), hasApiKey: Boolean(apiKey) };
}

const cache = {
  get: () => readJson('summaries.json', {}),
  set: (data) => writeJson('summaries.json', data),
};

module.exports = { loadSettings, saveSettings, publicSettings, cache };
