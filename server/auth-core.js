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

// Convenience for glue: expiry timestamps from a clock.
function tokenExpiry(now) { return now + TOKEN_TTL_MS; }
function sessionExpiry(now) { return now + SESSION_TTL_MS; }

module.exports = {
  TOKEN_TTL_MS, SESSION_TTL_MS, LINK_RATE,
  hashToken, generateToken,
  isLoginTokenUsable, withinRateLimit, canProvisionMore,
  isSessionValid, authorizeOwnerAction,
  tokenExpiry, sessionExpiry,
};
