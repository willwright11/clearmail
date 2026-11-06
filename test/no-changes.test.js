// Static guards: ClearMail reads email and sends the replies the user writes, and nothing
// else. These read the source as text (comments left out, since they say what the code must
// never do), so a change that adds a way to alter the mailbox, or brings back the AI or
// mark-as-read, fails here even before a test exercises it. The behaviour itself is tested in
// microsoft.test.js (the Graph write guard), mail.test.js (EXAMINE and BODY.PEEK only),
// main.test.js and integration.test.js (the 5-second reply queue).
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

test('Microsoft: no request that could change the mailbox is ever written', () => {
  const src = code(read('src/microsoft.js'));
  for (const bad of [/\bPATCH\b/, /\bDELETE\b/, /'PUT'/, /\/(?:move|copy|forward|send|sendMail|createReply|createReplyAll|replyAll)\b/, /\bmarkSeen\b/, /\bmarkBatch\b/, /isRead\s*:/]) {
    assert.ok(!bad.test(src), `src/microsoft.js has ${bad}`);
  }
  // Every Graph call is a GET, the $batch of GETs, or the reply.
  const calls = [...src.matchAll(/\bgraph\(account, [^,]+, '([A-Z]+)', ([^,]+),/g)].map((m) => [m[1], m[2]]);
  assert.ok(calls.length >= 4);
  for (const [method, target] of calls) {
    if (method === 'GET') continue;
    assert.strictEqual(method, 'POST', target);
    assert.ok(target === "'/$batch'" || /^`\/me\/messages\/\$\{encodeURIComponent\(id\)\}\/reply`$/.test(target), `POST ${target}`);
  }
  // It never asks Microsoft for permission to change the mailbox.
  const { SCOPES } = require('../src/microsoft');
  assert.strictEqual(SCOPES, 'openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send');
  assert.ok(!/ReadWrite|Mail\.Send\.Shared|MailboxSettings/.test(SCOPES));
});

test('IMAP: mailboxes are only opened read-only, nothing is flagged, moved, copied or deleted, and only Sent is appended to', () => {
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
  for (const name of used) assert.ok(['append', 'close', 'connect', 'fetch', 'getMailboxLock', 'list', 'logout', 'on', 'search'].includes(name), `client.${name}`);
  // One APPEND: a copy of the user's own reply, into the Sent folder, marked read.
  const appends = [...src.matchAll(/\.append\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(appends, ["path, raw, ['\\\\Seen']"]);
  assert.match(src, /async function saveToSent\([\s\S]*?\.append\(path, raw/);
});

test('main.js and preload.js: no mark-as-read, and a reply only goes through the 5-second queue', () => {
  const main = code(read('main.js'));
  const preload = code(read('preload.js'));
  for (const src of [main, preload]) {
    for (const bad of [/markSeen/, /email:markSeen/, /markAccountSeen/, /queueFor/, /demoSeen/, /seenChains/]) assert.ok(!bad.test(src), `${bad}`);
  }
  assert.match(main, /const REPLY_DELAY_MS = 5000;/);
  // sendReply is only called where a queued reply's time is up.
  const sendQueued = main.slice(main.indexOf('async function sendQueued('), main.indexOf('function dropPendingReplies('));
  assert.strictEqual([...main.matchAll(/\.sendReply\(/g)].length, 2);
  assert.strictEqual([...sendQueued.matchAll(/\.sendReply\(/g)].length, 2);
  assert.match(main, /setTimeout\(\(\) => \{\s*sendQueued\(id\)[\s\S]*?\}, REPLY_DELAY_MS\);/);
  // The reply handler takes only the email's id and the text: never an address.
  const handler = main.slice(main.indexOf("handle('email:reply'"), main.indexOf("handle('email:undoReply'"));
  assert.match(handler, /const \{ id, body \} = payload \|\| \{\};/);
  assert.ok(!/payload\.(?:to|cc|bcc|address|account)/.test(handler));
  // Quitting or closing the window asks first, and then drops waiting replies without sending them.
  assert.match(main, /app\.on\('before-quit', \(e\) => \{\s*if \(pending\.size && !shuttingDown && !confirmDropReplies\('quit'\)\) \{\s*e\.preventDefault\(\);\s*return;\s*\}\s*dropPendingReplies\(\);\s*\}\);/);
  assert.match(main, /app\.on\('will-quit', \(\) => \{\s*dropPendingReplies\(\);/);
  assert.match(main, /win\.on\('close', \(e\) => \{\s*if \(!pending\.size\) return;\s*if \(shuttingDown \|\| confirmDropReplies\('close'\)\) dropPendingReplies\(\);\s*else e\.preventDefault\(\);\s*\}\);/);
  assert.match(main, /webContents\.on\('render-process-gone', \(\) => dropPendingReplies\(\)\)/);
  assert.match(main, /function dropPendingReplies\(\) \{\s*for \(const job of pending\.values\(\)\) clearTimeout\(job\.timer\);\s*pending\.clear\(\);\s*\}/);
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
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['imapflow', 'mailparser', 'nodemailer']);
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
