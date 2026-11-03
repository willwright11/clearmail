// Dates and deadlines, in UK time so the clock changes are exercised. TZ must be set before
// any Date is made.
process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert');
const { findDates, findDeadlines, dayKey, daysBetween, formatDay, orderForLocale } = require('../src/dates');
const { clean } = require('../src/cleaner');
const demo = require('../src/demo');

const at = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min);
const TUE_3_NOV = at(2026, 11, 3);
const days = (s, ref = TUE_3_NOV, opts) => findDates(s, ref, opts).map((d) => d.day);
function one(s, ref = TUE_3_NOV, opts) {
  const found = findDates(s, ref, opts);
  assert.strictEqual(found.length, 1, `${s}: ${JSON.stringify(found)}`);
  return found[0];
}
const deadlines = (body, ref = TUE_3_NOV, extra = {}) => findDeadlines({ body, ...extra }, ref);
const cleanedDeadlines = (text, ref, subject = '') => {
  const c = clean({ text, subject, from: 'sam@example.com' });
  return findDeadlines({ subject, body: c.body, questions: c.questions, actions: c.actions }, ref);
};

test('dayKey, daysBetween and formatDay work on local calendar days', () => {
  assert.strictEqual(dayKey(at(2026, 10, 25, 0, 30)), '2026-10-25');
  assert.strictEqual(dayKey(Date.UTC(2026, 5, 30, 23, 30)), '2026-07-01'); // 00:30 BST
  assert.strictEqual(dayKey('2026-11-03'), '2026-11-03');
  assert.strictEqual(dayKey('2026-11-03T23:30:00Z'), '2026-11-03'); // GMT in November
  for (const bad of ['2026-02-31', 'nonsense', '', null, undefined, NaN, true]) assert.strictEqual(dayKey(bad), null, String(bad));

  assert.strictEqual(daysBetween('2026-10-24', '2026-10-26'), 2); // across the autumn change
  assert.strictEqual(daysBetween('2027-03-27', '2027-03-29'), 2); // across the spring change
  assert.strictEqual(daysBetween('2026-11-03', '2026-10-30'), -4);
  assert.strictEqual(daysBetween(at(2026, 10, 25, 23, 59), at(2026, 10, 26, 0, 1)), 1);
  assert.strictEqual(daysBetween('2026-12-28', '2027-01-05'), 8);
  assert.ok(Number.isNaN(daysBetween('x', '2026-01-01')));

  const today = '2026-11-03';
  assert.strictEqual(formatDay('2026-11-03', today), 'today');
  assert.strictEqual(formatDay('2026-11-04', today), 'tomorrow');
  assert.strictEqual(formatDay('2026-11-02', today), 'yesterday');
  assert.strictEqual(formatDay('2026-11-06', today), 'Fri 6 Nov');
  assert.strictEqual(formatDay('2027-01-31', today), 'Sun 31 Jan 2027');
  assert.strictEqual(formatDay('2026-11-06', TUE_3_NOV), 'Fri 6 Nov');
  assert.strictEqual(formatDay('bad', today), '');

  assert.strictEqual(orderForLocale('en-GB'), 'dmy');
  assert.strictEqual(orderForLocale('en-US'), 'mdy');
  assert.strictEqual(orderForLocale('fr-FR'), 'dmy');
  assert.strictEqual(orderForLocale(undefined), 'dmy');
});

test('DST: "tomorrow", weekdays and "in 2 days" land on the right day across the clock change', () => {
  // Clocks go back at 02:00 on Sunday 25 October 2026 (that day has 25 hours).
  const earlySat = at(2026, 10, 24, 0, 15);
  assert.deepStrictEqual(days('tomorrow', earlySat), ['2026-10-25']);
  assert.deepStrictEqual(days('in 2 days', earlySat), ['2026-10-26']);
  assert.deepStrictEqual(days('Monday', earlySat), ['2026-10-26']);
  assert.deepStrictEqual(days('tomorrow', at(2026, 10, 24, 23, 45)), ['2026-10-25']);
  // Clocks go forward at 01:00 on Sunday 28 March 2027 (that day has 23 hours).
  const lateSat = at(2027, 3, 27, 23, 30);
  assert.deepStrictEqual(days('tomorrow', lateSat), ['2027-03-28']);
  assert.deepStrictEqual(days('in 2 days', lateSat), ['2027-03-29']);
  assert.deepStrictEqual(days('Sunday', lateSat), ['2027-03-28']);
  assert.deepStrictEqual(days('today', at(2027, 3, 28, 0, 30)), ['2027-03-28']);
  assert.deepStrictEqual(days('today', '2027-03-28T23:30:00Z'), ['2027-03-29']); // 00:30 BST
});

