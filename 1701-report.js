/* ============================================================
   Tallo CPA – BIR Tax App
   1701-report.js – Annual Income Tax Return for Individuals
                     (including Mixed Income Earners), Estates
                     and Trusts (BIR Form 1701, Jan 2018 ENCS)

   Scope (v1 "core path"): single taxpayer (no spouse schedule),
   graduated rates OR 8% flat option, itemized OR OSD deduction,
   no NOLCO/exempt/special-rate schedules. Business-income figures
   (Sales/COGS/Opex) come from pnl-helpers.js's aggregator over the
   full calendar year; compensation income (if any, e.g. a mixed
   income earner) is a manual entry since it originates from an
   employer's BIR Form 2316, not from this business's Manager.io
   books.
   ============================================================ */

async function init1701Report() {
  const filterEl = document.getElementById('filter-area');
  const outputEl = document.getElementById('report-output');

  let biz;
  try {
    biz = await getReportBusiness(document.getElementById('biz-selector-wrap'));
    App.currentBusiness = biz;
  } catch (e) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Could not connect to Manager: ${escHtml(e.message)}</div>`;
    return null;
  }

  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Loading business setup…</span></div>`;
  const setup = await loadSetup(biz);
  if (!setup) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Business info not configured. Fill in the <strong>Business</strong> tab in the Tallo CPA extension first.</div>`;
    return null;
  }
  if (setup.classification !== 'Individual') {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ BIR Form 1701 is for Individual taxpayers only. This business is set up as Non-Individual.</div>`;
    return null;
  }
  outputEl.innerHTML = '';

  const now = new Date();
  const years = [now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear()];
  filterEl.innerHTML = `
    <div class="filter-bar" id="c1701-filter">
      <label>Year</label>
      <select id="c1701-year">${years.map(y => `<option value="${y}"${y === now.getFullYear() - 1 ? ' selected' : ''}>${y}</option>`).join('')}</select>
      <label>Method</label>
      <select id="c1701-method">
        <option value="graduated">Graduated Rates</option>
        <option value="8pct">8% Flat Rate</option>
      </select>
      <label>Deduction</label>
      <select id="c1701-deduction">
        <option value="itemized">Itemized Deduction</option>
        <option value="osd">Optional Standard Deduction (OSD)</option>
      </select>
      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="c1701-gen">⚡ Generate</button>
      <button class="btn btn-outline" id="c1701-print" style="display:none;" onclick="window.print()">🖨 Print</button>
      <button class="btn btn-success" id="c1701-pdf" style="display:none;" onclick="savePDF()">💾 Save PDF</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin || '—')}</strong>
    </div>`;

  document.getElementById('c1701-gen').addEventListener('click', () => generate1701(biz, setup, outputEl));
  return biz;
}

