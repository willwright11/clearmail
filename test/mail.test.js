// src/mail.js against tiny local IMAP and SMTP servers, with the real imapflow and nodemailer.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const imapflow = require('imapflow');
const nodemailer = require('nodemailer');

// The mock servers speak plain text, so let the clients skip TLS for them. The tests that
// check the TLS rules switch this off.
let allowPlain = true;
const RealImapFlow = imapflow.ImapFlow;
imapflow.ImapFlow = class extends RealImapFlow {
  constructor(options) {
    super(allowPlain ? { ...options, secure: false, doSTARTTLS: false } : options);
  }
};
const realCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = (options) => realCreateTransport(allowPlain ? { ...options, requireTLS: false, ignoreTLS: true } : options);

const mail = require('../src/mail');

// mail.js logs dropped connections and Sent-folder problems; keep the test output clean.
console.warn = () => {};

const CRLF = '\r\n';
const q = (s) => (s == null ? 'NIL' : `"${String(s).replace(/["\\]/g, '')}"`);

function addressList(value) {
  if (!value) return 'NIL';
  const m = /^(?:(.*?)\s*<)?([^<>@\s]+)@([^<>\s]+?)>?$/.exec(value);
  return `((${q(m[1] || null)} NIL ${q(m[2])} ${q(m[3])}))`;
}

function envelope(h) {
  const from = addressList(h.From);
  return `(${q(h.Date)} ${q(h.Subject)} ${from} ${from} ${h['Reply-To'] ? addressList(h['Reply-To']) : from} NIL NIL NIL NIL ${q(h['Message-ID'])})`;
}

function message({ uid, flags = [], headers, body, structure, parts }) {
  const header = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF;
  return {
    uid,
    flags,
    headers,
    header,
    source: header + body,
    structure: structure || `("text" "plain" ("charset" "utf-8") NIL NIL "7bit" ${body.length} ${body.split('\n').length})`,
    parts: parts || { 1: body },
  };
}

let nextUidValidity = 100;

