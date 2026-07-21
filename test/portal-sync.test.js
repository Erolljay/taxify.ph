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

// ── queued work of any shape ─────────────────────────────────────────

test('queued work with no business still counts as outstanding', () => {
  // A retried `disable` has no business_id, so it never appears in
  // `jobs`. Without the `pending` count the banner would clear on retry
  // and then never report what happened — the same blind spot, moved.
  const state = overview({ users: [staff()], jobs: [], pending: 1 });
  assert.equal(S.outstandingWork(state), true);
});

test('pending zero with everything settled stops the watch', () => {
  assert.equal(S.outstandingWork(overview({ users: [staff()], jobs: [], pending: 0 })), false);
});

// ── describing a failure to a CPA ────────────────────────────────────

test('a failed offboard is CRITICAL and says what is true right now', () => {
  const d = S.describeFailure({ id: 49, type: 'disable', user_email: 'jun@firm.ph', attempts: 3 });
  assert.equal(d.severity, 'critical');
  assert.match(d.headline, /jun@firm\.ph was removed, but may still have access/);
  assert.match(d.meaning, /still holding the client books/);
  assert.equal(d.attempts, 3);
});

test('a failed revoke is CRITICAL and names the client', () => {
  const d = S.describeFailure({ id: 7, type: 'revoke', user_email: 'jun@firm.ph', business_name: 'Acme' });
  assert.equal(d.severity, 'critical');
  assert.match(d.headline, /may still have access to Acme/);
});

test('a failed grant is only a WARNING — nobody is exposed', () => {
  const d = S.describeFailure({ id: 8, type: 'grant', user_email: 'jun@firm.ph', business_name: 'Acme' });
  assert.equal(d.severity, 'warning');
  assert.match(d.headline, /cannot open Acme yet/);
});

test('every job type the provisioner can run has copy', () => {
  // A type with no entry falls back to the unknown branch, which is
  // deliberately loud — but shipping a known type that way would be a
  // bug, so pin the list.
  ['create', 'create_business', 'configure_tabs', 'grant', 'revoke', 'disable', 'reset_password']
    .forEach(function (type) {
      const d = S.describeFailure({ id: 1, type: type, user_email: 'a@b.c', business_name: 'Acme' });
      assert.doesNotMatch(d.headline, /unknown|“/, type + ' fell through to the unknown branch');
      assert.ok(d.meaning.length > 10, type + ' has no explanation');
    });
});

test('an unrecognised job type surfaces loudly rather than vanishing', () => {
  const d = S.describeFailure({ id: 99, type: 'teleport', last_error: 'boom' });
  assert.equal(d.severity, 'critical', 'an unknown failure must not be quietly downgraded');
  assert.match(d.headline, /teleport/);
  assert.equal(d.detail, 'boom');
});

test('missing names degrade to readable English, not "undefined"', () => {
  const d = S.describeFailure({ id: 1, type: 'revoke' });
  assert.doesNotMatch(d.headline, /undefined|null/);
  assert.match(d.headline, /Someone.*a client/);
});

test('describeFailure survives junk input', () => {
  assert.equal(S.describeFailure(null).severity, 'critical');
  assert.equal(S.describeFailure({}).severity, 'critical');
});

// ── ordering: the dangerous one first ────────────────────────────────

test('critical failures sort above warnings, newest first within each', () => {
  const sorted = S.sortFailures([
    { id: 10, type: 'grant', user_email: 'a@b.c', business_name: 'Acme' },   // warning
    { id: 11, type: 'disable', user_email: 'jun@firm.ph' },                  // critical
    { id: 12, type: 'create', user_email: 'x@y.z' },                         // warning
    { id: 13, type: 'revoke', user_email: 'z@z.z', business_name: 'Beta' },  // critical
  ]);
  assert.deepEqual(sorted.map((f) => f.id), [13, 11, 12, 10]);
  assert.equal(sorted[0].severity, 'critical');
  assert.equal(sorted[3].severity, 'warning');
});

test('sortFailures handles an empty or missing list', () => {
  assert.deepEqual(S.sortFailures([]), []);
  assert.deepEqual(S.sortFailures(null), []);
});

test('hasCritical spots an offboard failure hiding among warnings', () => {
  assert.equal(S.hasCritical([{ id: 1, type: 'grant' }, { id: 2, type: 'disable' }]), true);
  assert.equal(S.hasCritical([{ id: 1, type: 'grant' }, { id: 2, type: 'create' }]), false);
  assert.equal(S.hasCritical([]), false);
});

// ── the timings ──────────────────────────────────────────────────────

test('polling is faster than the provisioner tick, and gives up after several', () => {
  // Polling slower than the provisioner acts would make a finished job
  // feel unfinished — the whole bug.
  assert.ok(S.WATCH_EVERY_MS < 120000, 'must poll faster than the 2-minute provisioner tick');
  assert.ok(S.WATCH_MAX_MS >= 3 * 120000, 'must allow at least three provisioner cycles');
});
