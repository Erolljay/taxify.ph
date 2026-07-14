/* ============================================================
   Tallo CPA – BIR Tax App
   alphalist-report.js – BIR Form 1604-C Alphalist of Employees
                          Schedule 1 (NMWE) and Schedule 2 (MWE)
   ============================================================ */

let _alphaState = { biz: null, setup: null };

function initAlphalistTab(biz, setup) {
  _alphaState.biz = biz;
  _alphaState.setup = setup;

  const filterEl = document.querySelector('#tab-report .filter-bar');
  const now = new Date();
  const years = [now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear()];

  filterEl.innerHTML = `
    <label>Year</label>
    <select id="alpha-year">
      ${years.map(y => `<option value="${y}"${y === now.getFullYear() - 1 ? ' selected' : ''}>${y}</option>`).join('')}
    </select>
    <button class="btn btn-primary" id="alpha-gen">⚡ Generate</button>
    <button class="btn btn-outline" id="alpha-excel" style="display:none;">📥 Excel</button>
    <button class="btn btn-outline" id="alpha-dat" style="display:none;">📄 DAT File</button>
    <button class="btn btn-outline" id="alpha-print" style="display:none;" onclick="window.print()">🖨 Print</button>
  `;

  document.getElementById('alpha-gen').addEventListener('click', generateAlphalist);
}

