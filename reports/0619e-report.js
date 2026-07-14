/* ============================================================
   Tallo CPA – BIR Tax App
   0619e-report.js – Monthly Remittance Form of Creditable
                      Income Taxes Withheld (Expanded)
   ============================================================ */

// ── LOCAL HELPERS ───────────────────────────────────────────────
function getLines0619(item) {
  return item?.Lines || item?.lines || [];
}

// 0619-E doesn't require an ATC alphalist — any tax code mapped to an
// EWT ATC (via the shared "Tax Codes" tab / ewtMap from getEwtTcMap)
// counts toward the total remittance. No name-based fallback needed.
function resolveAtc0619E(tcName, ewtMap, tcKey) {
  if (ewtMap && tcKey && ewtMap[tcKey]) {
    const m = ewtMap[tcKey];
    const atc = (m.atc || m).toString().toUpperCase();
    return { atc, desc: m.desc || ATC_MASTER[atc]?.desc || atc, rate: Number(m.rate ?? ATC_MASTER[atc]?.rate ?? 0) };
  }
  return null;
}

function extractEWTLines0619(item, ewtMap, rateByKeyEWT) {
  const out = [];
  for (const line of getLines0619(item)) {
    const tcObj = line?.taxCode ?? line?.TaxCode;
    const tcKey = (tcObj && typeof tcObj === 'object') ? (tcObj.key || tcObj.Key || '') : (tcObj || '');
    const tcName = (tcObj && typeof tcObj === 'object') ? (tcObj.name || tcObj.Name || '') : '';
    const info = resolveAtc0619E(tcName, ewtMap, tcKey);
    if (!info) continue;

    const qty = Number(line?.qty ?? 1);
    const unitPrice = Number(line?.salesUnitPrice ?? line?.purchaseUnitPrice ?? line?.unitPrice ?? 0);
    let amount = qty * unitPrice;
    if (line?.discountPercentage) amount *= (1 - Number(line.discountPercentage) / 100);
    amount -= Number(line?.discountAmount || 0);
    amount = Math.abs(amount);

    // Manager has no native withholding-tax line type, so EWT is recorded
    // using a 0% pass-through tax code where the line amount IS the tax
    // withheld. Gross it up using the real ATC rate to get the tax base.
    const mgrRate = Number(rateByKeyEWT?.[tcKey] ?? 0);
    let rate, base, ewt;
    if (mgrRate > 0 && mgrRate < 100) {
      rate = mgrRate;
      base = amount;
      ewt = base * rate / 100;
    } else {
      // mgrRate is 0 (legacy pass-through) or 100 (standard pass-through
      // workaround): the line amount IS the EWT amount, so gross it up.
      rate = Number(info.rate ?? 0);
      ewt = amount;
      base = rate > 0 ? amount / (rate / 100) : amount;
    }
    out.push({ atc: info.atc, desc: info.desc, rate, base, ewt });
  }
  return out;
}

