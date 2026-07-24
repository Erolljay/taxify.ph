/* ============================================================
   Txform.ph — server/dunning.js

   The non-payment sweep. Runs daily and walks each account's status
   through the lifecycle when a monthly invoice goes unpaid:

     active  --owes-->  grace  --deadline passes-->  suspended
        ^                  |                              |
        +---------- paid up (any time) ------------------+

   Enforcement itself is NOT here: the client entitlement gate
   (entitlement.php -> entitlement-core.gateForStatus) already turns
   'grace' into a warning and 'suspended' into a block, and does so live.
   This job only moves the authoritative status; flipping it back to
   'active' the moment the outstanding invoice is paid restores access
   instantly, with nothing to un-revoke. Reactivation for a returning
   owner is billing-service.reactivate (the portal "Pay now" button).

   The decision is billing-core.dunningTransition (pure, tested); this is
   the thin DB + email glue around it. Node built-ins only.

   Run daily via txform-dunning.timer, or by hand:
     node server/dunning.js [--dry-run] [--db PATH]
   ============================================================ */
'use strict';

const B = require('./billing-core.js');
// auth-service's top level requires only auth-core, so this is a plain
// require, not a cycle. Used to enqueue the provisioner disable/grant jobs
// that actually cut off / restore Books access.
const T = require('./auth-service.js');

// Does this account still owe? Any monthly invoice that is not paid — a
// pending one it never settled, or one whose Xendit page expired — counts.
// Restore only happens when NONE remain, so a firm with two missed months
// stays lapsed until both are cleared.
function hasUnpaidMonthlyInvoice(db, accountId) {
  return !!db.prepare(
    "SELECT 1 FROM billing_invoice WHERE account_id = ? AND kind = 'monthly' AND status != 'paid' LIMIT 1"
  ).get(accountId);
}

function ownerEmail(db, accountId) {
  const o = db.prepare(
    "SELECT email FROM users WHERE account_id = ? AND role = 'owner' AND status = 'active' ORDER BY id LIMIT 1"
  ).get(accountId);
  return o ? o.email : null;
}

// A live checkout link for the oldest thing this account owes, so a dunning
// email can point straight at payment. Falls back to the portal when the
// invoice has no usable page (expired) — the portal's Pay button re-issues.
function payLink(db, accountId, baseUrl) {
  const row = db.prepare(
    "SELECT invoice_url FROM billing_invoice WHERE account_id = ? AND kind = 'monthly' AND status = 'pending' AND invoice_url IS NOT NULL ORDER BY period_key ASC LIMIT 1"
  ).get(accountId);
  return (row && row.invoice_url) || ((baseUrl || 'https://txform.ph') + '/account');
}

// Apply one transition: write the status (+ grace deadline when it changes),
// audit it, and email the owner. Emails are fire-and-forget — a mail outage
// must not leave the status write half-done.
function applyTransition(db, account, t, now, deps) {
  if (Object.prototype.hasOwnProperty.call(t, 'graceUntil')) {
    const iso = t.graceUntil == null ? null : new Date(t.graceUntil).toISOString();
    db.prepare('UPDATE account SET status = ?, grace_until = ? WHERE id = ?').run(t.to, iso, account.id);
  } else {
    db.prepare('UPDATE account SET status = ? WHERE id = ?').run(t.to, account.id);
  }
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(account.id, 'dunning', 'account_' + t.to, 'from:' + account.status);

  // Hard enforcement in Manager: suspending strips the firm's owner+staff
  // from every client's books; restoring (paid up) re-grants them. Status
  // alone already gates the extension; this removes the underlying access.
  if (t.to === 'suspended') T.suspendManagerAccess(db, account.id, now);
  else if (t.to === 'active') T.restoreManagerAccess(db, account.id, now);

  const to = ownerEmail(db, account.id);
  if (!to || !deps.sendEmail) return;
  try {
    if (t.to === 'grace') {
      deps.sendEmail({ to: to, kind: 'past_due', link: payLink(db, account.id, deps.baseUrl), graceUntil: t.graceUntil });
    } else if (t.to === 'suspended') {
      deps.sendEmail({ to: to, kind: 'suspended', link: (deps.baseUrl || 'https://txform.ph') + '/account' });
    } else if (t.to === 'active') {
      deps.sendEmail({ to: to, kind: 'reactivated', link: (deps.baseUrl || 'https://txform.ph') + '/account' });
    }
  } catch (e) {
    console.error('[dunning] mail failed for', to, '-', e.message);
  }
}

