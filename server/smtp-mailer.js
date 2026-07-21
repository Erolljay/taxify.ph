/* ============================================================
   Txform.ph — server/smtp-mailer.js

   Zero-dependency SMTP sender for the passwordless (magic-link)
   auth flow. Uses only Node builtins (net/tls/crypto/os) so it
   ships with the same git-pull deploy as everything else — no
   npm install on the server, ever.

   Two seams are kept pure and unit-tested:
     • buildMessage()      — RFC 5322 message construction
     • magicLinkContent()  — the sign-in email copy
     • session()           — the SMTP command dialogue (tested
                             against an in-process mock server)

   sendMail()/makeMailer() are the thin transport glue that opens
   the real socket (implicit TLS on 465, or STARTTLS on 587) and
   drives session() — thin, like the HTTP wiring in auth-service.js.
   ============================================================ */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 20 * 1000;

// ── Message construction (pure) ──────────────────────────────────

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const isAscii = (s) => !/[^\x00-\x7F]/.test(s);

// Wrap a base64 string into 76-char lines (RFC 2045).
function wrap76(s) {
  return (s.match(/.{1,76}/g) || ['']).join(CRLF);
}

// RFC 5322 date, e.g. "Sun, 13 Jul 2026 18:00:00 +0000". Always UTC
// so we never depend on the box's timezone.
function rfc5322Date(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  return days[d.getUTCDay()] + ', ' + p2(d.getUTCDate()) + ' ' + mon[d.getUTCMonth()] +
    ' ' + d.getUTCFullYear() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) +
    ':' + p2(d.getUTCSeconds()) + ' +0000';
}

// Encode a header value only if it carries non-ASCII (RFC 2047 'B').
function encodeHeader(value) {
  return isAscii(value) ? value : '=?UTF-8?B?' + b64(value) + '?=';
}

// Strip CR/LF so a crafted address/subject can't inject extra SMTP
// headers or recipients (header injection). Applied to every value
// that lands in a header or the envelope.
function oneLine(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

// Bare address out of "Display Name <addr@host>" (or a plain addr).
function addressOnly(from) {
  const m = /<([^>]+)>/.exec(from);
  return oneLine(m ? m[1] : from);
}

// Build a complete RFC 5322 message (headers + blank line + body).
// No trailing CRLF and no SMTP dot-stuffing — that is a transport
// concern handled in session().
function buildMessage(opts) {
  const from = oneLine(opts.from);
  const to = oneLine(opts.to);
  const subject = oneLine(opts.subject);
  const body = String(opts.text || '').replace(/\r?\n/g, CRLF);
  const date = opts.date ? new Date(opts.date) : new Date();
  const domain = addressOnly(from).split('@')[1] || os.hostname();
  const messageId = opts.messageId || '<' + crypto.randomBytes(16).toString('hex') + '@' + domain + '>';

  const ascii = isAscii(body);
  const encodedBody = ascii ? body : wrap76(Buffer.from(body, 'utf8').toString('base64'));

  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + encodeHeader(subject),
    'Date: ' + rfc5322Date(date),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: ' + (ascii ? '7bit' : 'base64'),
  ];
  return headers.join(CRLF) + CRLF + CRLF + encodedBody;
}

// The sign-in email copy. Pure so the wording stays under test.
// "Your firm added you" — sent once, when an owner invites someone.
//
// Deliberately carries NO sign-in link. Login tokens last 15 minutes, so
// an invite opened the next morning would be a dead link and a support
// call; pointing at the portal instead can never go stale. It also means
// the email holds no credential at all.
//
// And never the Books password. That is shown once to the owner in the
// portal, for them to pass on however they already talk to their staff —
// email keeps a working credential in a mailbox indefinitely, which for
// a system holding clients' financial records is the control an auditor
// would ask about first.
function inviteContent(opts) {
  const firm = (opts && opts.firmName) || 'your firm';
  const portal = (opts && opts.portalUrl) || 'https://txform.ph/account';
  const isClient = opts && opts.role === 'client';

  const subject = isClient
    ? firm + ' has shared your books on Txform.ph'
    : 'You have been added to ' + firm + ' on Txform.ph';

  const what = isClient
    ? 'You can see your own filed BIR returns and what is due. It is read-only —\nyour accountant does the filing.'
    : 'You will be able to open the client books you have been given access to,\nand prepare and file their BIR returns.';

  const text = [
    'Hi,',
    '',
    firm + ' has added you to Txform.ph.',
    '',
    what,
    '',
    'To sign in, go to:',
    '',
    portal,
    '',
    'Enter this email address and we will send you a one-time sign-in link.',
    'There is no password to remember.',
    '',
    isClient
      ? 'Your firm will send you the separate credentials for the books themselves.'
      : 'Your firm owner will give you your Books sign-in separately — we never send\npasswords by email.',
    '',
    "If you were not expecting this, you can ignore this email — you will not be\nable to sign in unless someone at " + firm + ' added you.',
    '',
    '— Txform.ph',
  ].join('\n');

  return { subject, text };
}

function magicLinkContent(link) {
  const subject = 'Your Txform.ph sign-in link';
  const text = [
    'Hi,',
    '',
    'Use the link below to sign in to your Txform.ph account. It works once',
    'and expires in 15 minutes.',
    '',
    link,
    '',
    "If you didn't request this, you can safely ignore this email.",
    '',
    '— Txform.ph',
  ].join('\n');
  return { subject, text };
}

// SMTP dot-stuffing: any line starting with '.' gets an extra '.'.
function dotStuff(message) {
  return message.split(CRLF).map((l) => (l.startsWith('.') ? '.' + l : l)).join(CRLF);
}

// ── SMTP transport ───────────────────────────────────────────────

