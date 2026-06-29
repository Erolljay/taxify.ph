/* ============================================================
   Tallo CPA – BIR Tax App
   1701q-report.js – Quarterly Income Tax Return for Individuals
                      (BIR Form 1701-Q, Jan 2018 ENCS)

   Scope (v1 "core path"): single taxpayer (no spouse schedule),
   graduated rates OR 8% flat option, itemized OR OSD deduction,
   no NOLCO/exempt/special-rate schedules. Sales/COGS/Opex are
   reconstructed from transactions via pnl-helpers.js; manual
   inputs cover figures Manager.io has no transaction trail for
   (non-operating income, prior credits, penalties).
   ============================================================ */

const TAX_TABLE_2023 = [
  { upTo: 250000,      base: 0,        rate: 0    },
  { upTo: 400000,      base: 0,        rate: 0.15 },
  { upTo: 800000,      base: 22500,    rate: 0.20 },
  { upTo: 2000000,     base: 102500,   rate: 0.25 },
  { upTo: 8000000,     base: 402500,   rate: 0.30 },
  { upTo: Infinity,    base: 2202500,  rate: 0.35 },
];

function graduatedTaxDue(taxableIncome) {
  const ti = Math.max(0, taxableIncome);
  for (let i = 0; i < TAX_TABLE_2023.length; i++) {
    const bracket = TAX_TABLE_2023[i];
    if (ti <= bracket.upTo) {
      const prevCeiling = i === 0 ? 0 : TAX_TABLE_2023[i - 1].upTo;
      return bracket.base + (ti - prevCeiling) * bracket.rate;
    }
  }
  return 0;
}

