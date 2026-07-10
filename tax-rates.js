/* ============================================================
   Tallo CPA – BIR Tax App
   tax-rates.js – Single source of truth for BIR tax rates/brackets
                  referenced across all report modules (VAT, Percentage
                  Tax, individual graduated income tax, 8% flat rate,
                  OSD, 13th-month cap, corporate income tax, MCIT).

   Every rate is stored as a dated series: [{ effectiveDate, ... }, ...].
   Lookups pick the entry effective on/before the return's period, so a
   return for an earlier year correctly uses the rate that was in force
   then (e.g. TRAIN's original 2018-2022 brackets vs. its 2023+ step-down,
   or the CREATE Act's temporary MCIT/percentage-tax relief).

   Built-in defaults ship with the rates BIR law has actually used.
   Settings → Tax Rates (tax-rates-admin.js) lets a preparer add further
   dated entries — e.g. a brand-new VAT rate — without touching code;
   those overrides are kept in localStorage (shared across businesses on
   this device/browser, same as the EWT ATC mapping in ewt-helpers.js).
   ============================================================ */

const TAX_RATES_STORAGE_KEY = 'txf_tax_rates_v1';

// ── BUILT-IN DEFAULTS (BIR law as of this app's release) ───────
const DEFAULT_VAT_RATES = [
  { effectiveDate: '2006-02-01', rate: 12, label: 'Standard VAT (RA 9337)' },
];

const DEFAULT_PT_RATES = [
  { effectiveDate: '2018-01-01', rate: 3, label: 'Percentage Tax — Non-VAT (NIRC Sec. 116)' },
  { effectiveDate: '2020-07-01', rate: 1, label: 'Percentage Tax — Non-VAT (CREATE Act MSME relief)' },
  { effectiveDate: '2023-07-01', rate: 3, label: 'Percentage Tax — Non-VAT (relief expired)' },
];

const DEFAULT_PT_NONBANK_RATES = [
  { effectiveDate: '2018-01-01', rate: 5, label: 'Percentage Tax — Nonbank Financial Intermediaries' },
];

const DEFAULT_EIGHT_PCT_RATES = [
  { effectiveDate: '2018-01-01', rate: 8, label: '8% Flat Tax (in lieu of graduated rate + percentage tax)' },
];

const DEFAULT_OSD_RATES = [
  { effectiveDate: '2018-01-01', rate: 40, label: 'Optional Standard Deduction' },
];

const DEFAULT_THIRTEENTH_MONTH_CAP = [
  { effectiveDate: '2018-01-01', amount: 90000, label: 'Non-taxable ceiling — 13th month pay & other benefits' },
];

// Individual graduated income tax (annual). `upTo: null` = no ceiling.
const DEFAULT_INCOME_TAX_TABLES = [
  {
    effectiveDate: '2018-01-01',
    label: 'TRAIN Law (RA 10963), 2018–2022',
    brackets: [
      { upTo: 250000,  rate: 0.00 },
      { upTo: 400000,  rate: 0.20 },
      { upTo: 800000,  rate: 0.25 },
      { upTo: 2000000, rate: 0.30 },
      { upTo: 8000000, rate: 0.32 },
      { upTo: null,    rate: 0.35 },
    ],
  },
  {
    effectiveDate: '2023-01-01',
    label: 'TRAIN Law step-down, 2023 onward',
    brackets: [
      { upTo: 250000,  rate: 0.00 },
      { upTo: 400000,  rate: 0.15 },
      { upTo: 800000,  rate: 0.20 },
      { upTo: 2000000, rate: 0.25 },
      { upTo: 8000000, rate: 0.30 },
      { upTo: null,    rate: 0.35 },
    ],
  },
];

const DEFAULT_CORPORATE_RATES = [
  { effectiveDate: '2018-01-01', regular: 30, small: 30, label: 'Pre-CREATE (flat 30%)' },
  { effectiveDate: '2020-07-01', regular: 25, small: 20, label: 'CREATE Act (RA 11534)' },
];

const DEFAULT_MCIT_RATES = [
  { effectiveDate: '2018-01-01', rate: 2, label: 'MCIT standard' },
  { effectiveDate: '2020-07-01', rate: 1, label: 'MCIT — CREATE Act relief' },
  { effectiveDate: '2023-07-01', rate: 2, label: 'MCIT — relief expired' },
];

const TAX_RATE_CATEGORIES = {
  vat:           { label: 'VAT',                       defaults: DEFAULT_VAT_RATES },
  pt:            { label: 'Percentage Tax',             defaults: DEFAULT_PT_RATES },
  ptNonbank:     { label: 'Percentage Tax — Nonbank',   defaults: DEFAULT_PT_NONBANK_RATES },
  eightPct:      { label: '8% Flat Rate',               defaults: DEFAULT_EIGHT_PCT_RATES },
  osd:           { label: 'Optional Standard Deduction', defaults: DEFAULT_OSD_RATES },
  thirteenthCap: { label: '13th-Month Pay Cap',          defaults: DEFAULT_THIRTEENTH_MONTH_CAP },
  incomeTax:     { label: 'Individual Income Tax Table', defaults: DEFAULT_INCOME_TAX_TABLES },
  corporate:     { label: 'Corporate Income Tax',        defaults: DEFAULT_CORPORATE_RATES },
  mcit:          { label: 'MCIT',                        defaults: DEFAULT_MCIT_RATES },
};

