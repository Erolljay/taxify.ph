/* ============================================================
   Tallo CPA – BIR Tax App
   1701q-report.js – Quarterly Income Tax Return for Individuals
                      (BIR Form 1701-Q, Jan 2018 ENCS)

   Scope (v1 "core path"): single taxpayer (no spouse schedule),
   graduated rates OR 8% flat option, itemized OR OSD deduction,
   no NOLCO/exempt/special-rate schedules. Sales/COGS/Opex are
   reconstructed from transactions via pnl-helpers.js; manual
   inputs cover figures Manager.io has no transaction trail for
   (non-operating income, penalties).

   Prior Year's Excess Credit is read from a dedicated Balance Sheet
   account, resolved via the COA tab's Deferred Tax Asset role mapping
   (see DTA_ROLES/getDtaBalance in pnl-helpers.js — same role as
   1702q-report.js uses, since a business is always either Individual
   or Non-Individual, never both, so there's no collision risk sharing
   it) instead of a manual input, so it doesn't reset every session.
   ============================================================ */

// Graduated tax table now lives in tax-rates.js (Settings → Tax Rates),
// keyed by effective date so each return uses the bracket table that was
// actually in force for the year/quarter being filed.
function graduatedTaxDue(taxableIncome, year) {
  return computeGraduatedTax(taxableIncome, dateForYear(year));
}

