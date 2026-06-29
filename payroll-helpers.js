/* ============================================================
   Tallo CPA – BIR Tax App
   payroll-helpers.js – Shared payroll aggregation engine for
                         1601-C, 1604-C Alphalist, and BIR Form 2316.
                         Maps Manager payslips to BIR reporting
                         categories (see custom-fields.js PAYSLIP_ITEM_TYPES)
                         and computes withholding tax per the TRAIN/
                         CREATE graduated table.
   ============================================================ */

// ── BIR REPORTING CATEGORY IDS (must match custom-fields.js) ───
const PH_CAT = {
  BASIC:        'ph-bir-earn-01',
  OT:           'ph-bir-earn-02',
  HOLIDAY:      'ph-bir-earn-03',
  NIGHT_DIFF:   'ph-bir-earn-04',
  HAZARD:       'ph-bir-earn-05',
  THIRTEENTH:   'ph-bir-earn-06',
  DE_MINIMIS:   'ph-bir-earn-07',
  OTHER_TAXABLE:'ph-bir-earn-08',
  SEPARATION:   'ph-bir-earn-09',
  COMMISSION:   'ph-bir-earn-10',
  PROFIT_SHARE: 'ph-bir-earn-11',
  DIRECTOR_FEE: 'ph-bir-earn-12',
  WTC:          'ph-bir-ded-01',
  SSS_EE:       'ph-bir-ded-02',
  PHIC_EE:      'ph-bir-ded-03',
  HDMF_EE:      'ph-bir-ded-04',
  SSS_ER:       'ph-bir-con-01',
  PHIC_ER:      'ph-bir-con-02',
  HDMF_ER:      'ph-bir-con-03',
};

// MWE-exempt earnings categories (only exempt when employee Tax Status = MWE)
const MWE_EXEMPT_CATS = [PH_CAT.BASIC, PH_CAT.OT, PH_CAT.HOLIDAY, PH_CAT.NIGHT_DIFF, PH_CAT.HAZARD];

// Categories that are always taxable regardless of MWE status (when not MWE-exempt)
const TAXABLE_OTHER_CATS = [
  PH_CAT.OTHER_TAXABLE, PH_CAT.COMMISSION, PH_CAT.PROFIT_SHARE, PH_CAT.DIRECTOR_FEE,
];

const THIRTEENTH_MONTH_CAP = 90000;

// ── GRADUATED TAX TABLE (TRAIN / CREATE, annual) ────────────────
const ANNUAL_TAX_TABLE = [
  { from: 0,        to: 250000,    rate: 0.00, fixed: 0 },
  { from: 250000,   to: 400000,    rate: 0.15, fixed: 0 },
  { from: 400000,   to: 800000,    rate: 0.20, fixed: 22500 },
  { from: 800000,   to: 2000000,   rate: 0.25, fixed: 102500 },
  { from: 2000000,  to: 8000000,   rate: 0.30, fixed: 402500 },
  { from: 8000000,  to: Infinity,  rate: 0.35, fixed: 2202500 },
];

function computeAnnualTax(taxableIncome) {
  const inc = Math.max(0, Number(taxableIncome) || 0);
  const bracket = ANNUAL_TAX_TABLE.find(b => inc >= b.from && inc <= b.to) || ANNUAL_TAX_TABLE[ANNUAL_TAX_TABLE.length - 1];
  return bracket.fixed + (inc - bracket.from) * bracket.rate;
}

// ── PAYSLIP ITEM -> BIR CATEGORY MAP ──────────────────────────
// Reads from our BIR payroll mapping blob (stored in business data record).
// Manager's payslip item API does not support a reportingCategory field —
// we store the mapping ourselves via getPayrollMapping/savePayrollMapping.
async function getPayslipCategoryMap(biz) {
  return getPayrollMapping(biz);
}

// ── EXTRACT CATEGORY AMOUNTS FROM A SINGLE PAYSLIP ─────────────
// Defensive against Manager field-naming variants (camelCase / PascalCase,
// "Lines" grouped by type vs a single flat array with a "type" discriminator).
function extractPayslipLines(payslip) {
  const groups = [
    payslip?.earningsLines || payslip?.EarningsLines || payslip?.earnings || payslip?.Earnings || [],
    payslip?.deductionLines || payslip?.DeductionLines || payslip?.deductions || payslip?.Deductions || [],
    payslip?.contributionLines || payslip?.ContributionLines || payslip?.contributions || payslip?.Contributions || [],
  ];
  let lines = groups.flat().filter(Boolean);
  if (!lines.length) {
    lines = payslip?.lines || payslip?.Lines || [];
  }
  return lines;
}

