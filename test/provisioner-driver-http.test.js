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
const { businessOptionValue, encodeForm } = require('../server/manager-client.js');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// A user form with two of three businesses ticked.
function userFormHtml(selectedNames) {
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
    + '</form>';
}

// Fake client recording every call; serves the form html on GET.
function fakeClient(html) {
  const calls = [];
  return {
    calls,
    get: async (p) => { calls.push(['get', p]); return { status: 200, body: html }; },
    postForm: async (p, f) => { calls.push(['postForm', p, f]); return { status: 200, body: '' }; },
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

test('userFormPath: addresses an existing user by base64 username', () => {
  assert.equal(D.userFormPath('maria@firm.ph'), '/user-form?' + b64('maria@firm.ph'));
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
  const client = fakeClient('');
  return D.createDriver({ client }).createUser({ email: 'jun@firm.ph' }).then((r) => {
    const fields = lastPost(client)[2];
    assert.equal(fields.Type, 'Restricted', 'never an administrator');
    assert.deepEqual(fields.Businesses, [], 'access arrives as its own grant jobs');
    assert.equal(fields.Username, 'jun@firm.ph');
    assert.equal(r.managerUserRef, 'jun@firm.ph', 'the ref must address the edit form later');
  });
});

test('createBusiness / createUser reject empty input instead of creating junk', async () => {
  const d = D.createDriver({ client: fakeClient('') });
  await assert.rejects(() => d.createBusiness({ businessName: '' }), /required/);
  await assert.rejects(() => d.createUser({ email: '' }), /required/);
});

test('a rejected form surfaces as an error so the job retries', async () => {
  const client = fakeClient(userFormHtml([]));
  client.postForm = async () => ({ status: 500, body: '' });
  await assert.rejects(
    () => D.createDriver({ client }).grantAccess({ managerUserRef: 'm@f.ph', businessName: 'X' }),
    /rejected/
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