// Starts a server on a free port. close() also drops any connection a client left open.
async function start(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

async function imapServer({ messages = [], password = 'secret', caps = 'IMAP4rev1 UIDPLUS SPECIAL-USE', onFetch, storeFails = false } = {}) {
  const state = { commands: [], fetches: [], stores: [], appended: [], open: 0, connections: 0, uidValidity: nextUidValidity++ };
  const server = net.createServer((socket) => {
    state.connections++;
    state.open++;
    socket.on('close', () => state.open--);
    socket.on('error', () => {});
    const send = (s) => !socket.destroyed && socket.write(s);
    send(`* OK mock IMAP ready${CRLF}`);
    let buf = Buffer.alloc(0);
    let need = 0;
    let text = '';
    let literals = [];
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (!socket.destroyed) {
        if (need) {
          if (buf.length < need) return;
          literals.push(buf.subarray(0, need));
          buf = buf.subarray(need);
          need = 0;
          continue;
        }
        const i = buf.indexOf(CRLF);
        if (i < 0) return;
        const line = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          text += line.slice(0, lit.index);
          need = Number(lit[1]);
          if (!lit[2]) send(`+ go ahead${CRLF}`);
          continue;
        }
        const cmd = text + line;
        const lits = literals;
        text = '';
        literals = [];
        handle(cmd, lits);
      }
    });

    function fetch(tag, uidMode, args) {
      const [set, ...rest] = args.split(' ');
      const items = rest.join(' ');
      state.fetches.push({ uidMode, set, items });
      const list = messages.map((msg, i) => ({ msg, seq: i + 1 }));
      const max = uidMode ? Math.max(...messages.map((m) => m.uid)) : messages.length;
      const ranges = set.split(',').map((part) => {
        const [a, b] = part.split(':');
        const lo = a === '*' ? max : Number(a);
        const hi = b === undefined ? lo : b === '*' ? max : Number(b);
        return [Math.min(lo, hi), Math.max(lo, hi)];
      });
      if (onFetch && onFetch({ items, socket, send }) === 'stop') return;
      for (const { msg, seq } of list) {
        const n = uidMode ? msg.uid : seq;
        if (!ranges.some(([lo, hi]) => n >= lo && n <= hi)) continue;
        const fields = [`UID ${msg.uid}`];
        if (/\bFLAGS\b/.test(items)) fields.push(`FLAGS (${msg.flags.join(' ')})`);
        if (/RFC822\.SIZE/.test(items)) fields.push(`RFC822.SIZE ${Buffer.byteLength(msg.source)}`);
        if (/INTERNALDATE/.test(items)) fields.push('INTERNALDATE "01-Oct-2026 09:00:00 +0000"');
        if (/ENVELOPE/.test(items)) fields.push(`ENVELOPE ${envelope(msg.headers)}`);
        if (/BODYSTRUCTURE/.test(items)) fields.push(`BODYSTRUCTURE ${msg.structure}`);
        for (const [, section, start, length] of items.matchAll(/BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/g)) {
          let data = section === '' ? msg.source : section === 'HEADER' ? msg.header : section === 'TEXT' ? msg.source.slice(msg.header.length) : msg.parts[section] || '';
          if (start !== undefined) data = data.slice(Number(start), Number(start) + Number(length));
          fields.push(`BODY[${section}]${start !== undefined ? `<${start}>` : ''} {${Buffer.byteLength(data)}}${CRLF}${data}`);
        }
        send(`* ${seq} FETCH (${fields.join(' ')})${CRLF}`);
      }
      send(`${tag} OK fetched${CRLF}`);
    }

    function handle(line, lits) {
      const m = /^(\S+) (UID )?(\S+) ?(.*)$/i.exec(line);
      if (!m) return;
      const [, tag, uidMode, name, args] = m;
      const command = name.toUpperCase();
      state.commands.push(`${uidMode ? 'UID ' : ''}${command} ${args}`);
      const ok = (msg = 'done') => send(`${tag} OK ${msg}${CRLF}`);
      switch (command) {
        case 'CAPABILITY':
          send(`* CAPABILITY ${caps}${CRLF}`);
          return ok();
        case 'LOGIN': {
          const tokens = [...args.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((t) => t[1] ?? t[2]);
          const pass = lits.length ? lits[lits.length - 1].toString() : tokens[1];
          return pass === password ? ok('logged in') : send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)${CRLF}`);
        }
        case 'SELECT':
        case 'EXAMINE': {
          const uidNext = Math.max(0, ...messages.map((x) => x.uid)) + 1;
          send(`* FLAGS (\\Seen \\Flagged)${CRLF}* OK [PERMANENTFLAGS (\\Seen \\Flagged \\*)] ok${CRLF}`);
          send(`* ${messages.length} EXISTS${CRLF}* OK [UIDVALIDITY ${state.uidValidity}] ok${CRLF}* OK [UIDNEXT ${uidNext}] ok${CRLF}`);
          return ok('[READ-WRITE] selected');
        }
        case 'FETCH':
          return fetch(tag, Boolean(uidMode), args);
        case 'STORE': {
          state.stores.push(args);
          if (storeFails) return send(`${tag} NO [CANNOT] not allowed${CRLF}`);
          const uids = args.split(' ')[0].split(',').map(Number);
          messages.forEach((msg, i) => {
            if (!uids.includes(msg.uid)) return;
            if (!msg.flags.includes('\\Seen')) msg.flags.push('\\Seen');
            send(`* ${i + 1} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(' ')}))${CRLF}`);
          });
          return ok();
        }
        case 'LIST':
        case 'LSUB':
          send(`* ${command} (\\HasNoChildren) "/" "INBOX"${CRLF}* ${command} (\\HasNoChildren \\Sent) "/" "Sent"${CRLF}`);
          return ok();
        case 'APPEND':
          state.appended.push({ args, content: lits[0] });
          return ok(`[APPENDUID ${state.uidValidity} 1] appended`);
        case 'LOGOUT':
          send(`* BYE bye${CRLF}`);
          ok();
          return socket.end();
        default:
          return ok();
      }
    }
  });
  return { state, ...(await start(server)) };
}

async function smtpServer({ starttls = false } = {}) {
  const state = { commands: [], data: [] };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let buf = '';
    let inData = false;
    let data = '';
    socket.write(`220 mock ESMTP${CRLF}`);
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf(CRLF)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            state.data.push(data);
            data = '';
            socket.write(`250 queued${CRLF}`);
          } else {
            data += (line.startsWith('..') ? line.slice(1) : line) + CRLF;
          }
          continue;
        }
        state.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write(`250-mock${CRLF}${starttls ? `250-STARTTLS${CRLF}` : ''}250 AUTH PLAIN LOGIN${CRLF}`);
        else if (verb === 'AUTH') socket.write(`235 ok${CRLF}`);
        else if (verb === 'DATA') {
          inData = true;
          socket.write(`354 go${CRLF}`);
        } else if (verb === 'QUIT') {
          socket.write(`221 bye${CRLF}`);
          socket.end();
        } else if (verb === 'STARTTLS') socket.write(`454 TLS not available${CRLF}`);
        else socket.write(`250 ok${CRLF}`);
      }
    });
  });
  return { state, ...(await start(server)) };
}

function account(imapPort, extra = {}) {
  return {
    provider: 'custom',
    user: 'me@example.com',
    pass: 'secret',
    imapHost: '127.0.0.1',
    imapPort,
    imapSecurity: 'starttls',
    smtpHost: '127.0.0.1',
    smtpPort: 1,
    smtpSecurity: 'starttls',
    ...extra,
  };
}

// The server notices a client's close slightly after the client does.
async function settled(state) {
  for (let i = 0; i < 50 && state.open > 0; i++) await new Promise((r) => setTimeout(r, 10));
  return state.open;
}

function sampleInbox() {
  const pdf = 'JVBERi0xLjQK'.repeat(40);
  const big = `${'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB\r\n'.repeat(20000)}`;
  const bigText1 = 'Please sign the attached contract by Friday.=0D=0ACaf=C3=A9 meeting at 10.\r\n';
  const bigText2 = 'P.S. Bring your ID.\r\n';
  const bigBody = [
    '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', bigText1,
    '--b1', 'Content-Type: application/pdf; name="Contract.pdf"', 'Content-Disposition: inline; filename="Contract.pdf"', 'Content-Transfer-Encoding: base64', '', big,
    '--b1', 'Content-Type: text/plain; charset=utf-8', '', bigText2,
    '--b1--', '',
  ].join(CRLF);
  return [
    message({
      uid: 11,
      flags: ['\\Seen'],
      headers: { From: 'Alice <alice@example.com>', Subject: 'Booking', Date: 'Thu, 01 Oct 2026 10:00:00 +0000', 'Message-ID': '<same@example.com>', 'Reply-To': 'Bookings <bookings@example.com>' },
      body: 'Can you confirm the booking?\r\n',
    }),
    message({
      uid: 12,
      headers: {
        From: 'Bob <bob@example.com>', Subject: 'Contract', Date: 'Fri, 02 Oct 2026 10:00:00 +0000', 'Message-ID': '<same@example.com>',
        'MIME-Version': '1.0', 'Content-Type': 'multipart/mixed; boundary="m1"',
      },
      // Apple Mail style: the PDF is marked inline but is a real attachment.
      body: ['--m1', 'Content-Type: text/plain', '', 'Please sign the attached contract.', '--m1',
        'Content-Type: application/pdf; name="Small.pdf"', 'Content-Disposition: inline; filename="Small.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '--m1--', ''].join(CRLF),
    }),
    message({
      uid: 14,
      headers: {
        From: 'Big Sender <big@example.com>', Subject: 'Big one', Date: 'Wed, 30 Sep 2026 10:00:00 +0000', 'Message-ID': '<big@example.com>',
        'MIME-Version': '1.0', 'Content-Type': 'multipart/mixed; boundary="b1"',
      },
      body: bigBody,
      structure: `(("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" ${bigText1.length} 2 NIL NIL NIL NIL)` +
        `("application" "pdf" ("name" "Contract.pdf") NIL NIL "base64" ${big.length} NIL ("inline" ("filename" "Contract.pdf")) NIL NIL)` +
        `("text" "plain" ("charset" "utf-8") NIL NIL "7bit" ${bigText2.length} 1 NIL NIL NIL NIL) "mixed" ("boundary" "b1") NIL NIL NIL)`,
      parts: { 1: bigText1, 3: bigText2 },
    }),
  ];
}

test('fetchInbox parses mail, downloads only text of big messages, and closes the connection', { timeout: 15000 }, async () => {
  const imap = await imapServer({ messages: sampleInbox() });
  try {
    const emails = await mail.fetchInbox(account(imap.port));
    assert.deepStrictEqual(emails.map((e) => e.uid), [14, 11, 12], 'sorted oldest first');
    const [big, booking, contract] = emails;

    assert.notStrictEqual(booking.id, contract.id, 'duplicate Message-IDs still get unique ids');
    assert.strictEqual(booking.messageId, '<same@example.com>');
    assert.deepStrictEqual(booking.replyTo, { name: 'Bookings', address: 'bookings@example.com' });
    assert.strictEqual(contract.replyTo, null);
    assert.strictEqual(booking.seen, true);
    assert.strictEqual(contract.seen, false);
    assert.match(booking.text, /confirm the booking/);
    assert.deepStrictEqual(contract.attachments.map((a) => a.filename), ['Small.pdf']);

    assert.match(big.text, /Please sign the attached contract by Friday/);
    assert.match(big.text, /Café meeting at 10/);
    assert.match(big.text, /Bring your ID/);
    assert.strictEqual(big.from.address, 'big@example.com');
    assert.deepStrictEqual(big.attachments.map((a) => a.filename), ['Contract.pdf']);
    assert.ok(big.attachments[0].size > 1000000);
    const bigFetches = imap.state.fetches.filter((f) => f.uidMode && f.set.split(',').includes('14'));
    assert.ok(bigFetches.every((f) => !/BODY\.PEEK\[\]|BODY\.PEEK\[2\]/.test(f.items)), 'never downloads the big attachment');

    assert.strictEqual(await settled(imap.state), 0, 'no connection left open');
    assert.ok(imap.state.commands.some((c) => c.startsWith('LOGOUT')));

    // A refresh only asks for the metadata again.
    imap.state.fetches.length = 0;
    const again = await mail.fetchInbox(account(imap.port));
    assert.deepStrictEqual(again.map((e) => e.id), emails.map((e) => e.id), 'ids are stable');
    assert.strictEqual(imap.state.fetches.length, 1, 'cached messages are not downloaded again');
    assert.doesNotMatch(imap.state.fetches[0].items, /BODY/);
  } finally {
    await imap.close();
  }
});

test('a huge single-part email is capped and says so instead of silently losing the end', { timeout: 15000 }, async () => {
  const html = `<p>Urgent: the site is closed on Monday.</p>${'<p>filler text</p>'.repeat(200000)}`;
  const imap = await imapServer({
    messages: [message({
      uid: 5,
      headers: { From: 'Site <site@example.com>', Subject: 'Notice', Date: 'Thu, 01 Oct 2026 10:00:00 +0000', 'Message-ID': '<n@example.com>', 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
      structure: `("text" "html" ("charset" "utf-8") NIL NIL "7bit" ${html.length} 1)`,
    })],
  });
  try {
    const [email] = await mail.fetchInbox(account(imap.port));
    assert.match(email.html, /^<p>Urgent: the site is closed on Monday\.<\/p>/);
    assert.match(email.html, /only downloaded the start of it/);
    assert.ok(email.html.length < html.length);
    assert.strictEqual(email.subject, 'Notice');
    assert.ok(imap.state.fetches.some((f) => /BODY\.PEEK\[TEXT\]<0\.\d+>/.test(f.items)));
  } finally {
    await imap.close();
  }
});

test('an unsolicited flag update during the fetch does not break the load', { timeout: 10000 }, async () => {
  const imap = await imapServer({
    messages: sampleInbox().slice(0, 2),
    onFetch: ({ items, send }) => {
      if (/BODY\.PEEK\[\]/.test(items)) send(`* 1 FETCH (FLAGS (\\Seen \\Flagged))${CRLF}`);
    },
  });
  try {
    const emails = await mail.fetchInbox(account(imap.port));
    assert.strictEqual(emails.length, 2);
  } finally {
    await imap.close();
  }
});

test('a rejected login gives a clear message and does not leak the connection', { timeout: 10000 }, async () => {
  const imap = await imapServer();
  try {
    await assert.rejects(mail.fetchInbox(account(imap.port, { pass: 'wrong' })), (err) => {
      assert.match(err.message, /rejected the login/);
      assert.match(err.message, /Invalid credentials/);
      assert.ok(err.cause, 'original error kept as cause');
      return true;
    });
    assert.strictEqual(await settled(imap.state), 0, 'socket closed after the failed login');
  } finally {
    await imap.close();
  }
});

test('a connection reset mid-fetch rejects cleanly instead of crashing', { timeout: 10000 }, async () => {
  const imap = await imapServer({
    messages: sampleInbox(),
    onFetch: ({ items, socket }) => {
      if (/BODY\.PEEK\[\]/.test(items)) {
        socket.resetAndDestroy();
        return 'stop';
      }
    },
  });
  try {
    await assert.rejects(mail.fetchInbox(account(imap.port)), /connection to your mail server/);
    // Give a stray 'error' event a chance to surface as an uncaught exception.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    await imap.close();
  }
});

test('markSeen uses one connection and one STORE for all ids, and rejects when the server refuses', { timeout: 10000 }, async () => {
  const imap = await imapServer({ messages: sampleInbox().slice(0, 2) });
  try {
    await mail.fetchInbox(account(imap.port));
    imap.state.connections = 0;
    await mail.markSeen(account(imap.port), [12, 11, 12]);
    assert.strictEqual(imap.state.connections, 1);
    assert.deepStrictEqual(imap.state.stores, ['12,11 +FLAGS (\\Seen)']);
    assert.strictEqual(await settled(imap.state), 0);

    // UIDs from before a UIDVALIDITY change would point at other messages.
    imap.state.uidValidity += 1;
    await assert.rejects(mail.markSeen(account(imap.port), [12]), /changed on the server/);
    assert.strictEqual(imap.state.stores.length, 1);
  } finally {
    await imap.close();
  }

  const refusing = await imapServer({ messages: sampleInbox().slice(0, 2), storeFails: true });
  try {
    await mail.fetchInbox(account(refusing.port));
    await assert.rejects(mail.markSeen(account(refusing.port), [12]), /mark the email as read/);
  } finally {
    await refusing.close();
  }
});

test('IMAP STARTTLS is required: no password is sent to a server without it', { timeout: 10000 }, async () => {
  allowPlain = false;
  const imap = await imapServer({ messages: sampleInbox() });
  try {
    await assert.rejects(mail.fetchInbox(account(imap.port)), /secure connection/);
    assert.ok(!imap.state.commands.some((c) => c.startsWith('LOGIN')), 'LOGIN never sent in plain text');
  } finally {
    allowPlain = true;
    await imap.close();
  }
});

test('SMTP STARTTLS is required: no password is sent to a server without it', { timeout: 10000 }, async () => {
  allowPlain = false;
  const smtp = await smtpServer();
  try {
    const original = { from: { name: 'Alice', address: 'alice@example.com' }, replyTo: null, subject: 'Hi', messageId: '<a@example.com>', references: [] };
    await assert.rejects(mail.sendReply(account(1, { smtpPort: smtp.port }), original, 'Thanks'), /secure connection/);
    assert.ok(!smtp.state.commands.some((c) => /^AUTH/i.test(c)), 'AUTH never sent in plain text');
  } finally {
    allowPlain = true;
    await smtp.close();
  }
});

test('sendReply answers the Reply-To address, threads the reply and files it in Sent', { timeout: 10000 }, async () => {
  const imap = await imapServer();
  const smtp = await smtpServer();
  try {
    const original = {
      from: { name: 'Website', address: 'website@example.com' },
      replyTo: { name: 'Customer', address: 'customer@example.com' },
      subject: 'Contact form',
      messageId: '<form-1@example.com>',
      references: ['<older@example.com>'],
    };
    const result = await mail.sendReply(account(imap.port, { smtpPort: smtp.port }), original, 'Happy to help.');
    assert.strictEqual(result.sent, true);
    assert.strictEqual(await result.filedInSent, true);
    assert.ok(smtp.state.commands.some((c) => /^RCPT TO:<customer@example.com>/i.test(c)));
    const sent = smtp.state.data[0];
    assert.match(sent, /^In-Reply-To: <form-1@example.com>/m);
    assert.match(sent, /^References: <older@example.com> <form-1@example.com>/m);
    assert.match(sent, /^Subject: Re: Contact form/m);
    assert.match(sent, /^Message-ID: <.+>/m);
    assert.match(sent, /^Date: /m);
    assert.strictEqual(imap.state.appended.length, 1);
    assert.match(imap.state.appended[0].args, /"?Sent"? \(\\Seen\)/);
    assert.strictEqual(imap.state.appended[0].content.toString().trimEnd(), sent.trimEnd(), 'Sent copy matches what was delivered');
    assert.strictEqual(await settled(imap.state), 0);
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test('sendReply refuses an email with no reply address', async () => {
  await assert.rejects(
    mail.sendReply(account(1), { from: { name: 'Unknown', address: '' }, replyTo: null, subject: 'x' }, 'hi'),
    /no address to reply to/,
  );
});

test('providers: Outlook is gone and STARTTLS presets require TLS', () => {
  assert.deepStrictEqual(Object.keys(mail.PROVIDERS).sort(), ['gmail', 'icloud', 'yahoo']);
  for (const p of Object.values(mail.PROVIDERS)) {
    if (!p.smtp.secure) assert.strictEqual(p.smtp.requireTLS, true);
    assert.strictEqual(p.imap.secure, true);
  }
});

test('an email whose HTML mailparser cannot convert is still read, not replaced by a placeholder', { timeout: 15000 }, async () => {
  // Deeply nested quotes make html-to-text (inside mailparser) give up.
  const nested = '<blockquote>x<br>'.repeat(4000);
  const imap = await imapServer({
    messages: [
      message({
        uid: 1,
        headers: { From: 'Eve <eve@example.com>', Subject: 'Nested', Date: 'Thu, 01 Oct 2026 10:00:00 +0000', 'Message-ID': '<n@example.com>', 'Content-Type': 'text/html; charset=utf-8' },
        body: `<p>Pay the &pound;500 deposit by Friday.</p>${nested}`,
      }),
    ],
  });
  try {
    const [email] = await mail.fetchInbox(account(imap.port));
    assert.match(email.text, /Pay the £500 deposit by Friday\./);
    assert.ok(email.html.includes('deposit'));
  } finally {
    await imap.close();
  }
});

test('sendReply refuses to send without an email address to send from', async () => {
  const original = { from: { name: 'Bob', address: 'bob@example.com' }, replyTo: null, subject: 'x', messageId: null };
  await assert.rejects(mail.sendReply(account(1, { user: 'jsmith' }), original, 'hi'), /full email address/);
});
