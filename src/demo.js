// Sample inbox so the app can be tried without connecting an account. Every date is worked
// out from the current time, so the deadlines in the demo always look current.
//
// Exports the array of RawEmail v3 objects (ids demo-1 to demo-17). Extra, non-enumerable
// properties: `ME` (the demo user), `build(now)` (the same emails for another time) and
// `facts` (the dates written into the emails, as text and as 'YYYY-MM-DD', for tests).

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const ME = Object.freeze({ name: 'Will Wright', address: 'will@example.com' });

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
// "Friday 6th November"
const longDate = (d) => `${WEEKDAYS[d.getDay()]} ${ordinal(d.getDate())} ${MONTHS[d.getMonth()]}`;
// "11 November 2026"
const plainDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
// "Wed, 14 Oct 2026 at 16:05", as mail apps write it in quoted and forwarded headers
const headerDate = (d) => `${SHORT_DAYS[d.getDay()]}, ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const person = (name, address) => ({ name, address });
const NO_HEADERS = Object.freeze({ listUnsubscribe: null, listId: null, precedence: null, autoSubmitted: null });
const listHeaders = (unsubscribe, listId = null) => ({ listUnsubscribe: unsubscribe, listId, precedence: 'bulk', autoSubmitted: null });

/** The demo inbox as it would look at `now`. */
function build(now = Date.now()) {
  const at = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const today = new Date(now);
  // A local day n days from today (at noon, so DST can't move it to another day).
  const day = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n, 12);

  // Sarah wants an answer by the first Friday at least 2 days away; the job starts 17 days later.
  const toFriday = (5 - today.getDay() + 7) % 7;
  const confirmBy = day(toFriday >= 2 ? toFriday : toFriday + 7);
  const startDate = day(Math.round((confirmBy - day(0)) / DAY) + 17);
  // Will's reply with the drawings, quoted at the bottom of demo-2 (see demo-sent.js).
  const willReplied = new Date(now - 27 * HOUR);

  // Self Assessment: the next 31 January, for the tax year that ended the April before.
  let taxYear = today.getFullYear();
  if (today > new Date(taxYear, 0, 31, 23, 59, 59)) taxYear += 1;

  // VAT return: due on the 7th of the first month at least 10 days away, for the quarter
  // that ended a month before; Priya's missing receipts are from the middle of that quarter.
  let vatDue = new Date(today.getFullYear(), today.getMonth(), 7, 12);
  while (vatDue - today < 10 * DAY) vatDue = new Date(vatDue.getFullYear(), vatDue.getMonth() + 1, 7, 12);
  const receiptsMonth = MONTHS[(vatDue.getMonth() + 9) % 12];

  // Planning decision sent 21 days ago; appeals are allowed within 28 days of it.
  const decided = new Date(day(-21).setHours(16, 5, 0, 0));
  const appealBy = day(7);

  // Weekly Builder: last month's figures, and guidance expected in the month after next.
  const lastMonth = MONTHS[(today.getMonth() + 11) % 12];
  const guidanceMonth = MONTHS[(today.getMonth() + 2) % 12];

  const email = (fields) => ({
    messageId: `<${fields.id}@demo.clearmail.invalid>`,
    uid: null,
    replyTo: null,
    to: [{ ...ME }],
    cc: [],
    seen: false,
    flagged: false,
    importance: 'normal',
    focused: true,
    conversationId: `conv-${fields.id}`,
    inReplyTo: null,
    references: [],
    headers: { ...NO_HEADERS },
    webLink: null,
    attachments: [],
    html: '',
    ...fields,
    receivedAt: fields.date,
  });

  const weeklyBuilder = (id, hoursAgo, subject, text) => email({
    id,
    from: person('The Weekly Builder', 'newsletter@weeklybuilder.com'),
    subject,
    date: at(hoursAgo),
    focused: false,
    headers: listHeaders('<https://weeklybuilder.com/unsubscribe>', '<weekly.weeklybuilder.com>'),
    text,
  });

  const taxDeadline = new Date(taxYear, 0, 31, 12);
  const facts = {
    confirmBy: longDate(confirmBy),
    confirmByDay: dayKey(confirmBy),
    startDate: longDate(startDate),
    startDay: dayKey(startDate),
    taxDeadline: plainDate(taxDeadline),
    taxDeadlineDay: dayKey(taxDeadline),
    vatDue: `${vatDue.getDate()} ${MONTHS[vatDue.getMonth()]}`,
    vatDueDay: dayKey(vatDue),
    receiptsMonth,
    appealBy: plainDate(appealBy),
    appealByDay: dayKey(appealBy),
    decided: headerDate(decided),
  };

  const list = [
    email({
      id: 'demo-1',
      from: person('Sarah Collins', 'sarah.collins@brightbuild.co.uk'),
      subject: 'RE: Site visit + quote for the Harrow extension',
      date: at(30),
      seen: true,
      conversationId: 'conv-harrow',
      text: `Hi Will,

