/* ============================================================
   Integration tests for server/auth-service.js against a real
   in-memory node:sqlite DB (the schema from server/schema.sql).
   Injected clock + capturing email sender — no HTTP, no real mail.

     node --test test/auth-service.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const S = require('../server/auth-service.js');
const A = require('../server/auth-core.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');

// Fresh DB seeded with two accounts so cross-tenant checks are real.
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO account (id, firm_code, plan, status, seats_limit, businesses_limit) VALUES (?,?,?,?,?,?)')
    .run(1, 'FIRMA', 'firm', 'active', 5, 10);
  db.prepare('INSERT INTO account (id, firm_code, plan, status, seats_limit, businesses_limit) VALUES (?,?,?,?,?,?)')
    .run(2, 'FIRMB', 'starter', 'active', 1, 1);
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (?,?,?,?)').run(1, 1, 'owner@x.com', 'owner');
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (?,?,?,?)').run(2, 1, 'staff@x.com', 'staff');
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (?,?,?,?)').run(3, 2, 'other@x.com', 'owner');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (?,?,?,?,?)').run(1, 1, 'Acme', 'Acme', '2026-01-01T00:00:00Z');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (?,?,?,?,?)').run(2, 2, 'OtherCo', 'OtherCo', '2026-01-01T00:00:00Z');
  return db;
}

// Deps with a movable clock and a capturing mailer.
function makeDeps() {
  const state = { now: Date.now(), sent: [] };
  return {
    state,
    now: function () { return state.now; },
    baseUrl: 'https://txform.ph',
    portalUrl: 'https://txform.ph/account',
    sendEmail: function (m) { state.sent.push(m); },
  };
}

const tokenFromLink = (link) => new URL(link).searchParams.get('token');
const cookieHeader = (setCookie) => setCookie.split(';')[0]; // "txfsid=..."

// Drive request-link → verify and return the session Cookie header.
function signIn(db, deps, email) {
  const r1 = S.requestLink(db, { email: email }, deps);
  assert.equal(r1.status, 200);
  const link = deps.state.sent[deps.state.sent.length - 1].link;
  const r2 = S.verifyLink(db, { token: tokenFromLink(link) }, deps);
  assert.equal(r2.status, 200, 'verify should succeed');
  return cookieHeader(r2.setCookie);
}

test('request-link: known user sends a link; response is generic', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.requestLink(db, { email: 'owner@x.com' }, deps);
  assert.equal(r.status, 200);
  assert.match(r.json.message, /if that email/i);
  assert.equal(deps.state.sent.length, 1);
  assert.ok(tokenFromLink(deps.state.sent[0].link));
});

test('request-link: unknown email gets the SAME generic 200 and sends nothing (no enumeration)', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.requestLink(db, { email: 'nobody@x.com' }, deps);
  assert.equal(r.status, 200);
  assert.match(r.json.message, /if that email/i);
  assert.equal(deps.state.sent.length, 0);
});

test('request-link: email is case-insensitive', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'OWNER@X.COM' }, deps);
  assert.equal(deps.state.sent.length, 1);
});

test('full flow: sign in, then /me reflects the owner', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const me = S.currentUser(db, { cookie: cookie }, deps);
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { email: 'owner@x.com', role: 'owner', account_id: 1 });
});

test('verify: a token is single-use — replay is rejected', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  assert.equal(S.verifyLink(db, { token: token }, deps).status, 200);
  const replay = S.verifyLink(db, { token: token }, deps);
  assert.equal(replay.status, 400);
  assert.match(replay.json.error, /consumed/);
});

test('verify: an expired link is rejected', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  deps.state.now += 16 * 60 * 1000; // past the 15-min TTL
  const r = S.verifyLink(db, { token: token }, deps);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /expired/);
});

test('verify: a bogus token is rejected', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.verifyLink(db, { token: 'not-a-real-token' }, deps);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /missing/);
});

// ── verify: browser (magic-link click) redirects vs API JSON ──────
// A browser navigating to the emailed link sends `Accept: text/html`; it
// should land on the portal (302) with the session cookie still attached,
// not download a verify.json. API clients (Accept: application/json, or no
// Accept) keep the exact JSON contract.

test('verify (browser): success 302-redirects to the portal WITH the session cookie', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  const r = S.verifyLink(db, { token: token, accept: 'text/html,application/xhtml+xml,*/*' }, deps);
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://txform.ph/account');
  assert.ok(r.setCookie && r.setCookie.startsWith('txfsid='), 'session cookie set on the redirect');
  assert.equal(r.json, undefined, 'no JSON body on a browser redirect');
});

