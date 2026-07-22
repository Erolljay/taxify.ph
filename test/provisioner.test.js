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
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (1, 1, ?, ?, ?)').run('Acme', 'Acme', '2026-01-01T00:00:00Z');
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
    createBusiness: async (a) => { rec('createBusiness', a); if (opts.failCreateBusiness) throw new Error('create-business boom'); return {}; },
    configureTabs: async (a) => { rec('configureTabs', a); if (opts.failConfigureTabs) throw new Error('tabs boom'); return { tabsEnabled: [], alreadyConfigured: true }; },
    configureCustomButton: async (a) => { rec('configureCustomButton', a); if (opts.failConfigureCustomButton) throw new Error('button boom'); return { installed: true, alreadyInstalled: false }; },
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

test('grant: passes the Manager user ref and business name to the driver', async () => {
  const db = seed(), driver = fakeDriver();
  db.prepare("UPDATE users SET manager_user_ref='mgr:staff@x.com' WHERE id=1").run();
  enqueue(db, 'grant', 1, 1);
  await P.drainOnce(db, driver, deps);
  assert.deepEqual(only(driver.calls, 'grantAccess')[0][1], { managerUserRef: 'mgr:staff@x.com', businessName: 'Acme' });
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
  // One attempt per tick: a failing job must NOT burn its whole retry
  // budget inside a single drain, or a brief outage exhausts it in seconds.
  for (let i = 0; i < P.MAX_ATTEMPTS; i++) await P.drainOnce(db, driver, deps);
  assert.equal(only(driver.calls, 'createUser').length, P.MAX_ATTEMPTS, 'one attempt per tick');
  assert.equal(jobStatus(db, 1).status, 'failed');
  assert.match(jobStatus(db, 1).last_error, /create boom/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='job_failed'").get());
});

test('grant with no created user (and no create job) retries to failed, never calls the driver', async () => {
  const db = seed(), driver = fakeDriver();
  enqueue(db, 'grant', 1, 1); // user has no manager_user_ref, no create queued
  for (let i = 0; i < P.MAX_ATTEMPTS; i++) await P.drainOnce(db, driver, deps);
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

// ── create_business ──────────────────────────────────────────────
test('create_business: creates the books and stamps manager_created_at', async () => {
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (2, 1, ?, ?)")
    .run('FIRMA-New Co', 'New Co');
  enqueue(db, 'create_business', null, 2);
  const driver = fakeDriver();

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.deepEqual(only(driver.calls, 'createBusiness')[0][1], { businessName: 'FIRMA-New Co' });
  assert.ok(db.prepare('SELECT manager_created_at FROM businesses WHERE id=2').get().manager_created_at,
    'stamped, so grants may now proceed');
});

// ── configure_tabs ───────────────────────────────────────────────
test('configure_tabs: turns on the firm\'s tabs once the books exist', async () => {
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (2, 1, ?, ?, ?)")
    .run('FIRMA-New Co', 'New Co', '2026-01-01T00:00:00Z');
  enqueue(db, 'configure_tabs', null, 2);
  const driver = fakeDriver();

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.deepEqual(only(driver.calls, 'configureTabs')[0][1], { businessName: 'FIRMA-New Co' });
  assert.equal(jobStatus(db, 1).status, 'done');
});

test('configure_tabs: waits for the books rather than failing outright', async () => {
  // Queued alongside create_business, so on the first tick the books may
  // not exist yet. It must go back to pending, not burn its attempts.
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (2, 1, ?, ?)")
    .run('FIRMA-New Co', 'New Co');
  enqueue(db, 'configure_tabs', null, 2);
  const driver = fakeDriver();

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.equal(only(driver.calls, 'configureTabs').length, 0, 'must not touch Manager yet');
  assert.equal(jobStatus(db, 1).status, 'pending');
  assert.match(jobStatus(db, 1).last_error, /not created in Manager yet/);
});

test('configure_tabs: runs after create_business when both are queued', async () => {
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (2, 1, ?, ?)")
    .run('FIRMA-New Co', 'New Co');
  enqueue(db, 'create_business', null, 2);
  enqueue(db, 'configure_tabs', null, 2);
  const driver = fakeDriver();

  // First tick: books get made; tabs defers because one attempt per job
  // per tick. Second tick: tabs runs.
  await P.drainOnce(db, driver, { now: () => 1 });
  await P.drainOnce(db, driver, { now: () => 2 });

  const order = driver.calls.map((c) => c[0]);
  assert.deepEqual(order, ['createBusiness', 'configureTabs']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provision_job WHERE status='pending'").get().n, 0);
});

test('configure_tabs: a failure does not block the books being usable', async () => {
  // The books still exist and grants still work — only the sidebar is
  // unconfigured. It must retry, and be visible in the log if it gives up.
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (2, 1, ?, ?, ?)")
    .run('FIRMA-New Co', 'New Co', '2026-01-01T00:00:00Z');
  enqueue(db, 'configure_tabs', null, 2);
  const driver = fakeDriver({ failConfigureTabs: true });

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.equal(jobStatus(db, 1).status, 'pending');
  assert.match(jobStatus(db, 1).last_error, /tabs boom/);
});

// ── configure_custom_button ──────────────────────────────────────
test('configure_custom_button: installs the button once the books exist', async () => {
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (2, 1, ?, ?, ?)")
    .run('FIRMA-New Co', 'New Co', '2026-01-01T00:00:00Z');
  enqueue(db, 'configure_custom_button', null, 2);
  const driver = fakeDriver();

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.deepEqual(only(driver.calls, 'configureCustomButton')[0][1], { businessName: 'FIRMA-New Co' });
  assert.equal(jobStatus(db, 1).status, 'done');
});

test('configure_custom_button: waits for the books rather than failing outright', async () => {
  // Queued alongside create_business, so on the first tick the books may
  // not exist yet. It must go back to pending, not burn its attempts.
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (2, 1, ?, ?)")
    .run('FIRMA-New Co', 'New Co');
  enqueue(db, 'configure_custom_button', null, 2);
  const driver = fakeDriver();

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.equal(only(driver.calls, 'configureCustomButton').length, 0, 'must not touch Manager yet');
  assert.equal(jobStatus(db, 1).status, 'pending');
  assert.match(jobStatus(db, 1).last_error, /not created in Manager yet/);
});

test('configure_custom_button: a failure does not block the books being usable', async () => {
  // The books still exist and grants still work — only the Summary app is
  // missing. It must retry, and be visible in the log if it gives up.
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (2, 1, ?, ?, ?)")
    .run('FIRMA-New Co', 'New Co', '2026-01-01T00:00:00Z');
  enqueue(db, 'configure_custom_button', null, 2);
  const driver = fakeDriver({ failConfigureCustomButton: true });

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.equal(jobStatus(db, 1).status, 'pending');
  assert.match(jobStatus(db, 1).last_error, /button boom/);
});

test('create_business: a retry after an unseen response does not make a second set of books', async () => {
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (2, 1, ?, ?, ?)")
    .run('FIRMA-Already', 'Already', '2026-01-01T00:00:00Z');
  enqueue(db, 'create_business', null, 2);
  const driver = fakeDriver();

  await P.drainOnce(db, driver, { now: () => 1 });

  assert.equal(only(driver.calls, 'createBusiness').length, 0, 'already created — the driver is not called again');
  assert.equal(jobStatus(db, 1).status, 'done');
});

test('grant: refuses until the books exist in Manager, then succeeds', async () => {
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (2, 1, ?, ?)")
    .run('FIRMA-Pending', 'Pending');
  enqueue(db, 'create', 1, null);
  enqueue(db, 'grant', 1, 2);   // queued against books that do not exist yet
  const driver = fakeDriver();

  // First pass: the user is created; the grant finds no books and retries.
  await P.drainOnce(db, driver, { now: () => 1 });
  assert.equal(only(driver.calls, 'grantAccess').length, 0, 'no grant against books that do not exist');
  assert.equal(jobStatus(db, 2).status, 'pending', 'retried rather than failed');
  assert.match(jobStatus(db, 2).last_error, /not created in Manager/);

  // Now the books exist — the same queued job goes through.
  db.prepare("UPDATE businesses SET manager_created_at = ? WHERE id = 2").run('2026-01-02T00:00:00Z');
  await P.drainOnce(db, driver, { now: () => 2 });
  assert.deepEqual(only(driver.calls, 'grantAccess')[0][1],
    { managerUserRef: 'mgr:staff@x.com', businessName: 'FIRMA-Pending' });
  assert.equal(jobStatus(db, 2).status, 'done');
});

test('create_business: a failure is audited against the right firm', async () => {
  const db = seed();
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (2, 1, ?, ?)")
    .run('FIRMA-Doomed', 'Doomed');
  enqueue(db, 'create_business', null, 2);
  const driver = fakeDriver({ failCreateBusiness: true });

  for (let i = 0; i < P.MAX_ATTEMPTS; i++) await P.drainOnce(db, driver, { now: () => 1 });

  assert.equal(jobStatus(db, 1).status, 'failed');
  const entry = db.prepare("SELECT account_id FROM audit_log WHERE action='job_failed'").get();
  assert.equal(entry.account_id, 1, 'resolved through the business, since there is no user on this job');
});
