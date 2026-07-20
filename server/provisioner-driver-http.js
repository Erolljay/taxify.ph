/* ============================================================
   Txform.ph — server/provisioner-driver-http.js

   The provisioner's driver, over plain HTTP. Replaces the Playwright
   adapter: Manager needs no browser, so the only npm dependency the
   project had is gone with it.

   Implements the interface provisioner.js expects:
     createBusiness({ businessName })
     createUser({ email })            -> { managerUserRef }
     grantAccess({ managerUserRef, businessName })
     revokeAccess({ managerUserRef, businessName })
     disableUser({ managerUserRef })

   managerUserRef is the user's USERNAME in Manager. The edit form is
   addressed as /user-form?<base64(username)>, so the ref has to be
   whatever that encodes — not a numeric id, which Manager never exposes.

   ── The one thing to understand about access ──
   Manager has no per-user permissions page. Access is the `Businesses`
   multi-select on the user form itself, so grant and revoke are the same
   operation: read the form, edit the selection, post it back. That makes
   every write a read-modify-write, and it means a partial form post
   would silently drop the fields it omitted — so `submitUserForm` always
   sends the complete set.
   ============================================================ */
'use strict';

const { createClient, businessOptionValue, managerKeyParam } = require('./manager-client.js');

const USER_FORM = '/user-form';

// Addresses an existing user. The param is Manager's protobuf-style
// envelope, NOT plain base64 — plain base64 silently serves a blank
// new-user form instead of erroring, which is how a grant can report
// success while granting nothing.
function userFormPath(managerUserRef) {
  return USER_FORM + '?' + managerKeyParam(managerUserRef);
}

// Which businesses are currently ticked on a user form. Option values are
// base64 of the business name; `selected` marks the ones in force.
function parseSelectedBusinesses(html) {
  const block = /<select[^>]*name="Businesses"[\s\S]*?<\/select>/i.exec(html || '');
  if (!block) return [];
  const selected = [];
  const option = /<option([^>]*)>/gi;
  let m;
  while ((m = option.exec(block[0])) !== null) {
    const attrs = m[1];
    if (!/\bselected\b/i.test(attrs)) continue;
    const val = /value="([^"]*)"/i.exec(attrs);
    if (val) selected.push(val[1]);
  }
  return selected;
}

// Read a single input's current value, so a re-post preserves fields we
// are not deliberately changing.
function parseInputValue(html, name) {
  const re = new RegExp('<input[^>]*name="' + name + '"[^>]*>', 'i');
  const tag = re.exec(html || '');
  if (!tag) return '';
  const val = /value="([^"]*)"/i.exec(tag[0]);
  return val ? val[1] : '';
}

function parseSelectedOption(html, selectName) {
  const block = new RegExp('<select[^>]*name="' + selectName + '"[\\s\\S]*?</select>', 'i').exec(html || '');
  if (!block) return '';
  const opt = /<option([^>]*)>/gi;
  let m;
  while ((m = opt.exec(block[0])) !== null) {
    if (/\bselected\b/i.test(m[1])) {
      const val = /value="([^"]*)"/i.exec(m[1]);
      if (val) return val[1];
    }
  }
  return '';
}

