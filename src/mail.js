// IMAP (read) + SMTP (reply). Works with any provider that supports app passwords.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const PROVIDERS = {
  gmail: { label: 'Gmail', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  icloud: { label: 'iCloud', imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  yahoo: { label: 'Yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
  outlook: { label: 'Outlook / Office 365', imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
};

function serverConfig(account, kind) {
  const preset = PROVIDERS[account.provider];
  if (preset) return preset[kind];
  return {
    host: account[`${kind}Host`],
    port: Number(account[`${kind}Port`]) || (kind === 'imap' ? 993 : 465),
    secure: account[`${kind}Secure`] !== false,
  };
}

async function fetchInbox(account, { limit = 60 } = {}) {
  const client = new ImapFlow({
    ...serverConfig(account, 'imap'),
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
  await client.connect();
  const emails = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const total = client.mailbox.exists;
    if (total > 0) {
      const from = Math.max(1, total - limit + 1);
      for await (const msg of client.fetch(`${from}:*`, { uid: true, flags: true, source: true })) {
        const parsed = await simpleParser(msg.source);
        const sender = parsed.from?.value?.[0] || {};
        emails.push({
          id: parsed.messageId || `uid-${msg.uid}`,
          uid: msg.uid,
          from: { name: sender.name || sender.address || 'Unknown', address: (sender.address || '').toLowerCase() },
          subject: parsed.subject || '',
          date: (parsed.date || new Date()).toISOString(),
          text: parsed.text || '',
          html: typeof parsed.html === 'string' ? parsed.html : '',
          seen: msg.flags?.has('\\Seen') ?? false,
          references: parsed.references || [],
          attachments: (parsed.attachments || [])
            .filter((a) => a.contentDisposition !== 'inline')
            .map((a) => ({ filename: a.filename || 'attachment', size: a.size })),
        });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return emails.sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function markSeen(account, uid) {
  const client = new ImapFlow({ ...serverConfig(account, 'imap'), auth: { user: account.user, pass: account.pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function sendReply(account, original, body) {
  const transport = nodemailer.createTransport({
    ...serverConfig(account, 'smtp'),
    auth: { user: account.user, pass: account.pass },
  });
  const subject = /^re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`;
  const refs = [...(Array.isArray(original.references) ? original.references : [original.references].filter(Boolean)), original.id]
    .filter((r) => r && !String(r).startsWith('uid-'));
  await transport.sendMail({
    from: account.user,
    to: original.from.address,
    subject,
    text: body,
    inReplyTo: original.id && !original.id.startsWith('uid-') ? original.id : undefined,
    references: refs.length ? refs : undefined,
  });
}

module.exports = { PROVIDERS, fetchInbox, markSeen, sendReply };
