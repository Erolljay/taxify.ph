/* ============================================================
   Tallo CPA – BIR Tax App
   shared.js  –  postMessage bridge, storage helpers, utilities
                 Used by ALL pages (Setup + Report extensions)
   ============================================================ */

// ── STATE ────────────────────────────────────────────────────
const App = { businesses: [], currentBusiness: null };

// ── POST-MESSAGE BRIDGE ──────────────────────────────────────
async function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('API request timed out after 30s'));
    }, 30000);
    function handler(event) {
      const d = event.data;
      if (d?.type?.endsWith('-response') && d?.requestId === requestId) {
        window.removeEventListener('message', handler);
        clearTimeout(timeout);
        if (d.error) reject(new Error(d.error));
        else resolve(d.body);
      }
    }
    window.addEventListener('message', handler);
    const msg = { type: 'api-request', method, path, requestId };
    if (body) msg.body = body;
    window.parent.postMessage(msg, '*');
  });
}

// ── FETCH ALL BATCH (50/page) ────────────────────────────────
async function fetchAllBatch(batchPath, businessName, extraParams) {
  const all = [];
  let skip = 0;
  const PAGE = 50;
  while (true) {
    const qs = new URLSearchParams({ business: businessName, Skip: String(skip), PageSize: String(PAGE), ...(extraParams || {}) }).toString();
    const res = await apiRequest('GET', `${batchPath}?${qs}`);
    const items = res?.items || [];
    all.push(...items);
    if (items.length < PAGE) break;
    skip += PAGE;
  }
  return all;
}

// ── BUSINESSES ───────────────────────────────────────────────
async function loadBusinesses(selectId, onchange) {
  try {
    const res = await apiRequest('GET', '/api4/businesses');
    App.businesses = res?.businesses || [];
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = App.businesses.map(b =>
      `<option value="${escHtml(b.name)}">${escHtml(b.name)}</option>`
    ).join('');
    App.currentBusiness = sel.value || App.businesses[0]?.name || '';
    sel.value = App.currentBusiness;
    sel.addEventListener('change', () => {
      App.currentBusiness = sel.value;
      if (onchange) onchange();
    });
    if (onchange && App.currentBusiness) onchange();
  } catch (e) {
    const sel = document.getElementById(selectId);
    if (sel) sel.innerHTML = '<option value="">⚠ Could not load</option>';
    console.error(e);
  }
}

// ── REPORT CONTEXT — for pages opened via Manager Custom Button ──
// ── PAGE CONTEXT — ask Manager which business this tab belongs to ──
function getPageContextBusiness() {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 3000);
    function handler(event) {
      const d = event.data;
      if (d?.type === 'page-response' && d?.requestId === requestId) {
        window.removeEventListener('message', handler);
        clearTimeout(timeout);
        resolve(d?.body?.query?.business || null);
      }
    }
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: 'page-request', requestId }, '*');
  });
}

async function getReportBusiness(containerEl) {
  const ctxBiz = await getPageContextBusiness();
  if (ctxBiz) {
    App.currentBusiness = ctxBiz;
    return ctxBiz;
  }

  const res = await apiRequest('GET', '/api4/businesses');
  const businesses = res?.businesses || [];
  if (!businesses.length) throw new Error('No businesses found in Manager.');
  if (businesses.length === 1) {
    App.currentBusiness = businesses[0].name;
    return businesses[0].name;
  }
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:12px;';
    wrap.innerHTML = `<strong>Business:</strong>
      <select id="report-biz-sel" style="font-size:12px;padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;">
        ${businesses.map(b => `<option value="${escHtml(b.name)}">${escHtml(b.name)}</option>`).join('')}
      </select>
      <button id="report-biz-ok" class="btn btn-primary" style="font-size:11px;padding:4px 12px;">Select</button>`;
    if (containerEl) containerEl.prepend(wrap);
    document.getElementById('report-biz-ok').addEventListener('click', () => {
      const val = document.getElementById('report-biz-sel').value;
      App.currentBusiness = val;
      wrap.remove();
      resolve(val);
    });
  });
}

