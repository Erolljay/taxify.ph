/* ============================================================
   Tallo CPA – BIR Tax App
   1702rt-report.js – Annual Income Tax Return for Corporations,
                       Partnerships and Other Non-Individual
                       Taxpayers Subject Only to Regular Income
                       Tax Rate (BIR Form 1702-RT, Jan 2018 ENCS)

   Scope (v1 "core path"): regular/normal rate only (no EXEMPT or
   SPECIAL rate schedule), itemized OR OSD deduction, MCIT computed
   and compared against the regular tax due for the year. No NOLCO
   schedule detail and no multi-year MCIT carryforward tracking —
   "Excess MCIT Applied this Current Taxable Year" is a single
   manual input, since Manager.io has no transaction trail for a
   tax attribute that isn't a real account.
   ============================================================ */

async function init1702RTReport() {
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
  if (setup.classification === 'Individual') {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ BIR Form 1702-RT is for Corporations/Partnerships only. This business is set up as Individual.</div>`;
    return null;
  }
  outputEl.innerHTML = '';

  const now = new Date();
  const years = [now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear()];
  filterEl.innerHTML = `
    <div class="filter-bar" id="c1702rt-filter">
      <label>Year</label>
      <select id="c1702rt-year">${years.map(y => `<option value="${y}"${y === now.getFullYear() - 1 ? ' selected' : ''}>${y}</option>`).join('')}</select>
      <label>Regular Rate</label>
      <select id="c1702rt-rate">${corporateRateOptionsHtml()}</select>
      <label>Deduction</label>
      <select id="c1702rt-deduction">
        <option value="itemized">Itemized Deduction</option>
        <option value="osd">Optional Standard Deduction (OSD)</option>
      </select>
      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="c1702rt-gen">⚡ Generate</button>
      <button class="btn btn-outline" id="c1702rt-print" style="display:none;" onclick="window.print()">🖨 Print</button>
      <button class="btn btn-success" id="c1702rt-pdf" style="display:none;" onclick="savePDF()">💾 Save PDF</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin || '—')}</strong>
    </div>`;

  document.getElementById('c1702rt-gen').addEventListener('click', () => generate1702RT(biz, setup, outputEl));
  return biz;
}

async function generate1702RT(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Aggregating transactions…</span></div>`;

  const year = parseInt(document.getElementById('c1702rt-year').value, 10);
  const rate = parseFloat(document.getElementById('c1702rt-rate').value);
  const deduction = document.getElementById('c1702rt-deduction').value;

  try {
    const coa = await loadChartOfAccounts(biz);
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31);
    const q3End = new Date(year, 8, 30);

    const fullYear = await aggregateAccountActivity(biz, yearStart, yearEnd, coa);

    const dtaMap = await getDtaRoleMapping(biz);
    const cwt2307Year = await getDtaBalance(biz, coa, dtaMap, yearEnd, 'cwt2307');
    const cwt2307Q3 = await getDtaBalance(biz, coa, dtaMap, q3End, 'cwt2307');
    const cwtQ4 = cwt2307Year - cwt2307Q3;

    render1702RT(outputEl, { fullYear, cwtQ4 }, setup, year, rate, deduction);

    ['c1702rt-print', 'c1702rt-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function render1702RT(el, data, setup, year, rate, deduction) {
  const name = setup.companyName || setup.taxpayerName || '';
  const sales = data.fullYear.totals.income;
  const cogs = data.fullYear.totals.cogs;
  const schedule = buildItemizedSchedule(App.currentBusiness, data.fullYear.byAccount);
  const opex = schedule.total;

  const pnlHtml = renderPnLStatementHtml(data.fullYear.totals, data.fullYear.byAccount);
  const mappingHtml = renderDeductionScheduleHtml(schedule, 'Schedule I – Ordinary Allowable Itemized Deductions');

  // MCIT only applies beginning the 4th taxable year following incorporation
  // (NIRC Sec. 27(E)(1)) — see isMcitApplicable in pnl-helpers.js.
  const mcitApplicable = isMcitApplicable(setup.dateOfIncorporation, year);
  const mcitRatePct = (getMcitRate(dateForYear(year)) * 100).toFixed(0);
  const mcitExemptNote = !mcitApplicable
    ? `<div class="alert alert-info no-print" style="margin-top:6px;font-size:11px;">⏸ Not yet subject to MCIT — exempt for the first 3 taxable years from incorporation (${escHtml(setup.dateOfIncorporation)}). MCIT first applies for taxable year ${new Date(setup.dateOfIncorporation).getFullYear() + 3}.</div>`
    : '';

  const formHtml = `
    <div class="form-title">
      <h2>BIR Form 1702-RT — Annual Income Tax Return for Corporations, Partnerships and Other Non-Individual Taxpayers</h2>
      <div class="sub">For Calendar Year ${year} &nbsp;|&nbsp; Regular Rate ${rate * 100}% — ${deduction === 'osd' ? 'OSD' : 'Itemized Deduction'}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(setup.tin || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">8</div><div class="return-line-label">Registered Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(name)}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part IV – Computation of Tax</div>
      <div class="return-line"><div class="return-line-num">27</div><div class="return-line-label">Sales/Receipts/Revenues/Fees</div><div class="return-line-amt" id="c1702rt-27">₱ 0.00</div></div>
      ${manualLine1702RT('28', 'Less: Sales Returns, Allowances and Discounts', 'c1702rt-28')}
      <div class="return-line"><div class="return-line-num">29</div><div class="return-line-label" style="font-weight:700;">Net Sales/Receipts/Revenues/Fees</div><div class="return-line-amt" id="c1702rt-29">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">30</div><div class="return-line-label">Less: Cost of Sales/Services</div><div class="return-line-amt" id="c1702rt-30">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">31</div><div class="return-line-label" style="font-weight:700;">Gross Income from Operation</div><div class="return-line-amt" id="c1702rt-31">₱ 0.00</div></div>
      ${manualLine1702RT('32', 'Add: Other Taxable Income Not Subjected to Final Tax', 'c1702rt-32')}
      <div class="return-line"><div class="return-line-num">33</div><div class="return-line-label" style="font-weight:700;">Total Taxable Income</div><div class="return-line-amt" id="c1702rt-33">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">34</div><div class="return-line-label">Ordinary Allowable Itemized Deductions</div><div class="return-line-amt" id="c1702rt-34">₱ 0.00</div></div>
      ${manualLine1702RT('35', 'Special Allowable Itemized Deductions', 'c1702rt-35')}
      ${manualLine1702RT('36', 'NOLCO', 'c1702rt-36')}
      <div class="return-line"><div class="return-line-num">37</div><div class="return-line-label">Total Deductions (Itemized)</div><div class="return-line-amt" id="c1702rt-37">₱ 0.00</div></div>
    </div>
    <div class="return-section">
      <div class="return-line"><div class="return-line-num">38</div><div class="return-line-label">Optional Standard Deduction (OSD)</div><div class="return-line-amt" id="c1702rt-38">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">39</div><div class="return-line-label" style="font-weight:700;">Net Taxable Income/(Loss) (${deduction === 'osd' ? 'OSD' : 'Itemized'})</div><div class="return-line-amt" id="c1702rt-39">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">40</div><div class="return-line-label">Applicable Income Tax Rate</div><div class="return-line-amt">${rate * 100}%</div></div>
      <div class="return-line"><div class="return-line-num">41</div><div class="return-line-label">Income Tax Due Other than MCIT</div><div class="return-line-amt" id="c1702rt-41">₱ 0.00</div></div>
      ${mcitExemptNote}
      <div class="return-line"><div class="return-line-num">42</div><div class="return-line-label">MCIT Due (${mcitRatePct}% of Total Taxable Income)</div><div class="return-line-amt" id="c1702rt-42">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">43</div><div class="return-line-label" style="font-weight:700;">Tax Due (Higher of Item 41 or 42)</div><div class="return-line-amt highlight" id="c1702rt-43">₱ 0.00</div></div>
      ${manualLine1702RT('44', "Prior Year's Excess Credits other than MCIT", 'c1702rt-44')}
      ${manualLine1702RT('45', 'Income Tax Payment under MCIT from Previous Quarter/s', 'c1702rt-45')}
      ${manualLine1702RT('46', 'Income Tax Payment under Regular Rate from Previous Quarter/s', 'c1702rt-46')}
      ${manualLine1702RT('47', 'Excess MCIT Applied this Current Taxable Year (only if Item 43 is the regular rate)', 'c1702rt-47')}
      ${manualLine1702RT('48', 'Creditable Tax Withheld from Previous Quarter/s per BIR Form No. 2307', 'c1702rt-48')}
      <div class="return-line"><div class="return-line-num">49</div><div class="return-line-label">Creditable Tax Withheld per BIR Form No. 2307 for the 4th Quarter</div><div class="return-line-amt">₱ ${fmt(data.cwtQ4)}</div></div>
      ${manualLine1702RT('50', 'Foreign Tax Credits, if applicable', 'c1702rt-50')}
      ${manualLine1702RT('51', 'Tax Paid in Return Previously Filed, if Amended', 'c1702rt-51')}
      ${manualLine1702RT('53', 'Other Tax Credits/Payments', 'c1702rt-53')}
      <div class="return-line"><div class="return-line-num">55</div><div class="return-line-label" style="font-weight:700;">Total Tax Credits/Payments</div><div class="return-line-amt" id="c1702rt-55">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">56</div><div class="return-line-label" style="font-weight:700;">Net Tax Payable/(Overpayment)</div><div class="return-line-amt" id="c1702rt-56">₱ 0.00</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part II – Total Tax Payable</div>
      <div class="return-line"><div class="return-line-num">14</div><div class="return-line-label">Tax Due</div><div class="return-line-amt" id="c1702rt-p2-14">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">15</div><div class="return-line-label">Less: Total Tax Credits/Payments</div><div class="return-line-amt" id="c1702rt-p2-15">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">16</div><div class="return-line-label" style="font-weight:700;">Net Tax Payable/(Overpayment)</div><div class="return-line-amt" id="c1702rt-p2-16">₱ 0.00</div></div>
      ${manualLine1702RT('17', 'Surcharge', 'c1702rt-p17')}
      ${manualLine1702RT('18', 'Interest', 'c1702rt-p18')}
      ${manualLine1702RT('19', 'Compromise', 'c1702rt-p19')}
      <div class="return-line"><div class="return-line-num">20</div><div class="return-line-label">Total Penalties</div><div class="return-line-amt" id="c1702rt-p2-20">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">21</div><div class="return-line-label" style="font-weight:700;">TOTAL AMOUNT PAYABLE/(OVERPAYMENT)</div><div class="return-line-amt highlight payable" id="c1702rt-p2-21">₱ 0.00</div></div>
    </div>`;

  el.innerHTML = renderIncomeTaxTabs([
    { key: 'pnl', label: 'Profit and Loss Statement', html: pnlHtml },
    { key: 'mapping', label: 'BIR Mapping of COA', html: mappingHtml },
    { key: 'form', label: 'BIR Form', html: formHtml },
  ], 'form');

  el._totals = { sales, cogs, opex };
  el._rate = rate;
  el._deduction = deduction;
  el._cwtQ4 = data.cwtQ4;
  el._mcitApplicable = mcitApplicable;
  el._year = year;
  bindIncomeTaxTabs(el);
  el.querySelectorAll('.recon-manual-input').forEach(inp => inp.addEventListener('input', () => recompute1702RT(el)));
  bindDeductionMappingTable(el, App.currentBusiness, () => render1702RT(el, data, setup, year, rate, deduction));
  recompute1702RT(el);
}

