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
console.warn = () => {}; // store logs secrets it can't decrypt and files it can't read
const store = require('../src/store');
const { readConfig } = require('../src/config');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const settingsFile = path.join(dir, 'settings.json');
const readFile = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const enc = (s) => Buffer.from(`enc:${s}`).toString('base64');

function reset(raw) {
  keychain.available = true;
  keychain.denyDecrypt = false;
  fs.rmSync(settingsFile, { force: true });
  if (raw) fs.writeFileSync(settingsFile, JSON.stringify(raw));
}

const gmail = { provider: 'gmail', user: 'me@gmail.com', pass: 'abcd efgh' };
const icloud = { provider: 'icloud', user: 'me@icloud.com', pass: 'icloud-pw' };
const outlook = { email: 'willw6311@outlook.com', name: 'Will', refreshToken: 'M.C5_BAY.0.U.-refresh*1' };
const uni = { email: 'cvww@lunet.lboro.ac.uk', name: 'Will W', refreshToken: '1.AXkA-uni-refresh' };
const only = (s) => s.accounts[s.accounts.length - 1];

test('each account keeps its own encrypted secret, and the API key is separate', () => {
  reset();
  store.saveAccount(gmail);
  store.saveAccount(icloud);
  store.saveMicrosoftAccount(outlook);
  store.saveSettings({ apiKey: 'sk-ant-123', limit: '40' });
  const disk = JSON.stringify(readFile());
  for (const secret of ['abcd efgh', 'icloud-pw', outlook.refreshToken, 'sk-ant-123']) assert.ok(!disk.includes(secret), secret);
  assert.strictEqual(readFile().version, 2);

  const s = store.loadSettings();
  assert.deepStrictEqual(s.accounts.map((a) => [a.kind, a.pass ?? a.refreshToken, a.locked]), [
    ['imap', 'abcd efgh', false],
    ['imap', 'icloud-pw', false],
    ['microsoft', outlook.refreshToken, false],
  ]);
  assert.strictEqual(s.apiKey, 'sk-ant-123');
  assert.strictEqual(s.limit, 40);
  assert.deepStrictEqual(s.locked, { apiKey: false });
  const ids = s.accounts.map((a) => a.id);
  assert.strictEqual(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(store.loadSettings().accounts.map((a) => a.id), ids, 'ids are stable');
});

test('editing an account: a blank password keeps the saved one; general settings leave accounts alone', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  const s = store.saveAccount({ ...gmail, id, pass: '' });
  assert.strictEqual(s.accounts.length, 1);
  assert.strictEqual(only(s).pass, 'abcd efgh');
  store.saveSettings({ apiKey: 'sk-ant-1', limit: '80' });
  const again = store.saveSettings({ apiKey: '', demo: true });
  assert.strictEqual(again.apiKey, 'sk-ant-1');
  assert.strictEqual(again.limit, 80);
  assert.strictEqual(only(again).pass, 'abcd efgh');
});

test('the saved password is dropped when the provider, address or server changes', () => {
  for (const change of [{ provider: 'icloud', user: 'me@icloud.com' }, { user: 'other@gmail.com' }]) {
    reset();
    const { id } = only(store.saveAccount(gmail));
    const s = store.saveAccount({ ...gmail, ...change, id, pass: '' });
    assert.strictEqual(only(s).pass, '', JSON.stringify(change));
    assert.strictEqual(only(store.loadSettings()).pass, '');
  }
  reset();
  const custom = { provider: 'custom', user: 'me', pass: 'pw', imapHost: 'imap.a.com', smtpHost: 'smtp.a.com' };
  const { id } = only(store.saveAccount(custom));
  assert.strictEqual(only(store.saveAccount({ ...custom, id, pass: '', imapPort: '143', imapSecurity: 'starttls' })).pass, 'pw');
  assert.strictEqual(only(store.saveAccount({ ...custom, id, pass: '', imapHost: 'IMAP.A.COM ' })).pass, 'pw');
  assert.strictEqual(only(store.saveAccount({ ...custom, id, pass: '', smtpHost: 'evil.example.net' })).pass, '');
});

