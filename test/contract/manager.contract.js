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
const P = require('../../server/manager-permissions.js');
const T = require('../../server/manager-tabs.js');
const V = require('../../server/manager-vue-form.js');
const E = require('../../server/manager-extension.js');
const C = require('../../server/manager-coa.js');

const BASE = process.env.MANAGER_URL || 'http://127.0.0.1:5000';
const USER = process.env.MANAGER_ADMIN_USER;
const PASS = process.env.MANAGER_ADMIN_PASS;
const ready = Boolean(USER && PASS);

const client = ready ? createClient({ baseUrl: BASE, username: USER, password: PASS }) : null;
const opts = { skip: ready ? false : 'MANAGER_ADMIN_USER / MANAGER_ADMIN_PASS not set' };

// ── a business to inspect ────────────────────────────────────────────
// The business-scoped screens (User Permissions, Tabs) only exist inside
// a business, so these checks need one to look at. ANY will do — every
// check below is a GET. Override with MANAGER_CONTRACT_BUSINESS to pin
// it to a throwaway; otherwise the first business Manager lists.
//
// Resolved once and cached, so the whole file costs one extra request.
let businessPromise = null;
function someBusiness() {
  if (!businessPromise) {
    businessPromise = (async function () {
      if (process.env.MANAGER_CONTRACT_BUSINESS) return process.env.MANAGER_CONTRACT_BUSINESS;
      const res = await client.get('/api4/businesses');
      const parsed = JSON.parse(res.body);
      const list = parsed.businesses || parsed || [];
      const name = (list[0] || {}).name;
      assert.ok(name, 'no businesses on this server — cannot check the business-scoped screens');
      return name;
    })();
  }
  return businessPromise;
}

// Settings is where both walks start, so most checks below need it.
async function settingsBody() {
  const name = await someBusiness();
  const res = await client.get(P.settingsPath(name));
  assert.equal(res.status, 200, 'Settings did not load for ' + JSON.stringify(name));
  return res.body;
}

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

test('the extension resource still lists per business, scoped by the header', opts, async () => {
  // The custom-button step (manager-extension.js) reads and writes /api4/
  // extension, scoping each call with the Manager-Business header exactly
  // as Manager's own api-proxy.js does. If either the resource or that
  // header contract changed, the provisioner would stop installing the
  // Txform Now! button on new clients. READ-ONLY: lists, creates nothing.
  const name = await someBusiness();
  const path = E.EXTENSION_BATCH + '?business=' + encodeURIComponent(name) + '&Skip=0&PageSize=200';
  const res = await client.get(path, { 'Manager-Business': encodeURIComponent(name) });
  assert.equal(res.status, 200, '/api4/extension-batch did not list for ' + JSON.stringify(name));
  // Parses as the { items: [...] } shape the driver's idempotency check reads.
  assert.doesNotThrow(function () { E.parseExtensions(res.body); },
    'the extension list is no longer the { items: [{ item }] } shape');
});

test('the chart-of-accounts template exists and its batch collections read', opts, async () => {
  // The copy_chart_of_accounts step (manager-coa.js) reads these five
  // collections from the template business and PUTs them to a new client.
  // If the template were renamed/deleted, or a collection's batch path
  // changed, provisioning would stop copying the firm's accounts. READ-ONLY:
  // lists the template, writes nothing.
  const template = process.env.MANAGER_COA_TEMPLATE || C.TEMPLATE_BUSINESS;
  const businesses = JSON.parse((await client.get('/api4/businesses')).body).businesses || [];
  assert.ok(businesses.some(function (b) { return b.name === template; }),
    'the COA template business ' + JSON.stringify(template) + ' is not on this server'
    + ' — set MANAGER_COA_TEMPLATE or fix TEMPLATE_BUSINESS in manager-coa.js');

  let total = 0;
  for (const path of C.COA_COLLECTIONS) {
    const res = await client.get(C.batchGetPath(path, template, 0), { 'Manager-Business': encodeURIComponent(template) });
    assert.equal(res.status, 200, path + ' did not read for the template');
    total += C.parseBatchItems(res.body).length;   // also asserts the { items } shape parses
  }
  assert.ok(total > 0, 'the COA template ' + JSON.stringify(template) + ' has no accounts to copy');
});

test('an expired session is recovered automatically', opts, async () => {
  // Sessions expire on their own schedule; the provisioner must not need
  // a restart when they do.
  const fresh = createClient({ baseUrl: BASE, username: USER, password: PASS });
  await fresh.login();
  const res = await fresh.get('/api4/businesses');   // forces re-login internally if dropped
  assert.equal(res.status, 200);
});

