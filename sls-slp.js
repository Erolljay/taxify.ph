/* ============================================================
   Tallo CPA – BIR Tax App for Manager.io
   sls-slp.js  –  Summary List of Sales (SLS) & Summary List of Purchases (SLP)
                  with DAT download and Excel export
   ============================================================ */

// ── SLS ENTRY ────────────────────────────────────────────────
function renderSLS(el) {
  renderSummaryList(el, 'sls');
}

// ── SLP ENTRY ────────────────────────────────────────────────
function renderSLP(el) {
  renderSummaryList(el, 'slp');
}

// ── SHARED RENDER ─────────────────────────────────────────────
async function renderSummaryList(el, type) {
  const isSLS = type === 'sls';
  const title = isSLS ? 'Summary List of Sales (SLS)' : 'Summary List of Purchases (SLP)';

  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Loading…</span></div>`;
  const setup = await loadSetup(App.currentBusiness);

  if (!setup) {
    el.innerHTML = `<div class="setup-required">
      <span>⚠️</span>
      <div><strong>Business info not configured yet.</strong><br>Fill in the Business tab first.</div>
    </div>`;
    return;
  }

  const now  = new Date();
  const curQ = Math.ceil((now.getMonth() + 1) / 3);
  const curY = now.getFullYear();

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📊 ${title}</div>
        <div class="page-subtitle">${escHtml(App.currentBusiness)}</div>
      </div>
    </div>

    <div class="filter-bar">
      <label>Period</label>
      <select id="sl-period-type">
        <option value="quarterly">Quarterly</option>
        <option value="monthly">Monthly</option>
      </select>

      <div id="sl-month-wrap" style="display:none;">
        <label>Month</label>
        <select id="sl-month">
          ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m =>
            `<option value="${m}" ${m === now.getMonth() ? 'selected':''}>${monthName(m)}</option>`
          ).join('')}
        </select>
      </div>

      <div id="sl-quarter-wrap">
        <label>Quarter</label>
        <select id="sl-quarter">
          ${[1,2,3,4].map(q =>
            `<option value="${q}" ${q === curQ ? 'selected':''}>${quarterLabel(q)}</option>`
          ).join('')}
        </select>
      </div>

      <label>Year</label>
      <select id="sl-year">
        ${[curY-2, curY-1, curY, curY+1].map(y =>
          `<option value="${y}" ${y === curY ? 'selected':''}>${y}</option>`
        ).join('')}
      </select>

      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="btn-gen-sl">⚡ Generate</button>
      <button class="btn btn-outline" id="btn-excel-sl" style="display:none;">📥 Excel</button>
      <button class="btn btn-outline" id="btn-dat-sl" style="display:none;">📄 DAT File</button>
    </div>

    <div id="sl-output"></div>
  `;

  // Period type toggle
  document.getElementById('sl-period-type').addEventListener('change', function() {
    const isM = this.value === 'monthly';
    document.getElementById('sl-month-wrap').style.display  = isM ? '' : 'none';
    document.getElementById('sl-quarter-wrap').style.display = isM ? 'none' : '';
  });

  document.getElementById('btn-gen-sl').addEventListener('click', () => generateSL(type));
}

