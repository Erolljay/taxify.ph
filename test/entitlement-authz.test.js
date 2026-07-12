/* ============================================================
   Verifies the session + account-scoping AUTHORIZATION MODEL that
   server/entitlement.php enforces (Phase 1.3, closing review #3).

   entitlement.php is PHP and can't run on this machine, so we test the
   exact query semantics it uses against the real schema and REAL
   sessions minted by the Node auth service. The two query helpers below
   MIRROR entitlement.php's two steps — keep them in sync with that file.

     node --test test/entitlement-authz.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const S = require('../server/auth-service.js');
const A = require('../server/auth-core.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO account (id, plan, status, seats_limit, businesses_limit) VALUES (1,?,?,?,?)').run('firm', 'active', 5, 10);
  db.prepare('INSERT INTO account (id, plan, status, seats_limit, businesses_limit) VALUES (2,?,?,?,?)').run('starter', 'suspended', 1, 1);
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (1,1,?,?)').run('owner@x.com', 'owner');
  db.prepare('INSERT INTO users (id, account_id, email, role) VALUES (2,1,?,?)').run('staff@x.com', 'staff');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_guid, name) VALUES (1,1,?,?)').run('guid-1', 'Acme');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_guid, name) VALUES (2,2,?,?)').run('guid-2', 'OtherCo');
  return db;
}
function makeDeps() {
  const state = { now: Date.now(), sent: [] };
  return { state, now: () => state.now, baseUrl: 'https://txform.ph', sendEmail: (m) => state.sent.push(m) };
}
// --- mirrors of entitlement.php's two queries (keep in sync) ---------
function findSession(db, sessHash, now) {
  return db.prepare(
    `SELECT u.id AS user_id, u.account_id, u.role
       FROM session s JOIN users u ON u.id = s.user_id
      WHERE s.session_hash = ? AND s.expires_at > ? LIMIT 1`
  ).get(sessHash, now);
}
function findStatus(db, who, guid) {
  return db.prepare(
    `SELECT a.status FROM businesses b JOIN account a ON a.id = b.account_id
      WHERE b.manager_business_guid = ? AND b.account_id = ?
        AND ( ? = 'owner' OR EXISTS (SELECT 1 FROM user_business ub
              WHERE ub.user_id = ? AND ub.business_id = b.id) ) LIMIT 1`
  ).get(guid, who.account_id, who.role, who.user_id);
}

// Sign in and return the raw session secret (what the cookie carries).
function sessionSecret(db, deps, email) {
  S.requestLink(db, { email }, deps);
  const token = new URL(deps.state.sent.at(-1).link).searchParams.get('token');
  const out = S.verifyLink(db, { token }, deps);
  return S.parseCookie(out.setCookie, 'txfsid');
}

test('owner: own business returns its account status', () => {
  const db = freshDb(), deps = makeDeps();
  const hash = A.hashToken(sessionSecret(db, deps, 'owner@x.com'));
  const who = findSession(db, hash, deps.state.now);
  assert.ok(who, 'valid session resolves');
  assert.equal(findStatus(db, who, 'guid-1').status, 'active');
});

test('owner: another account\'s business is invisible (would be 404)', () => {
  const db = freshDb(), deps = makeDeps();
  const who = findSession(db, A.hashToken(sessionSecret(db, deps, 'owner@x.com')), deps.state.now);
  assert.equal(findStatus(db, who, 'guid-2'), undefined, 'cross-account business must not resolve');
});

test('no / bogus session → nothing (would be 401)', () => {
  const db = freshDb();
  assert.equal(findSession(db, A.hashToken('not-a-session'), Date.now()), undefined);
});

test('expired session → nothing (would be 401)', () => {
  const db = freshDb(), deps = makeDeps();
  const hash = A.hashToken(sessionSecret(db, deps, 'owner@x.com'));
  const later = deps.state.now + 15 * 24 * 60 * 60 * 1000; // past the 14-day TTL
  assert.equal(findSession(db, hash, later), undefined);
});

test('staff WITHOUT a grant cannot see the business (would be 404)', () => {
  const db = freshDb(), deps = makeDeps();
  const who = findSession(db, A.hashToken(sessionSecret(db, deps, 'staff@x.com')), deps.state.now);
  assert.equal(findStatus(db, who, 'guid-1'), undefined);
});

test('staff WITH a grant can see the business', () => {
  const db = freshDb(), deps = makeDeps();
  db.prepare('INSERT INTO user_business (user_id, business_id) VALUES (2,1)').run();
  const who = findSession(db, A.hashToken(sessionSecret(db, deps, 'staff@x.com')), deps.state.now);
  assert.equal(findStatus(db, who, 'guid-1').status, 'active');
});
