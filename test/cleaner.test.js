const test = require('node:test');
const assert = require('node:assert');
const { simpleParser } = require('mailparser');
const { clean, htmlToText, splitSentences } = require('../src/cleaner');
const demo = require('../src/demo');

const byId = (id) => demo.find((m) => m.id === id);
const run = (m) => clean({ text: m.text, subject: m.subject, from: m.from.address });
const text = (t, extra = {}) => clean({ text: t, ...extra });

test('strips greetings, pleasantries, sign-off, signature and quoted reply', () => {
  const c = run(byId('demo-2'));
  assert.doesNotMatch(c.body, /hope you're well/i);
  assert.doesNotMatch(c.body, /don't hesitate/i);
  assert.doesNotMatch(c.body, /Kind regards/);
  assert.doesNotMatch(c.body, /wrote:|Previous message/);
  assert.match(c.body, /£14,750/);
});

test('pulls out money, dates, asks and actions', () => {
  const c = run(byId('demo-2'));
  assert.ok(c.amounts.includes('£14,750'));
  assert.ok(c.dates.some((d) => /Friday 17th October/i.test(d)));
  assert.ok(c.times.includes('10am'));
  assert.ok(c.questions.some((q) => /site meeting/.test(q)));
  assert.ok(c.actions.some((a) => /confirm/.test(a)));
});

test('rewrites throat-clearing openers', () => {
  const c = run(byId('demo-1'));
  assert.match(c.body, /^About the Harrow extension/);
});

test('removes legal footers and unsubscribe blocks', () => {
  assert.doesNotMatch(run(byId('demo-1')).body, /confidential|Registered in England/i);
  assert.doesNotMatch(run(byId('demo-5')).body, /Unsubscribe|Privacy policy/i);
  assert.doesNotMatch(run(byId('demo-6')).body, /Unsubscribe|view this email/i);
});

test('shortens tracking links but keeps the URL', () => {
  const c = run(byId('demo-5'));
  assert.match(c.body, /\[screwfix\.com\]/);
  assert.match(c.links[0].url, /^https:\/\/www\.screwfix\.com\/orders/);
});

test('categorises mail', () => {
  assert.strictEqual(run(byId('demo-5')).category, 'receipt');
  assert.strictEqual(run(byId('demo-6')).category, 'newsletter');
  assert.strictEqual(run(byId('demo-4')).category, 'notification');
  assert.strictEqual(run(byId('demo-7')).category, 'person');
  assert.strictEqual(run(byId('demo-4')).urgency, 'high');
});

test('handles HTML-only mail', () => {
  const c = clean({ html: '<p>Hi Will,</p><p>The meeting moved to <b>3pm Thursday</b>.</p><p>Unsubscribe here</p>' });
  assert.strictEqual(c.body, 'The meeting moved to 3pm Thursday.');
});

test('F26: a mid-email "Thanks." or "Love it!" does not cut off the rest', () => {
  let c = text('Hi Will,\n\nThanks.\n\nPayment of £5,000 is overdue, please pay by Friday or we will start court action.\n\nSarah');
  assert.match(c.body, /Payment of £5,000 is overdue/);
  assert.deepStrictEqual(c.amounts, ['£5,000']);
  assert.ok(c.actions.length);
  assert.match(text('Hi Will,\nI got the drawings.\nThanks for that.\nBut the council rejected the planning application, we need to resubmit by 1 December.\nSam').body, /council rejected the planning application, we need to resubmit by 1 December/);
  c = text('Love it!\nCan we also add a skylight? Budget up to £2k.');
  assert.ok(c.questions.includes('Can we also add a skylight?'));
  assert.deepStrictEqual(c.amounts, ['£2k']);
  assert.match(text('Hi team,\nThe tender went in.\nBest of luck\nResults are due 14 November and the bond of £20,000 must be lodged by Monday.\nJo').body, /bond of £20,000 must be lodged by Monday/);
  assert.match(text('Cheers\nYour car is ready to collect, bill £250.').body, /Your car is ready to collect, bill £250\./);
  assert.match(text('Hi,\n\nThanks!\n\nWe need to resubmit by 1 December, fee £300.').body, /resubmit by 1 December, fee £300/);
  for (const signoff of ['Ta', 'Thanks Will']) {
    const body = text(`Hi Will,\nThe skip is booked.\n${signoff}\nThe crane is cancelled though - do not let the crew in.`).body;
    assert.match(body, /crane is cancelled though - do not let the crew in/);
  }
});

test('F26: a P.S. after the signature is kept, the signature still goes', () => {
  const c = text("Hi Will,\n\nAll good for next week.\n\nThanks,\nSam\n\nP.S. The gate code changed to 4471 - you'll need it Monday.");
  assert.match(c.body, /P\.S\. The gate code changed to 4471/);
  assert.doesNotMatch(c.body, /Thanks|Sam/);
  assert.ok(c.keyPoints.every((k) => k !== 'P.S.'));
});

test('F27: forwarded messages keep their content', () => {
  const forward = '---------- Forwarded message ---------\nFrom: Harrow Council <planning@harrow.gov.uk>\nDate: Mon, 13 Oct 2026 at 09:12\nSubject: Planning decision\nTo: Jo <jo@example.com>\n\nYour application 26/1234 has been refused. You may appeal within 28 days, by 10 November 2026. The fee of £462 is non-refundable.';
  for (const t of [`FYI - see below, can you sort this?\n\n${forward}`, forward]) {
    for (const subject of ['Fwd: Planning decision', '']) {
      const c = text(t, { subject });
      assert.match(c.body, /Forwarded message from Harrow Council:/);
      assert.match(c.body, /has been refused/);
      assert.ok(c.dates.includes('10 November 2026'));
      assert.deepStrictEqual(c.amounts, ['£462']);
      assert.doesNotMatch(c.body, /^(?:From|Date|To|Subject):/m);
    }
  }
  const body = 'Your application 26/1234 has been refused. Appeal by 10 November 2026, fee £462.';
  const outlook = text(`See below\n\n________________________________\nFrom: Harrow Council <planning@harrow.gov.uk>\nSent: Monday, October 13, 2026 9:12 AM\nTo: Jo Patel <jo@example.com>\nSubject: Planning decision\n\n${body}`, { subject: 'FW: Planning decision' });
  assert.match(outlook.body, /has been refused/);
  const apple = text(`FYI\n\nBegin forwarded message:\n\nFrom: Harrow Council <planning@harrow.gov.uk>\nSubject: Planning decision\nDate: 13 October 2026 at 09:12:00 BST\nTo: Jo Patel <jo@example.com>\n\n${body}`, { subject: 'Fwd: Planning decision' });
  assert.match(apple.body, /has been refused/);
  // mailparser's header block for a forwarded-as-attachment message
  const attached = text(`See attached.\n\n\nFrom: "Harrow Council" <planning@harrow.gov.uk>\nSubject: Planning decision\nDate: Mon, 13 Oct 2026 09:12:00 GMT\nTo: jo@example.com\n\n${body}`, { subject: 'Planning decision' });
  assert.match(attached.body, /has been refused/);
  // Apple Mail HTML: the whole forward sits in a blockquote
  const appleHtml = clean({ subject: 'Fwd: decision', html: '<div>FYI</div><blockquote type="cite"><div>Begin forwarded message:</div><br><div><b>From: </b>Council &lt;p@c.gov.uk&gt;<br><b>Subject: </b>Decision<br><b>Date: </b>13 October 2026 at 09:12:00 BST<br><b>To: </b>Jo &lt;jo@x.com&gt;</div><br><div>Refused. Appeal by 10 November 2026.</div></blockquote>' });
  assert.match(appleHtml.body, /Refused\. Appeal by 10 November 2026\./);
});

test('F27: inline answers between quoted lines are kept', () => {
  const c = text("Hi Will,\n\nAnswers inline below.\n\nOn Mon, 13 Oct 2026 at 09:12, Will Wright <will@example.com> wrote:\n> Can you do Tuesday?\nYes, Tuesday 9am works.\n> And what's the final price?\n£450 all in.\n> Do you need a deposit?\nYes, £100 by Friday please.", { subject: 'Re: Bathroom' });
  assert.match(c.body, /Yes, Tuesday 9am works\. £450 all in\. Yes, £100 by Friday please\./);
  assert.deepStrictEqual(c.amounts, ['£450', '£100']);
  assert.doesNotMatch(c.body, /wrote:|final price/);
});

test('F27: the quoted history under an Outlook header in a reply is still cut', () => {
  const c = text('Yes, I will sort it by Friday.\n\nThanks,\nSam\n\n________________________________\nFrom: Will Wright <will@example.com>\nSent: Monday, October 13, 2026 9:12 AM\nTo: Sam <sam@example.com>\nSubject: Planning\n\nCan you sort the appeal? It is due 10 November.', { subject: 'RE: Planning' });
  assert.strictEqual(c.body, 'Yes, I will sort it by Friday.');
});

test('F27: the forwarded demo email shows the forwarded facts', () => {
  const c = run(byId('demo-8'));
  assert.match(c.body, /Forwarded message from Northfield Borough Council Planning:/);
  assert.match(c.body, /refused this application/);
  assert.ok(c.dates.includes('11 November 2026'));
  assert.deepStrictEqual(c.amounts, ['£462']);
  assert.ok(c.keyPoints.some((k) => /£462/.test(k)));
  assert.doesNotMatch(c.body, /Yours sincerely|intended recipient|Thanks,/);
});

test('F28: tickets, web forms, Teams invites and prose are not mistaken for quoted replies', () => {
  let c = text('Your booking is confirmed.\n\nFrom: London Euston\nTo: Manchester Piccadilly\nDate: 17 October 2026\nDeparts: 07:43\nCoach C, Seat 42\nCollection reference: TXQ4471\n\nTotal paid: £86.40');
  assert.match(c.body, /Coach C, Seat 42\nCollection reference: TXQ4471/);
  assert.deepStrictEqual(c.amounts, ['£86.40']);
  assert.ok(c.dates.includes('17 October 2026'));
  c = text('New enquiry from your website:\n\nFrom: Jane Doe\nEmail: jane@example.com\nPhone: 07700 900123\nDate: 16/10/2026\nMessage: I need a quote for a loft conversion, budget £40k. Can you call me?');
  assert.match(c.body, /Phone: 07700 900123/);
  assert.deepStrictEqual(c.amounts, ['£40k']);
  c = text('Hi all, quick sync on the Harrow snagging list.\n\n________________________________________________________________________________\nMicrosoft Teams meeting\nClick here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc>\nMeeting ID: 345 678 901 234\nPasscode: aB3cD4\n________________________________________________________________________________');
  assert.match(c.body, /Meeting ID: 345 678 901 234/);
  assert.match(c.body, /Passcode: aB3cD4/);
  assert.strictEqual(c.links[0].url, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc');
  c = text('Bad news from the client.\n\nOn Friday the client wrote:\n\n"We will not pay the final £8,000 until the snagging is done."\n\nSo we need to finish snagging by 31 October.');
  assert.deepStrictEqual(c.amounts, ['£8,000']);
  assert.match(c.body, /finish snagging by 31 October/);
});

test('F29: a greeting or pleasantry at the start does not delete the sentence', () => {
  const cases = [
    ['Hi Will, running 20 mins late.', /^Running 20 mins late\.$/],
    ['Hi Will, the gas is off until Monday.', /^The gas is off until Monday\.$/],
    ['Good morning, site closed today due to flooding!', /^Site closed today due to flooding!$/],
    ['Hey, the alarm at the yard is going off!', /^The alarm at the yard is going off!$/],
    ['I hope you can make the meeting on Friday at 3pm at our Leeds office.\n\nJo', /meeting on Friday at 3pm/],
    ['Thanks for your patience, the refund of £120 will arrive by Friday.\n\nJo', /refund of £120 will arrive by Friday/],
    ["Please don't hesitate to contact Mark on 07700 900123 who is covering the Harrow job while I'm away.\n\nJo", /contact Mark on 07700 900123/],
    ['Looking forward to your reply by Friday, otherwise the offer of £250,000 lapses.\n\nJo', /offer of £250,000 lapses/],
    ['Have a good weekend, and remember the yard is closed Monday so collect your tools by Friday 5pm.', /collect your tools by Friday 5pm/],
    ['Hope this helps - the door code is 4471 and the alarm code is 9902.', /door code is 4471/],
    ['Let me know if you have any questions before you sign the contract, which must be returned by 31 October.', /returned by 31 October/],
    ['Hi Will,\nSkip arrives Monday.', /^Skip arrives Monday\.$/],
    ['Hi Will,\nThe gas is off until Monday.\nSam', /^The gas is off until Monday\./],
    ['I hope you can bring the ladder.', /bring the ladder/],
  ];
  for (const [input, expected] of cases) assert.match(text(input).body, expected, input);
  // real pleasantries still go
  assert.strictEqual(text('I hope this email finds you well and that you had a lovely weekend.\n\nThe skip is booked.').body, 'The skip is booked.');
  assert.strictEqual(text("Hope you're well! Can you send the invoice?").body, 'Can you send the invoice?');
});

test('F30: "confidential", "privacy policy" and similar words in real content are kept', () => {
  const cases = [
    ["Hi Will\nThe bank details below are confidential, please don't share them.\nSort code 12-34-56, account 12345678. Please pay the £2,400 by Friday.\nSam", /Please pay the £2,400 by Friday/],
    ['Please keep this confidential: our tender price is £1.2m and the bid is due Monday 3 November.\n\nJo', /tender price is £1\.2m/],
    ['Can you send me your registered office address and company number? I need them for the contract.\n\nJo', /registered office address and company number\?/],
    ['We are changing our privacy policy on 1 December 2026. From that date we will share your data with partners unless you opt out at https://bank.example.com/optout.\n\nYour Bank', /share your data with partners unless you opt out/],
    ['Please do not reply to this email until you have spoken to legal - the £50,000 settlement offer expires on Friday.\n\nJo', /£50,000 settlement offer/],
    ["I've attached the disclaimer you need to sign before the climbing day on Saturday 18 October.\n\nJo", /disclaimer you need to sign/],
    ['This advice is legally privileged. In short: do not sign the variation, and send the termination notice by 20 October.\n\nJo', /do not sign the variation/],
  ];
  for (const [input, expected] of cases) assert.match(text(input).body, expected, input);
  assert.ok(text(cases[2][0]).questions.length);
  // a person's own closing paragraph is not a footer, even with no date or amount in it
  assert.match(text('Hi Sam,\n\nThe skip is booked for Friday.\n\nI tried to unsubscribe from your texts but they keep coming.\n\nWill').body, /I tried to unsubscribe/);
  assert.match(text('I have read your privacy policy and I am not happy with it.').body, /privacy policy/);
});

test('F32: weak words or quoted/signature text do not make a person email a newsletter', () => {
  let c = text('Please pay invoice 4471 (£3,200) today, it is overdue.\n\nJo\nBrightBuild Ltd | Sign up to our newsletter at brightbuild.co.uk', { from: 'jo@brightbuild.co.uk' });
  assert.strictEqual(c.category, 'person');
  assert.strictEqual(c.urgency, 'high');
  assert.ok(c.actions.length);
  assert.strictEqual(text("I'm on site this week in Harrow. Can you confirm the steel delivery for Thursday? It's urgent.", { from: 'sam@x.co.uk' }).category, 'person');
  c = text('Let me digest the figures... Please send the signed contract by Friday, it is urgent.', { from: 'sam@x.co.uk' });
  assert.strictEqual(c.category, 'person');
  assert.ok(c.actions.length);
  assert.strictEqual(text('Yes please book it for Friday.\n\nOn Mon, 13 Oct 2026 at 09:12, Will <will@x.com> wrote:\n> Look at this deal, 20% off!\n> Unsubscribe here', { from: 'sam@x.co.uk', subject: 'Re: offer' }).category, 'person');
  c = text('Your order of oak beams arrived damaged. Can you confirm a replacement by Friday?', { from: 'sam@timber.co.uk' });
  assert.strictEqual(c.category, 'person');
  assert.strictEqual(c.urgency, 'normal');
  assert.strictEqual(text('Can you lend me the van on Saturday?', { from: 'tom.mailer@gmail.com' }).category, 'person');
  assert.strictEqual(text('Wholesale timber prices are up again.\n\nUnsubscribe', { from: 'newsletter@x.com' }).category, 'newsletter');
});

test('F32: only strong evidence of mass mail switches off actions and questions', () => {
  const promo = 'Need a new drill? Book your slot now, 20% off this week.\n\nUnsubscribe';
  let c = text(promo, { from: 'shop@toolstation.example', bulk: true });
  assert.strictEqual(c.category, 'promo');
  assert.deepStrictEqual([c.actions, c.questions, c.urgency], [[], [], 'low']);
  c = text(promo, { from: 'deals@toolstation.example' });
  assert.deepStrictEqual([c.actions, c.questions], [[], []]);
  c = text(promo, { from: 'sam@x.co.uk' }); // a body-only guess keeps them
  assert.ok(c.actions.length && c.questions.length);
});

test('F33: URLs drop html-to-text brackets and keep balanced parentheses', async () => {
  let c = text('Pay online: Pay now [https://pay.example.com/inv/4471?t=abc]');
  assert.strictEqual(c.links[0].url, 'https://pay.example.com/inv/4471?t=abc');
  assert.strictEqual(c.body, 'Pay online: Pay now [pay.example.com]');
  c = text('See https://en.wikipedia.org/wiki/Bolt_(fastener) for specs.');
  assert.strictEqual(c.links[0].url, 'https://en.wikipedia.org/wiki/Bolt_(fastener)');
  assert.strictEqual(c.body, 'See [en.wikipedia.org] for specs.');
  c = text('Details (https://x.example.com/a). Or https://y.example.com/b.');
  assert.deepStrictEqual(c.links.map((l) => l.url), ['https://x.example.com/a', 'https://y.example.com/b']);
  // the real thing: mailparser's text for an HTML-only message
  const parsed = await simpleParser('From: a@example.com\r\nSubject: Invoice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Pay online: <a href="https://pay.example.com/inv/4471?t=abc">Pay now</a></p>');
  c = clean({ text: parsed.text, html: parsed.html });
  assert.strictEqual(c.links[0].url, 'https://pay.example.com/inv/4471?t=abc');
  assert.doesNotMatch(c.body, /\[\[|\]\]/);
});

test('F34: every link gets a label that tells it apart', () => {
  const docs = ['Contract', 'Schedule', 'Plans', 'Warranty', 'Insurance', 'Payment terms'];
  const c = text(`Please sign all six documents by Friday:\n${docs.map((d, i) => `- ${d} https://sign.example.com/d/${i + 1}`).join('\n')}`);
  assert.strictEqual(c.links.length, 6);
  assert.strictEqual(new Set(c.links.map((l) => l.label)).size, 6);
  assert.match(c.body, /- Payment terms \[sign\.example\.com\/d\/6\]/);
  const same = text('A https://a.example.com/y?z=1 and B https://a.example.com/y?z=2').links.map((l) => l.label);
  assert.deepStrictEqual(same, ['a.example.com/y', 'a.example.com/y #2']);
});

test('F35: htmlToText keeps £/€ amounts, separates table cells and finds every link', async () => {
  const html = "<p>The steel costs &pound;3,400 and arrives Tuesday.</p><table><tr><td>Due</td><td>12 November 2026</td></tr></table><p>Docs: <a href='https://docs.example.com/x'>here</a></p><p>Please pay &#163;450 by Friday.</p><p>Or &#x20AC;500.</p><p><a\nhref=\"https://pay.example.com/a?x=1&amp;y=2\">Pay</a></p>";
  const t = htmlToText(html);
  assert.match(t, /costs £3,400/);
  assert.match(t, /Due\t12 November 2026/);
  assert.match(t, /here \(https:\/\/docs\.example\.com\/x\)/);
  assert.match(t, /Pay \(https:\/\/pay\.example\.com\/a\?x=1&y=2\)/);
  const c = clean({ html });
  assert.deepStrictEqual(c.amounts, ['£3,400', '£450', '€500']);
  assert.ok(c.dates.includes('12 November 2026'));
  assert.strictEqual(c.links.length, 2);
  assert.strictEqual(htmlToText('caf&eacute; &mdash; &rsquo;x&rsquo; &#146;y&#146; &bogus; &constructor;'), 'café — ’x’ ’y’ &bogus; &constructor;');
  assert.strictEqual(htmlToText('<ul><li>one</li><li>two</li></ul><blockquote>old<br>text</blockquote>after'), '• one\n• two\n\n> old\n> text\nafter');
  // HTML inside multipart/related has no text part from mailparser, so clean() converts it
  const parsed = await simpleParser('From: a@example.com\r\nSubject: Steel\r\nContent-Type: multipart/related; boundary=b\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>The fee is &pound;9,000.</p>\r\n--b\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--b--\r\n');
  assert.deepStrictEqual(clean({ text: parsed.text, html: parsed.html }).amounts, ['£9,000']);
});

test('F36: broken or hostile HTML is converted in linear time', () => {
  const big = (s) => s.repeat(Math.ceil(1_000_000 / s.length));
  for (const html of [big('<header>x '), big('<a href="x">y '), big('<style>x '), big('<div>'), big('< < a'), big('<blockquote>x<br>')]) {
    const start = Date.now();
    htmlToText(html);
    assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  }
  const start = Date.now();
  clean({ html: big('<header>x ') });
  clean({ text: big('---------- Forwarded message ---------\n') });
  clean({ text: big('Thanks\n') });
  assert.ok(Date.now() - start < 6000, `took ${Date.now() - start} ms`);
});

test('F37: dates are real dates', () => {
  assert.deepStrictEqual(text('I sat down with the client and the sun was out. They wed next year.').dates, []);
  assert.deepStrictEqual(text('The fix is in version 1.2 and iOS 17.4. We offer 24/7 support. Total £12.50 for 3/4 of the order, rated 4.8 stars, section 2.1. Sort code 12-34-56.').dates, []);
  let c = text('The skip arrives Monday 9am.');
  assert.deepStrictEqual([c.dates, c.times], [['Monday'], ['9am']]);
  assert.deepStrictEqual(text('1. Pay invoice 4471 by Friday\n2. Sign the contract').dates, ['by Friday']);
  assert.deepStrictEqual(text('Your team may 2 days early?').dates, []);
  assert.deepStrictEqual(text('New guidance is due in December.').dates, ['in December']);
  assert.deepStrictEqual(text('Timber £14.50. Screws £3.20. Glue £4.99. Sealant £6.75. Delivery is on Friday 17 October.').dates, ['on Friday 17 October']);
  c = text('See you 17/10 or 16/10/2026 or 2026-10-16. On Sat we start; Fri 17 Oct is the deadline.');
  assert.deepStrictEqual(c.dates, ['17/10', '16/10/2026', '2026-10-16', 'On Sat', 'Fri 17 Oct']);
});

test('F38: amounts keep their real size and no trailing comma', () => {
  const c = text("It'll cost £500 more than we quoted, and $20 kids tickets. That's €300 minimum. The contract is worth £5 million. The quote is £14,750, including VAT. Budget £2k, or £1.2m.");
  assert.deepStrictEqual(c.amounts, ['£500', '$20', '€300', '£5 million', '£14,750', '£2k', '£1.2m']);
});

test('F39: "today", "important" and "expires" alone are not urgent', () => {
  for (const t of ['Great to see you today, the kids loved it.', 'Not important, just a photo of the dog from the weekend.', 'Your passport expires in 2031.']) {
    assert.notStrictEqual(text(t, { from: 'mum@example.com' }).urgency, 'high', t);
  }
  assert.strictEqual(text('Please pay by today.').urgency, 'high');
  assert.strictEqual(text('IMPORTANT: gas leak at the yard').urgency, 'high');
});

test('F40: list numbers and abbreviations do not split sentences', () => {
  let c = text('Hi Will, a few things for this week:\n\n1. Pay invoice 4471 by Friday\n2. Sign the contract\n3. Book the skip');
  assert.ok(c.keyPoints.every((k) => /[a-z]/i.test(k) && !/^\d+\.$/.test(k)), c.keyPoints.join(' | '));
  assert.ok(c.actions.includes('Pay invoice 4471 by Friday'));
  c = text('Please call Mr. Smith on Tuesday. Bring ID, e.g. Passport or licence.');
  assert.ok(c.actions.includes('Please call Mr. Smith on Tuesday.'));
  assert.deepStrictEqual(splitSentences('Please call Mr. Smith on Tuesday. Bring ID, e.g. Passport or licence.'), ['Please call Mr. Smith on Tuesday.', 'Bring ID, e.g. Passport or licence.']);
});

test('F41: an action is not rewritten into "About …"', () => {
  for (const t of ['I want to check in on Monday at 9am, is that ok?', 'I wanted to follow up on Friday with the client.', 'I am writing on behalf of the landlord to give you notice to vacate by 30 November.']) {
    assert.strictEqual(text(t).body, t);
  }
  assert.strictEqual(text("I'm writing regarding your invoice.").body, 'About your invoice.');
});

test('F42: a "--" separator in the content is not a signature', () => {
  const c = text('Agenda for Monday:\n--\nItem 1: budget sign-off, £40k\nItem 2: programme review\nItem 3: safety\nItem 4: AOB\nJo');
  assert.match(c.body, /Item 1: budget sign-off, £40k[\s\S]*Item 4: AOB/);
  assert.deepStrictEqual(c.amounts, ['£40k']);
  assert.strictEqual(text('See you then.\n\n-- \nJo Bloggs\nSite Manager | 07700 900123').body, 'See you then.');
});

test('F43: wrapped and non-English reply attributions are removed', () => {
  let c = text('Yes that works.\n\nOn Mon, 13 Oct 2026 at 09:12, Will Wright <will.wright@example-construction.co.uk>\nwrote:\n> Can you do Tuesday?', { subject: 'Re: Tuesday' });
  assert.deepStrictEqual([c.body, c.dates], ['Yes that works.', []]);
  c = text('Ja, passt.\n\nAm Mo., 13. Okt. 2026 um 09:12 Uhr schrieb Will <will@example.com>:\n> Can you do Tuesday?', { subject: 'AW: Dienstag' });
  assert.deepStrictEqual([c.body, c.dates], ['Ja, passt.', []]);
  assert.strictEqual(text('Sí.\n\nEl lun, 13 oct 2026 a las 09:12, Will (<will@example.com>) escribió:\n> Can you do Tuesday?').body, 'Sí.');
  assert.strictEqual(text('OK.\n\nLe lun. 13 oct. 2026 à 09:12, Will <will@example.com> a écrit :\n> Can you do Tuesday?').body, 'OK.');
  const gmail = clean({ subject: 'Re: x', html: '<div dir="ltr">Yes that works.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 13 Oct 2026 at 09:12, Will &lt;will@x.com&gt; wrote:<br></div><blockquote class="gmail_quote">Can you do Tuesday?</blockquote></div>' });
  assert.strictEqual(gmail.body, 'Yes that works.');
});

test('never returns an empty result for empty or odd input', () => {
  for (const email of [{}, { text: '', html: null }, { text: 'Thanks,\nSam' }]) {
    const c = clean(email);
    assert.strictEqual(typeof c.body, 'string');
    assert.ok(Array.isArray(c.links) && Array.isArray(c.keyPoints));
  }
  assert.match(text('Thanks,\nSam').body, /Sam/);
});

test('quoted text in an email that is not a reply is kept (booking-site messages, HTML blockquotes)', () => {
  const c = clean({
    subject: 'New message from Jane',
    from: 'express@booking.example',
    html: '<p>You have a new message from Jane (guest):</p><blockquote>We arrive Friday at 11pm, is late check-in OK? Door code please.</blockquote><p>Reply on the website.</p>',
  });
  assert.match(c.body, /late check-in OK\?/);
  assert.ok(c.questions.some((q) => /late check-in/.test(q)));
  assert.ok(c.dates.includes('Friday'));
});

test('quoted history under an attribution is still dropped', () => {
  const c = clean({ subject: 'Plans', text: 'Sounds good, see you then.\n\nOn Mon, 13 Oct 2026 at 09:12, Will <will@x.com> wrote:\n> Shall we meet at 3pm?\n> £50 deposit' });
  assert.strictEqual(c.body, 'Sounds good, see you then.');
});

test('promos and newsletters are never marked time-sensitive', () => {
  const promo = clean({ from: 'hello@shop.example', subject: 'Offer', text: 'Last chance! 50% off today only.\n\nUnsubscribe | View in browser' });
  assert.strictEqual(promo.category, 'promo');
  assert.strictEqual(promo.urgency, 'low');
  const person = clean({ from: 'sam@builder.example', subject: 'Skip', text: 'The skip permit expires tomorrow, can you renew it?' });
  assert.strictEqual(person.urgency, 'high');
});