// ── GENERATE ─────────────────────────────────────────────────
async function generateSL(type) {
  const isSLS  = type === 'sls';
  const output = document.getElementById('sl-output');
  output.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;

  const periodType = document.getElementById('sl-period-type').value;
  const year = parseInt(document.getElementById('sl-year').value, 10);
  let period;
  if (periodType === 'monthly') {
    period = parseInt(document.getElementById('sl-month').value, 10);
  } else {
    period = parseInt(document.getElementById('sl-quarter').value, 10);
  }

  const { start, end } = getPeriodDates(periodType, period, year);
  const setup = await loadSetup(App.currentBusiness);
  const vm    = setup?.vatMapping || {};

  try {
    const rows = isSLS
      ? await buildSLSRows(start, end, vm, setup)
      : await buildSLPRows(start, end, vm, setup);

    const periodLabel = periodType === 'monthly'
      ? `${monthName(period)} ${year}`
      : `${quarterLabel(period)} ${year}`;

    renderSLTable(output, rows, type, periodLabel);

    // Wire export buttons
    const excelBtn = document.getElementById('btn-excel-sl');
    const datBtn   = document.getElementById('btn-dat-sl');
    excelBtn.style.display = '';
    datBtn.style.display   = '';
    excelBtn.onclick = () => exportSLExcel(rows, type, periodLabel, setup);
    datBtn.onclick   = () => exportSLDat(rows, type, periodLabel, setup);

  } catch (err) {
    output.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ── BUILD SLS ROWS ────────────────────────────────────────────
async function buildSLSRows(start, end, vm, setup) {
  const [invItems, receiptItems, custData] = await Promise.all([
    fetchAllBatch('/api4/sales-invoice-batch', App.currentBusiness),
    fetchAllBatch('/api4/receipt-batch', App.currentBusiness),
    loadPartyBIR(App.currentBusiness, 'customer'),
  ]);
  // Include receipts so cash-sale workflows (no sales invoice) are captured too
  const items = [...invItems, ...receiptItems.filter(({ item }) => (item?.Lines || []).some(l => l?.TaxCode))];
  // setup.vatMapping uses flat keys (sales_taxable, sales_zero, sales_exempt, ...)
  // mapping to Manager tax code keys — same shape as used by 2550Q.
  const rows     = [];

  for (const { key: invKey, item } of items) {
    if (!inRange(item?.Date, start, end)) continue;

    const custKey = item?.Customer || '';
    const cust    = custData[custKey] || {};
    const custName = cust.type === 'Individual'
      ? [cust.lastName, cust.firstName, cust.middleName].filter(Boolean).join(', ')
      : (cust.corpName || item?.CustomerName || custKey);

    let taxableSales = 0, zeroRated = 0, exempt = 0, outputVAT = 0;

    for (const line of (item?.Lines || [])) {
      const tc  = line?.TaxCode?.key || line?.TaxCode || line?.taxCode || '';
      const amt = Math.abs(Number(line?.Amount || 0));
      const tax = Math.abs(Number(line?.Tax || 0));

      if (vm.sales_taxable && tc === vm.sales_taxable) {
        taxableSales += amt;
        outputVAT    += tax || (amt * 0.12);
      } else if (vm.sales_zero && tc === vm.sales_zero) {
        zeroRated += amt;
      } else if (vm.sales_exempt && tc === vm.sales_exempt) {
        exempt += amt;
      }
    }

    const totalAmt = taxableSales + zeroRated + exempt;
    if (totalAmt === 0) continue;

    rows.push({
      date:        item.Date,
      reference:   item.Reference || item.InvoiceNumber || '',
      buyerName:   custName,
      buyerTIN:    cust.tin || '',
      buyerAddr:   [cust.address1, cust.address2].filter(Boolean).join(', '),
      buyerType:   cust.type || 'Non-Individual',
      taxable:     taxableSales,
      zeroRated,
      exempt,
      outputVAT,
      totalAmt,
    });
  }

  // Sort by date
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return rows;
}

// ── BUILD SLP ROWS ────────────────────────────────────────────
async function buildSLPRows(start, end, vm, setup) {
  const [invItems, paymentItems, suppData] = await Promise.all([
    fetchAllBatch('/api4/purchase-invoice-batch', App.currentBusiness),
    fetchAllBatch('/api4/payment-batch', App.currentBusiness),
    loadPartyBIR(App.currentBusiness, 'supplier'),
  ]);
  // Include payments so cash-purchase/expense workflows (no purchase invoice) are captured too
  const items = [...invItems, ...paymentItems.filter(({ item }) => (item?.Lines || []).some(l => l?.TaxCode))];
  const rows     = [];

  for (const { key: invKey, item } of items) {
    if (!inRange(item?.Date, start, end)) continue;

    const suppKey  = item?.Supplier || '';
    const supp     = suppData[suppKey] || {};
    const suppName = supp.type === 'Individual'
      ? [supp.lastName, supp.firstName, supp.middleName].filter(Boolean).join(', ')
      : (supp.corpName || item?.SupplierName || suppKey);

    let capitalGoods = 0, otherGoods = 0, services = 0, zeroRated = 0, exempt = 0, inputVAT = 0;

    for (const line of (item?.Lines || [])) {
      const tc  = line?.TaxCode?.key || line?.TaxCode || line?.taxCode || '';
      const amt = Math.abs(Number(line?.Amount || 0));
      const tax = Math.abs(Number(line?.Tax || 0));

      if (vm.purch_capital && tc === vm.purch_capital) {
        capitalGoods += amt;
        inputVAT     += tax || (amt * 0.12);
      } else if (vm.purch_other && tc === vm.purch_other) {
        otherGoods += amt;
        inputVAT   += tax || (amt * 0.12);
      } else if (vm.purch_services && tc === vm.purch_services) {
        services += amt;
        inputVAT += tax || (amt * 0.12);
      } else if (vm.purch_zero && tc === vm.purch_zero) {
        zeroRated += amt;
      } else if (vm.purch_exempt && tc === vm.purch_exempt) {
        exempt += amt;
      }
    }

    const totalAmt = capitalGoods + otherGoods + services + zeroRated + exempt;
    if (totalAmt === 0) continue;

    rows.push({
      date:        item.Date,
      reference:   item.Reference || item.InvoiceNumber || '',
      sellerName:  suppName,
      sellerTIN:   supp.tin || '',
      sellerAddr:  [supp.address1, supp.address2].filter(Boolean).join(', '),
      sellerType:  supp.type || 'Non-Individual',
      capitalGoods,
      otherGoods,
      services,
      zeroRated,
      exempt,
      inputVAT,
      totalAmt: capitalGoods + otherGoods + services + zeroRated + exempt,
    });
  }

  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return rows;
}

// ── RENDER TABLE ──────────────────────────────────────────────
function renderSLTable(el, rows, type, periodLabel) {
  const isSLS = type === 'sls';

  if (rows.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">📭</div>
      <h3>No Transactions Found</h3>
      <p>No ${isSLS ? 'sales' : 'purchase'} invoices matched the VAT tax codes in your mapping for this period.</p>
    </div>`;
    return;
  }

  // Totals
  const tot = rows.reduce((acc, r) => {
    if (isSLS) {
      acc.taxable   += r.taxable;
      acc.zeroRated += r.zeroRated;
      acc.exempt    += r.exempt;
      acc.vat       += r.outputVAT;
      acc.total     += r.totalAmt;
    } else {
      acc.capitalGoods += r.capitalGoods;
      acc.otherGoods   += r.otherGoods;
      acc.services     += r.services;
      acc.zeroRated    += r.zeroRated;
      acc.exempt       += r.exempt;
      acc.vat          += r.inputVAT;
      acc.total        += r.totalAmt;
    }
    return acc;
  }, { taxable:0, zeroRated:0, exempt:0, vat:0, total:0, capitalGoods:0, otherGoods:0, services:0 });

  // Stats row
  const statsHtml = isSLS ? `
    <div class="stats-row" style="margin-bottom:16px;">
      <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Taxable Sales</div><div class="stat-value small">₱ ${fmt(tot.taxable)}</div></div>
      <div class="stat-card"><div class="stat-label">Zero-Rated</div><div class="stat-value small">₱ ${fmt(tot.zeroRated)}</div></div>
      <div class="stat-card"><div class="stat-label">Output VAT</div><div class="stat-value small">₱ ${fmt(tot.vat)}</div></div>
    </div>` : `
    <div class="stats-row" style="margin-bottom:16px;">
      <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Capital Goods</div><div class="stat-value small">₱ ${fmt(tot.capitalGoods)}</div></div>
      <div class="stat-card"><div class="stat-label">Other Goods</div><div class="stat-value small">₱ ${fmt(tot.otherGoods)}</div></div>
      <div class="stat-card"><div class="stat-label">Input VAT</div><div class="stat-value small">₱ ${fmt(tot.vat)}</div></div>
    </div>`;

  const slsHeaders = `<th>Date</th><th>Invoice No.</th><th>Buyer Name</th><th>TIN</th>
    <th class="num">Taxable</th><th class="num">Zero-Rated</th><th class="num">Exempt</th><th class="num">Output VAT</th>`;

  const slpHeaders = `<th>Date</th><th>Invoice No.</th><th>Seller Name</th><th>TIN</th>
    <th class="num">Capital Goods</th><th class="num">Other Goods</th><th class="num">Services</th>
    <th class="num">Zero-Rated</th><th class="num">Exempt</th><th class="num">Input VAT</th>`;

  const slsRow = r => `<tr>
    <td>${fmtDate(r.date)}</td>
    <td>${escHtml(r.reference)}</td>
    <td>${escHtml(r.buyerName)}</td>
    <td style="font-family:monospace;">${escHtml(r.buyerTIN)}</td>
    <td class="num">${fmt(r.taxable)}</td>
    <td class="num">${fmt(r.zeroRated)}</td>
    <td class="num">${fmt(r.exempt)}</td>
    <td class="num">${fmt(r.outputVAT)}</td>
  </tr>`;

  const slpRow = r => `<tr>
    <td>${fmtDate(r.date)}</td>
    <td>${escHtml(r.reference)}</td>
    <td>${escHtml(r.sellerName)}</td>
    <td style="font-family:monospace;">${escHtml(r.sellerTIN)}</td>
    <td class="num">${fmt(r.capitalGoods)}</td>
    <td class="num">${fmt(r.otherGoods)}</td>
    <td class="num">${fmt(r.services)}</td>
    <td class="num">${fmt(r.zeroRated)}</td>
    <td class="num">${fmt(r.exempt)}</td>
    <td class="num">${fmt(r.inputVAT)}</td>
  </tr>`;

  const slsFooter = `<td colspan="4" style="font-weight:700;">TOTALS</td>
    <td class="num">${fmt(tot.taxable)}</td><td class="num">${fmt(tot.zeroRated)}</td>
    <td class="num">${fmt(tot.exempt)}</td><td class="num">${fmt(tot.vat)}</td>`;

  const slpFooter = `<td colspan="4" style="font-weight:700;">TOTALS</td>
    <td class="num">${fmt(tot.capitalGoods)}</td><td class="num">${fmt(tot.otherGoods)}</td>
    <td class="num">${fmt(tot.services)}</td>
    <td class="num">${fmt(tot.zeroRated)}</td><td class="num">${fmt(tot.exempt)}</td>
    <td class="num">${fmt(tot.vat)}</td>`;

  el.innerHTML = `
    ${statsHtml}
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr>${isSLS ? slsHeaders : slpHeaders}</tr></thead>
        <tbody>${rows.map(r => isSLS ? slsRow(r) : slpRow(r)).join('')}</tbody>
        <tfoot><tr>${isSLS ? slsFooter : slpFooter}</tr></tfoot>
      </table>
    </div>
  `;
}

// ── EXPORT: EXCEL ─────────────────────────────────────────────
function exportSLExcel(rows, type, periodLabel, setup) {
  if (!window.XLSX) {
    showToast('⚠ Loading Excel library…');
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => exportSLExcel(rows, type, periodLabel, setup);
    document.head.appendChild(s);
    return;
  }

  const isSLS = type === 'sls';
  const title = isSLS ? 'Summary List of Sales' : 'Summary List of Purchases';

  // Header rows
  const sheetData = [
    [title],
    [`Period: ${periodLabel}`],
    [`Taxpayer: ${setup.taxpayerName || App.currentBusiness}  |  TIN: ${setup.tin || ''}  |  RDO: ${setup.rdoCode || ''}`],
    [],
  ];

  if (isSLS) {
    sheetData.push(['Date','Invoice No.','Buyer Name','TIN','Buyer Address','Taxable Sales','Zero-Rated','Exempt','Output VAT','Total']);
    rows.forEach(r => sheetData.push([
      r.date, r.reference, r.buyerName, r.buyerTIN, r.buyerAddr,
      r.taxable, r.zeroRated, r.exempt, r.outputVAT, r.totalAmt,
    ]));
    const tot = rows.reduce((a,r) => ({
      taxable: a.taxable+r.taxable, zeroRated: a.zeroRated+r.zeroRated,
      exempt: a.exempt+r.exempt, vat: a.vat+r.outputVAT, total: a.total+r.totalAmt
    }), {taxable:0,zeroRated:0,exempt:0,vat:0,total:0});
    sheetData.push(['','','','','TOTALS', tot.taxable, tot.zeroRated, tot.exempt, tot.vat, tot.total]);
  } else {
    sheetData.push(['Date','Invoice No.','Seller Name','TIN','Seller Address','Capital Goods','Other Goods','Services','Zero-Rated','Exempt','Input VAT','Total']);
    rows.forEach(r => sheetData.push([
      r.date, r.reference, r.sellerName, r.sellerTIN, r.sellerAddr,
      r.capitalGoods, r.otherGoods, r.services, r.zeroRated, r.exempt, r.inputVAT, r.totalAmt,
    ]));
    const tot = rows.reduce((a,r) => ({
      cg: a.cg+r.capitalGoods, og: a.og+r.otherGoods, sv: a.sv+r.services,
      zr: a.zr+r.zeroRated, ex: a.ex+r.exempt, vat: a.vat+r.inputVAT, total: a.total+r.totalAmt
    }), {cg:0,og:0,sv:0,zr:0,ex:0,vat:0,total:0});
    sheetData.push(['','','','','TOTALS', tot.cg, tot.og, tot.sv, tot.zr, tot.ex, tot.vat, tot.total]);
  }

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, isSLS ? 'SLS' : 'SLP');
  XLSX.writeFile(wb, `${type.toUpperCase()}_${periodLabel.replace(/[\s()–\/]/g,'_')}.xlsx`);
}

// ── EXPORT: BIR DAT FILE ──────────────────────────────────────
function exportSLDat(rows, type, periodLabel, setup) {
  const isSLS = type === 'sls';
  const tin   = (setup.tin || '000-000-000-000').replace(/-/g, '');
  const name  = (setup.taxpayerName || App.currentBusiness).replace(/,/g, '').toUpperCase().padEnd(50).substring(0, 50);

  // BIR DAT format: pipe-delimited
  // SLS fields: TaxpayerTIN|TaxpayerName|BuyerTIN|BuyerName|InvoiceDate|InvoiceNo|TaxableAmt|ZeroRated|Exempt|OutputVAT
  // SLP fields: TaxpayerTIN|TaxpayerName|SellerTIN|SellerName|InvoiceDate|InvoiceNo|CapGoods|OtherGoods|Services|ZeroRated|Exempt|InputVAT

  const lines = [];
  // BIR's SLS/SLP validation app rejects commas in header/taxpayer-info fields
  const noComma = s => (s || '').replace(/,/g, '');

  if (isSLS) {
    for (const r of rows) {
      const buyTIN  = (r.buyerTIN || '').replace(/-/g, '').padEnd(12).substring(0, 12);
      const buyName = noComma(r.buyerName).toUpperCase().padEnd(50).substring(0, 50);
      const invDate = r.date ? r.date.substring(0, 10).replace(/-/g, '/') : '';
      const invNo   = (r.reference || '').padEnd(30).substring(0, 30);
      lines.push([
        tin, name.trim(), buyTIN, buyName.trim(),
        invDate, invNo.trim(),
        r.taxable.toFixed(2), r.zeroRated.toFixed(2),
        r.exempt.toFixed(2), r.outputVAT.toFixed(2),
      ].join('|'));
    }
  } else {
    for (const r of rows) {
      const selTIN  = (r.sellerTIN || '').replace(/-/g, '').padEnd(12).substring(0, 12);
      const selName = noComma(r.sellerName).toUpperCase().padEnd(50).substring(0, 50);
      const invDate = r.date ? r.date.substring(0, 10).replace(/-/g, '/') : '';
      const invNo   = (r.reference || '').padEnd(30).substring(0, 30);
      lines.push([
        tin, name.trim(), selTIN, selName.trim(),
        invDate, invNo.trim(),
        r.capitalGoods.toFixed(2), r.otherGoods.toFixed(2),
        r.services.toFixed(2), r.zeroRated.toFixed(2),
        r.exempt.toFixed(2), r.inputVAT.toFixed(2),
      ].join('|'));
    }
  }

  const content  = lines.join('\r\n');
  const blob     = new Blob([content], { type: 'text/plain' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = `${type.toUpperCase()}_${periodLabel.replace(/[\s()–\/]/g,'_')}.dat`;
  a.click();
  URL.revokeObjectURL(url);
}
