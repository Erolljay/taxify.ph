/* ============================================================
   Txform.ph — server/manager-coa.js

   Copies a chart of accounts from a template business onto a freshly
   provisioned one, so a new client's books arrive with the firm's standard
   accounts instead of Manager's bare defaults.

   ── Not a hand-rolled copier — Manager's own mechanism, server-side ──
   Manager ships a "Replicator" extension (Extensions → Replicator) that does
   exactly this in the browser. It is UI-only (no programmatic trigger), so
   this module reproduces its api4 calls server-side. Verified against the
   live extension source on 26.7.10, and against a manual run (49 records
   copied, control accounts merged not duplicated).

   ── Why it is robust: bulk PUT preserving keys ──
   Each collection is read with GET /api4/<x>-batch and written back with
   PUT /api4/<x>-batch as { business, values:[{key, value}] } — carrying every
   record's ORIGINAL GUID. Because keys are preserved, an account's `group`
   GUID still resolves in the destination (the group was written with that same
   GUID), so there is no per-business group remapping and nothing lands under
   Uncategorized. It is an upsert by key: a re-run overwrites the same records
   rather than duplicating them, which makes the job safely retriable.

   ── Control accounts take care of themselves ──
   Cash & cash equivalents, Accounts Receivable/Payable, and the Employee
   Clearing account are auto-created per business from the enabled tabs. They
   share GUIDs across businesses, so the bulk PUT merges onto the destination's
   own rather than creating duplicates — confirmed by the manual run. Nothing
   here special-cases them.

   ── Order matters ──
   Groups and subtotals are copied before the accounts that reference them, so
   every reference already exists by the time it is written. COA_COLLECTIONS is
   that order; do not reorder it.
   ============================================================ */
'use strict';

// The template whose chart of accounts every new client starts from. A real
// Manager business the firm maintains by hand; copied FROM (read-only) here.
// Firm policy, like REQUIRED_TABS in manager-tabs.js — change it here.
const TEMPLATE_BUSINESS = '0000 Chart of Accounts';

// Manager's batch reads page; the Replicator uses 50 and so do we.
const PAGE_SIZE = 50;

// The five collections a chart of accounts spans, in dependency order:
// groups and subtotals before the accounts that reference them.
const COA_COLLECTIONS = [
  '/api4/balance-sheet-group-batch',
  '/api4/profit-and-loss-statement-group-batch',
  '/api4/subtotal-batch',
  '/api4/balance-sheet-account-batch',
  '/api4/profit-and-loss-statement-account-batch',
];

// The batch GET Manager expects: `Business` is capitalised here (as the
// Replicator sends it), distinct from the lowercase `business` the extension
// batch used — matched per endpoint rather than assumed uniform.
function batchGetPath(collectionPath, business, skip) {
  return collectionPath + '?Business=' + encodeURIComponent(business)
    + '&Skip=' + skip + '&PageSize=' + PAGE_SIZE;
}

// A batch page is { items: [{ key, item }] }. Return the raw items, tolerant
// of an empty or missing page; throw only on genuinely unparseable output so a
// broken read never reads as "nothing to copy".
function parseBatchItems(body) {
  let parsed;
  try {
    parsed = JSON.parse(body || '{}');
  } catch (e) {
    throw new Error('could not parse the batch page: ' + e.message);
  }
  return (parsed && parsed.items) || [];
}

// GET batch returns { key, item }; PUT batch expects { key, value }. Keep the
// key so the record is written with its original GUID.
function toValues(items) {
  return (items || []).map(function (it) {
    return { key: it.key, value: it.item || it.value };
  });
}

// Manager answers a successful batch PUT with the JSON literal `true`; an error
// comes back as an object carrying a message. Read either shape.
function putSucceeded(res) {
  if (!res || res.status >= 400) return false;
  const body = (res.body == null ? '' : String(res.body)).trim();
  if (body === 'true' || body === '') return true;
  try {
    return JSON.parse(body) === true;
  } catch (e) {
    return false;
  }
}

// The error message Manager put in a failed PUT response, for the log.
function putError(res) {
  if (!res) return 'no response';
  const body = (res.body == null ? '' : String(res.body)).trim();
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.message) return parsed.message;
  } catch (e) { /* not JSON — fall through */ }
  return body || ('http ' + res.status);
}

module.exports = {
  TEMPLATE_BUSINESS, PAGE_SIZE, COA_COLLECTIONS,
  batchGetPath, parseBatchItems, toValues, putSucceeded, putError,
};
