/* ============================================================
   Tallo CPA – BIR Tax App
   batch-import-collect.js  –  Downloads open (not fully paid) Sales
                        or Purchase Invoices as of today, lets the
                        bookkeeper fill in the settlement date, bank/
                        cash account, and amount collected/paid for
                        whichever rows have actually cleared, then
                        posts matching Receipts/Payments straight to
                        Manager's API (PUT) from inside this iframe.
                        Unlike batch-import.js, this never creates new
                        invoices or contacts — every row settles an
                        invoice that already exists in Manager.

   Shared by two installable pages:
     batch-import-receivables.html  sets BI_COLLECT_TYPE = 'Sale'
     batch-import-payables.html     sets BI_COLLECT_TYPE = 'Purchase'
   ============================================================ */

const BI_IS_SALE_C = (typeof BI_COLLECT_TYPE !== 'undefined' ? BI_COLLECT_TYPE : 'Sale') === 'Sale';
const BI_PARTY_LABEL_C = BI_IS_SALE_C ? 'Customer' : 'Supplier';
const BI_SETTLE_NOUN = BI_IS_SALE_C ? 'Receipt' : 'Payment';
const BI_INVOICE_NOUN = BI_IS_SALE_C ? 'Sales Invoice' : 'Purchase Invoice';

let _bicRows = [];
let _bicBiz  = '';
let _bicCache = null;
let _bicFile = null;

async function initBatchCollect() {
  const biz = await getReportBusiness(document.getElementById('biz-selector-wrap'));
  App.currentBusiness = biz;
  _bicBiz = biz;

  document.getElementById('bic-download').addEventListener('click', downloadOpenInvoices);
  document.getElementById('bic-upload-btn').addEventListener('click', () => document.getElementById('bic-file').click());
  document.getElementById('bic-file').addEventListener('change', handleFileChosenC);
  document.getElementById('bic-validate').addEventListener('click', runValidationC);
  document.getElementById('bic-post').addEventListener('click', postAllToManagerC);
}

// ── XLSX / EXCELJS LOADING (lazy) ──
function ensureXLSXc(cb) {
  if (window.XLSX) return cb();
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  s.onload = cb;
  document.head.appendChild(s);
}
function ensureExcelJSc(cb) {
  if (window.ExcelJS) return cb();
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  s.onload = cb;
  document.head.appendChild(s);
}

