/* ============================================================
   Txform.ph — server/provisioner-driver-playwright.js  (Phase 1.4)

   The real driver behind provisioner.js: headless Chromium that logs
   into Manager Server's admin UI and creates/grants/revokes/disables
   restricted users. This is the ONLY piece that needs a dependency:

       npm install playwright && npx playwright install chromium

   It is intentionally isolated so the rest of the backend stays
   dependency-free and unit-tested; this adapter is verified against a
   live Manager instance (staging), not in CI-without-a-browser.

   ⚠ SELECTORS ARE PLACEHOLDERS. Manager Server's admin DOM isn't known
   here — every locator marked TODO must be confirmed against the real
   books.txform.ph admin UI before this runs in anger. The structure
   (login-once, per-action page, screenshot-every-step, typed return
   shape) is what matters and is final; the selectors are stubs.

   Implements the driver interface consumed by provisioner.js:
     createUser({ email }) -> { managerUserRef, screenshot }
     grantAccess({ managerUserRef, businessName }) -> { screenshot }
     revokeAccess({ managerUserRef, businessName }) -> { screenshot }
     disableUser({ managerUserRef }) -> { screenshot }
     close()
   ============================================================ */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

function createDriver(cfg) {
  const { baseUrl, adminUser, adminPass, screenshotDir } = cfg;
  if (!adminUser || !adminPass) throw new Error('MANAGER_ADMIN_USER / MANAGER_ADMIN_PASS required');
  fs.mkdirSync(screenshotDir, { recursive: true });

  let browser = null;
  let context = null;

  // Lazy require so importing this module doesn't hard-require playwright
  // until an action actually runs.
  async function ensureLogin() {
    if (context) return context;
    const { chromium } = require('playwright');
    browser = await browser || (await chromium.launch({ headless: true }));
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseUrl + '/login'); // TODO: confirm Manager login path
    // TODO: confirm Manager login field selectors
    await page.fill('input[name="username"]', adminUser);
    await page.fill('input[name="password"]', adminPass);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await page.close();
    return context;
  }

  // Screenshot every action, named by job kind + timestamp, so a run is
  // auditable and failures are diagnosable (plan requirement).
  async function shoot(page, label) {
    const file = path.join(screenshotDir, label + '-' + Date.now() + '.png');
    try { await page.screenshot({ path: file, fullPage: true }); } catch (e) { /* best-effort */ }
    return file;
  }

  async function withPage(fn) {
    await ensureLogin();
    const page = await context.newPage();
    try { return await fn(page); }
    finally { await page.close(); }
  }

  return {
    async createUser({ email }) {
      return withPage(async (page) => {
        await page.goto(baseUrl + '/admin/users/new'); // TODO: confirm path
        // TODO: fill the restricted-user form (email, restricted role) and submit
        // TODO: read back the created user's id/key from the URL or the row
        const managerUserRef = null; // TODO: capture the real Manager user id
        const screenshot = await shoot(page, 'create');
        if (!managerUserRef) throw new Error('createUser not implemented: capture managerUserRef');
        return { managerUserRef, screenshot };
      });
    },

    // Manager has NO per-user permissions page. Access is the `Businesses`
    // multi-select on the user form itself, so grant and revoke are the same
    // operation: re-open /user-form?<base64 email>, edit the selection, save.
    // Option values are base64(businessName) — hence businessName, not an id.
    async grantAccess({ managerUserRef, businessName }) {
      return withPage(async (page) => {
        await page.goto(baseUrl + '/user-form?' + Buffer.from(managerUserRef).toString('base64'));
        // TODO: select the option whose value is base64(businessName), keeping
        // the existing selection, then submit the form.
        const screenshot = await shoot(page, 'grant');
        throw new Error('grantAccess not implemented');
        return { screenshot }; // eslint-disable-line no-unreachable
      });
    },

    async revokeAccess({ managerUserRef, businessName }) {
      return withPage(async (page) => {
        await page.goto(baseUrl + '/user-form?' + Buffer.from(managerUserRef).toString('base64'));
        // TODO: deselect the option whose value is base64(businessName),
        // keeping the rest, then submit the form.
        const screenshot = await shoot(page, 'revoke');
        throw new Error('revokeAccess not implemented');
        return { screenshot }; // eslint-disable-line no-unreachable
      });
    },

    async disableUser({ managerUserRef }) {
      return withPage(async (page) => {
        await page.goto(baseUrl + '/admin/users/' + managerUserRef); // TODO
        const screenshot = await shoot(page, 'disable');
        throw new Error('disableUser not implemented');
        return { screenshot }; // eslint-disable-line no-unreachable
      });
    },

    async close() {
      if (context) await context.close();
      if (browser) await browser.close();
    },
  };
}

module.exports = { createDriver };
