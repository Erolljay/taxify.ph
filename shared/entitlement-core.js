/* ============================================================
   Txform.ph — entitlement-core.js

   Pure entitlement decision logic. NO fetch, NO DOM, NO SQLite —
   just functions from (server data + clock) to (what the extension
   may do). Kept dependency-free so it runs identically in the browser
   (loaded as a global) and under Node's test runner.

   This is deliberately the ONLY place billing-status → access rules
   live, so there is exactly one implementation to reason about and
   test. entitlement.php serves raw rows; entitlement.js does the
   fetch + caching plumbing; both defer the actual decision to here.

   Loaded in the browser via <script> (sets window.EntitlementCore),
   and required in tests via module.exports — same file, no build step,
   matching the repo's no-bundler setup.
   ============================================================ */
(function (root) {
  'use strict';

  var HOUR = 3600 * 1000;

  // How long a fetched entitlement is treated as fresh before the
  // client bothers hitting the server again.
  var CACHE_TTL_MS = 24 * HOUR;

  // If the server can't be reached, keep honoring the last good answer
  // for this long so a transient outage never blocks a filing.
  var FAIL_OPEN_MS = 72 * HOUR;

  // Recurring major BIR deadlines, as {month(1-12), day}. Planning set
  // from the SaaS plan (Jan 25, Apr 15, quarterly 25ths) — validate and
  // extend against the real BIR calendar before launch; this is the one
  // spot to edit when you do.
  var BIR_DEADLINES = [
    { month: 1, day: 25 },   // annual withholding / start-of-year cluster
    { month: 4, day: 15 },   // annual income tax
    { month: 1, day: 25 },   // Q4 percentage / withholding
    { month: 4, day: 25 },   // Q1
    { month: 7, day: 25 },   // Q2
    { month: 10, day: 25 }   // Q3
  ];

  var DEADLINE_GRACE_DAYS = 3;

  // Map an authoritative billing status to what the extension allows.
  // canFileNew gates generating NEW reports/filings; viewing existing
  // books is Manager's own concern, not this gate.
  function gateForStatus(status) {
    switch (status) {
      case 'active':    return { canFileNew: true,  level: 'full' };
      case 'grace':     return { canFileNew: true,  level: 'grace' };
      case 'suspended': return { canFileNew: false, level: 'suspended' };
      case 'cancelled': return { canFileNew: false, level: 'cancelled' };
      // Anything we don't recognize fails safe — no new filings — but is
      // NOT treated as a cancellation, so it stays recoverable.
      default:          return { canFileNew: false, level: 'unknown' };
    }
  }

  // Is a cached entitlement still within its client-side TTL?
  function isCacheFresh(cached, now, ttlMs) {
    if (!cached || typeof cached.at !== 'number') return false;
    var ttl = typeof ttlMs === 'number' ? ttlMs : CACHE_TTL_MS;
    return (now - cached.at) <= ttl;
  }

  // Resolve the effective entitlement given a (possibly failed) live
  // fetch and the last known-good cached value.
  //
  //   live   = { ok: boolean, status?: string }   result of the fetch
  //   cached = { status, at } | null              last successful read
  //
  // Precedence: live result → 72h fail-open on the cached status →
  // unverified (blocks new filings, but recoverable).
  function resolveEffective(opts) {
    var live = opts.live || { ok: false };
    var cached = opts.cached || null;
    var now = opts.now;

    if (live.ok) {
      var g = gateForStatus(live.status);
      return { source: 'live', status: live.status, canFileNew: g.canFileNew, level: g.level };
    }

    if (cached && (now - cached.at) <= FAIL_OPEN_MS) {
      var gc = gateForStatus(cached.status);
      return { source: 'failopen', status: cached.status, canFileNew: gc.canFileNew, level: gc.level };
    }

    // No authoritative signal: endpoint absent, business GUID unresolved,
    // or an outage past the fail-open window. The gate is UX-only and must
    // never block a filing by itself, and the extension also runs in
    // non-SaaS / pre-launch installs with no subscription at all — so treat
    // "unverified" as full access and show no banner. Real enforcement is
    // the provisioner revoking Manager access (Phase 1.4).
    return { source: 'unverified', status: 'unverified', canFileNew: true, level: 'unverified' };
  }

  // Is `now` within DEADLINE_GRACE_DAYS before any major BIR deadline?
  // Used so a suspension that would land right before a filing deadline
  // can be auto-extended past it. Checks this year and next so late-
  // December correctly sees the upcoming Jan deadline.
  //
  // NOTE ON LAYER: this belongs to the SERVER/provisioner suspension
  // decision (whether to flip an account to 'suspended'), NOT the client
  // gate — the client only reads the resulting status. It lives here so
  // that decision has one tested implementation to share; it is
  // intentionally not called from checkEntitlement(). Wire it into the
  // Phase 1.4 suspension job, not the browser.
  function isNearBirDeadline(now, deadlines, withinDays) {
    var list = deadlines || BIR_DEADLINES;
    var days = typeof withinDays === 'number' ? withinDays : DEADLINE_GRACE_DAYS;
    var windowMs = days * 24 * HOUR;
    var d = new Date(now);
    var years = [d.getFullYear(), d.getFullYear() + 1];

    for (var i = 0; i < list.length; i++) {
      for (var y = 0; y < years.length; y++) {
        // Deadlines are PH-local (UTC+8); build them there so the window
        // math doesn't drift by the runner's timezone.
        var deadline = new Date(years[y] + '-' +
          pad2(list[i].month) + '-' + pad2(list[i].day) + 'T23:59:59+08:00').getTime();
        var delta = deadline - now;
        if (delta >= 0 && delta <= windowMs) return true;
      }
    }
    return false;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var api = {
    CACHE_TTL_MS: CACHE_TTL_MS,
    FAIL_OPEN_MS: FAIL_OPEN_MS,
    BIR_DEADLINES: BIR_DEADLINES,
    gateForStatus: gateForStatus,
    isCacheFresh: isCacheFresh,
    resolveEffective: resolveEffective,
    isNearBirDeadline: isNearBirDeadline
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node / tests
  } else {
    root.EntitlementCore = api;      // browser global
  }
})(typeof self !== 'undefined' ? self : this);
