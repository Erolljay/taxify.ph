/* ============================================================
   Tallo CPA – BIR Tax App
   1702q-report.js – Quarterly Income Tax Return for Corporations,
                      Partnerships and Other Non-Individual
                      Taxpayers (BIR Form 1702-Q, Jan 2018 ENCS)

   Scope (v1 "core path"): regular/normal rate only (no EXEMPT or
   SPECIAL rate schedule), itemized OR OSD deduction, MCIT compared
   against regular tax for the current quarter. CREATE Law rate (25%
   or the 20% small-corporation rate) is preparer-selected since
   Manager.io does not track total assets.

   Cross-year figures (Prior Year's Excess Credit, prior quarters'
   ITR/MCIT payments, unexpired MCIT carryforward) are read from 4
   dedicated Balance Sheet accounts instead of manual inputs — see
   DTA_ACCOUNTS in pnl-helpers.js — so they don't reset every session
   and don't rely on the preparer re-typing a number this same app
   already computed on an earlier quarter's return.
   ============================================================ */

async function init1702QReport() {
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
  if (setup.classification === 'Individual') {
    outputEl.innerHTML = `<div class="alert alert-warn">⚠️ BIR Form 1702-Q is for Corporations/Partnerships only. This business is set up as Individual.</div>`;
    return null;
  }
  outputEl.innerHTML = '';

  await loadTaxRatesData();
  filterEl.innerHTML = periodFilterHTML('quarterly', 'c1702q');
  filterEl.insertAdjacentHTML('beforeend', `
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin || '—')}</strong>
    </div>
    <div class="filter-bar" style="margin-top:6px;">
      <label>Regular Rate</label>
      <select id="c1702q-rate">${corporateRateOptionsHtml()}</select>
      <label>Deduction</label>
      <select id="c1702q-deduction">
        <option value="itemized">Itemized Deduction</option>
        <option value="osd">Optional Standard Deduction (OSD)</option>
      </select>
    </div>`);

  document.getElementById('c1702q-gen').addEventListener('click', () => generate1702Q(biz, setup, outputEl));
  return biz;
}

