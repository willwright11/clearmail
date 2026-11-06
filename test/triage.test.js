process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert');
const {
  triage, triageAll, senderStats, sortBucket, REASON_TEXT, isValidRuleKey, BUCKETS, CAUTION_TEXT, deadlineLabel,
} = require('../src/triage');
const fx = require('./fixtures/triage-fixtures');

const { email, deadline, ctx, NOW, DAY, HOUR } = fx;
const one = (m, c = ctx()) => triage(m, c);
const expect = (result, bucket, codes) => {
  assert.strictEqual(result.bucket, bucket, `bucket (reasons: ${result.reasons.join(' | ')})`);
  if (codes) assert.deepStrictEqual(result.codes.slice(0, codes.length), codes);
};
const at = (y, m, d, h = 9) => Date.UTC(y, m - 1, d, h); // London is on GMT in all of these

// ---------- the fixture table ----------

test("Sarah's quote: needs you, with the action, the deadline and that you know her", () => {
  const r = one(fx.sarah());
  expect(r, 'needs-you', ['asks-action', 'deadline-soon', 'known-contact']);
  assert.deepStrictEqual(r.reasons, ['Asks you to do something', 'Due Fri 6 Nov', "You've written to them 6 times"]);
  assert.deepStrictEqual(r.deadline, { text: 'Friday 6th November', day: '2026-11-06', time: null, label: 'Fri 6 Nov', daysAway: 3, uncertain: false });
  assert.strictEqual(r.caution, null);
});

test("Dad's question: needs you", () => {
  expect(one(fx.dad()), 'needs-you', ['asks-question', 'known-contact']);
  expect(one(fx.dad(), ctx({ wrote: {} })), 'needs-you', ['asks-question', 'first-contact']);
});

test('HMRC with List-Unsubscribe: worth knowing 89 days out, needs you near and just after the date, never noise', () => {
  const r = one(fx.hmrc());
  expect(r, 'worth-knowing', ['deadline-later']);
  assert.strictEqual(r.deadline.daysAway, 89);
  assert.strictEqual(r.reasons[0], 'Deadline Sun 31 Jan 2027');
  expect(one(fx.hmrc(), ctx({ now: at(2027, 1, 20) })), 'needs-you', ['deadline-soon']);
  assert.strictEqual(one(fx.hmrc(), ctx({ now: at(2027, 1, 20) })).reasons[0], 'Due Sun 31 Jan');
  const late = one(fx.hmrc(), ctx({ now: at(2027, 2, 10) }));
  expect(late, 'needs-you', ['overdue']);
  assert.strictEqual(late.reasons[0], 'Was due Sun 31 Jan');
  const long = one(fx.hmrc(), ctx({ now: at(2027, 3, 1) }));
  expect(long, 'worth-knowing', ['deadline-past']);
  assert.strictEqual(long.deadline, null, 'no deadline chip once it is long gone');
  // Every day from now until a year after the date: never noise.
  for (let t = NOW; t < at(2028, 2, 1); t += DAY) assert.notStrictEqual(one(fx.hmrc(), ctx({ now: t })).bucket, 'noise');
});

test('HMRC: if the date was not recognised, the obligation wording still keeps it out of noise', () => {
  expect(one(fx.hmrc({ deadlines: [] })), 'worth-knowing', ['obligation']);
});

test('Screwfix receipt with List-Unsubscribe: worth knowing', () => {
  expect(one(fx.screwfix()), 'worth-knowing', ['receipt']);
});

test('"Today only" promo: noise, and its marketing deadline is ignored', () => {
  const r = one(fx.promo());
  expect(r, 'noise', ['promo']);
  assert.strictEqual(r.deadline, null);
  assert.strictEqual(r.reasons[0], 'Promotion');
});

test("Ignored newsletter: noise, saying how many weren't opened; usually read: worth knowing", () => {
  const issues = fx.weeklyBuilderIssues(0);
  const results = triageAll(issues, ctx());
  const current = results.get(issues[0].id);
  expect(current, 'noise', ['newsletter']);
  assert.strictEqual(current.reasons[0], "Newsletter you haven't opened in 4 emails");
  const read = fx.weeklyBuilderIssues(3);
  expect(triageAll(read, ctx()).get(read[0].id), 'worth-knowing', ['usually-read']);
  assert.strictEqual(triageAll(read, ctx()).get(read[0].id).reasons[0], 'A newsletter you usually open');
});

test("CC'd FYI: worth knowing, and doesn't claim the question is for you", () => {
  const r = one(fx.ccFyi());
  expect(r, 'worth-knowing', ['cc-only']);
  assert.strictEqual(r.reasons[0], "You're only CC'd");
  assert.ok(!r.codes.includes('asks-question'));
});

test('Bank "£25 due in 3 days" with List-Unsubscribe and a marketing footer: needs you', () => {
  const r = one(fx.bank());
  expect(r, 'needs-you', ['payment-due']);
  assert.strictEqual(r.reasons[0], 'Payment due Fri 6 Nov');
  assert.strictEqual(r.deadline.day, '2026-11-06', 'the "Offer ends 30 November" date is marketing and ignored');
  assert.strictEqual(r.caution, CAUTION_TEXT);
  // Without a date it is still a payment due.
  expect(one({ ...fx.bank(), deadlines: [] }), 'needs-you', ['payment-due']);
  assert.strictEqual(one({ ...fx.bank(), deadlines: [] }).reasons[0], 'Payment due');
});

test('Payment due needs a due cue: "due to high demand" is not a bill', () => {
  const shop = (body) => email({ from: { name: 'Shop', address: 'orders@shop.example' }, category: 'notification', body });
  expect(one(shop('Due to high demand, delivery now costs £5.')), 'worth-knowing', ['automated']);
  expect(one(shop('The amount due to us is £40.')), 'needs-you', ['payment-due']);
  expect(one(shop('Your direct debit of £45.00 will be taken on the 1st.')), 'needs-you', ['payment-due']);
  // In marketing sentences of bulk mail, money and "due" don't count.
  expect(one(email({ from: { name: 'Shop', address: 'offers@shop.example' }, category: 'promo', listUnsubscribe: true, body: 'Last chance: £10 voucher due to expire!' })), 'noise', ['promo']);
});

