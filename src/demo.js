// Sample inbox so the app can be tried without connecting an account.

const now = Date.now();
const ago = (h) => new Date(now - h * 3600_000).toISOString();

module.exports = [
  {
    id: 'demo-1',
    from: { name: 'Sarah Collins', address: 'sarah.collins@brightbuild.co.uk' },
    subject: 'RE: Site visit + quote for the Harrow extension',
    date: ago(30),
    seen: true,
    attachments: [],
    text: `Hi Will,

I hope this email finds you well and that you had a lovely weekend.

Just wanted to reach out regarding the Harrow extension. We had a look at the drawings with the team on Friday.

Could you send over the revised drawings showing the steel beam position? We'll need them before we can finalise anything.

Let me know if you have any questions.

Kind regards,
Sarah Collins
Project Coordinator | BrightBuild Ltd
Registered in England No. 0123456. This email and any attachments are confidential and intended solely for the intended recipient.`,
  },
  {
    id: 'demo-2',
    from: { name: 'Sarah Collins', address: 'sarah.collins@brightbuild.co.uk' },
    subject: 'RE: Site visit + quote for the Harrow extension',
    date: ago(3),
    seen: false,
    attachments: [{ filename: 'Harrow-quote-v2.pdf', size: 183000 }],
    text: `Hi Will,

I hope you're well and thank you so much for getting back to me so promptly, it's really appreciated.

Following on from our conversation last week, and further to the drawings you kindly sent over, I'm pleased to say that we've now had the opportunity to review everything internally with the wider team. I've attached the revised quote, which comes to £14,750 including VAT. This is slightly higher than the initial estimate, mainly because of the additional steelwork that was identified.

In terms of next steps, we would need you to confirm you're happy to proceed by Friday 17th October so that we can hold the start date of Monday 3rd November. If we don't hear back by then, we may have to release the slot to another client, as our schedule is quite busy at the moment.

Also, would you be able to make a site meeting on Wednesday at 10am to go over the access arrangements?

Please don't hesitate to get in touch if you have any questions at all.

Looking forward to hearing from you.

Kind regards,
Sarah

On Mon, 6 Oct 2026 at 09:12, Will Wright <will@example.com> wrote:
> Hi Sarah, drawings attached. Thanks, Will
> Previous message text...`,
  },
  {
    id: 'demo-3',
    from: { name: 'Dad', address: 'dad@example.com' },
    subject: 'Sunday',
    date: ago(20),
    seen: false,
    attachments: [],
    text: `Hello son

Mum says are you coming for lunch on Sunday? We're doing a roast at 1pm. Bring the kids if you can. Can you pick up some milk on the way?

Love Dad

Sent from my iPhone`,
  },
  {
    id: 'demo-4',
    from: { name: 'HMRC', address: 'noreply@notifications.service.gov.uk' },
    subject: 'Action required: your Self Assessment tax return',
    date: ago(48),
    seen: false,
    attachments: [],
    text: `Dear Customer,

This is a reminder that your online Self Assessment tax return for the 2025 to 2026 tax year must be submitted by 31 January 2027.

You must also pay any tax you owe by 31 January 2027. If you miss the deadline you may have to pay a penalty of £100.

Sign in to your account at https://www.gov.uk/log-in-file-self-assessment-tax-return to file your return.

Do not reply to this email. This mailbox is not monitored.

HM Revenue and Customs`,
  },
  {
    id: 'demo-5',
    from: { name: 'Screwfix', address: 'orders@screwfix.com' },
    subject: 'Your order confirmation #SF-4471920',
    date: ago(6),
    seen: true,
    attachments: [],
    text: `Thanks for your order!

Order number: SF-4471920
DeWalt 18V Combi Drill x1 — £129.99
Total paid: £129.99

Your order will be ready to collect from Harrow Wealdstone tomorrow after 2pm. Please bring your order number and photo ID.

View your order: https://www.screwfix.com/orders/SF-4471920?utm_source=email&utm_campaign=order_conf

You are receiving this email because you placed an order with Screwfix. Privacy policy | Unsubscribe | Manage preferences`,
  },
  {
    id: 'demo-6',
    from: { name: 'The Weekly Builder', address: 'newsletter@weeklybuilder.com' },
    subject: '🏗️ This week in construction: 12 trends you can\'t ignore',
    date: ago(12),
    seen: false,
    attachments: [],
    text: `View this email in your browser

Happy Monday!

Welcome to another bumper edition of The Weekly Builder. We've got loads for you this week so grab a cuppa and settle in.

Timber prices fell 4% in September, the third monthly drop in a row.

New Part L building regulations guidance is due in December.

Our top 12 trends piece is here: https://weeklybuilder.com/trends?ref=nl

Have a great week!

The Weekly Builder team
You are receiving this because you signed up at weeklybuilder.com. Unsubscribe here.`,
  },
  {
    id: 'demo-7',
    from: { name: 'Priya Shah', address: 'priya@shahaccounting.co.uk' },
    subject: 'Quick one — VAT receipts',
    date: ago(1),
    seen: false,
    attachments: [],
    text: `Hi Will,

Hope all is good with you!

Quick one — I'm missing receipts for three purchases in August totalling £412.60. Could you dig them out and upload them to the shared folder by end of the week? The VAT return is due on 7 November so I need a few days to get it done.

Also, did you buy the van outright or is it on finance?

Cheers,
Priya

--
Priya Shah ACCA
Shah Accounting | 020 7946 0000`,
  },
];
