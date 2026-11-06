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

test('each account keeps its own encrypted secret', () => {
  reset();
  store.saveAccount(gmail);
  store.saveAccount(icloud);
  store.saveMicrosoftAccount(outlook);
  store.saveSettings({ limit: '40' });
  const disk = JSON.stringify(readFile());
  for (const secret of ['abcd efgh', 'icloud-pw', outlook.refreshToken]) assert.ok(!disk.includes(secret), secret);
  assert.strictEqual(readFile().version, 3);
  assert.strictEqual(fs.statSync(settingsFile).mode & 0o777, 0o600);

  const s = store.loadSettings();
  assert.deepStrictEqual(s.accounts.map((a) => [a.kind, a.pass ?? a.refreshToken, a.locked]), [
    ['imap', 'abcd efgh', false],
    ['imap', 'icloud-pw', false],
    ['microsoft', outlook.refreshToken, false],
  ]);
  assert.strictEqual(s.limit, 40);
  assert.ok(!('apiKey' in s));
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
  store.saveSettings({ limit: '80' });
  const again = store.saveSettings({ demo: true, apiKey: 'sk-ant-ignored' });
  assert.strictEqual(again.limit, 80);
  assert.strictEqual(only(again).pass, 'abcd efgh');
  assert.ok(!JSON.stringify(readFile()).includes('sk-ant'), 'an API key is never saved any more');
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
  const custom = { provider: 'custom', user: 'me', pass: 'pw', imapHost: 'imap.a.com' };
  const { id } = only(store.saveAccount(custom));
  assert.strictEqual(only(store.saveAccount({ ...custom, id, pass: '', imapPort: '143', imapSecurity: 'starttls' })).pass, 'pw');
  assert.strictEqual(only(store.saveAccount({ ...custom, id, pass: '', imapHost: 'IMAP.A.COM ' })).pass, 'pw');
  // Outgoing-mail fields are ignored (ClearMail sends nothing), so they change nothing.
  assert.strictEqual(only(store.saveAccount({ ...custom, id, pass: '', smtpHost: 'evil.example.net', smtpPort: 25 })).pass, 'pw');
  assert.ok(!Object.keys(readFile().accounts[0]).some((k) => /^smtp/i.test(k)));
  assert.strictEqual(only(store.saveAccount({ ...custom, id, pass: '', imapHost: 'evil.example.net' })).pass, '');
});

test('hidden custom host fields do not matter for a preset provider', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  assert.strictEqual(only(store.saveAccount({ ...gmail, id, pass: '', imapHost: 'imap.other.example' })).pass, 'abcd efgh');
});