// ── MANAGER MAPPING GUIDS ────────────────────────────────────
const MAPPING_GUIDS = {
  vatMapping: 'b1r00099-0000-4000-a000-000000000001',
  ewtMapping: 'b1r00099-0000-4000-a000-000000000002',
  fwtMapping: 'b1r00099-0000-4000-a000-000000000003',
  ptMapping:  'b1r00099-0000-4000-a000-000000000004',
};

// ── BIR CUSTOM FIELD DEFINITIONS ─────────────────────────────
const BIR_CF_NAMES = {
  biz:     'BIR Business Data',
  party:   'BIR Party Data',
  emp:     'BIR Employee Data',
  mapping: 'BIR Mapping Data',
};

// Known Manager custom-field placement GUIDs (confirmed via API).
const BIR_PLACEMENTS = {
  biz:   [{ Key: '38cf4712-6e95-4ce1-b53a-bff03edad273', UniqueName: 'Business Details' }],
  party: [
    { Key: 'ec37c11e-2b67-49c6-8a58-6eccb7dd75ee', UniqueName: 'Customer' },
    { Key: '6d2dc48d-2053-4e45-8330-285ebd431242', UniqueName: 'Supplier' },
  ],
  emp:   [{ Key: 'dadb7f95-a5dd-45c0-945d-6ad4ee28776e', UniqueName: 'Employee' }],
  // Payroll mapping blob is stored on the dummy customer record (see
  // BIZ_DATA_RECORD_NAME / getOrCreateBizDataRecord), so it needs a
  // Customer-placed field, same as 'party'.
  mapping: [{ Key: 'ec37c11e-2b67-49c6-8a58-6eccb7dd75ee', UniqueName: 'Customer' }],
};

const _birGuidCache = {};

// Looks up custom field DEFINITION GUIDs by name (needed to read/write record data).
// BIR_PLACEMENTS above are placement GUIDs (UI location) — different from definition GUIDs.
async function ensureBIRFields(biz) {
  if (_birGuidCache[biz]) return _birGuidCache[biz];

  let items = [];
  try {
    items = await fetchAllBatch('/api4/text-custom-field-batch', biz);
  } catch(e) {
    console.warn('ensureBIRFields: batch fetch failed:', e.message);
  }
  const findGuid = name => {
    const it = items.find(i => {
      const it2 = i.item || i.value || i;
      const n = it2.name || it2.Name;
      return n === name;
    });
    return it ? (it.key || it.Key) : null;
  };

  const guids = {
    biz:     findGuid(BIR_CF_NAMES.biz),
    party:   findGuid(BIR_CF_NAMES.party),
    emp:     findGuid(BIR_CF_NAMES.emp),
    mapping: findGuid(BIR_CF_NAMES.mapping),
  };

  // Create any missing definitions
  const defs = [
    { slot: 'biz',     name: BIR_CF_NAMES.biz,     placement: BIR_PLACEMENTS.biz.map(p => p.Key)     },
    { slot: 'party',   name: BIR_CF_NAMES.party,   placement: BIR_PLACEMENTS.party.map(p => p.Key)   },
    { slot: 'emp',     name: BIR_CF_NAMES.emp,     placement: BIR_PLACEMENTS.emp.map(p => p.Key)     },
    { slot: 'mapping', name: BIR_CF_NAMES.mapping, placement: BIR_PLACEMENTS.mapping.map(p => p.Key) },
  ];
  for (const def of defs) {
    if (guids[def.slot]) continue;
    try {
      const created = await apiRequest('POST', '/api4/text-custom-field', {
        business: biz,
        value: { name: def.name, lockedForManualEditing: true, placement: def.placement },
      });
      if (created) {
        guids[def.slot] = typeof created === 'string' ? created : (created.key || null);
      }
      if (!guids[def.slot]) {
        const re = await fetchAllBatch('/api4/text-custom-field-batch', biz);
        const found = re.find(i => {
          const it2 = i.item || i.value || i;
          const n = it2.name || it2.Name;
          return n === def.name;
        });
        if (found) guids[def.slot] = found.key || found.Key;
      }
    } catch(e) {
      console.warn('ensureBIRFields: could not create', def.name, ':', e.message);
    }
  }

  // customer and supplier share the same 'BIR Party Data' definition
  guids.customer = guids.party;
  guids.supplier = guids.party;

  _birGuidCache[biz] = guids;
  return guids;
}