test('verify (API): success still returns 200 JSON + cookie when Accept is application/json', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  const r = S.verifyLink(db, { token: token, accept: 'application/json' }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.ok(r.setCookie && r.setCookie.startsWith('txfsid='));
  assert.equal(r.location, undefined);
});

test('verify (default, no Accept): success stays JSON — API-compatible default', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  const r = S.verifyLink(db, { token: token }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.location, undefined);
});

test('verify (browser): expired link 302-redirects to sign-in with ?error=link_expired and NO cookie', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  deps.state.now += 16 * 60 * 1000; // past the 15-min TTL
  const r = S.verifyLink(db, { token: token, accept: 'text/html' }, deps);
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://txform.ph/account?error=link_expired');
  assert.equal(r.setCookie, undefined, 'no session opened on a failed link');
});

test('verify (browser): replayed/consumed link 302-redirects with ?error=link_used', () => {
  const db = freshDb(), deps = makeDeps();
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  S.verifyLink(db, { token: token }, deps); // first use consumes it
  const r = S.verifyLink(db, { token: token, accept: 'text/html' }, deps);
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://txform.ph/account?error=link_used');
  assert.equal(r.setCookie, undefined);
});

test('verify (browser): bogus token 302-redirects with ?error=link_invalid', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.verifyLink(db, { token: 'not-a-real-token', accept: 'text/html' }, deps);
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://txform.ph/account?error=link_invalid');
  assert.equal(r.setCookie, undefined);
});

test('verify (browser): missing token 302-redirects with ?error=link_invalid', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.verifyLink(db, { accept: 'text/html' }, deps);
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://txform.ph/account?error=link_invalid');
});

test('verify (browser): portal URL falls back to baseUrl + /account when portalUrl is unset', () => {
  const db = freshDb(), deps = makeDeps();
  delete deps.portalUrl; // only baseUrl configured
  S.requestLink(db, { email: 'owner@x.com' }, deps);
  const token = tokenFromLink(deps.state.sent[0].link);
  const r = S.verifyLink(db, { token: token, accept: 'text/html' }, deps);
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://txform.ph/account');
});

test('request-link: rate limited after the cap within the window', () => {
  const db = freshDb(), deps = makeDeps();
  for (let i = 0; i < 5; i++) assert.equal(S.requestLink(db, { email: 'owner@x.com' }, deps).status, 200);
  const sixth = S.requestLink(db, { email: 'owner@x.com' }, deps);
  assert.equal(sixth.status, 429);
});

test('tenancy: owner can grant a staff member access to a client business', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const r = S.setUserBusiness(db, { cookie: cookie, userId: 2, businessId: 1, grant: true }, deps);
  assert.equal(r.status, 200);
  assert.ok(db.prepare('SELECT 1 FROM user_business WHERE user_id=2 AND business_id=1').get(), 'access row created');
  assert.equal(db.prepare("SELECT type FROM provision_job WHERE status='pending'").get().type, 'grant', 'job enqueued');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='grant_business'").get(), 'audit written');
});

test('tenancy: revoke removes access and enqueues a revoke job', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  S.setUserBusiness(db, { cookie: cookie, userId: 2, businessId: 1, grant: true }, deps);
  const r = S.setUserBusiness(db, { cookie: cookie, userId: 2, businessId: 1, grant: false }, deps);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM user_business WHERE user_id=2 AND business_id=1').get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM provision_job WHERE type='revoke'").get());
});

test('tenancy: staff (non-owner) is denied', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'staff@x.com');
  const r = S.setUserBusiness(db, { cookie: cookie, userId: 2, businessId: 1, grant: true }, deps);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /not_owner/);
});

test('tenancy: owner cannot touch ANOTHER account\'s business (cross-tenant)', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com'); // account 1
  const r = S.setUserBusiness(db, { cookie: cookie, userId: 2, businessId: 2, grant: true }, deps); // business 2 = account 2
  assert.equal(r.status, 403);
  assert.match(r.json.error, /wrong_account/);
});

test('tenancy: no session is rejected', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.setUserBusiness(db, { cookie: '', userId: 2, businessId: 1, grant: true }, deps);
  assert.equal(r.status, 401);
});

