/* ============================================================
   Tallo CPA – BIR Tax App
   deduction-helpers.js – Maps Chart-of-Accounts Operating Expense
                           accounts to the BIR's Schedule 4 / Schedule
                           I "Ordinary Allowable Itemized Deductions"
                           categories (1701 Schedule 4, 1702-RT
                           Schedule I — both Jan 2018 ENCS).

   Accounts are auto-categorized by name keyword match; the preparer
   can override any account's category, saved per-business in
   localStorage. Unmatched accounts fall into item 17/"Others -
   Other Expenses" so the schedule always reconciles to the same
   itemized-deduction total used elsewhere in the report.
   ============================================================ */

const DEDUCTION_SCHEDULE = [
  { num: '1',   key: 'amortizations',     label: 'Amortizations',                                       keywords: ['amortization'] },
  { num: '2',   key: 'badDebts',          label: 'Bad Debts',                                            keywords: ['bad debt'] },
  { num: '3',   key: 'charitable',        label: 'Charitable and Other Contributions',                  keywords: ['charitable', 'donation', 'contribution'] },
  { num: '4',   key: 'depletion',         label: 'Depletion',                                            keywords: ['depletion'] },
  { num: '5',   key: 'depreciation',      label: 'Depreciation',                                         keywords: ['depreciation'] },
  { num: '6',   key: 'entertainment',     label: 'Entertainment, Amusement and Recreation',              keywords: ['entertainment', 'amusement', 'recreation', 'representation'] },
  { num: '7',   key: 'fringeBenefits',    label: 'Fringe Benefits',                                      keywords: ['fringe benefit'] },
  { num: '8',   key: 'interest',          label: 'Interest',                                             keywords: ['interest expense', 'interest'] },
  { num: '9',   key: 'losses',            label: 'Losses',                                               keywords: ['loss on', 'losses'] },
  { num: '10',  key: 'pensionTrusts',     label: 'Pension Trusts',                                       keywords: ['pension', 'retirement'] },
  { num: '11',  key: 'rental',            label: 'Rental',                                               keywords: ['rent'] },
  { num: '12',  key: 'researchDev',       label: 'Research and Development',                             keywords: ['research', 'development'] },
  { num: '13',  key: 'salaries',          label: 'Salaries, Wages and Allowances',                       keywords: ['salar', 'wage', 'allowance', 'payroll'] },
  { num: '14',  key: 'sssEtc',            label: 'SSS, GSIS, Philhealth, HDMF and Other Contributions',  keywords: ['sss', 'gsis', 'philhealth', 'hdmf', 'pag-ibig', 'pagibig'] },
  { num: '15',  key: 'taxesLicenses',     label: 'Taxes and Licenses',                                   keywords: ['tax', 'license', 'permit'] },
  { num: '16',  key: 'transportation',    label: 'Transportation and Travel',                            keywords: ['transportation', 'travel', 'gas', 'fuel', 'parking', 'toll'] },
  { num: '17a', key: 'janitorial',        label: 'Janitorial and Messengerial Services',                 keywords: ['janitorial', 'messengerial'] },
  { num: '17b', key: 'professionalFees',  label: 'Professional Fees',                                    keywords: ['professional fee', 'consulting', 'consultant', 'accounting fee', 'legal fee', 'audit fee'] },
  { num: '17c', key: 'security',          label: 'Security Services',                                    keywords: ['security'] },
  { num: '17d', key: 'otherExpenses',     label: 'Other Expenses',                                       keywords: [] }, // catch-all, must stay last
];

function autoMatchDeductionCategory(accountName) {
  const n = (accountName || '').toLowerCase();
  for (const cat of DEDUCTION_SCHEDULE) {
    if (cat.key === 'otherExpenses') continue;
    if (cat.keywords.some(kw => n.includes(kw))) return cat.key;
  }
  return 'otherExpenses';
}

function deductionMapStorageKey(biz) { return `deduction_mapping_${biz}`; }

function getDeductionOverrides(biz) {
  try { return JSON.parse(localStorage.getItem(deductionMapStorageKey(biz))) || {}; }
  catch { return {}; }
}

