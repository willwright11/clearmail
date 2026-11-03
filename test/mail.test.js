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

// Every command any mock IMAP server in this file received, to check at the end that
// ClearMail never changed a mailbox.
const allCommands = [];

// "Name <a@b>, c@d" as an IMAP envelope address list.
function addressList(value) {
  if (!value) return 'NIL';
  const one = (part) => {
    const m = /^(?:(.*?)\s*<)?([^<>@\s]+)@([^<>\s]+?)>?$/.exec(part.trim());
    return `(${q(m[1] || null)} NIL ${q(m[2])} ${q(m[3])})`;
  };
  return `(${value.split(/,\s*/).map(one).join('')})`;
}

function envelope(h) {
  const from = addressList(h.From);
  const replyTo = h['Reply-To'] ? addressList(h['Reply-To']) : from;
  return `(${q(h.Date)} ${q(h.Subject)} ${from} ${from} ${replyTo} ${addressList(h.To)} ${addressList(h.Cc)} ${addressList(h.Bcc)} ${q(h['In-Reply-To'])} ${q(h['Message-ID'])})`;
}

function message({ uid, flags = [], headers, body, structure, parts, internalDate }) {
  const header = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF;
  return {
    uid,
    flags,
    internalDate,
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

// A tiny IMAP server with an INBOX and (unless sentFolder is false) a Sent folder marked
// \Sent. EXAMINE answers read-only, as real servers do (no permanent flags). Nothing that
// changes a mailbox is carried out: STORE, COPY, MOVE and EXPUNGE are refused and recorded.
async function imapServer({
  messages = [], sent = [], sentFolder = true, password = 'secret', caps = 'IMAP4rev1 UIDPLUS SPECIAL-USE', onFetch, sentHasCopy = false, uidNext: sendUidNext = true,
} = {}) {
  const state = {
    commands: [], fetches: [], stores: [], appended: [], opened: [], open: 0, connections: 0,
    boxes: { INBOX: { messages, uidValidity: nextUidValidity++ }, Sent: { messages: sent, uidValidity: nextUidValidity++ } },
  };
  // Kept for the tests written before there was a Sent folder.
  Object.defineProperty(state, 'uidValidity', { get: () => state.boxes.INBOX.uidValidity, set: (v) => { state.boxes.INBOX.uidValidity = v; } });
  const server = net.createServer((socket) => {
    state.connections++;
    state.open++;
    let selected = null;
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
      state.fetches.push({ uidMode, set, items, box: selected });
      const list = state.boxes[selected].messages.map((msg, i) => ({ msg, seq: i + 1 }));
      const max = uidMode ? Math.max(...list.map(({ msg }) => msg.uid)) : list.length;
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
        if (/INTERNALDATE/.test(items)) fields.push(`INTERNALDATE "${msg.internalDate || '01-Oct-2026 09:00:00 +0000'}"`);
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
      allCommands.push(`${uidMode ? 'UID ' : ''}${command} ${args}`);
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
          const boxName = args.replace(/"/g, '').split(' ')[0];
          state.opened.push(`${command} ${boxName}`);
          const box = state.boxes[boxName];
          if (!box || (boxName === 'Sent' && !sentFolder)) return send(`${tag} NO [NONEXISTENT] no such mailbox${CRLF}`);
          selected = boxName;
          const uidNext = Math.max(0, ...box.messages.map((x) => x.uid)) + 1;
          const readOnly = command === 'EXAMINE';
          send(`* FLAGS (\\Seen \\Flagged)${CRLF}* OK [PERMANENTFLAGS (${readOnly ? '' : '\\Seen \\Flagged \\*'})] ok${CRLF}`);
          send(`* ${box.messages.length} EXISTS${CRLF}* OK [UIDVALIDITY ${box.uidValidity}] ok${CRLF}${sendUidNext ? `* OK [UIDNEXT ${uidNext}] ok${CRLF}` : ''}`);
          return ok(readOnly ? '[READ-ONLY] examined' : '[READ-WRITE] selected');
        }
        case 'FETCH':
          return fetch(tag, Boolean(uidMode), args);
        case 'SEARCH':
          send(`* SEARCH${sentHasCopy ? ' 1' : ''}${CRLF}`);
          return ok();
        case 'STORE':
        case 'COPY':
        case 'MOVE':
        case 'EXPUNGE':
          state.stores.push(`${command} ${args}`);
          return send(`${tag} NO [CANNOT] the mock refuses to change a mailbox${CRLF}`);
        case 'LIST':
        case 'LSUB':
          // `LIST "" ""` asks for the hierarchy delimiter, as real servers answer it.
          if (args.trim() === '"" ""') {
            send(`* ${command} (\\Noselect) "/" ""${CRLF}`);
            return ok();
          }
          send(`* ${command} (\\HasNoChildren) "/" "INBOX"${CRLF}`);
          if (sentFolder) send(`* ${command} (\\HasNoChildren \\Sent) "/" "Sent"${CRLF}`);
          return ok();
        case 'APPEND':
          state.appended.push({ args, box: args.replace(/"/g, '').split(' ')[0], content: lits[0] });
          return ok(`[APPENDUID ${state.boxes.Sent.uidValidity} 1] appended`);
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
      flags: ['\\Seen', '\\Flagged'],
      headers: {
        From: 'Alice <alice@example.com>', To: 'Me <Me@Example.com>, Tom <tom@example.com>, me@example.com', Cc: 'Ann <ann@example.com>',
        Subject: 'Booking', Date: 'Thu, 01 Oct 2026 10:00:00 +0000', 'Message-ID': '<same@example.com>', 'Reply-To': 'Bookings <bookings@example.com>',
        'In-Reply-To': '<prev@example.com>', 'X-Priority': '1 (Highest)',
      },
      body: 'Can you confirm the booking?\r\n',
      internalDate: '01-Oct-2026 10:00:07 +0000',
    }),
    message({
      uid: 12,
      headers: {
        From: 'Bob <bob@example.com>', To: 'me@example.com', Subject: 'Contract', Date: 'Fri, 02 Oct 2026 10:00:00 +0000', 'Message-ID': '<same@example.com>',
        'List-Unsubscribe': '<https://bob.example/unsub?u=1>,\r\n <mailto:unsub@bob.example>', 'List-Id': 'Bob News <news.bob.example>',
        Precedence: 'Bulk', 'Auto-Submitted': 'Auto-Generated',
        'MIME-Version': '1.0', 'Content-Type': 'multipart/mixed; boundary="m1"',
      },
      // Apple Mail style: the PDF is marked inline but is a real attachment.
      body: ['--m1', 'Content-Type: text/plain', '', 'Please sign the attached contract.', '--m1',
        'Content-Type: application/pdf; name="Small.pdf"', 'Content-Disposition: inline; filename="Small.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '--m1--', ''].join(CRLF),
    }),
    message({
      uid: 14,
      flags: ['\\Flagged'],
      internalDate: '30-Sep-2026 10:05:00 +0000',
      headers: {
        From: 'Big Sender <big@example.com>', To: 'Me <me@example.com>', Cc: 'Boss <Boss@Example.com>, Ann <ann@example.com>',
        Subject: 'Big one', Date: 'Wed, 30 Sep 2026 10:00:00 +0000', 'Message-ID': '<big@example.com>',
        'List-Unsubscribe': '<mailto:leave@big.example>', Importance: 'low',
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

const RAW_EMAIL_KEYS = [
  'attachments', 'cc', 'conversationId', 'date', 'flagged', 'focused', 'from', 'headers', 'html', 'id', 'importance', 'inReplyTo',
  'messageId', 'receivedAt', 'references', 'replyTo', 'seen', 'subject', 'text', 'to', 'uid', 'webLink',
];
const NO_HEADERS = { listUnsubscribe: null, listId: null, precedence: null, autoSubmitted: null };

// Every body ClearMail downloads is a PEEK, so the server never marks it as read.
function onlyPeeks(fetches) {
  for (const { items } of fetches) {
    const rest = items.replace(/\b(?:BODY|BINARY)\.PEEK\[[^\]]*\](?:<\d+\.\d+>)?/g, '').replace(/RFC822\.SIZE/g, '');
    assert.doesNotMatch(rest, /\bBODY\[|\bBINARY\[|\bRFC822\b/, `a fetch that would mark as read: ${items}`);
  }
}

test('fetchInbox parses mail, downloads only text of big messages, and closes the connection', { timeout: 15000 }, async () => {
  const imap = await imapServer({ messages: sampleInbox() });
  try {
    const emails = await mail.fetchInbox(account(imap.port));
    assert.deepStrictEqual(emails.map((e) => e.uid), [14, 11, 12], 'sorted oldest first');
    for (const e of emails) assert.deepStrictEqual(Object.keys(e).sort(), RAW_EMAIL_KEYS);
    const [big, booking, contract] = emails;

    // RawEmail v3: recipients, flags, list headers, importance, threading.
    assert.deepStrictEqual(booking.to, [{ name: 'Me', address: 'me@example.com' }, { name: 'Tom', address: 'tom@example.com' }]);
    assert.deepStrictEqual(booking.cc, [{ name: 'Ann', address: 'ann@example.com' }]);
    assert.deepStrictEqual([booking.flagged, booking.importance, booking.inReplyTo], [true, 'high', '<prev@example.com>']);
    assert.deepStrictEqual(booking.headers, NO_HEADERS);
    assert.strictEqual(booking.date, '2026-10-01T10:00:00.000Z');
    assert.strictEqual(booking.receivedAt, '2026-10-01T10:00:07.000Z');
    assert.deepStrictEqual(contract.headers, {
      listUnsubscribe: '<https://bob.example/unsub?u=1>, <mailto:unsub@bob.example>',
      listId: 'Bob News <news.bob.example>',
      precedence: 'bulk',
      autoSubmitted: 'auto-generated',
    });
    assert.deepStrictEqual([contract.flagged, contract.importance, contract.inReplyTo], [false, 'normal', null]);
    assert.deepStrictEqual(contract.to, [{ name: 'me@example.com', address: 'me@example.com' }]);
    assert.deepStrictEqual(contract.cc, []);
    // The big message's fields come from its downloaded headers alone.
    assert.deepStrictEqual(big.to, [{ name: 'Me', address: 'me@example.com' }]);
    assert.deepStrictEqual(big.cc, [{ name: 'Boss', address: 'boss@example.com' }, { name: 'Ann', address: 'ann@example.com' }]);
    assert.deepStrictEqual(big.headers, { ...NO_HEADERS, listUnsubscribe: '<mailto:leave@big.example>' });
    assert.deepStrictEqual([big.flagged, big.importance, big.receivedAt], [true, 'low', '2026-09-30T10:05:00.000Z']);
    for (const e of emails) assert.deepStrictEqual([e.focused, e.conversationId, e.webLink], [null, null, null], 'Outlook only');

    // Read-only: the inbox was EXAMINEd, every body was a PEEK, nothing was changed or added.
    assert.deepStrictEqual(imap.state.opened, ['EXAMINE INBOX']);
    onlyPeeks(imap.state.fetches);
    assert.deepStrictEqual([imap.state.stores, imap.state.appended], [[], []]);

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

    // A refresh only asks for the metadata again, and picks up what changed in the user's mail app.
    imap.state.fetches.length = 0;
    const [m11, m12] = imap.state.boxes.INBOX.messages;
    m11.flags = ['\\Flagged'];
    m12.flags = ['\\Seen', '\\Flagged'];
    const again = await mail.fetchInbox(account(imap.port));
    assert.deepStrictEqual(again.map((e) => e.id), emails.map((e) => e.id), 'ids are stable');
    assert.strictEqual(imap.state.fetches.length, 1, 'cached messages are not downloaded again');
    assert.doesNotMatch(imap.state.fetches[0].items, /BODY/);
    assert.deepStrictEqual(again.map((e) => [e.uid, e.seen, e.flagged]), [[14, false, true], [11, false, true], [12, true, true]]);
    assert.deepStrictEqual(again[2].headers, contract.headers, 'the rest comes from the cache');
  } finally {
    await imap.close();
  }
});

test('each account keeps its own cache: loading one account does not make the other download everything again', { timeout: 15000 }, async () => {
  const first = await imapServer({ messages: sampleInbox().slice(0, 2) });
  const second = await imapServer({ messages: sampleInbox().slice(0, 2) });
  try {
    const a = account(first.port, { user: 'a@example.com' });
    const b = account(second.port, { user: 'b@example.com' });
    await Promise.all([mail.fetchInbox(a), mail.fetchInbox(b)]);
    first.state.fetches.length = 0;
    second.state.fetches.length = 0;
    await mail.fetchInbox(a);
    await mail.fetchInbox(b);
    for (const { state } of [first, second]) {
      assert.strictEqual(state.fetches.length, 1, 'only the metadata is fetched again');
      assert.doesNotMatch(state.fetches[0].items, /BODY/);
    }
  } finally {
    await Promise.all([first.close(), second.close()]);
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
    assert.strictEqual(imap.state.appended[0].box, 'Sent');
    assert.match(imap.state.appended[0].args, /"?Sent"? \(\\Seen\)/);
    assert.strictEqual(imap.state.appended[0].content.toString().trimEnd(), sent.trimEnd(), 'Sent copy matches what was delivered');
    // Sent was only looked at read-only, to check the server hadn't filed a copy itself.
    assert.deepStrictEqual(imap.state.opened, ['EXAMINE Sent']);
    assert.ok(imap.state.commands.some((c) => /^UID SEARCH HEADER Message-ID/i.test(c)));
    assert.deepStrictEqual(imap.state.stores, []);
    assert.strictEqual(await settled(imap.state), 0);
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test('sendReply adds no second copy when the server filed one, and none when there is no Sent folder', { timeout: 10000 }, async () => {
  const original = { from: { name: 'Alice', address: 'alice@example.com' }, replyTo: null, subject: 'Hi', messageId: '<a@example.com>', references: [] };
  for (const [options, filed] of [[{ sentHasCopy: true }, true], [{ sentFolder: false }, false]]) {
    const imap = await imapServer(options);
    const smtp = await smtpServer();
    try {
      const result = await mail.sendReply(account(imap.port, { smtpPort: smtp.port }), original, 'Thanks');
      assert.strictEqual(result.sent, true);
      assert.strictEqual(await result.filedInSent, filed);
      assert.deepStrictEqual(imap.state.appended, []);
      assert.ok(!imap.state.opened.some((c) => c.startsWith('SELECT')));
      assert.strictEqual(await settled(imap.state), 0);
    } finally {
      await imap.close();
      await smtp.close();
    }
  }
});

// ---------- sent history ----------

function sentMail(uid, { to = 'Sarah <Sarah@Example.com>', cc, bcc, inReplyTo, date } = {}) {
  return message({
    uid,
    flags: ['\\Seen'],
    headers: {
      From: 'Me <Me@example.com>', To: to, ...(cc ? { Cc: cc } : {}), ...(bcc ? { Bcc: bcc } : {}),
      Subject: `Sent ${uid}`, Date: date || new Date(Date.UTC(2026, 8, 1) + uid * 3600_000).toUTCString(), 'Message-ID': `<sent-${uid}@example.com>`,
      ...(inReplyTo ? { 'In-Reply-To': inReplyTo } : {}),
    },
    body: `Private reply ${uid}\r\n`,
  });
}

const sentFetches = (state) => state.fetches.filter((f) => f.box === 'Sent');

test('fetchSentHistory reads Sent read-only by envelope, then only what is new', { timeout: 15000 }, async () => {
  const imap = await imapServer({
    messages: sampleInbox().slice(0, 1),
    sent: [
      sentMail(5, { cc: 'Tom <tom@example.com>, sarah@example.com', bcc: 'Dad <dad@example.com>', inReplyTo: '<same@example.com>' }),
      sentMail(6, { date: 'not a date' }),
      sentMail(9, { to: 'Priya <priya@example.com>' }),
    ],
  });
  try {
    const acct = account(imap.port);
    const before = Date.now();
    const first = await mail.fetchSentHistory(acct, null);
    assert.strictEqual(first.full, true);
    assert.deepStrictEqual(first.entries, [
      { from: 'me@example.com', to: ['sarah@example.com', 'tom@example.com', 'dad@example.com'], date: '2026-09-01T05:00:00.000Z', conversationId: null, inReplyTo: '<same@example.com>' },
      { from: 'me@example.com', to: ['priya@example.com'], date: '2026-09-01T09:00:00.000Z', conversationId: null, inReplyTo: null },
    ], 'oldest first; one with no date is left out');
    const box = imap.state.boxes.Sent;
    assert.deepStrictEqual({ ...first.cursor, fullAt: 0 }, { kind: 'imap', path: 'Sent', uidValidity: String(box.uidValidity), lastUid: 9, fullAt: 0 });
    assert.ok(first.cursor.fullAt >= before && first.cursor.fullAt <= Date.now());
    // Envelopes only, from a folder opened read-only: no email content is downloaded.
    assert.deepStrictEqual(imap.state.opened, ['EXAMINE Sent']);
    assert.deepStrictEqual(sentFetches(imap.state).map((f) => [f.uidMode, f.set]), [[false, '1:*']]);
    for (const f of sentFetches(imap.state)) {
      assert.match(f.items, /ENVELOPE/);
      assert.doesNotMatch(f.items, /BODY|RFC822|BINARY/);
    }

    // A new sent email: only it is fetched, by UID.
    box.messages.push(sentMail(12, { to: 'Jo <jo@example.com>' }));
    imap.state.fetches.length = 0;
    const second = await mail.fetchSentHistory(acct, first.cursor);
    assert.strictEqual(second.full, false);
    assert.deepStrictEqual(second.entries.map((e) => e.to), [['jo@example.com']]);
    assert.deepStrictEqual(sentFetches(imap.state).map((f) => [f.uidMode, f.set]), [[true, '10:*']]);
    assert.deepStrictEqual(second.cursor, { ...first.cursor, lastUid: 12 });

    // Nothing new (UIDNEXT says so): nothing is fetched at all.
    imap.state.fetches.length = 0;
    const third = await mail.fetchSentHistory(acct, second.cursor);
    assert.deepStrictEqual([third.full, third.entries, third.cursor], [false, [], second.cursor]);
    assert.deepStrictEqual(sentFetches(imap.state), []);

    // The folder's UIDVALIDITY changed (rebuilt on the server): UIDs mean nothing now, start again.
    box.uidValidity += 1000;
    const reset = await mail.fetchSentHistory(acct, third.cursor);
    assert.deepStrictEqual([reset.full, reset.entries.length, reset.cursor.uidValidity], [true, 3, String(box.uidValidity)]);

    // And every 30 days, or with a cursor that doesn't fit this folder.
    for (const cursor of [
      { ...reset.cursor, fullAt: Date.now() - 31 * 24 * 3600_000 },
      { ...reset.cursor, path: 'Old Sent' },
      { ...reset.cursor, lastUid: -1 },
      { kind: 'graph', since: '2026-10-01T00:00:00Z', fullAt: Date.now() },
      'junk',
    ]) {
      const again = await mail.fetchSentHistory(acct, cursor);
      assert.deepStrictEqual([again.full, again.entries.length], [true, 3], JSON.stringify(cursor));
    }
    assert.deepStrictEqual([imap.state.appended, imap.state.stores], [[], []]);
    assert.ok(imap.state.opened.every((c) => c === 'EXAMINE Sent'));
    assert.strictEqual(await settled(imap.state), 0);
  } finally {
    await imap.close();
  }
});

test('fetchSentHistory: at most the newest 500, and a server that hides UIDNEXT still gets only new ones', { timeout: 20000 }, async () => {
  const imap = await imapServer({ sent: Array.from({ length: 520 }, (_, i) => sentMail(i + 1, { to: `p${i}@example.com` })), uidNext: false });
  try {
    const acct = account(imap.port);
    const first = await mail.fetchSentHistory(acct, null);
    assert.strictEqual(first.entries.length, 500);
    assert.deepStrictEqual([first.entries[0].to, first.entries.at(-1).to], [['p20@example.com'], ['p519@example.com']]);
    assert.deepStrictEqual(sentFetches(imap.state).map((f) => f.set), ['21:*']);
    assert.strictEqual(first.cursor.lastUid, 520);

    // Without UIDNEXT it has to ask; "UID FETCH 521:*" then returns the newest message (520)
    // anyway, which isn't new.
    imap.state.fetches.length = 0;
    const again = await mail.fetchSentHistory(acct, first.cursor);
    assert.deepStrictEqual(sentFetches(imap.state).map((f) => [f.uidMode, f.set]), [[true, '521:*']]);
    assert.deepStrictEqual([again.full, again.entries, again.cursor.lastUid], [false, [], 520]);

    // More than 500 new since the last sync: the newest 500 of them.
    imap.state.boxes.Sent.messages.push(...Array.from({ length: 503 }, (_, i) => sentMail(521 + i, { to: `n${i}@example.com` })));
    const more = await mail.fetchSentHistory(acct, again.cursor);
    assert.deepStrictEqual([more.full, more.entries.length, more.entries[0].to, more.cursor.lastUid], [false, 500, ['n3@example.com'], 1023]);
  } finally {
    await imap.close();
  }
});

test('fetchSentHistory: no Sent folder is an empty history, not an error', { timeout: 10000 }, async () => {
  const imap = await imapServer({ sentFolder: false });
  try {
    const batch = await mail.fetchSentHistory(account(imap.port), null);
    assert.deepStrictEqual({ ...batch, cursor: { ...batch.cursor, fullAt: 0 } }, {
      cursor: { kind: 'imap', path: null, uidValidity: null, lastUid: 0, fullAt: 0 }, full: true, entries: [],
    });
    assert.deepStrictEqual(imap.state.opened, []);
    assert.strictEqual(await settled(imap.state), 0);
  } finally {
    await imap.close();
  }

  // A login the server rejects is a sentence, like everywhere else.
  const refusing = await imapServer();
  try {
    await assert.rejects(mail.fetchSentHistory(account(refusing.port, { pass: 'wrong' }), null), /rejected the login/);
  } finally {
    await refusing.close();
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

test('there is no way to mark as read, and nothing ClearMail did changed a mailbox', () => {
  assert.strictEqual(mail.markSeen, undefined);
  assert.ok(allCommands.length > 50, 'the tests above talked to the mock servers');
  for (const command of allCommands) {
    assert.doesNotMatch(command, /^(?:UID )?(?:STORE|COPY|MOVE|EXPUNGE|SELECT|CLOSE|DELETE|RENAME|CREATE)\b/i, command);
    if (/^EXAMINE /i.test(command)) assert.match(command, /^EXAMINE "?(?:INBOX|Sent)"?$/, command);
    if (/^APPEND /i.test(command)) assert.match(command, /^APPEND "?Sent"? \(\\Seen\)/, command);
    if (/^(?:UID )?FETCH /i.test(command)) {
      const items = command.replace(/\b(?:BODY|BINARY)\.PEEK\[[^\]]*\](?:<\d+\.\d+>)?/g, '').replace(/RFC822\.SIZE/g, '');
      assert.doesNotMatch(items, /\bBODY\[|\bBINARY\[|\bRFC822\b/, command);
    }
  }
  // The only APPENDs are the replies the sendReply tests sent.
  assert.strictEqual(allCommands.filter((c) => /^APPEND /i.test(c)).length, 1);
});
