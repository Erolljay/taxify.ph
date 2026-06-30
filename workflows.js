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
        key: 'vat-instructions',
        type: 'instruction',
        label: 'Before you start',
        body: `Open Manager's native <strong>Reports → Tax Audit</strong> report first and confirm there are no
          transactions missing a Tax Code — especially Profit &amp; Loss accounts (sales and expense/purchase
          lines). VAT and SLS/SLP/SAWT figures are only correct if every relevant transaction has a Tax Code
          applied. Once you've confirmed that, continue.`,
      },
      {
        key: 'vat-period',
        type: 'period',
        label: 'Choose filing period',
        help: 'Pick Monthly or Quarterly and the period to file. This applies to every step below.',
      },
      {
        key: 'vat-2550q-review',
        type: 'review',
        label: 'Review 2550Q — VAT Quarterly Return',
        help: 'Review the return and the Tax Codes mapping tab. Confirm the figures look right before continuing.',
        file: findReport('2550q.html').file,
        iframeId: 'vat-2550q',
        usesPeriod: true,
      },
      {
        key: 'sls-review',
        type: 'review',
        label: 'Review Summary List of Sales',
        help: 'Generate the SLS for the period and confirm the figures look right.',
        file: findReport('sls.html').file,
        iframeId: 'sls',
        usesPeriod: true,
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
        help: 'Generate the SLP for the period and confirm the figures look right.',
        file: findReport('slp.html').file,
        iframeId: 'slp',
        usesPeriod: true,
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
        label: 'Download SAWT (if VAT was withheld from you this quarter)',
        help: 'Only required if any customer withheld VAT on payments to you this quarter.',
        file: findReport('sawt.html').file,
        iframeId: 'sawt',
        usesPeriod: true,
        formParam: '2550Q',
        buttonIds: ['sawt-excel', 'sawt-dat'],
        requireAll: false,
        skippable: true,
        skipLabel: 'No VAT withheld this quarter — skip',
      },
      {
        key: 'vat-payment',
        type: 'payment',
        label: 'Record VAT payment',
        help: 'Posts the VAT due (or closing entry, if fully covered by input tax / CWT credits) into Manager.',
        sourceStepKey: 'vat-2550q-review',
      },
      {
        key: 'vat-final',
        type: 'final',
        label: 'Download working paper',
        help: 'Download everything you prepared in this workflow. To save the 2550Q, SLS, SLP, or SAWT as a PDF for the client, open that step and use its own "Print / Save as PDF" button.',
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
