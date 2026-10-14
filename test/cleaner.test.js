const test = require('node:test');
const assert = require('node:assert');
const { clean } = require('../src/cleaner');
const demo = require('../src/demo');

const byId = (id) => demo.find((m) => m.id === id);
const run = (m) => clean({ text: m.text, subject: m.subject, from: m.from.address });

test('strips greetings, pleasantries, sign-off, signature and quoted reply', () => {
  const c = run(byId('demo-2'));
  assert.doesNotMatch(c.body, /hope you're well/i);
  assert.doesNotMatch(c.body, /don't hesitate/i);
  assert.doesNotMatch(c.body, /Kind regards/);
  assert.doesNotMatch(c.body, /wrote:|Previous message/);
  assert.match(c.body, /£14,750/);
});

test('pulls out money, dates, asks and actions', () => {
  const c = run(byId('demo-2'));
  assert.ok(c.amounts.includes('£14,750'));
  assert.ok(c.dates.some((d) => /Friday 17th October/i.test(d)));
  assert.ok(c.times.includes('10am'));
  assert.ok(c.questions.some((q) => /site meeting/.test(q)));
  assert.ok(c.actions.some((a) => /confirm/.test(a)));
});

test('rewrites throat-clearing openers', () => {
  const c = run(byId('demo-1'));
  assert.match(c.body, /^About the Harrow extension/);
});

test('removes legal footers and unsubscribe blocks', () => {
  assert.doesNotMatch(run(byId('demo-1')).body, /confidential|Registered in England/i);
  assert.doesNotMatch(run(byId('demo-5')).body, /Unsubscribe|Privacy policy/i);
});

test('shortens tracking links but keeps the URL', () => {
  const c = run(byId('demo-5'));
  assert.match(c.body, /\[screwfix\.com\]/);
  assert.match(c.links[0].url, /^https:\/\/www\.screwfix\.com\/orders/);
});

test('categorises mail', () => {
  assert.strictEqual(run(byId('demo-5')).category, 'receipt');
  assert.strictEqual(run(byId('demo-6')).category, 'newsletter');
  assert.strictEqual(run(byId('demo-4')).category, 'notification');
  assert.strictEqual(run(byId('demo-7')).category, 'person');
  assert.strictEqual(run(byId('demo-4')).urgency, 'high');
});

test('handles HTML-only mail', () => {
  const c = clean({ html: '<p>Hi Will,</p><p>The meeting moved to <b>3pm Thursday</b>.</p><p>Unsubscribe here</p>' });
  assert.strictEqual(c.body, 'The meeting moved to 3pm Thursday.');
});
