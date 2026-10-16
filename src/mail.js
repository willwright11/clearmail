// IMAP (read) + SMTP (reply). Works with any provider that supports app passwords.
// Outlook / Office 365 is not offered: Microsoft has turned off app-password IMAP and SMTP.

const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { htmlToText } = require('./cleaner');

// savesSent: the provider files mail sent over SMTP in Sent itself, so we must not add a copy.
const PROVIDERS = {
  gmail: {
    label: 'Gmail',
    savesSent: true,
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  },
  icloud: {
    label: 'iCloud',
    savesSent: false,
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true },
  },
  yahoo: {
    label: 'Yahoo',
    savesSent: true,
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  },
};

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
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

// Parsed emails from the last load, so a refresh only downloads new messages.
let inboxCache = { key: null, emails: new Map() };
const uidValidityByAccount = new Map();

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

function serverConfig(account, kind) {
  const preset = presetFor(account);
  if (preset) return { ...preset[kind] };
  const host = String(account[`${kind}Host`] || '').trim();
  if (!host) throw userError(`Enter your ${kind.toUpperCase()} server in Settings.`);
  const n = Number(account[`${kind}Port`]);
  const port = Number.isInteger(n) && n > 0 && n < 65536 ? n : kind === 'imap' ? 993 : 465;
  const mode = account[`${kind}Security`];
  const secure = mode === 'tls' || (mode !== 'starttls' && [993, 465].includes(port));
  if (secure) return { host, port, secure: true };
  // STARTTLS must succeed: never fall back to sending the password in plain text.
  return kind === 'smtp' ? { host, port, secure: false, requireTLS: true } : { host, port, secure: false, doSTARTTLS: true };
}

function accountKey(account) {
  const id = `${String(account.user || '').trim().toLowerCase()}\n${serverConfig(account, 'imap').host.toLowerCase()}`;
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 10);
}

// Turns any IMAP/SMTP/network failure into a sentence the user can act on.
function friendlyError(err, action) {
  if (err && err.userFacing) return err;
  const text = String((err && err.message) || '');
  // nodemailer wraps socket errors as ESOCKET, so also look for Node's code in the message.
  const codes = new Set([String((err && err.code) || ''), ...(text.match(/\bE[A-Z]{4,}\b/g) || [])]);
  const has = (...list) => list.some((c) => codes.has(c));
  const raw = typeof err?.responseText === 'string' ? err.responseText : typeof err?.response === 'string' ? err.response : '';
  const said = raw.replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 200);
  const saidSuffix = said ? ` The server said: "${said}"` : '';
  let message;
  if (err?.authenticationFailed || has('EAUTH') || err?.serverResponseCode === 'AUTHENTICATIONFAILED') {
    message = LOGIN_REJECTED + saidSuffix;
  } else if (has('ENOAUTH')) {
    message = 'Add your email address and app password in Settings.';
  } else if (has('ENOTFOUND', 'EAI_AGAIN', 'EDNS')) {
    message = "Couldn't find your mail server. Check your internet connection and the server name in Settings.";
  } else if (has('ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL')) {
    message = "Couldn't connect to your mail server. Check your internet connection, and the server and port in Settings.";
  } else if (has('ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT')) {
    message = 'Your mail server took too long to respond. Check your internet connection and try again.';
  } else if ([...codes].some((c) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c)) || /certificate/i.test(text)) {
    message = "Your mail server's security certificate couldn't be verified, so ClearMail didn't connect.";
  } else if (err?.tlsFailed || has('ETLS') || [...codes].some((c) => /^ERR_(SSL|TLS)_/.test(c)) || /STARTTLS|wrong version number|\b(ssl|tls)\b/i.test(text)) {
    message = "Couldn't set up a secure connection to your mail server. Check the server, port and security setting in Settings.";
  } else if (has('NoConnection', 'EConnectionClosed', 'ECONNRESET', 'EPIPE', 'ECONNECTION', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS')) {
    message = 'Lost the connection to your mail server. Check your internet connection and try again.';
  } else if (has('EENVELOPE')) {
    message = `${action}: your mail server didn't accept the address.${saidSuffix}`;
  } else if (said) {
    message = `${action}.${saidSuffix}`;
  } else {
    message = `${action}. Please try again.${text ? ` (${text.slice(0, 200)})` : ''}`;
  }
  return new Error(message, { cause: err });
}

