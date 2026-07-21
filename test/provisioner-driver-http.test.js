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
function fakeClient(html, opts = {}) {
  const calls = [];
  let current = html;
  const decode = (v) => Buffer.from(v, 'base64').toString('utf8');
  return {
    calls,
    get: async (p) => { calls.push(['get', p]); return { status: 200, body: current }; },
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
