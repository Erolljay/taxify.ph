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

   ── The two things to understand about access ──
   1. WHICH books a user can open is the `Businesses` multi-select on the
      user form itself, so grant and revoke are the same operation: read
      the form, edit the selection, post it back. That makes every write a
      read-modify-write, and it means a partial form post would silently
      drop the fields it omitted — so `submitUserForm` always sends the
      complete set.

   2. WHAT they can do once inside is a separate per-business User
      Permissions record, with its own `Access type` of Full or Custom.
      See manager-permissions.js. A user who is linked to a business but
      has no such record — or has one left on Custom with nothing ticked —
      signs in, sees the books, and cannot work in them.

   So `grantAccess` does both, and verifies both. Half a grant is worse
   than a failed one: the portal would show a green tick over books the
   staff member cannot actually use, and nobody would know until they
   tried.
   ============================================================ */
'use strict';

const { createClient, businessOptionValue, managerKeyParam } = require('./manager-client.js');
const P = require('./manager-permissions.js');
const T = require('./manager-tabs.js');
const V = require('./manager-vue-form.js');

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

// A checkbox's value, but ONLY when it is ticked. Manager stores state in
// the value itself (MultifactorAuthentication carries the user's TOTP
// secret), so a re-post must send back exactly what it was given.
// Any attribute off a named input, ticked or not. Needed for the blank
// new-user form, where the MFA checkbox carries the freshly-minted secret
// but is not yet checked.
function parseInputAttr(html, name, attr) {
  const tag = new RegExp('<input[^>]*name="' + name + '"[^>]*>', 'i').exec(html || '');
  if (!tag) return null;
  const val = new RegExp(attr + '="([^"]*)"', 'i').exec(tag[0]);
  return val ? val[1] : null;
}