async function init1701QReport() {
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
  if (setup.classification !== 'Individual') {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ BIR Form 1701-Q is for Individual taxpayers only. This business is set up as Non-Individual.</div>`;
    return null;
  }
  outputEl.innerHTML = '';

  filterEl.innerHTML = periodFilterHTML('quarterly', 'c1701q');
  filterEl.insertAdjacentHTML('beforeend', `
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin || '—')}</strong>
    </div>
    <div class="filter-bar" style="margin-top:6px;">
      <label>Method</label>
      <select id="c1701q-method">
        <option value="graduated">Graduated Rates</option>
        <option value="8pct">8% Flat Rate</option>
      </select>
      <label>Deduction</label>
      <select id="c1701q-deduction">
        <option value="itemized">Itemized Deduction</option>
        <option value="osd">Optional Standard Deduction (OSD)</option>
      </select>
    </div>`);

  document.getElementById('c1701q-gen').addEventListener('click', () => generate1701Q(biz, setup, outputEl));
  return biz;
}

async function generate1701Q(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Aggregating transactions…</span></div>`;

  const quarter = parseInt(document.getElementById('c1701q-quarter').value, 10);
  const year = parseInt(document.getElementById('c1701q-year').value, 10);
  const method = document.getElementById('c1701q-method').value;
  const deduction = document.getElementById('c1701q-deduction').value;

  try {
    await loadTaxRatesData();
    const coa = await loadChartOfAccounts(biz);
    const yearStart = new Date(year, 0, 1);
    const { start: qStart, end: qEnd } = getPeriodDates('quarterly', quarter, year);
    const prevEnd = new Date(qStart.getTime() - 86400000);

    const [thisQ, cumPrev] = await Promise.all([
      aggregateAccountActivity(biz, qStart, qEnd, coa),
      quarter > 1 ? aggregateAccountActivity(biz, yearStart, prevEnd, coa) : Promise.resolve({ totals: { income: 0, cogs: 0, opex: 0 } }),
    ]);

    const dtaMap = await getDtaRoleMapping(biz);
    const cwtPrepaid2306 = isFinite(quarter) ? await getDtaBalance(biz, coa, dtaMap, qEnd, 'cwt2306') : 0;
    const cwtPrepaid2306PrevQ = quarter > 1 ? await getDtaBalance(biz, coa, dtaMap, prevEnd, 'cwt2306') : 0;
    const cwtThisQuarter = cwtPrepaid2306 - cwtPrepaid2306PrevQ;

    const priorYearExcessCredit = await getDtaBalance(biz, coa, dtaMap, qEnd, 'priorYearExcessCredit');
    const itrPaymentsPrevQ = quarter > 1 ? await getDtaBalance(biz, coa, dtaMap, prevEnd, 'itrPaymentsRegular') : 0;

    const period = { quarter, year, label: `${quarterLabel(quarter)} ${year}` };
    render1701Q(outputEl, {
      thisQ, cumPrev, cwtThisQuarter,
      cwtPrevQuarters: cwtPrepaid2306PrevQ,
      priorYearExcessCredit,
      itrPaymentsPrevQ,
      coa, dtaMap,
    }, setup, period, method, deduction);

    ['c1701q-print', 'c1701q-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function netIncomeFor(totals, deduction, itemizedTotal, year) {
  const sales = totals.income;
  const cogs = totals.cogs;
  const grossIncome = sales - cogs;
  const itemized = itemizedTotal !== undefined ? itemizedTotal : totals.opex;
  const osd = getOsdRate(dateForYear(year)) * sales;
  const allowable = deduction === 'osd' ? osd : itemized;
  return { sales, cogs, grossIncome, itemized, osd, allowable, netIncome: grossIncome - allowable };
}

function render1701Q(el, data, setup, period, method, deduction) {
  const taxpayerName = [setup.lastName, setup.firstName, setup.middleName].filter(Boolean).join(', ') || setup.taxpayerName;

  const schedule = buildItemizedSchedule(App.currentBusiness, data.thisQ.byAccount);
  const thisQ = netIncomeFor(data.thisQ.totals, deduction, schedule.total, period.year);
  const prevQ = netIncomeFor(data.cumPrev.totals, deduction, undefined, period.year);

  const pnlHtml = renderPnLStatementHtml(data.thisQ.totals, data.thisQ.byAccount);
  const mappingHtml = renderDeductionScheduleHtml(schedule, 'Ordinary Allowable Itemized Deductions (This Quarter)');

  const formHtml = `
    <div class="form-title">
      <h2>BIR Form 1701-Q — Quarterly Income Tax Return for Individuals, Estates and Trusts</h2>
      <div class="sub">For ${escHtml(period.label)} &nbsp;|&nbsp; ${method === '8pct' ? '8% Flat Rate' : 'Graduated Rates — ' + (deduction === 'osd' ? 'OSD' : 'Itemized Deduction')}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(setup.tin || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Taxpayer/Filer's Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(taxpayerName)}</div></div>
      <div class="return-line"><div class="return-line-num">10</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
    </div>

    ${method === '8pct' ? render1701QSchedule2(thisQ, prevQ, data) : render1701QSchedule1(thisQ, prevQ, deduction)}

    <div class="return-section">
      <div class="return-section-header">Schedule III – Tax Credits/Payments</div>
      ${returnLine(55, "Prior Year's Excess Credits <span style=\"font-size:10px;color:#9ca3af;font-weight:400;\">(auto — from books)</span>", data.priorYearExcessCredit)}
      ${returnLine(56, 'Tax Payment/s for the Previous Quarter/s <span style="font-size:10px;color:#9ca3af;font-weight:400;">(auto — from books)</span>', data.itrPaymentsPrevQ)}
      ${returnLine(57, 'Creditable Tax Withheld for the Previous Quarter/s <span style="font-size:10px;color:#9ca3af;font-weight:400;">(auto — from books)</span>', data.cwtPrevQuarters)}
      ${returnLine(58, 'Creditable Tax Withheld per BIR Form No. 2307 for this Quarter', data.cwtThisQuarter)}
      ${manualLine(59, 'Tax Paid in Return Previously Filed, if Amended', 'c1701q-59')}
      ${manualLine(60, 'Foreign Tax Credits, if applicable', 'c1701q-60')}
      ${manualLine(61, 'Other Tax Credits/Payments', 'c1701q-61')}
      <div class="return-line"><div class="return-line-num">62</div><div class="return-line-label" style="font-weight:700;">Total Tax Credits/Payments</div><div class="return-line-amt" id="c1701q-line62">₱ 0.00</div></div>
    </div>

    ${renderDtaEntryPanelHtml1701Q()}

    <div class="return-section">
      <div class="return-section-header">Part III – Total Tax Payable</div>
      <div class="return-line"><div class="return-line-num">26</div><div class="return-line-label" style="font-weight:700;">Tax Due</div><div class="return-line-amt" id="c1701q-line26">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">27</div><div class="return-line-label">Less: Tax Credits/Payments</div><div class="return-line-amt" id="c1701q-line27">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">28</div><div class="return-line-label" style="font-weight:700;">Tax Payable/(Overpayment)</div><div class="return-line-amt" id="c1701q-line28">₱ 0.00</div></div>
      ${manualLine(64, 'Surcharge', 'c1701q-64')}
      ${manualLine(65, 'Interest', 'c1701q-65')}
      ${manualLine(66, 'Compromise', 'c1701q-66')}
      <div class="return-line"><div class="return-line-num">67</div><div class="return-line-label">Total Penalties</div><div class="return-line-amt" id="c1701q-line67">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">30</div><div class="return-line-label" style="font-weight:700;">TOTAL AMOUNT PAYABLE/(OVERPAYMENT)</div><div class="return-line-amt highlight payable" id="c1701q-line30">₱ 0.00</div></div>
    </div>`;

  el.innerHTML = renderIncomeTaxTabs([
    { key: 'pnl', label: 'Profit and Loss Statement', html: pnlHtml },
    { key: 'mapping', label: 'BIR Mapping of COA', html: mappingHtml },
    { key: 'form', label: 'BIR Form', html: formHtml },
  ], 'form');

  el._cwtThisQuarter = data.cwtThisQuarter;
  el._cwtPrevQuarters = data.cwtPrevQuarters;
  el._priorYearExcessCredit = data.priorYearExcessCredit;
  el._itrPaymentsPrevQ = data.itrPaymentsPrevQ;
  bindIncomeTaxTabs(el);
  el.querySelectorAll('.recon-manual-input').forEach(inp => inp.addEventListener('input', () => recompute1701Q(el, thisQ, prevQ, method)));
  el._year = period.year;
  bindDeductionMappingTable(el, App.currentBusiness, () => render1701Q(el, data, setup, period, method, deduction));
  bindDtaEntryPanel1701Q(el, App.currentBusiness, data.coa, data.dtaMap, () => generate1701Q(App.currentBusiness, setup, el));
  recompute1701Q(el, thisQ, prevQ, method);
}

function render1701QSchedule1(thisQ, prevQ, deduction) {
  const allowableLabel = deduction === 'osd' ? '40 Optional Standard Deduction (OSD)' : '39 Total Allowable Itemized Deductions';
  return `
    <div class="return-section">
      <div class="return-section-header">Schedule I – For Graduated IT Rate</div>
      ${returnLine(36, 'Sales/Revenues/Receipts/Fees (net of returns, allowances &amp; discounts)', thisQ.sales)}
      ${returnLine(37, 'Less: Cost of Sales/Services', thisQ.cogs)}
      ${returnLine(38, 'Gross Income/(Loss) from Operation', thisQ.grossIncome, true)}
      ${returnLine(deduction === 'osd' ? 40 : 39, allowableLabel, thisQ.allowable)}
      ${returnLine(41, 'Net Income/(Loss) This Quarter', thisQ.netIncome, true)}
      ${returnLine(42, 'Add: Taxable Income/(Loss) Previous Quarter/s', prevQ.netIncome)}
      ${manualLine(43, 'Non-Operating Income', 'c1701q-43')}
      ${manualLine(44, 'Share in Income from General Professional Partnership (GPP)', 'c1701q-44')}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">45</div><div class="return-line-label">Total Taxable Income/(Loss) To Date</div><div class="return-line-amt" id="c1701q-line45">0.00</div></div>
      <div class="return-line highlight" style="font-weight:700;"><div class="return-line-num">46</div><div class="return-line-label">TAX DUE (Graduated Rates per Tax Table)</div><div class="return-line-amt" id="c1701q-line46">0.00</div></div>
    </div>`;
}

function render1701QSchedule2(thisQ, prevQ, data) {
  return `
    <div class="return-section">
      <div class="return-section-header">Schedule II – For 8% IT Rate</div>
      ${returnLine(47, 'Sales/Revenues/Receipts/Fees (net of returns, allowances &amp; discounts)', thisQ.sales)}
      ${manualLine(48, 'Add: Non-Operating Income', 'c1701q-48')}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">49</div><div class="return-line-label">Total Income for the Quarter</div><div class="return-line-amt" id="c1701q-line49">0.00</div></div>
      ${returnLine(50, 'Add: Total Taxable Income/(Loss) Previous Quarter', prevQ.sales)}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">51</div><div class="return-line-label">Cumulative Taxable Income/(Loss) as of This Quarter</div><div class="return-line-amt" id="c1701q-line51">0.00</div></div>
      ${returnLine(52, 'Less: Allowable Reduction (P250,000)', 250000)}
      <div class="return-line" style="font-weight:700;"><div class="return-line-num">53</div><div class="return-line-label">Taxable Income/(Loss) To Date</div><div class="return-line-amt" id="c1701q-line53">0.00</div></div>
      <div class="return-line highlight" style="font-weight:700;"><div class="return-line-num">54</div><div class="return-line-label">TAX DUE (8% Tax Rate)</div><div class="return-line-amt" id="c1701q-line54">0.00</div></div>
    </div>`;
}

function manualLine(num, label, inputId) {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label">${escHtml(label)}</div>
    <div class="return-line-amt"><input type="number" step="0.01" class="recon-manual-input" id="${inputId}" value="0" style="width:120px;text-align:right;font-size:12px;"></div>
  </div>`;
}

// Same panel as 1702q-report.js's renderDtaEntryPanelHtml/bindDtaEntryPanel,
// trimmed to the roles that apply to individuals — no MCIT concept here, so
// no itrPaymentsMcit/mcitCarryforward options.
const DTA_ROLES_1701Q = ['priorYearExcessCredit', 'itrPaymentsRegular', 'cwt2306'];

function renderDtaEntryPanelHtml1701Q() {
  const roleOpts = DTA_ROLES.filter(r => DTA_ROLES_1701Q.includes(r.key))
    .map(r => `<option value="${r.key}">${escHtml(r.label)}</option>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  return `
    <details class="no-print" style="margin:10px 0;border:1px solid #e5e7eb;border-radius:6px;padding:8px;">
      <summary style="cursor:pointer;font-size:12px;font-weight:600;">📝 Record a Carry-Forward Entry</summary>
      <p style="font-size:11px;color:#6b7280;margin:8px 0;">Posts a journal entry to Manager so the balance is picked up automatically on future returns — no manual re-entry needed. The account for each role is whatever's mapped in Settings → Chart of Accounts (or its default name, if unmapped).</p>
      <div class="filter-bar" style="flex-wrap:wrap;gap:8px;">
        <label>Date</label>
        <input type="date" id="c1701q-dta-date" value="${today}" style="width:130px;">
        <label>Role</label>
        <select id="c1701q-dta-role" style="min-width:180px;">${roleOpts}</select>
        <label>Direction</label>
        <select id="c1701q-dta-direction" style="min-width:220px;">
          <option value="increase">Increase (payment made / balance established)</option>
          <option value="decrease">Decrease (applied against tax due / written off)</option>
        </select>
      </div>
      <div class="filter-bar" style="flex-wrap:wrap;margin-top:6px;gap:8px;">
        <label>Amount</label>
        <input type="number" step="0.01" id="c1701q-dta-amount" style="width:140px;text-align:right;">
        <label>Counter-account</label>
        <select id="c1701q-dta-counter" style="min-width:220px;"><option value="">Loading accounts…</option></select>
        <label>Description</label>
        <input type="text" id="c1701q-dta-desc" style="width:200px;" placeholder="optional">
      </div>
      <div style="margin-top:8px;">
        <button type="button" class="btn btn-primary btn-sm" id="c1701q-dta-post">Post Entry</button>
        <span id="c1701q-dta-status" style="font-size:11px;color:#6b7280;margin-left:8px;"></span>
      </div>
    </details>`;
}

function bindDtaEntryPanel1701Q(el, biz, coa, dtaMap, onPosted) {
  const counterSel = el.querySelector('#c1701q-dta-counter');
  const postBtn = el.querySelector('#c1701q-dta-post');
  if (!counterSel || !postBtn) return;

  const allAccts = Object.values(coa || {})
    .filter(a => a.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  counterSel.innerHTML = allAccts.map(a => `<option value="${a.key}">${escHtml(a.name)}</option>`).join('');

  postBtn.addEventListener('click', async () => {
    const statusEl = el.querySelector('#c1701q-dta-status');
    const date = el.querySelector('#c1701q-dta-date').value;
    const roleKey = el.querySelector('#c1701q-dta-role').value;
    const isIncrease = el.querySelector('#c1701q-dta-direction').value === 'increase';
    const amount = parseFloat(el.querySelector('#c1701q-dta-amount').value) || 0;
    const counterGuid = counterSel.value;
    const desc = el.querySelector('#c1701q-dta-desc').value.trim();

    if (!date) { statusEl.textContent = '❌ Pick a date.'; return; }
    if (amount <= 0.005) { statusEl.textContent = '❌ Enter an amount greater than zero.'; return; }
    if (!counterGuid) { statusEl.textContent = '❌ Pick a counter-account.'; return; }

    const dtaAccount = findDtaAccount(coa, dtaMap, roleKey);
    if (!dtaAccount) {
      statusEl.textContent = '❌ No account is mapped to this role yet — map or create one in Settings → Chart of Accounts first.';
      return;
    }

    const role = DTA_ROLES.find(r => r.key === roleKey);
    const lineDesc = desc || role.label;
    const lines = [
      { account: dtaAccount.key, lineDescription: lineDesc, debit: isIncrease ? amount : 0, credit: isIncrease ? 0 : amount },
      { account: counterGuid, lineDescription: lineDesc, debit: isIncrease ? 0 : amount, credit: isIncrease ? amount : 0 },
    ];

    statusEl.textContent = 'Posting…';
    postBtn.disabled = true;
    try {
      await apiRequest('PUT', '/api4/journal-entry', {
        key: crypto.randomUUID(),
        value: { date, narration: `${role.label} — ${isIncrease ? 'established/payment' : 'applied/written off'}`, lines },
      });
      statusEl.textContent = '✅ Posted — refreshing figures…';
      await onPosted();
    } catch (err) {
      statusEl.textContent = `❌ ${err.message}`;
      postBtn.disabled = false;
    }
  });
}

function val(id) {
  const el = document.getElementById(id);
  return el ? (parseFloat(el.value) || 0) : 0;
}

function recompute1701Q(el, thisQ, prevQ, method) {
  const year = el._year;
  let taxDue;
  if (method === '8pct') {
    const nonOp = val('c1701q-48');
    const line49 = thisQ.sales + nonOp;
    const line51 = line49 + prevQ.sales;
    const line53 = Math.max(0, line51 - 250000);
    taxDue = line53 * getEightPercentRate(dateForYear(year));
    setText(el, 'c1701q-line49', line49);
    setText(el, 'c1701q-line51', line51);
    setText(el, 'c1701q-line53', line53);
    setText(el, 'c1701q-line54', taxDue);
  } else {
    const nonOp = val('c1701q-43');
    const gpp = val('c1701q-44');
    const line45 = thisQ.netIncome + prevQ.netIncome + nonOp + gpp;
    taxDue = graduatedTaxDue(line45, year);
    setText(el, 'c1701q-line45', line45);
    setText(el, 'c1701q-line46', taxDue);
  }

  const line62 = ['c1701q-59','c1701q-60','c1701q-61'].reduce((s, id) => s + val(id), 0)
    + (el._cwtThisQuarter || 0) + (el._cwtPrevQuarters || 0)
    + (el._priorYearExcessCredit || 0) + (el._itrPaymentsPrevQ || 0);

  setText(el, 'c1701q-line62', line62);
  setText(el, 'c1701q-line26', taxDue);
  setText(el, 'c1701q-line27', line62);
  const line28 = taxDue - line62;
  setText(el, 'c1701q-line28', line28);

  const penalties = ['c1701q-64','c1701q-65','c1701q-66'].reduce((s, id) => s + val(id), 0);
  setText(el, 'c1701q-line67', penalties);
  const totalPayable = line28 + penalties;
  setText(el, 'c1701q-line30', totalPayable);

  // Exposed for the "Record Payment / Journal Entry" workflow step
  // (step-engine.js's mountItrPaymentStepContent), which reads this straight
  // out of this report's iframe rather than recomputing anything itself.
  window._itr = { totalPayable };
}

function setText(el, id, amount) {
  const target = el.querySelector(`#${id}`);
  if (target) target.textContent = `₱ ${fmt(amount)}`;
}