function saveDeductionOverrides(biz, overrides) {
  localStorage.setItem(deductionMapStorageKey(biz), JSON.stringify(overrides));
}

// byAccount: { [guid]: { name, bucket, amount, ... } } from aggregateAccountActivity.
// Only 'opex' bucket accounts feed the itemized-deduction schedule (COGS is its
// own line elsewhere on the form). Returns the 16+3+catch-all schedule lines,
// the per-account rows (for the mapping-review table), and the grand total
// (always equal to totals.opex, so the schedule reconciles).
function buildItemizedSchedule(biz, byAccount) {
  const overrides = getDeductionOverrides(biz);
  const totals = {};
  for (const cat of DEDUCTION_SCHEDULE) totals[cat.key] = 0;
  const accountRows = [];

  for (const [guid, row] of Object.entries(byAccount || {})) {
    if (row.bucket !== 'opex') continue;
    if (Math.abs(row.amount) < 0.005) continue;
    const catKey = overrides[guid] || autoMatchDeductionCategory(row.name);
    totals[catKey] = (totals[catKey] || 0) + row.amount;
    accountRows.push({ guid, name: row.name, amount: row.amount, category: catKey });
  }

  const lines = DEDUCTION_SCHEDULE.map(cat => ({ num: cat.num, label: cat.label, key: cat.key, amount: totals[cat.key] || 0 }));
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { lines, accountRows, total };
}

// Renders an editable mapping-review table (account -> BIR category dropdown).
function renderDeductionMappingTable(accountRows) {
  if (!accountRows.length) return '';
  const rowsHtml = [...accountRows]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(r => `
      <tr>
        <td style="padding:3px 8px;font-size:11px;">${escHtml(r.name)}</td>
        <td style="padding:3px 8px;font-size:11px;text-align:right;">₱ ${fmt(r.amount)}</td>
        <td style="padding:3px 8px;">
          <select class="deduction-map-select" data-guid="${r.guid}" style="font-size:11px;width:100%;">
            ${DEDUCTION_SCHEDULE.map(c => `<option value="${c.key}"${c.key === r.category ? ' selected' : ''}>${c.num} – ${escHtml(c.label)}</option>`).join('')}
          </select>
        </td>
      </tr>`).join('');
  return `
    <details class="no-print" style="margin:10px 0;border:1px solid #e5e7eb;border-radius:6px;padding:8px;">
      <summary style="cursor:pointer;font-size:12px;font-weight:600;">🔧 Review COA → BIR Itemized Deduction Mapping (${accountRows.length} account${accountRows.length === 1 ? '' : 's'})</summary>
      <table style="width:100%;margin-top:8px;border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left;font-size:11px;padding:3px 8px;">Account</th>
          <th style="text-align:right;font-size:11px;padding:3px 8px;">Amount</th>
          <th style="text-align:left;font-size:11px;padding:3px 8px;">BIR Schedule Line</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </details>`;
}

// Combines the BIR schedule total lines with the editable mapping-review
// table into the "BIR Mapping of COA" tab content. `title` is the schedule
// header shown above the lines (e.g. "Schedule 4 – Ordinary Allowable
// Itemized Deductions"); quarterly forms (1701Q/1702Q) have no official
// per-category schedule line on the return itself, but the mapping tab is
// still useful there for review, so they pass a generic title.
function renderDeductionScheduleHtml(schedule, title) {
  return `
    <div class="return-section">
      <div class="return-section-header">${escHtml(title)}</div>
      ${schedule.lines.map(l => returnLine(l.num, l.label, l.amount)).join('')}
      ${returnLine('Total', 'Total Ordinary Allowable Itemized Deductions', schedule.total, true)}
    </div>
    ${renderDeductionMappingTable(schedule.accountRows)}`;
}

// Wires up the mapping dropdowns: on change, persist the override and re-run
// the page's recompute function so the schedule + downstream totals refresh.
function bindDeductionMappingTable(el, biz, onChange) {
  el.querySelectorAll('.deduction-map-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const overrides = getDeductionOverrides(biz);
      overrides[sel.dataset.guid] = sel.value;
      saveDeductionOverrides(biz, overrides);
      onChange();
    });
  });
}