test('A stranger asking a question: needs you, first contact; asking for bank details adds the caution', () => {
  const r = one(fx.stranger());
  expect(r, 'needs-you', ['asks-question', 'first-contact']);
  assert.strictEqual(r.caution, null);
  const bank = one(fx.strangerBankDetails());
  expect(bank, 'needs-you', ['asks-question']);
  assert.strictEqual(bank.caution, CAUTION_TEXT);
  assert.match(bank.caution, /Check it's genuine/);
  // Someone the user has written to gets no warning.
  assert.strictEqual(one(fx.strangerBankDetails(), ctx({ wrote: { 'amy.turner@example.net': 1 } })).caution, null);
  // Without Sent history, "first contact" isn't claimed.
  assert.ok(!one(fx.stranger(), ctx({ historyKnown: false, wrote: {} })).codes.includes('first-contact'));
});

test("The same stranger's email to 20 people: worth knowing; with a coursework deadline on Friday: needs you", () => {
  const r = one(fx.strangerGroup());
  expect(r, 'worth-knowing', ['group']);
  assert.strictEqual(r.reasons[0], 'Sent to 20 people');
  expect(one(fx.strangerGroupCoursework()), 'needs-you', ['asks-action', 'deadline-soon']);
});

test('demo-1, which the user replied to afterwards: worth knowing', () => {
  const m = fx.demo1();
  expect(one(m, ctx({ replied: { [m.id]: fx.DEMO1_REPLIED } })), 'worth-knowing', ['replied']);
  assert.strictEqual(one(m, ctx({ replied: { [m.id]: fx.DEMO1_REPLIED } })).reasons[0], "You've already replied");
  // A reply from before the email arrived doesn't count.
  expect(one(m, ctx({ replied: { [m.id]: new Date(NOW - 40 * HOUR).toISOString() } })), 'needs-you');
});

test('A 2-day-old sign-in code: noise; a fresh sign-in alert: worth knowing', () => {
  expect(one(fx.oldCode()), 'noise', ['old-code']);
  expect(one(fx.freshSignIn()), 'worth-knowing', ['security']);
  // The same code an hour after it arrived is not noise.
  expect(one({ ...fx.oldCode(), receivedAt: new Date(NOW - HOUR).toISOString() }), 'worth-knowing');
});

test('Automated mail Outlook filed under Other: noise; the same over IMAP: worth knowing', () => {
  expect(one(fx.automated()), 'noise', ['outlook-other']);
  expect(one(fx.automated({ focused: null })), 'worth-knowing', ['automated']);
});

test("A person's email Outlook filed under Other: worth knowing (people are never auto-noise)", () => {
  const r = one(fx.personOther());
  expect(r, 'worth-knowing', ['fyi']);
  assert.ok(r.codes.includes('outlook-other'));
});

test('A flagged newsletter: needs you', () => {
  const r = one(fx.flaggedNewsletter());
  expect(r, 'needs-you', ['flagged']);
  assert.strictEqual(r.reasons[0], 'Flagged in Outlook');
  assert.strictEqual(one({ ...fx.flaggedNewsletter(), focused: null }).reasons[0], 'You flagged it');
});

test('An email from an Always-noise sender that was marked Not noise: not noise', () => {
  const m = fx.weeklyBuilder(30);
  const rules = { 'newsletter@weeklybuilder.com': 'noise' };
  expect(one(m, ctx({ rules })), 'noise', ['rule-noise']);
  const r = one(m, ctx({ rules, notNoise: [m.id] }));
  expect(r, 'worth-knowing', ['not-noise']);
  // Not noise also beats the newsletter, promo, Other, ignored and old-code rules.
  for (const f of [fx.promo, fx.oldCode, fx.automated, () => fx.weeklyBuilder(30)]) {
    const e = f();
    assert.strictEqual(one(e, ctx({ notNoise: [e.id] })).bucket, 'worth-knowing');
  }
});

// ---------- the other rules ----------

test('Sender rules: important beats everything but a flag; address rules beat domain rules', () => {
  const m = fx.promo();
  const r = one(m, ctx({ rules: { 'offers@tradehub.example': 'important' } }));
  expect(r, 'needs-you', ['rule-important']);
  assert.strictEqual(r.reasons[0], 'You marked TradeHub Supplies as always important');
  const domain = one(m, ctx({ rules: { '@tradehub.example': 'important' } }));
  assert.strictEqual(domain.reasons[0], 'You marked everyone at tradehub.example as always important');
  expect(one(m, ctx({ rules: { '@tradehub.example': 'important', 'offers@tradehub.example': 'noise' } })), 'noise', ['rule-noise']);
  expect(one(fx.sarah(), ctx({ rules: { 'sarah.collins@brightbuild.co.uk': 'noise' } })), 'noise', ['rule-noise']);
  expect(one({ ...fx.sarah(), flagged: true }, ctx({ rules: { 'sarah.collins@brightbuild.co.uk': 'noise' } })), 'needs-you', ['flagged']);
  const long = { ...m, from: { name: `Offers\n${'x'.repeat(200)}`, address: 'offers@tradehub.example' } };
  assert.strictEqual(one(long, ctx({ rules: { 'offers@tradehub.example': 'important' } })).reasons[0], `You marked Offers ${'x'.repeat(52)}… as always important`);
  // Junk values in the rules are ignored, and so are inherited keys.
  expect(one(fx.stranger(), ctx({ rules: { 'amy.turner@example.net': 'delete', ['__proto__']: 'noise' } })), 'needs-you');
});

test('Sent from your own address: worth knowing', () => {
  expect(one(email({ from: { name: 'Will', address: 'WILL@example.com' }, questions: ['Note to self?'] })), 'worth-knowing', ['from-me']);
});

test('A person with only a deadline soon, or saying it is urgent, needs you; an old ask is worth knowing', () => {
  const due = email({ body: 'The skip arrives tomorrow, pay the driver by then.', deadlines: [deadline(1, { cue: 'by', text: 'tomorrow' })] });
  expect(one(due), 'needs-you', ['deadline-soon']);
  assert.strictEqual(one(due).reasons[0], 'Due tomorrow');
  const overdue = email({ deadlines: [deadline(-2, { cue: 'by' })] });
  expect(one(overdue), 'needs-you', ['overdue']);
  assert.strictEqual(one(overdue).reasons[0], 'Was due Sun 1 Nov');
  // A person's date with no cue word and not in an ask isn't a deadline.
  expect(one(email({ deadlines: [deadline(1, { cue: null })] })), 'worth-knowing', ['fyi']);
  expect(one(email({ urgency: 'high', body: 'Urgent: the gas is leaking.' })), 'needs-you', ['urgent']);
  const old = email({ hoursAgo: 24 * 22, questions: ['Can you send the invoice?'] });
  expect(one(old), 'worth-knowing', ['old-ask']);
  assert.strictEqual(one(old).reasons[0], 'From 3 weeks ago');
});

test('A deadline far off moves up as it nears', () => {
  const m = (days) => email({
    from: { name: 'Council', address: 'noreply@council.example' },
    category: 'notification',
    deadlines: [deadline(days, { sentence: 'Your renewal must be submitted by then.' })],
  });
  expect(one(m(30)), 'worth-knowing', ['deadline-later']);
  expect(one(m(14)), 'needs-you', ['deadline-soon']);
  expect(one(m(0)), 'needs-you', ['deadline-soon']);
  assert.strictEqual(one(m(0)).reasons[0], 'Due today');
  // A date in automated mail without obligation wording isn't a deadline.
  const plain = email({ from: { name: 'Council', address: 'noreply@council.example' }, category: 'notification', deadlines: [deadline(2, { sentence: 'The library reopens on Friday.' })] });
  expect(one(plain), 'worth-knowing', ['automated']);
});

test('Known contacts are never noise, even sending bulk mail', () => {
  const m = { ...fx.weeklyBuilder(30), from: { name: 'Jo', address: 'jo.patel@example.com' } };
  expect(one(m), 'worth-knowing', ['known-contact']);
  assert.strictEqual(one(m, ctx({ wrote: { 'jo.patel@example.com': 1 } })).reasons[0], "You've written to them once");
});

test('An automated sender you keep ignoring is noise; supporting reasons say so', () => {
  const list = [1, 2, 3, 4].map((d) => fx.automated({ focused: null, hoursAgo: d * 24 + 5 }));
  const results = triageAll(list, ctx());
  expect(results.get(list[0].id), 'noise', ['ignored']);
  assert.strictEqual(results.get(list[0].id).reasons[0], "You haven't opened their last 4 emails");
});

test('Week and month deadlines read naturally', () => {
  assert.strictEqual(deadlineLabel({ day: '2026-11-09', precision: 'week' }, '2026-11-03'), 'the week of Mon 9 Nov');
  assert.strictEqual(deadlineLabel({ day: '2026-12-01', precision: 'month' }, '2026-11-03'), 'in December');
  assert.strictEqual(deadlineLabel({ day: '2027-03-31', precision: 'month' }, '2026-11-03'), 'end of March 2027');
  assert.strictEqual(deadlineLabel({ day: '2026-11-04' }, '2026-11-03'), 'tomorrow');
  assert.strictEqual(deadlineLabel({ day: '2026-11-02' }, '2026-11-03'), 'yesterday');
  const unsure = one(email({ deadlines: [deadline(3, { uncertain: true })] }));
  assert.strictEqual(unsure.reasons[0], 'Due Fri 6 Nov?');
  assert.strictEqual(unsure.deadline.uncertain, true);
});

test('Days away count calendar days, even across the clocks going back', () => {
  // 24 Oct 2026 23:30 BST; the deadline is 2 calendar days later, after the change on the 25th.
  const c = ctx({ now: Date.UTC(2026, 9, 24, 22, 30) });
  assert.strictEqual(c.today, '2026-10-24');
  assert.strictEqual(one(email({ deadlines: [deadline('2026-10-26')] }), c).deadline.daysAway, 2);
  // 28 Mar 2027 00:30 GMT, the night the clocks go forward.
  const spring = ctx({ now: Date.UTC(2027, 2, 28, 0, 30) });
  assert.strictEqual(one(email({ deadlines: [deadline('2027-03-29')] }), spring).deadline.daysAway, 1);
});

// ---------- fixes from the adversarial review (v0.3) ----------

const noreply = { name: 'Council', address: 'noreply@council.example' };

test('Bulk or automated mail that asks for something by a date: the deadline counts', () => {
  const school = one(fx.schoolTrip());
  expect(school, 'needs-you', ['deadline-soon']);
  assert.strictEqual(school.reasons[0], 'Due Fri 6 Nov');
  // Only an ask with a cue word: a date that merely sits in an ask isn't a deadline.
  const plain = fx.schoolTrip();
  plain.deadlines = [deadline(3, { text: 'Friday', cue: null, source: 'ask', sentence: 'On the day, please wear school uniform on Friday.' })];
  expect(one(plain), 'noise', ['newsletter']);
  // Marketing asks still don't count.
  const sale = fx.schoolTrip();
  sale.deadlines = [deadline(3, { cue: 'by', source: 'ask', sentence: 'Book by Friday to get 20% off the uniform shop.' })];
  expect(one(sale), 'noise', ['newsletter']);
  // "expires", "expiry", "deadline", "no later than" and "your … must" are obligation wording.
  for (const sentence of [
    'The MOT for your vehicle AB12 CDE expires on 14 November 2026.',
    'Expiry date of your parking permit: 14 November 2026.',
    'The deadline for applications is 14 November.',
    'Forms must reach our office no later than 14 November.',
    'Your parcel must be collected by 14 November.',
  ]) {
    const m = email({ from: noreply, listUnsubscribe: true, category: 'notification', deadlines: [deadline('2026-11-14', { cue: null, sentence })] });
    expect(one(m), 'needs-you', ['deadline-soon']);
  }
});

test("A delivery notice is news, not a task: \"your order will be delivered by Friday\" doesn't need you; an import fee does", () => {
  expect(one(fx.delivery()), 'noise', ['outlook-other']);
  const inFocused = one(fx.delivery({ focused: true }));
  expect(inFocused, 'worth-knowing', ['automated']);
  assert.strictEqual(inFocused.deadline, null);
  // "Your order" alone isn't obligation wording any more, and other ways of saying it.
  for (const sentence of [
    'Your order will be delivered by Friday 6 November.',
    'We will deliver your order by Friday 6 November.',
    'Your card will arrive by Friday 6 November.',
    'Your new card has been dispatched and is due to arrive by 6 November.',
    'Your order will be ready to collect from Friday 6 November.',
    'Your order is scheduled for delivery by Friday 6 November.',
  ]) {
    for (const source of ['body', 'ask']) {
      const m = fx.delivery({ focused: true, deadlines: [deadline(3, { cue: 'by', source, sentence })] });
      assert.notStrictEqual(one(m).bucket, 'needs-you', `${source}: ${sentence}`);
    }
  }
  const change = 'Your order can be changed or cancelled until Friday 6 November.';
  expect(one(fx.delivery({ focused: true, deadlines: [deadline(3, { cue: 'until', sentence: change })] })), 'worth-knowing', ['automated']);
  // From a shop address that looks like a person, it is still not an ask or a deadline.
  const shop = one(fx.delivery({ from: { name: 'Parcel Shop', address: 'orders@parcelshop.example' }, category: 'person', focused: true }));
  expect(shop, 'worth-knowing', ['fyi']);
  assert.strictEqual(shop.deadline, null);
  // Paying the import fee is a task.
  const fee = one(fx.importFee());
  expect(fee, 'needs-you', ['deadline-soon']);
  assert.strictEqual(fee.reasons[0], 'Due Fri 6 Nov');
  // So is a sentence about an arrival that also asks for something.
  for (const sentence of [
    'Your parcel will be delivered once you pay the £18.40 import fee by Friday 6 November.',
    'Payment must be made before the engineer arrives on Friday 6 November.',
    'Please make sure someone is in when your parcel arrives on Friday 6 November.',
  ]) {
    expect(one(fx.delivery({ deadlines: [deadline(3, { cue: 'by', source: 'ask', sentence })] })), 'needs-you');
  }
  // And a person telling you when something arrives isn't asking you to do anything.
  const builder = email({ from: { name: 'Sarah', address: 'sarah.collins@brightbuild.co.uk' }, actions: ['The steel will be delivered by Friday.'],
    deadlines: [deadline(3, { cue: 'by', source: 'ask', sentence: 'The steel will be delivered by Friday.' })] });
  expect(one(builder), 'worth-knowing', ['known-contact']);
});

test('Notices that say you must act but give no date are worth knowing, not noise', () => {
  const notice = (subject, body, o = {}) => email({ from: { name: 'DVLA', address: 'noreply@dvla.example' }, subject, body, category: 'notification', focused: false, ...o });
  for (const [subject, body] of [
    ['Action needed: your vehicle tax', 'We could not take your vehicle tax Direct Debit payment. You need to set up a new payment to keep your vehicle taxed.'],
    ['Response needed', 'Please reply to our letter about your 2025 return. If you do not respond we may charge you a penalty.'],
    ['Your vehicle tax', "We couldn't collect your payment this month."],
    ['Reply required', 'Please get in touch about your licence.'],
    ['Your licence', 'You have to renew your licence before you drive again.'],
  ]) {
    expect(one(notice(subject, body)), 'worth-knowing', ['obligation']);
    expect(one(notice(subject, body, { listUnsubscribe: true })), 'worth-knowing', ['obligation']);
  }
  // "You do not need to do anything" is not one.
  expect(one(notice('Your tax code has changed', 'Your tax code has changed to 1257L. You do not need to do anything.')), 'noise', ['outlook-other']);
});

test('A bank fraud check is a security alert, found in the subject or the start of the body', () => {
  expect(one(fx.fraudCheck()), 'worth-knowing', ['security']);
  assert.strictEqual(one(fx.fraudCheck()).reasons[0], 'Security alert about your account');
  expect(one(fx.fraudCheck({ subject: 'Your card ending 4421' })), 'worth-knowing', ['security']);
  for (const subject of ['Fraud alert', 'Did you authorise this transaction?', 'Suspicious payment on your account']) {
    expect(one(fx.fraudCheck({ subject, body: 'Please call us on the number on the back of your card.' })), 'worth-knowing', ['security']);
  }
  // Only the start of the body is read: a mention far down a long notice doesn't count.
  const long = fx.fraudCheck({ subject: 'Your statement is ready', body: `${'Your statement for October is ready to view in the app. '.repeat(8)}Read our tips on avoiding fraud.` });
  expect(one(long), 'noise', ['outlook-other']);
  // Older alerts from a sender whose emails go unread are not hidden as "ignored".
  const alerts = [1, 2, 3, 4].map((d) => fx.fraudCheck({ focused: null, hoursAgo: d * 24 + 5 }));
  const results = triageAll(alerts, ctx());
  for (const m of alerts) assert.notStrictEqual(results.get(m.id).bucket, 'noise', results.get(m.id).reasons.join(' | '));
  assert.ok(results.get(alerts[3].id).codes.includes('ignored'), 'still says they go unread');
  // Other automated mail from an ignored sender still is.
  const other = [1, 2, 3, 4].map((d) => fx.automated({ focused: null, hoursAgo: d * 24 + 5 }));
  expect(triageAll(other, ctx()).get(other[3].id), 'noise', ['ignored']);
});

test('A holiday key-safe code is not an old sign-in code; a real old sign-in code still is', () => {
  const cottage = one(fx.cottageCode());
  expect(cottage, 'worth-knowing', ['automated']);
  // Even with sign-in wording, an email about a stay still to come isn't a sign-in code…
  const withLogin = fx.cottageCode({ body: 'Your stay starts on Friday 6 November. Log in to the guest app for directions. Your key safe access code is 4821.' });
  expect(one(withLogin), 'worth-knowing', ['automated']);
  // …nor one with a deadline still to come.
  const balance = fx.cottageCode({ cleaned: { dates: [] }, body: 'Log in with your access code 4821 and pay the balance by Friday.',
    deadlines: [deadline(3, { cue: 'by', sentence: 'Log in with your access code 4821 and pay the balance by Friday.' })] });
  assert.notStrictEqual(one(balance).codes[0], 'old-code');
  // Access codes with sign-in wording and no date: old codes.
  const code = (subject, body) => email({ from: { name: 'Shop', address: 'noreply@shop.example' }, subject, body, hoursAgo: 30, seen: true, category: 'notification' });
  expect(one(code('Your code', 'Your access code is 4821. Use it to log in.')), 'noise', ['old-code']);
  expect(one(code('Your code', '482913 is your code. It expires in 10 minutes.')), 'noise', ['old-code']);
  expect(one(code('Your code', 'Your verification code is 482913. Use it today.')), 'noise', ['old-code']);
  // A confirmation code with no sign-in wording is not one.
  expect(one(code('Booking confirmed', 'Your confirmation code is 4821.')), 'worth-knowing', ['automated']);
  expect(one(fx.oldCode()), 'noise', ['old-code']);
});

test("CC'd, but asked by name: needs you, with that ask's deadline", () => {
  const r = one(fx.ccNamed());
  expect(r, 'needs-you', ['asks-question', 'deadline-soon']);
  assert.strictEqual(r.deadline.day, fx.dayPlus(fx.TODAY, 3), "the user's Friday, not Tom's Thursday");
  assert.strictEqual(r.reasons[1], 'Due Fri 6 Nov');
  assert.ok(!r.codes.includes('cc-only'));
  // Without the user's names (or with someone else's), it reads as before.
  expect(one(fx.ccNamed(), ctx({ names: [] })), 'worth-knowing', ['cc-only', 'deadline-soon']);
  assert.strictEqual(one(fx.ccNamed(), ctx({ names: [] })).deadline.day, fx.dayPlus(fx.TODAY, 2));
  expect(one(fx.ccNamed(), ctx({ names: ['sam'] })), 'worth-knowing', ['cc-only']);
  // The ways people address someone by name.
  for (const ask of [
    'Could you bring the new valves on Friday, Will?',
    'Hi Will, can you send me the invoice?',
    'Tom can drain it, and Will, could you bring the valves?',
    'Will: please send the invoice.',
    'WILL, could you send the invoice?',
  ]) {
    const m = fx.ccNamed({ deadlines: [] });
    m.cleaned[ask.endsWith('?') ? 'questions' : 'actions'] = [m.cleaned.questions[0], ask];
    expect(one(m), 'needs-you');
  }
  // Not addressed by name: "Will you…?", "ask Will, our electrician", "we will, if needed,".
  for (const ask of ['Will you be on site on Thursday, Tom?', 'Can you ask Will, our electrician, to call me?', 'We will, if needed, call you?', 'Can you check it, will?']) {
    expect(one(fx.ccNamed({ questions: [ask], deadlines: [] })), 'worth-knowing', ['cc-only']);
  }
  // The CC'd FYI that mentions the user ("Will, I've copied you in") asks nothing of them.
  expect(one(fx.ccFyi()), 'worth-knowing', ['cc-only']);
  // Names that aren't plain words are ignored rather than breaking the pattern.
  expect(one(fx.ccNamed(), ctx({ names: ['w', '.*', 'will)', 42, null] })), 'worth-knowing', ['cc-only']);
});

test("A Gmail post to a discussion group is a person's email, not bulk", () => {
  const r = one(fx.groupPost());
  expect(r, 'worth-knowing', ['group']);
  assert.strictEqual(r.reasons[0], 'Sent to a mailing list');
  // Asked by name, or with a deadline within a week: needs you.
  expect(one(fx.groupPost({ questions: ['Will, could you bring the corner flags?'] })), 'needs-you', ['asks-question']);
  const confirm = 'Please confirm your child can play by Thursday.';
  expect(one(fx.groupPost({ actions: [confirm], deadlines: [deadline(2, { text: 'Thursday', cue: 'by', source: 'ask', sentence: confirm })] })), 'needs-you', ['asks-action']);
  // Never noise, even unread, ignored or filed under Other.
  const posts = [1, 2, 3, 4].map((d) => fx.groupPost({ hoursAgo: d * 24 + 5, focused: false, questions: [] }));
  for (const res of triageAll(posts, ctx()).values()) assert.notStrictEqual(res.bucket, 'noise', res.reasons.join(' | '));
  // The same post from a company's own domain is still bulk.
  expect(one(fx.groupPost({ from: { name: 'Club', address: 'news@harrowjuniors.example' } })), 'noise', ['newsletter']);
  // Words in a webmail person's email ("unsubscribe", "sale", "payment received") don't make it bulk or automated.
  for (const category of ['newsletter', 'promo', 'receipt', 'notification']) {
    const m = email({ from: { name: 'Tom Hughes', address: 'tomhughes88@gmail.com' }, category, focused: false, questions: ['Can you give me a call tonight?'] });
    expect(one(m, ctx({ wrote: {} })), 'needs-you', ['asks-question']);
  }
  // Precedence: junk, Auto-Submitted and no-reply addresses still count.
  expect(one(email({ from: { name: 'X', address: 'someone@gmail.com' }, headers: { precedence: 'junk' } })), 'noise', ['newsletter']);
  expect(one(email({ from: { name: 'X', address: 'someone@gmail.com' }, headers: { autoSubmitted: 'auto-replied' }, focused: false })), 'noise', ['outlook-other']);
});

// ---------- the never-noise property ----------

const PROMO_SENTENCE = 'Today only: 30% off everything, shop now while stocks last.';

// Adds the worst of the noise signals: a List-Unsubscribe header, promo words (which the
// cleaner would then call a promotion, unless it's a receipt) and Outlook's Other tab.
function mutate(m, { listUnsubscribe, promoWords, other }) {
  const out = { ...m, headers: { ...(m.headers || {}) }, cleaned: { ...m.cleaned } };
  if (listUnsubscribe) out.headers.listUnsubscribe = fx.LIST_UNSUBSCRIBE;
  if (promoWords) {
    out.cleaned.body = `${out.cleaned.body} ${PROMO_SENTENCE}`;
    out.text = `${out.text} ${PROMO_SENTENCE}`;
    if (listUnsubscribe && out.cleaned.category !== 'receipt') out.cleaned.category = 'promo';
  }
  if (other) out.focused = false;
  return out;
}

const COMBOS = [];
for (const listUnsubscribe of [false, true]) {
  for (const promoWords of [false, true]) for (const other of [false, true]) COMBOS.push({ listUnsubscribe, promoWords, other });
}

// Protected by something other than being a person: a flag, a rule, Not noise, a reply, a
// known contact, an obligation deadline, a payment due, a receipt or a fresh security notice.
const PROTECTED = [
  ['Sarah (known contact)', () => [fx.sarah(), ctx()]],
  ['Dad (known contact)', () => [fx.dad(), ctx()]],
  ...[NOW, at(2027, 1, 20), at(2027, 2, 10), at(2027, 3, 1)].map((now) => [`HMRC at ${new Date(now).toISOString().slice(0, 10)}`, () => [fx.hmrc(), ctx({ now })]]),
  ['HMRC with no date found', () => [fx.hmrc({ deadlines: [] }), ctx()]],
  ['Screwfix receipt', () => [fx.screwfix(), ctx()]],
  ['bank payment due', () => [fx.bank(), ctx()]],
  ['demo-1 replied', () => {
    const m = fx.demo1();
    return [m, ctx({ replied: { [m.id]: fx.DEMO1_REPLIED } })];
  }],
  ['flagged newsletter', () => [fx.flaggedNewsletter(), ctx()]],
  ['always important', () => [fx.stranger(), ctx({ rules: { 'amy.turner@example.net': 'important' } })]],
  ['marked Not noise', () => {
    const m = fx.weeklyBuilder(30);
    return [m, ctx({ notNoise: [m.id], rules: { '@weeklybuilder.com': 'noise' } })];
  }],
  ['group coursework deadline', () => [fx.strangerGroupCoursework(), ctx()]],
  ['fresh sign-in alert', () => [fx.freshSignIn(), ctx()]],
  ['school asks for a form back by Friday', () => [fx.schoolTrip(), ctx()]],
  ['import fee to pay within 3 days', () => [fx.importFee(), ctx()]],
  ['bank fraud check', () => [fx.fraudCheck(), ctx()]],
  ["CC'd but asked by name", () => [fx.ccNamed(), ctx()]],
  ['Gmail post to a discussion group', () => [fx.groupPost(), ctx()]],
  ['Gmail post to a discussion group, asking by name', () => [fx.groupPost({ questions: ['Will, could you bring the corner flags?'] }), ctx()]],
];

// Protected only by being from a person. A List-Unsubscribe header is the positive bulk
// evidence that may make an unknown sender noise, so these get the other two signals.
const PEOPLE = [
  ['stranger asking', () => [fx.stranger(), ctx()]],
  ['stranger asking for bank details', () => [fx.strangerBankDetails(), ctx()]],
  ["CC'd FYI", () => [fx.ccFyi(), ctx()]],
  ['person filed under Other', () => [fx.personOther(), ctx()]],
  ['group email', () => [fx.strangerGroup(), ctx()]],
  ['old ask', () => [email({ hoursAgo: 24 * 30, questions: ['Can you send the invoice?'] }), ctx()]],
];

test('Property: protected emails never become noise, whatever noise signals are added', () => {
  for (const [name, make] of PROTECTED) {
    for (const combo of COMBOS) {
      const [m, c] = make();
      const r = triage(mutate(m, combo), c);
      assert.notStrictEqual(r.bucket, 'noise', `${name} with ${JSON.stringify(combo)}: ${r.reasons.join(' | ')}`);
    }
  }
  for (const [name, make] of PEOPLE) {
    for (const combo of COMBOS.filter((x) => !x.listUnsubscribe)) {
      const [m, c] = make();
      const r = triage(mutate(m, combo), c);
      assert.notStrictEqual(r.bucket, 'noise', `${name} with ${JSON.stringify(combo)}: ${r.reasons.join(' | ')}`);
    }
  }
});

// A small seeded random generator, so the fuzz test is the same every run.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Property: an email from a person is never noise unless the user chose Always noise', () => {
  const rnd = random(42);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let i = 0; i < 400; i++) {
    const addr = `p${i % 7}@people.example`;
    const others = Array.from({ length: pick([0, 3, 15]) }, (_, n) => ({ name: '', address: `x${n}@example.org` }));
    const toMe = pick([true, false]);
    const inputs = Array.from({ length: pick([1, 2, 5]) }, () => email({
      from: { name: 'P', address: addr },
      to: toMe ? [{ ...fx.ME }, ...others] : others,
      cc: toMe ? [] : [{ ...fx.ME }],
      hoursAgo: pick([1, 20, 30, 24 * 5, 24 * 20, 24 * 90]),
      seen: pick([true, false]),
      focused: pick([true, false, null]),
      importance: pick(['low', 'normal', 'high']),
      urgency: pick(['low', 'normal', 'high']),
      questions: pick([[], ['Can you call me?']]),
      actions: pick([[], ['Please send the form.']]),
      body: pick(['', PROMO_SENTENCE, 'Your verification code is 482913.', 'Payment of £50 is overdue.']),
      subject: pick(['', 'Security alert', 'Newsletter']),
      deadlines: pick([[], [deadline(pick([-30, -3, 0, 5, 20, 500]), { cue: pick(['by', null]), source: pick(['body', 'ask']) })]]),
    }));
    const c = ctx({ wrote: pick([{}, { [addr]: 2 }]), historyKnown: pick([true, false]) });
    for (const [id, r] of triageAll(inputs, c)) assert.notStrictEqual(r.bucket, 'noise', `${id}: ${r.reasons.join(' | ')}`);
  }
});

