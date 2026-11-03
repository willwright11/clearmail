// Offline short versions: tighten() and its meaning guards, the gist, and the summary shape.
process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const summarize = require('../src/summarize');
const { heuristicSummary, normalizeSummary, originalText, tighten, sameFacts, factTokens, MAX_GIST_WORDS } = summarize;
const { clean, splitSentences, countWords } = require('../src/cleaner');
const { findDeadlines } = require('../src/dates');
const demo = require('../src/demo');

const SHAPE = ['action_items', 'amounts', 'category', 'dates', 'gist', 'key_points', 'questions', 'urgency', 'words'];
const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h);

// Fixed emails (the demo inbox's dates move with today). Sent on Tuesday 13 October 2026:
// Wednesday is the 14th, Friday 16th October and Monday 2nd November are right.
const SARAH = {
  from: 'sarah.collins@brightbuild.co.uk',
  subject: 'RE: Site visit + quote for the Harrow extension',
  sent: at(2026, 10, 13),
  text: `Hi Will,

I hope you're well and thank you so much for getting back to me so promptly, it's really appreciated.

I've attached the revised quote, which comes to £14,750 including VAT. This is slightly higher than the initial estimate, mainly because of the additional steelwork that was identified.

In terms of next steps, we would need you to confirm you're happy to proceed by Friday 16th October so that we can hold the start date of Monday 2nd November. If we don't hear back by then, we may have to release the slot to another client.

Also, would you be able to make a site meeting on Wednesday at 10am to go over the access arrangements?

Kind regards,
Sarah`,
};
const PRIYA = {
  from: 'priya@shahaccounting.co.uk',
  subject: 'Quick one — VAT receipts',
  sent: at(2026, 11, 3),
  text: `Hi Will,

Quick one — I'm missing receipts for three purchases in August totalling £412.60. Could you dig them out and upload them to the shared folder by end of the week? The VAT return is due on 7 December so I need a few days to get it done.

Also, did you buy the van outright or is it on finance?

Cheers,
Priya`,
};
const DAD = {
  from: 'dad@example.com',
  subject: 'Sunday',
  sent: at(2026, 11, 2),
  text: 'Hello son\n\nMum says are you coming for lunch on Sunday? We\'re doing a roast at 1pm. Bring the kids if you can. Can you pick up some milk on the way?\n\nLove Dad',
};
const BANK = {
  from: 'alerts@kestrelbank.example',
  subject: 'Your credit card payment is due soon',
  sent: at(2026, 11, 3),
  text: `Hi Will,

Your Kestrel credit card statement is ready.

Statement balance: £312.48
Your minimum payment of £25.00 is due in 3 days.

To pay, open the Kestrel Bank app or sign in at kestrelbank.example.

Switch your mortgage to Kestrel today and get a £250 cashback voucher. Terms apply.

You're receiving this email because you have a Kestrel Bank credit card. Unsubscribe from marketing emails.`,
};

// The whole offline pipeline, as the app runs it.
function summary(email, { text = email.text, subject = email.subject, sent = email.sent } = {}) {
  const cleaned = clean({ text, subject, from: email.from });
  const deadlines = findDeadlines({ subject, body: cleaned.body, questions: cleaned.questions, actions: cleaned.actions }, sent);
  return heuristicSummary(cleaned, subject, text, { deadlines });
}

