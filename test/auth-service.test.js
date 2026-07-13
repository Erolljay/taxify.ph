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

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');

// Fresh DB seeded with two accounts so cross-tenant checks are real.
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO account (id, plan, status, seats_limit, businesses_limit) VALUES (?,?,?,?,?)')
    .run(1, 'firm', 'active', 5, 10);
  db.prepare('INSERT INTO account (id, plan, status, seats_limit, businesses_limit) VALUES (?,?,?,?,?)')
    .run(2, 'starter', 'active', 1, 1);
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (?,?,?,?)').run(1, 1, 'owner@x.com', 'owner');
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (?,?,?,?)').run(2, 1, 'staff@x.com', 'staff');
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (?,?,?,?)').run(3, 2, 'other@x.com', 'owner');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_guid, name) VALUES (?,?,?,?)').run(1, 1, 'guid-1', 'Acme');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_guid, name) VALUES (?,?,?,?)').run(2, 2, 'guid-2', 'OtherCo');
  return db;
}

// Deps with a movable clock and a capturing mailer.
function makeDeps() {
  const state = { now: Date.now(), sent: [] };
  return {
    state,
    now: function () { return state.now; },
    baseUrl: 'https://txform.ph',
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

test('early-access: valid email is stored and returns a generic ok', () => {
  const db = freshDb(), deps = makeDeps();
  const r = S.earlyAccess(db, { email: 'lead@firm.ph' }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const row = db.prepare('SELECT email, created_at FROM early_access WHERE email = ?').get('lead@firm.ph');
  assert.equal(row.email, 'lead@firm.ph');
  assert.equal(row.created_at, deps.state.now);
});

test('early-access: is idempotent per email (double submit = one row)', () => {
  const db = freshDb(), deps = makeDeps();
  assert.equal(S.earlyAccess(db, { email: 'Lead@Firm.PH' }, deps).status, 200);
  assert.equal(S.earlyAccess(db, { email: 'lead@firm.ph' }, deps).status, 200);
  const n = db.prepare('SELECT COUNT(*) AS n FROM early_access WHERE email = ?').get('lead@firm.ph').n;
  assert.equal(n, 1, 'case-normalized email stored once');
});

test('early-access: junk or missing email is rejected with 400', () => {
  const db = freshDb(), deps = makeDeps();
  assert.equal(S.earlyAccess(db, { email: 'not-an-email' }, deps).status, 400);
  assert.equal(S.earlyAccess(db, { email: '' }, deps).status, 400);
  assert.equal(S.earlyAccess(db, {}, deps).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM early_access').get().n, 0);
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
  const r = S.addBusiness(db, { cookie: cookie, managerBusinessGuid: 'guid-new', name: 'NewClient' }, deps);
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT account_id FROM businesses WHERE id=?').get(r.json.businessId).account_id, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='add_business'").get());
});

test('add-business: claiming a GUID owned by another account is refused', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com'); // account 1
  const r = S.addBusiness(db, { cookie: cookie, managerBusinessGuid: 'guid-2', name: 'Steal' }, deps); // guid-2 = account 2
  assert.equal(r.status, 409);
  assert.match(r.json.error, /another account/);
});

test('add-business: re-adding own business is idempotent', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');
  const r = S.addBusiness(db, { cookie: cookie, managerBusinessGuid: 'guid-1', name: 'Acme' }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.alreadyAdded, true);
});

test('add-business: business limit is enforced', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'other@x.com'); // account 2, businesses_limit 1, already has 1
  const r = S.addBusiness(db, { cookie: cookie, managerBusinessGuid: 'guid-extra', name: 'Extra' }, deps);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /business_limit_reached/);
});

test('add-business: staff cannot add', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'staff@x.com');
  assert.equal(S.addBusiness(db, { cookie: cookie, managerBusinessGuid: 'g', name: 'n' }, deps).status, 403);
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
  assert.equal(r.json.businesses.length, 1);     // Acme (guid-1)
  assert.equal(r.json.grants.length, 1);
  assert.equal(r.json.grants[0].user_id, 2);
  assert.equal(r.json.grants[0].business_id, 1);
});

test('overview: only the caller\'s account is visible (no cross-tenant leak)', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com'); // account 1
  const r = S.overview(db, { cookie: cookie }, deps);
  assert.ok(r.json.businesses.every((b) => b.manager_business_guid !== 'guid-2'), 'account 2 business absent');
  assert.ok(r.json.users.every((u) => u.email !== 'other@x.com'), 'account 2 user absent');
});

test('overview: staff and unauthenticated are denied', () => {
  const db = freshDb(), deps = makeDeps();
  assert.equal(S.overview(db, { cookie: signIn(db, deps, 'staff@x.com') }, deps).status, 403);
  assert.equal(S.overview(db, { cookie: '' }, deps).status, 401);
});