async function generate1701(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Aggregating transactions…</span></div>`;

  const year = parseInt(document.getElementById('c1701-year').value, 10);
  const method = document.getElementById('c1701-method').value;
  const deduction = document.getElementById('c1701-deduction').value;

  try {
    const coa = await loadChartOfAccounts(biz);
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31);
    const q3End = new Date(year, 8, 30);

    const fullYear = await aggregateAccountActivity(biz, yearStart, yearEnd, coa);

    const cwt2306Year = await getPrepaidTaxAssetBalance(biz, coa, yearEnd, 'Prepaid Tax Asset-2306');
    const cwt2306Q3 = await getPrepaidTaxAssetBalance(biz, coa, q3End, 'Prepaid Tax Asset-2306');
    const cwtQ4 = cwt2306Year - cwt2306Q3;

    render1701(outputEl, { fullYear, cwtQ4 }, setup, year, method, deduction);

    ['c1701-print', 'c1701-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function netIncomeFor1701(totals, deduction, itemizedTotal) {
  const sales = totals.income;
  const cogs = totals.cogs;
  const grossIncome = sales - cogs;
  const itemized = itemizedTotal;
  const osd = 0.4 * sales;
  const allowable = deduction === 'osd' ? osd : itemized;
  return { sales, cogs, grossIncome, itemized, osd, allowable, netIncome: grossIncome - allowable };
}

function render1701(el, data, setup, year, method, deduction) {
  const taxpayerName = [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ') || setup.taxpayerName;
  const schedule = buildItemizedSchedule(App.currentBusiness, data.fullYear.byAccount);
  const biz = netIncomeFor1701(data.fullYear.totals, deduction, schedule.total);

  const pnlHtml = renderPnLStatementHtml(data.fullYear.totals, data.fullYear.byAccount);
  const mappingHtml = renderDeductionScheduleHtml(schedule, 'Schedule 4 – Ordinary Allowable Itemized Deductions');

  const formHtml = `
    <div class="form-title">
      <h2>BIR Form 1701 — Annual Income Tax Return for Individuals, Estates and Trusts</h2>
      <div class="sub">For Calendar Year ${year} &nbsp;|&nbsp; ${method === '8pct' ? '8% Flat Rate' : 'Graduated Rates — ' + (deduction === 'osd' ? 'OSD' : 'Itemized Deduction')}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">4</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(setup.tin || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">8</div><div class="return-line-label">Taxpayer's Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(taxpayerName)}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Schedule 2 – Taxable Compensation Income (if a Mixed Income Earner)</div>
      ${manualLine1701('4', 'Gross Compensation Income (from BIR Form 2316)', 'c1701-comp-gross')}
      ${manualLine1701('5', 'Less: Non-Taxable / Exempt Compensation', 'c1701-comp-exempt')}
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label" style="font-weight:700;">Taxable Compensation Income</div><div class="return-line-amt" id="c1701-line6">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label" style="font-weight:700;">Tax Due – Compensation Income</div><div class="return-line-amt" id="c1701-line7">₱ 0.00</div></div>
      ${manualLine1701('2316', 'Creditable Tax Withheld per BIR Form No. 2316 (employer)', 'c1701-comp-cwt')}
    </div>

    ${method === '8pct' ? render1701Schedule3B(biz) : render1701Schedule3A(biz, deduction, schedule)}

    <div class="return-section">
      <div class="return-section-header">Part VI – Summary of Income Tax Due</div>
      <div class="return-line"><div class="return-line-num">1</div><div class="return-line-label">Regular Rate – Income Tax Due (Compensation + Business)</div><div class="return-line-amt" id="c1701-p6-1">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label" style="font-weight:700;">Total Income Tax Due</div><div class="return-line-amt highlight" id="c1701-p6-5">₱ 0.00</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part VII – Tax Credits/Payments</div>
      ${manualLine1701('1', "Prior Year's Excess Credits", 'c1701-tc1')}
      ${manualLine1701('2', 'Tax Payments for the First Three (3) Quarters', 'c1701-tc2')}
      ${manualLine1701('3', 'Creditable Tax Withheld for the First Three (3) Quarters', 'c1701-tc3')}
      <div class="return-line"><div class="return-line-num">4</div><div class="return-line-label">Creditable Tax Withheld per BIR Form No. 2307 for the 4th Quarter</div><div class="return-line-amt">₱ ${fmt(data.cwtQ4)}</div></div>
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label">Creditable Tax Withheld per BIR Form No. 2316</div><div class="return-line-amt" id="c1701-tc5">₱ 0.00</div></div>
      ${manualLine1701('6', 'Tax Paid in Return Previously Filed, if Amended', 'c1701-tc6')}
      ${manualLine1701('7', 'Foreign Tax Credits, if applicable', 'c1701-tc7')}
      ${manualLine1701('9', 'Other Tax Credits/Payments', 'c1701-tc9')}
      <div class="return-line"><div class="return-line-num">10</div><div class="return-line-label" style="font-weight:700;">Total Tax Credits/Payments</div><div class="return-line-amt" id="c1701-tc-total">₱ 0.00</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part II – Total Tax Payable</div>
      <div class="return-line"><div class="return-line-num">22</div><div class="return-line-label">Tax Due</div><div class="return-line-amt" id="c1701-p2-22">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">23</div><div class="return-line-label">Less: Total Tax Credits/Payments</div><div class="return-line-amt" id="c1701-p2-23">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">24</div><div class="return-line-label" style="font-weight:700;">Tax Payable/(Overpayment)</div><div class="return-line-amt" id="c1701-p2-24">₱ 0.00</div></div>
      ${manualLine1701('25', '50% Installment Deferred to 2nd Installment (≤ 50% of Item 22, due Oct 15)', 'c1701-installment')}
      <div class="return-line"><div class="return-line-num">26</div><div class="return-line-label" style="font-weight:700;">Amount of Tax Payable/(Overpayment)</div><div class="return-line-amt" id="c1701-p2-26">₱ 0.00</div></div>
      ${manualLine1701('27', 'Interest', 'c1701-pen27')}
      ${manualLine1701('28', 'Surcharge', 'c1701-pen28')}
      ${manualLine1701('29', 'Compromise', 'c1701-pen29')}
      <div class="return-line"><div class="return-line-num">30</div><div class="return-line-label">Total Penalties</div><div class="return-line-amt" id="c1701-p2-30">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">31</div><div class="return-line-label" style="font-weight:700;">TOTAL AMOUNT PAYABLE/(OVERPAYMENT)</div><div class="return-line-amt highlight payable" id="c1701-p2-31">₱ 0.00</div></div>
    </div>`;

  el.innerHTML = renderIncomeTaxTabs([
    { key: 'pnl', label: 'Profit and Loss Statement', html: pnlHtml },
    { key: 'mapping', label: 'BIR Mapping of COA', html: mappingHtml },
    { key: 'form', label: 'BIR Form', html: formHtml },
  ], 'form');

  el._biz = biz;
  el._method = method;
  el._cwtQ4 = data.cwtQ4;
  bindIncomeTaxTabs(el);
  el.querySelectorAll('.recon-manual-input').forEach(inp => inp.addEventListener('input', () => recompute1701(el)));
  bindDeductionMappingTable(el, App.currentBusiness, () => render1701(el, data, setup, year, method, deduction));
  recompute1701(el);
}

function render1701Schedule3A(biz, deduction, schedule) {
  const allowableLabel = deduction === 'osd' ? '17 Optional Standard Deduction (OSD)' : '13 Ordinary Allowable Itemized Deductions';
  return `
    <div class="return-section">
      <div class="return-section-header">Schedule 3.A – Taxable Business Income (Graduated Rates)</div>
      ${returnLine(10, 'Net Sales/Revenues/Receipts/Fees', biz.sales)}
      ${returnLine(11, 'Less: Cost of Sales/Services', biz.cogs)}
      ${returnLine(12, 'Gross Income/(Loss) from Operation', biz.grossIncome, true)}
      ${returnLine(deduction === 'osd' ? 17 : 13, allowableLabel, biz.allowable)}
      ${returnLine(18, 'Net Income/(Loss)', biz.netIncome, true)}
      ${manualLine1701('19', 'Add: Other Non-Operating Income', 'c1701-nonop')}
      ${manualLine1701('21', 'Amount Received/Share in Income from GPP', 'c1701-gpp')}
      <div class="return-line"><div class="return-line-num">23</div><div class="return-line-label" style="font-weight:700;">Taxable Income – Business</div><div class="return-line-amt" id="c1701-line23">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">24</div><div class="return-line-label" style="font-weight:700;">Total Taxable Income – Compensation &amp; Business</div><div class="return-line-amt" id="c1701-line24">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">25</div><div class="return-line-label" style="font-weight:700;">Total Tax Due (Graduated Rates)</div><div class="return-line-amt highlight" id="c1701-line25">₱ 0.00</div></div>
    </div>`;
}

function render1701Schedule3B(biz) {
  return `
    <div class="return-section">
      <div class="return-section-header">Schedule 3.B – Taxable Business Income (8% Flat Rate)</div>
      ${returnLine(26, 'Sales/Revenues/Receipts/Fees (net of returns, allowances &amp; discounts)', biz.sales)}
      ${manualLine1701('27', 'Add: Other Non-Operating Income', 'c1701-nonop8')}
      <div class="return-line"><div class="return-line-num">28</div><div class="return-line-label" style="font-weight:700;">Total Income</div><div class="return-line-amt" id="c1701-line28">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">29</div><div class="return-line-label">Less: Allowable Reduction (P250,000, not applicable if with compensation income)</div><div class="return-line-amt" id="c1701-line29">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">30</div><div class="return-line-label" style="font-weight:700;">Taxable Income/(Loss)</div><div class="return-line-amt" id="c1701-line30">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">31</div><div class="return-line-label">Tax Due – Business Income (8%)</div><div class="return-line-amt" id="c1701-line31">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">32</div><div class="return-line-label" style="font-weight:700;">Total Tax Due – Compensation &amp; Business Income</div><div class="return-line-amt highlight" id="c1701-line32">₱ 0.00</div></div>
    </div>`;
}

function manualLine1701(num, label, inputId) {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label">${escHtml(label)}</div>
    <div class="return-line-amt"><input type="number" step="0.01" class="recon-manual-input" id="${inputId}" value="0" style="width:120px;text-align:right;font-size:12px;"></div>
  </div>`;
}