I hope this email finds you well and that you had a lovely weekend.

Just wanted to reach out regarding the Harrow extension. We had a look at the drawings with the team on Friday.

Could you send over the revised drawings showing the steel beam position? We'll need them before we can finalise anything.

Let me know if you have any questions.

Kind regards,
Sarah Collins
Project Coordinator | BrightBuild Ltd
Registered in England No. 0123456. This email and any attachments are confidential and intended solely for the intended recipient.`,
    }),
    email({
      id: 'demo-2',
      from: person('Sarah Collins', 'sarah.collins@brightbuild.co.uk'),
      subject: 'RE: Site visit + quote for the Harrow extension',
      date: at(3),
      conversationId: 'conv-harrow',
      inReplyTo: '<harrow-drawings@example.com>',
      attachments: [{ filename: 'Harrow-quote-v2.pdf', size: 183000 }],
      text: `Hi Will,

I hope you're well and thank you so much for getting back to me so promptly, it's really appreciated.

Following on from our conversation last week, and further to the drawings you kindly sent over, I'm pleased to say that we've now had the opportunity to review everything internally with the wider team. I've attached the revised quote, which comes to £14,750 including VAT. This is slightly higher than the initial estimate, mainly because of the additional steelwork that was identified.

In terms of next steps, we would need you to confirm you're happy to proceed by ${longDate(confirmBy)} so that we can hold the start date of ${longDate(startDate)}. If we don't hear back by then, we may have to release the slot to another client, as our schedule is quite busy at the moment.

Also, would you be able to make a site meeting on Wednesday at 10am to go over the access arrangements?

Please don't hesitate to get in touch if you have any questions at all.

Looking forward to hearing from you.

Kind regards,
Sarah

On ${headerDate(willReplied)}, Will Wright <will@example.com> wrote:
> Hi Sarah, drawings attached. Thanks, Will
> Previous message text...`,
    }),
    email({
      id: 'demo-3',
      from: person('Dad', 'dad@example.com'),
      subject: 'Sunday',
      date: at(20),
      text: `Hello son

Mum says are you coming for lunch on Sunday? We're doing a roast at 1pm. Bring the kids if you can. Can you pick up some milk on the way?

Love Dad

Sent from my iPhone`,
    }),
    email({
      id: 'demo-4',
      from: person('HMRC', 'noreply@notifications.service.gov.uk'),
      subject: 'Action required: your Self Assessment tax return',
      date: at(48),
      headers: { ...NO_HEADERS, listUnsubscribe: '<https://www.notifications.service.gov.uk/unsubscribe>' },
      text: `Dear Customer,

This is a reminder that your online Self Assessment tax return for the ${taxYear - 2} to ${taxYear - 1} tax year must be submitted by ${facts.taxDeadline}.

You must also pay any tax you owe by ${facts.taxDeadline}. If you miss the deadline you may have to pay a penalty of £100.

