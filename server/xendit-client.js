/* ============================================================
   Txform.ph — server/xendit-client.js

   Thin Xendit REST client. The ONE place that speaks HTTP to Xendit,
   so the rest of the server deals in plain objects and billing-core's
   pure rules, never in transport details.

   Node built-ins only (node:https) — no npm, consistent with the rest of
   this server. The actual request function is injectable (deps.request),
   so billing-service and its tests exercise the create-invoice flow with
   a fake instead of the network; makeClient() wires the real https call.

   Auth is HTTP Basic with the secret key as the username and an empty
   password — Xendit's scheme. The key is passed in, never read from the
   environment here; wiring reads env once and hands it down.
   ============================================================ */
'use strict';

const https = require('node:https');

const XENDIT_HOST = 'api.xendit.co';

// Create a Xendit hosted invoice. Returns the fields we keep:
//   { id, invoiceUrl, status } — Xendit's id, the checkout page URL, and
// the initial status (PENDING). Throws on a non-2xx response or malformed
// body, with the status/message surfaced so the caller can log a real
// reason rather than a bare failure.
//
// params:
//   externalId            our idempotency key (billing-core.externalId)
//   amountPesos           whole pesos (billing-core.amountPesos)
//   payerEmail            prefills + receipts the invoice
//   description           shown on the hosted page
//   successRedirectUrl    where Xendit sends the payer after paying
//   failureRedirectUrl    where Xendit sends them on failure/expiry
async function createInvoice(deps, params) {
  const body = {
    external_id: params.externalId,
    amount: params.amountPesos,
    currency: 'PHP',
    payer_email: params.payerEmail,
    description: params.description,
    // Give the payer a reasonable window and a clean return trip. Xendit
    // caps invoice duration; 24h is ample for "sign up, then pay".
    invoice_duration: 86400,
    success_redirect_url: params.successRedirectUrl,
    failure_redirect_url: params.failureRedirectUrl,
  };

  const res = await deps.request({
    method: 'POST',
    host: XENDIT_HOST,
    path: '/v2/invoices',
    secretKey: deps.secretKey,
    body: body,
  });

  if (res.status < 200 || res.status >= 300) {
    const msg = (res.json && (res.json.message || res.json.error_code)) || ('HTTP ' + res.status);
    throw new Error('Xendit create-invoice failed: ' + msg);
  }
  const j = res.json || {};
  if (!j.id || !j.invoice_url) throw new Error('Xendit create-invoice returned an unexpected body');
  return { id: j.id, invoiceUrl: j.invoice_url, status: j.status || 'PENDING' };
}

// The real transport: a Basic-auth HTTPS JSON round-trip. Resolves to
// { status, json } and rejects only on a transport error — an HTTP error
// STATUS is data the caller inspects, not a thrown exception here.
function httpsRequest(opts) {
  return new Promise(function (resolve, reject) {
    const payload = opts.body ? JSON.stringify(opts.body) : '';
    const auth = Buffer.from(String(opts.secretKey || '') + ':').toString('base64');
    const req = https.request({
      method: opts.method,
      host: opts.host,
      path: opts.path,
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Bind a secret key into a ready-to-use client. The service calls
// client.createInvoice(params) and never sees the key or the transport.
function makeClient(secretKey) {
  const deps = { request: httpsRequest, secretKey: secretKey };
  return {
    createInvoice: function (params) { return createInvoice(deps, params); },
  };
}

module.exports = { createInvoice, makeClient, XENDIT_HOST };