function val1701(id) {
  const el = document.getElementById(id);
  return el ? (parseFloat(el.value) || 0) : 0;
}

function set1701(el, id, amount) {
  const target = el.querySelector(`#${id}`);
  if (target) target.textContent = `₱ ${fmt(amount)}`;
}

function recompute1701(el) {
  const biz = el._biz;
  const method = el._method;

  const compGross = val1701('c1701-comp-gross');
  const compExempt = val1701('c1701-comp-exempt');
  const taxableComp = Math.max(0, compGross - compExempt);
  set1701(el, 'c1701-line6', taxableComp);
  const compTaxDue = graduatedTaxDue(taxableComp);
  set1701(el, 'c1701-line7', compTaxDue);

  let businessTaxDue, totalTaxableIncome;

  if (method === '8pct') {
    const nonOp = val1701('c1701-nonop8');
    const totalIncome = biz.sales + nonOp;
    set1701(el, 'c1701-line28', totalIncome);
    const reduction = compGross > 0 ? 0 : 250000;
    set1701(el, 'c1701-line29', reduction);
    const taxableIncome = Math.max(0, totalIncome - reduction);
    set1701(el, 'c1701-line30', taxableIncome);
    businessTaxDue = taxableIncome * 0.08;
    set1701(el, 'c1701-line31', businessTaxDue);
    totalTaxableIncome = taxableComp + taxableIncome;
    set1701(el, 'c1701-line32', compTaxDue + businessTaxDue);
  } else {
    const nonOp = val1701('c1701-nonop');
    const gpp = val1701('c1701-gpp');
    const businessTaxable = biz.netIncome + nonOp + gpp;
    set1701(el, 'c1701-line23', businessTaxable);
    totalTaxableIncome = taxableComp + businessTaxable;
    set1701(el, 'c1701-line24', totalTaxableIncome);
    businessTaxDue = graduatedTaxDue(totalTaxableIncome) - compTaxDue;
    set1701(el, 'c1701-line25', graduatedTaxDue(totalTaxableIncome));
  }

  const totalTaxDue = method === '8pct' ? (compTaxDue + businessTaxDue) : graduatedTaxDue(totalTaxableIncome);
  set1701(el, 'c1701-p6-1', totalTaxDue);
  set1701(el, 'c1701-p6-5', totalTaxDue);
  set1701(el, 'c1701-p2-22', totalTaxDue);

  const compCwt = val1701('c1701-comp-cwt');
  set1701(el, 'c1701-tc5', compCwt);

  const credits = ['c1701-tc1','c1701-tc2','c1701-tc3','c1701-tc6','c1701-tc7','c1701-tc9']
    .reduce((s, id) => s + val1701(id), 0) + (el._cwtQ4 || 0) + compCwt;
  set1701(el, 'c1701-tc-total', credits);
  set1701(el, 'c1701-p2-23', credits);

  const payable = totalTaxDue - credits;
  set1701(el, 'c1701-p2-24', payable);

  const installment = val1701('c1701-installment');
  const amountPayable = payable - installment;
  set1701(el, 'c1701-p2-26', amountPayable);

  const penalties = ['c1701-pen27','c1701-pen28','c1701-pen29'].reduce((s, id) => s + val1701(id), 0);
  set1701(el, 'c1701-p2-30', penalties);
  set1701(el, 'c1701-p2-31', amountPayable + penalties);
}
