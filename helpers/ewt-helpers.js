/* ============================================================
   Tallo CPA – BIR Tax App
   ewt-helpers.js  –  Shared ATC master table + EWT line extraction
                       Used by 2307-report.js and qap-report.js
   ============================================================ */

// ── ATC MASTER — single source of truth for creditable Expanded ──
// Withholding Tax (EWT) codes, per the BIR ATC list (RR 11-2018 as amended,
// incl. later additions: e-marketplace/digital WI/WC820-830, joint ventures
// WI/WC770-790, Top-WA motor vehicles/medicine/fuels WI/WC840-860, raw sugar
// WI/WC720, REIT WC690). This is the ONLY EWT ATC table — every EWT form
// (0619E, 1601EQ, 2307, QAP) resolves through here, and tax-codes.js derives
// EWT_ATC_LIST from it (see EWT_ATC_LIST there), so nothing can diverge.
// `payee` is the BIR "Allowed Payee Type". Royalties (final tax, 20%) and the
// Sec.109BB govt percentage tax live in tax-codes.js FWT_ATC_LIST / PT_ATC_LIST
// — they are NOT creditable EWT and must not appear on 2307/1601EQ.
const ATC_MASTER = {
  // ── Individual (WI) ──
  'WI010': { desc: 'Professional fees, <=3M',              rate: 5,   payee: 'Individual' },
  'WI011': { desc: 'Professional fees, >3M/VAT',           rate: 10,  payee: 'Individual' },
  'WI020': { desc: 'Prof. entertainers, <=3M',            rate: 5,   payee: 'Individual' },
  'WI021': { desc: 'Prof. entertainers, >3M/VAT',         rate: 10,  payee: 'Individual' },
  'WI030': { desc: 'Prof. athletes, <=3M',                rate: 5,   payee: 'Individual' },
  'WI031': { desc: 'Prof. athletes, >3M/VAT',             rate: 10,  payee: 'Individual' },
  'WI040': { desc: 'Directors/producers, <=3M',           rate: 5,   payee: 'Individual' },
  'WI041': { desc: 'Directors/producers, >3M/VAT',        rate: 10,  payee: 'Individual' },
  'WI050': { desc: 'Mgt/tech consultants, <=3M',          rate: 5,   payee: 'Individual' },
  'WI051': { desc: 'Mgt/tech consultants, >3M/VAT',       rate: 10,  payee: 'Individual' },
  'WI060': { desc: 'Bookkeeping agents, <=3M',            rate: 5,   payee: 'Individual' },
  'WI061': { desc: 'Bookkeeping agents, >3M/VAT',         rate: 10,  payee: 'Individual' },
  'WI070': { desc: 'Insurance agents, <=3M',             rate: 5,   payee: 'Individual' },
  'WI071': { desc: 'Insurance agents, >3M/VAT',          rate: 10,  payee: 'Individual' },
  'WI080': { desc: 'Talent fees - other, <=3M',          rate: 5,   payee: 'Individual' },
  'WI081': { desc: 'Talent fees - other, >3M/VAT',       rate: 10,  payee: 'Individual' },
  'WI090': { desc: 'Non-employee directors, <=3M',        rate: 5,   payee: 'Individual' },
  'WI091': { desc: 'Non-employee directors, >3M/VAT',     rate: 10,  payee: 'Individual' },
  'WI100': { desc: 'Rentals - property/personal',         rate: 5,   payee: 'Individual' },
  'WI110': { desc: 'Cinematographic film rentals',        rate: 5,   payee: 'Individual' },
  'WI120': { desc: 'Contractors',                         rate: 2,   payee: 'Individual' },
  'WI130': { desc: 'Estate/trust distributions',          rate: 15,  payee: 'Individual' },
  'WI139': { desc: 'Brokers/RESPs, <=3M',                rate: 5,   payee: 'Individual' },
  'WI140': { desc: 'Brokers/RESPs, >3M/VAT',             rate: 10,  payee: 'Individual' },
  'WI150': { desc: 'Medical practitioners, >3M/VAT',      rate: 10,  payee: 'Individual' },
  'WI151': { desc: 'Medical practitioners, <=3M',        rate: 5,   payee: 'Individual' },
  'WI152': { desc: 'GPP partners, <=720K',               rate: 10,  payee: 'Individual' },
  'WI153': { desc: 'GPP partners, >720K',                rate: 15,  payee: 'Individual' },
  'WI156': { desc: 'Credit card company payments',        rate: 0.5, payee: 'Individual' },
  'WI157': { desc: 'Govt/GOCC supplier - services',       rate: 2,   payee: 'Individual' },
  'WI158': { desc: 'Top WA supplier - goods',             rate: 1,   payee: 'Individual' },
  'WI159': { desc: 'Govt personnel overtime',             rate: 15,  payee: 'Individual' },
  'WI160': { desc: 'Top WA supplier - services',          rate: 2,   payee: 'Individual' },
  'WI515': { desc: 'Sales reps/MLM, <=3M',               rate: 5,   payee: 'Individual' },
  'WI516': { desc: 'Sales reps/MLM, >3M/VAT',            rate: 10,  payee: 'Individual' },
  'WI530': { desc: 'Embalmers by funeral parlors',        rate: 1,   payee: 'Individual' },
  'WI535': { desc: 'Pre-need co. to funeral parlors',     rate: 1,   payee: 'Individual' },
  'WI540': { desc: 'Tolling fees - refineries',           rate: 5,   payee: 'Individual' },
  'WI610': { desc: 'Agri products supplier, >300K',       rate: 1,   payee: 'Individual' },
  'WI630': { desc: 'Minerals/quarry (non-BSP)',           rate: 5,   payee: 'Individual' },
  'WI632': { desc: 'Minerals/quarry (BSP)',               rate: 1,   payee: 'Individual' },
  'WI640': { desc: 'Govt/GOCC supplier - goods',          rate: 1,   payee: 'Individual' },
  'WI650': { desc: 'MERALCO refund - active',             rate: 15,  payee: 'Individual' },
  'WI651': { desc: 'MERALCO refund - terminated',         rate: 15,  payee: 'Individual' },
  'WI660': { desc: 'Meter deposit int. - MERALCO res.',   rate: 10,  payee: 'Individual' },
  'WI661': { desc: 'Meter deposit int. - MERALCO non-res.', rate: 10, payee: 'Individual' },
  'WI662': { desc: 'Meter deposit int. - other DU res.',  rate: 10,  payee: 'Individual' },
  'WI663': { desc: 'Meter deposit int. - other DU non-res.', rate: 15, payee: 'Individual' },
  'WI680': { desc: 'Political/campaign payments',         rate: 5,   payee: 'Individual' },
  'WI710': { desc: 'Interest - other debt instruments',   rate: 15,  payee: 'Individual' },
  'WI720': { desc: 'Locally produced raw sugar',          rate: 1,   payee: 'Individual' },
  'WI770': { desc: 'Joint venture supplier - goods',      rate: 1,   payee: 'Individual' },
  'WI780': { desc: 'Joint venture supplier - services',   rate: 2,   payee: 'Individual' },
  'WI820': { desc: 'E-marketplace remittances',           rate: 0.5, payee: 'Individual' },
  'WI830': { desc: 'Digital financial svc remittances',   rate: 0.5, payee: 'Individual' },
  'WI840': { desc: 'Top WA - motor vehicles',             rate: 0.5, payee: 'Individual' },
  'WI850': { desc: 'Top WA - medicine/pharma',            rate: 0.5, payee: 'Individual' },
  'WI860': { desc: 'Top WA - fuels',                      rate: 0.5, payee: 'Individual' },
  // ── Non-Individual (WC) ──
  'WC010': { desc: 'Professional fees, <=720K',           rate: 10,  payee: 'Non-Individual' },
  'WC011': { desc: 'Professional fees, >720K',            rate: 15,  payee: 'Non-Individual' },
  'WC020': { desc: 'Prof. entertainers, <=720K',          rate: 10,  payee: 'Non-Individual' },
  'WC021': { desc: 'Prof. entertainers, >720K',           rate: 15,  payee: 'Non-Individual' },
  'WC030': { desc: 'Prof. athletes, <=720K',              rate: 10,  payee: 'Non-Individual' },
  'WC031': { desc: 'Prof. athletes, >720K',               rate: 15,  payee: 'Non-Individual' },
  'WC040': { desc: 'Directors/producers, <=720K',         rate: 10,  payee: 'Non-Individual' },
  'WC041': { desc: 'Directors/producers, >720K',          rate: 15,  payee: 'Non-Individual' },
  'WC050': { desc: 'Mgt/tech consultants, <=720K',        rate: 10,  payee: 'Non-Individual' },
  'WC051': { desc: 'Mgt/tech consultants, >720K',         rate: 15,  payee: 'Non-Individual' },
  'WC060': { desc: 'Bookkeeping agents, <=720K',          rate: 10,  payee: 'Non-Individual' },
  'WC061': { desc: 'Bookkeeping agents, >720K',           rate: 15,  payee: 'Non-Individual' },
  'WC070': { desc: 'Insurance agents, <=720K',            rate: 10,  payee: 'Non-Individual' },
  'WC071': { desc: 'Insurance agents, >720K',             rate: 15,  payee: 'Non-Individual' },
  'WC080': { desc: 'Talent fees - other, <=720K',         rate: 10,  payee: 'Non-Individual' },
  'WC081': { desc: 'Talent fees - other, >720K',          rate: 15,  payee: 'Non-Individual' },
  'WC100': { desc: 'Rentals - property/personal',         rate: 5,   payee: 'Non-Individual' },
  'WC110': { desc: 'Cinematographic film rentals',        rate: 5,   payee: 'Non-Individual' },
  'WC120': { desc: 'Contractors',                         rate: 2,   payee: 'Non-Individual' },
  'WC139': { desc: 'Brokers/RESPs, <=720K',               rate: 10,  payee: 'Non-Individual' },
  'WC140': { desc: 'Brokers/RESPs, >720K',                rate: 15,  payee: 'Non-Individual' },
  'WC150': { desc: 'Medical practitioners, >720K',        rate: 15,  payee: 'Non-Individual' },
  'WC151': { desc: 'Medical practitioners, <=720K',       rate: 10,  payee: 'Non-Individual' },
  'WC156': { desc: 'Credit card company payments',        rate: 0.5, payee: 'Non-Individual' },
  'WC157': { desc: 'Govt/GOCC supplier - services',       rate: 2,   payee: 'Non-Individual' },
  'WC158': { desc: 'Top WA supplier - goods',             rate: 1,   payee: 'Non-Individual' },
  'WC160': { desc: 'Top WA supplier - services',          rate: 2,   payee: 'Non-Individual' },
  'WC515': { desc: 'Sales reps/MLM, <=720K',              rate: 10,  payee: 'Non-Individual' },
  'WC516': { desc: 'Sales reps/MLM, >720K',               rate: 15,  payee: 'Non-Individual' },
  'WC535': { desc: 'Pre-need co. to funeral parlors',     rate: 1,   payee: 'Non-Individual' },
  'WC540': { desc: 'Tolling fees - refineries',           rate: 5,   payee: 'Non-Individual' },
  'WC610': { desc: 'Agri products supplier, >300K',       rate: 1,   payee: 'Non-Individual' },
  'WC630': { desc: 'Minerals/quarry (non-BSP)',           rate: 5,   payee: 'Non-Individual' },
  'WC632': { desc: 'Minerals/quarry (BSP)',               rate: 1,   payee: 'Non-Individual' },
  'WC640': { desc: 'Govt/GOCC supplier - goods',          rate: 1,   payee: 'Non-Individual' },
  'WC650': { desc: 'MERALCO refund - active',             rate: 15,  payee: 'Non-Individual' },
  'WC651': { desc: 'MERALCO refund - terminated',         rate: 15,  payee: 'Non-Individual' },
  'WC660': { desc: 'Meter deposit int. - MERALCO res.',   rate: 10,  payee: 'Non-Individual' },
  'WC661': { desc: 'Meter deposit int. - MERALCO non-res.', rate: 10, payee: 'Non-Individual' },
  'WC662': { desc: 'Meter deposit int. - other DU res.',  rate: 10,  payee: 'Non-Individual' },
  'WC663': { desc: 'Meter deposit int. - other DU non-res.', rate: 15, payee: 'Non-Individual' },
  'WC680': { desc: 'Political/campaign payments',         rate: 5,   payee: 'Non-Individual' },
  'WC690': { desc: 'REIT income payments',                rate: 1,   payee: 'Non-Individual' },
  'WC710': { desc: 'Interest - other debt instruments',   rate: 15,  payee: 'Non-Individual' },
  'WC720': { desc: 'Locally produced raw sugar',          rate: 1,   payee: 'Non-Individual' },
  'WC770': { desc: 'Joint venture supplier - goods',      rate: 1,   payee: 'Non-Individual' },
  'WC780': { desc: 'Joint venture supplier - services',   rate: 2,   payee: 'Non-Individual' },
  'WC790': { desc: 'JV/consortium net income share',      rate: 15,  payee: 'Non-Individual' },
  'WC820': { desc: 'E-marketplace remittances',           rate: 0.5, payee: 'Non-Individual' },
  'WC830': { desc: 'Digital financial svc remittances',   rate: 0.5, payee: 'Non-Individual' },
  'WC840': { desc: 'Top WA - motor vehicles',             rate: 0.5, payee: 'Non-Individual' },
  'WC850': { desc: 'Top WA - medicine/pharma',            rate: 0.5, payee: 'Non-Individual' },
  'WC860': { desc: 'Top WA - fuels',                      rate: 0.5, payee: 'Non-Individual' },
};

