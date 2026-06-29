/* ============================================================
   Tallo CPA – BIR Tax App
   vat-report.js  –  Shared VAT return logic for 2550M and 2550Q
   ============================================================ */

async function initVATReport(mode, filterAreaId, outputId) {
  const filterEl = document.getElementById(filterAreaId);
  const outputEl = document.getElementById(outputId);

  // Detect business from Manager context
  let biz;
  try {
    biz = await getReportBusiness(document.getElementById('biz-selector-wrap'));
    App.currentBusiness = biz;
  } catch(e) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Could not connect to Manager: ${escHtml(e.message)}</div>`;
    return;
  }

  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Loading business setup…</span></div>`;
  const setup = await loadSetup(biz);
  outputEl.innerHTML = '';

  if (!setup) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Business info not configured. Fill in the <strong>Business</strong> tab in the Tallo CPA extension first.</div>`;
    return;
  }

  // Render filter bar
  filterEl.innerHTML = periodFilterHTML(mode, 'vat') + `
    <div style="font-size:11px;color:#6b7280;margin-top:6px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      Taxpayer: <strong>${escHtml(setup.taxpayerName||'—')}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin||'—')}</strong>
    </div>`;

  document.getElementById('vat-gen').addEventListener('click', () => generateVATReport(mode, biz, setup, outputEl));
}

async function generateVATReport(mode, biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;

  const year   = parseInt(document.getElementById('vat-year').value, 10);
  const period = mode === 'monthly'
    ? parseInt(document.getElementById('vat-month').value, 10)
    : parseInt(document.getElementById('vat-quarter').value, 10);

  const { start, end } = getPeriodDates(mode, period, year);
  const vm = setup.vatMapping || {};

  try {
    const [salesItems, purchItems] = await Promise.all([
      fetchAllBatch('/api4/sales-invoice-batch', biz),
      fetchAllBatch('/api4/purchase-invoice-batch', biz),
    ]);

    const sales = salesItems.filter(({ item }) => inRange(item?.Date, start, end));
    const purch = purchItems.filter(({ item }) => inRange(item?.Date, start, end));

    // Compute sales
    let taxable = 0, zeroRatedS = 0, exemptS = 0;
    for (const { item } of sales) {
      for (const line of (item?.Lines || [])) {
        const tc  = line?.TaxCode || '';
        const amt = Math.abs(Number(line?.Amount || 0));
        if (tc && tc === vm.sales_taxable)   taxable   += amt;
        else if (tc && tc === vm.sales_zero) zeroRatedS += amt;
        else if (tc && tc === vm.sales_exempt) exemptS  += amt;
      }
    }

    // Compute purchases
    let capitalGoods = 0, otherGoods = 0, services = 0, zeroRatedP = 0, exemptP = 0;
    for (const { item } of purch) {
      for (const line of (item?.Lines || [])) {
        const tc  = line?.TaxCode || '';
        const amt = Math.abs(Number(line?.Amount || 0));
        if (tc && tc === vm.purch_capital)   capitalGoods += amt;
        else if (tc && tc === vm.purch_other)   otherGoods += amt;
        else if (tc && tc === vm.purch_services) services  += amt;
        else if (tc && tc === vm.purch_zero)  zeroRatedP   += amt;
        else if (tc && tc === vm.purch_exempt) exemptP     += amt;
      }
    }

    const outputVAT     = taxable * 0.12;
    const inputVAT      = (capitalGoods + otherGoods + services) * 0.12;
    const priorKey      = `tallocpa_prior_input_${biz}_${year}_${period}`;
    const priorInput    = parseFloat(localStorage.getItem(priorKey) || '0');
    const totalInput    = inputVAT + priorInput;
    const vatPayable    = Math.max(0, outputVAT - totalInput);
    const vatRefundable = Math.max(0, totalInput - outputVAT);
    const grossSales    = taxable + zeroRatedS + exemptS;

    const periodLabel = mode === 'monthly'
      ? `${monthName(period)} ${year}`
      : `${quarterLabel(period)} ${year}`;

    const formNo = mode === 'monthly' ? '2550M' : '2550Q';

    outputEl.innerHTML = `
      <!-- Print header -->
      <div style="text-align:center;margin-bottom:16px;display:none;" class="print-header">
        <h2 style="font-size:16px;margin:0;">BIR Form ${formNo}</h2>
        <div style="font-size:12px;">${escHtml(setup.taxpayerName||biz)} | TIN: ${escHtml(setup.tin||'—')} | RDO: ${escHtml(setup.rdoCode||'—')}</div>
        <div style="font-size:12px;">Period: ${periodLabel}</div>
      </div>

      <div class="stats-row">
        <div class="stat-card"><div class="stat-label">Gross Sales</div><div class="stat-value">₱ ${fmt(grossSales)}</div></div>
        <div class="stat-card"><div class="stat-label">Output VAT</div><div class="stat-value">₱ ${fmt(outputVAT)}</div></div>
        <div class="stat-card"><div class="stat-label">Input VAT</div><div class="stat-value">₱ ${fmt(totalInput)}</div></div>
        <div class="stat-card ${vatPayable > 0 ? 'red' : 'green'}">
          <div class="stat-label">${vatPayable > 0 ? 'VAT Payable' : 'Excess Input'}</div>
          <div class="stat-value">₱ ${fmt(vatPayable > 0 ? vatPayable : vatRefundable)}</div>
        </div>
      </div>

      <div class="return-section">
        <div class="return-section-header">PART I — SALES / RECEIPTS AND OUTPUT TAX</div>
        ${returnLine('1','Taxable Sales (net of VAT)', taxable)}
        ${returnLine('2','Sales to Government (5% Final Withholding VAT)', 0)}
        ${returnLine('3','Zero-Rated Sales', zeroRatedS)}
        ${returnLine('4','Exempt Sales', exemptS)}
        ${returnLine('5','Total Gross Sales (1+2+3+4)', grossSales, true)}
        ${returnLine('6','Output Tax (12% × Line 1)', outputVAT)}
      </div>

      <div class="return-section">
        <div class="return-section-header">PART II — PURCHASES AND INPUT TAX</div>
        ${returnLine('7','Capital Goods (≤ ₱1M per transaction)', capitalGoods)}
        ${returnLine('8','Goods other than Capital Goods', otherGoods)}
        ${returnLine('9','Services', services)}
        ${returnLine('10','Zero-Rated Purchases', zeroRatedP)}
        ${returnLine('11','Exempt Purchases', exemptP)}
        ${returnLine('12','Current Period Input Tax (12% × (7+8+9))', inputVAT)}
        <div class="return-line" style="background:#fffbeb;">
          <div class="return-line-num">13</div>
          <div class="return-line-label">Prior Period Excess Input Tax (carry-over)
            <input type="number" style="width:120px;margin-left:8px;padding:3px 6px;border:1.5px solid #e5e7eb;border-radius:4px;font-size:12px;"
              value="${fmt(priorInput,2).replace(/,/g,'')}"
              onchange="localStorage.setItem('${priorKey}',this.value);generateVATReport('${mode}','${biz}',${JSON.stringify(setup).replace(/</g,'\\u003c')},document.getElementById('report-output'))">
          </div>
          <div class="return-line-amt">₱ ${fmt(priorInput)}</div>
        </div>
        ${returnLine('14','Total Allowable Input Tax (12+13)', totalInput, true)}
      </div>

      <div class="return-section">
        <div class="return-section-header">PART III — COMPUTATION OF VAT PAYABLE / REFUNDABLE</div>
        ${returnLine('15','Output Tax (Line 6)', outputVAT)}
        ${returnLine('16','Less: Total Input Tax (Line 14)', totalInput)}
        <div class="return-line" style="background:${vatPayable>0?'#fef2f2':'#f0fdf4'};">
          <div class="return-line-num" style="background:${vatPayable>0?'#fca5a5':'#86efac'};color:white;border:none;">17</div>
          <div class="return-line-label" style="font-weight:700;">
            ${vatPayable>0 ? '⚠️ VAT PAYABLE' : '✅ EXCESS INPUT VAT (Refundable/Creditable)'}
          </div>
          <div class="return-line-amt ${vatPayable>0?'payable highlight':'refund highlight'}">
            ₱ ${fmt(vatPayable>0 ? vatPayable : vatRefundable)}
          </div>
        </div>
      </div>

      <div class="alert alert-info no-print" style="margin-top:12px;">
        ℹ️ Figures computed from Manager.io invoices matched by your VAT mapping. Verify before filing.
        ${!vm.sales_taxable ? '<br>⚠️ <strong>VAT mapping is incomplete.</strong> Go to Setup → VAT Mapping.' : ''}
      </div>
    `;

    // Show print/PDF buttons
    document.getElementById('vat-print').style.display = '';
    document.getElementById('vat-pdf').style.display   = '';

    // Show print header on print
    document.querySelectorAll('.print-header').forEach(el => {
      el.style.display = 'block';
    });

  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}