test('hidden custom host fields do not matter for a preset provider', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  assert.strictEqual(only(store.saveAccount({ ...gmail, id, pass: '', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' })).pass, 'abcd efgh');
});

test('a Keychain decrypt failure is reported as locked and never erases the stored secrets', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  store.saveMicrosoftAccount(outlook);
  store.saveSettings({ apiKey: 'sk-ant-123' });
  const before = readFile();
  keychain.denyDecrypt = true;
  const locked = store.loadSettings();
  assert.deepStrictEqual(locked.accounts.map((a) => [a.pass ?? a.refreshToken, a.locked]), [['', true], ['', true]]);
  assert.deepStrictEqual(locked.locked, { apiKey: true });
  const pub = store.publicSettings(locked);
  assert.strictEqual(pub.secretsLocked, true);
  assert.deepStrictEqual(pub.accounts.map((a) => [a.locked, a.hasPass, a.signedIn, a.needsSignIn]), [[true, false, false, false], [true, false, false, true]]);

  // Saving anything else writes the stored ciphertext back untouched.
  const saved = store.saveAccount({ ...gmail, id, pass: '', imapPort: '' });
  assert.strictEqual(saved.accounts[0].locked, true);
  store.saveSettings({ apiKey: '', limit: 30 });
  const after = readFile();
  assert.strictEqual(after.accounts[0].pass, before.accounts[0].pass);
  assert.strictEqual(after.accounts[1].refreshToken, before.accounts[1].refreshToken);
  assert.strictEqual(after.apiKey, before.apiKey);

  keychain.denyDecrypt = false;
  const back = store.loadSettings();
  assert.strictEqual(back.accounts[0].pass, 'abcd efgh');
  assert.strictEqual(back.accounts[1].refreshToken, outlook.refreshToken);
  assert.strictEqual(back.apiKey, 'sk-ant-123');
  assert.strictEqual(back.limit, 30);
});

test('a new secret with no Keychain fails with a clear message and writes nothing', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  store.saveMicrosoftAccount(outlook);
  const before = fs.readFileSync(settingsFile, 'utf8');
  keychain.available = false;
  assert.throws(() => store.saveAccount({ ...gmail, id, pass: 'new one', user: 'x@gmail.com' }), /Keychain/);
  assert.throws(() => store.saveAccount(icloud), /Keychain/);
  assert.throws(() => store.saveMicrosoftAccount(uni), /Keychain/);
  assert.throws(() => store.saveSettings({ apiKey: 'sk-ant-9' }), /Keychain/);
  assert.throws(() => store.setRefreshToken(only(store.loadSettings()).id, 'rotated'), /Keychain/);
  assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), before);
});