// ══════════════════════════════════════════════════════════════════════
//  The business-scoped screens: User Permissions and Tabs
//
//  Both are Vue forms the driver reaches by FOLLOWING Manager's own
//  links rather than building URLs (field 250 of a record key is a
//  destructive flag — see manager-vue-form.js). So the first thing that
//  can break is a link disappearing from the sidebar, and the second is
//  a model key being renamed. Neither would raise an error at run time:
//  the provisioner would just stop configuring new books, or stop
//  granting Full access, while reporting every job done.
//
//  All READ-ONLY. Opening the blank "New User Permissions" form creates
//  nothing, exactly as GET /user-form creates no user.
// ══════════════════════════════════════════════════════════════════════

test('the Settings sidebar still carries both links the driver follows', opts, async () => {
  const body = await settingsBody();
  assert.ok(V.findHref(body, P.PERMISSIONS_LIST),
    'no /user-permissions link — grantAccess could not reach the permissions record');
  assert.ok(V.findHref(body, T.TABS_FORM),
    'no /tabs-form (Customize) link — configureTabs could not reach the Tabs form');
});

test('the Tabs form still names every tab the firm turns on', opts, async () => {
  // A renamed key is the silent failure that matters here: applyTabs
  // throws on an unknown tab, so the job would fail loudly — but only
  // once a business is created. This catches it at upgrade time instead.
  const href = V.findHref(await settingsBody(), T.TABS_FORM);
  const res = await client.get(href);
  assert.equal(res.status, 200);

  const model = V.parseVueModel(res.body);
  T.REQUIRED_TABS.forEach(function (tab) {
    assert.ok(tab in model, 'the Tabs model no longer has "' + tab + '"');
    assert.equal(typeof model[tab], 'boolean', '"' + tab + '" is no longer a boolean');
  });
  assert.ok('id' in model, 'the Tabs model has no id — a re-post would not address the record');
});

test('Manager still hides child tabs behind their parents, as PARENTS assumes', opts, async () => {
  // The hierarchy is not ours; it is Manager's, expressed as getIf*
  // guards on the form. If it changed, ticking (say) Payslips without
  // Employees would save a setting that never appears in the sidebar.
  const href = V.findHref(await settingsBody(), T.TABS_FORM);
  const body = (await client.get(href)).body;

  Object.keys(T.PARENTS).forEach(function (child) {
    const guard = new RegExp('getIf' + child + ':\\s*function[^}]*?get' + T.PARENTS[child] + '\\b');
    if (!guard.test(body)) {
      assert.fail('Manager no longer gates "' + child + '" behind "' + T.PARENTS[child]
        + '" — PARENTS in manager-tabs.js is out of date');
    }
  });
});

test('the User Permissions list still offers a way to add a record', opts, async () => {
  // A user with no record needs the New link; without it a first grant
  // has nowhere to go.
  const href = V.findHref(await settingsBody(), P.PERMISSIONS_LIST);
  const res = await client.get(href);
  assert.equal(res.status, 200);
  assert.ok(P.findNewPermissionHref(res.body),
    'no "New User Permissions" link — a user without a record could never be granted one');
  // Rows are allowed to be zero (a fresh business has none); what must
  // hold is that parsing does not throw and returns a well-formed list.
  P.parsePermissionRows(res.body).forEach(function (row) {
    assert.ok(row.username, 'a permissions row parsed with no username');
    assert.ok(row.href, 'a permissions row parsed with no Edit link');
  });
});

test('Access type still offers Full access as 1', opts, async () => {
  // The label is what a human reads; 1 is what we post. If Manager
  // renumbered these, every grant would quietly set Custom access —
  // books the staff member can open and not work in.
  const list = V.findHref(await settingsBody(), P.PERMISSIONS_LIST);
  const newHref = P.findNewPermissionHref((await client.get(list)).body);
  const res = await client.get(newHref);          // blank form; creates nothing
  assert.equal(res.status, 200);

  assert.match(res.body, /<option value="1">Full access<\/option>/,
    'Full access is no longer option value 1');
  assert.match(res.body, /<option value="0">Custom access<\/option>/,
    'Custom access is no longer option value 0');
  assert.equal(P.ACCESS_FULL, 1, 'ACCESS_FULL drifted from the value Manager posts');

  const model = V.parseVueModel(res.body);
  ['Username', 'AccessType', 'Namespaces', 'FullAccess'].forEach(function (k) {
    assert.ok(k in model, 'the permissions model no longer has "' + k + '"');
  });
});

test('the hidden field these Vue forms submit through is unchanged', opts, async () => {
  // MODEL_FIELD is hardcoded from Manager's own form.js. If Manager ever
  // regenerates it, every post would arrive with a field Manager ignores
  // — a 200 that changes nothing, which is the worst failure shape here.
  const res = await client.get('/resources/htmx-extensions/form.js');
  assert.equal(res.status, 200, 'form.js is gone — the submit mechanism has changed');
  assert.ok(res.body.indexOf(V.MODEL_FIELD) !== -1,
    'form.js no longer contains ' + V.MODEL_FIELD + ' — MODEL_FIELD must be updated');
});
