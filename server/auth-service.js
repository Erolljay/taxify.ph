/* ============================================================
   Txform.ph — server/auth-service.js

   Small Node HTTP service for passwordless (magic-link) auth and
   owner-only tenancy writes. Uses ONLY Node built-ins: node:http,
   node:sqlite, node:crypto — no npm install. All decisions defer to
   the tested rules in auth-core.js, so this file is thin plumbing:
   DB access, cookies, and wiring.

   Handlers are exported as pure-ish functions (db, input, deps) →
   { status, json, setCookie? } so they can be tested against an
   in-memory DB with an injected clock and email sender, without
   booting the server or sending real mail. main() wires them to HTTP.

   Sessions are server-side (random secret, only its hash stored;
   cookie holds the raw secret). No signing key to manage; revoke by
   deleting the session row.
   ============================================================ */
'use strict';

const A = require('./auth-core.js');

const COOKIE_NAME = 'txfsid';
// Set to '.txform.ph' in prod so the session cookie set by the portal
// (txform.ph) is also sent to the extension host (extension.txform.ph)
// where entitlement.php reads it. Empty in dev = host-only cookie.
const COOKIE_DOMAIN = process.env.TXFORM_COOKIE_DOMAIN || '';

// ── helpers ───────────────────────────────────────────────────────
function parseCookie(header, name) {
  if (!header) return null;
  const hit = header.split(';').map(function (s) { return s.trim(); })
    .find(function (s) { return s.startsWith(name + '='); });
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function sessionCookie(raw, maxAgeMs) {
  return COOKIE_NAME + '=' + encodeURIComponent(raw) +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + Math.floor(maxAgeMs / 1000) +
    (COOKIE_DOMAIN ? '; Domain=' + COOKIE_DOMAIN : '');
}

// Resolve the caller's session into { user_id, email, role, account_id,
// expires_at } or null. Used by every authenticated handler.
function loadSession(db, cookieHeader, now) {
  const raw = parseCookie(cookieHeader, COOKIE_NAME);
  if (!raw) return null;
  const row = db.prepare(
    `SELECT s.expires_at, u.id AS user_id, u.email, u.role, u.account_id
       FROM session s JOIN users u ON u.id = s.user_id
      WHERE s.session_hash = ?`
  ).get(A.hashToken(raw));
  if (!A.isSessionValid(row, now)) return null;
  return row;
}

// ── handlers ──────────────────────────────────────────────────────

// POST /api/auth/request-link { email }
// Always returns the same generic 200 (no account enumeration). Sends a
// link only if the email maps to a user and the rate limit allows it.
function requestLink(db, input, deps) {
  const now = deps.now();
  const email = (input && typeof input.email === 'string') ? input.email.trim().toLowerCase() : '';
  const generic = { status: 200, json: { ok: true, message: 'If that email has an account, a sign-in link is on its way.' } };
  if (!email) return { status: 400, json: { error: 'email required' } };

  const recent = db.prepare('SELECT created_at FROM login_token WHERE email = ?')
    .all(email).map(function (r) { return r.created_at; });
  if (!A.withinRateLimit(recent, now, A.LINK_RATE)) {
    return { status: 429, json: { error: 'Too many sign-in requests. Try again shortly.' } };
  }

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (user) {
    const raw = A.generateToken();
    db.prepare('INSERT INTO login_token (email, token_hash, expires_at, created_at, request_ip) VALUES (?,?,?,?,?)')
      .run(email, A.hashToken(raw), A.tokenExpiry(now), now, input.ip || null);
    deps.sendEmail({ to: email, link: deps.baseUrl + '/api/auth/verify?token=' + encodeURIComponent(raw) });
  }
  return generic; // identical response whether or not the user existed
}

// POST /api/early-access { email }
// The one public, unauthenticated write: captures a marketing signup from
// the website's early-access form. Idempotent per email (UNIQUE), so a
// double submit is a no-op. Generic 200 — no account enumeration.
function earlyAccess(db, input, deps) {
  const now = deps.now();
  const email = (input && typeof input.email === 'string') ? input.email.trim().toLowerCase() : '';
  // Minimal shape check — something@something.tld. Not full RFC 5322;
  // the goal is to reject obvious junk, not to validate deliverability.
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { status: 400, json: { error: 'A valid email is required.' } };
  }
  db.prepare('INSERT OR IGNORE INTO early_access (email, created_at, request_ip) VALUES (?,?,?)')
    .run(email, now, (input && input.ip) || null);
  return { status: 200, json: { ok: true, message: "You're on the list — we'll be in touch with onboarding details." } };
}

