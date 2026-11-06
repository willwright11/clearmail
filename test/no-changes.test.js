// Static guards: ClearMail only reads email. It can't send, reply, delete, move or mark
// anything. These read the source as text (comments left out, since they say what the code
// must never do), so a change that adds a way to send or to alter the mailbox, or brings back
// the AI or mark-as-read, fails here even before a test exercises it. The behaviour itself is
// tested in microsoft.test.js (the Graph write guard), mail.test.js (EXAMINE and BODY.PEEK
// only), main.test.js (Copy subject) and integration.test.js (every Graph call is a read).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const SRC = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`);
const RENDERER = fs.readdirSync(path.join(ROOT, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => `renderer/${f}`);
const ALL = ['main.js', 'preload.js', ...SRC, ...RENDERER];

test('Microsoft: no request that could send or change the mailbox is ever written', () => {
  const src = code(read('src/microsoft.js'));
  for (const bad of [/\bPATCH\b/, /\bDELETE\b/, /'PUT'/, /\/(?:move|copy|forward|send|sendMail|reply|createReply|createReplyAll|replyAll|createForward)\b/, /\bmarkSeen\b/, /\bmarkBatch\b/, /isRead\s*:/]) {
    assert.ok(!bad.test(src), `src/microsoft.js has ${bad}`);
  }
  // Every Graph call is a GET, or the $batch of GETs.
  const calls = [...src.matchAll(/\bgraph\(account, [^,]+, '([A-Z]+)', ([^,]+),/g)].map((m) => [m[1], m[2]]);
  assert.ok(calls.length >= 3);
  for (const [method, target] of calls) {
    if (method === 'GET') continue;
    assert.deepStrictEqual([method, target], ['POST', "'/$batch'"]);
  }
  // It only ever asks Microsoft for permission to read.
  const { SCOPES } = require('../src/microsoft');
  assert.strictEqual(SCOPES, 'openid profile email offline_access User.Read Mail.Read');
  assert.ok(!/ReadWrite|Mail\.Send|\.Shared|MailboxSettings/.test(SCOPES));
});

test('IMAP: mailboxes are only opened read-only, and nothing is flagged, moved, copied, deleted or appended', () => {
  const src = code(read('src/mail.js'));
  for (const bad of [/messageFlags(?:Add|Set|Remove)/, /messageDelete/, /messageMove/, /messageCopy/, /mailbox(?:Create|Delete|Rename|Subscribe|Unsubscribe|Open)/,
    /expunge/i, /readOnly:\s*false/, /\bmarkSeen\b/, /uidValidityByAccount/, /\\\\Deleted/]) {
    assert.ok(!bad.test(src), `src/mail.js has ${bad}`);
  }
  const locks = [...src.matchAll(/getMailboxLock\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(locks.length >= 2);
  for (const args of locks) assert.match(args, /, \{ readOnly: true \}$/, `getMailboxLock(${args})`);
  // The imapflow calls used: none of them can change a message.
  const used = new Set([...src.matchAll(/\bclient\.(\w+)\(/g)].map((m) => m[1]));
  for (const name of used) assert.ok(['close', 'connect', 'fetch', 'getMailboxLock', 'list', 'logout', 'on', 'search'].includes(name), `client.${name}`);
});

test('nothing can send: no SMTP, no reply and no APPEND anywhere in main.js or src/', () => {
  for (const file of ['main.js', ...SRC]) {
    const src = code(read(file));
    for (const bad of [/nodemailer/i, /smtp/i, /sendReply/, /saveToSent/, /\/reply/, /sendMail/i, /createReply/, /\.append\(/, /\bAPPEND\b/]) {
      assert.ok(!bad.test(src), `${file} has ${bad}`);
    }
  }
  assert.ok(!SRC.includes('src/reply-target.js'), 'src/reply-target.js is gone');
  const pkg = JSON.parse(read('package.json'));
  for (const list of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) assert.ok(!Object.hasOwn(list || {}, 'nodemailer'), 'no nodemailer in package.json');
  const lock = JSON.parse(read('package-lock.json'));
  assert.ok(!Object.hasOwn(lock.packages[''].dependencies || {}, 'nodemailer'), 'nor among the lock file\'s own dependencies');
});

test('main.js and preload.js: no mark-as-read, nothing that replies, and Copy subject takes only an id', () => {
  const main = code(read('main.js'));
  const preload = code(read('preload.js'));
  for (const src of [main, preload]) {
    for (const bad of [/markSeen/, /email:markSeen/, /markAccountSeen/, /queueFor/, /demoSeen/, /seenChains/, /email:reply/, /email:undoReply/, /reply:result/, /reply-target/, /noteReply/]) {
      assert.ok(!bad.test(src), `${bad}`);
    }
  }
  // The window's API: nothing that sends, replies or undoes a send.
  const methods = [...preload.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
  assert.ok(methods.length >= 15 && methods.includes('copySubject'), methods.join(' '));
  for (const name of methods) assert.ok(!/reply|send|undo|draft|compose|forward/i.test(name), `preload exposes ${name}`);
  const channels = [...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  for (const channel of channels) assert.ok(!/reply|send|undo/i.test(channel), channel);
  assert.match(preload, /copySubject: \(id\) => ipcRenderer\.invoke\('email:copySubject', id\),/);
  // Copy subject: the window names the email; the text is always that email's own subject.
  const copy = main.slice(main.indexOf("handle('email:copySubject'"), main.indexOf("handle('link:open'"));
  assert.match(copy, /, \(_e, id\) => \{\s*const entry = loadedEntry\(id\);\s*if \(!entry\) throw ipcError\(EMAIL_GONE\);/);
  assert.match(copy, /const subject = String\(entry\.raw\.subject \|\| ''\)/);
  assert.match(copy, /clipboard\.writeText\(subject \|\| '\(no subject\)'\);/);
  assert.strictEqual([...main.matchAll(/\bclipboard\.\w+\(/g)].length, 1, 'the clipboard is only written there');
  // System Settings and Microsoft pages are fixed addresses, never one from the window.
  assert.match(main, /notifications: 'x-apple\.systempreferences:com\.apple\.Notifications-Settings\.extension'/);
  assert.match(main, /'login-items': 'x-apple\.systempreferences:com\.apple\.LoginItems-Settings\.extension'/);
});

test('no AI: the Anthropic SDK and the Claude key are gone everywhere', () => {
  for (const file of ALL) {
    const src = code(read(file));
    assert.ok(!/@anthropic-ai|anthropic/i.test(src), `${file} mentions Anthropic`);
    assert.ok(!/claude-|\baiSummary\b|startSummaries|summary:update|ai:status/.test(src), `${file} still has the AI path`);
  }
  for (const file of ['main.js', 'preload.js', ...RENDERER]) assert.ok(!/\bapiKey\b/.test(code(read(file))), `${file} uses apiKey`);
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.version, '0.3.0');
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['imapflow', 'mailparser']);
  const lock = JSON.parse(read('package-lock.json'));
  assert.strictEqual(lock.version, '0.3.0');
  assert.ok(!Object.keys(lock.packages).some((p) => p.includes('@anthropic-ai')), 'not in the lock file');
});

test('the window is sandboxed and never renders email HTML', () => {
  const main = code(read('main.js'));
  assert.match(main, /contextIsolation: true,\s*nodeIntegration: false,\s*sandbox: true,/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /on\('will-navigate', \(e\) => e\.preventDefault\(\)\)/);
  const view = code(read('src/view.js'));
  assert.ok(!/\bhtml\s*:/.test(view.slice(view.indexOf('function buildEmailView')).split('\n}\n')[0]), 'an EmailView carries no HTML');
});
