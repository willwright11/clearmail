// src/view.js: from loaded emails to the BriefView the window shows (IPC contract H).
process.env.TZ = 'Europe/London';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const view = require('../src/view');
const demo = require('../src/demo');
const { buildSentBatch } = require('../src/demo-sent');
const history = require('../src/history');
const { briefWindow } = require('../src/brief');
const { replyTarget } = require('../src/reply-target');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 3, 9, 15).getTime(); // Tue 3 Nov 2026, 09:15
const EMAIL_VIEW = ['accountEmail', 'accountId', 'attachments', 'canOpen', 'cleanedBody', 'date', 'done', 'from', 'id', 'isNew', 'links', 'notNoise',
  'original', 'receivedAt', 'replyNote', 'replyTarget', 'replyTo', 'seen', 'senderRule', 'subject', 'summary', 'triage'];

function raw(id, extra = {}) {
  const date = extra.date || new Date(NOW - HOUR).toISOString();
  return {
    id, messageId: `<${id}@example.com>`, uid: null, from: { name: 'Ann', address: 'ann@example.com' }, replyTo: null, to: [{ name: 'Will', address: 'will@example.com' }], cc: [],
    subject: `About ${id}`, date, receivedAt: date, text: `Hello, this is ${id}.`, html: '', seen: false, flagged: false, references: [], attachments: [],
    headers: null, importance: 'normal', focused: null, conversationId: null, inReplyTo: null, webLink: null,
    ...extra,
  };
}

const item = (r, extra = {}) => ({ id: `acc1:${r.id}`, accountId: 'acc1', accountEmail: 'will@example.com', raw: r, prep: view.prepareEmail(r), canOpen: true, ...extra });

// The demo inbox at NOW, with the demo Sent folder, as main.js builds it.
function demoView(marks = {}, { since = NOW - DAY } = {}) {
  const emails = demo.build(NOW);
  const sent = history.mergeSent(null, buildSentBatch({ now: NOW, emails }), { accountEmail: demo.ME.address, now: NOW });
  const items = emails.map((r) => ({ id: `demo:${r.id}`, accountId: 'demo', accountEmail: '', raw: r, prep: view.prepareEmail(r), canOpen: false }));
  return view.buildBriefView({
    now: NOW, demo: true, demoReason: 'no-account', since, sinceLabel: 'since yesterday 07:30', accounts: [], items,
    history: history.historyContext([sent], { accountEmails: [demo.ME.address] }),
    marks: { rules: {}, done: {}, notNoise: {}, ...marks },
  });
}

const bucketOf = (v, n) => v.emails.find((m) => m.id === `demo:demo-${n}`).triage.bucket;
const numbers = (list) => list.map((m) => Number(m.id.split('-').pop()));

test('prepareEmail: cleaned text, deadlines and the short version, worked out once per email', () => {
  const r = raw('m1', { subject: 'Invoice', text: 'Hi Will,\n\nPlease pay the invoice of £250 by Friday 6 November.\n\nThanks,\nAnn', date: new Date(NOW - DAY).toISOString() });
  const p = view.prepareEmail(r);
  assert.deepStrictEqual(Object.keys(p).sort(), ['cleaned', 'deadlines', 'key', 'original', 'summary']);
  assert.strictEqual(p.original, r.text);
  assert.ok(p.cleaned.amounts.includes('£250'));
  assert.deepStrictEqual(p.deadlines.map((d) => [d.day, d.source]), [['2026-11-06', 'ask']]);
  assert.match(p.summary.gist, /pay the invoice of £250 by Friday 6 November/);
  assert.deepStrictEqual(p.summary.dates.map((d) => d.day), ['2026-11-06']);
  assert.strictEqual(view.prepareEmail(r, { previous: p }), p, 'reused');
  assert.notStrictEqual(view.prepareEmail({ ...r, text: `${r.text} More.` }, { previous: p }), p, 'not when the email could be read this time');
  assert.notStrictEqual(view.prepareEmail(r, { previous: p, order: 'mdy' }), p, 'not for another date order');
  // 10/11 is 10 November in the UK and 11 October in the US.
  const numeric = raw('m2', { text: 'Please reply by 10/11.', date: new Date(NOW - DAY).toISOString() });
  assert.strictEqual(view.prepareEmail(numeric, { order: 'dmy' }).deadlines[0].day, '2026-11-10');
  assert.strictEqual(view.prepareEmail(numeric, { order: 'mdy' }).deadlines[0].day, '2026-10-11', 'up to 60 days back counts as this year');
});

