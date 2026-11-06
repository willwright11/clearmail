process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeBriefSettings, slotOn, catchUpDeadline, dueBrief, nextBriefTime, briefWindow, briefCounts, briefText,
  failedBriefText, createBriefScheduler, dayKey, BRIEF_DEFAULTS,
} = require('../src/brief');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A London wall-clock time (the TZ is set above), so DST is handled as on a real Mac.
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const WEEKDAYS = { enabled: true, time: '07:30', days: [1, 2, 3, 4, 5], openAtLogin: false };
const EVERY_DAY = { enabled: true, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], openAtLogin: false };

// ---------- settings ----------

test('normalizeBriefSettings: defaults, tidying and partial updates', () => {
  const defaults = { enabled: false, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], openAtLogin: false };
  assert.deepStrictEqual(normalizeBriefSettings(undefined), defaults);
  assert.deepStrictEqual(normalizeBriefSettings({}), defaults);
  assert.deepStrictEqual(normalizeBriefSettings({ enabled: true, time: ' 06:45 ', days: [5, 1, 1, 3], openAtLogin: true }),
    { enabled: true, time: '06:45', days: [1, 3, 5], openAtLogin: true });
  const base = { enabled: true, time: '08:00', days: [1, 2], openAtLogin: true };
  assert.deepStrictEqual(normalizeBriefSettings({ time: '09:15' }, { base }), { ...base, time: '09:15' });
  assert.deepStrictEqual(normalizeBriefSettings({ enabled: false, days: [] }, { base }), { enabled: false, time: '08:00', days: [], openAtLogin: true });
  // The result is a fresh object: changing it never changes the defaults.
  normalizeBriefSettings({}).days.push(9);
  assert.deepStrictEqual(BRIEF_DEFAULTS.days, [0, 1, 2, 3, 4, 5, 6]);
});