test('a Keychain decrypt failure is reported as locked and never erases the stored secrets', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  store.saveMicrosoftAccount(outlook);
  const before = readFile();
  keychain.denyDecrypt = true;
  const locked = store.loadSettings();
  assert.deepStrictEqual(locked.accounts.map((a) => [a.pass ?? a.refreshToken, a.locked]), [['', true], ['', true]]);
  const pub = store.publicSettings(locked);
  assert.strictEqual(pub.secretsLocked, true);
  assert.deepStrictEqual(pub.accounts.map((a) => [a.locked, a.hasPass, a.signedIn, a.needsSignIn]), [[true, false, false, false], [true, false, false, true]]);

  // Saving anything else writes the stored ciphertext back untouched.
  const saved = store.saveAccount({ ...gmail, id, pass: '', imapPort: '' });
  assert.strictEqual(saved.accounts[0].locked, true);
  store.saveSettings({ limit: 30 });
  assert.strictEqual(store.migrate().changed, false, 'nothing to migrate, and locked secrets are left alone');
  const after = readFile();
  assert.strictEqual(after.accounts[0].pass, before.accounts[0].pass);
  assert.strictEqual(after.accounts[1].refreshToken, before.accounts[1].refreshToken);

  keychain.denyDecrypt = false;
  const back = store.loadSettings();
  assert.strictEqual(back.accounts[0].pass, 'abcd efgh');
  assert.strictEqual(back.accounts[1].refreshToken, outlook.refreshToken);
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
  store.saveSettings({ provider: 'yahoo', user: 'ignored@yahoo.com', accounts: [], apiKey: 'sk-ant-x' });
  assert.strictEqual(readFile().accounts.length, 1, 'general settings never touch accounts');
  assert.strictEqual(readFile().apiKey, undefined);

  assert.throws(() => store.saveAccount({ provider: 'outlook', user: 'me@x.com' }), /provider/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me', imapPort: '99999' }), /port/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me', imapHost: 'imap example.com' }), /server name/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me', imapSecurity: 'ssl' }), /^Error: Choose TLS or STARTTLS for the IMAP \(incoming\) server\.$/);
  // Outgoing-mail settings are not read at all, so not checked or saved either.
  const ignored = store.saveAccount({ provider: 'custom', user: 'me2', imapHost: 'imap.x.com', smtpHost: 'not a host!', smtpPort: '99999', smtpSecurity: 'ssl' });
  assert.ok(!Object.keys(only(ignored)).some((k) => /^smtp/i.test(k)));
  assert.ok(!JSON.stringify(readFile()).includes('smtp'));
  store.removeAccount(only(ignored).id);
  assert.throws(() => store.saveAccount({ provider: 'gmail', user: 'me' }), /full email address/);
  assert.throws(() => store.saveAccount({ provider: 'gmail', user: '' }), /Enter your email address/);
  assert.throws(() => store.saveAccount({ provider: 'custom', user: 'me@hotmail.co.uk', imapHost: 'imap.x.com' }), /Add Outlook or Microsoft 365/);
  assert.throws(() => store.saveAccount({ ...gmail, user: 'ME@gmail.com' }), /already in ClearMail/);
  assert.throws(() => store.saveAccount({ ...gmail, id: 'ffffffffffffffff' }), /no longer in ClearMail/);
  assert.throws(() => store.saveAccount(null), /account form/);
  assert.throws(() => store.saveSettings({ limit: 0 }), /from 1 to 500/);
  assert.throws(() => store.saveSettings({ msClientId: 'my app' }), /Application \(client\) ID/);
  assert.throws(() => store.saveSettings(null), /settings form/);
  assert.strictEqual(store.saveSettings({ demo: 'yes' }).demo, false);
  assert.strictEqual(store.saveSettings({ demo: true }).demo, true);
  assert.strictEqual(store.saveSettings({ msClientId: ' 1A2B3C4D-1234-5678-9ABC-1234567890AB ' }).msClientId, '1a2b3c4d-1234-5678-9abc-1234567890ab');
  assert.strictEqual(store.saveSettings({ msClientId: '' }).msClientId, '');

  const ms = store.saveMicrosoftAccount(outlook);
  assert.throws(() => store.saveAccount({ id: only(ms).id, user: 'x@gmail.com' }), /Sign in again/);
});

test('the morning brief settings: partial saves, defaults, and messages a person can act on', () => {
  reset();
  assert.deepStrictEqual(store.loadSettings().brief, { enabled: false, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], openAtLogin: false });
  store.saveSettings({ brief: { enabled: true, time: '06:45', days: [5, 1, 1, 3] } });
  assert.deepStrictEqual(store.saveSettings({ brief: { openAtLogin: true } }).brief, { enabled: true, time: '06:45', days: [1, 3, 5], openAtLogin: true });
  assert.deepStrictEqual(readFile().brief, { enabled: true, time: '06:45', days: [1, 3, 5], openAtLogin: true });
  const before = fs.readFileSync(settingsFile, 'utf8');
  assert.throws(() => store.saveSettings({ brief: { time: '25:00' } }), /^Error: Choose a time for the morning brief, like 07:30\.$/);
  assert.throws(() => store.saveSettings({ brief: { days: [7] } }), /Choose the days for the morning brief/);
  assert.throws(() => store.saveSettings({ brief: { days: [] } }), /at least one day/);
  assert.throws(() => store.saveSettings({ brief: { enabled: 'yes' } }), /couldn't be saved/);
  assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), before, 'nothing written');
  // A damaged file on disk is read leniently.
  reset({ version: 3, accounts: [], brief: { enabled: true, time: 'soon', days: 'weekdays' } });
  assert.deepStrictEqual(store.loadSettings().brief, { enabled: true, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], openAtLogin: false });
});

test('null removes a secret', () => {
  reset();
  const { id } = only(store.saveAccount(gmail));
  assert.strictEqual(only(store.saveAccount({ id, pass: null })).pass, '');
});