test('prepareEmail: HTML becomes text, and an email the cleaner chokes on is shown uncleaned', () => {
  const html = view.prepareEmail(raw('h1', { text: '', html: '<p>Can you <b>call</b> me?</p><script>alert(1)</script>' }));
  assert.ok(!/<b>|<p>|<script/.test(html.original + html.cleaned.body));

  const cleanerPath = require.resolve('../src/cleaner');
  const viewPath = require.resolve('../src/view');
  const real = require.cache[cleanerPath].exports;
  require.cache[cleanerPath].exports = { ...real, clean: () => { throw new Error('boom'); } };
  delete require.cache[viewPath];
  const original = console.error;
  console.error = () => {};
  try {
    const broken = require('../src/view').prepareEmail(raw('b1', { text: 'Could you call me back about Friday?' }));
    assert.strictEqual(broken.cleaned.body, 'Could you call me back about Friday?');
    assert.strictEqual(broken.cleaned.category, 'person');
    assert.strictEqual(broken.summary.gist.length > 0, true);
  } finally {
    console.error = original;
    require.cache[cleanerPath].exports = real;
    delete require.cache[viewPath];
    require('../src/view');
  }
});

test('toTriageInput: the email\'s own fields, its account-prefixed id, and what was worked out', () => {
  const r = raw('t1', { flagged: true, focused: false, headers: { listUnsubscribe: '<x>', listId: null, precedence: null, autoSubmitted: null } });
  const it = item(r);
  const input = view.toTriageInput(it);
  assert.strictEqual(input.id, 'acc1:t1');
  for (const key of ['from', 'to', 'cc', 'subject', 'date', 'receivedAt', 'seen', 'flagged', 'importance', 'focused', 'headers', 'conversationId', 'messageId']) {
    assert.deepStrictEqual(input[key], r[key], key);
  }
  assert.strictEqual(input.cleaned, it.prep.cleaned);
  assert.strictEqual(input.deadlines, it.prep.deadlines);
  assert.strictEqual(r.id, 't1', 'the email itself is not changed');
});

test('buildEmailView: exactly the contract fields, as plain text, never the HTML', () => {
  const r = raw('v1', {
    from: { name: '', address: 'bob@example.com' }, replyTo: { name: '', address: 'help@example.com' }, date: 'not a date', receivedAt: undefined,
    html: '<p>secret <img src="https://tracker.example/p.gif"></p>', text: '', attachments: [{ filename: 'a.pdf', size: '20' }, { size: 3 }],
    webLink: 'https://outlook.live.com/owa/?ItemID=1',
  });
  const v = view.buildEmailView(item(r), { triage: { bucket: 'worth-knowing', reasons: [], codes: [], deadline: null, caution: null }, isNew: true, now: NOW });
  assert.deepStrictEqual(Object.keys(v).sort(), EMAIL_VIEW);
  assert.deepStrictEqual(v.from, { name: 'bob@example.com', address: 'bob@example.com' });
  assert.deepStrictEqual(v.replyTo, { name: 'help@example.com', address: 'help@example.com' });
  assert.deepStrictEqual([v.replyTarget, v.replyNote], [{ name: 'help@example.com', address: 'help@example.com' }, null]);
  assert.strictEqual(v.date, new Date(NOW).toISOString(), 'a bad date reads as now');
  assert.strictEqual(v.receivedAt, v.date);
  assert.deepStrictEqual(v.attachments, [{ filename: 'a.pdf', size: 20 }, { filename: 'attachment', size: 3 }]);
  assert.ok(!JSON.stringify(v).includes('<p>') && !JSON.stringify(v).includes('tracker.example'), 'no HTML and no remote image');
  assert.ok(!JSON.stringify(v).includes('ItemID'), 'the Outlook link stays in main');
  assert.deepStrictEqual([v.isNew, v.done, v.notNoise, v.senderRule, v.canOpen], [true, false, false, null, true]);
  assert.strictEqual(view.buildEmailView(item(r), { triage: {}, senderRule: 'delete' }).senderRule, null);
});

