// The demo user's Sent history, so the demo inbox can show "You've written to them 6 times"
// and "You've already replied". Same shape as fetchSentHistory() returns (a SentBatch), with
// dates worked out from the demo emails, so they always fit around them.

const demo = require('./demo');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * @typedef {object} SentEntry
 * @property {string} from  the user's address, lower-case
 * @property {string[]} to  lower-case addresses
 * @property {string} date  ISO
 * @property {string|null} conversationId
 * @property {string|null} inReplyTo
 *
 * @typedef {{ cursor: null, full: boolean, entries: SentEntry[] }} SentBatch
 */

/**
 * The demo Sent folder: to Sarah 6 times (one of them the reply to demo-1, sent after it and
 * before demo-2), to Dad, to Priya and to Jo.
 * @param {{ emails?: object[], now?: number }} [opts]  the demo emails it should fit around
 * @returns {SentBatch}
 */
function buildSentBatch({ now = Date.now(), emails = demo.build(now) } = {}) {
  const me = demo.ME.address;
  const at = (daysAgo, hour = 10) => {
    const d = new Date(now - daysAgo * DAY);
    d.setHours(hour, 15, 0, 0);
    return d.toISOString();
  };
  const entry = (to, date, conversationId = null, inReplyTo = null) => ({ from: me, to: [to], date, conversationId, inReplyTo });

  const sarah = 'sarah.collins@brightbuild.co.uk';
  const first = emails.find((m) => m.id === 'demo-1');
  const firstAt = first ? Date.parse(first.receivedAt || first.date) : now - 30 * HOUR;
  const entries = [
    entry('priya@shahaccounting.co.uk', at(62), 'conv-priya-q2'),
    entry(sarah, at(41), 'conv-harrow-intro'),
    entry(sarah, at(34), 'conv-harrow-intro'),
    entry('priya@shahaccounting.co.uk', at(31), 'conv-priya-q3'),
    entry('jo.patel@example.com', at(25), 'conv-elm-road'),
    entry(sarah, at(20), 'conv-harrow-survey'),
    entry('priya@shahaccounting.co.uk', at(15), 'conv-priya-van'),
    entry(sarah, at(13), 'conv-harrow-survey'),
    entry('dad@example.com', at(9, 19), 'conv-dad-birthday'),
    entry(sarah, at(6), 'conv-harrow'),
    entry('jo.patel@example.com', at(4), 'conv-elm-road'),
    entry('dad@example.com', at(2, 20), 'conv-dad-birthday'),
    // Will's reply to demo-1, with the drawings: 3 hours after it arrived.
    entry(sarah, new Date(firstAt + 3 * HOUR).toISOString(), first ? first.conversationId : 'conv-harrow', first ? first.messageId : null),
  ];
  entries.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { cursor: null, full: true, entries };
}

module.exports = {
  ME: demo.ME,
  sentBatch: buildSentBatch({ emails: demo }),
  buildSentBatch,
};
