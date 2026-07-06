/* ============================================================
   Tallo CPA – BIR Tax App
   pnl-helpers.js – Chart-of-Accounts cache + transaction
                     aggregator used by Income Tax (1701/1702)
                     and Tax Reconciliation reports.

   Manager.io has no API endpoint that returns computed P&L /
   trial-balance figures — only report *definitions*. The
   `profit-and-loss-statement-account-batch` and
   `balance-sheet-account-batch` endpoints, however, return the
   real Chart of Accounts (name + group). Combined with the raw
   transaction batches (journal entries, invoices, receipts,
   payments) which carry a denormalized `account` GUID and
   debit/credit amounts, we can reconstruct P&L totals ourselves.
   ============================================================ */

// Standard Manager.io system group GUIDs (same across all businesses). Only
// used as a fallback (see pnlBucketForAccount below) — real accounts live in
// editable *subgroups* of these, never directly in the master group itself,
// so this match rarely fires once an account has a real BIR category.
const PNL_GROUP = {
  SALES: '95713fac-30d3-42e4-b536-dd7bc4f7a80e',   // Sales / Other Income
  COGS:  '11eafe62-925c-4b6b-8321-1b5485a963cc',   // Cost of Sales
  OPEX:  'fd003045-876e-439e-b923-1904453f5c30',   // Operating Expenses
};

// Maps the explicit BIR category (set per-account in the COA tab, chart-of-
// accounts.js's BIR_COA_CATEGORIES) to the 3 P&L totals the income-tax
// reports aggregate into. Cost of Sales and Cost of Services both feed the
// single "Cost of Sales/Services" line on 1701/1701Q/1702Q/1702RT; Other
// Income/Other Expense are still ordinary P&L income/expense for tax
// purposes, so they roll into the same income/opex totals as Revenue/Opex.
const COA_CATEGORY_BUCKET = {
  'acct-bir-revenue':  'income',
  'acct-bir-oincome':  'income',
  'acct-bir-cogs':     'cogs',
  'acct-bir-cos':      'cogs',
  'acct-bir-opex':     'opex',
  'acct-bir-oexpense': 'opex',
};

// ── DEFERRED TAX ASSET ACCOUNTS (carry-forward figures) ──────
// Account names the preparer books cross-year/cross-quarter income-tax
// carry-forward figures to — Balance Sheet / asset-type, never P&L, so they
// never touch Gross/Taxable Income. Distinct "Deferred Tax Asset -" prefix
// keeps findAccountByName()'s substring match from ever confusing these
// with "Prepaid Tax Asset-2307/2306". Shared by 1701q-report.js (Prior
// Year Excess Credit only — individuals have no MCIT) and 1702q-report.js
// (all 4 — a business is always either Individual or Non-Individual, never
// both, so there's no collision risk reusing the same account name).
const DTA_ACCOUNTS = {
  priorYearExcessCredit: 'Deferred Tax Asset - Prior Year Excess Credit',
  itrPaymentsRegular:    'Deferred Tax Asset - ITR Payments Regular',
  itrPaymentsMcit:       'Deferred Tax Asset - ITR Payments MCIT',
  mcitCarryforward:      'Deferred Tax Asset - MCIT Carryforward',
};

// coaMap: { accountGuid -> 'acct-bir-<category>' } from getCoaMapping() — the
// mapping the preparer sets up in the COA tab. That mapping is the source of
// truth; the raw Manager group GUID is only a fallback for accounts nobody
// has mapped yet (and, per the comment above, will rarely match anything).
function pnlBucketForAccount(guid, groupGuid, coaMap) {
  const mapped = coaMap && coaMap[guid];
  if (mapped && COA_CATEGORY_BUCKET[mapped]) return COA_CATEGORY_BUCKET[mapped];
  if (groupGuid === PNL_GROUP.SALES) return 'income';
  if (groupGuid === PNL_GROUP.COGS) return 'cogs';
  if (groupGuid === PNL_GROUP.OPEX) return 'opex';
  return 'other';
}

// ── CHART OF ACCOUNTS CACHE ──────────────────────────────────
let _coaCache = {}; // { [biz]: { [accountGuid]: {...} } }

