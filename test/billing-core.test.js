/* ============================================================
   Tests for server/billing-core.js — the pure sign-up + checkout rules.

     node --test test/billing-core.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../server/billing-core.js');
const A = require('../server/auth-core.js');

// ── sign-up validation ───────────────────────────────────────────
test('validateSignup: accepts a well-formed sign-up and normalises it', () => {
  const r = B.validateSignup({ firmName: '  Tallo CPA  ', email: 'Owner@Tallo.PH', firmCode: 'tallo', businesses: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { firmName: 'Tallo CPA', email: 'owner@tallo.ph', firmCode: 'tallo', businesses: 5 });
});

test('validateSignup: reports each bad field on its own key', () => {
  const r = B.validateSignup({ firmName: '', email: 'nope', firmCode: 'T', businesses: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.firmName, 'name');
  assert.ok(r.errors.email, 'email');
  assert.ok(r.errors.firmCode, 'code too short');
  assert.ok(r.errors.businesses, 'must be >= 1');
});

test('validateSignup: rejects a code that normalising would silently rewrite', () => {
  // Same discipline as create-firm: validate the RAW input, so "TALLO CPA"
  // is refused rather than quietly becoming TALLOCPA.
  assert.equal(B.validateSignup({ firmName: 'F', email: 'a@b.ph', firmCode: 'TALLO CPA', businesses: 1 }).ok, false);
});

test('validateSignup: a non-integer or over-cap quantity is refused', () => {
  assert.ok(B.validateSignup({ firmName: 'F', email: 'a@b.ph', firmCode: 'AB', businesses: 2.5 }).errors.businesses);
  assert.ok(B.validateSignup({ firmName: 'F', email: 'a@b.ph', firmCode: 'AB', businesses: 9999 }).errors.businesses);
  assert.equal(B.validateSignup({ firmName: 'F', email: 'a@b.ph', firmCode: 'AB', businesses: B.MAX_SIGNUP_BUSINESSES }).ok, true);
});

// ── activation charge ────────────────────────────────────────────
test('activationAmountCentavos: quantity × the flat rate, in centavos', () => {
  assert.equal(B.activationAmountCentavos(1), A.RATE_CENTAVOS);
  assert.equal(B.activationAmountCentavos(5), 5 * A.RATE_CENTAVOS);
  assert.equal(B.activationAmountCentavos(0), 0);
});

test('amountPesos: converts exact centavos to whole pesos for Xendit', () => {
  assert.equal(B.amountPesos(50000), 500);
  assert.equal(B.amountPesos(5 * A.RATE_CENTAVOS), 2500);
});

test('amountPesos: refuses a fractional-peso amount rather than shipping it', () => {
  assert.throws(() => B.amountPesos(50050), /whole number of pesos/);
});

// ── idempotency key ──────────────────────────────────────────────
test('externalId: is deterministic in account, period and kind', () => {
  assert.equal(B.externalId(42, '2026-07', 'activation'), 'txf-activation-42-2026-07');
  assert.equal(B.externalId(42, '2026-07', 'activation'), B.externalId(42, '2026-07', 'activation'),
    'a reloaded pay page or a retried create must map to the SAME invoice');
  assert.notEqual(B.externalId(42, '2026-07', 'activation'), B.externalId(42, '2026-08', 'activation'));
  assert.notEqual(B.externalId(42, '2026-07', 'activation'), B.externalId(43, '2026-07', 'activation'));
});

// ── webhook authentication ───────────────────────────────────────
test('isWebhookAuthentic: only an exact token match passes', () => {
  assert.equal(B.isWebhookAuthentic('secret-token', 'secret-token'), true);
  assert.equal(B.isWebhookAuthentic('wrong', 'secret-token'), false);
});

test('isWebhookAuthentic: fails CLOSED when either side is missing', () => {
  // A missing configured secret must reject — an endpoint that waved
  // webhooks through would let anyone flip an account to paid.
  assert.equal(B.isWebhookAuthentic('anything', ''), false);
  assert.equal(B.isWebhookAuthentic('anything', undefined), false);
  assert.equal(B.isWebhookAuthentic('', 'secret-token'), false);
  assert.equal(B.isWebhookAuthentic(null, 'secret-token'), false);
});

test('isWebhookAuthentic: a length mismatch fails without throwing', () => {
  assert.equal(B.isWebhookAuthentic('short', 'a-much-longer-token'), false);
});

// ── payment status ───────────────────────────────────────────────
test('isPaidStatus: PAID and SETTLED count; PENDING/EXPIRED do not', () => {
  assert.equal(B.isPaidStatus('PAID'), true);
  assert.equal(B.isPaidStatus('settled'), true);
  assert.equal(B.isPaidStatus('PENDING'), false);
  assert.equal(B.isPaidStatus('EXPIRED'), false);
  assert.equal(B.isPaidStatus(undefined), false);
});

test('isExpiredStatus: recognises EXPIRED case-insensitively', () => {
  assert.equal(B.isExpiredStatus('expired'), true);
  assert.equal(B.isExpiredStatus('PAID'), false);
});
