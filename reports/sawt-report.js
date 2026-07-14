/* ============================================================
   Tallo CPA – BIR Tax App
   sawt-report.js  –  Summary Alphalist of Withholding Taxes (SAWT)
                       Attachment to BIR Forms 1701Q/1702Q/2550Q —
                       creditable EWT withheld BY CUSTOMERS on our
                       sales invoices/receipts (mirrors qap-report.js,
                       which covers EWT WE withhold from suppliers).
   ============================================================ */

let _sawtCustMap = {};

async function initSAWTReport() {
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

  _sawtCustMap = await loadPartyBIR(biz, 'customer');

  filterEl.innerHTML = `
    <div class="filter-bar">
      <label>SAWT Form</label>
      <select id="sawt-form">
        <option value="1700">1700</option>
        <option value="1701Q">1701Q</option>
        <option value="1701">1701</option>
        <option value="1702Q" selected>1702Q</option>
        <option value="1702">1702</option>
        <option value="2550M">2550M</option>
        <option value="2550Q">2550Q</option>
        <option value="2551Q">2551Q</option>
        <option value="2553">2553</option>
      </select>
      <label>Period</label>
      <select id="sawt-ptype">
        <option value="quarterly">Quarterly</option>
        <option value="monthly">Monthly</option>
        <option value="annual">Annual</option>
      </select>
      <span id="sawt-qwrap">
        <label>Quarter</label>
        <select id="sawt-quarter">
          ${[1,2,3,4].map(q=>`<option value="${q}"${q===curQ?' selected':''}>${quarterLabel(q)}</option>`).join('')}
        </select>
      </span>
      <span id="sawt-mwrap" style="display:none;">
        <label>Month</label>
        <select id="sawt-month">
          ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m=>`<option value="${m}"${m===now.getMonth()?' selected':''}>${monthName(m)}</option>`).join('')}
        </select>
      </span>
      <label>Year</label>
      <select id="sawt-year">
        ${years.map(y=>`<option value="${y}"${y===curY?' selected':''}>${y}</option>`).join('')}
      </select>
      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="sawt-gen">⚡ Generate</button>
      <button class="btn btn-outline" id="sawt-excel" style="display:none;">📥 Excel (SAWT)</button>
      <button class="btn btn-outline" id="sawt-dat"   style="display:none;">📄 DAT File</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin||'—')}</strong>
    </div>
    <div id="sawt-period-note" style="font-size:11px;color:#9ca3af;margin-top:2px;display:none;"></div>`;

  function syncPeriodWidgets() {
    const ptype = document.getElementById('sawt-ptype').value;
    const isM = ptype === 'monthly';
    const isA = ptype === 'annual';
    document.getElementById('sawt-qwrap').style.display = isM || isA ? 'none' : '';
    document.getElementById('sawt-mwrap').style.display = isM ? '' : 'none';
  }

  // BIR's own form-selection menu implies a fixed filing frequency per form
  // (monthly: 2550M; quarterly: 1701Q/1702Q/2550Q/2551Q; annual: the rest)
  // — auto-select the matching period type so the report period always
  // matches what that BIR form actually requires.
  const FORM_PERIODICITY = {
    '2550M': 'monthly',
    '1701Q': 'quarterly', '1702Q': 'quarterly', '2550Q': 'quarterly', '2551Q': 'quarterly',
    '1700': 'annual', '1701': 'annual', '1702': 'annual', '2553': 'annual',
  };
  document.getElementById('sawt-form').addEventListener('change', function () {
    const p = FORM_PERIODICITY[this.value];
    if (p) {
      document.getElementById('sawt-ptype').value = p;
      syncPeriodWidgets();
    }
  });

  document.getElementById('sawt-ptype').addEventListener('change', syncPeriodWidgets);
  syncPeriodWidgets();

  document.getElementById('sawt-gen').addEventListener('click', () => generateSAWT(biz, setup, outputEl));

  // Pre-fill from URL query params (?form=&ptype=&period=&year=) when embedded
  // by a workflow step that already collected the form/period, and auto-run.
  const qs = new URLSearchParams(location.search);
  const qForm = qs.get('form');
  if (qForm) document.getElementById('sawt-form').value = qForm;
  const qPtype = qs.get('ptype');
  if (qPtype) {
    document.getElementById('sawt-ptype').value = qPtype;
    syncPeriodWidgets();
    const qYear = qs.get('year');
    if (qYear) document.getElementById('sawt-year').value = qYear;
    const qPeriod = qs.get('period');
    if (qPeriod != null) {
      if (qPtype === 'monthly') document.getElementById('sawt-month').value = qPeriod;
      else if (qPtype === 'quarterly') document.getElementById('sawt-quarter').value = qPeriod;
    }
    document.getElementById('sawt-gen').click();
  }

  // Customers quick-edit tab — mirrors QAP's Suppliers tab
  let customerController = null;
  document.getElementById('sawt-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn'); if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('#sawt-tabs .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === 'customers') {
      const container = document.getElementById('tab-customers');
      if (!customerController) customerController = CF.mountParty(container, 'customer');
      customerController.refresh().then(() => filterCustomerTabToPeriod(container));
    }
  });
}

