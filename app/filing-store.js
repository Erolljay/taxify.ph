/* ============================================================
   Txform.ph — filing-store.js  (browser I/O)

   The fetch layer for frozen filings: talks to server/save-report.php and
   server/report-snapshots.php with the txfsid session cookie. Mirrors
   entitlement.js — same credentials:'include', same GUID resolution — and,
   like it, keys the endpoints on the Manager business GUID (names aren't a
   safe cross-tenant key).

   Storage is SERVER-ONLY by decision, so this is the one place that turns a
   401 into a typed FilingAuthError. Callers use it to render an explicit
   "sign in to freeze filings" state — a freeze must FAIL LOUDLY on an
   install with no session, never silently drop the snapshot.

   Depends on globals from shared.js (apiRequest). Exposes window.FilingStore.
   ============================================================ */
(function (root) {
  'use strict';

  var SAVE_ENDPOINT      = 'server/save-report.php';
  var SNAPSHOTS_ENDPOINT = 'server/report-snapshots.php';

  function FilingAuthError(message) {
    this.name = 'FilingAuthError';
    this.message = message || 'Not signed in';
    this.isAuthError = true;
  }
  FilingAuthError.prototype = Object.create(Error.prototype);
  FilingAuthError.prototype.constructor = FilingAuthError;

  // ── business name → Manager GUID (cached) ──────────────────────────
  var _guidCache = {};
  function resolveBusinessGuid(name) {
    if (!name) return Promise.resolve(null);
    if (_guidCache[name]) return Promise.resolve(_guidCache[name]);
    return apiRequest('GET', '/api4/businesses')
      .then(function (res) {
        var list = (res && res.businesses) || [];
        var b = list.find(function (x) { return x.name === name; });
        var guid = b ? (b.key || b.Key || null) : null;
        if (guid) _guidCache[name] = guid;
        return guid;
      })
      .catch(function () { return null; });
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
    return resolveBusinessGuid(bizName).then(function (guid) {
      if (!guid) throw new FilingAuthError('Business not resolvable');
      var url = SNAPSHOTS_ENDPOINT
        + '?business=' + encodeURIComponent(guid)
        + '&workflow=' + encodeURIComponent(workflowKey)
        + '&period=' + encodeURIComponent(periodKey)
        + '&t=' + Date.now();
      return fetch(url, { cache: 'no-store', credentials: 'include' })
        .then(_parse)
        .then(function (data) { return (data && data.snapshots) || []; });
    });
  }

  // Current filed status per filing across the whole business (light — no
  // payload). Cached per business until a freeze invalidates it.
  var _batchCache = {};
  function loadBusinessFilings(bizName, forceFresh) {
    return resolveBusinessGuid(bizName).then(function (guid) {
      if (!guid) throw new FilingAuthError('Business not resolvable');
      if (_batchCache[guid] && !forceFresh) return _batchCache[guid];
      var url = SNAPSHOTS_ENDPOINT + '?business=' + encodeURIComponent(guid) + '&t=' + Date.now();
      return fetch(url, { cache: 'no-store', credentials: 'include' })
        .then(_parse)
        .then(function (data) {
          var filings = (data && data.filings) || [];
          _batchCache[guid] = filings;
          return filings;
        });
    });
  }

  // Freeze a filing. `snapshot` = { workflowKey, periodKey, form, headline,
  // payload }. Returns { version }. Throws FilingAuthError on 401 so the
  // caller can keep the period in Draft and prompt sign-in.
  function saveFilingSnapshot(bizName, snapshot) {
    return resolveBusinessGuid(bizName).then(function (guid) {
      if (!guid) throw new FilingAuthError('Business not resolvable');
      var body = {
        business: guid,
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
          delete _batchCache[guid];   // status changed — drop the cache
          return { version: data.version };
        });
    });
  }

  function resetFilingStore() { _guidCache = {}; _batchCache = {}; }

  root.FilingStore = {
    FilingAuthError: FilingAuthError,
    resolveBusinessGuid: resolveBusinessGuid,
    loadFilingSnapshots: loadFilingSnapshots,
    loadBusinessFilings: loadBusinessFilings,
    saveFilingSnapshot: saveFilingSnapshot,
    resetFilingStore: resetFilingStore
  };
})(typeof self !== 'undefined' ? self : this);
