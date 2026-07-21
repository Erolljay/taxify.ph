/* ============================================================
   Txform.ph — server/manager-permissions.js

   Reading and writing Manager's per-business User Permissions record:
   the screen at Settings → User Permissions, whose `Access type` is
   what actually decides whether a staff member can DO anything in a
   set of books.

   ── Why this file exists ──
   Until now the codebase believed Manager had no per-user permissions
   page, and that access was entirely the `Businesses` multi-select on
   /user-form. That is half right, and the missing half is the reason a
   provisioned staff member could sign in, see the client's books listed,
   and still be unable to work in them:

     /user-form Businesses   →  WHICH books they can open
     User Permissions record →  WHAT they can do once inside

   Granting is therefore two writes, not one. Both are verified.

   /user-permissions-form is one of Manager's Vue-backed screens — see
   manager-vue-form.js for how those are read and written, and for the
   field-250 hazard that is why this module follows Manager's own hrefs
   instead of building record URLs.

   Field 101 of the URL envelope is a "referrer" breadcrumb and is
   cosmetic: the same record answers to referrer "/users" and to a deeply
   nested settings chain. Nothing here depends on reproducing it.
   ============================================================ */
'use strict';

const { managerKey } = require('./manager-client.js');
const V = require('./manager-vue-form.js');

// `Access type` on the form. 0 = Custom access (per-tab checkboxes),
// 1 = Full access. Those are the only two options Manager offers.
const ACCESS_CUSTOM = 0;
const ACCESS_FULL = 1;

const SETTINGS = '/settings';
const PERMISSIONS_LIST = '/user-permissions';
const PERMISSIONS_FORM = '/user-permissions-form';

// The one key we build ourselves: business name only. Same shape as the
// sidebar's /settings and /summary-view links, so it is known good.
function settingsPath(businessName) {
  if (!businessName) throw new Error('businessName is required');
  return SETTINGS + '?' + managerKey([{ field: 100, string: businessName }]);
}

// Strip tags and collapse whitespace — cell text is wrapped in <span>.
function cellText(cell) {
  return cell.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// The list table: one row per user with access to this business, each
// carrying its own Edit link. Returns { username, accessType, href }.
//
// The href is kept VERBATIM and reused as the form URL — that is what
// keeps us out of the business of encoding record keys.
function parsePermissionRows(html) {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html || '');
  if (!body) return [];
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = rowRe.exec(body[1])) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(r[1])) !== null) cells.push(c[1]);
    if (cells.length < 3) continue;
    const href = V.findHref(cells[0], PERMISSIONS_FORM);
    if (!href) continue;
    rows.push({ href: href, username: cellText(cells[1]), accessType: cellText(cells[2]) });
  }
  return rows;
}

function findRowForUsername(html, username) {
  const want = String(username || '').trim().toLowerCase();
  return parsePermissionRows(html).find(function (row) {
    return row.username.toLowerCase() === want;
  }) || null;
}

// The "New User Permissions" link — present on the list page, and the
// only way to add a record for a user who has none yet.
function findNewPermissionHref(html) {
  const re = /href\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    // The create link is a /user-permissions-form href with no record
    // key. Every Edit link in the table has one, so "shortest wins" is
    // not safe — instead take the one that is not inside the table body.
    if (m[1].indexOf(PERMISSIONS_FORM) === 0 && !isInsideTbody(html, m.index)) return m[1];
  }
  return null;
}

function isInsideTbody(html, index) {
  const open = html.lastIndexOf('<tbody', index);
  if (open === -1) return false;
  const close = html.lastIndexOf('</tbody>', index);
  return close < open;
}

module.exports = {
  ACCESS_CUSTOM, ACCESS_FULL,
  SETTINGS, PERMISSIONS_LIST, PERMISSIONS_FORM,
  settingsPath, parsePermissionRows, findRowForUsername, findNewPermissionHref,
  // Re-exported so callers and tests have one import for a permissions
  // round trip, even though these are generic to every Vue form.
  MODEL_FIELD: V.MODEL_FIELD, findHref: V.findHref, parseVueModel: V.parseVueModel,
};