async function generateAlphalist() {
  const { biz, setup } = _alphaState;
  const outputEl = document.getElementById('report-output');
  const year = parseInt(document.getElementById('alpha-year').value, 10);

  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Computing annual compensation for ${year}…</span></div>`;

  try {
    const [byEmployee, employees] = await Promise.all([
      buildPayrollYear(biz, year),
      loadEmployeesBIR(biz),
      loadTaxRatesData(),
    ]);

    const nmwe = [], mwe = [];

    for (const [empKey, data] of Object.entries(byEmployee)) {
      const emp = employees[empKey];
      if (!emp || !emp.taxStatus) continue; // exclude employees with no Tax Status set
      const monthly = computeEmployee1601C(data.months, emp.taxStatus, year);
      const sum = (k) => monthly.reduce((a, m) => a + (m[k] || 0), 0);
      const catTotal = (cat) => data.months.reduce((a, b) => a + (b[cat] || 0), 0);

      const grossComp   = sum('line14');
      if (!grossComp) continue;

      const nonTaxable  = sum('line21');
      const taxableComp = sum('line22');
      const taxWithheld = sum('line25');
      const taxDue      = computeAnnualTax(taxableComp, year);

      const row = {
        empKey,
        tin: emp.tin,
        lastName: emp.lastName, firstName: emp.firstName, middleName: emp.middleName,
        name: [emp.lastName, emp.firstName, emp.middleName].filter(Boolean).join(', ') || emp.name,
        nationality: emp.nationality, employmentStatus: emp.employmentStatus,
        dateHired: emp.dateHired, dateSeparated: emp.dateSeparated,
        reasonSeparation: emp.reasonSeparation, substitutedFiling: emp.substitutedFiling,
        basic: catTotal(PH_CAT.BASIC),
        ot: catTotal(PH_CAT.OT),
        holiday: catTotal(PH_CAT.HOLIDAY),
        nightDiff: catTotal(PH_CAT.NIGHT_DIFF),
        hazard: catTotal(PH_CAT.HAZARD),
        thirteenth: catTotal(PH_CAT.THIRTEENTH),
        deMinimis: catTotal(PH_CAT.DE_MINIMIS),
        otherTax: catTotal(PH_CAT.OTHER_TAXABLE),
        commission: catTotal(PH_CAT.COMMISSION),
        profitShare: catTotal(PH_CAT.PROFIT_SHARE),
        directorFee: catTotal(PH_CAT.DIRECTOR_FEE),
        separation: catTotal(PH_CAT.SEPARATION),
        sssEe: catTotal(PH_CAT.SSS_EE), phicEe: catTotal(PH_CAT.PHIC_EE), hdmfEe: catTotal(PH_CAT.HDMF_EE),
        grossComp, nonTaxable, taxableComp, taxDue, taxWithheld,
      };

      if (emp.taxStatus === 'MWE') mwe.push(row); else nmwe.push(row);
    }

    nmwe.sort((a, b) => a.name.localeCompare(b.name));
    mwe.sort((a, b) => a.name.localeCompare(b.name));

    renderAlphalist(outputEl, nmwe, mwe, setup, year);
    document.getElementById('alpha-print').style.display = '';
    document.getElementById('alpha-excel').style.display = '';
    document.getElementById('alpha-dat').style.display   = '';
    document.getElementById('alpha-excel').onclick = () => exportAlphalistExcel(nmwe, mwe, setup, year);
    document.getElementById('alpha-dat').onclick   = () => exportAlphalistDat(nmwe, mwe, setup, year);
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function sumRows(rows, key) {
  return rows.reduce((a, r) => a + (r[key] || 0), 0);
}

function renderAlphalist(el, nmwe, mwe, setup, year) {
  const isInd = setup.classification === 'Individual';
  const employerName = isInd
    ? [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '');

  el.innerHTML = `
    <div class="form-title">
      <h2>BIR Form 1604-C — Alphalist of Employees</h2>
      <div class="sub">For the Year ${year} &nbsp;|&nbsp; Withholding Agent: ${escHtml(employerName)} &nbsp;|&nbsp; TIN: ${escHtml(tinDashed1601(setup.tin))}</div>
    </div>

    ${renderScheduleTable('Schedule 1 — Alphalist of Employees Other Than MWEs (NMWE), with or without Tax Due', nmwe, false)}
    ${renderScheduleTable('Schedule 2 — Alphalist of Minimum Wage Earners (MWE)', mwe, true)}
  `;
}

function renderScheduleTable(title, rows, isMWESchedule) {
  const baseCols = `
    <th>TIN</th><th>Last Name</th><th>First Name</th><th>Middle Name</th>
    <th class="num">Basic Salary</th>`;
  const mweCols = isMWESchedule ? `
    <th class="num">Overtime</th><th class="num">Holiday Pay</th>
    <th class="num">Night Diff.</th><th class="num">Hazard Pay</th>` : '';
  const restCols = `
    <th class="num">13th Month &amp; Other Benefits</th>
    <th class="num">De Minimis</th>
    <th class="num">Commission</th>
    <th class="num">Profit Share</th>
    <th class="num">Director's Fees</th>
    <th class="num">Other Taxable</th>
    <th class="num">Separation/Retirement</th>
    <th class="num">SSS/PHIC/HDMF (EE)</th>
    <th class="num">Gross Compensation</th>
    <th class="num">Non-Taxable Comp.</th>
    <th class="num">Taxable Comp.</th>
    <th class="num">Tax Due</th>
    <th class="num">Tax Withheld</th>`;

  const bodyRows = rows.map(r => `
    <tr>
      <td style="font-family:monospace;">${escHtml(tinDashed1601(r.tin))}</td>
      <td>${escHtml(r.lastName)}</td><td>${escHtml(r.firstName)}</td><td>${escHtml(r.middleName)}</td>
      <td class="num">${fmt(r.basic)}</td>
      ${isMWESchedule ? `<td class="num">${fmt(r.ot)}</td><td class="num">${fmt(r.holiday)}</td><td class="num">${fmt(r.nightDiff)}</td><td class="num">${fmt(r.hazard)}</td>` : ''}
      <td class="num">${fmt(r.thirteenth)}</td>
      <td class="num">${fmt(r.deMinimis)}</td>
      <td class="num">${fmt(r.commission)}</td>
      <td class="num">${fmt(r.profitShare)}</td>
      <td class="num">${fmt(r.directorFee)}</td>
      <td class="num">${fmt(r.otherTax)}</td>
      <td class="num">${fmt(r.separation)}</td>
      <td class="num">${fmt(r.sssEe + r.phicEe + r.hdmfEe)}</td>
      <td class="num">${fmt(r.grossComp)}</td>
      <td class="num">${fmt(r.nonTaxable)}</td>
      <td class="num">${fmt(r.taxableComp)}</td>
      <td class="num">${fmt(r.taxDue)}</td>
      <td class="num">${fmt(r.taxWithheld)}</td>
    </tr>`).join('');

  const totalsCols = `
    <td class="num">${fmt(sumRows(rows,'basic'))}</td>
    ${isMWESchedule ? `<td class="num">${fmt(sumRows(rows,'ot'))}</td><td class="num">${fmt(sumRows(rows,'holiday'))}</td><td class="num">${fmt(sumRows(rows,'nightDiff'))}</td><td class="num">${fmt(sumRows(rows,'hazard'))}</td>` : ''}
    <td class="num">${fmt(sumRows(rows,'thirteenth'))}</td>
    <td class="num">${fmt(sumRows(rows,'deMinimis'))}</td>
    <td class="num">${fmt(sumRows(rows,'commission'))}</td>
    <td class="num">${fmt(sumRows(rows,'profitShare'))}</td>
    <td class="num">${fmt(sumRows(rows,'directorFee'))}</td>
    <td class="num">${fmt(sumRows(rows,'otherTax'))}</td>
    <td class="num">${fmt(sumRows(rows,'separation'))}</td>
    <td class="num">${fmt(sumRows(rows,'sssEe')+sumRows(rows,'phicEe')+sumRows(rows,'hdmfEe'))}</td>
    <td class="num">${fmt(sumRows(rows,'grossComp'))}</td>
    <td class="num">${fmt(sumRows(rows,'nonTaxable'))}</td>
    <td class="num">${fmt(sumRows(rows,'taxableComp'))}</td>
    <td class="num">${fmt(sumRows(rows,'taxDue'))}</td>
    <td class="num">${fmt(sumRows(rows,'taxWithheld'))}</td>`;

  const colCount = 4 + 1 + (isMWESchedule ? 4 : 0) + 12;

  return `
    <div class="return-section">
      <div class="return-section-header">${title}</div>
      <div class="data-table-wrap">
        <table class="data-table" style="font-size:10px;">
          <thead><tr>${baseCols}${mweCols}${restCols}</tr></thead>
          <tbody>${bodyRows || `<tr><td colspan="${colCount}" style="text-align:center;color:#9ca3af;">No employees in this category for the year</td></tr>`}</tbody>
          <tfoot><tr><td colspan="4" style="font-weight:700;">TOTALS (${rows.length} employee${rows.length===1?'':'s'})</td>${totalsCols}</tr></tfoot>
        </table>
      </div>
    </div>`;
}

// ── BIR COLUMN BREAKDOWN (16-column official QAP-style layout) ─────
// Splits each employee's already-computed totals (grossComp, nonTaxable,
// taxableComp, taxDue, taxWithheld — same figures shown on screen) into
// the official BIR present-employer column set 7a-7j. Non-taxable items
// we can categorize directly (13th month, de minimis, SSS/PHIC/HDMF) are
// broken out; any remainder is grouped into 7e/7i so 7f=(7b+7c+7d+7e) and
// 7j is taxableComp, keeping 7a=(7f+7j) consistent for BIR validation.
function alphaCols(r) {
  const c7b = r.thirteenth || 0;
  const c7c = r.deMinimis || 0;
  const c7d = (r.sssEe || 0) + (r.phicEe || 0) + (r.hdmfEe || 0);
  const c7e = Math.max(0, (r.nonTaxable || 0) - c7b - c7c - c7d);
  const c7f = c7b + c7c + c7d + c7e;
  const c7j = r.taxableComp || 0;
  const taxDue = r.taxDue || 0;
  const taxWithheld = r.taxWithheld || 0;
  return {
    c7a: r.grossComp || 0, c7b, c7c, c7d, c7e, c7f,
    c7g: 0, c7h: 0, c7i: c7j, c7j,
    c13: c7j, c14: taxDue, c15a: 0, c15b: taxWithheld, c16: 0,
    c17a: Math.max(0, taxDue - taxWithheld), c17b: Math.max(0, taxWithheld - taxDue), c18: 0,
  };
}

function tin9Alpha(t) {
  const digits = (t || '').replace(/\D/g, '');
  return (digits.substring(0, 9) || '').padEnd(9, '0').substring(0, 9) || '000000000';
}

function branch4Alpha(b) {
  return (b || '').toString().replace(/\D/g, '').padStart(4, '0').substring(0, 4) || '0000';
}

// ── EXCEL EXPORT (official "BIR FORM 1604C - SCHEDULE 1/2" layout) ──
function exportAlphalistExcel(nmwe, mwe, setup, year) {
  if (!window.XLSX) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => exportAlphalistExcel(nmwe, mwe, setup, year);
    document.head.appendChild(s); return;
  }
  const isInd = setup.classification === 'Individual';
  const agentName = (isInd
    ? [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '')).toUpperCase();

  function buildSheet(scheduleNo, rows) {
    const data = [
      [`BIR FORM 1604C - SCHEDULE ${scheduleNo}`],
      [scheduleNo === 1
        ? 'ALPHABETICAL LIST EMPLOYEES (Declared and Certified using BIR Form No. 2316)'
        : 'ALPHABETICAL LIST OF MINIMUM WAGE EARNERS (MWE)'],
      [`AS OF DECEMBER 31,${year}`],
      [],
      [`TIN : ${tinDashed1601(setup.tin)}-${branch4Alpha(setup.branchCode)}`],
      [],
      [`WITHHOLDING AGENT'S NAME: ${agentName}`],
      [],
      [
        'SEQ', 'NAME OF EMPLOYEES', 'NATIONALITY/', 'CURRENT EMPLOYMENT',
        '', '', 'REASON OF', 'GROSS', '13th MONTH PAY', 'DE MINIMIS', 'SSS, GSIS, PHIC &',
        'SALARIES (P250K & below) &', 'TOTAL', 'BASIC SALARY', '13th MONTH PAY', 'SALARIES & OTHER',
        'TOTAL TAXABLE', 'TAXPAYER', 'EMPLOYMENT', 'PERIOD OF', '', 'TAX DUE', 'AMOUNT OF TAX',
        '(Jan. - Dec.)', 'PREVIOUS EMPLOYER', 'PRESENT EMPLOYER', 'AMT WITHHELD AND PAID FOR IN DECEMBER OR LAST SALARY',
        'OVER', 'AMOUNT OF TAX', 'SUBSTITUTED FILING',
      ],
      [
        'NO', '(Last Name, First Name, Middle Name)', 'RESIDENT', 'STATUS', 'From', 'To',
        'SEPARATION', 'COMPENSATION', '& OTHER BENEFITS', 'BENEFITS', 'PAG-IBIG CONTRIBUTIONS',
        'OTHER FORMS OF', 'NON-TAXABLE/EXEMPT', '(Net of SSS,GSIS,PHIC,', '& OTHER BENEFITS', 'FORMS OF',
        'COMPENSATION INCOME', 'IDENTIFICATION NUMBER', 'STATUS', '', '', 'COMPENSATION INCOME',
        'WITHHELD AS', '', 'WITHHELD TAX', 'WITHHELD TAX', '', 'REFUNDED TO', 'ADJUSTED', 'YES/NO',
      ],
      [
        '', '(2a)(2b)(2c)', '(for foreigners only)', '(*)', '(5a)', '(5b)', '(**)', '7a=(7f+7j)',
        '(7b)', '(7c)', '(7d)', '(7e)', '7f=(7b+7c+7d+7e)', '(7g)', '(7h)', '(7i)', '7j=(7g+7h+7i)',
        '(8)', '(9)', '(10a)', '(10b)', '13=(7j+12j)', '(14)', '15a', '(15b)', '16', '17a', '17b', '(18)', '(19)',
      ],
    ];

    let totGross=0, tot7e=0, tot7b=0, tot7c=0, tot7d=0, tot7f=0, totTaxable=0, totTaxDue=0, totWithheld=0;
    rows.forEach((r, i) => {
      const c = alphaCols(r);
      totGross += c.c7a; tot7e += c.c7e; tot7b += c.c7b; tot7c += c.c7c; tot7d += c.c7d; tot7f += c.c7f;
      totTaxable += c.c7j; totTaxDue += c.c14; totWithheld += c.c15b;
      data.push([
        i + 1,
        r.name,
        (r.nationality || 'FILIPINO').toUpperCase(),
        r.employmentStatus || 'R',
        r.dateHired ? new Date(r.dateHired) : '',
        r.dateSeparated ? new Date(r.dateSeparated) : '',
        r.reasonSeparation || 'NA',
        Number(c.c7a.toFixed(2)), Number(c.c7b.toFixed(2)), Number(c.c7c.toFixed(2)),
        Number(c.c7d.toFixed(2)), Number(c.c7e.toFixed(2)), Number(c.c7f.toFixed(2)),
        Number(c.c7g.toFixed(2)), Number(c.c7h.toFixed(2)), Number(c.c7i.toFixed(2)), Number(c.c7j.toFixed(2)),
        `${tinDashed1601(r.tin)}-0000`,
        '', '', '', '',
        Number(c.c14.toFixed(2)), Number(c.c15b.toFixed(2)), Number(c.c16.toFixed(2)),
        Number(c.c17a.toFixed(2)), Number(c.c17b.toFixed(2)), Number(c.c18.toFixed(2)),
        r.substitutedFiling || 'Y',
      ]);
    });

    data.push([
      'Grand Total :', '', '', '', '', '', '',
      Number(totGross.toFixed(2)), Number(tot7b.toFixed(2)), Number(tot7c.toFixed(2)), Number(tot7d.toFixed(2)),
      Number(tot7e.toFixed(2)), Number(tot7f.toFixed(2)), 0, 0, Number(totTaxable.toFixed(2)), Number(totTaxable.toFixed(2)),
      '', '', '', '', Number(totTaxDue.toFixed(2)), Number(totWithheld.toFixed(2)), 0, 0, 0, 0, '',
    ]);
    data.push(['------------------']);
    data.push(['==================']);
    data.push(['END OF REPORT']);

    return XLSX.utils.aoa_to_sheet(data);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSheet(1, nmwe), 'Schedule 1 - NMWE');
  XLSX.utils.book_append_sheet(wb, buildSheet(2, mwe), 'Schedule 2 - MWE');
  XLSX.writeFile(wb, `1604C_Alphalist_${year}.xlsx`);
}

