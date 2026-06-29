/* ============================================================
   Tallo CPA – BIR Tax App
   2316-report.js – BIR Form 2316 Certificate of Compensation
                     Payment / Tax Withheld, per employee, tab
                     embedded inside alphalist.html (1604-C).
   ============================================================ */

let _form2316State = { biz: null, setup: null, employees: null, year: null };

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
        const monthly = computeEmployee1601C(byEmployee[key].months, emp.taxStatus);
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
  const taxDue = computeAnnualTax(taxableComp);

  const isInd = setup.classification === 'Individual';
  const employerName = isInd
    ? [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '');

  const field = (num, label, value) => `
    <div class="f2316-field"><span class="f2316-num">${escHtml(String(num))}</span>
      <span class="f2316-label">${label}</span><span class="f2316-fill">${escHtml(value || '')}</span>
    </div>`;
  const item = (num, label, amount, totalCls = '') => `
    <div class="f2316-item ${totalCls}"><span class="lbl"><strong>${escHtml(String(num))}</strong> ${label}</span><span class="amt">${fmt(amount)}</span></div>`;

  return `
    <div class="f2316">
      <div class="f2316-head">
        <div class="hd-form">
          <div class="for-bir">For BIR<br>Use Only&nbsp;&nbsp;BCS/<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Item:</div>
          <div class="form-label">BIR Form No.</div>
          <div class="form-no">2316</div>
          <div class="form-rev">September 2021(ENCS)</div>
        </div>
        <div class="hd-mid">
          <div class="gov-lines">
            Republic of the Philippines<br>
            Department of Finance<br>
            <strong>Bureau of Internal Revenue</strong>
          </div>
          <div class="bir-title">Certificate of Compensation Payment / Tax Withheld</div>
          <div class="bir-sub">For Compensation Payment With or Without Tax Withheld</div>
        </div>
        <div class="hd-code">
          <div class="form-tag">2316 9/21ENCS</div>
        </div>
      </div>
      <div class="f2316-fill-note">Fill in all applicable spaces. Mark all appropriate boxes with an "X".</div>

      <div class="f2316-yp">
        <div>1 For the Year <span class="box">${escHtml(String(year))}</span></div>
        <div>2 For the Period <span class="box">01/01</span> To <span class="box">12/31</span></div>
      </div>

      <div class="f2316-cols">
        <div class="f2316-col">
          <div class="f2316-part-title">Part I – Employee Information</div>
          ${field(3, 'TIN', tinDashed1601(emp.tin))}
          ${field(4, "Employee's Name (Last, First, Middle)", name)}
          ${field(5, 'RDO Code', setup.rdoCode)}
          ${field(6, 'Registered Address', emp.address)}
          ${field('6A', 'ZIP Code', emp.zipCode)}
          ${field(7, 'Date of Birth', emp.dateOfBirth)}
          ${field(8, 'Contact Number', emp.contactNumber)}
          <div class="f2316-mwe-box">
            <strong>11</strong> Minimum Wage Earner (MWE) whose compensation is exempt from withholding tax and not subject to income tax:
            <strong>${isMWE ? '☑ YES' : '☐ NO'}</strong>
          </div>

          <div class="f2316-part-title">Part II – Employer Information (Present)</div>
          ${field(12, 'TIN', tinDashed1601(setup.tin))}
          ${field(13, "Employer's Name", employerName)}
          ${field(14, 'Registered Address', setup.address)}
          ${field('14A', 'ZIP Code', setup.zipCode)}

          <div class="f2316-part-title">Part III – Employer Information (Previous)</div>
          ${field(16, 'TIN', '')}
          ${field(17, "Employer's Name", '')}
          ${field(18, 'Registered Address', '')}

          <div class="f2316-part-title">Part IV-A – Summary</div>
          ${item(19, 'Gross Compensation Income from Present Employer', grossComp)}
          ${item(20, 'Less: Total Non-Taxable/Exempt Compensation Income', item38)}
          ${item(21, 'Taxable Compensation Income from Present Employer', item52)}
          ${item(22, 'Add: Taxable Compensation Income from Previous Employer', 0)}
          ${item(23, 'Gross Taxable Compensation Income', taxableComp)}
          ${item(24, 'Tax Due', taxDue, 'total')}
          ${item('25A', 'Amount of Taxes Withheld — Present Employer', taxWithheld)}
          ${item('25B', 'Amount of Taxes Withheld — Previous Employer', 0)}
          ${item(26, 'Total Amount of Taxes Withheld as Adjusted', taxWithheld)}
          ${item(27, '5% Tax Credit (PERA Act of 2008)', 0)}
          ${item(28, 'Total Taxes Withheld', taxWithheld, 'total')}
        </div>

        <div class="f2316-col">
          <div class="f2316-part-title">Part IV-B – Details of Compensation Income &amp; Tax Withheld from Present Employer</div>
          <div style="font-weight:700;margin-bottom:2px;">A. NON-TAXABLE/EXEMPT COMPENSATION INCOME</div>
          ${item(29, 'Basic Salary (incl. exempt P250,000 & below) or SMW of the MWE', item29)}
          ${item(30, 'Holiday Pay (MWE)', item30)}
          ${item(31, 'Overtime Pay (MWE)', item31)}
          ${item(32, 'Night Shift Differential (MWE)', item32)}
          ${item(33, 'Hazard Pay (MWE)', item33)}
          ${item(34, '13th Month Pay and Other Benefits (max. P90,000)', item34)}
          ${item(35, 'De Minimis Benefits', item35)}
          ${item(36, 'SSS, GSIS, PHIC & HDMF Contributions and Union Dues (Employee share)', item36)}
          ${item(37, 'Salaries and Other Forms of Compensation', item37)}
          ${item(38, 'Total Non-Taxable/Exempt Compensation Income', item38, 'total')}

          <div style="font-weight:700;margin:6px 0 2px;">B. TAXABLE COMPENSATION INCOME REGULAR</div>
          ${item(39, 'Basic Salary', item39)}
          ${item(40, 'Representation', 0)}
          ${item(41, 'Transportation', 0)}
          ${item(42, 'Cost of Living Allowance (COLA)', 0)}
          ${item(43, 'Fixed Housing Allowance', 0)}
          ${item('44A', 'Others — Other Taxable Compensation', item44)}
          <div style="font-weight:700;margin:6px 0 2px;">SUPPLEMENTARY</div>
          ${item(45, 'Commission', item45)}
          ${item(46, 'Profit Sharing', item46)}
          ${item(47, "Fees Including Director's Fees", item47)}
          ${item(48, 'Taxable 13th Month Benefits', item48)}
          ${item(49, 'Hazard Pay', item49)}
          ${item(50, 'Overtime Pay', item50)}
          ${item('51A', 'Others — Holiday Pay / Night Shift Differential', item51a)}
          ${item(52, 'Total Taxable Compensation Income', item52, 'total')}
        </div>
      </div>

      <div class="f2316-declaration">
        I/We declare, under the penalties of perjury that this certificate has been made in good faith, verified by me/us,
        and to the best of my/our knowledge and belief, is true and correct, pursuant to the provisions of the National
        Internal Revenue Code, as amended, and the regulations issued under authority thereof. Further, I/we give my/our
        consent to the processing of my/our information as contemplated under the *Data Privacy Act of 2012 (R.A. No. 10173)
        for legitimate and lawful purposes.
      </div>

      <div class="f2316-sig2">
        <div class="f2316-sig-row">
          <div class="f2316-sig-block">
            <div class="line">${setup.authRepSignature ? `<img class="sig-img" src="${setup.authRepSignature}" alt="Signature">` : ''}<span class="name-text">${escHtml(setup.authRep || '')}</span></div>
            <div class="cap"><strong>53</strong><br>Present Employer/Authorized Agent Signature over Printed Name</div>
          </div>
          <div class="f2316-sig-date">Date Signed: <span class="date-fill"></span></div>
        </div>

        <div class="f2316-conforme">CONFORME:</div>

        <div class="f2316-sig-row">
          <div class="f2316-sig-block">
            <div class="line"><span class="name-text">${escHtml(name || '')}</span></div>
            <div class="cap"><strong>54</strong><br>Employee Signature over Printed Name</div>
          </div>
          <div class="f2316-sig-date">Date Signed: <span class="date-fill"></span></div>
        </div>

        <div class="f2316-ctc-row">
          <div class="ctc-field">CTC/Valid ID No.<br>of Employee<span class="fill"></span></div>
          <div class="ctc-field">Place of<br>Issue<span class="fill"></span></div>
          <div class="ctc-date">Date Issued: <span class="date-fill"></span></div>
          <div class="ctc-amount">Amount paid, if CTC<span class="fill"></span></div>
        </div>
      </div>

      <div class="f2316-subfiling">
        <div class="f2316-subfiling-title">To be accomplished under substituted filing</div>
        <div class="f2316-subfiling-cols">
          <div class="f2316-subfiling-col">
            I declare, under the penalties of perjury that the information herein stated are reported under
            BIR Form No. 1604-C which has been filed with the Bureau of Internal Revenue.
            <div class="f2316-sig-block">
              <div class="line">${setup.authRepSignature ? `<img class="sig-img" src="${setup.authRepSignature}" alt="Signature">` : ''}<span class="name-text">${escHtml(setup.authRep || '')}</span></div>
              <div class="cap"><strong>55</strong><br>Present Employer/Authorized Agent Signature over Printed Name<br>(Head of Accounting/Human Resource or Authorized Representative)</div>
            </div>
          </div>
          <div class="f2316-subfiling-col">
            I declare, under the penalties of perjury that I am qualified under substituted filing of Income Tax Return
            (BIR Form No. 1700), since I received purely compensation income from only one employer in the Philippines
            for the calendar year; that taxes have been correctly withheld by my employer (tax due equals tax withheld);
            that the BIR Form No. 1604-C filed by my employer to the BIR shall constitute as my income tax return; and
            that BIR Form No. 2316 shall serve the same purpose as if BIR Form No. 1700 has been filed pursuant to the
            provisions of Revenue Regulations (RR) No. 3-2002, as amended.
            <div class="f2316-sig-block">
              <div class="line"><span class="name-text">${escHtml(name || '')}</span></div>
              <div class="cap"><strong>56</strong><br>Employee Signature over Printed Name</div>
            </div>
          </div>
        </div>
      </div>

      <div class="f2316-note">*NOTE: The BIR Data Privacy is in the BIR website (www.bir.gov.ph)</div>
    </div>`;
}
