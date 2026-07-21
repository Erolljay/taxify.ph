/* ============================================================
   Tests for server/deploy-health.js — noticing that deploys have
   quietly stopped.

   Two failure modes matter and they pull in opposite directions:
   staying silent when the site is stuck (the bug), and crying wolf until
   the alerts are filtered to junk (which produces the bug again, later,
   with more steps).

     node --test test/deploy-health.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../server/deploy-health.js');

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

function facts(over) {
  return Object.assign({
    now: NOW,
    headSha: 'aaaaaaa',
    originSha: 'aaaaaaa',      // in sync
    dirtyTracked: [],
    behindSinceMs: null,
    lastAlertKey: null,
    lastAlertAtMs: null,
  }, over || {});
}

// ── diagnosis ────────────────────────────────────────────────────────

test('a server in sync with a clean tree is healthy', () => {
  assert.equal(H.diagnose(facts()), null);
  assert.equal(H.assess(facts()).alert, false);
});

test('a dirty tracked file is a fault immediately — it blocks every deploy', () => {
  // No grace period: this never fixes itself, and until it is cleared
  // nothing merged reaches the site.
  assert.equal(H.diagnose(facts({ dirtyTracked: ['nginx-portal-snippet.conf'] })), 'dirty');
});

test('being briefly behind is NOT a fault — the next tick has not run yet', () => {
  const f = facts({ originSha: 'bbbbbbb', behindSinceMs: NOW - 3 * MIN });
  assert.equal(H.diagnose(f), null, 'three minutes is normal');
});

test('being behind for longer than several ticks IS a fault', () => {
  const f = facts({ originSha: 'bbbbbbb', behindSinceMs: NOW - 11 * MIN });
  assert.equal(H.diagnose(f), 'stale');
});

test('the first sighting of being behind starts the clock rather than alerting', () => {
  const f = facts({ originSha: 'bbbbbbb', behindSinceMs: null });
  assert.equal(H.diagnose(f), null);
  assert.equal(H.nextState(f, H.assess(f)).behindSinceMs, NOW, 'clock started');
});

test('the clock is not reset while it stays behind', () => {
  const started = NOW - 8 * MIN;
  const f = facts({ originSha: 'bbbbbbb', behindSinceMs: started });
  assert.equal(H.nextState(f, H.assess(f)).behindSinceMs, started);
});

test('dirty is reported ahead of stale — it is the likely cause', () => {
  // Leading with "behind by 3 commits" would send someone looking at the
  // wrong thing entirely.
  const f = facts({ originSha: 'bbbbbbb', behindSinceMs: NOW - 30 * MIN, dirtyTracked: ['a.js'] });
  assert.equal(H.diagnose(f), 'dirty');
});

// ── not crying wolf ──────────────────────────────────────────────────

test('a new problem alerts', () => {
  const d = H.assess(facts({ dirtyTracked: ['a.js'] }));
  assert.equal(d.alert, true);
  assert.equal(d.kind, 'new');
});

test('the same problem does not alert again straight away', () => {
  const d = H.assess(facts({
    dirtyTracked: ['a.js'], lastAlertKey: 'dirty', lastAlertAtMs: NOW - 5 * MIN,
  }));
  assert.equal(d.alert, false);
  assert.equal(d.kind, 'suppressed');
});

test('a persisting problem repeats after an hour, not before', () => {
  const at59 = H.assess(facts({ dirtyTracked: ['a.js'], lastAlertKey: 'dirty', lastAlertAtMs: NOW - 59 * MIN }));
  const at61 = H.assess(facts({ dirtyTracked: ['a.js'], lastAlertKey: 'dirty', lastAlertAtMs: NOW - 61 * MIN }));
  assert.equal(at59.alert, false);
  assert.equal(at61.alert, true);
  assert.equal(at61.kind, 'repeat');
});

test('a DIFFERENT problem alerts immediately, cooldown or not', () => {
  // Going from "behind" to "blocked" is news, and the remedy differs.
  const d = H.assess(facts({
    dirtyTracked: ['a.js'], lastAlertKey: 'stale', lastAlertAtMs: NOW - 1 * MIN,
  }));
  assert.equal(d.alert, true);
  assert.equal(d.kind, 'new');
});

// ── the all-clear ────────────────────────────────────────────────────

test('recovery sends exactly one all-clear, then silence', () => {
  // Without this, a quiet inbox is ambiguous: fixed, or still broken and
  // the monitor gave up?
  const recovered = H.assess(facts({ lastAlertKey: 'dirty', lastAlertAtMs: NOW - 5 * MIN }));
  assert.equal(recovered.alert, true);
  assert.equal(recovered.kind, 'resolved');

  const after = H.nextState(facts(), recovered);
  assert.equal(after.lastAlertKey, null, 'cleared, so it will not keep saying it');
  assert.equal(H.assess(facts(Object.assign({}, after, { now: NOW + MIN }))).alert, false);
});

// ── what the message actually says ───────────────────────────────────

test('the blocked-deploy alert names the files and the remedy', () => {
  const body = H.bodyFor('dirty', facts({ dirtyTracked: ['nginx-portal-snippet.conf'] }));
  assert.match(body, /nginx-portal-snippet\.conf/, 'must name the file');
  assert.match(body, /git checkout --/, 'must give the command');
  assert.match(body, /NOTHING you merge will reach the site/, 'must state the consequence');
});

test('the stalled alert gives both shas and where to look', () => {
  const body = H.bodyFor('stale', facts({ headSha: 'aaaaaaa', originSha: 'bbbbbbb' }));
  assert.match(body, /aaaaaaa/);
  assert.match(body, /bbbbbbb/);
  assert.match(body, /txform-deploy\.log/, 'must say where to look');
});

test('subjects are scannable in a phone notification', () => {
  assert.match(H.subjectFor('dirty', facts()), /DEPLOYS BLOCKED/);
  assert.match(H.subjectFor('stale', facts()), /stalled/);
  assert.match(H.subjectFor('resolved', facts()), /working again/);
});

test('thresholds are sane relative to the two-minute deploy tick', () => {
  assert.ok(H.STALE_AFTER_MS >= 5 * MIN, 'must tolerate a few normal ticks');
  assert.ok(H.STALE_AFTER_MS <= 30 * MIN, 'but not let a stall sit all morning');
  assert.ok(H.REPEAT_AFTER_MS >= 30 * MIN, 'repeats must not become noise');
});
