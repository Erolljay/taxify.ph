/* ============================================================
   Tests for server/create-firm.js — the back-office firm creator
   that stands in for a self-serve sign-up flow.

     node --test test/create-firm.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const C = require('../server/create-firm.js');
const S = require('../server/auth-service.js');
const A = require('../server/auth-core.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}
const args = (s) => C.parseArgs(s.split(' '));

// ── argument handling ────────────────────────────────────────────
test('parseArgs: firm name and email are positional; limits have defaults', () => {
  const o = args('Tallo CPA owner@tallo.ph');
  assert.equal(o.email, 'owner@tallo.ph');
  assert.equal(o.businesses, 100);
  assert.equal(o.seats, 10);
});

test('parseArgs: our own firms are billing-exempt unless --billable is passed', () => {
  assert.equal(args('Firm a@b.ph').billingExempt, 1, 'exempt by default — these are our firms');
  assert.equal(args('Firm a@b.ph --billable').billingExempt, 0);
});

test('parseArgs: email is lower-cased so sign-in matching cannot miss', () => {
  assert.equal(args('Firm Owner@Tallo.PH').email, 'owner@tallo.ph');
});

test('parseArgs: an unknown option is rejected rather than ignored', () => {
  assert.throws(() => args('Firm a@b.ph --oops'), /unknown option/);
});

test('validate: rejects a missing name, a bad email, and nonsense limits', () => {
  assert.match(C.validate(args('')), /firm name/);
  assert.match(C.validate(args('Firm not-an-email')), /valid owner email/);
  assert.match(C.validate(args('Firm a@b.ph --businesses 0')), /businesses/);
  assert.match(C.validate(args('Firm a@b.ph --seats x')), /seats/);
  assert.equal(C.validate(args('Firm a@b.ph')), null);
});

// ── creation ─────────────────────────────────────────────────────
test('createFirm: creates an ACTIVE account with an owner and an audit row', () => {
  const db = freshDb();
  const r = C.createFirm(db, args('Tallo owner@tallo.ph'));
  assert.equal(r.created, true);

  const acct = db.prepare('SELECT * FROM account WHERE id = ?').get(r.accountId);
  assert.equal(acct.firm_name, 'Tallo');
  assert.equal(acct.status, 'active', 'usable immediately — no payment step gates it');
  assert.equal(acct.billing_exempt, 1);

  const user = db.prepare('SELECT email, role FROM users WHERE id = ?').get(r.userId);
  assert.equal(user.email, 'owner@tallo.ph');
  assert.equal(user.role, 'owner');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='create_firm'").get());
});

test('createFirm: is idempotent — a known email never gets a second firm', () => {
  const db = freshDb();
  const first = C.createFirm(db, args('Tallo owner@tallo.ph'));
  const again = C.createFirm(db, args('Different owner@tallo.ph'));
  assert.equal(again.created, false);
  assert.equal(again.accountId, first.accountId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account').get().n, 1);
});

test('createFirm: separate firms are fully isolated from each other', () => {
  const db = freshDb();
  const a = C.createFirm(db, args('FirmA a@a.ph'));
  const b = C.createFirm(db, args('FirmB b@b.ph'));
  assert.notEqual(a.accountId, b.accountId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account').get().n, 2);
});

// ── billing exemption ────────────────────────────────────────────
test('an exempt firm is never billable, however many businesses it adds', () => {
  const db = freshDb();
  const r = C.createFirm(db, args('Ours owner@ours.ph'));
  const period = A.billingPeriodKey(Date.now());
  db.prepare('INSERT INTO businesses (account_id, manager_business_name, name) VALUES (?,?,?)')
    .run(r.accountId, 'Client One', 'Client One');
  S.recordBillingPeriod(db, 1, Date.now());

  assert.equal(S.billableCount(db, r.accountId, period), 0, 'our own firms are never invoiced');
});

test('a billable firm IS counted — exemption is per account, not global', () => {
  const db = freshDb();
  const ours = C.createFirm(db, args('Ours owner@ours.ph'));
  const paying = C.createFirm(db, args('Paying owner@paying.ph --billable'));
  const period = A.billingPeriodKey(Date.now());

  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (1,?,?,?)')
    .run(ours.accountId, 'Ours Client', 'Ours Client');
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (2,?,?,?)')
    .run(paying.accountId, 'Their Client', 'Their Client');
  S.recordBillingPeriod(db, 1, Date.now());
  S.recordBillingPeriod(db, 2, Date.now());

  assert.equal(S.billableCount(db, ours.accountId, period), 0);
  assert.equal(S.billableCount(db, paying.accountId, period), 1);
});
