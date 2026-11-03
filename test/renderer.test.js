// Static and unit checks for the renderer (renderer/*.js and index.html). They run without a
// browser: the files are read as text, and common.js is loaded into a small fake page to check
// that a plain Enter in the reply box never sends.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', 'renderer');
const SCRIPTS = ['common.js', 'brief.js', 'people.js', 'settings.js', 'app.js'];
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const html = read('index.html');
const sources = Object.fromEntries(SCRIPTS.map((name) => [name, read(name)]));
const allJs = Object.values(sources).join('\n');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

// What the renderer may call on window.clearmail: the preload's names for contract H.
const API = [
  'getSettings', 'saveSettings', 'saveAccount', 'removeAccount', 'signInMicrosoft', 'cancelSignIn',
  'loadInbox', 'openEmail', 'reply', 'undoReply', 'openLink', 'setRule', 'setNotNoise', 'setDone',
  'importDone', 'testBrief', 'briefStatus', 'openSystemSettings', 'openConsentPage',
  'onBriefShow', 'onInboxUpdated', 'onReplyResult',
];

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

test('the renderer only calls the contract H channels', () => {
  const used = new Set([...code(allJs).matchAll(/(?<![\w'"`.])clearmail\.(\w+)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(API.includes(name), `clearmail.${name} is not in contract H`);
  for (const name of ['reply', 'undoReply', 'setRule', 'setNotNoise', 'setDone', 'importDone', 'loadInbox', 'onReplyResult']) {
    assert.ok(used.has(name), `clearmail.${name} is used`);
  }
});

test('only isSendKey (or the Send button) can send a reply', () => {
  const src = code(allJs);
  // submitReply: defined once, called by the form's submit (the Send button) and after isSendKey.
  const submits = [...src.matchAll(/submitReply\(/g)].length;
  assert.strictEqual(submits, 3, 'definition, onsubmit and the ⌘↩ path');
  assert.match(src, /if \(isSendKey\(e\)\) \{\s*e\.preventDefault\(\);\s*submitReply\(/);
  assert.match(src, /onsubmit: \(e\) => \{\s*e\.preventDefault\(\);\s*submitReply\(/);
  // queueReply: defined once, called from submitReply and Retry.
  assert.strictEqual([...src.matchAll(/queueReply\(/g)].length, 3);
  assert.match(src, /function retryReply\(m, entry\) \{[\s\S]*?queueReply\(m, entry\.body\)/);
  // The old Enter-to-send is gone, and nothing else calls clearmail.reply.
  assert.ok(!/e\.metaKey \|\| !e\.shiftKey/.test(src));
  assert.strictEqual([...src.matchAll(/clearmail\.reply\(/g)].length, 1);
});

test('isSendKey: only ⌘↩ (or Ctrl+↩) sends; plain Enter, Shift+Enter and IME Enter never do', () => {
  const { ctx } = page();
  const no = [
    { key: 'Enter' },
    { key: 'Enter', shiftKey: true },
    { key: 'Enter', altKey: true },
    { key: 'Enter', metaKey: true, altKey: true },
    { key: 'Enter', metaKey: true, isComposing: true },
    { key: 'Enter', ctrlKey: true, keyCode: 229 },
    { key: 'a', metaKey: true },
    null,
  ];
  for (const e of no) assert.strictEqual(ctx.isSendKey(e), false, JSON.stringify(e));
  assert.strictEqual(ctx.isSendKey({ key: 'Enter', metaKey: true }), true);
  assert.strictEqual(ctx.isSendKey({ key: 'Enter', ctrlKey: true }), true);
});

test('the reply box: a plain Enter types a new line; ⌘↩ queues the reply once', async () => {
  const { ctx, calls } = page();
  const m = ctx.tidyEmail({
    id: 'acc1:msg1', accountId: 'acc1', accountEmail: 'will@outlook.com',
    from: { name: 'Sarah Collins', address: 'sarah@example.com' }, subject: 'Quote', date: '2026-11-03T09:00:00Z',
    triage: { bucket: 'needs-you', reasons: ['Asks you to do something'], codes: ['asks-action'] },
  });
  const form = ctx.composer(m, { onClose: () => {} });
  const textarea = find(form, (n) => n.tagName === 'TEXTAREA');
  const from = find(form, (n) => n.className === 'reply-from');
  assert.match(text(from), /^From will@outlook\.com to Sarah Collins \(sarah@example\.com\)$/);

  textarea.value = 'Thanks Sarah,\n\nYes please.';
  textarea.dispatch('input');
  for (const e of [{ key: 'Enter' }, { key: 'Enter', shiftKey: true }, { key: 'Enter', metaKey: true, isComposing: true }, { key: 'Enter', metaKey: true, keyCode: 229 }]) {
    const ev = textarea.dispatch('keydown', e);
    assert.strictEqual(ev.defaultPrevented, false, `${JSON.stringify(e)} is left to type`);
  }
  assert.deepStrictEqual(calls, [], 'nothing was sent');
  assert.strictEqual(vm.runInContext('state.drafts.get("acc1:msg1")', ctx), 'Thanks Sarah,\n\nYes please.', 'the draft is kept');

  const ev = textarea.dispatch('keydown', { key: 'Enter', metaKey: true });
  assert.strictEqual(ev.defaultPrevented, true);
  assert.deepStrictEqual(calls, [['reply', 'acc1:msg1', 'Thanks Sarah,\n\nYes please.']]);
  // A second ⌘↩ while the first waits its 5 seconds doesn't send again.
  textarea.dispatch('keydown', { key: 'Enter', metaKey: true });
  assert.strictEqual(calls.length, 1);
  await new Promise((r) => setImmediate(r));
  const entry = vm.runInContext('pendingReply("acc1:msg1")', ctx);
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(vm.runInContext('state.drafts.has("acc1:msg1")', ctx), false);
});

test('Undo returns the reply to the box; a result for it later is ignored', async () => {
  const { ctx, calls } = page();
  const m = ctx.tidyEmail({ id: 'a:1', accountEmail: 'me@example.com', from: { name: 'Dad', address: 'dad@example.com' }, date: '2026-11-03T09:00:00Z' });
  ctx.queueReply(m, 'See you Sunday');
  await new Promise((r) => setImmediate(r));
  await ctx.undoReply(m);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['reply', 'undoReply']);
  assert.strictEqual(vm.runInContext('state.drafts.get("a:1")', ctx), 'See you Sunday');
  assert.strictEqual(vm.runInContext('pendingReply("a:1")', ctx), null);
  ctx.handleReplyResult({ id: 'a:1', ok: true });
  assert.strictEqual(vm.runInContext('repliesFor("a:1").length', ctx), 0);
});

test('a failed reply keeps its text for Retry', async () => {
  const { ctx } = page();
  const m = ctx.tidyEmail({ id: 'a:2', from: { name: 'Jo', address: 'jo@example.com' }, date: '2026-11-03T09:00:00Z' });
  ctx.queueReply(m, 'On it');
  await new Promise((r) => setImmediate(r));
  ctx.handleReplyResult({ id: 'a:2', ok: false, error: "Couldn't reach Outlook." });
  const list = vm.runInContext('repliesFor("a:2")', ctx);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].status, 'failed');
  assert.strictEqual(list[0].body, 'On it');
  assert.strictEqual(list[0].error, "Couldn't reach Outlook.");
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

// ---------- a small fake page for common.js ----------

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

const text = (node) => (node.children.length ? node.children.map(text).join('') : node.textContent);

function page() {
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
      this.offsetParent = null;
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
      if (k === 'disabled') this.disabled = true;
    }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    append(...nodes) { this.children.push(...nodes); }
    focus() {}
    setSelectionRange() {}
    dispatch(type, init = {}) {
      const e = { type, target: this, currentTarget: this, defaultPrevented: false, ...init };
      e.preventDefault = () => { e.defaultPrevented = true; };
      for (const fn of this.listeners[type] || []) fn(e);
      return e;
    }
  }
  const calls = [];
  const clearmail = {
    reply: (id, body) => {
      calls.push(['reply', id, body]);
      return Promise.resolve({ queued: true, sendAt: Date.now() + 5000 });
    },
    undoReply: (id) => {
      calls.push(['undoReply', id]);
      return Promise.resolve({ undone: true });
    },
  };
  const document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => Object.assign(new FakeNode('#text'), { textContent: t }),
    getElementById: () => null,
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
    setTimeout,
    clearTimeout,
    setInterval: () => 0, // the Undo countdown isn't needed here
    clearInterval: () => {},
    renderAll: () => {}, // from app.js
  });
  vm.runInContext(sources['common.js'], ctx, { filename: 'renderer/common.js' });
  return { ctx, calls };
}
