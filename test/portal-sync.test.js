/* ============================================================
   Tests for shared/portal-sync.js — when the owner portal should keep
   watching for the provisioner to catch up.

   Getting this wrong is invisible in either direction: too eager and the
   page polls forever over something no retry will fix; too shy and the
   bug it was written for comes back — a finished job that still reads
   "syncing…" until someone presses F5.

     node --test test/portal-sync.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../shared/portal-sync.js');

// The shape /api/tenancy/overview actually returns.
function overview(over) {
  return Object.assign({
    account: { firm_name: 'Tallo CPA', status: 'active' },
    me: { email: 'info@tallocpa.com', role: 'owner' },
    users: [{ id: 1, email: 'info@tallocpa.com', role: 'owner', status: 'active', provisioned: false }],
    businesses: [],
    grants: [],
    jobs: [],
  }, over || {});
}

const staff = (over) => Object.assign(
  { id: 2, email: 'maria@firm.ph', role: 'staff', status: 'active', provisioned: true }, over || {});

// ── nothing outstanding ──────────────────────────────────────────────

test('a settled firm is not watched', () => {
  assert.equal(S.outstandingWork(overview({ users: [staff()] })), false);
});

test('missing or empty state never starts a poll', () => {
  assert.equal(S.outstandingWork(null), false);
  assert.equal(S.outstandingWork(undefined), false);
  assert.equal(S.outstandingWork({}), false);
});

test('the OWNER never counts as unprovisioned work', () => {
  // Owners are control-plane only and get no Manager user, so their
  // permanently-false `provisioned` would otherwise poll forever.
  const state = overview({ users: [{ id: 1, role: 'owner', status: 'active', provisioned: false }] });
  assert.equal(S.outstandingWork(state), false);
});

test('a removed member is not waited on', () => {
  const state = overview({ users: [staff({ status: 'removed', provisioned: false })] });
  assert.equal(S.outstandingWork(state), false);
});

// ── grant / revoke: visible in `jobs` ────────────────────────────────

test('a pending grant is outstanding', () => {
  const state = overview({ jobs: [{ user_id: 2, business_id: 5, type: 'grant', status: 'pending' }] });
  assert.equal(S.outstandingWork(state), true);
});

test('a running job is outstanding', () => {
  const state = overview({ jobs: [{ user_id: 2, business_id: 5, type: 'revoke', status: 'running' }] });
  assert.equal(S.outstandingWork(state), true);
});

test('a FAILED job is not outstanding — the grid already says "failed"', () => {
  // Polling on a failure would never end: no retry is coming, and the
  // chip is already telling the truth.
  const state = overview({ jobs: [{ user_id: 2, business_id: 5, type: 'grant', status: 'failed' }] });
  assert.equal(S.outstandingWork(state), false);
});

// ── invite: NOT visible in `jobs` ────────────────────────────────────

test('a newly invited member is outstanding even with no jobs listed', () => {
  // The regression that caused the bug. A `create` job has no
  // business_id, so the overview never lists it — watching `jobs` alone
  // meant the password and authenticator steps never appeared.
  const state = overview({ users: [staff({ provisioned: false })], jobs: [] });
  assert.equal(S.outstandingWork(state), true);
});

test('once they are provisioned, watching stops', () => {
  const state = overview({ users: [staff({ provisioned: true })], jobs: [] });
  assert.equal(S.outstandingWork(state), false);
});

test('a client awaiting provisioning counts too, not just staff', () => {
  const state = overview({ users: [staff({ role: 'client', provisioned: false })] });
  assert.equal(S.outstandingWork(state), true);
});

test('one settled member does not mask another still syncing', () => {
  const state = overview({
    users: [staff({ id: 2, provisioned: true }), staff({ id: 3, email: 'jun@firm.ph', provisioned: false })],
  });
  assert.equal(S.outstandingWork(state), true);
});

// ── not stealing the caret ───────────────────────────────────────────

test('a render is deferred while the user is typing', () => {
  ['INPUT', 'TEXTAREA', 'SELECT'].forEach(function (tag) {
    assert.equal(S.shouldDeferRender({ tagName: tag }), true, tag + ' should defer');
  });
});

test('a render is not deferred for ordinary focus', () => {
  assert.equal(S.shouldDeferRender({ tagName: 'BODY' }), false);
  assert.equal(S.shouldDeferRender({ tagName: 'BUTTON' }), false);
  assert.equal(S.shouldDeferRender(null), false);
  assert.equal(S.shouldDeferRender({}), false);
});

// ── the timings ──────────────────────────────────────────────────────

test('polling is faster than the provisioner tick, and gives up after several', () => {
  // Polling slower than the provisioner acts would make a finished job
  // feel unfinished — the whole bug.
  assert.ok(S.WATCH_EVERY_MS < 120000, 'must poll faster than the 2-minute provisioner tick');
  assert.ok(S.WATCH_MAX_MS >= 3 * 120000, 'must allow at least three provisioner cycles');
});
