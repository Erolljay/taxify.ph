// Philippines BIR — Report definitions
// Each entry maps to one Manager Custom Button under Reports.
// `available: true` = JS exists and is ready to install.
// `available: false` = placeholder; shows as Coming Soon in the Reports tab.
// DO NOT change the `id` GUIDs after first install — they are the stable extension keys.

const BASE_URL = 'https://erolljay.github.io/taxify.ph';

const REPORTS = [

  // ── VALUE ADDED TAX ─────────────────────────────────────────
  {
    id: 'a1b2c3d4-0001-4000-8000-000000000001',
    name: 'VT – 2550M VAT Monthly Declaration',
    file: '2550m.html',
    group: 'Value Added Tax',
    req: 'vat',
    phase: 2,
    available: false,
  },
  {
    id: 'b2c3d4e5-f6a7-4890-b123-c4d5e6f7a8b9',
    name: 'VT – 2550Q VAT Quarterly Return',
    file: '2550q.html',
    group: 'Value Added Tax',
    req: 'vat',
    phase: 1,
    available: true,
  },
  {
    id: 'c3d4e5f6-a7b8-4901-c234-d5e6f7a8b9c0',
    name: 'VT – SLS Summary List of Sales',
    file: 'sls.html',
    group: 'Value Added Tax',
    req: 'vat',
    phase: 1,
    available: true,
  },
  {
    id: 'd4e5f6a7-b8c9-4012-d345-e6f7a8b9c0d1',
    name: 'VT – SLP Summary List of Purchases',
    file: 'slp.html',
    group: 'Value Added Tax',
    req: 'vat',
    phase: 1,
    available: true,
  },

  // ── PERCENTAGE TAX ───────────────────────────────────────────
  {
    id: 'a1b2c3d4-0002-4000-8000-000000000001',
    name: 'PT – 2551Q Percentage Tax Quarterly',
    file: '2551q.html',
    group: 'Percentage Tax',
    req: 'pt',
    phase: 2,
    available: false,
  },

  // ── EXPANDED WITHHOLDING TAX ─────────────────────────────────
  {
    id: 'a1b2c3d4-0003-4000-8000-000000000001',
    name: 'WE – 0619E EWT Monthly Remittance',
    file: '0619e.html',
    group: 'Expanded Withholding Tax',
    req: 'expanded',
    phase: 2,
    available: true,
  },
  {
    id: 'a1b2c3d4-0003-4000-8000-000000000002',
    name: 'WE – 1601EQ EWT Quarterly Return',
    file: '1601eq.html',
    group: 'Expanded Withholding Tax',
    req: 'expanded',
    phase: 2,
    available: true,
  },
  {
    id: 'e5f6a7b8-c9d0-4123-e456-f7a8b9c0d1e2',
    name: 'WE – QAP Quarterly Alphalist of Payees',
    file: 'qap.html',
    group: 'Expanded Withholding Tax',
    req: 'expanded',
    phase: 2,
    available: true,
  },
  {
    id: 'f6a7b8c9-d0e1-4234-f567-a8b9c0d1e2f3',
    name: 'IT – SAWT Summary Alphalist of Withholding Taxes',
    file: 'sawt.html',
    group: 'Income Tax',
    req: 'expanded',
    phase: 2,
    available: true,
  },
  {
    id: 'a7b8c9d0-e1f2-4345-a678-b9c0d1e2f3a4',
    name: 'WE – BIR Form 2307 Certificate of Creditable WT',
    file: '2307.html',
    group: 'Expanded Withholding Tax',
    req: 'expanded',
    phase: 1,
    available: true,
  },

  // ── FINAL WITHHOLDING TAX ────────────────────────────────────
  {
    id: 'a1b2c3d4-0004-4000-8000-000000000001',
    name: 'FWT – 0619F FWT Monthly Remittance',
    file: '0619f.html',
    group: 'Final Withholding Tax',
    req: 'final',
    phase: 3,
    available: false,
  },
  {
    id: 'a1b2c3d4-0004-4000-8000-000000000002',
    name: 'FWT – 1601FQ FWT Quarterly Return',
    file: '1601fq.html',
    group: 'Final Withholding Tax',
    req: 'final',
    phase: 3,
    available: false,
  },

  // ── COMPENSATION WITHHOLDING TAX ─────────────────────────────
  {
    id: 'a1b2c3d4-0005-4000-8000-000000000001',
    name: 'WC – 1601C WTC Monthly Remittance',
    file: '1601c.html',
    group: 'Compensation (Payroll)',
    req: 'compensation',
    phase: 2,
    available: true,
  },
  {
    id: 'b8c9d0e1-f2a3-4456-b789-c0d1e2f3a4b5',
    name: 'WC – BIR Form 2316 Certificate of Compensation',
    file: 'alphalist.html#2316',
    group: 'Compensation (Payroll)',
    req: 'compensation',
    phase: 2,
    available: true,
  },
  {
    id: 'c9d0e1f2-a3b4-4567-c890-d1e2f3a4b5c6',
    name: 'WC – SSS PhilHealth Pag-IBIG Remittance',
    file: 'sss.html',
    group: 'Compensation (Payroll)',
    req: 'compensation',
    phase: 2,
    available: true,
  },

  // ── INCOME TAX – CORPORATION ─────────────────────────────────
  {
    id: 'a1b2c3d4-0006-4000-8000-000000000001',
    name: 'IT – 1702Q Quarterly Income Tax Return (Corp)',
    file: '1702q.html',
    group: 'Income Tax',
    req: 'nonindividual',
    phase: 3,
    available: true,
  },
  {
    id: 'a1b2c3d4-0006-4000-8000-000000000002',
    name: 'IT – 1702RT Annual Income Tax Return (Corp)',
    file: '1702rt.html',
    group: 'Income Tax',
    req: 'nonindividual',
    phase: 3,
    available: true,
  },

  // ── INCOME TAX – INDIVIDUAL ──────────────────────────────────
  {
    id: 'a1b2c3d4-0007-4000-8000-000000000001',
    name: 'IT – 1701Q Quarterly Income Tax Return (Indiv)',
    file: '1701q.html',
    group: 'Income Tax',
    req: 'individual',
    phase: 3,
    available: true,
  },
  {
    id: 'a1b2c3d4-0007-4000-8000-000000000002',
    name: 'IT – 1701 Annual Income Tax Return (Indiv)',
    file: '1701.html',
    group: 'Income Tax',
    req: 'individual',
    phase: 3,
    available: true,
  },
];