function parseCheckedValue(html, name) {
  const re = new RegExp('<input[^>]*name="' + name + '"[^>]*>', 'i');
  const tag = re.exec(html || '');
  if (!tag || !/\bchecked\b/i.test(tag[0])) return null;
  const val = /value="([^"]*)"/i.exec(tag[0]);
  return val ? val[1] : null;
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

    // MultifactorAuthentication's value IS the user's stored TOTP secret,
    // and an unchecked checkbox submits nothing. Omitting it would post
    // "MFA off" and silently strip a staff member's second factor every
    // time we changed their access — the robot undoing the protection it
    // is supposed to preserve.
    const mfa = parseCheckedValue(page.body, 'MultifactorAuthentication');

    const fields = {
      Name: parseInputValue(page.body, 'Name'),
      EmailAddress: parseInputValue(page.body, 'EmailAddress'),
      Username: existingUsername,
      Type: parseSelectedOption(page.body, 'Type') || 'Restricted',
      Businesses: parseSelectedBusinesses(page.body),
    };
    if (mfa) fields.MultifactorAuthentication = mfa;

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
    // Never let an access change cost someone their second factor.
    if (mfa && !parseCheckedValue(after.body, 'MultifactorAuthentication')) {
      throw new Error('access change disabled MFA for ' + managerUserRef + ' — refusing to leave it off');
    }
    return res;
  }

  // Walk Settings → User Permissions for a business and hand back the
  // list page plus the URL it lives at.
  //
  // We navigate rather than construct: the only key we build is the
  // business name (see manager-permissions.js on why building record
  // keys is a footgun), and every URL after that is one of Manager's own
  // hrefs, followed verbatim.
  // The one page every business-scoped walk starts from. Its sidebar
  // carries the links we need — User Permissions and Customize (Tabs) —
  // so we never assemble a record URL ourselves.
  async function openSettings(businessName) {
    const settings = await client.get(P.settingsPath(businessName));
    if (settings.status !== 200) {
      throw new Error('could not open Settings for "' + businessName + '" (http ' + settings.status + ')');
    }
    return settings.body;
  }

  async function openPermissionsList(businessName) {
    const body = await openSettings(businessName);
    const listHref = V.findHref(body, P.PERMISSIONS_LIST);
    if (!listHref) {
      throw new Error('no User Permissions link in Settings for "' + businessName + '" — Manager\'s layout may have changed');
    }
    const list = await client.get(listHref);
    if (list.status !== 200) {
      throw new Error('could not open User Permissions for "' + businessName + '" (http ' + list.status + ')');
    }
    return { href: listHref, body: list.body };
  }

  // Give `username` Full access to `businessName`, creating the
  // permission record if they have none. Idempotent: a user already on
  // Full access is left alone, so a retry costs a read and nothing else.
  async function ensureFullAccess(businessName, username) {
    const list = await openPermissionsList(businessName);
    const row = P.findRowForUsername(list.body, username);

    let formHref = row ? row.href : P.findNewPermissionHref(list.body);
    if (!formHref) {
      throw new Error('no way to add User Permissions for ' + username + ' in "' + businessName + '"'
        + ' — neither an existing row nor a New link');
    }

    const form = await client.get(formHref);
    if (form.status !== 200) {
      throw new Error('could not open the permissions form for ' + username + ' (http ' + form.status + ')');
    }

    // Read-modify-write, exactly as with the user form: the post is the
    // record's COMPLETE new state, so we start from what Manager gave us
    // and change only what we mean to.
    const model = P.parseVueModel(form.body);
    model.Username = username;
    model.AccessType = P.ACCESS_FULL;
    model.FullAccess = true;

    const res = await client.postMultipart(formHref, { [P.MODEL_FIELD]: JSON.stringify(model) });
    if (res.status >= 400) {
      throw new Error('permissions form rejected for ' + username + ' in "' + businessName + '" (http ' + res.status + ')');
    }

    // Read back off the LIST, not the form: the list is what an owner
    // would look at, and it proves the record exists, belongs to this
    // user, and reads "Full access". Manager returns 200 for a post that
    // changed nothing, so without this a grant can report success while
    // leaving the staff member unable to work.
    const after = await openPermissionsList(businessName);
    const confirmed = P.findRowForUsername(after.body, username);
    if (!confirmed) {
      throw new Error('Manager accepted the permissions post but ' + username
        + ' still has no User Permissions record in "' + businessName + '"');
    }
    if (!/full access/i.test(confirmed.accessType)) {
      throw new Error('Manager left ' + username + ' on "' + confirmed.accessType
        + '" instead of Full access in "' + businessName + '"');
    }
    return { accessType: confirmed.accessType, created: !row };
  }

  // Turn on the tabs the firm works in. Additive: never unticks, so a
  // retry cannot undo a tab someone enabled deliberately. See
  // manager-tabs.js for why that trade was made.
  async function configureTabs(businessName, tabs) {
    const settings = await openSettings(businessName);
    const formHref = V.findHref(settings, T.TABS_FORM);
    if (!formHref) {
      throw new Error('no Customize (Tabs) link in the sidebar for "' + businessName
        + '" — Manager\'s layout may have changed');
    }

    const form = await client.get(formHref);
    if (form.status !== 200) {
      throw new Error('could not open the Tabs form for "' + businessName + '" (http ' + form.status + ')');
    }

    const model = V.parseVueModel(form.body);
    const turningOn = T.tabsToTurnOn(model, tabs);
    // Already right — don't write. Keeps a retry cheap, and keeps the
    // books' History clean of no-op edits.
    if (turningOn.length === 0) return { tabsEnabled: [], alreadyConfigured: true };

    const next = T.applyTabs(model, tabs);
    const res = await client.postMultipart(formHref, V.modelPayload(next));
    if (res.status >= 400) {
      throw new Error('Tabs form rejected for "' + businessName + '" (http ' + res.status + ')');
    }

    // Read back. Manager returns 200 for a post that changed nothing, so
    // without this the books could come out with the client's tabs
    // missing and the job reporting done.
    const after = await client.get(formHref);
    const missing = T.missingTabs(V.parseVueModel(after.body), tabs);
    if (missing.length) {
      throw new Error('Manager did not enable ' + missing.join(', ') + ' for "' + businessName + '"');
    }
    return { tabsEnabled: turningOn, alreadyConfigured: false };
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

    // Its own job, not part of createBusiness: createBusiness short-
    // circuits on manager_created_at to avoid making a second set of
    // books, so folding tabs in there would mean a failed tab write is
    // never retried.
    async configureTabs({ businessName, tabs }) {
      if (!businessName) throw new Error('businessName is required');
      return configureTabs(businessName, tabs);
    },

    // A restricted user with no businesses yet; grants follow as their
    // own jobs. Username is the email — it is what addresses the form
    // later, so it must be stable and unique, which an email already is.
    // MFA is on by default. Enrolment happens at the user's FIRST LOGIN —
    // Manager shows them a QR then — so ticking it here strands nobody.
    // (The confusing case is scanning from the admin form, where the value
    // is a candidate the save then replaces. Staff never see that form.)
    async createUser({ email, password, enableMfa }) {
      if (!email) throw new Error('email is required');
      if (!password) throw new Error('password is required');

      // The MultifactorAuthentication checkbox does NOT carry a boolean —
      // its value is a TOTP secret Manager generates fresh on every render
      // of the blank form. Posting 'on' is not a value it can parse, so it
      // silently creates the user with MFA off. Fetch the form and hand
      // back the exact secret it just minted.
      let mfaSecret = null;
      if (enableMfa !== false) {
        const blank = await client.get(USER_FORM);
        if (blank.status !== 200) throw new Error('could not open the new-user form (http ' + blank.status + ')');
        mfaSecret = parseCheckedValue(blank.body, 'MultifactorAuthentication')
          || parseInputAttr(blank.body, 'MultifactorAuthentication', 'value');
        if (!mfaSecret) throw new Error('new-user form has no MultifactorAuthentication value — cannot enable MFA');
      }

      const fields = {
        Name: email,
        EmailAddress: email,
        Username: email,
        Password: password,
        Type: 'Restricted',
        Businesses: [],
      };
      if (mfaSecret) fields.MultifactorAuthentication = mfaSecret;
      const res = await client.postForm(USER_FORM, fields);
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

    // Set a new password without disturbing anything else — same
    // read-modify-write, so their businesses and MFA secret survive.
    async setPassword({ managerUserRef, password }) {
      if (!password) throw new Error('password is required');
      await submitUserForm(managerUserRef, function (fields) {
        fields.Password = password;
      });
      return { reset: true };
    },

    // Both halves of a grant. The link goes first: the User Permissions
    // screen lives INSIDE the business, and a user who cannot open the
    // books has nothing for a permission record to apply to.
    async grantAccess({ managerUserRef, businessName }) {
      const value = businessOptionValue(businessName);
      await submitUserForm(managerUserRef, function (fields) {
        if (fields.Businesses.indexOf(value) === -1) fields.Businesses.push(value);
      });
      const access = await ensureFullAccess(businessName, managerUserRef);
      return { granted: true, accessType: access.accessType, permissionCreated: access.created };
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

// Revoke deliberately does NOT delete the User Permissions record. The
// Businesses multi-select is the gate — with the business unlinked the
// record applies to nothing — and deleting means building a key with the
// delete flag set, which is the one envelope this codebase refuses to
// construct. A leftover record is harmless and gets reused on re-grant.

module.exports = {
  createDriver, userFormPath, parseSelectedBusinesses, parseInputValue, parseSelectedOption,
  parseCheckedValue,
};