// ── invite-staff ─────────────────────────────────────────────────
test('invite-staff: owner adds a new member, consumes a seat, enqueues a create job', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const before = db.prepare('SELECT COUNT(*) AS n FROM users WHERE account_id=1').get().n;
  const r = S.inviteStaff(db, { cookie: cookie, email: 'New.Hire@X.com' }, deps);
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE account_id=1').get().n, before + 1);
  assert.equal(db.prepare('SELECT email FROM users WHERE id=?').get(r.json.userId).email, 'new.hire@x.com', 'email normalized');
  assert.ok(db.prepare("SELECT 1 FROM provision_job WHERE type='create' AND user_id=?").get(r.json.userId));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='invite_staff'").get());
});

test('invite-staff: re-inviting an existing member is idempotent, consumes no seat', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const before = db.prepare('SELECT COUNT(*) AS n FROM users WHERE account_id=1').get().n;
  const r = S.inviteStaff(db, { cookie: cookie, email: 'staff@x.com' }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.alreadyMember, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE account_id=1').get().n, before);
});

test('invite-staff: seat limit is enforced', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'other@x.com'); // account 2, seats_limit 1, already has 1 user
  const r = S.inviteStaff(db, { cookie: cookie, email: 'extra@x.com' }, deps);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /seat_limit_reached/);
});

test('invite-staff: staff cannot invite', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'staff@x.com');
  assert.equal(S.inviteStaff(db, { cookie: cookie, email: 'x@x.com' }, deps).status, 403);
});

// ── add-business ─────────────────────────────────────────────────
test('add-business: owner registers a new client business', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const r = S.addBusiness(db, { cookie: cookie, name: 'NewClient' }, deps);
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT account_id FROM businesses WHERE id=?').get(r.json.businessId).account_id, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='add_business'").get());
});

test('add-business: the Manager name is prefixed with the firm code', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com'); // account 1, code FIRMA
  const r = S.addBusiness(db, { cookie: cookie, name: 'Acme Trading' }, deps);
  const row = db.prepare('SELECT name, manager_business_name FROM businesses WHERE id=?').get(r.json.businessId);
  assert.equal(row.manager_business_name, 'FIRMA-Acme Trading');
  assert.equal(row.name, 'Acme Trading', 'the firm sees the name it chose');
});

test('add-business: two firms can register the same client name, with no signal to either', () => {
  const db = freshDb(), deps = makeDeps();
  // Account 2 ships with room for exactly one business and already has it —
  // give it headroom so this tests naming, not the seat cap.
  db.prepare('UPDATE account SET businesses_limit = 5 WHERE id = 2').run();
  const a = S.addBusiness(db, { cookie: signIn(db, deps, 'owner@x.com'), name: 'Shared Name Co' }, deps);
  const b = S.addBusiness(db, { cookie: signIn(db, deps, 'other@x.com'), name: 'Shared Name Co' }, deps);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201, 'the second firm is not blocked, and learns nothing');
  const names = db.prepare("SELECT manager_business_name FROM businesses WHERE name='Shared Name Co' ORDER BY id")
    .all().map((r) => r.manager_business_name);
  assert.deepEqual(names, ['FIRMA-Shared Name Co', 'FIRMB-Shared Name Co']);
});

test('add-business: the response never reveals the Manager-side name', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.addBusiness(db, { cookie: signIn(db, deps, 'owner@x.com'), name: 'Quiet Co' }, deps);
  assert.equal(r.json.managerBusinessName, undefined,
    'an internal detail — surfacing it would hint at what other firms hold');
});

test('add-business: a firm with no code cannot register anything', () => {
  const db = freshDb(), deps = makeDeps();
  db.prepare('UPDATE account SET firm_code = NULL WHERE id = 1').run();
  const r = S.addBusiness(db, { cookie: signIn(db, deps, 'owner@x.com'), name: 'Nameless Co' }, deps);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /firm_code_missing/);
});

test('add-business: queues a create_business job — the books do not exist yet', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.addBusiness(db, { cookie: signIn(db, deps, 'owner@x.com'), name: 'Fresh Co' }, deps);
  const job = db.prepare("SELECT type, business_id, user_id FROM provision_job WHERE type='create_business'").get();
  assert.equal(job.business_id, r.json.businessId);
  assert.equal(job.user_id, null, 'no user involved in creating books');
  assert.equal(
    db.prepare('SELECT manager_created_at FROM businesses WHERE id=?').get(r.json.businessId).manager_created_at,
    null, 'not created in Manager until the provisioner says so'
  );
});

