/* ============================================================
   Txform.ph — scripts/test-copy-coa.js

   A one-off, live check of the chart-of-accounts copy step against a REAL
   Manager Server. It drives the SAME driver method the provisioner uses
   (copyChartOfAccounts), so a green run here is a green run in production.

   Reproduces Manager's Replicator (Extensions → Replicator, "Chart of
   accounts") server-side: it copies groups, subtotals, and accounts from the
   template business onto the destination. Idempotent — the copy upserts by
   key, so re-running overwrites the same records rather than duplicating them.
   To undo, use the destination business's History in Books.

   Run it ON THE SERVER, where Manager is on the loopback and the admin
   credentials already live in /etc/txform/provisioner.env:

     cd /var/www/taxify
     sudo env $(sudo cat /etc/txform/provisioner.env | xargs) \
       node scripts/test-copy-coa.js "Test-Business-1"

   Args: the DESTINATION business name (required-ish; defaults to
   "Test-Business-1"), and an optional template override (defaults to the
   TEMPLATE_BUSINESS in manager-coa.js, "0000 Chart of Accounts"):

     node scripts/test-copy-coa.js "Some Client" "0000 Chart of Accounts"
   ============================================================ */
'use strict';

const { createDriver } = require('../server/provisioner-driver-http.js');
const C = require('../server/manager-coa.js');

const businessName = process.argv[2] || 'Test-Business-1';
const templateBusiness = process.argv[3] || process.env.MANAGER_COA_TEMPLATE || C.TEMPLATE_BUSINESS;

if (!process.env.MANAGER_ADMIN_USER || !process.env.MANAGER_ADMIN_PASS) {
  console.error('✗ MANAGER_ADMIN_USER / MANAGER_ADMIN_PASS are not set.');
  console.error('  Run with the provisioner env loaded, e.g.:');
  console.error('  sudo env $(sudo cat /etc/txform/provisioner.env | xargs) node scripts/test-copy-coa.js "' + businessName + '"');
  process.exit(1);
}

const driver = createDriver({
  baseUrl: process.env.MANAGER_URL || 'http://127.0.0.1:5000',
  adminUser: process.env.MANAGER_ADMIN_USER,
  adminPass: process.env.MANAGER_ADMIN_PASS,
});

console.log('Copying chart of accounts');
console.log('  from template: ' + JSON.stringify(templateBusiness));
console.log('  to business:   ' + JSON.stringify(businessName));
console.log('  Manager:       ' + (process.env.MANAGER_URL || 'http://127.0.0.1:5000'));

driver.copyChartOfAccounts({ businessName: businessName, templateBusiness: templateBusiness })
  .then(function (r) {
    console.log('✓ Copied and verified ' + r.copied + ' record(s). Open ' + businessName
      + ' → Settings → Chart of Accounts in Books to review.');
    process.exit(0);
  })
  .catch(function (e) {
    console.error('✗ Failed: ' + (e && e.message ? e.message : e));
    console.error('  Some records may have been written before the failure — the copy is safe to re-run (it upserts by key).');
    console.error('  Or undo via the destination business’s History in Books.');
    process.exit(1);
  });