test('only known keys are saved and values are validated', () => {
  reset();
  const s = store.saveAccount({ ...gmail, imapSecure: false, evil: 'x', kind: 'microsoft', __proto__: { polluted: 1 } });
  const disk = readFile();
  assert.strictEqual(disk.evil, undefined);
  assert.strictEqual(disk.accounts[0].evil, undefined);
  assert.strictEqual(disk.accounts[0].imapSecure, undefined);
  assert.strictEqual(disk.accounts[0].kind, 'imap');
  assert.strictEqual(only(s).imapSecurity, 'tls');
  store.saveSettings({ provider: 'yahoo', user: 'ignored@yahoo.com', accounts: [] });
  assert.strictEqual(readFile().accounts.length, 1, 'general settings never touch accounts');

  assert.throws(() => store.saveAccount({ provider: 'outlook', user: 'me@x.com' }), /provider/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me', imapPort: '99999' }), /port/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me', imapHost: 'imap example.com' }), /server name/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me', smtpSecurity: 'ssl' }), /TLS or STARTTLS/);
  assert.throws(() => store.saveAccount({ provider: 'gmail', user: 'me' }), /full email address/);
  assert.throws(() => store.saveAccount({ provider: 'gmail', user: '' }), /Enter your email address/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me@hotmail.co.uk', imapHost: 'imap.x.com' }), /Add Outlook or Microsoft 365/);
  assert.throws(() => store.saveAccount({ ...gmail, user: 'ME@gmail.com' }), /already in ClearMail/);
  assert.throws(() => store.saveAccount({ ...gmail, id: 'ffffffffffffffff' }), /no longer in ClearMail/);
  assert.throws(() => store.saveAccount(null), /account form/);
  assert.throws(() => store.saveSettings({ limit: 0 }), /from 1 to 500/);
  assert.throws(() => store.saveSettings({ apiKey: 'sk ant' }), /API key/);
  assert.throws(() => store.saveSettings({ msClientId: 'my app' }), /Application \(client\) ID/);
  assert.throws(() => store.saveSettings(null), /settings form/);
  assert.strictEqual(store.saveSettings({ demo: 'yes' }).demo, false);
  assert.strictEqual(store.saveSettings({ demo: true }).demo, true);
  assert.strictEqual(store.saveSettings({ msClientId: ' 1A2B3C4D-1234-5678-9ABC-1234567890AB ' }).msClientId, '1a2b3c4d-1234-5678-9abc-1234567890ab');
  assert.strictEqual(store.saveSettings({ msClientId: '' }).msClientId, '');

  const ms = store.saveMicrosoftAccount(outlook);
  assert.throws(() => store.saveAccount({ id: only(ms).id, user: 'x@gmail.com' }), /Sign in again/);
});

test('null removes a secret', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  store.saveSettings({ apiKey: 'sk-ant-1' });
  const s = store.saveSettings({ apiKey: null });
  assert.strictEqual(s.apiKey, '');
  assert.strictEqual(only(s).pass, 'abcd efgh');
  assert.strictEqual(only(store.saveAccount({ id, pass: null })).pass, '');
});

test('an old single-account settings file becomes accounts[0] without losing its password', () => {
  const v1 = { provider: 'gmail', user: 'me@gmail.com', pass: enc('old-pw'), apiKey: enc('sk-ant-old'), smtpPort: '587', imapSecure: false, demo: true, limit: 'lots' };
  reset(v1);
  const s = store.loadSettings();
  assert.strictEqual(s.accounts.length, 1);
  const [a] = s.accounts;
  assert.strictEqual(a.kind, 'imap');
  assert.strictEqual(a.user, 'me@gmail.com');
  assert.strictEqual(a.pass, 'old-pw');
  assert.strictEqual(a.imapSecurity, 'starttls');
  assert.strictEqual(a.smtpPort, 587);
  assert.strictEqual(s.apiKey, 'sk-ant-old');
  assert.strictEqual(s.limit, 60);
  assert.strictEqual(s.demo, true);
  assert.strictEqual(store.loadSettings().accounts[0].id, a.id, 'the id is the same on every launch');

  // The next save writes version 2 with the same id and the stored ciphertext untouched.
  store.saveSettings({ limit: 25 });
  const disk = readFile();
  assert.strictEqual(disk.version, 2);
  assert.strictEqual(disk.user, undefined);
  assert.strictEqual(disk.pass, undefined);
  assert.deepStrictEqual([disk.accounts[0].id, disk.accounts[0].pass, disk.apiKey], [a.id, v1.pass, v1.apiKey]);
  assert.strictEqual(store.loadSettings().accounts[0].pass, 'old-pw');

  // Even while the Keychain is locked.
  reset(v1);
  keychain.denyDecrypt = true;
  assert.strictEqual(store.loadSettings().accounts[0].locked, true);
  store.saveSettings({ demo: false });
  assert.strictEqual(readFile().accounts[0].pass, v1.pass);

  // Outlook was an IMAP choice once; it becomes a custom server. No address, no account.
  reset({ provider: 'outlook', user: 'me@outlook.com' });
  assert.strictEqual(store.loadSettings().accounts[0].provider, 'custom');
  reset({ apiKey: enc('k'), limit: 10 });
  assert.deepStrictEqual(store.loadSettings().accounts, []);
});

