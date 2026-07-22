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

// A cookie that overwrites txfsid with an already-expired one so the browser
// drops it. It must carry the SAME Domain and Path the session cookie was set
// with, or the browser treats it as a different cookie and keeps the original.
function clearedCookie() {
  return COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' +
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
      WHERE s.session_hash = ? AND u.status = 'active'`
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

  // Removed users are treated exactly like unknown ones: same generic
  // 200, no link. Anything else would let an offboarded person back in.
  const user = db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").get(email);
  if (user) {
    const raw = A.generateToken();
    db.prepare('INSERT INTO login_token (email, token_hash, expires_at, created_at, request_ip) VALUES (?,?,?,?,?)')
      .run(email, A.hashToken(raw), A.tokenExpiry(now), now, input.ip || null);
    deps.sendEmail({ to: email, link: deps.baseUrl + '/api/auth/verify?token=' + encodeURIComponent(raw) });
  }
  return generic; // identical response whether or not the user existed
}

// Does the caller want an HTML page (a browser navigating to the link),
// as opposed to a JSON API client? Drives redirect-vs-JSON on /verify.
function wantsHtml(accept) {
  return typeof accept === 'string' && accept.indexOf('text/html') !== -1;
}

// Token-failure reason (from auth-core.isLoginTokenUsable) → a stable code
// the portal sign-in view can turn into a friendly message. Anything not
// listed falls back to link_invalid.
const LINK_ERROR_CODE = { expired: 'link_expired', consumed: 'link_used', missing: 'link_invalid' };

// GET /api/auth/verify?token=...  → consumes the token, opens a session.
// A browser (Accept: text/html) is 302-redirected: on success to the portal
// with the session cookie attached, on failure back to the sign-in view with
// an ?error=<code> indicator. API clients (Accept: application/json, or no
// Accept header) keep the original JSON contract unchanged.
function verifyLink(db, input, deps) {
  const now = deps.now();
  const html = wantsHtml(input && input.accept);
  const portal = deps.portalUrl || ((deps.baseUrl || 'https://txform.ph') + '/account');

  // Browsers get a redirect back to sign-in; API clients keep the JSON error.
  function fail(status, jsonError, code) {
    if (html) return { status: 302, location: portal + '?error=' + code };
    return { status: status, json: { error: jsonError } };
  }

  const token = input && input.token;
  if (!token) return fail(400, 'token required', 'link_invalid');

  const row = db.prepare('SELECT id, email, expires_at, consumed_at FROM login_token WHERE token_hash = ?')
    .get(A.hashToken(String(token)));
  const check = A.isLoginTokenUsable(row, now);
  if (!check.usable) return fail(400, 'link ' + check.reason, LINK_ERROR_CODE[check.reason] || 'link_invalid');

  // Consume atomically — the WHERE guard makes a replayed request a no-op.
  const consumed = db.prepare('UPDATE login_token SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .run(now, row.id);
  if (consumed.changes !== 1) return fail(400, 'link consumed', 'link_used');

  // Checked again here, not just at request time: a link minted minutes
  // before someone was removed must not still open a session.
  const user = db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").get(row.email);
  if (!user) return fail(400, 'no such user', 'link_invalid');

  const raw = A.generateToken();
  db.prepare('INSERT INTO session (user_id, session_hash, expires_at, created_at) VALUES (?,?,?,?)')
    .run(user.id, A.hashToken(raw), A.sessionExpiry(now), now);

  // Same session in both cases; only the envelope differs. The Set-Cookie
  // rides the 302 so the browser lands on the portal already signed in.
  const setCookie = sessionCookie(raw, A.SESSION_TTL_MS);
  if (html) return { status: 302, location: portal, setCookie: setCookie };
  return { status: 200, json: { ok: true }, setCookie: setCookie };
}

// GET /api/auth/me  → who is signed in.
function currentUser(db, input, deps) {
  const s = loadSession(db, input.cookie, deps.now());
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  return { status: 200, json: { email: s.email, role: s.role, account_id: s.account_id } };
}

// POST /api/auth/sign-out  → ends the caller's session.
// Deletes the server-side session row so the secret in the cookie can never
// be replayed (even if a copy of the cookie survives somewhere), and clears
// the cookie in the browser. Scoped to THIS session only — signing out on one
// device leaves the user's other sessions alone. Idempotent: a missing or
// already-deleted session still returns 200 with the cleared cookie, because
// signing out is never an error.
function signOut(db, input) {
  const raw = parseCookie(input && input.cookie, COOKIE_NAME);
  if (raw) db.prepare('DELETE FROM session WHERE session_hash = ?').run(A.hashToken(raw));
  return { status: 200, json: { ok: true }, setCookie: clearedCookie() };
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

// POST /api/tenancy/invite-staff { email, role?, businessId? }
// Owner-only. Adds a staff or client user and enqueues a 'create' job so
// the provisioner makes their Manager restricted user. Re-inviting an
// existing member is idempotent and consumes no seat.
//
// role defaults to 'staff'. A 'client' is the business owner we keep books
// for: read-only, free, and scoped to exactly one business — so businessId
// is REQUIRED for them and the grant is written here rather than left to a
// separate trip through the access grid.
function inviteStaff(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const account = db.prepare('SELECT id, seats_limit, firm_name FROM account WHERE id = ?').get(s.account_id);
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const email = (input && typeof input.email === 'string') ? input.email.trim().toLowerCase() : '';
  if (!email) return { status: 400, json: { error: 'email required' } };

  // Only these two are invitable. 'owner' is deliberately absent: a second
  // owner would be a billing-control change, not an invite.
  const role = (input && input.role === 'client') ? 'client' : 'staff';

  // A client with no business would see nothing at all, so require the grant
  // up front and verify it's this firm's business before trusting it.
  let clientBusiness = null;
  if (role === 'client') {
    // Coerce first: node:sqlite refuses to bind undefined, so an omitted
    // businessId would throw here instead of returning the 400 it deserves.
    const bizId = Number(input && input.businessId);
    clientBusiness = Number.isInteger(bizId) && bizId > 0
      ? db.prepare("SELECT id, account_id FROM businesses WHERE id = ? AND status = 'active'").get(bizId)
      : null;
    if (!clientBusiness || clientBusiness.account_id !== s.account_id) {
      return { status: 400, json: { error: 'client_requires_own_business' } };
    }
  }

  const existing = db.prepare('SELECT id, status FROM users WHERE account_id = ? AND email = ?').get(s.account_id, email);
  if (existing && existing.status === 'active') {
    return { status: 200, json: { ok: true, userId: existing.id, alreadyMember: true } };
  }
  // Someone who left and came back: reactivate the same row rather than
  // failing on UNIQUE(account_id, email). They return with NO books —
  // access is re-granted deliberately through the grid, never restored
  // silently by rehiring.
  if (existing) {
    db.prepare("UPDATE users SET status = 'active', removed_at = NULL, role = ? WHERE id = ?")
      .run(role, existing.id);
    db.prepare('INSERT INTO provision_job (type, user_id, created_at, updated_at) VALUES (?,?,?,?)')
      .run('create', existing.id, now, now);
    db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
      .run(s.account_id, s.email, 'reinstate_' + role, 'user:' + existing.id + ' ' + email);
    if (deps.sendEmail) {
      try {
        deps.sendEmail({
          to: email, kind: 'invite', role: role,
          firmName: account.firm_name || null,
          portalUrl: deps.portalUrl || ((deps.baseUrl || 'https://txform.ph') + '/account'),
        });
      } catch (e) { console.error('[invite] could not send to', email, '-', e.message); }
    }
    return { status: 200, json: { ok: true, userId: existing.id, reinstated: true, role: role } };
  }

  // Clients are free — only owner/staff count against seats.
  if (A.consumesSeat(role)) {
    const seatCount = db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE account_id = ? AND role IN ('owner','staff') AND status = 'active'"
    ).get(s.account_id).n;
    const room = A.canProvisionMore('seat', { limit: account.seats_limit, currentCount: seatCount });
    if (!room.ok) return { status: 409, json: { error: room.reason } };
  }

  const userId = Number(db.prepare('INSERT INTO users (account_id, email, role) VALUES (?,?,?)')
    .run(s.account_id, email, role).lastInsertRowid);
  db.prepare('INSERT INTO provision_job (type, user_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('create', userId, now, now);

  if (clientBusiness) {
    db.prepare('INSERT OR IGNORE INTO user_business (user_id, business_id) VALUES (?,?)').run(userId, clientBusiness.id);
    db.prepare('INSERT INTO provision_job (type, user_id, business_id, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('grant', userId, clientBusiness.id, now, now);
  }

  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'invite_' + role, 'user:' + userId + ' ' + email);

  // Tell them they exist. Without this the invite is silent: the row is
  // created, the robot provisions them, and nobody ever informs the
  // person. Carries no link and no password — see inviteContent.
  //
  // Fire-and-forget, like the sign-in mail: a mail outage must not fail
  // the invite, because the account and its provisioning are already
  // committed and re-inviting is a no-op that would send nothing.
  if (deps.sendEmail) {
    try {
      deps.sendEmail({
        to: email,
        kind: 'invite',
        role: role,
        firmName: account.firm_name || null,
        portalUrl: deps.portalUrl || ((deps.baseUrl || 'https://txform.ph') + '/account'),
      });
    } catch (e) {
      console.error('[invite] could not send to', email, '-', e.message);
    }
  }

  return { status: 201, json: { ok: true, userId: userId, role: role } };
}

// Pick the name this business will carry on the Manager server. Manager
// keys businesses by name, so it must be globally unique across every
// firm we host — but a bare "that name is taken" would let one firm probe
// another's client list. Instead the loser of a collision silently gets an
// account-scoped suffix: deterministic (same answer however many firms
// collide, so the count leaks nothing) and invisible in the portal, which
// always shows the firm's own `name`.
// Mark this business as active for the current billing month. Idempotent —
// the UNIQUE(business_id, period_key) makes a repeat a no-op, so it's safe
// to call on every add and reactivate.
function recordBillingPeriod(db, businessId, now) {
  db.prepare('INSERT OR IGNORE INTO business_billing_period (business_id, period_key) VALUES (?,?)')
    .run(businessId, A.billingPeriodKey(now));
}

// How many businesses does this account owe for in `periodKey`? The
// high-water mark: everything active at any point in the month, including
// what has since been archived. This is the number an invoice multiplies.
//
// Strictly a count — no account is exempt from being counted. Paying
// nothing is a DISCOUNT, applied in invoiceFor; it is not an escape from
// the rules. That keeps one billing path for every account.
function billableCount(db, accountId, periodKey) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM business_billing_period bp
       JOIN businesses b ON b.id = bp.business_id
      WHERE b.account_id = ? AND bp.period_key = ?`
  ).get(accountId, periodKey).n;
}