async function generate1702Q(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Aggregating transactions…</span></div>`;

  const quarter = parseInt(document.getElementById('c1702q-quarter').value, 10);
  const year = parseInt(document.getElementById('c1702q-year').value, 10);
  const rate = parseFloat(document.getElementById('c1702q-rate').value);
  const deduction = document.getElementById('c1702q-deduction').value;

  try {
    const coa = await loadChartOfAccounts(biz);
    const yearStart = new Date(year, 0, 1);
    const { start: qStart, end: qEnd } = getPeriodDates('quarterly', quarter, year);
    const prevEnd = new Date(qStart.getTime() - 86400000);

    const [thisQ, cumPrev, cumToDate] = await Promise.all([
      aggregateAccountActivity(biz, qStart, qEnd, coa),
      quarter > 1 ? aggregateAccountActivity(biz, yearStart, prevEnd, coa) : Promise.resolve({ totals: { income: 0, cogs: 0, opex: 0 } }),
      aggregateAccountActivity(biz, yearStart, qEnd, coa),
    ]);

    const dtaMap = await getDtaRoleMapping(biz);
    const cwt2307 = await getDtaBalance(biz, coa, dtaMap, qEnd, 'cwt2307');
    const cwt2307PrevQ = quarter > 1 ? await getDtaBalance(biz, coa, dtaMap, prevEnd, 'cwt2307') : 0;
    const cwtThisQuarter = cwt2307 - cwt2307PrevQ;

    const priorYearExcessCredit = await getDtaBalance(biz, coa, dtaMap, qEnd, 'priorYearExcessCredit');
    const itrPaymentsRegularPrevQ = quarter > 1 ? await getDtaBalance(biz, coa, dtaMap, prevEnd, 'itrPaymentsRegular') : 0;
    const itrPaymentsMcitPrevQ = quarter > 1 ? await getDtaBalance(biz, coa, dtaMap, prevEnd, 'itrPaymentsMcit') : 0;
    const mcitCarryforward = await getDtaAgedBalance(biz, coa, dtaMap, qEnd, 'mcitCarryforward');

    const period = { quarter, year, label: `${quarterLabel(quarter)} ${year}` };
    render1702Q(outputEl, {
      thisQ, cumPrev, cumToDate,
      cwtThisQuarter,
      cwtPrevQuarters: cwt2307PrevQ,
      priorYearExcessCredit,
      itrPaymentsRegularPrevQ,
      itrPaymentsMcitPrevQ,
      mcitCarryforward,
      coa, dtaMap,
    }, setup, period, rate, deduction);

    ['c1702q-print', 'c1702q-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function netIncomeFor1702(totals, deduction, nonOp, itemizedTotal, year) {
  const sales = totals.income;
  const cogs = totals.cogs;
  const grossIncomeOps = sales - cogs;
  const totalGrossIncome = grossIncomeOps + nonOp;
  const itemized = itemizedTotal !== undefined ? itemizedTotal : totals.opex;
  const osd = getOsdRate(dateForYear(year)) * totalGrossIncome;
  const allowable = deduction === 'osd' ? osd : itemized;
  return { sales, cogs, grossIncomeOps, totalGrossIncome, itemized, osd, allowable, taxableIncome: totalGrossIncome - allowable };
}

function render1702Q(el, data, setup, period, rate, deduction) {
  const name = setup.companyName || setup.taxpayerName || '';

  const schedule = buildItemizedSchedule(App.currentBusiness, data.thisQ.byAccount);
  const pnlHtml = renderPnLStatementHtml(data.thisQ.totals, data.thisQ.byAccount);
  const mappingHtml = renderDeductionScheduleHtml(schedule, 'Ordinary Allowable Itemized Deductions (This Quarter)');

  // MCIT only applies beginning the 4th taxable year following incorporation
  // (NIRC Sec. 27(E)(1)) — see isMcitApplicable in pnl-helpers.js.
  const mcitApplicable = isMcitApplicable(setup.dateOfIncorporation, period.year);
  const mcitRatePct = (getMcitRate(dateForYear(period.year)) * 100).toFixed(0);
  const mcitExemptNote = !mcitApplicable
    ? `<div class="alert alert-info no-print" style="margin-top:6px;font-size:11px;">⏸ Not yet subject to MCIT — exempt through the 3rd taxable year following the year operations commenced (${escHtml(setup.dateOfIncorporation)}), per RR 9-98. MCIT first applies for taxable year ${new Date(setup.dateOfIncorporation).getFullYear() + 4}.</div>`
    : '';

  const formHtml = `
    <div class="form-title">
      <h2>BIR Form 1702-Q — Quarterly Income Tax Return for Corporations, Partnerships and Other Non-Individual Taxpayers</h2>
      <div class="sub">For ${escHtml(period.label)} &nbsp;|&nbsp; Regular Rate ${rate * 100}% — ${deduction === 'osd' ? 'OSD' : 'Itemized Deduction'}</div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Part I – Background Information</div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">Taxpayer Identification Number (TIN)</div><div class="return-line-amt">${escHtml(setup.tin || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label">RDO Code</div><div class="return-line-amt">${escHtml(setup.rdoCode || '—')}</div></div>
      <div class="return-line"><div class="return-line-num">8</div><div class="return-line-label">Registered Name</div><div class="return-line-amt" style="font-size:11px;">${escHtml(name)}</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label">Registered Address</div><div class="return-line-amt" style="font-size:11px;">${escHtml(setup.address || '—')}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Schedule 2 – Declaration this Quarter — Regular/Normal Rate</div>
      <div class="return-line"><div class="return-line-num">1</div><div class="return-line-label">Sales/Receipts/Revenues/Fees</div><div class="return-line-amt" id="c1702q-s2-1">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">2</div><div class="return-line-label">Less: Cost of Sales/Services</div><div class="return-line-amt" id="c1702q-s2-2">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">3</div><div class="return-line-label" style="font-weight:700;">Gross Income from Operation</div><div class="return-line-amt" id="c1702q-s2-3">₱ 0.00</div></div>
      ${manualLine1702('4', 'Add: Non-Operating and Other Taxable Income', 'c1702q-nonop')}
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label" style="font-weight:700;">Total Gross Income</div><div class="return-line-amt" id="c1702q-s2-5">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label">Less: Deductions (${deduction === 'osd' ? 'OSD' : 'Itemized'})</div><div class="return-line-amt" id="c1702q-s2-6">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label" style="font-weight:700;">Taxable Income this Quarter</div><div class="return-line-amt" id="c1702q-s2-7">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">8</div><div class="return-line-label">Add: Taxable Income Previous Quarter/s</div><div class="return-line-amt" id="c1702q-s2-8">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">9</div><div class="return-line-label" style="font-weight:700;">Total Taxable Income to Date</div><div class="return-line-amt" id="c1702q-s2-9">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">10</div><div class="return-line-label">Applicable Income Tax Rate</div><div class="return-line-amt">${rate * 100}%</div></div>
      <div class="return-line"><div class="return-line-num">11</div><div class="return-line-label">Income Tax Due Other than MCIT</div><div class="return-line-amt" id="c1702q-s2-11">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">12</div><div class="return-line-label">Minimum Corporate Income Tax (MCIT)</div><div class="return-line-amt" id="c1702q-s2-12">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">13</div><div class="return-line-label" style="font-weight:700;">Income Tax Due (Higher of Item 11 or 12)</div><div class="return-line-amt highlight" id="c1702q-s2-13">₱ 0.00</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Schedule 3 – Computation of MCIT for the Quarter/s</div>
      ${mcitExemptNote}
      <div class="return-line"><div class="return-line-num">4</div><div class="return-line-label">Total Gross Income, Year-to-Date</div><div class="return-line-amt" id="c1702q-s3-4">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label">MCIT Rate</div><div class="return-line-amt">${mcitRatePct}%</div></div>
      <div class="return-line"><div class="return-line-num">6</div><div class="return-line-label" style="font-weight:700;">Minimum Corporate Income Tax</div><div class="return-line-amt" id="c1702q-s3-6">₱ 0.00</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Schedule 4 – Tax Credits/Payments</div>
      ${computedLine1702('1', "Prior Year's Excess Credits", data.priorYearExcessCredit)}
      ${computedLine1702('2', 'Tax Payment/s for the Previous Quarter/s (other than MCIT)', data.itrPaymentsRegularPrevQ)}
      ${computedLine1702('3', 'MCIT Payment/s for the Previous Quarter/s', data.itrPaymentsMcitPrevQ)}
      ${computedLine1702('4', 'Creditable Tax Withheld for the Previous Quarter/s', data.cwtPrevQuarters)}
      <div class="return-line"><div class="return-line-num">5</div><div class="return-line-label">Creditable Tax Withheld per BIR Form No. 2307 for this Quarter</div><div class="return-line-amt">₱ ${fmt(data.cwtThisQuarter)}</div></div>
      ${manualLine1702('6', 'Tax Paid in Return Previously Filed, if Amended', 'c1702q-tc6')}
      ${manualLine1702('6b', 'Other Tax Credits/Payments', 'c1702q-tc6b')}
      <div class="return-line"><div class="return-line-num">7</div><div class="return-line-label" style="font-weight:700;">Total Tax Credits/Payments</div><div class="return-line-amt" id="c1702q-tc-total">₱ 0.00</div></div>
      ${mcitCarryforwardWarningHtml(data.mcitCarryforward)}
    </div>

    ${renderDtaEntryPanelHtml()}

    <div class="return-section">
      <div class="return-section-header">Part II – Total Tax Payable</div>
      <div class="return-line"><div class="return-line-num">14</div><div class="return-line-label">Income Tax Due – Regular/Normal Rate</div><div class="return-line-amt" id="c1702q-p2-14">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">15</div><div class="return-line-label">Less: Unexpired Excess of Prior Year's MCIT over Regular Rate <span style="font-size:10px;color:#9ca3af;font-weight:400;">(auto — from books, only if Item 14 is regular rate, capped at Item 14)</span></div><div class="return-line-amt" id="c1702q-p2-15">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">16</div><div class="return-line-label">Balance/Income Tax Still Due – Regular Rate</div><div class="return-line-amt" id="c1702q-p2-16">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">18</div><div class="return-line-label" style="font-weight:700;">Aggregate Income Tax Due</div><div class="return-line-amt" id="c1702q-p2-18">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">19</div><div class="return-line-label">Less: Total Tax Credits/Payments</div><div class="return-line-amt" id="c1702q-p2-19">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">20</div><div class="return-line-label" style="font-weight:700;">Net Tax Payable/(Overpayment)</div><div class="return-line-amt" id="c1702q-p2-20">₱ 0.00</div></div>
      ${manualLine1702('21', 'Surcharge', 'c1702q-p21')}
      ${manualLine1702('22', 'Interest', 'c1702q-p22')}
      ${manualLine1702('23', 'Compromise', 'c1702q-p23')}
      <div class="return-line"><div class="return-line-num">24</div><div class="return-line-label">Total Penalties</div><div class="return-line-amt" id="c1702q-p2-24">₱ 0.00</div></div>
      <div class="return-line"><div class="return-line-num">25</div><div class="return-line-label" style="font-weight:700;">TOTAL AMOUNT PAYABLE/(OVERPAYMENT)</div><div class="return-line-amt highlight payable" id="c1702q-p2-25">₱ 0.00</div></div>
    </div>`;

  el.innerHTML = renderIncomeTaxTabs([
    { key: 'pnl', label: 'Profit and Loss Statement', html: pnlHtml },
    { key: 'mapping', label: 'BIR Mapping of COA', html: mappingHtml },
    { key: 'form', label: 'BIR Form', html: formHtml },
  ], 'form');

  el._data = data;
  el._rate = rate;
  el._deduction = deduction;
  el._itemizedTotal = schedule.total;
  el._mcitApplicable = mcitApplicable;
  el._year = period.year;
  bindIncomeTaxTabs(el);
  el.querySelectorAll('.recon-manual-input').forEach(inp => inp.addEventListener('input', () => recompute1702Q(el)));
  bindDeductionMappingTable(el, App.currentBusiness, () => render1702Q(el, data, setup, period, rate, deduction));
  bindDtaEntryPanel(el, App.currentBusiness, data.coa, data.dtaMap, () => generate1702Q(App.currentBusiness, setup, el));
  recompute1702Q(el);
}

function manualLine1702(num, label, inputId) {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label">${escHtml(label)}</div>
    <div class="return-line-amt"><input type="number" step="0.01" class="recon-manual-input" id="${inputId}" value="0" style="width:120px;text-align:right;font-size:12px;"></div>
  </div>`;
}