test('buildEmailView: one address a reply goes to, the one both backends send to', () => {
  const ev = (extra) => view.buildEmailView(item(raw('r1', extra)), { triage: {}, now: NOW });
  const reply = (v) => [v.replyTarget, v.replyTo, v.replyNote];
  assert.deepStrictEqual(reply(ev({})), [{ name: 'Ann', address: 'ann@example.com' }, null, null], 'From, by default');

  // "Kestrel Bank Fraud Team <fraud-team>" is no address: the reply goes to From, and the
  // reply box says From (it used to name the Reply-To while the reply went to From).
  const bank = { name: 'Kestrel Bank', address: 'alerts@kestrel-secure.example' };
  assert.deepStrictEqual(reply(ev({ from: bank, replyTo: { name: 'Kestrel Bank Fraud Team', address: 'fraud-team' } })), [bank, null, null]);

  // A Reply-To on the sender's own domain, as universities and shops use: no note.
  const library = { name: 'Library', address: 'library@lboro.ac.uk' };
  assert.deepStrictEqual(reply(ev({ from: { name: 'Student Services', address: 'noreply@lboro.ac.uk' }, replyTo: library })), [library, library, null]);
  // On another domain: the box says where it really goes.
  const elsewhere = ev({ from: { name: 'Kestrel Bank', address: 'alerts@kestrelbank.example' }, replyTo: { name: '', address: ' Support@Kestrel-Help.example ' } });
  const support = { name: 'support@kestrel-help.example', address: 'support@kestrel-help.example' };
  assert.deepStrictEqual(reply(elsewhere), [support, support, 'Replies go to support@kestrel-help.example, not the address it came from.']);

  // No address at all: nothing to reply to (Reply is turned off, and main refuses it).
  assert.deepStrictEqual(reply(ev({ from: { name: 'Mail Delivery System', address: '' }, replyTo: { name: 'x', address: 'nobody' } })), [null, null, null]);
  assert.deepStrictEqual(reply(ev({ from: { name: 'Odd', address: 'not an address' }, replyTo: null })), [null, null, null]);

  // Graph lists every Reply-To address: only the first real one is ever used.
  const list = { from: bank, replyTo: [{ name: 'x', address: 'fraud-team' }, { name: 'Support', address: 'support@kestrel-help.example' }, { name: 'y', address: 'collector@attacker.example' }] };
  assert.deepStrictEqual(replyTarget(list), { name: 'Support', address: 'support@kestrel-help.example' });
  // Every sample email can be answered.
  for (const m of demoView().emails) assert.ok(m.replyTarget && m.replyTarget.address === m.from.address, m.id);
});

test('firstNames: the first word of each account name, lower-cased, letters only, 2 letters or more', () => {
  assert.deepStrictEqual(view.firstNames(['Will Wright', 'WILL W', '  Ann-Marie Jones', 'J Smith', '', null, 42, 'Zoë Ball', 'Will,']), ['will', 'annmarie', 'zoë']);
  assert.deepStrictEqual(view.firstNames([]), []);
  assert.deepStrictEqual(view.firstNames([demo.ME.name]), ['will']);
});

