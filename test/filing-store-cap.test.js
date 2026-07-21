/* ============================================================
   Txform.ph — request-body cap contract

   The freeze path has one number that must agree across two languages:
   the largest request body save-report.php will accept. The client sizes
   the captured return document against its copy and drops the document
   when it wouldn't fit; the server enforces its own copy with a 413.

   Drift is silent and asymmetric:
     client > server → oversized freezes are REJECTED (413) instead of
                       degrading to a figures-only filing — the preparer
                       loses the filing, not just the visual record.
     client < server → documents get dropped that would have fitted.

   Neither shows up in any other test, since the two constants live in
   files that never import each other. Read both off disk and compare.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('filing-store and report-store agree on the max body size', () => {
  const js = read('app/filing-store.js').match(/MAX_BODY_BYTES\s*=\s*(\d+)/);
  const php = read('server/report-store.php').match(/TXFORM_MAX_BODY_BYTES\s*=\s*(\d+)/);

  assert.ok(js, 'MAX_BODY_BYTES not found in app/filing-store.js');
  assert.ok(php, 'TXFORM_MAX_BODY_BYTES not found in server/report-store.php');
  assert.equal(
    Number(js[1]), Number(php[1]),
    'client and server body caps have drifted — see this file for why that is not benign'
  );
});
