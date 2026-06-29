/* ============================================================
   Taxify it! — workflow definitions consumed by StepEngine.
   Categories are keyed the same way REPORTS[].req is in reports.js, so
   the User-mode landing screen and these step sequences both read from
   that single source of truth instead of duplicating report metadata.

   VAT is fully fleshed out per spec. The other categories are intentionally
   thin (review the relevant reports, then file) until their own step-by-step
   sequences are scoped — they still run through the same generic engine.
   ============================================================ */

function findReport(file) {
  return REPORTS.find(r => r.file === file);
}

// Customers/suppliers missing a TIN block a filing — flag every party on
// file rather than only ones with this quarter's transactions, since the
// data model has no cheap way to scope "transacted this period" outside of
// the report's own row-building logic (sls-report.js / slp-report.js).
async function checkPartyTIN(biz, partyType) {
  const parties = await loadPartyBIR(biz, partyType);
  const problems = Object.values(parties)
    .filter(p => !p.tin)
    .map(p => p.name);
  if (!problems.length) return { ok: true };
  const noun = partyType === 'customer' ? 'customers' : 'suppliers';
  return {
    ok: false,
    message: `${problems.length} ${noun} are missing a TIN.`,
    problems,
  };
}

const WORKFLOWS = {

  vat: {
    key: 'vat',
    label: 'Value Added Tax',
    steps: [
      {
        key: 'sls-review',
        type: 'review',
        label: 'Review Summary List of Sales',
        help: 'Generate the SLS for the quarter and confirm the figures look right.',
        file: findReport('sls.html').file,
        iframeId: 'sls',
      },
      {
        key: 'sls-tin-check',
        type: 'validate',
        label: 'Check customer TINs',
        help: 'Every customer on file needs a TIN before the SLS can be submitted.',
        check: (biz) => checkPartyTIN(biz, 'customer'),
        fixLabel: 'Open Customers screen →',
        fixIframeId: 'sls',
        fixFile: findReport('sls.html').file,
        fixTabSelector: '[data-tab="customers"]',
      },
      {
        key: 'sls-download',
        type: 'download',
        label: 'Download SLS (Excel / DAT)',
        help: 'Download the SLS Excel and/or DAT file before continuing.',
        file: findReport('sls.html').file,
        iframeId: 'sls',
        buttonIds: ['sl-excel', 'sl-dat'],
        requireAll: false,
      },
      {
        key: 'slp-review',
        type: 'review',
        label: 'Review Summary List of Purchases',
        help: 'Generate the SLP for the quarter and confirm the figures look right.',
        file: findReport('slp.html').file,
        iframeId: 'slp',
      },
      {
        key: 'slp-tin-check',
        type: 'validate',
        label: 'Check supplier TINs',
        help: 'Every supplier on file needs a TIN before the SLP can be submitted.',
        check: (biz) => checkPartyTIN(biz, 'supplier'),
        fixLabel: 'Open Suppliers screen →',
        fixIframeId: 'slp',
        fixFile: findReport('slp.html').file,
        fixTabSelector: '[data-tab="suppliers"]',
      },
      {
        key: 'slp-download',
        type: 'download',
        label: 'Download SLP (Excel / DAT)',
        help: 'Download the SLP Excel and/or DAT file before continuing.',
        file: findReport('slp.html').file,
        iframeId: 'slp',
        buttonIds: ['sl-excel', 'sl-dat'],
        requireAll: false,
      },
      {
        key: 'sawt-download',
        type: 'download',
        label: 'Download SAWT (if you withheld EWT this quarter)',
        help: 'Only required if you withheld Expanded Withholding Tax from any supplier this quarter.',
        file: findReport('sawt.html').file,
        iframeId: 'sawt',
        buttonIds: ['sawt-excel', 'sawt-dat'],
        requireAll: false,
        skippable: true,
        skipLabel: 'No EWT withheld this quarter — skip',
      },
      {
        key: 'vat-final',
        type: 'final',
        label: 'File 2550Q — VAT Quarterly Return',
        help: 'Review the 2550Q, then download everything you prepared in this workflow.',
        file: findReport('2550q.html').file,
        iframeId: 'vat-2550q',
        bundle: ['sls-download', 'slp-download', 'sawt-download'],
      },
    ],
  },

  expanded: {
    key: 'expanded',
    label: 'Expanded Withholding Tax',
    steps: [
      {
        key: 'qap-review',
        type: 'review',
        label: 'Review Quarterly Alphalist of Payees',
        file: findReport('qap.html').file,
        iframeId: 'qap',
      },
      {
        key: 'ewt-final',
        type: 'final',
        label: 'File 1601EQ — EWT Quarterly Return',
        file: findReport('1601eq.html').file,
        iframeId: 'ewt-1601eq',
      },
    ],
  },

  compensation: {
    key: 'compensation',
    label: 'Compensation (Payroll)',
    steps: [
      {
        key: 'payroll-review',
        type: 'review',
        label: 'Review payroll withholding',
        file: findReport('1601c.html').file,
        iframeId: 'payroll',
      },
      {
        key: 'compensation-final',
        type: 'final',
        label: 'File 1601C — Monthly Remittance',
        file: findReport('1601c.html').file,
        iframeId: 'payroll',
      },
    ],
  },

  individual: {
    key: 'individual',
    label: 'Income Tax (Individual)',
    steps: [
      {
        key: 'itr-review',
        type: 'review',
        label: 'Review Quarterly Income Tax Return',
        file: findReport('1701q.html').file,
        iframeId: 'itr',
      },
      {
        key: 'itr-final',
        type: 'final',
        label: 'File 1701Q',
        file: findReport('1701q.html').file,
        iframeId: 'itr',
      },
    ],
  },

  nonindividual: {
    key: 'nonindividual',
    label: 'Income Tax (Corporation)',
    steps: [
      {
        key: 'itr-review',
        type: 'review',
        label: 'Review Quarterly Income Tax Return',
        file: findReport('1702q.html').file,
        iframeId: 'itr',
      },
      {
        key: 'itr-final',
        type: 'final',
        label: 'File 1702Q',
        file: findReport('1702q.html').file,
        iframeId: 'itr',
      },
    ],
  },
};

// Category cards shown on the User-mode landing screen. `req` matches
// REPORTS[].req so future filtering by registered tax type can reuse it;
// `income` groups individual/nonindividual under one card, picked by
// setup.classification at render time.
const WORKFLOW_CATEGORIES = [
  { key: 'vat',           label: 'Value Added Tax',            icon: '🧾', req: 'vat' },
  { key: 'expanded',      label: 'Expanded Withholding Tax',    icon: '📑', req: 'expanded' },
  { key: 'compensation',  label: 'Compensation (Payroll)',      icon: '👥', req: 'compensation' },
  { key: 'income',        label: 'Income Tax',                  icon: '💰', req: 'income' },
];