const PHRASE_TABLE = [
  ['In order to book the skip, call Sam.', 'To book the skip, call Sam.'],
  ['We were late due to the fact that the van broke down.', 'We were late because the van broke down.'],
  ['Owing to the fact that it rained, we stopped.', 'Because it rained, we stopped.'],
  ['In light of the fact that it rained, we stopped.', 'Because it rained, we stopped.'],
  ['Despite the fact that it rained, we finished.', 'Although it rained, we finished.'],
  ['At this point in time we have no slots.', 'Now we have no slots.'],
  ['At the present time the yard is shut.', 'Now the yard is shut.'],
  ['We will call you in the near future.', 'We will call you soon.'],
  ['Please pay prior to Friday.', 'Please pay before Friday.'],
  ['Subsequent to the meeting we agreed a price.', 'After the meeting we agreed a price.'],
  ['In the event that it rains, we stop.', 'If it rains, we stop.'],
  ['This is for the purpose of insurance.', 'This is for insurance.'],
  ['I am writing with regard to your invoice.', 'I am writing about your invoice.'],
  ['Sam called with regards to the roof.', 'Sam called about the roof.'],
  ['There is a query in relation to the invoice.', 'There is a query about the invoice.'],
  ['A number of tiles are cracked.', 'Several tiles are cracked.'],
  ['The majority of the work is done.', 'Most of the work is done.'],
  ['The majority of people agree.', 'Most people agree.'],
  ['We check the site on a weekly basis.', 'We check the site weekly.'],
  ['Please reply at your earliest convenience.', 'Please reply as soon as you can.'],
  ['Wait until such time as the plaster dries.', 'Wait until the plaster dries.'],
  ['Each and every room needs painting.', 'Every room needs painting.'],
  ['First and foremost, the roof must be fixed.', 'First, the roof must be fixed.'],
  ['Sam is able to start on Monday.', 'Sam can start on Monday.'],
  ['The crane has the ability to lift 5 tonnes.', 'The crane can lift 5 tonnes.'],
  ['We need to make a decision by Friday.', 'We need to decide by Friday.'],
  ['Please take into consideration the delays.', 'Please consider the delays.'],
  ['Please be advised that the office is closed on Friday.', 'The office is closed on Friday.'],
  ['Please note that the gate code is 4471.', 'The gate code is 4471.'],
  ['Kindly note that HMRC will write to you.', 'HMRC will write to you.'],
  ['We are pleased to inform you that your application was approved.', 'Your application was approved.'],
  ['We regret to inform you that your application was refused.', 'Your application was refused.'],
  ['It should be noted that the scaffold stays up.', 'The scaffold stays up.'],
  ['As previously mentioned, the fee is £462.', 'The fee is £462.'],
  ['The fee, as I mentioned, is £462.', 'The fee is £462.'],
  ['We would need you to confirm by Friday.', 'Please confirm by Friday.'],
  ['I need you to sign the form.', 'Please sign the form.'],
  ['We would like you to check the drawings.', 'Please check the drawings.'],
  ['Would you be able to make a site meeting on Wednesday at 10am?', 'Could you make a site meeting on Wednesday at 10am?'],
  ['Would it be possible for you to send the drawings?', 'Could you send the drawings?'],
  ['I was wondering if you could send the drawings?', 'Could you send the drawings?'],
  ['Are you able to come on Monday?', 'Can you come on Monday?'],
  ['Additionally, the skip is booked.', 'The skip is booked.'],
  ['Moreover, the van needs an MOT.', 'The van needs an MOT.'],
  ['Basically, the roof leaks.', 'The roof leaks.'],
  ['I really appreciate your help with the roof.', 'I appreciate your help with the roof.'],
  ['I just wanted to say the roof looks great.', 'I wanted to say the roof looks great.'],
  ['Just a quick note: the skip is booked.', 'A quick note: the skip is booked.'],
];

