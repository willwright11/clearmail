// IMAP, for reading only. Works with any provider that supports app passwords.
// Outlook / Office 365 is not offered: Microsoft has turned off app-password IMAP.
//
// ClearMail only reads: it can't send, delete, move, mark or change anything. The inbox and
// the Sent folder are opened read-only (EXAMINE), and imapflow fetches every body with
// BODY.PEEK, so reading never marks anything as read. Nothing here sets a flag, moves,
// copies, deletes or adds a message.

/**
 * An email as both backends return it (src/microsoft.js builds the same shape).
 * @typedef {{ name: string, address: string }} Address  the address is lower-cased
 * @typedef {{ listUnsubscribe: string|null, listId: string|null, precedence: string|null,
 *   autoSubmitted: string|null }} MailHeaders  raw values (precedence and autoSubmitted lower-cased)
 * @typedef {Object} RawEmail
 * @property {string} id
 * @property {string|null} messageId
 * @property {number|null} uid
 * @property {Address} from
 * @property {Address|null} replyTo
 * @property {Address[]} to
 * @property {Address[]} cc
 * @property {string} subject
 * @property {string} date  ISO: when it was sent
 * @property {string} receivedAt  ISO: when it arrived (the server's INTERNALDATE)
 * @property {string} text
 * @property {string} html  kept as data, never rendered
 * @property {boolean} seen  the mailbox's own read state (ClearMail never changes it)
 * @property {boolean} flagged
 * @property {string[]} references
 * @property {{ filename: string, size: number }[]} attachments
 * @property {MailHeaders|null} headers  null when the email couldn't be read
 * @property {'low'|'normal'|'high'} importance
 * @property {null} focused  Outlook only
 * @property {null} conversationId  Outlook only
 * @property {string|null} inReplyTo
 * @property {null} webLink  Outlook only
 *
 * What fetchSentHistory returns. `full` means the entries are the whole history (start
 * again from them); otherwise they are only what was sent since the cursor passed in.
 * @typedef {{ from: string, to: string[], date: string, conversationId: null,
 *   inReplyTo: string|null }} SentEntry  addresses lower-cased; to holds To, Cc and Bcc
 * @typedef {{ cursor: { kind: 'imap', path: string|null, uidValidity: string|null, lastUid: number,
 *   fullAt: number }, full: boolean, entries: SentEntry[] }} SentBatch
 */

const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { htmlToText } = require('./cleaner');

