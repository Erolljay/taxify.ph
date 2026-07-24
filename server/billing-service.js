/* ============================================================
   Txform.ph — server/billing-service.js

   Self-serve sign-up + Xendit checkout handlers. Same shape as
   auth-service.js: pure-ish functions (db, input, deps) → { status,
   json } so they test against an in-memory DB with an injected clock,
   an injected Xendit client, and an injected mailer — no network, no
   keys, no server boot.

   The flow (pay-first, no trial — the schema was built for exactly this):
     1. sign-up          create a PENDING account + owner, then a Xendit
                         hosted invoice for (chosen businesses × flat rate)
                         for the current month. Return its checkout URL.
     2. pay on Xendit    the payer completes payment on Xendit's page.
     3. webhook          Xendit calls us; we authenticate the callback,
                         mark the invoice paid, flip the account PENDING →
                         ACTIVE, and email the owner a magic sign-in link.
   Nothing is provisioned in Manager until step 3 — that is the whole point
   of the pending status.

   Decisions live in billing-core.js (validation, the charge, the
   idempotency key, webhook auth); transport lives in xendit-client.js.
   This file is the plumbing between them and the database.
   ============================================================ */
'use strict';

const A = require('./auth-core.js');
const B = require('./billing-core.js');

// Create (or resume) the activation invoice for a PENDING account and
// return its Xendit checkout URL. `businesses` is the account's chosen
// quantity — the source of truth is account.businesses_limit, so a resumed
// sign-up continues the original order rather than silently re-pricing it.
async function createActivationInvoice(db, accountId, businesses, email, now, deps, kind) {
  kind = kind || 'activation';
  const periodKey = A.billingPeriodKey(now);
  // 'resubscribe' gets its own external_id so it can never collide with (and
  // overwrite) the original 'activation' invoice from the same month.
  const extId = B.externalId(accountId, periodKey, kind);
  const amountCentavos = B.activationAmountCentavos(businesses);

  // Resume: a still-pending invoice for this account+month already has a
  // live Xendit page. Return it rather than minting a second charge — the
  // external_id is the idempotency anchor (see billing-core.externalId).
  const existing = db.prepare('SELECT invoice_url, status FROM billing_invoice WHERE external_id = ?').get(extId);
  if (existing && existing.status === 'pending' && existing.invoice_url) {
    return { status: 200, json: { ok: true, invoiceUrl: existing.invoice_url, ref: extId, resumed: true } };
  }

  const plural = businesses === 1 ? ' client business' : ' client businesses';
  let inv;
  try {
    inv = await deps.xendit.createInvoice({
      externalId: extId,
      amountPesos: B.amountPesos(amountCentavos),
      payerEmail: email,
      description: businesses + plural + ' × ₱' + (A.RATE_CENTAVOS / 100) + '/mo — Txform.ph',
      successRedirectUrl: deps.baseUrl + '/account?signup=success',
      failureRedirectUrl: (deps.signupUrl || (deps.baseUrl + '/signup.html')) + '?status=cancelled',
    });
  } catch (e) {
    // The account row exists (pending); they can retry and resume. Surface
    // a friendly reason, keep the technical one in the log.
    console.error('[signup] Xendit invoice failed for account', accountId, '-', e.message);
    return { status: 502, json: { error: 'payment_setup_failed', message: 'We couldn’t start checkout just now. Please try again in a moment.' } };
  }

  db.prepare(
    `INSERT INTO billing_invoice
       (account_id, external_id, xendit_invoice_id, kind, period_key, businesses, amount_centavos, status, invoice_url)
     VALUES (?,?,?,?,?,?,?, 'pending', ?)
     ON CONFLICT(external_id) DO UPDATE SET
       xendit_invoice_id = excluded.xendit_invoice_id,
       invoice_url       = excluded.invoice_url,
       businesses        = excluded.businesses,
       amount_centavos   = excluded.amount_centavos,
       status            = 'pending'`
  ).run(accountId, extId, inv.id, kind, periodKey, businesses, amountCentavos, inv.invoiceUrl);

  return { status: 201, json: { ok: true, invoiceUrl: inv.invoiceUrl, ref: extId } };
}