// ── DAT EXPORT (matches the official 1604C DAT sample field order) ──
// Header: H1604C,<ourTIN9>,<ourBranch4>,<asOfDate MM/DD/YYYY>
// Detail: D1,1604C,<ourTIN9>,<ourBranch4>,<asOfDate>,<seq>,<empTIN9>,<empBranch4>,
//         "<last>","<first>","<middle>",<region>,
//         [11 zero fields — previous-employer block, not tracked by this app],
//         <fromDate>,<toDate>,
//         <gross>,<salariesOther 7e>,<13th 7b>,<deMinimis 7c>,<sss 7d>,0.00,<totalNonTax 7f>,
//         [4 taxable-side fields 7g-7j],<totalTaxable 13>,<taxDue 14>,<wthPrev 15a>,<wthPresent 15b>,
//         <5pct 16>,<17a>,<17b>,<18>,
//         <nationality>,<employmentStatus>,<reasonSeparation>,<substitutedFiling>,0.00
// Control: C1,1604C,<ourTIN9>,<ourBranch4>,<asOfDate>,[11 zeros],<grossTotal>,<salariesOtherTotal>,
//          <13thTotal>,<deMinimisTotal>,<sssTotal>,0.00,<totalNonTaxTotal>,[13 zeros]
function csvNumAlpha(n) { return (Number(n) || 0).toFixed(2); }
function datDateAlpha(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return '';
  return `${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}/${dt.getFullYear()}`;
}