// Parse the BIR JSON blob from a Manager record's customFields2.strings using the real GUID.
// If the canonical guid has no data (e.g. record was saved under an older/orphaned
// definition GUID), fall back to scanning all stored blobs for one whose keys match
// fallbackPrefix (e.g. 'b1r00002-' for party fields).
function parseBIRBlob(managerCF, guid, fallbackPrefix) {
  if (!managerCF) return {};
  if (guid && managerCF[guid]) {
    try {
      const o = JSON.parse(managerCF[guid]);
      if (o && typeof o === 'object') return o;
    } catch {}
  }
  if (fallbackPrefix) {
    for (const k of Object.keys(managerCF)) {
      if (k === guid) continue;
      const v = managerCF[k];
      if (typeof v !== 'string') continue;
      try {
        const o = JSON.parse(v);
        if (o && typeof o === 'object' && Object.keys(o).some(kk => kk.startsWith(fallbackPrefix))) {
          return o;
        }
      } catch {}
    }
  }
  return {};
}

// Build Manager customFields2 object: preserves existing strings, replaces the BIR blob.
// Returns { strings: {...} } to be set as record.customFields2
function buildBIRCustomFields(existingRecord, guid, birData) {
  const existing2 = (existingRecord && existingRecord.customFields2) || {};
  const strings = Object.assign({}, existing2.strings || {});
  if (guid) strings[guid] = JSON.stringify(birData);
  return Object.assign({}, existing2, { strings });
}

// All three mapping kinds below (payroll category, COA->BIR category, account-link
// picker selections) share ONE Manager custom field ('BIR Mapping Data'). Reads scan
// every stored blob and merge by value/key prefix (resilient to data saved under a
// stale GUID). Writes MUST merge with the full current blob first — saveBizDataRecord
// replaces the entire blob at the target GUID, so saving a partial map (e.g. only
// payroll entries) would silently delete the other two kinds' entries.
async function _getFullMappingBlob(biz) {
  const bizRec = await getOrCreateBizDataRecord(biz);
  const strings = (bizRec.value.customFields2 && bizRec.value.customFields2.strings) || {};
  const merged = {};
  for (const raw of Object.values(strings)) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') Object.assign(merged, parsed);
    } catch { /* skip non-JSON or invalid entries */ }
  }
  return merged;
}

// Saves `partialMap` into the shared blob, replacing only entries matching `keepPredicate`
// (i.e. entries previously saved by the same caller) and leaving all other entries intact.
async function _saveIntoMappingBlob(biz, partialMap, keepPredicate) {
  const guids = await ensureBIRFields(biz);
  const targetGuid = guids && guids.mapping;
  if (!targetGuid) throw new Error('BIR Mapping Data custom field not available');
  const full = await _getFullMappingBlob(biz);
  for (const k of Object.keys(full)) {
    if (keepPredicate(k, full[k])) delete full[k];
  }
  Object.assign(full, partialMap);
  return saveBizDataRecord(biz, targetGuid, full);
}

// Read/save payroll category mapping { itemKey -> birCategoryId }, values prefixed 'ph-bir-'.
async function getPayrollMapping(biz) {
  const full = await _getFullMappingBlob(biz);
  const merged = {};
  for (const [k, v] of Object.entries(full)) {
    if (typeof v === 'string' && v.startsWith('ph-bir-')) merged[k] = v;
  }
  return merged;
}

async function savePayrollMapping(biz, mapping) {
  return _saveIntoMappingBlob(biz, mapping, (k, v) => typeof v === 'string' && v.startsWith('ph-bir-'));
}

// Read/save Chart-of-Accounts -> BIR category mapping { accountGuid -> 'acct-bir-<category>' }.
async function getCoaMapping(biz) {
  const full = await _getFullMappingBlob(biz);
  const merged = {};
  for (const [k, v] of Object.entries(full)) {
    if (typeof v === 'string' && v.startsWith('acct-bir-')) merged[k] = v;
  }
  return merged;
}

async function saveCoaMapping(biz, mapping) {
  return _saveIntoMappingBlob(biz, mapping, (k, v) => typeof v === 'string' && v.startsWith('acct-bir-'));
}