test('a day and month with no year lands within 60 days back to 305 days ahead', () => {
  const mon28Dec = at(2026, 12, 28);
  assert.deepStrictEqual(days('Please pay by 5 January', mon28Dec), ['2027-01-05']);
  assert.deepStrictEqual(days('by 2 Jan', mon28Dec), ['2027-01-02']);
  assert.deepStrictEqual(days('by 20 December', mon28Dec), ['2026-12-20']);
  assert.deepStrictEqual(days('by Friday', mon28Dec), ['2027-01-01']);
  // Sent 3 November: "30 October" is four days ago, so it is already overdue.
  const [late] = deadlines('Please reply by 30 October.');
  assert.deepStrictEqual([late.day, late.cue], ['2026-10-30', 'by']);
  assert.strictEqual(daysBetween(dayKey(TUE_3_NOV), late.day), -4);
  // 1 September 2026 is 63 days back, outside the window, so it means next year.
  assert.deepStrictEqual(days('by 1 September'), ['2027-09-01']);
  // An explicit year is used as written.
  assert.deepStrictEqual(days('by 31 January 2027'), ['2027-01-31']);
  assert.deepStrictEqual(days('by 30 October 2028'), ['2028-10-30']);
});

test('impossible dates and things that only look like dates are rejected', () => {
  for (const s of ['Due 31 Feb', 'Due 31 February 2027', 'Due 30/02/2027', 'Due 2027-02-30', 'Deadline: 31 Feb', 'by 29 February 2027']) {
    assert.deepStrictEqual(findDates(s, TUE_3_NOV), [], s);
  }
  assert.deepStrictEqual(days('by 29 February 2028'), ['2028-02-29']);
  for (const s of ['We offer 24/7 support.', 'Total £12.50 for 3/4 of the order.', 'Sort code 12-34-56.', 'The fix is in version 1.2.', 'Application 26/1234 was refused.', 'I sat down with the client and the sun was out. They wed next year. Your team may 2 days early?']) {
    assert.deepStrictEqual(findDates(s, TUE_3_NOV), [], s);
  }
});

test('a weekday that does not match the date keeps the date, marked uncertain', () => {
  // 17 October 2026 is a Saturday.
  let d = one('by Friday 17th October 2026');
  assert.deepStrictEqual([d.day, d.uncertain, d.text], ['2026-10-17', true, 'Friday 17th October 2026']);
  d = one('by Saturday 17th October 2026');
  assert.deepStrictEqual([d.day, d.uncertain], ['2026-10-17', false]);
  d = one('by Friday 17th October', at(2026, 10, 14));
  assert.deepStrictEqual([d.day, d.uncertain], ['2026-10-17', true]);
  // 13 November 2026 is a Friday.
  d = one('Friday, 13/11 is the deadline');
  assert.deepStrictEqual([d.day, d.uncertain, d.text, d.cue], ['2026-11-13', false, 'Friday, 13/11', 'deadline']);
  assert.strictEqual(one('Thursday, 13/11').uncertain, true);
  d = one('on Friday 13th');
  assert.deepStrictEqual([d.day, d.uncertain], ['2026-11-13', false]);
  assert.deepStrictEqual([one('Fri 13 Nov').day, one('Fri 13 Nov').uncertain], ['2026-11-13', false]);
});

