/* ============================================================
   Txform.ph — entitlement.js  (browser glue)

   The I/O layer around entitlement-core.js: fetch the account's
   billing status from server/entitlement.php, persist the last good
   answer so the 72h fail-open survives page reloads, and hand the
   raw data to EntitlementCore for the actual decision.

   Mirrors tax-rates.js: same fetch-with-cache-bust pattern, same
   in-memory promise cache. The one addition is a localStorage record
   of the last successful read, because fail-open across a real outage
   must outlive a single page load.

   Keyed by Manager business GUID, not name — names aren't unique across
   tenants, so the endpoint only accepts the GUID. The wiring step must
   resolve the selected business to its GUID (from Manager's business
   list) before calling this.

   Usage from a report's init:
     const gate = await checkEntitlement(businessGuid);
     // UX-only gate — real enforcement is server-side (provisioner + Manager auth)
     if (!gate.canFileNew) { showEntitlementBanner(gate); return; }
   ============================================================ */

// Web-root path (NOT server/…): nginx 404s /server/ on extension.txform.ph,
// so entitlement.php lives at the root next to save-tax-rates.php.
const ENTITLEMENT_ENDPOINT = 'entitlement.php';

// Per-business in-memory promise cache (reset when the business changes).
let _entPromises = {};

// localStorage key holding { status, at } for the last successful read.
function _entCacheKey(guid) { return 'txform.ent.' + guid; }

function _readCache(business) {
  try {
    const raw = localStorage.getItem(_entCacheKey(business));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function _writeCache(business, status, at) {
  try {
    localStorage.setItem(_entCacheKey(business), JSON.stringify({ status: status, at: at }));
  } catch (e) { /* private mode / quota — fail-open still works within the session */ }
}

// Resolve the effective entitlement for a business GUID. forceFresh
// bypasses the in-memory promise cache (e.g. after a known status change).
function checkEntitlement(guid, forceFresh) {
  if (!guid) {
    return Promise.resolve(EntitlementCore.resolveEffective({ live: { ok: false }, cached: null, now: Date.now() }));
  }
  if (_entPromises[guid] && !forceFresh) return _entPromises[guid];

  const cached = _readCache(guid);
  const now = Date.now();

  // Honor the 24h client cache: if fresh, don't hit the server at all.
  if (!forceFresh && EntitlementCore.isCacheFresh(cached, now)) {
    _entPromises[guid] = Promise.resolve(
      EntitlementCore.resolveEffective({ live: { ok: true, status: cached.status }, cached: cached, now: now })
    );
    return _entPromises[guid];
  }

  _entPromises[guid] = fetch(
    ENTITLEMENT_ENDPOINT + '?business=' + encodeURIComponent(guid) + '&t=' + now,
    // credentials: send the txfsid session cookie so the endpoint can
    // authorize per-tenant. A 401 (not signed in / cross-subdomain cookie
    // not present) is treated like any fetch failure below → fail open.
    { cache: 'no-store', credentials: 'include' }
  )
    .then(function (res) {
      if (!res.ok) throw new Error('entitlement fetch failed (' + res.status + ')');
      return res.json();
    })
    .then(function (data) {
      if (data && data.error) throw new Error(data.error);
      _writeCache(guid, data.status, Date.now());
      return EntitlementCore.resolveEffective({
        live: { ok: true, status: data.status }, cached: _readCache(guid), now: Date.now()
      });
    })
    .catch(function () {
      // Server unreachable / 5xx / not-a-subscriber-yet: fall back to the
      // last good answer within the 72h window; beyond that, unverified.
      return EntitlementCore.resolveEffective({
        live: { ok: false }, cached: _readCache(guid), now: Date.now()
      });
    });

  return _entPromises[guid];
}

// Reset caches when the selected business changes (call from app.js's
// business `change` handler, next to setupTabLoaded = false).
function resetEntitlement() { _entPromises = {}; _bizGuidCache = {}; }

// ── BUSINESS NAME → GUID ─────────────────────────────────────────
// The extension knows businesses by name, but the entitlement endpoint
// keys on the Manager business GUID (names aren't a safe cross-tenant
// key). Resolve name → GUID from Manager's own business list, matching
// the `.key || .Key` shape Manager list objects use (see shared.js).
let _bizGuidCache = {};
async function resolveBusinessGuid(name) {
  if (!name) return null;
  if (_bizGuidCache[name]) return _bizGuidCache[name];
  try {
    const res = await apiRequest('GET', '/api4/businesses');
    const list = (res && res.businesses) || [];
    const b = list.find(function (x) { return x.name === name; });
    const guid = b ? (b.key || b.Key || null) : null;
    if (guid) _bizGuidCache[name] = guid;
    return guid;
  } catch (e) { return null; }
}

// ── ONE-CALL REPORT GATE (reference wiring) ──────────────────────
// Resolve GUID → check entitlement → surface a banner when access is
// degraded. Returns the gate so a caller can also disable generation.
// The gate is UX-only: real enforcement is the provisioner revoking the
// Manager user (Phase 1.4). If the GUID can't be resolved or the server
// is unreachable, checkEntitlement fails open — filings are never
// blocked by an entitlement-system hiccup.
async function gateReport(businessName, containerEl) {
  const guid = await resolveBusinessGuid(businessName);
  const gate = await checkEntitlement(guid);
  if (containerEl && gate.level !== 'full') renderEntitlementBanner(containerEl, gate);
  return gate;
}

function _entitlementMessage(gate) {
  switch (gate.level) {
    case 'grace':      return { cls: 'alert-warn',  text: 'Subscription payment is past due — please update billing. Filing still works during the grace period.' };
    case 'suspended':  return { cls: 'alert-error', text: 'Subscription suspended. Generating new BIR filings is paused until payment resumes; your books remain available in Manager.' };
    case 'cancelled':  return { cls: 'alert-error', text: 'Subscription cancelled. Reactivate to generate new filings; your books are retained and exportable.' };
    // 'unverified' (no authoritative answer) and 'full' → no banner. We only
    // nag on a DEFINITE negative status, so pre-launch / self-hosted / offline
    // installs behave exactly as they do today.
    default:           return null;
  }
}

function renderEntitlementBanner(containerEl, gate) {
  const m = _entitlementMessage(gate);
  if (!m) return;
  const el = document.createElement('div');
  el.className = 'alert ' + m.cls + ' no-print';
  el.setAttribute('role', 'status');
  el.textContent = m.text; // textContent, not innerHTML — no injection surface
  containerEl.prepend(el);
}