// Read/save account-picker assignments for payslip items & VAT tax codes.
// Keys: 'psi:<itemKey>:expense' | 'psi:<itemKey>:liability' | 'tc:<tcName>' -> accountGuid.
async function getAccountLinkMapping(biz) {
  const full = await _getFullMappingBlob(biz);
  const merged = {};
  for (const [k, v] of Object.entries(full)) {
    if (typeof v === 'string' && (k.startsWith('psi:') || k.startsWith('tc:'))) merged[k] = v;
  }
  return merged;
}

async function saveAccountLinkMapping(biz, mapping) {
  return _saveIntoMappingBlob(biz, mapping, (k) => k.startsWith('psi:') || k.startsWith('tc:'));
}

// Load business-details from Manager
async function loadBizDetails(biz) {
  const model = await apiRequest('GET', `/api4/business-details?business=${encodeURIComponent(biz)}`);
  return model || {};
}

// ── BUSINESS-LEVEL BIR DATA STORE ────────────────────────────
// PUT /api4/business-details does not persist customFields2 via this bridge
// (confirmed Manager platform limitation). As a workaround, business-level
// BIR data (TIN, RDO code, address, etc.) is stored on a dedicated, active but hidden
// "dummy" customer record, identified by name.
const BIZ_DATA_RECORD_NAME = '__BIR_BUSINESS_DATA__';

// Find (or create) the dummy customer record used to hold business-level BIR data.
// Returns { key, value }.
async function getOrCreateBizDataRecord(biz) {
  const all = await fetchAllBatch('/api4/customer-batch', biz);
  const found = all.find(it => {
    const v = it.item || {};
    return (v.name || v.Name) === BIZ_DATA_RECORD_NAME;
  });
  if (found) return { key: found.key, value: found.item || {} };

  const created = await apiRequest('POST', '/api4/customer', {
    business: biz,
    value: {
      name: BIZ_DATA_RECORD_NAME,
      inactive: false,
      customFields2: { strings: {} },
    },
  });
  const key = (created && (created.key || created.Key)) || (typeof created === 'string' ? created : null);
  if (!key) throw new Error('Could not create business data record');
  return { key, value: { name: BIZ_DATA_RECORD_NAME, inactive: false, customFields2: { strings: {} } } };
}

// Save the business-level BIR blob into the dummy customer record's customFields2.strings.
async function saveBizDataRecord(biz, guid, birBlob) {
  const { key, value } = await getOrCreateBizDataRecord(biz);
  const managerCF2 = buildBIRCustomFields(value, guid, birBlob);
  const putValue = {
    name:            value.name            !== undefined ? value.name            : BIZ_DATA_RECORD_NAME,
    code:            value.code            !== undefined ? value.code            : null,
    creditLimit:     value.creditLimit     !== undefined ? value.creditLimit     : 0,
    currency:        value.currency        !== undefined ? value.currency        : null,
    billingAddress:  value.billingAddress  !== undefined ? value.billingAddress  : null,
    deliveryAddress: value.deliveryAddress !== undefined ? value.deliveryAddress : null,
    email:           value.email           !== undefined ? value.email           : null,
    division:        value.division        !== undefined ? value.division        : null,
    controlAccount:  value.controlAccount  !== undefined ? value.controlAccount  : null,
    hasDefaultDueDateDays: value.hasDefaultDueDateDays || false,
    defaultDueDateDays:    value.defaultDueDateDays    !== undefined ? value.defaultDueDateDays : null,
    hasDefaultHourlyRate:  value.hasDefaultHourlyRate  || false,
    defaultHourlyRate:     value.defaultHourlyRate     !== undefined ? value.defaultHourlyRate  : 0,
    inactive:              false,
    customFields:          value.customFields          !== undefined ? value.customFields : null,
    customFields2:         managerCF2,
    hasDefaultBillingAddress:  value.hasDefaultBillingAddress  || false,
    defaultBillingAddress:     value.defaultBillingAddress     !== undefined ? value.defaultBillingAddress  : null,
    hasDefaultDeliveryAddress: value.hasDefaultDeliveryAddress || false,
    defaultDeliveryAddress:    value.defaultDeliveryAddress    !== undefined ? value.defaultDeliveryAddress : null,
  };
  await apiRequest('PUT', '/api4/customer', { business: biz, key, value: putValue });
  return managerCF2;
}