const PROVIDERS = {
  gmail: { label: 'Gmail', imap: { host: 'imap.gmail.com', port: 993, secure: true } },
  icloud: { label: 'iCloud', imap: { host: 'imap.mail.me.com', port: 993, secure: true } },
  yahoo: { label: 'Yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true } },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

const FULL_FETCH_LIMIT = 1024 * 1024; // messages up to this size are downloaded whole
const TEXT_PART_LIMIT = 1024 * 1024; // bigger messages: only their text parts, capped at this
// Inline images stay cid: links instead of being copied into the html as huge data: URLs.
// textAsHtml is never used, and building it is most of the parse time for a long email.
// mailparser's own HTML-to-text can block the main process for many seconds on deeply
// nested HTML, so it is skipped and ClearMail's linear converter is used instead (parse()).
const PARSE_OPTIONS = { keepCidLinks: true, skipTextToHtml: true, skipHtmlToText: true };
const UNREADABLE = "ClearMail couldn't read this email. Open it in your usual mail app to see it.";
const TRUNCATED = 'This email is very long, so ClearMail only downloaded the start of it. Open it in your usual mail app to read the rest.';
const LOGIN_REJECTED = 'Your email provider rejected the login. Check your email address and app password in Settings.';
const ADDRESS_LIMIT = 500; // recipients kept per email
const SENT_LIMIT = 500; // sent emails read at most per sync
const SENT_FULL_EVERY_MS = 30 * 24 * 3600 * 1000; // the sent history is rebuilt from scratch this often

// Parsed emails from each account's last load, so a refresh only downloads new messages.
// account fingerprint -> { key, emails }; only the most recently loaded accounts are kept.
const inboxCache = new Map();
const CACHED_ACCOUNTS = 20;

function userError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

function checkLogin(account) {
  if (!account.user || !account.pass) throw userError('Add your email address and app password in Settings.');
}

function presetFor(account) {
  return Object.hasOwn(PROVIDERS, account.provider) ? PROVIDERS[account.provider] : null;
}

function imapConfig(account) {
  const preset = presetFor(account);
  if (preset) return { ...preset.imap };
  const host = String(account.imapHost || '').trim();
  if (!host) throw userError('Enter your IMAP server in Settings.');
  const n = Number(account.imapPort);
  const port = Number.isInteger(n) && n > 0 && n < 65536 ? n : 993;
  const mode = account.imapSecurity;
  const secure = mode === 'tls' || (mode !== 'starttls' && [993, 465].includes(port));
  if (secure) return { host, port, secure: true };
  // STARTTLS must succeed: never fall back to sending the password in plain text.
  return { host, port, secure: false, doSTARTTLS: true };
}

function accountKey(account) {
  const id = `${String(account.user || '').trim().toLowerCase()}\n${imapConfig(account).host.toLowerCase()}`;
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 10);
}

// Turns any IMAP/network failure into a sentence the user can act on.
function friendlyError(err, action) {
  if (err && err.userFacing) return err;
  const text = String((err && err.message) || '');
  // A wrapped socket error may carry Node's code only in its message, so look there too.
  const codes = new Set([String((err && err.code) || ''), ...(text.match(/\bE[A-Z]{4,}\b/g) || [])]);
  const has = (...list) => list.some((c) => codes.has(c));
  const raw = typeof err?.responseText === 'string' ? err.responseText : typeof err?.response === 'string' ? err.response : '';
  const said = raw.replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 200);
  const saidSuffix = said ? ` The server said: "${said}"` : '';
  let message;
  if (err?.authenticationFailed || err?.serverResponseCode === 'AUTHENTICATIONFAILED') {
    message = LOGIN_REJECTED + saidSuffix;
  } else if (has('ENOTFOUND', 'EAI_AGAIN')) {
    message = "Couldn't find your mail server. Check your internet connection and the server name in Settings.";
  } else if (has('ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL')) {
    message = "Couldn't connect to your mail server. Check your internet connection, and the server and port in Settings.";
  } else if (has('ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT')) {
    message = 'Your mail server took too long to respond. Check your internet connection and try again.';
  } else if ([...codes].some((c) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c)) || /certificate/i.test(text)) {
    message = "Your mail server's security certificate couldn't be verified, so ClearMail didn't connect.";
  } else if (err?.tlsFailed || [...codes].some((c) => /^ERR_(SSL|TLS)_/.test(c)) || /STARTTLS|wrong version number|\b(ssl|tls)\b/i.test(text)) {
    message = "Couldn't set up a secure connection to your mail server. Check the server, port and security setting in Settings.";
  } else if (has('NoConnection', 'EConnectionClosed', 'ECONNRESET', 'EPIPE', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS')) {
    message = 'Lost the connection to your mail server. Check your internet connection and try again.';
  } else if (said) {
    message = `${action}.${saidSuffix}`;
  } else {
    message = `${action}. Please try again.${text ? ` (${text.slice(0, 200)})` : ''}`;
  }
  return new Error(message, { cause: err });
}

function openImap(account) {
  const client = new ImapFlow({
    ...imapConfig(account),
    auth: { user: account.user, pass: account.pass },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 30 * 1000,
    socketTimeout: 90 * 1000,
  });
  // Without a listener a dropped connection throws in the main process. The command in
  // flight still rejects, so the caller sees the failure anyway.
  client.on('error', (err) => console.warn('IMAP connection error:', err.code || err.message));
  return client;
}

// Runs fn(client) on a fresh connection and always closes it, even when login fails.
async function withImap(account, fn) {
  checkLogin(account);
  const client = openImap(account);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    if (client.usable) {
      // Log out politely, but don't hang on a dead connection.
      let timer;
      const giveUp = new Promise((resolve) => { timer = setTimeout(resolve, 5000); });
      await Promise.race([client.logout().catch(() => {}), giveUp]);
      clearTimeout(timer);
    }
    client.close();
  }
}

// The inbox, opened read-only (EXAMINE): nothing done inside can change it.
function withInbox(account, fn) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

