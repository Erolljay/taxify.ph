/* ============================================================
   Txform Now! — workflow definitions consumed by StepEngine.
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

// ── READINESS GATE ─────────────────────────────────────────────
// Customers/suppliers/employees missing BIR details block a filing — the gate
// flags every party on file rather than only ones with this period's
// transactions, since the data model has no cheap way to scope "transacted this
// period" outside of the report's own row-building logic.
// Type-aware "complete?" rule for a loadPartyBIR() record — the same rule the
// Month-end Prep badge uses (CF.partyBlobComplete), expressed over this shape.
// Individual: TIN + last + first + address1. Non-Individual: TIN + company +
// address1.
function partyRecordComplete(p) {
  const isInd = p.type === 'Individual';
  return !!(p.tin && (isInd ? (p.lastName && p.firstName) : p.companyName) && p.address1);
}

// Readiness check for the upfront gate: one row per party set, green only when
// every record is fully complete (not just TIN — BIR needs name + address on the
// DAT files too). specs: [{ partyType, label, used }].
async function checkPartyReadiness(biz, specs) {
  const rows = [];
  let allOk = true;
  for (const spec of specs) {
    const parties = Object.values(await loadPartyBIR(biz, spec.partyType));
    const incomplete = parties.filter(p => !partyRecordComplete(p));
    const ok = incomplete.length === 0;
    if (!ok) allOk = false;
    const eg = incomplete.slice(0, 3).map(p => p.name).join(', ');
    rows.push({
      ok,
      label: spec.label,
      detail: ok
        ? `All ${parties.length} complete — used by ${spec.used}.`
        : `${incomplete.length} of ${parties.length} missing TIN / name / address (e.g. ${eg}${incomplete.length > 3 ? '…' : ''}) — used by ${spec.used}.`,
    });
  }
  return {
    ok: allOk,
    message: allOk
      ? 'Every party has complete BIR details. You can proceed.'
      : 'Some parties are missing BIR details. Fix them in Month-end Prep, then Re-check.',
    rows,
  };
}

// Employee readiness for the Compensation gate. No standalone employee BIR
// loader exists, so load the batch here and reuse CF.employeeBlobComplete
// (TIN + Tax Status + name).
async function loadEmployeeBIR(biz) {
  const [all, guids] = await Promise.all([fetchAllBatch('/api4/employee-batch', biz), ensureBIRFields(biz)]);
  return all.map(it => {
    const rec = it.item || {};
    const cf  = parseBIRBlob((rec.customFields2 && rec.customFields2.strings) || rec.customFields || {}, guids.emp, 'b1r00003-');
    return { name: rec.name || rec.Name || it.key, cf };
  });
}

async function checkEmployeeReadiness(biz) {
  const emps = await loadEmployeeBIR(biz);
  const incomplete = emps.filter(e => !(typeof CF !== 'undefined' && CF.employeeBlobComplete(e.cf)));
  const ok = incomplete.length === 0;
  const eg = incomplete.slice(0, 3).map(e => e.name).join(', ');
  return {
    ok,
    message: ok
      ? 'Every employee has a TIN, Tax Status and name. You can proceed.'
      : 'Some employees are missing a TIN, Tax Status or name. Fix them in Month-end Prep, then Re-check.',
    rows: [{
      ok,
      label: 'Employees',
      detail: ok
        ? `All ${emps.length} complete — used by 1601-C, 1604-C, 2316.`
        : `${incomplete.length} of ${emps.length} incomplete (e.g. ${eg}${incomplete.length > 3 ? '…' : ''}).`,
    }],
  };
}

// showIf for the VAT Tax-Codes step: show it only while a core VAT category is
// still unmapped. When the business used the standard Setup (which creates the
// standard-named codes that auto-match fills), all core categories map and the
// step is hidden. Govt-withholding-VAT categories are excluded (niche). On any
// error we show the step (safer than hiding a needed mapping).
async function hasUnmappedVatCore(biz) {
  const CORE = ['sales_taxable', 'sales_zero', 'sales_exempt',
    'purch_capital', 'purch_other', 'purch_services', 'purch_zero', 'purch_exempt'];
  try {
    const { vm } = await getVatMapping(biz);
    return CORE.some(k => !vm[k]);
  } catch (e) {
    return true;
  }
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
        short: 'Start',
        info: true, // read-only guidance, not a gate — advances on its own
        body: `Open Manager's native <strong>Reports → Tax Audit</strong> report first and confirm there are no
          transactions missing a Tax Code — especially Profit &amp; Loss accounts (sales and expense/purchase
          lines). VAT and SLS/SLP/SAWT figures are only correct if every relevant transaction has a Tax Code
          applied.`,
      },
      {
        // Upfront readiness gate: every customer/supplier that lands on the
        // SLS/SLP/SAWT needs a complete TIN, name and address before the DAT
        // files pass BIR validation. Blocks until green; fixes happen in the
        // Month-end Prep screen (the report tabs remain for ad-hoc in-line fixes
        // during review).
        key: 'vat-readiness',
        type: 'checklist',
        label: 'Party details ready?',
        short: 'Parties',
        gate: true,
        fixTab: 'customers',
        fixLabel: 'Fix in Month-end Prep →',
        help: 'Confirm every customer and supplier has complete BIR details (TIN, name, address) before generating the SLS, SLP and SAWT. Fix any gaps in Month-end Prep, then Re-check.',
        check: (biz) => checkPartyReadiness(biz, [
          { partyType: 'customer', label: 'Customers', used: 'SLS & SAWT' },
          { partyType: 'supplier', label: 'Suppliers', used: 'SLP' },
        ]),
      },
      {
        // 2550Q's two tabs are split into their own steps: the Tax Codes
        // mapping drives every figure on the return, so it comes first as its
        // own decision instead of hiding behind a secondary tab.
        key: 'vat-2550q-taxcodes',
        type: 'review',
        label: 'Confirm Tax Codes',
        short: 'Tax Codes',
        help: 'Map each Manager Tax Code to its BIR VAT category. These mappings drive every figure on the 2550Q, SLS and SLP — confirm them before reviewing the return. Your mapping is saved, so the return step picks it up automatically.',
        // Own iframeId (not shared with the Return step): the engine keeps each
        // iframe in the step that created it, so a shared id would leave the
        // second step blank. The Tax Code mapping is saved per business, so the
        // separate Return iframe still reflects it.
        file: findReport('2550q.html').file,
        iframeId: 'vat-2550q-taxcodes',
        focusTab: 'taxcodes',
        usesPeriod: true,
        // Conditional: only shown while a core VAT category is still unmapped.
        showIf: (biz) => hasUnmappedVatCore(biz),
      },
      {
        key: 'vat-2550q-review',
        type: 'review',
        label: 'Review 2550Q Return',
        short: '2550Q Return',
        help: 'Review the quarterly VAT return. Confirm the figures look right before continuing.',
        file: findReport('2550q.html').file,
        iframeId: 'vat-2550q',
        focusTab: 'return',
        usesPeriod: true,
      },
      {
        // Party completeness is guaranteed by the upfront readiness gate, so
        // this step is just review + download. The report's own Customers tab
        // stays available for ad-hoc in-line fixes spotted during review.
        key: 'sls',
        type: 'document',
        label: 'Summary List of Sales',
        short: 'Sales (SLS)',
        help: 'Review the SLS, then download. A quarter downloads one DAT file per month (3 files).',
        file: findReport('sls.html').file,
        iframeId: 'sls',
        usesPeriod: true,
        buttonIds: ['sl-excel', 'sl-dat'],
        requireAll: false,
      },
      {
        key: 'slp',
        type: 'document',
        label: 'Summary List of Purchases',
        short: 'Purchases (SLP)',
        help: 'Review the SLP, then download. A quarter downloads one DAT file per month (3 files).',
        file: findReport('slp.html').file,
        iframeId: 'slp',
        usesPeriod: true,
        buttonIds: ['sl-excel', 'sl-dat'],
        requireAll: false,
      },
      {
        key: 'sawt-download',
        type: 'download',
        label: 'SAWT',
        optional: true, // shown as "if withheld" on the stepper
        help: 'Only required if any customer withheld VAT on payments to you this quarter. A quarter downloads one DAT file per month (3 files).',
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
        short: 'Payment',
        help: 'Posts the VAT due (or closing entry, if fully covered by input tax / CWT credits) into Manager.',
        sourceStepKey: 'vat-2550q-review',
      },
      {
        // Terminal step. The working-paper bundle download is folded into the
        // freeze footer (bundle:) so it is no longer a separate step.
        key: 'vat-file',
        type: 'file',
        label: 'Mark as Filed',
        short: 'File',
        help: 'Freeze the 2550Q figures as of filing. Later edits to this quarter’s books no longer change the filed return — they flow to an amendment instead. You can also re-download the working-paper files here.',
        sourceStepKey: 'vat-2550q-review',
        bundle: ['sls', 'slp', 'sawt-download'],
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
        short: 'Start',
        info: true, // read-only guidance, not a gate — advances on its own
        body: `Open Manager's native <strong>Reports → Tax Audit</strong> report first and confirm there are no
          supplier payments missing an EWT Tax Code. Every purchase invoice or payment with an expanded withholding
          tax component must have its EWT tax code applied before generating the return — amounts are only correct
          when all transactions are coded.`,
      },
      {
        // Upfront readiness gate: every payee (supplier) on the QAP needs a
        // complete TIN, name and address before the DAT passes BIR validation.
        key: 'ewt-readiness',
        type: 'checklist',
        label: 'Payee details ready?',
        short: 'Payees',
        gate: true,
        fixTab: 'suppliers',
        fixLabel: 'Fix in Month-end Prep →',
        help: 'Confirm every payee (supplier) has complete BIR details (TIN, name, address) before generating the QAP. Fix any gaps in Month-end Prep, then Re-check.',
        check: (biz) => checkPartyReadiness(biz, [
          { partyType: 'supplier', label: 'Payees (Suppliers)', used: 'QAP' },
        ]),
      },
      {
        // EWT keeps both periods (unlike VAT's quarterly-only): the monthly
        // 0619-E remittance and the quarterly 1601-EQ return, picked by the
        // period the user selected.
        key: 'ewt-return-review',
        type: 'review',
        label: 'Review EWT Return',
        short: 'EWT Return',
        help: 'Review the return. For a monthly period this is the 0619-E; for a quarterly period it is the 1601-EQ. Confirm the figures look right before continuing.',
        fileFn: (period) => period && period.ptype === 'monthly'
          ? findReport('0619e.html').file
          : findReport('1601eq.html').file,
        iframeId: 'ewt-return',
        usesPeriod: true,
      },
      {
        // Merged: review the QAP, fix any missing supplier TINs (blocking, as
        // an inline banner — BIR's eSubmission rejects DAT files with missing
        // payee TINs), and download — one screen instead of three steps.
        // Unlike SLS/SLP, the QAP DAT is a single file for the period (the
        // Annex A Excel always covers the full quarter), so datHint overrides
        // the shared "one file per month" note.
        key: 'qap',
        type: 'document',
        label: 'Quarterly Alphalist of Payees',
        short: 'QAP',
        help: 'Review the QAP — confirm every payee and ATC code — then download. The DAT file follows the period you picked; the Annex A Excel always covers the full quarter.',
        file: findReport('qap.html').file,
        iframeId: 'qap',
        usesPeriod: true,
        buttonIds: ['qap-excel', 'qap-dat'],
        requireAll: false,
        datHint: 'The DAT file follows the period you picked — one file for the quarter (or the selected month).',
      },
      {
        key: 'ewt-payment',
        type: 'payment',
        label: 'Record EWT remittance',
        short: 'Payment',
        help: 'Posts the EWT remittance (debit Withholding Tax Payable, credit bank/cash) into Manager.',
        paymentFlavor: 'ewt',
        sourceStepKey: 'ewt-return-review',
      },
      {
        // Terminal step. The working-paper re-download (QAP) is folded into the
        // freeze footer (bundle:) so it is no longer a separate step.
        key: 'ewt-file',
        type: 'file',
        label: 'Mark as Filed',
        short: 'File',
        help: 'Freeze the EWT return figures as of filing. Later edits to this period’s books no longer change the filed return — they flow to an amendment instead. You can also re-download the QAP working-paper files here.',
        sourceStepKey: 'ewt-return-review',
        bundle: ['qap'],
      },
    ],
  },

  compensation: {
    key: 'compensation',
    label: 'Compensation (Payroll)',
    steps: [
      {
        // First step = info-only guidance (the payslip-items reminder), matching
        // VAT/EWT's "Before you start". Read-only, self-advancing — not a gate.
        key: 'comp-instructions',
        type: 'instruction',
        label: 'Before you start',
        short: 'Start',
        info: true,
        body: 'Payslip items (earnings, deductions, employer contributions) are configured in ' +
          '<strong>Settings &rarr; Payslip items</strong>, not here. Before continuing, make sure every ' +
          'payslip item used this period already has a BIR category — and, for new items, an expense/liability ' +
          'account — mapped there. Also confirm this month\'s payroll is fully entered and posted.',
      },
      {
        // Upfront readiness gate: every employee needs a TIN, Tax Status and
        // name before 1601-C / 1604-C / 2316 are trustworthy. Fixes happen in
        // Month-end Prep → Employees (which also has the Excel round-trip).
        key: 'comp-readiness',
        type: 'checklist',
        label: 'Employee details ready?',
        short: 'Employees',
        gate: true,
        fixTab: 'employees',
        fixLabel: 'Fix in Month-end Prep →',
        help: 'Every employee needs a TIN, Tax Status (MWE / NMWE) and name before 1601-C, 1604-C Alphalist and BIR Form 2316 can be filed correctly. Fix any gaps in Month-end Prep, then Re-check — and please still double-check no one was misidentified.',
        check: (biz) => checkEmployeeReadiness(biz),
      },
      {
        key: 'payroll-review',
        type: 'review',
        label: 'Review 1601-C withholding',
        short: '1601-C',
        help: 'Review the monthly compensation withholding return. Confirm the figures look right before continuing.',
        file: findReport('1601c.html').file,
        iframeId: 'payroll-report',
        focusTab: 'report',
      },
      {
        key: 'compensation-payment',
        type: 'payment',
        label: 'Record 1601-C remittance',
        short: 'Payment',
        help: 'Posts the compensation withholding remittance (debit Withholding Tax Payable – Compensation, credit bank/cash) into Manager.',
        paymentFlavor: 'compensation',
        sourceStepKey: 'payroll-review',
      },
      {
        key: 'compensation-file',
        type: 'file',
        label: 'Mark as Filed',
        short: 'File',
        help: 'Freeze the 1601-C figures for this month. Later payroll edits to this month no longer change the filed return — they flow to an amendment instead.',
        sourceStepKey: 'payroll-review',
      },
    ],
  },

  individual: {
    key: 'individual',
    label: 'Income Tax (Individual)',
    steps: [
      {
        key: 'itr-instructions',
        type: 'instruction',
        label: 'Before you start',
        short: 'Start',
        info: true,
        body: `Open Manager's native <strong>Reports → Tax Audit</strong> and confirm this period's income and
          expense transactions are all recorded and coded — the 1701Q pulls straight from your books, so the
          return is only right if the period is complete.`,
      },
      {
        // Non-blocking readiness heads-up: the SAWT (optional) lists customers
        // who withheld 2307 from you; each needs complete BIR details. You can
        // continue and skip the SAWT if it doesn't apply this period.
        key: 'itr-readiness',
        type: 'checklist',
        label: 'Customer details ready?',
        short: 'Parties',
        fixTab: 'customers',
        fixLabel: 'Fix in Month-end Prep →',
        help: 'If creditable tax (2307) was withheld from you this period, the SAWT lists those customers — each needs a complete TIN, name and address. This is a heads-up, not a block: you can continue and skip the SAWT if it does not apply.',
        check: (biz) => checkPartyReadiness(biz, [
          { partyType: 'customer', label: 'Customers', used: 'SAWT (if withheld)' },
        ]),
      },
      {
        key: 'itr-dta-check',
        type: 'checklist',
        label: 'Carry-forward account check',
        short: 'Carry-forward',
        help: "Confirms whether the Deferred Tax Asset accounts for Prior Year's Excess Credit and Creditable Withholding Tax (2306) are set up. Informational only — you can continue either way.",
        check: (biz) => checkDtaAccounts(biz, ['priorYearExcessCredit', 'cwt2306']),
      },
      {
        key: 'itr-review',
        type: 'review',
        label: 'Review 1701Q Return',
        short: '1701-Q',
        help: 'Review the quarterly individual income tax return. Confirm the figures look right before continuing.',
        file: findReport('1701q.html').file,
        iframeId: 'itr',
        usesPeriod: true,
      },
      {
        // Attachment merged into a document step: review the SAWT, fix any
        // missing customer TINs (the payors who withheld from you), then
        // download. Optional — skip if no creditable tax was withheld.
        key: 'itr-sawt',
        type: 'document',
        label: 'SAWT — Summary Alphalist of Withholding Taxes',
        short: 'SAWT',
        optional: true,
        help: 'The 1701Q attachment listing income payments where creditable tax (2307) was withheld from you. Review, then download. A quarter downloads one DAT file per month (3 files).',
        file: findReport('sawt.html').file + '?form=1701Q',
        iframeId: 'itr-sawt',
        usesPeriod: true,
        buttonIds: ['sawt-excel', 'sawt-dat'],
        requireAll: false,
        skippable: true,
        skipLabel: 'No creditable tax withheld this period — skip',
      },
      {
        key: 'itr-record-payment',
        type: 'payment',
        label: 'Record income tax payment',
        short: 'Payment',
        help: "Posts the total amount payable from the return into Manager. Pick which account it clears (e.g. a Deferred Tax Asset - ITR Payments role) — that choice is yours, not automated.",
        paymentFlavor: 'itr',
        sourceStepKey: 'itr-review',
      },
      {
        key: 'itr-file',
        type: 'file',
        label: 'Mark as Filed',
        short: 'File',
        help: 'Freeze the return figures as of filing. Later edits to this period’s books no longer change the filed return — they flow to an amendment instead. You can also re-download the SAWT working-paper files here.',
        sourceStepKey: 'itr-review',
        bundle: ['itr-sawt'],
      },
    ],
  },

  nonindividual: {
    key: 'nonindividual',
    label: 'Income Tax (Corporation)',
    steps: [
      {
        key: 'itr-instructions',
        type: 'instruction',
        label: 'Before you start',
        short: 'Start',
        info: true,
        body: `Open Manager's native <strong>Reports → Tax Audit</strong> and confirm this period's income and
          expense transactions are all recorded and coded — the 1702Q pulls straight from your books, so the
          return is only right if the period is complete.`,
      },
      {
        // Non-blocking readiness heads-up: the SAWT (optional) lists customers
        // who withheld 2307 from you; each needs complete BIR details. You can
        // continue and skip the SAWT if it doesn't apply this period.
        key: 'itr-readiness',
        type: 'checklist',
        label: 'Customer details ready?',
        short: 'Parties',
        fixTab: 'customers',
        fixLabel: 'Fix in Month-end Prep →',
        help: 'If creditable tax (2307) was withheld from you this period, the SAWT lists those customers — each needs a complete TIN, name and address. This is a heads-up, not a block: you can continue and skip the SAWT if it does not apply.',
        check: (biz) => checkPartyReadiness(biz, [
          { partyType: 'customer', label: 'Customers', used: 'SAWT (if withheld)' },
        ]),
      },
      {
        key: 'itr-dta-check',
        type: 'checklist',
        label: 'Carry-forward accounts check',
        short: 'Carry-forward',
        help: "Confirms whether the 5 Deferred Tax Asset accounts (Prior Year's Excess Credit, ITR Payments Regular/MCIT, MCIT Carryforward, Creditable Withholding Tax 2307) are set up. Informational only — you can continue either way.",
        check: (biz) => checkDtaAccounts(biz, ['priorYearExcessCredit', 'itrPaymentsRegular', 'itrPaymentsMcit', 'mcitCarryforward', 'cwt2307']),
      },
      {
        key: 'itr-review',
        type: 'review',
        label: 'Review 1702Q Return',
        short: '1702-Q',
        help: 'Review the quarterly corporate income tax return. Confirm the figures look right before continuing.',
        file: findReport('1702q.html').file,
        iframeId: 'itr',
        usesPeriod: true,
      },
      {
        key: 'itr-sawt',
        type: 'document',
        label: 'SAWT — Summary Alphalist of Withholding Taxes',
        short: 'SAWT',
        optional: true,
        help: 'The 1702Q attachment listing income payments where creditable tax (2307) was withheld from you. Review, then download. A quarter downloads one DAT file per month (3 files).',
        file: findReport('sawt.html').file + '?form=1702Q',
        iframeId: 'itr-sawt',
        usesPeriod: true,
        buttonIds: ['sawt-excel', 'sawt-dat'],
        requireAll: false,
        skippable: true,
        skipLabel: 'No creditable tax withheld this period — skip',
      },
      {
        key: 'itr-record-payment',
        type: 'payment',
        label: 'Record income tax payment',
        short: 'Payment',
        help: "Posts the total amount payable from the return into Manager. Pick which account it clears (e.g. a Deferred Tax Asset - ITR Payments role) — that choice is yours, not automated.",
        paymentFlavor: 'itr',
        sourceStepKey: 'itr-review',
      },
      {
        key: 'itr-file',
        type: 'file',
        label: 'Mark as Filed',
        short: 'File',
        help: 'Freeze the return figures as of filing. Later edits to this period’s books no longer change the filed return — they flow to an amendment instead. You can also re-download the SAWT working-paper files here.',
        sourceStepKey: 'itr-review',
        bundle: ['itr-sawt'],
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
