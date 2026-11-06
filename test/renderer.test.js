// Static and unit checks for the renderer (renderer/*). They run without a browser: the files
// are read as text, and the scripts are loaded into a small fake page to check what the
// buttons do. ClearMail only reads, so nothing here may send, reply or change the mailbox.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', 'renderer');
const SCRIPTS = ['common.js', 'brief.js', 'people.js', 'settings.js', 'app.js'];
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const sources = Object.fromEntries(SCRIPTS.map((name) => [name, read(name)]));
const allJs = Object.values(sources).join('\n');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

// What the renderer may call on window.clearmail: the preload's names for contract H.
const API = [
  'getSettings', 'saveSettings', 'saveAccount', 'removeAccount', 'signInMicrosoft', 'cancelSignIn',
  'openConsentPage', 'loadInbox', 'openEmail', 'copySubject', 'openLink', 'setRule', 'setNotNoise',
  'setDone', 'importDone', 'testBrief', 'briefStatus', 'openSystemSettings', 'onBriefShow', 'onInboxUpdated',
];

const COPIED = "Copied. Paste it into Outlook's search to find the email.";

// Comments say what the code must never do, so they are left out of the text checks.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('the renderer never builds the page from HTML strings', () => {
  for (const [name, src] of Object.entries({ ...sources, 'index.html': html })) {
    for (const bad of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bsrcdoc\b/, /createContextualFragment/, /DOMParser/]) {
      assert.ok(!bad.test(code(src)), `${name} uses ${bad}`);
    }
  }
});

