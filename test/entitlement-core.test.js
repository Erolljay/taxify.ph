/* ============================================================
   Tests for entitlement-core.js — the pure entitlement decision
   logic. Runs on Node's built-in test runner, no dependencies:

     node --test test/

   These are the repo's first automated tests. The logic under test
   is the #1 correctness risk in the SaaS plan: a bug here either lets
   a non-payer file, or blocks a paying firm at a BIR deadline.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../entitlement-core.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ── gateForStatus: billing status → what the extension allows ──────
test('gateForStatus: active allows new filings', () => {
  assert.deepEqual(E.gateForStatus('active'), { canFileNew: true, level: 'full' });
});

test('gateForStatus: grace still allows filings (nothing blocked in grace)', () => {
  assert.deepEqual(E.gateForStatus('grace'), { canFileNew: true, level: 'grace' });
});

test('gateForStatus: suspended blocks NEW filings but is not cancelled', () => {
  assert.deepEqual(E.gateForStatus('suspended'), { canFileNew: false, level: 'suspended' });
});

test('gateForStatus: cancelled blocks', () => {
  assert.deepEqual(E.gateForStatus('cancelled'), { canFileNew: false, level: 'cancelled' });
});

test('gateForStatus: unknown/garbage status fails safe (no new filings), not cancelled', () => {
  assert.deepEqual(E.gateForStatus('wat'), { canFileNew: false, level: 'unknown' });
  assert.deepEqual(E.gateForStatus(undefined), { canFileNew: false, level: 'unknown' });
});

// ── resolveEffective: 72h fail-open when the server is unreachable ──
test('resolveEffective: live server result wins and becomes the new source', () => {
  const now = Date.now();
  const r = E.resolveEffective({ live: { ok: true, status: 'active' }, cached: null, now });
  assert.equal(r.source, 'live');
  assert.equal(r.status, 'active');
  assert.equal(r.canFileNew, true);
});

test('resolveEffective: server down + last good within 72h → FAIL OPEN', () => {
  const now = Date.now();
  const cached = { status: 'active', at: now - 10 * HOUR };
  const r = E.resolveEffective({ live: { ok: false }, cached, now });
  assert.equal(r.source, 'failopen');
  assert.equal(r.canFileNew, true, 'an API blip must never block a filing within 72h');
});

test('resolveEffective: server down + last good exactly 72h → still open (boundary inclusive)', () => {
  const now = Date.now();
  const cached = { status: 'active', at: now - 72 * HOUR };
  const r = E.resolveEffective({ live: { ok: false }, cached, now });
  assert.equal(r.source, 'failopen');
  assert.equal(r.canFileNew, true);
});

test('resolveEffective: server down + last good older than 72h → unverified, FAILS OPEN (never blocks a filing)', () => {
  const now = Date.now();
  const cached = { status: 'active', at: now - (72 * HOUR + 1) };
  const r = E.resolveEffective({ live: { ok: false }, cached, now });
  assert.equal(r.source, 'unverified');
  assert.equal(r.canFileNew, true, 'no authoritative signal must not block filings — enforcement is server-side');
  assert.notEqual(r.level, 'cancelled', 'unverified is not a cancellation');
});

test('resolveEffective: server down + never had a good check → unverified, fails open (no banner, full access)', () => {
  const now = Date.now();
  const r = E.resolveEffective({ live: { ok: false }, cached: null, now });
  assert.equal(r.source, 'unverified');
  assert.equal(r.canFileNew, true);
});

test('resolveEffective: fail-open honors the CACHED status, not a blanket allow', () => {
  const now = Date.now();
  const cached = { status: 'suspended', at: now - 5 * HOUR };
  const r = E.resolveEffective({ live: { ok: false }, cached, now });
  assert.equal(r.source, 'failopen');
  assert.equal(r.canFileNew, false, 'fail-open on a suspended account stays suspended');
});

// ── isCacheFresh: 24h client cache (when to bother refetching) ─────
test('isCacheFresh: within 24h is fresh', () => {
  const now = Date.now();
  assert.equal(E.isCacheFresh({ at: now - 23 * HOUR }, now), true);
});

test('isCacheFresh: past 24h is stale', () => {
  const now = Date.now();
  assert.equal(E.isCacheFresh({ at: now - 25 * HOUR }, now), false);
});

test('isCacheFresh: null cache is never fresh', () => {
  assert.equal(E.isCacheFresh(null, Date.now()), false);
});

// ── isNearBirDeadline: deadline-aware grace extension ─────────────
test('isNearBirDeadline: 2 days before Apr 15 is near', () => {
  const now = new Date('2026-04-13T09:00:00+08:00').getTime();
  assert.equal(E.isNearBirDeadline(now), true);
});

test('isNearBirDeadline: a quiet mid-month day is not near', () => {
  const now = new Date('2026-06-10T09:00:00+08:00').getTime();
  assert.equal(E.isNearBirDeadline(now), false);
});

test('isNearBirDeadline: 2 days before a quarterly 25th is near', () => {
  const now = new Date('2026-07-23T09:00:00+08:00').getTime();
  assert.equal(E.isNearBirDeadline(now), true);
});

test('isNearBirDeadline: wraps year-end (Jan 25 seen from late December)', () => {
  const now = new Date('2026-12-31T09:00:00+08:00').getTime();
  // Jan 25 is >3 days away here, so NOT near — guards against a naive wrap bug.
  assert.equal(E.isNearBirDeadline(now), false);
  const near = new Date('2027-01-23T09:00:00+08:00').getTime();
  assert.equal(E.isNearBirDeadline(near), true);
});
