/* ============================================================
   Tests for server/smtp-mailer.js.

   Pure builders (buildMessage / magicLinkContent / dotStuff) plus
   the SMTP session() dialogue driven against an in-process mock
   SMTP server over a plain socket — no real network, no TLS certs.

     node --test test/smtp-mailer.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const M = require('../server/smtp-mailer.js');

const CRLF = '\r\n';

// ── Pure message construction ────────────────────────────────────

test('buildMessage: required headers, CRLF endings, 7bit ASCII body', () => {
  const msg = M.buildMessage({
    from: 'Txform.ph <hello@txform.ph>',
    to: 'owner@x.com',
    subject: 'Your Txform.ph sign-in link',
    text: 'line one\nline two',
    date: '2026-07-13T18:00:00Z',
    messageId: '<fixed@txform.ph>',
  });
  assert.match(msg, /^From: Txform\.ph <hello@txform\.ph>/m);
  assert.match(msg, /^To: owner@x\.com/m);
  assert.match(msg, /^Subject: Your Txform\.ph sign-in link/m);
  assert.match(msg, /^Date: Mon, 13 Jul 2026 18:00:00 \+0000$/m);
  assert.match(msg, /^Message-ID: <fixed@txform\.ph>$/m);
  assert.match(msg, /^Content-Transfer-Encoding: 7bit$/m);
  assert.ok(msg.includes(CRLF + CRLF + 'line one' + CRLF + 'line two'), 'body after blank line, CRLF joined');
  assert.ok(!msg.endsWith(CRLF), 'no trailing CRLF (transport adds terminator)');
});

test('buildMessage: non-ASCII subject and body are encoded (RFC 2047 + base64)', () => {
  const msg = M.buildMessage({
    from: 'hello@txform.ph',
    to: 'owner@x.com',
    subject: 'Mabúhay ☑',
    text: 'Kumustá — ₱1,000',
  });
  assert.match(msg, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  assert.match(msg, /^Content-Transfer-Encoding: base64$/m);
  const body = msg.split(CRLF + CRLF)[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Kumustá — ₱1,000');
});

test('magicLinkContent: subject + link + expiry wording', () => {
  const { subject, text } = M.magicLinkContent('https://txform.ph/api/auth/verify?token=abc');
  assert.match(subject, /sign-in link/i);
  assert.ok(text.includes('https://txform.ph/api/auth/verify?token=abc'));
  assert.match(text, /expires in 15 minutes/i);
});

test('welcomeContent: names the payment, carries the link, keeps the 15-min expiry', () => {
  const { subject, text } = M.welcomeContent('https://txform.ph/api/auth/verify?token=xyz');
  assert.match(subject, /welcome/i);
  assert.match(text, /payment/i, 'says why they got it — not a bare login link');
  assert.ok(text.includes('https://txform.ph/api/auth/verify?token=xyz'));
  assert.match(text, /expires in 15 minutes/i);
});

test('monthlyInvoiceContent: names the period + amount and carries the pay link', () => {
  const { subject, text } = M.monthlyInvoiceContent({
    link: 'https://checkout.xendit.co/inv_9', amountCentavos: 250000, period: '2026-07', businesses: 5,
  });
  assert.match(subject, /2026-07/);
  assert.match(subject, /₱2,500/);
  assert.match(text, /5 client businesses × ₱500/);
  assert.ok(text.includes('https://checkout.xendit.co/inv_9'));
});

test('dotStuff: only lines beginning with a dot get an extra dot', () => {
  const stuffed = M.dotStuff(['normal', '.leading dot', 'mid.dle', '..two'].join(CRLF));
  assert.equal(stuffed, ['normal', '..leading dot', 'mid.dle', '...two'].join(CRLF));
});

test('addressOnly: strips a display name', () => {
  assert.equal(M.addressOnly('Txform.ph <hello@txform.ph>'), 'hello@txform.ph');
  assert.equal(M.addressOnly('hello@txform.ph'), 'hello@txform.ph');
});

test('buildMessage: CR/LF in header fields cannot inject headers (header injection)', () => {
  const msg = M.buildMessage({
    from: 'hello@txform.ph',
    to: 'victim@x.com\r\nBcc: attacker@evil.com',
    subject: 'Hi\r\nX-Injected: yes',
    text: 'body',
    messageId: '<i@txform.ph>',
  });
  assert.ok(!/^Bcc:/m.test(msg), 'no injected Bcc header');
  assert.ok(!/^X-Injected:/m.test(msg), 'no injected custom header');
  assert.match(msg, /^To: victim@x\.com Bcc: attacker@evil\.com$/m, 'CRLF folded to a space, stays one header');
});

// ── Mock SMTP server for the session() dialogue ──────────────────

// Minimal line-based SMTP server. Records the envelope, decoded
// credentials, and message body. `overrides` lets a test force a
// non-2xx reply at a given step to exercise the error path.
function mockServer(overrides = {}) {
  const received = { user: null, pass: null, mailFrom: null, rcptTo: null, body: '' };
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let authStep = 0; // 0 none, 1 expect user, 2 expect pass
    sock.write('220 mock.smtp ready' + CRLF);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf(CRLF)) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write((overrides.data || '250 queued') + CRLF); }
          else {
            // Dot-unstuffing: a real receiver strips one leading dot.
            const unstuffed = line.startsWith('.') ? line.slice(1) : line;
            received.body += (received.body ? CRLF : '') + unstuffed;
          }
          continue;
        }
        if (authStep === 1) { received.user = Buffer.from(line, 'base64').toString('utf8'); authStep = 2; sock.write('334 UGFzc3dvcmQ6' + CRLF); continue; }
        if (authStep === 2) { received.pass = Buffer.from(line, 'base64').toString('utf8'); authStep = 0; sock.write((overrides.authPass || '235 ok') + CRLF); continue; }

        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-mock.smtp' + CRLF + '250 AUTH LOGIN' + CRLF);
        else if (up === 'AUTH LOGIN') { authStep = 1; sock.write('334 VXNlcm5hbWU6' + CRLF); }
        else if (up.startsWith('MAIL FROM')) { received.mailFrom = line; sock.write((overrides.mail || '250 ok') + CRLF); }
        else if (up.startsWith('RCPT TO')) { received.rcptTo = line; sock.write((overrides.rcpt || '250 ok') + CRLF); }
        else if (up === 'DATA') { inData = true; sock.write('354 go ahead' + CRLF); }
        else if (up === 'QUIT') { sock.write('221 bye' + CRLF); sock.end(); }
        else sock.write('500 unknown' + CRLF);
      }
    });
    sock.on('error', () => {});
  });
  return { server, received };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

test('session: full AUTH → MAIL → RCPT → DATA delivers the message', async () => {
  const { server, received } = mockServer();
  const port = await listen(server);
  try {
    const sock = await connect(port);
    const message = M.buildMessage({
      from: 'hello@txform.ph', to: 'owner@x.com',
      subject: 'Your Txform.ph sign-in link', text: 'sign in: https://txform.ph/verify?token=xyz',
      messageId: '<t@txform.ph>',
    });
    await M.session(sock, {
      ehloName: 'txform.ph',
      auth: { user: 'hello@txform.ph', pass: 's3cr3t' },
      envelope: { from: 'hello@txform.ph', to: 'owner@x.com' },
      message: message,
    });
    assert.equal(received.user, 'hello@txform.ph');
    assert.equal(received.pass, 's3cr3t');
    assert.equal(received.mailFrom, 'MAIL FROM:<hello@txform.ph>');
    assert.equal(received.rcptTo, 'RCPT TO:<owner@x.com>');
    assert.match(received.body, /Subject: Your Txform\.ph sign-in link/);
    assert.match(received.body, /token=xyz/);
  } finally {
    server.close();
  }
});

test('session: no auth config skips AUTH and still delivers', async () => {
  const { server, received } = mockServer();
  const port = await listen(server);
  try {
    const sock = await connect(port);
    await M.session(sock, {
      ehloName: 'txform.ph', auth: null,
      envelope: { from: 'hello@txform.ph', to: 'a@b.com' },
      message: M.buildMessage({ from: 'hello@txform.ph', to: 'a@b.com', subject: 'Hi', text: 'body', messageId: '<x@txform.ph>' }),
    });
    assert.equal(received.user, null, 'AUTH never sent');
    assert.equal(received.rcptTo, 'RCPT TO:<a@b.com>');
  } finally {
    server.close();
  }
});

test('session: leading-dot body line survives dot-stuffing round-trip', async () => {
  const { server, received } = mockServer();
  const port = await listen(server);
  try {
    const sock = await connect(port);
    // A body whose text line starts with a dot must arrive intact.
    const message = M.buildMessage({ from: 'h@txform.ph', to: 'a@b.com', subject: 'S', text: '.hidden command\nafter', messageId: '<d@txform.ph>' });
    await M.session(sock, {
      ehloName: 'txform.ph', auth: null,
      envelope: { from: 'h@txform.ph', to: 'a@b.com' }, message: message,
    });
    assert.match(received.body, /(^|\r\n)\.hidden command(\r\n|$)/, 'un-stuffed back to a single leading dot');
  } finally {
    server.close();
  }
});

test('session: a rejected AUTH surfaces as an error', async () => {
  const { server } = mockServer({ authPass: '535 auth failed' });
  const port = await listen(server);
  try {
    const sock = await connect(port);
    await assert.rejects(
      M.session(sock, {
        ehloName: 'txform.ph', auth: { user: 'u', pass: 'bad' },
        envelope: { from: 'h@txform.ph', to: 'a@b.com' },
        message: M.buildMessage({ from: 'h@txform.ph', to: 'a@b.com', subject: 'S', text: 'b', messageId: '<z@txform.ph>' }),
      }),
      /AUTH pass: expected 235, got 535/,
    );
  } finally {
    server.close();
  }
});

test('session: a rejected recipient surfaces as an error', async () => {
  const { server } = mockServer({ rcpt: '550 no such user' });
  const port = await listen(server);
  try {
    const sock = await connect(port);
    await assert.rejects(
      M.session(sock, {
        ehloName: 'txform.ph', auth: null,
        envelope: { from: 'h@txform.ph', to: 'ghost@x.com' },
        message: M.buildMessage({ from: 'h@txform.ph', to: 'ghost@x.com', subject: 'S', text: 'b', messageId: '<z@txform.ph>' }),
      }),
      /RCPT TO: expected 250\/251, got 550/,
    );
  } finally {
    server.close();
  }
});

test('session: STARTTLS branch issues STARTTLS then re-EHLOs over the upgraded socket', async () => {
  // Mock advertises STARTTLS; the upgrade callback returns the SAME
  // plain socket so we can exercise the branch without real TLS.
  const received = { ehloCount: 0, starttls: false };
  const server = net.createServer((sock) => {
    let buf = '';
    sock.write('220 mock ready' + CRLF);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf(CRLF)) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { received.ehloCount++; sock.write('250-mock' + CRLF + '250 STARTTLS' + CRLF); }
        else if (up === 'STARTTLS') { received.starttls = true; sock.write('220 go ahead' + CRLF); }
        else if (up.startsWith('MAIL')) sock.write('250 ok' + CRLF);
        else if (up.startsWith('RCPT')) sock.write('250 ok' + CRLF);
        else if (up === 'DATA') sock.write('354 send' + CRLF);
        else if (line === '.') sock.write('250 queued' + CRLF);
        else if (up === 'QUIT') { sock.write('221 bye' + CRLF); sock.end(); }
      }
    });
    sock.on('error', () => {});
  });
  const port = await listen(server);
  try {
    const sock = await connect(port);
    let upgraded = false;
    await M.session(sock, {
      ehloName: 'txform.ph', auth: null,
      envelope: { from: 'h@txform.ph', to: 'a@b.com' },
      message: M.buildMessage({ from: 'h@txform.ph', to: 'a@b.com', subject: 'S', text: 'b', messageId: '<s@txform.ph>' }),
      startTls: true,
      upgrade: (raw) => { upgraded = true; return Promise.resolve(raw); },
    });
    assert.equal(received.starttls, true, 'STARTTLS issued');
    assert.equal(received.ehloCount, 2, 'EHLO before and after upgrade');
    assert.equal(upgraded, true, 'upgrade callback invoked');
  } finally {
    server.close();
  }
});

// ── invite email ─────────────────────────────────────────────────
test('inviteContent: names the firm and points at the portal', () => {
  const { subject, text } = M.inviteContent({ firmName: 'Tallo CPA', role: 'staff', portalUrl: 'https://txform.ph/account' });
  assert.match(subject, /Tallo CPA/);
  assert.match(text, /https:\/\/txform\.ph\/account/);
});

test('inviteContent: carries NO sign-in link and NO password', () => {
  // Tokens last 15 minutes, so a link would be dead by morning — and an
  // emailed password would sit in a mailbox indefinitely.
  const { text } = M.inviteContent({ firmName: 'Tallo CPA', role: 'staff' });
  assert.ok(!/verify\?token=/.test(text), 'no one-time link');
  assert.ok(!/password/i.test(text), 'the word password does not appear at all');
});

test('inviteContent: stays SHORT and free of credential vocabulary', () => {
  // The long version — QR codes, 6-digit codes, "ignore the security
  // warning" — was never delivered to an external Gmail, while the short
  // sign-in mail to the same address always arrived. It read like
  // phishing. Keep it looking like a notification.
  const { text } = M.inviteContent({ firmName: 'Tallo CPA', role: 'staff' });
  assert.ok(text.split('\n').length < 25, 'a wall of instructions is what got it filtered');
  ['QR code', 'authenticator', '6-digit', 'invalid authentication', 'Ignore it'].forEach((phrase) => {
    assert.ok(!new RegExp(phrase, 'i').test(text), 'must not mention: ' + phrase);
  });
});

test('inviteContent: points at the portal and says to use this address', () => {
  const { text } = M.inviteContent({ firmName: 'Tallo CPA', role: 'staff', portalUrl: 'https://txform.ph/account' });
  assert.match(text, /https:\/\/txform\.ph\/account/);
  assert.match(text, /one-time sign-in link/);
});

test('inviteContent: tells them the rest is coming from their firm', () => {
  // The password and pairing steps travel through the owner, so the email
  // has to set that expectation or the person is left waiting.
  assert.match(M.inviteContent({ firmName: 'Tallo CPA', role: 'staff' }).text,
    /Tallo CPA will send you the rest/);
  assert.match(M.inviteContent({ firmName: 'Tallo CPA', role: 'client' }).text,
    /Tallo CPA will be in touch/);
});

test('inviteContent: a client is told it is a view, not a job', () => {
  const { text } = M.inviteContent({ firmName: 'Tallo CPA', role: 'client' });
  assert.match(text, /view your filed BIR returns/);
  assert.ok(!/work on the client books/.test(text));
});

test('inviteContent: survives a firm with no name set', () => {
  const { subject, text } = M.inviteContent({ role: 'staff' });
  assert.match(subject, /your firm/);
  assert.ok(!/undefined|null/.test(text));
});

test('makeMailer: routes on kind, defaulting to the sign-in email', () => {
  const sent = [];
  const cfg = { host: 'x', from: 'Txform <hello@txform.ph>' };
  // Exercise the content selection without opening a socket.
  const invite = M.inviteContent({ firmName: 'F', role: 'staff' });
  const signin = M.magicLinkContent('https://txform.ph/api/auth/verify?token=abc');
  assert.notEqual(invite.subject, signin.subject);
  assert.match(signin.text, /expires in 15 minutes/);
  assert.ok(!/expires in 15 minutes/.test(invite.text));
});

test('inviteContent: clients get no authenticator steps', () => {
  // Clients never sign in to the books, so pairing does not apply to them.
  const { text } = M.inviteContent({ firmName: 'Tallo CPA', role: 'client' });
  assert.ok(!/QR code/.test(text));
});

test('makeMailer: logs a successful send, not only a failure', async () => {
  // Before this, a mail that sent and a mail never attempted both produced
  // no output — so "they never got the email" was unanswerable from logs.
  const { server } = mockServer();
  const port = await listen(server);
  const lines = [];
  const realLog = console.log, realErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const send = M.makeMailer({
      host: '127.0.0.1', port, secure: false, startTls: false, ehloName: 'test',
      from: 'Txform <hello@txform.ph>',
    });
    await send({ to: 'someone@example.com', kind: 'invite', firmName: 'Tallo CPA', role: 'staff' });
  } finally {
    console.log = realLog; console.error = realErr;
    server.close();
  }
  const joined = lines.join('\n');
  assert.match(joined, /\[mailer\] sent invite to someone@example\.com/);
  assert.ok(!/has added you to/.test(joined), 'the body is never logged');
});

test('makeMailer: distinguishes an invite from a sign-in in the log', () => {
  // Different kinds must be tellable apart, or "which email went out?" is
  // still guesswork.
  const invite = M.inviteContent({ firmName: 'F', role: 'staff' });
  const signin = M.magicLinkContent('https://txform.ph/api/auth/verify?token=x');
  assert.notEqual(invite.subject, signin.subject);
});
