/* ============================================================
   Tests for the HTTP provisioner driver, against a FAKE client —
   no live Manager, no network.

   The parsing tests use real markup shapes captured from Manager
   26.7.10 (/user-form), because the driver's correctness hinges on
   reading the Businesses multi-select back accurately: access is that
   select, so a mis-parse silently grants or revokes the wrong books.

     node --test test/provisioner-driver-http.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/provisioner-driver-http.js');
const { businessOptionValue, encodeForm, managerKeyParam } = require('../server/manager-client.js');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// A user form with two of three businesses ticked.
function userFormHtml(selectedNames, mfaSecret) {
  const all = ['Demo Business', 'TALLO-0001 Acme', 'TALLO-0002 Bayview'];
  const options = all.map(function (n) {
    const sel = selectedNames.indexOf(n) !== -1 ? ' selected' : '';
    return '<option value="' + b64(n) + '"' + sel + '>' + n + '</option>';
  }).join('');
  return '<form method="POST">'
    + '<input type="text" name="Name" value="Maria Santos" />'
    + '<input type="text" name="EmailAddress" value="maria@firm.ph" />'
    + '<input type="text" name="Username" value="maria@firm.ph" />'
    + '<input type="password" name="Password" />'
    + '<select name="Type"><option value="Administrator">Administrator</option>'
    + '<option value="Restricted" selected>Restricted user</option></select>'
    + '<select name="Businesses" multiple="multiple">' + options + '</select>'
    + '<input type="checkbox" name="MultifactorAuthentication" value="' + (mfaSecret || 'unset') + '"'
      + (mfaSecret ? ' checked="checked"' : '') + ' />'
    + '</form>';
}

// Stateful fake: a post updates what the next GET returns. The driver
// reads back after every write, so a fake that always replayed the
// original page would make every test fail — and a fake that ignored
// writes would hide the very bug read-back exists to catch.
// The permissions half of the fake. A grant now walks Settings → the
// User Permissions list → the record's form, so the fake has to serve
// all three and remember what was written to the last one.
//
// `access` is what the list currently reports for the user; null means
// they have no record yet and must go through "New User Permissions".
function permissionsPages(state) {
  const editHref = '/user-permissions-form?EDITKEY';
  const newHref = '/user-permissions-form?NEWKEY';
  const listHref = '/user-permissions?LISTKEY';
  return {
    listHref,
    editHref,
    newHref,
    // The sidebar carries BOTH links the driver follows: User
    // Permissions and Customize (Tabs).
    settings: () => '<a href="/summary-view?x">Summary</a>'
      + '<a href ="' + listHref + '" class="btn">User Permissions</a>'
      + '<a href="/tabs-form?TABSKEY" class="font-semibold">Customize</a>',
    list: () => '<a href ="' + newHref + '" class="btn">New User Permissions</a>'
      + '<table><thead><tr><th><a href ="/user-permissions?SORT">Username</a></th></tr></thead><tbody>'
      + (state.access === null ? '' :
        '<tr><td><a href ="' + editHref + '" class="btn btn-sm">Edit</a></td>'
        + '<td><span>' + state.username + '</span></td>'
        + '<td><span>' + state.access + '</span></td></tr>')
      + '</tbody></table>',
    form: () => '<div id="v-model-form"></div><script>app = new Vue({ el: "#v-model-form", data: '
      + JSON.stringify({
        Username: state.access === null ? '' : state.username,
        BankAndCashAccounts: [],
        AccessType: state.access === 'Full access' ? 1 : 0,
        Namespaces: {},
        Namespaces2: {},
        FullAccess: state.access === 'Full access',
        id: '019f834c-1e46-7150-9fca-ae9d824481f1',
      })
      + ', methods: { getIfUsername: function() { return true; } } })</script>',
  };
}

function fakeClient(html, opts = {}) {
  const calls = [];
  let current = html;
  const decode = (v) => Buffer.from(v, 'base64').toString('utf8');
  // Default: the user already has a Full access record, so tests that
  // are about the user form are unaffected by the permissions step.
  const perm = Object.assign(
    { username: 'maria@firm.ph', access: 'Full access', ignoreWrites: false },
    opts.permissions || {});
  const pages = permissionsPages(perm);

  // Tabs state, mutated by a successful post so the read-back sees it.
  const tabs = Object.assign({
    BankAndCashAccounts: false, Receipts: false, Payments: false,
    InterAccountTransfers: false, BankReconciliations: false, ExpenseClaims: false,
    Customers: false, SalesQuotes: false, SalesOrders: false, SalesInvoices: false,
    CreditNotes: false, LatePaymentFees: false, BillableTime: false,
    WithholdingTaxReceipts: false, DeliveryNotes: false, Suppliers: false,
    PurchaseQuotes: false, PurchaseOrders: false, PurchaseInvoices: false,
    DebitNotes: false, GoodsReceipts: false, Projects: false, InventoryItems: false,
    InventoryTransfers: false, InventoryWriteOffs: false, ProductionOrders: false,
    Employees: false, Payslips: false, Investments: false, FixedAssets: false,
    DepreciationEntries: false, IntangibleAssets: false, AmortizationEntries: false,
    CapitalAccounts: false, SpecialAccounts: false, Folders: false,
    id: 'ac789d1f-034f-4964-a8b5-ebfffc3511f2',
  }, opts.tabs || {});
  const tabsForm = () => '<div id="v-model-form"></div><script>app = new Vue({ el: "#v-model-form", data: '
    + JSON.stringify(tabs) + ', methods: {} })</script>';
  return {
    calls,
    pages,
    permissionState: perm,
    tabState: tabs,
    get: async (p) => {
      calls.push(['get', p]);
      if (p.indexOf('/settings?') === 0) return { status: 200, body: pages.settings() };
      if (p.indexOf('/user-permissions?') === 0) return { status: 200, body: pages.list() };
      if (p.indexOf('/user-permissions-form?') === 0) return { status: 200, body: pages.form() };
      if (p.indexOf('/tabs-form?') === 0) {
        if (opts.tabsFormStatus) return { status: opts.tabsFormStatus, body: '' };
        return { status: 200, body: tabsForm() };
      }
      return { status: 200, body: current };
    },
    postMultipart: async (p, f) => {
      calls.push(['postMultipart', p, f]);
      const model = JSON.parse(f['febb4049-dcdb-4c7a-a395-4b71da72a85b']);
      if (p.indexOf('/tabs-form?') === 0) {
        if (opts.tabsPostStatus) return { status: opts.tabsPostStatus, body: '' };
        if (!opts.tabsIgnoreWrites) Object.assign(tabs, model);
        return { status: 200, body: '' };
      }
      if (opts.permissionPostStatus) return { status: opts.permissionPostStatus, body: '' };
      if (!perm.ignoreWrites) {
        perm.username = model.Username;
        perm.access = model.AccessType === 1 ? 'Full access' : 'Custom access';
      }
      return { status: 200, body: '' };
    },
    postForm: async (p, f) => {
      calls.push(['postForm', p, f]);
      if (opts.postStatus) return { status: opts.postStatus, body: '' };
      // Reflect the submitted state, unless told to ignore writes.
      if (!opts.ignoreWrites && f.Businesses) {
        // Mirrors Manager: the post is the user's whole new state, so an
        // omitted MultifactorAuthentication means MFA off.
        current = userFormHtml((f.Businesses || []).map(decode), f.MultifactorAuthentication);
      }
      return { status: 200, body: '' };
    },
    postJson: async (p, o) => { calls.push(['postJson', p, o]); return { status: 200, body: '{}' }; },
  };
}
const lastPost = (c) => c.calls.filter((x) => x[0] === 'postForm').pop();

// ── parsing ──────────────────────────────────────────────────────
test('parseSelectedBusinesses: reads only the ticked options', () => {
  const html = userFormHtml(['TALLO-0001 Acme', 'TALLO-0002 Bayview']);
  assert.deepEqual(D.parseSelectedBusinesses(html),
    [b64('TALLO-0001 Acme'), b64('TALLO-0002 Bayview')]);
});

test('parseSelectedBusinesses: none ticked means no access, not "all"', () => {
  // Getting this backwards would hand a user every set of books.
  assert.deepEqual(D.parseSelectedBusinesses(userFormHtml([])), []);
});

test('parseSelectedBusinesses: a missing select yields nothing rather than throwing', () => {
  assert.deepEqual(D.parseSelectedBusinesses('<form></form>'), []);
  assert.deepEqual(D.parseSelectedBusinesses(''), []);
});

test('parseInputValue / parseSelectedOption: read the fields a re-post must preserve', () => {
  const html = userFormHtml([]);
  assert.equal(D.parseInputValue(html, 'EmailAddress'), 'maria@firm.ph');
  assert.equal(D.parseInputValue(html, 'Name'), 'Maria Santos');
  assert.equal(D.parseSelectedOption(html, 'Type'), 'Restricted');
});

test('userFormPath: uses the protobuf-style param, NOT plain base64', () => {
  // Verified against Manager 26.7.10: plain base64 does not 404, it serves
  // a BLANK new-user form — so this being wrong looks like success.
  const env = Buffer.concat([Buffer.from([0x0a, 'maria@firm.ph'.length]), Buffer.from('maria@firm.ph')]);
  assert.equal(D.userFormPath('maria@firm.ph'), '/user-form?' + env.toString('base64url').replace(/=+$/, ''));
  assert.notEqual(D.userFormPath('maria@firm.ph'), '/user-form?' + b64('maria@firm.ph'));
});

test('managerKeyParam: length-prefixed envelope, matching observed URLs', () => {
  // /login-password?Cgtwcm92aXNpb25lcg  ->  0a 0b "provisioner"
  assert.equal(managerKeyParam('provisioner'), 'Cgtwcm92aXNpb25lcg');
});

test('a blank form means the user was not found — never post it back', async () => {
  // Posting a blank form would CREATE a stray account instead of editing
  // the intended one. This is the bug that shipped and was caught live.
  const client = fakeClient('<form><select name="Businesses"></select></form>');
  await assert.rejects(
    () => D.createDriver({ client }).grantAccess({ managerUserRef: 'ghost@firm.ph', businessName: 'X' }),
    /no Manager user found/
  );
  assert.equal(client.calls.filter((c) => c[0] === 'postForm').length, 0, 'nothing was written');
});

test('a write Manager silently ignores is reported as a failure, not success', async () => {
  // Manager returns 200 for a post that changed nothing. Without reading
  // back, the portal would show a green tick over books nobody can open.
  const client = fakeClient(userFormHtml([]), { ignoreWrites: true });
  await assert.rejects(
    () => D.createDriver({ client }).grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' }),
    /did not apply the access change/
  );
});

// ── grant / revoke ───────────────────────────────────────────────
test('grantAccess: adds the business and KEEPS the ones already granted', () => {
  const client = fakeClient(userFormHtml(['TALLO-0001 Acme']));
  return D.createDriver({ client }).grantAccess({
    managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0002 Bayview',
  }).then(() => {
    const fields = lastPost(client)[2];
    assert.deepEqual(fields.Businesses.sort(),
      [b64('TALLO-0001 Acme'), b64('TALLO-0002 Bayview')].sort(),
      'a partial post would silently revoke everything else');
  });
});

test('grantAccess: granting twice does not duplicate the option', () => {
  const client = fakeClient(userFormHtml(['TALLO-0001 Acme']));
  return D.createDriver({ client }).grantAccess({
    managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme',
  }).then(() => {
    assert.deepEqual(lastPost(client)[2].Businesses, [b64('TALLO-0001 Acme')]);
  });
});

test('revokeAccess: removes only the named business', () => {
  const client = fakeClient(userFormHtml(['TALLO-0001 Acme', 'TALLO-0002 Bayview']));
  return D.createDriver({ client }).revokeAccess({
    managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme',
  }).then(() => {
    assert.deepEqual(lastPost(client)[2].Businesses, [b64('TALLO-0002 Bayview')]);
  });
});

test('the re-post carries every field, not just Businesses', () => {
  // Manager treats the post as the user's complete state, so anything
  // omitted is cleared — an incomplete post would wipe their email.
  const client = fakeClient(userFormHtml([]));
  return D.createDriver({ client }).grantAccess({
    managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme',
  }).then(() => {
    const fields = lastPost(client)[2];
    assert.equal(fields.EmailAddress, 'maria@firm.ph');
    assert.equal(fields.Name, 'Maria Santos');
    assert.equal(fields.Type, 'Restricted');
  });
});

test('disableUser: strips every business but keeps the account', () => {
  const client = fakeClient(userFormHtml(['TALLO-0001 Acme', 'TALLO-0002 Bayview']));
  return D.createDriver({ client }).disableUser({ managerUserRef: 'maria@firm.ph' }).then(() => {
    const fields = lastPost(client)[2];
    assert.deepEqual(fields.Businesses, [], 'opens nothing');
    assert.equal(fields.EmailAddress, 'maria@firm.ph', 'but is not deleted from the audit trail');
  });
});

// ── MFA must survive an access change ────────────────────────────
test('grantAccess preserves an enabled second factor', async () => {
  // MultifactorAuthentication's value IS the stored TOTP secret, and an
  // unchecked box submits nothing — so omitting it would post "MFA off"
  // and strip the staff member's second factor as a side effect of a
  // routine access change.
  const client = fakeClient(userFormHtml([], 'secret-abc'));
  await D.createDriver({ client }).grantAccess({
    managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme',
  });
  assert.equal(lastPost(client)[2].MultifactorAuthentication, 'secret-abc',
    'the exact stored secret must be posted back, not just a truthy flag');
});

test('a user without MFA is not silently given one', async () => {
  const client = fakeClient(userFormHtml([]));
  await D.createDriver({ client }).grantAccess({
    managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme',
  });
  assert.equal(lastPost(client)[2].MultifactorAuthentication, undefined);
});

test('if Manager drops MFA anyway, the job fails rather than leaving it off', async () => {
  const client = fakeClient(userFormHtml([], 'secret-abc'));
  const orig = client.postForm;
  client.postForm = async (p, f) => orig(p, Object.assign({}, f, { MultifactorAuthentication: undefined }));
  await assert.rejects(
    () => D.createDriver({ client }).grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' }),
    /disabled MFA/
  );
});

test('parseCheckedValue: reads the value only when ticked', () => {
  assert.equal(D.parseCheckedValue(userFormHtml([], 'sec-1'), 'MultifactorAuthentication'), 'sec-1');
  assert.equal(D.parseCheckedValue(userFormHtml([]), 'MultifactorAuthentication'), null);
});

// ── create ───────────────────────────────────────────────────────
test('createBusiness: posts the prefixed name as JSON to api4', () => {
  const client = fakeClient('');
  return D.createDriver({ client }).createBusiness({ businessName: 'TALLO-0001 Acme' }).then(() => {
    const call = client.calls.find((c) => c[0] === 'postJson');
    assert.equal(call[1], '/api4/business');
    assert.deepEqual(call[2], { name: 'TALLO-0001 Acme' });
  });
});

test('createUser: makes a RESTRICTED user with no businesses yet', () => {
  const client = fakeClient(userFormHtml([]));
  return D.createDriver({ client }).createUser({ email: 'jun@firm.ph', password: 'pw-1' }).then((r) => {
    const fields = lastPost(client)[2];
    assert.equal(fields.Type, 'Restricted', 'never an administrator');
    assert.deepEqual(fields.Businesses, [], 'access arrives as its own grant jobs');
    assert.equal(fields.Username, 'jun@firm.ph');
    assert.equal(r.managerUserRef, 'jun@firm.ph', 'the ref must address the edit form later');
  });
});

test('createUser: posts the secret Books minted, not a boolean', async () => {
  // The MFA checkbox value IS a freshly-generated TOTP secret. Posting
  // 'on' is not something Books can parse, so it silently creates the
  // user with MFA off — which is exactly what shipped and was caught in
  // real use.
  const client = fakeClient(userFormHtml([], 'minted-secret-123'));
  await D.createDriver({ client }).createUser({ email: 'jun@firm.ph', password: 'pw' });
  const fields = lastPost(client)[2];
  assert.equal(fields.MultifactorAuthentication, 'minted-secret-123');
  assert.notEqual(fields.MultifactorAuthentication, 'on');
});

test('createUser: reads the blank form BEFORE posting, to get that secret', async () => {
  const client = fakeClient(userFormHtml([], 'minted-secret-123'));
  await D.createDriver({ client }).createUser({ email: 'jun@firm.ph', password: 'pw' });
  const firstGet = client.calls.findIndex((c) => c[0] === 'get');
  const firstPost = client.calls.findIndex((c) => c[0] === 'postForm');
  assert.ok(firstGet >= 0 && firstGet < firstPost, 'must fetch the form first');
});

test('createUser: enableMfa false skips the field entirely', async () => {
  const client = fakeClient(userFormHtml([], 'minted-secret-123'));
  await D.createDriver({ client }).createUser({ email: 'jun@firm.ph', password: 'pw', enableMfa: false });
  assert.equal(lastPost(client)[2].MultifactorAuthentication, undefined);
});

test('createUser: refuses rather than quietly creating a user with no second factor', async () => {
  // If Books stops offering the field, failing loudly beats provisioning
  // staff who can reach client books with a password alone.
  const client = fakeClient('<form><input name="Username" value="" /></form>');
  await assert.rejects(
    () => D.createDriver({ client }).createUser({ email: 'jun@firm.ph', password: 'pw' }),
    /cannot enable MFA/
  );
});

test('createBusiness / createUser reject empty input instead of creating junk', async () => {
  const d = D.createDriver({ client: fakeClient(userFormHtml([])) });
  await assert.rejects(() => d.createBusiness({ businessName: '' }), /required/);
  await assert.rejects(() => d.createUser({ email: '' }), /required/);
  await assert.rejects(() => d.createUser({ email: 'a@b.ph' }), /password is required/);
});

test('a rejected form surfaces as an error so the job retries', async () => {
  const client = fakeClient(userFormHtml([]), { postStatus: 500 });
  await assert.rejects(
    () => D.createDriver({ client }).grantAccess({ managerUserRef: 'm@f.ph', businessName: 'X' }),
    /rejected/
  );
});

// ── passwords + MFA on new users ─────────────────────────────────
test('createUser: enables MFA by default', async () => {
  // Enrolment happens at the user's FIRST LOGIN, where Manager shows them
  // a QR — so ticking it here strands nobody.
  const client = fakeClient(userFormHtml([]));
  await D.createDriver({ client }).createUser({ email: 'jun@firm.ph', password: 'pw-1' });
  assert.ok(client.calls.find((c) => c[0] === 'postForm')[2].MultifactorAuthentication);
});

test('createUser: MFA can be turned off explicitly', async () => {
  const client = fakeClient(userFormHtml([]));
  await D.createDriver({ client }).createUser({ email: 'jun@firm.ph', password: 'pw-1', enableMfa: false });
  assert.equal(client.calls.find((c) => c[0] === 'postForm')[2].MultifactorAuthentication, undefined);
});

test('setPassword: changes the password without disturbing access or MFA', async () => {
  const client = fakeClient(userFormHtml(['TALLO-0001 Acme'], 'secret-abc'));
  await D.createDriver({ client }).setPassword({ managerUserRef: 'maria@firm.ph', password: 'new-pw' });
  const f = lastPost(client)[2];
  assert.equal(f.Password, 'new-pw');
  assert.deepEqual(f.Businesses, [b64('TALLO-0001 Acme')], 'a reset must not cost them their books');
  assert.equal(f.MultifactorAuthentication, 'secret-abc', 'nor their second factor');
});

test('setPassword: refuses an empty password rather than blanking it', async () => {
  const client = fakeClient(userFormHtml([]));
  await assert.rejects(
    () => D.createDriver({ client }).setPassword({ managerUserRef: 'maria@firm.ph', password: '' }),
    /password is required/
  );
});

// ── encoding ─────────────────────────────────────────────────────
// ── the second half of a grant: Full access inside the business ──
//
// Linking the business only decides WHICH books open. Without a User
// Permissions record set to Full access, the staff member signs in,
// sees the client listed, and cannot work in it — which is how this
// gap was found in production.

const lastMultipart = (c) => c.calls.filter((x) => x[0] === 'postMultipart').pop();
const postedModel = (c) => JSON.parse(lastMultipart(c)[2]['febb4049-dcdb-4c7a-a395-4b71da72a85b']);

test('grantAccess sets Full access, not just the business link', async () => {
  const client = fakeClient(userFormHtml([]), { permissions: { access: 'Custom access' } });
  const res = await D.createDriver({ client })
    .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' });

  assert.equal(res.granted, true);
  assert.equal(res.accessType, 'Full access');
  assert.equal(postedModel(client).AccessType, 1);
  assert.equal(client.permissionState.access, 'Full access');
});

test('grantAccess creates the permission record when the user has none', async () => {
  const client = fakeClient(userFormHtml([]), { permissions: { access: null } });
  const res = await D.createDriver({ client })
    .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' });

  assert.equal(res.permissionCreated, true);
  // It must go through the New link, not an Edit link that isn't there.
  assert.equal(lastMultipart(client)[1], client.pages.newHref);
  assert.equal(postedModel(client).Username, 'maria@firm.ph');
});

test('grantAccess edits the existing record rather than adding a second', async () => {
  const client = fakeClient(userFormHtml([]), { permissions: { access: 'Custom access' } });
  const res = await D.createDriver({ client })
    .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' });

  assert.equal(res.permissionCreated, false);
  assert.equal(lastMultipart(client)[1], client.pages.editHref);
});

test('the posted model keeps the fields we did not mean to change', async () => {
  // The post is the record's COMPLETE new state, so a model missing `id`
  // or Namespaces would blank them.
  const client = fakeClient(userFormHtml([]), { permissions: { access: 'Custom access' } });
  await D.createDriver({ client })
    .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' });

  const model = postedModel(client);
  assert.equal(model.id, '019f834c-1e46-7150-9fca-ae9d824481f1');
  assert.deepEqual(model.Namespaces, {});
  assert.deepEqual(model.BankAndCashAccounts, []);
  assert.equal(model.FullAccess, true);
});

test('a grant that Manager silently ignores fails instead of reporting success', async () => {
  // The failure that matters most: the portal would show a green tick
  // over books the staff member cannot use.
  const client = fakeClient(userFormHtml([]), {
    permissions: { access: 'Custom access', ignoreWrites: true },
  });
  await assert.rejects(
    () => D.createDriver({ client })
      .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' }),
    /left maria@firm\.ph on "Custom access" instead of Full access/,
  );
});

test('a rejected permissions post surfaces as an error so the job retries', async () => {
  const client = fakeClient(userFormHtml([]), {
    permissions: { access: 'Custom access' }, permissionPostStatus: 500,
  });
  await assert.rejects(
    () => D.createDriver({ client })
      .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' }),
    /permissions form rejected/,
  );
});

test('a grant is idempotent — a retry on Full access changes nothing', async () => {
  const client = fakeClient(userFormHtml([]), { permissions: { access: 'Full access' } });
  const res = await D.createDriver({ client })
    .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' });

  assert.equal(res.accessType, 'Full access');
  assert.equal(client.permissionState.access, 'Full access');
});

test('no URL the driver requests ever carries the delete flag', async () => {
  // Field 250 = 1 is Delete, and Update/Delete differ by that one bit.
  // The driver builds only the business-name key and follows Manager's
  // own hrefs, so no request should decode to a set delete flag.
  const client = fakeClient(userFormHtml([]), { permissions: { access: 'Custom access' } });
  await D.createDriver({ client })
    .grantAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' });

  const built = client.calls
    .map((c) => String(c[1]))
    .filter((p) => p.indexOf('/settings?') === 0);
  assert.ok(built.length > 0, 'expected the driver to build at least one key itself');
  built.forEach((p) => {
    const buf = Buffer.from(p.split('?')[1], 'base64url');
    // 0xd0 0x0f is the tag for field 250; the byte after it is the flag.
    for (let i = 0; i < buf.length - 2; i++) {
      if (buf[i] === 0xd0 && buf[i + 1] === 0x0f) {
        assert.equal(buf[i + 2], 0, 'delete flag set in a key the driver built: ' + p);
      }
    }
  });
});

test('revokeAccess leaves the permission record alone', async () => {
  // Deleting it would mean building a delete-flagged key. The Businesses
  // multi-select is the gate, so an orphaned record grants nothing.
  const client = fakeClient(userFormHtml(['TALLO-0001 Acme']), {
    permissions: { access: 'Full access' },
  });
  await D.createDriver({ client })
    .revokeAccess({ managerUserRef: 'maria@firm.ph', businessName: 'TALLO-0001 Acme' });

  assert.equal(lastMultipart(client), undefined, 'revoke should not touch the permissions form');
  assert.deepEqual(lastPost(client)[2].Businesses, []);
});

// ── Tabs: making a new client's books usable on arrival ──────────

const T = require('../server/manager-tabs.js');

test('configureTabs turns on all nine the firm works in', async () => {
  const client = fakeClient(userFormHtml([]));
  const res = await D.createDriver({ client }).configureTabs({ businessName: 'TALLO-0001 Acme' });

  assert.equal(res.alreadyConfigured, false);
  assert.equal(res.tabsEnabled.length, 9);
  T.REQUIRED_TABS.forEach((tab) => assert.equal(client.tabState[tab], true, tab));
});

test('configureTabs is additive — it never switches a tab off', async () => {
  // A client had Fixed Assets turned on by hand. A retry must not undo
  // it, which is the whole reason this step only ever ticks.
  const client = fakeClient(userFormHtml([]), {
    tabs: { FixedAssets: true, DepreciationEntries: true },
  });
  await D.createDriver({ client }).configureTabs({ businessName: 'TALLO-0001 Acme' });

  assert.equal(client.tabState.FixedAssets, true);
  assert.equal(client.tabState.DepreciationEntries, true);
  assert.equal(client.tabState.InventoryItems, false, 'unrelated tabs stay off');
});

test('configureTabs skips the write when the books are already right', async () => {
  const already = {};
  T.REQUIRED_TABS.forEach((t) => { already[t] = true; });
  const client = fakeClient(userFormHtml([]), { tabs: already });
  const res = await D.createDriver({ client }).configureTabs({ businessName: 'TALLO-0001 Acme' });

  assert.equal(res.alreadyConfigured, true);
  assert.equal(client.calls.filter((c) => c[0] === 'postMultipart').length, 0,
    'a no-op retry should not write, so the books\' History stays clean');
});

test('a tab change Manager silently ignores fails instead of reporting done', async () => {
  const client = fakeClient(userFormHtml([]), { tabsIgnoreWrites: true });
  await assert.rejects(
    () => D.createDriver({ client }).configureTabs({ businessName: 'TALLO-0001 Acme' }),
    /did not enable .*Payslips/,
  );
});

test('a rejected Tabs post surfaces as an error so the job retries', async () => {
  const client = fakeClient(userFormHtml([]), { tabsPostStatus: 500 });
  await assert.rejects(
    () => D.createDriver({ client }).configureTabs({ businessName: 'TALLO-0001 Acme' }),
    /Tabs form rejected/,
  );
});

test('a missing Customize link is an error, not a silent no-op', async () => {
  const client = fakeClient(userFormHtml([]));
  const plain = client.get;
  client.get = async (p) => (p.indexOf('/settings?') === 0
    ? { status: 200, body: '<a href="/summary-view?x">Summary</a>' }
    : plain(p));
  await assert.rejects(
    () => D.createDriver({ client }).configureTabs({ businessName: 'TALLO-0001 Acme' }),
    /no Customize \(Tabs\) link/,
  );
});

test('configureTabs posts the whole model, not just the nine', async () => {
  // Manager treats the post as the record's complete new state, so a
  // partial model would blank every tab it omitted.
  const client = fakeClient(userFormHtml([]), { tabs: { Projects: true } });
  await D.createDriver({ client }).configureTabs({ businessName: 'TALLO-0001 Acme' });

  const sent = JSON.parse(lastMultipart(client)[2]['febb4049-dcdb-4c7a-a395-4b71da72a85b']);
  assert.equal(Object.keys(sent).length, 37, 'all 36 tabs plus id');
  assert.equal(sent.id, 'ac789d1f-034f-4964-a8b5-ebfffc3511f2');
  assert.equal(sent.Projects, true);
});

test('configureTabs rejects an empty business name rather than guessing', async () => {
  await assert.rejects(
    () => D.createDriver({ client: fakeClient(userFormHtml([])) }).configureTabs({ businessName: '' }),
    /businessName is required/,
  );
});

test('businessOptionValue: base64 of the name, matching Manager option values', () => {
  // Verified against a live /user-form: "Demo Business" -> RGVtbyBCdXNpbmVzcw==
  assert.equal(businessOptionValue('Demo Business'), 'RGVtbyBCdXNpbmVzcw==');
});

test('encodeForm: a multi-select repeats the key, which is how access is submitted', () => {
  assert.equal(encodeForm({ Businesses: ['a', 'b'], Type: 'Restricted' }),
    'Businesses=a&Businesses=b&Type=Restricted');
});

test('encodeForm: omits undefined so an unset password is not sent as "undefined"', () => {
  assert.equal(encodeForm({ Username: 'x', Password: undefined }), 'Username=x');
});
