// Builders and sample emails for test/triage.test.js. The clock is fixed (Tue 3 Nov 2026,
// 09:00 in London) so the tests never depend on the real date. `cleaned` and `deadlines`
// are written by hand, as cleaner.clean() and dates.findDeadlines() would return them, so
// these tests only exercise the triage rules.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 3, 9, 0); // Tue 3 Nov 2026 09:00 GMT
const ME = { name: 'Will Wright', address: 'will@example.com' };

// How many times the user has written to each person (as in src/demo-sent.js).
const HISTORY = {
  'sarah.collins@brightbuild.co.uk': 6,
  'dad@example.com': 2,
  'priya@shahaccounting.co.uk': 3,
  'jo.patel@example.com': 2,
};

const pad = (n) => String(n).padStart(2, '0');
const localDayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// 'YYYY-MM-DD' n days from a day key.
const dayPlus = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const TODAY = localDayKey(NOW); // '2026-11-03'

const NO_HEADERS = { listUnsubscribe: null, listId: null, precedence: null, autoSubmitted: null };
const LIST_UNSUBSCRIBE = '<https://example.com/unsubscribe>';

let counter = 0;

/**
 * A TriageInput. `cleaned` fields can be given at the top level (body, questions, actions,
 * amounts, category, urgency); `hoursAgo` sets the dates; `listUnsubscribe: true` adds the header.
 */
function email(o = {}) {
  const {
    body = '', questions = [], actions = [], amounts = [], category = 'person', urgency = 'normal',
    hoursAgo = 2, listUnsubscribe, headers, cleaned, ...rest
  } = o;
  const received = new Date(NOW - hoursAgo * HOUR).toISOString();
  return {
    id: `acc:m${++counter}`,
    messageId: null,
    uid: null,
    from: { name: 'Someone', address: 'someone@example.com' },
    replyTo: null,
    to: [{ ...ME }],
    cc: [],
    subject: '',
    date: received,
    receivedAt: received,
    seen: false,
    flagged: false,
    importance: 'normal',
    focused: true,
    conversationId: null,
    inReplyTo: null,
    webLink: null,
    attachments: [],
    text: body,
    headers: headers === null ? null : { ...NO_HEADERS, ...(listUnsubscribe ? { listUnsubscribe: LIST_UNSUBSCRIBE } : {}), ...headers },
    cleaned: { body, questions, actions, amounts, category, urgency, keyPoints: [], links: [], dates: [], times: [], ...cleaned },
    deadlines: [],
    ...rest,
  };
}

/** A Deadline as dates.findDeadlines() returns it; `day` is an offset from TODAY or a day key. */
function deadline(day, o = {}) {
  return {
    text: o.text || 'Friday',
    sentence: o.sentence || '',
    source: o.source || 'body',
    cue: o.cue === undefined ? 'by' : o.cue,
    day: typeof day === 'number' ? dayPlus(TODAY, day) : day,
    time: o.time || null,
    precision: o.precision || 'day',
    uncertain: o.uncertain === true,
    relative: o.relative === true,
  };
}

/**
 * A TriageContext. `wrote` maps address → times written (default HISTORY), `replied` maps
 * email id → when the user replied, `names` are the user's first names (default ['will'],
 * as main.js derives them from the account name 'Will Wright').
 */
function ctx(o = {}) {
  const now = o.now ?? NOW;
  const wrote = o.wrote || HISTORY;
  const replied = o.replied || {};
  return {
    now,
    today: o.today || localDayKey(now),
    me: new Set([ME.address, ...(o.me || [])]),
    names: o.names || ['will'],
    rules: o.rules || {},
    notNoise: new Set(o.notNoise || []),
    wroteTo: (addr) => wrote[addr] || 0,
    historyKnown: o.historyKnown ?? true,
    repliedAt: (input) => replied[input.id] || null,
  };
}

// ---------- the fixture emails (each call returns a fresh copy) ----------

const sarah = () => email({
  from: { name: 'Sarah Collins', address: 'sarah.collins@brightbuild.co.uk' },
  subject: 'RE: Site visit + quote for the Harrow extension',
  hoursAgo: 3,
  body: "I've attached the revised quote, which comes to £14,750 including VAT. Please confirm you're happy to proceed by Friday 6th November so that we can hold the start date. Would you be able to make a site meeting on Wednesday at 10am?",
  actions: ["Please confirm you're happy to proceed by Friday 6th November so that we can hold the start date."],
  questions: ['Would you be able to make a site meeting on Wednesday at 10am?'],
  amounts: ['£14,750'],
  deadlines: [deadline(3, { text: 'Friday 6th November', cue: 'by', source: 'ask', sentence: "Please confirm you're happy to proceed by Friday 6th November so that we can hold the start date." })],
});

