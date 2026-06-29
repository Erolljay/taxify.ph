/* ============================================================
   Tallo CPA – BIR Tax App
   sls-report.js  –  Summary List of Sales and Purchases
                     with DAT download and Excel export
   ============================================================ */

let _slRows = [];

async function initSLReport(type) {
  const filterEl = document.getElementById('filter-area');
  const outputEl = document.getElementById('report-output');
  const isSLS    = type === 'sls';

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

  if (!setup) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Business info not configured. Fill in the <strong>Business</strong> tab in the Tallo CPA extension first.</div>`;
    return;
  }
  outputEl.innerHTML = '';

  const now  = new Date();
  const curQ = Math.ceil((now.getMonth() + 1) / 3);
  const curY = now.getFullYear();
  const years = [curY - 2, curY - 1, curY, curY + 1];

  filterEl.innerHTML = `
    <div class="filter-bar">
      <label>Period</label>
      <select id="sl-ptype">
        <option value="quarterly">Quarterly</option>
        <option value="monthly">Monthly</option>
        <option value="annual">Annual</option>
      </select>
      <span id="sl-qwrap">
        <label>Quarter</label>
        <select id="sl-quarter">
          ${[1,2,3,4].map(q=>`<option value="${q}"${q===curQ?' selected':''}>${quarterLabel(q)}</option>`).join('')}
        </select>
      </span>
      <span id="sl-mwrap" style="display:none;">
        <label>Month</label>
        <select id="sl-month">
          ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m=>`<option value="${m}"${m===now.getMonth()?' selected':''}>${monthName(m)}</option>`).join('')}
        </select>
      </span>
      <label>Year</label>
      <select id="sl-year">
        ${years.map(y=>`<option value="${y}"${y===curY?' selected':''}>${y}</option>`).join('')}
      </select>
      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="sl-gen">⚡ Generate</button>
      <button class="btn btn-outline"  id="sl-excel" style="display:none;">📥 Excel</button>
      <button class="btn btn-outline"  id="sl-dat"   style="display:none;">📄 DAT File</button>
      <button class="btn btn-outline"  id="sl-print" style="display:none;" onclick="window.print()">🖨 Print</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin||'—')}</strong>
    </div>`;

  document.getElementById('sl-ptype').addEventListener('change', function () {
    const isM = this.value === 'monthly';
    const isA = this.value === 'annual';
    document.getElementById('sl-qwrap').style.display = isM || isA ? 'none' : '';
    document.getElementById('sl-mwrap').style.display = isM ? '' : 'none';
  });

  document.getElementById('sl-gen').addEventListener('click', () => generateSL(type, biz, setup, outputEl));

  // Customers/Suppliers quick-edit tab
  const partyType = isSLS ? 'customer' : 'supplier';
  const partyTab  = isSLS ? 'customers' : 'suppliers';
  let partyController = null;
  document.getElementById('sl-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn'); if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('#sl-tabs .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === partyTab) {
      const container = document.getElementById(`tab-${partyTab}`);
      if (!partyController) partyController = CF.mountParty(container, partyType);
      partyController.refresh().then(() => filterPartyTabToPeriod(container));
    }
  });
}

// Hide rows for customers/suppliers that have no transactions in the
// currently-generated SLS/SLP period, so the tab only shows the
// parties relevant to that period's report.
function filterPartyTabToPeriod(container) {
  if (!_slRows.length) return;
  const keys = new Set();
  _slRows.forEach(r => (r.partyKeys || [r.partyKey]).forEach(k => k && keys.add(k)));
  if (!keys.size) return;
  let shown = 0, total = 0;
  container.querySelectorAll('tbody tr[data-key]').forEach(tr => {
    total++;
    const visible = keys.has(tr.dataset.key);
    tr.style.display = visible ? '' : 'none';
    if (visible) shown++;
  });
  const countEl = container.querySelector('[id$="-count"]');
  if (countEl) countEl.textContent = `${shown} of ${total} records have transactions in the selected period`;
}

async function generateSL(type, biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;
  const isSLS = type === 'sls';
  const ptypeEl = document.getElementById('sl-ptype');
  const ptype   = ptypeEl ? ptypeEl.value : 'quarterly';
  const year    = parseInt(document.getElementById('sl-year').value, 10);
  const period  = ptype === 'monthly'
    ? parseInt(document.getElementById('sl-month').value, 10)
    : ptype === 'annual' ? null
    : parseInt(document.getElementById('sl-quarter').value, 10);

  const { start, end } = getPeriodDates(ptype, period, year);
  const { vm, rateByKey } = await getVatMapping(biz);

  try {
    const rows = isSLS
      ? await buildSLSRows(biz, start, end, vm, rateByKey)
      : await buildSLPRows(biz, start, end, vm, rateByKey);

    _slRows = rows;

    const periodLabel = ptype === 'monthly' ? `${monthName(period)} ${year}`
      : ptype === 'annual' ? `${year}`
      : `${quarterLabel(period)} ${year}`;

    renderSLTable(outputEl, rows, type, periodLabel, setup);

    ['sl-excel','sl-dat','sl-print'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });

    document.getElementById('sl-excel').onclick = () => exportExcel(rows, type, periodLabel, setup, end);
    document.getElementById('sl-dat').onclick   = () => {
      if (ptype === 'monthly') { exportDAT(rows, type, setup, end); return; }
      // BIR RELIEF/eSubmission DAT files are filed per month, so a quarterly
      // or annual view must produce one DAT file per month covered rather
      // than a single file spanning multiple months.
      const byMonth = new Map();
      rows.forEach(r => {
        if (!byMonth.has(r.monthKey)) byMonth.set(r.monthKey, []);
        byMonth.get(r.monthKey).push(r);
      });
      [...byMonth.keys()].sort().forEach(mk => {
        exportDAT(byMonth.get(mk), type, setup, monthKeyToEndDate(mk));
      });
    };

  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ── BUILD ROWS ────────────────────────────────────────────────
// Manager's API returns line items under either `Lines` or `lines`.
function getLines(item) {
  return item?.Lines || item?.lines || [];
}
function getLineTaxCodeKey(line) {
  const tc = line?.taxCode ?? line?.TaxCode ?? '';
  return (tc && typeof tc === 'object') ? (tc.key || tc.Key || '') : (tc || '');
}

// Month-bucket key for "per party per month" aggregation, e.g. "2026-06"
function monthKey(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

// Last calendar day of a "YYYY-MM" month key, e.g. "2026-06" -> Date(2026-06-30)
function monthKeyToEndDate(mk) {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m, 0);
}

// Format a Date using its LOCAL calendar fields (toISOString() converts to UTC,
// which shifts the date backward a day in positive-UTC-offset timezones like PH).
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function buildSLSRows(biz, start, end, vm, rateByKey) {
  const [invItems, receiptItems, custMap] = await Promise.all([
    fetchAllBatch('/api4/sales-invoice-batch', biz),
    fetchAllBatch('/api4/receipt-batch', biz),
    loadPartyBIR(biz, 'customer'),
  ]);
  // Include cash-sale receipts that carry a VAT tax code directly on their lines
  const items = [...invItems, ...receiptItems.filter(({ item }) => getLines(item).some(l => getLineTaxCodeKey(l)))];
  const groups = new Map(); // key: partyKey|monthKey

  for (const { key: invKey, item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const ck   = item?.customer || item?.Customer || '';
    const cd   = custMap[ck] || {};
    const name = cd.companyName || [cd.lastName, cd.firstName, cd.middleName].filter(Boolean).join(', ') || item?.CustomerName || cd.name || ck;

    let taxable = 0, zeroRated = 0, exempt = 0, outputVAT = 0;
    for (const line of getLines(item)) {
      const tc = getLineTaxCodeKey(line);
      if (!tc) continue;
      const { net, tax } = lineAmounts(item, line, rateByKey);
      if (tc === vm.sales_taxable)      { taxable   += net; outputVAT += tax; }
      else if (tc === vm.sales_zero)    { zeroRated += net; }
      else if (tc === vm.sales_exempt)  { exempt    += net; }
    }
    if (taxable + zeroRated + exempt === 0) continue;

    const mk = monthKey(date);
    // Two Manager contacts sharing the same TIN are the same taxpayer for BIR
    // reporting purposes — combine them under one SLS row. Falls back to the
    // Manager party key when TIN is blank, so untagged contacts still group
    // correctly (and don't all collapse into a single blank-TIN bucket).
    const normTin = (cd.tin || '').replace(/\D/g, '');
    const gk = `${normTin || 'k:' + ck}|${mk}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        date: localDateStr(monthKeyToEndDate(mk)), monthKey: mk, reference: '', txnCount: 0,
        partyKey: ck,
        name, tin: cd.tin || '', address: [cd.address1, cd.address2].filter(Boolean).join(', '),
        companyName: cd.companyName || '', lastName: cd.lastName || '', firstName: cd.firstName || '', middleName: cd.middleName || '',
        address1: cd.address1 || '', address2: cd.address2 || '',
        partyKeys: new Set(),
        taxable: 0, zeroRated: 0, exempt: 0, outputVAT: 0, total: 0,
      };
      groups.set(gk, g);
    }
    g.partyKeys.add(ck);
    g.taxable   += taxable;
    g.zeroRated += zeroRated;
    g.exempt    += exempt;
    g.outputVAT += outputVAT;
    g.total     += taxable + zeroRated + exempt;
    g.txnCount++;
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