// Read a specific mapping from a business-details model
function readMapping(model, type) {
  const guid = MAPPING_GUIDS[type];
  if (!guid) return {};
  const raw = (model.customFields || {})[guid];
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ── BIR FIELD GUIDs ──────────────────────────────────────────
const BIZ_GUIDS = {
  tin:           'b1r00001-0000-4000-a000-000000000001',
  rdoCode:       'b1r00001-0000-4000-a000-000000000002',
  branchCode:    'b1r00001-0000-4000-a000-000000000013',
  classification:'b1r00001-0000-4000-a000-000000000004',
  lineOfBusiness:'b1r00001-0000-4000-a000-000000000005',
  phone:         'b1r00001-0000-4000-a000-000000000015',
  email:         'b1r00001-0000-4000-a000-000000000016',
  companyName:   'b1r00001-0000-4000-a000-000000000009',
  lastName:      'b1r00001-0000-4000-a000-000000000010',
  firstName:     'b1r00001-0000-4000-a000-000000000011',
  middleName:    'b1r00001-0000-4000-a000-000000000012',
  substreet:     'b1r00001-0000-4000-a000-000000000017',
  street:        'b1r00001-0000-4000-a000-000000000018',
  barangay:      'b1r00001-0000-4000-a000-000000000019',
  municipality:  'b1r00001-0000-4000-a000-000000000020',
  cityProvince:  'b1r00001-0000-4000-a000-000000000021',
  zipCode:       'b1r00001-0000-4000-a000-000000000003',
  authRep:       'b1r00001-0000-4000-a000-000000000014',
  authRepTitle:  'b1r00001-0000-4000-a000-000000000022',
  authRepSignature: 'b1r00001-0000-4000-a000-000000000023',
  fiscalMonthEnd:'b1r00001-0000-4000-a000-000000000024',
  tradeName:     'b1r00001-0000-4000-a000-000000000025',
};

const PARTY_GUIDS = {
  type:        'b1r00002-0000-4000-a000-000000000001',
  tin:         'b1r00002-0000-4000-a000-000000000002',
  branchCode:  'b1r00002-0000-4000-a000-000000000003',
  companyName: 'b1r00002-0000-4000-a000-000000000004',
  lastName:    'b1r00002-0000-4000-a000-000000000005',
  firstName:   'b1r00002-0000-4000-a000-000000000006',
  middleName:  'b1r00002-0000-4000-a000-000000000007',
  address1:    'b1r00002-0000-4000-a000-000000000008',
  address2:    'b1r00002-0000-4000-a000-000000000009',
};

// Load business BIR setup from Manager and return a plain object.
async function loadSetup(biz) {
  try {
    const [model, guids, bizRec] = await Promise.all([loadBizDetails(biz), ensureBIRFields(biz), getOrCreateBizDataRecord(biz)]);
    const rawCF = (bizRec.value.customFields2 && bizRec.value.customFields2.strings) || {};
    const cf    = parseBIRBlob(rawCF, guids && guids.biz, 'b1r00001-');
    const cls   = cf[BIZ_GUIDS.classification] || '';
    const isInd = cls === 'Individual';
    const ln    = cf[BIZ_GUIDS.lastName]  || '';
    const fn    = cf[BIZ_GUIDS.firstName] || '';
    const mn    = cf[BIZ_GUIDS.middleName]|| '';
    const corp  = cf[BIZ_GUIDS.companyName] || '';
    const taxpayerName = isInd
      ? [ln, fn, mn].filter(Boolean).join(', ')
      : corp;
    // BIR DAT mapping: Address1 = Substreet+Street+Barangay, Address2 = District/City+Zip (space-joined, no commas)
    const address1 = [cf[BIZ_GUIDS.substreet], cf[BIZ_GUIDS.street], cf[BIZ_GUIDS.barangay]].filter(Boolean).join(' ');
    const address2 = [cf[BIZ_GUIDS.municipality], cf[BIZ_GUIDS.cityProvince], cf[BIZ_GUIDS.zipCode]].filter(Boolean).join(' ');
    const addrParts = [
      cf[BIZ_GUIDS.substreet], cf[BIZ_GUIDS.street], cf[BIZ_GUIDS.barangay],
      cf[BIZ_GUIDS.municipality], cf[BIZ_GUIDS.cityProvince],
    ].filter(Boolean);
    return {
      tin:            cf[BIZ_GUIDS.tin]            || '',
      rdoCode:        cf[BIZ_GUIDS.rdoCode]         || '',
      branchCode:     (cf[BIZ_GUIDS.branchCode] || '').replace(/\D/g, '') || '',
      classification: cls,
      lineOfBusiness: cf[BIZ_GUIDS.lineOfBusiness]  || '',
      companyName:    corp,
      tradeName:      cf[BIZ_GUIDS.tradeName]       || '',
      fiscalMonthEnd: cf[BIZ_GUIDS.fiscalMonthEnd]   || '12',
      taxpayerName,
      lastName: ln, firstName: fn, middleName: mn,
      address:  addrParts.join(', '),
      address1, address2,
      zipCode:  cf[BIZ_GUIDS.zipCode]       || '',
      authRep:  cf[BIZ_GUIDS.authRep]       || '',
      authRepTitle: cf[BIZ_GUIDS.authRepTitle] || '',
      authRepSignature: cf[BIZ_GUIDS.authRepSignature] || '',
      vatMapping: readMapping(model, 'vatMapping'),
      ewtMapping: readMapping(model, 'ewtMapping'),
    };
  } catch(e) {
    console.warn('loadSetup failed:', e.message);
    return null;
  }
}

// Load all customers OR suppliers with their BIR custom fields.
async function loadPartyBIR(biz, partyType) {
  const batchPath = partyType === 'customer'
    ? '/api4/customer-batch'
    : '/api4/supplier-batch';
  try {
    const [all, guids] = await Promise.all([fetchAllBatch(batchPath, biz), ensureBIRFields(biz)]);
    const partyGuid = partyType === 'customer' ? guids.customer : guids.supplier;
    const result = {};
    all.forEach(it => {
      const rec   = it.item || {};
      if ((rec.name || rec.Name) === BIZ_DATA_RECORD_NAME) return;
      const rawCF = (rec.customFields2 && rec.customFields2.strings) || rec.customFields || {};
      const cf    = parseBIRBlob(rawCF, partyGuid, 'b1r00002-');
      result[it.key] = {
        name:        rec.name || rec.Name || it.key,
        type:        cf[PARTY_GUIDS.type]        || 'Non-Individual',
        tin:         cf[PARTY_GUIDS.tin]         || '',
        // BIR's COR shows branch codes as 3 digits (e.g. "000" for Head Office),
        // but DAT files require 4 digits. Pad here so a correctly-entered 3-digit
        // code (per the form's own placeholder) doesn't fail DAT validation.
        branchCode:  (() => {
          const digits = (cf[PARTY_GUIDS.branchCode] || '').replace(/\D/g, '');
          return digits ? digits.padStart(4, '0').slice(-4) : '';
        })(),
        companyName: cf[PARTY_GUIDS.companyName] || '',
        lastName:    cf[PARTY_GUIDS.lastName]    || '',
        firstName:   cf[PARTY_GUIDS.firstName]   || '',
        middleName:  cf[PARTY_GUIDS.middleName]  || '',
        address1:    cf[PARTY_GUIDS.address1]    || '',
        address2:    cf[PARTY_GUIDS.address2]    || '',
      };
    });
    return result;
  } catch(e) {
    console.warn('loadPartyBIR failed:', e.message);
    return {};
  }
}

// ── UTILITIES ────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-PH', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' }); }
  catch { return s; }
}

