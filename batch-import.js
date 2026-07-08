/* ============================================================
   Tallo CPA – BIR Tax App
   batch-import.js  –  Converts a simple client-facing Excel
                        template into Customers/Suppliers and
                        Sales/Purchase Invoices (plus same-day
                        Receipts/Payments) by posting directly to
                        Manager's API (PUT, upsert-by-key) from
                        inside this iframe.

   Shared by two installable pages:
     batch-import-sales.html    sets BI_TXN_TYPE = 'Sale'
     batch-import-purchase.html sets BI_TXN_TYPE = 'Purchase'
   ============================================================ */

const BI_IS_PAYROLL = (typeof BI_TXN_TYPE !== 'undefined' ? BI_TXN_TYPE : 'Sale') === 'Payroll';
const BI_IS_SALE = !BI_IS_PAYROLL && (typeof BI_TXN_TYPE !== 'undefined' ? BI_TXN_TYPE : 'Sale') === 'Sale';
const BI_PARTY_LABEL = BI_IS_PAYROLL ? 'Employee' : (BI_IS_SALE ? 'Customer' : 'Supplier');
const BI_SALARIES_PAYABLE_ACCOUNT = '650a36fe-801f-4031-8d5b-ab422d061fca';

// ── PAYROLL: one column per payslip item the business has actually set up
// in Manager (Earnings / Deductions / Contributions), in that order. The
// column list is fetched live per business — see buildLookupCache() — so
// BI_PAYROLL_COLS below is only a placeholder until the cache is built.
let BI_PAYROLL_COLS = [];

// ── SIMPLE CLIENT TEMPLATE (what the client/bookkeeper fills in) ──
// Both Sales and Purchase invoices are always tax-inclusive: VAT-category
// columns hold the gross (tax-inclusive) amount per category; withholding
// columns (CWT/WV for sales, Withholding Tax for purchases) are amounts
// withheld, recorded as negative lines. Chart of accounts (and, for
// purchases, ATC/withholding tax codes) vary per business, so the
// downloaded template includes extra reference sheets (fetched live for
// the selected business) to copy exact names from.
// Payroll headers/sample row depend on BI_PAYROLL_COLS, which is only known
// once the business's actual payslip items have been fetched (see
// buildLookupCache) — so these are computed via functions, not constants.
function biHeaders() {
  return BI_IS_PAYROLL ? [
    'Pay Period End / Payment Date (YYYY-MM-DD)', 'Employee Name', 'Reference',
    ...BI_PAYROLL_COLS.map(c => c.header),
    'Payment Account (Cash/Bank)',
    'Gross Pay (computed)', 'Total Deductions (computed)', 'Net Pay (computed)',
  ] : BI_IS_SALE ? [
    'Date (YYYY-MM-DD)', 'Customer Name', 'Reference', 'Revenue Account',
    'VATable Sales', 'VAT Exempt Sales', 'Zero-Rated Sales',
    'CWT Account', 'CWT ATC Code', 'CWT Amount', 'WV Account', 'WV ATC Code', 'WV Amount',
    'Other Ded. Account', 'Other Ded. Amount',
    'Paid Same Day (Yes/No)', 'Paid Amount', 'Payment Account (Cash/Bank)',
  ] : [
    'Date (YYYY-MM-DD)', 'Supplier Name', 'Reference', 'Account',
    'Input VAT 12% (Capital Goods)', 'Input VAT 12% (Other Goods)', 'Input VAT 12% (Services)',
    'Zero-Rated Purchases', 'VAT Exempt Purchases',
    'Withholding Tax Account', 'ATC Code', 'Withholding Tax Amount',
    'Paid Same Day (Yes/No)', 'Paid Amount', 'Payment Account (Cash/Bank)',
  ];
}

function biSampleRows() {
  if (BI_IS_PAYROLL) {
    const firstEarnIdx = BI_PAYROLL_COLS.findIndex(c => c.group === 'earnings');
    const cols = BI_PAYROLL_COLS.map((c, i) => i === firstEarnIdx ? 15000 : '');
    return [['2026-06-15', 'Juan Dela Cruz', 'PAYROLL-JUN1-2026', ...cols, 'Cash on Hand']];
  }
  return BI_IS_SALE ? [
    ['2026-06-18', '48 Coffee Co.', 'INV-1001', 'Sales Revenue',
      5600, '', '',
      '', '', '', '', '', '',
      '', '',
      'Yes', 5600, 'Cash on Hand'],
  ] : [
    ['2026-06-18', 'ABC Trading', 'BILL-2001', 'Professional Fees',
      '', 2000, '',
      '', '',
      'Withholding Tax Payable', 'WI010 – Prof. fees ≤3M (5%)', 100,
      'No', '', ''],
  ];
}

let _biRows  = [];
let _biBiz   = '';
let _biCache = null;
let _biFile  = null;

async function initBatchImport() {
  const biz = await getReportBusiness(document.getElementById('biz-selector-wrap'));
  App.currentBusiness = biz;
  _biBiz = biz;

  document.getElementById('bi-template').addEventListener('click', downloadTemplate);
  document.getElementById('bi-upload-btn').addEventListener('click', () => document.getElementById('bi-file').click());
  document.getElementById('bi-file').addEventListener('change', handleFileChosen);
  document.getElementById('bi-validate').addEventListener('click', runValidation);
  document.getElementById('bi-post').addEventListener('click', postAllToManager);
}

// ── XLSX LOADING (lazy, used only for reading uploaded files) ──
function ensureXLSX(cb) {
  if (window.XLSX) return cb();
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  s.onload = cb;
  document.head.appendChild(s);
}

// ── EXCELJS LOADING (lazy, used only to build the styled/validated template) ──
function ensureExcelJS(cb) {
  if (window.ExcelJS) return cb();
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  s.onload = cb;
  document.head.appendChild(s);
}

