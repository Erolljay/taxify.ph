/* ============================================================
   Txform.ph — server/provisioner.js  (Phase 1.4)

   Drains the provision_job queue that the tenancy writes fill, and
   reconciles Manager Server to match: create restricted users, grant
   /revoke their access to businesses, disable on offboard. The actual
   browser automation lives behind an injected `driver` (the Playwright
   adapter in provisioner-driver-playwright.js) so THIS file — the queue
   orchestration, retries, and DB bookkeeping — is fully testable with a
   fake driver, no Playwright and no live Manager.

   Single-worker model: run on a systemd timer (see
   server/txform-provisioner.{service,timer}); one drainOnce per tick.

   Driver interface (all async, may throw):
     createBusiness({ businessName })
     createUser({ email })            -> { managerUserRef }
     grantAccess({ managerUserRef, businessName })
     revokeAccess({ managerUserRef, businessName })
     disableUser({ managerUserRef })

   Job ordering is by id and enforced by retry, not by a scheduler: a
   grant whose business or user has not been created yet simply throws and
   is picked up again on the next tick, once the job ahead of it has run.
   ============================================================ */
'use strict';

const MAX_ATTEMPTS = 3;

// After a failed attempt, retry until we've burned MAX_ATTEMPTS.
function nextStatusOnFailure(attempts) {
  return attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
}