test('an old single-account settings file becomes accounts[0] without losing its password', () => {
  const v1 = { provider: 'gmail', user: 'me@gmail.com', pass: enc('old-pw'), apiKey: enc('sk-ant-old'), smtpPort: '587', smtpSecure: false, imapSecure: false, demo: true, limit: 'lots' };
  reset(v1);
  const s = store.loadSettings();
  assert.strictEqual(s.accounts.length, 1);
  const [a] = s.accounts;
  assert.strictEqual(a.kind, 'imap');
  assert.strictEqual(a.user, 'me@gmail.com');
  assert.strictEqual(a.pass, 'old-pw');
  assert.strictEqual(a.imapSecurity, 'starttls');
  assert.ok(!Object.keys(a).some((k) => /^smtp/i.test(k)), 'the outgoing-mail settings are not read');
  assert.strictEqual(s.limit, 60);
  assert.strictEqual(s.demo, true);
  assert.strictEqual(store.loadSettings().accounts[0].id, a.id, 'the id is the same on every launch');

  // Migrating writes version 3 with the same id, the stored ciphertext untouched, and no API
  // key or outgoing-mail settings.
  assert.strictEqual(store.migrate().changed, true);
  const disk = readFile();
  assert.strictEqual(disk.version, 3);
  assert.strictEqual(disk.user, undefined);
  assert.strictEqual(disk.pass, undefined);
  assert.strictEqual(disk.apiKey, undefined);
  assert.deepStrictEqual(disk.accounts[0], { id: a.id, kind: 'imap', provider: 'gmail', user: 'me@gmail.com', imapHost: '', imapPort: '', imapSecurity: 'starttls', pass: v1.pass });
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

// An IMAP account as ClearMail 0.2 and early 0.3 saved it, with the outgoing-mail server replies used.
const OLD_IMAP = {
  id: 'aaaaaaaaaaaaaaaa', kind: 'imap', provider: 'custom', user: 'me@example.com', pass: enc('pw'), imapHost: 'imap.example.com', imapPort: 993,
  imapSecurity: 'tls', smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'starttls',
};
const withoutSmtp = ({ smtpHost, smtpPort, smtpSecurity, ...rest }) => rest;

test('migrating from 0.2: the API key and AI cache go, old Outlook sign-ins must sign in again, IMAP stays without its outgoing server', () => {
  const v2 = {
    version: 2,
    apiKey: enc('sk-ant-secret'),
    limit: 80,
    demo: false,
    msClientId: '1a2b3c4d-1234-5678-9abc-1234567890ab',
    accounts: [
      OLD_IMAP,
      { id: 'bbbbbbbbbbbbbbbb', kind: 'microsoft', email: 'willw6311@outlook.com', name: 'Will', refreshToken: enc('old-readwrite-token') },
      { id: 'cccccccccccccccc', kind: 'microsoft', email: 'never@finished.example' },
    ],
  };
  reset(v2);
  fs.writeFileSync(path.join(dir, 'summaries.json'), '{"x":{"at":1,"summary":{"gist":"AI"}}}');
  // Before migrating, the old sign-in is already never used.
  assert.strictEqual(store.loadSettings().accounts[1].refreshToken, '');

  const result = store.migrate();
  assert.deepStrictEqual(result, { changed: true, reconnect: ['bbbbbbbbbbbbbbbb'] });
  assert.ok(!fs.existsSync(path.join(dir, 'summaries.json')));
  const disk = readFile();
  assert.strictEqual(disk.version, 3);
  assert.ok(!('apiKey' in disk));
  assert.ok(!JSON.stringify(disk).includes(enc('sk-ant-secret')));
  assert.deepStrictEqual(disk.accounts[0], withoutSmtp(OLD_IMAP), 'IMAP is kept as it was, without the outgoing-mail settings');
  assert.ok(!JSON.stringify(disk).includes('smtp'));
  assert.deepStrictEqual([disk.accounts[1].refreshToken, disk.accounts[1].upgrade, disk.accounts[1].grant], ['', 'reconnect', '']);
  assert.ok(!JSON.stringify(disk).includes(enc('old-readwrite-token')));
  assert.deepStrictEqual([disk.limit, disk.msClientId], [80, v2.msClientId]);
  assert.deepStrictEqual(disk.accounts.map((a) => a.id), v2.accounts.map((a) => a.id), 'ids never change, so Done and history stay with their account');

  const s = store.loadSettings();
  const pub = store.publicSettings(s).accounts;
  assert.deepStrictEqual(pub.map((a) => [a.email, a.needsSignIn, a.upgrade]), [
    ['me@example.com', false, null], ['willw6311@outlook.com', true, 'reconnect'], ['never@finished.example', true, null],
  ]);
  assert.strictEqual(s.accounts[0].pass, 'pw');

  // Once is enough: running it again writes nothing.
  const text = fs.readFileSync(settingsFile, 'utf8');
  assert.deepStrictEqual(store.migrate(), { changed: false, reconnect: [] });
  assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), text);
  // Signing in again (ClearMail now asks for Mail.Read only) clears it.
  const back = store.saveMicrosoftAccount({ email: 'WillW6311@outlook.com', refreshToken: 'new-token', grantedScopes: ['User.Read', 'Mail.Read', 'bad scope!'], personal: true });
  const ms = back.accounts[1];
  assert.deepStrictEqual([ms.id, ms.refreshToken, ms.upgrade, ms.grant, ms.grantedScopes, ms.personal], ['bbbbbbbbbbbbbbbb', 'new-token', null, 'read', ['Mail.Read', 'User.Read'], true]);
  assert.strictEqual(store.publicSettings(back).accounts[1].needsSignIn, false);
  // A fresh install has nothing to migrate.
  fs.rmSync(settingsFile);
  assert.deepStrictEqual(store.migrate(), { changed: false, reconnect: [] });
  assert.ok(!fs.existsSync(settingsFile));
});

