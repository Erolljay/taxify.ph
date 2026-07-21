/* ============================================================
   Tests for server/migrate.js.

   The bug this exists to prevent: schema.sql is CREATE TABLE IF NOT
   EXISTS, so adding a column had no effect on a live database. The
   service started fine and then returned 500 on the first query that
   touched the new column — which is how it reached production.

     node --test test/migrate.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const M = require('../server/migrate.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
const cols = (db, t) => db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);

// ── parsing ──────────────────────────────────────────────────────
test('parseColumns: keeps defaults containing commas and parentheses intact', () => {
  const body = `
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  account_id INTEGER NOT NULL REFERENCES account(id)`;
  const parsed = M.parseColumns(body);
  assert.deepEqual(parsed.map((c) => c.name), ['id', 'name', 'created_at', 'account_id']);
  assert.match(parsed[2].def, /datetime\('now'\)/, 'a comma inside the default must not split it');
});

test('parseColumns: ignores table-level constraints, which are not columns', () => {
  const body = `
  id    INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  UNIQUE(account_id, email)`;
  assert.deepEqual(M.parseColumns(body).map((c) => c.name), ['id', 'email']);
});

test('parseColumns: strips trailing comments', () => {
  const body = `
  role TEXT NOT NULL DEFAULT 'staff',        -- owner|staff|client
  status TEXT NOT NULL DEFAULT 'active'      -- active|removed`;
  const parsed = M.parseColumns(body);
  assert.deepEqual(parsed.map((c) => c.name), ['role', 'status']);
  assert.ok(!/--/.test(parsed[0].def));
});

test('parseSchemaTables: finds every table in the real schema', () => {
  const tables = M.parseSchemaTables(SCHEMA);
  ['account', 'users', 'businesses', 'user_business', 'provision_job', 'audit_log'].forEach((t) => {
    assert.ok(tables[t], 'missing ' + t);
  });
});

// ── what can and cannot be added ─────────────────────────────────
test('canAddColumn: refuses NOT NULL without a default', () => {
  // SQLite rejects it — existing rows would have no value.
  const r = M.canAddColumn('status TEXT NOT NULL');
  assert.equal(r.ok, false);
  assert.match(r.reason, /NOT NULL without DEFAULT/);
});

test('canAddColumn: allows NOT NULL WITH a default', () => {
  assert.equal(M.canAddColumn("status TEXT NOT NULL DEFAULT 'active'").ok, true);
});

test('canAddColumn: refuses PRIMARY KEY, which cannot be added at all', () => {
  assert.equal(M.canAddColumn('id INTEGER PRIMARY KEY').ok, false);
});

test('canAddColumn: refuses a non-constant default rather than dropping it', () => {
  // Forcing it through by removing the default would leave a stale database
  // inserting NULL where a fresh one writes a timestamp — a silent, permanent
  // divergence. Better to stop and say so.
  const r = M.canAddColumn("created_at TEXT NOT NULL DEFAULT (datetime('now'))");
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-constant DEFAULT/);
  assert.equal(M.canAddColumn("status TEXT NOT NULL DEFAULT 'active'").ok, true, 'a constant is fine');
});

test('canAddColumn: UNIQUE is allowed, but flagged for an index', () => {
  // SQLite cannot ADD COLUMN ... UNIQUE, yet the constraint must survive —
  // so the column goes in plain and a unique index enforces it.
  const r = M.canAddColumn('firm_code TEXT UNIQUE');
  assert.equal(r.ok, true);
  assert.equal(r.needsUniqueIndex, true);
});

test('planMigration: a UNIQUE column becomes ADD COLUMN plus an index', () => {
  const schema = 'CREATE TABLE IF NOT EXISTS account (\n  id INTEGER PRIMARY KEY,\n  firm_code TEXT UNIQUE\n);';
  const { plan } = M.planMigration(schema, { account: ['id'] });
  assert.equal(plan.length, 1);
  assert.ok(!/UNIQUE/i.test(plan[0].sql), 'the ADD COLUMN must not carry UNIQUE');
  assert.match(plan[0].indexSql, /CREATE UNIQUE INDEX .* ON account\(firm_code\)/);
});

test('migrate: the unique constraint really is enforced afterwards', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE account (id INTEGER PRIMARY KEY);');
  db.prepare('INSERT INTO account (id) VALUES (1)').run();
  db.prepare('INSERT INTO account (id) VALUES (2)').run();
  const schema = 'CREATE TABLE IF NOT EXISTS account (\n  id INTEGER PRIMARY KEY,\n  firm_code TEXT UNIQUE\n);';
  db.exec(schema);
  M.migrate(db, schema);
  db.prepare('UPDATE account SET firm_code = ? WHERE id = 1').run('TALLO');
  assert.throws(() => db.prepare('UPDATE account SET firm_code = ? WHERE id = 2').run('TALLO'),
    /UNIQUE|constraint/i, 'a duplicate code must still be rejected');
});

// ── planning ─────────────────────────────────────────────────────
test('planMigration: plans only the columns actually missing', () => {
  const schema = "CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'active'\n);";
  const { plan } = M.planMigration(schema, { users: ['id', 'email'] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].column, 'status');
  assert.match(plan[0].sql, /ALTER TABLE users ADD COLUMN status/);
});

test('planMigration: an up-to-date database plans nothing', () => {
  const schema = 'CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL\n);';
  assert.equal(M.planMigration(schema, { users: ['id', 'email'] }).plan.length, 0);
});

test('planMigration: a table that does not exist yet is left to CREATE TABLE', () => {
  const schema = 'CREATE TABLE IF NOT EXISTS brand_new (\n  id INTEGER PRIMARY KEY\n);';
  assert.equal(M.planMigration(schema, {}).plan.length, 0);
});

// ── the real thing ───────────────────────────────────────────────
test('migrate: adds a column to an existing table WITHOUT touching rows', () => {
  // This is the exact failure that hit production: the table pre-exists,
  // so CREATE TABLE IF NOT EXISTS is a no-op and the column never lands.
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);");
  db.prepare('INSERT INTO users (id, email) VALUES (1, ?)').run('owner@x.com');

  const schema = "CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'active',\n  removed_at TEXT\n);";
  db.exec(schema);                                   // no-op, as in production
  assert.ok(!cols(db, 'users').includes('status'), 'CREATE TABLE alone does not add it');

  const r = M.migrate(db, schema);
  assert.equal(r.added, 2);
  assert.ok(cols(db, 'users').includes('status'));
  assert.ok(cols(db, 'users').includes('removed_at'));

  const row = db.prepare('SELECT email, status FROM users WHERE id = 1').get();
  assert.equal(row.email, 'owner@x.com', 'the existing row survives');
  assert.equal(row.status, 'active', 'and gets the default');
});

test('migrate: is idempotent — safe to run on every boot', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
  const schema = "CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY,\n  status TEXT NOT NULL DEFAULT 'active'\n);";
  assert.equal(M.migrate(db, schema).added, 1);
  assert.equal(M.migrate(db, schema).added, 0, 'second run does nothing');
  assert.equal(M.migrate(db, schema).added, 0);
});

test('migrate: reports what it cannot add rather than crashing on boot', () => {
  // A dead auth service is worse than a warning — the caller can still
  // start, and the log says exactly which column is missing.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
  const schema = 'CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY,\n  code TEXT NOT NULL\n);';
  const lines = [];
  const r = M.migrate(db, schema, (m) => lines.push(m));
  assert.equal(r.added, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(lines.join('\n'), /WARNING.*users\.code/);
});

test('migrate: brings a stale database up to the REAL schema', () => {
  // The production shape: a database created from an older schema.sql.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE account (id INTEGER PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'starter');
    CREATE TABLE users (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff');
  `);
  db.prepare('INSERT INTO account (id) VALUES (1)').run();
  db.prepare('INSERT INTO users (id, account_id, email) VALUES (1, 1, ?)').run('owner@x.com');

  db.exec(SCHEMA);
  M.migrate(db, SCHEMA);

  ['status', 'removed_at', 'initial_password'].forEach((c) => {
    assert.ok(cols(db, 'users').includes(c), 'users.' + c + ' still missing');
  });
  ['firm_name', 'firm_code'].forEach((c) => {
    assert.ok(cols(db, 'account').includes(c), 'account.' + c + ' still missing');
  });
  assert.equal(db.prepare('SELECT email FROM users WHERE id=1').get().email, 'owner@x.com');

  // created_at uses DEFAULT (datetime('now')), which SQLite will not accept
  // in an ADD COLUMN. It is reported, not silently stripped of its default.
  const r = M.migrate(db, SCHEMA);
  assert.ok(r.skipped.every((sk) => /non-constant DEFAULT/.test(sk.reason)),
    'the only thing left unhandled should be the timestamp defaults');
});

test('migrate: a fresh database needs no migration at all', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  assert.equal(M.migrate(db, SCHEMA).added, 0, 'CREATE TABLE already built it correctly');
});