async function init1701QReport() {
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
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ BIR Form 1701-Q is for Individual taxpayers only. This business is set up as Non-Individual.</div>`;
    return null;
  }
  outputEl.innerHTML = '';

  filterEl.innerHTML = periodFilterHTML('quarterly', 'c1701q');
  filterEl.insertAdjacentHTML('beforeend', `
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin || '—')}</strong>
    </div>
    <div class="filter-bar" style="margin-top:6px;">
      <label>Method</label>
      <select id="c1701q-method">
        <option value="graduated">Graduated Rates</option>
        <option value="8pct">8% Flat Rate</option>
      </select>
      <label>Deduction</label>
      <select id="c1701q-deduction">
        <option value="itemized">Itemized Deduction</option>
        <option value="osd">Optional Standard Deduction (OSD)</option>
      </select>
    </div>`);

  document.getElementById('c1701q-gen').addEventListener('click', () => generate1701Q(biz, setup, outputEl));
  return biz;
}

async function generate1701Q(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Aggregating transactions…</span></div>`;

  const quarter = parseInt(document.getElementById('c1701q-quarter').value, 10);
  const year = parseInt(document.getElementById('c1701q-year').value, 10);
  const method = document.getElementById('c1701q-method').value;
  const deduction = document.getElementById('c1701q-deduction').value;

  try {
    const coa = await loadChartOfAccounts(biz);
    const yearStart = new Date(year, 0, 1);
    const { start: qStart, end: qEnd } = getPeriodDates('quarterly', quarter, year);
    const prevEnd = new Date(qStart.getTime() - 86400000);

    const [thisQ, cumPrev] = await Promise.all([
      aggregateAccountActivity(biz, qStart, qEnd, coa),
      quarter > 1 ? aggregateAccountActivity(biz, yearStart, prevEnd, coa) : Promise.resolve({ totals: { income: 0, cogs: 0, opex: 0 } }),
    ]);

    const cwtPrepaid2306 = isFinite(quarter) ? await getPrepaidTaxAssetBalance(biz, coa, qEnd, 'Prepaid Tax Asset-2306') : 0;
    const cwtPrepaid2306PrevQ = quarter > 1 ? await getPrepaidTaxAssetBalance(biz, coa, prevEnd, 'Prepaid Tax Asset-2306') : 0;
    const cwtThisQuarter = cwtPrepaid2306 - cwtPrepaid2306PrevQ;

    const period = { quarter, year, label: `${quarterLabel(quarter)} ${year}` };
    render1701Q(outputEl, { thisQ, cumPrev, cwtThisQuarter }, setup, period, method, deduction);

    ['c1701q-print', 'c1701q-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function netIncomeFor(totals, deduction, itemizedTotal) {
  const sales = totals.income;
  const cogs = totals.cogs;
  const grossIncome = sales - cogs;
  const itemized = itemizedTotal !== undefined ? itemizedTotal : totals.opex;
  const osd = 0.4 * sales;
  const allowable = deduction === 'osd' ? osd : itemized;
  return { sales, cogs, grossIncome, itemized, osd, allowable, netIncome: grossIncome - allowable };
}

function render1701Q(el, data, setup, period, method, deduction) {
  const taxpayerName = [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ') || setup.taxpayerName;

  const schedule = buildItemizedSchedule(App.currentBusiness, data.thisQ.byAccount);
  const thisQ = netIncomeFor(data.thisQ.totals, deduction, schedule.total);
  const prevQ = netIncomeFor(data.cumPrev.totals, deduction);

  const pnlHtml = renderPnLStatementHtml(data.thisQ.totals, data.thisQ.byAccount);
  const mappingHtml = renderDeductionScheduleHtml(schedule, 'Ordinary Allowable Itemized Deductions (This Quarter)');

  const formHtml = `
    <div class="form-title">
      <h2>BIR Form 1701-Q — Quarterly Income Tax Return for Individuals, Estates and Trusts</h2>
      <div class="sub">For ${escHtml(period.label)} &nbsp;|&nbsp; ${method === '8pct' ? '8% Flat Rate' : 'Graduated Rates — ' + (deduction === 'osd' ? 'OSD' : 'Itemized Deduction')}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(setup.tin || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Taxpayer/Filer's Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(taxpayerName)}</div></div>
      <div class="return-line"><div class="return-line-num">10</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
    </div>

    ${method === '8pct' ? render1701QSchedule2(thisQ, prevQ, data) : render1701QSchedule1(thisQ, prevQ, deduction)}

    <div class="return-section">
      <div class="return-section-header">Schedule III – Tax Credits/Payments</div>
      ${manualLine(55, "Prior Year's Excess Credits", 'c1701q-55')}
      ${manualLine(56, 'Tax Payment/s for the Previous Quarter/s', 'c1701q-56')}
      ${manualLine(57, 'Creditable Tax Withheld for the Previous Quarter/s', 'c1701q-57')}
      ${returnLine(58, 'Creditable Tax Withheld per BIR Form No. 2307 for this Quarter', data.cwtThisQuarter)}
      ${manualLine(59, 'Tax Paid in Return Previously Filed, if Amended', 'c1701q-59')}
      ${manualLine(60, 'Foreign Tax Credits, if applicable', 'c1701q-60')}
      ${manualLine(61, 'Other Tax Credits/Payments', 'c1701q-61')}
      <div class="return-line"><div class="return-line-num">62</div><div class="return-line-label" style="font-weight:700;">Total Tax Credits/Payments</div><div class="return-line-amt" id="c1701q-line62">₱ 0.00</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part III – Total Tax Payable</div>
      <div class="return-line"><div class="return-line-num">26</div><div class="return-line-label" style="font-weight:700;">Tax Due</div><div class="return-line-amt" id="c1701q-line26">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">27</div><div class="return-line-label">Less: Tax Credits/Payments</div><div class="return-line-amt" id="c1701q-line27">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">28</div><div class="return-line-label" style="font-weight:700;">Tax Payable/(Overpayment)</div><div class="return-line-amt" id="c1701q-line28">₱ 0.00</div></div>
      ${manualLine(64, 'Surcharge', 'c1701q-64')}
      ${manualLine(65, 'Interest', 'c1701q-65')}
      ${manualLine(66, 'Compromise', 'c1701q-66')}
      <div class="return-line"><div class="return-line-num">67</div><div class="return-line-label">Total Penalties</div><div class="return-line-amt" id="c1701q-line67">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">30</div><div class="return-line-label" style="font-weight:700;">TOTAL AMOUNT PAYABLE/(OVERPAYMENT)</div><div class="return-line-amt highlight payable" id="c1701q-line30">₱ 0.00</div></div>
    </div>`;

  el.innerHTML = renderIncomeTaxTabs([
    { key: 'pnl', label: 'Profit and Loss Statement', html: pnlHtml },
    { key: 'mapping', label: 'BIR Mapping of COA', html: mappingHtml },
    { key: 'form', label: 'BIR Form', html: formHtml },
  ], 'form');

  el._cwtThisQuarter = data.cwtThisQuarter;
  bindIncomeTaxTabs(el);
  el.querySelectorAll('.recon-manual-input').forEach(inp => inp.addEventListener('input', () => recompute1701Q(el, thisQ, prevQ, method)));
  bindDeductionMappingTable(el, App.currentBusiness, () => render1701Q(el, data, setup, period, method, deduction));
  recompute1701Q(el, thisQ, prevQ, method);
}

function render1701QSchedule1(thisQ, prevQ, deduction) {
  const allowableLabel = deduction === 'osd' ? '40 Optional Standard Deduction (OSD)' : '39 Total Allowable Itemized Deductions';
  return `
    <div class="return-section">
      <div class="return-section-header">Schedule I – For Graduated IT Rate</div>
      ${returnLine(36, 'Sales/Revenues/Receipts/Fees (net of returns, allowances &amp; discounts)', thisQ.sales)}
      ${returnLine(37, 'Less: Cost of Sales/Services', thisQ.cogs)}
      ${returnLine(38, 'Gross Income/(Loss) from Operation', thisQ.grossIncome, true)}
      ${returnLine(deduction === 'osd' ? 40 : 39, allowableLabel, thisQ.allowable)}
      ${returnLine(41, 'Net Income/(Loss) This Quarter', thisQ.netIncome, true)}
      ${returnLine(42, 'Add: Taxable Income/(Loss) Previous Quarter/s', prevQ.netIncome)}
      ${manualLine(43, 'Non-Operating Income', 'c1701q-43')}
      ${manualLine(44, 'Share in Income from General Professional Partnership (GPP)', 'c1701q-44')}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">45</div><div class="return-line-label">Total Taxable Income/(Loss) To Date</div><div class="return-line-amt" id="c1701q-line45">0.00</div></div>
      <div class="return-line highlight" style="font-weight:700;"><div class="return-line-num">46</div><div class="return-line-label">TAX DUE (Graduated Rates per Tax Table)</div><div class="return-line-amt" id="c1701q-line46">0.00</div></div>
    </div>`;
}

function render1701QSchedule2(thisQ, prevQ, data) {
  return `
    <div class="return-section">
      <div class="return-section-header">Schedule II – For 8% IT Rate</div>
      ${returnLine(47, 'Sales/Revenues/Receipts/Fees (net of returns, allowances &amp; discounts)', thisQ.sales)}
      ${manualLine(48, 'Add: Non-Operating Income', 'c1701q-48')}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">49</div><div class="return-line-label">Total Income for the Quarter</div><div class="return-line-amt" id="c1701q-line49">0.00</div></div>
      ${returnLine(50, 'Add: Total Taxable Income/(Loss) Previous Quarter', prevQ.sales)}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">51</div><div class="return-line-label">Cumulative Taxable Income/(Loss) as of This Quarter</div><div class="return-line-amt" id="c1701q-line51">0.00</div></div>
      ${returnLine(52, 'Less: Allowable Reduction (P250,000)', 250000)}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">53</div><div class="return-line-label">Taxable Income/(Loss) To Date</div><div class="return-line-amt" id="c1701q-line53">0.00</div></div>
      <div class="return-line highlight" style="font-weight:700;"><div class="return-line-num">54</div><div class="return-line-label">TAX DUE (8% Tax Rate)</div><div class="return-line-amt" id="c1701q-line54">0.00</div></div>
    </div>`;
}

function manualLine(num, label, inputId) {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label">${escHtml(label)}</div>
    <div class="return-line-amt"><input type="number" step="0.01" class="recon-manual-input" id="${inputId}" value="0" style="width:120px;text-align:right;font-size:12px;"></div>
  </div>`;
}

function val(id) {
  const el = document.getElementById(id);
  return el ? (parseFloat(el.value) || 0) : 0;
}

function recompute1701Q(el, thisQ, prevQ, method) {
  let taxDue;
  if (method === '8pct') {
    const nonOp = val('c1701q-48');
    const line49 = thisQ.sales + nonOp;
    const line51 = line49 + prevQ.sales;
    const line53 = Math.max(0, line51 - 250000);
    taxDue = line53 * 0.08;
    setText(el, 'c1701q-line49', line49);
    setText(el, 'c1701q-line51', line51);
    setText(el, 'c1701q-line53', line53);
    setText(el, 'c1701q-line54', taxDue);
  } else {
    const nonOp = val('c1701q-43');
    const gpp = val('c1701q-44');
    const line45 = thisQ.netIncome + prevQ.netIncome + nonOp + gpp;
    taxDue = graduatedTaxDue(line45);
    setText(el, 'c1701q-line45', line45);
    setText(el, 'c1701q-line46', taxDue);
  }

  const line62 = ['c1701q-55','c1701q-56','c1701q-57','c1701q-59','c1701q-60','c1701q-61'].reduce((s, id) => s + val(id), 0) + (el._cwtThisQuarter || 0);

  setText(el, 'c1701q-line62', line62);
  setText(el, 'c1701q-line26', taxDue);
  setText(el, 'c1701q-line27', line62);
  const line28 = taxDue - line62;
  setText(el, 'c1701q-line28', line28);

  const penalties = ['c1701q-64','c1701q-65','c1701q-66'].reduce((s, id) => s + val(id), 0);
  setText(el, 'c1701q-line67', penalties);
  setText(el, 'c1701q-line30', line28 + penalties);
}

function setText(el, id, amount) {
  const target = el.querySelector(`#${id}`);
  if (target) target.textContent = `₱ ${fmt(amount)}`;
}
