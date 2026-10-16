// Offline "waffle remover": strips quoted replies, signatures, legal footers and
// pleasantries, then pulls out the bits people tend to miss (asks, dates, money,
// links). Works with no network and no API key; the AI summariser builds on it.
// When in doubt it keeps text: a bit of leftover waffle beats a lost fact.

// ---------- Dates, money, links ----------

// A case-insensitive word inside a case-sensitive regex, so "Fri" and "friday"
// match but the ordinary words "sat", "sun", "wed" and "may" do not.
const ci = (word) => word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const anyOf = (words) => `(?:${words.map(ci).join('|')})`;

const DAY_FULL = anyOf(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const DAY_ABBR = '(?:Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\\b\\.?';
const MONTH = `(?:(?:${anyOf(['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december'])}|May|MAY)\\b|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\b\\.?)`;
// A day of the month, but not the hour in "Monday 9am" or "Friday 9:30".
const DAY_NUM = '\\d{1,2}(?:st|nd|rd|th)?(?!\\d|[:.]\\d|[ \\t]?(?:am|pm|AM|PM)\\b)';
const PREP = anyOf(['this', 'next', 'on', 'by', 'before', 'until', 'till', 'from']);

const DATE_RE = new RegExp(
  [
    // Friday, by Friday 17th October, Mon 13 Oct 2026 (abbreviated days need a number or a preposition)
    `\\b(?:(?:${PREP}[ \\t]+)?${DAY_FULL}\\b|${PREP}[ \\t]+${DAY_ABBR}|${DAY_ABBR}(?=,?[ \\t]+\\d))(?:,?[ \\t]+${DAY_NUM}(?:[ \\t]+(?:of[ \\t]+)?${MONTH}(?:,?[ \\t]+\\d{4}\\b)?)?)?`,
    // 17th October, 31 January 2027
    `\\b\\d{1,2}(?:st|nd|rd|th)?[ \\t]+(?:of[ \\t]+)?${MONTH}(?:,?[ \\t]+\\d{4}\\b)?`,
    // October 17, Oct 13, 2026, October 2026
    `\\b${MONTH}[ \\t]+(?:${DAY_NUM}(?:,?[ \\t]+\\d{4}\\b)?|\\d{4}\\b)`,
    // due in December, by end of March
    `\\b${anyOf(['in', 'by', 'until', 'till', 'before', 'from', 'during', 'early', 'late', 'mid', 'end of', 'start of'])}[ \\t-]+${MONTH}`,
    // 17/10, 16/10/2026, 16-10-2026, 16.10.2026, 2026-10-16 (not £12.50, 1.2, 3/4 of, 24/7: see realDate)
    '(?<![\\d.,/£$€-])\\d{1,2}/\\d{1,2}(?:/(?:\\d{4}|\\d{2}))?(?![\\d/]|[ \\t]+of\\b)',
    '(?<![\\d.,/£$€-])\\d{1,2}([.-])\\d{1,2}\\1(?:\\d{4}|\\d{2})(?!\\d)',
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    `\\b${anyOf(['today', 'tonight', 'tomorrow', 'this weekend', 'this week', 'this morning', 'this afternoon', 'this evening', 'next week', 'next month', 'end of the day', 'end of day', 'end of the week', 'end of week', 'end of the month', 'end of month', 'eod', 'eow', 'cob'])}\\b`,
  ].join('|'),
  'g',
);
const TIME_RE = /\b(?:\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})\b/gi;
// "£500 more" is £500, not £500m; "£14,750," does not keep the comma.
const MONEY_RE = /(?:[£$€] ?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?: ?(?:k|m|bn|million|billion)\b)?|\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})? ?(?:GBP|USD|EUR|pounds|dollars|euros)\b)/gi;
// Stops at brackets (html-to-text writes "Pay now [https://…]") but keeps balanced
// parentheses inside a URL (…/wiki/Bolt_(fastener)).
const URL_RE = /\bhttps?:\/\/(?:[^\s<>"'[\]()]|\([^\s<>"'()]*\))+(?<![.,;:!?])/gi;

// Non-global copies for yes/no checks.
const DATE_TEST = new RegExp(DATE_RE.source);
const TIME_TEST = new RegExp(TIME_RE.source, 'i');
const MONEY_TEST = new RegExp(MONEY_RE.source, 'i');

// Rejects numeric look-alikes such as 24/7 or 12-34-56 (a sort code).
function realDate(d) {
  const m = /^(\d{1,2})[/.-](\d{1,2})/.exec(d);
  if (!m) return d.length > 2;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return !(a === 24 && b === 7) && a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
}

// A '?', an amount or a date: things a footer or signature never needs.
const hasKeyFacts = (s) => s.includes('?') || MONEY_TEST.test(s) || DATE_TEST.test(s);
const hasFacts = (s) => /[\d£$€?]/.test(s) || DATE_TEST.test(s) || TIME_TEST.test(s);

const ACTION_CUES = /\b(?:please|could you|can you|would you|need you to|you need to|you must|required|action required|make sure|remember to|don't forget|deadline|due|by (?:eod|end of day|cob|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|asap|urgent|sign|approve|confirm|reply|respond|submit|pay|book|send)\b/i;

// Deadline phrasing, not just any mention of "today" or "important".
const URGENT_CUES = /\b(?:urgent(?:ly)?|asap|immediately|overdue|final (?:notice|reminder|demand)|last chance|action required|response required|deadline|suspended|time[- ]sensitive|today only|(?:by|before|due|until|end of) (?:today|tonight|eod|cob|end of (?:the )?day)|expir(?:es|ing|y)? (?:today|tomorrow|tonight|in \d+ (?:hours?|days?))|this is (?:urgent|important))\b|\bimportant\s*[:!]/i;
const NOT_URGENT = /\b(?:not|isn't|is not|nothing|no)\s+(?:urgent|important|rush)\b|\bno (?:rush|hurry)\b/gi;

// ---------- Quoted replies and forwards ----------

const QUOTE_LINE = /^\s*>/;
const FORWARD_MARKER = /^\s*(?:-{2,} ?(?:Forwarded message|Weitergeleitete Nachricht) ?-{2,}|Begin forwarded message:)\s*$/i;
const ORIGINAL_MARKER = /^\s*-{2,} ?Original Message ?-{2,}\s*$/i;
const RULE_LINE = /^\s*_{5,}\s*$/;
const HEADER = /^\s*\**(From|Sent|Date|To|Cc|Bcc|Subject|Reply-To)\**\s*:\**\s*(.*)$/i;
const REPLY_SUBJECT = /^\s*(?:re|aw|sv|antw|odp|vs)\s*:/i;
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|rv|enc)\s*:/i;
// "On Mon, 13 Oct 2026 at 09:12, Will <will@x.com> wrote:" and the same in other languages.
const ATTRIBUTION = /^.{0,300}?(?:\bwrote|\bschrieb|\bescribió|\ba écrit|\bha scritto|\bschreef|\bskrev)[^\n]{0,200}:\s*$/i;
const LABEL_RE = /^(?:Forwarded|Earlier) message(?: from .{1,200})?:$/;

// "From: …" followed by Sent/Date (with a time) and To/Subject lines, as mail clients
// write above a quoted or forwarded message. Returns { from, end } or null.
function headerBlock(lines, i, afterSeparator) {
  const first = HEADER.exec(lines[i] || '');
  if (!first || first[1].toLowerCase() !== 'from') return null;
  const seen = new Set();
  let timed = false;
  let end = i + 1;
  let last = 'from';
  for (; end < lines.length && end < i + 12; end++) {
    const h = HEADER.exec(lines[end]);
    if (h) {
      if (h[1].toLowerCase() === 'from') break; // the next message's header
      last = h[1].toLowerCase();
      seen.add(last);
      if ((last === 'sent' || last === 'date') && /\d{1,2}[:.]\d{2}/.test(h[2])) timed = true;
    } else if (!(lines[end].includes('@') && /^(?:to|cc|bcc)$/.test(last))) {
      break; // anything but a wrapped To:/Cc: list ends the block
    }
  }
  const addressed = /@|<[^>]*>/.test(first[2]);
  if (!timed || !(seen.has('to') || seen.has('cc') || seen.has('subject'))) return null;
  if (!addressed && !afterSeparator && !seen.has('sent')) return null;
  return { from: senderName(first[2]), end };
}

function senderName(value) {
  const v = value.replace(/\[mailto:[^\]]*\]/gi, '').replace(/\*/g, '');
  const name = v.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  const address = (/[^\s<>"'[\]]+@[^\s<>"'[\]]+/.exec(v) || [''])[0];
  return (name || address).slice(0, 120);
}

// Number of lines (1 or 2, Gmail wraps long ones) of a reply attribution at line i,
// or 0. It only counts when '>' quoted lines follow it.
function attributionLength(lines, i) {
  if (!/:\s*$/.test(lines[i]) && !/:\s*$/.test(lines[i + 1] || '')) return 0;
  for (const n of [1, 2]) {
    const part = lines.slice(i, i + n);
    if (part.length < n || part.some((l) => !l.trim() || QUOTE_LINE.test(l))) return 0;
    const joined = part.join(' ');
    if (!/:\s*$/.test(joined) || joined.length > 600 || !/[\d@]/.test(joined) || !ATTRIBUTION.test(joined)) continue;
    let k = i + n;
    while (k < lines.length && !lines[k].trim()) k++;
    if (k < lines.length && QUOTE_LINE.test(lines[k])) return n;
  }
  return 0;
}

// Removes one level of '>' from the quoted block that starts at line i.
function unquote(lines, i) {
  for (let k = i; k < lines.length && (QUOTE_LINE.test(lines[k]) || !lines[k].trim()); k++) {
    lines[k] = lines[k].replace(/^\s*>\s?/, '');
  }
}

// Drops '>' quoted lines and their attributions (inline answers between them stay),
// cuts the quoted history under an Outlook-style header in a reply, and keeps
// forwarded messages as labelled segments. Returns [{ label, text }].
function splitQuoted(text, subject = '') {
  const lines = text.split('\n');
  const isReply = REPLY_SUBJECT.test(subject);
  let forwarded = FORWARD_SUBJECT.test(subject);
  // '>' lines are old history only in a reply or under a "… wrote:" attribution. Elsewhere
  // (a booking site quoting a guest, an HTML <blockquote>) they are the content itself.
  const dropQuotes = isReply || lines.some((_, k) => attributionLength(lines, k) > 0);
  const segments = [{ label: null, lines: [] }];
  let hasContent = false; // any text kept yet
  for (let i = 0; i < lines.length; i++) {
    // Apple Mail's HTML puts a forwarded message, marker and all, in a blockquote. Unquote
    // it, except in a reply, where a quoted forward is old history.
    if (!isReply && QUOTE_LINE.test(lines[i]) && FORWARD_MARKER.test(lines[i].replace(/^\s*>\s?/, ''))) unquote(lines, i);
    if (QUOTE_LINE.test(lines[i])) {
      if (dropQuotes) continue;
      lines[i] = lines[i].replace(/^(?:\s*>\s?)+/, '');
    }
    const line = lines[i];

    const kind = FORWARD_MARKER.test(line) ? 'forward' : ORIGINAL_MARKER.test(line) ? 'original' : RULE_LINE.test(line) ? 'rule' : null;
    let j = i;
    if (kind) {
      j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (kind === 'forward' && QUOTE_LINE.test(lines[j] || '')) unquote(lines, j);
    }
    const block = headerBlock(lines, j, Boolean(kind));
    if (kind === 'forward' || kind === 'original' || block) {
      if (kind === 'forward') forwarded = true;
      if (isReply && !forwarded && hasContent) break; // the rest is the thread being replied to
      const from = block ? ` from ${block.from}` : '';
      const first = forwarded && segments.length === 1;
      segments.push({ label: `${first ? 'Forwarded' : 'Earlier'} message${from}:`, lines: [] });
      i = (block ? block.end : j) - 1;
      continue;
    }
    const attribution = attributionLength(lines, i);
    if (attribution) {
      i += attribution - 1;
      continue;
    }
    segments[segments.length - 1].lines.push(line);
    if (line.trim()) hasContent = true;
  }
  return segments.map((s) => ({ label: s.label, text: s.lines.join('\n') }));
}

// ---------- Signatures ----------

const SIGNOFF = /^(?:kind(?:est)? regards|best regards|warm(?:est)? regards|regards|best wishes|many thanks|with thanks|thanks(?: again| so much| a lot)?|thank you(?: so much)?|cheers|best|all the best|sincerely|yours (?:sincerely|faithfully|truly)|speak soon|talk soon|take care|ta|thx|love|lots of love|all my love)\b(.*)$/i;
// What may follow the sign-off word: up to two capitalised names ("Thanks Will", "Cheers, Sam x").
// Case-sensitive on purpose, so "Thanks for that." and "Love it!" are not sign-offs.
const SIGNOFF_TAIL = /^(?:[,.!]?[ \t]+[A-Z][\w'-]*){0,2}[ \t]*[,.!]*[ \t]*x*[ \t]*$/;
const MOBILE_SIG = /^(?:sent from my (?:iphone|ipad|android|samsung|mobile|phone)|get outlook for (?:ios|android)|sent from (?:outlook|mail|yahoo mail) for)/i;
const PS_LINE = /^\s*(?:P\.?\s?)+S\b/;
const SIG_SMALL_WORDS = new Set(['of', 'and', 'the', 'at', 'for', 'in', 'to', 'on', 'de', 'van', 'von', 'da', 'le', 'la']);

function isSignOff(line) {
  const l = line.trim();
  const m = SIGNOFF.exec(l);
  return (m && SIGNOFF_TAIL.test(m[1])) || MOBILE_SIG.test(l);
}

// Name, job title, company, phone, address, web: short, no asks, amounts, dates or sentences.
function isSignatureLine(line) {
  const l = line.trim();
  if (MOBILE_SIG.test(l)) return true;
  if (l.length > 80 || hasKeyFacts(l)) return false;
  const words = l.split(/\s+/);
  const lowerWords = words.filter((w) => /^[a-z][a-z'’-]*[,.;:!]?$/.test(w) && !SIG_SMALL_WORDS.has(w.replace(/[,.;:!]$/, '')));
  return lowerWords.length < 3 && !(words.length >= 4 && /[a-z][.!]$/.test(l));
}

// If lines[from..to) look like a signature (plus any legal footer), returns where it
// ends: `to`, or the index of a P.S. line that should be kept. Otherwise -1.
function signatureEnd(lines, from, to, maxLines) {
  let count = 0;
  let scanned = 0;
  let inFooter = false;
  for (let j = from; j < to; j++) {
    const l = lines[j];
    if (!l.trim()) {
      inFooter = false;
      continue;
    }
    if (PS_LINE.test(l)) return j;
    if (++scanned > 40) return -1;
    if (isFooter(l)) inFooter = true;
    if (inFooter) continue; // a wrapped disclaimer runs on until a blank line
    if (!isSignatureLine(l) || ++count > maxLines) return -1;
  }
  return to;
}

function cutSignature(text) {
  const lines = text.split('\n');
  let end = lines.length;
  let keepFrom = lines.length; // a P.S. after the signature is kept
  // The last "-- " delimiter, if what follows it is signature-sized.
  let dash = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^--\s?$/.test(lines[i])) {
      dash = i;
      break;
    }
  }
  if (dash > 0) {
    const stop = signatureEnd(lines, dash + 1, lines.length, 8);
    if (stop >= 0) {
      end = dash;
      keepFrom = stop;
    }
  }
  // A sign-off ("Thanks,", "Kind regards") counts only when just a signature follows it.
  for (let i = 0; i < end; i++) {
    if (!isSignOff(lines[i])) continue;
    const stop = signatureEnd(lines, i + 1, end, 6);
    if (stop < 0) continue;
    if (stop < end) keepFrom = stop;
    end = i;
    break;
  }
  const out = [...lines.slice(0, end), ...lines.slice(keepFrom)].join('\n');
  return out.trim() ? out : text;
}

// ---------- Footers ----------

// Multi-word phrases only: a bare "confidential" or "disclaimer" is often real content.
const FOOTER_HINTS = [
  'unsubscribe', 'intended recipient', 'intended solely for', 'intended only for', 'received this email in error',
  'received this e-mail in error', 'received this message in error', 'this email and any attachments',
  'this e-mail and any attachments', 'this message and any attachments', 'may contain confidential',
  'confidentiality notice', 'privileged and confidential', 'confidential and privileged', 'is confidential and',
  'are confidential and', 'view in browser', 'view this email in', 'view it in your browser', 'this email was sent to',
  'you are receiving this', "you're receiving this", 'you received this email because', 'manage preferences',
  'manage your preferences', 'email preferences', 'update your preferences', 'registered in england',
  'registered in scotland', 'registered in wales', 'registered office', 'company number', 'company registration',
  'all rights reserved', 'please consider the environment', 'privacy policy', 'privacy notice',
  'do not reply to this email', 'please do not reply', 'mailbox is not monitored', 'no-reply', 'noreply',
];
const FOOTER_RE = new RegExp(`(?:^|\\W)(?:${FOOTER_HINTS.map((h) => h.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(?![a-z])`, 'i');

// A person writing ("I tried to unsubscribe…") is not a footer; footers say "we" and "you".
const FIRST_PERSON = /\b(?:I|I'm|I’m|I've|I’ve|I'd|I’d|I'll|I’ll|me|my)\b/;
const isFooter = (s) => FOOTER_RE.test(s.includes('’') ? s.replace(/’/g, "'") : s) && !hasKeyFacts(s) && !FIRST_PERSON.test(s);
// Boilerplate that is never real content, wherever it sits (other footer text only goes
// when nothing important comes after it).
const STRONG_FOOTER = /\bview (?:this (?:email|message) |it )?in (?:your |a )?(?:web )?browser\b|\bhaving trouble viewing\b|\bthis e-?mail and any attachments\b|\bintended recipient\b|\breceived this (?:e-?mail|message) in error\b/i;
const isStrongFooter = (s) => STRONG_FOOTER.test(s) && !ACTION_CUES.test(s);

// ---------- Pleasantries ----------

const GREETING = /^(?:hi|hello|hey|hiya|dear|good (?:morning|afternoon|evening)|morning|afternoon|evening)\b/i;
// Names after the greeting must be capitalised ("Hi Will"), so "Hi Will running late" is not a greeting.
const GREETING_NAMES = /^(?:[ \t]+(?:[A-Z][\w'.-]*|all|team|everyone|guys|folks|there|son|mum|dad|both|sir|madam|or|and|&))*/;

function greetingLength(s) {
  const g = GREETING.exec(s);
  if (!g) return -1;
  const names = GREETING_NAMES.exec(s.slice(g[0].length));
  return names[0].split(/[ \t]+/).length > 5 ? -1 : g[0].length + names[0].length;
}

const isGreetingLine = (line) => {
  const n = greetingLength(line.trim());
  return n >= 0 && /^[ \t]*[,!.:]*[ \t]*$/.test(line.trim().slice(n));
};

// "Hi Will, running 20 mins late." -> "running 20 mins late."
function stripGreeting(s) {
  const n = greetingLength(s);
  if (n < 0) return s;
  const sep = /^[ \t]*[,!][ \t]+(?=\S)/.exec(s.slice(n));
  return sep ? s.slice(n + sep[0].length) : s;
}

// Sentences made only of these clauses carry no information. Each one is a complete
// phrase, so "I hope you can make Friday" or "Thanks for your patience, the refund…" survive.
const PLEASANTRIES = [
  "(?:(?:i|we) )?(?:really |just )?hope (?:that )?(?:you(?:'re| are)(?: all)?|all(?:'s| is)|everything(?:'s| is)|things are|you and (?:the|your) family are|you(?:'re| are|'ve been| have been) (?:keeping|doing)) (?:well|ok|okay|good|great|fine)(?: with you)?(?: too)?",
  "(?:(?:i|we) )?(?:really |just )?hope (?:that )?this (?:e-?mail |message |note )?finds you (?:well|in good (?:health|spirits))",
  "(?:(?:i|we) )?(?:really |just )?hope (?:that )?you(?: all)?(?: had| have had|'ve had| are having|'re having| have| enjoyed)? an? (?:good|great|lovely|nice|restful|relaxing|fab|fantastic|wonderful) (?:weekend|week|day|break|holiday|time off|christmas|easter|summer|new year)",
  '(?:(?:i|we) )?(?:really |just )?hope (?:that )?(?:this|that|it) helps',
  "(?:thanks|thank you|many thanks)(?: (?:so|very|ever so) much| a lot| again)?(?: for (?:your|the) (?:time|help|patience|attention|understanding|consideration|email|e-mail|message|note|reply|quick reply|prompt reply|response|quick response|prompt response|order|purchase|update|call|chat|feedback))?",
  '(?:thanks|thank you)(?: (?:so|very|ever so) much)? for getting back to me(?: so (?:quickly|promptly|fast|soon))?',
  '(?:thanks|thank you) in advance(?: for (?:your|the) help)?',
  "(?:it's|it is|that's|that is|this is)(?: (?:really|much|greatly|very much|so|always))* appreciated",
  "(?:please )?(?:do not|don't|dont) hesitate to (?:contact (?:me|us)|get in touch|reach out|call (?:me|us)|ask|let (?:me|us) know)(?: (?:if|should) you (?:have|need) (?:any|anything)(?: (?:further|other|more|else))?(?: (?:questions|queries|concerns|help|information|info|assistance))?)?(?: at all)?",
  '(?:please |just )?(?:let me know|let us know|give (?:me|us) a (?:shout|call|ring|bell)|feel free to (?:reach out|contact (?:me|us)|get in touch|ask|call))(?: if (?:you (?:have|need)|there (?:are|is)) any(?:thing)?(?: (?:further|other|more|else))?(?: (?:questions|queries|concerns|help|issues|problems|thoughts))?)?(?: at all)?',
  '(?:if you have any (?:questions|queries|concerns)|any (?:questions|queries)),? (?:just |please )?(?:let me know|let us know|give (?:me|us) a (?:shout|call)|get in touch|shout)',
  "(?:(?:i'm|i am|we're|we are) )?(?:really )?looking forward to (?:hearing (?:from you|back)|your (?:reply|response|thoughts)|speaking (?:to|with) you|seeing you|working with you|catching up)(?: soon)?",
  '(?:(?:i|we) )?look forward to (?:hearing (?:from you|back)|your (?:reply|response|thoughts)|speaking (?:to|with) you|seeing you|working with you)(?: soon)?',
  '(?:i )?(?:just )?(?:wanted|want) to (?:reach out|touch base|follow up|check in)',
  "(?:i am|i'm) (?:just )?(?:writing|reaching out|emailing|getting in touch)(?: to you)?",
  'have an? (?:great|good|lovely|nice|fab|fantastic|wonderful)(?: rest of (?:the|your))? (?:day|week|weekend|evening|one)(?: all| everyone)?',
  'enjoy (?:the|your)(?: rest of (?:the|your))? (?:day|week|weekend|evening)',
  'happy (?:monday|tuesday|wednesday|thursday|friday|weekend|new year)',
  'cheers|ta|thx|take care|speak soon|talk soon|best wishes|kind regards|regards|good luck|best of luck',
];
// Only allowed after "and" in a chain: "…finds you well and that you had a lovely weekend".
const PLEASANTRY_TAILS = [
  "you(?: all)? (?:had|have had|'ve had|are having|'re having) an? (?:good|great|lovely|nice|restful|relaxing|fab|fantastic|wonderful) (?:weekend|week|day|break|holiday|time off|christmas|easter|summer|new year)",
  "you(?:'re| are) (?:keeping )?(?:well|ok|good)",
];
const PLEASANTRY = `(?:${PLEASANTRIES.join('|')})`;
const JOIN = '(?:\\s*[,;&]\\s*|\\s+[-–—]\\s+|,?\\s+(?:and|but)\\s+(?:that\\s+)?)';
const FILLER_RE = new RegExp(`^${PLEASANTRY}(?:${JOIN}(?:${PLEASANTRY}|${PLEASANTRY_TAILS.join('|')}))*$`, 'i');
// Newsletter fluff with an open end: dropped only if the sentence has no facts in it.
const FILLER_OPEN = [/^welcome to (?:another|this week's|the latest)\b/i, /^(?:we've|we have) got (?:loads|lots|plenty)\b/i];

// Throat-clearing at the start of a sentence; the rest of the sentence is kept.
const FILLER_PREFIXES = [
  [/^(?:i )?(?:just )?(?:wanted|want) to (?:reach out|touch base|follow up|get in touch|check in)(?: with you)? (?:regarding|about|re)\s+/i, 'About '],
  [/^(?:i am|i'm) (?:just )?(?:writing|reaching out|emailing|getting in touch)(?: to you)? (?:regarding|about|re|in relation to|with regard to)\s+/i, 'About '],
  [/^(?:(?:i )?(?:just )?(?:wanted|want)|(?:i am|i'm) (?:just )?writing) to let you know(?: that)?\s+/i, ''],
  [/^(?:this is (?:just )?a (?:quick |friendly )?reminder that|just a (?:quick |friendly )?reminder that|quick one\s*[—–-]|also,|so,|in terms of next steps,|as discussed,|further to (?:our|my) (?:call|conversation|email)(?: [a-z ]{0,20})?,)\s*/i, ''],
];

function isFiller(sentence) {
  const s = sentence.replace(/[‘’]/g, "'").replace(/[\s.!…\p{Extended_Pictographic}\uFE0F]+$/u, '').trim();
  if (!s) return false;
  if (isGreetingLine(s) || isSignOff(s) || FILLER_RE.test(s)) return true;
  return FILLER_OPEN.some((re) => re.test(s)) && !hasFacts(s);
}

function stripPrefixes(sentence) {
  let out = stripGreeting(sentence);
  for (const [re, sub] of FILLER_PREFIXES) out = out.replace(re, sub);
  if (out === sentence || !out) return sentence;
  return out[0].toUpperCase() + out.slice(1);
}

// ---------- Text helpers ----------

const ABBREVIATIONS = '(?:Mr|Mrs|Ms|Dr|St|Prof|Rev|No|Nos|Ltd|Inc|Co|Jr|Sr|approx|vs|e\\.g|i\\.e|P\\.S|P\\.P\\.S)';
const SENTENCE_BREAK = new RegExp(`(?<=[.!?])(?<!\\b${ABBREVIATIONS}\\.)\\s+(?=[A-Z0-9"'£$€(])`);
const LIST_MARKER = /^\s*(?:[•\-*]|\d+[.)])\s+/;
// A short line followed by a capitalised one ends a sentence even without a full stop
// ("Cheers\nYour car is ready"); longer lines may just be hard-wrapped text.
const SHORT_LINE_BREAK = /^([^\n]{1,50})\n(?=[ \t]*[A-Z0-9"'£$€(])/gm;

function splitSentences(paragraph) {
  return (paragraph.includes('\n') ? paragraph.replace(SHORT_LINE_BREAK, '$1\n\n') : paragraph)
    .split(/\n\n/)
    .flatMap((part) => part.replace(/\s+/g, ' ').trim().split(SENTENCE_BREAK))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Sentences go back together with a space, or a line break after one with no full stop.
const joinSentences = (units) => units.map((u, i) => (i && !/[.!?…]["')\]]*$/.test(units[i - 1]) ? `\n${u}` : i ? ` ${u}` : u)).join('');

// Lists and "Label: value" blocks (tickets, receipts, web forms) keep their lines.
function isStructured(p) {
  if (!p.includes('\n')) return LIST_MARKER.test(p);
  const lines = p.split('\n');
  if (lines.some((l) => LIST_MARKER.test(l))) return true;
  return lines.length >= 2 && lines.filter((l) => /^[^\s:][^:]{0,30}:\s+\S/.test(l)).length * 2 >= lines.length;
}

// Replaces each URL (and any brackets around it) with a short [label] in every text;
// links with the same host get their path added so every label can be told apart.
function shortenUrls(texts) {
  const parsed = new Map();
  for (const t of texts) {
    if (!t.includes('http')) continue;
    for (const [url] of t.matchAll(URL_RE)) {
      if (parsed.has(url)) continue;
      try {
        parsed.set(url, new URL(url));
      } catch {
        // not a usable URL: leave it as text
      }
    }
  }
  const hosts = {};
  for (const u of parsed.values()) {
    const host = u.hostname.replace(/^www\./, '');
    hosts[host] = (hosts[host] || 0) + 1;
  }
  const labels = new Map();
  const used = {};
  const links = [];
  for (const [url, u] of parsed) {
    const host = u.hostname.replace(/^www\./, '');
    let label = host;
    if (hosts[host] > 1) {
      label = `${host}${u.pathname.replace(/\/+$/, '')}`;
      if (label.length > 48) label = `${label.slice(0, 47)}…`;
    }
    used[label] = (used[label] || 0) + 1;
    if (used[label] > 1) label = `${label} #${used[label]}`;
    labels.set(url, label);
    links.push({ url, label });
  }
  const wrapped = new RegExp(`\\[(${URL_RE.source})\\]|\\((${URL_RE.source})\\)|<(${URL_RE.source})>|(${URL_RE.source})`, 'gi');
  const shortened = texts.map((t) => {
    if (!t.includes('http')) return t;
    return t
      .replace(wrapped, (m, a, b, c, d, offset) => {
        const url = a || b || c || d;
        if (!labels.has(url)) return m;
        return `${/\w/.test(t[offset - 1] || '') ? ' ' : ''}[${labels.get(url)}]`;
      })
      .replace(/(\[[^\]\n]+\])(?:[ \t]+\1)+/g, '$1'); // "https://x.com [https://x.com]"
  });
  return { texts: shortened, links };
}

// The three most informative sentences (amounts, dates, numbers, asks), in email order,
// so a forwarded message's facts are not pushed out by the note above it.
function pickKeyPoints(sentences) {
  const score = (s) => (MONEY_TEST.test(s) ? 3 : 0) + (DATE_TEST.test(s) ? 2 : 0) + (/\d/.test(s) ? 1 : 0) + (ACTION_CUES.test(s) ? 1 : 0);
  return sentences
    .map((s, i) => ({ s, i, score: score(s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

function countWords(s) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const space = s.charCodeAt(i) <= 32;
    if (!space && !inWord) n++;
    inWord = !space;
  }
  return n;
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

// ---------- Categories ----------

const RECEIPT_RE = /\b(?:your receipt|receipt (?:for|from|no\.?|number|#)|invoice (?:#|no\.|number)|order confirmation|order (?:#|no\.|number|ref(?:erence)?)\s*:?\s*[a-z]*-?\d|(?:thanks|thank you) for your (?:order|purchase)|payment (?:received|confirmation|confirmed)|we've received your payment|your order (?:has been|is|was) (?:confirmed|dispatched|shipped|received|ready))/i;
const BULK_CUES = /\bunsubscribe\b|\bview (?:this (?:email|message) |it )?(?:in|on) (?:your |a |the )?(?:browser|web)\b|\byou(?:'re| are) receiving this\b|\b(?:manage|update) (?:your )?(?:email |subscription |mailing )?preferences\b/i;
const BULK_SENDER = /^(?:newsletters?|news|marketing|offers|deals|promos?|promotions)[-._+@]/i;
const PROMO_RE = /\d+% off\b|\b(?:sale|deals?|offers?|discounts?|promo(?:tion)?s?|vouchers?|coupons?|clearance)\b/i;
const NOTIFY_SENDER = /(?:^|[-._+])(?:no[-_]?reply|do[-_]?not[-_]?reply)(?:[-._+@]|$)|^(?:notifications?|alerts?|mailer(?:-daemon)?|bounces?)[-._+@]|@(?:mailer|notifications?|alerts?|bounces?)\./i;

// `massMail` is true only on strong evidence (List-* headers passed in as `bulk`, or a
// newsletter-style sender); only then are actions and urgency switched off.
function classify({ from = '', subject = '', text = '', bulk = false }) {
  const f = String(from || '').toLowerCase();
  const s = `${subject || ''}\n${text}`.replace(/’/g, "'");
  const massMail = Boolean(bulk) || BULK_SENDER.test(f);
  let category = 'person';
  if (RECEIPT_RE.test(s)) category = 'receipt';
  else if (massMail || BULK_CUES.test(s) || /\bnewsletter\b/i.test(subject || '')) category = PROMO_RE.test(s) ? 'promo' : 'newsletter';
  else if (NOTIFY_SENDER.test(f)) category = 'notification';
  return { category, massMail };
}

// ---------- HTML ----------

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", pound: '£', euro: '€', cent: '¢', yen: '¥',
  dollar: '$', copy: '©', reg: '®', trade: '™', deg: '°', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»', bull: '•', middot: '·',
  times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', sect: '§', para: '¶', plusmn: '±', micro: 'µ',
  iexcl: '¡', iquest: '¿', szlig: 'ß', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', ensp: ' ', emsp: ' ',
  thinsp: ' ', zwnj: '', zwj: '', shy: '', lrm: '', rlm: '', rarr: '→', larr: '←', check: '✓',
};
const ACCENTS = { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', cedil: '\u0327', ring: '\u030a' };
// Numeric references in the 128–159 range mean Windows-1252 characters.
const CP1252 = { 128: '€', 130: '‚', 132: '„', 133: '…', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 153: '™' };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (m, dec, hex, name) => {
    if (name) {
      if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
      const a = /^([a-zA-Z])(acute|grave|circ|uml|tilde|cedil|ring)$/.exec(name);
      return a ? (a[1] + ACCENTS[a[2]]).normalize('NFC') : m;
    }
    const code = dec ? Number(dec) : parseInt(hex, 16);
    if (code >= 128 && code <= 159) return CP1252[code] || '';
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
    return String.fromCodePoint(code);
  });
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'caption', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'p', 'section',
  'summary', 'table', 'tr',
]);
const SKIP_TAGS = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi, title: /<\/title\s*>/gi, template: /<\/template\s*>/gi };
const TAG_NAME = /(\/?)([a-zA-Z][\w:-]*)/y;
const HREF_ATTR = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const ALT_ATTR = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const QUOTE_OPEN = '\u0001';
const QUOTE_CLOSE = '\u0002';

function attr(tag, re) {
  const m = re.exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

// Single pass over the HTML (linear time, so hostile or broken markup cannot stall
// the main process). Links become "label (url)", <blockquote> lines get "> ".
function htmlToText(html) {
  const src = String(html || '');
  const out = [];
  const lists = []; // open <ul>/<ol>; n counts <ol> items
  let link = null; // open <a>: { href, start }
  let pre = 0;
  let gt = -1; // position of the next '>', cached so it is searched for only once
  let i = 0;

  // Control characters go (they would clash with the quote markers). Outside <pre>
  // whitespace collapses, as in a browser.
  const text = (s) => {
    out.push(decodeEntities(pre ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : s.replace(/[\u0000-\u0020]+/g, ' ')));
  };
  const endLink = () => {
    const label = out.slice(link.start).join('').replace(/\s+/g, ' ').trim();
    const { href } = link;
    link = null;
    if (!label || !href) return;
    if (/^https?:\/\//i.test(href)) {
      if (!label.includes(href)) out.push(` (${href})`);
    } else if (/^(?:mailto|tel):/i.test(href)) {
      const value = href.replace(/^(?:mailto|tel):/i, '').split('?')[0];
      if (value && !label.includes(value)) out.push(` (${value})`);
    }
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      text(src.slice(i));
      break;
    }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (gt < lt) gt = src.indexOf('>', lt);
    if (gt === -1) {
      text(src.slice(lt));
      break;
    }
    TAG_NAME.lastIndex = lt + 1;
    const m = TAG_NAME.exec(src);
    if (!m) {
      if (src[lt + 1] === '!' || src[lt + 1] === '?') {
        i = gt + 1; // doctype, CDATA, processing instruction
      } else {
        out.push('<'); // a stray '<' in text
        i = lt + 1;
      }
      continue;
    }
    i = gt + 1;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (!closing && SKIP_TAGS[name]) {
      const close = SKIP_TAGS[name];
      close.lastIndex = i;
      const c = close.exec(src);
      i = c ? c.index + c[0].length : src.length;
      continue;
    }
    switch (name) {
      case 'br':
        out.push('\n');
        break;
      case 'td':
      case 'th':
        if (closing) out.push('\t');
        break;
      case 'li': {
        const list = lists[lists.length - 1];
        if (!closing) out.push(list && list.n !== null ? `\n${++list.n}. ` : '\n• ');
        break;
      }
      case 'ul':
      case 'ol':
        if (closing) lists.pop();
        else lists.push({ n: name === 'ol' ? 0 : null });
        out.push('\n\n');
        break;
      case 'blockquote':
        out.push(`\n${closing ? QUOTE_CLOSE : QUOTE_OPEN}\n`);
        break;
      case 'pre':
        pre = Math.max(0, pre + (closing ? -1 : 1));
        out.push('\n\n');
        break;
      case 'a':
        if (link) endLink();
        if (!closing) link = { href: attr(src.slice(lt, gt), HREF_ATTR), start: out.length };
        break;
      case 'img':
        if (link) out.push(attr(src.slice(lt, gt), ALT_ATTR)); // the alt text labels an image link
        break;
      default:
        if (BLOCK_TAGS.has(name)) out.push('\n\n');
    }
  }
  if (link) endLink();

  let depth = 0;
  const lines = [];
  for (const raw of out.join('').replace(/[\u200b-\u200d\u2060\ufeff\u034f]/g, '').split('\n')) {
    const line = raw.replace(/\u00a0/g, ' ').replace(/ {2,}/g, ' ').replace(/[ \t]*\t[ \t]*/g, '\t').trim();
    if (line === QUOTE_OPEN) depth++;
    else if (line === QUOTE_CLOSE) depth = Math.max(0, depth - 1);
    else lines.push(depth && line ? `> ${line}` : line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Main ----------

const DETAIL_LIMIT = 50_000;

/**
 * @param {{ text?: string, html?: string, subject?: string, from?: string, bulk?: boolean }} email
 *   bulk: optional, true when the message has List-Unsubscribe/List-Id or Precedence: bulk headers.
 */
function clean(email = {}) {
  const raw = (typeof email.text === 'string' && email.text.trim()) ? email.text : htmlToText(email.html);
  const text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\u2060\ufeff\u034f]/g, '');

  const segments = splitQuoted(text, email.subject || '');
  // Only the first DETAIL_LIMIT characters get the full treatment. The rest of a giant
  // email (a log, a huge newsletter) is kept as it is, so it cannot stall the main process.
  let room = DETAIL_LIMIT;
  let overflow = '';
  const cleanedText = segments
    .map(({ label, text: part }) => {
      if (room <= 0) {
        overflow += `\n${label || ''}\n${part}`;
        return '';
      }
      let head = part;
      if (part.length > room) {
        const cut = part.lastIndexOf('\n', room);
        head = part.slice(0, cut > 0 ? cut : room);
        overflow += part.slice(head.length);
      }
      room -= head.length;
      const kept = cutSignature(head)
        .split('\n')
        .filter((l) => !isGreetingLine(l) && !/^\s*[_=*~-]{5,}\s*$/.test(l))
        .join('\n')
        .trim();
      return label ? `${label}\n\n${kept}` : kept;
    })
    .filter(Boolean)
    .join('\n\n');

  // Units are sentences, or the lines of a list or "Label: value" block.
  const blocks = cleanedText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (LABEL_RE.test(p)) return { label: true, units: [p] };
      const structured = isStructured(p);
      const units = structured ? p.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean) : splitSentences(p);
      return { structured, units };
    });

  // Footer text is only dropped from the paragraphs after the last one with an ask, amount,
  // date or action, and never from the first one.
  for (const b of blocks) b.footer = b.label ? [] : b.units.map(isFooter);
  const important = (b) => !b.label && b.units.some((u, i) => !b.footer[i] && (hasKeyFacts(u) || ACTION_CUES.test(u)));
  let lastImportant = blocks.length - 1;
  while (lastImportant >= 0 && !important(blocks[lastImportant])) lastImportant--;
  lastImportant = Math.max(lastImportant, blocks.findIndex((b) => !b.label));

  const keptBlocks = [];
  blocks.forEach((b, n) => {
    if (b.label) {
      keptBlocks.push(b);
      return;
    }
    const keep = b.units.filter((u, i) => !(b.footer[i] && (n > lastImportant || isStrongFooter(u))) && (b.structured || !isFiller(u)));
    if (keep.length) keptBlocks.push({ structured: b.structured, units: b.structured ? keep.map(stripGreeting) : keep.map(stripPrefixes) });
  });
  // The overflow is kept verbatim; its dates and amounts are still picked up from the body.
  if (overflow.trim()) keptBlocks.push({ overflow: true, units: [overflow.trim().replace(/\n{3,}/g, '\n\n')] });

  // Shorten links across all kept units at once, so labels are unique email-wide.
  const { texts, links } = shortenUrls(keptBlocks.flatMap((b) => b.units));
  let t = 0;
  for (const b of keptBlocks) b.units = texts.slice(t, (t += b.units.length));
  const body = keptBlocks.map((b) => (b.structured || b.overflow ? b.units.join('\n') : joinSentences(b.units))).join('\n\n');
  const allSentences = keptBlocks
    .filter((b) => !b.label && !b.overflow)
    .flatMap((b) => (b.structured ? b.units.flatMap((u) => splitSentences(u.replace(LIST_MARKER, ''))) : b.units))
    .filter((s) => /\p{L}/u.test(s));

  const { category, massMail } = classify({
    from: email.from,
    subject: email.subject,
    text: segments.map((s) => s.text).join('\n'),
    bulk: email.bulk,
  });
  const marketing = massMail && (category === 'newsletter' || category === 'promo');
  const questions = marketing ? [] : uniq(allSentences.filter((s) => /\?\s*$/.test(s)));
  const actions = marketing ? [] : uniq(
    allSentences.filter((s) => ACTION_CUES.test(s) && !/\?\s*$/.test(s) && s.length < 240),
  );
  const dates = uniq([...body.matchAll(DATE_RE)].map((m) => m[0].trim()).filter(realDate));
  const times = uniq([...body.matchAll(TIME_RE)].map((m) => m[0].trim()));
  const amounts = uniq([...body.matchAll(MONEY_RE)].map((m) => m[0].trim()));

  const rawWords = countWords(String(raw || ''));
  const keptWords = countWords(body);
  // Marketing "last chance" / "today only" copy is never time-sensitive for the reader.
  const urgent = category !== 'promo' && category !== 'newsletter' && URGENT_CUES.test(`${email.subject || ''}\n${body}`.replace(NOT_URGENT, ''));
  const personLike = category === 'person' || ((category === 'newsletter' || category === 'promo') && !massMail);

  return {
    body,
    keyPoints: pickKeyPoints(allSentences.filter((s) => !/\?\s*$/.test(s))),
    questions,
    actions,
    dates,
    times,
    amounts,
    links,
    category,
    urgency: urgent ? 'high' : (actions.length || questions.length) && personLike ? 'normal' : 'low',
    stats: { rawWords, keptWords, saved: Math.max(0, rawWords - keptWords) },
  };
}

module.exports = { clean, htmlToText, splitSentences };