function toAddress(entry) {
  if (!entry || !entry.address) return null;
  const address = String(entry.address).trim().toLowerCase();
  return { name: String(entry.name || '').trim() || address, address };
}

// First real address in a mailparser or envelope address list (groups flattened).
function firstAddress(list) {
  for (const entry of [].concat(list || [])) {
    const found = entry && (entry.group ? firstAddress(entry.group) : toAddress(entry));
    if (found) return found;
  }
  return null;
}

// The first real address (name@host) in a list ("Team <fraud-team>" isn't one).
function firstEmail(list) {
  for (const entry of [].concat(list || [])) {
    const found = entry && (entry.group ? firstEmail(entry.group) : toAddress(entry));
    if (found && EMAIL_RE.test(found.address)) return found;
  }
  return null;
}

// Every real address in mailparser or envelope address lists, once each (groups flattened).
function addressList(...lists) {
  const out = new Map();
  const add = (entry) => {
    if (!entry || out.size >= ADDRESS_LIMIT) return;
    if (entry.group) return [].concat(entry.group || []).forEach(add);
    const found = toAddress(entry);
    if (found && !out.has(found.address)) out.set(found.address, found);
  };
  for (const list of lists) [].concat(list || []).forEach(add);
  return [...out.values()];
}

// mailparser's To/Cc: one { value: [...] } per header line.
const parsedAddresses = (field) => [].concat(field || []).flatMap((header) => [].concat(header?.value || []));

function tidyHeader(value) {
  if (value == null) return null;
  const text = String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  return text || null;
}

const lowerHeader = (value) => tidyHeader(value)?.toLowerCase() ?? null;

// The first <message-id> in a header value.
function messageIdOf(value) {
  const text = tidyHeader(value);
  if (!text) return null;
  return /<[^<>\s]+>/.exec(text)?.[0] ?? text.split(' ')[0];
}

// Mailing-list and automatic-mail headers as written (like Graph's internetMessageHeaders),
// for sorting newsletters and notifications in src/triage.js.
function headerSignals(parsed) {
  const lines = Array.isArray(parsed.headerLines) ? parsed.headerLines : [];
  const raw = (key) => {
    const line = lines.find((l) => l && l.key === key);
    if (line) return String(line.line || '').replace(/^[^:]*:/, '');
    const value = parsed.headers?.get?.(key);
    return typeof value === 'string' ? value : null;
  };
  return {
    listUnsubscribe: tidyHeader(raw('list-unsubscribe')),
    listId: tidyHeader(raw('list-id')),
    precedence: lowerHeader(raw('precedence')),
    autoSubmitted: lowerHeader(raw('auto-submitted')),
  };
}

// mailparser reads Importance, Priority and X-Priority into one 'priority' header.
function importanceOf(parsed) {
  const value = String(parsed?.headers?.get?.('priority') || '').toLowerCase();
  return ['low', 'normal', 'high'].includes(value) ? value : 'normal';
}

const hasFlag = (meta, flag) => (meta.flags && typeof meta.flags.has === 'function' ? meta.flags.has(flag) : null);

