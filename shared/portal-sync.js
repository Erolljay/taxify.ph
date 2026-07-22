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

    // `pending` counts queued work of ANY shape, including the jobs that
    // carry no business_id and therefore never appear in `jobs` at all.
    // Retrying a failed offboard produces exactly such a job: without
    // this the banner would clear and then never report the outcome.
    if (state.pending > 0) return true;

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

  // ── describing a failed job to somebody who is not an engineer ──────
  //
  // The owner is a CPA. "disable job:49 failed — could not open the user
  // form (http 302)" tells them nothing they can act on. What they need
  // is who is affected, what is true right now because of it, and whether
  // it is urgent.
  //
  // Severity is about CONSEQUENCE, not about which job type it is:
  //
  //   critical — somebody has access they should not. A failed offboard
  //              is the worst failure this system has: the portal says
  //              they are gone, and the client's books say otherwise.
  //   warning  — somebody cannot do something yet. Annoying, visible,
  //              and nobody is exposed by it.
  const FAILURE_COPY = {
    disable: {
      severity: 'critical',
      headline: function (f) { return (f.user_email || 'Someone') + ' was removed, but may still have access in Books.'; },
      meaning: 'Their access could not be stripped. Until this succeeds, treat them as still holding the client books.',
    },
    revoke: {
      severity: 'critical',
      headline: function (f) {
        return (f.user_email || 'Someone') + ' may still have access to ' + (f.business_name || 'a client') + '.';
      },
      meaning: 'The access grid shows the change, but Books did not apply it.',
    },
    grant: {
      severity: 'warning',
      headline: function (f) {
        return (f.user_email || 'Someone') + ' cannot open ' + (f.business_name || 'a client') + ' yet.';
      },
      meaning: 'They will not see these books until this succeeds.',
    },
    create: {
      severity: 'warning',
      headline: function (f) { return (f.user_email || 'Someone') + ' has no Books account yet.'; },
      meaning: 'They cannot sign in to Books, and no password has been issued for them.',
    },
    reset_password: {
      severity: 'warning',
      headline: function (f) { return 'Could not reset the Books password for ' + (f.user_email || 'someone') + '.'; },
      meaning: 'Their existing password still works — nothing was changed.',
    },
    create_business: {
      severity: 'warning',
      headline: function (f) { return 'The books for ' + (f.business_name || 'a new client') + ' were not created.'; },
      meaning: 'Nobody can be given access until the books exist.',
    },
    configure_tabs: {
      severity: 'warning',
      headline: function (f) { return (f.business_name || 'A client') + '’s books were created, but the tabs were not set up.'; },
      meaning: 'The books work; the sidebar is missing the tabs the firm uses.',
    },
    configure_custom_button: {
      severity: 'warning',
      headline: function (f) { return (f.business_name || 'A client') + '’s books were created, but the Txform Now! button was not installed.'; },
      meaning: 'The books work; the Txform Now! app is just missing from the Summary page.',
    },
    copy_chart_of_accounts: {
      severity: 'warning',
      headline: function (f) { return (f.business_name || 'A client') + '’s books were created, but the chart of accounts was not copied.'; },
      meaning: 'The books work; they just have Manager’s default accounts instead of the firm’s standard chart.',
    },
  };

  // Unknown job types must still surface. A new job type added later and
  // forgotten here should look wrong, not vanish — hence a real entry
  // rather than a silent skip, and 'critical' so nobody ignores it.
  function describeFailure(f) {
    const job = f || {};
    const copy = FAILURE_COPY[job.type];
    if (!copy) {
      return {
        id: job.id,
        severity: 'critical',
        headline: 'A “' + (job.type || 'unknown') + '” step failed.',
        meaning: 'This is not a failure the portal knows how to explain — please send it to support.',
        detail: job.last_error || '',
        attempts: job.attempts || 0,
      };
    }
    return {
      id: job.id,
      severity: copy.severity,
      headline: copy.headline(job),
      meaning: copy.meaning,
      detail: job.last_error || '',
      attempts: job.attempts || 0,
    };
  }

  // Worst first, then newest. An owner scanning the top of the page must
  // meet the offboarding failure before the cosmetic one.
  function sortFailures(failures) {
    // NOT `rank[s] || 9` — critical ranks 0, which is falsy, so that idiom
    // sorts the most dangerous failure to the BOTTOM. Caught by the test
    // below; it would have quietly defeated the point of the banner.
    const rank = { critical: 0, warning: 1 };
    const rankOf = function (s) { return Object.prototype.hasOwnProperty.call(rank, s) ? rank[s] : 9; };

    return (failures || []).map(describeFailure).sort(function (a, b) {
      const s = rankOf(a.severity) - rankOf(b.severity);
      return s !== 0 ? s : (b.id || 0) - (a.id || 0);
    });
  }

  function hasCritical(failures) {
    return (failures || []).some(function (f) { return describeFailure(f).severity === 'critical'; });
  }

  const api = {
    WATCH_EVERY_MS: WATCH_EVERY_MS,
    WATCH_MAX_MS: WATCH_MAX_MS,
    outstandingWork: outstandingWork,
    shouldDeferRender: shouldDeferRender,
    describeFailure: describeFailure,
    sortFailures: sortFailures,
    hasCritical: hasCritical,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node / tests
  } else {
    root.PortalSync = api;           // browser global
  }
})(typeof self !== 'undefined' ? self : this);