const dad = () => email({
  from: { name: 'Dad', address: 'dad@example.com' },
  subject: 'Sunday',
  hoursAgo: 20,
  body: 'Mum says are you coming for lunch on Sunday? We\'re doing a roast at 1pm. Can you pick up some milk on the way?',
  questions: ['Mum says are you coming for lunch on Sunday?', 'Can you pick up some milk on the way?'],
});

const HMRC_DUE = '2027-01-31';
const hmrc = (o = {}) => email({
  from: { name: 'HMRC', address: 'noreply@notifications.service.gov.uk' },
  subject: 'Action required: your Self Assessment tax return',
  hoursAgo: 48,
  listUnsubscribe: true,
  category: 'notification',
  urgency: 'high',
  body: 'This is a reminder that your online Self Assessment tax return for the 2025 to 2026 tax year must be submitted by 31 January 2027. You must also pay any tax you owe by 31 January 2027. If you miss the deadline you may have to pay a penalty of £100.',
  deadlines: [
    deadline(HMRC_DUE, { text: '31 January 2027', cue: 'by', sentence: 'This is a reminder that your online Self Assessment tax return for the 2025 to 2026 tax year must be submitted by 31 January 2027.' }),
    deadline(HMRC_DUE, { text: '31 January 2027', cue: 'by', sentence: 'You must also pay any tax you owe by 31 January 2027.' }),
  ],
  ...o,
});

const screwfix = () => email({
  from: { name: 'Screwfix', address: 'orders@screwfix.com' },
  subject: 'Your order confirmation #SF-4471920',
  hoursAgo: 6,
  seen: true,
  listUnsubscribe: true,
  category: 'receipt',
  body: 'Thanks for your order! Order number: SF-4471920. Total paid: £129.99. Your order will be ready to collect from Harrow Wealdstone tomorrow after 2pm.',
  amounts: ['£129.99'],
});

const promo = () => email({
  from: { name: 'TradeHub Supplies', address: 'offers@tradehub.example' },
  subject: 'Today only: 30% off power tools',
  hoursAgo: 5,
  listUnsubscribe: true,
  focused: false,
  category: 'promo',
  body: 'Today only: 30% off all power tools, ends midnight tonight. Offer ends at midnight, so your order must be in by midnight. Shop now.',
  // A marketing "deadline" with obligation words ("your order"): it must not count.
  deadlines: [deadline(0, { text: 'midnight', cue: 'by', sentence: 'Offer ends at midnight, so your order must be in by midnight.' })],
});

const weeklyBuilder = (hoursAgo = 12, seen = false) => email({
  from: { name: 'The Weekly Builder', address: 'newsletter@weeklybuilder.com' },
  subject: 'This week in construction',
  hoursAgo,
  seen,
  listUnsubscribe: true,
  focused: false,
  category: 'newsletter',
  body: 'Timber prices fell 4% in September. Our top 12 trends piece is here.',
});

// The current issue plus three older ones; `readOlder` of the older ones were opened.
const weeklyBuilderIssues = (readOlder = 0) => [
  weeklyBuilder(12),
  ...[7, 14, 21].map((days, i) => weeklyBuilder(days * 24 + 12, i < readOlder)),
];

const ccFyi = () => email({
  from: { name: 'Mark Ellis', address: 'mark@ellisheating.example' },
  to: [{ name: 'Tom Baker', address: 'tom@bakerplumbing.example' }],
  cc: [{ ...ME }],
  subject: 'Boiler swap at 12 Elm Road',
  hoursAgo: 9,
  body: "Can you confirm you'll be on site on Thursday at 8am, Tom? Will, I've copied you in so you know the plan.",
  questions: ["Can you confirm you'll be on site on Thursday at 8am, Tom?"],
});

const bank = () => email({
  from: { name: 'Kestrel Bank', address: 'alerts@kestrelbank.example' },
  subject: 'Your credit card payment is due soon',
  hoursAgo: 4,
  listUnsubscribe: true,
  category: 'promo',
  body: 'Your Kestrel credit card statement is ready. Your minimum payment of £25.00 is due in 3 days. Switch your mortgage today and get a £250 cashback voucher. Offer ends 30 November.',
  amounts: ['£25.00', '£250'],
  deadlines: [
    deadline(3, { text: 'in 3 days', cue: 'due', relative: true, sentence: 'Your minimum payment of £25.00 is due in 3 days.' }),
    deadline('2026-11-30', { text: '30 November', cue: 'by', sentence: 'Offer ends 30 November.' }),
  ],
});

