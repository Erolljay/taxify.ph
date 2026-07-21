/* ============================================================
   Txform.ph — shared/portal-sync.js

   Decides whether the owner portal should keep watching for the
   provisioner to catch up.

   ── Why this exists ──
   The provisioner runs on a two-minute timer, so an action taken in the
   portal is NOT finished when the request returns. A granted checkbox
   shows "syncing…"; a newly invited person has no Manager password yet.

   The page had no way to find out those had completed. It rendered once
   and never again, so the chip stayed on "syncing…" and the password and
   authenticator steps stayed hidden until someone pressed F5 — working
   software that looked broken. Found by running the whole invite → grant
   → remove loop by hand on 2026-07-21; every underlying job had in fact
   succeeded within seconds.

   Loaded in the browser via <script> (sets window.PortalSync) and
   required in tests via module.exports — same file, no build step,
   matching shared/entitlement-core.js.
   ============================================================ */
(function (root) {
  'use strict';

  // The provisioner tick is 120s. Polling faster than it acts is wasted,
  // polling much slower makes a finished job feel unfinished. 5s keeps
  // the page honest within a tick of the truth at trivial cost — the
  // overview payload is small and the audience is a handful of owners.
  const WATCH_EVERY_MS = 5000;

  // Three provisioner cycles. Past that a job is stuck rather than slow,
  // and polling forever would be noise. The chip still reads "syncing…",
  // which remains true — we simply stop asking.
  const WATCH_MAX_MS = 6 * 60 * 1000;

  // Is the provisioner still owing us something the page is displaying?
  //
  // Two different signals, because the overview reports them differently:
  //
  //   grant / revoke — carry a business, so they appear in `jobs`
  //   create         — has NO business_id, so it never appears in `jobs`
  //                    at all. The only visible trace is a member who is
  //                    not `provisioned` yet. Watching only `jobs` was
  //                    exactly why the password steps never appeared.
  //
  // 'failed' deliberately does NOT count as outstanding: the grid already
  // shows "failed", which is accurate and final. Treating it as work in
  // progress would poll forever over something no retry will fix.
  function outstandingWork(state) {
    if (!state) return false;

    const jobs = state.jobs || [];
    const busy = jobs.some(function (j) {
      return j && (j.status === 'pending' || j.status === 'running');
    });
    if (busy) return true;

    // An owner never gets a Manager user (control plane only), so their
    // permanently-false `provisioned` must not keep the poll alive.
    return (state.users || []).some(function (u) {
      return u && u.status === 'active' && u.role !== 'owner' && !u.provisioned;
    });
  }

  // Re-rendering under someone's cursor steals focus mid-word and can
  // drop a half-typed email address. Skipping the render for one tick
  // costs a few seconds of staleness; stealing the caret costs their
  // work.
  function shouldDeferRender(activeElement) {
    if (!activeElement || !activeElement.tagName) return false;
    return /^(INPUT|SELECT|TEXTAREA)$/.test(activeElement.tagName);
  }

  const api = {
    WATCH_EVERY_MS: WATCH_EVERY_MS,
    WATCH_MAX_MS: WATCH_MAX_MS,
    outstandingWork: outstandingWork,
    shouldDeferRender: shouldDeferRender,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node / tests
  } else {
    root.PortalSync = api;           // browser global
  }
})(typeof self !== 'undefined' ? self : this);