// GET /api/auth/verify?token=...  → consumes the token, opens a session.
function verifyLink(db, input, deps) {
  const now = deps.now();
  const token = input && input.token;
  if (!token) return { status: 400, json: { error: 'token required' } };

  const row = db.prepare('SELECT id, email, expires_at, consumed_at FROM login_token WHERE token_hash = ?')
    .get(A.hashToken(String(token)));
  const check = A.isLoginTokenUsable(row, now);
  if (!check.usable) return { status: 400, json: { error: 'link ' + check.reason } };

  // Consume atomically — the WHERE guard makes a replayed request a no-op.
  const consumed = db.prepare('UPDATE login_token SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .run(now, row.id);
  if (consumed.changes !== 1) return { status: 400, json: { error: 'link consumed' } };

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(row.email);
  if (!user) return { status: 400, json: { error: 'no such user' } };

  const raw = A.generateToken();
  db.prepare('INSERT INTO session (user_id, session_hash, expires_at, created_at) VALUES (?,?,?,?)')
    .run(user.id, A.hashToken(raw), A.sessionExpiry(now), now);
  return { status: 200, json: { ok: true }, setCookie: sessionCookie(raw, A.SESSION_TTL_MS) };
}

// GET /api/auth/me  → who is signed in.
function currentUser(db, input, deps) {
  const s = loadSession(db, input.cookie, deps.now());
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  return { status: 200, json: { email: s.email, role: s.role, account_id: s.account_id } };
}

// POST /api/tenancy/user-business { userId, businessId, grant }
// Owner-only. Grants or revokes a staff member's access to a client
// business, enqueues a provisioner job, and writes the audit log.
function setUserBusiness(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };

  const account = { id: s.account_id };
  const authz = A.authorizeOwnerAction(
    { role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now
  );
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  // Both the target user and business must belong to the owner's account
  // — data-layer cross-tenant guard, beyond the role check above.
  const tu = db.prepare('SELECT account_id FROM users WHERE id = ?').get(input.userId);
  const tb = db.prepare('SELECT account_id FROM businesses WHERE id = ?').get(input.businessId);
  if (!tu || !tb || tu.account_id !== s.account_id || tb.account_id !== s.account_id) {
    return { status: 403, json: { error: 'wrong_account' } };
  }

  const grant = !!input.grant;
  if (grant) {
    db.prepare('INSERT OR IGNORE INTO user_business (user_id, business_id) VALUES (?,?)')
      .run(input.userId, input.businessId);
  } else {
    db.prepare('DELETE FROM user_business WHERE user_id = ? AND business_id = ?')
      .run(input.userId, input.businessId);
  }
  db.prepare('INSERT INTO provision_job (type, user_id, business_id, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(grant ? 'grant' : 'revoke', input.userId, input.businessId, now, now);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, grant ? 'grant_business' : 'revoke_business',
      'user:' + input.userId + ' business:' + input.businessId);

  return { status: 200, json: { ok: true } };
}

// POST /api/tenancy/invite-staff { email }
// Owner-only. Adds a staff user against the seat limit and enqueues a
// 'create' job so the provisioner makes their Manager restricted user.
// Re-inviting an existing member is idempotent and consumes no seat.
function inviteStaff(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const account = db.prepare('SELECT id, seats_limit FROM account WHERE id = ?').get(s.account_id);
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const email = (input && typeof input.email === 'string') ? input.email.trim().toLowerCase() : '';
  if (!email) return { status: 400, json: { error: 'email required' } };

  const existing = db.prepare('SELECT id FROM users WHERE account_id = ? AND email = ?').get(s.account_id, email);
  if (existing) return { status: 200, json: { ok: true, userId: existing.id, alreadyMember: true } };

  const seatCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE account_id = ?').get(s.account_id).n;
  const room = A.canProvisionMore('seat', { limit: account.seats_limit, currentCount: seatCount });
  if (!room.ok) return { status: 409, json: { error: room.reason } };

  const userId = Number(db.prepare('INSERT INTO users (account_id, email, role) VALUES (?,?,?)')
    .run(s.account_id, email, 'staff').lastInsertRowid);
  db.prepare('INSERT INTO provision_job (type, user_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('create', userId, now, now);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'invite_staff', 'user:' + userId + ' ' + email);
  return { status: 201, json: { ok: true, userId: userId } };
}

// POST /api/tenancy/add-business { managerBusinessGuid, name }
// Owner-only. Registers one of the firm's client businesses against the
// business limit. The GUID is globally unique — claiming one already
// registered to another account is refused. Granting a user access to it
// is a separate step (setUserBusiness).
function addBusiness(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const account = db.prepare('SELECT id, businesses_limit FROM account WHERE id = ?').get(s.account_id);
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const guid = (input && typeof input.managerBusinessGuid === 'string') ? input.managerBusinessGuid.trim() : '';
  const name = (input && typeof input.name === 'string') ? input.name.trim() : '';
  if (!guid || !name) return { status: 400, json: { error: 'managerBusinessGuid and name required' } };

  const existing = db.prepare('SELECT id, account_id FROM businesses WHERE manager_business_guid = ?').get(guid);
  if (existing) {
    if (existing.account_id === s.account_id) return { status: 200, json: { ok: true, businessId: existing.id, alreadyAdded: true } };
    return { status: 409, json: { error: 'business already registered to another account' } };
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE account_id = ?').get(s.account_id).n;
  const room = A.canProvisionMore('business', { limit: account.businesses_limit, currentCount: count });
  if (!room.ok) return { status: 409, json: { error: room.reason } };

  const businessId = Number(db.prepare('INSERT INTO businesses (account_id, manager_business_guid, name) VALUES (?,?,?)')
    .run(s.account_id, guid, name).lastInsertRowid);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'add_business', 'business:' + businessId + ' ' + guid);
  return { status: 201, json: { ok: true, businessId: businessId } };
}

// GET /api/tenancy/overview
// Owner-only snapshot the portal renders: account limits, staff,
// businesses, and the grant matrix.
function overview(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, { id: s.account_id }, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const account = db.prepare('SELECT plan, status, seats_limit, businesses_limit FROM account WHERE id = ?').get(s.account_id);
  const users = db.prepare('SELECT id, email, role FROM users WHERE account_id = ? ORDER BY role DESC, email').all(s.account_id);
  const businesses = db.prepare('SELECT id, name, manager_business_guid FROM businesses WHERE account_id = ? ORDER BY name').all(s.account_id);
  const grants = db.prepare(
    'SELECT ub.user_id, ub.business_id FROM user_business ub JOIN users u ON u.id = ub.user_id WHERE u.account_id = ?'
  ).all(s.account_id);

  return { status: 200, json: { account: account, me: { email: s.email, role: s.role }, users: users, businesses: businesses, grants: grants } };
}

module.exports = {
  COOKIE_NAME, parseCookie, loadSession,
  requestLink, verifyLink, currentUser, earlyAccess,
  setUserBusiness, inviteStaff, addBusiness, overview,
};

// ── HTTP wiring (thin; not unit-tested — handlers are) ────────────
if (require.main === module) {
  const http = require('node:http');
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const path = require('node:path');

  const dbPath = process.env.TXFORM_DB || path.join(__dirname, 'txform.db');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // Real SMTP sender when configured (creds via /etc/txform/auth.env,
  // wired by the systemd unit); otherwise log the link — keeps local
  // dev and CI working with no mailbox. secure defaults to true, and
  // to implicit-TLS on 465 vs STARTTLS on 587 by port.
  const mailer = require('./smtp-mailer.js');
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const sendEmail = process.env.SMTP_HOST
    ? mailer.makeMailer({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM || 'Txform.ph <hello@txform.ph>',
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtpPort === 465,
        ehloName: process.env.SMTP_EHLO || 'txform.ph',
      })
    : function (m) { console.log('[auth] would email', m.to, m.link); };

  const deps = {
    now: function () { return Date.now(); },
    baseUrl: process.env.TXFORM_BASE_URL || 'https://txform.ph',
    sendEmail: sendEmail,
  };

  function send(res, out) {
    const headers = { 'Content-Type': 'application/json' };
    if (out.setCookie) headers['Set-Cookie'] = out.setCookie;
    res.writeHead(out.status, headers);
    res.end(JSON.stringify(out.json));
  }

  http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch (e) { return send(res, { status: 400, json: { error: 'bad json' } }); }
      const cookie = req.headers.cookie;
      const ip = req.socket.remoteAddress;
      try {
        if (req.method === 'POST' && url.pathname === '/api/auth/request-link') return send(res, requestLink(db, { email: json.email, ip: ip }, deps));
        if (req.method === 'POST' && url.pathname === '/api/early-access') return send(res, earlyAccess(db, { email: json.email, ip: ip }, deps));
        if (url.pathname === '/api/auth/verify') return send(res, verifyLink(db, { token: url.searchParams.get('token') }, deps));
        if (url.pathname === '/api/auth/me') return send(res, currentUser(db, { cookie: cookie }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/user-business') return send(res, setUserBusiness(db, { cookie: cookie, userId: json.userId, businessId: json.businessId, grant: json.grant }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/invite-staff') return send(res, inviteStaff(db, { cookie: cookie, email: json.email }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/add-business') return send(res, addBusiness(db, { cookie: cookie, managerBusinessGuid: json.managerBusinessGuid, name: json.name }, deps));
        if (req.method === 'GET' && url.pathname === '/api/tenancy/overview') return send(res, overview(db, { cookie: cookie }, deps));
        send(res, { status: 404, json: { error: 'not found' } });
      } catch (e) {
        console.error('[auth] handler error', e);
        send(res, { status: 500, json: { error: 'internal error' } });
      }
    });
  }).listen(process.env.PORT || 5100, function () { console.log('[auth] listening on', process.env.PORT || 5100); });
}