// ---------- real emails through the real pipeline (cleaner → dates → triage) ----------

const real = require('./fixtures/real-emails');

const realCtx = (f, o = {}) => ctx({ now: real.NOW, names: real.NAMES, wrote: f.wrote || {}, ...o });
const realTriage = (f, rawEmail = f.raw()) => triage(real.prepare(rawEmail), realCtx(f));
const describeResult = (r) => `${r.bucket} ${r.codes.join(',')} ${r.deadline ? r.deadline.day : 'no deadline'} (${r.reasons.join(' | ')})`;

function checkReal(f) {
  const r = realTriage(f);
  const { bucket, code, day } = f.expect;
  assert.ok([].concat(bucket).includes(r.bucket), `${f.name}: ${describeResult(r)}`);
  if (code) assert.strictEqual(r.codes[0], code, `${f.name}: ${describeResult(r)}`);
  if (day) assert.strictEqual(r.deadline && r.deadline.day, day, `${f.name}: ${describeResult(r)}`);
}

// Which noise signals each fixture must survive (see real-emails.js).
function realCombos(f) {
  if (f.guard === 'all') return COMBOS;
  if (f.guard === 'person') return COMBOS.filter((x) => !x.listUnsubscribe);
  return [COMBOS[0]];
}

function checkRealNeverNoise(f) {
  for (const combo of realCombos(f)) {
    const r = realTriage(f, real.mutateRaw(f.raw(), combo));
    assert.notStrictEqual(r.bucket, 'noise', `${f.name} with ${JSON.stringify(combo)}: ${describeResult(r)}`);
  }
}