// POST /api/auth/sign-up { firmName, email, firmCode, businesses }
// Self-serve version of create-firm.js: makes a PENDING account and its
// owner, then hands back a Xendit checkout URL for the activation charge.
// The account provisions nothing until the payment webhook lands.
async function signUp(db, input, deps) {
  const now = deps.now();
  const check = B.validateSignup(input);
  if (!check.ok) return { status: 400, json: { error: 'invalid', fields: check.errors } };
  const v = check.value;

  // A known email never gets a second firm. If they abandoned checkout and
  // their account is still PENDING, resume it — otherwise send them to
  // sign-in rather than leaking whether/what account exists.
  const existingUser = db.prepare('SELECT account_id FROM users WHERE email = ?').get(v.email);
  if (existingUser) {
    const acct = db.prepare('SELECT id, status, businesses_limit FROM account WHERE id = ?').get(existingUser.account_id);
    if (acct && acct.status === 'pending') {
      return createActivationInvoice(db, acct.id, acct.businesses_limit, v.email, now, deps);
    }
    return { status: 409, json: { error: 'email_in_use', message: 'That email already has an account — please sign in instead.' } };
  }

  // Firm codes are permanent and prefix every business name in Manager, so
  // a taken one must fail loudly rather than collide later.
  const code = A.normalizeFirmCode(v.firmCode);
  const clash = db.prepare('SELECT id FROM account WHERE firm_code = ?').get(code);
  if (clash) return { status: 409, json: { error: 'code_taken', message: 'That firm code is taken. Please choose another.' } };

  const acct = db.prepare(
    `INSERT INTO account (firm_name, firm_code, plan, status, seats_limit, businesses_limit)
     VALUES (?, ?, 'firm', 'pending', ?, ?)`
  ).run(v.firmName, code, B.DEFAULT_SEATS_LIMIT, v.businesses);
  const accountId = Number(acct.lastInsertRowid);

  const user = db.prepare("INSERT INTO users (account_id, email, role) VALUES (?, ?, 'owner')").run(accountId, v.email);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(accountId, v.email, 'sign_up', 'account:' + accountId + ' owner:' + Number(user.lastInsertRowid) + ' ' + v.email);

  return createActivationInvoice(db, accountId, v.businesses, v.email, now, deps);
}

// Mint and email the owner a magic sign-in link, so a firm that just paid
// can get into the portal without a separate "request link" round-trip.
// Fire-and-forget, like the invite mail: a mail outage must not fail the
// activation, which is already committed.
function sendOwnerWelcome(db, accountId, now, deps) {
  const owner = db.prepare("SELECT email FROM users WHERE account_id = ? AND role = 'owner' AND status = 'active' ORDER BY id LIMIT 1").get(accountId);
  if (!owner || !deps.sendEmail) return;
  const raw = A.generateToken();
  db.prepare('INSERT INTO login_token (email, token_hash, expires_at, created_at, request_ip) VALUES (?,?,?,?,?)')
    .run(owner.email, A.hashToken(raw), A.tokenExpiry(now), now, 'signup');
  try {
    deps.sendEmail({
      to: owner.email,
      kind: 'welcome',
      link: (deps.baseUrl || 'https://txform.ph') + '/api/auth/verify?token=' + encodeURIComponent(raw),
    });
  } catch (e) {
    console.error('[signup] welcome mail failed for', owner.email, '-', e.message);
  }
}