function colLetterC(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Converts a raw cell value into a "YYYY-MM-DD" string — same conversion
// rules as batch-import.js's parseBiDate (kept local since these two pages
// don't load batch-import.js).
function parseBiDateC(v) {
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

// ── INVOICE / SETTLEMENT MATH ──────────────────────────────────
// Manager has no native "balance" field on an invoice — it's derived by
// summing the invoice's own lines, then subtracting whatever Receipts
// (Sales) or Payments (Purchases) already reference that invoice key.
function getLinesC(item) {
  return item?.Lines || item?.lines || [];
}

function lineSignedAmount(line) {
  if (line?.amount != null) return Number(line.amount);
  const qty = Number(line?.qty ?? 1);
  const unitPrice = Number(line?.salesUnitPrice ?? line?.purchaseUnitPrice ?? line?.unitPrice ?? 0);
  let amt = qty * unitPrice;
  if (line?.discountPercentage) amt *= (1 - Number(line.discountPercentage) / 100);
  amt -= Number(line?.discountAmount || 0);
  return amt;
}

function invoiceTotalC(item) {
  return getLinesC(item).reduce((s, l) => s + lineSignedAmount(l), 0);
}

// Receipt lines reference the invoice via `accountsReceivableSalesInvoice`;
// Payment lines reference it via `purchaseInvoice` — matching the exact
// field names batch-import.js already posts under (see postInvoiceRow).
function settleLineInvoiceKey(line) {
  const raw = BI_IS_SALE_C
    ? (line?.accountsReceivableSalesInvoice ?? line?.AccountsReceivableSalesInvoice)
    : (line?.purchaseInvoice ?? line?.PurchaseInvoice);
  return (raw && typeof raw === 'object') ? (raw.key || raw.Key || '') : (raw || '');
}

// Fetches every invoice plus every Receipt/Payment, and returns a Map of
// invoiceKey -> { partyKey, partyName, date, reference, total, balance }.
// Used both to build the "open invoices" download and, at validate/post
// time, to re-check each row against Manager's current state (a receipt
// could have been recorded directly in Manager since the file was downloaded).
async function buildOpenInvoiceMap(biz) {
  const isSale = BI_IS_SALE_C;
  const [invItems, settleItems, partyMap] = await Promise.all([
    fetchAllBatch(isSale ? '/api4/sales-invoice-batch' : '/api4/purchase-invoice-batch', biz),
    fetchAllBatch(isSale ? '/api4/receipt-batch' : '/api4/payment-batch', biz),
    loadPartyBIR(biz, isSale ? 'customer' : 'supplier'),
  ]);

  const settledByInvoice = new Map();
  for (const { item } of settleItems) {
    for (const line of getLinesC(item)) {
      const invKey = settleLineInvoiceKey(line);
      if (!invKey) continue;
      settledByInvoice.set(invKey, (settledByInvoice.get(invKey) || 0) + Number(line?.amount ?? 0));
    }
  }

  const map = new Map();
  for (const { key: invKey, item } of invItems) {
    const partyKey = item?.[isSale ? 'customer' : 'supplier'] || item?.[isSale ? 'Customer' : 'Supplier'] || '';
    const pd = partyMap[partyKey] || {};
    const total = invoiceTotalC(item);
    const settled = settledByInvoice.get(invKey) || 0;
    map.set(invKey, {
      invoiceKey: invKey,
      partyKey,
      partyName: pd.name || partyKey,
      date: item?.issueDate || item?.Date || '',
      reference: item?.reference || item?.Reference || item?.invoiceNumber || item?.InvoiceNumber || '',
      total,
      balance: total - settled,
    });
  }
  return map;
}

// ── LOOKUP CACHE (bank/cash accounts, AR/AP control account, open invoices) ──
async function buildCollectCache(biz) {
  if (_bicCache && _bicCache.biz === biz) return _bicCache;

  const isSale = BI_IS_SALE_C;
  const [invoiceMap, bankCashAccounts, controlAccounts] = await Promise.all([
    buildOpenInvoiceMap(biz),
    fetchAllBatch('/api4/bank-or-cash-account-batch', biz).catch(() => []),
    fetchAllBatch(isSale ? '/api4/accounts-receivable-control-account-batch' : '/api4/accounts-payable-control-account-batch', biz).catch(() => []),
  ]);

  const bankCashAccountList = bankCashAccounts.map(row => {
    const d = row?.item || row?.value || row || {};
    return { name: (d.name || d.Name || '').trim(), key: row?.key || row?.Key || d.key || '' };
  }).filter(a => a.name && a.key);
  const accountKeyByName = new Map(bankCashAccountList.map(a => [a.name.toLowerCase(), a.key]));
  const controlAccountKey = (controlAccounts[0] && (controlAccounts[0].key || controlAccounts[0].Key)) || null;

  _bicCache = { biz, invoiceMap, bankCashAccountList, accountKeyByName, controlAccountKey };
  return _bicCache;
}

// ── DOWNLOAD OPEN INVOICES ──────────────────────────────────────
function bicHeaders() {
  return [
    'Invoice ID (internal — do not edit)',
    'Invoice Date',
    `${BI_PARTY_LABEL_C} Name`,
    'Reference',
    'Invoice Amount',
    'Balance Due (as of download)',
    `${BI_SETTLE_NOUN} Date (YYYY-MM-DD)`,
    'Bank/Cash Account',
    `Amount ${BI_IS_SALE_C ? 'Received' : 'Paid'}`,
  ];
}

const BI_TEMPLATE_BRAND_C = 'FF1F4E78';

async function downloadOpenInvoices() {
  const out = document.getElementById('bic-output');
  out.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Fetching open ${BI_INVOICE_NOUN.toLowerCase()}s…</span></div>`;

  const cache = await buildCollectCache(_bicBiz);
  const today = new Date();
  const open = [...cache.invoiceMap.values()]
    .filter(r => Math.abs(r.balance) > 0.005)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.partyName.localeCompare(b.partyName));

  if (!open.length) {
    out.innerHTML = `<div class="alert alert-info">✅ No open ${BI_INVOICE_NOUN.toLowerCase()}s found — everything is fully settled as of today.</div>`;
    return;
  }

  out.innerHTML = '';
  ensureExcelJSc(async () => {
    const wb = new ExcelJS.Workbook();

    const instr = wb.addWorksheet('Instructions');
    instr.getColumn(1).width = 100;
    const titleRow = instr.addRow([`Batch ${BI_SETTLE_NOUN} Collection — Instructions`]);
    titleRow.font = { bold: true, size: 14, color: { argb: BI_TEMPLATE_BRAND_C } };
    instr.addRow([]);
    [
      `1. The "Open ${BI_INVOICE_NOUN}s" sheet lists every ${BI_INVOICE_NOUN.toLowerCase()} that isn't fully settled as of today (${today.toLocaleDateString('en-PH')}), one row per invoice.`,
      `2. Only fill in the last three columns — "${BI_SETTLE_NOUN} Date", "Bank/Cash Account", and "Amount ${BI_IS_SALE_C ? 'Received' : 'Paid'}" — for rows that have actually cleared. Leave a row's Amount blank if it hasn't been collected yet; it will simply be skipped.`,
      `3. Do not edit the "Invoice ID", "Invoice Date", "${BI_PARTY_LABEL_C} Name", "Reference", "Invoice Amount", or "Balance Due" columns — the importer uses "Invoice ID" to match each row back to its invoice in Manager.`,
      `4. "Bank/Cash Account": pick a value from the dropdown (sourced from the "Bank/Cash Accounts" sheet) or type the exact account title.`,
      `5. A partial amount is fine — the invoice stays open for the remaining balance. The amount just can't exceed the current balance due.`,
      `6. When done, go back to the app, choose "Upload" and select this same file, then click Validate before Post.`,
    ].forEach(s => { const row = instr.addRow([s]); row.font = { size: 11 }; row.alignment = { wrapText: true }; });

    const ws = wb.addWorksheet(`Open ${BI_INVOICE_NOUN}s`);
    const headers = bicHeaders();
    ws.addRow(headers);
    open.forEach(r => ws.addRow([r.invoiceKey, r.date, r.partyName, r.reference, r.total, r.balance, '', '', '']));

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BI_TEMPLATE_BRAND_C } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 32;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    headers.forEach((h, i) => { ws.getColumn(i + 1).width = Math.max(14, Math.min(32, h.length + 4)); });
    ws.getColumn(1).hidden = true;

    // Reference-only columns (read from Manager, matched by Invoice ID) are
    // shown italic/grey to signal they shouldn't be edited; the three
    // fill-in columns get a light highlight.
    for (let r = 2; r <= open.length + 1; r++) {
      for (let c = 2; c <= 6; c++) ws.getCell(r, c).font = { italic: true, color: { argb: 'FF6b7280' } };
      ws.getCell(r, 5).numFmt = '#,##0.00';
      ws.getCell(r, 6).numFmt = '#,##0.00';
      for (let c = 7; c <= 9; c++) ws.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } };
      ws.getCell(r, 9).numFmt = '#,##0.00';
    }

    // Bank/Cash Accounts reference sheet + dropdown validation
    const bank = wb.addWorksheet('Bank/Cash Accounts');
    bank.getColumn(1).width = 40;
    bank.addRow(['Cash/Bank Account']).font = { bold: true };
    const bankNames = cache.bankCashAccountList.map(a => a.name).sort((a, b) => a.localeCompare(b));
    bankNames.forEach(n => bank.addRow([n]));
    const bankRange = `'Bank/Cash Accounts'!$A$2:$A$${Math.max(2, bankNames.length + 1)}`;
    for (let r = 2; r <= open.length + 1; r++) {
      ws.getCell(`H${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [bankRange],
        showErrorMessage: true,
        errorStyle: 'warning',
        errorTitle: 'Not in list',
        error: 'Pick a value from the dropdown, or type the exact name from the reference sheet.',
      };
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    a.download = `batch_collect_${BI_IS_SALE_C ? 'receivables' : 'payables'}_${stamp}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

function handleFileChosenC(e) {
  _bicFile = e.target.files[0] || null;
  document.getElementById('bic-filename').textContent = _bicFile ? _bicFile.name : '';
  document.getElementById('bic-validate').style.display = _bicFile ? '' : 'none';
  document.getElementById('bic-post').style.display = 'none';
  document.getElementById('bic-output').innerHTML = '';
}

// ── PARSE + VALIDATE ─────────────────────────────────────────
async function runValidationC() {
  if (!_bicFile) return;
  ensureXLSXc(async () => {
    document.getElementById('bic-output').innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Reading file…</span></div>`;
    const buf = await _bicFile.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[`Open ${BI_INVOICE_NOUN}s`] || wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const dataRows = aoa.slice(1).filter(r => String(r[0] ?? '').trim() !== '');

    document.getElementById('bic-output').innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Checking against Manager's current invoice balances…</span></div>`;
    _bicCache = null; // force a fresh read of invoice balances/settlements at validate time
    const cache = await buildCollectCache(_bicBiz);

    _bicRows = dataRows.map((r, idx) => parseCollectRow(r, idx, cache));
    renderPreviewC();
  });
}

function parseCollectRow(r, idx, cache) {
  const get = i => (r[i] !== undefined ? String(r[i]).trim() : '');
  const num = i => parseFloat(get(i)) || 0;
  const getDate = i => parseBiDateC(r[i]);

  const row = {
    rowNum: idx + 2,
    invoiceKey: get(0),
    date: getDate(1),
    partyName: get(2),
    reference: get(3),
    invoiceAmount: num(4),
    balanceAtDownload: num(5),
    settleDate: getDate(6),
    account: get(7),
    amount: num(8),
    posted: false,
  };

  const fresh = row.invoiceKey ? cache.invoiceMap.get(row.invoiceKey) : null;
  if (!fresh) {
    row.errors = [`Invoice not found in Manager — it may have been deleted. Don't edit the "Invoice ID" column; re-download the file if this keeps happening.`];
    row.status = 'error';
    return row;
  }
  row.partyKey = fresh.partyKey;
  row.freshBalance = fresh.balance;

  if (row.amount <= 0) {
    row.errors = [];
    row.status = 'skip';
    return row;
  }

  const errors = [];
  if (!row.settleDate || isNaN(new Date(row.settleDate).getTime())) errors.push(`${BI_SETTLE_NOUN} Date is missing/invalid`);
  if (!row.account) errors.push(`Bank/Cash Account is blank`);
  else if (cache.accountKeyByName.size && !cache.accountKeyByName.has(row.account.trim().toLowerCase())) {
    errors.push(`Bank/Cash Account "${row.account}" not found in Manager — check spelling against the Bank/Cash Accounts sheet`);
  }
  if (fresh.balance <= 0.005) errors.push(`This invoice is already fully settled in Manager — remove this row or re-download the file`);
  else if (row.amount - fresh.balance > 0.01) errors.push(`Amount (${fmt(row.amount)}) exceeds the current balance due (${fmt(fresh.balance)}) — check for a typo, or a ${BI_SETTLE_NOUN.toLowerCase()} already recorded elsewhere`);

  row.errors = errors;
  row.status = errors.length ? 'error' : 'ok';
  return row;
}

// ── PREVIEW ───────────────────────────────────────────────────
function renderPreviewC() {
  const out = document.getElementById('bic-output');
  const okCount   = _bicRows.filter(r => r.status === 'ok').length;
  const errCount  = _bicRows.filter(r => r.status === 'error').length;
  const skipCount = _bicRows.filter(r => r.status === 'skip').length;

  const rowsHtml = _bicRows.map((r, i) => `
    <tr class="row-${r.status}" id="bic-row-${i}">
      <td>${r.rowNum}</td>
      <td>${escHtml(r.date)}</td>
      <td>${escHtml(r.partyName)}</td>
      <td>${escHtml(r.reference)}</td>
      <td>${fmt(r.invoiceAmount)}</td>
      <td>${r.freshBalance != null ? fmt(r.freshBalance) : fmt(r.balanceAtDownload)}</td>
      <td>${r.status === 'skip' ? '<span style="color:#9ca3af;">— not yet collected —</span>' : `${fmt(r.amount)} on ${escHtml(r.settleDate)} (${escHtml(r.account)})`}</td>
      <td class="bic-status-cell">${statusCellHtmlC(r)}</td>
    </tr>`).join('');

  out.innerHTML = `
    <div style="margin-bottom:10px;">
      <span class="bi-stat"><b>${_bicRows.length}</b> open invoices</span>
      <span class="bi-stat" style="color:#16a34a;"><b>${okCount}</b> ready to post</span>
      <span class="bi-stat" style="color:#c0392b;"><b>${errCount}</b> with errors</span>
      <span class="bi-stat" style="color:#9ca3af;"><b>${skipCount}</b> not yet collected</span>
    </div>
    <div class="bi-wrap">
      <table class="bi-table">
        <thead><tr><th>#</th><th>Date</th><th>${BI_PARTY_LABEL_C}</th><th>Ref</th><th>Invoice Amt</th><th>Balance Due</th><th>${BI_SETTLE_NOUN}</th><th>Status</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div id="bic-post-summary"></div>`;

  document.getElementById('bic-post').style.display = okCount > 0 ? '' : 'none';
}

function statusCellHtmlC(r) {
  if (r.status === 'error') return `<div class="bi-err">${r.errors.map(escHtml).join('<br>')}</div>`;
  if (r.status === 'skip') return '—';
  return '✅ OK';
}

function setRowStatusC(idx, html) {
  const cell = document.querySelector(`#bic-row-${idx} .bic-status-cell`);
  if (cell) cell.innerHTML = html;
}

// ── POST DIRECTLY TO MANAGER VIA API ───────────────────────────
async function postSettleRow(row, cache) {
  const acctKey = cache.accountKeyByName.get(row.account.trim().toLowerCase()) || null;
  const value = { date: row.settleDate, reference: row.reference || null };

  if (BI_IS_SALE_C) {
    value.receivedIn = acctKey;
    value.paidBy = 1;
    value.customer = row.partyKey;
    value.lines = [{
      account: cache.controlAccountKey,
      accountsReceivableCustomer: row.partyKey,
      accountsReceivableSalesInvoice: row.invoiceKey,
      amount: row.amount,
    }];
  } else {
    value.paidFrom = acctKey;
    value.payee = 2;
    value.supplier = row.partyKey;
    value.lines = [{
      account: cache.controlAccountKey,
      accountsPayableSupplier: row.partyKey,
      purchaseInvoice: row.invoiceKey,
      amount: row.amount,
    }];
  }

  await apiRequest('PUT', BI_IS_SALE_C ? '/api4/receipt' : '/api4/payment', { key: crypto.randomUUID(), value });
}

async function postAllToManagerC() {
  const cache = await buildCollectCache(_bicBiz);
  const okIdx = _bicRows.map((r, i) => i).filter(i => _bicRows[i].status === 'ok' && !_bicRows[i].posted);

  document.getElementById('bic-post').disabled = true;
  let successCount = 0;
  const failures = [];

  for (const i of okIdx) {
    const row = _bicRows[i];
    setRowStatusC(i, `<div class="spinner-wrap" style="justify-content:flex-start;"><div class="spinner" style="width:14px;height:14px;"></div><span>Posting…</span></div>`);
    try {
      await postSettleRow(row, cache);
      row.posted = true;
      successCount++;
      setRowStatusC(i, `✅ Posted ${BI_SETTLE_NOUN.toLowerCase()} to Manager`);
    } catch (err) {
      failures.push({ rowNum: row.rowNum, message: err.message });
      setRowStatusC(i, `<div class="bi-err">❌ Failed: ${escHtml(err.message)}</div>`);
    }
  }

  document.getElementById('bic-post').disabled = false;
  const summary = document.getElementById('bic-post-summary');
  summary.innerHTML = `
    <div class="alert ${failures.length ? 'alert-warning' : 'alert-info'}" style="margin-top:14px;">
      ${failures.length
        ? `⚠️ Posted <strong>${successCount}</strong> of <strong>${okIdx.length}</strong> rows. <strong>${failures.length}</strong> failed — see row(s) above for the error, fix the source data, and click "Post to Manager" again to retry just the failed rows.`
        : `✅ Posted <strong>${successCount}</strong> ${BI_SETTLE_NOUN.toLowerCase()}(s) to Manager, settling each matching invoice.`}
    </div>`;
}
