/* ============================================================
   Tallo CPA – BIR Tax App
   tax-rates.js – Single source of truth for BIR tax rates/brackets
                  referenced across all report modules (VAT, Percentage
                  Tax, individual graduated income tax, 8% flat rate,
                  OSD, 13th-month cap, corporate income tax, MCIT).

   The data itself lives in tax-rates-data.json, fetched once per page
   load and cached in memory — NOT in localStorage. Every business's
   installed extension fetches that same file from the same deployed
   URL, so a new rate merged into it takes effect for every business
   automatically, the next time each one opens a report. Editing that
   data is done in installer.html's "Txform.ph Super Admin" screen
   (tax-rates-admin.js), which produces the JSON you commit/merge —
   this file has no write access of its own (no backend to write to).

   Every rate is stored as a dated series: [{ effectiveDate, ... }, ...].
   Lookups pick the entry effective on/before the return's period, so a
   return for an earlier year correctly uses the rate that was in force
   then (e.g. TRAIN's original 2018-2022 brackets vs. its 2023+ step-down,
   or the CREATE Act's temporary MCIT/percentage-tax relief).

   IMPORTANT for callers: loadTaxRatesData() must be awaited before any
   getX()/computeX() lookup below is called (report init functions do
   this once, near the top, before rendering anything rate-dependent).
   ============================================================ */

const TAX_RATES_DATA_URL = 'tax-rates-data.json';

let _taxRatesData = null;
let _taxRatesLoadPromise = null;

// Idempotent — safe to call from every report's init function; the
// underlying fetch only happens once per page load. Pass forceFresh to
// bypass the in-memory cache too (used right after a save, so the admin
// screen reflects what was just published instead of what was loaded
// when the page first opened).
//
// cache: 'no-store' + a timestamp query param bypasses both the browser's
// HTTP cache and any intermediate proxy cache — tax-rates-data.json is a
// plain static file, so without this a fetch() can silently return a
// stale copy even though the file on disk has already changed.
function loadTaxRatesData(forceFresh) {
  if (_taxRatesLoadPromise && !forceFresh) return _taxRatesLoadPromise;
  _taxRatesLoadPromise = fetch(`${TAX_RATES_DATA_URL}?t=${Date.now()}`, { cache: 'no-store' })
    .then(res => {
      if (!res.ok) throw new Error(`tax-rates-data.json fetch failed (${res.status})`);
      return res.json();
    })
    .then(data => { _taxRatesData = data; return data; });
  return _taxRatesLoadPromise;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// Reports pick "the rate in force as of the return's period" — for an
// annual/quarterly return keyed by calendar year, that's Dec 31 of that year.
function dateForYear(year) { return `${year}-12-31`; }

// Series for one category, sorted by effective date. Throws clearly if
// called before loadTaxRatesData() has resolved, instead of silently
// computing with missing rates.
function getTaxRateSeries(categoryKey) {
  if (!_taxRatesData) {
    throw new Error('tax-rates.js: loadTaxRatesData() must be awaited before reading rates');
  }
  const series = _taxRatesData[categoryKey] || [];
  return series.slice().sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

// Pick the entry effective on/before `onDate` (defaults to today).
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

function computeGraduatedTax(taxableIncome, onDate) {
  const table = getIncomeTaxTable(onDate);
  if (!table.length) return 0;
  const ti = Math.max(0, Number(taxableIncome) || 0);
  const bracket = table.find(b => ti >= b.from && ti <= b.to) || table[table.length - 1];
  return bracket.fixed + (ti - bracket.from) * bracket.rate;
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