// POST /api/billing/xendit-webhook  (called by Xendit, not a browser)
// Authenticates the callback token, then applies the payment: mark the
// invoice paid and flip the account PENDING → ACTIVE. Idempotent — Xendit
// retries webhooks, and a re-delivered PAID must not do anything twice.
//
// Always ACKs (200) once authenticated, even for an unknown invoice: a
// non-200 tells Xendit to retry, and retrying a callback we have nothing
// to do with is just noise. The one non-200 is a bad token — that is an
// attempt to forge a payment and must be rejected, loudly.
function xenditWebhook(db, input, deps) {
  if (!B.isWebhookAuthentic(input.token, deps.webhookToken)) {
    return { status: 401, json: { error: 'bad_token' } };
  }
  const body = input.body || {};
  const extId = body.external_id;
  if (!extId) return { status: 400, json: { error: 'no_external_id' } };

  const inv = db.prepare('SELECT id, account_id, businesses, status FROM billing_invoice WHERE external_id = ?').get(extId);
  if (!inv) return { status: 200, json: { ok: true, ignored: 'unknown_invoice' } };
  if (inv.status === 'paid') return { status: 200, json: { ok: true, alreadyApplied: true } };

  const now = deps.now();

  if (B.isPaidStatus(body.status)) {
    db.prepare("UPDATE billing_invoice SET status = 'paid', xendit_invoice_id = COALESCE(?, xendit_invoice_id), paid_at = ? WHERE id = ?")
      .run(body.id || null, new Date(now).toISOString(), inv.id);

    // Activate from pending (first-time sign-up) or cancelled (a resubscribe
    // payment). Never downgrade — a later webhook for an already-active
    // account must not disturb its status. A cancelled account also had a
    // team with grants, so bring their Books access back; a pending one is
    // brand new and provisions per-business as clients are added.
    const acct = db.prepare('SELECT id, status FROM account WHERE id = ?').get(inv.account_id);
    if (acct && (acct.status === 'pending' || acct.status === 'cancelled')) {
      const wasCancelled = acct.status === 'cancelled';
      db.prepare("UPDATE account SET status = 'active', grace_until = NULL, current_period_end = ? WHERE id = ?")
        .run(A.billingPeriodKey(now), acct.id);
      if (wasCancelled) require('./auth-service.js').restoreManagerAccess(db, acct.id, now);
      db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
        .run(acct.id, 'xendit-webhook', wasCancelled ? 'resubscribe_account' : 'activate_account', 'invoice:' + extId + ' businesses:' + inv.businesses);
      sendOwnerWelcome(db, acct.id, now, deps);
      return { status: 200, json: { ok: true, activated: true, resubscribed: wasCancelled } };
    }

    // A lapsed account (grace/suspended) paying its outstanding bill comes
    // straight back — but only once NOTHING monthly is still unpaid, so a
    // firm two months behind isn't restored by clearing just one. The
    // daily dunning sweep would also do this; doing it here makes the
    // return instant instead of up-to-a-day later.
    if (acct && (acct.status === 'grace' || acct.status === 'suspended')) {
      const stillOwes = db.prepare(
        "SELECT 1 FROM billing_invoice WHERE account_id = ? AND kind = 'monthly' AND status IN ('pending','expired') LIMIT 1"
      ).get(acct.id);
      if (!stillOwes) {
        db.prepare("UPDATE account SET status = 'active', grace_until = NULL WHERE id = ?").run(acct.id);
        // Bring their team's Books access back — the mirror of the suspend
        // that stripped it. Only matters if they'd reached 'suspended', but
        // it's safe (and idempotent) to run from grace too.
        require('./auth-service.js').restoreManagerAccess(db, acct.id, now);
        db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
          .run(acct.id, 'xendit-webhook', 'account_active', 'from:' + acct.status + ' paid:' + extId);
        return { status: 200, json: { ok: true, reactivated: true } };
      }
    }
    return { status: 200, json: { ok: true, paid: true } };
  }

  if (B.isExpiredStatus(body.status)) {
    db.prepare("UPDATE billing_invoice SET status = 'expired' WHERE id = ? AND status = 'pending'").run(inv.id);
    return { status: 200, json: { ok: true, expired: true } };
  }

  return { status: 200, json: { ok: true, noop: String(body.status || '') } };
}

