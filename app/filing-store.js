/* ============================================================
   Txform.ph — filing-store.js  (browser I/O)

   The fetch layer for frozen filings: talks to server/save-report.php and
   server/report-snapshots.php with the txfsid session cookie. Mirrors
   entitlement.js — same credentials:'include' — and, like it, keys the
   endpoints on the Manager business NAME, which is Manager's own identifier
   for a business. Cross-tenant uniqueness is enforced server-side by the
   UNIQUE constraint on businesses.manager_business_name.

   Storage is SERVER-ONLY by decision, so this is the one place that turns a
   401 into a typed FilingAuthError. Callers use it to render an explicit
   "sign in to freeze filings" state — a freeze must FAIL LOUDLY on an
   install with no session, never silently drop the snapshot.

   Depends on globals from shared.js (apiRequest). Exposes window.FilingStore.
   ============================================================ */
(function (root) {
  'use strict';

  // Web-root paths (NOT server/…): nginx 404s /server/ on extension.txform.ph,
  // so the endpoints live at the root next to save-tax-rates.php.
  var SAVE_ENDPOINT      = 'save-report.php';
  var SNAPSHOTS_ENDPOINT = 'report-snapshots.php';

  function FilingAuthError(message) {
    this.name = 'FilingAuthError';
    this.message = message || 'Not signed in';
    this.isAuthError = true;
  }
  FilingAuthError.prototype = Object.create(Error.prototype);
  FilingAuthError.prototype.constructor = FilingAuthError;

  // ── business key ───────────────────────────────────────────────────
  // Manager identifies a business by NAME — api4/businesses returns only
  // `name`, and the user form's Businesses options are base64(name). This
  // used to resolve a GUID off `.key`, which Manager never sends, so every
  // call returned null and every freeze/load threw 'Business not
  // resolvable'. The name goes straight through now.
  function businessKey(name) {
    return (typeof name === 'string' && name.trim()) ? name.trim() : null;
  }

  function _parse(res) {
    if (res.status === 401) throw new FilingAuthError();
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok || (data && data.error)) {
        throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      }
      return data;
    });
  }

  // Full version history for one filing (payload included). Empty array when
  // the filing has never been frozen.
  function loadFilingSnapshots(bizName, workflowKey, periodKey) {
    var key = businessKey(bizName);
    if (!key) return Promise.reject(new FilingAuthError('No business selected'));
    var url = SNAPSHOTS_ENDPOINT
      + '?business=' + encodeURIComponent(key)
      + '&workflow=' + encodeURIComponent(workflowKey)
      + '&period=' + encodeURIComponent(periodKey)
      + '&t=' + Date.now();
    return fetch(url, { cache: 'no-store', credentials: 'include' })
      .then(_parse)
      .then(function (data) { return (data && data.snapshots) || []; });
  }

  // Current filed status per filing across the whole business (light — no
  // payload). Cached per business until a freeze invalidates it.
  var _batchCache = {};
  function loadBusinessFilings(bizName, forceFresh) {
    var key = businessKey(bizName);
    if (!key) return Promise.reject(new FilingAuthError('No business selected'));
    if (_batchCache[key] && !forceFresh) return Promise.resolve(_batchCache[key]);
    var url = SNAPSHOTS_ENDPOINT + '?business=' + encodeURIComponent(key) + '&t=' + Date.now();
    return fetch(url, { cache: 'no-store', credentials: 'include' })
      .then(_parse)
      .then(function (data) {
        var filings = (data && data.filings) || [];
        _batchCache[key] = filings;
        return filings;
      });
  }

  // Freeze a filing. `snapshot` = { workflowKey, periodKey, form, headline,
  // payload }. Returns { version }. Throws FilingAuthError on 401 so the
  // caller can keep the period in Draft and prompt sign-in.
  function saveFilingSnapshot(bizName, snapshot) {
    var key = businessKey(bizName);
    if (!key) return Promise.reject(new FilingAuthError('No business selected'));
    var body = {
      business: key,
      workflowKey: snapshot.workflowKey,
      periodKey: snapshot.periodKey,
      form: snapshot.form || null,
      headline: snapshot.headline || null,
      payload: snapshot.payload || {}
    };
    return fetch(SAVE_ENDPOINT, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(_parse)
      .then(function (data) {
        delete _batchCache[key];   // status changed — drop the cache
        return { version: data.version };
      });
  }

  function resetFilingStore() { _batchCache = {}; }

  // Largest request body save-report.php will accept. MUST stay in step
  // with TXFORM_MAX_BODY_BYTES in server/report-store.php — the client
  // drops the filed document when it would overrun this, so a client value
  // larger than the server's means oversized freezes get rejected outright
  // instead of degrading. test/filing-store-cap.test.js locks the pair.
  var MAX_BODY_BYTES = 1048576; // 1 MiB

  root.FilingStore = {
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    FilingAuthError: FilingAuthError,
    businessKey: businessKey,
    loadFilingSnapshots: loadFilingSnapshots,
    loadBusinessFilings: loadBusinessFilings,
    saveFilingSnapshot: saveFilingSnapshot,
    resetFilingStore: resetFilingStore
  };
})(typeof self !== 'undefined' ? self : this);
