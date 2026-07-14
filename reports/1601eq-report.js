/* ============================================================
   Tallo CPA – BIR Tax App
   1601eq-report.js – Quarterly Remittance Return of Creditable
                       Income Taxes Withheld (Expanded), Part IV
                       Alphalist by ATC + DAT/Excel export
   ============================================================ */

// ── LOCAL HELPERS (kept independent of sls-report.js) ──────────
function getLines(item) {
  return item?.Lines || item?.lines || [];
}
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

// 1601-EQ resolves ATCs through the shared ATC_MASTER (ewt-helpers.js) — the
// single source of truth also used by 0619E / 2307 / QAP, so the quarterly
// return and its QAP alphalist read the exact same ATC set and always
// reconcile. (Previously this file kept its own partial ATC table, which
// silently dropped codes the shared table had, and vice-versa.) Explicit
// per-tax-code mappings (ewtMap, keyed by Manager tax-code GUID) still win.
function resolveAtc1601EQ(tcName, ewtMap, tcKey) {
  // 1. explicit user mapping by Manager tax-code key
  if (ewtMap && tcKey && ewtMap[tcKey]) {
    const m = ewtMap[tcKey];
    const atc = (m.atc || m).toString().toUpperCase();
    return { atc, desc: m.desc || ATC_MASTER[atc]?.desc || atc, rate: Number(m.rate ?? ATC_MASTER[atc]?.rate ?? 0) };
  }
  if (!tcName) return null;
  const upper = tcName.toUpperCase().trim();
  if (ATC_MASTER[upper]) return { atc: upper, ...ATC_MASTER[upper] };
  for (const atc of Object.keys(ATC_MASTER)) {
    if (upper.includes(atc)) return { atc, ...ATC_MASTER[atc] };
  }
  return null;
}

