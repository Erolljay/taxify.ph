/* ============================================================
   Tallo CPA – BIR Tax App
   1601c-report.js – Monthly Remittance Return of Income Taxes
                      Withheld on Compensation (BIR Form 1601-C)
   ============================================================ */

async function init1601CReport() {
  const filterEl = document.getElementById('filter-area');
  const outputEl = document.getElementById('report-output');

  let biz;
  try {
    biz = await getReportBusiness(document.getElementById('biz-selector-wrap'));
    App.currentBusiness = biz;
  } catch (e) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Could not connect to Manager: ${escHtml(e.message)}</div>`;
    return null;
  }

  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Loading business setup…</span></div>`;
  const setup = await loadSetup(biz);
  if (!setup) {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ Business info not configured. Fill in the <strong>Business</strong> tab in the Tallo CPA extension first.</div>`;
    return null;
  }
  outputEl.innerHTML = '';

  filterEl.innerHTML = periodFilterHTML('monthly', 'c1601');
  filterEl.insertAdjacentHTML('beforeend', `
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(tinDashed1601(setup.tin))}</strong>
    </div>`);

  document.getElementById('c1601-gen').addEventListener('click', () => generate1601C(biz, setup, outputEl));
  return biz;
}

// ── EMPLOYEE TAX STATUS TAB ─────────────────────────────────────
// Bulk list-and-edit view so the preparer can review every employee's
// Tax Status (MWE/NMWE) at a glance and correct it before running any
// 1601-C/1604-C/2316 report — those reports now skip employees whose
// Tax Status is blank, so this tab is how blanks get fixed.
let _taxStatusState = { biz: null, birGuids: null, employees: [] };
// Exposed on window (top-level `let` doesn't become a window property) so the
// parent wizard's step engine can poll completeness from outside this iframe.
window._taxStatusState = _taxStatusState;

async function initEmployeeTaxStatusTab(biz) {
  _taxStatusState.biz = biz;
  const outputEl = document.getElementById('taxstatus-output');
  const filterEl = document.getElementById('taxstatus-filter-bar');
  filterEl.innerHTML = `
    <input type="text" id="ts-search" placeholder="Search employee…" style="font-size:12px;min-width:220px;">
    <button class="btn btn-outline" id="ts-refresh">🔄 Refresh</button>
  `;
  document.getElementById('ts-refresh').addEventListener('click', loadTaxStatusList);
  document.getElementById('ts-search').addEventListener('input', renderTaxStatusList);
  await loadTaxStatusList();

  async function loadTaxStatusList() {
    outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Loading employees…</span></div>`;
    try {
      const [raw, birGuids] = await Promise.all([
        fetchAllBatch('/api4/employee-batch', biz),
        ensureBIRFields(biz),
      ]);
      _taxStatusState.birGuids = birGuids;
      _taxStatusState.employees = raw.map(it => {
        const value = it.item || it.value || {};
        const cf = parseBIRBlob((value.customFields2 && value.customFields2.strings) || {}, birGuids && birGuids.emp, 'b1r00003-');
        const taxStatusFieldId = (window.CF && window.CF.EMPLOYEE_FIELDS[5].id);
        return {
          key: it.key,
          value,
          name: value.name || value.Name || it.key,
          tin: cf[(window.CF && window.CF.EMPLOYEE_FIELDS[0].id)] || '',
          taxStatus: cf[taxStatusFieldId] || '',
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
      renderTaxStatusList();
    } catch (err) {
      outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
    }
  }

  function renderTaxStatusList() {
    const q = (document.getElementById('ts-search').value || '').toLowerCase();
    const rows = _taxStatusState.employees.filter(e => !q || e.name.toLowerCase().includes(q));
    const blanks = _taxStatusState.employees.filter(e => !e.taxStatus).length;

    const opts = [
      { v: '', l: '-- not set --' },
      { v: 'MWE', l: 'MWE - Minimum Wage Earner' },
      { v: 'NMWE', l: 'NMWE - Non-Minimum Wage Earner' },
    ];

    outputEl.innerHTML = `
      ${blanks ? `<div class="alert alert-warn">⚠️ ${blanks} employee(s) have no Tax Status set — they are excluded from 1601-C, 1604-C, and 2316 reports until fixed here.</div>` : ''}
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Employee</th><th>TIN</th><th>Tax Status</th><th></th></tr></thead>
          <tbody>
            ${rows.map(e => `
              <tr data-emp-key="${escHtml(e.key)}">
                <td>${escHtml(e.name)}</td>
                <td style="font-family:monospace;">${escHtml(e.tin || '—')}</td>
                <td>
                  <select class="ts-select" data-emp-key="${escHtml(e.key)}" style="font-size:12px;${!e.taxStatus ? 'border-color:#f59e0b;' : ''}">
                    ${opts.map(o => `<option value="${o.v}"${o.v === e.taxStatus ? ' selected' : ''}>${escHtml(o.l)}</option>`).join('')}
                  </select>
                </td>
                <td><button class="btn btn-outline ts-save-row" data-emp-key="${escHtml(e.key)}" style="font-size:11px;padding:2px 10px;">Save</button></td>
              </tr>`).join('') || `<tr><td colspan="4" style="text-align:center;color:#9ca3af;">No employees found</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:flex-end;">
        <button class="btn btn-primary" id="ts-save-all">💾 Save All</button>
      </div>`;

    outputEl.querySelectorAll('.ts-save-row').forEach(btn => {
      btn.addEventListener('click', () => saveTaxStatusRow(btn.dataset.empKey, btn));
    });
    document.getElementById('ts-save-all').addEventListener('click', saveAllTaxStatus);
  }

  async function saveTaxStatusRow(empKey, btn) {
    const emp = _taxStatusState.employees.find(e => e.key === empKey);
    const select = outputEl.querySelector(`.ts-select[data-emp-key="${empKey}"]`);
    if (!emp || !select) return;
    const newStatus = select.value;
    try {
      const updated = await window.CF.saveEmployeeTaxStatus(biz, emp.key, emp.value, newStatus, _taxStatusState.birGuids);
      emp.value = updated;
      emp.taxStatus = newStatus;
      select.style.borderColor = '';
      if (btn) flashSaveBtn(btn, true);
    } catch (err) {
      if (btn) flashSaveBtn(btn, false);
      console.error(err);
    }
  }

  async function saveAllTaxStatus() {
    const btn = document.getElementById('ts-save-all');
    const selects = [...outputEl.querySelectorAll('.ts-select')];
    let ok = 0, fail = 0;
    for (const select of selects) {
      const empKey = select.dataset.empKey;
      const emp = _taxStatusState.employees.find(e => e.key === empKey);
      if (!emp || emp.taxStatus === select.value) continue; // nothing changed
      try {
        const updated = await window.CF.saveEmployeeTaxStatus(biz, emp.key, emp.value, select.value, _taxStatusState.birGuids);
        emp.value = updated;
        emp.taxStatus = select.value;
        select.style.borderColor = '';
        ok++;
      } catch (err) {
        fail++;
        console.error(err);
      }
    }
    flashSaveBtn(btn, fail === 0, ok ? `Saved ${ok}` : 'No changes');
    if (ok) renderTaxStatusList();
  }
}

function flashSaveBtn(btn, success, label) {
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = success ? `✓ ${label || 'Saved'}` : '✗ Failed';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
}


async function generate1601C(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching payroll data…</span></div>`;

  const month = parseInt(document.getElementById('c1601-month').value, 10);
  const year  = parseInt(document.getElementById('c1601-year').value, 10);

  try {
    const [byEmployee, employees] = await Promise.all([
      buildPayrollYear(biz, year),
      loadEmployeesBIR(biz),
      loadTaxRatesData(),
    ]);

    const rows = [];
    let totals = { line14:0, line15:0, line16:0, line17:0, line18:0, line19:0, line20:0, line21:0, line22:0, line23:0, line24:0, line25:0 };

    for (const [empKey, data] of Object.entries(byEmployee)) {
      const emp = employees[empKey];
      if (!emp || !emp.taxStatus) continue; // exclude employees with no Tax Status set
      const computed = computeEmployee1601C(data.months, emp.taxStatus, year);
      const m = computed[month];
      if (!m.line14) continue; // skip employees with no pay this month

      const name = [emp.lastName, emp.firstName, emp.middleName].filter(Boolean).join(', ') || emp.name;
      rows.push({ empKey, name, tin: emp.tin, taxStatus: emp.taxStatus, ...m });

      for (const k of Object.keys(totals)) totals[k] += m[k] || 0;
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));

    const period = { month, year, label: `${monthName(month)} ${year}` };
    render1601C(outputEl, rows, totals, setup, period);

    ['c1601-print','c1601-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function render1601C(el, rows, totals, setup, period) {
  const isInd = setup.classification === 'Individual';
  const agentName = isInd
    ? [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ')
    : (setup.companyName || setup.taxpayerName || '');

  const taxDue = totals.line25; // Line 25 total per Part II is the basis carried to Part III
  const totalRemittance = taxDue;

  // Exposed for the wizard's freeze/variance step (parallels window._v / _e /
  // _itr in the other reports) — the headline figure the filing snapshots,
  // plus the period this render represents so the freeze keys the snapshot to
  // exactly what's on screen (month is 0-based, matching monthName()).
  window._c = { totalRemittance };
  window._period = { ptype: 'monthly', year: period.year, period: period.month, form: '1601C', label: period.label };

  const detailRows = rows.map(r => `
    <tr>
      <td>${escHtml(r.name)}</td>
      <td style="font-family:monospace;">${escHtml(tinDashed1601(r.tin))}</td>
      <td>${escHtml(r.taxStatus)}</td>
      <td class="num">${fmt(r.line14)}</td>
      <td class="num">${fmt(r.line15)}</td>
      <td class="num">${fmt(r.line16)}</td>
      <td class="num">${fmt(r.line21)}</td>
      <td class="num">${fmt(r.line22)}</td>
      <td class="num">${fmt(r.line23)}</td>
      <td class="num">${fmt(r.line24)}</td>
      <td class="num">${fmt(r.line25)}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="form-title">
      <h2>BIR Form 1601-C — Monthly Remittance Return of Income Taxes Withheld on Compensation</h2>
      <div class="sub">For the Month of: ${escHtml(period.label)}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(tinDashed1601(setup.tin))}</div></div>
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">8</div><div class="return-line-label">Withholding Agent's Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(agentName)}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">9A</div><div class="return-line-label">ZIP Code</div><div class="return-line-amt">${escHtml(setup.zipCode || '—')}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part II – Computation of Tax</div>
      ${returnLine(14, 'Total Amount of Compensation', totals.line14)}
      ${returnLine(15, 'Statutory Minimum Wage for Minimum Wage Earners (MWEs)', totals.line15)}
      ${returnLine(16, 'Holiday Pay, Overtime Pay, Night Shift Differential Pay, Hazard Pay (for MWEs only)', totals.line16)}
      ${returnLine(17, '13th Month Pay and Other Benefits', totals.line17)}
      ${returnLine(18, 'De Minimis Benefits', totals.line18)}
      ${returnLine(19, 'SSS, GSIS, PHIC, HDMF Mandatory Contributions &amp; Union Dues (employee’s share only)', totals.line19)}
      ${returnLine(20, 'Other Non-Taxable Compensation', totals.line20)}
      ${returnLine(21, 'Total Non-Taxable Compensation (Sum of Items 15 to 20)', totals.line21, true)}
      ${returnLine(22, 'Total Taxable Compensation (Line 14 less Line 21)', totals.line22, true)}
      ${returnLine(23, 'Less: Compensation of Employees Whose Tax Due is Zero (per Sched. I)', totals.line23)}
      ${returnLine(24, 'Net Taxable Compensation Subject to Withholding (Line 22 less Line 23)', totals.line24, true)}
      ${returnLine(25, 'Total Taxes Withheld', totals.line25, true, 'highlight')}
      ${returnLine(26, 'Add/(Less): Adjustment of Taxes Withheld from Previous Month/s', 0)}
      ${returnLine(27, 'Taxes Withheld for Remittance (Sum of Items 25 and 26)', totals.line25, true)}
      ${returnLine(28, 'Less: Tax Remitted in Return Previously Filed, if this is an Amended Return', 0)}
      ${returnLine(29, 'Other Remittances Made', 0)}
      ${returnLine(30, 'Total Tax Remittances Made (Sum of Items 28 and 29)', 0)}
      ${returnLine(31, 'TAX STILL DUE / (OVER-REMITTANCE) (Item 27 less Item 30)', totalRemittance, true, 'highlight payable')}
    </div>

    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">Employees</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Total Compensation</div><div class="stat-value small">₱ ${fmt(totals.line14)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Tax Withheld</div><div class="stat-value small">₱ ${fmt(totals.line25)}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Schedule I — Per-Employee Computation for ${escHtml(period.label)}</div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>Employee</th><th>TIN</th><th>Status</th>
            <th class="num">Gross Comp. (14)</th>
            <th class="num">Stat. Min. Wage (15)</th><th class="num">Holiday/OT/etc. (16)</th>
            <th class="num">Non-Taxable (21)</th>
            <th class="num">Taxable (22)</th><th class="num">Excl. – Line 23</th>
            <th class="num">Net Taxable (24)</th><th class="num">Tax Withheld (25)</th>
          </tr></thead>
          <tbody>${detailRows || `<tr><td colspan="11" style="text-align:center;color:#9ca3af;">No payroll records for this month</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="3" style="font-weight:700;">TOTALS</td>
            <td class="num">${fmt(totals.line14)}</td>
            <td class="num">${fmt(totals.line15)}</td><td class="num">${fmt(totals.line16)}</td>
            <td class="num">${fmt(totals.line21)}</td>
            <td class="num">${fmt(totals.line22)}</td><td class="num">${fmt(totals.line23)}</td>
            <td class="num">${fmt(totals.line24)}</td><td class="num">${fmt(totals.line25)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>`;
}