async function loadChartOfAccounts(biz, force = false) {
  if (!force && _coaCache[biz]) return _coaCache[biz];

  let coaMap = {};
  try {
    coaMap = (typeof getCoaMapping === 'function') ? await getCoaMapping(biz) : {};
  } catch (e) {
    console.warn('loadChartOfAccounts: getCoaMapping failed, falling back to group-GUID matching:', e.message);
  }

  const [pnlAccounts, bsAccounts] = await Promise.all([
    fetchAllBatch('/api4/profit-and-loss-statement-account-batch', biz),
    fetchAllBatch('/api4/balance-sheet-account-batch', biz),
  ]);

  const byKey = {};
  for (const it of pnlAccounts) {
    const a = it.item || it.value || it;
    const key = a.key || it.key;
    byKey[key] = {
      key,
      name: a.name,
      group: a.group,
      bucket: pnlBucketForAccount(key, a.group, coaMap),
      isProfitAndLossAccount: true,
    };
  }
  for (const it of bsAccounts) {
    const a = it.item || it.value || it;
    byKey[a.key || it.key] = {
      key: a.key || it.key,
      name: a.name,
      group: a.group,
      bucket: 'balanceSheet',
      isProfitAndLossAccount: false,
    };
  }

  _coaCache[biz] = byKey;
  return byKey;
}

function invalidateCoaCache(biz) {
  delete _coaCache[biz];
}

// ── ACCOUNT GROUPS CACHE ─────────────────────────────────────
// Groups are real Manager resources (balance-sheet-group / profit-and-loss-
// statement-group) — accounts reference one by GUID. Used by the COA builder
// to populate the Group picker and to create new custom headings.
let _coaGroupCache = {};

async function loadAccountGroups(biz, force = false) {
  if (!force && _coaGroupCache[biz]) return _coaGroupCache[biz];

  const [pnlGroups, bsGroups] = await Promise.all([
    fetchAllBatch('/api4/profit-and-loss-statement-group-batch', biz),
    fetchAllBatch('/api4/balance-sheet-group-batch', biz),
  ]);

  const norm = (it, isPnL) => {
    const g = it.item || it.value || it;
    return { key: g.key || it.key, name: g.name, isProfitAndLossAccount: isPnL };
  };

  const result = {
    pnl: pnlGroups.map(it => norm(it, true)),
    bs: bsGroups.map(it => norm(it, false)),
  };
  _coaGroupCache[biz] = result;
  return result;
}

function invalidateAccountGroupsCache(biz) {
  delete _coaGroupCache[biz];
}

function findAccountByName(coa, nameSubstr) {
  const needle = nameSubstr.toLowerCase();
  return Object.values(coa).find(a => (a.name || '').toLowerCase().includes(needle)) || null;
}

// Tax-code rate cache, keyed by Manager tax-code GUID. Needed to back
// VAT out of invoice/receipt/payment line amounts (which only carry
// qty + unitPrice + taxCode, not a precomputed net amount) — see
// `lineAmounts()` in shared.js, the same helper the SLS/SLP/EWT
// reports already use.
let _taxRateCache = {};
async function loadTaxCodeRates(biz) {
  if (_taxRateCache[biz]) return _taxRateCache[biz];
  const taxCodes = await fetchManagerTaxCodes(biz);
  const rateByKey = {};
  for (const tc of taxCodes) rateByKey[tc.key] = tc.rate;
  _taxRateCache[biz] = rateByKey;
  return rateByKey;
}

function pnlLineTaxCodeKey(line) {
  const tc = line?.taxCode ?? line?.TaxCode ?? '';
  return (tc && typeof tc === 'object') ? (tc.key || tc.Key || '') : (tc || '');
}

// Journal-entry lines carry real credit/debit fields; invoice/receipt/
// payment lines only carry qty + unitPrice (+ optional discount/tax),
// so their GL amount has to be computed via lineAmounts(). Returns a
// signed contribution suitable for direct summation into income (CR
// normal balance) or cogs/opex (DR normal balance) buckets.
function pnlLineAmount(item, line, rateByKey, bucket) {
  const hasCredit = line.credit !== undefined || line.Credit !== undefined;
  const hasDebit  = line.debit  !== undefined || line.Debit  !== undefined;
  if (hasCredit || hasDebit) {
    const credit = Number(line.credit ?? line.Credit ?? 0);
    const debit  = Number(line.debit  ?? line.Debit  ?? 0);
    return bucket === 'income' ? (credit - debit) : (debit - credit);
  }
  return lineAmounts(item, line, rateByKey).net; // always a positive magnitude
}