test('prepareEmail and buildBriefView pass on the user\'s names and the forwarded parts', () => {
  const paths = Object.fromEntries(['cleaner', 'summarize', 'dates', 'triage'].map((n) => [n, require.resolve(`../src/${n}`)]));
  const viewPath = require.resolve('../src/view');
  const real = Object.fromEntries(Object.entries(paths).map(([n, p]) => [n, require.cache[p].exports]));
  const seen = { summary: [], deadlines: [], triage: [] };
  const forwarded = [{ at: 12, date: '2026-10-30T09:00:00.000Z' }];
  require.cache[paths.cleaner].exports = { ...real.cleaner, clean: (...args) => ({ ...real.cleaner.clean(...args), forwarded }) };
  require.cache[paths.summarize].exports = {
    ...real.summarize,
    heuristicSummary: (...args) => { seen.summary.push(args[3]); return real.summarize.heuristicSummary(...args); },
  };
  require.cache[paths.dates].exports = { ...real.dates, findDeadlines: (...args) => { seen.deadlines.push(args); return real.dates.findDeadlines(...args); } };
  require.cache[paths.triage].exports = { ...real.triage, triageAll: (...args) => { seen.triage.push(args[1]); return real.triage.triageAll(...args); } };
  delete require.cache[viewPath];
  try {
    const v = require('../src/view');
    const r = raw('n1', { cc: [{ name: 'Will', address: 'will@example.com' }], to: [{ name: 'Ann', address: 'ann@example.com' }], text: 'Hi Ann,\n\nWill, could you send the forms by Friday?\n\nThanks' });
    const p = v.prepareEmail(r, { names: ['will'] });
    assert.deepStrictEqual(seen.summary[0].names, ['will']);
    assert.strictEqual(seen.summary[0].deadlines, p.deadlines);
    const [input, ref, opts] = seen.deadlines[0];
    assert.strictEqual(input.forwarded, forwarded, 'the cleaner\'s forwarded parts reach findDeadlines');
    assert.strictEqual(input.body, p.cleaned.body);
    assert.deepStrictEqual([ref, opts], [r.date, { order: 'dmy' }]);
    // Worked out again when the names change (an account renamed), not otherwise.
    assert.strictEqual(v.prepareEmail(r, { names: ['will'], previous: p }), p);
    assert.notStrictEqual(v.prepareEmail(r, { names: ['bill'], previous: p }), p);
    assert.deepStrictEqual(seen.summary.at(-1).names, ['bill']);
    // No names: an empty list, never undefined.
    v.prepareEmail(raw('n2'));
    assert.deepStrictEqual(seen.summary.at(-1).names, []);

    v.buildBriefView({
      now: NOW, demo: false, demoReason: null, since: NOW - DAY, sinceLabel: '', accounts: [], history: null, marks: null,
      items: [{ id: 'acc1:n1', accountId: 'acc1', accountEmail: 'will@example.com', raw: r, prep: p, canOpen: true }], names: ['will'],
    });
    assert.deepStrictEqual(seen.triage[0].names, ['will'], 'the TriageContext gets the names');
    v.buildBriefView({ now: NOW, demo: false, demoReason: null, since: NOW - DAY, sinceLabel: '', accounts: [], history: null, marks: null, items: [] });
    assert.deepStrictEqual(seen.triage[1].names, []);

    // An email the cleaner chokes on has no forwarded parts.
    require.cache[paths.cleaner].exports = { ...real.cleaner, clean: () => { throw new Error('boom'); } };
    delete require.cache[viewPath];
    const original = console.error;
    console.error = () => {};
    try {
      require('../src/view').prepareEmail(raw('n3'));
    } finally {
      console.error = original;
    }
    assert.deepStrictEqual(seen.deadlines.at(-1)[0].forwarded, []);
  } finally {
    for (const [n, p] of Object.entries(paths)) require.cache[p].exports = real[n];
    delete require.cache[viewPath];
    require('../src/view');
  }
});

test('buildBriefView: the demo inbox sorts as designed, in display order, with counts', () => {
  const v = demoView();
  assert.deepStrictEqual(Object.keys(v).sort(), ['accounts', 'counts', 'demo', 'demoReason', 'emails', 'generatedAt', 'since', 'sinceLabel']);
  assert.deepStrictEqual([v.demo, v.demoReason, v.sinceLabel, v.generatedAt], [true, 'no-account', 'since yesterday 07:30', new Date(NOW).toISOString()]);
  const by = (b) => numbers(v.emails.filter((m) => m.triage.bucket === b)).sort((x, y) => x - y);
  assert.deepStrictEqual(by('needs-you'), [2, 3, 7, 8, 13, 15]);
  assert.deepStrictEqual(by('worth-knowing'), [1, 4, 5, 14]);
  assert.deepStrictEqual(by('noise'), [6, 9, 10, 11, 12, 16, 17]);
  for (const m of v.emails) assert.deepStrictEqual(Object.keys(m).sort(), EMAIL_VIEW);

  // Needs you, then Worth knowing, then Noise; Needs you by deadline, overdue and soonest first.
  const order = ['needs-you', 'worth-knowing', 'noise'];
  const buckets = v.emails.map((m) => order.indexOf(m.triage.bucket));
  assert.deepStrictEqual(buckets, [...buckets].sort((a, b) => a - b));
  const away = v.emails.filter((m) => m.triage.bucket === 'needs-you').map((m) => m.triage.deadline?.daysAway ?? Infinity);
  assert.deepStrictEqual(away, [...away].sort((a, b) => a - b));
  // Worth knowing: new since the brief first. Noise: each sender's emails together.
  const worth = v.emails.filter((m) => m.triage.bucket === 'worth-knowing');
  assert.deepStrictEqual(worth.map((m) => m.isNew), [...worth.map((m) => m.isNew)].sort((a, b) => Number(b) - Number(a)));
  const senders = v.emails.filter((m) => m.triage.bucket === 'noise').map((m) => m.from.address);
  assert.deepStrictEqual(senders.filter((s, i) => s !== senders[i - 1]).length, new Set(senders).size, 'grouped by sender');

  assert.match(v.emails.find((m) => m.id === 'demo:demo-1').triage.reasons[0], /already replied/);
  assert.strictEqual(v.counts.needsYou, 6);
  assert.strictEqual(v.counts.done, 0);
  assert.strictEqual(v.counts.worthKnowing + v.counts.noise, v.emails.filter((m) => m.isNew && m.triage.bucket !== 'needs-you').length);
});

