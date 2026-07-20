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

const { createClient, businessOptionValue } = require('./manager-client.js');

const USER_FORM = '/user-form';

// /user-form?<base64(username)> addresses an existing user.
function userFormPath(managerUserRef) {
  return USER_FORM + '?' + Buffer.from(String(managerUserRef), 'utf8').toString('base64');
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

    const fields = {
      Name: parseInputValue(page.body, 'Name'),
      EmailAddress: parseInputValue(page.body, 'EmailAddress'),
      Username: parseInputValue(page.body, 'Username') || String(managerUserRef),
      Type: parseSelectedOption(page.body, 'Type') || 'Restricted',
      Businesses: parseSelectedBusinesses(page.body),
    };

    mutate(fields);

    const res = await client.postForm(path, fields);
    if (res.status >= 400) throw new Error('user form rejected for ' + managerUserRef + ' (http ' + res.status + ')');
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
