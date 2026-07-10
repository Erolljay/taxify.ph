/* ============================================================
   Tallo CPA – BIR Tax App
   2316-report.js – BIR Form 2316 Certificate of Compensation
                     Payment / Tax Withheld, per employee, tab
                     embedded inside alphalist.html (1604-C).
   ============================================================ */

let _form2316State = { biz: null, setup: null, employees: null, year: null };

// ── FORM-FIELD CELL HELPERS (match the official printed layout) ──
function tinCellsHtml2316(tin) {
  const digits = (tin || '').replace(/\D/g, '').padEnd(12, ' ').substring(0, 12);
  const groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9, 12)];
  let html = '<span class="f2316-tin-wrap">';
  groups.forEach((g, gi) => {
    g.split('').forEach(ch => { html += `<span class="f2316-tin-cell">${ch.trim() ? escHtml(ch) : '&nbsp;'}</span>`; });
    if (gi < groups.length - 1) html += `<span class="f2316-tin-cell dash"></span>`;
  });
  return html + '</span>';
}
function mmddyyyy2316(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[2]}${m[3]}${m[1]}` : (iso || '');
}
function tickCellsHtml2316(str, count) {
  const s = (str || '').replace(/\D/g, '').padEnd(count, ' ').substring(0, count);
  let html = '<div class="f2316-ticks">';
  for (let i = 0; i < count; i++) {
    const ch = s[i];
    html += `<span class="tick">${ch && ch.trim() ? escHtml(ch) : '&nbsp;'}</span>`;
  }
  return html + '</div>';
}
function boxCellsHtml2316(str, count) {
  const s = (str || '').padEnd(count, ' ').substring(0, count);
  let html = '<span class="f2316-boxwrap">';
  for (let i = 0; i < count; i++) {
    const ch = s[i];
    html += `<span class="f2316-boxcell">${ch && ch.trim() ? escHtml(ch) : '&nbsp;'}</span>`;
  }
  return html + '</span>';
}

async function init2316Tab(biz, setup) {
  _form2316State.biz = biz;
  _form2316State.setup = setup;

  const filterEl = document.querySelector('#tab-2316 .filter-bar');
  const now = new Date();
  const years = [now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear()];

  filterEl.innerHTML = `
    <label>Year</label>
    <select id="f2316-year">
      ${years.map(y => `<option value="${y}"${y === now.getFullYear() - 1 ? ' selected' : ''}>${y}</option>`).join('')}
    </select>
    <label>Employees</label>
    <span style="display:inline-flex; flex-direction:column; gap:2px;">
      <input type="text" id="f2316-employee-search" placeholder="Type to filter…" style="min-width:220px;">
      <select id="f2316-employee" multiple style="min-width:220px; height:60px;">
        <option value="__all__" selected>All employees</option>
      </select>
    </span>
    <button class="btn btn-primary" id="f2316-gen">⚡ Generate</button>
    <button class="btn btn-outline" id="f2316-print" style="display:none;" onclick="window.print()">🖨 Print</button>
  `;

  try {
    const employees = await loadEmployeesBIR(biz);
    _form2316State.employees = employees;
    const sel = document.getElementById('f2316-employee');
    Object.entries(employees).forEach(([key, e]) => {
      const name = [e.lastName, e.firstName, e.middleName].filter(Boolean).join(', ') || e.name;
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      const all = sel.querySelector('option[value="__all__"]');
      const others = [...sel.options].filter(o => o.value !== '__all__');
      if (all.selected) others.forEach(o => o.selected = false);
    });
    document.getElementById('f2316-employee-search').addEventListener('input', (e) => {
      const term = e.target.value.trim().toLowerCase();
      [...sel.options].forEach(o => {
        if (o.value === '__all__') return;
        o.hidden = term && !o.textContent.toLowerCase().includes(term);
      });
    });
  } catch (e) {
    console.warn('2316: could not load employees', e.message);
  }

  document.getElementById('f2316-gen').addEventListener('click', generate2316);
}

async function generate2316() {
  const { biz, setup } = _form2316State;
  const outputEl = document.getElementById('form2316-output');
  const year = parseInt(document.getElementById('f2316-year').value, 10);
  const sel = document.getElementById('f2316-employee');
  const selected = [...sel.selectedOptions].map(o => o.value);
  const wantAll = selected.includes('__all__') || selected.length === 0;

  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Computing annual compensation…</span></div>`;

  try {
    const [byEmployee, employees] = await Promise.all([
      buildPayrollYear(biz, year),
      loadEmployeesBIR(biz),
    ]);
    _form2316State.employees = employees;
    const empKeys = wantAll ? Object.keys(byEmployee) : selected.filter(k => byEmployee[k]);

    if (!empKeys.length) {
      outputEl.innerHTML = `<div class="alert alert-warn">⚠️ No payroll data found for ${year}.</div>`;
      return;
    }

    const certs = empKeys
      .filter(key => employees[key] && employees[key].taxStatus) // exclude employees with no Tax Status set
      .map(key => {
        const emp = employees[key];
        const monthly = computeEmployee1601C(byEmployee[key].months, emp.taxStatus, year);
        return render2316Cert(emp, monthly, byEmployee[key].months, setup, year);
      });

    if (!certs.length) {
      outputEl.innerHTML = `<div class="alert alert-warn">⚠️ No employees with a Tax Status set found for ${year}.</div>`;
      return;
    }

    outputEl.innerHTML = certs.join('<div class="page-break" style="break-after:page;"></div>');
    document.getElementById('f2316-print').style.display = '';
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ── RENDER A SINGLE 2316 CERTIFICATE ───────────────────────────
// Field numbering/grouping mirrors BIR Form No. 2316 (September 2021 ENCS)
// exactly — Part I/II/III on the left, Part IV-B (A. Non-Taxable / B.
// Taxable) on the right, Part IV-A Summary totals at the bottom-left.
function render2316Cert(emp, monthly, months, setup, year) {
  const isMWE = emp.taxStatus === 'MWE';
  const name = [emp.lastName, emp.firstName, emp.middleName].filter(Boolean).join(', ') || emp.name;

  // Annual totals (sum of monthly computed lines)
  const sum = (k) => monthly.reduce((a, m) => a + (m[k] || 0), 0);
  const grossComp   = sum('line14');
  const nonTaxable  = sum('line21');
  const taxableComp = sum('line22');
  const taxWithheld = sum('line25');
  const contributions = sum('line19'); // SSS/GSIS/PHIC/HDMF employee share (Item 36)

  // Breakdown of gross compensation by category
  const catTotal = (cat) => months.reduce((a, b) => a + (b[cat] || 0), 0);
  const basic       = catTotal(PH_CAT.BASIC);
  const ot          = catTotal(PH_CAT.OT);
  const holiday     = catTotal(PH_CAT.HOLIDAY);
  const nightDiff   = catTotal(PH_CAT.NIGHT_DIFF);
  const hazard      = catTotal(PH_CAT.HAZARD);
  const deMinimis   = catTotal(PH_CAT.DE_MINIMIS);
  const otherTax    = catTotal(PH_CAT.OTHER_TAXABLE);
  const commission  = catTotal(PH_CAT.COMMISSION);
  const profitShare = catTotal(PH_CAT.PROFIT_SHARE);
  const directorFee = catTotal(PH_CAT.DIRECTOR_FEE);
  const separation  = catTotal(PH_CAT.SEPARATION);

  // ── Part IV-B, A. Non-Taxable/Exempt Compensation Income (Items 29-38) ──
  // Item 29 (MWE basic) is reported net of contributions (line15, fixed the
  // same way as 1601-C Line 15) so Item 38's total reconciles to line21
  // without double-exempting the same peso via both Item 29 and Item 36.
  const item29 = sum('line15');                 // Basic Salary (MWE, net of contributions)
  const item30 = isMWE ? holiday : 0;            // Holiday Pay (MWE)
  const item31 = isMWE ? ot : 0;                 // Overtime Pay (MWE)
  const item32 = isMWE ? nightDiff : 0;          // Night Shift Differential (MWE)
  const item33 = isMWE ? hazard : 0;             // Hazard Pay (MWE)
  const item34 = sum('line17');                  // 13th Month Pay & Other Benefits (capped, non-taxable portion)
  const item35 = deMinimis;                      // De Minimis Benefits
  const item36 = contributions;                  // SSS/GSIS/PHIC/HDMF + Union Dues (employee share)
  const item37 = separation;                     // Salaries and Other Forms of Compensation (non-taxable)
  const item38 = item29 + item30 + item31 + item32 + item33 + item34 + item35 + item36 + item37;

  // ── Part IV-B, B. Taxable Compensation Income (Items 39-52) ─────────────
  // Item 39 (NMWE basic) is likewise net of contributions, mirroring Item 29,
  // so Item 52's total reconciles exactly to line22.
  const item39  = isMWE ? 0 : Math.max(0, basic - contributions); // Basic Salary
  const item44  = otherTax;                       // Others
  const item45  = commission;                      // Commission
  const item46  = profitShare;                     // Profit Sharing
  const item47  = directorFee;                     // Fees Including Director's Fees
  const item48  = sum('thirteenthExcess');         // Taxable 13th Month Benefits (excess over P90,000 cap)
  const item49  = isMWE ? 0 : hazard;               // Hazard Pay
  const item50  = isMWE ? 0 : ot;                   // Overtime Pay
  const item51a = isMWE ? 0 : (holiday + nightDiff); // Others — Holiday Pay / Night Shift Differential
  const item52  = item39 + item44 + item45 + item46 + item47 + item48 + item49 + item50 + item51a;

  // Annual tax due (per TRAIN graduated table on taxable income)
  const taxDue = computeAnnualTax(taxableComp, year);

  const isInd = setup.classification === 'Individual';
  const employerName = isInd
    ? [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '');

  const itemRow = (num, label, amount, totalCls = '') => `
    <div class="f2316-item-row ${totalCls}"><div class="lbl"><strong>${escHtml(String(num))}</strong> ${label}</div><div class="amt">${fmt(amount)}</div></div>`;

  const sigName = setup.authRep || '';
  const sigImg = setup.authRepSignature ? `<img class="sig" src="${setup.authRepSignature}" alt="Signature">` : '';

  return `
    <div class="f2316-page">
      <div class="f2316-topstrip">
        <div class="biruse"><span class="gray">For BIR<br>Use Only</span><span>BCS/<br>Item:</span></div>
        <div class="gov">
          <img src="bir-logo.png" alt="BIR">
          <div class="lines">Republic of the Philippines<br>Department of Finance<br>Bureau of Internal Revenue</div>
        </div>
      </div>
      <div class="f2316-outer">
        <div class="f2316-headband">
          <div class="formno"><div class="lbl">BIR Form No.</div><div class="big">2316</div><div class="rev">September 2021(ENCS)</div></div>
          <div class="title"><div class="t">Certificate of Compensation<br>Payment/Tax Withheld</div><div class="sub">For Compensation Payment With or Without Tax Withheld</div></div>
          <div class="barcode"><img src="bir-barcode-2316.png" alt=""><div class="code">2316 9/21ENCS</div></div>
        </div>
        <div class="f2316-fillnote">Fill in all applicable spaces. Mark all appropriate boxes with an "X".</div>

        <div class="f2316-yp">
          <div class="a"><span><strong>1</strong> For the Year<br><span style="font-style:italic;">(YYYY)</span></span>${boxCellsHtml2316(String(year), 4)}</div>
          <div class="b"><span><strong>2</strong> For the Period</span><span>From <span style="font-style:italic;">(MM/DD)</span></span>${boxCellsHtml2316('0101', 4)}<span>To <span style="font-style:italic;">(MM/DD)</span></span>${boxCellsHtml2316('1231', 4)}</div>
        </div>

        <div class="f2316-main">
          <div class="f2316-col left">
            <div class="f2316-parttitle">Part I - Employee Information</div>
            <div class="f2316-tin-row"><span><strong>3</strong> TIN</span>${tinCellsHtml2316(emp.tin)}</div>
            <div class="f2316-row2">
              <div class="f2316-fieldbox"><div><strong>4</strong> Employee's Name <span style="font-style:italic;">(Last Name, First Name, Middle Name)</span></div><div class="val">${escHtml(name || '')}</div></div>
              <div class="f2316-fieldbox narrow"><div><strong>5</strong> RDO Code</div><div class="val center">${escHtml(setup.rdoCode || '')}</div></div>
            </div>
            <div class="f2316-row2">
              <div class="f2316-fieldbox"><div><strong>6</strong> Registered Address</div><div class="val">${escHtml(emp.address || '')}</div></div>
              <div class="f2316-fieldbox narrow"><div><strong>6A</strong> ZIP Code</div><div class="val center">${escHtml(emp.zipCode || '')}</div></div>
            </div>
            <div class="f2316-fieldbox-single"><div><strong>6D</strong> Foreign Address</div><div class="val"></div></div>
            <div class="f2316-row2">
              <div class="f2316-fieldbox" style="flex:0 0 225px;"><div><strong>7</strong> Date of Birth <span style="font-style:italic;">(MM/DD/YYYY)</span></div>${tickCellsHtml2316(mmddyyyy2316(emp.dateOfBirth), 8)}</div>
              <div class="f2316-fieldbox"><div><strong>8</strong> Contact Number</div>${tickCellsHtml2316(emp.contactNumber, 11)}</div>
            </div>
            <div class="f2316-inline-row"><div style="flex:1;"><strong>9</strong> Statutory Minimum Wage rate per day</div><div class="f2316-amtbox"></div></div>
            <div class="f2316-inline-row"><div style="flex:1;"><strong>10</strong> Statutory Minimum Wage rate per month</div><div class="f2316-amtbox"></div></div>
            <div class="f2316-mwe"><span><strong>11</strong></span><span class="f2316-checkbox">${isMWE ? 'X' : ''}</span><span style="flex:1;">Minimum Wage Earner (MWE) whose compensation is exempt from withholding tax and not subject to income tax</span></div>

            <div class="f2316-parttitle">Part II - Employer Information <span style="font-style:italic;">(Present)</span></div>
            <div class="f2316-tin-row"><span><strong>12</strong> TIN</span>${tinCellsHtml2316((setup.tin || '') + (setup.branchCode || '').replace(/\D/g, '').padStart(3, '0').slice(-3))}</div>
            <div class="f2316-fieldbox-single"><div><strong>13</strong> Employer's Name</div><div class="val">${escHtml(employerName || '')}</div></div>
            <div class="f2316-row2">
              <div class="f2316-fieldbox"><div><strong>14</strong> Registered Address</div><div class="val">${escHtml(setup.address || '')}</div></div>
              <div class="f2316-fieldbox narrow"><div><strong>14A</strong> ZIP Code</div><div class="val center">${escHtml(setup.zipCode || '')}</div></div>
            </div>
            <div class="f2316-inline-row" style="gap:14px;">
              <span><strong>15</strong> Type of Employer</span>
              <span style="display:flex;align-items:center;gap:5px;"><span class="f2316-checkbox sm">X</span> Main Employer</span>
              <span style="display:flex;align-items:center;gap:5px;"><span class="f2316-checkbox sm"></span> Secondary Employer</span>
            </div>

            <div class="f2316-parttitle">Part III - Employer Information <span style="font-style:italic;">(Previous)</span></div>
            <div class="f2316-tin-row"><span><strong>16</strong> TIN</span>${tinCellsHtml2316('')}</div>
            <div class="f2316-fieldbox-single"><div><strong>17</strong> Employer's Name</div><div class="val"></div></div>
            <div class="f2316-row2">
              <div class="f2316-fieldbox"><div><strong>18</strong> Registered Address</div><div class="val"></div></div>
              <div class="f2316-fieldbox narrow"><div><strong>18A</strong> ZIP Code</div><div class="val"></div></div>
            </div>

            <div class="f2316-parttitle">Part IV-A - Summary</div>
            ${itemRow(19, 'Gross Compensation Income from Present Employer', grossComp)}
            ${itemRow(20, 'Less: Total Non-Taxable/Exempt Compensation Income', item38)}
            ${itemRow(21, 'Taxable Compensation Income from Present Employer', item52)}
            ${itemRow(22, 'Add: Taxable Compensation Income from Previous Employer', 0)}
            ${itemRow(23, 'Gross Taxable Compensation Income', taxableComp)}
            ${itemRow(24, 'Tax Due', taxDue, 'total')}
            ${itemRow('25A', 'Amount of Taxes Withheld — Present Employer', taxWithheld)}
            ${itemRow('25B', 'Amount of Taxes Withheld — Previous Employer', 0)}
            ${itemRow(26, 'Total Amount of Taxes Withheld as Adjusted', taxWithheld)}
            ${itemRow(27, '5% Tax Credit (PERA Act of 2008)', 0)}
            ${itemRow(28, 'Total Taxes Withheld', taxWithheld, 'total')}
          </div>

          <div class="f2316-col">
            <div class="f2316-parttitle">Part IV-B Details of Compensation Income &amp; Tax Withheld from Present Employer</div>
            <div class="f2316-cathdr"><div class="lbl">A. NON-TAXABLE/EXEMPT COMPENSATION INCOME</div><div class="amtcol">Amount</div></div>
            ${itemRow(29, 'Basic Salary (incl. exempt P250,000 &amp; below) or SMW of the MWE', item29)}
            ${itemRow(30, 'Holiday Pay (MWE)', item30)}
            ${itemRow(31, 'Overtime Pay (MWE)', item31)}
            ${itemRow(32, 'Night Shift Differential (MWE)', item32)}
            ${itemRow(33, 'Hazard Pay (MWE)', item33)}
            ${itemRow(34, '13th Month Pay and Other Benefits (max. P90,000)', item34)}
            ${itemRow(35, 'De Minimis Benefits', item35)}
            ${itemRow(36, 'SSS, GSIS, PHIC &amp; HDMF Contributions and Union Dues (Employee share)', item36)}
            ${itemRow(37, 'Salaries and Other Forms of Compensation', item37)}
            ${itemRow(38, 'Total Non-Taxable/Exempt Compensation Income', item38, 'total')}

            <div class="f2316-subhdr">B. TAXABLE COMPENSATION INCOME REGULAR</div>
            ${itemRow(39, 'Basic Salary', item39)}
            ${itemRow(40, 'Representation', 0)}
            ${itemRow(41, 'Transportation', 0)}
            ${itemRow(42, 'Cost of Living Allowance (COLA)', 0)}
            ${itemRow(43, 'Fixed Housing Allowance', 0)}
            ${itemRow('44A', 'Others — Other Taxable Compensation', item44)}
            <div class="f2316-subhdr">SUPPLEMENTARY</div>
            ${itemRow(45, 'Commission', item45)}
            ${itemRow(46, 'Profit Sharing', item46)}
            ${itemRow(47, "Fees Including Director's Fees", item47)}
            ${itemRow(48, 'Taxable 13th Month Benefits', item48)}
            ${itemRow(49, 'Hazard Pay', item49)}
            ${itemRow(50, 'Overtime Pay', item50)}
            ${itemRow('51A', 'Others — Holiday Pay / Night Shift Differential', item51a)}
            ${itemRow(52, 'Total Taxable Compensation Income', item52, 'total')}
          </div>
        </div>

        <div class="f2316-declaration">
          I/We declare, under the penalties of perjury that this certificate has been made in good faith, verified by me/us, and to the best of my/our knowledge and belief, is true and correct, pursuant to the provisions of the National Internal Revenue Code, as amended, and the regulations issued under authority thereof. Further, I/we give my/our consent to the processing of my/our information as contemplated under the *Data Privacy Act of 2012 (R.A. No. 10173) for legitimate and lawful purposes.
        </div>

        <div class="f2316-sigrow">
          <div class="f2316-sigblock">
            <div class="f2316-line"><strong>53</strong><span class="val">${sigImg}${escHtml(sigName)}</span></div>
            <div class="f2316-cap">Present Employer/Authorized Agent Signature over Printed Name</div>
          </div>
          <div class="f2316-datesigned"><span>Date Signed</span><span class="f2316-datewrap">${'<span class="f2316-datebox"></span>'.repeat(8)}</span></div>
        </div>
        <div class="f2316-conforme">CONFORME:</div>
        <div class="f2316-sigrow">
          <div class="f2316-sigblock">
            <div class="f2316-line"><strong>54</strong><span class="val">${escHtml(name || '')}</span></div>
            <div class="f2316-cap">Employee Signature over Printed Name</div>
          </div>
          <div class="f2316-datesigned"><span>Date Signed</span><span class="f2316-datewrap">${'<span class="f2316-datebox"></span>'.repeat(8)}</span></div>
        </div>
        <div class="f2316-ctcrow">
          <div class="f2316-ctcfield"><span class="l">CTC/Valid ID No.<br>of Employee</span><span class="box"></span></div>
          <div class="f2316-ctcfield"><span class="l">Place of<br>Issue</span><span class="box"></span></div>
          <div class="f2316-ctc-date">
            <div style="display:flex;align-items:center;gap:6px;"><span>Date Issued</span><span class="f2316-datewrap">${'<span class="f2316-datebox"></span>'.repeat(8)}</span></div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:5px;"><span>Amount paid, if CTC</span><span class="amtbox"></span></div>
          </div>
        </div>

        <div class="f2316-subfiling-title">To be accomplished under substituted filing</div>
        <div class="f2316-subfiling-cols">
          <div class="f2316-subfiling-col">
            <div class="f2316-subfiling-text">I declare, under the penalties of perjury that the information herein stated are reported under BIR Form No. 1604-C which has been filed with the Bureau of Internal Revenue.</div>
            <div class="f2316-line" style="margin-top:26px;"><strong>55</strong><span class="val">${sigImg}${escHtml(sigName)}</span></div>
            <div class="f2316-cap">Present Employer/Authorized Agent Signature over Printed Name<br>(Head of Accounting/Human Resource or Authorized Representative)</div>
          </div>
          <div class="f2316-subfiling-col">
            <div class="f2316-subfiling-text">I declare, under the penalties of perjury that I am qualified under substituted filing of Income Tax Return (BIR Form No. 1700), since I received purely compensation income from only one employer in the Philippines for the calendar year; that taxes have been correctly withheld by my employer (tax due equals tax withheld); that the BIR Form No. 1604-C filed by my employer to the BIR shall constitute as my income tax return; and that BIR Form No. 2316 shall serve the same purpose as if BIR Form No. 1700 has been filed pursuant to the provisions of Revenue Regulations (RR) No. 3-2002, as amended.</div>
            <div class="f2316-line" style="margin-top:6px;"><strong>56</strong><span class="val">${escHtml(name || '')}</span></div>
            <div class="f2316-cap">Employee Signature over Printed Name</div>
          </div>
        </div>
        <div class="f2316-note">*NOTE: The BIR Data Privacy is in the BIR website (www.bir.gov.ph)</div>
      </div>
    </div>`;
}
