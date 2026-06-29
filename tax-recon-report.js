/* ============================================================
   Tallo CPA – BIR Tax App
   tax-recon-report.js – Tax Reconciliation Report

   Cross-checks the income-tax aggregator's P&L figures against
   other already-filed tax data, and flags P&L lines that carry
   no tax code so the preparer can spot-check them. This is the
   first consumer of pnl-helpers.js and validates the aggregator
   pipeline before it feeds the 1701/1702 returns.
   ============================================================ */

async function initTaxReconReport() {
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

  filterEl.innerHTML = periodFilterHTML('quarterly', 'recon');
  filterEl.insertAdjacentHTML('beforeend', `
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      Business: <strong>${escHtml(biz)}</strong> &nbsp;|&nbsp;
      TIN: <strong>${escHtml(setup.tin || '—')}</strong>
    </div>`);

  document.getElementById('recon-gen').addEventListener('click', () => generateTaxRecon(biz, setup, outputEl));
  return biz;
}

async function generateTaxRecon(biz, setup, outputEl) {
  outputEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Aggregating transactions…</span></div>`;

  const quarter = parseInt(document.getElementById('recon-quarter').value, 10);
  const year = parseInt(document.getElementById('recon-year').value, 10);
  const { start, end } = getPeriodDates('quarterly', quarter, year);

  try {
    const coa = await loadChartOfAccounts(biz);
    const { byAccount, totals } = await aggregateAccountActivity(biz, start, end, coa);

    const isIndividual = setup.classification === 'Individual';
    const prepaidLabel = isIndividual ? 'Prepaid Tax Asset-2306' : 'Prepaid Tax Asset-2307';
    const prepaidBalance = await getPrepaidTaxAssetBalance(biz, coa, end, prepaidLabel);

    const period = { quarter, year, label: `${quarterLabel(quarter)} ${year}` };
    renderTaxRecon(outputEl, byAccount, totals, prepaidBalance, prepaidLabel, setup, period);

    ['recon-print', 'recon-pdf'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  } catch (err) {
    outputEl.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

function renderTaxRecon(el, byAccount, totals, prepaidBalance, prepaidLabel, setup, period) {
  const rows = Object.values(byAccount).filter(r => r.bucket !== 'other').sort((a, b) => {
    const order = { income: 0, cogs: 1, opex: 2 };
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    return a.name.localeCompare(b.name);
  });

  const bucketLabel = { income: 'Sales / Other Income', cogs: 'Cost of Sales', opex: 'Operating Expenses' };

  const flagged = rows.filter(r => Math.abs(r.untaxedAmount) > 0.01 && Math.abs(r.untaxedAmount) !== Math.abs(r.amount));

  el.innerHTML = `
    <div class="form-title">
      <h2>Tax Reconciliation Report</h2>
      <div class="sub">For ${escHtml(period.label)}</div>
    </div>

    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">Sales / Other Income</div><div class="stat-value small">₱ ${fmt(totals.income)}</div></div>
      <div class="stat-card"><div class="stat-label">Cost of Sales</div><div class="stat-value small">₱ ${fmt(totals.cogs)}</div></div>
      <div class="stat-card"><div class="stat-label">Operating Expenses</div><div class="stat-value small">₱ ${fmt(totals.opex)}</div></div>
      <div class="stat-card"><div class="stat-label">${escHtml(prepaidLabel)} (balance)</div><div class="stat-value small">₱ ${fmt(prepaidBalance)}</div></div>
    </div>

    <div class="return-section">
      <div class="return-section-header">Per-Account P&amp;L Activity (Reconstructed from Transactions)</div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Account</th><th>Classification</th><th class="num">Net Amount</th><th class="num">Untaxed Portion</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr${Math.abs(r.untaxedAmount) > 0.01 && Math.abs(r.untaxedAmount) !== Math.abs(r.amount) ? ' style="background:#fff7e6;"' : ''}>
                <td>${escHtml(r.name)}</td>
                <td>${escHtml(bucketLabel[r.bucket] || r.bucket)}</td>
                <td class="num">${fmt(r.amount)}</td>
                <td class="num">${r.untaxedAmount ? fmt(r.untaxedAmount) : '—'}</td>
              </tr>`).join('') || `<tr><td colspan="4" style="text-align:center;color:#9ca3af;">No P&amp;L activity for this period</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    ${flagged.length ? `
    <div class="alert alert-warn">
      ⚠️ ${flagged.length} account(s) have a mix of taxed and untaxed lines this period. Spot-check the untaxed portion against
      2550Q/SLS (for Sales/Other Income) or 1601EQ/QAP/SLP (for Cost of Sales/Operating Expenses) to confirm nothing was missed.
    </div>` : `
    <div class="alert alert-info">✅ No mixed taxed/untaxed accounts detected for this period.</div>`}

    <div class="return-section">
      <div class="return-section-header">Notes</div>
      <div style="font-size:11px;color:#6b7280;padding:8px 12px;line-height:1.6;">
        • Figures above are reconstructed directly from journal entries, invoices, receipts, and payments tagged against
        Profit &amp; Loss accounts in the Chart of Accounts — Manager.io has no API that returns computed P&amp;L totals,
        so this app rebuilds them from the same source transactions.<br>
        • An account having untaxed lines is normal (e.g. Salaries, Depreciation, SSS/PHIC/HDMF, Bank Charges, Interest)
        — it is only a concern when an account is <em>partly</em> taxed and partly untaxed in the same period.<br>
        • ${escHtml(prepaidLabel)} balance should match the sum of BIR Form 2307 certificates received for the period
        (and prior periods, since it carries forward) once those are reconciled separately.
      </div>
    </div>`;
}
