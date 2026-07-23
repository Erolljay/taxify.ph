/* ============================================================
   Txform.ph — server/billing-core.js

   Pure sign-up + checkout decision logic. NO HTTP, NO SQLite, NO
   Xendit SDK — just the rules: what a self-serve sign-up must contain,
   what the activation charge is, the idempotency key each invoice
   carries, and how a payment webhook is authenticated and interpreted.

   Kept as one tested module (like auth-core.js) so the money-touching
   decisions have exactly one implementation under test, and the HTTP +
   Xendit glue in billing-service.js / xendit-client.js stays thin.

   Money is integer centavos everywhere, as in auth-core. The whole-peso
   figure Xendit wants is DERIVED at the edge (amountPesos), never stored.
   ============================================================ */
'use strict';

const crypto = require('crypto');
const A = require('./auth-core.js');

// A firm signs up choosing how many client businesses it starts with.
// One is the floor (paying for zero makes no sense); the ceiling is an
// anti-fluke guard, not a real limit — a 900-client firm is a phone call,
// not a self-serve checkout.
const MIN_SIGNUP_BUSINESSES = 1;
const MAX_SIGNUP_BUSINESSES = 500;

// A generous owner+staff seat ceiling for a self-serve firm. Seats are an
// anti-abuse cap, not a priced quantity (only businesses are billed), so
// this is deliberately roomy; the owner can ask for more by hand.
const DEFAULT_SEATS_LIMIT = 10;

// ── SIGN-UP VALIDATION ────────────────────────────────────────────
// Validate and normalise a self-serve sign-up. Returns either
//   { ok:true, value:{ firmName, email, firmCode, businesses } }
// or { ok:false, errors:{ field: message, ... } } — field-keyed so the
// sign-up form can show each message against its own input rather than a
// single opaque banner. Mirrors create-firm.validate, but web-shaped.
function validateSignup(input) {
  const errors = {};
  const firmName = (input && typeof input.firmName === 'string') ? input.firmName.trim() : '';
  const email = (input && typeof input.email === 'string') ? input.email.trim().toLowerCase() : '';
  const rawCode = (input && typeof input.firmCode === 'string') ? input.firmCode.trim() : '';
  // Coerce first: an omitted/blank quantity should read as "not chosen"
  // and get the friendly message, not NaN slipping through a comparison.
  const businesses = Number(input && input.businesses);

  if (!firmName) errors.firmName = 'Your firm name is required.';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!rawCode) errors.firmCode = 'A firm code is required — it prefixes every client’s books.';
  else if (!A.isValidFirmCode(rawCode)) errors.firmCode = 'Use 2–12 letters or digits only, e.g. TALLO.';

  if (!Number.isInteger(businesses) || businesses < MIN_SIGNUP_BUSINESSES) {
    errors.businesses = 'Choose at least one client business.';
  } else if (businesses > MAX_SIGNUP_BUSINESSES) {
    errors.businesses = 'That’s more than ' + MAX_SIGNUP_BUSINESSES + ' — contact us and we’ll set you up directly.';
  }

  if (Object.keys(errors).length) return { ok: false, errors: errors };
  return { ok: true, value: { firmName: firmName, email: email, firmCode: rawCode, businesses: businesses } };
}

// ── ACTIVATION CHARGE ─────────────────────────────────────────────
// What a firm pays to activate: the current month at the flat rate for
// the quantity it chose. No discount is applied at sign-up — vouchers are
// an account-level, ongoing thing granted deliberately (see auth-core /
// grantDiscount), and they take effect on the monthly bill-runs, not on
// the self-serve activation charge. Returns centavos.
function activationAmountCentavos(businesses) {
  const n = Math.max(0, Number(businesses) || 0);
  return n * A.RATE_CENTAVOS;
}

// Xendit's invoice `amount` is in the currency's MAIN unit (whole pesos
// for PHP), while everything here is centavos. The rate is a whole number
// of pesos, so this division is always exact; guard it anyway rather than
// silently shipping a fractional amount if that ever stops being true.
function amountPesos(centavos) {
  const c = Math.max(0, Number(centavos) || 0);
  if (c % 100 !== 0) throw new Error('amount is not a whole number of pesos: ' + c + ' centavos');
  return c / 100;
}

// ── IDEMPOTENCY KEY ───────────────────────────────────────────────
// The key one invoice carries, deterministic in (account, period, kind).
// Sent to Xendit as external_id and stored on billing_invoice.external_id.
// Deterministic so a reloaded pay page or a retried create maps to the
// SAME invoice instead of minting a second charge for the same month.
function externalId(accountId, periodKey, kind) {
  return 'txf-' + (kind || 'activation') + '-' + accountId + '-' + periodKey;
}

// ── WEBHOOK AUTHENTICATION ────────────────────────────────────────
// Xendit signs invoice callbacks with a static token in the
// `x-callback-token` header, matched against the token we set in the
// dashboard (XENDIT_WEBHOOK_TOKEN). No token configured ⇒ never authentic:
// a webhook endpoint that fails OPEN would let anyone flip an account to
// paid, so a missing secret must reject, not wave through.
function isWebhookAuthentic(receivedToken, expectedToken) {
  if (!expectedToken || !receivedToken) return false;
  const a = Buffer.from(String(receivedToken));
  const b = Buffer.from(String(expectedToken));
  // Constant-time compare, and length-guarded — timingSafeEqual throws on
  // a length mismatch, which would itself leak length via the exception.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Xendit invoice statuses that mean "money is in": PAID and SETTLED. An
// invoice can also be PENDING or EXPIRED, which activate nothing.
function isPaidStatus(status) {
  const s = String(status || '').toUpperCase();
  return s === 'PAID' || s === 'SETTLED';
}

function isExpiredStatus(status) {
  return String(status || '').toUpperCase() === 'EXPIRED';
}

// ── BILLING PERIODS ───────────────────────────────────────────────
// The month before `periodKey` ('YYYY-MM'). The monthly bill-run charges
// in arrears — on the 1st of month M it bills the now-complete M-1 — so it
// needs the previous key, and January must roll the year back.
function previousPeriod(periodKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ''));
  if (!m) throw new Error('bad period key: ' + periodKey);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return prevYear + '-' + String(prevMonth).padStart(2, '0');
}

module.exports = {
  MIN_SIGNUP_BUSINESSES, MAX_SIGNUP_BUSINESSES, DEFAULT_SEATS_LIMIT,
  validateSignup, activationAmountCentavos, amountPesos, externalId,
  isWebhookAuthentic, isPaidStatus, isExpiredStatus, previousPeriod,
};
