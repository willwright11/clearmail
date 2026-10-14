// Offline "waffle remover": strips quoted replies, signatures, legal footers and
// pleasantries, then pulls out the bits people tend to miss (asks, dates, money,
// links). Works with no network and no API key; the AI summariser builds on it.

const REPLY_MARKERS = [
  /^On .{5,200}wrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^_{5,}\s*$/m,
  /^From:\s.+\n(?:.*\n){0,3}?(?:Sent|Date):\s/im,
  /^Le .{5,200}a écrit\s*:\s*$/im,
];

const SIGNOFF = /^(?:kind(?:est)? regards|best regards|warm regards|regards|best wishes|many thanks|thanks(?: again| so much)?|thank you|cheers|best|all the best|sincerely|yours sincerely|yours faithfully|speak soon|ta|thx|love|lots of love|all my love)(?:[,.!]?\s+[A-Z][\w'-]*){0,2}[,.!x]*\s*$/i;

const MOBILE_SIG = /^(?:sent from my (?:iphone|ipad|android|samsung|mobile)|get outlook for (?:ios|android)|sent from (?:outlook|mail) for)/i;

const FOOTER_HINTS = [
  'unsubscribe', 'intended recipient', 'confidential', 'privileged', 'disclaimer',
  'privacy policy', 'view in browser', 'view this email in', 'this email was sent to',
  'you are receiving this', 'manage preferences', 'email preferences', 'registered in england',
  'registered office', 'company number', 'all rights reserved', 'please consider the environment',
  'do not reply to this email', 'no-reply', 'noreply',
];

// Sentences that carry no information. Matched case-insensitively against a whole sentence.
const FILLER = [
  /^i hope (?:this|you|all|your)\b.*$/i,
  /^hope (?:you|this|all|your)(?:'re| are| is|'s)?\b.*$/i,
  /^(?:i )?(?:just )?(?:wanted|want) to (?:reach out|touch base|follow up|check in)\.?$/i,
  /^(?:i am|i'm) (?:writing|reaching out|emailing) (?:to you )?(?:today )?(?:to|regarding|about)?\.?$/i,
  /^(?:please )?(?:do not|don't) hesitate to (?:contact|get in touch|reach out).*$/i,
  /^(?:please )?(?:let me know|feel free to (?:reach out|contact)) if you have any (?:questions|queries|concerns).*$/i,
  /^(?:any questions,? )?(?:just )?(?:give me a shout|let me know)\.?$/i,
  /^looking forward to (?:hearing from you|your reply|your response|speaking).*$/i,
  /^thanks? (?:you )?(?:in advance|for your (?:time|help|patience|attention)).*$/i,
  /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.!?]{0,40}[,!]?$/i,
  /^thanks? (?:you )?(?:so much )?for (?:your|the) (?:order|purchase|email|message|reply|quick reply)!?$/i,
  /^welcome to (?:another|this week's|the latest)\b.*$/i,
  /^(?:we've|we have) got (?:loads|lots|plenty)\b.*$/i,
  /^happy (?:monday|tuesday|wednesday|thursday|friday)!?$/i,
  /^have a (?:great|good|lovely|nice) (?:day|week|weekend|evening).*$/i,
];

// Throat-clearing at the start of a sentence; the rest of the sentence is kept.
const FILLER_PREFIXES = [
  [/^(?:i )?(?:just )?(?:wanted|want|am writing|'m writing|am reaching out|'m reaching out|am emailing|'m emailing) (?:to )?(?:reach out|touch base|follow up|get in touch|check in)?(?: with you)? ?(?:regarding|about|on|re)\s+/i, 'About '],
  [/^(?:i )?(?:just )?(?:wanted|want) to let you know(?: that)?\s+/i, ''],
  [/^(?:this is (?:just )?a (?:quick |friendly )?reminder that|just a (?:quick |friendly )?reminder that|quick one\s*[—–-]|also,|so,|in terms of next steps,|as discussed,|further to (?:our|my) (?:call|conversation|email)(?: [a-z ]{0,20})?,)\s*/i, ''],
];

const ACTION_CUES = /\b(?:please|could you|can you|would you|need you to|you need to|you must|required|action required|make sure|remember to|don't forget|deadline|due|by (?:eod|end of day|cob|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|asap|urgent|sign|approve|confirm|reply|respond|submit|pay|book|send)\b/i;

const URGENT_CUES = /\b(?:urgent|asap|immediately|today|by eod|end of day|overdue|final notice|last chance|action required|deadline|expires?|suspended|important)\b/i;

const DAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?';
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = new RegExp(
  [
    `\\b(?:(?:this|next|on|by|before|until)\\s+)?${DAY}\\b(?:\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s+${MONTH})?)?`,
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:\\s+\\d{4})?\\b`,
    `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`,
    `\\b\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?\\b`,
    `\\b(?:today|tonight|tomorrow|this (?:week|weekend|morning|afternoon|evening)|next week|end of (?:the )?(?:day|week|month)|eod|eow|cob)\\b`,
  ].join('|'),
  'gi',
);
const TIME_RE = /\b(?:\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})\b/gi;
const MONEY_RE = /(?:[£$€]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|m|bn))?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:GBP|USD|EUR|pounds|dollars|euros)\b)/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/gi;

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|table|blockquote)>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function cutQuotedReply(text) {
  let end = text.length;
  for (const re of REPLY_MARKERS) {
    const m = re.exec(text);
    if (m && m.index > 0 && m.index < end) end = m.index;
  }
  return text
    .slice(0, end)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

function cutSignature(text) {
  const lines = text.split('\n');
  // Classic "-- " delimiter wins outright.
  const dash = lines.findIndex((l) => /^--\s?$/.test(l));
  let end = dash > 0 ? dash : lines.length;
  // Otherwise a sign-off in the bottom part of the email ends the useful content.
  const searchFrom = Math.floor(end * 0.4);
  for (let i = searchFrom; i < end; i++) {
    const l = lines[i].trim();
    if (SIGNOFF.test(l) || MOBILE_SIG.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(0, end).join('\n');
}

function hasFooterHint(str) {
  const lower = str.toLowerCase();
  return FOOTER_HINTS.some((h) => lower.includes(h));
}

// Short paragraphs with a footer hint go entirely; in long ones (often an HTML
// email collapsed into one block) only the offending sentences are dropped.
function stripFooter(p) {
  if (!hasFooterHint(p)) return p;
  if (p.length < 400) return '';
  return splitSentences(p).filter((s) => !hasFooterHint(s)).join(' ');
}

function splitSentences(paragraph) {
  return paragraph
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'£$€(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripPrefixes(sentence) {
  let out = sentence;
  for (const [re, sub] of FILLER_PREFIXES) out = out.replace(re, sub);
  if (out === sentence || !out) return sentence;
  return out[0].toUpperCase() + out.slice(1);
}

function isFiller(sentence) {
  const s = sentence.replace(/[.!]+$/, '').trim();
  return FILLER.some((re) => re.test(s) || re.test(sentence));
}

function shortenUrls(text, links) {
  return text.replace(URL_RE, (url) => {
    let label;
    try {
      label = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
    if (!links.some((l) => l.url === url)) links.push({ url, label });
    return `[${label}]`;
  });
}

function uniq(arr) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function classify({ from = '', subject = '', raw = '' }) {
  const f = from.toLowerCase();
  const s = `${subject}\n${raw}`.toLowerCase();
  if (/\b(?:your receipt|receipt for|invoice #|order confirmation|order #|your order|payment received|we've received your payment)\b/.test(s)) return 'receipt';
  if (/unsubscribe|newsletter|view in browser|this week in|digest/.test(s)) return /% off|sale|deal|offer|discount|promo/.test(s) ? 'promo' : 'newsletter';
  if (/no-?reply|notifications?@|alerts?@|mailer|donotreply/.test(f)) return 'notification';
  return 'person';
}

/**
 * @param {{ text?: string, html?: string, subject?: string, from?: string }} email
 */
function clean(email) {
  const raw = (email.text && email.text.trim()) ? email.text : htmlToText(email.html);
  let text = String(raw || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  text = cutQuotedReply(text);
  text = cutSignature(text);

  const links = [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => stripFooter(p.trim()))
    .filter(Boolean);

  const kept = [];
  for (const p of paragraphs) {
    const isList = /^\s*(?:[•\-*]|\d+[.)])\s/m.test(p);
    if (isList) {
      kept.push(shortenUrls(p.replace(/[ \t]+/g, ' '), links));
      continue;
    }
    const sentences = splitSentences(p).filter((s) => !isFiller(s)).map(stripPrefixes);
    if (sentences.length) kept.push(shortenUrls(sentences.join(' '), links));
  }

  const body = kept.join('\n\n').trim();
  const allSentences = kept.flatMap((p) => p.split('\n')).flatMap(splitSentences);

  const questions = uniq(allSentences.filter((s) => /\?\s*$/.test(s)));
  const category = classify({ from: email.from, subject: email.subject, raw });
  const marketing = category === 'newsletter' || category === 'promo';
  const actions = marketing ? [] : uniq(
    allSentences.filter((s) => ACTION_CUES.test(s) && !/\?\s*$/.test(s) && s.length < 240),
  );
  const dates = uniq([...body.matchAll(DATE_RE)].map((m) => m[0].trim()).filter((d) => d.length > 2));
  const times = uniq([...body.matchAll(TIME_RE)].map((m) => m[0].trim()));
  const amounts = uniq([...body.matchAll(MONEY_RE)].map((m) => m[0].trim()));

  const rawWords = String(raw || '').split(/\s+/).filter(Boolean).length;
  const keptWords = body.split(/\s+/).filter(Boolean).length;
  const urgent = !marketing && URGENT_CUES.test(`${email.subject || ''} ${body}`);

  return {
    body,
    keyPoints: allSentences.filter((s) => !questions.includes(s)).slice(0, 3),
    questions,
    actions,
    dates,
    times,
    amounts,
    links,
    category,
    urgency: urgent ? 'high' : (actions.length || questions.length) && category === 'person' ? 'normal' : 'low',
    stats: { rawWords, keptWords, saved: Math.max(0, rawWords - keptWords) },
  };
}

module.exports = { clean, htmlToText, splitSentences };