test('numeric dates: the locale order decides 10/11, and a number over 12 overrides it', () => {
  assert.deepStrictEqual(days('due 10/11'), ['2026-11-10']);
  assert.deepStrictEqual(days('due 10/11', TUE_3_NOV, { order: 'dmy' }), ['2026-11-10']);
  assert.deepStrictEqual(days('due 10/11', TUE_3_NOV, { order: 'mdy' }), ['2026-10-11']);
  assert.deepStrictEqual(days('due 13/11', TUE_3_NOV, { order: 'mdy' }), ['2026-11-13']);
  assert.deepStrictEqual(days('due 11/13', TUE_3_NOV, { order: 'dmy' }), ['2026-11-13']);
  assert.deepStrictEqual(days('due 10/11/2027'), ['2027-11-10']);
  assert.deepStrictEqual(days('due 10/11/27'), ['2027-11-10']);
  assert.deepStrictEqual(days('due 16.10.2026'), ['2026-10-16']);
  assert.deepStrictEqual(days('due 16-10-2026'), ['2026-10-16']);
  assert.deepStrictEqual(days('due 2026-11-20'), ['2026-11-20']);
  assert.deepStrictEqual(days('due 1999-11-20'), []); // a reference number, not a deadline
});

test('relative dates: "within 28 days", and working days skip the weekend', () => {
  let d = one('You can appeal within 28 days of this notice.');
  assert.deepStrictEqual([d.day, d.relative, d.cue, d.text], ['2026-12-01', true, 'within', 'within 28 days']);
  const fri6Nov = at(2026, 11, 6);
  d = one('Please reply within 2 working days.', fri6Nov);
  assert.deepStrictEqual([d.day, d.relative], ['2026-11-10', true]); // Mon, Tue
  assert.deepStrictEqual(days('within 2 days', fri6Nov), ['2026-11-08']);
  assert.deepStrictEqual(days('within five business days', fri6Nov), ['2026-11-13']);
  assert.deepStrictEqual(days('within 1 working day', at(2026, 11, 7)), ['2026-11-09']);
  assert.deepStrictEqual(days('in a week', fri6Nov), ['2026-11-13']);
  assert.deepStrictEqual(days('within two weeks', fri6Nov), ['2026-11-20']);
  assert.deepStrictEqual(days('in a fortnight', fri6Nov), ['2026-11-20']);
  assert.deepStrictEqual(days('within the next 30 days', fri6Nov), ['2026-12-06']);
  assert.deepStrictEqual(days('within 1 month', at(2027, 1, 31)), ['2027-02-28']);
  assert.deepStrictEqual(findDates('It expires in 10 minutes.', TUE_3_NOV), []);
});

test('weekdays, weeks, weekends and months follow the rules', () => {
  const check = (s, day, extra = {}, ref = TUE_3_NOV) => {
    const d = one(s, ref);
    assert.strictEqual(d.day, day, s);
    for (const [k, v] of Object.entries(extra)) assert.strictEqual(d[k], v, `${s}: ${k}`);
  };
  // Sent on Tuesday 3 November 2026.
  check('Friday', '2026-11-06', { uncertain: false, precision: 'day' });
  check('this Friday', '2026-11-06', { uncertain: false, text: 'this Friday' });
  check('on Mon', '2026-11-09', { text: 'Mon' });
  check('Tuesday', '2026-11-03', { uncertain: true }); // the same weekday: today, but unsure
  check('next Friday', '2026-11-13', { uncertain: true });
  check('next Tuesday', '2026-11-10', { uncertain: true });
  check('last Friday', '2026-10-30', { past: true });
  check('this week', '2026-11-06');
  check('by the end of the week', '2026-11-06');
  check('EOW', '2026-11-06');
  check('end of the week', '2026-11-13', {}, at(2026, 11, 7)); // on a Saturday: the coming Friday
  check('this weekend', '2026-11-07');
  check('this weekend', '2026-11-08', {}, at(2026, 11, 8)); // on a Sunday: today
  check('next week', '2026-11-09', { precision: 'week' });
  check('next week', '2026-11-09', { precision: 'week' }, at(2026, 11, 8));
  check('next month', '2026-12-01', { precision: 'month' });
  check('by end of the month', '2026-11-30', { precision: 'day' });
  check('in December', '2026-12-01', { precision: 'month', text: 'December' });
  check('by end of March', '2027-03-31', { precision: 'month', text: 'end of March' });
  check('early March', '2027-03-01', { precision: 'month' });
  check('mid-March', '2027-03-15', { precision: 'month' });
  check('in December 2027', '2027-12-01', { precision: 'month', text: 'December 2027' });
  check('October 2027', '2027-10-01', { precision: 'month' });
  for (const s of ['today', 'tonight', 'by EOD', 'by end of day', 'by COB', 'this afternoon']) check(s, '2026-11-03');
  check('tomorrow', '2026-11-04');
  check('by the day after tomorrow', '2026-11-05', { text: 'the day after tomorrow' });
});