// User-defined tax code → ATC mapping (loaded from localStorage, per browser)
function loadAtcMapping() {
  try { return JSON.parse(localStorage.getItem('tc_atc_map') || '{}'); } catch(e) { return {}; }
}

function saveAtcMapping(map) {
  localStorage.setItem('tc_atc_map', JSON.stringify(map || {}));
}

// Resolve a Manager.io tax code name to ATC info: { atc, desc, rate }
function resolveAtc(taxCodeName, customAtcMap) {
  if (!taxCodeName) return null;
  const upper = String(taxCodeName).toUpperCase().trim();
  customAtcMap = customAtcMap || {};
  if (ATC_MASTER[upper]) return { atc: upper, ...ATC_MASTER[upper] };
  if (customAtcMap[upper]) return customAtcMap[upper];
  for (const atc of Object.keys(ATC_MASTER)) {
    if (upper.includes(atc)) return { atc, ...ATC_MASTER[atc] };
  }
  // Try matching by ATC code embedded within custom-mapped names too
  for (const [name, info] of Object.entries(customAtcMap)) {
    if (upper.includes(name)) return info;
  }
  return null;
}

// Extract EWT lines from a purchase invoice / payment item.
// `tcNameByKey` maps Manager tax-code GUID keys -> tax code names
// (api4 batch endpoints return line.taxCode as a bare GUID string,
// not an object, so the name must be looked up separately).
// Returns array of { atc, desc, rate, base, ewt }
// `rateByKey` maps Manager tax-code GUID keys -> the tax code's Rate field.
// Manager has no native "withholding tax" line type, so EWT is recorded as
// a regular line using a 0% pass-through tax code, where the line amount
// IS the tax withheld (not the tax base). When the Manager tax code's rate
// is 0, we treat the line amount as the EWT amount itself and gross it up
// using the real ATC rate to recover the tax base.
function extractEWT(item, customAtcMap, tcNameByKey, rateByKey, ewtMap) {
  const lines = item?.lines || item?.Lines || item?.purchaseInvoiceLines || [];
  const result = {};
  tcNameByKey = tcNameByKey || {};
  rateByKey = rateByKey || {};
  ewtMap = ewtMap || {};

  lines.forEach(line => {
    const tcRaw  = line?.taxCode ?? line?.TaxCode ?? '';
    let tcName;
    if (tcRaw && typeof tcRaw === 'object') {
      tcName = tcRaw.name || tcRaw.Name || '';
    } else {
      tcName = line?.taxCodeName || line?.TaxCodeName || tcNameByKey[tcRaw] || tcRaw || '';
    }
    // Prefer the explicit ATC mapping (Setup > Tax Codes), keyed by the
    // Manager tax code's GUID; fall back to name-based matching.
    const atcInfo = (tcRaw && ewtMap[tcRaw]) || resolveAtc(tcName, customAtcMap);
    if (!atcInfo) return;

    const qty       = Number(line?.qty ?? line?.Qty ?? line?.quantity ?? 1);
    const unitPrice = Number(line?.salesUnitPrice ?? line?.purchaseUnitPrice ?? line?.unitPrice ?? line?.UnitPrice ?? line?.amount ?? 0);
    let lineTotal   = Number(line?.total ?? line?.Total ?? (unitPrice * qty));
    if (line?.discountPercentage) lineTotal *= (1 - Number(line.discountPercentage) / 100);
    lineTotal -= Number(line?.discountAmount || 0);

    const amount = Math.abs(lineTotal);
    const mgrRate = Number(rateByKey[tcRaw] ?? 0);

    let rate, taxBase, taxAmt;
    if (mgrRate > 0 && mgrRate < 100) {
      rate = mgrRate;
      taxBase = amount;
      taxAmt = Number(line?.taxAmount ?? line?.TaxAmount ?? (taxBase * rate / 100));
    } else {
      // mgrRate is 0 (legacy pass-through) or 100 (standard pass-through
      // workaround): the line amount IS the EWT amount, so gross it up.
      rate = Number(ATC_MASTER[atcInfo.atc]?.rate ?? atcInfo.rate ?? 0);
      taxAmt = amount;
      taxBase = rate > 0 ? amount / (rate / 100) : amount;
    }

    const atc = atcInfo.atc;
    if (!result[atc]) {
      result[atc] = { atc, desc: atcInfo.desc, rate, base: 0, ewt: 0 };
    }
    result[atc].base += taxBase;
    result[atc].ewt  += Math.abs(taxAmt);
  });

  return Object.values(result);
}

// month-in-quarter index (0,1,2) from a date string/Date
function monthInQuarter(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  return d.getMonth() % 3;
}
