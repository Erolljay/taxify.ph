/* ============================================================
   Tests for server/xendit-client.js — the thin Xendit REST client.
   The transport is injected, so these run with no network.

     node --test test/xendit-client.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const X = require('../server/xendit-client.js');

// A fake request() that records what it was called with and returns a
// scripted response, standing in for the real HTTPS round-trip.
function fakeRequest(response) {
  const calls = [];
  const request = function (opts) { calls.push(opts); return Promise.resolve(response); };
  return { request: request, calls: calls };
}

const OK_BODY = { id: 'inv_123', invoice_url: 'https://checkout.xendit.co/inv_123', status: 'PENDING' };
const goodParams = {
  externalId: 'txf-activation-7-2026-07',
  amountPesos: 2500,
  payerEmail: 'owner@firm.ph',
  description: '5 client businesses × ₱500 — July 2026',
  successRedirectUrl: 'https://txform.ph/account?signup=success',
  failureRedirectUrl: 'https://txform.ph/signup.html?status=cancelled',
};

test('createInvoice: posts to /v2/invoices with our key and the mapped body', async () => {
  const fake = fakeRequest({ status: 200, json: OK_BODY });
  const out = await X.createInvoice({ request: fake.request, secretKey: 'xnd_development_key' }, goodParams);

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v2/invoices');
  assert.equal(call.secretKey, 'xnd_development_key');
  assert.equal(call.body.external_id, 'txf-activation-7-2026-07');
  assert.equal(call.body.amount, 2500, 'whole pesos, not centavos');
  assert.equal(call.body.currency, 'PHP');
  assert.equal(call.body.payer_email, 'owner@firm.ph');
  assert.equal(call.body.success_redirect_url, goodParams.successRedirectUrl);

  assert.deepEqual(out, { id: 'inv_123', invoiceUrl: 'https://checkout.xendit.co/inv_123', status: 'PENDING' });
});

test('createInvoice: surfaces Xendit’s message on a non-2xx response', async () => {
  const fake = fakeRequest({ status: 400, json: { message: 'amount must be greater than 0' } });
  await assert.rejects(
    () => X.createInvoice({ request: fake.request, secretKey: 'k' }, goodParams),
    /amount must be greater than 0/
  );
});

test('createInvoice: rejects a 2xx body missing id or invoice_url', async () => {
  const fake = fakeRequest({ status: 200, json: { status: 'PENDING' } });
  await assert.rejects(
    () => X.createInvoice({ request: fake.request, secretKey: 'k' }, goodParams),
    /unexpected body/
  );
});

test('makeClient: binds the key so callers never see it', () => {
  const client = X.makeClient('xnd_development_secret');
  assert.equal(typeof client.createInvoice, 'function');
});
