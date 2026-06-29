/* ============================================================
   Tallo CPA – BIR Tax App
   ewt-helpers.js  –  Shared ATC master table + EWT line extraction
                       Used by 2307-report.js and qap-report.js
   ============================================================ */

// ── ATC MASTER (BIR standard Expanded Withholding Tax codes) ──
// Kept in sync with EWT_ATC_LIST / TAX_CODE_TEMPLATES in tax-codes.js —
// these are the same ATC codes offered for installation in Setup > Tax Codes.
const ATC_MASTER = {
  // Individual
  'WI010': { desc: 'Professional fees, ≤3M',               rate: 5  },
  'WI011': { desc: 'Professional fees, >3M/VAT',           rate: 10 },
  'WI060': { desc: 'Bookkeeping agents, ≤3M',              rate: 5  },
  'WI061': { desc: 'Bookkeeping agents, >3M/VAT',          rate: 10 },
  'WI100': { desc: 'Rentals - property/personal',          rate: 5  },
  'WI120': { desc: 'Contractors',                          rate: 2  },
  'WI150': { desc: 'Medical practitioners, >3M/VAT',       rate: 10 },
  'WI151': { desc: 'Medical practitioners, ≤3M',           rate: 5  },
  'WI157': { desc: 'Govt/GOCC supplier - services',        rate: 2  },
  'WI158': { desc: 'Top WA supplier - goods',              rate: 1  },
  'WI160': { desc: 'Top WA supplier - services',           rate: 2  },
  'WI630': { desc: 'Minerals/quarry (non-BSP)',            rate: 5  },
  'WI640': { desc: 'Govt/GOCC supplier - goods',           rate: 1  },
  // Non-Individual
  'WC010': { desc: 'Professional fees, ≤720K',             rate: 10 },
  'WC011': { desc: 'Professional fees, >720K',             rate: 15 },
  'WC100': { desc: 'Rentals - property/personal',          rate: 5  },
  'WC120': { desc: 'Contractors',                          rate: 2  },
  'WC157': { desc: 'Govt/GOCC supplier - services',        rate: 2  },
  'WC158': { desc: 'Top WA supplier - goods',              rate: 1  },
  'WC160': { desc: 'Top WA supplier - services',           rate: 2  },
  'WC640': { desc: 'Govt/GOCC supplier - goods',           rate: 1  },
  // Government withholding (final VAT / percentage tax)
  'WV012': { desc: 'Final withholding VAT on goods',       rate: 5  },
  'WV022': { desc: 'Final withholding VAT on services',    rate: 5  },
  'WB080': { desc: 'Sec. 109BB percentage tax (Govt)',      rate: 3  },
  // Final withholding tax
  'WI250': { desc: 'Royalties - citizens, residents, NRAETB',          rate: 20 },
  'WC250': { desc: 'Royalties - domestic & resident foreign corps',    rate: 20 },
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
