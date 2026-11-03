// The morning brief: when it's due, which emails it covers, and the notification text.
// Pure functions plus a small scheduler whose clock and timers are passed in, so it can be
// tested with a fake clock. The text never names senders or subjects, because macOS can
// show it on the lock screen.
//
// Times are milliseconds since 1970 (Date.now()); "days" are local calendar days.

/**
 * @typedef {object} BriefSettings
 * @property {boolean} enabled
 * @property {string} time  'HH:MM', 24-hour
 * @property {number[]} days  the days it comes, as Date#getDay() numbers (0 = Sunday)
 * @property {boolean} openAtLogin
 *
 * @typedef {object} BriefState  (state.json `brief`)
 * @property {number|string|null} lastSlot  the slot of the last brief that went out
 * @property {number|string|null} lastAt  when it went out
 * @property {number|string|null} lastSince  the start of the window that brief covered
 *
 * @typedef {object} BriefCounts
 * @property {number} needsYou  not done, received within the last 30 days
 * @property {number} needsYouNew  the same, received since the window started
 * @property {number} worthKnowing  received since the window started, not done
 * @property {number} noise  received since the window started, not done
 * @property {number} done  emails marked done
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DEFAULTS = Object.freeze({ enabled: false, time: '07:30', days: ALL_DAYS, openAtLogin: false });
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value) return Date.parse(value);
  return NaN;
}

const pad = (n) => String(n).padStart(2, '0');

/** The local calendar day of a time, as 'YYYY-MM-DD' (null for no time). */
function dayKey(value) {
  const t = toMs(value);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A local date (y, m, d) from a time, a Date or a 'YYYY-MM-DD' key.
function localDay(day) {
  const m = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (m) return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const d = new Date(toMs(day));
  return [d.getFullYear(), d.getMonth(), d.getDate()];
}

const clockTime = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Checks and fills in the brief settings. Missing values come from `base` (the current
 * settings) and then the defaults. A bad value throws an Error whose message can be shown
 * to the user; with { lenient: true } (for a file read from disk) it is replaced instead.
 * @returns {BriefSettings}
 */
function normalizeBriefSettings(raw, { base, lenient = false } = {}) {
  const start = base && typeof base === 'object' && base !== raw ? normalizeBriefSettings(base, { lenient: true }) : DEFAULTS;
  const fail = (message) => {
    if (!lenient) throw new Error(message);
    return undefined;
  };
  if (raw == null) return { ...start, days: [...start.days] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail("The morning brief settings couldn't be saved. Please try again.");
    return { ...start, days: [...start.days] };
  }

  const flag = (key) => {
    if (raw[key] === undefined) return start[key];
    if (typeof raw[key] === 'boolean') return raw[key];
    fail("The morning brief settings couldn't be saved. Please try again.");
    return start[key];
  };
  const enabled = flag('enabled');
  const openAtLogin = flag('openAtLogin');

  let time = start.time;
  if (raw.time !== undefined) {
    const value = typeof raw.time === 'string' ? raw.time.trim() : '';
    if (TIME_RE.test(value)) time = value;
    else fail('Choose a time for the morning brief, like 07:30.');
  }

  let days = [...start.days];
  if (raw.days !== undefined) {
    const list = Array.isArray(raw.days) ? raw.days : null;
    const valid = list ? list.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    if (!list || valid.length !== list.length) fail('Choose the days for the morning brief from the list.');
    if (list) days = [...new Set(valid)].sort((a, b) => a - b);
  }
  if (enabled && !days.length && !lenient) fail('Choose at least one day for the morning brief, or turn it off.');

  return { enabled, time, days, openAtLogin };
}

/** The brief's time on a given day (a time, a Date or 'YYYY-MM-DD'), in local time. */
function slotOn(day, settings) {
  const s = normalizeBriefSettings(settings, { lenient: true });
  const [y, m, d] = localDay(day);
  const [hh, mm] = s.time.split(':').map(Number);
  return new Date(y, m, d, hh, mm, 0, 0).getTime();
}

/**
 * The latest a missed brief still goes out: 18:00 or six hours after the slot, whichever is
 * later, but never past the end of that day.
 */
function catchUpDeadline(slot) {
  const [y, m, d] = localDay(slot);
  const endOfDay = new Date(y, m, d, 23, 59, 59, 999).getTime();
  const sixPm = new Date(y, m, d, 18, 0, 0, 0).getTime();
  return Math.min(endOfDay, Math.max(sixPm, slot + 6 * HOUR));
}

/**
 * Whether a brief is due now: it's on, today is one of its days, the slot has passed but its
 * catch-up time hasn't, and no brief has gone out today.
 * @returns {{slot: number}|null}
 */
function dueBrief(now, settings, lastSlot) {
  const s = normalizeBriefSettings(settings, { lenient: true });
  const t = toMs(now);
  if (!s.enabled || Number.isNaN(t) || !s.days.includes(new Date(t).getDay())) return null;
  const slot = slotOn(t, s);
  if (t < slot || t > catchUpDeadline(slot)) return null;
  if (dayKey(lastSlot) === dayKey(slot)) return null;
  return { slot };
}

/**
 * When the next brief will go out (looking up to 8 days ahead), or null when it's off.
 * A brief that is due right now gives `now`.
 */
function nextBriefTime(now, settings, lastSlot) {
  const s = normalizeBriefSettings(settings, { lenient: true });
  const t = toMs(now);
  if (!s.enabled || !s.days.length || Number.isNaN(t)) return null;
  const [y, m, d] = localDay(t);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(y, m, d + i, 12);
    if (!s.days.includes(day.getDay())) continue;
    const slot = slotOn(day.getTime(), s);
    if (dayKey(lastSlot) === dayKey(slot)) continue;
    if (slot > t) return slot;
    if (t <= catchUpDeadline(slot)) return t;
  }
  return null;
}