function lineItemKey(line) {
  const ref = line?.payslipItem ?? line?.PayslipItem ?? line?.earningsItem ?? line?.EarningsItem
    ?? line?.deductionItem ?? line?.DeductionItem ?? line?.contributionItem ?? line?.ContributionItem
    ?? line?.item ?? line?.Item;
  return (ref && typeof ref === 'object') ? (ref.key || ref.Key || '') : (ref || '');
}

function lineAmount(line) {
  // Manager payslip lines: flat amounts use earningsAmount/deductionAmount/contributionAmount;
  // rate-based lines use unitPrice * units. Negative values (tardiness, LWP) are preserved.
  const direct = line?.amount ?? line?.Amount
    ?? line?.earningsAmount ?? line?.EarningsAmount
    ?? line?.deductionAmount ?? line?.DeductionAmount
    ?? line?.contributionAmount ?? line?.ContributionAmount;
  if (direct != null && direct !== '') return Number(direct) || 0;
  const units = Number(line?.units ?? line?.Units ?? 1);
  const price = Number(line?.unitPrice ?? line?.UnitPrice ?? 0);
  return price * units;
}

function payslipEmployeeKey(payslip) {
  const ref = payslip?.employee ?? payslip?.Employee;
  return (ref && typeof ref === 'object') ? (ref.key || ref.Key || '') : (ref || '');
}

function payslipDate(payslip) {
  return payslip?.paymentDate || payslip?.PaymentDate || payslip?.payPeriodEnd || payslip?.endDate || payslip?.date || payslip?.Date;
}

function tinDashed1601(t) {
  const d = (t || '').replace(/\D/g, '').padEnd(9, '0').substring(0, 9);
  return `${d.substring(0,3)}-${d.substring(3,6)}-${d.substring(6,9)}`;
}

// ── LOAD EMPLOYEES + BIR DATA (TIN, Tax Status, name, etc.) ────
async function loadEmployeesBIR(biz) {
  const EF = window.CF && window.CF.EMPLOYEE_FIELDS;
  const [all, guids] = await Promise.all([fetchAllBatch('/api4/employee-batch', biz), ensureBIRFields(biz)]);
  const result = {};
  all.forEach(it => {
    const rec = it.item || it.value || {};
    const rawCF = (rec.customFields2 && rec.customFields2.strings) || {};
    const cf = parseBIRBlob(rawCF, guids && guids.emp, 'b1r00003-');
    const get = idx => (EF && EF[idx]) ? (cf[EF[idx].id] || '') : '';
    result[it.key] = {
      name: rec.name || rec.Name || it.key,
      tin: get(0),
      employmentStatus: get(4) || 'R',
      taxStatus: get(5) || '',
      dateHired: get(6),
      dateSeparated: get(7),
      reasonSeparation: get(8) || 'NA',
      substitutedFiling: get(9) || 'Y',
      lastName: get(10),
      firstName: get(11),
      middleName: get(12),
      dateOfBirth: get(13),
      address: get(14),
      region: get(15),
      zipCode: get(16),
      contactNumber: get(17),
      nationality: get(20) || 'FILIPINO',
    };
  });
  return result;
}

// ── BUILD PER-EMPLOYEE, PER-MONTH CATEGORY TOTALS FOR A YEAR ───
// Returns: { [employeeKey]: { months: [ {catTotals}, x12 (Jan=0) ], year } }
async function buildPayrollYear(biz, year) {
  const [payslips, catMap] = await Promise.all([
    fetchAllBatch('/api4/payslip-batch', biz),
    getPayslipCategoryMap(biz),
  ]);

  const byEmployee = {};
  for (const { item } of payslips) {
    const dateStr = payslipDate(item);
    const d = dateStr ? new Date(dateStr) : null;
    if (!d || isNaN(d) || d.getFullYear() !== year) continue;

    const empKey = payslipEmployeeKey(item);
    if (!empKey) continue;
    const month = d.getMonth(); // 0-11

    if (!byEmployee[empKey]) {
      byEmployee[empKey] = { months: Array.from({ length: 12 }, () => ({})) };
    }
    const bucket = byEmployee[empKey].months[month];

    for (const line of extractPayslipLines(item)) {
      const itemKey = lineItemKey(line);
      const cat = catMap[itemKey];
      if (!cat) continue;
      bucket[cat] = (bucket[cat] || 0) + lineAmount(line);
    }
  }
  return byEmployee;
}

function sumCats(bucket, cats) {
  return cats.reduce((a, c) => a + (bucket[c] || 0), 0);
}

