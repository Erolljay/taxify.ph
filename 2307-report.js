/* ============================================================
   Tallo CPA – BIR Tax App
   2307-report.js  –  BIR Form 2307 Certificate of Creditable
                       Tax Withheld at Source, per-supplier,
                       generated from purchase invoices/payments
   ============================================================ */

let _f2307Setup = null;
let _f2307SuppMap = {};

function tinDashed(t) {
  const d = (t || '').replace(/\D/g, '').padEnd(9, '0').substring(0, 9);
  return `${d.substring(0,3)}-${d.substring(3,6)}-${d.substring(6,9)}`;
}

async function init2307Report() {
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
  _f2307Setup = setup;

  if (!setup) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Business info not configured. Fill in the <strong>Business</strong> tab in the Tallo CPA extension first.</div>`;
    return;
  }
  outputEl.innerHTML = '';

  const now  = new Date();
  const curQ = Math.ceil((now.getMonth() + 1) / 3);
  const curY = now.getFullYear();
  const years = [curY - 2, curY - 1, curY, curY + 1];

  _f2307SuppMap = await loadPartyBIR(biz, 'supplier');
  const suppOptions = Object.entries(_f2307SuppMap)
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
    .map(([key, s]) => `<option value="${escHtml(key)}">${escHtml(s.name)}</option>`).join('');

  const curM = now.getMonth() + 1;

  filterEl.innerHTML = `
    <div class="filter-bar">
      <label>Frequency</label>
      <select id="f2307-freq">
        <option value="quarterly">Quarterly</option>
        <option value="monthly">Monthly</option>
        <option value="transaction">Per Transaction</option>
      </select>
      <label id="f2307-quarter-lbl">Quarter</label>
      <select id="f2307-quarter">
        ${[1,2,3,4].map(q=>`<option value="${q}"${q===curQ?' selected':''}>${quarterLabel(q)}</option>`).join('')}
      </select>
      <label id="f2307-month-lbl" style="display:none;">Month</label>
      <select id="f2307-month" style="display:none;">
        ${[1,2,3,4,5,6,7,8,9,10,11,12].map(m=>`<option value="${m}"${m===curM?' selected':''}>${monthName(m)}</option>`).join('')}
      </select>
      <label>Year</label>
      <select id="f2307-year">
        ${years.map(y=>`<option value="${y}"${y===curY?' selected':''}>${y}</option>`).join('')}
      </select>
      <label>Supplier</label>
      <select id="f2307-supplier">
        <option value="__all__">All suppliers with EWT</option>
        ${suppOptions}
      </select>
      <div class="filter-sep"></div>
      <button class="btn btn-primary" id="f2307-gen">⚡ Generate</button>
      <button class="btn btn-outline" id="f2307-print" style="display:none;" onclick="window.print()">🖨 Print</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin||'—')}</strong>
    </div>`;

  document.getElementById('f2307-freq').addEventListener('change', e => {
    const freq = e.target.value;
    const showMonth = freq === 'monthly';
    document.getElementById('f2307-month-lbl').style.display = showMonth ? '' : 'none';
    document.getElementById('f2307-month').style.display = showMonth ? '' : 'none';
    document.getElementById('f2307-quarter-lbl').style.display = showMonth ? 'none' : '';
    document.getElementById('f2307-quarter').style.display = showMonth ? 'none' : '';
  });

  document.getElementById('f2307-gen').addEventListener('click', () => generate2307(biz, setup, outputEl));
}

// ── DATA AGGREGATION ─────────────────────────────────────────
// Build EWT rows per ATC per supplier for the quarter, split by month-in-quarter.
async function buildEWTBySupplier(biz, start, end) {
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
  // supplierKey -> { atc -> { atc, desc, rate, months:[base/ewt x3], totalBase, totalEwt } }
  const bySupplier = {};

  for (const { item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const ewtLines = extractEWT(item, customAtcMap, tcNameByKey, rateByKey, tcKeyToAtc);
    if (!ewtLines.length) continue;

    const suppKey = item?.supplier || item?.Supplier || '';
    if (!suppKey) continue;
    const mIdx = monthInQuarter(date);

    if (!bySupplier[suppKey]) bySupplier[suppKey] = {};
    const supATC = bySupplier[suppKey];

    ewtLines.forEach(line => {
      if (!supATC[line.atc]) {
        supATC[line.atc] = {
          atc: line.atc, desc: line.desc, rate: line.rate,
          months: [{ base: 0, ewt: 0 }, { base: 0, ewt: 0 }, { base: 0, ewt: 0 }],
          totalBase: 0, totalEwt: 0,
        };
      }
      const rec = supATC[line.atc];
      rec.months[mIdx].base += line.base;
      rec.months[mIdx].ewt  += line.ewt;
      rec.totalBase += line.base;
      rec.totalEwt  += line.ewt;
    });
  }

  return bySupplier;
}

// Build one EWT row-set per individual transaction (purchase invoice / payment).
// Returns array of { suppKey, date, ref, atcMap } — atcMap has the same shape
// as buildEWTBySupplier's per-supplier map, but for a single transaction.
async function buildEWTByTransaction(biz, start, end) {
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
  const out = [];

  for (const { item } of items) {
    const date = item?.issueDate || item?.Date;
    if (!inRange(date, start, end)) continue;
    const ewtLines = extractEWT(item, customAtcMap, tcNameByKey, rateByKey, tcKeyToAtc);
    if (!ewtLines.length) continue;

    const suppKey = item?.supplier || item?.Supplier || '';
    if (!suppKey) continue;
    const ref = item?.reference || item?.Reference || item?.invoiceNumber || item?.InvoiceNumber || '';
    const mIdx = monthInQuarter(date);

    const atcMap = {};
    ewtLines.forEach(line => {
      const months = [{ base: 0, ewt: 0 }, { base: 0, ewt: 0 }, { base: 0, ewt: 0 }];
      months[mIdx] = { base: line.base, ewt: line.ewt };
      atcMap[line.atc] = { atc: line.atc, desc: line.desc, rate: line.rate, months, totalBase: line.base, totalEwt: line.ewt };
    });

    out.push({ suppKey, date, ref, atcMap });
  }

  return out;
}

async function generate2307(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching transactions…</span></div>`;

  const freq = document.getElementById('f2307-freq').value;
  const year = parseInt(document.getElementById('f2307-year').value, 10);
  const suppSel = document.getElementById('f2307-supplier').value;

  let start, end, periodLabel;
  if (freq === 'monthly') {
    const month = parseInt(document.getElementById('f2307-month').value, 10);
    ({ start, end } = getPeriodDates('monthly', month, year));
    periodLabel = `${monthName(month)} ${year}`;
  } else {
    const q = parseInt(document.getElementById('f2307-quarter').value, 10);
    ({ start, end } = getPeriodDates('quarterly', q, year));
    periodLabel = `${quarterLabel(q)} ${year}`;
  }

  try {
    if (freq === 'transaction') {
      let txns = await buildEWTByTransaction(biz, start, end);
      if (suppSel !== '__all__') txns = txns.filter(t => t.suppKey === suppSel);
      txns.sort((a, b) => new Date(a.date) - new Date(b.date) || (_f2307SuppMap[a.suppKey]?.name || '').localeCompare(_f2307SuppMap[b.suppKey]?.name || ''));

      if (!txns.length) {
        outputEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><h3>No EWT Transactions Found</h3>
          <p>No purchase invoices or payments with EWT tax codes matched for ${escHtml(periodLabel)}${suppSel!=='__all__' ? ' for the selected supplier' : ''}.</p></div>`;
        document.getElementById('f2307-print').style.display = 'none';
        return;
      }

      outputEl.innerHTML = txns.map(t => {
        const d = new Date(t.date);
        const txnLabel = t.ref ? `${fmtDateMDY(d)} — ${escHtml(t.ref)}` : fmtDateMDY(d);
        return renderCertificate(t.suppKey, t.atcMap, d, d, setup, txnLabel);
      }).join('');

      document.getElementById('f2307-print').style.display = '';
      return;
    }

    const bySupplier = await buildEWTBySupplier(biz, start, end);

    let supplierKeys = Object.keys(bySupplier);
    if (suppSel !== '__all__') {
      supplierKeys = supplierKeys.filter(k => k === suppSel);
    }

    if (!supplierKeys.length) {
      outputEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><h3>No EWT Transactions Found</h3>
        <p>No purchase invoices or payments with EWT tax codes matched for ${escHtml(periodLabel)}${suppSel!=='__all__' ? ' for the selected supplier' : ''}.</p></div>`;
      document.getElementById('f2307-print').style.display = 'none';
      return;
    }

    supplierKeys.sort((a, b) => (_f2307SuppMap[a]?.name || a).localeCompare(_f2307SuppMap[b]?.name || b));

    outputEl.innerHTML = supplierKeys.map(sk => renderCertificate(sk, bySupplier[sk], start, end, setup, periodLabel)).join('');

    document.getElementById('f2307-print').style.display = '';
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ── RENDER ONE CERTIFICATE ───────────────────────────────────
function renderCertificate(suppKey, atcMap, start, end, setup, periodLabel) {
  const supp = _f2307SuppMap[suppKey] || {};
  const payeeName = supp.companyName ||
    [supp.lastName, [supp.firstName, supp.middleName].filter(Boolean).join(' ')].filter(Boolean).join(', ') ||
    supp.name || suppKey;
  const payeeTin  = supp.tin ? tinDashed(supp.tin) : '— — — — — — — — —';
  const payeeAddr = [supp.address1, supp.address2].filter(Boolean).join(', ') || '—';

  const ownerIsInd = setup.classification === 'Individual';
  const payorName = ownerIsInd
    ? [setup.lastName, [setup.firstName, setup.middleName].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '—');
  const payorTin  = setup.tin ? tinDashed(setup.tin) : '— — — — — — — — —';
  const payorAddr = setup.address || '—';

  const rows = Object.values(atcMap).sort((a, b) => a.atc.localeCompare(b.atc));
  let totM = [0,0,0], totEwtQ = 0, totBaseAll = 0;

  const bodyRows = rows.map(r => {
    const m1 = r.months[0], m2 = r.months[1], m3 = r.months[2];
    const total = m1.base + m2.base + m3.base;
    totM[0] += m1.base; totM[1] += m2.base; totM[2] += m3.base;
    totEwtQ += r.totalEwt; totBaseAll += total;
    return `<tr>
      <td class="left">${escHtml(r.desc)}</td>
      <td class="center">${escHtml(r.atc)}</td>
      <td>${m1.base ? fmt(m1.base) : '—'}</td>
      <td>${m2.base ? fmt(m2.base) : '—'}</td>
      <td>${m3.base ? fmt(m3.base) : '—'}</td>
      <td>${fmt(total)}</td>
      <td>${fmt(r.totalEwt)}</td>
    </tr>`;
  }).join('') + emptyRows2307(Math.max(0, 4 - rows.length));

  const fromStr = fmtDateMDY(start);
  const toStr   = fmtDateMDY(end);
  const repName  = setup.authRep || '';
  const repTitle = setup.authRepTitle || '';
  const repSig   = setup.authRepSignature || '';

  return `
  <div class="bir-form">
    <div class="bir-top">
      <div class="formno-box">
        <div class="big">2307</div>
        <div class="small">January 2018 (ENCS)</div>
      </div>
      <div class="title-box">
        <div class="republic">Republic of the Philippines<br>Department of Finance<br>Bureau of Internal Revenue</div>
        <div class="formname">Certificate of Creditable Tax<br>Withheld at Source</div>
      </div>
      <div class="barcode-box">For BIR Use Only<br>BCS/Item:</div>
    </div>
    <div class="bir-note">Fill in all applicable spaces. Mark all appropriate boxes with an "X".</div>

    <div class="period-row">
      <span class="num">1</span> For the Period
      <span>From</span><div class="period-box">${fromStr}</div>
      <span style="font-size:6.5pt;">(MM/DD/YYYY)</span>
      <span>To</span><div class="period-box">${toStr}</div>
      <span style="font-size:6.5pt;">(MM/DD/YYYY)</span>
    </div>

    <div class="bir-section-title">Part I – Payee Information</div>
    <div class="bir-row first">
      <div class="bir-cell w50"><span class="num">2</span> Taxpayer Identification Number (TIN)
        <span class="val">${escHtml(payeeTin)}</span></div>
    </div>
    <div class="bir-row">
      <div class="bir-cell"><span class="num">3</span> Payee's Name <span class="lbl">(Last Name, First Name, Middle Name for Individual OR Registered Name for Non-Individual)</span>
        <span class="val">${escHtml(payeeName)}</span></div>
    </div>
    <div class="bir-row">
      <div class="bir-cell w50"><span class="num">4</span> Registered Address
        <span class="val">${escHtml(payeeAddr)}</span></div>
      <div class="bir-cell"><span class="num">4A</span> ZIP Code
        <span class="val">${escHtml(supp.zipCode || '')}</span></div>
    </div>

    <div class="bir-section-title">Part II – Payor Information</div>
    <div class="bir-row first">
      <div class="bir-cell w50"><span class="num">6</span> Taxpayer Identification Number (TIN)
        <span class="val">${escHtml(payorTin)}</span></div>
    </div>
    <div class="bir-row">
      <div class="bir-cell"><span class="num">7</span> Payor's Name <span class="lbl">(Last Name, First Name, Middle Name for Individual OR Registered Name for Non-Individual)</span>
        <span class="val">${escHtml(payorName)}</span></div>
    </div>
    <div class="bir-row">
      <div class="bir-cell w50"><span class="num">8</span> Registered Address
        <span class="val">${escHtml(payorAddr)}</span></div>
      <div class="bir-cell"><span class="num">8A</span> ZIP Code
        <span class="val">${escHtml(setup.zipCode || '')}</span></div>
    </div>

    <div class="bir-section-title">Part III – Details of Monthly Income Payments and Taxes Withheld</div>
    <table class="bir-detail-table">
      <thead>
        <tr>
          <th rowspan="2" style="width:32%">Income Payments Subject to Expanded Withholding Tax</th>
          <th rowspan="2" style="width:8%">ATC</th>
          <th colspan="4">Amount of Income Payments</th>
          <th rowspan="2" style="width:12%">Tax Withheld for the Quarter</th>
        </tr>
        <tr>
          <th>1st Month of the Quarter</th>
          <th>2nd Month of the Quarter</th>
          <th>3rd Month of the Quarter</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
        <tr class="total-row">
          <td colspan="2" class="left">Total</td>
          <td>${totM[0] ? fmt(totM[0]) : '—'}</td>
          <td>${totM[1] ? fmt(totM[1]) : '—'}</td>
          <td>${totM[2] ? fmt(totM[2]) : '—'}</td>
          <td>${fmt(totBaseAll)}</td>
          <td>${fmt(totEwtQ)}</td>
        </tr>
        <tr class="section-row">
          <td colspan="7" class="left">Money Payments Subject to Withholding of Business Tax (Government &amp; Private)</td>
        </tr>
        ${emptyRows2307(2)}
        <tr class="total-row">
          <td colspan="2" class="left">Total</td>
          <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
        </tr>
      </tbody>
    </table>

    <div class="cert-box">
      We declare under the penalties of perjury that this certificate has been made in good faith, verified by us, and to the
      best of our knowledge and belief, is true and correct, pursuant to the provisions of the National Internal Revenue Code,
      as amended, and the regulations issued under authority thereof. Further, we give our consent to the processing of our
      information as contemplated under the *Data Privacy Act of 2012 (R.A. No. 10173) for legitimate and lawful purposes.
    </div>

    <div class="sig-area">
      <div class="sig-line">${repSig ? `<img src="${repSig}" alt="Signature" style="max-height:34px;max-width:180px;">` : ''}</div>
      ${repName ? `<strong>${escHtml(repName)}</strong><br>` : ''}
      Signature over Printed Name of Payor/Payor's Authorized Representative/Tax Agent<br>
      <span class="sig-sub">${repTitle ? escHtml(repTitle) : '(Indicate Title/Designation and TIN)'}</span>
    </div>
    <div class="sig-meta-row">
      <div class="bir-cell w50">Tax Agent Accreditation No./Attorney's Roll No. (if applicable)</div>
      <div class="bir-cell w25">Date of Issue<br><span class="sig-sub">(MM/DD/YYYY)</span></div>
      <div class="bir-cell">Date of Expiry<br><span class="sig-sub">(MM/DD/YYYY)</span></div>
    </div>

    <div class="conforme-title">CONFORME</div>
    <div class="sig-area">
      <div class="sig-line"></div>
      Signature over Printed Name of Payee/Payee's Authorized Representative/Tax Agent<br>
      <span class="sig-sub">(Indicate Title/Designation and TIN)</span>
    </div>
    <div class="sig-meta-row">
      <div class="bir-cell w50">Tax Agent Accreditation No./Attorney's Roll No. (if applicable)</div>
      <div class="bir-cell w25">Date of Issue<br><span class="sig-sub">(MM/DD/YYYY)</span></div>
      <div class="bir-cell">Date of Expiry<br><span class="sig-sub">(MM/DD/YYYY)</span></div>
    </div>

    <div class="footer-note">*NOTE: The BIR Data Privacy is in the BIR website (www.bir.gov.ph)</div>
  </div>`;
}

function emptyRows2307(n) {
  if (n <= 0) return '';
  return Array(n).fill(0).map(() =>
    `<tr><td class="left">&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`
  ).join('');
}

function fmtDateMDY(d) {
  if (!d) return '—';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return '—';
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${dt.getFullYear()}`;
}