test('a time written next to the date is kept', () => {
  assert.strictEqual(one('a site meeting on Wednesday at 10am').time, '10am');
  assert.strictEqual(one('by 5pm on Friday').time, '5pm');
  assert.strictEqual(one('Friday 9:30 works').time, '9:30');
  assert.strictEqual(one('ready tomorrow after 2pm').time, '2pm');
  assert.strictEqual(one('Offer ends midnight tonight').time, 'midnight');
  assert.strictEqual(one('Friday 17 October, 3.30pm').time, '3.30pm');
  assert.strictEqual(one('by Friday').time, null);
});

test('cue rules: a date is a deadline only with a cue word in the 4 words before it, or inside an ask', () => {
  // "December" with no cue word is not a deadline; "due in December" is.
  assert.deepStrictEqual(deadlines('New guidance is expected in December.'), []);
  const [due] = deadlines('New guidance is due in December.');
  assert.deepStrictEqual([due.cue, due.day, due.precision, due.source, due.sentence], ['due', '2026-12-01', 'month', 'body', 'New guidance is due in December.']);
  assert.deepStrictEqual(deadlines('The skip arrives on Friday.'), []);
  assert.strictEqual(deadlines('Please send it by Friday.')[0].cue, 'by');
  assert.strictEqual(deadlines('Deadline: 10 November').at(0).cue, 'deadline');
  assert.strictEqual(deadlines('Fri 13 Nov is the deadline.').at(0).cue, 'deadline');
  assert.strictEqual(deadlines('Friday at the latest.').at(0).cue, 'deadline');
  assert.strictEqual(deadlines('Send it no later than 10 November.').at(0).cue, 'no later than');
  assert.strictEqual(deadlines('Your policy expires on 30 November.').at(0).cue, 'expires');
  assert.strictEqual(deadlines('Applications close on 30 November.').at(0).cue, 'close');
  // A cue five or more words back doesn't count.
  assert.deepStrictEqual(deadlines('We will pay the balance of the account in full on 30 November.'), []);
  // Inside an ask, no cue is needed.
  const ask = 'Can you come round on Friday to take a look?';
  const [inAsk] = deadlines(ask, TUE_3_NOV, { questions: [ask] });
  assert.deepStrictEqual([inAsk.source, inAsk.cue, inAsk.day], ['ask', null, '2026-11-06']);
  // The same sentence when it isn't one of the asks: not a deadline.
  assert.deepStrictEqual(deadlines('Sam comes round on Friday to take a look.'), []);
  // The subject counts too (with any "RE:"/"Fwd:" taken off).
  const [subj] = findDeadlines({ subject: 'RE: Invoice due 7 Nov' }, TUE_3_NOV);
  assert.deepStrictEqual([subj.source, subj.cue, subj.day, subj.sentence], ['subject', 'due', '2026-11-07', 'Invoice due 7 Nov']);
  assert.deepStrictEqual(findDeadlines({ subject: 'Meeting Friday' }, TUE_3_NOV), []);
  // "until" is a cue, but not after "away", "closed" and the like.
  assert.deepStrictEqual(deadlines("I'm away until Monday."), []);
  assert.deepStrictEqual(deadlines('The yard is closed until Monday.'), []);
  assert.strictEqual(deadlines('You have until Friday to reply.')[0].cue, 'until');
  // The same date twice is one deadline, from the first sentence it appears in.
  const twice = deadlines('Your return must be submitted by 31 January 2027. You must also pay by 31 January 2027.');
  assert.strictEqual(twice.length, 1);
  assert.match(twice[0].sentence, /^Your return/);
  assert.deepStrictEqual(Object.keys(twice[0]).sort(), ['cue', 'day', 'precision', 'relative', 'sentence', 'source', 'text', 'time', 'uncertain']);
});