// GET /api/billing/signup-status?ref=<external_id>
// The success page polls this: has the webhook landed and activated the
// account yet? Returns just the two statuses, nothing account-identifying.
function signupStatus(db, input) {
  const ref = input && input.ref;
  if (!ref) return { status: 400, json: { error: 'ref required' } };
  const inv = db.prepare('SELECT account_id, status FROM billing_invoice WHERE external_id = ?').get(ref);
  if (!inv) return { status: 404, json: { error: 'unknown' } };
  const acct = db.prepare('SELECT status FROM account WHERE id = ?').get(inv.account_id);
  return { status: 200, json: { invoice: inv.status, account: acct ? acct.status : null } };
}

// POST /api/billing/reactivate  (owner-only, cookie'd)
// The way back for a lapsed firm: a grace/suspended owner signs in, hits
// the portal's "Pay now", and this hands back a Xendit checkout URL for
// what they owe. Paying it fires the same webhook that flips them back to
// active — nothing here changes status, it only produces the payable link.
// Requiring loadSession from auth-service is safe: auth-service's top level
// pulls in only auth-core, so there is no require cycle.
async function reactivate(db, input, deps) {
  const now = deps.now();
  const authSvc = require('./auth-service.js');
  const s = authSvc.loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  if (s.role !== 'owner') return { status: 403, json: { error: 'not_owner' } };

  const acct = db.prepare('SELECT id, status FROM account WHERE id = ?').get(s.account_id);
  if (!acct) return { status: 404, json: { error: 'no_account' } };
  if (acct.status === 'active') return { status: 200, json: { ok: true, alreadyActive: true } };
  // Only a lapsed account reactivates here. A never-paid 'pending' account
  // goes back through sign-up/checkout, not this.
  if (acct.status !== 'grace' && acct.status !== 'suspended') {
    return { status: 409, json: { error: 'not_reactivatable', status: acct.status } };
  }

  // What they owe: the oldest unpaid monthly invoice.
  const owed = db.prepare(
    "SELECT id, external_id, period_key, businesses, amount_centavos, status, invoice_url FROM billing_invoice WHERE account_id = ? AND kind = 'monthly' AND status != 'paid' ORDER BY period_key ASC LIMIT 1"
  ).get(acct.id);

  // Nothing outstanding but not active — the data says they shouldn't be
  // lapsed at all. Restore rather than charge them for nothing.
  if (!owed) {
    db.prepare("UPDATE account SET status = 'active', grace_until = NULL WHERE id = ?").run(acct.id);
    authSvc.restoreManagerAccess(db, acct.id, now);
    db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
      .run(acct.id, s.email, 'account_active', 'reactivate: nothing owed');
    return { status: 200, json: { ok: true, reactivated: true } };
  }

  // A still-live Xendit page for that bill — reuse it, don't mint a second.
  if (owed.status === 'pending' && owed.invoice_url) {
    return { status: 200, json: { ok: true, invoiceUrl: owed.invoice_url, ref: owed.external_id, resumed: true } };
  }

  // Expired/failed page — raise a fresh invoice for the SAME period + amount,
  // keeping the external_id so the webhook still maps to this row.
  const plural = owed.businesses === 1 ? ' client business' : ' client businesses';
  let inv;
  try {
    inv = await deps.xendit.createInvoice({
      externalId: owed.external_id,
      amountPesos: B.amountPesos(owed.amount_centavos),
      payerEmail: s.email,
      description: owed.businesses + plural + ' — ' + owed.period_key + ' — Txform.ph (reactivate)',
      successRedirectUrl: deps.baseUrl + '/account?billing=paid',
      failureRedirectUrl: deps.baseUrl + '/account?billing=unpaid',
    });
  } catch (e) {
    console.error('[reactivate] Xendit invoice failed for account', acct.id, '-', e.message);
    return { status: 502, json: { error: 'payment_setup_failed', message: 'We couldn’t start checkout just now. Please try again in a moment.' } };
  }
  db.prepare("UPDATE billing_invoice SET status = 'pending', xendit_invoice_id = ?, invoice_url = ? WHERE id = ?")
    .run(inv.id, inv.invoiceUrl, owed.id);
  return { status: 200, json: { ok: true, invoiceUrl: inv.invoiceUrl, ref: owed.external_id } };
}

