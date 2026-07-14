/* ============================================================
   Txform.ph — filing-core.js

   Pure filing-lifecycle logic. NO fetch, NO DOM, NO SQLite — just
   functions over (snapshot rows + period + clock). Kept dependency-free
   so it runs identically in the browser (window.FilingCore) and under
   Node's test runner (module.exports), matching the repo's no-build setup
   (same pattern as entitlement-core.js).

   A "filing" is one tax return for one business + one workflow + one
   period. `periodKey()` is the canonical id shared with the SQL
   `report_snapshot.period_key` column (and validated by save-report.php's
   regex), so the client and server always agree on what a period is.
   ============================================================ */
(function (root) {
  'use strict';

  // Which BIR forms each workflow files. Used to enumerate a workflow's
  // periods and to map a deadline (which is keyed by form) back to its
  // workflow. Forms are unique across workflows (1701* individual, 1702*
  // corporate), so the reverse map needs no classification hint.
  var WORKFLOW_FORMS = {
    vat:           ['2550Q'],
    expanded:      ['0619E', '1601EQ', '1604E'],
    compensation:  ['1601C', '1604C'],
    individual:    ['1701Q', '1701'],
    nonindividual: ['1702Q', '1702']
  };

  // The single report figure a freeze snapshots and the variance alert
  // compares against live books. winVar = the window.* property the report
  // page publishes (see reports/*.js and 2550q.html); field = the numeric
  // property on it; label = the human wording for the banner.
  var WORKFLOW_HEADLINE = {
    vat:           { winVar: '_v',   field: 'i61',             label: 'Net VAT payable' },
    expanded:      { winVar: '_e',   field: 'totalEwt',        label: 'EWT due' },
    compensation:  { winVar: '_c',   field: 'totalRemittance', label: 'Tax to remit' },
    individual:    { winVar: '_itr', field: 'totalPayable',    label: 'Total amount payable' },
    nonindividual: { winVar: '_itr', field: 'totalPayable',    label: 'Total amount payable' }
  };

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // Canonical period id, e.g. "quarterly:2026:1", "monthly:2026:2" (month is
  // the 0-based index the step engine's period picker uses), "annual:2026".
  // Must satisfy save-report.php's /^[a-z]+:\d{4}(:\d{1,2})?$/.
  function periodKey(period) {
    if (!period || !period.ptype || !period.year) return null;
    if (period.ptype === 'annual' || period.period == null) {
      return period.ptype + ':' + period.year;
    }
    return period.ptype + ':' + period.year + ':' + period.period;
  }

  function parsePeriodKey(key) {
    if (typeof key !== 'string') return null;
    var parts = key.split(':');
    if (parts.length < 2) return null;
    var out = { ptype: parts[0], year: parseInt(parts[1], 10) };
    if (parts.length >= 3) out.period = parseInt(parts[2], 10);
    return out;
  }

  function periodLabel(period) {
    if (!period) return '';
    if (period.ptype === 'annual' || period.period == null) return 'Annual ' + period.year;
    if (period.ptype === 'monthly') return (MONTHS[period.period] || '?') + ' ' + period.year;
    return 'Q' + period.period + ' ' + period.year;
  }

  function formsFor(workflowKey) {
    return WORKFLOW_FORMS[workflowKey] || [];
  }

  function headlineFor(workflowKey) {
    return WORKFLOW_HEADLINE[workflowKey] || null;
  }

  function formToWorkflow(form) {
    for (var wf in WORKFLOW_FORMS) {
      if (WORKFLOW_FORMS.hasOwnProperty(wf) && WORKFLOW_FORMS[wf].indexOf(form) !== -1) {
        return wf;
      }
    }
    return null;
  }

  // The current (not superseded) filed snapshot from a history array — the
  // highest-version row still marked 'filed'. Batch rows carry no status
  // (they're already filtered to filed server-side), so treat null as filed.
  function currentSnapshot(snapshots) {
    if (!Array.isArray(snapshots)) return null;
    var current = null;
    for (var i = 0; i < snapshots.length; i++) {
      var s = snapshots[i];
      if (!s) continue;
      if (s.status === 'filed' || s.status == null) {
        if (!current || (s.version || 0) > (current.version || 0)) current = s;
      }
    }
    return current;
  }

  // 'draft' (nothing filed), 'filed' (original v1), or 'amended' (v2+).
  function resolveFilingStatus(snapshots) {
    var current = currentSnapshot(snapshots);
    if (!current) return 'draft';
    return (current.version && current.version > 1) ? 'amended' : 'filed';
  }

  // Compare a frozen headline against a freshly recomputed live amount.
  // filedHeadline = { label, amount }; liveAmount = number (or null if the
  // live figure couldn't be read). `changed` uses a centavo tolerance.
  function computeVariance(filedHeadline, liveAmount) {
    var filedAmount = (filedHeadline && typeof filedHeadline.amount === 'number')
      ? filedHeadline.amount : null;
    var live = (typeof liveAmount === 'number' && isFinite(liveAmount)) ? liveAmount : null;
    var label = (filedHeadline && filedHeadline.label) || null;
    if (filedAmount === null || live === null) {
      return { changed: false, filedAmount: filedAmount, liveAmount: live, delta: null, label: label };
    }
    var delta = live - filedAmount;
    return {
      changed: Math.abs(delta) > 0.005,
      filedAmount: filedAmount,
      liveAmount: live,
      delta: delta,
      label: label
    };
  }

  var api = {
    WORKFLOW_FORMS: WORKFLOW_FORMS,
    WORKFLOW_HEADLINE: WORKFLOW_HEADLINE,
    periodKey: periodKey,
    parsePeriodKey: parsePeriodKey,
    periodLabel: periodLabel,
    formsFor: formsFor,
    headlineFor: headlineFor,
    formToWorkflow: formToWorkflow,
    currentSnapshot: currentSnapshot,
    resolveFilingStatus: resolveFilingStatus,
    computeVariance: computeVariance
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;          // Node / tests
  } else {
    root.FilingCore = api;         // browser global
  }
})(typeof self !== 'undefined' ? self : this);