// What this account owes for `periodKey`, in centavos, with any voucher
// applied. A fully-comped firm gets a real invoice totalling zero — it is
// counted, charged and recorded like everyone else.
function invoiceFor(db, accountId, periodKey) {
  const discounts = db.prepare(
    'SELECT code, percent_off, reason, starts_period, ends_period FROM account_discount WHERE account_id = ?'
  ).all(accountId);
  const pct = A.discountPercentFor(discounts, periodKey);
  const invoice = A.computeInvoice(billableCount(db, accountId, periodKey), pct);
  // Name the reason on the invoice: a zero total should never be a mystery.
  const applied = discounts.find(function (d) { return Number(d.percent_off) === pct && pct > 0; });
  return Object.assign({ periodKey: periodKey, reason: applied ? applied.reason : null, code: applied ? applied.code : null }, invoice);
}

// Grant a discount. `reason` is required — an unexplained free account is
// exactly what this design exists to prevent.
function grantDiscount(db, accountId, opts) {
  if (!opts || !opts.reason) throw new Error('a discount needs a reason');
  const pct = Math.max(1, Math.min(100, Number(opts.percentOff) || 0));
  db.prepare(
    `INSERT INTO account_discount (account_id, code, percent_off, reason, starts_period, ends_period)
     VALUES (?,?,?,?,?,?)`
  ).run(accountId, opts.code || null, pct, opts.reason, opts.startsPeriod, opts.endsPeriod || null);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(accountId, opts.actor || 'admin-cli', 'grant_discount', pct + '% ' + opts.reason);
}


