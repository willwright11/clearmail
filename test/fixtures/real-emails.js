// Real emails for the triage tests, run through the real pipeline the way view.prepareEmail()
// does: raw text → cleaner.clean() → dates.findDeadlines() → triage. They are the examples the
// adversarial review found sorted wrongly (scratchpad v03 findings), plus a few emails that
// really are noise, so the fixes can't simply stop sorting anything as noise.
//
// The clock is the same as in triage-fixtures.js: Tue 3 Nov 2026, 09:00 in London.
//
// Each fixture has:
// - `expect`: the bucket, and optionally the lead reason code and the deadline day shown.
//   `bucket` can be a list when either answer is fine (never noise).
// - `guard`: which noise signals it must survive in the property test. 'all': a List-
//   Unsubscribe header, promo words and Outlook's Other tab. 'person': the last two only,
//   because a List-Unsubscribe header is fair evidence that an unknown sender is bulk.
//   'none': only as it is (automated mail with nothing at stake, such as a booking).
// - `needs`: set when `expect` depends on a fix the text agent is making in parallel in
//   cleaner.js / dates.js (named in the text). `noiseNeeds`: set when even "not noise" does.

const { clean } = require('../../src/cleaner');
const { findDeadlines } = require('../../src/dates');
const { originalText } = require('../../src/summarize');

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 3, 9, 0); // Tue 3 Nov 2026 09:00 GMT
const ME = { name: 'Will Wright', address: 'will@example.com' };
const NAMES = ['will']; // what main.js derives from the account's display name

const NO_HEADERS = { listUnsubscribe: null, listId: null, precedence: null, autoSubmitted: null };
const LU = { ...NO_HEADERS, listUnsubscribe: '<https://example.com/unsubscribe>' };
const GOOGLE_GROUP = {
  listUnsubscribe: '<mailto:googlegroups-manage+123@googlegroups.com>',
  listId: '<harrow-juniors.googlegroups.com>',
  precedence: 'list',
  autoSubmitted: null,
};
const P = (name, address) => ({ name, address });

let counter = 0;

/** A RawEmail v3 as a backend returns it. `hoursAgo` (or `date`) sets when it arrived. */
function raw(f) {
  const { hoursAgo = 2, ...rest } = f;
  const date = rest.date || new Date((rest.now || NOW) - hoursAgo * HOUR).toISOString();
  const id = `real:${rest.id || `r${++counter}`}`;
  delete rest.now;
  return {
    messageId: `<${id}@example.invalid>`,
    uid: null,
    replyTo: null,
    to: [{ ...ME }],
    cc: [],
    seen: false,
    flagged: false,
    importance: 'normal',
    focused: true,
    conversationId: `conv-${id}`,
    inReplyTo: null,
    references: [],
    headers: { ...NO_HEADERS },
    webLink: null,
    attachments: [],
    html: '',
    text: '',
    subject: '',
    ...rest,
    id,
    date,
    receivedAt: rest.receivedAt || date,
  };
}

/**
 * The TriageInput for a raw email, made exactly as view.prepareEmail() makes it: the
 * original text is cleaned, then its deadlines are found from the email's sent date (with
 * the dates of any forwarded part, cleaned.forwarded, for the text after it).
 */
function prepare(r) {
  const original = originalText(r);
  const cleaned = clean({ text: original, html: r.html, subject: r.subject, from: r.from?.address || '' });
  const deadlines = findDeadlines({
    subject: r.subject,
    body: cleaned.body,
    questions: cleaned.questions,
    actions: cleaned.actions,
    forwarded: cleaned.forwarded,
  }, r.date, { order: 'dmy' });
  return { ...r, cleaned, deadlines };
}

// ---------- the review's examples (none of them may be noise) ----------