// Read-only counterpart to manualLine1702 for figures sourced from a
// Deferred Tax Asset account's running balance instead of a typed-in value.
function computedLine1702(num, label, amount) {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label">${escHtml(label)} <span style="font-size:10px;color:#9ca3af;font-weight:400;">(auto — from books)</span></div>
    <div class="return-line-amt">₱ ${fmt(amount)}</div>
  </div>`;
}

// Surfaces the MCIT carryforward's aged breakdown right under Schedule 4 so
// the preparer sees, at filing time, exactly how much of the account's total
// balance is usable this quarter vs. about to expire vs. already expired
// under the NIRC's 3-taxable-year window — the plain running balance on
// line 1/Part II line 15 alone can't show that distinction.
function mcitCarryforwardWarningHtml(mcitCarryforward) {
  if (!mcitCarryforward) return '';
  const { expiringSoon, expired, breakdown } = mcitCarryforward;
  if (expiringSoon < 0.005 && expired < 0.005) return '';
  const rows = breakdown
    .filter(l => l.expired || l.amount >= 0.005)
    .map(l => `<li>Tax Year ${l.year}: ₱ ${fmt(l.amount)}${l.expired ? ' — <strong>expired</strong>, no longer creditable' : (l.age >= 3 ? ' — expires after this year' : '')}</li>`)
    .join('');
  return `<div class="alert alert-warn no-print" style="margin-top:8px;font-size:11px;">
    ⚠ MCIT Carryforward aging (Deferred Tax Asset - MCIT Carryforward): only unexpired lots are counted toward Part II Line 15.
    <ul style="margin:4px 0 0 18px;padding:0;">${rows}</ul>
  </div>`;
}

// Lets the preparer post the journal entry for a carry-forward event
// (a quarterly ITR/MCIT payment made, or establishing/applying Prior Year's
// Excess Credit or MCIT Carryforward) straight from the return, instead of
// switching over to Manager and finding the right accounts themselves.
// Debits the role's Deferred Tax Asset account for an "increase" (a payment
// made, or a carry-forward balance being established) and credits it for a
// "decrease" (the balance being applied against tax due, or written off);
// the counter-account takes the opposite side.
function renderDtaEntryPanelHtml() {
  const roleOpts = DTA_ROLES.map(r => `<option value="${r.key}">${escHtml(r.label)}</option>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  return `
    <details class="no-print" style="margin:10px 0;border:1px solid #e5e7eb;border-radius:6px;padding:8px;">
      <summary style="cursor:pointer;font-size:12px;font-weight:600;">📝 Record a Carry-Forward Entry</summary>
      <p style="font-size:11px;color:#6b7280;margin:8px 0;">Posts a journal entry to Manager so the balance is picked up automatically on future returns — no manual re-entry needed. The account for each role is whatever's mapped in Settings → Chart of Accounts (or its default name, if unmapped).</p>
      <div class="filter-bar" style="flex-wrap:wrap;gap:8px;">
        <label>Date</label>
        <input type="date" id="c1702q-dta-date" value="${today}" style="width:130px;">
        <label>Role</label>
        <select id="c1702q-dta-role" style="min-width:180px;">${roleOpts}</select>
        <label>Direction</label>
        <select id="c1702q-dta-direction" style="min-width:220px;">
          <option value="increase">Increase (payment made / balance established)</option>
          <option value="decrease">Decrease (applied against tax due / written off)</option>
        </select>
      </div>
      <div class="filter-bar" style="flex-wrap:wrap;margin-top:6px;gap:8px;">
        <label>Amount</label>
        <input type="number" step="0.01" id="c1702q-dta-amount" style="width:140px;text-align:right;">
        <label>Counter-account</label>
        <select id="c1702q-dta-counter" style="min-width:220px;"><option value="">Loading accounts…</option></select>
        <label>Description</label>
        <input type="text" id="c1702q-dta-desc" style="width:200px;" placeholder="optional">
      </div>
      <div style="margin-top:8px;">
        <button type="button" class="btn btn-primary btn-sm" id="c1702q-dta-post">Post Entry</button>
        <span id="c1702q-dta-status" style="font-size:11px;color:#6b7280;margin-left:8px;"></span>
      </div>
    </details>`;
}

