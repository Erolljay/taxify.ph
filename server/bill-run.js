/* ============================================================
   Txform.ph — server/bill-run.js

   The monthly billing job. Turns activation into recurring revenue:
   once a month it (1) rolls the current period so continuing clients are
   counted, then (2) issues each account's invoice for the PREVIOUS,
   now-complete month's high-water mark.

   Why in arrears: the price is per-business, high-water-mark, no
   proration — so a month's charge is only knowable once the month is
   over (a client added on the 20th still owes for that month). The
   activation charge at sign-up already covers the sign-up month, so the
   monthly run skips any period already paid — one charge per month, ever.

   Same discipline as the rest of this server:
     - decisions defer to the tested pure code (auth-core.computeInvoice /
       auth-service.invoiceFor, billing-core.externalId / previousPeriod);
     - money is centavos; the whole-peso figure is derived at the Xendit
       edge only;
     - Node built-ins only, so the git-pull deploy stays a file copy;
     - idempotent — external_id is unique per (account, period, kind) and
       every write guards on an already-covered check, so a re-run (or two
       timers firing) never double-charges.

   Run monthly via txform-bill-run.timer, or by hand:
     node server/bill-run.js [--roll YYYY-MM] [--bill YYYY-MM] [--dry-run] [--db PATH]
   ============================================================ */
'use strict';

const A = require('./auth-core.js');
const B = require('./billing-core.js');
const S = require('./auth-service.js'); // invoiceFor, billableCount, recordBillingPeriod

// Stamp every ACTIVE business with a billing-period row for `periodKey`, so
// clients that simply continue from month to month are counted in that
// month's high-water mark (adds during the month stamp their own row in
// addBusiness). Idempotent via the UNIQUE(business_id, period_key).
function rollBillingPeriod(db, periodKey) {
  const active = db.prepare("SELECT id FROM businesses WHERE status = 'active'").all();
  const ins = db.prepare('INSERT OR IGNORE INTO business_billing_period (business_id, period_key) VALUES (?,?)');
  let added = 0;
  active.forEach(function (b) { added += ins.run(b.id, periodKey).changes; });
  return { active: active.length, added: added };
}

// Is this account+period already settled — its activation charge, or a
// prior monthly run — so it must not be billed again? A paid OR pending
// invoice both count: a pending one means a payment page is already out,
// and issuing a second would be a duplicate charge.
function alreadyCovered(db, accountId, periodKey) {
  return !!db.prepare(
    "SELECT 1 FROM billing_invoice WHERE account_id = ? AND period_key = ? AND status IN ('paid','pending')"
  ).get(accountId, periodKey);
}

// Accounts that owe for `periodKey`: ACTIVE, with at least one business
// counted that month, and not already covered. A pending (never-activated)
// or suspended account is deliberately excluded — only live firms are billed.
function accountsToBill(db, periodKey) {
  const rows = db.prepare(
    `SELECT DISTINCT a.id
       FROM account a
       JOIN businesses b               ON b.account_id = a.id
       JOIN business_billing_period bp ON bp.business_id = b.id
      WHERE a.status = 'active' AND bp.period_key = ?
      ORDER BY a.id`
  ).all(periodKey);
  return rows.map(function (r) { return r.id; })
    .filter(function (id) { return !alreadyCovered(db, id, periodKey); });
}

// Bill one account for `periodKey`. Returns a small result describing what
// happened, so the run can be logged and a dry-run previewed. Never throws
// on a Xendit failure — it records the reason and moves on, so one bad
// account can't abort the whole month's billing; the next run retries it.
async function billAccount(db, accountId, periodKey, now, deps) {
  if (alreadyCovered(db, accountId, periodKey)) return { accountId: accountId, skipped: 'already_covered' };

  const invoice = S.invoiceFor(db, accountId, periodKey); // centavos + reason
  if (invoice.businesses === 0) return { accountId: accountId, skipped: 'nothing_billable' };

  const extId = B.externalId(accountId, periodKey, 'monthly');

  // Fully comped: a real invoice totalling zero, recorded paid with no
  // Xendit page — the account stays in the ledger, billed like everyone
  // else, it simply owes nothing. Same rule the activation path follows.
  if (invoice.net === 0) {
    db.prepare(
      `INSERT INTO billing_invoice
         (account_id, external_id, kind, period_key, businesses, amount_centavos, status, paid_at)
       VALUES (?,?, 'monthly', ?, ?, 0, 'paid', ?)
       ON CONFLICT(external_id) DO NOTHING`
    ).run(accountId, extId, periodKey, invoice.businesses, new Date(now).toISOString());
    db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
      .run(accountId, 'bill-run', 'bill_comped', 'period:' + periodKey + ' businesses:' + invoice.businesses + ' (' + (invoice.reason || 'comped') + ')');
    return { accountId: accountId, comped: true, businesses: invoice.businesses, period: periodKey };
  }

  // A real charge: create the Xendit invoice, record it pending, email the
  // owner the link. The owner is the payer of record.
  const owner = db.prepare(
    "SELECT email FROM users WHERE account_id = ? AND role = 'owner' AND status = 'active' ORDER BY id LIMIT 1"
  ).get(accountId);

  let inv;
  try {
    inv = await deps.xendit.createInvoice({
      externalId: extId,
      amountPesos: B.amountPesos(invoice.net),
      payerEmail: owner ? owner.email : (deps.billingEmail || 'billing@txform.ph'),
      description: invoice.businesses + (invoice.businesses === 1 ? ' client business' : ' client businesses') + ' — ' + periodKey + ' — Txform.ph',
      successRedirectUrl: deps.baseUrl + '/account?billing=paid',
      failureRedirectUrl: deps.baseUrl + '/account?billing=unpaid',
    });
  } catch (e) {
    console.error('[bill-run] Xendit invoice failed for account', accountId, 'period', periodKey, '-', e.message);
    return { accountId: accountId, error: e.message, period: periodKey };
  }

  db.prepare(
    `INSERT INTO billing_invoice
       (account_id, external_id, xendit_invoice_id, kind, period_key, businesses, amount_centavos, status, invoice_url)
     VALUES (?,?,?, 'monthly', ?, ?, ?, 'pending', ?)
     ON CONFLICT(external_id) DO UPDATE SET
       xendit_invoice_id = excluded.xendit_invoice_id,
       invoice_url       = excluded.invoice_url,
       businesses        = excluded.businesses,
       amount_centavos   = excluded.amount_centavos,
       status            = 'pending'`
  ).run(accountId, extId, inv.id, periodKey, invoice.businesses, invoice.net, inv.invoiceUrl);
  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(accountId, 'bill-run', 'bill_monthly', 'period:' + periodKey + ' businesses:' + invoice.businesses + ' net:' + invoice.net);

  if (owner && deps.sendEmail) {
    try {
      deps.sendEmail({ to: owner.email, kind: 'invoice', link: inv.invoiceUrl, amountCentavos: invoice.net, period: periodKey, businesses: invoice.businesses });
    } catch (e) {
      console.error('[bill-run] invoice mail failed for', owner.email, '-', e.message);
    }
  }
  return { accountId: accountId, charged: true, net: invoice.net, businesses: invoice.businesses, period: periodKey, invoiceUrl: inv.invoiceUrl };
}

