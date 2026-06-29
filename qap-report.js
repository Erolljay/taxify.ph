/* ============================================================
   Tallo CPA – BIR Tax App
   qap-report.js  –  Quarterly Alphalist of Payees (QAP)
                      Attachment to BIR Form 1601-EQ — EWT withheld
                      from suppliers, per BIR RMC No. 15-2025, Annex A
   ============================================================ */

let _qapSuppMap = {};

async function initQAPReport() {
  const filterEl = document.getElementById('filter-area');
  const outputEl = document.getElementById('report-output');

  let biz;
  try {
    biz = await getReportBusiness(document.getElementById('biz-selector-wrap'));
    App.currentBusiness = biz;
  } catch (e) {
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

  _qapSuppMap = await loadPartyBIR(biz, 'supplier');

  filterEl.innerHTML = `
    <div class="filter-bar">
      <label>Period</label>
      <select id="qap-ptype">
        <option value="quarterly">Quarterly</option>
        <option value="monthly">Monthly</option>
        <option value="annual">Annual</option>
      </select>
      <span id="qap-qwrap">
        <label>Quarter</label>
        <select id="qap-quarter">
          ${[1,2,3,4].map(q=>`<option value="${q}"${q===curQ?' selected':''}>${quarterLabel(q)}</option>`).join('')}
        </select>
      </span>
      <span id="qap-mwrap" style="display:none;">
        <label>Month</label>
        <select id="qap-month">
          ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m=>`<option value="${m}"${m===now.getMonth()?' selected':''}>${monthName(m)}</option>`).join('')}
        </select>
      </span>
      <label>Year</label>
      <select id="qap-year">
        ${years.map(y=>`<option value="${y}"${y===curY?' selected':''}>${y}</option>`).join('')}
      </select>
      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="qap-gen">⚡ Generate</button>
      <button class="btn btn-outline" id="qap-excel" style="display:none;">📥 Excel (QAP)</button>
      <button class="btn btn-outline" id="qap-dat"   style="display:none;">📄 DAT File</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin||'—')}</strong>
    </div>
    <div id="qap-period-note" style="font-size:11px;color:#9ca3af;margin-top:2px;display:none;">
      ℹ️ The Excel (Annex A) report always covers the full quarter. Only the DAT file follows the selected period above.
    </div>`;

  document.getElementById('qap-ptype').addEventListener('change', function () {
    const isM = this.value === 'monthly';
    const isA = this.value === 'annual';
    document.getElementById('qap-qwrap').style.display = isM || isA ? 'none' : '';
    document.getElementById('qap-mwrap').style.display = isM ? '' : 'none';
    document.getElementById('qap-period-note').style.display = isM || isA ? '' : 'none';
  });

  document.getElementById('qap-gen').addEventListener('click', () => generateQAP(biz, setup, outputEl));

  // Suppliers quick-edit tab — mirrors SLP's pattern
  let supplierController = null;
  document.getElementById('qap-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn'); if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('#qap-tabs .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === 'suppliers') {
      const container = document.getElementById('tab-suppliers');
      if (!supplierController) supplierController = CF.mountParty(container, 'supplier');
      supplierController.refresh().then(() => filterSupplierTabToPeriod(container));
    }
  });
}

