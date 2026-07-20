/* ============================================================
   Txform.ph — seed-owner.js  (one-time bootstrap)

   Sign-up isn't built yet (Phase 3), so the magic-link sign-in has no
   way to create the FIRST account: request-link only emails an email
   that already has a `users` row (auth-service.js requestLink), and
   verify rejects a link with no matching user. This script inserts that
   first firm + owner user so real magic-link sign-in works — after which
   adding client businesses and granting access is self-serve in the
   account dashboard.

   Zero-dep, matches auth-service.js exactly (node:sqlite, same DB path).
   Idempotent: re-running with the same email is a no-op.

   Run on the SERVER (where txform.db lives):
     node server/seed-owner.js erolljay@tallocpa.com
     # or, if the service uses a non-default DB path:
     TXFORM_DB=/var/www/taxify/server/txform.db node server/seed-owner.js erolljay@tallocpa.com
   ============================================================ */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email || email.indexOf('@') === -1) {
  console.error('Usage: node server/seed-owner.js <owner-email>');
  process.exit(1);
}

const dbPath = process.env.TXFORM_DB || path.join(__dirname, 'txform.db');
const db = new DatabaseSync(dbPath);

const existing = db.prepare('SELECT id, account_id, role FROM users WHERE email = ?').get(email);
if (existing) {
  console.log('Owner already seeded — nothing to do.');
  console.log('  email      : ' + email);
  console.log('  user id    : ' + existing.id);
  console.log('  account id : ' + existing.account_id);
  console.log('  role       : ' + existing.role);
  console.log('\nSign in at https://txform.ph/account (magic link will be emailed).');
  process.exit(0);
}

// A generous "firm" account so testing isn't gated by seat/business limits.
const acct = db.prepare(
  "INSERT INTO account (plan, status, seats_limit, businesses_limit) VALUES ('firm', 'active', 10, 100)"
).run();
const accountId = Number(acct.lastInsertRowid);

const user = db.prepare(
  "INSERT INTO users (account_id, email, role) VALUES (?, ?, 'owner')"
).run(accountId, email);

db.prepare(
  "INSERT INTO audit_log (account_id, actor, action, target) VALUES (?, 'system', 'seed_owner', ?)"
).run(accountId, 'user:' + user.lastInsertRowid + ' ' + email);

console.log('Seeded owner account:');
console.log('  db         : ' + dbPath);
console.log('  email      : ' + email);
console.log('  user id    : ' + Number(user.lastInsertRowid));
console.log('  account id : ' + accountId + '  (plan=firm, active, 10 seats / 100 businesses)');
console.log('\nNext:');
console.log('  1. Go to https://txform.ph/account, enter ' + email + ', click "Send link".');
console.log('  2. Open the emailed link → you land signed in on the dashboard.');
console.log('  3. "Add business" using the business name exactly as it appears in Manager, then freeze a filing.');