function monthName(m) {
  return ['January','February','March','April','May','June','July','August','September','October','November','December'][m] || '';
}

function quarterLabel(q) {
  return `Q${q} (${[['Jan','Mar'],['Apr','Jun'],['Jul','Sep'],['Oct','Dec']][q-1].join('–')})`;
}

function getPeriodDates(type, period, year) {
  if (type === 'monthly') {
    const m = parseInt(period, 10);
    return { start: new Date(year, m, 1), end: new Date(year, m + 1, 0) };
  }
  if (type === 'annual') {
    return { start: new Date(year, 0, 1), end: new Date(year, 11, 31) };
  }
  const q = parseInt(period, 10);
  const sm = (q - 1) * 3;
  return { start: new Date(year, sm, 1), end: new Date(year, sm + 3, 0) };
}

function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return d >= start && d <= end;
}

// ── TOAST ────────────────────────────────────────────────────
function showToast(msg, type = 'ok') {
  let t = document.getElementById('__toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__toast';
    t.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:8px;font-size:12px;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.2);transition:opacity .3s;max-width:320px;';
    document.body.appendChild(t);
  }
  t.style.background = type === 'ok' ? '#1a2f5e' : type === 'err' ? '#c0392b' : '#27ae60';
  t.style.color = 'white';
  t.style.opacity = '1';
  t.textContent = msg;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── PERIOD FILTER HTML ────────────────────────────────────────