test('Real pipeline: the emails the review found sorted wrongly now land where they should', () => {
  for (const f of real.REAL.filter((x) => !x.needs)) checkReal(f);
});

// Depends on the text agent's parallel fixes in cleaner.js and dates.js ("no later than
// 5pm on…", "by the 15th", and forwarded emails' dates, cleaner.forwarded): each fixture's
// `needs` names which.
test("Real pipeline, with the text agent's cleaner and dates fixes: the deadlines are found too", () => {
  for (const f of real.REAL.filter((x) => x.needs)) checkReal(f);
});

test('Property (real pipeline): none of those emails becomes noise, whatever noise signals are added', () => {
  for (const f of real.REAL.filter((x) => !x.noiseNeeds)) checkRealNeverNoise(f);
});

// Depends on the text agent's dates.js fix ("no later than midnight on 20 November"): until
// then no deadline is found and nothing else protects that council notice.
test("Property (real pipeline, with the text agent's dates fix): nor do the ones that need it", () => {
  for (const f of real.REAL.filter((x) => x.noiseNeeds)) checkRealNeverNoise(f);
});

test('Real pipeline: emails that really are noise still are', () => {
  for (const f of real.CONTROLS) {
    const r = realTriage(f);
    expect(r, 'noise', [f.code]);
  }
  const issues = real.ignoredNewsletter().map(real.prepare);
  const current = triageAll(issues, realCtx({})).get(issues[0].id);
  expect(current, 'noise', ['newsletter']);
  assert.strictEqual(current.reasons[0], "Newsletter you haven't opened in 4 emails");
  // The delivery notice in Outlook's Focused tab: worth knowing, never needs you.
  const delivery = real.CONTROLS.find((f) => f.code === 'outlook-other');
  expect(realTriage(delivery, { ...delivery.raw(), focused: true }), 'worth-knowing', ['automated']);
});