test('index.html has the tight CSP, no inline scripts or handlers, and loads the scripts in order', () => {
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  assert.ok(meta, 'CSP meta tag');
  assert.strictEqual(meta[1], CSP);
  assert.strictEqual((html.match(/Content-Security-Policy/g) || []).length, 1);

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepStrictEqual(scripts.map((m) => (m[1].match(/src="([^"]+)"/) || [])[1]), SCRIPTS);
  for (const m of scripts) assert.strictEqual(m[2].trim(), '', 'no inline script');
  for (const name of SCRIPTS) assert.ok(fs.existsSync(path.join(DIR, name)), name);

  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no on*= attributes');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no style attributes (the CSP blocks them)');
  assert.ok(!/<style\b/i.test(html), 'no inline <style>');
  assert.ok(!/javascript:/i.test(html));
  assert.ok(!/<form\b[^>]*\saction=/i.test(html), 'forms never submit anywhere');
});

test('el() never sets inline handlers from strings or style attributes', () => {
  const { ctx } = page();
  const node = ctx.el('button', { onclick: 'alert(1)', style: 'color:red', class: 'x', 'data-act': 'go' }, 'Go');
  assert.strictEqual(node.attrs.onclick, undefined);
  assert.strictEqual(node.attrs.style, undefined);
  assert.strictEqual(node.className, 'x');
  assert.strictEqual(node.attrs['data-act'], 'go');
  assert.strictEqual(node.children[0].textContent, 'Go', 'children are text nodes');
});

test('nothing in the renderer changes the mailbox or uses the removed AI', () => {
  const src = code(allJs);
  for (const bad of [/markSeen/, /markAccountSeen/, /\bapiKey\b/, /hasApiKey/, /onSummary/, /onAiStatus/, /reply_suggestions/, /aiEnabled/, /aiError/, /renderBanner/]) {
    assert.ok(!bad.test(src), `renderer still uses ${bad}`);
  }
  assert.ok(!/Claude/.test(allJs + html), 'no Claude key wording');
  assert.ok(!/name="apiKey"/.test(html));
  // Unread state is shown, never cleared: nothing sets an email's seen flag.
  assert.ok(!/\.seen\s*=(?!=)/.test(src), 'the renderer never sets seen');
});

test('nothing in the renderer can send or reply: no composer, Send key, Undo send or reply channel', () => {
  const files = fs.readdirSync(DIR);
  assert.deepStrictEqual(files.sort(), [...SCRIPTS, 'index.html', 'styles.css'].sort(), 'no other renderer files');
  for (const name of files) {
    const src = read(name);
    for (const bad of [
      /\bundoReply\b/, /\bonReplyResult\b/, /\bisSendKey\b/, /reply:result/, /email:reply/, /email:undoReply/,
      /clearmail\s*\.\s*reply\b/, /\[\s*['"]reply['"]\s*\]/, /\b(?:submitReply|queueReply|handleReplyResult|retryReply|editReply|replyState|replyTarget|replyNote|replyTo)\b/,
      /composer/i, /\bdrafts?\b/i, /smtp/i, /textarea/i, /⌘↩|Meta\+Enter|Cmd\+Enter/, /\bsendAt\b/, /\bSending… Undo/, /✓ Sent/,
      /['">]Send['"<]/,
    ]) {
      assert.ok(!bad.test(src), `${name} still has ${bad}`);
    }
  }
});

test('words about replying always point to Outlook, never to replying in ClearMail', () => {
  const lines = [...code(allJs).split('\n'), ...html.split('\n')].filter((l) => /repl(?:y|ies|ied|ying)/i.test(l));
  assert.ok(lines.length, 'the help text says how to reply');
  for (const line of lines) assert.match(line, /Outlook/, `"${line.trim()}" mentions replying without pointing to Outlook`);
});

test('the renderer only calls the contract H channels, and the preload offers each of them', () => {
  const used = new Set([...code(allJs).matchAll(/(?<![\w'"`.])clearmail\.(\w+)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(API.includes(name), `clearmail.${name} is not in contract H`);
  for (const name of ['copySubject', 'openEmail', 'setRule', 'setNotNoise', 'setDone', 'importDone', 'loadInbox', 'onInboxUpdated', 'onBriefShow']) {
    assert.ok(used.has(name), `clearmail.${name} is used`);
  }
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const exposed = new Set([...preload.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]));
  for (const name of used) assert.ok(exposed.has(name), `preload.js exposes clearmail.${name}`);
});

test('copySubject is only ever called with an email id', () => {
  const callsInCode = [...code(allJs).matchAll(/clearmail\.copySubject\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(callsInCode, ['m.id'], 'one call, with the id and nothing else');
});

test('Copy subject: sends only the id, then says "Copied…" for 3 seconds', async () => {
  const { ctx, calls, notices, timers } = page({ scripts: ['common.js', 'brief.js', 'people.js'] });
  const m = ctx.tidyEmail(email('acc:1', { subject: 'Quote for the Harrow extension' }));
  vm.runInContext('state.emails = []', ctx);
  const button = find(ctx.card(m, false), act('copy-subject'));
  assert.strictEqual(text(button), 'Copy subject');
  assert.strictEqual(button.attrs['aria-label'], 'Copy the subject of the email from Sarah Collins');
  button.dispatch('click');
  await settle();
  assert.deepStrictEqual(calls, [['copySubject', 'acc:1']], 'only the id goes to main');
  assert.strictEqual(notices.at(-1), COPIED);
  assert.ok(timers.some((t) => t.ms === 3000), 'gone after about 3 seconds');
  assert.strictEqual(text(find(ctx.card(m, false), act('copy-subject'))), '✓ Copied');
  // Once the 3 seconds are up, the button is back to normal.
  for (const t of timers.splice(0)) t.fn();
  assert.strictEqual(text(find(ctx.card(m, false), act('copy-subject'))), 'Copy subject');
  assert.strictEqual(notices.at(-1), COPIED, 'the notice line was cleared, not changed');
});

test('Copy subject: an error from main is shown as it is', async () => {
  const { ctx, calls, notices } = page({
    scripts: ['common.js', 'brief.js'],
    copyError: "Error invoking remote method 'email:copySubject': This email is no longer in your inbox. Refresh and try again.",
  });
  const m = ctx.tidyEmail(email('acc:gone'));
  find(ctx.card(m, false), act('copy-subject')).dispatch('click');
  await settle();
  assert.deepStrictEqual(calls, [['copySubject', 'acc:gone']]);
  assert.strictEqual(notices.at(-1), 'This email is no longer in your inbox. Refresh and try again.');
  assert.strictEqual(text(find(ctx.card(m, false), act('copy-subject'))), 'Copy subject', 'not marked as copied');
});

test('every email has Copy subject: Brief cards, Noise and Done when read, and By person', async () => {
  const { ctx, calls } = page({ scripts: ['common.js', 'brief.js', 'people.js'] });
  const m = ctx.tidyEmail(email('acc:2', { triage: { bucket: 'needs-you', reasons: ['Asks you to do something'] }, canOpen: true }));

  // A Brief card: Read, Copy subject, Done and ⋯. Nothing to reply with.
  const actions = find(ctx.card(m, false), (n) => n.className === 'card-actions');
  assert.deepStrictEqual(actions.children.map((n) => text(n.tagName === 'BUTTON' ? n : n.children[0])), ['Read', 'Copy subject', '✓ Done', '⋯']);
  assert.ok(find(ctx.card(m, true), act('copy-subject')), 'compact cards too');

  // Noise and Done rows have Copy subject in their Read panel.
  vm.runInContext('state.reading.set("acc:2", "original")', ctx);
  for (const row of [ctx.noiseRow(m), ctx.doneRow(m)]) {
    const read = find(row, (n) => n.className === 'read');
    assert.ok(find(read, act('copy-subject')), row.className);
  }
  vm.runInContext('state.reading.clear()', ctx);

  // By person: each email's footer.
  const bubble = ctx.bubble(m, { name: 'Sarah Collins' });
  const copy = find(bubble, act('copy-subject'));
  assert.strictEqual(copy.className, 'linkish');
  copy.dispatch('click');
  await settle();
  assert.deepStrictEqual(calls, [['copySubject', 'acc:2']]);
});

test('the ⋯ menu keeps Always important, Always noise and Open in Outlook on the web', () => {
  const { ctx } = page({ scripts: ['common.js', 'brief.js'] });
  const m = ctx.tidyEmail(email('acc:3', { canOpen: true }));
  vm.runInContext('state.menu = "acc:3"', ctx);
  const items = [];
  (function walk(n) {
    if (n.attrs?.role === 'menuitem') items.push(text(n));
    for (const c of n.children || []) walk(c);
  })(ctx.card(m, false));
  assert.deepStrictEqual(items, ['Always important', 'Always noise', 'Open in Outlook on the web']);
});

test('the note shown when reading an email says ClearMail only reads and how to reply in Outlook', () => {
  const { ctx } = page();
  assert.strictEqual(text(ctx.readNote()),
    'ClearMail only reads your email. To reply, find it in Outlook (Copy subject helps) and reply there. Emails stay unread in Outlook.');
});

test('Settings: Outlook accounts are read-only; an old permission to send or change mail is flagged', () => {
  const { ctx } = page({ scripts: ['common.js', 'settings.js'] });
  const ms = (id, extra) => ({ id, kind: 'microsoft', email: `${id}@outlook.com`, signedIn: true, needsSignIn: false, ...extra });
  const view = ctx.tidySettings({
    accounts: [
      ms('fine', { grantedScopes: ['Mail.Read', 'User.Read', 'offline_access', 'openid'] }),
      ms('send', { grantedScopes: ['Mail.Read', 'Mail.Send'] }),
      ms('write', { grantedScopes: ['Mail.ReadWrite'] }),
      ms('shared', { grantedScopes: ['Mail.Read', 'Mail.Send.Shared'] }),
      ms('old', { upgrade: 'reconnect', needsSignIn: true }),
      { id: 'gmail', kind: 'imap', provider: 'gmail', user: 'me@gmail.com', hasPass: true },
    ],
  });
  const status = Object.fromEntries(view.accounts.map((a) => [a.id, ctx.accountStatus(a)]));
  assert.strictEqual(status.fine.perm, "Read-only: can't send, delete or move anything ✓");
  assert.ok(!status.fine.consent);
  for (const id of ['send', 'write', 'shared']) {
    assert.strictEqual(status[id].consent, true, id);
    assert.strictEqual(status[id].signIn, true, id);
    assert.match(status[id].text, /permission to send or change your email/, id);
    assert.match(status[id].text, /click Open Microsoft's permissions page/, id);
  }
  assert.strictEqual(status.old.text, 'ClearMail no longer needs permission to send email or change your mailbox. Click Sign in again.');
  assert.strictEqual(status.gmail.perm, null, 'only Outlook accounts have a permission line');
});

test('the IMAP account form only asks for the incoming server', () => {
  const form = html.match(/<form class="dialog-body" id="account-form"[\s\S]*?<\/form>/)[0];
  for (const name of ['provider', 'imapHost', 'imapPort', 'imapSecurity', 'user', 'pass']) assert.match(form, new RegExp(`name="${name}"`), name);
  assert.deepStrictEqual([...form.matchAll(/name="(\w+)"/g)].map((m) => m[1]).sort(), ['imapHost', 'imapPort', 'imapSecurity', 'pass', 'provider', 'user']);
  assert.ok(!/people-composer/.test(html + css), 'no reply box under By person');
});

test('broken sorting data never hides an email as noise', () => {
  const { ctx } = page();
  for (const triage of [undefined, null, {}, { bucket: 'spam' }, { bucket: 42 }, 'noise']) {
    assert.strictEqual(ctx.tidyEmail({ id: 'x', triage }).triage.bucket, 'worth-knowing', JSON.stringify(triage));
  }
  assert.strictEqual(ctx.tidyEmail({ id: 'x', triage: { bucket: 'noise' } }).triage.bucket, 'noise');
  const t = ctx.tidyEmail({ id: 'x', triage: { bucket: 'needs-you', reasons: ['a', 'b', 'c', 'd'], deadline: { label: 'tomorrow', daysAway: 1 } } }).triage;
  assert.strictEqual(t.reasons.length, 3);
  assert.strictEqual(t.deadline.label, 'tomorrow');
});

// ---------- a small fake page for the renderer scripts ----------

function email(id, extra = {}) {
  return {
    id, accountId: 'acc', accountEmail: 'will@outlook.com', from: { name: 'Sarah Collins', address: 'sarah@example.com' },
    subject: 'Quote', date: '2026-11-03T09:00:00Z', summary: { gist: 'Can you confirm the quote?' },
    triage: { bucket: 'needs-you', reasons: ['Asks you a question'], codes: ['asks-question'] }, ...extra,
  };
}

const settle = () => new Promise((r) => setImmediate(r));
const act = (name) => (n) => n.attrs?.['data-act'] === name;

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

const text = (node) => (node.children.length ? node.children.map(text).join('') : node.textContent);

// scripts: the renderer files to load, in order. copyError: what clearmail.copySubject rejects with.
function page({ scripts = ['common.js'], copyError = null } = {}) {
  class FakeNode {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attrs = {};
      this.listeners = {};
      this.dataset = {};
      this.style = { setProperty() {} };
      this.className = '';
      this.textContent = '';
      this.value = '';
      this.isConnected = false;
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
      if (k === 'disabled') this.disabled = true;
    }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    focus() {}
    dispatch(type, init = {}) {
      const e = { type, target: this, currentTarget: this, defaultPrevented: false, ...init };
      e.preventDefault = () => { e.defaultPrevented = true; };
      e.stopPropagation = () => {};
      for (const fn of this.listeners[type] || []) fn(e);
      return e;
    }
  }
  // Every call to window.clearmail, with all its arguments.
  const calls = [];
  const clearmail = {
    copySubject: (...args) => {
      calls.push(['copySubject', ...args]);
      return copyError ? Promise.reject(new Error(copyError)) : Promise.resolve({ copied: true });
    },
  };
  // The notice line under the top bar: every text shown in it (as the DOM would: a child
  // that isn't a node shows as its string, so a stray null would read "null").
  const notices = [];
  const noticeNode = new FakeNode('div');
  noticeNode.replaceChildren = (...nodes) => {
    noticeNode.children = nodes;
    if (nodes.length) notices.push(nodes.map((n) => (n instanceof FakeNode ? text(n) : String(n))).join(''));
  };
  // Timers are recorded, not run, so a test can check how long something stays and then run it.
  const timers = [];
  const document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => Object.assign(new FakeNode('#text'), { textContent: t }),
    getElementById: (id) => (id === 'notice' ? noticeNode : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
  };
  const ctx = vm.createContext({
    document,
    Node: FakeNode,
    clearmail,
    CSS: { escape: (s) => String(s) },
    Intl,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    renderAll: () => {}, // from app.js
  });
  for (const name of scripts) vm.runInContext(sources[name], ctx, { filename: `renderer/${name}` });
  return { ctx, calls, notices, timers };
}