function createDriver(opts) {
  const client = opts.client || createClient({
    baseUrl: opts.baseUrl,
    username: opts.adminUser,
    password: opts.adminPass,
    timeoutMs: opts.timeoutMs,
  });

  // Read a user's form, hand it to `mutate` to adjust, post the whole
  // thing back. Always a full submit — Manager treats the post as the
  // complete state of the user, so omitting a field clears it.
  async function submitUserForm(managerUserRef, mutate) {
    const path = userFormPath(managerUserRef);
    const page = await client.get(path);
    if (page.status !== 200) throw new Error('could not open the user form for ' + managerUserRef + ' (http ' + page.status + ')');

    // A blank Username means Manager served the NEW-user form rather than
    // this user's — it does not 404 for an unknown key. Posting that back
    // would create a stray account instead of editing the intended one.
    const existingUsername = parseInputValue(page.body, 'Username');
    if (!existingUsername) {
      throw new Error('no Manager user found for "' + managerUserRef + '" (got a blank form, not their record)');
    }

    const fields = {
      Name: parseInputValue(page.body, 'Name'),
      EmailAddress: parseInputValue(page.body, 'EmailAddress'),
      Username: existingUsername,
      Type: parseSelectedOption(page.body, 'Type') || 'Restricted',
      Businesses: parseSelectedBusinesses(page.body),
    };

    mutate(fields);

    const res = await client.postForm(path, fields);
    if (res.status >= 400) throw new Error('user form rejected for ' + managerUserRef + ' (http ' + res.status + ')');

    // Read back. Manager returns 200 for a post that changed nothing, so
    // without this a grant can report success while the user still has no
    // access — the failure mode that matters most here, because the portal
    // would show a green tick over books nobody can open.
    const after = await client.get(path);
    const actual = parseSelectedBusinesses(after.body);
    const expected = fields.Businesses.slice().sort();
    if (actual.slice().sort().join('|') !== expected.join('|')) {
      throw new Error('Manager did not apply the access change for ' + managerUserRef
        + ' (wanted ' + expected.length + ' business(es), it has ' + actual.length + ')');
    }
    return res;
  }

  return {
    // POST /api4/business {"name"} — the books, empty. BIR scaffolding
    // (custom fields, tax codes, chart of accounts) is deliberately NOT
    // done here: it needs figures off the client's COR, and it already
    // exists, tested, in the extension.
    async createBusiness({ businessName }) {
      if (!businessName) throw new Error('businessName is required');
      const res = await client.postJson('/api4/business', { name: businessName });
      if (res.status >= 400) throw new Error('Manager refused to create "' + businessName + '" (http ' + res.status + ')');
      return { created: true };
    },

    // A restricted user with no businesses yet; grants follow as their
    // own jobs. Username is the email — it is what addresses the form
    // later, so it must be stable and unique, which an email already is.
    async createUser({ email }) {
      if (!email) throw new Error('email is required');
      const res = await client.postForm(USER_FORM, {
        Name: email,
        EmailAddress: email,
        Username: email,
        Password: opts.newUserPassword ? opts.newUserPassword(email) : undefined,
        Type: 'Restricted',
        Businesses: [],
      });
      if (res.status >= 400) throw new Error('Manager refused to create user ' + email + ' (http ' + res.status + ')');

      // Confirm the user is really addressable before the queue moves on
      // to granting them access — a create that silently no-ops would turn
      // every following grant into a stray-account bug.
      const check = await client.get(userFormPath(email));
      if (check.status !== 200 || !parseInputValue(check.body, 'Username')) {
        throw new Error('Manager reported success but user ' + email + ' is not there');
      }
      return { managerUserRef: email };
    },

    async grantAccess({ managerUserRef, businessName }) {
      const value = businessOptionValue(businessName);
      await submitUserForm(managerUserRef, function (fields) {
        if (fields.Businesses.indexOf(value) === -1) fields.Businesses.push(value);
      });
      return { granted: true };
    },

    async revokeAccess({ managerUserRef, businessName }) {
      const value = businessOptionValue(businessName);
      await submitUserForm(managerUserRef, function (fields) {
        fields.Businesses = fields.Businesses.filter(function (v) { return v !== value; });
      });
      return { revoked: true };
    },

    // Offboarding. Manager has no "disabled" flag we can rely on, so we
    // take away every business instead: the login survives but opens
    // nothing. Deleting the user would erase them from Manager's own
    // audit trail, which is the opposite of what an offboard should do.
    async disableUser({ managerUserRef }) {
      await submitUserForm(managerUserRef, function (fields) {
        fields.Businesses = [];
      });
      return { disabled: true };
    },
  };
}

module.exports = {
  createDriver, userFormPath, parseSelectedBusinesses, parseInputValue, parseSelectedOption,
};