// ---------- reasons ----------

test('Reasons: at most 3, one code each, every code has plain-English text', () => {
  const many = email({
    to: [{ name: 'Tom', address: 'tom@example.org' }],
    cc: [{ ...fx.ME }],
    importance: 'high',
    focused: false,
    questions: ['Can you check?'],
    deadlines: [deadline(2)],
  });
  const all = [
    fx.sarah(), fx.dad(), fx.hmrc(), fx.screwfix(), fx.promo(), fx.ccFyi(), fx.bank(), fx.stranger(), fx.strangerBankDetails(),
    fx.strangerGroup(), fx.strangerGroupCoursework(), fx.demo1(), fx.oldCode(), fx.freshSignIn(), fx.automated(),
    fx.personOther(), fx.flaggedNewsletter(), many, ...fx.weeklyBuilderIssues(0),
    fx.schoolTrip(), fx.importFee(), fx.delivery(), fx.fraudCheck(), fx.cottageCode(), fx.ccNamed(), fx.groupPost(),
  ];
  const results = triageAll(all, ctx());
  assert.strictEqual(results.size, all.length);
  const seen = new Set();
  for (const r of results.values()) {
    assert.ok(BUCKETS.includes(r.bucket));
    assert.ok(r.codes.length >= 1 && r.codes.length <= 3, r.codes.join());
    assert.strictEqual(r.reasons.length, r.codes.length);
    assert.strictEqual(new Set(r.codes).size, r.codes.length, 'no reason twice');
    for (const [i, code] of r.codes.entries()) {
      assert.ok(Object.hasOwn(REASON_TEXT, code), code);
      assert.ok(typeof r.reasons[i] === 'string' && r.reasons[i].length > 3);
      assert.doesNotMatch(r.reasons[i], /undefined|NaN|null|\[object/);
      seen.add(code);
    }
    assert.deepStrictEqual(Object.keys(r).sort(), ['bucket', 'caution', 'codes', 'deadline', 'reasons']);
  }
  const m = triage(many, ctx());
  assert.strictEqual(m.codes.length, 3);
  assert.deepStrictEqual(m.codes, ['cc-only', 'deadline-soon', 'first-contact']);
  assert.ok(seen.size >= 15, `${seen.size} different reasons seen`);
  // Every text works with typical details.
  const details = { name: 'Sarah', count: 4, label: 'Fri 6 Nov', daysAway: 3, weeks: 2, outlook: true };
  for (const [code, text] of Object.entries(REASON_TEXT)) {
    assert.doesNotMatch(text(details), /undefined|NaN/, code);
    assert.strictEqual(typeof text({}), 'string', code);
  }
});

test('triage never throws on missing or broken fields', () => {
  for (const input of [null, undefined, {}, { from: 'x', to: 'y', cc: 5, cleaned: 5, deadlines: 'no', headers: 'x' },
    { id: 1, from: { address: 7 }, deadlines: [null, { day: '2026-02-31' }, { day: 'soon' }], receivedAt: 'yesterday' }]) {
    for (const c of [undefined, null, {}, { now: 'bad', me: 'x', wroteTo: () => { throw new Error('boom'); }, repliedAt: 5 }]) {
      const r = triage(input, c);
      assert.ok(BUCKETS.includes(r.bucket));
      assert.ok(r.reasons.length >= 1);
    }
  }
  assert.strictEqual(triageAll(null, {}).size, 0);
  // An impossible date (31 Feb) is skipped rather than shown.
  assert.strictEqual(one(email({ deadlines: [deadline('2027-02-31')] })).deadline, null);
});

// ---------- senderStats ----------

test('senderStats: only emails older than a day count towards ignored and usually read', () => {
  const from = { name: 'N', address: 'News@Example.com' };
  const mk = (hoursAgo, seen) => email({ from, hoursAgo, seen });
  let stats = senderStats([mk(2, false), mk(30, false), mk(60, false), mk(90, false)], NOW).get('news@example.com');
  assert.deepStrictEqual(stats, { total: 4, older: 3, read: 0, unreadRun: 4, ignored: true, usuallyRead: false });
  // An opened email among the newest older ones breaks the run.
  stats = senderStats([mk(2, false), mk(30, false), mk(60, true), mk(90, false), mk(120, false)], NOW).get('news@example.com');
  assert.deepStrictEqual([stats.ignored, stats.unreadRun, stats.older, stats.read], [false, 2, 4, 1]);
  // Usually read: at least 3 older, half or more opened.
  stats = senderStats([mk(30, true), mk(60, false), mk(90, true)], NOW).get('news@example.com');
  assert.deepStrictEqual([stats.usuallyRead, stats.ignored], [true, false]);
  assert.strictEqual(senderStats([mk(30, true), mk(60, true)], NOW).get('news@example.com').usuallyRead, false);
  // Recent unread email alone is never "ignored".
  assert.strictEqual(senderStats([mk(1, false), mk(5, false), mk(20, false)], NOW).get('news@example.com').ignored, false);
  assert.strictEqual(senderStats(null, NOW).size, 0);
  assert.strictEqual(senderStats([{ from: null }, null, { from: { address: '' } }], NOW).size, 0);
});

// ---------- sort order ----------

test('sortBucket: needs you by overdue, soonest deadline, flagged, newest', () => {
  const item = (id, hoursAgo, daysAway, flagged = false) => ({
    id,
    receivedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    triage: { bucket: 'needs-you', codes: flagged ? ['flagged'] : ['asks-question'], deadline: daysAway === null ? null : { daysAway } },
  });
  const items = [
    item('new-plain', 1, null), item('old-plain', 50, null), item('due-3', 5, 3), item('overdue-1', 5, -1),
    item('flagged', 40, null, true), item('overdue-5', 80, -5), item('due-0', 2, 0), item('due-3-flagged', 9, 3, true),
  ];
  assert.deepStrictEqual(sortBucket(items, 'needs-you').map((i) => i.id), [
    'overdue-5', 'overdue-1', 'due-0', 'due-3-flagged', 'due-3', 'flagged', 'new-plain', 'old-plain',
  ]);
  assert.notStrictEqual(sortBucket(items, 'needs-you'), items, 'a new array');
  assert.strictEqual(items[0].id, 'new-plain', 'the input is not reordered');
});

test('sortBucket: worth knowing puts new since the last brief first; noise is grouped by sender', () => {
  const w = (id, hoursAgo, isNew) => ({ id, isNew, date: new Date(NOW - hoursAgo * HOUR).toISOString(), triage: { bucket: 'worth-knowing' } });
  assert.deepStrictEqual(sortBucket([w('a', 1, false), w('b', 5, true), w('c', 2, true), w('d', 0.5, false)], 'worth-knowing').map((i) => i.id), ['c', 'b', 'd', 'a']);
  const n = (id, addr, hoursAgo) => ({ id, from: { name: addr, address: addr }, receivedAt: new Date(NOW - hoursAgo * HOUR).toISOString() });
  const noise = [n('wb1', 'wb@x.com', 10), n('promo', 'offers@y.com', 2), n('wb2', 'wb@x.com', 1), n('wb3', 'WB@x.com', 50), n('social', 's@z.com', 5)];
  assert.deepStrictEqual(sortBucket(noise, 'noise').map((i) => i.id), ['wb2', 'wb1', 'wb3', 'promo', 'social']);
  assert.deepStrictEqual(sortBucket(null, 'noise'), []);
});

// ---------- rule keys ----------

test('isValidRuleKey: lower-case addresses and @domains, but never a whole webmail domain', () => {
  for (const key of ['sarah.collins@brightbuild.co.uk', '@brightbuild.co.uk', 'a+b@x.io', '@mail.example']) assert.strictEqual(isValidRuleKey(key), true, key);
  for (const key of ['Sarah@x.com', ' a@b.com', 'a@b', '@', '@gmail.com', '@outlook.com', '@hotmail.co.uk', 'a b@c.com', '__proto__',
    'constructor', '', 'x'.repeat(250) + '@b.com', 42, null, undefined, {}, 'a@b.com\n', '<a@b.com>', '@-bad.com']) {
    assert.strictEqual(isValidRuleKey(key), false, String(key));
  }
  // A single address at a webmail domain is fine.
  assert.strictEqual(isValidRuleKey('someone@gmail.com'), true);
});

// ---------- demo data ----------

const demo = require('../src/demo');
const { sentBatch, buildSentBatch, ME } = require('../src/demo-sent');
const { clean } = require('../src/cleaner');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

test('demo: ids, RawEmail v3 fields, and dates worked out from now', () => {
  assert.deepStrictEqual(demo.map((m) => m.id), Array.from({ length: 17 }, (_, i) => `demo-${i + 1}`));
  for (const m of demo) {
    for (const key of ['to', 'cc', 'headers', 'conversationId', 'focused', 'flagged', 'importance', 'receivedAt', 'webLink', 'inReplyTo', 'seen', 'attachments', 'text']) {
      assert.ok(key in m, `${m.id} has ${key}`);
    }
    assert.strictEqual(m.webLink, null);
    assert.ok(Date.parse(m.receivedAt) <= Date.now() && Date.parse(m.receivedAt) > Date.now() - 23 * DAY, m.id);
    for (const a of [m.from, ...m.to, ...m.cc]) assert.strictEqual(a.address, a.address.toLowerCase());
  }
  assert.strictEqual(demo.ME.address, 'will@example.com');
  assert.strictEqual(Object.keys(demo).length, demo.length, 'ME and build are not enumerable');
});

test('demo: every computed date is right for any day of the year', () => {
  const start = Date.UTC(2026, 0, 1, 10);
  for (let i = 0; i < 400; i++) {
    const now = start + i * DAY + (i % 24) * HOUR;
    const today = new Date(now);
    const list = demo.build(now);
    const { facts } = list;
    const two = list.find((m) => m.id === 'demo-2').text;
    // The facts are what the emails say.
    assert.ok(two.includes(`proceed by ${facts.confirmBy} so`) && two.includes(`start date of ${facts.startDate}.`));
    assert.ok(list.find((m) => m.id === 'demo-4').text.includes(`submitted by ${facts.taxDeadline}.`));
    assert.ok(list.find((m) => m.id === 'demo-7').text.includes(`purchases in ${facts.receiptsMonth} `) && list.find((m) => m.id === 'demo-7').text.includes(`due on ${facts.vatDue} so`));
    assert.ok(list.find((m) => m.id === 'demo-8').text.includes(`so by ${facts.appealBy}.`) && list.find((m) => m.id === 'demo-8').text.includes(`Date: ${facts.decided}\n`));
    for (const key of ['confirmByDay', 'startDay', 'taxDeadlineDay', 'vatDueDay', 'appealByDay']) assert.match(facts[key], /^\d{4}-\d{2}-\d{2}$/);
    const [, weekday, date, month] = /proceed by (\w+) (\d+)\w\w (\w+)/.exec(two);
    // Sarah's Friday is 2 to 8 days away, and the weekday matches the date.
    let friday = null;
    for (let n = 1; n <= 9; n++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n, 12);
      if (d.getDate() === Number(date) && MONTHS[d.getMonth()] === month) friday = { n, d };
    }
    assert.ok(friday && friday.n >= 2 && friday.n <= 8, `${today.toISOString()}: ${weekday} ${date} ${month}`);
    assert.strictEqual(weekday, 'Friday');
    assert.strictEqual(WEEKDAYS[friday.d.getDay()], 'Friday');
    const [, startDay] = /start date of (\w+)/.exec(two);
    assert.strictEqual(startDay, 'Monday');
    // HMRC's date is still to come; the VAT return is at least 10 days off.
    const [, year] = /must be submitted by 31 January (\d{4})/.exec(list.find((m) => m.id === 'demo-4').text);
    assert.ok(new Date(Number(year), 0, 31, 23, 59) >= today && Number(year) - today.getFullYear() <= 1);
    const [, vatDay, vatMonth] = /due on (\d+) (\w+) so/.exec(list.find((m) => m.id === 'demo-7').text);
    assert.strictEqual(vatDay, '7');
    assert.ok(MONTHS.includes(vatMonth));
    // The planning appeal date is 28 days after the decision.
    const eight = list.find((m) => m.id === 'demo-8').text;
    const [, dDay, dMon, dYear] = /Date: \w+, (\d+) (\w+) (\d{4})/.exec(eight);
    const [, aDay, aMonth, aYear] = /so by (\d+) (\w+) (\d{4})/.exec(eight);
    const decided = new Date(Number(dYear), ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(dMon), Number(dDay), 12);
    const appeal = new Date(Number(aYear), MONTHS.indexOf(aMonth), Number(aDay), 12);
    assert.strictEqual(Math.round((appeal - decided) / DAY), 28);
  }
});

