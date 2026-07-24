/* ============================================================
   Tests for server/dunning.js — the non-payment sweep.
   In-memory DB, injected clock + capturing mailer.

     node --test test/dunning.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const D = require('../server/dunning.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
const NOW = Date.UTC(2026, 8, 20);
const DAY = 24 * 60 * 60 * 1000;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

let seq = 0;
// Seed an account with an owner and (optionally) an unpaid or paid monthly
// invoice, at a given status + grace deadline.
function seed(db, opts) {
  opts = opts || {};
  const id = Number(db.prepare(
    'INSERT INTO account (firm_name, firm_code, plan, status, seats_limit, businesses_limit, grace_until) VALUES (?,?,?,?,?,?,?)'
  ).run('Firm' + (++seq), 'CODE' + seq, 'firm', opts.status || 'active', 10, 100, opts.graceUntil || null).lastInsertRowid);
  db.prepare("INSERT INTO users (account_id, email, role) VALUES (?,?, 'owner')").run(id, 'owner' + id + '@x.ph');
  if (opts.invoice) {
    db.prepare(
      "INSERT INTO billing_invoice (account_id, external_id, kind, period_key, businesses, amount_centavos, status, invoice_url) VALUES (?,?, 'monthly', '2026-08', 1, 50000, ?, ?)"
    ).run(id, 'txf-monthly-' + id + '-2026-08', opts.invoice, opts.invoiceUrl || 'https://checkout.xendit.co/x' + id);
  }
  return id;
}

function fakeMailer() { const sent = []; return { sent: sent, send: function (m) { sent.push(m); } }; }
function makeDeps(over) {
  const mailer = (over && over.mailer) || fakeMailer();
  return {
    deps: { now: function () { return NOW; }, baseUrl: 'https://txform.ph', sendEmail: mailer.send, isNearDeadline: over && over.isNearDeadline },
    mailer: mailer,
  };
}
function statusOf(db, id) { return db.prepare('SELECT status, grace_until FROM account WHERE id=?').get(id); }

// ── active → grace ───────────────────────────────────────────────
test('runDunning: an active account with an unpaid invoice moves to grace + emails', () => {
  const db = freshDb();
  const { deps, mailer } = makeDeps();
  const id = seed(db, { status: 'active', invoice: 'pending' });

  D.runDunning(db, deps, {});
  const a = statusOf(db, id);
  assert.equal(a.status, 'grace');
  assert.equal(Date.parse(a.grace_until), NOW + 7 * DAY, 'a 7-day deadline is stamped');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].kind, 'past_due');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='account_grace'").get());
});

test('runDunning: an active, paid-up account is left alone', () => {
  const db = freshDb();
  const { deps, mailer } = makeDeps();
  const id = seed(db, { status: 'active', invoice: 'paid' });
  D.runDunning(db, deps, {});
  assert.equal(statusOf(db, id).status, 'active');
  assert.equal(mailer.sent.length, 0);
});

// ── grace → suspended ────────────────────────────────────────────
test('runDunning: grace suspends once the deadline passes', () => {
  const db = freshDb();
  const { deps, mailer } = makeDeps();
  const id = seed(db, { status: 'grace', graceUntil: new Date(NOW - DAY).toISOString(), invoice: 'pending' });
  D.runDunning(db, deps, {});
  assert.equal(statusOf(db, id).status, 'suspended');
  assert.equal(mailer.sent[0].kind, 'suspended');
});

test('runDunning: grace still within its window does not suspend', () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const id = seed(db, { status: 'grace', graceUntil: new Date(NOW + 2 * DAY).toISOString(), invoice: 'pending' });
  D.runDunning(db, deps, {});
  assert.equal(statusOf(db, id).status, 'grace');
});

test('runDunning: a near filing deadline holds off suspension', () => {
  const db = freshDb();
  const { deps } = makeDeps({ isNearDeadline: function () { return true; } });
  const id = seed(db, { status: 'grace', graceUntil: new Date(NOW - DAY).toISOString(), invoice: 'pending' });
  const summary = D.runDunning(db, deps, {});
  assert.equal(summary.holdSuspend, true);
  assert.equal(statusOf(db, id).status, 'grace', 'not cut off right before a deadline');
});

// ── restore on payment ───────────────────────────────────────────
test('runDunning: a suspended account whose invoice is now paid is restored', () => {
  const db = freshDb();
  const { deps, mailer } = makeDeps();
  const id = seed(db, { status: 'suspended', graceUntil: new Date(NOW - 5 * DAY).toISOString(), invoice: 'paid' });
  D.runDunning(db, deps, {});
  const a = statusOf(db, id);
  assert.equal(a.status, 'active');
  assert.equal(a.grace_until, null, 'deadline cleared');
  assert.equal(mailer.sent[0].kind, 'reactivated');
});

test('runDunning: an account two months behind stays lapsed until BOTH are paid', () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const id = seed(db, { status: 'suspended', invoice: 'paid' }); // Aug paid…
  db.prepare("INSERT INTO billing_invoice (account_id, external_id, kind, period_key, businesses, amount_centavos, status) VALUES (?,?, 'monthly', '2026-07', 1, 50000, 'pending')")
    .run(id, 'txf-monthly-' + id + '-2026-07'); // …but July still owed
  D.runDunning(db, deps, {});
  assert.equal(statusOf(db, id).status, 'suspended', 'one paid month is not enough');
});

// ── dry run ──────────────────────────────────────────────────────
test('runDunning: dry-run reports transitions but writes nothing', () => {
  const db = freshDb();
  const { deps, mailer } = makeDeps();
  const id = seed(db, { status: 'active', invoice: 'pending' });
  const summary = D.runDunning(db, deps, { dryRun: true });
  assert.equal(statusOf(db, id).status, 'active', 'unchanged');
  assert.equal(mailer.sent.length, 0);
  assert.equal(summary.results[0].to, 'grace', 'but the intended move is reported');
});
