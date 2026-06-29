/* ============================================================
   Tallo CPA – BIR Tax App for Manager.io
   vat.js  –  BIR Form 2550M (Monthly) and 2550Q (Quarterly)
   ============================================================ */

// ── RENDER ENTRY POINT ───────────────────────────────────────
function renderVATReturn(el, mode) {
  const setup = getSetup(App.currentBusiness);

  if (!setup || setup.salesTaxType !== 'vat') {
    el.innerHTML = `<div class="alert alert-warn">
      ⚠️ This business is not configured as VAT-registered. Go to <strong>Setup → Business Info</strong> and set Sales Tax Type to VAT.
    </div>`;
    return;
  }

  const vm = setup.vatMapping || {};
  const hasMapping = vm.sales?.taxable || vm.purchases?.capitalGoods;

  const now = new Date();
  const curMonth = now.getMonth();
  const curYear  = now.getFullYear();
  const curQ     = Math.ceil((curMonth + 1) / 3);

  const label = mode === 'monthly' ? 'BIR Form 2550M — Monthly VAT Declaration' : 'BIR Form 2550Q — Quarterly VAT Return';
  const sublabel = mode === 'monthly' ? 'Monthly' : 'Quarterly';

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${label}</div>
        <div class="page-subtitle">${escHtml(App.currentBusiness)}</div>
      </div>
    </div>

    ${!hasMapping ? `<div class="setup-required">
      <span>⚠️</span>
      <div><strong>VAT Mapping Not Set</strong> — Go to Setup → VAT Mapping to map your tax codes before generating this return.</div>
      <button class="btn btn-primary btn-sm" onclick="navigate('setup')">Go to Setup</button>
    </div>` : ''}

    <div class="filter-bar">
      ${mode === 'monthly' ? `
        <label>Month</label>
        <select id="vat-month">
          ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m =>
            `<option value="${m}" ${m === curMonth ? 'selected' : ''}>${monthName(m)}</option>`
          ).join('')}
        </select>
      ` : `
        <label>Quarter</label>
        <select id="vat-quarter">
          ${[1,2,3,4].map(q =>
            `<option value="${q}" ${q === curQ ? 'selected' : ''}>${quarterLabel(q)}</option>`
          ).join('')}
        </select>
      `}
      <label>Year</label>
      <select id="vat-year">
        ${[curYear-2, curYear-1, curYear, curYear+1].map(y =>
          `<option value="${y}" ${y === curYear ? 'selected' : ''}>${y}</option>`
        ).join('')}
      </select>
      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="btn-gen-vat">⚡ Generate</button>
      <button class="btn btn-outline" id="btn-print-vat" style="display:none;" onclick="window.print()">🖨 Print</button>
    </div>

    <div id="vat-output"></div>
  `;

  document.getElementById('btn-gen-vat').addEventListener('click', () => generateVAT(mode));
}

// ── GENERATE ─────────────────────────────────────────────────
async function generateVAT(mode) {
  const output = document.getElementById('vat-output');
  output.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions from Manager…</span></div>`;

  const year = parseInt(document.getElementById('vat-year').value, 10);
  let period, dates;

  if (mode === 'monthly') {
    period = parseInt(document.getElementById('vat-month').value, 10);
    dates  = getPeriodDates('monthly', period, year);
  } else {
    period = parseInt(document.getElementById('vat-quarter').value, 10);
    dates  = getPeriodDates('quarterly', period, year);
  }

  const { start, end } = dates;
  const setup = getSetup(App.currentBusiness);
  const vm    = setup.vatMapping || {};

  try {
    // Fetch invoices in parallel
    const [salesItems, purchaseItems] = await Promise.all([
      fetchAllBatch('/api4/sales-invoice-batch', App.currentBusiness),
      fetchAllBatch('/api4/purchase-invoice-batch', App.currentBusiness),
    ]);

    // Filter by period
    const sales = salesItems.filter(({ item }) => inRange(item?.Date, start, end));
    const purchases = purchaseItems.filter(({ item }) => inRange(item?.Date, start, end));

    // Compute sales figures
    const salesFig = computeSalesFigures(sales, vm.sales || {});
    // Compute purchase figures
    const purchFig = computePurchaseFigures(purchases, vm.purchases || {});

    // Compute VAT
    const outputVAT = salesFig.taxable * 0.12;
    const inputVAT  = purchFig.capitalGoods * 0.12 + purchFig.otherGoods * 0.12 + purchFig.services * 0.12;
    const netVAT    = outputVAT - inputVAT;

    // Render
    renderVATOutput(output, mode, period, year, salesFig, purchFig, outputVAT, inputVAT, netVAT, setup, start, end);
    document.getElementById('btn-print-vat').style.display = '';

  } catch (err) {
    output.innerHTML = `<div class="alert alert-error">❌ Error: ${escHtml(err.message)}</div>`;
  }
}