// ── PAYSLIP ITEM -> EXPENSE ACCOUNT CACHE ─────────────────────
// Manager posts payroll through Payslip transactions, not Journal
// Entries — each payslip's Earnings/Employer-Contribution lines hit
// whatever expense account is configured on that earnings/contribution
// item (Settings > Payroll Items), not an account on the line itself.
// Deduction lines (WTC, employee SSS/PHIC/HDMF) only redirect part of
// gross pay to a liability account — gross pay is already captured via
// the Earnings lines — so they have no separate P&L impact and are
// skipped here (same logic payroll-helpers.js uses for 1601-C/2316).
let _payslipItemAccountCache = {};
async function loadPayslipItemAccounts(biz, force = false) {
  if (!force && _payslipItemAccountCache[biz]) return _payslipItemAccountCache[biz];
  const [earnings, contributions] = await Promise.all([
    fetchAllBatch('/api4/payslip-earnings-item-batch', biz),
    fetchAllBatch('/api4/payslip-contribution-item-batch', biz),
  ]);
  const byKey = {};
  for (const it of [...earnings, ...contributions]) {
    const a = it.item || it.value || it;
    const acct = a.account ?? a.Account ?? a.expenseAccount ?? a.ExpenseAccount;
    const guid = (acct && typeof acct === 'object') ? (acct.key || acct.Key) : acct;
    if (guid) byKey[a.key || it.key] = guid;
  }
  _payslipItemAccountCache[biz] = byKey;
  return byKey;
}

// Sums payslip Earnings + Employer-Contribution lines (e.g. depreciation-
// style adjustments don't apply here, but salaries/wages, 13th month,
// SSS/PHIC/HDMF employer share, etc. do) directly into the byAccount/
// totals produced by aggregateAccountActivity, so payroll booked via
// Manager's Payslip feature — not manual journal entries — still flows
// into the income-tax P&L and the Schedule 4/I "Salaries, Wages and
// Allowances" / "SSS, GSIS, Philhealth, HDMF" deduction categories.
async function aggregatePayslipActivity(biz, periodStart, periodEnd, coa, byAccount, totals) {
  const [payslips, itemAccounts] = await Promise.all([
    fetchAllBatch('/api4/payslip-batch', biz),
    loadPayslipItemAccounts(biz),
  ]);

  for (const it of payslips) {
    const v = it.item || it.value || it;
    const dateStr = payslipDate(v);
    if (!inRange(dateStr, periodStart, periodEnd)) continue;

    const lines = [
      ...(v.earningsLines || v.EarningsLines || v.earnings || v.Earnings || []),
      ...(v.contributionLines || v.ContributionLines || v.contributions || v.Contributions || []),
    ];
    for (const line of lines) {
      const guid = itemAccounts[lineItemKey(line)];
      if (!guid) continue;
      const meta = coa[guid];
      if (!meta || !meta.isProfitAndLossAccount) continue;

      const amount = lineAmount(line);
      if (!byAccount[guid]) {
        byAccount[guid] = { key: guid, name: meta.name || '(Unknown account)', bucket: meta.bucket || 'other', amount: 0, untaxedAmount: 0 };
      }
      byAccount[guid].amount += amount;

      if (meta.bucket === 'income') totals.income += amount;
      else if (meta.bucket === 'cogs') totals.cogs += amount;
      else if (meta.bucket === 'opex') totals.opex += amount;
    }
  }
}