// ── STORAGE (overrides only — defaults never get written back) ──
function loadTaxRateOverrides() {
  try { return JSON.parse(localStorage.getItem(TAX_RATES_STORAGE_KEY) || '{}'); } catch (e) { return {}; }
}

function saveTaxRateOverrides(data) {
  localStorage.setItem(TAX_RATES_STORAGE_KEY, JSON.stringify(data || {}));
}

function addTaxRateEntry(categoryKey, entry) {
  const overrides = loadTaxRateOverrides();
  const list = overrides[categoryKey] || [];
  list.push({ ...entry, id: `c${Date.now()}${Math.floor(Math.random() * 1000)}` });
  overrides[categoryKey] = list;
  saveTaxRateOverrides(overrides);
}

function deleteTaxRateEntry(categoryKey, id) {
  const overrides = loadTaxRateOverrides();
  overrides[categoryKey] = (overrides[categoryKey] || []).filter(e => e.id !== id);
  saveTaxRateOverrides(overrides);
}

// Merged, sorted (defaults + custom overrides), each entry tagged with
// its source so the admin UI can tell built-in rows from editable ones.
function getTaxRateSeries(categoryKey) {
  const cat = TAX_RATE_CATEGORIES[categoryKey];
  if (!cat) return [];
  const overrides = loadTaxRateOverrides()[categoryKey] || [];
  const defaults = cat.defaults.map(e => ({ ...e, source: 'default' }));
  const custom = overrides.map(e => ({ ...e, source: 'custom' }));
  return [...defaults, ...custom].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

// Pick the entry effective on/before `onDate` (defaults to today). Among
// entries with the same effectiveDate, a custom override wins over the
// built-in default (stable sort keeps defaults first within a tie, and
// the loop below keeps overwriting `picked` as it walks forward).
function pickEffective(categoryKey, onDate) {
  const series = getTaxRateSeries(categoryKey);
  if (!series.length) return null;
  const d = onDate instanceof Date ? onDate.toISOString().slice(0, 10) : String(onDate || todayStr());
  let picked = series[0];
  for (const entry of series) {
    if (entry.effectiveDate <= d) picked = entry; else break;
  }
  return picked;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// Reports pick "the rate in force as of the return's period" — for an
// annual/quarterly return keyed by calendar year, that's Dec 31 of that year.
function dateForYear(year) { return `${year}-12-31`; }

// ── PUBLIC LOOKUPS (rates returned as decimals, e.g. 0.12 not 12) ──
function getVatRate(onDate) { return (pickEffective('vat', onDate)?.rate || 0) / 100; }
function getPercentageTaxRate(onDate) { return (pickEffective('pt', onDate)?.rate || 0) / 100; }
function getPercentageTaxNonbankRate(onDate) { return (pickEffective('ptNonbank', onDate)?.rate || 0) / 100; }
function getEightPercentRate(onDate) { return (pickEffective('eightPct', onDate)?.rate || 0) / 100; }
function getOsdRate(onDate) { return (pickEffective('osd', onDate)?.rate || 0) / 100; }
function getThirteenthMonthCap(onDate) { return pickEffective('thirteenthCap', onDate)?.amount || 0; }
function getMcitRate(onDate) { return (pickEffective('mcit', onDate)?.rate || 0) / 100; }
function getCorporateRates(onDate) {
  const e = pickEffective('corporate', onDate);
  return { regular: (e?.regular || 0) / 100, small: (e?.small || 0) / 100 };
}

// Converts the admin-facing bracket shape ({upTo, rate}) into the
// {from, to, rate, fixed} shape report code iterates over — `fixed` (the
// tax already accumulated by prior brackets) is derived automatically so
// editing one bracket's rate can't leave a stale fixed-amount downstream.
function getIncomeTaxTable(onDate) {
  const entry = pickEffective('incomeTax', onDate);
  const brackets = entry ? entry.brackets : [];
  let from = 0, fixed = 0;
  return brackets.map(b => {
    const to = (b.upTo === null || b.upTo === undefined || b.upTo === '') ? Infinity : Number(b.upTo);
    const bracket = { from, to, rate: Number(b.rate), fixed };
    fixed += (to === Infinity ? 0 : (to - from)) * Number(b.rate);
    from = to;
    return bracket;
  });
}

// <option> list for the 1702-Q/1702-RT "Regular Rate" selector, sourced
// from whatever corporate rates are currently in force (Settings → Tax
// Rates), instead of two rates baked into the report's HTML.
function corporateRateOptionsHtml(onDate) {
  const { regular, small } = getCorporateRates(onDate);
  return `
    <option value="${regular}">${(regular * 100).toFixed(0)}% (Domestic Corporation, In General)</option>
    <option value="${small}">${(small * 100).toFixed(0)}% (Proprietary/Small Corp — Net Taxable Income ≤P5M &amp; Total Assets ≤P100M excl. land)</option>`;
}

function computeGraduatedTax(taxableIncome, onDate) {
  const table = getIncomeTaxTable(onDate);
  if (!table.length) return 0;
  const ti = Math.max(0, Number(taxableIncome) || 0);
  const bracket = table.find(b => ti >= b.from && ti <= b.to) || table[table.length - 1];
  return bracket.fixed + (ti - bracket.from) * bracket.rate;
}