async function buildSLPRows(biz, start, end, vm, rateByKey) {
  const [invItems, paymentItems, suppMap] = await Promise.all([
    fetchAllBatch('/api4/purchase-invoice-batch', biz),
    fetchAllBatch('/api4/payment-batch', biz),
    loadPartyBIR(biz, 'supplier'),
  ]);
  // Include cash-purchase/expense payments that carry a VAT tax code directly on their lines
  const items = [...invItems, ...paymentItems.filter(({ item }) => getLines(item).some(l => getLineTaxCodeKey(l)))];
  const groups = new Map(); // key: partyKey|monthKey

  for (const { key: invKey, item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const sk   = item?.supplier || item?.Supplier || '';
    const sd   = suppMap[sk] || {};
    const name = sd.companyName || [sd.lastName, sd.firstName, sd.middleName].filter(Boolean).join(', ') || item?.SupplierName || sd.name || sk;

    let capGoods = 0, otherGoods = 0, services = 0, zeroRated = 0, exempt = 0, inputVAT = 0;
    for (const line of getLines(item)) {
      const tc = getLineTaxCodeKey(line);
      if (!tc) continue;
      const { net, tax } = lineAmounts(item, line, rateByKey);
      if (tc === vm.purch_capital)      { capGoods   += net; inputVAT += tax; }
      else if (tc === vm.purch_other)   { otherGoods += net; inputVAT += tax; }
      else if (tc === vm.purch_services){ services   += net; inputVAT += tax; }
      else if (tc === vm.purch_zero)    { zeroRated  += net; }
      else if (tc === vm.purch_exempt)  { exempt     += net; }
    }
    if (capGoods + otherGoods + services + zeroRated + exempt === 0) continue;

    const mk = monthKey(date);
    // Combine suppliers sharing the same TIN into one SLP row (see SLS above).
    const normTin = (sd.tin || '').replace(/\D/g, '');
    const gk = `${normTin || 'k:' + sk}|${mk}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        date: localDateStr(monthKeyToEndDate(mk)), monthKey: mk, reference: '', txnCount: 0,
        partyKey: sk,
        name, tin: sd.tin || '', address: [sd.address1, sd.address2].filter(Boolean).join(', '),
        companyName: sd.companyName || '', lastName: sd.lastName || '', firstName: sd.firstName || '', middleName: sd.middleName || '',
        address1: sd.address1 || '', address2: sd.address2 || '',
        partyKeys: new Set(),
        capGoods: 0, otherGoods: 0, services: 0, zeroRated: 0, exempt: 0, inputVAT: 0, total: 0,
      };
      groups.set(gk, g);
    }
    g.partyKeys.add(sk);
    g.capGoods   += capGoods;
    g.otherGoods += otherGoods;
    g.services   += services;
    g.zeroRated  += zeroRated;
    g.exempt     += exempt;
    g.inputVAT   += inputVAT;
    g.total      += capGoods + otherGoods + services + zeroRated + exempt;
    g.txnCount++;
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

// ── RENDER TABLE ──────────────────────────────────────────────
function renderSLTable(el, rows, type, periodLabel, setup) {
  const isSLS = type === 'sls';
  if (rows.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">📭</div><h3>No Transactions Found</h3>
      <p>No ${isSLS?'sales':'purchase'} invoices matched your VAT mapping for this period.</p></div>`;
    return;
  }

  const tot = rows.reduce((a, r) => {
    if (isSLS) return { ...a, taxable: a.taxable+r.taxable, zeroRated: a.zeroRated+r.zeroRated, exempt: a.exempt+r.exempt, vat: a.vat+r.outputVAT };
    return { ...a, cap: a.cap+r.capGoods, other: a.other+r.otherGoods, svc: a.svc+r.services, zr: a.zr+r.zeroRated, ex: a.ex+r.exempt, vat: a.vat+r.inputVAT };
  }, { taxable:0, zeroRated:0, exempt:0, vat:0, cap:0, other:0, svc:0, zr:0, ex:0 });

  const slsHead = `<th>Month</th><th class="num">Txns</th><th>Buyer Name</th><th>TIN</th>
    <th class="num">Taxable</th><th class="num">Zero-Rated</th><th class="num">Exempt</th><th class="num">Output VAT</th>`;
  const slpHead = `<th>Month</th><th class="num">Txns</th><th>Seller Name</th><th>TIN</th>
    <th class="num">Capital Goods</th><th class="num">Other Goods</th><th class="num">Services</th>
    <th class="num">Zero-Rated</th><th class="num">Exempt</th><th class="num">Input VAT</th>`;

  const slsRow = r => `<tr>
    <td>${monthName(parseInt(r.monthKey.split('-')[1],10)-1)} ${r.monthKey.split('-')[0]}</td>
    <td class="num">${r.txnCount}</td><td>${escHtml(r.name)}</td>
    <td style="font-family:monospace;">${escHtml(r.tin)}</td>
    <td class="num">${fmt(r.taxable)}</td><td class="num">${fmt(r.zeroRated)}</td>
    <td class="num">${fmt(r.exempt)}</td><td class="num">${fmt(r.outputVAT)}</td></tr>`;

  const slpRow = r => `<tr>
    <td>${monthName(parseInt(r.monthKey.split('-')[1],10)-1)} ${r.monthKey.split('-')[0]}</td>
    <td class="num">${r.txnCount}</td><td>${escHtml(r.name)}</td>
    <td style="font-family:monospace;">${escHtml(r.tin)}</td>
    <td class="num">${fmt(r.capGoods)}</td><td class="num">${fmt(r.otherGoods)}</td>
    <td class="num">${fmt(r.services)}</td><td class="num">${fmt(r.zeroRated)}</td>
    <td class="num">${fmt(r.exempt)}</td><td class="num">${fmt(r.inputVAT)}</td></tr>`;

  const slsFoot = `<td colspan="4" style="font-weight:700;">TOTALS</td>
    <td class="num">${fmt(tot.taxable)}</td><td class="num">${fmt(tot.zeroRated)}</td>
    <td class="num">${fmt(tot.exempt)}</td><td class="num">${fmt(tot.vat)}</td>`;
  const slpFoot = `<td colspan="4" style="font-weight:700;">TOTALS</td>
    <td class="num">${fmt(tot.cap)}</td><td class="num">${fmt(tot.other)}</td>
    <td class="num">${fmt(tot.svc)}</td><td class="num">${fmt(tot.zr)}</td>
    <td class="num">${fmt(tot.ex)}</td><td class="num">${fmt(tot.vat)}</td>`;

  el.innerHTML = `
    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">${rows.length}</div></div>
      ${isSLS
        ? `<div class="stat-card"><div class="stat-label">Taxable Sales</div><div class="stat-value small">₱ ${fmt(tot.taxable)}</div></div>
           <div class="stat-card"><div class="stat-label">Output VAT</div><div class="stat-value small">₱ ${fmt(tot.vat)}</div></div>`
        : `<div class="stat-card"><div class="stat-label">Capital Goods</div><div class="stat-value small">₱ ${fmt(tot.cap)}</div></div>
           <div class="stat-card"><div class="stat-label">Input VAT</div><div class="stat-value small">₱ ${fmt(tot.vat)}</div></div>`}
    </div>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr>${isSLS ? slsHead : slpHead}</tr></thead>
        <tbody>${rows.map(r => isSLS ? slsRow(r) : slpRow(r)).join('')}</tbody>
        <tfoot><tr>${isSLS ? slsFoot : slpFoot}</tr></tfoot>
      </table>
    </div>`;
}

// ── EXPORT EXCEL ──────────────────────────────────────────────
function tinDashed(t) {
  const d = (t || '').replace(/\D/g, '').padEnd(9, '0').substring(0, 9);
  return `${d.substring(0,3)}-${d.substring(3,6)}-${d.substring(6,9)}`;
}

function partyNameCols(r) {
  const isInd = !r.companyName && (r.lastName || r.firstName || r.middleName);
  if (isInd) {
    const full = [r.lastName, [r.firstName, r.middleName].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return ['', full];
  }
  return [r.companyName || r.name || '', ''];
}

function exportExcel(rows, type, periodLabel, setup, periodEnd) {
  if (!window.XLSX) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => exportExcel(rows, type, periodLabel, setup, periodEnd);
    document.head.appendChild(s); return;
  }
  const isSLS = type === 'sls';
  const ownerIsInd = setup.classification === 'Individual';
  const ownerName = ownerIsInd
    ? [setup.lastName, [setup.firstName, setup.middleName].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '');
  const monthDate = periodEnd ? new Date(periodEnd) : null; // fallback only; rows carry their own monthKey

  const data = [
    [isSLS ? 'SALES TRANSACTION' : 'PURCHASE TRANSACTION'],
    ['RECONCILIATION OF LISTING FOR ENFORCEMENT'],
    [], [], [],
    [`TIN : ${tinDashed(setup.tin)}`],
    [`OWNER'S NAME: ${ownerName.toUpperCase()}`],
    [`OWNER'S TRADE NAME : ${(setup.companyName || setup.taxpayerName || '').toUpperCase()}`],
    [`OWNER'S ADDRESS: ${(setup.address || '').toUpperCase()}${setup.zipCode ? ' ' + setup.zipCode : ''}`],
    [],
  ];

  const headerRowIdxs = [];
  let totGross = 0, totExempt = 0, totZeroRated = 0, totTaxable = 0, totTax = 0, totGrossTaxable = 0;
  let totServices = 0, totCapGoods = 0, totOtherGoods = 0;

  if (isSLS) {
    headerRowIdxs.push(data.length, data.length + 1, data.length + 2, data.length + 3);
    data.push(['TAXABLE','TAXPAYER','REGISTERED NAME','NAME OF CUSTOMER',"CUSTOMER'S ADDRESS",'AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF']);
    data.push(['MONTH','IDENTIFICATION','','(Last Name, First Name, Middle Name)','','GROSS SALES','EXEMPT SALES','ZERO RATED SALES','TAXABLE SALES','OUTPUT TAX','GROSS TAXABLE SALES']);
    data.push(['','NUMBER','','','','','','','','','']);
    data.push(['(1)','(2)','(3)','(4)','(5)','(6)','(7)','(8)','(9)','(10)','(11)']);

    rows.forEach(r => {
      const [regName, custName] = partyNameCols(r);
      const gross = r.exempt + r.zeroRated + r.taxable;
      const grossTaxable = r.taxable + r.outputVAT;
      totGross += gross; totExempt += r.exempt; totZeroRated += r.zeroRated;
      totTaxable += r.taxable; totTax += r.outputVAT; totGrossTaxable += grossTaxable;
      data.push([
        r.monthKey ? monthKeyToEndDate(r.monthKey) : monthDate, tinDashed(r.tin), regName.toUpperCase(), custName.toUpperCase(),
        [r.address1, r.address2].filter(Boolean).join(' ').toUpperCase(),
        gross, r.exempt, r.zeroRated, r.taxable, r.outputVAT, grossTaxable,
      ]);
    });

    data.push(['', '', '', '', 'Grand Total :',
      Number(totGross.toFixed(2)), Number(totExempt.toFixed(2)), Number(totZeroRated.toFixed(2)),
      Number(totTaxable.toFixed(2)), Number(totTax.toFixed(2)), Number(totGrossTaxable.toFixed(2))]);
  } else {
    headerRowIdxs.push(data.length, data.length + 1, data.length + 2, data.length + 3);
    data.push(['TAXABLE','TAXPAYER','REGISTERED NAME','NAME OF SUPPLIER',"SUPPLIER'S ADDRESS",'AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF','AMOUNT OF']);
    data.push(['MONTH','IDENTIFICATION','','(Last Name, First Name, Middle Name)','','GROSS PURCHASE','EXEMPT PURCHASE','ZERO-RATED PURCHASE','TAXABLE PURCHASE','PURCHASE OF SERVICES','PURCHASE OF CAPITAL GOODS','PURCHASE OF GOODS OTHER THAN CAPITAL GOODS','INPUT TAX','GROSS TAXABLE PURCHASE']);
    data.push(['','NUMBER','','','','','','','','','','','','']);
    data.push(['(1)','(2)','(3)','(4)','(5)','(6)','(7)','(8)','(9)','(10)','(11)','(12)','(13)','(14)']);

    rows.forEach(r => {
      const [regName, suppName] = partyNameCols(r);
      const taxable = r.services + r.capGoods + r.otherGoods;
      const gross = r.exempt + r.zeroRated + taxable;
      const grossTaxable = taxable + r.inputVAT;
      totGross += gross; totExempt += r.exempt; totZeroRated += r.zeroRated; totTaxable += taxable;
      totServices += r.services; totCapGoods += r.capGoods; totOtherGoods += r.otherGoods;
      totTax += r.inputVAT; totGrossTaxable += grossTaxable;
      data.push([
        r.monthKey ? monthKeyToEndDate(r.monthKey) : monthDate, tinDashed(r.tin), regName.toUpperCase(), suppName.toUpperCase(),
        [r.address1, r.address2].filter(Boolean).join(' ').toUpperCase(),
        gross, r.exempt, r.zeroRated, taxable, r.services, r.capGoods, r.otherGoods, r.inputVAT, grossTaxable,
      ]);
    });

    data.push(['', '', '', '', 'Grand Total :',
      Number(totGross.toFixed(2)), Number(totExempt.toFixed(2)), Number(totZeroRated.toFixed(2)), Number(totTaxable.toFixed(2)),
      Number(totServices.toFixed(2)), Number(totCapGoods.toFixed(2)), Number(totOtherGoods.toFixed(2)),
      Number(totTax.toFixed(2)), Number(totGrossTaxable.toFixed(2))]);
  }

  const grandTotalRowIdx = data.length - 1;
  data.push(['------------------']);
  data.push(['==================']);
  data.push(['END OF REPORT']);

  const ws = XLSX.utils.aoa_to_sheet(data);
  const boldRange = (rowIdx) => {
    const row = data[rowIdx];
    for (let c = 0; c < row.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
      if (!ws[addr]) continue;
      ws[addr].s = { font: { bold: true } };
    }
  };
  headerRowIdxs.forEach(boldRange);
  boldRange(grandTotalRowIdx);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, isSLS ? 'SLS' : 'SLP');
  XLSX.writeFile(wb, `${type.toUpperCase()}_${periodLabel.replace(/[\s()–\/]/g,'_')}.xlsx`, { cellStyles: true });
}