async function buildEWTMonthly(biz, start, end, ewtMap, rateByKeyEWT) {
  const [invItems, paymentItems, suppMap] = await Promise.all([
    fetchAllBatch('/api4/purchase-invoice-batch', biz),
    fetchAllBatch('/api4/payment-batch', biz),
    loadPartyBIR(biz, 'supplier'),
  ]);
  const items = [...invItems, ...paymentItems.filter(({ item }) => getLines0619(item).some(l => {
    const tc = l?.taxCode ?? l?.TaxCode;
    return tc && (typeof tc === 'object' ? (tc.key || tc.Key) : tc);
  }))];

  const byAtc = {};
  const detail = [];

  for (const { item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const sk = item?.supplier || item?.Supplier || '';
    const sd = suppMap[sk] || {};
    const name = sd.companyName || [sd.lastName, sd.firstName, sd.middleName].filter(Boolean).join(', ') || item?.SupplierName || sk;
    const ref = item?.reference || item?.Reference || item?.invoiceNumber || item?.InvoiceNumber || '';

    const lines = extractEWTLines0619(item, ewtMap, rateByKeyEWT);
    for (const l of lines) {
      if (!byAtc[l.atc]) byAtc[l.atc] = { atc: l.atc, desc: l.desc, rate: l.rate, base: 0, ewt: 0 };
      byAtc[l.atc].base += l.base;
      byAtc[l.atc].ewt  += l.ewt;
      detail.push({ date, ref, name, tin: sd.tin || '', atc: l.atc, desc: l.desc, rate: l.rate, base: l.base, ewt: l.ewt });
    }
  }

  const atcRows = Object.values(byAtc).sort((a, b) => a.atc.localeCompare(b.atc));
  return { atcRows, detail: detail.sort((a, b) => new Date(a.date) - new Date(b.date)) };
}

// ── INIT ────────────────────────────────────────────────────────
async function init0619EReport() {
  const filterEl = document.getElementById('filter-area');
  const outputEl = document.getElementById('report-output');

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

  filterEl.innerHTML = periodFilterHTML('monthly', 'me');
  filterEl.insertAdjacentHTML('beforeend', `
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin||'—')}</strong>
    </div>`);

  document.getElementById('me-gen').addEventListener('click', () => generate0619E(biz, setup, outputEl));
}

async function generate0619E(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;

  const month = parseInt(document.getElementById('me-month').value, 10);
  const year  = parseInt(document.getElementById('me-year').value, 10);
  const { start, end } = getPeriodDates('monthly', month, year);

  try {
    const { tcKeyToAtc, taxCodes } = await getEwtTcMap(biz);
    const rateByKeyEWT = {};
    taxCodes.forEach(tc => rateByKeyEWT[tc.key] = tc.rate);
    const ewtMap = tcKeyToAtc;

    const { atcRows, detail } = await buildEWTMonthly(biz, start, end, ewtMap, rateByKeyEWT);
    const period = { month, year, start, end, label: `${monthName(month)} ${year}` };

    render0619E(outputEl, atcRows, detail, setup, period);
    window._e = { totalEwt: atcRows.reduce((a, r) => a + r.ewt, 0) };
    // Period this render represents, for the wizard's freeze/variance step
    // (month is 0-based, matching monthName()).
    window._period = { ptype: 'monthly', year: year, period: month, form: '0619E', label: period.label };

    ['me-print','me-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function tinDashed0619(t) {
  const d = (t || '').replace(/\D/g, '').padEnd(9, '0').substring(0, 9);
  return `${d.substring(0,3)}-${d.substring(3,6)}-${d.substring(6,9)}`;
}

function render0619E(el, atcRows, detail, setup, period) {
  const totalEwt = atcRows.reduce((a, r) => a + r.ewt, 0);
  const isInd = setup.classification === 'Individual';
  const agentName = isInd
    ? [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '');

  const detailRows = detail.map(d => `
    <tr>
      <td>${fmtDate(d.date)}</td><td>${escHtml(d.ref)}</td><td>${escHtml(d.name)}</td>
      <td style="font-family:monospace;">${escHtml(d.tin)}</td>
      <td>${escHtml(d.atc)}</td><td class="num">${fmt(d.base)}</td>
      <td class="num">${d.rate}%</td><td class="num">${fmt(d.ewt)}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="form-title">
      <h2>BIR Form 0619-E — Monthly Remittance Form of Creditable Income Taxes Withheld (Expanded)</h2>
      <div class="sub">For the Month of: ${escHtml(period.label)}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label">ATC</div><div class="return-line-amt">WME10</div></div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">Tax Type Code</div><div class="return-line-amt">WE</div></div>
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(tinDashed0619(setup.tin))}</div></div>
      <div class="return-line"><div class="return-line-num">8</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Withholding Agent's Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(agentName)}</div></div>
      <div class="return-line"><div class="return-line-num">10</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">10A</div><div class="return-line-label">ZIP Code</div><div class="return-line-amt">${escHtml(setup.zipCode || '—')}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part II – Tax Remittance</div>
      ${returnLine(14, 'Amount of Remittance', totalEwt, true, 'highlight')}
      ${returnLine(15, 'Less: Amount Remitted from Previously Filed Form, if amended', 0)}
      ${returnLine(16, 'Net Amount of Remittance (Item 14 Less Item 15)', totalEwt, true)}
      ${returnLine('17A', 'Add: Surcharge', 0)}
      ${returnLine('17B', 'Add: Interest', 0)}
      ${returnLine('17C', 'Add: Compromise', 0)}
      ${returnLine('17D', 'Total Penalties (Sum of Items 17A to 17C)', 0)}
      ${returnLine(18, 'TOTAL AMOUNT OF REMITTANCE (Sum of Items 16 and 17D)', totalEwt, true, 'highlight payable')}
    </div>

    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">ATC Codes</div><div class="stat-value">${atcRows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">${detail.length}</div></div>
      <div class="stat-card"><div class="stat-label">Total Tax Withheld</div><div class="stat-value small">₱ ${fmt(totalEwt)}</div></div>
    </div>

    <div class="return-section no-print">
      <div class="return-section-header">Reference — EWT Breakdown for the Month (for your records — not part of 0619-E)</div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Reference</th><th>Payee</th><th>TIN</th><th>ATC</th><th class="num">Tax Base</th><th class="num">Rate</th><th class="num">Tax Withheld</th></tr></thead>
          <tbody>${detailRows || `<tr><td colspan="8" style="text-align:center;color:#9ca3af;">No records</td></tr>`}</tbody>
          <tfoot><tr><td colspan="5" style="font-weight:700;">TOTAL</td><td class="num">${fmt(atcRows.reduce((a,r)=>a+r.base,0))}</td><td></td><td class="num">${fmt(totalEwt)}</td></tr></tfoot>
        </table>
      </div>
    </div>`;
}
