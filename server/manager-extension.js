/* ============================================================
   Txform.ph — server/manager-extension.js

   The one Custom Button every provisioned client gets: the "Txform Now!"
   app, pinned to the Summary page. Manager calls these "Custom Buttons"
   in its UI (Settings → Custom Buttons) but keys them off /api4/extension
   internally — the same resource installer.html installs by hand.

   ── Not the Vue-form pattern ──
   Tabs and User Permissions are scraped Vue forms (see manager-vue-form.js),
   but extensions have a real api4 resource: a JSON create and a batch list.
   So this step is a plain POST + read-back, closer to createBusiness than to
   configureTabs. Business scoping is a `Manager-Business` header, exactly as
   Manager's own api-proxy.js sends it — verified against the live proxy on
   26.7.10.

   ── Keep in step with installer.html ──
   installer.html installs the identical button through the browser proxy.
   The Name / Source / Endpoint / Placement here MUST match TAXIFY_EXT there,
   or the two paths would install two different (or duplicate) buttons.
   ============================================================ */
'use strict';

const EXTENSION = '/api4/extension';
const EXTENSION_BATCH = '/api4/extension-batch';

// Source 0 = Url (1 = Inline HTML). Endpoint is the full https:// URL Manager
// loads in the iframe — the scheme is part of the stored value, not prefixed
// by Manager. Placement 'summary-view' pins the button to the Summary page.
const TXFORM_BUTTON = {
  Name: 'Txform Now!',
  Source: 0,
  Endpoint: 'https://extension.txform.ph/taxify.html',
  Placement: 'summary-view',
};

// api4 returns extensions as { items: [{ key, item: {...} }] }. Pull out the
// value objects, tolerant of an empty or missing page. Throws on genuinely
// unparseable output rather than treating it as "no buttons" — the latter
// would make a broken list read as "nothing installed" and re-create the
// button on every run.
function parseExtensions(body) {
  let parsed;
  try {
    parsed = JSON.parse(body || '{}');
  } catch (e) {
    throw new Error('could not parse the extension list: ' + e.message);
  }
  const items = (parsed && parsed.items) || [];
  return items.map(function (it) { return (it && (it.item || it.value)) || {}; });
}

// Is a button with this endpoint already installed? Manager stores it under
// Endpoint; the proxy path has been seen to lowercase it, so accept both.
function hasExtension(extensions, endpoint) {
  return (extensions || []).some(function (v) {
    return (v.Endpoint || v.endpoint) === endpoint;
  });
}

module.exports = { EXTENSION, EXTENSION_BATCH, TXFORM_BUTTON, parseExtensions, hasExtension };