test('demo-2 keeps its structure: the quote, the confirm-by deadline, the site meeting and the start date', () => {
  const c = clean({ text: demo.find((m) => m.id === 'demo-2').text, subject: 'RE: Site visit', from: 'sarah.collins@brightbuild.co.uk' });
  assert.ok(c.amounts.includes('£14,750'));
  assert.ok(c.questions.some((q) => /site meeting/.test(q)));
  assert.ok(c.actions.some((a) => /confirm/.test(a)));
  assert.match(c.body, /start date of Monday/);
});

test('demo sent history: Sarah six times (one the reply to demo-1), Dad, Priya and Jo', () => {
  assert.strictEqual(ME, demo.ME);
  assert.deepStrictEqual([sentBatch.cursor, sentBatch.full], [null, true]);
  const count = {};
  for (const e of sentBatch.entries) {
    assert.strictEqual(e.from, 'will@example.com');
    assert.ok(Array.isArray(e.to) && e.to.every((a) => a === a.toLowerCase()));
    assert.ok(!Number.isNaN(Date.parse(e.date)) && Date.parse(e.date) < Date.now());
    for (const a of e.to) count[a] = (count[a] || 0) + 1;
  }
  assert.deepStrictEqual(count, { 'sarah.collins@brightbuild.co.uk': 6, 'dad@example.com': 2, 'priya@shahaccounting.co.uk': 3, 'jo.patel@example.com': 2 });
  const [one1, two] = ['demo-1', 'demo-2'].map((id) => demo.find((m) => m.id === id));
  const reply = sentBatch.entries.find((e) => e.inReplyTo === one1.messageId);
  assert.strictEqual(reply.conversationId, one1.conversationId);
  assert.strictEqual(two.conversationId, one1.conversationId);
  assert.ok(Date.parse(reply.date) > Date.parse(one1.receivedAt) && Date.parse(reply.date) < Date.parse(two.receivedAt));
  // Rebuilt for another time, it still fits around that time's emails.
  const later = Date.UTC(2027, 5, 1, 12);
  const batch = buildSentBatch({ now: later });
  const first = demo.build(later).find((m) => m.id === 'demo-1');
  assert.ok(Date.parse(batch.entries.find((e) => e.inReplyTo === first.messageId).date) > Date.parse(first.receivedAt));
});