// ── PARTY DEDUP HELPERS ─────────────────────────────────────────
// Strips punctuation/whitespace and common entity suffixes so
// "ABC Trading Co." / "ABC Trading, Co" / "abc trading" all normalize the
// same way for matching against existing Manager contacts.
const BI_ENTITY_SUFFIXES = /\b(incorporated|inc|corporation|corp|company|co|ltd|llc)\b\.?/g;
function normalizePartyName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[.,'"()\-]/g, ' ')
    .replace(BI_ENTITY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizeTin(tin) {
  return (tin || '').replace(/\D/g, '');
}
// Standard edit-distance, used to flag near-duplicate names (typos,
// missing/extra words) rather than silently treating them as new contacts.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}
// Returns existing parties whose normalized name is close enough to be a
// likely duplicate of `normName`, best match first.
function findNearDupCandidates(normName, cache, max = 3) {
  if (!normName) return [];
  const threshold = normName.length <= 6 ? 1 : (normName.length <= 12 ? 2 : 3);
  const scored = [];
  for (const p of cache.partyList) {
    if (p.normName === normName) continue; // exact normalized matches are handled separately
    if (Math.abs(p.normName.length - normName.length) > threshold + 2) continue;
    const dist = levenshtein(normName, p.normName);
    if (dist <= threshold || p.normName.includes(normName) || normName.includes(p.normName)) {
      scored.push({ key: p.key, name: p.name, dist });
    }
  }
  return scored.sort((a, b) => a.dist - b.dist).slice(0, max);
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const BI_TEMPLATE_BRAND = 'FF1F4E78';

function downloadTemplate() {
  ensureExcelJS(async () => {
    const cache = await buildLookupCache(_biBiz);
    const wb = new ExcelJS.Workbook();

    // Instructions sheet
    const instr = wb.addWorksheet('Instructions');
    instr.getColumn(1).width = 100;
    const titleRow = instr.addRow([`Batch ${BI_IS_PAYROLL ? 'Payroll' : (BI_IS_SALE ? 'Sales' : 'Purchase')} Import — Instructions`]);
    titleRow.font = { bold: true, size: 14, color: { argb: BI_TEMPLATE_BRAND } };
    instr.addRow([]);
    const steps = BI_IS_PAYROLL ? [
      '1. Fill in the "Batch Import" sheet below — one row per employee per pay period.',
      '2. Date columns use YYYY-MM-DD format (e.g. 2026-06-15).',
      '3. Earnings/Deduction/Contribution columns are the actual payslip items set up for this business in Manager — leave a column blank if it does not apply to this payslip.',
      '4. "Payment Account" column: pick a value from the dropdown (sourced from the "Payment Accounts" sheet) or type the exact cash/bank account title. All payroll is assumed paid the same day as the Pay Period End date entered in column 1 — net pay (earnings less deductions) is settled against the firm\'s Salaries Payable / Employee Clearing Account automatically.',
      '5. Do not rename, delete, or reorder the columns in the "Batch Import" sheet — the importer reads them by position.',
      '6. Use the "Withholding Tax Calculator" sheet (pick an employee, enter gross compensation and non-taxable deductions) to work out the "Withholding Tax" amount for that row, per the BIR monthly withholding tax table.',
      '7. When done, go back to the app, choose "Upload" and select this file, then click Validate before Post.',
    ] : [
      '1. Fill in the "Batch Import" sheet below — one row per invoice.',
      '2. Date columns use YYYY-MM-DD format (e.g. 2026-06-18).',
      '3. Account columns: pick a value from the dropdown (sourced from the "Chart of Accounts" sheet) or type the exact account title.',
      BI_IS_SALE
        ? '4. CWT/WV ATC Code columns: pick a value from the dropdown (sourced from the "ATC Codes" sheet).'
        : '4. ATC Code column: pick a value from the dropdown (sourced from the "ATC Codes" sheet).',
      BI_IS_SALE
        ? '5. Withholding amounts (CWT, WV) and the "Other Ded. Amount" (e.g. SC/PWD Discount) — enter as a positive number; they are recorded as deductions from the sale automatically. Leave "Other Ded. Account"/"Other Ded. Amount" blank if there is no such deduction on that invoice.'
        : '5. Withholding amounts (CWT, WV, Withholding Tax) — enter as a positive number; they are recorded as deductions automatically.',
      '6. "Paid Same Day" — enter Yes only if the invoice was settled in cash/bank on the same day as the Date in column 1 (that date is used as the payment date too); otherwise leave it as No.',
      '7. Do not rename, delete, or reorder the columns in the "Batch Import" sheet — the importer reads them by position.',
      `8. When done, go back to the app, choose "Upload" and select this file, then click Validate before Post. If the ${BI_PARTY_LABEL} name on a row looks like a possible duplicate of an existing contact, the preview will flag it and let you pick the matching contact (or confirm it's new) right there — no need to edit the file and re-upload.`,
    ];
    steps.forEach(s => { const row = instr.addRow([s]); row.font = { size: 11 }; row.alignment = { wrapText: true }; });

    // Batch Import sheet
    const ws = wb.addWorksheet('Batch Import');
    const headerRowIdx = BI_IS_PAYROLL ? 2 : 1;
    const firstSampleRowIdx = headerRowIdx + 1;
    const headers = biHeaders();
    const sampleRows = biSampleRows();

    const earnCount = BI_PAYROLL_COLS.filter(c => c.group === 'earnings').length;
    const dedCount = BI_PAYROLL_COLS.filter(c => c.group === 'deductions').length;
    const conCount = BI_PAYROLL_COLS.filter(c => c.group === 'contributions').length;

    if (BI_IS_PAYROLL) {
      // Group-label row above the headers, like a payroll register: Earnings / Deductions / Employer Contributions / Payment / Validation totals.
      const groups = [
        { label: '', span: 3 },
        { label: 'EARNINGS', span: earnCount },
        { label: 'DEDUCTIONS', span: dedCount },
        { label: 'EMPLOYER CONTRIBUTIONS', span: conCount },
        { label: 'PAYMENT', span: 1 },
        { label: 'TOTALS (FOR VALIDATION)', span: 3 },
      ];
      const groupColors = { EARNINGS: 'FF2E7D32', DEDUCTIONS: 'FFB71C1C', 'EMPLOYER CONTRIBUTIONS': 'FF6A1B9A', PAYMENT: 'FF0D47A1', 'TOTALS (FOR VALIDATION)': 'FF455A64' };
      const groupRow = ws.addRow([]);
      let col = 1;
      groups.forEach(g => {
        if (g.label) {
          ws.mergeCells(groupRow.number, col, groupRow.number, col + g.span - 1);
          const cell = groupRow.getCell(col);
          cell.value = g.label;
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupColors[g.label] } };
        }
        col += g.span;
      });
      groupRow.height = 20;
    }

    ws.addRow(headers);
    sampleRows.forEach(r => ws.addRow(r));
    const headerRow = ws.getRow(headerRowIdx);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BI_TEMPLATE_BRAND } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 32;
    ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
    headers.forEach((h, i) => { ws.getColumn(i + 1).width = Math.max(14, Math.min(28, h.length + 4)); });
    ws.getRow(firstSampleRowIdx).font = { italic: true, color: { argb: 'FF888888' } };

    // Payroll: per-row Gross Pay / Total Deductions / Net Pay formulas, for
    // the bookkeeper to validate the amount actually received by the employee.
    if (BI_IS_PAYROLL) {
      const earnFirstCol0 = 3, earnLastCol0 = earnFirstCol0 + earnCount - 1;
      const dedFirstCol0 = earnLastCol0 + 1, dedLastCol0 = dedFirstCol0 + dedCount - 1;
      const grossPayCol0 = dedLastCol0 + conCount + 2; // +1 for Payment Account, +1 to land on Gross Pay
      const earnRange = `${colLetter(earnFirstCol0 + 1)}%r:${colLetter(earnLastCol0 + 1)}%r`;
      const dedRange = `${colLetter(dedFirstCol0 + 1)}%r:${colLetter(dedLastCol0 + 1)}%r`;
      const grossLetter = colLetter(grossPayCol0 + 1);
      const totalDedLetter = colLetter(grossPayCol0 + 2);
      const netPayLetter = colLetter(grossPayCol0 + 3);
      const LAST_DATA_ROW = 500;
      for (let r = firstSampleRowIdx; r <= LAST_DATA_ROW; r++) {
        ws.getCell(`${grossLetter}${r}`).value = { formula: `SUM(${earnRange.replace(/%r/g, r)})` };
        ws.getCell(`${totalDedLetter}${r}`).value = { formula: `SUM(${dedRange.replace(/%r/g, r)})` };
        ws.getCell(`${netPayLetter}${r}`).value = { formula: `${grossLetter}${r}-${totalDedLetter}${r}` };
        ws.getCell(`${grossLetter}${r}`).numFmt = '#,##0.00';
        ws.getCell(`${totalDedLetter}${r}`).numFmt = '#,##0.00';
        ws.getCell(`${netPayLetter}${r}`).numFmt = '#,##0.00';
      }
    }

    // Payroll: small "Payment Accounts" sheet (bank/cash accounts only — that's
    // the only account column left now that net pay always settles against the
    // firm's Salaries Payable / Employee Clearing Account automatically).
    // Sales/Purchase: full Chart of Accounts sheet, since several account
    // columns vary per business.
    const coa = wb.addWorksheet(BI_IS_PAYROLL ? 'Payment Accounts' : 'Chart of Accounts');
    coa.getColumn(1).width = 40;
    coa.addRow([BI_IS_PAYROLL ? 'Cash/Bank Account' : 'Account Title']).font = { bold: true };
    const accountNames = (BI_IS_PAYROLL ? cache.bankCashAccountList : cache.accountList)
      .map(a => a.name).sort((a, b) => a.localeCompare(b));
    accountNames.forEach(n => coa.addRow([n]));

    // ATC Codes sheet (sales/purchase only — payroll has no ATC codes)
    const atcCodes = BI_IS_PAYROLL ? [] : cache.taxCodes.filter(tc => /^W[ICVB]\d/.test(tc.name)).map(tc => tc.name).sort((a, b) => a.localeCompare(b));
    if (!BI_IS_PAYROLL) {
      const atc = wb.addWorksheet('ATC Codes');
      atc.getColumn(1).width = 50;
      atc.addRow(['ATC Code (Tax Code Name)']).font = { bold: true };
      atcCodes.forEach(n => atc.addRow([n]));
    }

    // Dropdown validation on Account / ATC Code columns, sourced from the reference sheets
    const coaRange = `'${BI_IS_PAYROLL ? 'Payment Accounts' : 'Chart of Accounts'}'!$A$2:$A$${Math.max(2, accountNames.length + 1)}`;
    const atcRange = `'ATC Codes'!$A$2:$A$${Math.max(2, atcCodes.length + 1)}`;
    const LAST_DATA_ROW = 500;
    headers.forEach((h, i) => {
      const isAccountCol = /account/i.test(h);
      const isAtcCol = /atc code/i.test(h);
      if (!isAccountCol && !isAtcCol) return;
      const letter = colLetter(i + 1);
      for (let r = firstSampleRowIdx; r <= LAST_DATA_ROW; r++) {
        ws.getCell(`${letter}${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [isAccountCol ? coaRange : atcRange],
          showErrorMessage: true,
          errorStyle: 'warning',
          errorTitle: 'Not in list',
          error: 'Pick a value from the dropdown, or type the exact name from the reference sheet.',
        };
      }
    });

    // Payroll: Withholding Tax Calculator sheet — pick an employee, enter their
    // monthly gross compensation and non-taxable deductions (SSS/PhilHealth/
    // Pag-IBIG employee share, etc.), and it works out the monthly withholding
    // tax per the BIR monthly withholding tax table, for reference only.
    if (BI_IS_PAYROLL) {
      const wht = wb.addWorksheet('Withholding Tax Calculator');
      const whtHeaders = ['Employee Name', 'Monthly Gross Compensation', 'Non-Taxable Deductions (SSS/PhilHealth/Pag-IBIG, etc.)', 'Net Taxable Compensation', 'Monthly Withholding Tax'];
      wht.addRow(['Monthly Withholding Tax Calculator (for reference — based on the BIR monthly withholding tax table)']).font = { bold: true, size: 13, color: { argb: BI_TEMPLATE_BRAND } };
      wht.addRow([]);
      const whtHeaderRow = wht.addRow(whtHeaders);
      whtHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      whtHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BI_TEMPLATE_BRAND } };
      whtHeaderRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      whtHeaderRow.height = 32;
      whtHeaders.forEach((h, i) => { wht.getColumn(i + 1).width = Math.max(18, Math.min(40, h.length + 4)); });
      wht.views = [{ state: 'frozen', ySplit: 3 }];

      const WHT_FIRST_ROW = 4;
      const WHT_LAST_ROW = 103;
      for (let r = WHT_FIRST_ROW; r <= WHT_LAST_ROW; r++) {
        wht.getCell(`D${r}`).value = { formula: `IF(B${r}="","",MAX(0,B${r}-C${r}))` };
        wht.getCell(`E${r}`).value = { formula:
          `IF(D${r}="","",` +
          `IF(D${r}<=20833,0,` +
          `IF(D${r}<=33333,(D${r}-20833)*0.15,` +
          `IF(D${r}<=66667,1875+(D${r}-33333)*0.2,` +
          `IF(D${r}<=166667,8875+(D${r}-66667)*0.25,` +
          `IF(D${r}<=666667,33125+(D${r}-166667)*0.3,` +
          `183125+(D${r}-666667)*0.35))))))` };
        wht.getCell(`D${r}`).numFmt = '#,##0.00';
        wht.getCell(`E${r}`).numFmt = '#,##0.00';
        wht.getCell(`B${r}`).numFmt = '#,##0.00';
        wht.getCell(`C${r}`).numFmt = '#,##0.00';
      }
      // Employee-name dropdown, sourced from the firm's actual employee list.
      const empSheet = wb.addWorksheet('Employees');
      empSheet.getColumn(1).width = 30;
      empSheet.addRow(['Employee Name']).font = { bold: true };
      cache.employeeNames.forEach(n => empSheet.addRow([n]));
      const empRange = `'Employees'!$A$2:$A$${Math.max(2, cache.employeeNames.length + 1)}`;
      for (let r = WHT_FIRST_ROW; r <= WHT_LAST_ROW; r++) {
        wht.getCell(`A${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [empRange],
          showErrorMessage: true,
          errorStyle: 'warning',
          errorTitle: 'Not in list',
          error: 'Pick an employee from the dropdown, or type the exact name.',
        };
      }
      wht.addRow([]);
      const noteRow = wht.addRow(['Reference table: ₱0–20,833 0% · ₱20,834–33,333 15% of excess over ₱20,833 · ₱33,334–66,667 ₱1,875 + 20% of excess over ₱33,333 · ₱66,668–166,667 ₱8,875 + 25% of excess over ₱66,667 · ₱166,668–666,667 ₱33,125 + 30% of excess over ₱166,667 · Above ₱666,667 ₱183,125 + 35% of excess over ₱666,667.']);
      noteRow.font = { italic: true, size: 9, color: { argb: 'FF888888' } };
      noteRow.alignment = { wrapText: true };
      wht.mergeCells(`A${noteRow.number}:E${noteRow.number}`);
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const typeLabel = BI_IS_PAYROLL ? 'Payroll' : (BI_IS_SALE ? 'Sales' : 'Purchase');
    const bizLabel = (_biBiz || 'Business').replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, '_');
    a.download = `Batch_Import_${typeLabel}_Template_${bizLabel}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

function handleFileChosen(e) {
  _biFile = e.target.files[0] || null;
  document.getElementById('bi-filename').textContent = _biFile ? _biFile.name : '';
  document.getElementById('bi-validate').style.display = _biFile ? '' : 'none';
  document.getElementById('bi-post').style.display = 'none';
  document.getElementById('bi-output').innerHTML = '';
}

// ── LOOKUP CACHE (account/tax-code/contact name -> Manager key) ──
async function buildLookupCache(biz) {
  if (_biCache && _biCache.biz === biz) return _biCache;

  const keyMap = arr => {
    const m = new Map();
    arr.forEach(row => {
      const d = row?.item || row?.value || row || {};
      const n = (d.name || d.Name || '').trim().toLowerCase();
      const k = row?.key || row?.Key || d.key || '';
      if (n && k) m.set(n, k);
    });
    return m;
  };

  if (BI_IS_PAYROLL) {
    const [bsAccounts, plAccounts, bankCashAccounts, employees, earningsItems, deductionItems, contributionItems] = await Promise.all([
      fetchAllBatch('/api4/balance-sheet-account-batch', biz).catch(() => []),
      fetchAllBatch('/api4/profit-and-loss-statement-account-batch', biz).catch(() => []),
      fetchAllBatch('/api4/bank-or-cash-account-batch', biz).catch(() => []),
      fetchAllBatch('/api4/employee-batch', biz),
      fetchAllBatch('/api4/payslip-earnings-item-batch', biz).catch(() => []),
      fetchAllBatch('/api4/payslip-deduction-item-batch', biz).catch(() => []),
      fetchAllBatch('/api4/payslip-contribution-item-batch', biz).catch(() => []),
    ]);
    const accounts = [...bsAccounts, ...plAccounts, ...bankCashAccounts];
    const accountList = accounts.map(row => {
      const d = row?.item || row?.value || row || {};
      return { name: (d.name || d.Name || '').trim(), key: row?.key || row?.Key || d.key || '' };
    }).filter(a => a.name && a.key);
    const bankCashAccountList = bankCashAccounts.map(row => {
      const d = row?.item || row?.value || row || {};
      return { name: (d.name || d.Name || '').trim(), key: row?.key || row?.Key || d.key || '' };
    }).filter(a => a.name && a.key);
    const employeeNames = employees.map(row => {
      const d = row?.item || row?.value || row || {};
      return (d.name || d.Name || '').trim();
    }).filter(Boolean).sort((a, b) => a.localeCompare(b));

    // One batch-import column per payslip item the business has actually
    // set up in Manager, grouped Earnings / Deductions / Contributions (in
    // that order) and alphabetical within each group.
    const itemsByGroup = { earnings: earningsItems, deductions: deductionItems, contributions: contributionItems };
    const itemNameByKey = new Map();
    const itemGroupByKey = new Map();
    const payrollCols = [];
    Object.entries(itemsByGroup).forEach(([group, items]) => {
      const groupCols = [];
      items.forEach(row => {
        const d = row?.item || row?.value || row || {};
        const k = row?.key || row?.Key || d.key || '';
        const n = (d.name || d.Name || '').trim();
        if (!k || !n) return;
        itemNameByKey.set(k, n);
        itemGroupByKey.set(k, group);
        groupCols.push({ header: n, itemKey: k, group });
      });
      groupCols.sort((a, b) => a.header.localeCompare(b.header));
      payrollCols.push(...groupCols);
    });
    BI_PAYROLL_COLS = payrollCols;

    const partyList = employees.map(row => {
      const d = row?.item || row?.value || row || {};
      const name = (d.name || d.Name || '').trim();
      const key = row?.key || row?.Key || d.key || '';
      return { key, name, normName: normalizePartyName(name) };
    }).filter(p => p.key && p.name);
    const partyKeyByNormName = new Map(partyList.map(p => [p.normName, p.key]).filter(([n]) => n));

    _biCache = {
      biz,
      accountKeyByName: keyMap(accounts),
      accountList,
      bankCashAccountList,
      employeeNames,
      partyKeyByName: keyMap(employees),
      partyKeyByNormName,
      partyList,
      itemNameByKey,
      itemGroupByKey,
      payrollCols,
    };
    return _biCache;
  }

  const [taxCodes, bsAccounts, plAccounts, bankCashAccounts, apControlAccounts, arControlAccounts, parties, partyBIR] = await Promise.all([
    fetchManagerTaxCodes(biz),
    fetchAllBatch('/api4/balance-sheet-account-batch', biz).catch(() => []),
    fetchAllBatch('/api4/profit-and-loss-statement-account-batch', biz).catch(() => []),
    fetchAllBatch('/api4/bank-or-cash-account-batch', biz).catch(() => []),
    fetchAllBatch('/api4/accounts-payable-control-account-batch', biz).catch(() => []),
    fetchAllBatch('/api4/accounts-receivable-control-account-batch', biz).catch(() => []),
    fetchAllBatch(BI_IS_SALE ? '/api4/customer-batch' : '/api4/supplier-batch', biz),
    loadPartyBIR(biz, BI_IS_SALE ? 'customer' : 'supplier').catch(() => ({})),
  ]);
  const accounts = [...bsAccounts, ...plAccounts, ...bankCashAccounts, ...apControlAccounts, ...arControlAccounts];
  const accountList = accounts.map(row => {
    const d = row?.item || row?.value || row || {};
    return { name: (d.name || d.Name || '').trim(), key: row?.key || row?.Key || d.key || '' };
  }).filter(a => a.name && a.key);
  const taxCodeKeyByName = new Map(taxCodes.map(tc => [tc.name.trim().toLowerCase(), tc.key]));
  const accountKeyByName = keyMap(accounts);

  // Party list with normalized names (for fuzzy near-duplicate matching).
  // TIN is pulled in for display only — the batch template has no TIN column
  // (TIN is maintained per-contact on the Customers/Suppliers BIR tab), so it
  // can't be used to match an import row, but showing it alongside a
  // near-duplicate candidate helps the bookkeeper confirm it's the same party.
  const partyList = parties.map(row => {
    const d = row?.item || row?.value || row || {};
    const name = (d.name || d.Name || '').trim();
    const key = row?.key || row?.Key || d.key || '';
    return { key, name, normName: normalizePartyName(name), tin: (partyBIR || {})[key]?.tin || '' };
  }).filter(p => p.key && p.name);
  const partyKeyByNormName = new Map(partyList.map(p => [p.normName, p.key]).filter(([n]) => n));
  // TEMP: hardcoded fallback for the test business while we confirm the
  // line.account theory — replace with a per-business dynamic lookup once
  // we find Manager's real endpoint for these control accounts.
  const apAccountKey = accountKeyByName.get('accounts payable')
    || (apControlAccounts[0] && (apControlAccounts[0].key || apControlAccounts[0].Key))
    || 'dac7ba37-0ccd-45e5-906e-548e6c50df37';
  const arAccountKey = accountKeyByName.get('accounts receivable')
    || (arControlAccounts[0] && (arControlAccounts[0].key || arControlAccounts[0].Key))
    || 'd1489e95-bb28-4f5d-b42e-67d3291b3893';

  _biCache = {
    biz,
    taxCodes,
    taxCodeKeyByName,
    accountKeyByName,
    accountList,
    partyKeyByName: keyMap(parties),
    partyKeyByNormName,
    partyList,
    apAccountKey,
    arAccountKey,
  };
  return _biCache;
}

// ── PARSE + VALIDATE ─────────────────────────────────────────
async function runValidation() {
  if (!_biFile) return;
  ensureXLSX(async () => {
    document.getElementById('bi-output').innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Reading file…</span></div>`;
    const buf = await _biFile.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets['Batch Import'] || wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // Only count rows where Date or Party Name (cols 0/1) are filled — the
    // payroll sheet pre-fills Gross/Deductions/Net Pay formulas down to row
    // 500 for convenience, which evaluate to 0 (non-blank) on still-empty rows.
    const dataRows = aoa.slice(BI_IS_PAYROLL ? 2 : 1)
      .filter(r => String(r[0] ?? '').trim() !== '' || String(r[1] ?? '').trim() !== '');

    document.getElementById('bi-output').innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Checking against Manager accounts, tax codes &amp; contacts…</span></div>`;
    const cache = await buildLookupCache(_biBiz);

    _biRows = dataRows.map((r, idx) => parseRow(r, idx, cache));
    renderPreview();
  });
}

function parseRow(r, idx, cache) {
  if (BI_IS_PAYROLL) return parsePayrollRow(r, idx, cache);
  return BI_IS_SALE ? parseSaleRow(r, idx, cache) : parsePurchaseRow(r, idx, cache);
}

function parsePayrollRow(r, idx, cache) {
  const errors = [];
  const get = i => (r[i] !== undefined ? String(r[i]).trim() : '');
  const num = i => parseFloat(get(i)) || 0;

  const cols = cache.payrollCols;
  const FIRST_COL = 3; // 0=Date, 1=Employee Name, 2=Reference
  const paidColStart = FIRST_COL + cols.length;

  const row = {
    rowNum: idx + 3,
    date: parseBiDate(r[0]),
    partyName: get(1),
    reference: get(2),
    lines: [],
    paymentAccount: get(paidColStart),
  };

  let hasAmount = false;
  cols.forEach((col, i) => {
    const amount = Math.abs(num(FIRST_COL + i));
    if (amount <= 0) return;
    hasAmount = true;
    row.lines.push({
      group: col.group,
      itemKey: col.itemKey,
      acctName: col.header,
      amount,
    });
  });

  if (!row.date || isNaN(new Date(row.date).getTime())) errors.push(`Date is missing/invalid`);
  if (!row.partyName) errors.push(`${BI_PARTY_LABEL} name is blank`);
  if (!hasAmount) errors.push(`No earnings/deduction/contribution amount entered`);

  resolvePartyMatch(row, cache);

  row.paidAmount = row.lines.filter(l => l.group === 'earnings').reduce((s, l) => s + l.amount, 0)
    - row.lines.filter(l => l.group === 'deductions').reduce((s, l) => s + l.amount, 0);
  row.paidDate = row.date;
  row.paid = true;

  if (!row.paymentAccount) errors.push(`Payment Account is blank`);
  else checkAccount(errors, 'Payment', row.paymentAccount, cache);

  row.errors = errors;
  row.status = errors.length ? 'error' : (row.partyMissing ? 'warn' : 'ok');
  row.posted = false;
  return row;
}

// Resolves a row's typed party name against existing Manager contacts:
// exact name match (original behavior) -> normalized-name match (handles
// punctuation/suffix differences) -> fuzzy near-duplicate candidates the
// bookkeeper must confirm. Mutates `row` with the result.
function resolvePartyMatch(row, cache) {
  if (!row.partyName) { row.partyMissing = false; row.resolvedPartyKey = null; row.nearDupCandidates = []; return; }
  const lname = row.partyName.trim().toLowerCase();
  const normName = normalizePartyName(row.partyName);
  const exactKey = cache.partyKeyByName.get(lname) || cache.partyKeyByNormName.get(normName) || null;
  row.resolvedPartyKey = exactKey;
  row.partyMissing = !exactKey;
  row.nearDupCandidates = exactKey ? [] : findNearDupCandidates(normName, cache);
}

function checkAccount(errors, label, acctName, cache) {
  if (cache.accountKeyByName.size && !cache.accountKeyByName.has(acctName.trim().toLowerCase())) {
    errors.push(`${label} account "${acctName}" not found in Manager — check spelling against the Chart of Accounts sheet`);
  }
}

// Converts a raw cell value into a "YYYY-MM-DD" string. Handles plain text
// dates, JS Date objects, and Excel date serial numbers — Excel silently
// retypes a text date column as a numeric Date cell when the file is
// opened/saved in Excel, which SheetJS then returns as a raw serial number.
function parseBiDate(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && isFinite(v)) {
    const parsed = XLSX.SSF.parse_date_code(v);
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  return String(v).trim();
}

function parseSaleRow(r, idx, cache) {
  const errors = [];
  const get = i => (r[i] !== undefined ? String(r[i]).trim() : '');
  const num = i => parseFloat(get(i)) || 0;
  const getDate = i => parseBiDate(r[i]);

  const row = {
    rowNum: idx + 2,
    date: getDate(0),
    partyName: get(1),
    reference: get(2),
    amountsIncludeTax: true,
    lines: [],
    paid: /^y/i.test(get(15)),
    paidAmount: parseFloat(get(16)) || 0,
    paymentAccount: get(17),
  };
  row.paidDate = row.date; // Paid Same Day — payment date always equals the invoice date

  const revenueAcctName = get(3);
  const vatable    = num(4);
  const exempt     = num(5);
  const zeroRated  = num(6);
  const cwtAcctName = get(7);
  const cwtAtcCode = get(8);
  const cwt        = Math.abs(num(9));
  const wvAcctName  = get(10);
  const wvAtcCode  = get(11);
  const wv         = Math.abs(num(12));
  const otherDedAcctName = get(13);
  const otherDed    = Math.abs(num(14));

  const resolveAcct = (name, label) => {
    if (!name) { errors.push(`${label} account is blank — copy an Account Title from the Chart of Accounts sheet`); return null; }
    const key = cache.accountKeyByName.get(name.trim().toLowerCase());
    if (!key) errors.push(`${label} account "${name}" not found in Manager — check spelling against the Chart of Accounts sheet`);
    return key || null;
  };

  const resolveAtc = (code, label) => {
    if (!code) { errors.push(`${label} ATC Code is blank — copy one from the ATC Codes sheet`); return null; }
    const key = cache.taxCodeKeyByName.get(code.trim().toLowerCase());
    if (!key) errors.push(`${label} ATC Code "${code}" not found in Manager — check spelling against the ATC Codes sheet`);
    return key || null;
  };

  const revenueAcctKey = (vatable > 0 || exempt > 0 || zeroRated > 0) ? resolveAcct(revenueAcctName, 'Revenue') : null;

  if (vatable > 0)   row.lines.push({ acctKey: revenueAcctKey, acctName: revenueAcctName || 'Revenue', amount: vatable, tcName: 'Output VAT 12%' });
  if (exempt > 0)    row.lines.push({ acctKey: revenueAcctKey, acctName: revenueAcctName || 'Revenue', amount: exempt, tcName: 'VAT Exempt Sales' });
  if (zeroRated > 0) row.lines.push({ acctKey: revenueAcctKey, acctName: revenueAcctName || 'Revenue', amount: zeroRated, tcName: 'Zero-Rated Sales' });
  if (cwt > 0)       row.lines.push({ acctKey: resolveAcct(cwtAcctName, 'CWT'), acctName: cwtAcctName || 'CWT', amount: -cwt, tcName: cwtAtcCode, tcKey: resolveAtc(cwtAtcCode, 'CWT') });
  if (wv > 0)        row.lines.push({ acctKey: resolveAcct(wvAcctName, 'WV'), acctName: wvAcctName || 'WV', amount: -wv, tcName: wvAtcCode, tcKey: resolveAtc(wvAtcCode, 'WV') });
  if (otherDed > 0)  row.lines.push({ acctKey: resolveAcct(otherDedAcctName, 'Other Deduction'), acctName: otherDedAcctName || 'Other Deduction', amount: -otherDed });

  ['Output VAT 12%', 'VAT Exempt Sales', 'Zero-Rated Sales'].forEach(tc => {
    if (row.lines.some(l => l.tcName === tc) && !cache.taxCodeKeyByName.has(tc.toLowerCase())) {
      errors.push(`Tax code "${tc}" not found in Manager — install standard tax codes from the Tax Codes tab`);
    }
  });

  if (!row.date || isNaN(new Date(row.date).getTime())) errors.push(`Date is missing/invalid`);
  if (!row.partyName) errors.push(`${BI_PARTY_LABEL} name is blank`);
  if (vatable === 0 && exempt === 0 && zeroRated === 0) errors.push(`No sales amount entered (VATable / VAT Exempt / Zero-Rated Sales)`);

  resolvePartyMatch(row, cache);

  if (row.paid) {
    if (!row.paidAmount) errors.push(`Paid = Yes but Paid Amount is blank`);
    if (!row.paymentAccount) errors.push(`Paid = Yes but Payment Account is blank`);
    else checkAccount(errors, 'Payment', row.paymentAccount, cache);
  }

  row.errors = errors;
  row.status = errors.length ? 'error' : ((row.partyMissing) ? 'warn' : 'ok');
  row.posted = false;
  return row;
}

function parsePurchaseRow(r, idx, cache) {
  const errors = [];
  const get = i => (r[i] !== undefined ? String(r[i]).trim() : '');
  const num = i => parseFloat(get(i)) || 0;
  const getDate = i => parseBiDate(r[i]);

  const row = {
    rowNum: idx + 2,
    date: getDate(0),
    partyName: get(1),
    reference: get(2),
    amountsIncludeTax: true,
    lines: [],
    paid: /^y/i.test(get(12)),
    paidAmount: parseFloat(get(13)) || 0,
    paymentAccount: get(14),
  };
  row.paidDate = row.date; // Paid Same Day — payment date always equals the bill date

  const acctName    = get(3);
  const capGoods    = num(4);
  const otherGoods  = num(5);
  const services    = num(6);
  const zeroRated   = num(7);
  const exempt      = num(8);
  const whtAcctName = get(9);
  const atcCode     = get(10);
  const whtAmount   = Math.abs(num(11));

  const resolveAcct = (name, label) => {
    if (!name) { errors.push(`${label} account is blank — copy an Account Title from the Chart of Accounts sheet`); return null; }
    const key = cache.accountKeyByName.get(name.trim().toLowerCase());
    if (!key) errors.push(`${label} account "${name}" not found in Manager — check spelling against the Chart of Accounts sheet`);
    return key || null;
  };

  const hasCategoryAmount = capGoods > 0 || otherGoods > 0 || services > 0 || zeroRated > 0 || exempt > 0;
  const acctKey = hasCategoryAmount ? resolveAcct(acctName, 'Account') : null;

  if (capGoods > 0)   row.lines.push({ acctKey, acctName: acctName || 'Account', amount: capGoods,   tcName: 'Input VAT 12% (Capital Goods)' });
  if (otherGoods > 0) row.lines.push({ acctKey, acctName: acctName || 'Account', amount: otherGoods, tcName: 'Input VAT 12% (Other Goods)' });
  if (services > 0)   row.lines.push({ acctKey, acctName: acctName || 'Account', amount: services,   tcName: 'Input VAT 12% (Services)' });
  if (zeroRated > 0)  row.lines.push({ acctKey, acctName: acctName || 'Account', amount: zeroRated,  tcName: 'Zero-Rated Purchases' });
  if (exempt > 0)     row.lines.push({ acctKey, acctName: acctName || 'Account', amount: exempt,     tcName: 'VAT Exempt Purchases' });

  ['Input VAT 12% (Capital Goods)', 'Input VAT 12% (Other Goods)', 'Input VAT 12% (Services)', 'Zero-Rated Purchases', 'VAT Exempt Purchases'].forEach(tc => {
    if (row.lines.some(l => l.tcName === tc) && !cache.taxCodeKeyByName.has(tc.toLowerCase())) {
      errors.push(`Tax code "${tc}" not found in Manager — install standard tax codes from the Tax Codes tab`);
    }
  });

  if (whtAmount > 0) {
    const whtAcctKey = resolveAcct(whtAcctName, 'Withholding Tax');
    let atcKey = null;
    if (!atcCode) errors.push(`ATC Code is blank — copy one from the ATC Codes sheet`);
    else {
      atcKey = cache.taxCodeKeyByName.get(atcCode.trim().toLowerCase()) || null;
      if (!atcKey) errors.push(`ATC Code "${atcCode}" not found in Manager — check spelling against the ATC Codes sheet`);
    }
    row.lines.push({ acctKey: whtAcctKey, acctName: whtAcctName || 'Withholding Tax', amount: -whtAmount, tcName: atcCode, tcKey: atcKey });
  }

  if (!row.date || isNaN(new Date(row.date).getTime())) errors.push(`Date is missing/invalid`);
  if (!row.partyName) errors.push(`${BI_PARTY_LABEL} name is blank`);
  if (!hasCategoryAmount) errors.push(`No purchase amount entered (Capital Goods / Other Goods / Services / Zero-Rated / Exempt)`);

  resolvePartyMatch(row, cache);

  if (row.paid) {
    if (!row.paidAmount) errors.push(`Paid = Yes but Paid Amount is blank`);
    if (!row.paymentAccount) errors.push(`Paid = Yes but Payment Account is blank`);
    else checkAccount(errors, 'Payment', row.paymentAccount, cache);
  }

  row.errors = errors;
  row.status = errors.length ? 'error' : (row.partyMissing ? 'warn' : 'ok');
  row.posted = false;
  return row;
}

// ── PREVIEW ───────────────────────────────────────────────────
function renderPreview() {
  const out = document.getElementById('bi-output');
  const okCount  = _biRows.filter(r => r.status !== 'error').length;
  const errCount = _biRows.filter(r => r.status === 'error').length;
  const newParty = _biRows.filter(r => r.partyMissing).length;

  const rowsHtml = _biRows.map((r, i) => `
    <tr class="row-${r.status}" id="bi-row-${i}">
      <td>${r.rowNum}</td>
      <td>${escHtml(r.date)}</td>
      <td>${escHtml(r.partyName)}${r.partyMissing ? ' <span style="color:#92400e;">(new)</span>' : ''}</td>
      <td>${escHtml(r.reference)}</td>
      <td>${r.lines.map(l => `${escHtml(l.acctName)}: ${fmt(l.amount)}${l.tcName ? ' ['+escHtml(l.tcName)+']' : ''}`).join('<br>')}</td>
      <td>${r.paid ? `Yes — ${fmt(r.paidAmount)} on ${escHtml(r.paidDate)} (${escHtml(r.paymentAccount)})` : 'No'}</td>
      <td class="bi-status-cell">${statusCellHtml(r, i)}</td>
    </tr>`).join('');

  out.innerHTML = `
    <div style="margin-bottom:10px;">
      <span class="bi-stat"><b>${_biRows.length}</b> rows</span>
      <span class="bi-stat" style="color:#16a34a;"><b>${okCount}</b> ready</span>
      <span class="bi-stat" style="color:#c0392b;"><b>${errCount}</b> with errors</span>
      <span class="bi-stat" style="color:#92400e;"><b>${newParty}</b> new ${BI_PARTY_LABEL.toLowerCase()}</span>
    </div>
    <div class="bi-wrap">
      <table class="bi-table">
        <thead><tr><th>#</th><th>Date</th><th>${BI_PARTY_LABEL}</th><th>Ref</th><th>Lines</th><th>Paid</th><th>Status</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div id="bi-post-summary"></div>`;

  out.querySelectorAll('.bi-party-pick').forEach(sel => sel.addEventListener('change', onPartyPickChange));
  document.getElementById('bi-post').style.display = okCount > 0 ? '' : 'none';
}

// Renders the Status cell. Rows whose party name doesn't exactly match an
// existing contact but is a close match to one (typo, punctuation, missing
// suffix, etc.) get a picker so the bookkeeper resolves it right here,
// instead of editing the spreadsheet and re-uploading.
function statusCellHtml(r, i) {
  if (r.errors.length) return `<div class="bi-err">${r.errors.map(escHtml).join('<br>')}</div>`;
  if (!r.partyMissing) return '✅ OK';
  if (!r.nearDupCandidates.length) return `⚠️ New ${BI_PARTY_LABEL.toLowerCase()}`;
  const chosen = r.userPartyChoice || 'new';
  const opts = [`<option value="new"${chosen === 'new' ? ' selected' : ''}>+ Create new contact "${escHtml(r.partyName)}"</option>`]
    .concat(r.nearDupCandidates.map(c =>
      `<option value="${c.key}"${chosen === c.key ? ' selected' : ''}>Use existing: ${escHtml(c.name)}${c.tin ? ' (TIN ' + escHtml(c.tin) + ')' : ''}</option>`));
  return `<div style="color:#92400e;">⚠️ Possible duplicate —
    <select class="bi-party-pick" data-row="${i}">${opts.join('')}</select></div>`;
}

function onPartyPickChange(e) {
  const i = parseInt(e.target.dataset.row, 10);
  _biRows[i].userPartyChoice = e.target.value;
  const row = document.getElementById(`bi-row-${i}`);
  if (row) { row.classList.remove('row-warn'); row.classList.add('row-ok'); }
}

function setRowStatus(idx, html) {
  const cell = document.querySelector(`#bi-row-${idx} .bi-status-cell`);
  if (cell) cell.innerHTML = html;
}

// ── POST DIRECTLY TO MANAGER VIA API ───────────────────────────
// Picks the party key to post against: an exact match found during
// validation, the bookkeeper's explicit pick from the duplicate-resolution
// dropdown, or (only if neither applies) creates a brand-new contact.
async function resolvePartyForPosting(row, cache) {
  if (row.resolvedPartyKey) return row.resolvedPartyKey;
  if (row.userPartyChoice && row.userPartyChoice !== 'new') return row.userPartyChoice;
  return ensureParty(row.partyName, cache);
}

async function ensureParty(name, cache) {
  const lname = name.trim().toLowerCase();
  const existing = cache.partyKeyByName.get(lname);
  if (existing) return existing;

  const key = crypto.randomUUID();
  if (BI_IS_PAYROLL) {
    await apiRequest('PUT', '/api4/employee', { key, value: { name: name.trim(), inactive: false } });
  } else {
    await apiRequest('PUT', BI_IS_SALE ? '/api4/customer' : '/api4/supplier', {
      key,
      value: {
        name: name.trim(),
        inactive: false,
        controlAccount: BI_IS_SALE ? cache.arAccountKey : cache.apAccountKey,
      },
    });
  }
  cache.partyKeyByName.set(lname, key);
  return key;
}

async function postPayrollRow(row, cache) {
  const empKey = await ensureParty(row.partyName, cache);

  const earnings = row.lines.filter(l => l.group === 'earnings')
    .map(l => ({ item: l.itemKey, units: 1, unitPrice: l.amount, earningsAmount: null }));
  const deductions = row.lines.filter(l => l.group === 'deductions')
    .map(l => ({ item: l.itemKey, deductionAmount: l.amount }));
  const contributions = row.lines.filter(l => l.group === 'contributions')
    .map(l => ({ item: l.itemKey, contributionAmount: l.amount }));

  const payslipKey = crypto.randomUUID();
  await apiRequest('PUT', '/api4/payslip', {
    key: payslipKey,
    value: {
      employee: empKey,
      date: row.date,
      reference: row.reference || null,
      earnings,
      deductions,
      contributions,
    },
  });

  if (row.paid) {
    const paymentAcctKey = cache.accountKeyByName.get(row.paymentAccount.trim().toLowerCase()) || null;
    await apiRequest('PUT', '/api4/payment', {
      key: crypto.randomUUID(),
      value: {
        date: row.paidDate,
        reference: row.reference || null,
        paidFrom: paymentAcctKey,
        description: `Net pay — ${row.partyName}`,
        lines: [{
          account: BI_SALARIES_PAYABLE_ACCOUNT,
          employee: empKey,
          lineDescription: `Net pay — ${row.partyName}`,
          amount: row.paidAmount,
        }],
      },
    });
  }

  return payslipKey;
}

async function postInvoiceRow(row, cache) {
  const partyKey = await resolvePartyForPosting(row, cache);

  const lines = row.lines.map(l => {
    const line = {
      account: l.acctKey || cache.accountKeyByName.get(l.acctName.trim().toLowerCase()) || null,
      qty: 1,
      taxCode: l.tcKey !== undefined ? l.tcKey : (l.tcName ? (cache.taxCodeKeyByName.get(l.tcName.trim().toLowerCase()) || null) : null),
    };
    line[BI_IS_SALE ? 'salesUnitPrice' : 'purchaseUnitPrice'] = l.amount;
    return line;
  });

  const invoiceKey = crypto.randomUUID();
  const value = {
    issueDate: row.date,
    reference: row.reference || null,
    amountsIncludeTax: !!row.amountsIncludeTax,
    lines,
  };
  value[BI_IS_SALE ? 'customer' : 'supplier'] = partyKey;

  await apiRequest('PUT', BI_IS_SALE ? '/api4/sales-invoice' : '/api4/purchase-invoice', { key: invoiceKey, value });

  if (row.paid) {
    const paymentAcctKey = cache.accountKeyByName.get(row.paymentAccount.trim().toLowerCase()) || null;
    const settleKey = crypto.randomUUID();
    if (BI_IS_SALE) {
      await apiRequest('PUT', '/api4/receipt', {
        key: settleKey,
        value: {
          date: row.paidDate,
          reference: row.reference || null,
          receivedIn: paymentAcctKey,
          paidBy: 1,
          customer: partyKey,
          lines: [{
            account: cache.arAccountKey,
            accountsReceivableCustomer: partyKey,
            accountsReceivableSalesInvoice: invoiceKey,
            amount: row.paidAmount,
          }],
        },
      });
    } else {
      await apiRequest('PUT', '/api4/payment', {
        key: settleKey,
        value: {
          date: row.paidDate,
          reference: row.reference || null,
          paidFrom: paymentAcctKey,
          payee: 2,
          supplier: partyKey,
          lines: [{
            account: cache.apAccountKey,
            accountsPayableSupplier: partyKey,
            purchaseInvoice: invoiceKey,
            amount: row.paidAmount,
          }],
        },
      });
    }
  }

  return invoiceKey;
}

async function postAllToManager() {
  const cache = await buildLookupCache(_biBiz);
  const okIdx = _biRows.map((r, i) => i).filter(i => _biRows[i].status !== 'error' && !_biRows[i].posted);

  document.getElementById('bi-post').disabled = true;
  let successCount = 0;
  const failures = [];

  for (const i of okIdx) {
    const row = _biRows[i];
    setRowStatus(i, `<div class="spinner-wrap" style="justify-content:flex-start;"><div class="spinner" style="width:14px;height:14px;"></div><span>Posting…</span></div>`);
    try {
      await (BI_IS_PAYROLL ? postPayrollRow(row, cache) : postInvoiceRow(row, cache));
      row.posted = true;
      successCount++;
      setRowStatus(i, '✅ Posted to Manager' + (row.paid ? ' + settled' : ''));
    } catch (err) {
      failures.push({ rowNum: row.rowNum, message: err.message });
      setRowStatus(i, `<div class="bi-err">❌ Failed: ${escHtml(err.message)}</div>`);
    }
  }

  document.getElementById('bi-post').disabled = false;
  const summary = document.getElementById('bi-post-summary');
  summary.innerHTML = `
    <div class="alert ${failures.length ? 'alert-warning' : 'alert-info'}" style="margin-top:14px;">
      ${failures.length
        ? `⚠️ Posted <strong>${successCount}</strong> of <strong>${okIdx.length}</strong> rows. <strong>${failures.length}</strong> failed — see row(s) above for the error, fix the source data, and click "Post to Manager" again to retry just the failed rows.`
        : `✅ Posted <strong>${successCount}</strong> row(s) to Manager — ${BI_PARTY_LABEL}s created as needed, then ${BI_IS_PAYROLL ? 'Payslips, then Payments' : 'Invoices, then ' + (BI_IS_SALE ? 'Receipts' : 'Payments')} for rows marked Paid Same Day.`}
    </div>`;
}