test('add-business: re-adding own business is idempotent and costs no slot', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const before = db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE account_id=1').get().n;
  const r = S.addBusiness(db, { cookie: cookie, name: 'Acme' }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.alreadyAdded, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE account_id=1').get().n, before);
});

test('add-business: business limit is enforced', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'other@x.com'); // account 2, businesses_limit 1, already has 1
  const r = S.addBusiness(db, { cookie: cookie, name: 'Extra' }, deps);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /business_limit_reached/);
});

test('add-business: a blank name is rejected', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  assert.equal(S.addBusiness(db, { cookie: cookie, name: '   ' }, deps).status, 400);
});

test('add-business: staff cannot add', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'staff@x.com');
  assert.equal(S.addBusiness(db, { cookie: cookie, name: 'n' }, deps).status, 403);
});

// ── archive + high-water-mark billing ────────────────────────────
test('archive: revokes every grant and frees the slot, but still bills the month', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const add = S.addBusiness(db, { cookie: cookie, name: 'Leaving Co' }, deps);
  S.setUserBusiness(db, { cookie: cookie, userId: 2, businessId: add.json.businessId, grant: true }, deps);

  const r = S.archiveBusiness(db, { cookie: cookie, businessId: add.json.businessId }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.revoked, 1, 'the staff grant was revoked');

  const row = db.prepare('SELECT status, archived_at FROM businesses WHERE id = ?').get(add.json.businessId);
  assert.equal(row.status, 'archived');
  assert.ok(row.archived_at, 'archived_at stamped');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_business WHERE business_id = ?').get(add.json.businessId).n, 0);
  assert.ok(db.prepare("SELECT 1 FROM provision_job WHERE type='revoke' AND business_id = ?").get(add.json.businessId));

  // The whole point: archiving does NOT erase the period.
  const period = A.billingPeriodKey(deps.state.now);
  assert.equal(S.billableCount(db, 1, period), 1, 'still billed for the month it was active in');
});

test('archive: add-then-archive-then-add inside one month cannot dodge the bill', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const period = A.billingPeriodKey(deps.state.now);

  // The exploit shape: churn clients through a single billing month.
  ['A Co', 'B Co', 'C Co'].forEach((name) => {
    const a = S.addBusiness(db, { cookie: cookie, name: name }, deps);
    S.archiveBusiness(db, { cookie: cookie, businessId: a.json.businessId }, deps);
  });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE account_id=1 AND status='active'").get().n, 1,
    'only the seeded Acme is left active');
  assert.equal(S.billableCount(db, 1, period), 3, 'all three are still billed — high-water mark, not a snapshot');
});

test('archive: is idempotent and refuses another firm\'s business', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const a = S.addBusiness(db, { cookie: cookie, name: 'Once Co' }, deps);
  assert.equal(S.archiveBusiness(db, { cookie: cookie, businessId: a.json.businessId }, deps).status, 200);
  const again = S.archiveBusiness(db, { cookie: cookie, businessId: a.json.businessId }, deps);
  assert.equal(again.json.alreadyArchived, true);
  assert.equal(S.archiveBusiness(db, { cookie: cookie, businessId: 2 }, deps).status, 403, 'business 2 belongs to account 2');
});

test('archive: staff cannot archive', () => {
  const db = freshDb(), deps = makeDeps();
  assert.equal(S.archiveBusiness(db, { cookie: signIn(db, deps, 'staff@x.com'), businessId: 1 }, deps).status, 403);
});

test('add-business: re-adding an archived name reactivates it rather than duplicating', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const a = S.addBusiness(db, { cookie: cookie, name: 'Returning Co' }, deps);
  S.archiveBusiness(db, { cookie: cookie, businessId: a.json.businessId }, deps);

  const back = S.addBusiness(db, { cookie: cookie, name: 'Returning Co' }, deps);
  assert.equal(back.json.reactivated, true);
  assert.equal(back.json.businessId, a.json.businessId, 'same row — its filed snapshots come back with it');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE name='Returning Co'").get().n, 1);
});

test('add-business: an archived business does not consume the paid quantity', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'other@x.com'); // account 2: businesses_limit 1, already at 1
  assert.equal(S.addBusiness(db, { cookie: cookie, name: 'Blocked Co' }, deps).status, 409);
  S.archiveBusiness(db, { cookie: cookie, businessId: 2 }, deps);
  assert.equal(S.addBusiness(db, { cookie: cookie, name: 'Now Fits Co' }, deps).status, 201, 'slot freed by archiving');
});