Sign in to your account at https://www.gov.uk/log-in-file-self-assessment-tax-return to file your return.

Do not reply to this email. This mailbox is not monitored.

HM Revenue and Customs`,
    }),
    email({
      id: 'demo-5',
      from: person('Screwfix', 'orders@screwfix.com'),
      subject: 'Your order confirmation #SF-4471920',
      date: at(6),
      seen: true,
      focused: false,
      headers: listHeaders('<https://www.screwfix.com/unsubscribe>'),
      text: `Thanks for your order!

Order number: SF-4471920
DeWalt 18V Combi Drill x1 — £129.99
Total paid: £129.99

Your order will be ready to collect from Harrow Wealdstone tomorrow after 2pm. Please bring your order number and photo ID.

View your order: https://www.screwfix.com/orders/SF-4471920?utm_source=email&utm_campaign=order_conf

You are receiving this email because you placed an order with Screwfix. Privacy policy | Unsubscribe | Manage preferences`,
    }),
    weeklyBuilder('demo-6', 12, '🏗️ This week in construction: 12 trends you can\'t ignore', `View this email in your browser

Happy Monday!

Welcome to another bumper edition of The Weekly Builder. We've got loads for you this week so grab a cuppa and settle in.

Timber prices fell 4% in ${lastMonth}, the third monthly drop in a row.

New Part L building regulations guidance is expected in ${guidanceMonth}.

Our top 12 trends piece is here: https://weeklybuilder.com/trends?ref=nl

Have a great week!

The Weekly Builder team
You are receiving this because you signed up at weeklybuilder.com. Unsubscribe here.`),
    email({
      id: 'demo-7',
      from: person('Priya Shah', 'priya@shahaccounting.co.uk'),
      subject: 'Quick one — VAT receipts',
      date: at(1),
      text: `Hi Will,

Hope all is good with you!

Quick one — I'm missing receipts for three purchases in ${receiptsMonth} totalling £412.60. Could you dig them out and upload them to the shared folder by end of the week? The VAT return is due on ${facts.vatDue} so I need a few days to get it done.

Also, did you buy the van outright or is it on finance?

Cheers,
Priya

--
Priya Shah ACCA
Shah Accounting | 020 7946 0000`,
    }),
    email({
      id: 'demo-8',
      from: person('Jo Patel', 'jo.patel@example.com'),
      subject: 'Fwd: Planning decision - 12 Elm Road',
      date: at(2),
      importance: 'high',
      attachments: [{ filename: 'Decision-notice-26-1234.pdf', size: 96000 }],
      text: `Hi Will,

FYI - see below. Can you get the appeal in? I'm away until Monday.

Thanks,
Jo

---------- Forwarded message ---------
From: Northfield Borough Council Planning <planning@northfield-council.example>
Date: ${headerDate(decided)}
Subject: Planning decision - 12 Elm Road
To: Jo Patel <jo.patel@example.com>

Dear Ms Patel,

Application 26/1234: single-storey rear extension at 12 Elm Road.

We have refused this application because the extension is too close to the boundary with number 14.

You can appeal within 28 days of this notice, so by ${facts.appealBy}. The appeal fee of £462 is non-refundable.

Yours sincerely,
Planning Services
Northfield Borough Council

This email and any attachments are confidential and intended solely for the intended recipient.`,
    }),
    email({
      id: 'demo-9',
      from: person('TradeHub Supplies', 'offers@tradehub.example'),
      subject: 'Today only: 30% off power tools 🔨',
      date: at(5),
      focused: false,
      headers: listHeaders('<https://tradehub.example/unsubscribe>'),
      text: `View this email in your browser

Today only: 30% off all power tools. Offer ends midnight tonight!

Combi drills, impact drivers, circular saws and more, all with free next-day delivery.

Shop now: https://tradehub.example/sale?utm_source=email&utm_campaign=flash

