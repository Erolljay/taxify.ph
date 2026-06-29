// Custom-field setup for the PH (Philippines BIR) extension.
// Field GUIDs are stable identifiers -- DO NOT CHANGE after first use.
// Uses postMessage bridge (apiRequest from shared.js) -- NOT direct fetch.
//
// Business section mirrors AU extension:
//   - Data stored IN Manager's business record as custom fields
//   - Form renders immediately (no spinner), loads from Manager in background
//   - On save: writes directly to Manager business record (no localStorage)

(function () {

  var BUSINESS_FIELDS = [
    // [0] Identity
    { id: 'b1r00001-0000-4000-a000-000000000001', label: 'TIN',                      type: 'text',   placeholder: '000-000-000-000' },
    { id: 'b1r00001-0000-4000-a000-000000000002', label: 'RDO Code',                 type: 'text',   placeholder: 'e.g. 083' },
    { id: 'b1r00001-0000-4000-a000-000000000013', label: 'Branch Code',              type: 'text',   placeholder: '0000 (Head Office = 0000)' },
    { id: 'b1r00001-0000-4000-a000-000000000004', label: 'Taxpayer Classification',  type: 'select', options: ['', 'Non-Individual / Corporation', 'Individual'] },
    { id: 'b1r00001-0000-4000-a000-000000000005', label: 'Line of Business',         type: 'text',   placeholder: 'e.g. Retail Trade' },
    { id: 'b1r00001-0000-4000-a000-000000000015', label: 'Telephone Number',         type: 'text',   placeholder: 'e.g. 033-XXX-XXXX' },
    { id: 'b1r00001-0000-4000-a000-000000000016', label: 'Email Address',            type: 'text',   placeholder: 'e.g. info@company.com' },
    { id: 'b1r00001-0000-4000-a000-000000000024', label: 'Fiscal Month End',         type: 'select', options: ['', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'], labels: ['-- select --', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] },
    // [7] Registered Name (non-individual)
    { id: 'b1r00001-0000-4000-a000-000000000009', label: 'Company / Registered Name', type: 'text',  placeholder: 'ABC Corporation' },
    { id: 'b1r00001-0000-4000-a000-000000000025', label: 'Trade Name',               type: 'text',   placeholder: 'e.g. ABC Store (if different from registered name)' },
    // [8-10] Registered Name (individual)
    { id: 'b1r00001-0000-4000-a000-000000000010', label: 'Last Name',                type: 'text',   placeholder: 'Dela Cruz' },
    { id: 'b1r00001-0000-4000-a000-000000000011', label: 'First Name',               type: 'text',   placeholder: 'Juan' },
    { id: 'b1r00001-0000-4000-a000-000000000012', label: 'Middle Name',              type: 'text',   placeholder: 'Santos' },
    // [11-16] Address
    { id: 'b1r00001-0000-4000-a000-000000000017', label: 'Substreet',                type: 'text',   placeholder: 'Unit / Floor / Room' },
    { id: 'b1r00001-0000-4000-a000-000000000018', label: 'Street',                   type: 'text',   placeholder: 'e.g. Iznart St.' },
    { id: 'b1r00001-0000-4000-a000-000000000019', label: 'Barangay',                 type: 'text',   placeholder: 'e.g. Brgy. Rizal' },
    { id: 'b1r00001-0000-4000-a000-000000000020', label: 'District / Municipality',  type: 'text',   placeholder: 'e.g. Iloilo City' },
    { id: 'b1r00001-0000-4000-a000-000000000021', label: 'City / Province',          type: 'text',   placeholder: 'e.g. Iloilo' },
    { id: 'b1r00001-0000-4000-a000-000000000003', label: 'Zip Code',                 type: 'text',   placeholder: 'e.g. 5000' },
    // [17-18] Authorized Rep
    { id: 'b1r00001-0000-4000-a000-000000000014', label: 'Authorized Rep Name',      type: 'text',   placeholder: 'Full name of signatory' },
    { id: 'b1r00001-0000-4000-a000-000000000022', label: 'Authorized Rep Title',     type: 'text',   placeholder: 'e.g. President / Treasurer' },
    { id: 'b1r00001-0000-4000-a000-000000000023', label: 'Authorized Rep e-Signature', type: 'image', help: 'PNG or JPEG, max ' + Math.round(150) + ' KB. Appears on 2307 and 2316 signature lines.' },
  ];

  var MAX_SIGNATURE_BYTES = 150 * 1024; // 150 KB raw file size cap

  var PARTY_FIELDS = [
    { id: 'b1r00002-0000-4000-a000-000000000001', label: 'Taxpayer Type',    type: 'select', options: ['', 'Non-Individual', 'Individual'], labels: ['-- select --', 'Non-Individual / Corporation', 'Individual'] },
    { id: 'b1r00002-0000-4000-a000-000000000002', label: 'TIN',              type: 'text', placeholder: '000-000-000-000' },
    { id: 'b1r00002-0000-4000-a000-000000000003', label: 'Branch Code',      type: 'text', placeholder: '000' },
    { id: 'b1r00002-0000-4000-a000-000000000004', label: 'Company Name',     type: 'text', placeholder: 'Corp / Registered Name' },
    { id: 'b1r00002-0000-4000-a000-000000000005', label: 'Last Name',        type: 'text', placeholder: 'Dela Cruz' },
    { id: 'b1r00002-0000-4000-a000-000000000006', label: 'First Name',       type: 'text', placeholder: 'Juan' },
    { id: 'b1r00002-0000-4000-a000-000000000007', label: 'Middle Name',      type: 'text', placeholder: 'Santos' },
    { id: 'b1r00002-0000-4000-a000-000000000008', label: 'Address Line 1',   type: 'text', placeholder: 'Unit, Bldg, Street, Brgy' },
    { id: 'b1r00002-0000-4000-a000-000000000009', label: 'Address Line 2',   type: 'text', placeholder: 'City / Municipality, Province' },
  ];

  var EMPLOYEE_FIELDS = [
    // [0-3] BIR Identity
    { id: 'b1r00003-0000-4000-a000-000000000001', label: 'TIN',                     type: 'text', placeholder: '000-000-000-000' },
    { id: 'b1r00003-0000-4000-a000-000000000002', label: 'SSS Number',               type: 'text', placeholder: 'XX-XXXXXXX-X' },
    { id: 'b1r00003-0000-4000-a000-000000000003', label: 'PhilHealth Number',        type: 'text', placeholder: 'XX-XXXXXXXXX-X' },
    { id: 'b1r00003-0000-4000-a000-000000000004', label: 'Pag-IBIG (HDMF) Number',  type: 'text', placeholder: 'XXXX-XXXX-XXXX' },
    // [4-9] Employment Details
    { id: 'b1r00003-0000-4000-a000-000000000005', label: 'Employment Status',        type: 'select', options: ['', 'R', 'C', 'CP', 'S', 'P', 'AL'], labels: ['-- select --', 'Regular', 'Casual', 'Contractual/Project-Based', 'Seasonal', 'Probationary', 'Apprentice/Learners'] },
    { id: 'b1r00003-0000-4000-a000-000000000006', label: 'Tax Status',               type: 'select', options: ['', 'MWE', 'NMWE'], labels: ['-- select --', 'MWE - Minimum Wage Earner', 'NMWE - Non-Minimum Wage Earner'] },
    { id: 'b1r00003-0000-4000-a000-000000000023', label: 'Date Hired',               type: 'date' },
    { id: 'b1r00003-0000-4000-a000-000000000024', label: 'Date Separated',           type: 'date' },
    { id: 'b1r00003-0000-4000-a000-000000000025', label: 'Reason for Separation',    type: 'select', options: ['', 'NA', 'T', 'TR', 'R', 'D'], labels: ['-- select --', 'Not Applicable', 'Terminated / Resigned', 'Transferred', 'Retirement', 'Death'] },
    { id: 'b1r00003-0000-4000-a000-000000000026', label: 'Substituted Filing',       type: 'select', options: ['', 'Y', 'N'], labels: ['-- select --', 'Yes', 'No'] },
    // [10-20] Personal Information
    { id: 'b1r00003-0000-4000-a000-000000000007', label: 'Last Name',                type: 'text', placeholder: 'Dela Cruz' },
    { id: 'b1r00003-0000-4000-a000-000000000008', label: 'First Name',               type: 'text', placeholder: 'Juan' },
    { id: 'b1r00003-0000-4000-a000-000000000009', label: 'Middle Name',              type: 'text', placeholder: 'Santos' },
    { id: 'b1r00003-0000-4000-a000-000000000010', label: 'Date of Birth',            type: 'date' },
    { id: 'b1r00003-0000-4000-a000-000000000011', label: 'Address',                  type: 'text', placeholder: 'Unit, Bldg, Street, Barangay, City' },
    { id: 'b1r00003-0000-4000-a000-000000000027', label: 'Region',                   type: 'text', placeholder: 'e.g. NCR' },
    { id: 'b1r00003-0000-4000-a000-000000000028', label: 'Zip Code',                 type: 'text', placeholder: 'e.g. 5000' },
    { id: 'b1r00003-0000-4000-a000-000000000029', label: 'Telephone Number',         type: 'text', placeholder: 'e.g. 09171234567' },
    { id: 'b1r00003-0000-4000-a000-000000000030', label: 'Valid ID',                 type: 'text', placeholder: 'e.g. SSS 12-3456789-0' },
    { id: 'b1r00003-0000-4000-a000-000000000031', label: 'Place of Issue of ID',     type: 'text', placeholder: 'e.g. Cebu City' },
    { id: 'b1r00003-0000-4000-a000-000000000032', label: 'Nationality',              type: 'text', placeholder: 'e.g. Filipino' },
  ];

  var PAYSLIP_ITEM_TYPES = [
    { key: 'earnings', label: 'Earnings', endpoint: 'payslip-earnings-item', categories: [
      { id: 'ph-bir-earn-01', name: 'Basic Salary' },
      { id: 'ph-bir-earn-02', name: 'Overtime Pay' },
      { id: 'ph-bir-earn-03', name: 'Holiday Pay' },
      { id: 'ph-bir-earn-04', name: 'Night Differential' },
      { id: 'ph-bir-earn-05', name: 'Hazard Pay' },
      { id: 'ph-bir-earn-06', name: '13th Month Pay (taxable portion)' },
      { id: 'ph-bir-earn-07', name: 'De Minimis Benefits (non-taxable)' },
      { id: 'ph-bir-earn-08', name: 'Other Taxable Allowances' },
      { id: 'ph-bir-earn-09', name: 'Separation Pay / Retirement' },
      { id: 'ph-bir-earn-10', name: 'Commission' },
      { id: 'ph-bir-earn-11', name: 'Profit Sharing' },
      { id: 'ph-bir-earn-12', name: "Fees Including Director's Fees" },
    ]},
    { key: 'deductions', label: 'Deductions', endpoint: 'payslip-deduction-item', categories: [
      { id: 'ph-bir-ded-01', name: 'Withholding Tax on Compensation' },
      { id: 'ph-bir-ded-02', name: 'SSS Contribution' },
      { id: 'ph-bir-ded-03', name: 'PhilHealth Contribution' },
      { id: 'ph-bir-ded-04', name: 'Pag-IBIG (HDMF) Contribution' },
      { id: 'ph-bir-ded-05', name: 'Other Deductions (non-BIR)' },
    ]},
    { key: 'contributions', label: 'Employer Contributions', endpoint: 'payslip-contribution-item', categories: [
      { id: 'ph-bir-con-01', name: 'SSS - Employer Share' },
      { id: 'ph-bir-con-02', name: 'PhilHealth - Employer Share' },
      { id: 'ph-bir-con-03', name: 'Pag-IBIG - Employer Share' },
    ]},
  ];

  // ---- Helpers ----

  function esc(s) {
    return String(s != null ? s : '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function patchCF(existing, updates) {
    var out = Object.assign({}, existing || {});
    for (var i = 0; i < updates.length; i++) {
      var f = updates[i].field, v = updates[i].value;
      if (v === '' || v == null) delete out[f.id];
      else out[f.id] = String(v);
    }
    return out;
  }

  function renderControl(field, value, idPfx) {
    var inputId = idPfx + '-' + field.id;
    if (field.type === 'select') {
      var opts = (field.options || []).map(function(o, i) {
        var lbl = field.labels ? field.labels[i] : o;
        var sel = o === value ? ' selected' : '';
        return '<option value="' + esc(o) + '"' + sel + '>' + esc(lbl || o || '--') + '</option>';
      }).join('');
      return '<select id="' + inputId + '" class="form-select" data-cf-id="' + field.id + '">' + opts + '</select>';
    }
    if (field.type === 'date') {
      return '<input id="' + inputId + '" type="date" class="form-input" value="' + esc(value) + '" data-cf-id="' + field.id + '">';
    }
    if (field.type === 'image') {
      var imgId = inputId + '-preview';
      var preview = '<img id="' + imgId + '" src="' + esc(value || '') + '" style="max-height:60px;max-width:220px;border:1px solid #e5e7eb;border-radius:4px;display:' + (value ? 'block' : 'none') + ';margin-bottom:6px;background:#fff;">';
      return preview +
        '<input id="' + inputId + '" type="hidden" data-cf-id="' + field.id + '" value="' + esc(value || '') + '">' +
        '<input type="file" accept="image/png,image/jpeg" class="form-input" onchange="window.cfHandleImageUpload(this, \'' + inputId + '\', \'' + imgId + '\')">' +
        '<div id="' + inputId + '-err" style="font-size:10px;color:#c0392b;margin-top:2px;"></div>' +
        '<button type="button" style="margin-top:4px;font-size:11px;" onclick="window.cfClearImage(\'' + inputId + '\', \'' + imgId + '\')">Remove signature</button>';
    }
    return '<input id="' + inputId + '" type="text" class="form-input" placeholder="' + esc(field.placeholder || '') + '" value="' + esc(value) + '" data-cf-id="' + field.id + '">';
  }

  function renderField(field, value, idPfx) {
    var ctrl = renderControl(field, value, idPfx);
    var help = field.help ? '<small style="color:#6b7280;font-size:10px;">' + esc(field.help) + '</small>' : '';
    return '<div class="form-group"><label class="form-label">' + esc(field.label) + '</label>' + ctrl + help + '</div>';
  }

  function collectValues(container, fields) {
    return fields.map(function(f) {
      var el = container.querySelector('[data-cf-id="' + f.id + '"]');
      return { field: f, value: el ? el.value : '' };
    });
  }

  function flash(btn, ok) {
    var orig = btn.dataset.orig || btn.textContent;
    btn.dataset.orig = orig;
    btn.disabled = true;
    btn.textContent = ok ? 'Saved' : 'Failed';
    btn.style.background = ok ? '#27ae60' : '#c0392b';
    setTimeout(function() {
      btn.textContent = orig;
      btn.style.background = '';
      btn.disabled = false;
    }, ok ? 1400 : 3000);
  }

  function biz() {
    var sel = document.getElementById('business');
    if (sel && sel.value) return sel.value;
    return (typeof App !== 'undefined' && App.currentBusiness) ? App.currentBusiness : '';
  }

  function noBusinessMsg() {
    return '<div class="alert alert-info">Please select a business above.</div>';
  }

  function spinner(msg) {
    return '<div class="spinner-wrap"><div class="spinner"></div><span>' + esc(msg) + '</span></div>';
  }

  // ---- BUSINESS SECTION ----

  function mountBusinessSection(container) {
    var currentModel = {};
    var birGuids = null;

    async function refresh() {
      var business = biz();
      if (!business) { container.innerHTML = noBusinessMsg(); return; }

      currentModel = {};
      renderBizForm({});

      var statusEl = container.querySelector('#cf-biz-status');
      if (statusEl) { statusEl.textContent = 'Loading...'; statusEl.style.color = '#6b7280'; }

      try {
        birGuids = await ensureBIRFields(business);

        var rec = await getOrCreateBizDataRecord(business);
        if (statusEl) statusEl.textContent = '';
        currentModel = rec.value;

        // BIR data lives in customFields2.strings keyed by the real Manager GUID
        var cf = parseBIRBlob((currentModel.customFields2 && currentModel.customFields2.strings) || {}, birGuids && birGuids.biz, 'b1r00001-');

        BUSINESS_FIELDS.forEach(function(f) {
          var el = container.querySelector('[data-cf-id="' + f.id + '"]');
          if (!el) return;
          el.value = cf[f.id] || '';
        });
        var cls = cf['b1r00001-0000-4000-a000-000000000004'] || '';
        var ind = cls === 'Individual';
        var co = container.querySelector('#cf-grp-company');
        var pi = container.querySelector('#cf-grp-ind');
        if (co) co.style.display = ind ? 'none' : '';
        if (pi) pi.style.display = ind ? '' : 'none';
      } catch(err) {
        if (statusEl) {
          statusEl.textContent = 'Could not load from Manager — fill in and save manually.';
          statusEl.style.color = '#f59e0b';
        }
        console.warn('business-details GET failed:', err && err.message);
      }
    }

    function renderBizForm(cf) {
      var isInd = (cf['b1r00001-0000-4000-a000-000000000004'] || '') === 'Individual';

      function BF(id) { return BUSINESS_FIELDS.find(function(f){ return f.id === id; }); }
      function val(id) { return cf[id] || ''; }

      var secStyle = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid #f1f5f9;';

      var left =
        '<p style="' + secStyle + '">Taxpayer Identity</p>' +
        renderField(BF('b1r00001-0000-4000-a000-000000000001'), val('b1r00001-0000-4000-a000-000000000001'), 'biz') +
        renderField(BF('b1r00001-0000-4000-a000-000000000002'), val('b1r00001-0000-4000-a000-000000000002'), 'biz') +
        renderField(BF('b1r00001-0000-4000-a000-000000000013'), val('b1r00001-0000-4000-a000-000000000013'), 'biz') +
        renderField(BF('b1r00001-0000-4000-a000-000000000004'), val('b1r00001-0000-4000-a000-000000000004'), 'biz') +
        renderField(BF('b1r00001-0000-4000-a000-000000000005'), val('b1r00001-0000-4000-a000-000000000005'), 'biz') +
        renderField(BF('b1r00001-0000-4000-a000-000000000015'), val('b1r00001-0000-4000-a000-000000000015'), 'biz') +
        renderField(BF('b1r00001-0000-4000-a000-000000000016'), val('b1r00001-0000-4000-a000-000000000016'), 'biz') +
        renderField(BF('b1r00001-0000-4000-a000-000000000024'), val('b1r00001-0000-4000-a000-000000000024'), 'biz');

      var right =
        '<p style="' + secStyle + '">Registered Name</p>' +
        '<div id="cf-grp-company" style="' + (isInd ? 'display:none' : '') + '">' +
          renderField(BF('b1r00001-0000-4000-a000-000000000009'), val('b1r00001-0000-4000-a000-000000000009'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000025'), val('b1r00001-0000-4000-a000-000000000025'), 'biz') +
        '</div>' +
        '<div id="cf-grp-ind" style="' + (!isInd ? 'display:none' : '') + '">' +
          renderField(BF('b1r00001-0000-4000-a000-000000000010'), val('b1r00001-0000-4000-a000-000000000010'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000011'), val('b1r00001-0000-4000-a000-000000000011'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000012'), val('b1r00001-0000-4000-a000-000000000012'), 'biz') +
        '</div>';

      var addr =
        '<p style="' + secStyle + 'margin-top:16px;">Address</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 16px;">' +
          renderField(BF('b1r00001-0000-4000-a000-000000000017'), val('b1r00001-0000-4000-a000-000000000017'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000018'), val('b1r00001-0000-4000-a000-000000000018'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000019'), val('b1r00001-0000-4000-a000-000000000019'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000020'), val('b1r00001-0000-4000-a000-000000000020'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000021'), val('b1r00001-0000-4000-a000-000000000021'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000003'), val('b1r00001-0000-4000-a000-000000000003'), 'biz') +
        '</div>';

      var rep =
        '<p style="' + secStyle + 'margin-top:16px;">Authorized Representative</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">' +
          renderField(BF('b1r00001-0000-4000-a000-000000000014'), val('b1r00001-0000-4000-a000-000000000014'), 'biz') +
          renderField(BF('b1r00001-0000-4000-a000-000000000022'), val('b1r00001-0000-4000-a000-000000000022'), 'biz') +
        '</div>' +
        '<div style="margin-top:6px;">' +
          renderField(BF('b1r00001-0000-4000-a000-000000000023'), val('b1r00001-0000-4000-a000-000000000023'), 'biz') +
        '</div>';

      container.innerHTML =
        '<p style="font-size:11px;color:#6b7280;margin-bottom:14px;">' +
        'BIR fields stored as custom fields in Manager — per business, per record. ' +
        'Used by all reports, DAT files, and 2307 certificate generation.' +
        '</p>' +
        '<form id="cf-biz-form">' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">' +
        '<div>' + left + '</div>' +
        '<div>' + right + '</div>' +
        '</div>' +
        addr +
        rep +
        '<div style="margin-top:16px;display:flex;justify-content:flex-end;align-items:center;gap:12px;">' +
        '<span id="cf-biz-status" style="font-size:11px;color:#6b7280;"></span>' +
        '<button type="button" id="cf-biz-reload" class="btn btn-secondary" style="font-size:12px;">Reload</button>' +
        '<button type="submit" class="btn btn-primary" id="cf-biz-save">Save Business Info</button>' +
        '</div>' +
        '</form>';

      var clsSel = container.querySelector('[data-cf-id="b1r00001-0000-4000-a000-000000000004"]');
      if (clsSel) {
        clsSel.addEventListener('change', function(e) {
          var ind = e.target.value === 'Individual';
          var co = container.querySelector('#cf-grp-company');
          var pi = container.querySelector('#cf-grp-ind');
          if (co) co.style.display = ind ? 'none' : '';
          if (pi) pi.style.display = ind ? '' : 'none';
        });
      }

      container.querySelector('#cf-biz-reload').addEventListener('click', function() { refresh(); });
      container.querySelector('#cf-biz-form').addEventListener('submit', onSave);
    }

    async function onSave(e) {
      e.preventDefault();
      var btn = document.getElementById('cf-biz-save');
      var status = document.getElementById('cf-biz-status');
      var business = biz();
      if (!business) return;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      if (status) status.textContent = '';

      var birBlob = {};
      var sizeError = '';
      BUSINESS_FIELDS.forEach(function(f) {
        var el = container.querySelector('[data-cf-id="' + f.id + '"]');
        if (!el) return;
        var v = el.value || '';
        if (f.type === 'image' && v) {
          // base64 data URI is ~37% larger than raw bytes
          var approxBytes = Math.floor(v.length * 0.75);
          if (approxBytes > MAX_SIGNATURE_BYTES) {
            sizeError = 'Signature image exceeds ' + Math.round(MAX_SIGNATURE_BYTES / 1024) + ' KB — please upload a smaller image.';
            return;
          }
        }
        birBlob[f.id] = v;
      });

      if (sizeError) {
        btn.disabled = false;
        btn.textContent = 'Save Business Info';
        if (status) { status.textContent = sizeError; status.style.color = '#c0392b'; }
        return;
      }

      var managerOk = false;
      try {
        if (!birGuids) birGuids = await ensureBIRFields(business);
        if (!birGuids || !birGuids.biz) throw new Error('BIR custom field not ready');
        var managerCF2 = await saveBizDataRecord(business, birGuids.biz, birBlob);
        currentModel = Object.assign({}, currentModel || {}, { customFields2: managerCF2 });
        managerOk = true;
      } catch(err) {
        console.warn('business BIR data save failed:', err.message);
      }

      btn.disabled = false;
      btn.textContent = 'Save Business Info';
      if (status) {
        status.textContent = managerOk ? 'Saved to Manager' : 'Saved locally (Manager write failed)';
        status.style.color = managerOk ? '#27ae60' : '#f59e0b';
        setTimeout(function() { if (status) status.textContent = ''; }, 3000);
      }
    }

    return { refresh: refresh };
  }

  // ---- CUSTOMERS / SUPPLIERS SECTION ----

  function buildSafeValue(v, overrides) {
    var result = {};
    Object.keys(v || {}).forEach(function(k) {
      if (k === 'timestamp' || k === 'id' || k === 'key') return;
      result[k] = v[k];
    });
    return Object.assign(result, overrides || {});
  }

  function buildPartyValue(v, newCustomFields2) {
    return {
      name:            v.name            !== undefined ? v.name            : null,
      code:            v.code            !== undefined ? v.code            : null,
      creditLimit:     v.creditLimit     !== undefined ? v.creditLimit     : 0,
      currency:        v.currency        !== undefined ? v.currency        : null,
      billingAddress:  v.billingAddress  !== undefined ? v.billingAddress  : null,
      deliveryAddress: v.deliveryAddress !== undefined ? v.deliveryAddress : null,
      email:           v.email           !== undefined ? v.email           : null,
      division:        v.division        !== undefined ? v.division        : null,
      controlAccount:  v.controlAccount  !== undefined ? v.controlAccount  : null,
      hasDefaultDueDateDays: v.hasDefaultDueDateDays || false,
      defaultDueDateDays:    v.defaultDueDateDays    !== undefined ? v.defaultDueDateDays : null,
      hasDefaultHourlyRate:  v.hasDefaultHourlyRate  || false,
      defaultHourlyRate:     v.defaultHourlyRate     !== undefined ? v.defaultHourlyRate  : 0,
      inactive:              v.inactive              || false,
      customFields:          v.customFields          !== undefined ? v.customFields : null,
      customFields2:         newCustomFields2,
      hasDefaultBillingAddress:  v.hasDefaultBillingAddress  || false,
      defaultBillingAddress:     v.defaultBillingAddress     !== undefined ? v.defaultBillingAddress  : null,
      hasDefaultDeliveryAddress: v.hasDefaultDeliveryAddress || false,
      defaultDeliveryAddress:    v.defaultDeliveryAddress    !== undefined ? v.defaultDeliveryAddress : null,
    };
  }

  function mountPartySection(container, partyType) {
    var batchPath = partyType === 'customer' ? '/api4/customer-batch' : '/api4/supplier-batch';
    var putPath   = partyType === 'customer' ? '/api4/customer'       : '/api4/supplier';
    var cache = [];
    var birGuids = null;

    async function refresh() {
      var business = biz();
      if (!business) { container.innerHTML = noBusinessMsg(); return; }
      container.innerHTML = spinner('Loading ' + partyType + 's from Manager…');
      try {
        birGuids = await ensureBIRFields(business);
        var res = await apiRequest('GET', batchPath + '?business=' + encodeURIComponent(business) + '&Skip=0&PageSize=500');
        var items = (res && res.items) ? res.items : [];
        cache = items.map(function(it) {
          return {
            key: it.key,
            value: it.item || {},
            displayName: (it.item || {}).name || (it.item || {}).Name || it.key,
          };
        }).sort(function(a, b) { return a.displayName.localeCompare(b.displayName); });
      } catch(err) {
        container.innerHTML =
          '<div style="padding:12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;font-size:12px;color:#991b1b;">' +
          '⚠ Could not load ' + partyType + 's: ' + esc(err.message) +
          ' <button onclick="CF.mount' + (partyType === 'customer' ? 'Party' : 'Party') + '" style="margin-left:8px;font-size:11px;padding:2px 10px;cursor:pointer;" id="cf-' + partyType + '-retry">Retry</button>' +
          '</div>';
        var retryBtn = container.querySelector('#cf-' + partyType + '-retry');
        if (retryBtn) retryBtn.addEventListener('click', function() { refresh(); });
        return;
      }
      renderPartyTable();
    }

    function renderPartyTable() {
      if (!cache.length) {
        container.innerHTML = '<div class="alert alert-info">No ' + partyType + 's found.</div>';
        return;
      }
      var dis = 'background:#f1f5f9;color:#94a3b8;';
      var rows = cache.map(function(rec, idx) {
        var cf = parseBIRBlob((rec.value.customFields2 && rec.value.customFields2.strings) || {}, birGuids && birGuids.party, 'b1r00002-');
        var pType  = cf[PARTY_FIELDS[0].id] || 'Non-Individual';
        var isInd  = pType === 'Individual';
        var tin    = cf[PARTY_FIELDS[1].id] || '';
        var branch = cf[PARTY_FIELDS[2].id] || '';
        var corp   = cf[PARTY_FIELDS[3].id] || '';
        var ln     = cf[PARTY_FIELDS[4].id] || '';
        var fn     = cf[PARTY_FIELDS[5].id] || '';
        var mn     = cf[PARTY_FIELDS[6].id] || '';
        var a1     = cf[PARTY_FIELDS[7].id] || '';
        var a2     = cf[PARTY_FIELDS[8].id] || '';
        var isComplete = !!(tin && (isInd ? (ln && fn) : corp) && a1);
        return '<tr data-key="' + esc(rec.key) + '" data-idx="' + idx + '" data-complete="' + (isComplete ? '1' : '0') + '">' +
          '<td style="font-weight:600;font-size:11px;">' + esc(rec.displayName) + '</td>' +
          '<td><select class="form-select cf-ptype" style="width:100%;font-size:10px;" onchange="cfPartyToggle(this)">' +
            '<option value="Non-Individual"' + (!isInd ? ' selected' : '') + '>Non-Individual</option>' +
            '<option value="Individual"' + (isInd ? ' selected' : '') + '>Individual</option>' +
          '</select></td>' +
          '<td><input class="form-input cf-tin"    style="width:100%;font-size:11px;" placeholder="000-000-000-000" value="' + esc(tin) + '"></td>' +
          '<td><input class="form-input cf-branch" style="width:100%;font-size:11px;" placeholder="000" value="' + esc(branch) + '"></td>' +
          '<td><input class="form-input cf-corp" style="width:100%;font-size:11px;" placeholder="Corp / Registered Name" value="' + esc(corp) + '"' + (isInd ? ' disabled style="' + dis + 'width:100%;font-size:11px;"' : '') + '></td>' +
          '<td><input class="form-input cf-ln" style="width:100%;font-size:11px;" placeholder="Dela Cruz" value="' + esc(ln) + '"' + (!isInd ? ' disabled style="' + dis + 'width:100%;font-size:11px;"' : '') + '></td>' +
          '<td><input class="form-input cf-fn" style="width:100%;font-size:11px;" placeholder="Juan" value="' + esc(fn) + '"' + (!isInd ? ' disabled style="' + dis + 'width:100%;font-size:11px;"' : '') + '></td>' +
          '<td><input class="form-input cf-mn" style="width:100%;font-size:11px;" placeholder="Santos" value="' + esc(mn) + '"' + (!isInd ? ' disabled style="' + dis + 'width:100%;font-size:11px;"' : '') + '></td>' +
          '<td><input class="form-input cf-a1" style="width:100%;font-size:11px;" placeholder="Unit, Bldg, Street, Brgy" value="' + esc(a1) + '"></td>' +
          '<td><input class="form-input cf-a2" style="width:100%;font-size:11px;" placeholder="City / Municipality, Province" value="' + esc(a2) + '"></td>' +
          '<td><button class="btn btn-primary btn-sm" data-action="cf-save-row" onclick="cfSavePartyRow(this,\'' + partyType + '\')" style="font-size:10px;">Save</button></td>' +
          '</tr>';
      }).join('');

      container.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">' +
        '<input type="text" class="form-input" id="cf-' + partyType + '-search" placeholder="Search by name…" style="width:220px;" oninput="cfPartyFilter(\'' + partyType + '\')">'+
        '<select class="form-select" id="cf-' + partyType + '-filter" style="width:200px;font-size:12px;" onchange="cfPartyFilter(\'' + partyType + '\')">' +
          '<option value="all">Show all</option>' +
          '<option value="incomplete">Missing details only</option>' +
          '<option value="complete">Completed only</option>' +
        '</select>' +
        '<span id="cf-' + partyType + '-count" style="font-size:11px;color:#6b7280;">' + cache.length + ' record' + (cache.length !== 1 ? 's' : '') + ' — Save per row or use Save All</span>' +
        '<button class="btn btn-secondary" style="margin-left:auto;font-size:11px;padding:5px 14px;" onclick="cfSaveAllParty(\'' + partyType + '\')">Save All</button>' +
        '</div>' +
        '<div style="width:100%;">' +
        '<table class="data-table" id="cf-' + partyType + '-table" style="width:100%;table-layout:fixed;border-collapse:collapse;">' +
        '<thead><tr style="font-size:11px;">' +
        '<th style="width:14%;">Name in Manager</th>' +
        '<th style="width:9%;">Taxpayer Type</th>' +
        '<th style="width:9%;">TIN</th>' +
        '<th style="width:5%;">Branch</th>' +
        '<th style="width:12%;">Company / Corp Name</th>' +
        '<th style="width:8%;">Last Name</th>' +
        '<th style="width:8%;">First Name</th>' +
        '<th style="width:7%;">Middle Name</th>' +
        '<th style="width:13%;">Address Line 1</th>' +
        '<th style="width:11%;">Address Line 2</th>' +
        '<th style="width:4%;"></th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table></div>';
    }

    async function saveRow(btn) {
      var tr = btn.closest('tr');
      var key = tr.dataset.key;
      var idx = parseInt(tr.dataset.idx, 10);
      var business = biz();
      if (!business || !key) return;
      var rec = cache[idx];
      if (!rec) return;
      var pType = tr.querySelector('.cf-ptype').value;
      var isInd = pType === 'Individual';
      var updates = [
        { field: PARTY_FIELDS[0], value: pType },
        { field: PARTY_FIELDS[1], value: tr.querySelector('.cf-tin').value.trim() },
        { field: PARTY_FIELDS[2], value: tr.querySelector('.cf-branch').value.trim() },
        { field: PARTY_FIELDS[3], value: !isInd ? tr.querySelector('.cf-corp').value.trim() : '' },
        { field: PARTY_FIELDS[4], value: isInd ? tr.querySelector('.cf-ln').value.trim() : '' },
        { field: PARTY_FIELDS[5], value: isInd ? tr.querySelector('.cf-fn').value.trim() : '' },
        { field: PARTY_FIELDS[6], value: isInd ? tr.querySelector('.cf-mn').value.trim() : '' },
        { field: PARTY_FIELDS[7], value: tr.querySelector('.cf-a1').value.trim() },
        { field: PARTY_FIELDS[8], value: tr.querySelector('.cf-a2').value.trim() },
      ];
      // Patch the BIR blob, then wrap in Manager customFields2
      var existingBlob = parseBIRBlob((rec.value.customFields2 && rec.value.customFields2.strings) || {}, birGuids && birGuids.party, 'b1r00002-');
      var newBlob  = patchCF(existingBlob, updates);
      var managerCF2 = buildBIRCustomFields(rec.value, birGuids && birGuids.party, newBlob);
      var putValue = buildPartyValue(rec.value, managerCF2);
      try {
        await apiRequest('PUT', putPath, { business: business, key: key, value: putValue });
        rec.value = Object.assign({}, rec.value, { customFields2: managerCF2 });
        flash(btn, true);
      } catch(err) {
        console.error(err);
        flash(btn, false);
      }
    }

    async function saveAll() {
      var rows = container.querySelectorAll('tbody tr');
      var ok = 0, fail = 0;
      for (var i = 0; i < rows.length; i++) {
        var saveBtn = rows[i].querySelector('[data-action="cf-save-row"]');
        if (!saveBtn) continue;
        var tr = rows[i];
        var key = tr.dataset.key;
        var idx = parseInt(tr.dataset.idx, 10);
        var business = biz();
        var rec = cache[idx];
        if (!rec || !key || !business) { fail++; continue; }
        try {
          var pType = tr.querySelector('.cf-ptype').value;
          var isInd = pType === 'Individual';
          var updates = [
            { field: PARTY_FIELDS[0], value: pType },
            { field: PARTY_FIELDS[1], value: tr.querySelector('.cf-tin').value.trim() },
            { field: PARTY_FIELDS[2], value: tr.querySelector('.cf-branch').value.trim() },
            { field: PARTY_FIELDS[3], value: !isInd ? tr.querySelector('.cf-corp').value.trim() : '' },
            { field: PARTY_FIELDS[4], value: isInd ? tr.querySelector('.cf-ln').value.trim() : '' },
            { field: PARTY_FIELDS[5], value: isInd ? tr.querySelector('.cf-fn').value.trim() : '' },
            { field: PARTY_FIELDS[6], value: isInd ? tr.querySelector('.cf-mn').value.trim() : '' },
            { field: PARTY_FIELDS[7], value: tr.querySelector('.cf-a1').value.trim() },
            { field: PARTY_FIELDS[8], value: tr.querySelector('.cf-a2').value.trim() },
          ];
          var existingBlob = parseBIRBlob((rec.value.customFields2 && rec.value.customFields2.strings) || {}, birGuids && birGuids.party, 'b1r00002-');
          var newBlob   = patchCF(existingBlob, updates);
          var managerCF2 = buildBIRCustomFields(rec.value, birGuids && birGuids.party, newBlob);
          var putValue  = buildPartyValue(rec.value, managerCF2);
          await apiRequest('PUT', putPath, { business: business, key: key, value: putValue });
          rec.value = Object.assign({}, rec.value, { customFields2: managerCF2 });
          ok++;
        } catch(e) { fail++; }
      }
      if (typeof showToast === 'function') {
        showToast(fail === 0 ? (ok + ' ' + partyType + 's saved.') : (ok + ' saved, ' + fail + ' failed.'), fail === 0 ? 'ok' : 'err');
      }
    }

    window['cfSavePartyRow_' + partyType] = function(btn) { saveRow(btn); };
    window['cfSaveAll_' + partyType]      = function()    { saveAll(); };

    return { refresh: refresh };
  }

  // ---- EMPLOYEES SECTION ----

  function mountEmployeeSection(container) {
    var cache = [];
    var birGuids = null;

    async function refresh() {
      var business = biz();
      if (!business) { container.innerHTML = noBusinessMsg(); return; }
      container.innerHTML = spinner('Loading employees from Manager…');
      birGuids = await ensureBIRFields(business);
      try {
        var res = await apiRequest('GET', '/api4/employee-batch?business=' + encodeURIComponent(business) + '&Skip=0&PageSize=500');
        var items = (res && res.items) ? res.items : [];
        cache = items.map(function(it) {
          return { key: it.key, value: it.item || {}, displayName: (it.item || {}).name || (it.item || {}).Name || it.key };
        }).sort(function(a, b) { return a.displayName.localeCompare(b.displayName); });
      } catch(err) {
        container.innerHTML =
          '<div style="padding:12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;font-size:12px;color:#991b1b;">' +
          '⚠ Could not load employees: ' + esc(err.message) +
          ' <button id="cf-emp-retry" style="margin-left:8px;font-size:11px;padding:2px 10px;cursor:pointer;">Retry</button></div>';
        var retryBtn = container.querySelector('#cf-emp-retry');
        if (retryBtn) retryBtn.addEventListener('click', function() { refresh(); });
        return;
      }
      renderEmpPicker();
    }

    function renderEmpPicker() {
      if (!cache.length) {
        container.innerHTML = '<div class="alert alert-info">No employees found in this business.</div>';
        return;
      }
      var opts = cache.map(function(e) {
        return '<option value="' + esc(e.key) + '">' + esc(e.displayName) + '</option>';
      }).join('');
      container.innerHTML =
        '<p style="font-size:11px;color:#6b7280;margin-bottom:12px;">BIR fields stored in Manager employee record. Select an employee to edit.</p>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
        '<label style="font-size:12px;color:#6b7280;">Employee</label>' +
        '<select id="cf-emp-picker" style="font-size:12px;min-width:220px;"><option value="">-- select an employee --</option>' + opts + '</select>' +
        '</div><div id="cf-emp-form-host"></div>';
      container.querySelector('#cf-emp-picker').addEventListener('change', function(e) { renderEmpForm(e.target.value); });
    }

    function renderEmpForm(key) {
      var host = container.querySelector('#cf-emp-form-host');
      if (!host) return;
      if (!key) { host.innerHTML = ''; return; }
      var emp = cache.find(function(e) { return e.key === key; });
      if (!emp) return;
      var empBlob = parseBIRBlob((emp.value.customFields2 && emp.value.customFields2.strings) || {}, birGuids && birGuids.emp, 'b1r00003-');
      var groups = [
        { heading: 'BIR Identity', fields: EMPLOYEE_FIELDS.slice(0, 4) },
        { heading: 'Employment Details', fields: EMPLOYEE_FIELDS.slice(4, 10) },
        { heading: 'Personal Information', fields: EMPLOYEE_FIELDS.slice(10) },
      ];
      var groupsHtml = groups.map(function(g) {
        return '<fieldset style="border:.5px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin-bottom:12px;">' +
          '<legend style="font-size:11px;font-weight:500;color:#6b7280;padding:0 6px;">' + esc(g.heading) + '</legend>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
          g.fields.map(function(f) { return renderField(f, empBlob[f.id] || '', 'emp-' + key); }).join('') +
          '</div></fieldset>';
      }).join('');
      host.innerHTML = '<form id="cf-emp-save-form">' + groupsHtml +
        '<div style="display:flex;justify-content:flex-end;">' +
        '<button type="submit" class="btn btn-primary" id="cf-emp-save-btn">Save employee</button>' +
        '</div></form>';
      host.querySelector('#cf-emp-save-form').addEventListener('submit', function(e) { onEmpSave(e, emp); });
    }

    async function onEmpSave(e, emp) {
      e.preventDefault();
      var business = biz();
      if (!business) return;
      var btn = document.getElementById('cf-emp-save-btn');
      var updates = collectValues(e.currentTarget, EMPLOYEE_FIELDS);
      var existingBlob = parseBIRBlob((emp.value.customFields2 && emp.value.customFields2.strings) || {}, birGuids && birGuids.emp, 'b1r00003-');
      var newBlob   = patchCF(existingBlob, updates);
      var managerCF2 = buildBIRCustomFields(emp.value, birGuids && birGuids.emp, newBlob);
      var updated   = buildSafeValue(emp.value, { customFields2: managerCF2 });
      try {
        await apiRequest('PUT', '/api4/employee', { business: business, key: emp.key, value: updated });
        emp.value = updated;
        flash(btn, true);
      } catch(err) {
        console.error(err);
        flash(btn, false);
      }
    }

    return { refresh: refresh };
  }

  // Bulk-editable single-field save used by the 1601-C "Employee Tax Status" tab —
  // patches just the Tax Status field (EMPLOYEE_FIELDS[5]) on one employee record.
  async function saveEmployeeTaxStatus(business, empKey, empValue, taxStatus, birGuids) {
    var taxStatusField = EMPLOYEE_FIELDS[5];
    var existingBlob = parseBIRBlob((empValue.customFields2 && empValue.customFields2.strings) || {}, birGuids && birGuids.emp, 'b1r00003-');
    var newBlob = patchCF(existingBlob, [{ field: taxStatusField, value: taxStatus }]);
    var managerCF2 = buildBIRCustomFields(empValue, birGuids && birGuids.emp, newBlob);
    var updated = buildSafeValue(empValue, { customFields2: managerCF2 });
    await apiRequest('PUT', '/api4/employee', { business: business, key: empKey, value: updated });
    return updated;
  }

  // ---- PAYSLIP ITEMS SECTION ----

  var PAYSLIP_SUGGESTED_NAMES = {
    'ph-bir-earn-01': ['Basic Salary','Monthly Salary','Basic Pay','Daily Wage'],
    'ph-bir-earn-02': ['Overtime Pay','OT Pay (regular)','OT Pay (holiday)','OT Pay (rest day)'],
    'ph-bir-earn-03': ['Holiday Pay','Regular Holiday Pay','Special Holiday Pay'],
    'ph-bir-earn-04': ['Night Differential','Night Shift Differential'],
    'ph-bir-earn-05': ['Hazard Pay','Danger Pay'],
    'ph-bir-earn-06': ['13th Month Pay','14th Month Pay','Christmas Bonus','Mid-Year Bonus','Productivity Incentive Bonus','Loyalty Bonus','Anniversary Bonus','Performance Bonus','Rice Allowance (excess over limit)','Other Benefits (non-taxable portion)'],
    'ph-bir-earn-07': ['Rice Allowance (within ₱2,000/mo)','Clothing Allowance (within ₱6,000/yr)','Medical Allowance (within ₱10,000/yr)','Laundry Allowance (within ₱300/mo)','Achievement Award (within ₱10,000/yr)','Cash Gift (within ₱5,000/yr)','CBA/Productivity Benefit (within ₱10,000/yr)','Meal Allowance – OT/Night (within 25% min wage)'],
    'ph-bir-earn-08': ['Living Allowance','Transportation Allowance','Communication Allowance','Representation Allowance','Other Taxable Allowance'],
    'ph-bir-earn-09': ['Separation Pay','Retirement Pay','Terminal Pay'],
    'ph-bir-earn-10': ['Commission','Sales Commission','Agent Commission'],
    'ph-bir-earn-11': ['Profit Sharing','Year-End Profit Share'],
    'ph-bir-earn-12': ["Director's Fee","Board Director's Fee"],
    'ph-bir-ded-01': ['Withholding Tax on Compensation','Income Tax Withheld'],
    'ph-bir-ded-02': ['SSS Employee Contribution','SSS Premium'],
    'ph-bir-ded-03': ['PhilHealth Employee Contribution','PhilHealth Premium'],
    'ph-bir-ded-04': ['Pag-IBIG Employee Contribution','HDMF Contribution'],
    'ph-bir-con-01': ['SSS Employer Share','SSS Employer Contribution'],
    'ph-bir-con-02': ['PhilHealth Employer Share','PhilHealth Employer Contribution'],
    'ph-bir-con-03': ['Pag-IBIG Employer Share','HDMF Employer Contribution'],
  };

  var PAYSLIP_TYPE_ENDPOINT = {
    earnings:      'payslip-earnings-item',
    deductions:    'payslip-deduction-item',
    contributions: 'payslip-contribution-item',
  };

  // Payslip item -> Manager account field name(s). Earnings post to one
  // expense account; deductions redirect to one liability account; employer
  // contributions need BOTH (employer's cost + amount payable to the agency).
  var PAYSLIP_ACCOUNT_FIELDS = {
    earnings:      { expense: 'expenseAccount' },
    deductions:    { liability: 'account' },
    contributions: { expense: 'expenseAccount', liability: 'liabilityAccount' },
  };

  function mountPayslipItemsSection(container) {
    var caches = {};
    var payrollMap = {};
    var coa = {};
    var accountLinks = {};

    async function refresh() {
      var business = biz();
      if (!business) { container.innerHTML = noBusinessMsg(); return; }
      container.innerHTML = spinner('Loading payslip items...');
      try {
        var results = await Promise.all(
          PAYSLIP_ITEM_TYPES.map(function(t) { return fetchAllBatch('/api4/' + t.endpoint + '-batch', business); })
            .concat([
              getPayrollMapping(business),
              (typeof loadChartOfAccounts === 'function') ? loadChartOfAccounts(business, true) : Promise.resolve({}),
              (typeof getAccountLinkMapping === 'function') ? getAccountLinkMapping(business) : Promise.resolve({}),
            ])
        );
        PAYSLIP_ITEM_TYPES.forEach(function(t, i) {
          caches[t.key] = (results[i] || []).map(function(it) {
            return { key: it.key, value: it.item || {}, displayName: (it.item || {}).name || (it.item || {}).Name || it.key };
          }).sort(function(a, b) { return a.displayName.localeCompare(b.displayName); });
        });
        payrollMap   = results[PAYSLIP_ITEM_TYPES.length] || {};
        coa          = results[PAYSLIP_ITEM_TYPES.length + 1] || {};
        accountLinks = results[PAYSLIP_ITEM_TYPES.length + 2] || {};
      } catch(err) {
        container.innerHTML = '<div class="alert alert-error">Failed: ' + esc(err.message) + '</div>';
        return;
      }
      renderPayslipTables();
    }

    function buildCreatorHTML() {
      var firstType = PAYSLIP_ITEM_TYPES[0];
      var firstCat  = firstType.categories[0] || {};
      var typeOpts = PAYSLIP_ITEM_TYPES.map(function(t) {
        return '<option value="' + esc(t.key) + '">' + esc(t.label) + '</option>';
      }).join('');
      var catOpts = firstType.categories.map(function(c) {
        return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
      }).join('');
      var suggestOpts = (PAYSLIP_SUGGESTED_NAMES[firstCat.id] || []).map(function(s) {
        return '<option value="' + esc(s) + '">' + esc(s) + '</option>';
      }).join('');
      return '<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:18px;">' +
        '<div style="font-size:12px;font-weight:700;color:#0d1b3e;margin-bottom:10px;">➕ Create New Payslip Item</div>' +
        '<div style="font-size:11px;color:#6b7280;margin-bottom:10px;">For items that don\'t exist in Manager yet. Existing items can be mapped using the dropdowns below.</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">' +
          '<div><label style="font-size:11px;font-weight:600;display:block;margin-bottom:3px;">Type</label>' +
            '<select id="psi-type" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;min-width:160px;" onchange="window._psiOnType()">' + typeOpts + '</select></div>' +
          '<div><label style="font-size:11px;font-weight:600;display:block;margin-bottom:3px;">BIR Category</label>' +
            '<select id="psi-cat" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;min-width:220px;" onchange="window._psiOnCat()">' + catOpts + '</select></div>' +
          '<div><label style="font-size:11px;font-weight:600;display:block;margin-bottom:3px;">Item Name</label>' +
            '<select id="psi-name-sel" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;min-width:230px;" onchange="window._psiOnName()">' +
              '<option value="">— pick a name —</option>' + suggestOpts + '<option value="__custom__">✏️ Custom name…</option>' +
            '</select>' +
            '<input id="psi-name-custom" type="text" placeholder="Enter item name" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;width:220px;margin-top:5px;display:none;" /></div>' +
          '<div id="psi-account-fields" style="display:flex;gap:10px;"></div>' +
          '<button class="btn btn-primary" onclick="window._psiCreate()" style="white-space:nowrap;align-self:flex-end;padding:6px 16px;">✦ Create</button>' +
        '</div>' +
        '<div id="psi-msg" style="margin-top:7px;font-size:11px;min-height:14px;"></div>' +
      '</div>';
    }

    function accountFieldHtml(label, id, isPnL) {
      var opts = (typeof COA !== 'undefined') ? COA.accountOptionsHtml(coa, { isPnL: isPnL }) : '<option value="">-- none --</option>';
      return '<div><label style="font-size:11px;font-weight:600;display:block;margin-bottom:3px;">' + esc(label) + '</label>' +
        '<select id="' + id + '" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;min-width:200px;">' + opts + '</select></div>';
    }

    function renderCreatorAccountFields(typeKey) {
      var fields = PAYSLIP_ACCOUNT_FIELDS[typeKey] || {};
      var html = '';
      if (fields.expense) html += accountFieldHtml('Expense Account', 'psi-acct-expense', true);
      if (fields.liability) html += accountFieldHtml('Liability Account', 'psi-acct-liability', false);
      document.getElementById('psi-account-fields').innerHTML = html;
    }

    function renderPayslipTables() {
      var intro = '<p style="font-size:11px;color:#6b7280;margin-bottom:14px;">Assign each payslip item to a BIR reporting category so values flow into 1601C, SAWT, and 2316.</p>';
      container.innerHTML = buildCreatorHTML() + intro + PAYSLIP_ITEM_TYPES.map(function(type) { return renderPayslipTable(type); }).join('');
      container.querySelectorAll('[data-action="save-payslip-item"]').forEach(function(btn) {
        btn.addEventListener('click', onPayslipSave);
      });

      // Wire creator handlers onto window so inline onchange can reach them
      window._psiOnType = function() {
        var typeKey = document.getElementById('psi-type').value;
        var type = PAYSLIP_ITEM_TYPES.find(function(t) { return t.key === typeKey; }) || PAYSLIP_ITEM_TYPES[0];
        document.getElementById('psi-cat').innerHTML = type.categories.map(function(c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
        }).join('');
        renderCreatorAccountFields(typeKey);
        window._psiOnCat();
      };
      renderCreatorAccountFields(PAYSLIP_ITEM_TYPES[0].key);
      window._psiOnCat = function() {
        var cat = document.getElementById('psi-cat').value;
        var suggestions = PAYSLIP_SUGGESTED_NAMES[cat] || [];
        document.getElementById('psi-name-sel').innerHTML =
          '<option value="">— pick a name —</option>' +
          suggestions.map(function(s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('') +
          '<option value="__custom__">✏️ Custom name…</option>';
        document.getElementById('psi-name-custom').style.display = 'none';
        document.getElementById('psi-name-custom').value = '';
      };
      window._psiOnName = function() {
        var v = document.getElementById('psi-name-sel').value;
        document.getElementById('psi-name-custom').style.display = v === '__custom__' ? 'block' : 'none';
      };
      window._psiCreate = async function() {
        var msgEl = document.getElementById('psi-msg');
        var typeKey = document.getElementById('psi-type').value;
        var cat = document.getElementById('psi-cat').value;
        var selVal = document.getElementById('psi-name-sel').value;
        var name = selVal === '__custom__'
          ? (document.getElementById('psi-name-custom').value || '').trim()
          : selVal;
        if (!name) { msgEl.innerHTML = '<span style="color:#c0392b;">Please select or enter a name.</span>'; return; }
        var type = PAYSLIP_ITEM_TYPES.find(function(t) { return t.key === typeKey; });
        if (!type) return;
        var existing = (caches[typeKey] || []).find(function(it) { return (it.value.name || '').toLowerCase() === name.toLowerCase(); });
        if (existing) { msgEl.innerHTML = '<span style="color:#c0392b;">An item named "' + esc(name) + '" already exists.</span>'; return; }
        msgEl.innerHTML = '<span style="color:#6b7280;">Creating…</span>';
        try {
          var template = (caches[typeKey] || [])[0];
          var baseValue = template ? buildSafeValue(template.value, {}) : { inactive: false };
          var createValue = Object.assign({}, baseValue, { name: name });
          delete createValue.reportingCategory;

          var fields = PAYSLIP_ACCOUNT_FIELDS[typeKey] || {};
          var expenseGuid = fields.expense ? (document.getElementById('psi-acct-expense') || {}).value : '';
          var liabilityGuid = fields.liability ? (document.getElementById('psi-acct-liability') || {}).value : '';
          if (fields.expense && expenseGuid) createValue[fields.expense] = expenseGuid;
          if (fields.liability && liabilityGuid) createValue[fields.liability] = liabilityGuid;

          var created = await apiRequest('POST', '/api4/' + type.endpoint, { business: biz(), value: createValue });
          var createdKey = typeof created === 'string' ? created : (created && (created.key || created.Key));

          // Map the new item immediately in our blob
          if (createdKey && cat) {
            payrollMap[createdKey] = cat;
            await savePayrollMapping(biz(), payrollMap);
          }
          if (createdKey) {
            var linkChanged = false;
            if (fields.expense && expenseGuid) { accountLinks['psi:' + createdKey + ':expense'] = expenseGuid; linkChanged = true; }
            if (fields.liability && liabilityGuid) { accountLinks['psi:' + createdKey + ':liability'] = liabilityGuid; linkChanged = true; }
            if (linkChanged) await saveAccountLinkMapping(biz(), accountLinks);
          }

          await refresh();
          showToast('✅ "' + name + '" created and mapped!', 'success');
        } catch(err) {
          msgEl.innerHTML = '<span style="color:#c0392b;">❌ ' + esc(err.message) + '</span>';
        }
      };
    }

    function renderPayslipTable(type) {
      var items = caches[type.key] || [];
      var heading = '<h3 style="margin:16px 0 6px;font-size:13px;font-weight:500;">' + esc(type.label) + '</h3>';
      if (!items.length) return heading + '<p class="muted">No ' + esc(type.label.toLowerCase()) + ' items in this business.</p>';
      var catOpts = '<option value="">-- none --</option>' +
        type.categories.map(function(c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
      var fields = PAYSLIP_ACCOUNT_FIELDS[type.key] || {};
      var hasAccountCols = !!(fields.expense || fields.liability);
      var rows = items.map(function(it, idx) {
        var current = payrollMap[it.key] || '';
        var opts = catOpts.replace('value="' + esc(current) + '"', 'value="' + esc(current) + '" selected');
        var expenseCell = '';
        var liabilityCell = '';
        if (fields.expense) {
          var curExpense = accountLinks['psi:' + it.key + ':expense'] || '';
          var expOpts = (typeof COA !== 'undefined') ? COA.accountOptionsHtml(coa, { isPnL: true, selected: curExpense }) : '<option value="">-- none --</option>';
          expenseCell = '<td style="padding:6px 8px;"><select data-role="acct-expense" style="width:100%;font-size:12px;">' + expOpts + '</select></td>';
        }
        if (fields.liability) {
          var curLiability = accountLinks['psi:' + it.key + ':liability'] || '';
          var liabOpts = (typeof COA !== 'undefined') ? COA.accountOptionsHtml(coa, { isPnL: false, selected: curLiability }) : '<option value="">-- none --</option>';
          liabilityCell = '<td style="padding:6px 8px;"><select data-role="acct-liability" style="width:100%;font-size:12px;">' + liabOpts + '</select></td>';
        }
        return '<tr data-type="' + type.key + '" data-key="' + esc(it.key) + '" data-idx="' + idx + '" style="border-bottom:.5px solid #f3f4f6;">' +
          '<td style="padding:6px 8px;font-size:12px;font-weight:500;">' + esc(it.displayName) + '</td>' +
          '<td style="padding:6px 8px;"><select data-role="cat" style="width:100%;font-size:12px;">' + opts + '</select></td>' +
          expenseCell + liabilityCell +
          '<td style="padding:6px 8px;"><button class="btn btn-primary btn-sm" data-action="save-payslip-item" style="font-size:11px;">Save</button></td>' +
          '</tr>';
      }).join('');
      var expenseHeader = fields.expense ? '<th style="padding:5px 8px;font-weight:500;">Expense Account</th>' : '';
      var liabilityHeader = fields.liability ? '<th style="padding:5px 8px;font-weight:500;">Liability Account</th>' : '';
      return heading +
        '<div style="overflow-x:auto;margin-bottom:8px;"><table style="width:100%;border-collapse:collapse;">' +
        '<thead><tr style="font-size:11px;color:#9ca3af;">' +
        '<th style="text-align:left;padding:5px 8px;font-weight:500;">Item</th>' +
        '<th style="padding:5px 8px;font-weight:500;">BIR Reporting Category</th>' +
        expenseHeader + liabilityHeader +
        '<th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
    }

    async function onPayslipSave(e) {
      var btn = e.currentTarget;
      var row = btn.closest('tr');
      var key = row.dataset.key;
      var typeKey = row.dataset.type;
      var business = biz();
      if (!business || !key) return;
      var newCat = row.querySelector('[data-role="cat"]').value || null;
      var fields = PAYSLIP_ACCOUNT_FIELDS[typeKey] || {};
      var expenseSel = row.querySelector('[data-role="acct-expense"]');
      var liabilitySel = row.querySelector('[data-role="acct-liability"]');
      var expenseGuid = expenseSel ? expenseSel.value : '';
      var liabilityGuid = liabilitySel ? liabilitySel.value : '';
      try {
        if (newCat) {
          payrollMap[key] = newCat;
        } else {
          delete payrollMap[key];
        }
        await savePayrollMapping(business, payrollMap);

        if (fields.expense || fields.liability) {
          var type = PAYSLIP_ITEM_TYPES.find(function(t) { return t.key === typeKey; });
          var item = (caches[typeKey] || []).find(function(it) { return it.key === key; });
          if (type && item) {
            var overrides = {};
            if (fields.expense) overrides[fields.expense] = expenseGuid || null;
            if (fields.liability) overrides[fields.liability] = liabilityGuid || null;
            var putValue = buildSafeValue(item.value, overrides);
            await apiRequest('PUT', '/api4/' + type.endpoint, { business: business, key: key, value: putValue });
          }
          if (fields.expense) {
            if (expenseGuid) accountLinks['psi:' + key + ':expense'] = expenseGuid;
            else delete accountLinks['psi:' + key + ':expense'];
          }
          if (fields.liability) {
            if (liabilityGuid) accountLinks['psi:' + key + ':liability'] = liabilityGuid;
            else delete accountLinks['psi:' + key + ':liability'];
          }
          await saveAccountLinkMapping(business, accountLinks);
        }

        flash(btn, true);
      } catch(err) {
        console.error(err);
        flash(btn, false);
      }
    }

    return { refresh: refresh };
  }

  // ---- GLOBAL HELPERS ----

  window.cfHandleImageUpload = function(fileInput, hiddenId, imgId) {
    var hidden = document.getElementById(hiddenId);
    var img = document.getElementById(imgId);
    var errEl = document.getElementById(hiddenId + '-err');
    if (errEl) errEl.textContent = '';
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type)) {
      if (errEl) errEl.textContent = 'Only PNG or JPEG images are allowed.';
      fileInput.value = '';
      return;
    }
    if (file.size > MAX_SIGNATURE_BYTES) {
      if (errEl) errEl.textContent = 'Image is too large (' + Math.round(file.size / 1024) + ' KB). Max size is ' + Math.round(MAX_SIGNATURE_BYTES / 1024) + ' KB.';
      fileInput.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function() {
      if (hidden) hidden.value = reader.result;
      if (img) { img.src = reader.result; img.style.display = 'block'; }
    };
    reader.onerror = function() {
      if (errEl) errEl.textContent = 'Could not read file.';
    };
    reader.readAsDataURL(file);
  };

  window.cfClearImage = function(hiddenId, imgId) {
    var hidden = document.getElementById(hiddenId);
    var img = document.getElementById(imgId);
    if (hidden) hidden.value = '';
    if (img) { img.src = ''; img.style.display = 'none'; }
  };

  window.cfPartyToggle = function(sel) {
    var tr = sel.closest('tr');
    var isInd = sel.value === 'Individual';
    var dis = function(cls, disabled) {
      tr.querySelectorAll('.' + cls).forEach(function(inp) {
        inp.disabled = disabled;
        inp.style.background = disabled ? '#f1f5f9' : '';
        inp.style.color = disabled ? '#94a3b8' : '';
        if (disabled) inp.value = '';
      });
    };
    dis('cf-corp', isInd);
    dis('cf-ln', !isInd);
    dis('cf-fn', !isInd);
    dis('cf-mn', !isInd);
  };

  window.cfPartyFilter = function(partyType) {
    var searchEl = document.getElementById('cf-' + partyType + '-search');
    var filterEl = document.getElementById('cf-' + partyType + '-filter');
    var q = searchEl ? searchEl.value.toLowerCase() : '';
    var mode = filterEl ? filterEl.value : 'all';
    var shown = 0, total = 0;
    document.querySelectorAll('#cf-' + partyType + '-table tbody tr').forEach(function(tr) {
      total++;
      var name = (tr.querySelector('td:first-child') ? tr.querySelector('td:first-child').textContent : '').toLowerCase();
      var matchesSearch = name.indexOf(q) >= 0;
      var complete = tr.dataset.complete === '1';
      var matchesFilter = mode === 'all' || (mode === 'incomplete' && !complete) || (mode === 'complete' && complete);
      var visible = matchesSearch && matchesFilter;
      tr.style.display = visible ? '' : 'none';
      if (visible) shown++;
    });
    var countEl = document.getElementById('cf-' + partyType + '-count');
    if (countEl) {
      countEl.textContent = (shown === total ? total + ' record' + (total !== 1 ? 's' : '') : shown + ' of ' + total + ' records') + ' — Save per row or use Save All';
    }
  };

  window.cfSavePartyRow = function(btn, pType) {
    var fn = window['cfSavePartyRow_' + pType];
    if (fn) fn(btn);
  };

  window.cfSaveAllParty = function(pType) {
    var fn = window['cfSaveAll_' + pType];
    if (fn) fn();
  };

  // ---- PUBLIC API ----

  window.CF = {
    mountBusiness:     mountBusinessSection,
    mountParty:        mountPartySection,
    mountEmployees:    mountEmployeeSection,
    mountPayslipItems: mountPayslipItemsSection,
    BUSINESS_FIELDS:   BUSINESS_FIELDS,
    PARTY_FIELDS:      PARTY_FIELDS,
    EMPLOYEE_FIELDS:   EMPLOYEE_FIELDS,
    saveEmployeeTaxStatus: saveEmployeeTaxStatus,
  };

})();