// The sweep: evaluate every account that dunning can touch, apply any
// transition. holdSuspend is a single per-run flag (a filing deadline is
// near) so no firm is cut off right before it must file — injected via
// deps.isNearDeadline(now); absent = never hold.
function runDunning(db, deps, opts) {
  opts = opts || {};
  const now = deps.now();
  const graceDays = opts.graceDays || B.DUNNING_GRACE_DAYS;
  const holdSuspend = deps.isNearDeadline ? !!deps.isNearDeadline(now) : false;

  const accounts = db.prepare(
    "SELECT id, status, grace_until FROM account WHERE status IN ('active','grace','suspended') ORDER BY id"
  ).all();

  const results = [];
  accounts.forEach(function (a) {
    const owes = hasUnpaidMonthlyInvoice(db, a.id);
    const graceUntil = a.grace_until ? Date.parse(a.grace_until) : null;
    const t = B.dunningTransition(
      { status: a.status, graceUntil: graceUntil },
      { hasUnpaidInvoice: owes, now: now, graceDays: graceDays, holdSuspend: holdSuspend }
    );
    if (!t.to) { results.push({ accountId: a.id, status: a.status, change: null }); return; }
    if (opts.dryRun) { results.push({ accountId: a.id, from: a.status, to: t.to, dryRun: true }); return; }
    applyTransition(db, a, t, now, deps);
    results.push({ accountId: a.id, from: a.status, to: t.to });
  });

  return { holdSuspend: holdSuspend, considered: accounts.length, results: results };
}

module.exports = { hasUnpaidMonthlyInvoice, ownerEmail, payLink, applyTransition, runDunning };

// ── CLI (thin; not unit-tested — the logic above is) ──────────────
if (require.main === module) {
  const path = require('node:path');
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');

  const argv = process.argv.slice(2);
  const opts = { dryRun: false };
  let dbPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--db') dbPath = argv[++i];
    else { console.error('unknown option: ' + a); process.exit(1); }
  }

  dbPath = dbPath || process.env.TXFORM_DB || path.join(__dirname, 'txform.db');
  const db = new DatabaseSync(dbPath);
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  require('./migrate.js').migrate(db, schemaSql, console.log);

  const mailer = require('./smtp-mailer.js');
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const sendEmail = process.env.SMTP_HOST
    ? mailer.makeMailer({
        host: process.env.SMTP_HOST, port: smtpPort,
        user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
        from: process.env.SMTP_BILLING_FROM || 'Txform.ph Billing <billing@txform.ph>',
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtpPort === 465,
        ehloName: process.env.SMTP_EHLO || 'txform.ph',
      })
    : function (m) { console.log('[dunning] would email', m.to, m.kind); };

  const deps = {
    now: function () { return Date.now(); },
    baseUrl: process.env.TXFORM_BASE_URL || 'https://txform.ph',
    sendEmail: sendEmail,
  };

  const summary = runDunning(db, deps, opts);
  console.log('[dunning] considered ' + summary.considered + ' account(s)' + (summary.holdSuspend ? ' (suspensions held — filing deadline near)' : '') + (opts.dryRun ? ' (DRY RUN)' : ''));
  let moved = 0;
  summary.results.forEach(function (r) {
    if (r.to) { moved++; console.log('  account ' + r.accountId + ': ' + r.from + ' -> ' + r.to + (r.dryRun ? ' (dry run)' : '')); }
  });
  console.log('[dunning] done — ' + moved + ' transition(s)');
  process.exit(0);
}