test('public settings have every contract field and never a secret', () => {
  reset();
  store.saveAccount(gmail);
  store.saveMicrosoftAccount(outlook);
  store.saveSettings({ apiKey: 'sk-ant-123', msClientId: '1a2b3c4d-1234-5678-9abc-1234567890ab' });
  const s = store.loadSettings();
  const pub = store.publicSettings(s, { needsSignIn: new Set([s.accounts[1].id]) });
  assert.deepStrictEqual(Object.keys(pub).sort(), ['accounts', 'demoChosen', 'hasApiKey', 'limit', 'msClientId', 'secretsLocked']);
  const fields = ['email', 'hasPass', 'id', 'imapHost', 'imapPort', 'imapSecurity', 'kind', 'locked', 'name', 'needsSignIn', 'provider', 'signedIn', 'smtpHost', 'smtpPort', 'smtpSecurity', 'user'];
  for (const a of pub.accounts) assert.deepStrictEqual(Object.keys(a).sort(), fields);
  const [g, o] = pub.accounts;
  assert.deepStrictEqual([g.kind, g.email, g.provider, g.hasPass, g.signedIn, g.needsSignIn], ['imap', 'me@gmail.com', 'gmail', true, false, false]);
  assert.deepStrictEqual([o.kind, o.email, o.name, o.provider, o.hasPass, o.signedIn, o.needsSignIn], ['microsoft', outlook.email, 'Will', 'microsoft', false, true, true]);
  assert.strictEqual(pub.msClientId, '1a2b3c4d-1234-5678-9abc-1234567890ab');
  const text = JSON.stringify(pub);
  for (const secret of ['abcd efgh', outlook.refreshToken, 'sk-ant-123']) assert.ok(!text.includes(secret));
});

test('Microsoft sign-ins: the same address updates its account, a renewed token is saved, a wrong address is refused', () => {
  reset();
  const first = only(store.saveMicrosoftAccount(outlook));
  store.saveMicrosoftAccount(uni);
  // Signing in again to an address already added updates it instead of adding a copy.
  const again = store.saveMicrosoftAccount({ ...outlook, email: 'WillW6311@outlook.com', name: '', refreshToken: 'second' });
  assert.strictEqual(again.accounts.length, 2);
  assert.deepStrictEqual([again.accounts[0].id, again.accounts[0].refreshToken, again.accounts[0].name], [first.id, 'second', 'Will']);
  // "Sign in again" on one account, but the browser signed in to another.
  assert.throws(() => store.saveMicrosoftAccount({ ...uni, id: first.id }), /You signed in as cvww@lunet\.lboro\.ac\.uk, but this account is willw6311@outlook\.com/);
  assert.strictEqual(store.loadSettings().accounts[0].refreshToken, 'second');
  assert.throws(() => store.saveMicrosoftAccount({ ...outlook, id: 'ffffffffffffffff' }), /removed/);
  assert.throws(() => store.saveMicrosoftAccount({ ...outlook, email: '' }), /email address/);
  assert.throws(() => store.saveMicrosoftAccount({ ...outlook, refreshToken: '' }), /finish signing you in/);

  // Microsoft renews the refresh token: it is saved encrypted, for that account only.
  const rotated = store.setRefreshToken(first.id, 'third-token');
  assert.strictEqual(rotated.accounts[0].refreshToken, 'third-token');
  assert.strictEqual(rotated.accounts[1].refreshToken, uni.refreshToken);
  assert.ok(!JSON.stringify(readFile()).includes('third-token'));
  assert.strictEqual(store.loadSettings().accounts[0].refreshToken, 'third-token');
  assert.strictEqual(store.setRefreshToken('ffffffffffffffff', 'x'), null);
  assert.strictEqual(store.setRefreshToken(first.id, 'bad token\n'), null);
});