function bindDtaEntryPanel(el, biz, coa, dtaMap, onPosted) {
  const counterSel = el.querySelector('#c1702q-dta-counter');
  const postBtn = el.querySelector('#c1702q-dta-post');
  if (!counterSel || !postBtn) return;

  const allAccts = Object.values(coa || {})
    .filter(a => a.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  counterSel.innerHTML = allAccts.map(a => `<option value="${a.key}">${escHtml(a.name)}</option>`).join('');

  postBtn.addEventListener('click', async () => {
    const statusEl = el.querySelector('#c1702q-dta-status');
    const date = el.querySelector('#c1702q-dta-date').value;
    const roleKey = el.querySelector('#c1702q-dta-role').value;
    const isIncrease = el.querySelector('#c1702q-dta-direction').value === 'increase';
    const amount = parseFloat(el.querySelector('#c1702q-dta-amount').value) || 0;
    const counterGuid = counterSel.value;
    const desc = el.querySelector('#c1702q-dta-desc').value.trim();

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

function val1702(id) {
  const el = document.getElementById(id);
  return el ? (parseFloat(el.value) || 0) : 0;
}

function set1702(el, id, amount) {
  const target = el.querySelector(`#${id}`);
  if (target) target.textContent = `₱ ${fmt(amount)}`;
}

function recompute1702Q(el) {
  const {
    thisQ, cumPrev, cumToDate, cwtThisQuarter, cwtPrevQuarters,
    priorYearExcessCredit, itrPaymentsRegularPrevQ, itrPaymentsMcitPrevQ, mcitCarryforward,
  } = el._data;
  const rate = el._rate;
  const deduction = el._deduction;
  const year = el._year;

  const nonOp = val1702('c1702q-nonop');
  const thisQNet = netIncomeFor1702(thisQ.totals, deduction, nonOp, el._itemizedTotal, year);
  const prevQNet = netIncomeFor1702(cumPrev.totals, deduction, 0, undefined, year);
  const cumNet = netIncomeFor1702(cumToDate.totals, deduction, nonOp, undefined, year);

  set1702(el, 'c1702q-s2-1', thisQNet.sales);
  set1702(el, 'c1702q-s2-2', thisQNet.cogs);
  set1702(el, 'c1702q-s2-3', thisQNet.grossIncomeOps);
  set1702(el, 'c1702q-s2-5', thisQNet.totalGrossIncome);
  set1702(el, 'c1702q-s2-6', thisQNet.allowable);
  set1702(el, 'c1702q-s2-7', thisQNet.taxableIncome);
  set1702(el, 'c1702q-s2-8', prevQNet.taxableIncome);

  const totalTaxableToDate = thisQNet.taxableIncome + prevQNet.taxableIncome;
  set1702(el, 'c1702q-s2-9', totalTaxableToDate);

  const incomeTaxDueRegular = Math.max(0, totalTaxableToDate) * rate;
  set1702(el, 'c1702q-s2-11', incomeTaxDueRegular);

  const mcitBase = cumNet.totalGrossIncome;
  set1702(el, 'c1702q-s3-4', mcitBase);
  // Still within the MCIT-exempt window (commencement year + 3 following
  // years) -> not yet subject to MCIT at all, regardless of gross income
  // (NIRC Sec. 27(E)(1), RR 9-98). See isMcitApplicable in pnl-helpers.js.
  const mcit = el._mcitApplicable ? Math.max(0, mcitBase) * getMcitRate(dateForYear(year)) : 0;
  set1702(el, 'c1702q-s3-6', mcit);
  set1702(el, 'c1702q-s2-12', mcit);

  const incomeTaxDue = Math.max(incomeTaxDueRegular, mcit);
  set1702(el, 'c1702q-s2-13', incomeTaxDue);

  const isRegularRateHigher = incomeTaxDueRegular >= mcit;
  const line14 = incomeTaxDueRegular >= mcit ? incomeTaxDueRegular : mcit;
  // Only unexpired MCIT carryforward lots count, and it can only offset
  // regular-rate tax due (never MCIT), capped at Item 14 itself — this
  // line only reduces tax due, it can't create a refund on its own.
  const line15 = isRegularRateHigher ? Math.min(mcitCarryforward.usable, line14) : 0;
  set1702(el, 'c1702q-p2-14', line14);
  set1702(el, 'c1702q-p2-15', line15);
  const line16 = line14 - line15;
  set1702(el, 'c1702q-p2-16', line16);
  set1702(el, 'c1702q-p2-18', line16);

  const manualCredits = ['c1702q-tc6', 'c1702q-tc6b'].reduce((s, id) => s + val1702(id), 0);
  const credits = manualCredits + priorYearExcessCredit + itrPaymentsRegularPrevQ + itrPaymentsMcitPrevQ + cwtPrevQuarters + cwtThisQuarter;
  set1702(el, 'c1702q-tc-total', credits);
  set1702(el, 'c1702q-p2-19', credits);

  const netPayable = line16 - credits;
  set1702(el, 'c1702q-p2-20', netPayable);

  const penalties = ['c1702q-p21','c1702q-p22','c1702q-p23'].reduce((s, id) => s + val1702(id), 0);
  set1702(el, 'c1702q-p2-24', penalties);
  const totalPayable = netPayable + penalties;
  set1702(el, 'c1702q-p2-25', totalPayable);

  // Exposed for the "Record Payment / Journal Entry" workflow step
  // (step-engine.js's mountItrPaymentStepContent), which reads this straight
  // out of this report's iframe rather than recomputing anything itself.
  window._itr = { totalPayable };
}