test('demo: the inbox sorts as designed (real cleaner, no deadlines needed)', () => {
  const wrote = {};
  const replies = {};
  for (const e of sentBatch.entries) {
    for (const a of e.to) wrote[a] = (wrote[a] || 0) + 1;
    replies[e.conversationId] = Math.max(replies[e.conversationId] || 0, Date.parse(e.date));
  }
  const inputs = demo.map((m) => ({ ...m, cleaned: clean({ text: m.text, subject: m.subject, from: m.from.address }), deadlines: [] }));
  const results = triageAll(inputs, {
    now: Date.now(),
    me: new Set([ME.address]),
    names: ['will'], // from demo.ME's name, as main.js derives it
    wroteTo: (a) => wrote[a] || 0,
    historyKnown: true,
    repliedAt: (m) => replies[m.conversationId] || null,
  });
  const bucket = (b) => inputs.filter((m) => results.get(m.id).bucket === b).map((m) => m.id);
  assert.deepStrictEqual(bucket('needs-you'), ['demo-2', 'demo-3', 'demo-7', 'demo-8', 'demo-13', 'demo-15']);
  assert.deepStrictEqual(bucket('worth-knowing'), ['demo-1', 'demo-4', 'demo-5', 'demo-14']);
  assert.deepStrictEqual(bucket('noise'), ['demo-6', 'demo-9', 'demo-10', 'demo-11', 'demo-12', 'demo-16', 'demo-17']);
  assert.strictEqual(results.get('demo-1').codes[0], 'replied');
  assert.strictEqual(results.get('demo-6').reasons[0], "Newsletter you haven't opened in 4 emails");
  assert.strictEqual(results.get('demo-16').codes[0], 'old-code');
  assert.ok(results.get('demo-13').caution);
});
