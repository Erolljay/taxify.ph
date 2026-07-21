/* ============================================================
   Tests for server/manager-client.js — specifically, recognising
   that a session has expired.

   This exists because getting it wrong cost a live offboarding. Books
   redirects an unauthenticated request to the SITE ROOT, as an absolute
   url, not to /login. The client only matched a relative '/login'
   prefix, so it never re-authenticated: a `disable` job burned all three
   retries on "could not open the user form (http 302)" and left a
   removed person's access in place.

   That is the one direction that must not fail quietly — a grant that
   fails is a nuisance, a revoke that fails is someone still holding the
   client books.

     node --test test/manager-client.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, encodeForm, mergeCookies, cookieHeader, businessOptionValue, managerKeyParam } =
  require('../server/manager-client.js');

// No requests are made; only the pure helpers are exercised.
const client = createClient({ baseUrl: 'http://127.0.0.1:5000', username: 'u', password: 'p' });
const signedOut = (res) => client._isSignedOut(res);

// ── session expiry ───────────────────────────────────────────────
test('signed out: the ABSOLUTE redirect to root that Books actually sends', () => {
  // Observed live: GET /user-form -> 302 Location: http://127.0.0.1:5000/
  assert.equal(signedOut({ status: 302, location: 'http://127.0.0.1:5000/' }), true);
});

test('signed out: the same redirect via https and a real hostname', () => {
  // The host must not matter — only the path.
  assert.equal(signedOut({ status: 302, location: 'https://books.txform.ph/' }), true);
});

test('signed out: a relative redirect to root', () => {
  assert.equal(signedOut({ status: 302, location: '/' }), true);
});

test('signed out: redirects into the login flow', () => {
  assert.equal(signedOut({ status: 302, location: '/login' }), true);
  assert.equal(signedOut({ status: 302, location: '/login-password?Cgtwcm92aXNpb25lcg' }), true);
  assert.equal(signedOut({ status: 302, location: 'http://127.0.0.1:5000/login' }), true);
});

test('signed out: a plain 401', () => {
  assert.equal(signedOut({ status: 401 }), true);
});

// ── NOT signed out ───────────────────────────────────────────────
test('a successful login redirect is NOT signed out', () => {
  // The password step lands on /businesses. Treating that as expiry
  // would put the client in a login loop.
  assert.equal(signedOut({ status: 302, location: '/businesses' }), false);
  assert.equal(signedOut({ status: 302, location: 'http://127.0.0.1:5000/businesses' }), false);
});

test('an ordinary 200 is NOT signed out', () => {
  assert.equal(signedOut({ status: 200, body: '<form>' }), false);
});

test('a 500 is a failure, not an expiry — retrying the login would not help', () => {
  assert.equal(signedOut({ status: 500 }), false);
});

test('a 302 with no Location is not treated as expiry', () => {
  assert.equal(signedOut({ status: 302 }), false);
  assert.equal(signedOut({ status: 302, location: null }), false);
});

test('a malformed Location does not throw', () => {
  // Better to answer "not signed out" than to crash the provisioner.
  assert.doesNotThrow(() => signedOut({ status: 302, location: '::::not a url' }));
});

// ── encoding helpers ─────────────────────────────────────────────
test('managerKeyParam: the length-prefixed envelope Books uses in query keys', () => {
  assert.equal(managerKeyParam('provisioner'), 'Cgtwcm92aXNpb25lcg');
});

test('businessOptionValue: plain base64 — a DIFFERENT encoding from the query key', () => {
  // Two encodings in the same page. Confusing them is what made an
  // earlier grant read a blank form and report success.
  assert.equal(businessOptionValue('Demo Business'), 'RGVtbyBCdXNpbmVzcw==');
  assert.notEqual(businessOptionValue('Demo Business'), managerKeyParam('Demo Business'));
});

test('encodeForm: a multi-select repeats its key', () => {
  assert.equal(encodeForm({ Businesses: ['a', 'b'], Type: 'Restricted' }),
    'Businesses=a&Businesses=b&Type=Restricted');
});

test('mergeCookies / cookieHeader: keep only name=value, newest wins', () => {
  const jar = mergeCookies({}, ['session=abc; Path=/; HttpOnly', 'other=1; Path=/']);
  assert.equal(jar.session, 'abc');
  const updated = mergeCookies(jar, ['session=xyz; Path=/']);
  assert.equal(updated.session, 'xyz');
  assert.match(cookieHeader(updated), /session=xyz/);
});
