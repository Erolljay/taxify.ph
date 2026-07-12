/* ============================================================
   Tests for server/provisioner.js — queue orchestration, retries, and
   DB reconciliation — against a real in-memory node:sqlite DB with a
   FAKE driver (no Playwright, no live Manager).

     node --test test/provisioner.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const P = require('../server/provisioner.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO account (id, plan) VALUES (1, ?)').run('firm');
  db.prepare('INSERT INTO users (id, account_id, email) VALUES (1, 1, ?)').run('staff@x.com');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_guid, name) VALUES (1, 1, ?, ?)').run('guid-1', 'Acme');
  return db;
}
function enqueue(db, type, userId, businessId) {
  db.prepare('INSERT INTO provision_job (type, user_id, business_id, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(type, userId, businessId || null, Date.now(), Date.now());
}
function jobStatus(db, id) { return db.prepare('SELECT status, last_error, screenshot_path FROM provision_job WHERE id = ?').get(id); }

// Configurable fake driver that records calls.
function fakeDriver(opts = {}) {
  const calls = [];
  const rec = (name, a) => { calls.push([name, a]); };
  return {
    calls,
    createUser: async (a) => { rec('createUser', a); if (opts.failCreate) throw new Error('create boom'); return { managerUserRef: 'mgr:' + a.email, screenshot: '/s/create.png' }; },
    grantAccess: async (a) => { rec('grantAccess', a); if (opts.failGrant) throw new Error('grant boom'); return { screenshot: '/s/grant.png' }; },
    revokeAccess: async (a) => { rec('revokeAccess', a); return { screenshot: '/s/revoke.png' }; },
    disableUser: async (a) => { rec('disableUser', a); return { screenshot: '/s/disable.png' }; },
  };
}
const only = (calls, name) => calls.filter((c) => c[0] === name);
const deps = { now: () => Date.now() };

test('nextStatusOnFailure: retries below the cap, fails at it', () => {
  assert.equal(P.nextStatusOnFailure(1), 'pending');
  assert.equal(P.nextStatusOnFailure(2), 'pending');
  assert.equal(P.nextStatusOnFailure(3), 'failed');
});

test('create: makes a Manager user and stores the ref', async () => {
  const db = seed(), driver = fakeDriver();
  enqueue(db, 'create', 1);
  const n = await P.drainOnce(db, driver, deps);
  assert.equal(n, 1);
  assert.equal(db.prepare('SELECT manager_user_ref FROM users WHERE id=1').get().manager_user_ref, 'mgr:staff@x.com');
  assert.equal(jobStatus(db, 1).status, 'done');
  assert.equal(jobStatus(db, 1).screenshot_path, '/s/create.png');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='job_done'").get());
});

test('grant: passes the Manager user ref and business GUID to the driver', async () => {
  const db = seed(), driver = fakeDriver();
  db.prepare("UPDATE users SET manager_user_ref='mgr:staff@x.com' WHERE id=1").run();
  enqueue(db, 'grant', 1, 1);
  await P.drainOnce(db, driver, deps);
  assert.deepEqual(only(driver.calls, 'grantAccess')[0][1], { managerUserRef: 'mgr:staff@x.com', businessGuid: 'guid-1' });
  assert.equal(jobStatus(db, 1).status, 'done');
});

test('ordering: create runs before grant even when both are queued', async () => {
  const db = seed(), driver = fakeDriver();
  enqueue(db, 'create', 1);      // id 1
  enqueue(db, 'grant', 1, 1);    // id 2 — user has no ref until create runs
  const n = await P.drainOnce(db, driver, deps);
  assert.equal(n, 2);
  assert.equal(jobStatus(db, 1).status, 'done');
  assert.equal(jobStatus(db, 2).status, 'done');
  // grant received the ref that create produced
  assert.equal(only(driver.calls, 'grantAccess')[0][1].managerUserRef, 'mgr:staff@x.com');
});

test('revoke and disable dispatch to the right driver methods', async () => {
  const db = seed(), driver = fakeDriver();
  db.prepare("UPDATE users SET manager_user_ref='mgr:staff@x.com' WHERE id=1").run();
  enqueue(db, 'revoke', 1, 1);
  enqueue(db, 'disable', 1);
  await P.drainOnce(db, driver, deps);
  assert.equal(only(driver.calls, 'revokeAccess').length, 1);
  assert.equal(only(driver.calls, 'disableUser').length, 1);
  assert.equal(jobStatus(db, 1).status, 'done');
  assert.equal(jobStatus(db, 2).status, 'done');
});

test('failure: a job retries up to the cap then is marked failed with the error', async () => {
  const db = seed(), driver = fakeDriver({ failCreate: true });
  enqueue(db, 'create', 1);
  await P.drainOnce(db, driver, deps);
  assert.equal(only(driver.calls, 'createUser').length, P.MAX_ATTEMPTS, 'retried MAX_ATTEMPTS times');
  assert.equal(jobStatus(db, 1).status, 'failed');
  assert.match(jobStatus(db, 1).last_error, /create boom/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='job_failed'").get());
});

test('grant with no created user (and no create job) retries to failed, never calls the driver', async () => {
  const db = seed(), driver = fakeDriver();
  enqueue(db, 'grant', 1, 1); // user has no manager_user_ref, no create queued
  await P.drainOnce(db, driver, deps);
  assert.equal(only(driver.calls, 'grantAccess').length, 0);
  assert.equal(jobStatus(db, 1).status, 'failed');
  assert.match(jobStatus(db, 1).last_error, /not created/);
});

test('drainOnce leaves no pending jobs behind', async () => {
  const db = seed(), driver = fakeDriver();
  db.prepare("UPDATE users SET manager_user_ref='mgr:staff@x.com' WHERE id=1").run();
  enqueue(db, 'grant', 1, 1);
  enqueue(db, 'revoke', 1, 1);
  await P.drainOnce(db, driver, deps);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provision_job WHERE status='pending'").get().n, 0);
});