// ── PER-EMPLOYEE MONTHLY 1601-C COMPUTATION ─────────────────────
// Given an employee's 12-month category buckets and Tax Status (MWE/NMWE),
// returns an array of 12 objects with the 1601-C Part II line items for
// that employee for each month, including running 13th-month cap tracking.
function computeEmployee1601C(months, taxStatus) {
  const isMWE = taxStatus === 'MWE';
  let thirteenthYTD = 0; // cumulative 13th-month/other-benefits already treated as non-taxable
  const out = [];

  for (let m = 0; m < 12; m++) {
    const b = months[m] || {};

    // Line 14 — Total Amount of Compensation (gross, all earnings categories).
    // Employer-share SSS/PHIC/HDMF contributions are excluded: they're a
    // business expense, not employee compensation, and are never subject
    // to withholding tax.
    const allCats = Object.values(PH_CAT).filter(c => ![
      PH_CAT.WTC, PH_CAT.SSS_EE, PH_CAT.PHIC_EE, PH_CAT.HDMF_EE,
      PH_CAT.SSS_ER, PH_CAT.PHIC_ER, PH_CAT.HDMF_ER,
    ].includes(c));
    const line14 = sumCats(b, allCats);

    // Line 19 — SSS/GSIS/PHIC/HDMF (employee share) — computed first since
    // Line 15 (MWE only) must be reported net of these contributions to
    // avoid double-exempting the same peso (basic pay is 100% exempt via
    // Line 15, so contributions deducted from it can't also be exempted
    // again via Line 19, or Line 22 taxable comp would go negative).
    const line19 = sumCats(b, [PH_CAT.SSS_EE, PH_CAT.PHIC_EE, PH_CAT.HDMF_EE]);

    // Line 15 — Statutory Minimum Wage (MWE only): basic salary net of SSS/PHIC/HDMF
    const line15 = isMWE ? Math.max(0, (b[PH_CAT.BASIC] || 0) - line19) : 0;

    // Line 16 — Holiday/OT/Night Diff/Hazard (MWE only)
    const line16 = isMWE ? sumCats(b, [PH_CAT.OT, PH_CAT.HOLIDAY, PH_CAT.NIGHT_DIFF, PH_CAT.HAZARD]) : 0;

    // Line 17 — 13th Month Pay & Other Benefits, non-taxable portion (cap ₱90,000/yr cumulative)
    const thirteenthThisMonth = b[PH_CAT.THIRTEENTH] || 0;
    const remainingCap = Math.max(0, THIRTEENTH_MONTH_CAP - thirteenthYTD);
    const line17 = Math.min(thirteenthThisMonth, remainingCap);
    const thirteenthExcess = thirteenthThisMonth - line17;
    thirteenthYTD += line17;

    // Line 18 — De Minimis Benefits
    const line18 = b[PH_CAT.DE_MINIMIS] || 0;

    // Line 20 — Other Non-Taxable Compensation (separation/retirement pay, assumed exempt)
    const line20 = b[PH_CAT.SEPARATION] || 0;

    // Line 21 — Total Non-Taxable (sum 15-20)
    const line21 = line15 + line16 + line17 + line18 + line19 + line20;

    // Line 22 — Total Taxable Compensation (14 less 21)
    const line22 = line14 - line21;

    // For NMWE: classify based on whether tax was actually withheld this
    // month per payroll (Line 25 / PH_CAT.WTC) — not a recomputed table
    // projection. 1601-C is a monthly advance-withholding return; the
    // actual annual tax due vs. withheld reconciliation happens at
    // year-end annualization (1604-C), not here. If no withholding tax
    // was posted on any payslip this month, the employee's taxable comp
    // is excluded from withholding (Line 23) per BIR Form 1601-C
    // instructions; otherwise it's fully subject to withholding (Line 24).
    const actualWTC = b[PH_CAT.WTC] || 0;
    let line23 = 0;
    if (!isMWE && line22 > 0 && actualWTC <= 0) line23 = line22;
    // MWE: any residual taxable comp (e.g. thirteenth-month excess) is still
    // subject to withholding — not part of Line 23 (Line 23 is "for employees
    // OTHER THAN MWEs").

    // Line 24 — Net Taxable Compensation
    const line24 = line22 - line23;

    // Line 25 — Total Taxes Withheld (actual WTC deducted this month, per payroll)
    const line25 = b[PH_CAT.WTC] || 0;

    out.push({
      line14, line15, line16, line17, line18, line19, line20, line21, line22, line23, line24, line25,
      thirteenthExcess,
    });
  }
  return out;
}
