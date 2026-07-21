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

  // A ledger line only reaches Manager if it moves at least a centavo —
  // the posting guard in step-engine.js filters the rest out. Both the
  // voucher's "is there anything to post?" check and that filter run
  // through isRecordableLine so the two can never disagree: if this says a
  // voucher has nothing recordable, readRows() is guaranteed to be empty.
  var LINE_EPSILON = 0.005;

  function isRecordableLine(row) {
    if (!row) return false;
    return (row.debit || 0) > LINE_EPSILON || (row.credit || 0) > LINE_EPSILON;
  }

  // True when a computed voucher has at least one line worth posting.
  // False means the period had no activity at all (e.g. a 0619E month with
  // nothing withheld), so there is no bookkeeping entry to make — the step
  // closes on its own rather than demanding a ₱0.00 journal entry that
  // would be meaningless in the books and rejected by Manager anyway.
  // Note this keys off the LINES, not the headline figure: a VAT quarter
  // whose output tax is fully offset by input tax nets to ₱0 cash but
  // still has a real closing entry to post.
  function hasRecordableLines(rows) {
    if (!Array.isArray(rows)) return false;
    for (var i = 0; i < rows.length; i++) {
      if (isRecordableLine(rows[i])) return true;
    }
    return false;
  }

  // Whether a VAT quarter has anything to post. VAT is unlike the
  // withholding forms, where the single remittance line IS the whole entry:
  // a VAT quarter can net to ₱0 cash and still need a real clearing entry —
  // reverse output tax, close input tax, carry any excess forward. So this
  // asks whether the BOOKS moved, not whether the net payable came out at
  // zero. In particular a quarter with purchases but no sales computes every
  // voucher line as ₱0.00 (inputUsed is capped at outputTax) yet still has
  // input tax to close out. Only a dormant quarter — no output tax, no
  // available input tax, no credits — has nothing to record.
  //   i37 = output tax · i60 = total available input tax credit
  //   i20 = CWT + other credits · i25 = advance/other payments
  function vatHasRecordableActivity(v) {
    if (!v) return false;
    return Math.abs(v.i37 || 0) > LINE_EPSILON
        || Math.abs(v.i60 || 0) > LINE_EPSILON
        || Math.abs((v.i20 || 0) + (v.i25 || 0)) > LINE_EPSILON;
  }

  // ── Snapshot document ───────────────────────────────────────────────────
  // A freeze stores the rendered return itself, so a filed period can be
  // shown back exactly as it stood — the figures alone can tell you THAT a
  // number moved, but not what you actually filed.
  //
  // Where the return lives in each report page. Two conventions exist:
  // most pages wrap in .report-wrap and render into #report-output, while
  // 2550q (the oldest) uses .rw and #output. Capture is scoped to these on
  // purpose — anything outside them isn't ours. Browser extensions inject
  // at <body> level, so scoping is also what keeps foreign nodes out of the
  // stored document and out of the captured manual inputs.
  var RETURN_ROOT_SELECTORS = ['#report-output', '#output'];
  var PAGE_ROOT_SELECTORS = ['.report-wrap', '.rw'];

  // Encoded length of `n` bytes under base64: 4 chars per 3-byte group.
  function base64Size(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return 0;
    return 4 * Math.ceil(n / 3);
  }

  // Whether a gzipped document survives base64 into a body of `capBytes`,
  // once `otherBytes` (figures, manual inputs, period) is accounted for.
  // Compares ENCODED size: 200 KB of gzip is ~267 KB base64, which overruns
  // a 262 KB cap even though the raw length looks like it fits.
  //
  // A document that doesn't fit is dropped, not fatal: the freeze still
  // stores the figures. Losing the visual record is bad; failing the
  // filing outright is worse.
  function documentFitsCap(gzBytes, capBytes, otherBytes) {
    if (typeof gzBytes !== 'number' || !isFinite(gzBytes) || gzBytes < 0) return false;
    return base64Size(gzBytes) + (otherBytes || 0) <= capBytes;
  }

  var api = {
    WORKFLOW_FORMS: WORKFLOW_FORMS,
    WORKFLOW_HEADLINE: WORKFLOW_HEADLINE,
    RETURN_ROOT_SELECTORS: RETURN_ROOT_SELECTORS,
    PAGE_ROOT_SELECTORS: PAGE_ROOT_SELECTORS,
    base64Size: base64Size,
    documentFitsCap: documentFitsCap,
    LINE_EPSILON: LINE_EPSILON,
    isRecordableLine: isRecordableLine,
    hasRecordableLines: hasRecordableLines,
    vatHasRecordableActivity: vatHasRecordableActivity,
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
