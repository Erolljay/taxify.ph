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

// Reports whether each Deferred Tax Asset carry-forward account (see
// DTA_ROLES in pnl-helpers.js) resolves to a real Manager account — either
// explicitly via the COA tab's "Deferred Tax Asset Role" dropdown, or by
// matching the role's default name. Informational only: a missing account
// just means that figure defaults to ₱0.00 on the return (the same
// fallback 1701q/1702q-report.js already use), so this never blocks
// filing — see the 'checklist' step type in step-engine.js. roleKeys
// restricts which roles get checked (1701Q has no MCIT, so the individual
// workflow only checks 'priorYearExcessCredit'); omit for all 4.
async function checkDtaAccounts(biz, roleKeys) {
  const coa = await loadChartOfAccounts(biz);
  const dtaMap = await getDtaRoleMapping(biz);
  const today = new Date();

  const roles = roleKeys ? DTA_ROLES.filter(r => roleKeys.includes(r.key)) : DTA_ROLES;
  const rows = [];
  for (const role of roles) {
    const account = findDtaAccount(coa, dtaMap, role.key);
    if (!account) {
      rows.push({
        ok: false,
        label: role.label,
        detail: 'No account mapped or found by default name — this figure will read as ₱0.00 until one is set up in Settings → Chart of Accounts.',
      });
      continue;
    }
    if (role.key === 'mcitCarryforward') {
      const aged = await getDtaAgedBalance(biz, coa, dtaMap, today, role.key);
      let detail = `"${account.name}" — usable: ₱${fmt(aged.usable)}`;
      if (aged.expiringSoon > 0.005) detail += `, expiring this year: ₱${fmt(aged.expiringSoon)}`;
      if (aged.expired > 0.005) detail += `, expired: ₱${fmt(aged.expired)}`;
      rows.push({ ok: true, label: role.label, detail });
    } else {
      const balance = await getDtaBalance(biz, coa, dtaMap, today, role.key);
      rows.push({ ok: true, label: role.label, detail: `"${account.name}" — current balance: ₱${fmt(balance)}` });
    }
  }

  const allMapped = rows.every(r => r.ok);
  return {
    ok: allMapped,
    message: allMapped
      ? `All ${roles.length} carry-forward account${roles.length === 1 ? '' : 's'} ${roles.length === 1 ? 'is' : 'are'} mapped.`
      : "Some carry-forward accounts aren't set up yet — this is informational only and won't block filing.",
    rows,
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
        key: 'ewt-instructions',
        type: 'instruction',
        label: 'Before you start',
        body: `Open Manager's native <strong>Reports → Tax Audit</strong> report first and confirm there are no
          supplier payments missing an EWT Tax Code. Every purchase invoice or payment with an expanded withholding
          tax component must have its EWT tax code applied before generating the return — amounts are only correct
          when all transactions are coded. Once confirmed, continue.`,
      },
      {
        key: 'ewt-period',
        type: 'period',
        label: 'Choose filing period',
        help: 'Monthly → files 0619-E (monthly remittance). Quarterly → files 1601-EQ (quarterly return + QAP alphalist).',
      },
      {
        key: 'ewt-return-review',
        type: 'review',
        label: 'Review EWT Return',
        help: 'Generate and review the return. For monthly periods this is the 0619-E; for quarterly it is the 1601-EQ. Confirm the figures look right before continuing.',
        fileFn: (period) => period && period.ptype === 'monthly'
          ? findReport('0619e.html').file
          : findReport('1601eq.html').file,
        iframeId: 'ewt-return',
        usesPeriod: true,
      },
      {
        key: 'qap-review',
        type: 'review',
        label: 'Review QAP — Quarterly Alphalist of Payees',
        help: 'Generate the Quarterly Alphalist of Payees (QAP) and confirm every payee and ATC code is correct. For monthly periods the QAP covers the single month so you have the DAT file ready.',
        file: findReport('qap.html').file,
        iframeId: 'qap',
        usesPeriod: true,
      },
      {
        key: 'qap-tin-check',
        type: 'validate',
        label: 'Check supplier TINs',
        help: "Every supplier needs a TIN — BIR's eSubmission module rejects QAP and 1601-EQ DAT files with missing or all-zero payee TINs.",
        check: (biz) => checkPartyTIN(biz, 'supplier'),
        fixLabel: 'Open Suppliers screen →',
        fixIframeId: 'qap',
        fixFile: findReport('qap.html').file,
        fixTabSelector: '[data-tab="suppliers"]',
      },
      {
        key: 'qap-download',
        type: 'download',
        label: 'Download QAP (Excel / DAT)',
        help: 'Click the Excel or DAT button inside the QAP report below to download. You can also go back to the <strong>Reports</strong> tab and open the QAP report there to download the files directly.',
        file: findReport('qap.html').file,
        iframeId: 'qap',
        usesPeriod: true,
        buttonIds: ['qap-excel', 'qap-dat'],
        requireAll: false,
      },
      {
        key: 'ewt-payment',
        type: 'payment',
        label: 'Record EWT remittance',
        help: 'Posts the EWT remittance (debit Withholding Tax Payable, credit bank/cash) into Manager.',
        paymentFlavor: 'ewt',
        sourceStepKey: 'ewt-return-review',
      },
      {
        key: 'ewt-final',
        type: 'final',
        label: 'Done — download working paper',
        help: 'Re-download the QAP files for your working paper bundle. To save the EWT return or QAP as a PDF, open that step and use its own Print / Save as PDF button.',
        bundle: ['qap-download'],
      },
    ],
  },

  compensation: {
    key: 'compensation',
    label: 'Compensation (Payroll)',
    steps: [
      {
        key: 'taxstatus-check',
        type: 'review',
        label: 'Confirm employee tax status',
        help: 'Every employee needs a Tax Status (MWE or NMWE) set before 1601-C, 1604-C Alphalist, and BIR Form 2316 can be filed correctly. Continue is blocked until none are blank — but please still double-check no one was misidentified.',
        file: findReport('1601c.html').file,
        iframeId: 'payroll',
        focusTab: 'taxstatus',
        requireAllTaxStatus: true,
      },
      {
        key: 'payslip-items-check',
        type: 'instruction',
        label: 'Confirm payslip items are mapped',
        body: 'Payslip items (earnings, deductions, employer contributions) are configured in ' +
          '<strong>Settings &rarr; Payslip items</strong>, not here. Before continuing, make sure every ' +
          'payslip item used this period already has a BIR category — and, for new items, an expense/liability ' +
          'account — mapped there.',
      },
      {
        key: 'payroll-review',
        type: 'review',
        label: 'Review payroll withholding',
        file: findReport('1601c.html').file,
        iframeId: 'payroll',
        focusTab: 'report',
      },
      {
        key: 'compensation-final',
        type: 'final',
        label: 'File 1601C — Monthly Remittance',
        file: findReport('1601c.html').file,
        iframeId: 'payroll',
        focusTab: 'report',
      },
    ],
  },

  individual: {
    key: 'individual',
    label: 'Income Tax (Individual)',
    steps: [
      {
        key: 'itr-dta-check',
        type: 'checklist',
        label: 'Carry-forward account check',
        help: "Confirms whether the Deferred Tax Asset accounts for Prior Year's Excess Credit and Creditable Withholding Tax (2306) are set up. Informational only — you can continue either way.",
        check: (biz) => checkDtaAccounts(biz, ['priorYearExcessCredit', 'cwt2306']),
      },
      {
        key: 'itr-review',
        type: 'review',
        label: 'File 1701Q',
        file: findReport('1701q.html').file,
        iframeId: 'itr',
      },
      {
        key: 'itr-sawt',
        type: 'review',
        label: 'SAWT (1701Q)',
        help: 'File the Summary Alphalist of Withholding Taxes attachment for this period.',
        file: findReport('sawt.html').file + '?form=1701Q',
        iframeId: 'itr-sawt',
      },
      {
        key: 'itr-record-payment',
        type: 'payment',
        label: 'Record Payment / Journal Entry',
        help: "Posts the total amount payable from the return into Manager. Pick which account it clears (e.g. a Deferred Tax Asset - ITR Payments role) — that choice is yours, not automated.",
        paymentFlavor: 'itr',
        sourceStepKey: 'itr-review',
      },
      {
        key: 'itr-final',
        type: 'final',
        label: 'Mark Complete',
      },
    ],
  },

  nonindividual: {
    key: 'nonindividual',
    label: 'Income Tax (Corporation)',
    steps: [
      {
        key: 'itr-dta-check',
        type: 'checklist',
        label: 'Carry-forward accounts check',
        help: "Confirms whether the 5 Deferred Tax Asset accounts (Prior Year's Excess Credit, ITR Payments Regular/MCIT, MCIT Carryforward, Creditable Withholding Tax 2307) are set up. Informational only — you can continue either way.",
        check: (biz) => checkDtaAccounts(biz, ['priorYearExcessCredit', 'itrPaymentsRegular', 'itrPaymentsMcit', 'mcitCarryforward', 'cwt2307']),
      },
      {
        key: 'itr-review',
        type: 'review',
        label: 'File 1702Q',
        file: findReport('1702q.html').file,
        iframeId: 'itr',
      },
      {
        key: 'itr-sawt',
        type: 'review',
        label: 'SAWT (1702Q)',
        help: 'File the Summary Alphalist of Withholding Taxes attachment for this period.',
        file: findReport('sawt.html').file + '?form=1702Q',
        iframeId: 'itr-sawt',
      },
      {
        key: 'itr-record-payment',
        type: 'payment',
        label: 'Record Payment / Journal Entry',
        help: "Posts the total amount payable from the return into Manager. Pick which account it clears (e.g. a Deferred Tax Asset - ITR Payments role) — that choice is yours, not automated.",
        paymentFlavor: 'itr',
        sourceStepKey: 'itr-review',
      },
      {
        key: 'itr-final',
        type: 'final',
        label: 'Mark Complete',
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
