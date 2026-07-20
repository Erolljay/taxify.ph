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
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (?,?,?,?)').run(1, 1, 'Acme', 'Acme');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (?,?,?,?)').run(2, 2, 'OtherCo', 'OtherCo');
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
  assert.equal(r.json.managerBusinessName, 'NewClient');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='add_business'").get());
});

test('add-business: a name another firm already uses is accepted with a scoped Manager name', () => {
  const db = freshDb(), deps = makeDeps();
  const cookie = signIn(db, deps, 'owner@x.com');        // account 1
  const r = S.addBusiness(db, { cookie: cookie, name: 'OtherCo' }, deps); // account 2 holds 'OtherCo'
  assert.equal(r.status, 201, 'must not leak that another account holds the name');
  assert.equal(r.json.managerBusinessName, 'OtherCo (1)', 'Manager-side name is account-scoped');
  const row = db.prepare('SELECT name, manager_business_name FROM businesses WHERE id=?').get(r.json.businessId);
  assert.equal(row.name, 'OtherCo', 'the firm still sees its own chosen name');
});

test('add-business: the scoped fallback is deterministic, not a collision counter', () => {
  const db = freshDb(), deps = makeDeps();
  // Two separate firms colliding on the same name must each derive their own
  // suffix from their account id — never an incrementing count that would
  // reveal how many other firms hold it.
  assert.equal(S.managerNameFor(db, 1, 'OtherCo'), 'OtherCo (1)');
  assert.equal(S.managerNameFor(db, 7, 'OtherCo'), 'OtherCo (7)');
});

test('add-business: an unused name is taken verbatim', () => {
  const db = freshDb(), deps = makeDeps();
  assert.equal(S.managerNameFor(db, 1, 'Brand New Co'), 'Brand New Co');
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

test('overview: staff and unauthenticated are denied', () => {
  const db = freshDb(), deps = makeDeps();
  assert.equal(S.overview(db, { cookie: signIn(db, deps, 'staff@x.com') }, deps).status, 403);
  assert.equal(S.overview(db, { cookie: '' }, deps).status, 401);
});