test('buildBriefView: isNew and the counts follow the brief\'s window', () => {
  const window = briefWindow(NOW, { lastAt: NOW - 2 * HOUR, lastSince: NOW - 26 * HOUR, lastSlot: NOW - 2 * HOUR });
  const v = demoView({}, { since: window.since });
  for (const m of v.emails) assert.strictEqual(m.isNew, Date.parse(m.receivedAt) > window.since, m.id);
  const later = demoView({}, { since: NOW });
  assert.ok(later.emails.every((m) => !m.isNew));
  assert.deepStrictEqual([later.counts.worthKnowing, later.counts.noise, later.counts.needsYouNew], [0, 0, 0]);
  assert.strictEqual(later.counts.needsYou, 6, 'Needs you counts everything from the last 30 days');
});

test('buildBriefView: rules, Not noise and Done change the sorting, and Done comes last', () => {
  const weekly = 'newsletter@weeklybuilder.com';
  const sarah = 'sarah.collins@brightbuild.co.uk';
  let v = demoView({ rules: { [weekly]: 'important' } });
  assert.strictEqual(bucketOf(v, 6), 'needs-you');
  assert.strictEqual(v.emails.find((m) => m.id === 'demo:demo-6').senderRule, 'important');
  assert.match(v.emails.find((m) => m.id === 'demo:demo-6').triage.reasons[0], /always important/);

  v = demoView({ rules: { [sarah]: 'noise' } });
  assert.deepStrictEqual([bucketOf(v, 1), bucketOf(v, 2)], ['noise', 'noise']);
  // A rule for the whole domain applies, but the email's senderRule is its own address's only.
  v = demoView({ rules: { '@brightbuild.co.uk': 'noise' } });
  assert.deepStrictEqual([bucketOf(v, 2), v.emails.find((m) => m.id === 'demo:demo-2').senderRule], ['noise', null]);
  v = demoView({ rules: { [sarah]: 'noise' }, notNoise: { 'demo:demo-2': NOW } });
  assert.strictEqual(bucketOf(v, 2), 'needs-you', 'Not noise beats Always noise');
  assert.strictEqual(v.emails.find((m) => m.id === 'demo:demo-2').notNoise, true);

  v = demoView({ notNoise: { 'demo:demo-9': NOW } });
  assert.notStrictEqual(bucketOf(v, 9), 'noise');

  v = demoView({ done: { 'demo:demo-2': NOW - HOUR, 'demo:demo-9': NOW - 2 * HOUR, 'demo:demo-3': NOW - 3 * HOUR } });
  assert.deepStrictEqual(v.emails.slice(-3).map((m) => [m.id, m.done]), [['demo:demo-2', true], ['demo:demo-9', true], ['demo:demo-3', true]], 'most recently done first');
  assert.ok(v.emails.slice(0, -3).every((m) => !m.done));
  assert.deepStrictEqual([v.counts.done, v.counts.needsYou], [3, 4]);
});

test('buildBriefView: an account\'s row says read-only, and nothing about an email is lost', () => {
  const items = [item(raw('a1')), item(raw('a2', { from: { name: 'Shop', address: 'deals@shop.example' }, headers: { listUnsubscribe: '<u>', listId: null, precedence: 'bulk', autoSubmitted: null } }))];
  const v = view.buildBriefView({
    now: NOW, demo: false, demoReason: null, since: NOW - DAY, sinceLabel: 'in the last 24 hours',
    accounts: [{ id: 'acc1', email: 'will@example.com', kind: 'imap', error: null, needsSignIn: false }], items, history: null, marks: null,
  });
  assert.deepStrictEqual(v.accounts, [{ id: 'acc1', email: 'will@example.com', kind: 'imap', error: null, needsSignIn: false, readOnly: true }]);
  assert.deepStrictEqual(v.emails.map((m) => m.id).sort(), ['acc1:a1', 'acc1:a2']);
  assert.deepStrictEqual(v.emails.map((m) => m.triage.bucket), ['worth-knowing', 'noise']);
  assert.strictEqual(v.since, new Date(NOW - DAY).toISOString());
});