// ── TRANSACTION AGGREGATOR ───────────────────────────────────
// Sums net activity per account GUID across all transaction
// batches for the given date range, restricted to P&L accounts
// (per the COA cache). Returns:
//   { byAccount: { [guid]: { amount, name, bucket, untaxedAmount } },
//     totals: { income, cogs, opex } }
async function aggregateAccountActivity(biz, periodStart, periodEnd, coa) {
  const batches = [
    'journal-entry-batch',
    'sales-invoice-batch',
    'purchase-invoice-batch',
    'receipt-batch',
    'payment-batch',
  ];

  const rateByKey = await loadTaxCodeRates(biz);
  const byAccount = {};
  const totals = { income: 0, cogs: 0, opex: 0 };

  function ensure(guid) {
    if (!byAccount[guid]) {
      const meta = coa[guid] || {};
      byAccount[guid] = { key: guid, name: meta.name || '(Unknown account)', bucket: meta.bucket || 'other', amount: 0, untaxedAmount: 0 };
    }
    return byAccount[guid];
  }

  function applyLine(line, item, dateStr) {
    if (!inRange(dateStr, periodStart, periodEnd)) return;
    const guid = line.account || line.Account;
    if (!guid) return;
    const meta = coa[guid];
    if (!meta || !meta.isProfitAndLossAccount) return;

    const amount = pnlLineAmount(item, line, rateByKey, meta.bucket);

    const row = ensure(guid);
    row.amount += amount;
    if (!pnlLineTaxCodeKey(line)) row.untaxedAmount += amount;

    if (meta.bucket === 'income') totals.income += amount;
    else if (meta.bucket === 'cogs') totals.cogs += amount;
    else if (meta.bucket === 'opex') totals.opex += amount;
  }

  for (const batchPath of batches) {
    const items = await fetchAllBatch(`/api4/${batchPath}`, biz);
    for (const it of items) {
      const v = it.item || it.value || it;
      const date = v.date || v.issueDate || v.invoiceDate || v.receiptDate || v.paymentDate;
      const lines = v.Lines || v.lines || v.invoiceLines || v.receiptLines || v.paymentLines || v.journalEntryLines || [];
      for (const line of lines) applyLine(line, v, date);
    }
  }

  await aggregatePayslipActivity(biz, periodStart, periodEnd, coa, byAccount, totals);

  return { byAccount, totals };
}

// ── PROFIT AND LOSS STATEMENT (Income Tax "P&L" tab) ─────────
// Renders a straight COA-grouped P&L (Income / Cost of Sales /
// Operating Expenses, each itemized by account) independent of any
// BIR schedule mapping — this is the "books" P&L, not the return.
function renderPnLStatementHtml(totals, byAccount) {
  const rows = Object.values(byAccount || {}).filter(r => Math.abs(r.amount) >= 0.005);
  const byBucket = bucket => rows.filter(r => r.bucket === bucket).sort((a, b) => a.name.localeCompare(b.name));
  const income = byBucket('income');
  const cogs = byBucket('cogs');
  const opex = byBucket('opex');

  const acctLine = r => `<div class="return-line"><div class="return-line-label">${escHtml(r.name)}</div><div class="return-line-amt">₱ ${fmt(r.amount)}</div></div>`;
  const emptyLine = `<div class="return-line"><div class="return-line-label" style="color:var(--text-muted);">No activity</div></div>`;
  const totalLine = (label, amount, cls = '') => `<div class="return-line"><div class="return-line-label" style="font-weight:700;">${label}</div><div class="return-line-amt ${cls}" style="font-weight:700;">₱ ${fmt(amount)}</div></div>`;

  const grossProfit = totals.income - totals.cogs;
  const netIncome = grossProfit - totals.opex;

  return `
    <div class="return-section">
      <div class="return-section-header">Income</div>
      ${income.map(acctLine).join('') || emptyLine}
      ${totalLine('Total Income', totals.income)}
    </div>
    <div class="return-section">
      <div class="return-section-header">Cost of Sales</div>
      ${cogs.map(acctLine).join('') || emptyLine}
      ${totalLine('Total Cost of Sales', totals.cogs)}
    </div>
    <div class="return-section">
      ${totalLine('Gross Profit', grossProfit, 'highlight')}
    </div>
    <div class="return-section">
      <div class="return-section-header">Operating Expenses</div>
      ${opex.map(acctLine).join('') || emptyLine}
      ${totalLine('Total Operating Expenses', totals.opex)}
    </div>
    <div class="return-section">
      ${totalLine('Net Income', netIncome, 'highlight')}
    </div>`;
}