function manualLine1702RT(num, label, inputId) {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label">${escHtml(label)}</div>
    <div class="return-line-amt"><input type="number" step="0.01" class="recon-manual-input" id="${inputId}" value="0" style="width:120px;text-align:right;font-size:12px;"></div>
  </div>`;
}

function val1702RT(id) {
  const el = document.getElementById(id);
  return el ? (parseFloat(el.value) || 0) : 0;
}

function set1702RT(el, id, amount) {
  const target = el.querySelector(`#${id}`);
  if (target) target.textContent = `₱ ${fmt(amount)}`;
}

function recompute1702RT(el) {
  const { sales, cogs, opex } = el._totals;
  const rate = el._rate;
  const deduction = el._deduction;
  const year = el._year;

  const returns = val1702RT('c1702rt-28');
  const netSales = sales - returns;
  set1702RT(el, 'c1702rt-27', sales);
  set1702RT(el, 'c1702rt-29', netSales);
  set1702RT(el, 'c1702rt-30', cogs);

  const grossIncome = netSales - cogs;
  set1702RT(el, 'c1702rt-31', grossIncome);

  const otherIncome = val1702RT('c1702rt-32');
  const totalTaxableIncomeBase = grossIncome + otherIncome;
  set1702RT(el, 'c1702rt-33', totalTaxableIncomeBase);

  const special = val1702RT('c1702rt-35');
  const nolco = val1702RT('c1702rt-36');
  const itemizedTotal = opex + special + nolco;
  set1702RT(el, 'c1702rt-34', opex);
  set1702RT(el, 'c1702rt-37', itemizedTotal);

  const osd = getOsdRate(dateForYear(year)) * totalTaxableIncomeBase;
  set1702RT(el, 'c1702rt-38', osd);

  const netTaxableIncome = deduction === 'osd' ? (totalTaxableIncomeBase - osd) : (totalTaxableIncomeBase - itemizedTotal);
  set1702RT(el, 'c1702rt-39', netTaxableIncome);

  const incomeTaxDueRegular = Math.max(0, netTaxableIncome) * rate;
  set1702RT(el, 'c1702rt-41', incomeTaxDueRegular);

  // Still within the first 3 taxable years from incorporation -> not yet
  // subject to MCIT at all, regardless of gross income (NIRC Sec. 27(E)(1)).
  const mcit = el._mcitApplicable ? Math.max(0, totalTaxableIncomeBase) * getMcitRate(dateForYear(year)) : 0;
  set1702RT(el, 'c1702rt-42', mcit);

  const taxDue = Math.max(incomeTaxDueRegular, mcit);
  set1702RT(el, 'c1702rt-43', taxDue);
  set1702RT(el, 'c1702rt-p2-14', taxDue);

  const credits = ['c1702rt-44','c1702rt-45','c1702rt-46','c1702rt-47','c1702rt-48','c1702rt-50','c1702rt-51','c1702rt-53']
    .reduce((s, id) => s + val1702RT(id), 0) + (el._cwtQ4 || 0);
  set1702RT(el, 'c1702rt-55', credits);
  set1702RT(el, 'c1702rt-p2-15', credits);

  const netPayable = taxDue - credits;
  set1702RT(el, 'c1702rt-56', netPayable);
  set1702RT(el, 'c1702rt-p2-16', netPayable);

  const penalties = ['c1702rt-p17','c1702rt-p18','c1702rt-p19'].reduce((s, id) => s + val1702RT(id), 0);
  set1702RT(el, 'c1702rt-p2-20', penalties);
  set1702RT(el, 'c1702rt-p2-21', netPayable + penalties);
}