const REAL = [
  // Bulk or automated mail that asks for something by a date (dates.js finds the deadline).
  {
    name: 'school trip consent form, with List-Unsubscribe',
    raw: () => raw({
      id: 'school-trip', from: P("St Mary's Primary", 'office@stmarys.sch.uk'), subject: 'Year 5 trip to the Science Museum', headers: LU,
      text: "Dear Parents and Carers,\n\nYear 5 are visiting the Science Museum on Wednesday 18 November.\n\nPlease return the signed consent form by Friday 6 November. The cost is £12.50, payable on ParentPay.\n\nThank you,\nMrs Jones\n\nYou are receiving this email because you are a parent at St Mary's. Unsubscribe",
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-06' },
    guard: 'all',
  },
  {
    name: 'Passport Office asking for documents, with List-Unsubscribe',
    raw: () => raw({
      id: 'passport', from: P('HM Passport Office', 'noreply@notifications.service.gov.uk'), subject: 'Your passport application: we need more information', headers: LU,
      text: 'We need more information to process your passport application.\n\nPlease send us the documents listed below by 20 November 2026 or we will have to withdraw it.\n\nYour application reference is 1234-5678.',
    }),
    expect: { bucket: 'worth-knowing', code: 'deadline-later', day: '2026-11-20' },
    guard: 'all',
  },
  {
    name: 'GP asking for a blood test within 2 weeks, filed under Other',
    raw: () => raw({
      id: 'gp-bloods', from: P('Harrow Health Centre', 'noreply@accurx.nhs.uk'), subject: 'A message from your GP practice', focused: false,
      text: 'Dr Patel has reviewed your results and would like you to have a repeat blood test.\n\nPlease book a blood test within the next 2 weeks by calling 020 8000 0000.\n\nThis is an automated message. Please do not reply.',
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-17' },
    guard: 'all',
  },
  {
    name: 'Royal Mail: collect the parcel by Saturday or it goes back',
    raw: () => raw({
      id: 'parcel-collect', from: P('Royal Mail', 'no-reply@royalmail.com'), subject: "Something for you: we couldn't deliver your parcel", focused: false,
      text: 'We tried to deliver your parcel today but no one was in.\n\nCollect it from Harrow Delivery Office by Saturday 14 November, or it will be returned to the sender.\n\nBring your card and photo ID.',
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-14' },
    guard: 'all',
  },
  {
    name: 'DPD: pay the import fee of £18.40 within 3 days',
    raw: () => raw({
      id: 'parcel-customs', from: P('DPD', 'notifications@dpd.co.uk'), subject: 'Action needed: pay import fee for your parcel', focused: false,
      text: 'Your parcel from Germany is being held. Pay the import fee of £18.40 within 3 days to release it, or it will be returned.',
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-06' },
    guard: 'all',
  },
  {
    name: 'job offer from a no-reply careers system, filed under Other',
    raw: () => raw({
      id: 'job-offer-ats', from: P('Acme Careers', 'no-reply@acme-careers.example'), subject: 'Your offer from Acme Construction', focused: false,
      text: "Dear Will,\n\nWe're delighted to offer you the role of Site Manager at Acme Construction, with a salary of £48,000.\n\nPlease accept or decline the offer by Friday 13 November using the link below.\n\nhttps://acme-careers.example/offer/123\n\nKind regards,\nAcme Talent Team",
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-13' },
    guard: 'all',
  },
  {
    name: 'DVSA: your MOT expires on 14 November, with List-Unsubscribe',
    raw: () => raw({
      id: 'mot', from: P('DVSA', 'noreply@notifications.service.gov.uk'), subject: 'Your MOT expires soon', headers: LU,
      text: 'The MOT for your vehicle AB12 CDE expires on 14 November 2026.\n\nYou can be fined up to £1,000 for driving without a valid MOT.\n\nBook an MOT test: https://www.gov.uk/getting-an-mot',
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-14' },
    guard: 'all',
  },

  // A person's words ("unsubscribe", "offer", "sale", "payment received") must not make the
  // email bulk. Without the text agent's classify() fix the non-webmail ones are still
  // protected by the deadline they ask for, so the bucket holds either way.
  {
    name: "a friend's new Gmail address: \"I had to unsubscribe from everything\"",
    raw: () => raw({
      id: 'friend-unsub', from: P('Tom Hughes', 'tomhughes88@gmail.com'), subject: 'New address',
      text: 'Hi Will,\n\nNew email address - the old one got hacked so I had to unsubscribe from everything.\n\nCan you give me a call tonight? Something has happened with Mum.\n\nTom',
    }),
    expect: { bucket: 'needs-you', code: 'asks-question' },
    guard: 'all',
  },
  {
    name: 'a recruiter offering a job, with a preferences footer',
    raw: () => raw({
      id: 'job-offer-person', from: P('Rachel Green', 'rachel.green@acme.example'), subject: 'Job offer - Site Manager',
      text: "Dear Will,\n\nWe're delighted to offer you the role of Site Manager, with a salary of £48,000.\n\nPlease confirm by Friday 13 November whether you accept.\n\nYou are receiving this email because you applied via our careers site. Manage your preferences or unsubscribe.\n\nRachel",
    }),
    expect: { bucket: 'needs-you', day: '2026-11-13' },
    guard: 'all',
  },
  {
    name: 'a conveyancer: completion of the sale, transfer the balance by Thursday',
    raw: () => raw({
      id: 'conveyancer', from: P('Smith & Co Conveyancing', 'case-updates@smithco.example'), subject: 'Completion date agreed: 12 Elm Road',
      text: 'Dear Will,\n\nCompletion of the sale is now set for Friday 13 November.\n\nPlease transfer the balance of £12,500 to our client account by Thursday 12 November.\n\nYou are receiving this because you are a client of Smith & Co. Manage preferences | Unsubscribe',
    }),
    expect: { bucket: 'needs-you', day: '2026-11-12' },
    guard: 'all',
  },
  {
    name: 'a Google Groups post from Gmail that asks the user by name',
    raw: () => raw({
      id: 'google-group', from: P('Jane Doe', 'jane.doe@gmail.com'), to: [P('Harrow Juniors', 'harrow-juniors@googlegroups.com')],
      subject: '[Harrow Juniors] Match moved to Sunday', headers: { ...GOOGLE_GROUP },
      text: 'Hi all,\n\nThe match is moved to Sunday 8 November at 10am. Please confirm your child can play by Thursday.\n\nWill, could you bring the corner flags?\n\nThanks, Jane\n\n--\nYou received this message because you are subscribed to the Google Groups "Harrow Juniors" group.\nTo unsubscribe from this group and stop receiving emails from it, send an email to harrow-juniors+unsubscribe@googlegroups.com.',
    }),
    expect: { bucket: 'needs-you', code: 'asks-question', day: '2026-11-05' },
    guard: 'all',
  },
  {
    name: 'a person from Gmail: "Payment received for the van, thanks"',
    raw: () => raw({
      id: 'person-receipt', from: P('Gary Lane', 'gary.lane@gmail.com'), subject: 'Van',
      text: 'Hi Will,\n\nPayment received for the van, thanks.\n\nCan you drop the keys round on Saturday?\n\nGary',
    }),
    expect: { bucket: 'needs-you', code: 'asks-question', day: '2026-11-07' },
    guard: 'all',
  },

  // "no later than 5pm on 10 November": needs the text agent's dates.js fix (a time between
  // the cue and the date). Until then HMRC is kept out of noise by "penalty" (obligation).
  {
    name: 'HMRC: filed no later than 5pm on 10 November, with List-Unsubscribe',
    raw: () => raw({
      id: 'nlt-gov', from: P('HMRC', 'noreply@hmrc.example'), subject: 'Self Assessment reminder', headers: LU,
      text: 'Your tax return must be filed no later than 5pm on 10 November 2026.\n\nIf you miss it you will be charged a £100 penalty.',
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-10' },
    guard: 'all',
    needs: 'text agent: dates.js "no later than 5pm on <date>"',
  },
  {
    name: 'Priya (a known contact): no later than 5pm on 10 November',
    raw: () => raw({
      id: 'nlt-person', from: P('Priya Shah', 'priya@shahaccounting.co.uk'), subject: 'Accounts',
      text: 'Hi Will,\n\nThe accounts must reach Companies House no later than 5pm on 10 November.\n\nPriya',
    }),
    wrote: { 'priya@shahaccounting.co.uk': 3 },
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-10' },
    guard: 'all',
    needs: 'text agent: dates.js "no later than 5pm on <date>"',
  },
  {
    // The cleaner counts the sentence as an ask; "deadline" in it is the obligation wording.
    name: 'university admissions: the deadline is 12 noon on Friday 13 November',
    raw: () => raw({
      id: 'deadline-noon', from: P('Admissions', 'admissions@harrowcollege.example'), subject: 'Applications for January entry', headers: LU,
      text: 'Thank you for your interest in our January courses.\n\nThe deadline for applications is 12 noon on Friday 13 November.\n\nUnsubscribe from these emails.',
    }),
    expect: { bucket: 'needs-you', code: 'deadline-soon', day: '2026-11-13' },
    guard: 'all',
  },
  {
    name: 'council: forms must reach us no later than midnight on 20 November',
    raw: () => raw({
      id: 'nlt-midnight', from: P('Harrow Council', 'electoral@harrow.example'), subject: 'Household enquiry form', headers: LU,
      text: 'Every household must return the annual enquiry form.\n\nForms must reach our office no later than midnight on 20 November.',
    }),
    expect: { bucket: 'worth-knowing', code: 'deadline-later', day: '2026-11-20' },
    guard: 'all',
    needs: 'text agent: dates.js "no later than midnight on <date>"',
    noiseNeeds: 'text agent: dates.js "no later than midnight on <date>"',
  },

  // Notices that say the user must act, with no date.
  {
    name: 'DVLA: could not take your vehicle tax payment, filed under Other',
    raw: () => raw({
      id: 'dvla', from: P('DVLA', 'noreply@dvla.example'), subject: 'Action needed: your vehicle tax', focused: false,
      text: 'We could not take your vehicle tax Direct Debit payment. You need to set up a new payment to keep your vehicle taxed.',
    }),
    expect: { bucket: 'worth-knowing', code: 'obligation' },
    guard: 'all',
  },
  {
    name: 'HMRC: response needed or a penalty, with List-Unsubscribe',
    raw: () => raw({
      id: 'hmrc-response', from: P('HMRC', 'noreply@hmrc.example'), subject: 'Response needed', headers: LU,
      text: 'Please reply to our letter about your 2025 return. If you do not respond we may charge you a penalty.',
    }),
    expect: { bucket: 'worth-knowing', code: 'obligation' },
    guard: 'all',
  },

  // A bank fraud check, filed under Other.
  {
    name: 'bank fraud check: "Did you make this payment?"',
    raw: () => raw({
      id: 'fraud-check', from: P('Kestrel Bank', 'alerts@kestrelbank.example'), subject: 'Did you make this payment?', focused: false,
      text: "We've noticed an unusual payment on your card ending 4421: £499.00 at CURRYS ONLINE.\n\nIf this wasn't you, call us now on the number on the back of your card. Reply Y if it was you or N if not.",
    }),
    expect: { bucket: 'worth-knowing', code: 'security' },
    guard: 'all',
  },

  // A forwarded council refusal: "within 28 days of this notice" counts from the notice's
  // date (13 Oct), so the deadline is 10 Nov. Needs the text agent's cleaner.forwarded and
  // dates.js fix for the day; the bucket holds either way (Jo asks and is a known contact).
  {
    name: 'Jo forwards a planning refusal: appeal within 28 days of the notice',
    raw: () => raw({
      id: 'fwd-relative', from: P('Jo Patel', 'jo.patel@example.com'), subject: 'Fwd: Planning decision - 12 Elm Road',
      text: "Hi Will,\n\nFYI - see below. Can you get the appeal in? I'm away until Monday.\n\nThanks,\nJo\n\n---------- Forwarded message ---------\nFrom: Northfield Borough Council Planning <planning@northfield-council.example>\nDate: Tue, 13 Oct 2026 at 16:05\nSubject: Planning decision - 12 Elm Road\nTo: Jo Patel <jo.patel@example.com>\n\nDear Ms Patel,\n\nWe have refused this application.\n\nYou must appeal within 28 days of this notice. The appeal fee of £462 is non-refundable.\n\nPlanning Services",
    }),
    wrote: { 'jo.patel@example.com': 2 },
    expect: { bucket: 'needs-you', day: '2026-11-10' },
    guard: 'all',
    needs: 'text agent: cleaner.forwarded dates and dates.js counting from them',
  },

  // Short versions (the text agent's summarize.js findings); here only the sorting.
  {
    name: 'a solicitor: "If we need you to sign anything else, we will let you know"',
    raw: () => raw({
      id: 'cond-ask', from: P('Helen Ward', 'helen@wardsolicitors.example'), subject: 'Your documents',
      text: 'Dear Will,\n\nThank you for sending the signed documents, which we received this morning.\n\nIf we need you to sign anything else, we will let you know.\n\nKind regards,\nHelen',
    }),
    wrote: { 'helen@wardsolicitors.example': 2 },
    // Nothing is asked: it's a promise to ask later, not a request.
    expect: { bucket: 'worth-knowing' },
    guard: 'all',
  },
  {
    name: 'Amy: "Would it be possible to get a copy of the invoice?"',
    raw: () => raw({
      id: 'possible', from: P('Amy Turner', 'amy.turner@example.net'), subject: 'Invoice',
      text: 'Hi Will,\n\nWould it be possible to get a copy of the invoice for our records?\n\nThanks,\nAmy',
    }),
    wrote: { 'amy.turner@example.net': 1 },
    expect: { bucket: 'needs-you', code: 'asks-question' },
    guard: 'all',
  },
  {
    name: 'gym: £480 will be taken unless you cancel before 13 November',
    raw: () => raw({
      id: 'gym-renewal', from: P('FitGym', 'membership@fitgym.example'), subject: 'Your membership renewal',
      text: 'Your annual membership and locker hire will renew automatically on 20 November 2026 and £480 will be taken from your card on that day unless you cancel it before 13 November by calling us.',
    }),
    expect: { bucket: ['needs-you', 'worth-knowing'] },
    guard: 'person',
  },
  {
    name: 'visa office: do not send the original documents before 20 November',
    raw: () => raw({
      id: 'do-not-send', from: P('Visa Office', 'noreply@visas.example'), subject: 'Your application', headers: LU,
      text: 'Thank you for your application. Please make sure you do not send the original documents or your passport to us before 20 November.',
    }),
    expect: { bucket: 'worth-knowing', code: 'deadline-later', day: '2026-11-20' },
    guard: 'all',
  },

  // "by the 15th" / "before the 15th": needs the text agent's cleaner/dates.js fix for the day.
  {
    name: 'letting agent: rent overdue, pay the balance by the 15th',
    raw: () => raw({
      id: 'by-the-15th', from: P('Lettings', 'lettings@agent.example'), subject: 'Rent arrears', headers: LU,
      text: 'Your rent payment of £1,200 is overdue. Please pay the balance by the 15th to avoid a late fee.',
    }),
    expect: { bucket: 'needs-you', code: 'payment-due', day: '2026-11-15' },
    guard: 'all',
    needs: 'text agent: dates "by the 15th"',
  },
  {
    name: 'a landlord: the new amount needs to be in my account before the 15th',
    raw: () => raw({
      id: 'person-15th', from: P('Mike Rowe', 'mike@landlord.example'), subject: 'Rent',
      text: 'Hi Will, the rent went up so the new amount needs to be in my account before the 15th. Mike',
    }),
    expect: { bucket: 'worth-knowing', day: '2026-11-15' },
    guard: 'person',
    needs: 'text agent: dates "before the 15th"',
  },

  // A holiday key-safe code is not an old sign-in code.
  {
    name: "holiday cottage key-safe access code, 40 hours old (no-reply)",
    raw: () => raw({
      id: 'cottage-code', hoursAgo: 40, from: P('Lakeside Cottages', 'noreply@lakesidecottages.example'), subject: 'Your arrival details for Friday',
      text: 'Your stay at Heron Cottage starts on Friday 6 November. Check-in is from 4pm.\n\nYour key safe access code is 4821.',
    }),
    expect: { bucket: 'worth-knowing', code: 'automated' },
    guard: 'none',
  },
  {
    name: 'holiday cottage key-safe access code, 40 hours old (bookings@)',
    raw: () => raw({
      id: 'cottage-code-bookings', hoursAgo: 40, from: P('Lakeside Cottages', 'bookings@lakesidecottages.example'), subject: 'Your arrival details for Friday',
      text: 'Hi Will,\n\nYour stay at Heron Cottage starts on Friday 6 November. Check-in is from 4pm.\n\nYour key safe access code is 4821.\n\nThe address is 3 Lake Road, Keswick CA12 5DE.\n\nEnjoy your stay!',
    }),
    expect: { bucket: 'worth-knowing' },
    guard: 'person',
  },

  // CC'd, but asked by name: needs you, with that ask's deadline (Friday, not Tom's Thursday).
  {
    name: "CC'd, and asked by name for the invoice by Friday",
    raw: () => raw({
      id: 'cc-ask-named', from: P('Mark Ellis', 'mark@ellisheating.example'), to: [P('Tom Baker', 'tom@bakerplumbing.example')], cc: [{ ...ME }], subject: 'Elm Road',
      text: 'Hi Tom,\n\nCan you drain the system on Thursday?\n\nWill, could you send me the invoice by Friday? I need it for the client.\n\nThanks,\nMark',
    }),
    expect: { bucket: 'needs-you', code: 'asks-question', day: '2026-11-06' },
    guard: 'all',
  },
];

// ---------- emails that really are noise ----------

const CONTROLS = [
  {
    name: '"Today only" promotion',
    raw: () => raw({
      id: 'promo', from: P('TradeHub Supplies', 'offers@tradehub.example'), subject: 'Today only: 30% off power tools', hoursAgo: 5, focused: false, headers: LU,
      text: "View this email in your browser\n\nToday only: 30% off all power tools. Offer ends midnight tonight! Your order must be in by midnight.\n\nShop now: https://tradehub.example/sale\n\nYou're receiving this because you have a TradeHub account. Unsubscribe | Manage preferences",
    }),
    code: 'promo',
  },
  {
    name: 'old sign-in code (50 hours)',
    raw: () => raw({
      id: 'old-code', hoursAgo: 50, seen: true, from: P('Kestrel Bank', 'noreply@kestrelbank.example'), subject: 'Your Kestrel Bank verification code',
      text: "Your verification code is 482913. It expires in 10 minutes.\n\nKestrel Bank will never call you to ask for this code. Don't share it with anyone.",
    }),
    code: 'old-code',
  },
  {
    name: 'old login code with a plain subject (30 hours)',
    raw: () => raw({
      id: 'old-login-code', hoursAgo: 30, seen: true, from: P('Shop', 'noreply@shop.example'), subject: 'Your code',
      text: '482913 is your login code. It expires in 10 minutes.',
    }),
    code: 'old-code',
  },
  {
    name: 'delivery-only notice: "Your order will be delivered by Friday", filed under Other',
    raw: () => raw({
      id: 'delivery', from: P('Parcel Shop', 'notifications@parcelshop.example'), subject: 'Your order is on its way', focused: false,
      text: 'Good news! Your order will be delivered by Friday 6 November. Track your parcel here: https://parcelshop.example/track',
    }),
    code: 'outlook-other',
  },
];

/** The current Weekly Builder issue plus three older unread ones (an ignored newsletter). */
function ignoredNewsletter() {
  const issue = (n, hoursAgo) => raw({
    id: `weekly-${n}`, hoursAgo, from: P('The Weekly Builder', 'newsletter@weeklybuilder.com'), subject: 'This week in construction', focused: false,
    headers: { ...LU, listId: '<weekly.weeklybuilder.com>', precedence: 'bulk' },
    text: 'View this email in your browser\n\nTimber prices fell 4% last month. Our top 12 trends piece is here: https://weeklybuilder.com/trends\n\nYou are receiving this because you signed up at weeklybuilder.com. Unsubscribe here.',
  });
  return [issue(1, 12), issue(2, 7 * 24 + 12), issue(3, 14 * 24 + 12), issue(4, 21 * 24 + 12)];
}

// ---------- the never-noise property ----------

const PROMO_SENTENCE = 'Today only: 30% off everything, shop now while stocks last.';

/**
 * The raw email with the worst of the noise signals added: a List-Unsubscribe header, promo
 * words (with an unsubscribe footer as well when the header is added, so the cleaner calls
 * it a promotion) and Outlook's Other tab. Run it through prepare() again afterwards.
 */
function mutateRaw(r, { listUnsubscribe, promoWords, other }) {
  const out = { ...r, headers: { ...(r.headers || NO_HEADERS) } };
  if (listUnsubscribe) out.headers.listUnsubscribe = LU.listUnsubscribe;
  if (promoWords) out.text = `${r.text}\n\n${PROMO_SENTENCE}${listUnsubscribe ? ' Unsubscribe | Manage preferences' : ''}`;
  if (other) out.focused = false;
  return out;
}

module.exports = {
  NOW, ME, NAMES, LU, GOOGLE_GROUP, raw, prepare, REAL, CONTROLS, ignoredNewsletter, mutateRaw, PROMO_SENTENCE,
};
