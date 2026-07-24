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

// ── previous period ──────────────────────────────────────────────
test('previousPeriod: steps back one month, rolling the year at January', () => {
  assert.equal(B.previousPeriod('2026-07'), '2026-06');
  assert.equal(B.previousPeriod('2026-01'), '2025-12', 'January rolls to prior December');
  assert.equal(B.previousPeriod('2026-11'), '2026-10', 'two-digit month stays padded');
});

test('previousPeriod: rejects a malformed key rather than guessing', () => {
  assert.throws(() => B.previousPeriod('2026-7'), /bad period key/);
  assert.throws(() => B.previousPeriod('nope'), /bad period key/);
});

// ── dunning transitions ──────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 15);

test('dunningTransition: an active account that owes moves to grace with a deadline', () => {
  const t = B.dunningTransition({ status: 'active', graceUntil: null }, { hasUnpaidInvoice: true, now: NOW, graceDays: 7 });
  assert.equal(t.to, 'grace');
  assert.equal(t.graceUntil, NOW + 7 * DAY);
});

test('dunningTransition: an active account that is paid up does not move', () => {
  assert.equal(B.dunningTransition({ status: 'active', graceUntil: null }, { hasUnpaidInvoice: false, now: NOW }).to, null);
});

test('dunningTransition: grace holds until the deadline, then suspends', () => {
  const before = B.dunningTransition({ status: 'grace', graceUntil: NOW + DAY }, { hasUnpaidInvoice: true, now: NOW });
  assert.equal(before.to, null, 'still within the grace window');
  const after = B.dunningTransition({ status: 'grace', graceUntil: NOW - DAY }, { hasUnpaidInvoice: true, now: NOW });
  assert.equal(after.to, 'suspended', 'deadline passed');
});

test('dunningTransition: never suspends when a filing deadline is near (holdSuspend)', () => {
  const t = B.dunningTransition({ status: 'grace', graceUntil: NOW - DAY }, { hasUnpaidInvoice: true, now: NOW, holdSuspend: true });
  assert.equal(t.to, null, 'a firm is not cut off right before it must file');
});

test('dunningTransition: paying up restores grace OR suspended to active and clears the deadline', () => {
  const fromGrace = B.dunningTransition({ status: 'grace', graceUntil: NOW - DAY }, { hasUnpaidInvoice: false, now: NOW });
  assert.deepEqual(fromGrace, { to: 'active', graceUntil: null });
  const fromSuspended = B.dunningTransition({ status: 'suspended', graceUntil: NOW - DAY }, { hasUnpaidInvoice: false, now: NOW });
  assert.deepEqual(fromSuspended, { to: 'active', graceUntil: null });
});

test('dunningTransition: a suspended account that still owes stays suspended', () => {
  assert.equal(B.dunningTransition({ status: 'suspended', graceUntil: NOW - DAY }, { hasUnpaidInvoice: true, now: NOW }).to, null);
});

test('dunningTransition: pending and cancelled accounts are never touched by dunning', () => {
  assert.equal(B.dunningTransition({ status: 'pending' }, { hasUnpaidInvoice: true, now: NOW }).to, null);
  assert.equal(B.dunningTransition({ status: 'cancelled' }, { hasUnpaidInvoice: true, now: NOW }).to, null);
});
