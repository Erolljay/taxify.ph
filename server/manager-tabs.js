/* ============================================================
   Txform.ph — server/manager-tabs.js

   Which tabs a set of books shows down its left-hand side. Manager's
   "Customize" screen (/tabs-form), reached from the bottom of any
   business sidebar.

   Fresh books arrive with Manager's own defaults, which are not the ones
   a Philippine bookkeeping engagement needs. This turns on the nine the
   firm actually works in, so a newly provisioned client is usable
   immediately rather than after a round of manual ticking.

   ── Additive by design ──
   The step only ever turns tabs ON. It never turns one off. A client who
   later needs Fixed Assets or Inventory gets it switched on by hand, and
   nothing here will quietly undo that — including on a retry, which
   matters because provisioner jobs retry up to MAX_ATTEMPTS.

   That is a deliberate trade: books may end up with a Manager default we
   did not ask for, which is untidy. The alternative — forcing an exact
   set — is destructive on every re-run, and losing a tab someone turned
   on for a reason is the worse failure.

   ── Manager enforces a hierarchy ──
   Child tabs only exist while their parent is on: no Receipts without
   Bank and Cash Accounts, no Sales Invoices without Customers, and so
   on. Ticking a child alone produces a setting that silently never
   appears. PARENTS encodes that, and assertHierarchy refuses to build a
   payload that violates it.

   Journal Entries has no checkbox — Manager always shows it.
   ============================================================ */
'use strict';

const V = require('./manager-vue-form.js');

const TABS_FORM = '/tabs-form';

// The nine the firm works in. Order is cosmetic; the model is flat.
const REQUIRED_TABS = [
  'BankAndCashAccounts',
  'Receipts',
  'Payments',
  'Customers',
  'SalesInvoices',
  'Suppliers',
  'PurchaseInvoices',
  'Employees',
  'Payslips',
];

// child -> parent, taken from the getIf* guards Manager emits on the
// form. Only the branches we touch are listed; adding a tab means adding
// its parent here too, and the test will say so if you forget.
const PARENTS = {
  Receipts: 'BankAndCashAccounts',
  Payments: 'BankAndCashAccounts',
  InterAccountTransfers: 'BankAndCashAccounts',
  BankReconciliations: 'BankAndCashAccounts',
  SalesQuotes: 'Customers',
  SalesOrders: 'Customers',
  SalesInvoices: 'Customers',
  DeliveryNotes: 'Customers',
  CreditNotes: 'SalesInvoices',
  LatePaymentFees: 'SalesInvoices',
  BillableTime: 'SalesInvoices',
  WithholdingTaxReceipts: 'SalesInvoices',
  PurchaseQuotes: 'Suppliers',
  PurchaseOrders: 'Suppliers',
  PurchaseInvoices: 'Suppliers',
  GoodsReceipts: 'Suppliers',
  DebitNotes: 'PurchaseInvoices',
  Payslips: 'Employees',
  InventoryTransfers: 'InventoryItems',
  InventoryWriteOffs: 'InventoryItems',
  ProductionOrders: 'InventoryItems',
  DepreciationEntries: 'FixedAssets',
  AmortizationEntries: 'IntangibleAssets',
};

// A tab whose parent is off would be saved and never shown. Catch it
// here, at build time, rather than wondering later why a sidebar is
// missing something the database says is enabled.
function assertHierarchy(tabs) {
  const on = new Set(tabs);
  tabs.forEach(function (tab) {
    const parent = PARENTS[tab];
    if (parent && !on.has(parent)) {
      throw new Error('tab "' + tab + '" needs "' + parent + '" enabled or it never appears');
    }
  });
}

// Turn the wanted tabs on, leave every other key exactly as Manager gave
// it. Returns a NEW object — the caller keeps the original to compare
// against, and nothing mutates the parsed model in place.
function applyTabs(model, tabs) {
  const wanted = tabs || REQUIRED_TABS;
  assertHierarchy(wanted);
  const next = Object.assign({}, model);
  wanted.forEach(function (tab) {
    if (!(tab in next)) {
      // Manager renames things between versions. Silently adding an
      // unknown key would post a field it ignores and report success.
      throw new Error('Manager\'s Tabs form has no "' + tab + '" — its layout may have changed');
    }
    next[tab] = true;
  });
  return next;
}

// Which of the wanted tabs are still off. Used for the read-back: an
// empty list is the only acceptable end state.
function missingTabs(model, tabs) {
  return (tabs || REQUIRED_TABS).filter(function (tab) { return model[tab] !== true; });
}

// Which tabs this call would actually change — for logging, and to skip
// a pointless write when the books are already right.
function tabsToTurnOn(model, tabs) {
  return (tabs || REQUIRED_TABS).filter(function (tab) { return model[tab] !== true; });
}

module.exports = {
  TABS_FORM, REQUIRED_TABS, PARENTS,
  assertHierarchy, applyTabs, missingTabs, tabsToTurnOn,
  MODEL_FIELD: V.MODEL_FIELD,
};
