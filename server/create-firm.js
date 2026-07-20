#!/usr/bin/env node
/* ============================================================
   Txform.ph — server/create-firm.js

   Creates a firm account and its owner. This is the back-office
   replacement for a self-serve sign-up flow: while every firm on the
   system is one we know personally, onboarding is a command we run,
   not a funnel strangers walk through.

   The owner signs in at https://txform.ph/account with a magic link —
   no password is set here, because none exists. From there they run
   their own firm: invite staff, add client businesses, set the access
   grid. Nothing else needs doing by hand.

   Usage:
     node server/create-firm.js "Firm Name" owner@firm.ph [options]

   Options:
     --businesses N   paid/allowed client businesses   (default 100)
     --seats N        owner+staff seats                (default 10)
     --comp "reason"  attach a 100%-off voucher with no end date, for the
                      reason given. The firm is still counted and still
                      invoiced — the invoice just totals zero, and says why.
                      There is no billing-exempt flag: the rules apply to
                      every account, and paying nothing is a discount.
     --percent-off N  use with --comp for a partial discount instead of 100
     --db PATH        override TXFORM_DB / the default location

   Exit codes: 0 created (or already existed), 1 bad usage / failure.
   ============================================================ */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const S = require('./auth-service.js');
const A = require('./auth-core.js');

// ── args ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const opts = { businesses: 100, seats: 10, comp: null, percentOff: 100, db: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--businesses') opts.businesses = Number(argv[++i]);
    else if (a === '--seats') opts.seats = Number(argv[++i]);
    else if (a === '--comp') opts.comp = argv[++i];
    else if (a === '--percent-off') opts.percentOff = Number(argv[++i]);
    else if (a === '--db') opts.db = argv[++i];
    else if (a.startsWith('--')) throw new Error('unknown option: ' + a);
    else positional.push(a);
  }
  opts.firmName = (positional[0] || '').trim();
  opts.email = (positional[1] || '').trim().toLowerCase();
  return opts;
}

function validate(opts) {
  if (!opts.firmName) return 'firm name is required';
  if (!opts.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(opts.email)) return 'a valid owner email is required';
  if (!Number.isInteger(opts.businesses) || opts.businesses < 1) return '--businesses must be a positive integer';
  if (!Number.isInteger(opts.seats) || opts.seats < 1) return '--seats must be a positive integer';
  if (opts.comp !== null && !String(opts.comp).trim()) return '--comp needs a reason ("founder firm", "beta partner", ...)';
  if (opts.comp !== null && (!Number.isInteger(opts.percentOff) || opts.percentOff < 1 || opts.percentOff > 100)) {
    return '--percent-off must be between 1 and 100';
  }
  if (opts.comp === null && opts.percentOff !== 100) return '--percent-off only means something with --comp';
  return null;
}

// ── the one write ─────────────────────────────────────────────────
// Idempotent: an email that already owns an account is reported and left
// alone rather than silently given a second firm.
function createFirm(db, opts) {
  const existing = db.prepare('SELECT id, account_id, role FROM users WHERE email = ?').get(opts.email);
  if (existing) return { created: false, userId: existing.id, accountId: existing.account_id, role: existing.role };

  const acct = db.prepare(
    `INSERT INTO account (firm_name, plan, status, seats_limit, businesses_limit)
     VALUES (?, 'firm', 'active', ?, ?)`
  ).run(opts.firmName, opts.seats, opts.businesses);
  const accountId = Number(acct.lastInsertRowid);

  const user = db.prepare("INSERT INTO users (account_id, email, role) VALUES (?, ?, 'owner')")
    .run(accountId, opts.email);
  const userId = Number(user.lastInsertRowid);

  db.prepare('INSERT INTO audit_log (account_id, actor, action, target) VALUES (?,?,?,?)')
    .run(accountId, 'admin-cli', 'create_firm', 'account:' + accountId + ' owner:' + userId + ' ' + opts.email);

  // A comped firm is discounted, never exempted — it stays inside the
  // billing rules and its zero invoice carries the reason.
  if (opts.comp) {
    S.grantDiscount(db, accountId, {
      percentOff: opts.percentOff,
      reason: opts.comp,
      startsPeriod: A.billingPeriodKey(opts.now || Date.now()),
      actor: 'admin-cli',
    });
  }

  return { created: true, userId: userId, accountId: accountId, role: 'owner' };
}

module.exports = { parseArgs, validate, createFirm };

// ── CLI ───────────────────────────────────────────────────────────
if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }

  const problem = validate(opts);
  if (problem) {
    console.error('Error: ' + problem + '\n');
    console.error('Usage: node server/create-firm.js "Firm Name" owner@firm.ph [--businesses N] [--seats N] [--billable]');
    process.exit(1);
  }

  const dbPath = opts.db || process.env.TXFORM_DB || path.join(__dirname, 'txform.db');

  let db;
  try {
    db = new DatabaseSync(dbPath);
    // Apply the schema exactly as the auth service does on boot, so this
    // works against a brand-new file instead of failing with a bare
    // "no such table: users". CREATE TABLE IF NOT EXISTS makes it a no-op
    // on an established database.
    db.exec(require('node:fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  } catch (e) {
    console.error('Error: could not open the database at ' + dbPath);
    console.error('  ' + e.message);
    console.error('\nCheck the path, and that you have permission to write it');
    console.error('(on the server the file is owned by www-data — use sudo).');
    process.exit(1);
  }

  const r = createFirm(db, opts);

  if (!r.created) {
    console.log('That email already has an account — nothing to do.');
    console.log('  email      : ' + opts.email);
    console.log('  account id : ' + r.accountId + '   role: ' + r.role);
    process.exit(0);
  }

  console.log('Created firm:');
  console.log('  firm       : ' + opts.firmName);
  console.log('  account id : ' + r.accountId);
  console.log('  owner      : ' + opts.email + '  (user ' + r.userId + ')');
  console.log('  limits     : ' + opts.seats + ' seats / ' + opts.businesses + ' businesses');
  console.log('  billing    : ' + (opts.comp
    ? opts.percentOff + '% voucher — "' + opts.comp + '" (still counted and invoiced; total ₱0)'
    : 'standard — ₱' + (A.RATE_CENTAVOS / 100) + ' per business per month'));
  console.log('\nNext: the owner signs in at https://txform.ph/account with their email');
  console.log('(magic link — no password). From there they add businesses and invite staff.');
}
