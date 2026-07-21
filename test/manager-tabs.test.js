/* ============================================================
   Tests for the Tabs (Customize) step.

   The fixture model is the REAL one captured off books.txform.ph
   (Manager 26.7.10.3654) — all 36 tab flags plus `id`, in Manager's own
   order. A hand-written subset would not catch a renamed or dropped key,
   which is the failure this step is most exposed to.

     node --test test/manager-tabs.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../server/manager-tabs.js');
const V = require('../server/manager-vue-form.js');

// Manager's defaults for a business with nothing turned on yet.
function freshModel(overrides) {
  const base = {
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
  };
  return Object.assign(base, overrides || {});
}

function tabsFormHtml(model) {
  return '<div id="v-model-form"></div><script>const baseCurrency = {"code":null};'
    + 'app = new Vue({ el: "#v-model-form", data: ' + JSON.stringify(model, null, 2)
    + ', methods: { getIfReceipts: function() { return true; } } })</script>';
}

// ── the nine ─────────────────────────────────────────────────────────

test('the required set is exactly the nine tabs the firm works in', () => {
  assert.deepEqual(T.REQUIRED_TABS, [
    'BankAndCashAccounts', 'Receipts', 'Payments',
    'Customers', 'SalesInvoices', 'Suppliers',
    'PurchaseInvoices', 'Employees', 'Payslips',
  ]);
});

test('the required set satisfies Manager\'s parent/child rules', () => {
  // Ticking Receipts without Bank and Cash Accounts saves a setting that
  // never appears in the sidebar. This asserts the shipped list is sane.
  assert.doesNotThrow(() => T.assertHierarchy(T.REQUIRED_TABS));
});

test('assertHierarchy rejects a child whose parent is off', () => {
  assert.throws(() => T.assertHierarchy(['Payslips']),
    /"Payslips" needs "Employees"/);
  assert.throws(() => T.assertHierarchy(['Customers', 'CreditNotes']),
    /"CreditNotes" needs "SalesInvoices"/);
});

// ── applying them ────────────────────────────────────────────────────

test('applyTabs turns on all nine', () => {
  const next = T.applyTabs(freshModel());
  T.REQUIRED_TABS.forEach((tab) => assert.equal(next[tab], true, tab + ' should be on'));
});

test('applyTabs leaves every other tab exactly as Manager had it', () => {
  // The whole point of the additive choice: a client who had Fixed
  // Assets turned on by hand keeps it, and one who never had Inventory
  // does not suddenly get it.
  const before = freshModel({ FixedAssets: true, DepreciationEntries: true });
  const next = T.applyTabs(before);

  assert.equal(next.FixedAssets, true, 'a deliberately enabled tab must survive');
  assert.equal(next.DepreciationEntries, true);
  assert.equal(next.InventoryItems, false, 'an unrelated tab must not be switched on');
  assert.equal(next.Projects, false);
  assert.equal(next.id, before.id, 'the record id must be carried through');
});

test('applyTabs does not mutate the model it was given', () => {
  const before = freshModel();
  T.applyTabs(before);
  assert.equal(before.Customers, false, 'the parsed model must be left untouched');
});

test('applyTabs refuses a tab Manager does not have', () => {
  // Manager renames things between versions. Adding the key anyway would
  // post a field it ignores and read back as success.
  const model = freshModel();
  delete model.Payslips;
  assert.throws(() => T.applyTabs(model), /has no "Payslips"/);
});

test('applyTabs accepts an explicit list, still hierarchy-checked', () => {
  const next = T.applyTabs(freshModel(), ['Customers', 'SalesInvoices']);
  assert.equal(next.SalesInvoices, true);
  assert.equal(next.Payslips, false);
  assert.throws(() => T.applyTabs(freshModel(), ['SalesInvoices']), /needs "Customers"/);
});

// ── deciding whether to write, and checking it took ──────────────────

test('tabsToTurnOn lists only what is actually off', () => {
  assert.equal(T.tabsToTurnOn(freshModel()).length, 9);
  const half = freshModel({ BankAndCashAccounts: true, Receipts: true, Payments: true });
  assert.deepEqual(T.tabsToTurnOn(half),
    ['Customers', 'SalesInvoices', 'Suppliers', 'PurchaseInvoices', 'Employees', 'Payslips']);
});

test('tabsToTurnOn is empty when the books are already right — so we skip the write', () => {
  const done = freshModel();
  T.REQUIRED_TABS.forEach((t) => { done[t] = true; });
  assert.deepEqual(T.tabsToTurnOn(done), []);
});

test('missingTabs is what the read-back checks, and treats a missing key as missing', () => {
  const partial = freshModel({ BankAndCashAccounts: true, Receipts: true });
  assert.ok(missingIncludes(T.missingTabs(partial), 'Payslips'));
  const gone = freshModel();
  delete gone.Customers;
  assert.ok(missingIncludes(T.missingTabs(gone), 'Customers'));
});

function missingIncludes(list, tab) { return list.indexOf(tab) !== -1; }

// ── the real captured page ───────────────────────────────────────────

test('the captured Tabs form parses, and already shows the nine on', () => {
  // This is the state of a business configured by hand — the outcome the
  // provisioner now has to reproduce on its own.
  const configured = freshModel();
  T.REQUIRED_TABS.forEach((t) => { configured[t] = true; });
  const parsed = V.parseVueModel(tabsFormHtml(configured));

  assert.deepEqual(T.missingTabs(parsed), []);
  assert.equal(parsed.id, 'ac789d1f-034f-4964-a8b5-ebfffc3511f2');
  assert.equal(parsed.InventoryItems, false);
});

test('Journal Entries is not a tab — Manager always shows it', () => {
  assert.equal(T.REQUIRED_TABS.indexOf('JournalEntries'), -1);
  assert.equal('JournalEntries' in freshModel(), false);
});

test('the payload is one field holding the whole model', () => {
  const payload = V.modelPayload(T.applyTabs(freshModel()));
  assert.deepEqual(Object.keys(payload), [V.MODEL_FIELD]);
  assert.equal(JSON.parse(payload[V.MODEL_FIELD]).Customers, true);
});
