// src/history.js: the Sent-folder history triage uses ("You've written to them 6 times",
// "You've already replied"). Pure functions, so plain data in and out.
const test = require('node:test');
const assert = require('node:assert');
const history = require('../src/history');

const ME = 'willw6311@outlook.com';
const NOW = Date.parse('2026-11-03T08:00:00Z');
const at = (iso) => new Date(iso).toISOString();

// A SentBatch as fetchSentHistory returns it.
const batch = (entries, { full = false, cursor = { kind: 'graph', since: '2026-11-02T18:00:00.000Z', fullAt: NOW } } = {}) => ({ cursor, full, entries });
const sent = (date, to, over = {}) => ({ from: ME, to: [].concat(to), date: at(date), conversationId: null, inReplyTo: null, ...over });

// Deep-freezes a value, so a test fails if a function changes what it was given.
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) frozen(v);
    Object.freeze(value);
  }
  return value;
}

test('an empty history, and anything malformed on disk read as empty', () => {
  assert.deepStrictEqual(history.emptyHistory(), { cursor: null, syncedAt: null, me: [], people: {}, replies: {} });
  for (const junk of [null, undefined, 'x', 42, [], { people: 'no', replies: [1], me: 'me' }]) {
    assert.deepStrictEqual(history.normalizeHistory(junk), history.emptyHistory());
  }
  const cleaned = history.normalizeHistory({
    cursor: { kind: 'imap', path: 'Sent', uidValidity: 123, lastUid: 9, fullAt: NOW, extra: 'dropped' },
    syncedAt: 'yesterday-ish',
    me: ['Will@Example.com', 'not an address', 'will@example.com'],
    people: {
      'Sarah@Example.com': { n: 6, last: '2026-11-01T10:00:00Z' },
      'zero@example.com': { n: 0, last: '2026-11-01T10:00:00Z' },
      'nodate@example.com': { n: 2, last: 'soon' },
      'not-an-address': { n: 1, last: '2026-11-01T10:00:00Z' },
      'fraction@example.com': { n: 1.5, last: '2026-11-01T10:00:00Z' },
    },
    replies: { 'c:AAQk=': '2026-11-01T10:00:00Z', 'm:<a@b>': 'never', 'x:other': '2026-11-01T10:00:00Z', 'c:': '2026-11-01T10:00:00Z' },
  });
  assert.deepStrictEqual(cleaned, {
    cursor: { kind: 'imap', path: 'Sent', uidValidity: '123', lastUid: 9, fullAt: NOW },
    syncedAt: null,
    me: ['will@example.com'],
    people: { 'sarah@example.com': { n: 6, last: '2026-11-01T10:00:00.000Z' } },
    replies: { 'c:AAQk=': '2026-11-01T10:00:00.000Z' },
  });
  assert.strictEqual(history.normalizeHistory({ cursor: { kind: 'other', fullAt: 1 } }).cursor, null);
  assert.deepStrictEqual(history.normalizeHistory({ cursor: { kind: 'graph', since: 'x', fullAt: NOW } }).cursor, { kind: 'graph', since: null, fullAt: NOW });
});