test('normalizeBriefSettings: bad values give messages a person can act on', () => {
  for (const time of ['7:30', '24:00', '07:60', '0730', 730, '', null]) {
    assert.throws(() => normalizeBriefSettings({ time }), { message: 'Choose a time for the morning brief, like 07:30.' }, String(time));
  }
  for (const days of [[7], ['1'], 'mon', [1.5], [-1], null]) {
    assert.throws(() => normalizeBriefSettings({ days }), { message: 'Choose the days for the morning brief from the list.' }, String(days));
  }
  assert.throws(() => normalizeBriefSettings({ enabled: true, days: [] }), { message: 'Choose at least one day for the morning brief, or turn it off.' });
  assert.throws(() => normalizeBriefSettings({ enabled: 'yes' }), /couldn't be saved/);
  assert.throws(() => normalizeBriefSettings('on'), /couldn't be saved/);
  for (const bad of [{ time: '25:00', days: [8, 2], enabled: 'x' }, 'on', [1], 42]) {
    const s = normalizeBriefSettings(bad, { lenient: true });
    assert.strictEqual(typeof s.enabled, 'boolean');
    assert.match(s.time, /^\d\d:\d\d$/);
  }
  assert.deepStrictEqual(normalizeBriefSettings({ time: '25:00', days: [8, 2] }, { lenient: true }).days, [2]);
});

// ---------- timing ----------

test('slotOn: the chosen time on that day, in local time across DST', () => {
  assert.strictEqual(slotOn('2026-11-03', WEEKDAYS), Date.UTC(2026, 10, 3, 7, 30));
  assert.strictEqual(slotOn(local(2026, 11, 3, 22), WEEKDAYS), Date.UTC(2026, 10, 3, 7, 30));
  assert.strictEqual(slotOn('2026-07-01', WEEKDAYS), Date.UTC(2026, 6, 1, 6, 30), 'BST');
  assert.strictEqual(slotOn('2026-10-25', WEEKDAYS), Date.UTC(2026, 9, 25, 7, 30), 'the day the clocks go back');
  assert.strictEqual(slotOn('2027-03-28', WEEKDAYS), Date.UTC(2027, 2, 28, 6, 30), 'the day the clocks go forward');
});

test('catchUpDeadline: 18:00 or slot + 6 h, whichever is later, never past midnight', () => {
  assert.strictEqual(catchUpDeadline(local(2026, 11, 3, 7, 30)), local(2026, 11, 3, 18));
  assert.strictEqual(catchUpDeadline(local(2026, 11, 3, 14)), local(2026, 11, 3, 20));
  assert.strictEqual(catchUpDeadline(local(2026, 11, 3, 20)), local(2026, 11, 3, 23, 59) + 59_999);
  assert.strictEqual(catchUpDeadline(local(2026, 10, 25, 20)), local(2026, 10, 25, 23, 59) + 59_999);
});

test('dueBrief: before and after the slot, catch-up at 09:00 but not 18:30, and once a day', () => {
  const day = (h, min) => local(2026, 11, 3, h, min); // a Tuesday
  assert.strictEqual(dueBrief(day(7, 29), WEEKDAYS, null), null);
  assert.deepStrictEqual(dueBrief(day(7, 30), WEEKDAYS, null), { slot: day(7, 30) });
  assert.deepStrictEqual(dueBrief(day(9, 0), WEEKDAYS, null), { slot: day(7, 30) });
  assert.deepStrictEqual(dueBrief(day(18, 0), WEEKDAYS, null), { slot: day(7, 30) });
  assert.strictEqual(dueBrief(day(18, 30), WEEKDAYS, null), null);
  // Already sent today; yesterday's doesn't count.
  assert.strictEqual(dueBrief(day(9, 0), WEEKDAYS, day(7, 30)), null);
  assert.deepStrictEqual(dueBrief(day(9, 0), WEEKDAYS, day(7, 30) - DAY), { slot: day(7, 30) });
  assert.deepStrictEqual(dueBrief(day(9, 0), WEEKDAYS, new Date(day(7, 30) - DAY).toISOString()), { slot: day(7, 30) });
  // Once a day even after the time is changed.
  assert.strictEqual(dueBrief(day(9, 5), { ...WEEKDAYS, time: '09:00' }, day(7, 30)), null);
  // Weekends off, and off means off.
  assert.strictEqual(dueBrief(local(2026, 11, 7, 9), WEEKDAYS, null), null);
  assert.strictEqual(dueBrief(day(9, 0), { ...WEEKDAYS, enabled: false }, null), null);
  assert.strictEqual(dueBrief(day(9, 0), undefined, null), null);
});

test('dueBrief: a 20:00 brief catches up until 23:59, not after midnight', () => {
  const s = { ...EVERY_DAY, time: '20:00' };
  assert.deepStrictEqual(dueBrief(local(2026, 11, 3, 23, 59), s, null), { slot: local(2026, 11, 3, 20) });
  assert.strictEqual(dueBrief(local(2026, 11, 4, 0, 1), s, null), null);
});

test('dueBrief: on both DST change days the brief comes at 07:30 on the clock', () => {
  assert.strictEqual(dueBrief(Date.UTC(2026, 9, 25, 7, 29), EVERY_DAY, null), null);
  assert.deepStrictEqual(dueBrief(Date.UTC(2026, 9, 25, 7, 30), EVERY_DAY, null), { slot: Date.UTC(2026, 9, 25, 7, 30) });
  assert.strictEqual(dueBrief(Date.UTC(2027, 2, 28, 6, 29), EVERY_DAY, null), null);
  assert.deepStrictEqual(dueBrief(Date.UTC(2027, 2, 28, 6, 30), EVERY_DAY, null), { slot: Date.UTC(2027, 2, 28, 6, 30) });
  // Saturday's brief (BST) and Sunday's (GMT) are different days.
  assert.deepStrictEqual(dueBrief(Date.UTC(2026, 9, 25, 8), EVERY_DAY, Date.UTC(2026, 9, 24, 6, 30)), { slot: Date.UTC(2026, 9, 25, 7, 30) });
});

test('nextBriefTime: Friday rolls over to Monday; due now gives now; off gives null', () => {
  const friSlot = local(2026, 11, 6, 7, 30);
  const monSlot = local(2026, 11, 9, 7, 30);
  assert.strictEqual(nextBriefTime(local(2026, 11, 6, 9), WEEKDAYS, friSlot), monSlot);
  assert.strictEqual(nextBriefTime(local(2026, 11, 6, 6), WEEKDAYS, null), friSlot);
  assert.strictEqual(nextBriefTime(local(2026, 11, 6, 9), WEEKDAYS, null), local(2026, 11, 6, 9), 'missed this morning: due now');
  assert.strictEqual(nextBriefTime(local(2026, 11, 6, 19), WEEKDAYS, null), monSlot, 'too late today');
  assert.strictEqual(nextBriefTime(local(2026, 11, 7, 12), WEEKDAYS, null), monSlot);
  assert.strictEqual(nextBriefTime(local(2026, 11, 6, 9), { ...WEEKDAYS, days: [5] }, friSlot), local(2026, 11, 13, 7, 30), 'a week later');
  assert.strictEqual(nextBriefTime(local(2026, 11, 6, 9), { ...WEEKDAYS, enabled: false }, null), null);
  assert.strictEqual(nextBriefTime(local(2026, 11, 6, 9), { ...WEEKDAYS, days: [] }, null), null);
  // Across the clocks going forward: Sunday 07:30 BST.
  assert.strictEqual(nextBriefTime(local(2027, 3, 27, 8), EVERY_DAY, local(2027, 3, 27, 7, 30)), Date.UTC(2027, 2, 28, 6, 30));
});

test('dayKey: local calendar days', () => {
  assert.strictEqual(dayKey(Date.UTC(2026, 9, 24, 23, 30)), '2026-10-25', '00:30 BST is already the 25th in London');
  assert.strictEqual(dayKey(null), null);
  assert.strictEqual(dayKey('nonsense'), null);
});

// ---------- window, counts and text ----------

test('briefWindow: since the last brief, the same window again later that day, else the last 24 hours', () => {
  const now = local(2026, 11, 3, 12); // Tuesday noon
  assert.deepStrictEqual(briefWindow(now, null), { since: now - DAY, label: 'in the last 24 hours' });
  assert.deepStrictEqual(briefWindow(now, {}), { since: now - DAY, label: 'in the last 24 hours' });
  const yesterday = local(2026, 11, 2, 7, 31);
  assert.deepStrictEqual(briefWindow(now, { lastAt: yesterday, lastSince: yesterday - DAY }), { since: yesterday, label: 'since yesterday 07:31' });
  // Today's brief already went out: keep the window it covered.
  const todayAt = local(2026, 11, 3, 7, 31);
  assert.deepStrictEqual(briefWindow(now, { lastAt: todayAt, lastSince: yesterday }), { since: yesterday, label: 'since yesterday 07:31' });
  assert.deepStrictEqual(briefWindow(now, { lastAt: new Date(todayAt).toISOString(), lastSince: new Date(yesterday).toISOString() }).since, yesterday);
  assert.strictEqual(briefWindow(now, { lastAt: todayAt }).label, 'in the last 24 hours', 'no saved window: fall back');
  assert.strictEqual(briefWindow(now, { lastAt: local(2026, 10, 31, 7, 30) }).label, 'since Saturday 07:30');
  assert.strictEqual(briefWindow(now, { lastAt: local(2026, 10, 24, 7, 30) }).label, 'since 24 Oct 07:30');
  assert.strictEqual(briefWindow(now, { lastAt: local(2026, 11, 3, 8, 5), lastSince: local(2026, 11, 3, 6) }).label, 'since 06:00');
  assert.strictEqual(briefWindow(now, { lastAt: now + HOUR }).label, 'in the last 24 hours', 'a time in the future is ignored');
});

const NOW = local(2026, 11, 3, 7, 30);
const SINCE = local(2026, 11, 2, 7, 30);
const item = (bucket, hoursAgo, extra = {}) => ({
  id: `${bucket}-${hoursAgo}`,
  from: { name: 'Sarah Collins', address: 'sarah.collins@brightbuild.co.uk' },
  subject: 'Secret quote for the Harrow extension',
  receivedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  triage: { bucket, reasons: ['Asks you to do something'] },
  done: false,
  ...extra,
});

test('briefCounts: needs you over 30 days, the rest since the window, done left out', () => {
  const items = [
    item('needs-you', 2), item('needs-you', 30), item('needs-you', 24 * 20), item('needs-you', 24 * 40),
    item('needs-you', 3, { done: true }),
    item('worth-knowing', 1), item('worth-knowing', 10), item('worth-knowing', 30), item('worth-knowing', 4, { done: true }),
    item('noise', 1), item('noise', 2), item('noise', 25), { bucket: 'noise', date: new Date(NOW - HOUR).toISOString() },
    null, 'junk', { triage: {} },
  ];
  assert.deepStrictEqual(briefCounts(items, { since: SINCE, now: NOW }), { needsYou: 3, needsYouNew: 1, worthKnowing: 2, noise: 3, done: 2 });
  assert.deepStrictEqual(briefCounts(null, { since: SINCE, now: NOW }), { needsYou: 0, needsYouNew: 0, worthKnowing: 0, noise: 0, done: 0 });
});

test('briefCounts: a Needs-you email older than 30 days still counts when it is due soon, flagged or always important', () => {
  const old = (extra, triage = {}) => item('needs-you', 24 * 45, { ...extra, triage: { bucket: 'needs-you', reasons: ['Due soon'], codes: ['deadline-soon'], deadline: null, ...triage } });
  const due = (daysAway) => ({ text: '31 January 2027', day: '2027-01-31', label: 'Sun 31 Jan', daysAway, uncertain: false, time: null });
  const counted = (it) => briefCounts([it], { since: SINCE, now: NOW }).needsYou;
  assert.strictEqual(counted(old({})), 0, 'old and nothing at stake: left out, as before');
  assert.strictEqual(counted(old({}, { deadline: due(11) })), 1, 'due in 11 days');
  assert.strictEqual(counted(old({}, { deadline: due(14) })), 1);
  assert.strictEqual(counted(old({}, { deadline: due(0) })), 1, 'due today');
  assert.strictEqual(counted(old({}, { deadline: due(-3) })), 1, 'overdue');
  assert.strictEqual(counted(old({}, { deadline: due(15) })), 0, 'more than two weeks off');
  assert.strictEqual(counted(old({}, { deadline: { daysAway: NaN } })), 0);
  assert.strictEqual(counted(old({}, { codes: ['flagged'] })), 1, 'flagged in Outlook');
  assert.strictEqual(counted(old({ flagged: true })), 1);
  assert.strictEqual(counted(old({}, { codes: ['rule-important'] })), 1, 'from a sender marked always important');
  assert.strictEqual(counted(old({ senderRule: 'important' })), 1);
  assert.strictEqual(counted(old({ done: true }, { deadline: due(3) })), 0, 'done is done');
  // Only Needs you is counted this way; old Worth knowing stays out of the window.
  assert.strictEqual(briefCounts([item('worth-knowing', 24 * 45, { triage: { bucket: 'worth-knowing', deadline: due(3) } })], { since: SINCE, now: NOW }).worthKnowing, 0);
});

test("The HMRC reminder from November needs you in the brief on 20 January (real pipeline)", () => {
  const triage = require('../src/triage');
  const real = require('./fixtures/real-emails');
  // Received on 1 Nov 2026, about the 31 Jan 2027 deadline; the brief is on 20 Jan 2027 at 07:30.
  const now = local(2027, 1, 20, 7, 30);
  const raw = real.raw({
    id: 'hmrc-november', date: '2026-11-01T10:00:00.000Z', from: { name: 'HMRC', address: 'noreply@notifications.service.gov.uk' },
    subject: 'Action required: your Self Assessment tax return', headers: real.LU,
    text: 'Your online Self Assessment tax return must be submitted by 31 January 2027.',
  });
  const result = triage.triage(real.prepare(raw), { now, me: new Set([real.ME.address]), names: real.NAMES, historyKnown: true });
  assert.strictEqual(result.bucket, 'needs-you');
  assert.strictEqual(result.reasons[0], 'Due Sun 31 Jan');
  const view = { id: raw.id, receivedAt: raw.receivedAt, triage: result, done: false };
  const { since, label } = briefWindow(now, { lastAt: now - DAY, lastSince: now - 2 * DAY });
  const counts = briefCounts([view], { since, now });
  assert.deepStrictEqual(counts, { needsYou: 1, needsYouNew: 0, worthKnowing: 0, noise: 0, done: 0 });
  assert.strictEqual(briefText(counts, { sinceLabel: label }).body, '1 needs you');
});

test('briefText: counts with plurals, zeros left out, and the quiet and failed variants', () => {
  const text = (counts, opts) => briefText({ needsYou: 0, needsYouNew: 0, worthKnowing: 0, noise: 0, done: 0, ...counts }, opts);
  assert.deepStrictEqual(text({ needsYou: 2, worthKnowing: 5, noise: 23 }), { title: 'Morning brief', body: '2 need you · 5 worth knowing · 23 noise hidden' });
  assert.strictEqual(text({ needsYou: 1, worthKnowing: 1, noise: 1 }).body, '1 needs you · 1 worth knowing · 1 noise hidden');
  assert.strictEqual(text({ worthKnowing: 5, noise: 23 }).body, 'Nothing needs you · 5 worth knowing · 23 noise hidden');
  assert.strictEqual(text({ needsYou: 3 }).body, '3 need you');
  assert.strictEqual(text({ noise: 4 }).body, 'Nothing needs you · 4 noise hidden');
  assert.strictEqual(text({}).body, 'All quiet: no new email since yesterday.');
  assert.strictEqual(text({}, { sinceLabel: 'since Saturday 07:30' }).body, 'All quiet: no new email since Saturday 07:30.');
  assert.deepStrictEqual(text({ needsYou: 1 }, { failedAccounts: ['will@uni.ac.uk'] }), { title: 'Morning brief', body: '1 needs you', subtitle: "Couldn't check will@uni.ac.uk" });
  assert.strictEqual(text({}, { failedAccounts: ['will@uni.ac.uk'] }).body, 'Nothing new in the accounts ClearMail could check.');
  assert.strictEqual(text({}, { failedAccounts: ['a@x.com', 'b@y.com'] }).subtitle, "Couldn't check a@x.com or b@y.com");
  assert.strictEqual(text({}, { failedAccounts: ['a@x.com', 'b@y.com', 'c@z.com'] }).subtitle, "Couldn't check 3 of your accounts");
  assert.strictEqual(text({ needsYou: -1, worthKnowing: NaN, noise: 2.7 }).body, 'Nothing needs you · 2 noise hidden');
  assert.deepStrictEqual(failedBriefText(), { title: 'Morning brief', body: "Couldn't check your email. Open ClearMail to try again." });
});

test('briefText never contains a sender name or a subject', () => {
  const items = [item('needs-you', 2), item('worth-knowing', 3), item('noise', 4)];
  const out = briefText(briefCounts(items, { since: SINCE, now: NOW }), { failedAccounts: ['will@example.com'], sinceLabel: briefWindow(NOW, {}).label });
  const all = JSON.stringify(out);
  for (const secret of ['Sarah', 'Collins', 'brightbuild', 'Secret', 'Harrow', 'quote', 'Asks you']) assert.ok(!all.includes(secret), secret);
  assert.deepStrictEqual(Object.keys(out).sort(), ['body', 'subtitle', 'title']);
});

// ---------- the scheduler, with a fake clock ----------

function harness({ start = local(2026, 11, 3, 7), settings = { brief: EVERY_DAY }, saveState = true } = {}) {
  const h = {
    t: start,
    online: true,
    locked: false,
    settings,
    state: { lastSlot: null, lastAt: null, lastSince: null },
    calls: [],
    intervals: [],
    result: () => ({ ok: true }),
  };
  h.scheduler = createBriefScheduler({
    now: () => h.t,
    getSettings: () => h.settings,
    getBriefState: () => h.state,
    deliver: async (slot, opts) => {
      h.calls.push({ slot, at: h.t, ...opts });
      const res = await h.result(slot, opts);
      if (saveState && ((res && res.ok) || opts.final)) h.state = { lastSlot: slot, lastAt: h.t, lastSince: h.t - DAY };
      return res;
    },
    isOnline: () => h.online,
    isLocked: () => h.locked,
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      h.intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timer.cleared = true;
    },
  });
  h.at = (y, m, d, hh, mm) => {
    h.t = local(y, m, d, hh, mm);
    return h.scheduler.check();
  };
  return h;
}

test('scheduler: delivers once a day at the slot', async () => {
  const h = harness();
  assert.strictEqual(await h.scheduler.check(), 'not-due');
  assert.strictEqual(await h.at(2026, 11, 3, 7, 30), 'delivered');
  assert.deepStrictEqual(h.calls.map((c) => [c.slot, c.final, c.reason]), [[local(2026, 11, 3, 7, 30), false, 'poll']]);
  assert.strictEqual(await h.at(2026, 11, 3, 7, 31), 'not-due');
  assert.strictEqual(await h.at(2026, 11, 3, 12, 0), 'not-due');
  assert.strictEqual(await h.at(2026, 11, 4, 7, 29), 'not-due');
  assert.strictEqual(await h.at(2026, 11, 4, 7, 30), 'delivered');
  assert.strictEqual(h.calls.length, 2);
});

test('scheduler: never delivers twice in a day, even if saving the state failed', async () => {
  const h = harness({ saveState: false });
  assert.strictEqual(await h.at(2026, 11, 3, 7, 40), 'delivered');
  assert.strictEqual(await h.at(2026, 11, 3, 7, 41), 'not-due');
  assert.strictEqual(h.calls.length, 1);
});

test('scheduler: after sleeping through the slot, waking up delivers it', async () => {
  const h = harness({ start: local(2026, 11, 2, 23) });
  assert.strictEqual(await h.scheduler.check('poll'), 'not-due');
  h.t = local(2026, 11, 3, 8, 15); // the Mac slept all night
  assert.strictEqual(await h.scheduler.check('resume'), 'delivered');
  assert.deepStrictEqual([h.calls[0].slot, h.calls[0].reason], [local(2026, 11, 3, 7, 30), 'resume']);
});

test('scheduler: waits while offline or locked, without counting it as a try', async () => {
  const h = harness();
  h.online = false;
  for (let m = 30; m < 60; m += 5) assert.strictEqual(await h.at(2026, 11, 3, 7, m), 'waiting-offline');
  h.online = true;
  h.locked = true;
  assert.strictEqual(await h.at(2026, 11, 3, 8, 0), 'waiting-locked');
  assert.strictEqual(h.calls.length, 0);
  h.locked = false;
  assert.strictEqual(await h.at(2026, 11, 3, 8, 1), 'delivered');
  assert.deepStrictEqual(h.calls.map((c) => c.final), [false]);
});

test('scheduler: if the catch-up time passes while offline, that day is skipped silently', async () => {
  const h = harness();
  h.online = false;
  assert.strictEqual(await h.at(2026, 11, 3, 7, 31), 'waiting-offline');
  assert.strictEqual(await h.at(2026, 11, 3, 17, 59), 'waiting-offline');
  h.online = true;
  assert.strictEqual(await h.at(2026, 11, 3, 18, 1), 'not-due');
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(await h.at(2026, 11, 4, 7, 30), 'delivered');
});

test('scheduler: a failure is retried after 5 minutes; the 3rd failure shows the final notification', async () => {
  const h = harness();
  h.result = () => ({ ok: false });
  assert.strictEqual(await h.at(2026, 11, 3, 7, 31), 'failed');
  assert.strictEqual(await h.at(2026, 11, 3, 7, 33), 'not-due', 'too soon to try again');
  h.result = () => {
    throw new Error('Graph said no');
  };
  assert.strictEqual(await h.at(2026, 11, 3, 7, 36), 'failed', 'a thrown error counts as a failure');
  h.result = () => ({ ok: false });
  assert.strictEqual(await h.at(2026, 11, 3, 7, 41), 'failed');
  assert.deepStrictEqual(h.calls.map((c) => c.final), [false, false, false, true]);
  assert.ok(h.calls.every((c) => c.slot === local(2026, 11, 3, 7, 30)));
  // That day is over.
  h.result = () => ({ ok: true });
  assert.strictEqual(await h.at(2026, 11, 3, 7, 50), 'not-due');
  assert.strictEqual(await h.at(2026, 11, 3, 12, 0), 'not-due');
  assert.strictEqual(h.calls.length, 4);
  assert.strictEqual(await h.at(2026, 11, 4, 7, 30), 'delivered');
});

test('scheduler: turning the brief off stops a pending retry', async () => {
  const h = harness();
  h.result = () => ({ ok: false });
  assert.strictEqual(await h.at(2026, 11, 3, 7, 31), 'failed');
  h.settings = { brief: { ...EVERY_DAY, enabled: false } };
  assert.strictEqual(await h.at(2026, 11, 3, 7, 40), 'not-due');
  h.settings = { brief: EVERY_DAY };
  h.result = () => ({ ok: true });
  assert.strictEqual(await h.at(2026, 11, 3, 7, 45), 'delivered', 'turned back on the same morning: a fresh try');
  assert.deepStrictEqual(h.calls.map((c) => c.final), [false, false]);
});

test('scheduler: a failure caused by the connection dropping is not counted', async () => {
  const h = harness();
  h.result = () => {
    h.online = false;
    return { ok: false };
  };
  assert.strictEqual(await h.at(2026, 11, 3, 7, 31), 'waiting-offline');
  assert.strictEqual(await h.at(2026, 11, 3, 7, 32), 'waiting-offline');
  h.online = true;
  h.result = () => ({ ok: true });
  assert.strictEqual(await h.at(2026, 11, 3, 7, 33), 'delivered');
  assert.deepStrictEqual(h.calls.map((c) => c.final), [false, false]);
});

test('scheduler: retries carry on just past the catch-up time, then stop', async () => {
  const h = harness();
  h.result = () => ({ ok: false });
  assert.strictEqual(await h.at(2026, 11, 3, 17, 58), 'failed');
  assert.strictEqual(await h.at(2026, 11, 3, 18, 3), 'failed');
  assert.strictEqual(await h.at(2026, 11, 3, 18, 8), 'failed');
  assert.deepStrictEqual(h.calls.map((c) => c.final), [false, false, false, true]);
});

test('scheduler: a late brief that keeps failing gets its 3rd try and the final notice just after midnight', async () => {
  const h = harness({ settings: { brief: { ...EVERY_DAY, time: '23:50' } } });
  h.result = () => ({ ok: false });
  assert.strictEqual(await h.at(2026, 11, 3, 23, 50), 'failed');
  assert.strictEqual(await h.at(2026, 11, 3, 23, 55), 'failed');
  assert.strictEqual(await h.at(2026, 11, 4, 0, 0), 'failed', 'the 3rd try, after midnight');
  assert.deepStrictEqual(h.calls.map((c) => [c.slot, c.final]), [
    [local(2026, 11, 3, 23, 50), false], [local(2026, 11, 3, 23, 50), false], [local(2026, 11, 3, 23, 50), false], [local(2026, 11, 3, 23, 50), true],
  ]);
  // That brief is over, and the new day's comes at its own time.
  h.result = () => ({ ok: true });
  assert.strictEqual(await h.at(2026, 11, 4, 0, 5), 'not-due');
  assert.strictEqual(await h.at(2026, 11, 4, 23, 49), 'not-due');
  assert.strictEqual(await h.at(2026, 11, 4, 23, 50), 'delivered');
  assert.strictEqual(h.calls.at(-1).slot, local(2026, 11, 4, 23, 50));
});

test('scheduler: a late brief that fails once and then works just after midnight is delivered once', async () => {
  const h = harness({ settings: { brief: { ...EVERY_DAY, time: '23:58' } } });
  h.result = () => ({ ok: false });
  assert.strictEqual(await h.at(2026, 11, 3, 23, 58), 'failed');
  h.result = () => ({ ok: true });
  assert.strictEqual(await h.at(2026, 11, 4, 0, 3), 'delivered', "yesterday's brief, retried");
  assert.strictEqual(h.calls.at(-1).slot, local(2026, 11, 3, 23, 58));
  assert.strictEqual(await h.at(2026, 11, 4, 0, 10), 'not-due');
  // Past the retry window (the catch-up time plus two retries), a failure is not retried.
  const late = harness({ settings: { brief: { ...EVERY_DAY, time: '23:58' } } });
  late.result = () => ({ ok: false });
  assert.strictEqual(await late.at(2026, 11, 3, 23, 58), 'failed');
  late.result = () => ({ ok: true });
  assert.strictEqual(await late.at(2026, 11, 4, 0, 11), 'not-due');
  assert.strictEqual(late.calls.length, 1);
});

test('scheduler: two checks at once deliver only one brief', async () => {
  const h = harness({ start: local(2026, 11, 3, 7, 30) });
  let release;
  h.result = () => new Promise((resolve) => {
    release = () => resolve({ ok: true });
  });
  const first = h.scheduler.check('resume');
  const second = h.scheduler.check('unlock-screen');
  assert.strictEqual(await second, 'busy');
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.strictEqual(await first, 'delivered');
  assert.strictEqual(await h.scheduler.check('user-did-become-active'), 'not-due');
  assert.strictEqual(h.calls.length, 1);
});

test('scheduler: start polls every minute; stop stops it', async () => {
  const h = harness({ start: local(2026, 11, 3, 6) });
  assert.strictEqual(await h.scheduler.start(), 'not-due');
  assert.strictEqual(h.intervals.length, 1);
  assert.strictEqual(h.intervals[0].ms, 60_000);
  await h.scheduler.start();
  assert.strictEqual(h.intervals.length, 1, 'starting twice keeps one timer');
  h.t = local(2026, 11, 3, 7, 30);
  h.intervals[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(h.calls.length, 1);
  h.scheduler.stop();
  assert.strictEqual(h.intervals[0].cleared, true);
  h.t = local(2026, 11, 4, 7, 30);
  assert.strictEqual(await h.scheduler.check('resume'), 'not-due', 'stopped: nothing is delivered');
  assert.strictEqual(h.calls.length, 1);
  // Started again, it carries on.
  assert.strictEqual(await h.scheduler.start(), 'delivered');
  assert.strictEqual(h.intervals.length, 2);
});

test('scheduler: off, or settings that cannot be read, means nothing is sent', async () => {
  const h = harness({ start: local(2026, 11, 3, 8), settings: { brief: { ...EVERY_DAY, enabled: false } } });
  assert.strictEqual(await h.scheduler.check(), 'not-due');
  h.scheduler = createBriefScheduler({
    now: () => h.t,
    getSettings: () => {
      throw new Error('disk full');
    },
    getBriefState: () => ({}),
    deliver: () => ({ ok: true }),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.strictEqual(await h.scheduler.check(), 'not-due');
  } finally {
    console.warn = warn;
  }
  // The brief settings can also be passed directly, not inside the whole settings.
  const direct = harness({ start: local(2026, 11, 3, 8), settings: EVERY_DAY });
  assert.strictEqual(await direct.scheduler.check(), 'delivered');
  assert.strictEqual(h.calls.length, 0);
});

test('scheduler: the clocks going back still give one brief at 07:30 on the clock', async () => {
  const h = harness({ start: Date.UTC(2026, 9, 24, 6, 30) }); // Sat 07:30 BST
  assert.strictEqual(await h.scheduler.check(), 'delivered');
  h.t = Date.UTC(2026, 9, 25, 6, 45); // Sun 06:45 GMT
  assert.strictEqual(await h.scheduler.check(), 'not-due');
  h.t = Date.UTC(2026, 9, 25, 7, 30); // Sun 07:30 GMT
  assert.strictEqual(await h.scheduler.check(), 'delivered');
  assert.deepStrictEqual(h.calls.map((c) => c.slot), [Date.UTC(2026, 9, 24, 6, 30), Date.UTC(2026, 9, 25, 7, 30)]);
});