// Hide customers with no EWT transactions in the currently-generated SAWT
// period, so the tab only shows the customers relevant to that period.
let _sawtRows = [];
function filterCustomerTabToPeriod(container) {
  if (!_sawtRows.length) return;
  const keys = new Set(_sawtRows.map(r => r.custKey).filter(Boolean));
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
// Returns flat array of detail rows: one per customer per ATC, with
// totals for the quarter (income payment / tax base + tax withheld).
// Mirrors buildQAPRows in qap-report.js, but sources sales invoices and
// receipts (customer side) instead of purchase invoices and payments.
async function buildSAWTRows(biz, start, end) {
  const customAtcMap = loadAtcMapping();
  const [invItems, receiptItems, { tcKeyToAtc, taxCodes }] = await Promise.all([
    fetchAllBatch('/api4/sales-invoice-batch', biz),
    fetchAllBatch('/api4/receipt-batch', biz),
    getEwtTcMap(biz),
  ]);
  const tcNameByKey = {};
  const rateByKey = {};
  taxCodes.forEach(tc => { tcNameByKey[tc.key] = tc.name; rateByKey[tc.key] = tc.rate; });

  const items = [...invItems, ...receiptItems];
  // key = customerKey|atc
  const agg = {};

  for (const { item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const ewtLines = extractEWT(item, customAtcMap, tcNameByKey, rateByKey, tcKeyToAtc);
    if (!ewtLines.length) continue;

    const custKey = item?.customer || item?.Customer || '';
    if (!custKey) continue;

    const monthIdx = Math.max(0, Math.min(2, new Date(date).getMonth() - start.getMonth()));

    ewtLines.forEach(line => {
      const k = `${custKey}|${line.atc}`;
      if (!agg[k]) {
        agg[k] = { custKey, atc: line.atc, desc: line.desc, rate: line.rate, base: 0, ewt: 0,
          months: [ { base: 0, ewt: 0 }, { base: 0, ewt: 0 }, { base: 0, ewt: 0 } ] };
      }
      agg[k].base += line.base;
      agg[k].ewt  += line.ewt;
      agg[k].months[monthIdx].base += line.base;
      agg[k].months[monthIdx].ewt  += line.ewt;
    });
  }

  return Object.values(agg).sort((a, b) => {
    const an = _sawtCustMap[a.custKey]?.name || a.custKey;
    const bn = _sawtCustMap[b.custKey]?.name || b.custKey;
    return an.localeCompare(bn) || a.atc.localeCompare(b.atc);
  });
}

async function generateSAWT(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;

  const ptypeEl  = document.getElementById('sawt-ptype');
  const ptype    = ptypeEl ? ptypeEl.value : 'quarterly';
  const year     = parseInt(document.getElementById('sawt-year').value, 10);
  const formType = document.getElementById('sawt-form')?.value || '1702Q';

  const q = ptype === 'monthly'
    ? Math.ceil((parseInt(document.getElementById('sawt-month').value, 10) + 1) / 3)
    : parseInt(document.getElementById('sawt-quarter').value, 10);

  // Both the Excel report and the DAT file follow the same selected period
  // (a single month, a full quarter, or the full year) — matching the
  // official BIR Alphalist app, which only ever generates one period at a time.
  let datStart, datEnd, periodLabel;
  if (ptype === 'monthly') {
    const month = parseInt(document.getElementById('sawt-month').value, 10);
    ({ start: datStart, end: datEnd } = getPeriodDates('monthly', month, year));
    periodLabel = `${monthName(month)} ${year}`;
  } else if (ptype === 'annual') {
    datStart = new Date(year, 0, 1);
    datEnd   = new Date(year, 11, 31, 23, 59, 59, 999);
    periodLabel = `${year}`;
  } else {
    ({ start: datStart, end: datEnd } = getPeriodDates('quarterly', q, year));
    periodLabel = `${quarterLabel(q)} ${year}`;
  }

  try {
    // Rows shown on screen / used for the DAT file follow the selected period.
    const allRows = await buildSAWTRows(biz, datStart, datEnd);
    // Each SAWT form only reports a specific category of ATC: 17XX forms
    // (1700/1701/1701Q/1702/1702Q) are creditable EWT on income payments
    // (WI/WC/WI250/WC250 ATCs); 25XX forms (2550M/2550Q/2551Q/2553) are
    // final withholding VAT or percentage tax (WV/WB ATCs).
    const isIncomeForm = !/^25/.test(formType);
    const rows = allRows.filter(r => isIncomeForm ? !/^W[VB]/.test(r.atc) : /^W[VB]/.test(r.atc));
    _sawtRows = rows;

    if (!rows.length) {
      outputEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><h3>No EWT Transactions Found</h3>
        <p>No sales invoices or receipts with EWT tax codes matched for ${escHtml(periodLabel)} under form ${escHtml(formType)}.</p></div>`;
      document.getElementById('sawt-excel').style.display = 'none';
      document.getElementById('sawt-dat').style.display   = 'none';
      return;
    }

    renderSAWTTable(outputEl, rows, periodLabel, setup);

    document.getElementById('sawt-excel').style.display = '';
    document.getElementById('sawt-dat').style.display    = '';
    document.getElementById('sawt-excel').onclick = () => exportSAWTExcel(rows, periodLabel, setup, datStart, datEnd, formType);
    if (ptype === 'quarterly') {
      // SAWT is filed per month, so a quarterly view produces one DAT file per
      // month of the quarter (not one file spanning the quarter). Each SAWT row
      // already carries a per-month breakdown in r.months[0..2] aligned to the
      // quarter's three months; re-use the single-period exporter for each.
      document.getElementById('sawt-dat').onclick = () => {
        const qStartMonth = datStart.getMonth();
        for (let i = 0; i < 3; i++) {
          const mStart = new Date(year, qStartMonth + i, 1);
          const mEnd   = new Date(year, qStartMonth + i + 1, 0, 23, 59, 59, 999);
          const mRows  = rows
            .map(r => ({ ...r, base: r.months[i].base, ewt: r.months[i].ewt }))
            .filter(r => Math.abs(r.ewt) > 0.005 || Math.abs(r.base) > 0.005);
          if (!mRows.length) continue; // skip a month with no EWT (same as SLS/SLP)
          exportSAWTDatSimple(mRows, setup, mStart, mEnd, formType, 'monthly');
        }
      };
    } else {
      document.getElementById('sawt-dat').onclick = () => exportSAWTDatSimple(rows, setup, datStart, datEnd, formType, ptype);
    }

  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ── RENDER TABLE ──────────────────────────────────────────────
function renderSAWTTable(el, rows, periodLabel, setup) {
  let totBase = 0, totEwt = 0;
  rows.forEach(r => { totBase += r.base; totEwt += r.ewt; });

  el.innerHTML = `
    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">Customers / ATC Lines</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Total Income Payments</div><div class="stat-value small">₱ ${fmt(totBase)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Tax Withheld</div><div class="stat-value small">₱ ${fmt(totEwt)}</div></div>
    </div>
    <div style="font-size:12px;color:#374151;margin:6px 0;">${escHtml(periodLabel)}</div>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Customer TIN</th><th>Registered Name / Customer</th><th>ATC</th><th>Nature of Income Payment</th>
          <th class="num">Rate</th><th class="num">Income Payment (Tax Base)</th><th class="num">Tax Withheld</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const c = _sawtCustMap[r.custKey] || {};
            const name = c.companyName || [c.lastName, [c.firstName, c.middleName].filter(Boolean).join(' ')].filter(Boolean).join(', ') || c.name || r.custKey;
            return `<tr>
              <td style="font-family:monospace;">${escHtml(c.tin ? tinDashed(c.tin) : '')}</td>
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

// ── EXCEL EXPORT (SAWT file structure per Annex A) ───────────────
// One row per customer/ATC detail, matching the DSAWT detail record layout:
// SEQUENCE_NUM, EMPLOYER_TIN, EMPLOYER_BRANCH_CODE, REGISTERED_NAME,
// LAST_NAME, FIRST_NAME, MIDDLE_NAME, RETRN_PERIOD, NATURE_INCOME,
// ATC_CODE, TAX_RATE, INCOME_PAYMENT, ACTUAL_AMT_WTHLD
// Layout matches the official BIR Alphalist app's SAWT Excel export exactly:
// one row per payee/ATC for the whole selected period (no monthly breakdown).
function exportSAWTExcel(rows, periodLabel, setup, periodStart, periodEnd, formType) {
  if (!window.XLSX) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => exportSAWTExcel(rows, periodLabel, setup, periodStart, periodEnd, formType);
    document.head.appendChild(s); return;
  }

  const payeeName = (setup.companyName || setup.taxpayerName || '').toUpperCase();
  const sameMonth = periodStart.getMonth() === periodEnd.getMonth() && periodStart.getFullYear() === periodEnd.getFullYear();
  const periodTitle = sameMonth
    ? `FOR THE MONTH OF ${monthName(periodStart.getMonth()).toUpperCase()}, ${periodStart.getFullYear()}`
    : `FOR THE PERIOD ${monthName(periodStart.getMonth()).toUpperCase()} ${periodStart.getFullYear()} TO ${monthName(periodEnd.getMonth()).toUpperCase()} ${periodEnd.getFullYear()}`;

  const sheetTitle = [
    [`BIR FORM ${formType}`],
    ['SUMMARY ALPHALIST OF WITHHOLDING TAXES (SAWT)'],
    [periodTitle],
    [],
    [],
    [`TIN : ${tinDashed(setup.tin)}-0000`],
    [`PAYEE'S NAME: ${payeeName}`],
    [],
    [],
    [],
    ['SEQ', 'TAXPAYER', 'CORPORATION', 'INDIVIDUAL', 'ATC CODE', 'NATURE OF PAYMENT', 'AMOUNT OF', 'TAX RATE', 'AMOUNT OF'],
    ['NO', 'IDENTIFICATION', '(Registered Name)', '(Last Name, First Name, Middle Name)', '', '', 'INCOME PAYMENT', '', 'TAX WITHHELD'],
    ['', 'NUMBER', '', '', '', '', '', '', ''],
    ['(1)', '(2)', '(3)', '(4)', '(5)', '', '(6)', '(7)', '(8)'],
    ['------------------------------', '------------------------------', '------------------------------', '------------------------------', '------------------------------', '------------------------------', '------------------------------', '------------------------------', '------------------------------'],
  ];

  const data = [...sheetTitle];

  let totBase = 0, totEwt = 0;
  rows.forEach((r, i) => {
    const c = _sawtCustMap[r.custKey] || {};
    const isIndividual = !c.companyName && (c.lastName || c.firstName);
    const corpName = isIndividual ? '' : (c.companyName || c.name || '').toUpperCase();
    const indName  = isIndividual
      ? [c.lastName, [c.firstName, c.middleName].filter(Boolean).join(' ')].filter(Boolean).join(', ').toUpperCase()
      : '';

    totBase += r.base; totEwt += r.ewt;

    data.push([
      i + 1,
      `${tinDashed(c.tin)}-${(c.branchCode || '0001')}`,
      corpName,
      indName,
      r.atc,
      r.desc,
      Number(r.base.toFixed(2)), r.rate, Number(r.ewt.toFixed(2)),
    ]);
  });

  const headerRowIdxs = [10, 11];
  data.push(['', '', '', '', '', '', '------------------', '------------------', '------------------']);
  const grandTotalRowIdx = data.length;
  data.push(['Grand Total :', 0, '', '', '', '', Number(totBase.toFixed(2)), '', Number(totEwt.toFixed(2))]);
  data.push(['', '', '', '', '', '', '==================', '==================', '==================']);
  data.push(['END OF REPORT']);

  const ws1 = XLSX.utils.aoa_to_sheet(data);
  const boldRange = (rowIdx) => {
    const row = data[rowIdx];
    for (let c = 0; c < row.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
      if (!ws1[addr]) continue;
      ws1[addr].s = { font: { bold: true } };
    }
  };
  headerRowIdxs.forEach(boldRange);
  boldRange(grandTotalRowIdx);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Sheet1');

  XLSX.writeFile(wb, `SAWT_${formType}_${periodLabel.replace(/[\s()–\/]/g,'_')}.xlsx`, { cellStyles: true });
}

// ── DAT EXPORT (SAWT file structure per Annex A: Header / Details / Control) ──
// Format mirrors QAP's DAT structure, but for our customers' withholding on
// our sales rather than our withholding on suppliers' purchases:
//   HSAWT,H<formType>,<TIN9>,<branch4>,"<payee name>","<lname>","<fname>","<mname>",<endMM/YYYY>,<RDO>
//   DSAWT,D<formType>,<seq>,<custTIN9>,<custBranch4>,"<cust name>","<lname>","<fname>","<mname>",<MM/YYYY>,,<ATC>,<rate>,<amt>,<tax>
//   CSAWT,C<formType>,<TIN9>,<branch4>,<endMM/YYYY>,<totalAmount>,<totalTax>
// BIR's Validation Module rejects DAT files with missing/invalid customer TINs
// (defaults to 000000000) or branch codes — warn before exporting.
function validateSAWTDat(rows) {
  const problems = [];
  rows.forEach(r => {
    const c = _sawtCustMap[r.custKey] || {};
    const name = c.companyName || c.name || r.custKey;
    const digits = (c.tin || '').replace(/\D/g, '');
    const issues = [];
    if (digits.length !== 9) issues.push('missing/invalid TIN');
    if (!/^\d{4}$/.test(c.branchCode || '')) issues.push('missing/invalid branch code');
    if (issues.length) problems.push(`${name}: ${issues.join(', ')}`);
  });
  if (!problems.length) return true;
  return confirm(
    `Warning: the following customers have data issues that may cause BIR Validation Module errors:\n\n` +
    problems.join('\n') +
    `\n\nThese will be exported as 000000000 / 0001. Continue generating the DAT file anyway?`
  );
}

// Retained fallback: emits ONE quarterly SAWT DAT (whole quarter in a single
// file). No longer wired to the button — generateSAWT() now splits a quarter
// into three monthly DAT files via exportSAWTDatSimple. Kept so we can revert
// to single-file quarterly output if an RDO's eSubmission rejects monthly SAWT.
function exportSAWTDat(rows, setup, periodEnd, formType) {
  if (!validateSAWTDat(rows)) return;
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

  const payeeName = stripSpecial(setup.companyName || setup.taxpayerName || '').toUpperCase();
  const filerLn = stripSpecial(setup.lastName || '').toUpperCase();
  const filerFn = stripSpecial(setup.firstName || '').toUpperCase();
  const filerMn = stripSpecial(setup.middleName || '').toUpperCase();

  const lines = [];

  // Header record
  lines.push([
    'HSAWT', `H${formType}`, ourTin, '0000', `"${payeeName}"`, qd(filerLn) || '""', qd(filerFn) || '""', qd(filerMn) || '""', periodEndStr, rdo,
  ].join(','));

  let totBase = 0, totEwt = 0;

  // Detail records — one row per payee/ATC for the whole quarter (no monthly breakdown)
  rows.forEach((r, i) => {
    const c = _sawtCustMap[r.custKey] || {};
    totBase += r.base; totEwt += r.ewt;
    const corpName = stripSpecial(c.companyName || (!c.lastName && !c.firstName ? c.name : '') || '').toUpperCase();
    const ln = stripSpecial(c.lastName || '').toUpperCase();
    const fn = stripSpecial(c.firstName || '').toUpperCase();
    const mn = stripSpecial(c.middleName || '').toUpperCase();
    lines.push([
      'DSAWT', `D${formType}`,
      i + 1,
      tin9(c.tin),
      (c.branchCode || '0001'),
      qd(corpName), qd(ln), qd(fn), qd(mn),
      periodEndStr, '', r.atc, r.rate.toFixed(2), csvNum(r.base), csvNum(r.ewt),
    ].join(','));
  });

  // Control record
  lines.push([
    'CSAWT', `C${formType}`, ourTin, '0000', periodEndStr, csvNum(totBase), csvNum(totEwt),
  ].join(','));

  const content = lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/plain' });
  const periodTag = `${String(qEnd.getMonth()+1).padStart(2,'0')}${qEnd.getFullYear()}`;
  const fname = `${ourTin}0000${periodTag}${formType}.DAT`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fname });
  a.click(); URL.revokeObjectURL(a.href);
}

// DAT export for a single period (one month, or a full year) with no
// 3-month breakdown — used when the SAWT filter is set to Monthly or Annual.
function exportSAWTDatSimple(rows, setup, periodStart, periodEnd, formType, ptype) {
  if (!validateSAWTDat(rows)) return;
  const ourTin = tin9(setup.tin);
  const rdo    = (setup.rdoCode || '').padStart(3, '0').substring(0, 3);

  const startStr = `${String(periodStart.getMonth()+1).padStart(2,'0')}/${periodStart.getFullYear()}`;
  const endStr   = `${String(periodEnd.getMonth()+1).padStart(2,'0')}/${periodEnd.getFullYear()}`;

  const payeeName = stripSpecial(setup.companyName || setup.taxpayerName || '').toUpperCase();
  const filerLn = stripSpecial(setup.lastName || '').toUpperCase();
  const filerFn = stripSpecial(setup.firstName || '').toUpperCase();
  const filerMn = stripSpecial(setup.middleName || '').toUpperCase();

  const lines = [];

  // Header record
  lines.push([
    'HSAWT', `H${formType}`, ourTin, '0000', `"${payeeName}"`, qd(filerLn) || '""', qd(filerFn) || '""', qd(filerMn) || '""', endStr, rdo,
  ].join(','));

  let totBase = 0, totEwt = 0;

  // Detail records — one period (no monthly breakdown)
  rows.forEach((r, i) => {
    const c = _sawtCustMap[r.custKey] || {};
    totBase += r.base; totEwt += r.ewt;
    const corpName = stripSpecial(c.companyName || (!c.lastName && !c.firstName ? c.name : '') || '').toUpperCase();
    const ln = stripSpecial(c.lastName || '').toUpperCase();
    const fn = stripSpecial(c.firstName || '').toUpperCase();
    const mn = stripSpecial(c.middleName || '').toUpperCase();
    lines.push([
      'DSAWT', `D${formType}`,
      i + 1,
      tin9(c.tin),
      (c.branchCode || '0001'),
      qd(corpName), qd(ln), qd(fn), qd(mn),
      (ptype === 'annual' ? endStr : startStr), '', r.atc, r.rate.toFixed(2), csvNum(r.base), csvNum(r.ewt),
    ].join(','));
  });

  // Control record
  lines.push([
    'CSAWT', `C${formType}`, ourTin, '0000', endStr, csvNum(totBase), csvNum(totEwt),
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

// ── HELPERS shared with qap-report.js conventions ────────────
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