// ── COMPUTE SALES ─────────────────────────────────────────────
function computeSalesFigures(invoices, salesMap) {
  let taxable = 0, zeroRated = 0, exempt = 0, govtSales = 0;

  for (const { item } of invoices) {
    const lines = item?.Lines || [];
    for (const line of lines) {
      const tcName = line?.TaxCode?.name || line?.TaxCodeName || '';
      const amt    = Math.abs(Number(line?.Amount || 0));

      if (salesMap.taxable && tcName === salesMap.taxable)   taxable   += amt;
      else if (salesMap.zeroRated && tcName === salesMap.zeroRated) zeroRated += amt;
      else if (salesMap.exempt && tcName === salesMap.exempt)        exempt    += amt;
    }
    // Check if customer is a government entity (heuristic: flag in item or separate field)
    // For now, manual entry for govt sales is provided in the form override below
  }

  return { taxable, zeroRated, exempt, govtSales };
}

// ── COMPUTE PURCHASES ─────────────────────────────────────────
function computePurchaseFigures(invoices, purchMap) {
  let capitalGoods = 0, otherGoods = 0, services = 0, zeroRated = 0, exempt = 0;

  for (const { item } of invoices) {
    const lines = item?.Lines || [];
    for (const line of lines) {
      const tcName = line?.TaxCode?.name || line?.TaxCodeName || '';
      const amt    = Math.abs(Number(line?.Amount || 0));

      if (purchMap.capitalGoods && tcName === purchMap.capitalGoods)                   capitalGoods += amt;
      else if (purchMap.otherThanCapitalGoods && tcName === purchMap.otherThanCapitalGoods) otherGoods += amt;
      else if (purchMap.services && tcName === purchMap.services)                      services     += amt;
      else if (purchMap.zeroRated && tcName === purchMap.zeroRated)                    zeroRated    += amt;
      else if (purchMap.exempt && tcName === purchMap.exempt)                          exempt       += amt;
    }
  }

  return { capitalGoods, otherGoods, services, zeroRated, exempt };
}