// ── invite: roles ────────────────────────────────────────────────
test('invite: a client must be scoped to one of the firm\'s own businesses', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  assert.equal(S.inviteStaff(db, { cookie: cookie, email: 'c@x.com', role: 'client' }, deps).status, 400,
    'no businessId');
  assert.equal(S.inviteStaff(db, { cookie: cookie, email: 'c@x.com', role: 'client', businessId: 2 }, deps).status, 400,
    'business 2 belongs to account 2');
});

test('invite: a client is granted their business immediately and consumes no seat', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const before = db.prepare("SELECT COUNT(*) AS n FROM users WHERE account_id=1 AND role IN ('owner','staff')").get().n;
  const r = S.inviteStaff(db, { cookie: cookie, email: 'c@acme.ph', role: 'client', businessId: 1 }, deps);
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_business WHERE user_id = ?').get(r.json.userId).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE account_id=1 AND role IN ('owner','staff')").get().n, before,
    'clients are free — seat count unchanged');
});

test('invite: cannot smuggle in a second owner via the role field', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const r = S.inviteStaff(db, { cookie: cookie, email: 'sneaky@x.com', role: 'owner' }, deps);
  assert.equal(r.json.role, 'staff', 'anything that is not "client" falls back to staff');
});

// ── overview (portal read) ───────────────────────────────────────
test('overview: owner sees account, staff, businesses, and grants', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  S.setUserBusiness(db, { cookie: cookie, userId: 2, businessId: 1, grant: true }, deps);
  const r = S.overview(db, { cookie: cookie }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.account.businesses_limit, 10);
  assert.equal(r.json.me.email, 'owner@x.com');
  assert.equal(r.json.users.length, 2);          // owner + staff
  assert.equal(r.json.businesses.length, 1);     // Acme
  assert.equal(r.json.grants.length, 1);
  assert.equal(r.json.grants[0].user_id, 2);
  assert.equal(r.json.grants[0].business_id, 1);
});

test('overview: only the caller\'s account is visible (no cross-tenant leak)', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com'); // account 1
  const r = S.overview(db, { cookie: cookie }, deps);
  assert.ok(r.json.businesses.every((b) => b.manager_business_name !== 'OtherCo'), 'account 2 business absent');
  assert.ok(r.json.users.every((u) => u.email !== 'other@x.com'), 'account 2 user absent');
});

test('overview: unauthenticated is denied', () => {
  const db = freshDb(), deps = makeDeps();
  assert.equal(S.overview(db, { cookie: '' }, deps).status, 401);
});

test('overview: staff get in, but see ONLY their granted businesses', () => {
  const db = freshDb(), deps = makeDeps();
  const owner = signIn(db, deps, 'owner@x.com');
  S.addBusiness(db, { cookie: owner, name: 'Ungranted Co' }, deps);
  S.setUserBusiness(db, { cookie: owner, userId: 2, businessId: 1, grant: true }, deps); // staff -> Acme only

  const r = S.overview(db, { cookie: signIn(db, deps, 'staff@x.com') }, deps);
  assert.equal(r.status, 200, 'staff are no longer turned away at the dashboard');
  assert.deepEqual(r.json.businesses.map((b) => b.name), ['Acme']);
  assert.equal(r.json.me.capabilities.file, true);
  assert.equal(r.json.me.capabilities.manageFirm, false);
});

test('overview: staff never learn who else works at the firm', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.overview(db, { cookie: signIn(db, deps, 'staff@x.com') }, deps);
  assert.deepEqual(r.json.users, [], 'no team roster');
  assert.deepEqual(r.json.grants, [], 'no access grid');
  assert.equal(r.json.billing, undefined, 'no billing figures');
  assert.equal(r.json.account.seats_limit, undefined, 'no plan limits');
});

test('overview: a client sees only their own business, read-only', () => {
  const db = freshDb(), deps = makeDeps();
  const owner = signIn(db, deps, 'owner@x.com');
  const inv = S.inviteStaff(db, { cookie: owner, email: 'client@acme.ph', role: 'client', businessId: 1 }, deps);
  assert.equal(inv.status, 201);
  assert.equal(inv.json.role, 'client');

  const r = S.overview(db, { cookie: signIn(db, deps, 'client@acme.ph') }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.businesses.map((b) => b.name), ['Acme']);
  assert.equal(r.json.me.capabilities.file, false, 'clients cannot file');
  assert.equal(r.json.me.capabilities.amendFiling, false);
});

