/* ============================================================
   Tests for the per-business User Permissions round trip.

   The fixtures are trimmed from REAL pages captured off
   books.txform.ph running Manager 26.7.10.3654 — including the
   `href ="..."` spacing quirk and the Vue model literal, both of which
   a hand-written fixture would have tidied away.

     node --test test/manager-permissions.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../server/manager-permissions.js');
const { managerKey, guidMessage } = require('../server/manager-client.js');

const BUSINESS = 'TALLO-Our Lady of Peace Learning Center - New Lucena, Iloilo Inc.';
const USER = 'idetayson@tallocpa.com';
const RECORD = '019f834c-1e46-7150-9fca-ae9d824481f1';

// Real keys, copied verbatim from the captured pages.
const REAL_FORM_KEY = 'ogZBVEFMTE8tT3VyIExhZHkgb2YgUGVhY2UgTGVhcm5pbmcgQ2VudGVyIC0gTmV3IEx1Y2VuYSwgSWxvaWxvIEluYy6qBgYvdXNlcnPCDBIJTIOfAUYeUHERn8qunYJEgfHQDwA';
const REAL_EDIT_HREF = '/user-permissions-form?REAL_EDIT_KEY';
const REAL_NEW_HREF = '/user-permissions-form?REAL_NEW_KEY';

function listHtml(rows) {
  const body = rows.map(function (r) {
    return '<tr><td class="text-start w-px whitespace-nowrap ">'
      + '<a href ="' + r.href + '" class="btn btn-sm">Edit</a></td>'
      + '<td class="text-start "><span>' + r.username + '</span></td>'
      + '<td class="text-start "><span>' + r.accessType + '</span></td></tr>';
  }).join('');
  return '<div class="card-header flex justify-between print:hidden">'
    + '<div class="card-title">User Permissions</div>'
    + '<a href ="' + REAL_NEW_HREF + '" class="btn">New User Permissions</a></div>'
    + '<table class="card-table"><thead><tr>'
    + '<th><a href ="/user-permissions?SORTKEY" class="text-neutral-500">Username</a></th>'
    + '<th><a href ="/user-permissions?SORTKEY2" class="text-neutral-500">Access type</a></th>'
    + '</tr></thead><tbody>' + body + '</tbody></table>';
}

function settingsHtml() {
  return '<a href="/summary-view?xxx">Summary</a>'
    + '<a href ="/user-permissions?LISTKEY" class="btn">User Permissions</a>'
    + '<a href="/tax-codes?yyy">Tax Codes</a>';
}

// The Vue literal exactly as Manager emits it, braces and all.
function formHtml(model) {
  return '<div id="v-model-form"><select class="form-select" v-model="AccessType">'
    + '<option value="0">Custom access</option><option value="1">Full access</option>'
    + '</select></div>'
    + '<script>Vue.component(\'v-select\', VueSelect.VueSelect);'
    + 'app = new Vue({ el: "#v-model-form", data: ' + JSON.stringify(model, null, 2)
    + ', methods: { getIfUsername: function() { return true; } } })</script>';
}

const FULL_MODEL = {
  Username: USER,
  BankAndCashAccounts: [],
  AccessType: 1,
  Namespaces: {},
  Namespaces2: {},
  FullAccess: true,
  id: RECORD,
};

// ── envelope construction ────────────────────────────────────────────

test('managerKey reproduces the business-name key Manager uses in sidebar links', () => {
  // /summary-view?ogZBVEFMTE8t… — field 100, the business name, alone.
  const expected = 'ogZBVEFMTE8tT3VyIExhZHkgb2YgUGVhY2UgTGVhcm5pbmcgQ2VudGVyIC0gTmV3IEx1Y2VuYSwgSWxvaWxvIEluYy4';
  assert.equal(managerKey([{ field: 100, string: BUSINESS }]), expected);
});

test('settingsPath builds the sidebar Settings URL', () => {
  assert.equal(P.settingsPath(BUSINESS),
    '/settings?ogZBVEFMTE8tT3VyIExhZHkgb2YgUGVhY2UgTGVhcm5pbmcgQ2VudGVyIC0gTmV3IEx1Y2VuYSwgSWxvaWxvIEluYy4');
});

test('guidMessage encodes a record id the way Manager addresses it', () => {
  // Verified against the real /user-permissions-form URL: the nested
  // message is two fixed64s holding the .NET mixed-endian Guid bytes.
  assert.equal(guidMessage(RECORD).toString('hex'), '094c839f01461e5071119fcaae9d824481f1');
});

test('a full key round-trips to the real one from the address bar', () => {
  const built = managerKey([
    { field: 100, string: BUSINESS },
    { field: 101, string: '/users' },
    { field: 200, guid: RECORD },
    { field: 250, varint: 0 },
  ]);
  assert.equal(built, REAL_FORM_KEY);
});

test('guidMessage rejects anything that is not a uuid', () => {
  assert.throws(() => guidMessage('not-a-guid'), /not a uuid/);
});

// ── list parsing ─────────────────────────────────────────────────────

test('parsePermissionRows reads username, access type and the Edit href', () => {
  const rows = P.parsePermissionRows(listHtml([
    { href: REAL_EDIT_HREF, username: USER, accessType: 'Full access' },
    { href: '/user-permissions-form?OTHER', username: 'jun@tallocpa.com', accessType: 'Custom access' },
  ]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { href: REAL_EDIT_HREF, username: USER, accessType: 'Full access' });
  assert.equal(rows[1].accessType, 'Custom access');
});

test('the header sort links are not mistaken for rows', () => {
  // Both live in <thead> and point at /user-permissions, not the form.
  const rows = P.parsePermissionRows(listHtml([
    { href: REAL_EDIT_HREF, username: USER, accessType: 'Full access' },
  ]));
  assert.equal(rows.length, 1);
});

test('findRowForUsername matches case-insensitively and returns null when absent', () => {
  const html = listHtml([{ href: REAL_EDIT_HREF, username: USER, accessType: 'Full access' }]);
  assert.equal(P.findRowForUsername(html, 'IDETAYSON@TalloCPA.com').href, REAL_EDIT_HREF);
  assert.equal(P.findRowForUsername(html, 'nobody@tallocpa.com'), null);
});

test('findNewPermissionHref finds the New link and not a row Edit link', () => {
  const html = listHtml([{ href: REAL_EDIT_HREF, username: USER, accessType: 'Full access' }]);
  assert.equal(P.findNewPermissionHref(html), REAL_NEW_HREF);
});

test('findNewPermissionHref still works when the table is empty', () => {
  assert.equal(P.findNewPermissionHref(listHtml([])), REAL_NEW_HREF);
});

test('findHref tolerates Manager writing `href =` with a space', () => {
  assert.equal(P.findHref(settingsHtml(), P.PERMISSIONS_LIST), '/user-permissions?LISTKEY');
});

// ── the Vue model ────────────────────────────────────────────────────

test('parseVueModel extracts the whole model, nested braces and all', () => {
  assert.deepEqual(P.parseVueModel(formHtml(FULL_MODEL)), FULL_MODEL);
});

test('parseVueModel does not truncate at the first empty Namespaces object', () => {
  // The bug a non-greedy regex would introduce: stopping at the `}` of
  // "Namespaces": {} and posting a model missing FullAccess and id,
  // which Manager would take as the record's complete new state.
  const model = P.parseVueModel(formHtml(FULL_MODEL));
  assert.equal(model.id, RECORD);
  assert.equal(model.FullAccess, true);
});

test('parseVueModel survives braces inside the business name', () => {
  const odd = Object.assign({}, FULL_MODEL, { Username: 'a{b}c@tallocpa.com' });
  assert.equal(P.parseVueModel(formHtml(odd)).Username, 'a{b}c@tallocpa.com');
});

test('parseVueModel throws rather than guessing when there is no model', () => {
  assert.throws(() => P.parseVueModel('<html>signed out</html>'), /no Vue model/);
});

test('parseVueModel throws on a truncated model', () => {
  const cut = formHtml(FULL_MODEL).replace(/\}, methods[\s\S]*$/, '');
  assert.throws(() => P.parseVueModel(cut), /truncated|could not parse/);
});

test('Full access is 1 — the value Manager posts, not the label', () => {
  assert.equal(P.ACCESS_FULL, 1);
  assert.equal(P.ACCESS_CUSTOM, 0);
});

module.exports = { listHtml, settingsHtml, formHtml, FULL_MODEL, BUSINESS, USER, RECORD };