test('migrating from an early 0.3 that could reply: its sign-ins must sign in again, IMAP stays without its outgoing server', () => {
  const early = {
    version: 3,
    limit: 60,
    demo: false,
    msClientId: '1a2b3c4d-1234-5678-9abc-1234567890ab',
    brief: { enabled: true, time: '07:30', days: [1, 2, 3, 4, 5], openAtLogin: false },
    accounts: [
      OLD_IMAP,
      {
        id: 'bbbbbbbbbbbbbbbb', kind: 'microsoft', email: 'willw6311@outlook.com', name: 'Will', refreshToken: enc('can-send-token'),
        grant: 'read+reply', grantedScopes: ['Mail.Read', 'Mail.Send', 'User.Read'], personal: true, upgrade: null,
      },
      // Signed in for reading only already: left alone.
      {
        id: 'cccccccccccccccc', kind: 'microsoft', email: 'cvww@lunet.lboro.ac.uk', name: 'Will W', refreshToken: enc('read-token'),
        grant: 'read', grantedScopes: ['Mail.Read', 'User.Read'], personal: false, upgrade: null,
      },
    ],
  };
  reset(early);
  const before = store.loadSettings();
  assert.deepStrictEqual(before.accounts.map((a) => a.refreshToken ?? a.pass), ['pw', '', 'read-token'], 'a sign-in that could send is never used');

  assert.deepStrictEqual(store.migrate(), { changed: true, reconnect: ['bbbbbbbbbbbbbbbb'] });
  const disk = readFile();
  assert.deepStrictEqual(disk.accounts[0], withoutSmtp(OLD_IMAP));
  assert.ok(!JSON.stringify(disk).includes('smtp'));
  assert.deepStrictEqual(disk.accounts[1], {
    id: 'bbbbbbbbbbbbbbbb', kind: 'microsoft', email: 'willw6311@outlook.com', name: 'Will', grant: '', grantedScopes: [], personal: true, upgrade: 'reconnect', refreshToken: '',
  });
  assert.ok(!JSON.stringify(disk).includes(enc('can-send-token')));
  assert.deepStrictEqual(disk.accounts[2], { ...early.accounts[2] });
  assert.deepStrictEqual(disk.brief, early.brief);

  const pub = store.publicSettings(store.loadSettings()).accounts;
  assert.deepStrictEqual(pub.map((a) => [a.email, a.needsSignIn, a.upgrade, a.grantedScopes]), [
    ['me@example.com', false, null, []], ['willw6311@outlook.com', true, 'reconnect', []], ['cvww@lunet.lboro.ac.uk', false, null, ['Mail.Read', 'User.Read']],
  ]);
  assert.strictEqual(store.loadSettings().accounts[2].refreshToken, 'read-token');
  assert.deepStrictEqual(store.migrate(), { changed: false, reconnect: [] }, 'once is enough');

  // Only leftover outgoing-mail settings, nothing else to do: still tidied once.
  reset({ version: 3, accounts: [OLD_IMAP] });
  assert.deepStrictEqual(store.migrate(), { changed: true, reconnect: [] });
  assert.deepStrictEqual(readFile().accounts, [withoutSmtp(OLD_IMAP)]);
  assert.strictEqual(store.loadSettings().accounts[0].pass, 'pw');
  assert.deepStrictEqual(store.migrate(), { changed: false, reconnect: [] });
});