// ── ACCOUNT LEDGER (PREPAID/DEFERRED TAX ASSET ACCOUNTS) ─────
// Shared by getPrepaidTaxAssetBalance() and getAgedCarryforwardBalance()
// below. Walks every transaction batch once and returns every line posted
// to the named account as a signed (debit-normal) amount + its date,
// sorted chronologically — the raw ledger, before either caller decides
// how to fold it into a single number.
async function collectAccountLedgerEntries(biz, coa, accountNameSubstr) {
  const account = findAccountByName(coa, accountNameSubstr);
  if (!account) return { account: null, entries: [] };

  const rateByKey = await loadTaxCodeRates(biz);
  const batches = [
    'journal-entry-batch',
    'sales-invoice-batch',
    'purchase-invoice-batch',
    'receipt-batch',
    'payment-batch',
  ];

  const entries = [];
  for (const batchPath of batches) {
    const items = await fetchAllBatch(`/api4/${batchPath}`, biz);
    for (const it of items) {
      const v = it.item || it.value || it;
      const date = v.date || v.issueDate || v.invoiceDate || v.receiptDate || v.paymentDate;
      if (!date) continue;
      const lines = v.Lines || v.lines || v.invoiceLines || v.receiptLines || v.paymentLines || v.journalEntryLines || [];
      for (const line of lines) {
        const guid = line.account || line.Account;
        if (guid !== account.key) continue;
        const hasCredit = line.credit !== undefined || line.Credit !== undefined;
        const hasDebit  = line.debit  !== undefined || line.Debit  !== undefined;
        const amount = (hasCredit || hasDebit)
          ? Number(line.debit ?? line.Debit ?? 0) - Number(line.credit ?? line.Credit ?? 0)
          : lineAmounts(v, line, rateByKey).net;
        entries.push({ date: new Date(date), amount });
      }
    }
  }
  entries.sort((a, b) => a.date - b.date);
  return { account, entries };
}

// ── PREPAID TAX ASSET (CREDITABLE WITHHOLDING TAX) BALANCE ───
// Looks up the running balance of "Prepaid Tax Asset-2306"
// (individual) or "Prepaid Tax Asset-2307" (corporate) as of a
// given cutoff date, by summing debit-credit (or, for invoice/
// receipt/payment lines that only carry qty+unitPrice, the computed
// net amount) on that account from all transactions up to (and
// including) the cutoff. Also used for the simple (non-expiring)
// carryforward accounts, e.g. "Deferred Tax Asset - Prior Year Excess
// Credit", which have no statutory expiry so a running balance is
// all they need.
async function getPrepaidTaxAssetBalance(biz, coa, cutoffDate, accountNameSubstr) {
  const { entries } = await collectAccountLedgerEntries(biz, coa, accountNameSubstr);
  return entries
    .filter(e => e.date <= cutoffDate)
    .reduce((sum, e) => sum + e.amount, 0);
}

// ── AGED CARRYFORWARD BALANCE (MCIT CARRYFORWARD, NIRC SEC. 27(E)(2)) ──
// Excess MCIT paid in a given taxable year may only be credited against
// REGULAR income tax due in the 3 taxable years immediately following —
// after that it expires. A plain running balance can't answer "how much
// of this is still usable," so this splits the ledger into dated FIFO
// lots: each debit entry opens a lot dated by the calendar year it was
// posted in (the app's usual convention of reading the fact from the
// transaction date rather than a separate field); each credit entry
// (usage/write-off) consumes the oldest open lot(s) first. As of
// cutoffDate, a lot is expired once more than `expiryYears` taxable
// years have passed since its origin year.
async function getAgedCarryforwardBalance(biz, coa, cutoffDate, accountNameSubstr, expiryYears = 3) {
  const { entries } = await collectAccountLedgerEntries(biz, coa, accountNameSubstr);
  const cutoffYear = cutoffDate.getFullYear();

  const lots = []; // [{ year, remaining }], oldest first (entries are date-sorted)
  for (const entry of entries) {
    if (entry.date > cutoffDate) continue;
    if (entry.amount >= 0) {
      const year = entry.date.getFullYear();
      const openLot = lots.find(l => l.year === year);
      if (openLot) openLot.remaining += entry.amount;
      else lots.push({ year, remaining: entry.amount });
    } else {
      let toConsume = -entry.amount;
      for (const lot of lots) {
        if (toConsume <= 0) break;
        const used = Math.min(lot.remaining, toConsume);
        lot.remaining -= used;
        toConsume -= used;
      }
    }
  }

  let usable = 0, expiringSoon = 0, expired = 0;
  const breakdown = [];
  for (const lot of lots) {
    if (lot.remaining <= 0.005) continue;
    const age = cutoffYear - lot.year;
    const isExpired = age > expiryYears;
    if (isExpired) expired += lot.remaining;
    else {
      usable += lot.remaining;
      if (age === expiryYears) expiringSoon += lot.remaining;
    }
    breakdown.push({ year: lot.year, amount: lot.remaining, age, expired: isExpired });
  }

  return { usable, expiringSoon, expired, breakdown };
}