// POST /api/billing/cancel  (owner-only, cookie'd)
// Explicit self-serve churn: the owner stops their subscription. Billing
// stops (the bill-run and dunning both skip 'cancelled'), Books access is
// cut for the firm's people, and any outstanding bill is written off so a
// later resubscribe starts clean. NOTHING is deleted — clients, books, team
// and filed returns are preserved, and resubscribe brings it all back.
//
// No final/prorated charge: pricing has no proration, so cancelling forfeits
// the rest of the current (unbilled, in-arrears) month rather than billing it.
function cancelSubscription(db, input, deps) {
  const now = deps.now();
  const authSvc = require('./auth-service.js');
  const s = authSvc.loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  if (s.role !== 'owner') return { status: 403, json: { error: 'not_owner' } };

  const acct = db.prepare('SELECT id, status FROM account WHERE id = ?').get(s.account_id);
  if (!acct) return { status: 404, json: { error: 'no_account' } };
  if (acct.status === 'cancelled') return { status: 200, json: { ok: true, alreadyCancelled: true } };
  // A never-activated 'pending' account has no subscription to cancel — it
  // just abandons checkout. Only a live/lapsed one can be cancelled.
  if (acct.status !== 'active' && acct.status !== 'grace' && acct.status !== 'suspended') {
    return { status: 409, json: { error: 'not_cancellable', status: acct.status } };
  }

  db.prepare("UPDATE account SET status = 'cancelled', grace_until = NULL WHERE id = ?").run(acct.id);
  // Void any outstanding bill so a future resubscribe doesn't instantly
  // re-lapse on a debt they walked away from.
  db.prepare("UPDATE billing_invoice SET status = 'void' WHERE account_id = ? AND kind = 'monthly' AND status IN ('pending','expired')").run(acct.id);
  authSvc.suspendManagerAccess(db, acct.id, now);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(acct.id, s.email, 'cancel_account', 'from:' + acct.status);
  return { status: 200, json: { ok: true, cancelled: true } };
}

// POST /api/billing/resubscribe  (owner-only, cookie'd)
// The way back from an explicit cancel: a fresh activation charge for the
// current month, for the businesses the firm still has. Paying it runs the
// same webhook that reactivates the account and restores access.
async function resubscribe(db, input, deps) {
  const now = deps.now();
  const authSvc = require('./auth-service.js');
  const s = authSvc.loadSession(db, input.cookie, now);
  if (!s) return { status: 401, json: { error: 'not signed in' } };
  if (s.role !== 'owner') return { status: 403, json: { error: 'not_owner' } };

  const acct = db.prepare('SELECT id, status, businesses_limit FROM account WHERE id = ?').get(s.account_id);
  if (!acct) return { status: 404, json: { error: 'no_account' } };
  if (acct.status === 'active') return { status: 200, json: { ok: true, alreadyActive: true } };
  // Cancelled is the only state that resubscribes here. A lapsed (grace/
  // suspended) account pays its OUTSTANDING bill via reactivate instead.
  if (acct.status !== 'cancelled') return { status: 409, json: { error: 'not_cancelled', status: acct.status } };

  const businesses = Math.max(1, Number(acct.businesses_limit) || 1);
  return createActivationInvoice(db, acct.id, businesses, s.email, now, deps, 'resubscribe');
}

module.exports = { signUp, xenditWebhook, signupStatus, reactivate, cancelSubscription, resubscribe, createActivationInvoice, sendOwnerWelcome };