You're receiving this because you have a TradeHub account. Unsubscribe | Manage preferences`,
    }),
    weeklyBuilder('demo-10', 7 * 24 + 12, 'This week in construction: why skip hire costs keep rising', `View this email in your browser

Skip hire prices rose again this month, with landfill tax the main driver.

Read the full story: https://weeklybuilder.com/skips?ref=nl

The Weekly Builder team
You are receiving this because you signed up at weeklybuilder.com. Unsubscribe here.`),
    weeklyBuilder('demo-11', 14 * 24 + 12, 'This week in construction: 5 apps every builder needs', `View this email in your browser

We tried 30 apps so you don't have to. Here are the five worth installing.

See the list: https://weeklybuilder.com/apps?ref=nl

The Weekly Builder team
You are receiving this because you signed up at weeklybuilder.com. Unsubscribe here.`),
    weeklyBuilder('demo-12', 21 * 24 + 12, 'This week in construction: the brick shortage explained', `View this email in your browser

Why are bricks so hard to get? We asked three suppliers.

Read more: https://weeklybuilder.com/bricks?ref=nl

The Weekly Builder team
You are receiving this because you signed up at weeklybuilder.com. Unsubscribe here.`),
    email({
      id: 'demo-13',
      from: person('Kestrel Bank', 'alerts@kestrelbank.example'),
      subject: 'Your credit card payment is due soon',
      date: at(4),
      headers: listHeaders('<https://kestrelbank.example/preferences>'),
      text: `Hi Will,

Your Kestrel credit card statement is ready.

Statement balance: £312.48
Your minimum payment of £25.00 is due in 3 days.

To pay, open the Kestrel Bank app or sign in at kestrelbank.example. We will never ask for your password or PIN by email.

Switch your mortgage to Kestrel today and get a £250 cashback voucher. Terms apply.

You're receiving this email because you have a Kestrel Bank credit card. Unsubscribe from marketing emails.`,
    }),
    email({
      id: 'demo-14',
      from: person('Mark Ellis', 'mark@ellisheating.example'),
      to: [person('Tom Baker', 'tom@bakerplumbing.example')],
      cc: [{ ...ME }],
      subject: 'Boiler swap at 12 Elm Road',
      date: at(9),
      text: `Hi Tom,

Can you confirm you'll be on site on Thursday at 8am to drain the system?

Will, I've copied you in so you know the plan. Nothing needed from you.

Thanks,
Mark`,
    }),
    email({
      id: 'demo-15',
      from: person('Amy Turner', 'amy.turner@example.net'),
      subject: 'Loft conversion quote?',
      date: at(26),
      text: `Hi,

Do you do loft conversions? We're in Harrow and looking for quotes. Could you come round next week to take a look?

Thanks,
Amy
07700 900456`,
    }),
    email({
      id: 'demo-16',
      from: person('Kestrel Bank', 'noreply@kestrelbank.example'),
      subject: 'Your Kestrel Bank verification code',
      date: at(50),
      seen: true,
      text: `Your verification code is 482913. It expires in 10 minutes.

Kestrel Bank will never call you to ask for this code. Don't share it with anyone.`,
    }),
    email({
      id: 'demo-17',
      from: person('Hoodly', 'notifications@hoodly.example'),
      subject: 'Sam Reid and 4 others reacted to your post',
      date: at(8),
      focused: false,
      headers: listHeaders('<https://hoodly.example/unsubscribe>'),
      text: `Sam Reid and 4 others reacted to your post in Harrow Tradespeople: "Anyone know a good scaffolder in Harrow?"

See what they said: https://hoodly.example/p/88231?utm_source=email

You're receiving this because you're a member of Harrow Tradespeople. Unsubscribe or manage email preferences.`,
    }),
  ];
  Object.defineProperty(list, 'facts', { value: Object.freeze(facts) });
  return list;
}

const emails = build(Date.now());
Object.defineProperties(emails, {
  ME: { value: ME },
  build: { value: build },
});

module.exports = emails;
