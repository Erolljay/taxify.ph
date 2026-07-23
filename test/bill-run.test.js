/* ============================================================
   Tests for server/bill-run.js — the monthly billing job.
   In-memory DB, injected clock + Xendit + mailer. No network.

     node --test test/bill-run.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const R = require('../server/bill-run.js');
const A = require('../server/auth-core.js');
const S = require('../server/auth-service.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
// 2026-08-10 → run bills the previous month, 2026-07.
const NOW = Date.UTC(2026, 7, 10);
const BILL = '2026-07';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

let seq = 0;
function seedAccount(db, opts) {
  opts = opts || {};
  const r = db.prepare(
    "INSERT INTO account (firm_name, firm_code, plan, status, seats_limit, businesses_limit) VALUES (?,?,?,?,?,?)"
  ).run(opts.firmName || ('Firm' + (++seq)), opts.firmCode || ('CODE' + seq), 'firm', opts.status || 'active', 10, 100);
  const accountId = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO users (account_id, email, role) VALUES (?,?, 'owner')")
    .run(accountId, opts.email || ('owner' + accountId + '@x.ph'));
  return accountId;
}

// Give an account `n` billable businesses for `period` (each gets a
// business row + a business_billing_period row).
function withBusinesses(db, accountId, n, period) {
  for (let i = 0; i < n; i++) {
    const bizId = Number(db.prepare(
      'INSERT INTO businesses (account_id, manager_business_name, name) VALUES (?,?,?)'
    ).run(accountId, 'B' + accountId + '_' + i + '_' + Math.random(), 'Client ' + i).lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO business_billing_period (business_id, period_key) VALUES (?,?)').run(bizId, period);
  }
}

function fakeXendit() {
  const calls = [];
  return {
    calls: calls,
    createInvoice: function (p) {
      calls.push(p);
      return Promise.resolve({ id: 'inv_' + calls.length, invoiceUrl: 'https://checkout.xendit.co/inv_' + calls.length, status: 'PENDING' });
    },
  };
}
function fakeMailer() { const sent = []; return { sent: sent, send: function (m) { sent.push(m); } }; }

function makeDeps(over) {
  const xendit = (over && over.xendit) || fakeXendit();
  const mailer = (over && over.mailer) || fakeMailer();
  return {
    deps: { now: function () { return NOW; }, baseUrl: 'https://txform.ph', xendit: xendit, sendEmail: mailer.send },
    xendit: xendit, mailer: mailer,
  };
}

// ── rollBillingPeriod ────────────────────────────────────────────
test('rollBillingPeriod: stamps every active business, and is idempotent', () => {
  const db = freshDb();
  const acct = seedAccount(db);
  db.prepare('INSERT INTO businesses (account_id, manager_business_name, name) VALUES (?,?,?)').run(acct, 'X1', 'X1');
  db.prepare('INSERT INTO businesses (account_id, manager_business_name, name, status) VALUES (?,?,?,?)').run(acct, 'X2', 'X2', 'archived');

  const first = R.rollBillingPeriod(db, '2026-08');
  assert.equal(first.active, 1, 'only the active business is rolled');
  assert.equal(first.added, 1);
  const again = R.rollBillingPeriod(db, '2026-08');
  assert.equal(again.added, 0, 'second roll adds nothing');
});

// ── accountsToBill ───────────────────────────────────────────────
test('accountsToBill: only active accounts with billable businesses, not yet covered', () => {
  const db = freshDb();
  const billable = seedAccount(db); withBusinesses(db, billable, 2, BILL);
  const pending = seedAccount(db, { status: 'pending' }); withBusinesses(db, pending, 1, BILL);
  const noBiz = seedAccount(db); // active, but nothing that month
  const covered = seedAccount(db); withBusinesses(db, covered, 1, BILL);
  // covered already has a paid activation invoice for the month
  db.prepare("INSERT INTO billing_invoice (account_id, external_id, kind, period_key, businesses, amount_centavos, status) VALUES (?,?, 'activation', ?, 1, 50000, 'paid')")
    .run(covered, 'txf-activation-' + covered + '-' + BILL, BILL);

  const ids = R.accountsToBill(db, BILL);
  assert.deepEqual(ids, [billable], 'pending, no-business, and already-covered accounts are excluded');
});

// ── billAccount ──────────────────────────────────────────────────
test('billAccount: charges a normal account — Xendit invoice, pending row, owner email', async () => {
  const db = freshDb();
  const { deps, xendit, mailer } = makeDeps();
  const acct = seedAccount(db, { email: 'boss@firm.ph' });
  withBusinesses(db, acct, 3, BILL);

  const r = await R.billAccount(db, acct, BILL, NOW, deps);
  assert.equal(r.charged, true);
  assert.equal(r.businesses, 3);
  assert.equal(r.net, 3 * A.RATE_CENTAVOS);

  assert.equal(xendit.calls.length, 1);
  assert.equal(xendit.calls[0].amountPesos, 1500, '3 × ₱500, whole pesos');
  assert.equal(xendit.calls[0].externalId, 'txf-monthly-' + acct + '-' + BILL);

  const inv = db.prepare('SELECT kind, status, amount_centavos FROM billing_invoice WHERE account_id=?').get(acct);
  assert.equal(inv.kind, 'monthly');
  assert.equal(inv.status, 'pending');
  assert.equal(inv.amount_centavos, 3 * A.RATE_CENTAVOS);

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].kind, 'invoice');
  assert.equal(mailer.sent[0].to, 'boss@firm.ph');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='bill_monthly'").get());
});

test('billAccount: a comped account gets a ₱0 PAID row and no Xendit charge', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const acct = seedAccount(db);
  withBusinesses(db, acct, 2, BILL);
  S.grantDiscount(db, acct, { percentOff: 100, reason: 'founder-firm', startsPeriod: BILL });

  const r = await R.billAccount(db, acct, BILL, NOW, deps);
  assert.equal(r.comped, true);
  assert.equal(xendit.calls.length, 0, 'a zero invoice never hits Xendit');
  const inv = db.prepare('SELECT status, amount_centavos FROM billing_invoice WHERE account_id=?').get(acct);
  assert.equal(inv.status, 'paid');
  assert.equal(inv.amount_centavos, 0);
});

test('billAccount: is idempotent — a second call does not double-charge', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const acct = seedAccount(db);
  withBusinesses(db, acct, 1, BILL);

  await R.billAccount(db, acct, BILL, NOW, deps);
  const again = await R.billAccount(db, acct, BILL, NOW, deps);
  assert.equal(again.skipped, 'already_covered');
  assert.equal(xendit.calls.length, 1, 'Xendit hit exactly once');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_invoice WHERE account_id=?').get(acct).n, 1);
});

test('billAccount: does NOT re-bill the month the activation charge already paid', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const acct = seedAccount(db);
  withBusinesses(db, acct, 1, BILL);
  db.prepare("INSERT INTO billing_invoice (account_id, external_id, kind, period_key, businesses, amount_centavos, status) VALUES (?,?, 'activation', ?, 1, 50000, 'paid')")
    .run(acct, 'txf-activation-' + acct + '-' + BILL, BILL);

  const r = await R.billAccount(db, acct, BILL, NOW, deps);
  assert.equal(r.skipped, 'already_covered');
  assert.equal(xendit.calls.length, 0);
});

test('billAccount: a Xendit failure is reported, not thrown, and writes no invoice row', async () => {
  const db = freshDb();
  const xendit = { calls: [], createInvoice: function () { return Promise.reject(new Error('xendit down')); } };
  const { deps } = makeDeps({ xendit: xendit });
  const acct = seedAccount(db);
  withBusinesses(db, acct, 1, BILL);

  const r = await R.billAccount(db, acct, BILL, NOW, deps);
  assert.equal(r.error, 'xendit down');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_invoice WHERE account_id=?').get(acct).n, 0, 'no half-written row to block a retry');
});

// ── runBillRun ───────────────────────────────────────────────────
test('runBillRun: rolls this month, bills last month, skips the activation month', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();

  // Account billed for last month (BILL): 2 businesses, active last month.
  const paying = seedAccount(db); withBusinesses(db, paying, 2, BILL);
  // Account that only signed up (activated) last month — already paid BILL.
  const justActivated = seedAccount(db); withBusinesses(db, justActivated, 1, BILL);
  db.prepare("INSERT INTO billing_invoice (account_id, external_id, kind, period_key, businesses, amount_centavos, status) VALUES (?,?, 'activation', ?, 1, 50000, 'paid')")
    .run(justActivated, 'txf-activation-' + justActivated + '-' + BILL, BILL);
  // A currently-active business (for the roll into THIS month, 2026-08).
  db.prepare('INSERT INTO businesses (account_id, manager_business_name, name) VALUES (?,?,?)').run(paying, 'LIVE', 'Live Co');

  const summary = await R.runBillRun(db, deps, {});
  assert.equal(summary.billPeriod, BILL);
  assert.equal(summary.rollPeriod, '2026-08');
  assert.ok(summary.rolled.added >= 1, 'the live business was rolled into this month');

  // Only the paying account was charged; the just-activated one was skipped.
  assert.equal(xendit.calls.length, 1);
  const charged = summary.results.find(function (r) { return r.charged; });
  assert.equal(charged.accountId, paying);
  assert.equal(charged.net, 2 * A.RATE_CENTAVOS);
});

test('runBillRun: dry-run previews without hitting Xendit or writing invoices', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const acct = seedAccount(db); withBusinesses(db, acct, 4, BILL);

  const summary = await R.runBillRun(db, deps, { dryRun: true });
  assert.equal(xendit.calls.length, 0, 'dry run charges nothing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_invoice').get().n, 0);
  const preview = summary.results.find(function (r) { return r.accountId === acct; });
  assert.equal(preview.wouldBill, 4 * A.RATE_CENTAVOS);
});