// Hide suppliers with no EWT transactions in the currently-generated QAP
// period, so the tab only shows the suppliers relevant to that period.
let _qapRows = [];
function filterSupplierTabToPeriod(container) {
  if (!_qapRows.length) return;
  const keys = new Set(_qapRows.map(r => r.suppKey).filter(Boolean));
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

// ── DATA AGGREGATION ─────────────────────────────────────────
// Returns flat array of detail rows: one per supplier per ATC, with
// totals for the quarter (income payment / tax base + tax withheld).
async function buildQAPRows(biz, start, end) {
  const customAtcMap = loadAtcMapping();
  const [invItems, paymentItems, { tcKeyToAtc, taxCodes }] = await Promise.all([
    fetchAllBatch('/api4/purchase-invoice-batch', biz),
    fetchAllBatch('/api4/payment-batch', biz),
    getEwtTcMap(biz),
  ]);
  const tcNameByKey = {};
  const rateByKey = {};
  taxCodes.forEach(tc => { tcNameByKey[tc.key] = tc.name; rateByKey[tc.key] = tc.rate; });

  const items = [...invItems, ...paymentItems];
  // key = supplierKey|atc
  const agg = {};

  for (const { item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const ewtLines = extractEWT(item, customAtcMap, tcNameByKey, rateByKey, tcKeyToAtc);
    if (!ewtLines.length) continue;

    const suppKey = item?.supplier || item?.Supplier || '';
    if (!suppKey) continue;

    const monthIdx = Math.max(0, Math.min(2, new Date(date).getMonth() - start.getMonth()));

    ewtLines.forEach(line => {
      const k = `${suppKey}|${line.atc}`;
      if (!agg[k]) {
        agg[k] = { suppKey, atc: line.atc, desc: line.desc, rate: line.rate, base: 0, ewt: 0,
          months: [ { base: 0, ewt: 0 }, { base: 0, ewt: 0 }, { base: 0, ewt: 0 } ] };
      }
      agg[k].base += line.base;
      agg[k].ewt  += line.ewt;
      agg[k].months[monthIdx].base += line.base;
      agg[k].months[monthIdx].ewt  += line.ewt;
    });
  }

  return Object.values(agg).sort((a, b) => {
    const an = _qapSuppMap[a.suppKey]?.name || a.suppKey;
    const bn = _qapSuppMap[b.suppKey]?.name || b.suppKey;
    return an.localeCompare(bn) || a.atc.localeCompare(b.atc);
  });
}

async function generateQAP(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;

  const ptypeEl  = document.getElementById('qap-ptype');
  const ptype    = ptypeEl ? ptypeEl.value : 'quarterly';
  const year     = parseInt(document.getElementById('qap-year').value, 10);
  const formType = '1601EQ';

  // The Excel (Annex A) report is always generated for the full quarter,
  // regardless of the period filter — derive that quarter here.
  const q = ptype === 'monthly'
    ? Math.ceil((parseInt(document.getElementById('qap-month').value, 10) + 1) / 3)
    : parseInt(document.getElementById('qap-quarter').value, 10);
  const { start: qStart, end: qEnd } = getPeriodDates('quarterly', q, year);

  // The DAT period follows the selected filter: a single month, a full
  // quarter, or the full year.
  let datStart, datEnd, periodLabel;
  if (ptype === 'monthly') {
    const month = parseInt(document.getElementById('qap-month').value, 10);
    ({ start: datStart, end: datEnd } = getPeriodDates('monthly', month, year));
    periodLabel = `${monthName(month)} ${year}`;
  } else if (ptype === 'annual') {
    datStart = new Date(year, 0, 1);
    datEnd   = new Date(year, 11, 31, 23, 59, 59, 999);
    periodLabel = `${year}`;
  } else {
    datStart = qStart; datEnd = qEnd;
    periodLabel = `${quarterLabel(q)} ${year}`;
  }

  try {
    // Rows shown on screen / used for the DAT file follow the selected period.
    const rows = await buildQAPRows(biz, datStart, datEnd);
    _qapRows = rows;

    if (!rows.length) {
      outputEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><h3>No EWT Transactions Found</h3>
        <p>No purchase invoices or payments with EWT tax codes matched for ${escHtml(periodLabel)}.</p></div>`;
      document.getElementById('qap-excel').style.display = 'none';
      document.getElementById('qap-dat').style.display   = 'none';
      return;
    }

    renderQAPTable(outputEl, rows, periodLabel, setup);

    document.getElementById('qap-excel').style.display = ptype === 'quarterly' ? '' : 'none';
    document.getElementById('qap-dat').style.display    = '';
    if (ptype === 'quarterly') {
      document.getElementById('qap-excel').onclick = () => exportQAPExcel(rows, periodLabel, setup, qEnd, formType);
      document.getElementById('qap-dat').onclick   = () => exportQAPDat(rows, setup, datEnd, formType);
    } else {
      document.getElementById('qap-dat').onclick = () => exportQAPDatSimple(rows, setup, datStart, datEnd, formType, ptype);
    }

  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ── RENDER TABLE ──────────────────────────────────────────────
function renderQAPTable(el, rows, periodLabel, setup) {
  let totBase = 0, totEwt = 0;
  rows.forEach(r => { totBase += r.base; totEwt += r.ewt; });

  el.innerHTML = `
    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">Payees / ATC Lines</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Total Income Payments</div><div class="stat-value small">₱ ${fmt(totBase)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Tax Withheld</div><div class="stat-value small">₱ ${fmt(totEwt)}</div></div>
    </div>
    <div style="font-size:12px;color:#374151;margin:6px 0;">${escHtml(periodLabel)}</div>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Payee TIN</th><th>Registered Name / Payee</th><th>ATC</th><th>Nature of Income Payment</th>
          <th class="num">Rate</th><th class="num">Income Payment (Tax Base)</th><th class="num">Tax Withheld</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const s = _qapSuppMap[r.suppKey] || {};
            const name = s.companyName || [s.lastName, [s.firstName, s.middleName].filter(Boolean).join(' ')].filter(Boolean).join(', ') || s.name || r.suppKey;
            return `<tr>
              <td style="font-family:monospace;">${escHtml(s.tin ? tinDashed(s.tin) : '')}</td>
              <td>${escHtml(name)}</td>
              <td>${escHtml(r.atc)}</td>
              <td>${escHtml(r.desc)}</td>
              <td class="num">${r.rate}%</td>
              <td class="num">${fmt(r.base)}</td>
              <td class="num">${fmt(r.ewt)}</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="5" style="font-weight:700;">TOTALS</td>
          <td class="num">${fmt(totBase)}</td>
          <td class="num">${fmt(totEwt)}</td>
        </tr></tfoot>
      </table>
    </div>`;
}

// ── EXCEL EXPORT (QAP file structure per Annex A) ───────────────
// One row per payee/ATC detail, matching the DSAWT detail record layout:
// SEQUENCE_NUM, EMPLOYER_TIN, EMPLOYER_BRANCH_CODE, REGISTERED_NAME,
// LAST_NAME, FIRST_NAME, MIDDLE_NAME, RETRN_PERIOD, NATURE_INCOME,
// ATC_CODE, TAX_RATE, INCOME_PAYMENT, ACTUAL_AMT_WTHLD
function exportQAPExcel(rows, periodLabel, setup, periodEnd, formType) {
  if (!window.XLSX) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => exportQAPExcel(rows, periodLabel, setup, periodEnd, formType);
    document.head.appendChild(s); return;
  }

  const qEndMonthName = periodEnd ? monthName(periodEnd.getMonth()).toUpperCase() : '';
  const year = periodEnd ? periodEnd.getFullYear() : '';
  const agentName = (setup.companyName || setup.taxpayerName || '').toUpperCase();

  const sheetTitle = [
    ['Attachment to BIR Form 1601-EQ'],
    ['QUARTERLY ALPHABETICAL LIST OF PAYEES SUBJECTED TO EXPANDED WITHHOLDING TAX & PAYEES WHOSE INCOME PAYMENTS ARE EXEMPT '],
    [`FOR THE QUARTER ENDING ${qEndMonthName}, ${year}`],
    [`TIN : ${tinDashed(setup.tin)}-0000`],
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

  const data = [...sheetTitle];

  let totBase = 0, totEwt = 0;
  rows.forEach((r, i) => {
    const s = _qapSuppMap[r.suppKey] || {};
    const isIndividual = !s.companyName && (s.lastName || s.firstName);
    const corpName = isIndividual ? '' : (s.companyName || s.name || '').toUpperCase().padEnd(50, ' ');
    const indName  = isIndividual
      ? [s.lastName, s.firstName, s.middleName].filter(Boolean).join(', ').toUpperCase().padEnd(50, ' ')
      : ''.padEnd(50, ' ');

    const m = r.months || [{base:0,ewt:0},{base:0,ewt:0},{base:0,ewt:0}];
    totBase += r.base; totEwt += r.ewt;

    data.push([
      i + 1,
      `${tinDashed(s.tin)}-${(s.branchCode || '0001')}`,
      corpName,
      indName,
      r.atc,
      r.desc,
      Number(m[0].base.toFixed(2)), r.rate, Number(m[0].ewt.toFixed(2)),
      Number(m[1].base.toFixed(2)), r.rate, Number(m[1].ewt.toFixed(2)),
      Number(m[2].base.toFixed(2)), r.rate, Number(m[2].ewt.toFixed(2)),
      Number(r.base.toFixed(2)), Number(r.ewt.toFixed(2)),
    ]);
  });

  data.push([
    '', '', '', '', '', 'Grand Total :',
    '', '', '', '', '', '', '', '', '',
    Number(totBase.toFixed(2)), Number(totEwt.toFixed(2)),
  ]);
  data.push(['------------------']);
  data.push(['==================']);
  data.push(['END OF REPORT']);

  const ws1 = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Sheet1');

  // Sheet2 / Sheet3 — placeholders for payees whose income payments are exempt
  // and other schedules per RMC Annex A, structured similarly to Sheet1.
  const exemptTitle = [
    ['Attachment to BIR Form 1601-EQ'],
    ['QUARTERLY ALPHABETICAL LIST OF PAYEES WHOSE INCOME PAYMENTS ARE EXEMPT FROM WITHHOLDING TAX'],
    [`FOR THE QUARTER ENDING ${qEndMonthName}, ${year}`],
    [`TIN : ${tinDashed(setup.tin)}-0000`],
    [`WITHHOLDING AGENT'S NAME: ${agentName}`],
    [],
    [
      'SEQ NO', 'TAXPAYER IDENTIFICATION NUMBER', 'CORPORATION (Registered Name)',
      'INDIVIDUAL (Last Name, First Name, Middle Name)', 'ATC CODE', 'NATURE OF PAYMENT',
      'AMOUNT OF INCOME PAYMENT EXEMPT',
    ],
    [],
    ['Grand Total :', '', '', '', '', '', 0],
    ['------------------'],
    ['=================='],
    ['END OF REPORT'],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(exemptTitle);
  XLSX.utils.book_append_sheet(wb, ws2, 'Sheet2');
  const ws3 = XLSX.utils.aoa_to_sheet(exemptTitle);
  XLSX.utils.book_append_sheet(wb, ws3, 'Sheet3');

  XLSX.writeFile(wb, `QAP_${formType}_${periodLabel.replace(/[\s()–\/]/g,'_')}.xlsx`);
}

// ── DAT EXPORT (SAWT file structure per Annex A: Header / Details / Control) ──
// Format per real 1601EQ DAT sample, adapted for QAP (quarterly, 3 months/payee):
//   HQAP,H<formType>,<TIN9>,<branch4>,"<agent name>",<startMM/YYYY>,<RDO>
//   D1,<formType>,<seq>,<payeeTIN9>,<payeeBranch4>,"<payee name>",<lname>,<fname>,<mname>,<MM1/YYYY>,<ATC>,<rate>,<amt1>,<tax1>,<MM2/YYYY>,<amt2>,<tax2>,<MM3/YYYY>,<amt3>,<tax3>
//   C1,<formType>,<TIN9>,<branch4>,<endMM/YYYY>,<totalAmount>,<totalTax>
// BIR's Validation Module rejects DAT files with missing/invalid payee TINs
// (defaults to 000000000) or branch codes — warn before exporting.
function validateQAPDat(rows) {
  const problems = [];
  rows.forEach(r => {
    const s = _qapSuppMap[r.suppKey] || {};
    const name = s.companyName || s.name || r.suppKey;
    const digits = (s.tin || '').replace(/\D/g, '');
    const issues = [];
    if (digits.length !== 9) issues.push('missing/invalid TIN');
    if (!/^\d{4}$/.test(s.branchCode || '')) issues.push('missing/invalid branch code');
    if (issues.length) problems.push(`${name}: ${issues.join(', ')}`);
  });
  if (!problems.length) return true;
  return confirm(
    `Warning: the following payees have data issues that may cause BIR Validation Module errors:\n\n` +
    problems.join('\n') +
    `\n\nThese will be exported as 000000000 / 0001. Continue generating the DAT file anyway?`
  );
}

function exportQAPDat(rows, setup, periodEnd, formType) {
  if (!validateQAPDat(rows)) return;
  const ourTin = tin9(setup.tin);
  const rdo    = (setup.rdoCode || '').padStart(3, '0').substring(0, 3);

  const qEnd = periodEnd ? periodEnd : new Date();
  const qStart = new Date(qEnd.getFullYear(), qEnd.getMonth() - 2, 1);
  const monthsInQ = [0, 1, 2].map(i => {
    const d = new Date(qStart.getFullYear(), qStart.getMonth() + i, 1);
    return `${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  });
  const periodStart = monthsInQ[0];
  const periodEndStr = monthsInQ[2];

  const agentName = stripSpecial(setup.companyName || setup.taxpayerName || '').toUpperCase();

  const lines = [];

  // Header record
  lines.push([
    'HQAP', `H${formType}`, ourTin, '0000', `"${agentName}"`, periodStart, rdo,
  ].join(','));

  let totBase = 0, totEwt = 0;

  // Detail records
  rows.forEach((r, i) => {
    const s = _qapSuppMap[r.suppKey] || {};
    const m = r.months || [{base:0,ewt:0},{base:0,ewt:0},{base:0,ewt:0}];
    totBase += r.base; totEwt += r.ewt;
    const corpName = stripSpecial(s.companyName || (!s.lastName && !s.firstName ? s.name : '') || '').toUpperCase();
    const ln = stripSpecial(s.lastName || '').toUpperCase();
    const fn = stripSpecial(s.firstName || '').toUpperCase();
    const mn = stripSpecial(s.middleName || '').toUpperCase();
    lines.push([
      'D1', formType,
      i + 1,
      tin9(s.tin),
      (s.branchCode || '0001'),
      qd(corpName), qd(ln), qd(fn), qd(mn),
      monthsInQ[0], r.atc, r.rate.toFixed(2), csvNum(m[0].base), csvNum(m[0].ewt),
      monthsInQ[1], csvNum(m[1].base), csvNum(m[1].ewt),
      monthsInQ[2], csvNum(m[2].base), csvNum(m[2].ewt),
    ].join(','));
  });

  // Control record
  lines.push([
    'C1', formType, ourTin, '0000', periodEndStr, csvNum(totBase), csvNum(totEwt),
  ].join(','));

  const content = lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/plain' });
  const periodTag = `${String(qEnd.getMonth()+1).padStart(2,'0')}${qEnd.getFullYear()}`;
  const fname = `${ourTin}0000${periodTag}${formType}.DAT`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fname });
  a.click(); URL.revokeObjectURL(a.href);
}

// DAT export for a single period (one month, or a full year) with no
// 3-month breakdown — used when the QAP filter is set to Monthly or Annual,
// since BIR eSubmission expects per-month detail rather than the quarterly
// Annex A layout.
function exportQAPDatSimple(rows, setup, periodStart, periodEnd, formType, ptype) {
  if (!validateQAPDat(rows)) return;
  const ourTin = tin9(setup.tin);
  const rdo    = (setup.rdoCode || '').padStart(3, '0').substring(0, 3);

  const startStr = `${String(periodStart.getMonth()+1).padStart(2,'0')}/${periodStart.getFullYear()}`;
  const endStr   = `${String(periodEnd.getMonth()+1).padStart(2,'0')}/${periodEnd.getFullYear()}`;

  const agentName = stripSpecial(setup.companyName || setup.taxpayerName || '').toUpperCase();

  const lines = [];

  // Header record
  lines.push([
    'HQAP', `H${formType}`, ourTin, '0000', `"${agentName}"`, startStr, rdo,
  ].join(','));

  let totBase = 0, totEwt = 0;

  // Detail records — one period (no monthly breakdown)
  rows.forEach((r, i) => {
    const s = _qapSuppMap[r.suppKey] || {};
    totBase += r.base; totEwt += r.ewt;
    const corpName = stripSpecial(s.companyName || (!s.lastName && !s.firstName ? s.name : '') || '').toUpperCase();
    const ln = stripSpecial(s.lastName || '').toUpperCase();
    const fn = stripSpecial(s.firstName || '').toUpperCase();
    const mn = stripSpecial(s.middleName || '').toUpperCase();
    lines.push([
      'D1', formType,
      i + 1,
      tin9(s.tin),
      (s.branchCode || '0001'),
      qd(corpName), qd(ln), qd(fn), qd(mn),
      ptype === 'annual' ? endStr : startStr, r.atc, r.rate.toFixed(2), csvNum(r.base), csvNum(r.ewt),
    ].join(','));
  });

  // Control record
  lines.push([
    'C1', formType, ourTin, '0000', endStr, csvNum(totBase), csvNum(totEwt),
  ].join(','));

  const content = lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/plain' });
  const periodTag = ptype === 'annual'
    ? `${periodEnd.getFullYear()}`
    : `${String(periodStart.getMonth()+1).padStart(2,'0')}${periodStart.getFullYear()}`;
  const fname = `${ourTin}0000${periodTag}${formType}.DAT`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fname });
  a.click(); URL.revokeObjectURL(a.href);
}

// ── HELPERS shared with sls-report.js conventions ────────────
function tin9(t) {
  const digits = (t || '').replace(/\D/g, '');
  return (digits.substring(0, 9) || '').padEnd(9, '0').substring(0, 9) || '000000000';
}

function csvNum(n) {
  return (Number(n) || 0).toFixed(2);
}

// D1 detail rows leave blank fields fully empty (no quotes); only quote when present.
function qd(v) {
  return v ? `"${v}"` : '';
}

// BIR's Validation Module rejects names/addresses containing special characters
// (commas break its naive comma-split parsing; other symbols like ()*&^%$#@! fail
// its field validation outright). Keep letters, digits, spaces, period, hyphen, slash.
function stripSpecial(v) {
  return (v || '').replace(/[^A-Za-z0-9\s.\-\/]/g, '');
}

function tinDashed(t) {
  const d = (t || '').replace(/\D/g, '').padEnd(9, '0').substring(0, 9);
  return `${d.substring(0,3)}-${d.substring(3,6)}-${d.substring(6,9)}`;
}