const stranger = (o = {}) => email({
  from: { name: 'Amy Turner', address: 'amy.turner@example.net' },
  subject: 'Loft conversion quote?',
  hoursAgo: 26,
  body: "Do you do loft conversions? We're in Harrow and looking for quotes.",
  questions: ['Do you do loft conversions?'],
  ...o,
});

const strangerBankDetails = () => stranger({
  subject: 'Deposit',
  body: 'Could you send me your bank details so I can pay the deposit?',
  questions: ['Could you send me your bank details so I can pay the deposit?'],
});

const twenty = Array.from({ length: 19 }, (_, i) => ({ name: `Person ${i}`, address: `person${i}@example.org` }));
const strangerGroup = (o = {}) => stranger({ to: [{ ...ME }, ...twenty], ...o });

const strangerGroupCoursework = () => strangerGroup({
  subject: 'Coursework',
  body: 'Please submit your coursework by Friday. Any questions?',
  actions: ['Please submit your coursework by Friday.'],
  questions: ['Any questions?'],
  deadlines: [deadline(3, { text: 'Friday', cue: 'by', source: 'ask', sentence: 'Please submit your coursework by Friday.' })],
});

const demo1 = () => email({
  id: 'demo:demo-1',
  from: { name: 'Sarah Collins', address: 'sarah.collins@brightbuild.co.uk' },
  subject: 'RE: Site visit + quote for the Harrow extension',
  hoursAgo: 30,
  seen: true,
  body: 'About the Harrow extension. Could you send over the revised drawings showing the steel beam position?',
  questions: ['Could you send over the revised drawings showing the steel beam position?'],
});
const DEMO1_REPLIED = new Date(NOW - 27 * HOUR).toISOString();

const oldCode = () => email({
  from: { name: 'Kestrel Bank', address: 'noreply@kestrelbank.example' },
  subject: 'Your Kestrel Bank verification code',
  hoursAgo: 50,
  seen: true,
  category: 'notification',
  body: 'Your verification code is 482913. It expires in 10 minutes.',
});

const freshSignIn = () => email({
  from: { name: 'Microsoft account team', address: 'account-security-noreply@accountprotection.microsoft.com' },
  subject: 'New sign-in to your Microsoft account',
  hoursAgo: 3,
  category: 'notification',
  body: 'We noticed a new sign-in to your account from a Mac in London. If this was you, you can ignore this email.',
});

const automated = (o = {}) => email({
  from: { name: 'Parcel Tracker', address: 'notifications@parceltracker.example' },
  subject: 'Your parcel has been delivered',
  hoursAgo: 10,
  category: 'notification',
  focused: false,
  body: 'Your parcel was delivered to your front door at 14:02.',
  ...o,
});

const personOther = () => email({
  from: { name: 'Lee Grant', address: 'lee@grantroofing.example' },
  subject: 'Photos from the job',
  hoursAgo: 30,
  focused: false,
  body: 'Here are the photos from the roof job last week.',
});

const flaggedNewsletter = () => ({ ...weeklyBuilder(30), flagged: true });

// ---------- from the adversarial review (v0.3) ----------

// A school asks parents to return a form by Friday: bulk mail, and the deadline is an ask.
const SCHOOL_ASK = 'Please return the signed consent form by Friday 6 November.';
const schoolTrip = () => email({
  from: { name: "St Mary's Primary", address: 'office@stmarys.sch.uk' },
  subject: 'Year 5 trip to the Science Museum',
  listUnsubscribe: true,
  category: 'newsletter',
  body: `Year 5 are visiting the Science Museum on Wednesday 18 November. ${SCHOOL_ASK} The cost is £12.50, payable on ParentPay.`,
  actions: [SCHOOL_ASK],
  deadlines: [deadline(3, { text: 'Friday 6 November', cue: 'by', source: 'ask', sentence: SCHOOL_ASK })],
});