// ── EXPORT DAT (BIR RELIEF/eSubmission format) ─────────────────
function tin9(t) {
  const digits = (t || '').replace(/\D/g, '');
  return (digits.substring(0, 9) || '').padEnd(9, '0').substring(0, 9) || '000000000';
}

function datDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return '';
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${dt.getFullYear()}`;
}

function csvNum(n) {
  return (Number(n) || 0).toFixed(2);
}

// BIR detail (D) rows leave blank fields fully empty (no quotes); only header (H)
// rows quote blanks as "". Use this for any D-row field that may legitimately be blank.
function qd(v) {
  return v ? `"${v}"` : '';
}

// BIR's Validation Module rejects names/addresses containing special characters
// (commas break its naive comma-split parsing; other symbols like ()*&^%$#@! fail
// its field validation outright). Keep letters, digits, spaces, period, hyphen, slash.
function stripSpecial(v) {
  return (v || '').replace(/[^A-Za-z0-9\s.\-\/]/g, '');
}

function exportDAT(rows, type, setup, periodEnd) {
  const isSLS = type === 'sls';
  const isInd = setup.classification === 'Individual';

  const ourTin = tin9(setup.tin);
  const ln = isInd ? (setup.lastName || '').toUpperCase()  : '';
  const fn = isInd ? (setup.firstName || '').toUpperCase() : '';
  const mn = isInd ? (setup.middleName || '').toUpperCase(): '';
  const regName = stripSpecial(setup.companyName || setup.taxpayerName || '').toUpperCase();
  const addr1 = stripSpecial(setup.address1 || setup.address || '').toUpperCase();
  const addr2 = stripSpecial(setup.address2 || setup.zipCode || '').toUpperCase();
  const rdo = setup.rdoCode || '';
  const fiscalMonthEnd = setup.fiscalMonthEnd || '12';
  const dateStr = datDate(periodEnd);

  const lines = [];

  if (isSLS) {
    const tot = rows.reduce((a, r) => ({
      exempt: a.exempt + r.exempt, zeroRated: a.zeroRated + r.zeroRated,
      taxable: a.taxable + r.taxable, vat: a.vat + r.outputVAT,
    }), { exempt: 0, zeroRated: 0, taxable: 0, vat: 0 });

    lines.push([
      'H', 'S', `"${ourTin}"`, '""', `"${ln}"`, `"${fn}"`, `"${mn}"`, `"${regName}"`, `"${addr1}"`, `"${addr2}"`,
      csvNum(tot.exempt), csvNum(tot.zeroRated), csvNum(tot.taxable), csvNum(tot.vat),
      rdo, dateStr, fiscalMonthEnd,
    ].join(','));

    for (const r of rows) {
      const buyerTin = tin9(r.tin);
      const buyerReg = stripSpecial(r.companyName || '').toUpperCase();
      const bln = stripSpecial(r.lastName || '').toUpperCase();
      const bfn = stripSpecial(r.firstName || '').toUpperCase();
      const bmn = stripSpecial(r.middleName || '').toUpperCase();
      const a1  = stripSpecial(r.address1 || '').toUpperCase();
      const a2  = stripSpecial(r.address2 || '').toUpperCase();
      lines.push([
        'D', 'S', `"${buyerTin}"`, qd(buyerReg), qd(bln), qd(bfn), qd(bmn), qd(a1), qd(a2),
        csvNum(r.exempt), csvNum(r.zeroRated), csvNum(r.taxable), csvNum(r.outputVAT),
        `"${ourTin}"`, datDate(r.date),
      ].join(','));
    }
  } else {
    const tot = rows.reduce((a, r) => ({
      exempt: a.exempt + r.exempt, zeroRated: a.zeroRated + r.zeroRated,
      capGoods: a.capGoods + r.capGoods, services: a.services + r.services,
      otherGoods: a.otherGoods + r.otherGoods, vat: a.vat + r.inputVAT,
    }), { exempt: 0, zeroRated: 0, capGoods: 0, services: 0, otherGoods: 0, vat: 0 });

    lines.push([
      'H', 'P', `"${ourTin}"`, '""', `"${ln}"`, `"${fn}"`, `"${mn}"`, `"${regName}"`, `"${addr1}"`, `"${addr2}"`,
      csvNum(tot.exempt), csvNum(tot.zeroRated), csvNum(tot.services), csvNum(tot.capGoods), csvNum(tot.otherGoods),
      csvNum(tot.vat), csvNum(tot.vat), csvNum(0),
      rdo, dateStr, fiscalMonthEnd,
    ].join(','));

    for (const r of rows) {
      const sellerTin = tin9(r.tin);
      const sellerReg = stripSpecial(r.companyName || '').toUpperCase();
      const sln = stripSpecial(r.lastName || '').toUpperCase();
      const sfn = stripSpecial(r.firstName || '').toUpperCase();
      const smn = stripSpecial(r.middleName || '').toUpperCase();
      const a1  = stripSpecial(r.address1 || '').toUpperCase();
      const a2  = stripSpecial(r.address2 || '').toUpperCase();
      lines.push([
        'D', 'P', `"${sellerTin}"`, qd(sellerReg), qd(sln), qd(sfn), qd(smn), qd(a1), qd(a2),
        csvNum(r.exempt), csvNum(r.zeroRated), csvNum(r.services), csvNum(r.capGoods), csvNum(r.otherGoods), csvNum(r.inputVAT),
        `"${ourTin}"`, datDate(r.date),
      ].join(','));
    }
  }

  const content = lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/plain' });
  const periodTag = periodEnd ? `${String(periodEnd.getMonth()+1).padStart(2,'0')}${periodEnd.getFullYear()}` : '';
  const fname = `${ourTin}${isSLS ? 'S' : 'P'}${periodTag}.DAT`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fname });
  a.click(); URL.revokeObjectURL(a.href);
}