test('no AI: nothing is sent anywhere, and the old AI exports are gone', () => {
  for (const name of ['summarize', 'buildPrompt', 'MODEL']) assert.strictEqual(summarize[name], undefined, name);
  for (const file of ['src/summarize.js', 'src/dates.js', 'src/cleaner.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(src, /anthropic|\bfetch\(|https?\.request|XMLHttpRequest|WebSocket/i, file);
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(requires.every((r) => r === './cleaner'), `${file} only uses ./cleaner: ${requires}`);
  }
});

test('tighten: the phrase table', () => {
  for (const [input, expected] of PHRASE_TABLE) assert.strictEqual(tighten(input), expected, input);
});

test('tighten keeps "I think", "perhaps" and capitals, and handles several sentences and lines', () => {
  for (const s of ['I think perhaps we should wait.', 'I think the roof is fine, perhaps.']) assert.strictEqual(tighten(s), s);
  assert.strictEqual(tighten('Perhaps in order to save time we could start Monday.'), 'Perhaps to save time we could start Monday.');
  assert.strictEqual(tighten('Call Sam in order to book.'), 'Call Sam to book.');
  assert.strictEqual(tighten('in order to book, call Sam'), 'to book, call Sam'); // no capital to keep
  assert.strictEqual(tighten('Furthermore, Sarah will bring the keys.'), 'Sarah will bring the keys.');
  assert.strictEqual(tighten('Please note that Sarah is away until Monday.'), 'Sarah is away until Monday.');
  assert.strictEqual(tighten('Please note that payment is due on 7 December.'), 'Payment is due on 7 December.');
  assert.strictEqual(tighten('As I mentioned, I need you to sign by Friday.'), 'Please sign by Friday.');
  assert.strictEqual(
    tighten('Please note that the gate is locked. In order to get in, call Sam.\nWe would need you to sign the form.'),
    'The gate is locked. To get in, call Sam.\nPlease sign the form.',
  );
  for (const [input, expected] of [[null, ''], [undefined, ''], [42, '42'], ['', ''], ['   ', '   '], ['OK', 'OK']]) {
    assert.strictEqual(tighten(input), expected, String(input));
  }
});

test('tighten: a negation in the 3 words before a phrase blocks it', () => {
  for (const s of [
    'This is not in order to save money.',
    'It is not due to the fact that we are busy.',
    'Do not make a decision until Monday.',
    "We can't, at this point in time, confirm.",
    'There is never a number of them.',
    'Not the majority of people agree.',
    'Without prior to booking.',
  ]) {
    assert.strictEqual(tighten(s), s, s);
  }
  // Further back than 3 words, it doesn't block.
  assert.strictEqual(tighten('We did not hear back, so in order to be safe we stopped.'), 'We did not hear back, so to be safe we stopped.');
});

test('tighten: quoted text, title case, and fewer than 3 words are left alone', () => {
  assert.strictEqual(tighten('He said "in order to win" and left.'), 'He said "in order to win" and left.');
  assert.strictEqual(tighten('He said “in order to win” and left.'), 'He said “in order to win” and left.');
  // A title is a name: rewriting it would lose capitalised words.
  assert.strictEqual(tighten('Read our guide In Order To Save Money.'), 'Read our guide In Order To Save Money.');
  assert.strictEqual(tighten('In Order To Save Money, read our guide.'), 'In Order To Save Money, read our guide.');
  // "It's fine." is only 2 words, so the original stays; 3 words are enough.
  assert.strictEqual(tighten("Please note that it's fine."), "Please note that it's fine.");
  assert.strictEqual(tighten('Please note that it is fine.'), 'It is fine.');
  assert.strictEqual(tighten('We need you to.'), 'We need you to.');
});

test('sameFacts and factTokens: what counts as a fact', () => {
  const t = factTokens('Please pay Sarah £25 by Friday 6 November, not later, to jo@example.com via [pay.example.com] or "the usual way".');
  for (const f of ['m:£25', 'n:£25', 'n:6', 'd:friday 6 november', 'x:not', 'e:jo@example.com', 'l:[pay.example.com]', 'q:"the usual way"']) {
    assert.ok(t.facts.includes(f), f);
  }
  assert.deepStrictEqual(t.names, ['Friday', 'November', 'Sarah']);
  assert.strictEqual(t.first, 'Please');
  assert.deepStrictEqual(factTokens("I don't think I'm free").facts, ["x:n't"]);
  assert.deepStrictEqual(factTokens("I don't think I'm free").names, []);

  const changed = [
    ['Pay £25 by Friday.', 'Pay £52 by Friday.'],
    ['Pay £25 by Friday.', 'Pay £25 by Monday.'],
    ['Do not pay the bill.', 'Do pay the bill.'],
    ["We can't come.", 'We can come.'],
    ['Call Sarah today.', 'Call Sam today.'],
    ['Email jo@example.com now.', 'Email them now.'],
    ['He said "yes" today.', 'He said "no" today.'],
    ['See [gov.uk] now.', 'See it now.'],
    ['Pay 20% now.', 'Pay 25% now.'],
    ['Meet at 10am.', 'Meet at 11am.'],
  ];
  for (const [a, b] of changed) assert.strictEqual(sameFacts(a, b), false, `${a} / ${b}`);
  const same = [
    ['Furthermore, Sarah will come.', 'Sarah will come.'],
    ['I need you to sign.', 'Please sign.'],
    ['Please pay prior to Friday.', 'Please pay before Friday.'],
    ['Please note that payment is due.', 'Payment is due.'],
  ];
  for (const [a, b] of same) assert.strictEqual(sameFacts(a, b), true, `${a} / ${b}`);
});

// An independent check of what tighten must keep: numbers, money, %, day and month words,
// quoted text, [links], email addresses, negations, and every name after the first word.
function assertKeeps(before, after) {
  const pick = (s) => [
    ...(s.match(/\d[\d,.:/%-]*\d|\d%?/g) || []),
    ...(s.match(/[£$€%]/g) || []),
    ...(s.toLowerCase().match(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:january|february|march|april|june|july|august|september|october|november|december|today|tonight|tomorrow)\b/g) || []),
    ...(s.match(/"[^"]*"|“[^”]*”|\[[^\]]*\]|\S+@\S+/g) || []),
    ...(s.toLowerCase().match(/\b(?:not|no|never|without|unless|except|cannot)\b|n['’]t\b/g) || []),
  ].sort();
  assert.deepStrictEqual(pick(after), pick(before), `${before} → ${after}`);
  const word = (w) => w.replace(/[^\p{L}'’-]/gu, '');
  const names = before.split(/\s+/).slice(1).map(word).filter((w) => /^\p{Lu}/u.test(w) && !/^I(?:['’]\w+)?$/.test(w));
  const all = after.split(/\s+/).map(word);
  for (const n of names) assert.ok(all.includes(n), `${before} → ${after}: keeps ${n}`);
}

test('tighten never changes a fact, and running it twice changes nothing (every demo sentence and more)', () => {
  const sentences = new Set([
    ...PHRASE_TABLE.map(([s]) => s),
    'Please note that the £250 deposit is not refundable unless you cancel by 1 December.',
    'We regret to inform you that your application 26/1234 has been refused.',
    'In order to avoid a penalty of £100, you must pay by 31 January 2027.',
    'The majority of the 12 flats will be ready prior to Christmas.',
    'Would it be possible to move the meeting to Thursday 5 November at 2pm?',
    "Due to the fact that it's raining, we can't pour the concrete today.",
    'Please contact jo@example.com in relation to the invoice.',
    'At this point in time we have no slots, except on Saturday.',
    "Basically, it's 30% off for a limited time.",
    'I was wondering if you could send the "final" drawings by Friday?',
    'Furthermore, Dr Patel says the scaffold must stay until 20/11.',
    "Additionally, there's no need to pay the £40 fee.",
    'Kindly note that the office will be closed in the near future.',
    'NB: in order to comply, HMRC is able to fine you £100 per day.',
    'Read the guide at [gov.uk] in order to file on a monthly basis.',
  ]);
  for (const e of [SARAH, PRIYA, DAD, BANK, ...demo]) {
    const c = clean({ text: e.text, html: e.html, subject: e.subject, from: typeof e.from === 'string' ? e.from : e.from.address });
    for (const s of [e.subject, ...splitSentences(e.text || ''), ...splitSentences(c.body), ...c.keyPoints, ...c.actions, ...c.questions]) {
      if (s && s.trim()) sentences.add(s);
    }
  }
  let changed = 0;
  for (const s of sentences) {
    const t = tighten(s);
    assert.strictEqual(tighten(t), t, `idempotent: ${s}`);
    assertKeeps(s, t);
    assert.ok(sameFacts(s, t), s);
    assert.ok(t.length <= s.length, s); // plainer, never longer ("as soon as you can" has more words but fewer letters)
    if (t !== s) {
      changed++;
      assert.ok(countWords(t) >= 3, s);
    }
  }
  assert.ok(sentences.size > 150, `checked ${sentences.size} sentences`);
  assert.ok(changed >= PHRASE_TABLE.length, `${changed} were tightened`);
});

test('the gist: person mail leads with the first ask, tightened', () => {
  const s = summary(SARAH);
  assert.strictEqual(s.gist, "Please confirm you're happy to proceed by Friday 16th October so that we can hold the start date of Monday 2nd November.");
  assert.deepStrictEqual(s.action_items, [], 'the ask in the gist is not repeated');
  assert.deepStrictEqual(s.questions, ['Could you make a site meeting on Wednesday at 10am to go over the access arrangements?']);
  assert.ok(s.key_points.some((k) => /£14,750/.test(k)));
  assert.ok(!s.key_points.some((k) => /proceed/.test(k)), 'a key point inside an ask is dropped');
  assert.deepStrictEqual(s.amounts, ['£14,750']);
  // A direct request beats an earlier sentence that only mentions "due".
  const p = summary(PRIYA);
  assert.strictEqual(p.gist, 'Could you dig them out and upload them to the shared folder by end of the week?');
  assert.deepStrictEqual(p.action_items, [{ task: 'The VAT return is due on 7 December so I need a few days to get it done.', due: '7 December' }]);
  assert.deepStrictEqual(p.questions, ['Did you buy the van outright or is it on finance?']);
  assert.strictEqual(summary(DAD).gist, 'Mum says are you coming for lunch on Sunday?');
});

test('the gist: other mail leads with its most informative fact, never the marketing', () => {
  assert.strictEqual(summary(BANK).gist, 'Your minimum payment of £25.00 is due in 3 days.');
  const otp = { from: 'noreply@kestrelbank.example', subject: 'Your code', sent: at(2026, 11, 3), text: 'Your verification code is 482913. It expires in 10 minutes.\n\nKestrel Bank will never call you to ask for this code.' };
  assert.strictEqual(summary(otp).gist, 'Your verification code is 482913.');
  const hmrc = { from: 'noreply@notifications.service.gov.uk', subject: 'Action required', sent: at(2026, 11, 1), text: 'Dear Customer,\n\nThis is a reminder that your online Self Assessment tax return must be submitted by 31 January 2027.\n\nIf you miss the deadline you may have to pay a penalty of £100.' };
  assert.strictEqual(summary(hmrc).gist, 'Your online Self Assessment tax return must be submitted by 31 January 2027.');
  // Nothing in the body: the subject.
  assert.strictEqual(heuristicSummary(clean({ text: '', subject: 'Photos' }), 'Photos', '').gist, 'Photos');
  assert.strictEqual(heuristicSummary({}, '', '').gist, '(no text)');
});

test('the gist is at most 25 words, cut at a clause boundary', () => {
  const long = 'Could you please send over the signed contract, the updated drawings for the rear extension and the building control certificate for the loft, because the bank needs them before they release the £20,000 payment on Friday?';
  let s = summary({ from: 'sam@x.co.uk', subject: 'Docs', sent: at(2026, 11, 3), text: long });
  assert.strictEqual(s.gist, 'Could you please send over the signed contract, the updated drawings for the rear extension and the building control certificate for the loft…');
  assert.ok(countWords(s.gist) <= MAX_GIST_WORDS);
  // The cut lost "£20,000" and "Friday", so the whole question is still there.
  assert.deepStrictEqual(s.questions, [long]);
  // No clause boundary: the first 25 words.
  const list = 'Please bring the long ladder the spare tiles the blue tarpaulin the big drill the small drill the sealant the screws the nails the bolts the washers the hinges and the handles to site';
  s = summary({ from: 'sam@x.co.uk', subject: 'Kit', sent: at(2026, 11, 3), text: list });
  assert.strictEqual(s.gist, `${list.split(' ').slice(0, 25).join(' ')}…`);
  // A key point the cut gist covers, facts and all, isn't repeated; one whose facts were cut is kept.
  const base = { body: 'x', actions: [], questions: [], category: 'newsletter', urgency: 'low' };
  const covered = 'Timber prices fell 4% in October, the third monthly drop in a row, and builders across the country say they expect the fall to continue well into the new year as demand slows.';
  s = heuristicSummary({ ...base, keyPoints: [covered] }, 'News');
  assert.strictEqual(s.gist, 'Timber prices fell 4% in October, the third monthly drop in a row…');
  assert.deepStrictEqual(s.key_points, []);
  const lost = 'Timber prices fell 4% in October, the third monthly drop in a row, and builders across the country say they expect the fall to continue until March 2027 as demand slows down.';
  s = heuristicSummary({ ...base, keyPoints: [lost] }, 'News');
  assert.ok(s.gist.endsWith('…'));
  assert.deepStrictEqual(s.key_points, [lost]);
});

test('dedupe: an ask equal to the gist is not repeated, and key points inside asks are dropped', () => {
  const cleaned = {
    body: 'Please pay invoice 4471 by Friday. The skip is booked. Can you call me?',
    keyPoints: ['Please pay invoice 4471 by Friday.', 'The skip is booked.'],
    actions: ['Please pay invoice 4471 by Friday.'],
    questions: ['Can you call me?'],
    category: 'person',
    urgency: 'normal',
  };
  const s = heuristicSummary(cleaned, 'Invoice', cleaned.body);
  assert.strictEqual(s.gist, 'Please pay invoice 4471 by Friday.');
  assert.deepStrictEqual(s.action_items, []);
  assert.deepStrictEqual(s.questions, ['Can you call me?']);
  assert.deepStrictEqual(s.key_points, ['The skip is booked.']);
});

test('dates come from the deadlines: what it is for, the date as written, and the day', () => {
  const s = summary(SARAH);
  assert.deepStrictEqual(s.dates, [
    { what: "Please confirm you're happy to proceed", when: 'Friday 16th October', day: '2026-10-16' },
    { what: 'We can hold the start date', when: 'Monday 2nd November', day: '2026-11-02' },
    { what: 'Could you make a site meeting', when: 'Wednesday at 10am', day: '2026-10-14' },
  ]);
  const p = summary(PRIYA);
  assert.deepStrictEqual(p.dates, [
    { what: 'Upload them to the shared folder', when: 'end of the week', day: '2026-11-06' },
    { what: 'The VAT return is due', when: '7 December', day: '2026-12-07' },
  ]);
  assert.deepStrictEqual(summary(BANK).dates, [{ what: 'Your minimum payment of £25.00 is due', when: 'in 3 days', day: '2026-11-06' }]);
  // Without deadlines (an older caller), the cleaner's dates are listed as written.
  const cleaned = { body: 'x', keyPoints: ['x'], actions: [], questions: [], dates: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], category: 'person' };
  const old = heuristicSummary(cleaned, 's');
  assert.strictEqual(old.dates.length, 6);
  assert.deepStrictEqual(old.dates[0], { what: '', when: 'Mon', day: null });
  // Deadlines with no date text or a bad day don't break anything.
  const odd = heuristicSummary(cleaned, 's', '', { deadlines: [null, { text: 'Friday', sentence: 'By Friday please.', day: 'nope' }, { text: '', day: '2026-11-06' }] });
  assert.deepStrictEqual(odd.dates, [{ what: '', when: 'Friday', day: null }]);
});

test('word counts: "Short version: 38 of 205 words"', () => {
  const s = summary(SARAH);
  assert.strictEqual(s.words.original, countWords(SARAH.text));
  const shown = [s.gist, ...s.key_points, ...s.action_items.map((a) => a.task), ...s.questions].join(' ');
  assert.strictEqual(s.words.short, countWords(shown));
  assert.ok(s.words.short < s.words.original);
  for (const e of [PRIYA, DAD, BANK]) {
    const w = summary(e).words;
    assert.ok(w.short > 0 && w.short <= w.original, `${e.subject}: ${w.short} of ${w.original}`);
  }
  // Nothing in the email: 0 of 0, not "1 of 0".
  assert.deepStrictEqual(heuristicSummary(clean({ text: '', subject: 'Photos' }), 'Photos', '').words, { original: 0, short: 0 });
});

test('normalizeSummary coerces junk into the v2 shape', () => {
  const s = normalizeSummary({
    source: 'ai', error: 'x', reply_suggestions: ['a'], gist: 42, category: 'spam', urgency: 'URGENT', key_points: 'x',
    action_items: ['Do it', { task: '' }, { task: 'Pay', due: null }], dates: [{ what: 'Friday' }, {}, { what: 'Pay', when: 'Fri', day: '2026-11-06' }, { when: 'Sat', day: '6 Nov' }],
    questions: [null, 'Q?'], amounts: ['£5', 7, null], words: { original: '12', short: -3 },
  }, { gist: 'fallback', category: 'receipt', urgency: 'low' });
  assert.deepStrictEqual(Object.keys(s).sort(), SHAPE);
  assert.strictEqual(s.gist, '42');
  assert.strictEqual(s.category, 'receipt');
  assert.strictEqual(s.urgency, 'low');
  assert.deepStrictEqual(s.key_points, []);
  assert.deepStrictEqual(s.action_items, [{ task: 'Do it', due: '' }, { task: 'Pay', due: '' }]);
  assert.deepStrictEqual(s.dates, [{ what: '', when: 'Friday', day: null }, { what: 'Pay', when: 'Fri', day: '2026-11-06' }, { what: '', when: 'Sat', day: null }]);
  assert.deepStrictEqual(s.questions, ['Q?']);
  assert.deepStrictEqual(s.amounts, ['£5', '7']);
  assert.deepStrictEqual(s.words, { original: 0, short: 0 });
  assert.deepStrictEqual(normalizeSummary({ words: { original: 205, short: 38 } }).words, { original: 205, short: 38 });
  assert.strictEqual(normalizeSummary(null).gist, '(no text)');
  const long = normalizeSummary({ gist: 'word '.repeat(40) }).gist;
  assert.strictEqual(countWords(long), MAX_GIST_WORDS);
  assert.ok(long.endsWith('…'));
});

test('originalText: the text part, else the HTML converted to text', () => {
  assert.strictEqual(originalText({ text: 'Hello', html: '<p>Other</p>' }), 'Hello');
  assert.match(originalText({ text: '', html: '<p>Your seat is <b>14C</b></p>' }), /14C/);
  for (const e of [null, undefined, {}, { text: '   ' }]) assert.strictEqual(originalText(e), '');
});

test('the summary shows the start of the email when the cleaner kept nothing', () => {
  const cleaned = { body: '', keyPoints: [], actions: [], dates: [], questions: [], category: 'person', urgency: 'normal' };
  const s = heuristicSummary(cleaned, 'Hello', 'Meeting moved to 3pm Thursday, bring your passport.');
  assert.match(s.key_points.join(' '), /bring your passport/);
  assert.strictEqual(s.gist, 'Hello');
});

test('every email in the demo inbox gets a v2 summary with a short gist', () => {
  for (const m of demo) {
    const text = originalText(m);
    const cleaned = clean({ text: m.text, html: m.html, subject: m.subject, from: m.from.address });
    const deadlines = findDeadlines({ subject: m.subject, body: cleaned.body, questions: cleaned.questions, actions: cleaned.actions }, m.date);
    const s = heuristicSummary(cleaned, m.subject, text, { deadlines });
    assert.deepStrictEqual(Object.keys(s).sort(), SHAPE, m.id);
    assert.ok(s.gist && countWords(s.gist) <= MAX_GIST_WORDS, `${m.id}: ${s.gist}`);
    assert.ok(s.words.original > 0 && s.words.short > 0 && s.words.short <= s.words.original, `${m.id}: ${JSON.stringify(s.words)}`);
    assert.ok(!s.key_points.includes(s.gist), m.id);
    assert.strictEqual(s.dates.length, new Set(s.dates.map((d) => `${d.day}|${d.when}`)).size, m.id);
    for (const d of s.dates) assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/, m.id);
    assert.deepStrictEqual(s, normalizeSummary(s), `${m.id} is already normalised`);
  }
});

test('long or hostile text stays quick', () => {
  const start = Date.now();
  tighten('in order to go, '.repeat(5000));
  tighten('Please note that in order to go we would need you to pay. '.repeat(3000));
  const body = Array.from({ length: 40 }, (_, i) => `Could you in order to help send item ${i} prior to Friday ${'x'.repeat(150)}?`).join(' ');
  heuristicSummary(clean({ text: body, subject: 's', from: 'a@b.com' }), 's', body);
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
});
