/* ============================================================
   Txform.ph — scripts/test-custom-button.js

   A one-off, live check of the custom-button provisioning step against a
   REAL Manager Server. It drives the SAME driver method the provisioner
   uses (configureCustomButton), so a green run here is a green run in
   production — no fake, no shortcut.

   Idempotent and reversible: it installs the "Txform Now!" button if the
   business does not already have it, or reports "already installed" and
   writes nothing. To undo, uninstall the button from installer.html.

   Run it ON THE SERVER, where Manager is on the loopback and the admin
   credentials already live in /etc/txform/provisioner.env:

     cd /var/www/taxify
     sudo env $(sudo cat /etc/txform/provisioner.env | xargs) \
       node scripts/test-custom-button.js "Test-Business-1"

   The business name is the MANAGER business name (what shows on the
   Businesses list in Books), exactly as typed there. Defaults to
   "Test-Business-1" if omitted.
   ============================================================ */
'use strict';

const { createDriver } = require('../server/provisioner-driver-http.js');

const businessName = process.argv[2] || 'Test-Business-1';

const driver = createDriver({
  baseUrl: process.env.MANAGER_URL || 'http://127.0.0.1:5000',
  adminUser: process.env.MANAGER_ADMIN_USER,
  adminPass: process.env.MANAGER_ADMIN_PASS,
});

if (!process.env.MANAGER_ADMIN_USER || !process.env.MANAGER_ADMIN_PASS) {
  console.error('✗ MANAGER_ADMIN_USER / MANAGER_ADMIN_PASS are not set.');
  console.error('  Run with the provisioner env loaded, e.g.:');
  console.error('  sudo env $(sudo cat /etc/txform/provisioner.env | xargs) node scripts/test-custom-button.js "' + businessName + '"');
  process.exit(1);
}

console.log('Installing the Txform Now! button on: ' + JSON.stringify(businessName));
console.log('Manager: ' + (process.env.MANAGER_URL || 'http://127.0.0.1:5000'));

driver.configureCustomButton({ businessName: businessName })
  .then(function (r) {
    if (r.alreadyInstalled) {
      console.log('✓ Already installed — nothing to do. The button is on ' + businessName + '’s Summary page.');
    } else {
      console.log('✓ Installed and verified. Open ' + businessName + ' → Summary in Books to see the Txform Now! button.');
    }
    process.exit(0);
  })
  .catch(function (e) {
    console.error('✗ Failed: ' + (e && e.message ? e.message : e));
    console.error('  Nothing partial was left behind — the button either installed fully or not at all.');
    process.exit(1);
  });
