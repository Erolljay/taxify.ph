/* ============================================================
   Txform.ph — report calculation harness (Phase 0 audit lock)

   These are the pure tax-calculation functions that live in the
   browser report files (tax-rates.js, pnl-helpers.js, ewt-helpers.js,
   the 1701/1701Q generators). They assume a browser global scope, so
   we load them into a shared Node `vm` context — exactly how the
   browser loads the <script> tags in sequence — and exercise the math
   directly. No changes to the source files are needed.

   Purpose: lock the correctness fixes from the 2026-07-14 audit
   (individual OSD, MCIT start year) and the graduated-tax + ATC tables
   so a future edit that breaks a calculation fails HERE, loudly, long
   before it can reach a client's filing.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const RATES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tax-rates-data.json'), 'utf8'));

// Build a browser-like sandbox: concatenate the given source files (in load
// order), run them once in a fresh vm context with minimal browser stubs, then
// inject the tax-rates data and expose the named globals back to the test.
function loadSandbox(files, exposeNames) {
  const preamble = `
    var window = globalThis;
    var self = globalThis;
    var App = {};
    var localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    var document = { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) };
    var fetch = () => Promise.reject(new Error('no network in tests'));
  `;
  const body = files
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
  // `_taxRatesData` is a module-level `let` in tax-rates.js; because the whole
  // concatenation runs as ONE script, this epilogue assignment lands in the
  // same lexical scope and primes the rate lookups without hitting fetch().
  const epilogue = `
    ;try { _taxRatesData = ${JSON.stringify(RATES)}; } catch (e) {}
    globalThis.__CALC__ = {};
    ${exposeNames.map(n => `try { if (typeof ${n} !== 'undefined') globalThis.__CALC__.${n} = ${n}; } catch (e) {}`).join('\n')}
  `;
  const context = vm.createContext({ console, Math, Date, Number, String, Object, Array, JSON, isNaN, parseFloat, parseInt, Infinity });
  vm.runInContext(preamble + '\n' + body + '\n' + epilogue, context, { filename: files.join('+') });
  return context.__CALC__;
}

const core = loadSandbox(
  ['shared/tax-rates.js', 'helpers/pnl-helpers.js', 'helpers/ewt-helpers.js', 'shared/tax-codes.js'],
  ['computeGraduatedTax', 'getOsdRate', 'getMcitRate', 'dateForYear', 'isMcitApplicable', 'ATC_MASTER', 'resolveAtc', 'EWT_ATC_LIST']
);
const ind = loadSandbox(['shared/tax-rates.js', 'reports/1701-report.js'], ['netIncomeFor1701']);
const indQ = loadSandbox(['shared/tax-rates.js', 'reports/1701q-report.js'], ['netIncomeFor']);

// ── GRADUATED INCOME TAX ENGINE ──────────────────────────────
test('graduated tax — 2023 table matches the BIR bracket figures', () => {
  const g = ti => core.computeGraduatedTax(ti, '2023-12-31');
  assert.equal(g(200000), 0);                 // within exempt bracket
  assert.equal(g(250000), 0);                 // exempt ceiling
  assert.equal(g(400000), 22500);             // 15% of 150k over 250k
  assert.equal(g(500000), 42500);             // 22,500 + 20% over 400k
  assert.equal(g(800000), 102500);            // bracket boundary
  assert.equal(g(2000000), 402500);           // bracket boundary
  assert.equal(g(8000000), 2202500);          // top bracket floor
  assert.equal(g(10000000), 2902500);         // 2,202,500 + 35% over 8M
});

test('graduated tax — 2018 (pre-2023) table is used for earlier years', () => {
  // 2018 brackets: 400k–800k taxed 30,000 + 25% of excess over 400k.
  assert.equal(core.computeGraduatedTax(500000, '2020-12-31'), 55000);
});

// ── INDIVIDUAL OSD (RR 16-2008): 40% of GROSS SALES, no separate COGS ──
test('individual OSD (1701) — net income is 60% of gross sales, COGS not deducted', () => {
  const r = ind.netIncomeFor1701({ income: 2000000, cogs: 800000 }, 'osd', 500000, 2023);
  assert.equal(r.netIncome, 1200000);   // 2,000,000 − 40% × 2,000,000  (NOT − COGS again)
  assert.equal(r.cogs, 0);              // COGS shown as 0 on the return under OSD
  assert.equal(r.grossIncome, 2000000);
});

test('individual OSD (1701) — itemized path still deducts COGS + expenses', () => {
  const r = ind.netIncomeFor1701({ income: 2000000, cogs: 800000 }, 'itemized', 500000, 2023);
  assert.equal(r.netIncome, 700000);    // (2,000,000 − 800,000) − 500,000
});

test('individual OSD (1701Q quarterly) — same 60%-of-gross-sales rule', () => {
  const r = indQ.netIncomeFor({ income: 2000000, cogs: 800000 }, 'osd', 500000, 2023);
  assert.equal(r.netIncome, 1200000);
  assert.equal(r.cogs, 0);
});

test('OSD rate is 40%', () => {
  assert.equal(core.getOsdRate('2023-12-31'), 0.4);
});

// ── MCIT START YEAR (RR 9-98): 4th taxable year FOLLOWING commencement ──
test('MCIT applies from incorporation year + 4, not + 3', () => {
  const inc = '2021-06-15';
  assert.equal(core.isMcitApplicable(inc, 2023), false); // year+2 — exempt
  assert.equal(core.isMcitApplicable(inc, 2024), false); // year+3 — exempt (was the bug)
  assert.equal(core.isMcitApplicable(inc, 2025), true);  // year+4 — first subject
  assert.equal(core.isMcitApplicable(inc, 2026), true);
});

test('MCIT — unknown incorporation date defaults to subject (never understate)', () => {
  assert.equal(core.isMcitApplicable('', 2025), true);
  assert.equal(core.isMcitApplicable(null, 2025), true);
});

// ── ATC MASTER — single source of truth, correct rates, no divergence ──
test('ATC_MASTER — spot-check rates against the BIR ATC list', () => {
  const rate = atc => core.ATC_MASTER[atc] && core.ATC_MASTER[atc].rate;
  assert.equal(rate('WI010'), 5);    // professional fees, individual ≤3M
  assert.equal(rate('WI011'), 10);
  assert.equal(rate('WC010'), 10);   // corp ≤720K
  assert.equal(rate('WC011'), 15);
  assert.equal(rate('WI120'), 2);    // contractors
  assert.equal(rate('WI158'), 1);    // top WA goods
  assert.equal(rate('WI160'), 2);    // top WA services
  assert.equal(rate('WI156'), 0.5);  // credit card
  assert.equal(rate('WI820'), 0.5);  // e-marketplace
});

test('ATC — codes that used to diverge between 1601EQ and 2307/QAP are ALL present', () => {
  // Previously missing from the shared table (2307/QAP dropped these):
  for (const atc of ['WI050', 'WI515', 'WI610', 'WC050']) assert.ok(core.ATC_MASTER[atc], `${atc} missing`);
  // Previously missing from the 1601EQ table (1601EQ dropped these):
  for (const atc of ['WI060', 'WI150', 'WI630']) assert.ok(core.ATC_MASTER[atc], `${atc} missing`);
});

test('ATC — resolveAtc resolves by exact code and by name containing the code', () => {
  assert.equal(core.resolveAtc('WI050').rate, 5);
  assert.equal(core.resolveAtc('WI050 – Mgt/tech consultants (5%)').atc, 'WI050');
  assert.equal(core.resolveAtc('not-an-atc'), null);
});

test('ATC — EWT_ATC_LIST is derived from ATC_MASTER (cannot drift)', () => {
  const master = core.ATC_MASTER;
  assert.equal(core.EWT_ATC_LIST.length, Object.keys(master).length);
  for (const row of core.EWT_ATC_LIST) {
    assert.equal(row.rate, master[row.atc].rate, `rate mismatch for ${row.atc}`);
    assert.equal(row.type, master[row.atc].payee, `payee mismatch for ${row.atc}`);
  }
});