// Reads lock-step SMTP replies off a socket. Handles multiline
// replies ("250-line" continuations ended by a "250 line"). detach()
// removes its listeners so the socket can be handed to STARTTLS.
function createClient(socket, timeoutMs) {
  let buffer = '';
  let pending = null;

  function settleReject(err) {
    if (pending) { const p = pending; pending = null; p.reject(err); }
  }
  function tryDeliver() {
    if (!pending) return;
    const lines = buffer.split(CRLF);
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        buffer = lines.slice(i + 1).join(CRLF);
        const code = Number(lines[i].slice(0, 3));
        const p = pending; pending = null;
        p.resolve({ code: code, text: lines.slice(0, i + 1).join('\n') });
        return;
      }
    }
  }
  const onData = (chunk) => { buffer += chunk.toString('utf8'); tryDeliver(); };
  const onError = (err) => settleReject(err);
  const onClose = () => settleReject(new Error('connection closed by server'));
  const onTimeout = () => socket.destroy(new Error('smtp timeout'));

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  if (timeoutMs) { socket.setTimeout(timeoutMs); socket.on('timeout', onTimeout); }

  function read() {
    return new Promise((resolve, reject) => {
      if (pending) return reject(new Error('read already pending'));
      pending = { resolve: resolve, reject: reject };
      tryDeliver();
    });
  }
  async function expect(codes, label) {
    const reply = await read();
    const list = Array.isArray(codes) ? codes : [codes];
    if (!list.includes(reply.code)) {
      throw new Error('SMTP ' + (label || 'reply') + ': expected ' + list.join('/') +
        ', got ' + reply.code + ' — ' + reply.text.replace(/\s+/g, ' ').trim());
    }
    return reply;
  }
  function write(line) { socket.write(line + CRLF); }
  function command(line, codes, label) { write(line); return expect(codes, label); }
  function detach() {
    socket.removeListener('data', onData);
    socket.removeListener('error', onError);
    socket.removeListener('close', onClose);
    socket.removeListener('timeout', onTimeout);
  }
  return { read, expect, command, write, detach };
}

// Drive one message to completion over an already-connected socket.
// opts: { ehloName, auth:{user,pass}|null, envelope:{from,to}, message,
//         startTls:bool, upgrade:(sock)=>Promise<socket>, timeoutMs }
async function session(initialSocket, opts) {
  let socket = initialSocket;
  let client = createClient(socket, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const ehlo = 'EHLO ' + (opts.ehloName || os.hostname());
  try {
    await client.expect(220, 'greeting');
    await client.command(ehlo, 250, 'EHLO');

    if (opts.startTls) {
      await client.command('STARTTLS', 220, 'STARTTLS');
      client.detach();
      socket = await opts.upgrade(socket);
      client = createClient(socket, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
      await client.command(ehlo, 250, 'EHLO(TLS)');
    }

    if (opts.auth) {
      await client.command('AUTH LOGIN', 334, 'AUTH');
      await client.command(b64(opts.auth.user), 334, 'AUTH user');
      await client.command(b64(opts.auth.pass), 235, 'AUTH pass');
    }

    await client.command('MAIL FROM:<' + opts.envelope.from + '>', 250, 'MAIL FROM');
    await client.command('RCPT TO:<' + opts.envelope.to + '>', [250, 251], 'RCPT TO');
    await client.command('DATA', 354, 'DATA');
    // Body terminated by <CRLF>.<CRLF>; write() appends the final CRLF.
    client.write(dotStuff(opts.message) + CRLF + '.');
    await client.expect(250, 'message body');
    await client.command('QUIT', 221, 'QUIT').catch(() => {});
  } finally {
    socket.end();
  }
}

function onceConnected(socket, event) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    socket.once('error', onErr);
    socket.once(event, () => { socket.removeListener('error', onErr); resolve(); });
  });
}

// Open the real connection and deliver one message.
// config: { host, port, user, pass, secure, ehloName, timeoutMs, tlsOptions }
async function sendMail(config, envelope, message) {
  const secure = config.secure;
  const socket = secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host, ...(config.tlsOptions || {}) })
    : net.connect({ host: config.host, port: config.port });
  await onceConnected(socket, secure ? 'secureConnect' : 'connect');

  await session(socket, {
    ehloName: config.ehloName,
    timeoutMs: config.timeoutMs,
    auth: config.user ? { user: config.user, pass: config.pass } : null,
    envelope: envelope,
    message: message,
    startTls: !secure,
    upgrade: (raw) => {
      const up = tls.connect({ socket: raw, servername: config.host, ...(config.tlsOptions || {}) });
      return onceConnected(up, 'secureConnect').then(() => up);
    },
  });
}

// Build a sendEmail({ to, link }) function to plug into the auth
// service's deps. Fire-and-forget: never throws into the caller, so a
// mail hiccup can't 500 the sign-in request — it logs and moves on.
function makeMailer(config) {
  const from = config.from || 'Txform.ph <hello@txform.ph>';
  const envelopeFrom = addressOnly(from);
  return function sendEmail(m) {
    const to = oneLine(m.to);
    // Two kinds of mail now. Anything without an explicit kind is a
    // sign-in link, keeping the original contract for existing callers.
    const { subject, text } = m.kind === 'invite' ? inviteContent(m) : magicLinkContent(m.link);
    const message = buildMessage({ from: from, to: to, subject: subject, text: text });
    return sendMail(config, { from: envelopeFrom, to: to }, message)
      .catch((err) => { console.error('[mailer] send to', to, 'failed:', err.message); });
  };
}

module.exports = {
  buildMessage, magicLinkContent, inviteContent, dotStuff, addressOnly, encodeHeader, rfc5322Date,
  createClient, session, sendMail, makeMailer,
};