test('which mailbox an account reads never depended on the outgoing-mail server, so ids, Done and history are unchanged', () => {
  const imap = { kind: 'imap', provider: 'custom', user: 'Me@Example.com', imapHost: 'IMAP.example.com' };
  assert.strictEqual(store.accountIdentity(imap), 'imap\nme@example.com\nimap.example.com');
  assert.strictEqual(store.accountIdentity({ ...imap, smtpHost: 'smtp.elsewhere.example', smtpPort: 25 }), store.accountIdentity(imap));
  assert.strictEqual(store.accountIdentity({ kind: 'imap', provider: 'gmail', user: 'me@gmail.com', imapHost: 'ignored.example' }), 'imap\nme@gmail.com\nimap.gmail.com');
  assert.strictEqual(store.accountIdentity({ kind: 'microsoft', email: 'WillW6311@Outlook.com' }), 'microsoft\nwillw6311@outlook.com');

  // A version 1 file has no ids: the one worked out for it is the same with or without the
  // outgoing-mail settings, before and after migrating.
  const v1 = { provider: 'custom', user: 'me@example.com', pass: enc('pw'), imapHost: 'imap.example.com' };
  reset(v1);
  const id = store.loadSettings().accounts[0].id;
  reset({ ...v1, smtpHost: 'smtp.example.com', smtpPort: 587 });
  assert.strictEqual(store.loadSettings().accounts[0].id, id);
  store.migrate();
  assert.strictEqual(readFile().accounts[0].id, id);
});

test('public settings have every contract field and never a secret', () => {
  reset();
  store.saveAccount(gmail);
  store.saveMicrosoftAccount({ ...outlook, grantedScopes: ['Mail.Read', 'User.Read'], personal: true });
  store.saveSettings({ msClientId: '1a2b3c4d-1234-5678-9abc-1234567890ab' });
  const s = store.loadSettings();
  const pub = store.publicSettings(s, { needsSignIn: new Set([s.accounts[1].id]) });
  assert.deepStrictEqual(Object.keys(pub).sort(), ['accounts', 'brief', 'demoChosen', 'limit', 'msClientId', 'secretsLocked']);
  const fields = ['email', 'grantedScopes', 'hasPass', 'id', 'imapHost', 'imapPort', 'imapSecurity', 'kind', 'locked', 'name', 'needsSignIn', 'personal', 'provider',
    'signedIn', 'upgrade', 'user'];
  for (const a of pub.accounts) assert.deepStrictEqual(Object.keys(a).sort(), fields);
  const [g, o] = pub.accounts;
  assert.deepStrictEqual([g.kind, g.email, g.provider, g.hasPass, g.signedIn, g.needsSignIn, g.grantedScopes], ['imap', 'me@gmail.com', 'gmail', true, false, false, []]);
  assert.deepStrictEqual([o.kind, o.email, o.name, o.provider, o.hasPass, o.signedIn, o.needsSignIn, o.grantedScopes, o.personal],
    ['microsoft', outlook.email, 'Will', 'microsoft', false, true, true, ['Mail.Read', 'User.Read'], true]);
  assert.strictEqual(pub.msClientId, '1a2b3c4d-1234-5678-9abc-1234567890ab');
  const text = JSON.stringify(pub);
  for (const secret of ['abcd efgh', outlook.refreshToken]) assert.ok(!text.includes(secret));
});