test('past tense: a date for something that already happened is not a deadline', () => {
  // demo-1's "on Friday" is about a meeting that already happened.
  const demo1 = `Hi Will,

I hope this email finds you well and that you had a lovely weekend.

Just wanted to reach out regarding the Harrow extension. We had a look at the drawings with the team on Friday.

Could you send over the revised drawings showing the steel beam position? We'll need them before we can finalise anything.

Let me know if you have any questions.

Kind regards,
Sarah Collins`;
  assert.deepStrictEqual(cleanedDeadlines(demo1, at(2026, 11, 2)), []);
  const past = findDates('We had a look at the drawings with the team on Friday.', TUE_3_NOV)[0];
  assert.deepStrictEqual([past.past, past.day], [true, '2026-10-30']);
  // Inside an ask, but about the past.
  for (const q of ['Did you get the parcel I sent on Monday?', 'Could you send the drawings we discussed on Friday?']) {
    assert.deepStrictEqual(deadlines(q, TUE_3_NOV, { questions: [q] }), [], q);
  }
  // An ask about the future still counts.
  const q = 'Could you come round on Friday?';
  assert.strictEqual(deadlines(q, TUE_3_NOV, { questions: [q] }).length, 1);
  // A deadline that has passed is still a deadline (it is overdue).
  const [overdue] = deadlines('Your payment was due on Monday, please pay now.');
  assert.deepStrictEqual([overdue.cue, overdue.day], ['due', '2026-11-02']);
});

test('the demo inbox: deadlines are real days, have a cue or an ask, and weekday and date agree', () => {
  const DAY_NAMES = /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[^\n]*\d/i;
  let total = 0;
  for (const m of demo) {
    const c = clean({ text: m.text, html: m.html, subject: m.subject, from: m.from.address });
    const found = findDeadlines({ subject: m.subject, body: c.body, questions: c.questions, actions: c.actions }, m.date);
    for (const d of found) {
      total++;
      assert.strictEqual(dayKey(d.day), d.day, `${m.id}: ${d.text}`);
      assert.ok(['subject', 'ask', 'body'].includes(d.source));
      assert.ok(['day', 'week', 'month'].includes(d.precision));
      assert.ok(d.cue || d.source === 'ask', `${m.id}: ${d.text} has a cue or is in an ask`);
      assert.ok(d.sentence.toLowerCase().includes(d.text.toLowerCase()), `${m.id}: ${d.text} is in its sentence`);
      if (DAY_NAMES.test(d.text)) assert.strictEqual(d.uncertain, false, `${m.id}: ${d.text} is on the right weekday`);
    }
    if (m.id === 'demo-1') assert.deepStrictEqual(found, [], 'demo-1 only mentions a past Friday');
    const confirm = /proceed by (\w+ \d+\w\w \w+)/.exec(m.text);
    if (m.id === 'demo-2' && confirm) {
      const d = found.find((x) => x.text === confirm[1]);
      assert.ok(d, `demo-2 has the ${confirm[1]} deadline`);
      const n = daysBetween(dayKey(m.date), d.day);
      assert.ok(n >= 1 && n <= 9 && d.cue === 'by' && !d.uncertain, `${confirm[1]} is ${n} days on`);
      assert.strictEqual(new Date(`${d.day}T12:00`).getDay(), 5);
    }
  }
  assert.ok(total >= 5, `the demo has deadlines (${total})`);
});

test('odd input never throws and long text is quick', () => {
  for (const s of [null, undefined, 42, {}, '', '   ']) assert.deepStrictEqual(findDates(s, TUE_3_NOV), []);
  for (const e of [null, undefined, 42, 'text', {}, { body: 42, questions: 'x', actions: [null, 5] }]) {
    assert.deepStrictEqual(findDeadlines(e, TUE_3_NOV), []);
  }
  // An invalid sent date means "now".
  assert.deepStrictEqual(days('today', 'not a date'), [dayKey(Date.now())]);
  assert.deepStrictEqual(days('today', null), [dayKey(Date.now())]);
  const start = Date.now();
  findDeadlines({ body: 'Please pay by Friday 13/11, or within 3 working days of 1 December 2026. '.repeat(3000) }, TUE_3_NOV);
  findDates('by Friday, '.repeat(5000), TUE_3_NOV);
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
});
