// Philippines BIR — Standard tax code templates.
// TAX_CODE_TEMPLATES: all BIR tax codes used by this extension.
//   Name        — exact name used in Manager (must match exactly)
//   Label       — display label / ATC description
//   birRate     — actual BIR rate shown in UI and used to back-calculate tax base
//   managerRate — rate to set when creating in Manager:
//                   100 for EWT/FWT/WB (workaround: line amount = withholding amount)
//                   actual rate for VAT/PT (Manager computes tax natively)
//   group       — one of: 'VAT' | 'PT' | 'EWT' | 'GOVT' | 'FWT'

// VAT/PT rate values below are sourced from Settings → Tax Rates (see
// tax-rates.js) so a new rate entered there is picked up next time a
// business installs these codes. The `Name` stays fixed even if the rate
// changes, since it's the Manager tax code's identity — existing
// installed codes (and past transactions posted against them) are
// matched/found by this exact name, and Manager doesn't retroactively
// change a code's rate. A genuinely new rate calls for a newly named code.
//
// Built lazily (not a top-level const) because it depends on
// tax-rates-data.json, which is fetched asynchronously — callers must
// `await loadTaxRatesData()` first (report/tab init functions already do).
function buildTaxCodeTemplates() {
  return [

  // ── GROUP 1A: VALUE ADDED TAX ─────────────────────────────
  { Name: 'Output VAT 12%',                  Label: 'Standard VATable sales',                          birRate: getVatRate() * 100, managerRate: getVatRate() * 100, group: 'VAT' },
  { Name: 'Input VAT 12% (Capital Goods)',   Label: 'Capital expenditure purchases',                   birRate: getVatRate() * 100, managerRate: getVatRate() * 100, group: 'VAT' },
  { Name: 'Input VAT 12% (Other Goods)',     Label: 'Non-capital goods purchases',                     birRate: getVatRate() * 100, managerRate: getVatRate() * 100, group: 'VAT' },
  { Name: 'Input VAT 12% (Services)',        Label: 'Services purchases',                              birRate: getVatRate() * 100, managerRate: getVatRate() * 100, group: 'VAT' },
  { Name: 'Zero-Rated Sales',                Label: 'Export / PEZA / zero-rated',                      birRate: 0,    managerRate: 0,    group: 'VAT' },
  { Name: 'VAT Exempt Sales',                Label: 'Sales exempt from VAT',                           birRate: 0,    managerRate: 0,    group: 'VAT' },
  { Name: 'Zero-Rated Purchases',            Label: 'Zero-rated purchase inputs',                      birRate: 0,    managerRate: 0,    group: 'VAT' },
  { Name: 'VAT Exempt Purchases',            Label: 'Exempt purchase inputs',                          birRate: 0,    managerRate: 0,    group: 'VAT' },

  // ── GROUP 1B: PERCENTAGE TAX ──────────────────────────────
  { Name: 'PT010 – Percentage Tax 3%',       Label: 'PT010 – Non-VAT registered taxpayers',            birRate: getPercentageTaxRate() * 100,        managerRate: getPercentageTaxRate() * 100,        group: 'PT' },
  { Name: 'PT040 – Common Carrier 3%',       Label: 'PT040 – Domestic carriers & keepers of garages',  birRate: 3.0,  managerRate: 3.0,  group: 'PT' },
  { Name: 'PT101 – Nonbanks Financial 5%',   Label: 'PT101 – Nonbanks financial intermediaries',       birRate: getPercentageTaxNonbankRate() * 100, managerRate: getPercentageTaxNonbankRate() * 100, group: 'PT' },

  // ── GROUP 2: EWT / CWT ON INCOME PAYMENTS ────────────────
  // Manager rate = 100 (line amount = exact withholding amount; birRate used to back-calc tax base)
  // Name uses ATC-first format so ATC appears in all Manager reports, QAP, and 2307.
  { Name: 'WI010 – Prof. fees ≤3M (5%)',          Label: 'Individual – Prof. fees ≤3M',          birRate: 5.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI011 – Prof. fees >3M/VAT (10%)',     Label: 'Individual – Prof. fees >3M/VAT',      birRate: 10.0, managerRate: 100, group: 'EWT' },
  { Name: 'WI060 – Bookkeeping ≤3M (5%)',         Label: 'Individual – Bookkeeping ≤3M',         birRate: 5.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI061 – Bookkeeping >3M/VAT (10%)',    Label: 'Individual – Bookkeeping >3M/VAT',     birRate: 10.0, managerRate: 100, group: 'EWT' },
  { Name: 'WI100 – Rentals (5%)',                  Label: 'Individual – Rentals',                 birRate: 5.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI120 – Contractors (2%)',              Label: 'Individual – Contractors',             birRate: 2.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI150 – Medical >3M/VAT (10%)',         Label: 'Individual – Medical >3M/VAT',         birRate: 10.0, managerRate: 100, group: 'EWT' },
  { Name: 'WI151 – Medical ≤3M (5%)',              Label: 'Individual – Medical ≤3M',             birRate: 5.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI157 – Govt/GOCC services (2%)',       Label: 'Individual – Govt/GOCC services',      birRate: 2.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI158 – Top WA goods (1%)',             Label: 'Individual – Top WA goods',            birRate: 1.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI160 – Top WA services (2%)',          Label: 'Individual – Top WA services',         birRate: 2.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI630 – Minerals/quarry (5%)',          Label: 'Individual – Minerals/quarry',         birRate: 5.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WI640 – Govt/GOCC goods (1%)',          Label: 'Individual – Govt/GOCC goods',         birRate: 1.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WC010 – Prof. fees ≤720K (10%)',        Label: 'Non-Individual – Prof. fees ≤720K',    birRate: 10.0, managerRate: 100, group: 'EWT' },
  { Name: 'WC011 – Prof. fees >720K (15%)',        Label: 'Non-Individual – Prof. fees >720K',    birRate: 15.0, managerRate: 100, group: 'EWT' },
  { Name: 'WC100 – Rentals (5%)',                  Label: 'Non-Individual – Rentals',             birRate: 5.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WC120 – Contractors (2%)',              Label: 'Non-Individual – Contractors',         birRate: 2.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WC157 – Govt/GOCC services (2%)',       Label: 'Non-Individual – Govt/GOCC services',  birRate: 2.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WC158 – Top WA goods (1%)',             Label: 'Non-Individual – Top WA goods',        birRate: 1.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WC160 – Top WA services (2%)',          Label: 'Non-Individual – Top WA services',     birRate: 2.0,  managerRate: 100, group: 'EWT' },
  { Name: 'WC640 – Govt/GOCC goods (1%)',          Label: 'Non-Individual – Govt/GOCC goods',     birRate: 1.0,  managerRate: 100, group: 'EWT' },

  // ── GROUP 3: EWT / CWT GOVERNMENT WITHHELD ───────────────
  { Name: 'WV012 – Govt WHT VAT Goods (5%)',       Label: 'Final withholding VAT on goods',       birRate: 5.0, managerRate: 100, group: 'GOVT' },
  { Name: 'WV022 – Govt WHT VAT Services (5%)',    Label: 'Final withholding VAT on services',    birRate: 5.0, managerRate: 100, group: 'GOVT' },
  { Name: 'WB080 – Govt WHT Percentage Tax (3%)',  Label: 'Sec. 109BB percentage tax',            birRate: 3.0, managerRate: 100, group: 'GOVT' },

  // ── GROUP 4: FINAL WITHHOLDING TAX ───────────────────────
  { Name: 'WI250 – Royalties Individual (20%)',    Label: 'FWT – Citizens, residents, NRAETB',         birRate: 20.0, managerRate: 100, group: 'FWT' },
  { Name: 'WC250 – Royalties Corporation (20%)',   Label: 'FWT – Domestic & resident foreign corps',   birRate: 20.0, managerRate: 100, group: 'FWT' },
  ];
}

// ── EWT / CWT ATC LIST ───────────────────────────────────────
// Used in the EWT/CWT mapping section of the Tax codes tab.
// Same codes appear on both purchases (EWT applied) and sales (CWT received).
//
// DERIVED from the canonical ATC_MASTER in ewt-helpers.js (loaded before this
// file on every EWT page) — so the mapping dropdown, 0619E, 1601EQ, 2307 and
// QAP all read the exact same ATC set/rates and can never drift apart. Guarded
// so a page that loads tax-codes.js without ewt-helpers.js just gets [].
const EWT_ATC_LIST = (typeof ATC_MASTER !== 'undefined')
  ? Object.entries(ATC_MASTER).map(([atc, m]) => ({ atc, desc: m.desc, rate: m.rate, type: m.payee }))
  : [];

// ── FWT ATC LIST ─────────────────────────────────────────────
const FWT_ATC_LIST = [
  { atc: 'WI250', desc: 'Royalties – citizens, residents, NRAETB', rate: 20.0, type: 'Individual' },
  { atc: 'WC250', desc: 'Royalties – domestic & resident foreign corps', rate: 20.0, type: 'Non-Individual' },
];

// ── PERCENTAGE TAX ATC LIST ───────────────────────────────────
const PT_ATC_LIST = [
  { atc: 'WB080', desc: 'Persons exempt from VAT – Sec. 109BB (Govt withholding)', rate: 3.0 },
];

// ── VAT CATEGORIES ────────────────────────────────────────────
// Used in the VAT mapping section.
const VAT_CATEGORIES = [
  { key: 'sales_taxable',  label: 'Output VAT 12%',                    side: 'sales',    rate: 12.0 },
  { key: 'sales_zero',     label: 'Zero-Rated Sales',                  side: 'sales',    rate: 0    },
  { key: 'sales_exempt',   label: 'VAT Exempt Sales',                  side: 'sales',    rate: 0    },
  { key: 'purch_capital',  label: 'Input VAT 12% – Capital Goods',     side: 'purchase', rate: 12.0 },
  { key: 'purch_other',    label: 'Input VAT 12% – Other Goods',       side: 'purchase', rate: 12.0 },
  { key: 'purch_services', label: 'Input VAT 12% – Services',          side: 'purchase', rate: 12.0 },
  { key: 'purch_zero',     label: 'Zero-Rated Purchases',              side: 'purchase', rate: 0    },
  { key: 'purch_exempt',   label: 'VAT Exempt Purchases',              side: 'purchase', rate: 0    },
  { key: 'govt_wv012',     label: 'Govt Withholding VAT – Goods (WV012)',    side: 'sales', rate: 5.0 },
  { key: 'govt_wv022',     label: 'Govt Withholding VAT – Services (WV022)', side: 'sales', rate: 5.0 },
];

// ── BIR category → exact Manager tax code Name (from TAX_CODE_TEMPLATES) ──
const VAT_CATEGORY_TC_NAME = {
  sales_taxable:   'Output VAT 12%',
  sales_zero:      'Zero-Rated Sales',
  sales_exempt:    'VAT Exempt Sales',
  purch_capital:   'Input VAT 12% (Capital Goods)',
  purch_other:     'Input VAT 12% (Other Goods)',
  purch_services:  'Input VAT 12% (Services)',
  purch_zero:      'Zero-Rated Purchases',
  purch_exempt:    'VAT Exempt Purchases',
  govt_wv012:      'WV012 – Govt WHT VAT Goods (5%)',
  govt_wv022:      'WV022 – Govt WHT VAT Services (5%)',
};

// Fetch this business's Manager tax codes as [{ key, name, rate }]
async function fetchManagerTaxCodes(biz) {
  const items = await fetchAllBatch('/api4/tax-code-batch', biz);
  return items.map(row => {
    const data = row?.item || row?.value || row || {};
    const name = data.Name || data.name || data.Code || data.code || '';
    const rate = Number(data.rate ?? (Array.isArray(data.rates) ? data.rates[0] : 0)) || 0;
    return { key: row?.key || row?.Key || data.key || '', name: name || `(unnamed: ${row?.key || ''})`, rate };
  });
}

// Build vm (category key -> Manager tax code key) by matching standard names
function autoMatchVatMapping(taxCodes) {
  const nameToKey = {};
  for (const tc of taxCodes) {
    const n = (tc.name || '').toLowerCase().trim();
    if (n) nameToKey[n] = tc.key;
  }
  const vm = {};
  for (const [catKey, tcName] of Object.entries(VAT_CATEGORY_TC_NAME)) {
    const k = nameToKey[tcName.toLowerCase().trim()];
    if (k) vm[catKey] = k;
  }
  return vm;
}

// ── TAX CODE MAPPING OVERRIDES (stored locally per business) ────
function overridesStorageKey(biz) { return `2550q_taxcode_overrides_${biz}`; }

function getMappingOverrides(biz) {
  try { return JSON.parse(localStorage.getItem(overridesStorageKey(biz))) || {}; }
  catch { return {}; }
}

function saveMappingOverrides(biz, overrides) {
  localStorage.setItem(overridesStorageKey(biz), JSON.stringify(overrides));
}

// ── EWT TAX CODE MAPPING (ATC -> Manager tax code) ───────────
// Shared by 1601EQ, 0619E, 2307, QAP. Requires ATC_MASTER from
// ewt-helpers.js to be loaded on the page.
function ewtOverridesStorageKey(biz) { return `ewt_taxcode_overrides_${biz}`; }

function getEwtMappingOverrides(biz) {
  try { return JSON.parse(localStorage.getItem(ewtOverridesStorageKey(biz))) || {}; }
  catch { return {}; }
}

function saveEwtMappingOverrides(biz, overrides) {
  localStorage.setItem(ewtOverridesStorageKey(biz), JSON.stringify(overrides));
}

// Auto-match Manager tax codes to BIR ATC codes by name (exact or
// substring match against ATC_MASTER keys), then apply saved overrides.
// Returns { tcKeyToAtc: { [managerTaxCodeKey]: {atc, desc, rate} }, atcToTcKey, taxCodes }
async function getEwtTcMap(biz) {
  const taxCodes = await fetchManagerTaxCodes(biz);
  const overrides = getEwtMappingOverrides(biz);
  const atcToTcKey = {};

  // Auto-match: tax code name contains an ATC code (e.g. "WC158")
  for (const atc of Object.keys(ATC_MASTER || {})) {
    const found = taxCodes.find(tc => (tc.name || '').toUpperCase().includes(atc));
    if (found) atcToTcKey[atc] = found.key;
  }
  // Apply overrides on top
  for (const [atc, tcKey] of Object.entries(overrides)) {
    if (tcKey) atcToTcKey[atc] = tcKey; else delete atcToTcKey[atc];
  }

  const tcKeyToAtc = {};
  for (const [atc, tcKey] of Object.entries(atcToTcKey)) {
    if (!tcKey) continue;
    const info = ATC_MASTER[atc];
    const tc = taxCodes.find(t => t.key === tcKey);
    // Prefer the real ATC rate from ATC_MASTER: Manager tax codes for EWT
    // are set up as 0%/100% pass-throughs (line amount = tax withheld), so
    // tc.rate is not the rate to use for grossing up the tax base.
    tcKeyToAtc[tcKey] = { atc, desc: info?.desc || atc, rate: Number(info?.rate ?? tc?.rate ?? 0) };
  }
  return { tcKeyToAtc, atcToTcKey, taxCodes };
}

// Final vm = auto-matched mapping with any saved overrides applied on top.
// Also returns rateByKey: Manager tax code key -> rate (%) as configured in Manager.
async function getVatMapping(biz) {
  const taxCodes = await fetchManagerTaxCodes(biz);
  const vm = autoMatchVatMapping(taxCodes);
  const overrides = getMappingOverrides(biz);
  for (const [catKey, tcKey] of Object.entries(overrides)) {
    if (tcKey) vm[catKey] = tcKey; else delete vm[catKey];
  }
  const rateByKey = {};
  for (const tc of taxCodes) rateByKey[tc.key] = tc.rate;
  return { vm, rateByKey };
}

// Compute net (tax-exclusive) amount and tax amount for a transaction line.
// Supports invoice lines (qty x unitPrice) and payment/spend-money lines (amount).
function lineAmounts(item, line, rateByKey) {
  let gross;
  if (line?.amount != null) {
    gross = Number(line.amount);
  } else {
    const qty       = Number(line?.qty ?? 1);
    const unitPrice = Number(line?.salesUnitPrice ?? line?.purchaseUnitPrice ?? line?.unitPrice ?? 0);
    gross = qty * unitPrice;
    if (line?.discountPercentage) gross *= (1 - Number(line.discountPercentage) / 100);
    gross -= Number(line?.discountAmount || 0);
  }

  const tcKey = line?.taxCode || line?.TaxCode || '';
  const rate  = Number(rateByKey?.[tcKey] ?? 0);
  const includesTax = !!item?.amountsIncludeTax;

  let net, tax;
  if (rate) {
    if (includesTax) { net = gross / (1 + rate / 100); tax = gross - net; }
    else             { net = gross; tax = gross * rate / 100; }
  } else {
    net = gross; tax = 0;
  }
  return { net: Math.abs(net), tax: Math.abs(tax), gross: Math.abs(gross) };
}