test('overview: owner sees this month\'s invoice', () => {
  const db = freshDb(), deps = makeDeps();
  const owner = signIn(db, deps, 'owner@x.com');
  S.addBusiness(db, { cookie: owner, name: 'Second Co' }, deps);
  const r = S.overview(db, { cookie: owner }, deps);
  assert.equal(r.json.billing.periodKey, A.billingPeriodKey(deps.state.now));
  // Acme is seeded directly (no billing row); only the added one is billable.
  assert.equal(r.json.billing.businesses, 1);
  assert.equal(r.json.billing.net, A.RATE_CENTAVOS, 'no voucher — full rate');
  assert.equal(r.json.billing.reason, null);
});

// ── initial password handover ────────────────────────────────────
// The rule these defend: the password is shown to ONE person, once, and
// never travels by email.
function withPassword(db, userId, pw, at) {
  db.prepare('UPDATE users SET manager_user_ref = ?, initial_password = ?, initial_password_at = ? WHERE id = ?')
    .run('mgr:' + userId, pw, at, userId);
}

test('password handover: the owner sees a freshly issued password', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'Abcde-Fghij-Klmno-Pqrst', deps.state.now);
  const r = S.overview(db, { cookie: signIn(db, deps, 'owner@x.com') }, deps);
  const staff = r.json.users.find((u) => u.id === 2);
  assert.equal(staff.initialPassword, 'Abcde-Fghij-Klmno-Pqrst');
});

test('password handover: staff never see any password, including their own', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'secret-pw', deps.state.now);
  const r = S.overview(db, { cookie: signIn(db, deps, 'staff@x.com') }, deps);
  assert.deepEqual(r.json.users, [], 'staff get no roster at all, so no passwords ride along');
  assert.equal(JSON.stringify(r.json).indexOf('secret-pw'), -1, 'and it appears nowhere in the payload');
});

test('password handover: another firm\'s owner cannot see it', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'secret-pw', deps.state.now);   // account 1's staff
  const r = S.overview(db, { cookie: signIn(db, deps, 'other@x.com') }, deps); // account 2
  assert.equal(JSON.stringify(r.json).indexOf('secret-pw'), -1);
});

test('password handover: an uncollected password stops being shown after 24h', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'stale-pw', deps.state.now - A.INITIAL_PASSWORD_TTL_MS - 1000);
  const r = S.overview(db, { cookie: signIn(db, deps, 'owner@x.com') }, deps);
  assert.equal(r.json.users.find((u) => u.id === 2).initialPassword, null);
});

test('clear-password: discards our copy once the owner has it', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'secret-pw', deps.state.now);
  const cookie = signIn(db, deps, 'owner@x.com');
  assert.equal(S.clearInitialPassword(db, { cookie, userId: 2 }, deps).status, 200);
  const row = db.prepare('SELECT initial_password, initial_password_at FROM users WHERE id=2').get();
  assert.equal(row.initial_password, null);
  assert.equal(row.initial_password_at, null);
});

test('clear-password: staff cannot, and neither can another firm', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'secret-pw', deps.state.now);
  assert.equal(S.clearInitialPassword(db, { cookie: signIn(db, deps, 'staff@x.com'), userId: 2 }, deps).status, 403);
  assert.equal(S.clearInitialPassword(db, { cookie: signIn(db, deps, 'other@x.com'), userId: 2 }, deps).status, 403);
  assert.ok(db.prepare('SELECT initial_password FROM users WHERE id=2').get().initial_password, 'untouched');
});

test('reset-password: queues a job and audits who asked', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'old-pw', deps.state.now);
  const r = S.resetPassword(db, { cookie: signIn(db, deps, 'owner@x.com'), userId: 2 }, deps);
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT user_id FROM provision_job WHERE type='reset_password'").get().user_id, 2);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='reset_password'").get());
});

test('reset-password: refused before the Manager user exists', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.resetPassword(db, { cookie: signIn(db, deps, 'owner@x.com'), userId: 2 }, deps);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not_provisioned_yet/);
});

test('reset-password: staff cannot reset anyone, including themselves', () => {
  const db = freshDb(), deps = makeDeps();
  withPassword(db, 2, 'old-pw', deps.state.now);
  assert.equal(S.resetPassword(db, { cookie: signIn(db, deps, 'staff@x.com'), userId: 2 }, deps).status, 403);
});