function periodFilterHTML(mode, idPrefix) {
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear  = now.getFullYear();
  const curQ     = Math.ceil((curMonth + 1) / 3);
  const years    = [curYear - 2, curYear - 1, curYear, curYear + 1];

  const monthSel = `<select id="${idPrefix}-month">
    ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m =>
      `<option value="${m}"${m===curMonth?' selected':''}>${monthName(m)}</option>`
    ).join('')}
  </select>`;

  const qSel = `<select id="${idPrefix}-quarter">
    ${[1,2,3,4].map(q =>
      `<option value="${q}"${q===curQ?' selected':''}>${quarterLabel(q)}</option>`
    ).join('')}
  </select>`;

  const yearSel = `<select id="${idPrefix}-year">
    ${years.map(y => `<option value="${y}"${y===curYear?' selected':''}>${y}</option>`).join('')}
  </select>`;

  const periodCtrl = mode === 'monthly'
    ? `<label>Month</label>${monthSel}`
    : `<label>Quarter</label>${qSel}`;

  return `<div class="filter-bar" id="${idPrefix}-filter">
    ${periodCtrl}
    <label>Year</label>${yearSel}
    <div class="filter-sep"></div>
    <button class="btn btn-primary" id="${idPrefix}-gen">⚡ Generate</button>
    <button class="btn btn-outline" id="${idPrefix}-print" style="display:none;" onclick="window.print()">🖨 Print</button>
    <button class="btn btn-success" id="${idPrefix}-pdf" style="display:none;" onclick="savePDF()">💾 Save PDF</button>
  </div>`;
}

function savePDF() {
  window.print();
}

// ── RETURN LINE ──────────────────────────────────────────────
function returnLine(num, label, amount, bold = false, cls = '') {
  return `<div class="return-line">
    <div class="return-line-num">${num}</div>
    <div class="return-line-label" style="${bold?'font-weight:700;':''}">${label}</div>
    <div class="return-line-amt ${cls}">₱ ${fmt(amount)}</div>
  </div>`;
}

// ── INCOME TAX REPORT TABS ───────────────────────────────────
// Wraps the three standard income-tax tab panels (Profit and Loss
// Statement, BIR Mapping of COA, BIR Form) into a tab bar + panel
// set. `tabs` is [{ key, label, html }] in display order. Call
// bindIncomeTaxTabs(el) once after setting el.innerHTML to wire up
// the click-to-switch behavior.
function renderIncomeTaxTabs(tabs, activeKey) {
  const active = activeKey || (tabs[0] && tabs[0].key);
  const buttons = tabs.map(t => `<button type="button" class="tax-tab-btn${t.key === active ? ' active' : ''}" data-tab="${t.key}">${escHtml(t.label)}</button>`).join('');
  const panels = tabs.map(t => `<div class="tax-tab-panel" data-tab="${t.key}" style="display:${t.key === active ? 'block' : 'none'};">${t.html}</div>`).join('');
  return `<div class="tax-tab-bar no-print">${buttons}</div>${panels}`;
}

function bindIncomeTaxTabs(el) {
  el.querySelectorAll('.tax-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tab;
      el.querySelectorAll('.tax-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      el.querySelectorAll('.tax-tab-panel').forEach(p => { p.style.display = (p.dataset.tab === key) ? 'block' : 'none'; });
    });
  });
}