test('mergeSent: counts the people written to, case-insensitively, and the conversations replied in', () => {
  const input = frozen(batch([
    sent('2026-10-01T09:00:00Z', ['Sarah@Example.com', 'tom@example.com'], { conversationId: 'AAQkQuote=' }),
    sent('2026-10-20T09:00:00Z', 'sarah@example.com', { conversationId: 'AAQkQuote=' }),
    sent('2026-10-05T09:00:00Z', ['SARAH@example.com', 'sarah@example.com'], { inReplyTo: '<form-1@example.com>' }),
    sent('2026-10-06T09:00:00Z', ['dad@example.com', ME, 'not an address'], { from: 'Will.Wright@Outlook.com' }),
    sent('2026-10-07T09:00:00Z', 'ghost@example.com', { date: 'not a date' }),
  ], { full: true }));
  const h = history.mergeSent(null, input, { accountEmail: 'WillW6311@Outlook.com', now: NOW });
  assert.deepStrictEqual(h, {
    cursor: input.cursor,
    syncedAt: '2026-11-03T08:00:00.000Z',
    // The account plus the alias it also sends from.
    me: [ME, 'will.wright@outlook.com'],
    people: {
      'sarah@example.com': { n: 3, last: '2026-10-20T09:00:00.000Z' }, // one email to her twice counts once
      'tom@example.com': { n: 1, last: '2026-10-01T09:00:00.000Z' },
      'dad@example.com': { n: 1, last: '2026-10-06T09:00:00.000Z' },
    },
    replies: {
      'c:AAQkQuote=': '2026-10-20T09:00:00.000Z', // the newest reply in the conversation
      'm:<form-1@example.com>': '2026-10-05T09:00:00.000Z',
    },
  });
  assert.strictEqual(history.wroteTo(h, 'SARAH@EXAMPLE.COM'), 3);
  assert.strictEqual(history.wroteTo(h, ' sarah@example.com '), 3);
  assert.strictEqual(history.wroteTo(h, 'stranger@example.com'), 0);
  assert.strictEqual(history.wroteTo(h, ME), 0, 'writing to yourself is not a person');
  assert.strictEqual(history.wroteTo(h, null), 0);
  assert.strictEqual(history.wroteTo(h, 'ghost@example.com'), 0, 'an entry with no date is skipped');
});

test('mergeSent: later syncs add to the counts; a full one starts again; aliases are never people', () => {
  let h = history.mergeSent(null, batch([sent('2026-10-01T09:00:00Z', ['sarah@example.com', 'will@work.example'])], { full: true }), { accountEmail: ME, now: NOW });
  assert.strictEqual(history.wroteTo(h, 'will@work.example'), 1);
  const before = frozen(structuredClone(h));
  h = history.mergeSent(before, batch([
    sent('2026-10-10T09:00:00Z', 'sarah@example.com'),
    // Sent from the work address: it's the user, so it stops counting as a person.
    sent('2026-10-11T09:00:00Z', 'jo@example.com', { from: 'will@work.example' }),
  ]), { accountEmail: ME, now: NOW + 1000 });
  assert.deepStrictEqual(h.people, {
    'sarah@example.com': { n: 2, last: '2026-10-10T09:00:00.000Z' },
    'jo@example.com': { n: 1, last: '2026-10-11T09:00:00.000Z' },
  });
  assert.deepStrictEqual(h.me, [ME, 'will@work.example']);
  assert.strictEqual(h.syncedAt, new Date(NOW + 1000).toISOString());

  // A full rebuild replaces everything.
  h = history.mergeSent(h, batch([sent('2026-10-12T09:00:00Z', 'priya@example.com')], { full: true }), { accountEmail: ME, now: NOW });
  assert.deepStrictEqual(Object.keys(h.people), ['priya@example.com']);
  assert.deepStrictEqual(h.me, [ME]);

  // A batch without a usable cursor keeps the old one.
  const kept = history.mergeSent(h, { cursor: null, full: false, entries: [] }, { accountEmail: ME, now: NOW });
  assert.deepStrictEqual(kept.cursor, h.cursor);
});

