/* ============================================================
   Txform.ph — backfill-principals.js  (one-time, idempotent)

   WHY THIS EXISTS
   The "access to all clients" model shipped after firms already existed.
   Two things never happened for those firms' owners:

     1. No Books login was ever created for the owner (only staff got one
        on invite), and
     2. new clients were never granted to the owner.

   So an owner — e.g. info@tallocpa.com — could SEE every client listed in
   the portal but could not OPEN any of their books. This script closes
   that gap for the databases that predate the feature.

   WHAT IT DOES
     - Marks every active OWNER as a principal (users.all_businesses = 1).
       New firms already do this at creation; this catches the old ones.
     - For every active principal (owner + any partner already flagged),
       grants every ACTIVE business in their account: writes the access
       row and queues the provisioner 'grant' job, and queues the one-off
       'create' job for their Books login if they don't have one yet.

   It reuses the exact helpers the live service uses (grantBusinessTo /
   ensureBooksLogin), so a grant queued here is identical to one queued by
   the portal — and every step is idempotent, so re-running is safe and
   quiet once the database is caught up.

   Run on the SERVER (where txform.db lives), AFTER deploying the schema:
     node server/backfill-principals.js
     # or a non-default DB path:
     TXFORM_DB=/var/www/taxify/server/txform.db node server/backfill-principals.js

   The provisioner (its systemd timer) then drains the queued jobs and the
   owner's Books password appears on the Team screen for collection.
   ============================================================ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const S = require('./auth-service.js');

const dbPath = process.env.TXFORM_DB || path.join(__dirname, 'txform.db');
const db = new DatabaseSync(dbPath);

// Bring the schema current first — all_businesses may not exist yet on a
// database that predates it. migrate() is additive and idempotent.
const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSql);
require('./migrate.js').migrate(db, schemaSql, console.log);

const now = Date.now();

// 1. Every active owner is a principal. (New firms set this at creation.)
const promoted = db.prepare(
  "UPDATE users SET all_businesses = 1 WHERE role = 'owner' AND status = 'active' AND all_businesses = 0"
).run().changes;
console.log('[backfill] owners promoted to all-clients: ' + promoted);

// 2. Grant every active principal every active business in their account.
const principals = db.prepare(
  "SELECT id, account_id, email FROM users WHERE all_businesses = 1 AND status = 'active'"
).all();

let grants = 0;
principals.forEach(function (u) {
  const businesses = db.prepare(
    "SELECT id FROM businesses WHERE account_id = ? AND status = 'active'"
  ).all(u.account_id);
  businesses.forEach(function (b) {
    const before = db.prepare('SELECT 1 FROM user_business WHERE user_id = ? AND business_id = ?').get(u.id, b.id);
    S.grantBusinessTo(db, u.id, b.id, now);
    if (!before) grants++;
  });
  console.log('[backfill] ' + u.email + ' — ' + businesses.length + ' active client(s) ensured');
});

console.log('[backfill] new grants queued: ' + grants);
console.log('[backfill] done. The provisioner will apply queued jobs on its next run.');