function reportEndpoint(report) {
  return `${BASE_URL}/${report.file}`;
}

// Setup-tab installs: standalone tools placed onto specific Manager pages
// (not the generic Reports tab). Placement maps to Manager's own page key.
// DO NOT change the `id` GUIDs after first install — they are the stable extension keys.
const BATCH_IMPORT_INSTALLS = [
  {
    id: '1a2b3c4d-5e6f-4789-9abc-d1e2f3a4b5c6',
    name: 'Batch Import — Sales Invoices',
    file: 'batch-import-sales.html',
    placement: 'sales-invoices',
  },
  {
    id: '2b3c4d5e-6f7a-4890-abcd-e1f2a3b4c5d6',
    name: 'Batch Import — Purchase Invoices',
    file: 'batch-import-purchase.html',
    placement: 'purchase-invoices',
  },
  {
    id: '3c4d5e6f-7a8b-4901-bcde-f2a3b4c5d6e7',
    name: 'Batch Import — Payroll',
    file: 'batch-import-payroll.html',
    placement: 'payslips',
  },
  {
    id: '4d5e6f7a-8b9c-4a12-9cde-a3b4c5d6e7f8',
    name: 'Batch Collect — Receivables',
    file: 'batch-import-receivables.html',
    placement: 'receipts',
  },
  {
    id: '5e6f7a8b-9c0d-4b23-adef-b4c5d6e7f8a9',
    name: 'Batch Collect — Payables',
    file: 'batch-import-payables.html',
    placement: 'payments',
  },
];