function openImap(account) {
  const client = new ImapFlow({
    ...serverConfig(account, 'imap'),
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

function withInbox(account, fn) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
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
    replyTo: parsed ? firstAddress(parsed.replyTo?.value) : firstAddress(env.replyTo),
    subject: String(parsed?.subject ?? env.subject ?? ''),
    date: isoDate(parsed?.date, env.date, meta.internalDate),
    text: parsed ? parsed.text || '' : UNREADABLE,
    html: typeof parsed?.html === 'string' ? parsed.html : '',
    seen: meta.flags?.has('\\Seen') ?? false,
    references: [].concat(parsed?.references || []).filter((ref) => typeof ref === 'string' && ref.trim()),
    attachments,
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

async function fetchInbox(account, { limit = 60 } = {}) {
  const max = Math.min(Math.max(Math.floor(Number(limit)) || 60, 1), 500);
  try {
    const fp = accountKey(account);
    return await withInbox(account, async (client) => {
      const uidValidity = String(client.mailbox.uidValidity);
      uidValidityByAccount.set(fp, uidValidity);
      const total = client.mailbox.exists;
      if (!total) return [];
      const key = `${fp}-${uidValidity}`;
      const cached = inboxCache.key === key ? inboxCache.emails : new Map();

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
        if (hit) emails.set(meta.uid, { ...hit, seen: meta.flags?.has('\\Seen') ?? hit.seen });
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
      inboxCache = { key, emails: new Map(list.filter((e) => !unreadable.has(e.uid)).map((e) => [e.uid, e])) };
      return list.map((e) => ({ ...e })).sort((a, b) => new Date(a.date) - new Date(b.date));
    });
  } catch (err) {
    throw friendlyError(err, "Couldn't load your inbox");
  }
}

async function markSeen(account, uids) {
  const list = [...new Set([].concat(uids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return;
  try {
    const fp = accountKey(account);
    await withInbox(account, async (client) => {
      // UIDs only mean the same messages while UIDVALIDITY is unchanged.
      const known = uidValidityByAccount.get(fp);
      if (known && known !== String(client.mailbox.uidValidity)) {
        throw userError('Your inbox changed on the server. Refresh and try again.');
      }
      const ok = await client.messageFlagsAdd(list.join(','), ['\\Seen'], { uid: true });
      if (!ok) throw userError("Your mail server didn't let ClearMail mark the email as read.");
    });
  } catch (err) {
    throw friendlyError(err, "Couldn't mark the email as read");
  }
}

// SMTP servers that file submitted mail in Sent themselves, so a copy would be a duplicate.
const SELF_FILING_SMTP = /(?:^|\.)(?:gmail|googlemail|google|yahoo|fastmail|office365|outlook)\.com$/i;

// Files a copy of a sent reply in the Sent mailbox. A failure is only logged: the reply went out.
async function saveToSent(account, raw, messageId) {
  if (presetFor(account)?.savesSent) return true;
  if (SELF_FILING_SMTP.test(String(account.smtpHost || '').trim())) return true;
  try {
    return await withImap(account, async (client) => {
      const sent = (await client.list()).find((box) => box.specialUse === '\\Sent');
      if (!sent) return false;
      if (messageId) {
        // Some servers file SMTP mail in Sent on their own; don't add a second copy.
        const lock = await client.getMailboxLock(sent.path);
        try {
          const found = await client.search({ header: { 'message-id': messageId } }, { uid: true }).catch(() => []);
          if (found && found.length) return true;
        } finally {
          lock.release();
        }
      }
      await client.append(sent.path, raw, ['\\Seen']);
      return true;
    });
  } catch (err) {
    console.warn('Could not save the reply to Sent:', err.code || err.message);
    return false;
  }
}

async function sendReply(account, original, body) {
  // Reply-To wins over From, as in every mail client (contact forms, support desks, lists).
  const target = [original.replyTo, original.from].find((a) => a && EMAIL_RE.test(String(a.address || '')));
  if (!target) throw userError('This email has no address to reply to.');
  const subject = /^re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`;
  const parentId = typeof original.messageId === 'string' && original.messageId.trim() ? original.messageId.trim() : null;
  const refs = [...new Set([...[].concat(original.references || []), parentId].filter((r) => typeof r === 'string' && r.trim()))];

  let raw;
  let messageId;
  try {
    checkLogin(account);
    // The login name is also the From address; without one the reply would go out unsigned.
    if (!EMAIL_RE.test(String(account.user).trim())) {
      throw userError('To send replies, enter your full email address (like name@example.com) as the user name in Settings.');
    }
    // Build the message once, so the copy saved in Sent is exactly what was delivered.
    const message = new MailComposer({
      from: account.user,
      to: { name: target.name === target.address ? '' : target.name || '', address: target.address },
      subject,
      text: String(body ?? ''),
      inReplyTo: parentId || undefined,
      references: refs.length ? refs : undefined,
    }).compile();
    const envelope = message.getEnvelope();
    messageId = message.messageId();
    raw = await message.build();
    const transport = nodemailer.createTransport({
      ...serverConfig(account, 'smtp'),
      auth: { user: account.user, pass: account.pass },
      connectionTimeout: 30 * 1000,
      greetingTimeout: 30 * 1000,
      socketTimeout: 60 * 1000,
    });
    transport.on('error', (err) => console.warn('SMTP error:', err.code || err.message));
    try {
      await transport.sendMail({ envelope, raw });
    } finally {
      transport.close();
    }
  } catch (err) {
    throw friendlyError(err, "Couldn't send your reply");
  }
  // The reply has gone; filing the Sent copy can be slow, so it isn't waited for.
  // `filedInSent` resolves to whether a copy is in Sent (it never rejects).
  return { sent: true, filedInSent: saveToSent(account, raw, messageId) };
}

module.exports = { PROVIDERS, fetchInbox, markSeen, sendReply };
