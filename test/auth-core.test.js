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

// ── role capabilities ────────────────────────────────────────────
test('can: only the owner may amend a filing that is already frozen', () => {
  assert.equal(A.can('owner', 'amendFiling'), true);
  assert.equal(A.can('staff', 'amendFiling'), false);
  assert.equal(A.can('client', 'amendFiling'), false);
});

test('can: staff may file, clients may not', () => {
  assert.equal(A.can('staff', 'file'), true);
  assert.equal(A.can('client', 'file'), false);
});

test('can: only the owner sees every business without a grant', () => {
  assert.equal(A.can('owner', 'allBusinesses'), true);
  assert.equal(A.can('staff', 'allBusinesses'), false);
  assert.equal(A.can('client', 'allBusinesses'), false);
});

test('can: an unknown role or capability fails CLOSED', () => {
  assert.equal(A.can('superuser', 'manageFirm'), false);
  assert.equal(A.can(undefined, 'file'), false);
  assert.equal(A.can('owner', 'launchMissiles'), false);
});

test('consumesSeat: clients are free, owner and staff are not', () => {
  assert.equal(A.consumesSeat('owner'), true);
  assert.equal(A.consumesSeat('staff'), true);
  assert.equal(A.consumesSeat('client'), false);
});

// ── billing period key ───────────────────────────────────────────
test('billingPeriodKey: YYYY-MM, zero-padded', () => {
  assert.equal(A.billingPeriodKey(Date.UTC(2026, 0, 15)), '2026-01');
  assert.equal(A.billingPeriodKey(Date.UTC(2026, 11, 1)), '2026-12');
});

test('billingPeriodKey: every instant in a month maps to the same key', () => {
  const first = A.billingPeriodKey(Date.UTC(2026, 6, 1, 0, 0, 0));
  const last  = A.billingPeriodKey(Date.UTC(2026, 6, 31, 23, 59, 59));
  assert.equal(first, last);
  assert.equal(first, '2026-07');
});

test('billingPeriodKey: a month boundary starts a new billing period', () => {
  assert.notEqual(
    A.billingPeriodKey(Date.UTC(2026, 6, 31, 23, 59, 59)),
    A.billingPeriodKey(Date.UTC(2026, 7, 1, 0, 0, 0))
  );
});

// ── pricing + vouchers ───────────────────────────────────────────
test('computeInvoice: flat rate per business, in centavos', () => {
  const r = A.computeInvoice(3, 0);
  assert.equal(r.gross, 3 * A.RATE_CENTAVOS);
  assert.equal(r.net, 3 * A.RATE_CENTAVOS);
  assert.equal(r.discount, 0);
});

test('computeInvoice: a 100% voucher zeroes the net but keeps the gross visible', () => {
  const r = A.computeInvoice(4, 100);
  assert.equal(r.gross, 4 * A.RATE_CENTAVOS, 'what it would have cost is still recorded');
  assert.equal(r.net, 0);
});

test('computeInvoice: discount and net always sum back to gross', () => {
  [0, 1, 7, 33, 50, 99, 100].forEach((pct) => {
    [0, 1, 3, 17].forEach((n) => {
      const r = A.computeInvoice(n, pct);
      assert.equal(r.discount + r.net, r.gross, n + ' businesses at ' + pct + '%');
    });
  });
});

test('computeInvoice: nonsense input cannot produce a negative charge', () => {
  assert.equal(A.computeInvoice(-5, 0).net, 0);
  assert.equal(A.computeInvoice(2, 999).net, 0, 'over-100% is clamped, not inverted');
  assert.equal(A.computeInvoice(2, -50).net, 2 * A.RATE_CENTAVOS);
});

test('discountPercentFor: applies only inside its own period window', () => {
  const d = [{ percent_off: 100, starts_period: '2026-07', ends_period: '2026-09' }];
  assert.equal(A.discountPercentFor(d, '2026-06'), 0, 'before it starts');
  assert.equal(A.discountPercentFor(d, '2026-07'), 100, 'first month, inclusive');
  assert.equal(A.discountPercentFor(d, '2026-09'), 100, 'last month, inclusive');
  assert.equal(A.discountPercentFor(d, '2026-10'), 0, 'after it ends');
});

test('discountPercentFor: an open-ended voucher never expires', () => {
  const d = [{ percent_off: 100, starts_period: '2026-01', ends_period: null }];
  assert.equal(A.discountPercentFor(d, '2031-12'), 100);
});

test('discountPercentFor: overlapping vouchers take the best one, never stack', () => {
  const d = [
    { percent_off: 20, starts_period: '2026-01', ends_period: null },
    { percent_off: 50, starts_period: '2026-01', ends_period: null },
  ];
  assert.equal(A.discountPercentFor(d, '2026-07'), 50, '50 — not 70');
});

test('discountPercentFor: no vouchers means full price', () => {
  assert.equal(A.discountPercentFor([], '2026-07'), 0);
  assert.equal(A.discountPercentFor(undefined, '2026-07'), 0);
});

// ── firm-code business naming ────────────────────────────────────
test('managerBusinessName: prefixes the firm code', () => {
  assert.equal(A.managerBusinessName('TALLO', '0001 Acme Trading'), 'TALLO-0001 Acme Trading');
});

test('managerBusinessName: two firms can hold the same client name', () => {
  // The whole point of the prefix: no collision, and so no way for one
  // firm to discover that another already uses a name.
  assert.notEqual(
    A.managerBusinessName('TALLO', 'Acme Trading'),
    A.managerBusinessName('RCRUZ', 'Acme Trading')
  );
});

test('managerBusinessName: is pure — no database, no dependence on other firms', () => {
  assert.equal(A.managerBusinessName('TALLO', 'Acme'), A.managerBusinessName('TALLO', 'Acme'));
});

test('managerBusinessName: normalizes the code and trims the name', () => {
  assert.equal(A.managerBusinessName('tallo', '  Acme  '), 'TALLO-Acme');
});

test('managerBusinessName: refuses to guess when either part is missing', () => {
  assert.equal(A.managerBusinessName('', 'Acme'), null);
  assert.equal(A.managerBusinessName('TALLO', '   '), null);
});

test('normalizeFirmCode: uppercases, strips punctuation, caps length', () => {
  assert.equal(A.normalizeFirmCode('tallo-cpa'), 'TALLOCPA');
  assert.equal(A.normalizeFirmCode('a b c'), 'ABC');
  assert.equal(A.normalizeFirmCode('X'.repeat(40)).length, 12);
});

test('isValidFirmCode: rejects codes that would be silently rewritten', () => {
  assert.equal(A.isValidFirmCode('TALLO'), true);
  assert.equal(A.isValidFirmCode('T'), false, 'too short');
  assert.equal(A.isValidFirmCode('TALLO CPA'), false, 'a space would be stripped — make them fix it');
  assert.equal(A.isValidFirmCode(''), false);
});