test('removing an account removes it and its secret; an unknown id changes nothing', () => {
  reset();
  const g = only(store.saveAccount(gmail));
  store.saveMicrosoftAccount(outlook);
  const s = store.removeAccount(g.id);
  assert.deepStrictEqual(s.accounts.map((a) => a.email), [outlook.email]);
  assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes(enc('abcd efgh')));
  const before = fs.readFileSync(settingsFile, 'utf8');
  assert.strictEqual(store.removeAccount('nope').accounts.length, 1);
  assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), before);
});

test('accounts with a damaged or repeated id get a stable one', () => {
  reset({ version: 2, accounts: [
    { id: 'BAD ID', kind: 'imap', provider: 'gmail', user: 'a@gmail.com' },
    { id: 'aaaaaaaaaaaaaaaa', kind: 'microsoft', email: 'b@outlook.com', refreshToken: enc('t') },
    { id: 'aaaaaaaaaaaaaaaa', kind: 'microsoft', email: 'c@outlook.com' },
    { kind: 'pigeon' },
    'junk',
  ] });
  const ids = store.loadSettings().accounts.map((a) => a.id);
  assert.strictEqual(ids.length, 3);
  assert.strictEqual(new Set(ids).size, 3);
  assert.strictEqual(ids[1], 'aaaaaaaaaaaaaaaa');
  assert.deepStrictEqual(store.loadSettings().accounts.map((a) => a.id), ids);
});

test('a damaged settings file is kept aside, not overwritten', () => {
  reset();
  fs.writeFileSync(settingsFile, '{"user": "me@gmail.c');
  assert.deepStrictEqual(store.loadSettings().accounts, []);
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.damaged')));
});

test('summary cache round-trips, drops bad entries and is pruned to a bound', () => {
  const entries = {};
  for (let i = 0; i < 30; i++) entries[`m${i}`] = { at: i, summary: { gist: `g${i}` } };
  entries.bad = { gist: 'old format' };
  store.cache.save(entries);
  const loaded = store.cache.load();
  assert.strictEqual(Object.keys(loaded).length, 30);
  assert.strictEqual(loaded.bad, undefined);

  assert.strictEqual(store.cache.prune(loaded, new Set(['m0', 'm1']), 10), true);
  const kept = Object.keys(loaded);
  assert.strictEqual(kept.length, 10);
  assert.ok(kept.includes('m0') && kept.includes('m1') && kept.includes('m29'));
  assert.ok(!kept.includes('m10'));
});

test('the app password is saved exactly as typed; the API key is trimmed', () => {
  reset();
  store.saveAccount({ ...gmail, pass: ' pass word ' });
  store.saveSettings({ apiKey: '  sk-ant-456\n' });
  const s = store.loadSettings();
  assert.strictEqual(only(s).pass, ' pass word ');
  assert.strictEqual(s.apiKey, 'sk-ant-456');
});

test('build config: the environment wins over build-config.json; a missing or bad file is ignored', () => {
  const file = path.join(dir, 'build-config.json');
  const id = '1a2b3c4d-1234-5678-9abc-1234567890ab';
  const other = 'ffffffff-1234-5678-9abc-1234567890ab';
  assert.deepStrictEqual(readConfig({ env: {}, file }), { msClientId: '' });
  fs.writeFileSync(file, JSON.stringify({ msClientId: ` ${id.toUpperCase()} ` }));
  assert.deepStrictEqual(readConfig({ env: {}, file }), { msClientId: id });
  assert.deepStrictEqual(readConfig({ env: { CLEARMAIL_MS_CLIENT_ID: other }, file }), { msClientId: other });
  assert.deepStrictEqual(readConfig({ env: { CLEARMAIL_MS_CLIENT_ID: 'not an id' }, file }), { msClientId: id });
  for (const bad of ['{"msClientId": ', '[1]', 'null', '{"msClientId": 42}', '{"msClientId": "nope"}']) {
    fs.writeFileSync(file, bad);
    assert.deepStrictEqual(readConfig({ env: {}, file }), { msClientId: '' }, bad);
  }
  fs.rmSync(file);
});