// DPD holds a parcel until an import fee is paid.
const FEE_ASK = 'Pay the import fee of £18.40 within 3 days to release it, or it will be returned.';
const importFee = () => email({
  from: { name: 'DPD', address: 'notifications@dpd.co.uk' },
  subject: 'Action needed: pay import fee for your parcel',
  focused: false,
  category: 'notification',
  body: `Your parcel from Germany is being held. ${FEE_ASK}`,
  actions: [FEE_ASK],
  amounts: ['£18.40'],
  deadlines: [deadline(3, { text: 'within 3 days', cue: 'within', source: 'ask', relative: true, sentence: FEE_ASK })],
});

// A delivery notice: the cleaner calls "…delivered by Friday" an action, but it isn't a task.
const DELIVERY = 'Your order will be delivered by Friday 6 November.';
const delivery = (o = {}) => email({
  from: { name: 'Parcel Shop', address: 'notifications@parcelshop.example' },
  subject: 'Your order is on its way',
  focused: false,
  category: 'notification',
  body: `Good news! ${DELIVERY}`,
  actions: [DELIVERY],
  deadlines: [deadline(3, { text: 'Friday 6 November', cue: 'by', source: 'ask', sentence: DELIVERY })],
  ...o,
});

// A bank asks whether a card payment was really the user's.
const fraudCheck = (o = {}) => email({
  from: { name: 'Kestrel Bank', address: 'alerts@kestrelbank.example' },
  subject: 'Did you make this payment?',
  focused: false,
  category: 'notification',
  body: "We've noticed an unusual payment on your card ending 4421: £499.00 at CURRYS ONLINE. If this wasn't you, call us now.",
  amounts: ['£499.00'],
  ...o,
});

// A holiday cottage's arrival details, with a key-safe code.
const cottageCode = (o = {}) => email({
  from: { name: 'Lakeside Cottages', address: 'noreply@lakesidecottages.example' },
  subject: 'Your arrival details for Friday',
  hoursAgo: 40,
  category: 'notification',
  body: 'Your stay at Heron Cottage starts on Friday 6 November. Check-in is from 4pm. Your key safe access code is 4821.',
  cleaned: { dates: ['on Friday 6 November'], times: ['4pm'] },
  ...o,
});

// To Tom, CC'd to the user, with one ask for Tom and one for the user by name.
const TOM_ASK = 'Can you drain the system on Thursday?';
const WILL_ASK = 'Will, could you send me the invoice by Friday?';
const ccNamed = (o = {}) => email({
  from: { name: 'Mark Ellis', address: 'mark@ellisheating.example' },
  to: [{ name: 'Tom Baker', address: 'tom@bakerplumbing.example' }],
  cc: [{ ...ME }],
  subject: 'Elm Road',
  body: `${TOM_ASK} ${WILL_ASK} I need it for the client.`,
  questions: [TOM_ASK, WILL_ASK],
  deadlines: [
    deadline(2, { text: 'Thursday', cue: null, source: 'ask', sentence: TOM_ASK }),
    deadline(3, { text: 'Friday', cue: 'by', source: 'ask', sentence: WILL_ASK }),
  ],
  ...o,
});

// A Google Groups post from Gmail (List-Id, List-Unsubscribe, Precedence: list).
const GROUP_HEADERS = { listUnsubscribe: '<mailto:googlegroups-manage+1@googlegroups.com>', listId: '<harrow-juniors.googlegroups.com>', precedence: 'list' };
const groupPost = (o = {}) => email({
  from: { name: 'Jane Doe', address: 'jane.doe@gmail.com' },
  to: [{ name: 'Harrow Juniors', address: 'harrow-juniors@googlegroups.com' }],
  subject: '[Harrow Juniors] Kit for the season',
  headers: GROUP_HEADERS,
  category: 'newsletter',
  body: 'Could someone bring spare shin pads to training? To unsubscribe from this group, send an email to harrow-juniors+unsubscribe@googlegroups.com.',
  questions: ['Could someone bring spare shin pads to training?'],
  ...o,
});

module.exports = {
  HOUR, DAY, NOW, TODAY, ME, HISTORY, HMRC_DUE, DEMO1_REPLIED, LIST_UNSUBSCRIBE,
  email, deadline, ctx, localDayKey, dayPlus,
  sarah, dad, hmrc, screwfix, promo, weeklyBuilder, weeklyBuilderIssues, ccFyi, bank, stranger,
  strangerBankDetails, strangerGroup, strangerGroupCoursework, demo1, oldCode, freshSignIn,
  automated, personOther, flaggedNewsletter,
  schoolTrip, importFee, delivery, fraudCheck, cottageCode, ccNamed, groupPost, GROUP_HEADERS,
};
