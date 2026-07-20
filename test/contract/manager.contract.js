/* ============================================================
   Txform.ph — Manager contract test

   Runs against a LIVE Manager Server and asserts the handful of things
   the provisioner depends on. Manager updates often, and the parts we
   rely on are its login form and its user form — neither is a published
   API with a stability promise. When an upgrade moves one of them, the
   symptom would otherwise be access changes silently ceasing to apply.
   This turns that into a failing test.

   Run it AFTER every Manager upgrade:
     sudo -E env $(sudo cat /etc/txform/provisioner.env | xargs) \
       node --test test/contract/manager.contract.js

   Or via: npm run contract   (with the env already loaded)

   Skips itself when the credentials are absent, so `npm test` in CI or
   on a laptop stays green without a Manager to talk to.

   READ-ONLY. It creates nothing: on a live server holding real client
   books, a contract test that writes is a contract test nobody dares
   run — which defeats the purpose.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, businessOptionValue } = require('../../server/manager-client.js');

const BASE = process.env.MANAGER_URL || 'http://127.0.0.1:5000';
const USER = process.env.MANAGER_ADMIN_USER;
const PASS = process.env.MANAGER_ADMIN_PASS;
const ready = Boolean(USER && PASS);

const client = ready ? createClient({ baseUrl: BASE, username: USER, password: PASS }) : null;
const opts = { skip: ready ? false : 'MANAGER_ADMIN_USER / MANAGER_ADMIN_PASS not set' };

test('login: the two-step form still issues a session', opts, async () => {
  await client.login();
  assert.ok(client._jar().session, 'no session cookie — the login flow has changed');
});

test('session reaches api4 and the admin user list', opts, async () => {
  assert.equal((await client.get('/api4/businesses')).status, 200);
  assert.equal((await client.get('/users')).status, 200);
});

test('the new-user form still carries every field createUser posts', opts, async () => {
  const res = await client.get('/user-form');
  assert.equal(res.status, 200);
  ['Name', 'EmailAddress', 'Username', 'Password'].forEach(function (f) {
    assert.match(res.body, new RegExp('name="' + f + '"'), 'missing input: ' + f);
  });
  assert.match(res.body, /<select[^>]*name="Type"/, 'missing the Type select');
  assert.match(res.body, /<select[^>]*name="Businesses"/, 'missing the Businesses select — access lives here');
});

test('Type still offers Restricted — we must never create administrators', opts, async () => {
  const res = await client.get('/user-form');
  assert.match(res.body, /value="Restricted"/,
    'if this option is renamed, createUser would fall back to whatever Manager defaults to');
});

test('Businesses option values are still base64 of the business name', opts, async () => {
  // The whole grant/revoke mechanism is this encoding. If Manager ever
  // switches to real ids, every grant would post a value it does not
  // recognise — and would quietly grant nothing.
  const form = await client.get('/user-form');
  const block = /<select[^>]*name="Businesses"[\s\S]*?<\/select>/i.exec(form.body);
  assert.ok(block, 'no Businesses select');
  const pair = /<option[^>]*value="([^"]+)"[^>]*>([^<]+)</i.exec(block[0]);
  assert.ok(pair, 'no options — expected at least one business');
  assert.equal(pair[1], businessOptionValue(pair[2].trim()),
    'option value is no longer base64(name): ' + pair[2]);
});

test('api4 still documents creating a business by name', opts, async () => {
  const res = await client.get('/openapi/post-business.json');
  assert.equal(res.status, 200);
  const spec = JSON.parse(res.body);
  assert.ok(spec.paths && spec.paths['/api4/business'], 'POST /api4/business is gone');
  const schema = (spec.components && spec.components.schemas && spec.components.schemas.PostBusiness) || {};
  assert.ok(schema.properties && schema.properties.name, 'PostBusiness no longer takes a name');
});

test('an expired session is recovered automatically', opts, async () => {
  // Sessions expire on their own schedule; the provisioner must not need
  // a restart when they do.
  const fresh = createClient({ baseUrl: BASE, username: USER, password: PASS });
  await fresh.login();
  const res = await fresh.get('/api4/businesses');   // forces re-login internally if dropped
  assert.equal(res.status, 200);
});
