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

   Driver interface (all async, may throw; may return { screenshot }):
     createUser({ email })            -> { managerUserRef, screenshot? }
     grantAccess({ managerUserRef, businessName })
     revokeAccess({ managerUserRef, businessName })
     disableUser({ managerUserRef })
   ============================================================ */
'use strict';

const MAX_ATTEMPTS = 3;

// After a failed attempt, retry until we've burned MAX_ATTEMPTS.
function nextStatusOnFailure(attempts) {
  return attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
}

// Claim the oldest pending job: mark it 'running' and bump attempts so a
// job that keeps throwing can't loop forever. Returns the job or null.
function claimNext(db, now) {
  const job = db.prepare("SELECT * FROM provision_job WHERE status = 'pending' ORDER BY id LIMIT 1").get();
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

  const biz = db.prepare('SELECT manager_business_name FROM businesses WHERE id = ?').get(job.business_id);
  if (!biz) throw new Error('business not found');
  if (job.type === 'grant') return driver.grantAccess({ managerUserRef: user.manager_user_ref, businessName: biz.manager_business_name });
  if (job.type === 'revoke') return driver.revokeAccess({ managerUserRef: user.manager_user_ref, businessName: biz.manager_business_name });
  throw new Error('unknown job type: ' + job.type);
}

function audit(db, job, outcome) {
  const u = job.user_id ? db.prepare('SELECT account_id FROM users WHERE id = ?').get(job.user_id) : null;
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(u ? u.account_id : null, 'provisioner', 'job_' + outcome, job.type + ' job:' + job.id);
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
  let processed = 0, job;
  while (processed < cap && (job = claimNext(db, now()))) {
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