// "since 07:30", "since yesterday 07:30", "since Monday 07:30", "since 28 Oct 07:30"
function sinceLabel(since, now) {
  const days = Math.round((Date.UTC(...localDay(now)) - Date.UTC(...localDay(since))) / DAY);
  const d = new Date(since);
  const when = days <= 0 ? '' : days === 1 ? 'yesterday ' : days < 7 ? `${DAY_NAMES[d.getDay()]} ` : `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} `;
  return `since ${when}${clockTime(since)}`;
}

/**
 * Which emails count as new for the brief: those since the last brief, or from the last
 * 24 hours when there hasn't been one. Opened again later the same day, it keeps the window
 * of that day's brief.
 * @param {BriefState} state
 * @returns {{since: number, label: string}}
 */
function briefWindow(now, state) {
  let t = toMs(now);
  if (Number.isNaN(t)) t = Date.now();
  const st = state && typeof state === 'object' ? state : {};
  const lastAt = toMs(st.lastAt);
  let since = NaN;
  if (!Number.isNaN(lastAt) && lastAt <= t) since = dayKey(lastAt) === dayKey(t) ? toMs(st.lastSince) : lastAt;
  if (Number.isNaN(since) || since > t) return { since: t - DAY, label: 'in the last 24 hours' };
  return { since, label: sinceLabel(since, t) };
}

/**
 * Counts for the brief. Items are EmailViews: `triage.bucket` (or `bucket`), `receivedAt`
 * (or `date`) and `done`.
 * @returns {BriefCounts}
 */
function briefCounts(items, { since, now } = {}) {
  let t = toMs(now);
  if (Number.isNaN(t)) t = Date.now();
  let from = toMs(since);
  if (Number.isNaN(from)) from = t - DAY;
  const counts = { needsYou: 0, needsYouNew: 0, worthKnowing: 0, noise: 0, done: 0 };
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    if (it.done === true) {
      counts.done++;
      continue;
    }
    const bucket = (it.triage && it.triage.bucket) || it.bucket;
    let received = toMs(it.receivedAt || it.date);
    if (Number.isNaN(received)) received = t;
    const isNew = received > from;
    if (bucket === 'needs-you') {
      if (t - received > 30 * DAY) continue;
      counts.needsYou++;
      if (isNew) counts.needsYouNew++;
    } else if (bucket === 'worth-knowing' && isNew) counts.worthKnowing++;
    else if (bucket === 'noise' && isNew) counts.noise++;
  }
  return counts;
}

// An account address made safe for one line of a notification.
const accountName = (a) => String(a).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);

/**
 * The notification. It holds counts and the user's own account addresses only, never a
 * sender's name or a subject.
 * @param {BriefCounts} counts
 * @param {{failedAccounts?: string[], sinceLabel?: string}} [opts]
 * @returns {{title: string, body: string, subtitle?: string}}
 */
function briefText(counts, { failedAccounts = [], sinceLabel: since } = {}) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const c = counts && typeof counts === 'object' ? counts : {};
  const [needs, worth, noise] = [n(c.needsYou), n(c.worthKnowing), n(c.noise)];
  const failed = (Array.isArray(failedAccounts) ? failedAccounts : []).filter((a) => typeof a === 'string').map(accountName).filter(Boolean);

  let body;
  if (!needs && !worth && !noise) {
    body = failed.length
      ? 'Nothing new in the accounts ClearMail could check.'
      : `All quiet: no new email ${typeof since === 'string' && since ? since : 'since yesterday'}.`;
  } else {
    const parts = [needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : 'Nothing needs you'];
    if (worth) parts.push(`${worth} worth knowing`);
    if (noise) parts.push(`${noise} noise hidden`);
    body = parts.join(' · ');
  }
  const out = { title: 'Morning brief', body };
  if (failed.length === 1) out.subtitle = `Couldn't check ${failed[0]}`;
  else if (failed.length === 2) out.subtitle = `Couldn't check ${failed[0]} or ${failed[1]}`;
  else if (failed.length > 2) out.subtitle = `Couldn't check ${failed.length} of your accounts`;
  return out;
}