test('repliedAt: only a reply after the email arrived counts, by conversation or by In-Reply-To', () => {
  const h = history.mergeSent(null, batch([
    sent('2026-10-20T09:00:00Z', 'sarah@example.com', { conversationId: 'AAQkQuote=' }),
    sent('2026-10-05T09:00:00Z', 'customer@example.com', { inReplyTo: '<form-1@example.com>' }),
  ], { full: true }), { accountEmail: ME, now: NOW });

  // Outlook: the same conversation, written in after the email came.
  assert.strictEqual(history.repliedAt(h, { conversationId: 'AAQkQuote=', receivedAt: '2026-10-19T09:00:00Z' }), '2026-10-20T09:00:00.000Z');
  // Sarah's newer email in that conversation hasn't been answered yet.
  assert.strictEqual(history.repliedAt(h, { conversationId: 'AAQkQuote=', receivedAt: '2026-10-21T09:00:00Z' }), null);
  // IMAP: the reply's In-Reply-To is the email's Message-ID (brackets or not).
  assert.strictEqual(history.repliedAt(h, { messageId: '<form-1@example.com>', receivedAt: '2026-10-04T12:00:00Z' }), '2026-10-05T09:00:00.000Z');
  assert.strictEqual(history.repliedAt(h, { messageId: 'form-1@example.com', receivedAt: '2026-10-04T12:00:00Z' }), '2026-10-05T09:00:00.000Z');
  // No receivedAt: the sent date stands in. Neither: nothing can be said.
  assert.strictEqual(history.repliedAt(h, { messageId: '<form-1@example.com>', date: '2026-10-04T12:00:00Z' }), '2026-10-05T09:00:00.000Z');
  assert.strictEqual(history.repliedAt(h, { messageId: '<form-1@example.com>' }), null);
  assert.strictEqual(history.repliedAt(h, { conversationId: 'other', receivedAt: '2026-10-01T00:00:00Z' }), null);
  assert.strictEqual(history.repliedAt(h, null), null);
  assert.strictEqual(history.repliedAt(null, { conversationId: 'AAQkQuote=', receivedAt: '2026-10-19T09:00:00Z' }), null);
});

test('noteReply: a reply sent from ClearMail counts at once, without counting the person twice', () => {
  const base = frozen(history.mergeSent(null, batch([sent('2026-10-01T09:00:00Z', 'sarah@example.com')], { full: true }), { accountEmail: ME, now: NOW }));
  const email = { conversationId: 'AAQkNew=', messageId: '<new-1@example.com>', receivedAt: '2026-11-02T09:00:00Z' };
  assert.strictEqual(history.repliedAt(base, email), null);
  const h = history.noteReply(base, email, Date.parse('2026-11-03T07:59:00Z'));
  assert.strictEqual(history.repliedAt(h, email), '2026-11-03T07:59:00.000Z');
  assert.strictEqual(history.repliedAt(h, { messageId: '<new-1@example.com>', receivedAt: '2026-11-02T09:00:00Z' }), '2026-11-03T07:59:00.000Z');
  assert.deepStrictEqual(h.people, base.people, 'the next Sent sync counts Sarah');
  // Doing it again, or the sync then seeing the same reply, changes nothing.
  assert.deepStrictEqual(history.noteReply(h, email, Date.parse('2026-11-03T07:59:00Z')), h);
  const synced = history.mergeSent(h, batch([sent('2026-11-03T07:59:00Z', 'sarah@example.com', { conversationId: 'AAQkNew=' })]), { accountEmail: ME, now: NOW });
  assert.strictEqual(synced.replies['c:AAQkNew='], '2026-11-03T07:59:00.000Z');
  assert.deepStrictEqual(history.noteReply(base, null), base);
  assert.deepStrictEqual(history.noteReply(base, email, 'not a date'), base);
});