// Claim the oldest pending job: mark it 'running' and bump attempts so a
// job that keeps throwing can't loop forever. Returns the job or null.
//
// `excludeIds` holds the jobs already attempted in THIS drain. Without it a
// job that fails back to 'pending' is immediately re-claimed by the same
// loop and burns all MAX_ATTEMPTS within one tick — which breaks the whole
// point of retrying. Jobs that wait on another job (a grant queued before
// its business exists) are exactly this case, and would give up seconds
// after being queued instead of succeeding on the next tick.
function claimNext(db, now, excludeIds) {
  const skip = excludeIds && excludeIds.length ? excludeIds : null;
  const sql = "SELECT * FROM provision_job WHERE status = 'pending'"
    + (skip ? ' AND id NOT IN (' + skip.map(function () { return '?'; }).join(',') + ')' : '')
    + ' ORDER BY id LIMIT 1';
  const job = skip ? db.prepare(sql).get.apply(db.prepare(sql), skip) : db.prepare(sql).get();
  if (!job) return null;
  db.prepare("UPDATE provision_job SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
    .run(now, job.id);
  job.attempts += 1;
  job.status = 'running';
  return job;
}

// Route a job to the driver, reading the DB context it needs. Throws on
// any problem; retriable ones (e.g. a grant before the user's create has
// run) simply throw and get retried by runJob.
async function dispatch(db, job, driver) {
  // Create the books themselves. No user involved — this is the one job
  // type keyed on a business alone.
  if (job.type === 'create_business') {
    const biz = db.prepare('SELECT id, manager_business_name, manager_created_at FROM businesses WHERE id = ?').get(job.business_id);
    if (!biz) throw new Error('business not found');
    // Already created: a retry after a response we never saw must not make
    // a second set of books.
    if (biz.manager_created_at) return { alreadyCreated: true };
    const r = await driver.createBusiness({ businessName: biz.manager_business_name });
    db.prepare('UPDATE businesses SET manager_created_at = ? WHERE id = ?')
      .run(new Date(Date.now()).toISOString(), biz.id);
    return r || {};
  }

  if (job.type === 'create') {
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(job.user_id);
    if (!user) throw new Error('user not found');
    const r = await driver.createUser({ email: user.email });
    db.prepare('UPDATE users SET manager_user_ref = ? WHERE id = ?').run(r.managerUserRef, user.id);
    return r;
  }

  const user = db.prepare('SELECT id, email, manager_user_ref FROM users WHERE id = ?').get(job.user_id);
  if (!user) throw new Error('user not found');
  // grant/revoke/disable all need the Manager user to exist first. If the
  // 'create' job hasn't run yet, throw so this retries after it.
  if (!user.manager_user_ref) throw new Error('manager user not created yet');

  if (job.type === 'disable') return driver.disableUser({ managerUserRef: user.manager_user_ref });

  const biz = db.prepare('SELECT manager_business_name, manager_created_at FROM businesses WHERE id = ?').get(job.business_id);
  if (!biz) throw new Error('business not found');
  // Granting access to books that do not exist yet would fail in Manager
  // and look like a permissions bug. Throw so this retries after the
  // create_business job ahead of it has run.
  if (!biz.manager_created_at) throw new Error('business not created in Manager yet');
  if (job.type === 'grant') return driver.grantAccess({ managerUserRef: user.manager_user_ref, businessName: biz.manager_business_name });
  if (job.type === 'revoke') return driver.revokeAccess({ managerUserRef: user.manager_user_ref, businessName: biz.manager_business_name });
  throw new Error('unknown job type: ' + job.type);
}

// Attribute the entry to the right firm. Most jobs carry a user, but
// create_business carries only a business — resolve through whichever is
// present so a failed book-creation still lands in that firm's activity
// log rather than nowhere.
function audit(db, job, outcome) {
  const owner = job.user_id
    ? db.prepare('SELECT account_id FROM users WHERE id = ?').get(job.user_id)
    : (job.business_id ? db.prepare('SELECT account_id FROM businesses WHERE id = ?').get(job.business_id) : null);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(owner ? owner.account_id : null, 'provisioner', 'job_' + outcome, job.type + ' job:' + job.id);
}

// Execute one claimed job. Records done (with any screenshot) or, on
// error, retries (back to pending) or gives up (failed) per attempts.
async function runJob(db, job, driver, deps) {
  const now = deps.now();
  try {
    const res = await dispatch(db, job, driver);
    db.prepare("UPDATE provision_job SET status = 'done', screenshot_path = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run((res && res.screenshot) || null, now, job.id);
    audit(db, job, 'done');
    return 'done';
  } catch (e) {
    const status = nextStatusOnFailure(job.attempts);
    db.prepare('UPDATE provision_job SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, String((e && e.message) || e), now, job.id);
    if (status === 'failed') audit(db, job, 'failed');
    return status;
  }
}

// Drain pending jobs until none remain (bounded so a perpetually-retried
// job can't spin the process forever within one tick).
async function drainOnce(db, driver, deps) {
  const cap = (deps && deps.cap) || 500;
  const now = (deps && deps.now) || function () { return Date.now(); };
  const seen = [];
  let processed = 0, job;
  while (processed < cap && (job = claimNext(db, now(), seen))) {
    seen.push(job.id);   // one attempt per job per tick
    await runJob(db, job, driver, { now: now });
    processed++;
  }
  return processed;
}

module.exports = { MAX_ATTEMPTS, nextStatusOnFailure, claimNext, dispatch, runJob, drainOnce };

// ── run one drain against the real DB + Playwright driver ─────────
if (require.main === module) {
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = process.env.TXFORM_DB || path.join(__dirname, 'txform.db');
  const db = new DatabaseSync(dbPath);
  // The Playwright adapter is the one piece that needs `npm install
  // playwright`; required lazily so tests never load it.
  const { createDriver } = require('./provisioner-driver-playwright.js');
  const driver = createDriver({
    baseUrl: process.env.MANAGER_URL || 'https://books.txform.ph',
    adminUser: process.env.MANAGER_ADMIN_USER,
    adminPass: process.env.MANAGER_ADMIN_PASS,
    screenshotDir: process.env.TXFORM_SHOT_DIR || path.join(__dirname, 'provision-shots'),
  });
  drainOnce(db, driver, { now: function () { return Date.now(); } })
    .then(function (n) { console.log('[provisioner] processed', n, 'job(s)'); return driver.close && driver.close(); })
    .then(function () { process.exit(0); })
    .catch(function (e) { console.error('[provisioner] fatal', e); process.exit(1); });
}