/** The notification after three failed tries. */
function failedBriefText() {
  return { title: 'Morning brief', body: "Couldn't check your email. Open ClearMail to try again." };
}

/**
 * Checks once a minute (by the wall clock, so it survives sleep and App Nap) whether the
 * brief is due, and delivers it. Waits while offline or while the screen is locked. A failed
 * delivery is tried again after 5 minutes; after the 3rd failure `deliver(slot, {final:true})`
 * shows a "couldn't check your email" notification and that day is over.
 *
 * deliver(slot, {final, reason}) returns (or resolves to) {ok}. It should save the brief state
 * (lastSlot etc.); the scheduler also remembers the day itself, so it never delivers twice.
 *
 * check(reason) resolves to 'delivered' | 'not-due' | 'waiting-offline' | 'waiting-locked' |
 * 'busy' | 'failed' and never rejects.
 */
function createBriefScheduler({
  now = Date.now,
  getSettings,
  getBriefState,
  deliver,
  isOnline = () => true,
  isLocked = () => false,
  setInterval: startTimer = setInterval,
  clearInterval: stopTimer = clearInterval,
  intervalMs = MINUTE,
  retryMs = 5 * MINUTE,
  attempts = 3,
} = {}) {
  let timer = null;
  let stopped = false;
  let busy = false;
  let deliveredSlot = null; // the last slot delivered (or given up on) by this scheduler
  let failure = null; // { slot, count, retryAt } while a brief is being retried

  const ask = async (fn, fallback) => {
    try {
      return typeof fn === 'function' ? await fn() : fallback;
    } catch {
      return fallback;
    }
  };

  // The later of the saved lastSlot and the one remembered here.
  const lastSlot = (state) => {
    const saved = toMs(state && state.lastSlot);
    if (deliveredSlot === null) return Number.isNaN(saved) ? null : saved;
    return Number.isNaN(saved) ? deliveredSlot : Math.max(saved, deliveredSlot);
  };

  const send = async (slot, opts) => {
    try {
      const res = await deliver(slot, opts);
      return Boolean(res && res.ok);
    } catch (err) {
      console.warn('The morning brief could not be delivered:', err && err.message);
      return false;
    }
  };

  async function run(reason) {
    const t = now();
    let settings;
    let state;
    try {
      settings = getSettings();
      state = typeof getBriefState === 'function' ? getBriefState() || {} : {};
    } catch (err) {
      console.warn('The morning brief settings could not be read:', err && err.message);
      return 'not-due';
    }
    const brief = normalizeBriefSettings(settings && settings.brief !== undefined ? settings.brief : settings, { lenient: true });
    if (!brief.enabled) {
      failure = null; // turned off: no retries either
      return 'not-due';
    }
    const last = lastSlot(state);

    let slot;
    if (failure && dayKey(failure.slot) === dayKey(t) && dayKey(last) !== dayKey(failure.slot)
      && t <= catchUpDeadline(failure.slot) + (attempts - 1) * retryMs) {
      // A brief that failed earlier is tried again, at most every retryMs.
      if (t < failure.retryAt) return 'not-due';
      slot = failure.slot;
    } else {
      failure = null;
      const due = dueBrief(t, brief, last);
      if (!due) return 'not-due';
      slot = due.slot;
    }

    // Waiting doesn't count as a try. If the catch-up time passes meanwhile, it's skipped.
    if (!(await ask(isOnline, true))) return 'waiting-offline';
    if (await ask(isLocked, false)) return 'waiting-locked';

    if (await send(slot, { final: false, reason })) {
      deliveredSlot = slot;
      failure = null;
      return 'delivered';
    }
    // Going offline mid-way isn't counted either: it's tried again once back online.
    if (!(await ask(isOnline, true))) return 'waiting-offline';
    const count = (failure && failure.slot === slot ? failure.count : 0) + 1;
    if (count >= attempts) {
      failure = null;
      deliveredSlot = slot; // that day is over, whatever the final notification does
      await send(slot, { final: true, reason });
      return 'failed';
    }
    failure = { slot, count, retryAt: now() + retryMs };
    return 'failed';
  }

  async function check(reason = 'poll') {
    if (busy) return 'busy';
    if (stopped) return 'not-due';
    busy = true;
    try {
      return await run(reason);
    } catch (err) {
      console.warn('The morning brief check failed:', err && err.message);
      return 'failed';
    } finally {
      busy = false;
    }
  }

  function start() {
    stopped = false;
    if (timer === null) {
      timer = startTimer(() => {
        check('poll');
      }, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return check('start');
  }

  function stop() {
    stopped = true;
    if (timer !== null) stopTimer(timer);
    timer = null;
  }

  return { start, stop, check };
}

module.exports = {
  normalizeBriefSettings,
  slotOn,
  catchUpDeadline,
  dueBrief,
  nextBriefTime,
  briefWindow,
  briefCounts,
  briefText,
  failedBriefText,
  createBriefScheduler,
  dayKey,
  BRIEF_DEFAULTS: DEFAULTS,
};
