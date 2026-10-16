const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Fake electron: a temp userData folder and a safeStorage whose Keychain can be denied.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearmail-store-'));
const keychain = { available: true, denyDecrypt: false };
const fakeElectron = {
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (buf) => {
      if (keychain.denyDecrypt) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return buf.toString().replace(/^enc:/, '');
    },
  },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? fakeElectron : realLoad.call(this, request, ...rest);
};
const store = require('../src/store');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const settingsFile = path.join(dir, 'settings.json');
const readFile = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

function reset(raw) {
  keychain.available = true;
  keychain.denyDecrypt = false;
  fs.rmSync(settingsFile, { force: true });
  if (raw) fs.writeFileSync(settingsFile, JSON.stringify(raw));
}

const gmail = { provider: 'gmail', user: 'me@gmail.com', pass: 'abcd efgh', apiKey: 'sk-ant-123', demo: false };

test('saves secrets encrypted and loads them back', () => {
  reset();
  store.saveSettings(gmail);
  const disk = readFile();
  assert.ok(!JSON.stringify(disk).includes('abcd efgh'));
  assert.ok(!JSON.stringify(disk).includes('sk-ant-123'));
  const s = store.loadSettings();
  assert.equal(s.pass, 'abcd efgh');
  assert.equal(s.apiKey, 'sk-ant-123');
  assert.deepEqual(s.locked, { pass: false, apiKey: false });
});

test('blank secrets keep the saved ones', () => {
  reset();
  store.saveSettings(gmail);
  const s = store.saveSettings({ ...gmail, pass: '', apiKey: '', limit: '80' });
  assert.equal(s.pass, 'abcd efgh');
  assert.equal(s.apiKey, 'sk-ant-123');
  assert.equal(s.limit, 80);
  assert.equal(store.loadSettings().pass, 'abcd efgh');
});

test('the saved password is dropped when the provider, address or server changes', () => {
  for (const change of [{ provider: 'icloud', user: 'me@icloud.com' }, { user: 'other@gmail.com' }]) {
    reset();
    store.saveSettings(gmail);
    const s = store.saveSettings({ ...gmail, ...change, pass: '' });
    assert.equal(s.pass, '', JSON.stringify(change));
    assert.equal(s.apiKey, 'sk-ant-123');
    assert.equal(store.loadSettings().pass, '');
  }
  reset();
  const custom = { provider: 'custom', user: 'me', pass: 'pw', imapHost: 'imap.a.com', smtpHost: 'smtp.a.com' };
  store.saveSettings(custom);
  assert.equal(store.saveSettings({ ...custom, pass: '', imapPort: '143', imapSecurity: 'starttls' }).pass, 'pw');
  assert.equal(store.saveSettings({ ...custom, pass: '', imapHost: 'IMAP.A.COM ' }).pass, 'pw');
  assert.equal(store.saveSettings({ ...custom, pass: '', smtpHost: 'evil.example.net' }).pass, '');
});