test('several accounts: me, wroteTo and repliedAt look across all of them', () => {
  const outlook = history.mergeSent(null, batch([sent('2026-10-01T09:00:00Z', 'sarah@example.com', { conversationId: 'c1' })], { full: true }), { accountEmail: ME, now: NOW });
  const gmail = history.mergeSent(null, batch([
    sent('2026-10-02T09:00:00Z', ['Sarah@example.com', 'priya@example.com'], { from: 'will.wright@gmail.com', inReplyTo: '<g41@mail.gmail.com>' }),
  ], { full: true, cursor: { kind: 'imap', path: '[Gmail]/Sent Mail', uidValidity: '7', lastUid: 3, fullAt: NOW } }), { accountEmail: 'will.wright@gmail.com', now: NOW });
  const file = { 'acc-outlook': outlook, 'acc-gmail': gmail }; // history.json's shape

  for (const histories of [file, [outlook, gmail]]) {
    assert.strictEqual(history.wroteTo(histories, 'sarah@EXAMPLE.com'), 2);
    assert.deepStrictEqual([...history.meSet(histories, ['Extra@Example.com'])].sort(), ['extra@example.com', 'will.wright@gmail.com', ME].sort());
    assert.strictEqual(history.repliedAt(histories, { messageId: '<g41@mail.gmail.com>', receivedAt: '2026-10-01T00:00:00Z' }), '2026-10-02T09:00:00.000Z');
    assert.strictEqual(history.historyKnown(histories), true);
  }
  assert.strictEqual(history.historyKnown({ 'acc-new': history.emptyHistory() }), false);
  assert.strictEqual(history.historyKnown(null), false);
  assert.deepStrictEqual(history.historyCounts(file), { people: 2, replies: 2 });

  // Everything triage asks, in one go.
  const ctx = history.historyContext(file, { accountEmails: [ME, 'will.wright@gmail.com'] });
  assert.ok(ctx.me.has('will.wright@gmail.com') && ctx.me.has(ME));
  assert.strictEqual(ctx.historyKnown, true);
  assert.strictEqual(ctx.wroteTo('SARAH@example.com'), 2);
  assert.strictEqual(ctx.wroteTo('nobody@example.com'), 0);
  assert.strictEqual(ctx.wroteTo(undefined), 0);
  assert.strictEqual(ctx.repliedAt({ conversationId: 'c1', receivedAt: '2026-09-30T00:00:00Z' }), '2026-10-01T09:00:00.000Z');
  const none = history.historyContext(undefined);
  assert.deepStrictEqual([none.me.size, none.historyKnown, none.wroteTo('a@b.c'), none.repliedAt({ conversationId: 'c1', receivedAt: '2020-01-01T00:00:00Z' })], [0, false, 0, null]);
});

test('caps: 5000 people and 5000 replies per account, keeping the most recent', () => {
  assert.deepStrictEqual(history.LIMITS, { people: 5000, replies: 5000, me: 50 });
  const entries = Array.from({ length: 5100 }, (_, i) => sent(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), `p${i}@example.com`, { conversationId: `c${i}` }));
  const h = history.mergeSent(null, batch(entries, { full: true }), { accountEmail: ME, now: NOW });
  assert.strictEqual(Object.keys(h.people).length, 5000);
  assert.strictEqual(Object.keys(h.replies).length, 5000);
  assert.strictEqual(history.wroteTo(h, 'p99@example.com'), 0, 'the oldest went');
  assert.strictEqual(history.wroteTo(h, 'p100@example.com'), 1);
  assert.strictEqual(history.wroteTo(h, 'p5099@example.com'), 1);
  assert.ok(!('c:c99' in h.replies) && 'c:c5099' in h.replies);

  // Read back from disk, the same caps apply.
  const big = { ...h, people: { ...h.people, 'extra@example.com': { n: 1, last: '2020-01-01T00:00:00Z' } } };
  assert.strictEqual(Object.keys(history.normalizeHistory(big).people).length, 5000);
  assert.strictEqual(history.wroteTo(history.normalizeHistory(big), 'extra@example.com'), 0);
});

test('a history survives being saved as JSON and read back', () => {
  const h = history.mergeSent(null, batch([
    sent('2026-10-01T09:00:00Z', 'sarah@example.com', { conversationId: 'AAQk/+=' }),
    sent('2026-10-02T09:00:00Z', 'jo@example.com', { inReplyTo: '<x@y>' }),
  ], { full: true }), { accountEmail: ME, now: NOW });
  assert.deepStrictEqual(history.normalizeHistory(JSON.parse(JSON.stringify(h))), h);
});
