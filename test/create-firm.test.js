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

test('parseArgs: an account is billable by default — comping is explicit', () => {
  assert.equal(args('Firm a@b.ph').comp, null, 'the rules apply unless someone says otherwise');
  assert.equal(args('Firm a@b.ph --comp founder-firm').comp, 'founder-firm');
  assert.equal(args('Firm a@b.ph --comp beta --percent-off 50').percentOff, 50);
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

test('validate: a free account must carry a reason', () => {
  assert.match(C.validate(args('Firm a@b.ph --comp  ')), /reason/);
  assert.equal(C.validate(args('Firm a@b.ph --comp founder-firm')), null);
});

test('validate: --percent-off is meaningless without --comp, and must be 1..100', () => {
  assert.match(C.validate(args('Firm a@b.ph --percent-off 50')), /only means something/);
  assert.match(C.validate(args('Firm a@b.ph --comp x --percent-off 0')), /between 1 and 100/);
  assert.match(C.validate(args('Firm a@b.ph --comp x --percent-off 101')), /between 1 and 100/);
});

// ── creation ─────────────────────────────────────────────────────
test('createFirm: creates an ACTIVE account with an owner and an audit row', () => {
  const db = freshDb();
  const r = C.createFirm(db, args('Tallo owner@tallo.ph'));
  assert.equal(r.created, true);

  const acct = db.prepare('SELECT * FROM account WHERE id = ?').get(r.accountId);
  assert.equal(acct.firm_name, 'Tallo');
  assert.equal(acct.status, 'active', 'usable immediately — no payment step gates it');

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

// ── comping via voucher, NOT exemption ───────────────────────────
// The rule this whole section defends: a free firm still obeys every
// billing rule. It is counted, it is invoiced, and its total is zero for
// a stated reason — it does not sit outside the system.
function withOneBusiness(db, accountId, bizId, name) {
  db.prepare('INSERT INTO businesses (id, account_id, manager_business_name, name) VALUES (?,?,?,?)')
    .run(bizId, accountId, name, name);
  S.recordBillingPeriod(db, bizId, Date.now());
}

test('a comped firm is still COUNTED — it is not exempt from the rules', () => {
  const db = freshDb();
  const r = C.createFirm(db, args('Ours owner@ours.ph --comp founder-firm'));
  withOneBusiness(db, r.accountId, 1, 'Client One');
  assert.equal(S.billableCount(db, r.accountId, A.billingPeriodKey(Date.now())), 1,
    'counted like everyone else');
});

test('a comped firm gets a real invoice that totals zero, and says why', () => {
  const db = freshDb();
  const r = C.createFirm(db, args('Ours owner@ours.ph --comp founder-firm'));
  withOneBusiness(db, r.accountId, 1, 'Client One');

  const inv = S.invoiceFor(db, r.accountId, A.billingPeriodKey(Date.now()));
  assert.equal(inv.businesses, 1);
  assert.equal(inv.gross, A.RATE_CENTAVOS, 'the charge is real');
  assert.equal(inv.percentOff, 100);
  assert.equal(inv.net, 0, 'and fully discounted');
  assert.equal(inv.reason, 'founder-firm', 'a zero total is never a mystery');
});

test('a partial voucher discounts rather than zeroes', () => {
  const db = freshDb();
  const r = C.createFirm(db, args('Partner owner@partner.ph --comp beta-partner --percent-off 50'));
  withOneBusiness(db, r.accountId, 1, 'Client One');

  const inv = S.invoiceFor(db, r.accountId, A.billingPeriodKey(Date.now()));
  assert.equal(inv.discount, A.RATE_CENTAVOS / 2);
  assert.equal(inv.net, A.RATE_CENTAVOS / 2);
});

test('an ordinary firm pays the full rate — comping is per account', () => {
  const db = freshDb();
  const ours = C.createFirm(db, args('Ours owner@ours.ph --comp founder-firm'));
  const paying = C.createFirm(db, args('Paying owner@paying.ph'));
  withOneBusiness(db, ours.accountId, 1, 'Ours Client');
  withOneBusiness(db, paying.accountId, 2, 'Their Client');

  const period = A.billingPeriodKey(Date.now());
  assert.equal(S.invoiceFor(db, ours.accountId, period).net, 0);
  assert.equal(S.invoiceFor(db, paying.accountId, period).net, A.RATE_CENTAVOS);
});

test('grantDiscount refuses an unexplained free account', () => {
  const db = freshDb();
  const r = C.createFirm(db, args('Firm owner@firm.ph'));
  assert.throws(
    () => S.grantDiscount(db, r.accountId, { percentOff: 100, startsPeriod: '2026-07' }),
    /needs a reason/
  );
});
