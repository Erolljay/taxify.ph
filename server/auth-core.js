/* ============================================================
   Txform.ph — server/auth-core.js

   Pure auth + tenancy-write decision logic. NO HTTP, NO SQLite, NO
   email — just the security rules: magic-link token lifecycle,
   sessions, request rate limiting, plan-limit checks, and owner
   authorization for tenancy writes.

   Server-side only (uses node:crypto). Kept as one tested module so
   the HTTP glue stays thin and these decisions — which gate who may
   sign in and who may grant access to a client's books — have exactly
   one implementation under test.
   ============================================================ */
'use strict';

const crypto = require('crypto');

const MINUTE = 60 * 1000;

// Magic links are single-use and short-lived.
const TOKEN_TTL_MS = 15 * MINUTE;
// Portal sessions.
const SESSION_TTL_MS = 14 * 24 * 60 * MINUTE;
// Link-request throttle: at most N per email within the window.
const LINK_RATE = { windowMs: 60 * MINUTE, max: 5 };

// Store only the hash of a token, never the raw value (same discipline
// as a password reset — a DB leak must not yield usable login links).
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// A high-entropy, URL-safe secret to embed in the emailed link.
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Is a login token usable right now? Enforces single-use + expiry.
// token = { expires_at:ms, consumed_at:ms|null } (or null if not found).
function isLoginTokenUsable(token, now) {
  if (!token) return { usable: false, reason: 'missing' };
  if (token.consumed_at != null) return { usable: false, reason: 'consumed' };
  if (now > token.expires_at) return { usable: false, reason: 'expired' };
  return { usable: true, reason: 'ok' };
}

// Allow another link request? recentTimestamps = ms of this email's
// prior requests. Blocks once `max` fall within `windowMs`.
function withinRateLimit(recentTimestamps, now, opts) {
  const windowMs = opts.windowMs;
  const cutoff = now - windowMs;
  const count = (recentTimestamps || []).filter(function (t) { return t > cutoff; }).length;
  return count < opts.max;
}

// May the account add one more of `kind` ('seat' | 'business')?
function canProvisionMore(kind, opts) {
  if (opts.currentCount < opts.limit) return { ok: true };
  return { ok: false, reason: kind + '_limit_reached' };
}

// Is a session still valid (present + unexpired)?
function isSessionValid(session, now) {
  if (!session) return false;
  return now <= session.expires_at;
}

// May this session perform an owner-only tenancy write on `account`?
// Checks, in order: session validity → owner role → same account
// (cross-tenant guard). Returns a typed reason on denial.
function authorizeOwnerAction(session, account, now) {
  if (!isSessionValid(session, now)) return { ok: false, reason: 'session_invalid' };
  if (session.role !== 'owner') return { ok: false, reason: 'not_owner' };
  if (session.account_id !== account.id) return { ok: false, reason: 'wrong_account' };
  return { ok: true };
}

// ── ROLE CAPABILITIES ────────────────────────────────────────────
// The permission matrix, in one place, so "what may a client do?" has a
// single answer rather than a role string compared in a dozen handlers.
//
//   manageFirm    — billing, businesses, invites, the access grid
//   file          — prepare a return and freeze it
//   amendFiling   — supersede an ALREADY-frozen filing. Owner only:
//                   unwinding a filed BIR return is a partner decision,
//                   and restricting it is what makes the audit log mean
//                   something.
//   allBusinesses — see every business in the firm without a grant.
//                   Staff and clients see only what user_business gives
//                   them; a client is granted exactly one.
const ROLE_CAPABILITIES = {
  owner:  { manageFirm: true,  file: true,  amendFiling: true,  allBusinesses: true },
  staff:  { manageFirm: false, file: true,  amendFiling: false, allBusinesses: false },
  client: { manageFirm: false, file: false, amendFiling: false, allBusinesses: false },
};

// Unknown roles get nothing — a typo in the DB must fail closed, never open.
function can(role, capability) {
  const caps = ROLE_CAPABILITIES[role];
  return !!(caps && caps[capability]);
}

// Roles that consume a paid seat. Clients are the business owners we're
// keeping books FOR, not staff of the firm, so they're free — their cost
// is already in their business's monthly rate.
function consumesSeat(role) { return role === 'owner' || role === 'staff'; }

// ── PRICING ──────────────────────────────────────────────────────
// One flat rate per business per month, VAT-registered or not. The rate
// deliberately does NOT vary by tax type: that is self-declared and
// unaudited, so a cheaper non-VAT tier would just be the new price.
//
// Centavos, always. Money never touches a float, and PayMongo takes
// minor units anyway.
const RATE_CENTAVOS = 50000; // ₱500.00

// Which discount applies in `periodKey`? Periods are 'YYYY-MM', so plain
// string comparison orders them correctly. When several overlap we take
// the single best one rather than stacking — stacked percentages are how
// you accidentally hand someone 130% off.
function discountPercentFor(discounts, periodKey) {
  let best = 0;
  (discounts || []).forEach(function (d) {
    if (periodKey < d.starts_period) return;
    if (d.ends_period && periodKey > d.ends_period) return;
    const pct = Math.max(0, Math.min(100, Number(d.percent_off) || 0));
    if (pct > best) best = pct;
  });
  return best;
}

// What does an account owe for a period? Returns minor units throughout.
// A 100%-discounted account still gets a real invoice here — count, gross,
// and a net of zero — rather than being skipped, so comped firms stay
// visible to every report instead of silently vanishing from billing.
function computeInvoice(businessCount, percentOff) {
  const count = Math.max(0, Number(businessCount) || 0);
  const pct = Math.max(0, Math.min(100, Number(percentOff) || 0));
  const gross = count * RATE_CENTAVOS;
  // Round the discount, not the net, so the two always sum back to gross.
  const discount = Math.round(gross * pct / 100);
  return { businesses: count, percentOff: pct, gross: gross, discount: discount, net: gross - discount };
}

// ── BILLING PERIODS ──────────────────────────────────────────────
// 'YYYY-MM' for a timestamp, in UTC. Billing is monthly and coarse, so
// a fixed zone beats guessing the server's — the only requirement is
// that the same instant always maps to the same key.
function billingPeriodKey(now) {
  const d = new Date(now);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// Convenience for glue: expiry timestamps from a clock.
function tokenExpiry(now) { return now + TOKEN_TTL_MS; }
function sessionExpiry(now) { return now + SESSION_TTL_MS; }

module.exports = {
  TOKEN_TTL_MS, SESSION_TTL_MS, LINK_RATE, ROLE_CAPABILITIES, RATE_CENTAVOS,
  hashToken, generateToken,
  isLoginTokenUsable, withinRateLimit, canProvisionMore,
  isSessionValid, authorizeOwnerAction, can, consumesSeat, billingPeriodKey,
  discountPercentFor, computeInvoice,
  tokenExpiry, sessionExpiry,
};