// POST /api/tenancy/add-business { name }
// Owner-only. Registers one of the firm's client businesses against the
// business limit. Granting a user access to it is a separate step
// (setUserBusiness).
function addBusiness(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const account = db.prepare('SELECT id, businesses_limit, firm_code FROM account WHERE id = ?').get(s.account_id);
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const name = (input && typeof input.name === 'string') ? input.name.trim() : '';
  if (!name) return { status: 400, json: { error: 'name required' } };
  // Without a firm code we cannot name the books in Manager, and an
  // unprefixed business would be the one able to collide with another
  // firm's. Refuse rather than guess.
  if (!account.firm_code) return { status: 409, json: { error: 'firm_code_missing' } };

  // Re-adding a client the firm already has is idempotent and costs no slot.
  // An ARCHIVED one is reactivated instead of duplicated — the Manager name
  // is still taken by that row, and its filed snapshots should come back with it.
  const mine = db.prepare('SELECT id, status FROM businesses WHERE account_id = ? AND name = ?').get(s.account_id, name);
  if (mine && mine.status === 'active') return { status: 200, json: { ok: true, businessId: mine.id, alreadyAdded: true } };
  if (mine) {
    db.prepare("UPDATE businesses SET status = 'active', archived_at = NULL WHERE id = ?").run(mine.id);
    recordBillingPeriod(db, mine.id, now);
    db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
      .run(s.account_id, s.email, 'reactivate_business', 'business:' + mine.id);
    return { status: 200, json: { ok: true, businessId: mine.id, reactivated: true } };
  }

  // Only ACTIVE businesses consume the paid quantity. Archiving frees the
  // slot at once; it does not refund the period (business_billing_period
  // keeps that row), so there's nothing to gain by cycling clients.
  const count = db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE account_id = ? AND status = 'active'").get(s.account_id).n;
  const room = A.canProvisionMore('business', { limit: account.businesses_limit, currentCount: count });
  if (!room.ok) return { status: 409, json: { error: room.reason } };

  // Both the plain name and the account-scoped fallback are taken. Only
  // reachable if this firm already holds the suffixed variant as a
  // separate client, so naming it is safe — it's their own data.
  // Prefixed with the firm's code, so this can never collide with another
  // firm's client of the same name — and so no firm can discover that it
  // would have.
  const managerName = A.managerBusinessName(account.firm_code, name);
  if (!managerName) return { status: 400, json: { error: 'name required' } };
  if (db.prepare('SELECT 1 FROM businesses WHERE manager_business_name = ?').get(managerName)) {
    // Only reachable within one firm — their own data, safe to name.
    return { status: 409, json: { error: 'name_unavailable' } };
  }

  const businessId = Number(db.prepare('INSERT INTO businesses (account_id, manager_business_name, name) VALUES (?,?,?)')
    .run(s.account_id, managerName, name).lastInsertRowid);
  recordBillingPeriod(db, businessId, now);
  // The books do not exist in Manager yet — the provisioner creates them,
  // and only then does manager_created_at get stamped.
  db.prepare('INSERT INTO provision_job (type, business_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('create_business', businessId, now, now);
  // Turn on the tabs the firm works in. Its own job so a tab failure
  // retries on its own, and ordered behind create_business by id.
  db.prepare('INSERT INTO provision_job (type, business_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('configure_tabs', businessId, now, now);
  // Pin the firm's "Txform Now!" custom button to the new client's Summary
  // page. Its own job so a failed install retries alone, and ordered behind
  // create_business by id like configure_tabs.
  db.prepare('INSERT INTO provision_job (type, business_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('configure_custom_button', businessId, now, now);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'add_business', 'business:' + businessId + ' ' + managerName);
  return { status: 201, json: { ok: true, businessId: businessId } };
}

// POST /api/tenancy/archive-business { businessId }
// Owner-only. Archive — never delete: filed snapshots and the audit trail
// must survive a client leaving. Revokes every user's Manager access to it
// and frees the slot against businesses_limit, but leaves this month's
// business_billing_period row standing, so the period is still billed.
// POST /api/tenancy/remove-user { userId }
// Owner-only. Offboards someone: they lose every set of books in Books,
// their seat is freed, and their history stays intact.
//
// This is the security-critical direction of the access grid. A grant
// that fails is a nuisance — someone cannot work. A revoke that fails
// means a person who has left still has the books, which is why this
// enqueues a 'disable' job (the provisioner strips every business from
// them) rather than only deleting rows here. Until that job reports
// done, the portal shows them as still being removed.
function removeUser(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const account = db.prepare('SELECT id FROM account WHERE id = ?').get(s.account_id);
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const target = db.prepare('SELECT id, account_id, email, role, status FROM users WHERE id = ?').get(input.userId);
  if (!target || target.account_id !== s.account_id) return { status: 403, json: { error: 'wrong_account' } };

  // Locking yourself out would leave the firm with no one who can manage
  // it, and no way back in from the portal.
  if (target.id === s.user_id) return { status: 409, json: { error: 'cannot_remove_self' } };
  if (target.role === 'owner') return { status: 409, json: { error: 'cannot_remove_owner' } };
  if (target.status === 'removed') return { status: 200, json: { ok: true, alreadyRemoved: true } };

  const held = db.prepare('SELECT COUNT(*) AS n FROM user_business WHERE user_id = ?').get(target.id).n;
  db.prepare('DELETE FROM user_business WHERE user_id = ?').run(target.id);
  // One job, not one per business: disableUser strips them all at once,
  // so a partially-applied offboard is not possible.
  db.prepare('INSERT INTO provision_job (type, user_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('disable', target.id, now, now);

  db.prepare("UPDATE users SET status = 'removed', removed_at = ?, initial_password = NULL WHERE id = ?")
    .run(new Date(now).toISOString(), target.id);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'remove_user', 'user:' + target.id + ' ' + target.email);

  return { status: 200, json: { ok: true, revoked: held } };
}

function archiveBusiness(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const account = db.prepare('SELECT id FROM account WHERE id = ?').get(s.account_id);
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const biz = db.prepare('SELECT id, account_id, status FROM businesses WHERE id = ?').get(input.businessId);
  if (!biz || biz.account_id !== s.account_id) return { status: 403, json: { error: 'wrong_account' } };
  if (biz.status === 'archived') return { status: 200, json: { ok: true, alreadyArchived: true } };

  // Revoke in Manager for everyone who had it, then drop the grants.
  const holders = db.prepare('SELECT user_id FROM user_business WHERE business_id = ?').all(biz.id);
  holders.forEach(function (h) {
    db.prepare('INSERT INTO provision_job (type, user_id, business_id, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('revoke', h.user_id, biz.id, now, now);
  });
  db.prepare('DELETE FROM user_business WHERE business_id = ?').run(biz.id);

  db.prepare("UPDATE businesses SET status = 'archived', archived_at = ? WHERE id = ?")
    .run(new Date(now).toISOString(), biz.id);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'archive_business', 'business:' + biz.id);
  return { status: 200, json: { ok: true, revoked: holders.length } };
}

// POST /api/tenancy/clear-password { userId }
// Owner-only. Called once the owner has copied the password. Discards our
// copy — the whole point is that we hold it as briefly as possible.
function clearInitialPassword(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, { id: s.account_id }, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const u = db.prepare('SELECT id, account_id FROM users WHERE id = ?').get(input.userId);
  if (!u || u.account_id !== s.account_id) return { status: 403, json: { error: 'wrong_account' } };

  db.prepare('UPDATE users SET initial_password = NULL, initial_password_at = NULL WHERE id = ?').run(u.id);
  return { status: 200, json: { ok: true } };
}

// POST /api/tenancy/reset-password { userId }
// Owner-only. Queues a fresh Manager password. Deliberately cheap to use:
// forgetting the handover password should cost a click, not a support
// request to us.
function resetPassword(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, { id: s.account_id }, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const u = db.prepare('SELECT id, account_id, email, manager_user_ref FROM users WHERE id = ?').get(input.userId);
  if (!u || u.account_id !== s.account_id) return { status: 403, json: { error: 'wrong_account' } };
  if (!u.manager_user_ref) return { status: 409, json: { error: 'not_provisioned_yet' } };

  db.prepare('INSERT INTO provision_job (type, user_id, created_at, updated_at) VALUES (?,?,?,?)')
    .run('reset_password', u.id, now, now);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'reset_password', 'user:' + u.id + ' ' + u.email);
  return { status: 200, json: { ok: true } };
}

// POST /api/tenancy/retry-job { jobId }
// Owner-only. Puts a failed provisioner job back in the queue.
//
// Exists because the alternative is what actually happened: a failed
// offboarding sat in the database for days and was eventually re-queued
// by hand with SQL on the live server. That is not a thing an owner can
// do, and it should not be a thing anyone has to do.
//
// Resets `attempts` as well as status — the three-attempt cap is there to
// stop a broken job spinning forever, not to make a fixed one
// unrunnable. Most failures here are transient or were fixed in the
// meantime (an expired Books session, a Manager upgrade), so a retry
// after the cause is addressed should get a clean run, not one last go.
function retryJob(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  const account = db.prepare('SELECT id FROM account WHERE id = ?').get(s.account_id);
  const authz = A.authorizeOwnerAction({ role: s.role, account_id: s.account_id, expires_at: s.expires_at }, account, now);
  if (!authz.ok) return { status: 403, json: { error: authz.reason } };

  const jobId = Number(input && input.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) return { status: 400, json: { error: 'jobId required' } };

  // Same ownership rule as the overview: through the user OR the business,
  // since a job need only carry one of them.
  const job = db.prepare(
    `SELECT j.id, j.type, j.status
       FROM provision_job j
       LEFT JOIN users u      ON u.id = j.user_id
       LEFT JOIN businesses b ON b.id = j.business_id
      WHERE j.id = ? AND (u.account_id = ? OR b.account_id = ?)`
  ).get(jobId, s.account_id, s.account_id);
  if (!job) return { status: 403, json: { error: 'wrong_account' } };

  // Only a failed job may be re-queued. Re-queuing one that is pending or
  // running would let it be claimed twice.
  if (job.status !== 'failed') return { status: 409, json: { error: 'job_not_failed' } };

  db.prepare("UPDATE provision_job SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?")
    .run(now, jobId);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(s.account_id, s.email, 'retry_job', job.type + ' job:' + jobId);

  return { status: 200, json: { ok: true, jobId: jobId, type: job.type } };
}

// GET /api/tenancy/overview
// The one read the portal renders, shaped by role. EVERY signed-in user
// gets a useful answer — previously this was owner-only, so staff and
// clients could sign in and were then turned away at the dashboard.
//
//   owner  — the firm: all businesses (incl. archived), the team, the
//            access grid, limits, and this month's billable count.
//   staff  — only businesses granted via user_business.
//   client — the single business they were invited for, read-only.
//
// Staff and clients get no `users` and no `grants`: who else works at the
// firm, and who else can see what, is none of their business.
function overview(db, input, deps) {
  const now = deps.now();
  const s = loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  if (!A.isSessionValid({ expires_at: s.expires_at }, now)) return { status: 401, json: { error: 'session_invalid' } };

  const account = db.prepare('SELECT firm_name, plan, status, seats_limit, businesses_limit FROM account WHERE id = ?').get(s.account_id);
  const me = { email: s.email, role: s.role, capabilities: A.ROLE_CAPABILITIES[s.role] || {} };

  // Sync state per business, so the portal can show pending/failed rather
  // than pretending an access change already reached Manager.
  const jobs = db.prepare(
    `SELECT user_id, business_id, type, status FROM provision_job
      WHERE status IN ('pending','running','failed') AND business_id IS NOT NULL
        AND user_id IN (SELECT id FROM users WHERE account_id = ?)`
  ).all(s.account_id);

  // Every failed job, whatever its shape — deliberately NOT the query
  // above.
  //
  // That one is for the access grid, so it requires BOTH a business_id
  // and a user_id. A failed `disable` has no business, and a failed
  // `create_business` has no user, so neither can ever appear in it. That
  // is not a detail: a failed offboarding is the highest-consequence
  // failure in the system — someone who left still holding client books —
  // and it was the single least visible thing here. One sat unnoticed in
  // the database until somebody happened to query the table by hand
  // (2026-07-21, job 49).
  //
  // Ownership is resolved through whichever of the two is present.
  const failures = db.prepare(
    `SELECT j.id, j.type, j.attempts, j.last_error, j.updated_at,
            u.email AS user_email, b.name AS business_name
       FROM provision_job j
       LEFT JOIN users u      ON u.id = j.user_id
       LEFT JOIN businesses b ON b.id = j.business_id
      WHERE j.status = 'failed' AND (u.account_id = ? OR b.account_id = ?)
      ORDER BY j.id DESC`
  ).all(s.account_id, s.account_id);

  // How much work is still in flight, of ANY shape. The `jobs` array
  // above cannot answer this: it needs both ids, so a queued `disable` or
  // `create_business` is invisible in it. The portal uses this to know
  // whether to keep watching — without it, retrying a failed offboard
  // would clear the banner and then never report what happened, which is
  // the same blind spot in a new place.
  const pending = db.prepare(
    `SELECT COUNT(*) AS n FROM provision_job j
       LEFT JOIN users u      ON u.id = j.user_id
       LEFT JOIN businesses b ON b.id = j.business_id
      WHERE j.status IN ('pending','running') AND (u.account_id = ? OR b.account_id = ?)`
  ).get(s.account_id, s.account_id).n;

  if (!A.can(s.role, 'allBusinesses')) {
    const businesses = db.prepare(
      `SELECT b.id, b.name, b.manager_business_name, b.status
         FROM businesses b JOIN user_business ub ON ub.business_id = b.id
        WHERE ub.user_id = ? AND b.status = 'active' ORDER BY b.name`
    ).all(s.user_id);
    // No `failures` for staff or clients: a stuck provisioner job is the
    // owner's to act on, and naming who else is mid-offboard is not
    // theirs to see. Present but empty, so the shape never varies.
    return { status: 200, json: { account: { firm_name: account.firm_name, status: account.status }, me: me, businesses: businesses, users: [], grants: [], jobs: [], failures: [], pending: 0 } };
  }

  // Initial Manager passwords, for the owner to hand over. Only ever sent
  // to the owner of that account, only while still visible, and cleared
  // as soon as they acknowledge it. Never emailed, never logged.
  const users = db.prepare(
    // Removed people are still listed, sorted below the active ones, so
    // an offboard is visible rather than a person silently vanishing.
    `SELECT id, email, role, status, removed_at, manager_user_ref, initial_password, initial_password_at
       FROM users WHERE account_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, role DESC, email`
  ).all(s.account_id).map(function (u) {
    const visible = u.initial_password && A.isInitialPasswordVisible(u.initial_password_at, now);
    return {
      id: u.id, email: u.email, role: u.role,
      status: u.status, removedAt: u.removed_at,
      initialPassword: visible ? u.initial_password : null,
      provisioned: !!u.manager_user_ref,
    };
  });
  const businesses = db.prepare(
    'SELECT id, name, manager_business_name, status FROM businesses WHERE account_id = ? ORDER BY status, name'
  ).all(s.account_id);
  const grants = db.prepare(
    'SELECT ub.user_id, ub.business_id FROM user_business ub JOIN users u ON u.id = ub.user_id WHERE u.account_id = ?'
  ).all(s.account_id);

  // Recent activity, owner-only. Capped: this is a "what happened lately"
  // panel, not an archive — the audit_log table remains the full record.
  const activity = db.prepare(
    'SELECT actor, action, target, at FROM audit_log WHERE account_id = ? ORDER BY id DESC LIMIT 50'
  ).all(s.account_id);

  return {
    status: 200,
    json: {
      account: account, me: me, users: users, businesses: businesses, grants: grants, jobs: jobs,
      failures: failures, pending: pending, activity: activity,
      billing: invoiceFor(db, s.account_id, A.billingPeriodKey(now)),
    },
  };
}

module.exports = {
  COOKIE_NAME, parseCookie, loadSession,
  requestLink, verifyLink, currentUser, signOut,
  setUserBusiness, inviteStaff, addBusiness, archiveBusiness, removeUser, clearInitialPassword, resetPassword, retryJob,
  recordBillingPeriod, billableCount, invoiceFor, grantDiscount, overview,
};

// ── HTTP wiring (thin; not unit-tested — handlers are) ────────────
if (require.main === module) {
  const http = require('node:http');
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const path = require('node:path');

  const dbPath = process.env.TXFORM_DB || path.join(__dirname, 'txform.db');
  const db = new DatabaseSync(dbPath);
  // CREATE TABLE IF NOT EXISTS creates missing tables but does nothing to
  // one that already exists — so a new column in schema.sql never reached
  // a live database, and the service came up healthy and then 500'd on
  // the first query touching it. migrate() closes that gap.
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  require('./migrate.js').migrate(db, schemaSql, console.log);

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

  const baseUrl = process.env.TXFORM_BASE_URL || 'https://txform.ph';
  const deps = {
    now: function () { return Date.now(); },
    baseUrl: baseUrl,
    // Canonical owner-portal URL the magic-link redirect lands on. Same
    // origin as the /api/* proxy (txform.ph apex) so account.js's cookie'd
    // calls reach the service. Defaults to <base>/account.
    portalUrl: process.env.TXFORM_PORTAL_URL || (baseUrl + '/account'),
    sendEmail: sendEmail,
  };

  // Thin responder. A handler result may carry either a JSON body or a
  // `location` (302 redirect); `setCookie` attaches to either.
  function send(res, out) {
    const headers = {};
    if (out.setCookie) headers['Set-Cookie'] = out.setCookie;
    if (out.location) {
      headers['Location'] = out.location;
      res.writeHead(out.status, headers);
      return res.end();
    }
    headers['Content-Type'] = 'application/json';
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
        if (url.pathname === '/api/auth/verify') return send(res, verifyLink(db, { token: url.searchParams.get('token'), accept: req.headers.accept }, deps));
        if (url.pathname === '/api/auth/me') return send(res, currentUser(db, { cookie: cookie }, deps));
        if (req.method === 'POST' && url.pathname === '/api/auth/sign-out') return send(res, signOut(db, { cookie: cookie }));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/user-business') return send(res, setUserBusiness(db, { cookie: cookie, userId: json.userId, businessId: json.businessId, grant: json.grant }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/invite-staff') return send(res, inviteStaff(db, { cookie: cookie, email: json.email, role: json.role, businessId: json.businessId }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/add-business') return send(res, addBusiness(db, { cookie: cookie, name: json.name }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/archive-business') return send(res, archiveBusiness(db, { cookie: cookie, businessId: json.businessId }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/remove-user') return send(res, removeUser(db, { cookie: cookie, userId: json.userId }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/clear-password') return send(res, clearInitialPassword(db, { cookie: cookie, userId: json.userId }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/reset-password') return send(res, resetPassword(db, { cookie: cookie, userId: json.userId }, deps));
        if (req.method === 'POST' && url.pathname === '/api/tenancy/retry-job') return send(res, retryJob(db, { cookie: cookie, jobId: json.jobId }, deps));
        if (req.method === 'GET' && url.pathname === '/api/tenancy/overview') return send(res, overview(db, { cookie: cookie }, deps));
        send(res, { status: 404, json: { error: 'not found' } });
      } catch (e) {
        console.error('[auth] handler error', e);
        send(res, { status: 500, json: { error: 'internal error' } });
      }
    });
  }).listen(process.env.PORT || 5100, function () { console.log('[auth] listening on', process.env.PORT || 5100); });
}