test('Microsoft sign-ins: the same address updates its account, a renewed token and permissions are saved, a wrong address is refused', () => {
  reset();
  const first = only(store.saveMicrosoftAccount(outlook));
  store.saveMicrosoftAccount(uni);
  assert.strictEqual(readFile().accounts[0].grant, 'read');
  assert.strictEqual(store.GRANT, 'read');
  // Signing in again to an address already added updates it instead of adding a copy.
  const again = store.saveMicrosoftAccount({ ...outlook, email: 'WillW6311@outlook.com', name: '', refreshToken: 'second' });
  assert.strictEqual(again.accounts.length, 2);
  assert.deepStrictEqual([again.accounts[0].id, again.accounts[0].refreshToken, again.accounts[0].name, again.accounts[0].email], [first.id, 'second', 'Will', outlook.email]);
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

  // What the token may do, as Microsoft says (an old consent can still carry more); written only when it changes.
  assert.deepStrictEqual(store.setGrantedScopes(first.id, ['Mail.Send', 'Mail.ReadWrite', 'Mail.Read']).accounts[0].grantedScopes, ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send']);
  assert.strictEqual(store.setGrantedScopes(first.id, ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send']), null);
  assert.strictEqual(store.setGrantedScopes('ffffffffffffffff', ['Mail.Read']), null);

  // A sign-in from 0.2, or from an early 0.3 that could reply, is never renewed or used.
  for (const grant of [undefined, 'read+reply', 'READ', 'read ']) {
    reset({ version: grant ? 3 : 2, accounts: [{ id: 'bbbbbbbbbbbbbbbb', kind: 'microsoft', email: 'a@outlook.com', refreshToken: enc('old'), grant }] });
    assert.strictEqual(store.setRefreshToken('bbbbbbbbbbbbbbbb', 'rotated-old'), null, grant);
    assert.strictEqual(store.setGrantedScopes('bbbbbbbbbbbbbbbb', ['Mail.Read']), null, grant);
    assert.strictEqual(store.loadSettings().accounts[0].refreshToken, '', grant);
    assert.strictEqual(store.publicSettings(store.loadSettings()).accounts[0].needsSignIn, true, grant);
  }
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

test('state.json: rules, Done and Not noise are checked and capped', () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const day = 86400_000;
  const raw = {
    rules: { 'sarah@brightbuild.co.uk': 'important', '@shop.example': 'noise', '@gmail.com': 'noise', 'Bad@Case.com': 'noise', 'x@y.com': 'delete', 'not an address': 'noise' },
    done: { 'aaaaaaaaaaaaaaaa:1': now - day, 'demo:demo-2': now - 61 * day, 'bad id': now, 'aaaaaaaaaaaaaaaa:future': now + 10 * day, 'aaaaaaaaaaaaaaaa:nan': 'x' },
    notNoise: { 'aaaaaaaaaaaaaaaa:2': now - 70 * day },
    brief: { lastSlot: now - day, lastAt: 'yesterday', lastSince: now - 2 * day },
    migrated: { localDone: now },
    extra: 'dropped',
  };
  const s = store.normalizeState(raw, { now, keep: new Set(['aaaaaaaaaaaaaaaa:2']) });
  assert.deepStrictEqual(s.rules, { 'sarah@brightbuild.co.uk': 'important', '@shop.example': 'noise' });
  assert.deepStrictEqual(s.done, { 'aaaaaaaaaaaaaaaa:future': now, 'aaaaaaaaaaaaaaaa:1': now - day }, 'over 60 days old goes, a future time is today');
  assert.deepStrictEqual(s.notNoise, { 'aaaaaaaaaaaaaaaa:2': now - 70 * day }, 'kept: its email is still loaded');
  assert.deepStrictEqual(s.brief, { lastSlot: now - day, lastAt: null, lastSince: now - 2 * day });
  assert.deepStrictEqual(s.migrated, { localDone: now });
  assert.ok(!('extra' in s));
  assert.deepStrictEqual(store.normalizeState('junk'), store.emptyState());

  const many = { rules: {}, done: {} };
  for (let i = 0; i < 2100; i++) many.rules[`p${i}@example.com`] = 'noise';
  for (let i = 0; i < 5100; i++) many.done[`aaaaaaaaaaaaaaaa:${i}`] = now - i * 1000;
  const capped = store.normalizeState(many, { now });
  assert.strictEqual(Object.keys(capped.rules).length, 2000);
  assert.strictEqual(Object.keys(capped.done).length, 5000);
  assert.ok(Object.hasOwn(capped.done, 'aaaaaaaaaaaaaaaa:0') && !Object.hasOwn(capped.done, 'aaaaaaaaaaaaaaaa:5099'), 'the newest are kept');

  fs.rmSync(path.join(dir, 'state.json'), { force: true });
  assert.deepStrictEqual(store.loadState(), store.emptyState());
  const saved = store.saveState({ ...store.emptyState(), rules: { 'a@b.com': 'noise' } });
  assert.deepStrictEqual(saved.rules, { 'a@b.com': 'noise' });
  assert.deepStrictEqual(store.loadState().rules, { 'a@b.com': 'noise' });
  assert.strictEqual(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'state.json'), '{"rules":');
  assert.deepStrictEqual(store.loadState(), store.emptyState());
  assert.ok(fs.existsSync(path.join(dir, 'state.json.damaged')), 'a damaged file is kept aside');
});

test('history.json: each account\'s Sent history is checked and capped, and only the user can read it', () => {
  fs.rmSync(path.join(dir, 'history.json'), { force: true });
  assert.deepStrictEqual(store.loadHistory(), {});
  const people = {};
  for (let i = 0; i < 5005; i++) people[`p${i}@example.com`] = { n: 1, last: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString() };
  store.saveHistory({
    aaaaaaaaaaaaaaaa: { cursor: { kind: 'graph', since: '2026-11-01T10:00:00Z', fullAt: 1 }, syncedAt: '2026-11-03T10:00:00Z', me: ['Me@Outlook.com'], people, replies: { 'c:conv-1': '2026-11-02T10:00:00Z' } },
    'not an id': { people: { 'x@y.com': { n: 1, last: '2026-01-01T00:00:00Z' } } },
  });
  assert.strictEqual(fs.statSync(path.join(dir, 'history.json')).mode & 0o777, 0o600);
  const h = store.loadHistory();
  assert.deepStrictEqual(Object.keys(h), ['aaaaaaaaaaaaaaaa']);
  assert.strictEqual(Object.keys(h.aaaaaaaaaaaaaaaa.people).length, 5000);
  assert.deepStrictEqual(h.aaaaaaaaaaaaaaaa.me, ['me@outlook.com']);
  assert.deepStrictEqual(h.aaaaaaaaaaaaaaaa.cursor, { kind: 'graph', since: '2026-11-01T10:00:00.000Z', fullAt: 1 });
});

test('history.json and state.json: what was kept for an account no longer in Settings is dropped', () => {
  const kept = 'aaaaaaaaaaaaaaaa';
  const gone = 'bbbbbbbbbbbbbbbb';
  const h = { cursor: null, syncedAt: '2026-11-03T10:00:00Z', me: ['me@example.com'], people: {}, replies: { 'c:conv-1': '2026-11-02T10:00:00Z' } };
  store.saveHistory({ [kept]: h, [gone]: h }, { accountIds: new Set([kept, 'demo']) });
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'))), [kept]);
  store.saveHistory({ [kept]: h, [gone]: h }); // without the list (older callers), both stay
  assert.deepStrictEqual(Object.keys(store.loadHistory()).sort(), [gone, kept].sort());
  assert.deepStrictEqual(Object.keys(store.loadHistory({ accountIds: [kept] })), [kept], 'an orphan is not loaded');

  const now = Date.now();
  const raw = { done: { [`${kept}:1`]: now, [`${gone}:1`]: now, 'demo:demo-3': now }, notNoise: { [`${gone}:2`]: now } };
  const s = store.normalizeState(raw, { now, keep: new Set([`${gone}:1`]), accountIds: new Set([kept, 'demo']) });
  assert.deepStrictEqual(Object.keys(s.done).sort(), [`${kept}:1`, 'demo:demo-3'], 'even an email still loaded');
  assert.deepStrictEqual(s.notNoise, {});
  store.saveState(raw, { now, accountIds: [kept] });
  assert.deepStrictEqual(Object.keys(store.loadState().done), [`${kept}:1`]);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(raw));
  assert.deepStrictEqual(Object.keys(store.loadState({ accountIds: [kept] }).done), [`${kept}:1`]);
  assert.deepStrictEqual(Object.keys(store.loadState().done).length, 3, 'without the list nothing is dropped');
});

test('the app password is saved exactly as typed', () => {
  reset();
  store.saveAccount({ ...gmail, pass: ' pass word ' });
  assert.strictEqual(only(store.loadSettings()).pass, ' pass word ');
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
