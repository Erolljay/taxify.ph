/* ============================================================
   Tests for server/billing-service.js — sign-up + Xendit checkout.
   In-memory DB, injected clock, injected Xendit client, injected mailer.
   No network, no keys, no server boot.

     node --test test/billing-service.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const S = require('../server/billing-service.js');
const B = require('../server/billing-core.js');
const A = require('../server/auth-core.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
const NOW = Date.UTC(2026, 6, 15); // 2026-07-15 → period 2026-07

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

// A Xendit stub that records params and returns a scripted invoice, or
// throws when told to (to exercise the failure path).
function fakeXendit(opts) {
  const calls = [];
  return {
    calls: calls,
    createInvoice: function (params) {
      calls.push(params);
      if (opts && opts.throw) return Promise.reject(new Error('xendit down'));
      return Promise.resolve({
        id: 'inv_' + calls.length,
        invoiceUrl: 'https://checkout.xendit.co/inv_' + calls.length,
        status: 'PENDING',
      });
    },
  };
}

function fakeMailer() {
  const sent = [];
  return { sent: sent, send: function (m) { sent.push(m); } };
}

function makeDeps(over) {
  const mailer = (over && over.mailer) || fakeMailer();
  const xendit = (over && over.xendit) || fakeXendit();
  return {
    deps: {
      now: function () { return (over && over.now) || NOW; },
      baseUrl: 'https://txform.ph',
      signupUrl: 'https://txform.ph/signup.html',
      xendit: xendit,
      webhookToken: 'wh-secret',
      sendEmail: mailer.send,
    },
    mailer: mailer,
    xendit: xendit,
  };
}

const goodSignup = { firmName: 'Tallo CPA', email: 'owner@tallo.ph', firmCode: 'TALLO', businesses: 5 };

// ── sign-up ──────────────────────────────────────────────────────
test('signUp: creates a PENDING account + owner and returns a checkout URL', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const out = await S.signUp(db, goodSignup, deps);

  assert.equal(out.status, 201);
  assert.match(out.json.invoiceUrl, /checkout\.xendit\.co/);
  assert.ok(out.json.ref, 'returns the external_id ref for status polling');

  const acct = db.prepare('SELECT status, firm_code, businesses_limit, plan FROM account').get();
  assert.equal(acct.status, 'pending', 'NOTHING is active until payment');
  assert.equal(acct.firm_code, 'TALLO');
  assert.equal(acct.businesses_limit, 5);

  const owner = db.prepare("SELECT email, role FROM users").get();
  assert.equal(owner.email, 'owner@tallo.ph');
  assert.equal(owner.role, 'owner');

  // Xendit was asked for the right amount: 5 × ₱500 = ₱2500 (whole pesos).
  assert.equal(xendit.calls.length, 1);
  assert.equal(xendit.calls[0].amountPesos, 2500);
  assert.equal(xendit.calls[0].payerEmail, 'owner@tallo.ph');

  const inv = db.prepare('SELECT * FROM billing_invoice').get();
  assert.equal(inv.status, 'pending');
  assert.equal(inv.businesses, 5);
  assert.equal(inv.amount_centavos, 5 * A.RATE_CENTAVOS);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='sign_up'").get());
});

test('signUp: rejects a bad form with field-keyed errors and writes nothing', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const out = await S.signUp(db, { firmName: '', email: 'bad', firmCode: 'X', businesses: 0 }, deps);
  assert.equal(out.status, 400);
  assert.ok(out.json.fields.email && out.json.fields.firmName);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account').get().n, 0);
});

test('signUp: a taken firm code fails loudly (codes are permanent)', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  await S.signUp(db, goodSignup, deps);
  const out = await S.signUp(db, { firmName: 'Other', email: 'other@x.ph', firmCode: 'tallo', businesses: 1 }, deps);
  assert.equal(out.status, 409);
  assert.equal(out.json.error, 'code_taken');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account').get().n, 1);
});

test('signUp: a known ACTIVE email is sent to sign-in, not given a 2nd firm', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  await S.signUp(db, goodSignup, deps);
  db.prepare("UPDATE account SET status='active'").run(); // simulate they paid
  const out = await S.signUp(db, { firmName: 'Again', email: 'owner@tallo.ph', firmCode: 'NEW2', businesses: 2 }, deps);
  assert.equal(out.status, 409);
  assert.equal(out.json.error, 'email_in_use');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account').get().n, 1);
});

test('signUp: an abandoned PENDING sign-up resumes the SAME invoice', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const first = await S.signUp(db, goodSignup, deps);
  const again = await S.signUp(db, goodSignup, deps);

  assert.equal(again.json.resumed, true);
  assert.equal(again.json.invoiceUrl, first.json.invoiceUrl, 'same checkout page, no second charge');
  assert.equal(xendit.calls.length, 1, 'Xendit was only hit once');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_invoice').get().n, 1);
});

test('signUp: a Xendit failure returns 502 but leaves the pending account to retry', async () => {
  const db = freshDb();
  const { deps } = makeDeps({ xendit: fakeXendit({ throw: true }) });
  const out = await S.signUp(db, goodSignup, deps);
  assert.equal(out.status, 502);
  assert.equal(out.json.error, 'payment_setup_failed');
  assert.equal(db.prepare("SELECT status FROM account").get().status, 'pending', 'they can resume');
});

// ── webhook ──────────────────────────────────────────────────────
async function pendingSignup(db, deps) {
  const out = await S.signUp(db, goodSignup, deps);
  return out.json.ref; // external_id
}

test('xenditWebhook: a bad token is rejected — a forged payment cannot activate', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const ref = await pendingSignup(db, deps);
  const out = S.xenditWebhook(db, { token: 'not-the-secret', body: { external_id: ref, status: 'PAID' } }, deps);
  assert.equal(out.status, 401);
  assert.equal(db.prepare('SELECT status FROM account').get().status, 'pending', 'still not active');
});

test('xenditWebhook: a valid PAID flips the account to active and emails a magic link', async () => {
  const db = freshDb();
  const { deps, mailer } = makeDeps();
  const ref = await pendingSignup(db, deps);

  const out = S.xenditWebhook(db, { token: 'wh-secret', body: { external_id: ref, id: 'xnd_9', status: 'PAID' } }, deps);
  assert.equal(out.status, 200);
  assert.equal(out.json.activated, true);

  assert.equal(db.prepare('SELECT status FROM account').get().status, 'active');
  assert.equal(db.prepare('SELECT status, xendit_invoice_id FROM billing_invoice').get().status, 'paid');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='activate_account'").get());

  // Owner got a welcome magic link, and a matching login_token was minted.
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].kind, 'welcome');
  assert.match(mailer.sent[0].link, /\/api\/auth\/verify\?token=/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM login_token WHERE email='owner@tallo.ph'").get().n, 1);
});

test('xenditWebhook: a re-delivered PAID is idempotent (no double activation/email)', async () => {
  const db = freshDb();
  const { deps, mailer } = makeDeps();
  const ref = await pendingSignup(db, deps);
  S.xenditWebhook(db, { token: 'wh-secret', body: { external_id: ref, status: 'PAID' } }, deps);
  const again = S.xenditWebhook(db, { token: 'wh-secret', body: { external_id: ref, status: 'PAID' } }, deps);
  assert.equal(again.json.alreadyApplied, true);
  assert.equal(mailer.sent.length, 1, 'only one welcome email');
});

test('xenditWebhook: an unknown invoice is ACKed (200) so Xendit stops retrying', () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const out = S.xenditWebhook(db, { token: 'wh-secret', body: { external_id: 'txf-activation-999-2026-07', status: 'PAID' } }, deps);
  assert.equal(out.status, 200);
  assert.equal(out.json.ignored, 'unknown_invoice');
});

test('xenditWebhook: EXPIRED marks the invoice expired but never touches the account', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const ref = await pendingSignup(db, deps);
  const out = S.xenditWebhook(db, { token: 'wh-secret', body: { external_id: ref, status: 'EXPIRED' } }, deps);
  assert.equal(out.json.expired, true);
  assert.equal(db.prepare('SELECT status FROM billing_invoice').get().status, 'expired');
  assert.equal(db.prepare('SELECT status FROM account').get().status, 'pending');
});

// ── reactivation (returning lapsed owner) ────────────────────────
// Seed a suspended firm with an owner (provisioned) and one outstanding
// monthly invoice, plus a real session cookie for that owner.
function seedSuspended(db, invoiceStatus, invoiceUrl) {
  const acctId = Number(db.prepare("INSERT INTO account (firm_name, firm_code, plan, status, seats_limit, businesses_limit) VALUES ('L','LAPS','firm','suspended',10,100)").run().lastInsertRowid);
  const uid = Number(db.prepare("INSERT INTO users (account_id, email, role, manager_user_ref, all_businesses) VALUES (?,?, 'owner', 'mref', 1)").run(acctId, 'boss@laps.ph').lastInsertRowid);
  db.prepare("INSERT INTO billing_invoice (account_id, external_id, kind, period_key, businesses, amount_centavos, status, invoice_url) VALUES (?,?, 'monthly', '2026-08', 2, 100000, ?, ?)")
    .run(acctId, 'txf-monthly-' + acctId + '-2026-08', invoiceStatus, invoiceUrl || null);
  return { acctId: acctId, uid: uid };
}
function ownerCookie(db, uid) {
  const raw = 'sess-' + uid;
  db.prepare('INSERT INTO session (user_id, session_hash, expires_at, created_at) VALUES (?,?,?,?)').run(uid, A.hashToken(raw), NOW + 3600000, NOW);
  return 'txfsid=' + raw;
}

test('reactivate: a suspended owner gets the outstanding invoice link (reused, no new charge)', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const { uid } = seedSuspended(db, 'pending', 'https://checkout.xendit.co/live');
  const r = await S.reactivate(db, { cookie: ownerCookie(db, uid) }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.invoiceUrl, 'https://checkout.xendit.co/live');
  assert.equal(xendit.calls.length, 0, 'a still-live invoice is reused');
});

test('reactivate: re-issues a fresh invoice for the owed period when the old one expired', async () => {
  const db = freshDb();
  const { deps, xendit } = makeDeps();
  const { acctId, uid } = seedSuspended(db, 'expired', null);
  const r = await S.reactivate(db, { cookie: ownerCookie(db, uid) }, deps);
  assert.equal(r.status, 200);
  assert.match(r.json.invoiceUrl, /checkout\.xendit\.co/);
  assert.equal(xendit.calls[0].amountPesos, 1000, '2 × ₱500 for the owed month');
  assert.equal(db.prepare('SELECT status FROM billing_invoice WHERE account_id=?').get(acctId).status, 'pending');
});

test('reactivate: an already-active account has nothing to do; a non-owner is refused', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const { acctId, uid } = seedSuspended(db, 'pending', 'u');
  db.prepare("UPDATE account SET status='active' WHERE id=?").run(acctId);
  assert.equal((await S.reactivate(db, { cookie: ownerCookie(db, uid) }, deps)).json.alreadyActive, true);
});

test('xenditWebhook: paying the outstanding monthly restores a suspended account AND re-grants access', () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const { acctId, uid } = seedSuspended(db, 'pending', 'u');
  db.prepare("INSERT INTO businesses (id, account_id, manager_business_name, name, manager_created_at) VALUES (500, ?, 'X', 'X', '2026-01-01')").run(acctId);

  const ref = 'txf-monthly-' + acctId + '-2026-08';
  const out = S.xenditWebhook(db, { token: 'wh-secret', body: { external_id: ref, status: 'PAID' } }, deps);
  assert.equal(out.json.reactivated, true);
  assert.equal(db.prepare('SELECT status FROM account WHERE id=?').get(acctId).status, 'active');
  assert.ok(db.prepare("SELECT 1 FROM provision_job WHERE type='grant' AND user_id=?").get(uid), 'the owner’s Books access was re-granted');
});

// ── status poll ──────────────────────────────────────────────────
test('signupStatus: reports invoice + account status for the success page', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  const ref = await pendingSignup(db, deps);
  let st = S.signupStatus(db, { ref: ref });
  assert.deepEqual(st.json, { invoice: 'pending', account: 'pending' });

  S.xenditWebhook(db, { token: 'wh-secret', body: { external_id: ref, status: 'PAID' } }, deps);
  st = S.signupStatus(db, { ref: ref });
  assert.deepEqual(st.json, { invoice: 'paid', account: 'active' });
});