// ── RENDER RETURN ─────────────────────────────────────────────
function renderVATOutput(el, mode, period, year, sales, purch, outputVAT, inputVAT, netVAT, setup, start, end) {
  const periodLabel = mode === 'monthly'
    ? `${monthName(period)} ${year}`
    : `${quarterLabel(period)} ${year}`;

  const grossSales = sales.taxable + sales.zeroRated + sales.exempt;

  // Allow manual override for prior period input VAT
  const priorInputKey = `tallocpa_prior_input_${App.currentBusiness}_${year}_${period}`;
  const priorInput = parseFloat(localStorage.getItem(priorInputKey) || '0');

  const totalInputVAT  = inputVAT + priorInput;
  const vatPayable     = Math.max(0, outputVAT - totalInputVAT);
  const vatRefundable  = Math.max(0, totalInputVAT - outputVAT);

  el.innerHTML = `
    <!-- RETURN HEADER -->
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:16px;font-weight:700;color:#0d1b3e;">
            ${mode === 'monthly' ? 'BIR Form 2550M' : 'BIR Form 2550Q'}
          </div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">
            Period: <strong>${periodLabel}</strong>
            &nbsp;|&nbsp; Taxpayer: <strong>${escHtml(setup.taxpayerName || App.currentBusiness)}</strong>
            &nbsp;|&nbsp; TIN: <strong>${escHtml(setup.tin || '—')}</strong>
            &nbsp;|&nbsp; RDO: <strong>${escHtml(setup.rdoCode || '—')}</strong>
          </div>
        </div>
        <div style="text-align:right;font-size:11px;color:#94a3b8;">
          ${start.toLocaleDateString('en-PH')} – ${end.toLocaleDateString('en-PH')}
        </div>
      </div>
    </div>

    <!-- SUMMARY STATS -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Gross Sales</div>
        <div class="stat-value">₱ ${fmt(grossSales)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Output VAT</div>
        <div class="stat-value">₱ ${fmt(outputVAT)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Input VAT</div>
        <div class="stat-value">₱ ${fmt(totalInputVAT)}</div>
      </div>
      <div class="stat-card ${vatPayable > 0 ? 'red' : 'green'}">
        <div class="stat-label">${vatPayable > 0 ? 'VAT Payable' : 'Excess Input VAT'}</div>
        <div class="stat-value">₱ ${fmt(vatPayable > 0 ? vatPayable : vatRefundable)}</div>
      </div>
    </div>

    <!-- PART I: SALES -->
    <div class="return-section">
      <div class="return-section-header">PART I — SALES / RECEIPTS AND OUTPUT TAX</div>
      ${returnLine('1', 'Taxable Sales (net of VAT)', sales.taxable)}
      ${returnLine('2', 'Sales to Government (5% Final Withholding VAT)', sales.govtSales || 0)}
      ${returnLine('3', 'Zero-Rated Sales', sales.zeroRated)}
      ${returnLine('4', 'Exempt Sales', sales.exempt)}
      ${returnLine('5', 'Total Gross Sales (1+2+3+4)', grossSales, true)}
      ${returnLine('6', 'Output Tax (12% × Line 1)', outputVAT)}
    </div>

    <!-- PART II: PURCHASES -->
    <div class="return-section">
      <div class="return-section-header">PART II — PURCHASES AND INPUT TAX</div>
      ${returnLine('7', 'Capital Goods (≤ ₱1M per transaction)', purch.capitalGoods)}
      ${returnLine('8', 'Goods other than Capital Goods', purch.otherGoods)}
      ${returnLine('9', 'Services', purch.services)}
      ${returnLine('10', 'Zero-Rated Purchases', purch.zeroRated)}
      ${returnLine('11', 'Exempt Purchases', purch.exempt)}
      ${returnLine('12', 'Current Period Input Tax (12% × (7+8+9))', inputVAT)}
      <div class="return-line" style="background:#fffbeb;">
        <div class="return-line-num">13</div>
        <div class="return-line-label">Prior Period Excess Input Tax (carry-over)</div>
        <div>
          <input type="number" style="width:130px;text-align:right;padding:4px 8px;border:1.5px solid #e5e7eb;border-radius:5px;font-family:'Courier New',monospace;font-size:12px;"
            id="prior-input-vat" value="${fmt(priorInput, 2).replace(/,/g,'')}"
            onchange="localStorage.setItem('${priorInputKey}', this.value); regenerateVAT('${mode}')">
        </div>
      </div>
      ${returnLine('14', 'Total Allowable Input Tax (12+13)', totalInputVAT, true)}
    </div>

    <!-- PART III: NET VAT -->
    <div class="return-section">
      <div class="return-section-header">PART III — COMPUTATION OF VAT PAYABLE / REFUNDABLE</div>
      ${returnLine('15', 'Output Tax (from Line 6)', outputVAT)}
      ${returnLine('16', 'Less: Total Input Tax (from Line 14)', totalInputVAT)}
      <div class="return-line" style="background:${vatPayable > 0 ? '#fef2f2' : '#f0fdf4'};border-radius:0 0 8px 8px;">
        <div class="return-line-num" style="background:${vatPayable > 0 ? '#fca5a5' : '#86efac'};color:white;border:none;">17</div>
        <div class="return-line-label" style="font-weight:700;">
          ${vatPayable > 0 ? '⚠️ VAT PAYABLE' : '✅ EXCESS INPUT VAT (Refundable/Creditable)'}
        </div>
        <div class="return-line-amt ${vatPayable > 0 ? 'payable highlight' : 'refund highlight'}">
          ₱ ${fmt(vatPayable > 0 ? vatPayable : vatRefundable)}
        </div>
      </div>
    </div>

    <div class="alert alert-info" style="margin-top:12px;">
      ℹ️ <strong>Note:</strong> Figures are computed from Manager.io transactions matched by the tax codes mapped in Setup.
      Government sales (Line 2) must be entered manually if not tagged separately. Verify all amounts before filing.
    </div>
  `;
}

function returnLine(num, label, amount, bold = false) {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label" style="${bold ? 'font-weight:700;' : ''}">${label}</div>
    <div class="return-line-amt ${bold ? 'highlight' : ''}">₱ ${fmt(amount)}</div>
  </div>`;
}

function regenerateVAT(mode) {
  // Re-run generate after manual input change
  generateVAT(mode);
}