// ── EWT EXTRACTION FROM AN ITEM (purchase invoice / payment) ───
function extractEWTLines(item, ewtMap, rateByKeyEWT) {
  const out = [];
  for (const line of getLines(item)) {
    const tcObj = line?.taxCode ?? line?.TaxCode;
    const tcKey = (tcObj && typeof tcObj === 'object') ? (tcObj.key || tcObj.Key || '') : (tcObj || '');
    const tcName = (tcObj && typeof tcObj === 'object') ? (tcObj.name || tcObj.Name || '') : '';
    const info = resolveAtc1601EQ(tcName, ewtMap, tcKey);
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

// ── BUILD ALPHALIST ROWS GROUPED BY ATC ────────────────────────
async function buildEWTAlphalist(biz, start, end, ewtMap, rateByKeyEWT) {
  const [invItems, paymentItems, suppMap] = await Promise.all([
    fetchAllBatch('/api4/purchase-invoice-batch', biz),
    fetchAllBatch('/api4/payment-batch', biz),
    loadPartyBIR(biz, 'supplier'),
  ]);
  const items = [...invItems, ...paymentItems.filter(({ item }) => getLines(item).some(l => {
    const tc = l?.taxCode ?? l?.TaxCode;
    return tc && (typeof tc === 'object' ? (tc.key || tc.Key) : tc);
  }))];

  const byAtc = {};   // atc -> { atc, desc, rate, base, ewt, payees: Map }
  const detail = [];  // per-transaction rows for reference table

  for (const { item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const sk = item?.supplier || item?.Supplier || '';
    const sd = suppMap[sk] || {};
    const name = sd.companyName || [sd.lastName, sd.firstName, sd.middleName].filter(Boolean).join(', ') || item?.SupplierName || sk;
    const ref = item?.reference || item?.Reference || item?.invoiceNumber || item?.InvoiceNumber || '';
    const monthIdx = Math.max(0, Math.min(2, new Date(date).getMonth() - start.getMonth()));

    const lines = extractEWTLines(item, ewtMap, rateByKeyEWT);
    for (const l of lines) {
      if (!byAtc[l.atc]) byAtc[l.atc] = { atc: l.atc, desc: l.desc, rate: l.rate, base: 0, ewt: 0, payees: new Map() };
      byAtc[l.atc].base += l.base;
      byAtc[l.atc].ewt  += l.ewt;
      const pkey = sk || name;
      if (!byAtc[l.atc].payees.has(pkey)) {
        byAtc[l.atc].payees.set(pkey, {
          name, tin: sd.tin || '', branchCode: sd.branchCode || '', companyName: sd.companyName || '',
          lastName: sd.lastName || '', firstName: sd.firstName || '', middleName: sd.middleName || '',
          address1: sd.address1 || '', address2: sd.address2 || '',
          base: 0, ewt: 0,
          months: [ { base: 0, ewt: 0 }, { base: 0, ewt: 0 }, { base: 0, ewt: 0 } ],
        });
      }
      const p = byAtc[l.atc].payees.get(pkey);
      p.base += l.base; p.ewt += l.ewt;
      p.months[monthIdx].base += l.base;
      p.months[monthIdx].ewt  += l.ewt;

      detail.push({
        date, ref, name, tin: sd.tin || '', atc: l.atc, desc: l.desc, rate: l.rate, base: l.base, ewt: l.ewt,
        companyName: sd.companyName || '', lastName: sd.lastName || '', firstName: sd.firstName || '', middleName: sd.middleName || '',
      });
    }
  }

  const atcRows = Object.values(byAtc).sort((a, b) => a.atc.localeCompare(b.atc));
  return { atcRows, detail: detail.sort((a, b) => new Date(a.date) - new Date(b.date)) };
}

// ── INIT ────────────────────────────────────────────────────────
async function init1601EQReport() {
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

  filterEl.innerHTML = periodFilterHTML('quarterly', 'eq');
  // Add Excel/DAT buttons (periodFilterHTML only provides Generate/Print/Save PDF)
  const sep = document.createElement('span');
  sep.innerHTML = `<button class="btn btn-outline" id="eq-excel" style="display:none;">📥 Excel</button>
                    <button class="btn btn-outline" id="eq-dat" style="display:none;">📄 DAT File</button>`;
  filterEl.querySelector('#eq-filter').appendChild(sep);

  filterEl.insertAdjacentHTML('beforeend', `
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin||'—')}</strong>
    </div>`);

  document.getElementById('eq-gen').addEventListener('click', () => generate1601EQ(biz, setup, outputEl));
}

let _eqAtcRows = [], _eqDetail = [], _eqPeriod = null;

async function generate1601EQ(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;

  const quarter = parseInt(document.getElementById('eq-quarter').value, 10);
  const year    = parseInt(document.getElementById('eq-year').value, 10);
  const { start, end } = getPeriodDates('quarterly', quarter, year);

  try {
    const { tcKeyToAtc, taxCodes } = await getEwtTcMap(biz);
    const rateByKeyEWT = {};
    taxCodes.forEach(tc => rateByKeyEWT[tc.key] = tc.rate);
    const ewtMap = tcKeyToAtc;

    const { atcRows, detail } = await buildEWTAlphalist(biz, start, end, ewtMap, rateByKeyEWT);
    _eqAtcRows = atcRows; _eqDetail = detail;
    _eqPeriod = { quarter, year, start, end, label: `${quarterLabel(quarter)} ${year}` };

    render1601EQ(outputEl, atcRows, detail, setup, _eqPeriod);
    window._e = { totalEwt: atcRows.reduce((a, r) => a + r.ewt, 0) };
    // Period this render represents, for the wizard's freeze/variance step.
    window._period = { ptype: 'quarterly', year: _eqPeriod.year, period: _eqPeriod.quarter, form: '1601EQ', label: _eqPeriod.label };

    ['eq-excel','eq-dat','eq-print','eq-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
    document.getElementById('eq-excel').onclick = () => exportEQExcel(atcRows, setup, _eqPeriod);
    document.getElementById('eq-dat').onclick   = () => exportEQDAT(detail, setup, _eqPeriod);

  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ── RENDER ────────────────────────────────────────────────────
function render1601EQ(el, atcRows, detail, setup, period) {
  const totalBase = atcRows.reduce((a, r) => a + r.base, 0);
  const totalEwt  = atcRows.reduce((a, r) => a + r.ewt, 0);

  const isInd = setup.classification === 'Individual';
  const agentName = isInd
    ? [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '');

  const atcLines = atcRows.map((r, i) => `
    <div class="return-line">
      <div class="return-line-num">${13 + i}</div>
      <div class="return-line-label">
        <strong>${escHtml(r.atc)}</strong> — ${escHtml(r.desc)}
        <br><small style="color:#9ca3af;">Tax Base: ₱ ${fmt(r.base)} &nbsp;|&nbsp; Rate: ${r.rate}%</small>
      </div>
      <div class="return-line-amt">₱ ${fmt(r.ewt)}</div>
    </div>`).join('');

  const detailRows = detail.map(d => `
    <tr>
      <td>${fmtDate(d.date)}</td><td>${escHtml(d.ref)}</td><td>${escHtml(d.name)}</td>
      <td style="font-family:monospace;">${escHtml(d.tin)}</td>
      <td>${escHtml(d.atc)}</td><td class="num">${fmt(d.base)}</td>
      <td class="num">${d.rate}%</td><td class="num">${fmt(d.ewt)}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="form-title">
      <h2>BIR Form 1601-EQ — Quarterly Remittance Return of Creditable Income Taxes Withheld (Expanded)</h2>
      <div class="sub">For the Quarter: ${escHtml(period.label)}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(tinDashed(setup.tin))}</div></div>
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">8</div><div class="return-line-label">Withholding Agent's Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(agentName)}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">9A</div><div class="return-line-label">ZIP Code</div><div class="return-line-amt">${escHtml(setup.zipCode || '—')}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part II – Computation of Tax (Schedule of Alphalist by ATC)</div>
      ${atcRows.length ? atcLines : `<div class="return-line"><div class="return-line-label" style="color:#9ca3af;">No EWT transactions found for this quarter.</div></div>`}
      ${returnLine(19, 'Total Taxes Withheld for the Quarter (Sum of Items 13 to 18)', totalEwt, true, 'highlight')}
      ${returnLine(20, 'Less: Remittances Made – 1st Month of the Quarter', 0)}
      ${returnLine(21, 'Less: Remittances Made – 2nd Month of the Quarter', 0)}
      ${returnLine(22, 'Tax Remitted in Return Previously Filed, if amended', 0)}
      ${returnLine(23, 'Over-remittance from Previous Quarter', 0)}
      ${returnLine(24, 'Other Payments Made (BIR Form 0605)', 0)}
      ${returnLine(25, 'Total Remittances Made (Sum of Items 20 to 24)', 0, true)}
      ${returnLine(26, 'Tax Still Due / (Over-remittance) (Item 19 Less Item 25)', totalEwt, true, 'payable')}
      ${returnLine(27, 'Add: Surcharge', 0)}
      ${returnLine(28, 'Add: Interest', 0)}
      ${returnLine(29, 'Add: Compromise', 0)}
      ${returnLine(30, 'Total Penalties (Sum of Items 27 to 29)', 0)}
      ${returnLine(31, 'TOTAL AMOUNT STILL DUE / (Over-remittance) (Sum of Items 26 and 30)', totalEwt, true, 'highlight payable')}
    </div>

    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">ATC Codes</div><div class="stat-value">${atcRows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Total Tax Base</div><div class="stat-value small">₱ ${fmt(totalBase)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Tax Withheld</div><div class="stat-value small">₱ ${fmt(totalEwt)}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Reference — Detailed EWT Transactions for the Quarter</div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Reference</th><th>Payee</th><th>TIN</th><th>ATC</th><th class="num">Tax Base</th><th class="num">Rate</th><th class="num">Tax Withheld</th></tr></thead>
          <tbody>${detailRows || `<tr><td colspan="8" style="text-align:center;color:#9ca3af;">No records</td></tr>`}</tbody>
          <tfoot><tr><td colspan="5" style="font-weight:700;">TOTALS</td><td class="num">${fmt(totalBase)}</td><td></td><td class="num">${fmt(totalEwt)}</td></tr></tfoot>
        </table>
      </div>
    </div>`;
}

function tinDashed(t) {
  const d = (t || '').replace(/\D/g, '').padEnd(9, '0').substring(0, 9);
  return `${d.substring(0,3)}-${d.substring(3,6)}-${d.substring(6,9)}`;
}

function branch4(b) {
  return (b || '').toString().replace(/\D/g, '').padStart(4, '0').substring(0, 4) || '0000';
}

// ── EXCEL EXPORT (official BIR QAP layout, Attachment to 1601-EQ) ──
function exportEQExcel(atcRows, setup, period) {
  if (!window.XLSX) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => exportEQExcel(atcRows, setup, period);
    document.head.appendChild(s); return;
  }
  const qEndMonthName = period.end ? monthName(period.end.getMonth()).toUpperCase() : '';
  const year = period.end ? period.end.getFullYear() : period.year;
  const agentName = (setup.companyName || setup.taxpayerName || '').toUpperCase();

  const data = [
    ['Attachment to BIR Form 1601-EQ'],
    ['QUARTERLY ALPHABETICAL LIST OF PAYEES SUBJECTED TO EXPANDED WITHHOLDING TAX & PAYEES WHOSE INCOME PAYMENTS ARE EXEMPT '],
    [`FOR THE QUARTER ENDING ${qEndMonthName}, ${year}`],
    [`TIN : ${tinDashed(setup.tin)}-${branch4(setup.branchCode)}`],
    [`WITHHOLDING AGENT'S NAME: ${agentName}`],
    [],
    [
      'SEQ NO', 'TAXPAYER IDENTIFICATION NUMBER', 'CORPORATION (Registered Name)',
      'INDIVIDUAL (Last Name, First Name, Middle Name)', 'ATC CODE', 'NATURE OF PAYMENT',
      '1ST MONTH OF QUARTER', '', '',
      '2ND MONTH OF QUARTER', '', '',
      '3RD MONTH OF QUARTER', '', '',
      'TOTAL FOR QUARTER', '',
    ],
    [
      '', '', '', '', '', '',
      'AMOUNT OF INCOME PAYMENT', 'TAX RATE', 'TAX WITHHELD',
      'AMOUNT OF INCOME PAYMENT', 'TAX RATE', 'TAX WITHHELD',
      'AMOUNT OF INCOME PAYMENT', 'TAX RATE', 'TAX WITHHELD',
      'TOTAL AMOUNT', 'TOTAL TAX WITHHELD',
    ],
  ];

  let seq = 0, totBase = 0, totEwt = 0;
  atcRows.forEach(r => {
    r.payees.forEach(p => {
      seq++;
      const isIndividual = !p.companyName && (p.lastName || p.firstName);
      const corpName = isIndividual ? '' : (p.companyName || p.name || '').toUpperCase();
      const indName  = isIndividual
        ? [p.lastName, p.firstName, p.middleName].filter(Boolean).join(', ').toUpperCase()
        : '';
      const m = p.months || [{base:0,ewt:0},{base:0,ewt:0},{base:0,ewt:0}];
      totBase += p.base; totEwt += p.ewt;

      data.push([
        seq,
        `${tinDashed(p.tin)}-${branch4(p.branchCode)}`,
        corpName,
        indName,
        r.atc,
        r.desc,
        Number(m[0].base.toFixed(2)), r.rate, Number(m[0].ewt.toFixed(2)),
        Number(m[1].base.toFixed(2)), r.rate, Number(m[1].ewt.toFixed(2)),
        Number(m[2].base.toFixed(2)), r.rate, Number(m[2].ewt.toFixed(2)),
        Number(p.base.toFixed(2)), Number(p.ewt.toFixed(2)),
      ]);
    });
  });

  data.push([
    '', '', '', '', '', 'Grand Total :',
    '', '', '', '', '', '', '', '', '',
    Number(totBase.toFixed(2)), Number(totEwt.toFixed(2)),
  ]);
  data.push(['------------------']);
  data.push(['==================']);
  data.push(['END OF REPORT']);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Sheet1');
  XLSX.writeFile(wb, `1601EQ_${period.label.replace(/[\s()–\/]/g,'_')}.xlsx`);
}

// ── DAT EXPORT (BIR eSubmission format, per sample 1601EQ DAT) ──
function csvNum1601(n) { return (Number(n) || 0).toFixed(2); }

function csvField1601(s) { return `"${(s || '').toString().toUpperCase()}"`; }

function exportEQDAT(detail, setup, period) {
  const ourTin = tin9(setup.tin);
  const ourBranch = (setup.branchCode || '0000').toString().padStart(4, '0').substring(0, 4);
  const regName = (setup.companyName || setup.taxpayerName ||
    [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(' ') || '').toUpperCase();
  const rdo = (setup.rdoCode || '').toString().padStart(3, '0').substring(0, 3);

  // Build the 3 months of the quarter
  const months = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(period.start.getFullYear(), period.start.getMonth() + i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, mmYYYY: `${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}` });
  }

  // Group detail rows by month, then by payee+ATC
  const byMonth = months.map(m => ({ ...m, payeeAtc: new Map() }));
  for (const row of detail) {
    const d = (row.date instanceof Date) ? row.date : new Date(row.date);
    if (isNaN(d)) continue;
    const m = byMonth.find(x => x.year === d.getFullYear() && x.month === (d.getMonth() + 1));
    if (!m) continue;
    const payeeTin = tin9(row.tin);
    const key = `${payeeTin}|${row.atc}`;
    if (!m.payeeAtc.has(key)) {
      m.payeeAtc.set(key, {
        tin: row.tin, atc: row.atc, rate: row.rate,
        companyName: row.companyName, lastName: row.lastName, firstName: row.firstName, middleName: row.middleName,
        name: row.name,
        base: 0, ewt: 0,
      });
    }
    const p = m.payeeAtc.get(key);
    p.base += row.base;
    p.ewt  += row.ewt;
  }

  // Header row
  const lines = [];
  lines.push(['HQAP', 'H1601EQ', ourTin, ourBranch, csvField1601(regName), months[2].mmYYYY, rdo].join(','));

  // Detail + control rows, one set per month with data
  let seq = 1;
  for (const m of byMonth) {
    if (m.payeeAtc.size === 0) continue;
    let monthBase = 0, monthEwt = 0;
    for (const p of m.payeeAtc.values()) {
      const payeeTin = tin9(p.tin);
      const payeeBranch = '0000';
      const payeeReg = p.companyName || p.name || '';
      const pln = p.lastName || '';
      const pfn = p.firstName || '';
      const pmn = p.middleName || '';
      lines.push([
        'D1', '1601EQ', String(seq).padStart(4, '0'), payeeTin, payeeBranch,
        csvField1601(payeeReg), csvField1601(pln), csvField1601(pfn), csvField1601(pmn),
        m.mmYYYY, p.atc, p.rate.toFixed(2), csvNum1601(p.base), csvNum1601(p.ewt),
      ].join(','));
      monthBase += p.base; monthEwt += p.ewt;
      seq++;
    }
    lines.push(['C1', '1601EQ', ourTin, ourBranch, m.mmYYYY, csvNum1601(monthBase), csvNum1601(monthEwt)].join(','));
  }

  const content = lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/plain' });
  const periodTag = `Q${period.quarter}${period.year}`;
  const fname = `${ourTin}1601EQ${periodTag}.DAT`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fname });
  a.click(); URL.revokeObjectURL(a.href);
}