function isoDate(...candidates) {
  for (const value of candidates) {
    const date = value ? new Date(value) : null;
    if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function decodedSize(node) {
  const size = Number(node.size) || 0;
  return node.encoding === 'base64' ? Math.floor((size * 3) / 4) : size;
}

// Splits a BODYSTRUCTURE into the text parts to read and the attachments to list, with
// mailparser's rules (images embedded in an html body are not attachments).
function splitStructure(node, related = false, out = { text: [], attachments: [] }) {
  if (node.type.startsWith('multipart/')) {
    for (const child of node.childNodes || []) splitStructure(child, related || node.type === 'multipart/related', out);
  } else if (['text/plain', 'text/html'].includes(node.type) && (!node.disposition || node.disposition === 'inline')) {
    out.text.push(node);
  } else if (!(related && node.id && node.type.startsWith('image/'))) {
    const filename = node.dispositionParameters?.filename || node.parameters?.name || 'attachment';
    out.attachments.push({ filename, size: decodedSize(node) });
  }
  return out;
}

// A single-part message has no part number: its body is the TEXT section (imapflow lower-cases keys).
const partKey = (node) => node.part || 'text';

// Rebuilds a MIME message holding only the downloaded text parts, so mailparser decodes
// their charsets and transfer encodings exactly as it would for the whole message.
function rebuildText(node, bodies) {
  const token = (value) => String(value || '').replace(/[^\w!#$&^.+/-]/g, '');
  if (node.type.startsWith('multipart/')) {
    const kids = (node.childNodes || []).map((child) => rebuildText(child, bodies)).filter(Boolean);
    if (!kids.length) return '';
    const boundary = `=_clearmail_${crypto.randomBytes(12).toString('hex')}`;
    return `Content-Type: ${token(node.type)}; boundary="${boundary}"\r\n\r\n` +
      kids.map((kid) => `--${boundary}\r\n${kid}\r\n`).join('') + `--${boundary}--\r\n`;
  }
  const body = bodies.get(partKey(node));
  if (!body) return '';
  const params = ['charset', 'format', 'delsp']
    .filter((key) => node.parameters?.[key])
    .map((key) => `; ${key}="${token(node.parameters[key])}"`)
    .join('');
  return `Content-Type: ${token(node.type)}${params}\r\nContent-Transfer-Encoding: ${token(node.encoding) || '7bit'}\r\n\r\n${body.toString('latin1')}`;
}

async function parse(source) {
  try {
    const parsed = await simpleParser(source, PARSE_OPTIONS);
    if (!(parsed.text && parsed.text.trim()) && typeof parsed.html === 'string' && parsed.html.trim()) {
      parsed.text = htmlToText(parsed.html);
    }
    return parsed;
  } catch (err) {
    console.warn('Could not parse an email:', err.message);
    return null;
  }
}

// parsed is null when the content could not be read. The envelope still says who it is
// from, so the user at least knows the email exists.
function buildEmail(id, meta, parsed, attachments) {
  const env = meta.envelope || {};
  return {
    id,
    messageId: parsed?.messageId || env.messageId || null,
    uid: meta.uid,
    from: firstAddress(parsed?.from?.value) || firstAddress(env.from) || { name: 'Unknown sender', address: '' },
    // The first Reply-To that is a real address, as microsoft.js keeps it.
    replyTo: parsed ? firstEmail(parsed.replyTo?.value) : firstEmail(env.replyTo),
    to: parsed?.to ? addressList(parsedAddresses(parsed.to)) : addressList(env.to),
    cc: parsed?.cc ? addressList(parsedAddresses(parsed.cc)) : addressList(env.cc),
    subject: String(parsed?.subject ?? env.subject ?? ''),
    date: isoDate(parsed?.date, env.date, meta.internalDate),
    receivedAt: isoDate(meta.internalDate, parsed?.date, env.date),
    text: parsed ? parsed.text || '' : UNREADABLE,
    html: typeof parsed?.html === 'string' ? parsed.html : '',
    seen: hasFlag(meta, '\\Seen') ?? false,
    flagged: hasFlag(meta, '\\Flagged') ?? false,
    references: [].concat(parsed?.references || []).filter((ref) => typeof ref === 'string' && ref.trim()),
    attachments,
    headers: parsed ? headerSignals(parsed) : null,
    importance: importanceOf(parsed),
    focused: null,
    conversationId: null,
    inReplyTo: messageIdOf(parsed ? parsed.inReplyTo : env.inReplyTo),
    webLink: null,
  };
}

// Big message: download its headers and text parts only, never the attachments.
// Resolves null if the message was deleted in the meantime.
async function fetchTextOnly(client, uid) {
  let structure = null;
  for await (const msg of client.fetch(String(uid), { uid: true, bodyStructure: true }, { uid: true })) {
    if (msg.uid === uid && msg.bodyStructure) structure = msg.bodyStructure;
  }
  if (!structure) return null;
  const { text, attachments } = splitStructure(structure);
  const query = { uid: true, headers: true, bodyParts: text.map((node) => ({ key: partKey(node), maxLength: TEXT_PART_LIMIT })) };
  let found = null;
  for await (const msg of client.fetch(String(uid), query, { uid: true })) {
    if (msg.uid === uid && msg.headers) found = msg;
  }
  if (!found) return null;
  const head = await parse(found.headers);
  const rebuilt = rebuildText(structure, found.bodyParts || new Map());
  const body = rebuilt ? await parse(Buffer.from(rebuilt, 'latin1')) : {};
  if (!head || !body) return { parsed: null, attachments };
  const parsed = { ...head, text: body.text || '', html: typeof body.html === 'string' ? body.html : '' };
  if (text.some((node) => (Number(node.size) || 0) > TEXT_PART_LIMIT)) {
    if (parsed.text) parsed.text += `\n\n[${TRUNCATED}]`;
    if (parsed.html) parsed.html += `<p>[${TRUNCATED}]</p>`;
    if (!parsed.text && !parsed.html) parsed.text = TRUNCATED;
  }
  return { parsed, attachments };
}

/**
 * The newest `limit` inbox messages, oldest first. Reading never marks anything as read.
 * @param {object} account
 * @param {{ limit?: number }} options
 * @returns {Promise<RawEmail[]>}
 */
async function fetchInbox(account, { limit = 60 } = {}) {
  const max = Math.min(Math.max(Math.floor(Number(limit)) || 60, 1), 500);
  try {
    const fp = accountKey(account);
    return await withInbox(account, async (client) => {
      const uidValidity = String(client.mailbox.uidValidity);
      const total = client.mailbox.exists;
      if (!total) return [];
      const key = `${fp}-${uidValidity}`;
      const last = inboxCache.get(fp);
      const cached = last && last.key === key ? last.emails : new Map();

      // 1. Cheap metadata for the newest messages.
      const metas = new Map();
      const range = `${Math.max(1, total - max + 1)}:*`;
      for await (const msg of client.fetch(range, { uid: true, flags: true, size: true, envelope: true, internalDate: true })) {
        if (!msg.uid) continue; // an unsolicited flag update without a UID
        metas.set(msg.uid, { ...metas.get(msg.uid), ...msg });
      }
      // Unsolicited flag updates carry no size: only keep the messages we asked for.
      const wanted = [...metas.values()].filter((meta) => meta.size !== undefined);

      // 2. Download only what isn't cached: small messages whole, big ones text only.
      const emails = new Map();
      const unreadable = new Set();
      const add = (meta, parsed, attachments) => {
        if (!parsed) unreadable.add(meta.uid);
        emails.set(meta.uid, buildEmail(`${key}-${meta.uid}`, meta, parsed, attachments));
      };
      const small = [];
      for (const meta of wanted) {
        const hit = cached.get(meta.uid);
        // Read and flagged can change in the user's mail app; the rest of an email never does.
        if (hit) emails.set(meta.uid, { ...hit, seen: hasFlag(meta, '\\Seen') ?? hit.seen, flagged: hasFlag(meta, '\\Flagged') ?? hit.flagged });
        else if (meta.size <= FULL_FETCH_LIMIT) small.push(meta);
      }
      if (small.length) {
        const byUid = new Map(small.map((meta) => [meta.uid, meta]));
        for await (const msg of client.fetch(small.map((meta) => meta.uid).join(','), { uid: true, source: true }, { uid: true })) {
          const meta = byUid.get(msg.uid);
          if (!meta || !msg.source || emails.has(msg.uid)) continue;
          const parsed = await parse(msg.source);
          const attachments = (parsed?.attachments || [])
            .filter((a) => !(a.related && /^image\//i.test(a.contentType || '')))
            .map((a) => ({ filename: a.filename || 'attachment', size: a.size || 0 }));
          add(meta, parsed, attachments);
        }
        // A small message that got no answer was deleted meanwhile, so it is left out.
      }
      for (const meta of wanted) {
        if (emails.has(meta.uid) || meta.size <= FULL_FETCH_LIMIT) continue;
        let result;
        try {
          result = await fetchTextOnly(client, meta.uid);
        } catch (err) {
          if (!client.usable) throw err;
          console.warn('Could not download a large email:', err.message);
          result = { parsed: null, attachments: [] };
        }
        if (result) add(meta, result.parsed, result.attachments);
      }

      const list = [...emails.values()];
      inboxCache.delete(fp); // re-added last, so the least recently loaded account goes first
      inboxCache.set(fp, { key, emails: new Map(list.filter((e) => !unreadable.has(e.uid)).map((e) => [e.uid, e])) });
      while (inboxCache.size > CACHED_ACCOUNTS) inboxCache.delete(inboxCache.keys().next().value);
      return list.map((e) => ({ ...e })).sort((a, b) => new Date(a.date) - new Date(b.date));
    });
  } catch (err) {
    throw friendlyError(err, "Couldn't load your inbox");
  }
}

// ---------- sent history ----------

// The Sent folder: the one marked \Sent, else one with a usual name such as "Sent Items"
// (imapflow works that out). null when there is none.
async function sentFolder(client) {
  return (await client.list()).find((box) => box.specialUse === '\\Sent') || null;
}

// One sent email from its envelope, or null without a usable date.
function sentEntry(env) {
  const date = env.date ? new Date(env.date) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return {
    from: firstAddress(env.from)?.address || '',
    to: addressList(env.to, env.cc, env.bcc).map((a) => a.address),
    date: date.toISOString(),
    conversationId: null,
    inReplyTo: messageIdOf(env.inReplyTo),
  };
}

// The cursor of an earlier sync of this same folder that can be continued, else null.
// UIDs only mean the same messages while UIDVALIDITY is unchanged.
function continuable(cursor, path, uidValidity, now) {
  if (!cursor || typeof cursor !== 'object' || cursor.kind !== 'imap') return null;
  const fullAt = Number(cursor.fullAt);
  const lastUid = Number(cursor.lastUid);
  if (cursor.path !== path || !uidValidity || String(cursor.uidValidity) !== uidValidity) return null;
  if (!Number.isInteger(lastUid) || lastUid < 0 || !Number.isFinite(fullAt) || fullAt > now || now - fullAt >= SENT_FULL_EVERY_MS) return null;
  return { lastUid, fullAt };
}

/**
 * Who the user has written to, from the Sent folder, opened read-only and read by envelope
 * only (no bodies): the newest 500 on the first sync, after the folder's UIDVALIDITY changes
 * and every 30 days; otherwise only what was sent since the cursor. No Sent folder means
 * an empty history, not an error.
 * @param {object} account
 * @param {SentBatch['cursor']|null} cursor  from the last SentBatch
 * @returns {Promise<SentBatch>}
 */
async function fetchSentHistory(account, cursor) {
  const now = Date.now();
  try {
    return await withImap(account, async (client) => {
      const sent = await sentFolder(client);
      if (!sent) return { cursor: { kind: 'imap', path: null, uidValidity: null, lastUid: 0, fullAt: now }, full: true, entries: [] };
      const lock = await client.getMailboxLock(sent.path, { readOnly: true });
      try {
        const box = client.mailbox;
        const uidValidity = box.uidValidity != null ? String(box.uidValidity) : null;
        const last = continuable(cursor, sent.path, uidValidity, now);
        const exists = Number(box.exists) || 0;
        const uidNext = Number(box.uidNext) || 0;
        const after = last ? last.lastUid : 0;
        let lastUid = after;
        const found = new Map(); // uid -> entry
        // First sync: the newest messages by position. Later: UIDs above the last one seen,
        // unless UIDNEXT says nothing new arrived.
        const range = !exists ? null
          : !last ? { set: `${Math.max(1, exists - SENT_LIMIT + 1)}:*`, uid: false }
            : !uidNext || uidNext > after + 1 ? { set: `${after + 1}:*`, uid: true } : null;
        if (range) {
          for await (const msg of client.fetch(range.set, { uid: true, envelope: true }, { uid: range.uid })) {
            // "n:*" also returns the newest message when n is past it, so old UIDs are skipped.
            if (!msg.uid || !msg.envelope || msg.uid <= after) continue;
            lastUid = Math.max(lastUid, msg.uid);
            const entry = sentEntry(msg.envelope);
            if (entry) found.set(msg.uid, entry);
          }
        }
        const entries = [...found.keys()].sort((a, b) => a - b).slice(-SENT_LIMIT).map((uid) => found.get(uid));
        return {
          cursor: { kind: 'imap', path: sent.path, uidValidity, lastUid, fullAt: last ? last.fullAt : now },
          full: !last,
          entries,
        };
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    throw friendlyError(err, "Couldn't read your sent emails");
  }
}

module.exports = { PROVIDERS, fetchInbox, fetchSentHistory };