function exportAlphalistDat(nmwe, mwe, setup, year) {
  const ourTin = tin9Alpha(setup.tin);
  const ourBranch = branch4Alpha(setup.branchCode);
  const asOfDate = `12/31/${year}`;
  const prevEmployerZeros = Array(11).fill('0.00');

  const lines = [];
  lines.push(['H1604C', ourTin, ourBranch, asOfDate].join(','));

  let totGross=0, tot7e=0, tot7b=0, tot7c=0, tot7d=0, tot7f=0;

  let seq = 0;
  [...nmwe, ...mwe].forEach(r => {
    seq++;
    const c = alphaCols(r);
    totGross += c.c7a; tot7e += c.c7e; tot7b += c.c7b; tot7c += c.c7c; tot7d += c.c7d; tot7f += c.c7f;

    lines.push([
      'D1', '1604C', ourTin, ourBranch, asOfDate,
      seq, tin9Alpha(r.tin), '0000',
      `"${(r.lastName || '').toUpperCase()}"`, `"${(r.firstName || '').toUpperCase()}"`, `"${(r.middleName || '').toUpperCase()}"`,
      r.region || '',
      ...prevEmployerZeros,
      datDateAlpha(r.dateHired) || `01/01/${year}`,
      datDateAlpha(r.dateSeparated) || `12/31/${year}`,
      csvNumAlpha(c.c7a), csvNumAlpha(c.c7e), csvNumAlpha(c.c7b), csvNumAlpha(c.c7c), csvNumAlpha(c.c7d),
      '0.00', csvNumAlpha(c.c7f),
      csvNumAlpha(c.c7g), csvNumAlpha(c.c7h), csvNumAlpha(c.c7i), csvNumAlpha(c.c7j),
      csvNumAlpha(c.c13), csvNumAlpha(c.c14), csvNumAlpha(c.c15a), csvNumAlpha(c.c15b),
      csvNumAlpha(c.c16), csvNumAlpha(c.c17a), csvNumAlpha(c.c17b), csvNumAlpha(c.c18),
      (r.nationality || 'FILIPINO').toUpperCase(), r.employmentStatus || 'R', r.reasonSeparation || 'NA',
      r.substitutedFiling || 'Y', '0.00',
    ].join(','));
  });

  lines.push([
    'C1', '1604C', ourTin, ourBranch, asOfDate,
    ...prevEmployerZeros,
    csvNumAlpha(totGross), csvNumAlpha(tot7e), csvNumAlpha(tot7b), csvNumAlpha(tot7c), csvNumAlpha(tot7d),
    '0.00', csvNumAlpha(tot7f),
    ...Array(13).fill('0.00'),
  ].join(','));

  const content = lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/plain' });
  // File naming structure per official BIR sample: <TIN9><branch4><asOfDateMMDDYYYY><formType>.DAT
  const dateTag = `${String(12).padStart(2,'0')}${String(31).padStart(2,'0')}${year}`;
  const fname = `${ourTin}${ourBranch}${dateTag}1604C.DAT`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fname });
  a.click(); URL.revokeObjectURL(a.href);
}