test('hidden custom host fields do not matter for a preset provider', () => {
  reset();
  store.saveSettings(gmail);
  assert.equal(store.saveSettings({ ...gmail, pass: '', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' }).pass, 'abcd efgh');
});

test('a Keychain decrypt failure is reported as locked and never erases the stored secrets', () => {
  reset();
  store.saveSettings(gmail);
  const before = readFile();
  keychain.denyDecrypt = true;
  const locked = store.loadSettings();
  assert.equal(locked.pass, '');
  assert.deepEqual(locked.locked, { pass: true, apiKey: true });
  assert.equal(store.publicSettings(locked).secretsLocked, true);
  assert.equal(store.publicSettings(locked).hasPass, false);

  const saved = store.saveSettings({ ...gmail, pass: '', apiKey: '', limit: 30 });
  assert.equal(saved.locked.pass, true);
  assert.equal(readFile().pass, before.pass);
  assert.equal(readFile().apiKey, before.apiKey);

  keychain.denyDecrypt = false;
  const back = store.loadSettings();
  assert.equal(back.pass, 'abcd efgh');
  assert.equal(back.apiKey, 'sk-ant-123');
  assert.equal(back.limit, 30);
});

test('a new secret with no Keychain fails with a clear message and writes nothing', () => {
  reset();
  store.saveSettings(gmail);
  const before = fs.readFileSync(settingsFile, 'utf8');
  keychain.available = false;
  assert.throws(() => store.saveSettings({ ...gmail, pass: 'new one', user: 'x@gmail.com' }), /Keychain/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
});

test('only known keys are saved and values are validated', () => {
  reset();
  const s = store.saveSettings({ ...gmail, imapSecure: false, evil: 'x', __proto__: { polluted: 1 } });
  assert.equal(readFile().evil, undefined);
  assert.equal(readFile().imapSecure, undefined);
  assert.equal(s.imapSecurity, 'tls');
  assert.throws(() => store.saveSettings({ provider: 'outlook' }), /provider/);
  assert.throws(() => store.saveSettings({ provider: 'custom', imapPort: '99999' }), /port/);
  assert.throws(() => store.saveSettings({ provider: 'custom', imapHost: 'imap example.com' }), /server name/);
  assert.throws(() => store.saveSettings({ provider: 'custom', smtpSecurity: 'ssl' }), /TLS or STARTTLS/);
  assert.throws(() => store.saveSettings({ provider: 'gmail', user: 'me' }), /full email address/);
  assert.throws(() => store.saveSettings({ limit: 0 }), /from 1 to 500/);
  assert.throws(() => store.saveSettings({ apiKey: 'sk ant' }), /API key/);
  assert.throws(() => store.saveSettings(null), /settings form/);
  assert.equal(store.saveSettings({ demo: 'yes' }).demo, false);
  assert.equal(store.saveSettings({ demo: true }).demo, true);
});

test('null removes a secret', () => {
  reset();
  store.saveSettings(gmail);
  const s = store.saveSettings({ apiKey: null });
  assert.equal(s.apiKey, '');
  assert.equal(s.pass, 'abcd efgh');
});

test('old settings files are migrated', () => {
  reset({ provider: 'outlook', user: 'me@outlook.com', imapSecure: false, smtpPort: '587', demo: true, limit: 'lots' });
  const s = store.loadSettings();
  assert.equal(s.provider, 'custom');
  assert.equal(s.imapSecurity, 'starttls');
  assert.equal(s.smtpSecurity, 'starttls');
  assert.equal(s.smtpPort, 587);
  assert.equal(s.limit, 60);
  const pub = store.publicSettings(s);
  assert.deepEqual(Object.keys(pub).sort(), [
    'demoChosen', 'hasApiKey', 'hasPass', 'imapHost', 'imapPort', 'imapSecurity', 'limit', 'provider',
    'secretsLocked', 'smtpHost', 'smtpPort', 'smtpSecurity', 'user',
  ]);
  assert.equal(pub.demoChosen, true);
});

test('a damaged settings file is kept aside, not overwritten', () => {
  reset();
  fs.writeFileSync(settingsFile, '{"user": "me@gmail.c');
  assert.equal(store.loadSettings().user, '');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.damaged')));
});

test('summary cache round-trips, drops bad entries and is pruned to a bound', () => {
  const entries = {};
  for (let i = 0; i < 30; i++) entries[`m${i}`] = { at: i, summary: { gist: `g${i}` } };
  entries.bad = { gist: 'old format' };
  store.cache.save(entries);
  const loaded = store.cache.load();
  assert.equal(Object.keys(loaded).length, 30);
  assert.equal(loaded.bad, undefined);

  assert.equal(store.cache.prune(loaded, new Set(['m0', 'm1']), 10), true);
  const kept = Object.keys(loaded);
  assert.equal(kept.length, 10);
  assert.ok(kept.includes('m0') && kept.includes('m1') && kept.includes('m29'));
  assert.ok(!kept.includes('m10'));
});

test('the app password is saved exactly as typed; the API key is trimmed', () => {
  reset();
  store.saveSettings({ ...gmail, pass: ' pass word ', apiKey: '  sk-ant-456\n' });
  const s = store.loadSettings();
  assert.strictEqual(s.pass, ' pass word ');
  assert.strictEqual(s.apiKey, 'sk-ant-456');
});
