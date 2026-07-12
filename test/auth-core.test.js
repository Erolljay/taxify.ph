/* ============================================================
   Tests for server/auth-core.js — the pure auth + tenancy-write
   decision logic (magic-link token lifecycle, sessions, rate limit,
   plan-limit checks, owner authorization). Server-side only.

     node --test test/auth-core.test.js

   These rules gate who can sign in and who can grant access to which
   client's books — the security core of tenancy. Kept pure so the HTTP
   glue (whatever runtime it lands on) stays thin and these decisions
   are covered by tests.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../server/auth-core.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ── token hashing: never store the raw token, only its hash ────────
test('hashToken is deterministic and hex', () => {
  assert.equal(A.hashToken('abc'), A.hashToken('abc'));
  assert.match(A.hashToken('abc'), /^[0-9a-f]{64}$/);
});

test('hashToken differs for different input', () => {
  assert.notEqual(A.hashToken('abc'), A.hashToken('abd'));
});

test('generateToken returns a long, url-safe, unique secret', () => {
  const a = A.generateToken(), b = A.generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url: safe in a link, no padding
});

// ── login token lifecycle: single-use + 15-min expiry ─────────────
test('isLoginTokenUsable: fresh, unconsumed token is usable', () => {
  const now = Date.now();
  assert.deepEqual(
    A.isLoginTokenUsable({ expires_at: now + 5 * MIN, consumed_at: null }, now),
    { usable: true, reason: 'ok' }
  );
});

test('isLoginTokenUsable: expired token is rejected', () => {
  const now = Date.now();
  const r = A.isLoginTokenUsable({ expires_at: now - 1, consumed_at: null }, now);
  assert.equal(r.usable, false);
  assert.equal(r.reason, 'expired');
});

test('isLoginTokenUsable: already-consumed token is rejected (single use)', () => {
  const now = Date.now();
  const r = A.isLoginTokenUsable({ expires_at: now + 5 * MIN, consumed_at: now - MIN }, now);
  assert.equal(r.usable, false);
  assert.equal(r.reason, 'consumed');
});

test('isLoginTokenUsable: missing token is rejected', () => {
  assert.equal(A.isLoginTokenUsable(null, Date.now()).reason, 'missing');
});

// ── rate limit on the link-request endpoint ───────────────────────
test('withinRateLimit: under the cap is allowed', () => {
  const now = Date.now();
  const recent = [now - 10 * MIN, now - 5 * MIN]; // 2 in the last hour
  assert.equal(A.withinRateLimit(recent, now, { windowMs: HOUR, max: 5 }), true);
});

test('withinRateLimit: at the cap is blocked', () => {
  const now = Date.now();
  const recent = [now - MIN, now - 2 * MIN, now - 3 * MIN, now - 4 * MIN, now - 5 * MIN];
  assert.equal(A.withinRateLimit(recent, now, { windowMs: HOUR, max: 5 }), false);
});

test('withinRateLimit: old requests outside the window do not count', () => {
  const now = Date.now();
  const recent = [now - 2 * HOUR, now - 90 * MIN]; // both older than 1h
  assert.equal(A.withinRateLimit(recent, now, { windowMs: HOUR, max: 1 }), true);
});

// ── plan limits: seats and client businesses ──────────────────────
test('canProvisionMore: below the limit is allowed', () => {
  assert.deepEqual(A.canProvisionMore('seat', { limit: 3, currentCount: 2 }), { ok: true });
});

test('canProvisionMore: at the limit is blocked with a typed reason', () => {
  assert.deepEqual(
    A.canProvisionMore('business', { limit: 10, currentCount: 10 }),
    { ok: false, reason: 'business_limit_reached' }
  );
});

// ── session validity ──────────────────────────────────────────────
test('isSessionValid: unexpired session is valid', () => {
  const now = Date.now();
  assert.equal(A.isSessionValid({ expires_at: now + HOUR }, now), true);
});

test('isSessionValid: expired or missing session is invalid', () => {
  const now = Date.now();
  assert.equal(A.isSessionValid({ expires_at: now - 1 }, now), false);
  assert.equal(A.isSessionValid(null, now), false);
});

// ── owner authorization for tenancy writes ────────────────────────
test('authorizeOwnerAction: valid owner on own account is allowed', () => {
  const now = Date.now();
  const session = { role: 'owner', account_id: 7, expires_at: now + HOUR };
  assert.deepEqual(A.authorizeOwnerAction(session, { id: 7 }, now), { ok: true });
});

test('authorizeOwnerAction: staff is denied (not owner)', () => {
  const now = Date.now();
  const session = { role: 'staff', account_id: 7, expires_at: now + HOUR };
  assert.equal(A.authorizeOwnerAction(session, { id: 7 }, now).reason, 'not_owner');
});

test('authorizeOwnerAction: owner acting on a DIFFERENT account is denied (cross-tenant)', () => {
  const now = Date.now();
  const session = { role: 'owner', account_id: 7, expires_at: now + HOUR };
  assert.equal(A.authorizeOwnerAction(session, { id: 8 }, now).reason, 'wrong_account');
});

test('authorizeOwnerAction: expired session is denied before role/account checks', () => {
  const now = Date.now();
  const session = { role: 'owner', account_id: 7, expires_at: now - 1 };
  assert.equal(A.authorizeOwnerAction(session, { id: 7 }, now).reason, 'session_invalid');
});