// The whole run: roll the current month (default) so continuing clients are
// counted going forward, then bill the previous, now-complete month.
// opts: { rollPeriod?, billPeriod?, dryRun? } — periods override the
// now-derived defaults, for backfilling or testing.
async function runBillRun(db, deps, opts) {
  opts = opts || {};
  const now = deps.now();
  const thisPeriod = A.billingPeriodKey(now);
  const rollPeriod = opts.rollPeriod || thisPeriod;
  const billPeriod = opts.billPeriod || B.previousPeriod(thisPeriod);

  const rolled = rollBillingPeriod(db, rollPeriod);

  const ids = accountsToBill(db, billPeriod);
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (opts.dryRun) {
      const preview = S.invoiceFor(db, id, billPeriod);
      results.push({ accountId: id, wouldBill: preview.net, businesses: preview.businesses });
      continue;
    }
    results.push(await billAccount(db, id, billPeriod, now, deps)); // eslint-disable-line no-await-in-loop
  }

  return { rollPeriod: rollPeriod, billPeriod: billPeriod, rolled: rolled, accounts: ids.length, results: results };
}

module.exports = { rollBillingPeriod, alreadyCovered, accountsToBill, billAccount, runBillRun };

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
    if (a === '--roll') opts.rollPeriod = argv[++i];
    else if (a === '--bill') opts.billPeriod = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
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
        // Invoices come from a dedicated billing identity, not the hello@
        // address the auth service (sign-in, welcome, invites) sends from —
        // so a payment request reads as billing, and a client can reply to
        // an address that's actually about their bill. Overridable via
        // SMTP_BILLING_FROM. NOTE: the authenticated Workspace user (SMTP_USER)
        // must be allowed to "send mail as" this address, or Gmail rewrites it.
        from: process.env.SMTP_BILLING_FROM || 'Txform.ph Billing <billing@txform.ph>',
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtpPort === 465,
        ehloName: process.env.SMTP_EHLO || 'txform.ph',
      })
    : function (m) { console.log('[bill-run] would email', m.to, m.kind, m.link || ''); };

  const baseUrl = process.env.TXFORM_BASE_URL || 'https://txform.ph';
  const deps = {
    now: function () { return Date.now(); },
    baseUrl: baseUrl,
    xendit: require('./xendit-client.js').makeClient(process.env.XENDIT_SECRET_KEY || ''),
    sendEmail: sendEmail,
  };

  runBillRun(db, deps, opts).then(function (summary) {
    console.log('[bill-run] roll ' + summary.rollPeriod + ': ' + summary.rolled.added + ' new period rows (' + summary.rolled.active + ' active businesses)');
    console.log('[bill-run] bill ' + summary.billPeriod + ': ' + summary.accounts + ' account(s) to consider' + (opts.dryRun ? ' (DRY RUN)' : ''));
    let charged = 0, comped = 0, errors = 0, skipped = 0, wouldTotal = 0;
    summary.results.forEach(function (r) {
      if (r.charged) { charged++; console.log('  charged  account ' + r.accountId + '  ' + r.businesses + ' biz  net ' + r.net + 'c'); }
      else if (r.comped) { comped++; console.log('  comped   account ' + r.accountId + '  ' + r.businesses + ' biz  ₱0'); }
      else if (r.error) { errors++; console.log('  ERROR    account ' + r.accountId + '  ' + r.error); }
      else if (r.skipped) { skipped++; console.log('  skipped  account ' + r.accountId + '  ' + r.skipped); }
      else if (opts.dryRun) { wouldTotal += r.wouldBill; console.log('  would bill account ' + r.accountId + '  ' + r.businesses + ' biz  net ' + r.wouldBill + 'c'); }
    });
    console.log('[bill-run] done — charged ' + charged + ', comped ' + comped + ', skipped ' + skipped + ', errors ' + errors + (opts.dryRun ? '; would total ' + wouldTotal + 'c' : ''));
    process.exit(errors > 0 ? 1 : 0);
  }).catch(function (e) {
    console.error('[bill-run] fatal', e);
    process.exit(1);
  });
}
