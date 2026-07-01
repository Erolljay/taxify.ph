/* ============================================================
   Tallo CPA - Philippines BIR Extension
   app.js - Tab switching, business selector, report install,
            tax code setup + all mapping sections,
            CF section wiring (lazy mount on tab activate).
   Mirrors AU extension architecture.
   Uses postMessage bridge (apiRequest from shared.js).
   ============================================================ */

// ?? UTILITIES ????????????????????????????????????????????????
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Storage helpers are defined in shared.js (getSetup, saveSetup, getCustomers, etc.)

// ?? BUSINESS SELECTOR ????????????????????????????????????????
var businessSelect = document.getElementById('business');

(async function loadBusinesses() {
  if (!businessSelect) return;
  try {
    var res = await apiRequest('GET', '/api4/businesses');
    var names = (res && res.businesses ? res.businesses : []).map(function(b){ return b.name; }).sort(function(a,b){ return a.localeCompare(b); });
    if (!names.length) {
      businessSelect.innerHTML = '<option value="">(no businesses found)</option>';
      return;
    }
    businessSelect.innerHTML = '<option value="">-- select a business --</option>' +
      names.map(function(n){ return '<option value="'+escHtml(n)+'">'+escHtml(n)+'</option>'; }).join('');
    // Fire immediately with the first available business so tabs don't stall
    businessSelect.value = names[0];
    businessSelect.dispatchEvent(new Event('change'));
    // Then refine to the page-context business (the one Manager is currently showing)
    if (typeof getPageContextBusiness === 'function') {
      getPageContextBusiness().then(function(ctxBiz) {
        if (ctxBiz && names.indexOf(ctxBiz) !== -1 && businessSelect.value !== ctxBiz) {
          businessSelect.value = ctxBiz;
          businessSelect.dispatchEvent(new Event('change'));
        }
      });
    }
  } catch(e) {
    businessSelect.innerHTML = '<option value="">(could not load)</option>';
    console.error(e);
  }
})();

businessSelect && businessSelect.addEventListener('change', function() {
  setupTabLoaded = false; // reset so tax codes reload for new business
  resetCF();
  var active = document.querySelector('.tab.active');
  if (active) activateTab(active.dataset.view);
  // Explicitly refresh the active CF section after mount to ensure data loads
  var view = active ? active.dataset.view : '';
  var sectionMap = { business: 'business', 'payslip-items': 'payslipItems' };
  var section = sectionMap[view];
  if (section && cfControllers[section] && typeof cfControllers[section].refresh === 'function') {
    cfControllers[section].refresh();
  }
});

function currentBiz() { return businessSelect ? businessSelect.value : ''; }

// ?? TAB SWITCHING ????????????????????????????????????????????
var allViews = document.querySelectorAll('[id$="-view"]');
var cfLoaded = {};
var cfControllers = {};
var setupTabLoaded = false;
var coaController = null;

function activateTab(view) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t.dataset.view === view); });
  allViews.forEach(function(v){ v.hidden = v.id !== (view + '-view'); });

  var biz = currentBiz();
  if (view === 'reports')       renderReportsTab(biz);
  if (view === 'setup' && !setupTabLoaded && biz) { setupTabLoaded = true; loadTaxCodesTab(); }
  if (view === 'batch-import-setup') renderBatchImportSetupTab(biz);
  if (view === 'business')      lazyMountCF('business',     biz);
  if (view === 'payslip-items') lazyMountCF('payslipItems', biz);
  if (view === 'coa')           lazyMountCoa();
}

document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){ activateTab(t.dataset.view); });
});

function lazyMountCoa() {
  if (typeof COA === 'undefined') return;
  if (!coaController) {
    coaController = COA.mount(document.getElementById('coa-view'));
  }
  coaController.refresh();
}

function lazyMountCF(section, biz) {
  if (!biz || typeof CF === 'undefined') return;
  var key = biz + '__' + section;
  if (cfLoaded[key]) return;
  cfLoaded[key] = true;

  if (section === 'business') {
    cfControllers.business = CF.mountBusiness(document.getElementById('business-view'));
    cfControllers.business.refresh();
  } else if (section === 'payslipItems') {
    cfControllers.payslipItems = CF.mountPayslipItems(document.getElementById('payslip-items-view'));
    cfControllers.payslipItems.refresh();
  }
}

function resetCF() {
  Object.keys(cfLoaded).forEach(function(k){ delete cfLoaded[k]; });
  cfControllers = {};
  coaController = null;
  ['business-view','coa-view','payslip-items-view'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

// ?? REPORTS TAB ??????????????????????????????????????????????
// All reports are shown regardless of tax type ? user decides what to install.
var _installed = [];

async function renderReportsTab(biz) {
  var container = document.getElementById('report-install-list');
  if (!container) return;
  if (!biz) {
    container.innerHTML = '<p class="muted">Select a business above to see report status.</p>';
    return;
  }
  container.innerHTML = '<div class="status">Loading...</div>';
  try {
    var res = await apiRequest('GET', '/api4/extension-batch?business='+encodeURIComponent(biz)+'&Skip=0&PageSize=200');
    _installed = (res && res.items ? res.items : []).map(function(it){ return { key: it.key, value: it.item || {} }; });
  } catch(e) { _installed = []; }
  buildReportTable(biz, container);
}

function buildReportTable(biz, container) {
  var groups = {};
  REPORTS.forEach(function(r) {
    if (!groups[r.group]) groups[r.group] = [];
    groups[r.group].push(r);
  });

  var html = '';
  Object.keys(groups).forEach(function(group) {
    var list = groups[group];
    var installableInGroup = list.filter(function(r) {
      if (!r.available) return false;
      var ep = reportEndpoint(r);
      return !_installed.find(function(e){ return (e.value.Endpoint || e.value.endpoint) === ep; });
    });
    var installAllBtn = installableInGroup.length > 0
      ? '<button class="secondary" data-action="install-all-group" data-group="'+escHtml(group)+'" style="font-size:11px;margin-left:10px;">Install All</button>'
      : '';
    html += '<h3 style="margin:18px 0 6px;font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;border-bottom:.5px solid #e5e7eb;padding-bottom:4px;display:flex;align-items:center;justify-content:space-between;">'+escHtml(group)+installAllBtn+'</h3>';
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:4px;">';
    html += '<thead><tr style="font-size:11px;color:#9ca3af;"><th style="text-align:left;padding:5px 8px;font-weight:500;">Report</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Status</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Action</th></tr></thead><tbody>';

    list.forEach(function(r) {
      var ep = reportEndpoint(r);
      var inst = _installed.find(function(e){ return (e.value.Endpoint || e.value.endpoint) === ep; });
      var badge, action;
      if (!r.available) {
        var label = r.phase >= 3 ? 'Phase 3' : 'Phase 2';
        badge  = '<span style="font-size:10px;background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:10px;">'+label+'</span>';
        action = '<button class="secondary" disabled style="opacity:.4;font-size:11px;">Install</button>';
      } else if (inst) {
        badge  = '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;">Installed</span>';
        action = '<button class="secondary" data-action="uninstall" data-key="'+escHtml(inst.key)+'" style="font-size:11px;">Uninstall</button>';
      } else {
        badge  = '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;">Not installed</span>';
        action = '<button class="secondary" data-action="install" data-name="'+escHtml(r.name)+'" data-ep="'+escHtml(ep)+'" style="font-size:11px;">Install</button>';
      }
      html += '<tr style="border-bottom:.5px solid #f3f4f6;"><td style="padding:7px 8px;font-size:12px;font-weight:500;">'+escHtml(r.name)+'</td><td style="padding:7px 8px;text-align:center;">'+badge+'</td><td style="padding:7px 8px;text-align:center;">'+action+'</td></tr>';
    });
    html += '</tbody></table>';
  });

  container.innerHTML = html;
  container.querySelectorAll('button[data-action]').forEach(function(btn){
    btn.addEventListener('click', function(){ onReportAction(btn, biz, groups); });
  });
}

async function onReportAction(btn, biz, groups) {
  var action = btn.dataset.action;
  btn.disabled = true;
  if (action === 'install-all-group') {
    btn.textContent = 'Installing...';
    var groupName = btn.dataset.group;
    var list = (groups && groups[groupName]) ? groups[groupName] : [];
    var toInstall = list.filter(function(r) {
      if (!r.available) return false;
      var ep = reportEndpoint(r);
      return !_installed.find(function(e){ return (e.value.Endpoint || e.value.endpoint) === ep; });
    });
    try {
      for (var i = 0; i < toInstall.length; i++) {
        var r = toInstall[i];
        await apiRequest('POST', '/api4/extension', {
          business: biz,
          value: { Name: r.name, Source: 0, Endpoint: reportEndpoint(r), Placement: 'reports' }
        });
      }
      await renderReportsTab(biz);
    } catch(err) {
      btn.disabled = false;
      btn.textContent = 'Install All';
      alert('Failed: ' + err.message);
    }
    return;
  }
  btn.textContent = action === 'install' ? 'Installing...' : 'Uninstalling...';
  try {
    if (action === 'install') {
      await apiRequest('POST', '/api4/extension', {
        business: biz,
        value: { Name: btn.dataset.name, Source: 0, Endpoint: btn.dataset.ep, Placement: 'reports' }
      });
    } else {
      await apiRequest('DELETE', '/api4/extension?business='+encodeURIComponent(biz)+'&key='+encodeURIComponent(btn.dataset.key));
    }
    await renderReportsTab(biz);
  } catch(err) {
    btn.disabled = false;
    btn.textContent = action === 'install' ? 'Install' : 'Uninstall';
    alert('Failed: ' + err.message);
  }
}

// ?? BATCH IMPORT SETUP TAB ???????????????????????????????????
// Installs standalone tools onto specific Manager pages (Sales/Purchase
// Invoices) rather than the generic Reports tab.
var _biInstalled = [];

async function renderBatchImportSetupTab(biz) {
  var container = document.getElementById('batch-import-install-list');
  if (!container) return;
  if (!biz) {
    container.innerHTML = '<p class="muted">Select a business above to see install status.</p>';
    return;
  }
  container.innerHTML = '<div class="status">Loading...</div>';
  try {
    var res = await apiRequest('GET', '/api4/extension-batch?business='+encodeURIComponent(biz)+'&Skip=0&PageSize=200');
    _biInstalled = (res && res.items ? res.items : []).map(function(it){ return { key: it.key, value: it.item || {} }; });
  } catch(e) { _biInstalled = []; }
  buildBatchImportInstallTable(biz, container);
}

function buildBatchImportInstallTable(biz, container) {
  var html = '<table style="width:100%;border-collapse:collapse;margin-bottom:4px;">';
  html += '<thead><tr style="font-size:11px;color:#9ca3af;"><th style="text-align:left;padding:5px 8px;font-weight:500;">Tool</th><th style="padding:5px 8px;font-weight:500;text-align:left;">Placement</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Status</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Action</th></tr></thead><tbody>';

  BATCH_IMPORT_INSTALLS.forEach(function(r) {
    var ep = reportEndpoint(r);
    var inst = _biInstalled.find(function(e){ return (e.value.Endpoint || e.value.endpoint) === ep; });
    var badge, action;
    if (inst) {
      badge  = '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;">Installed</span>';
      action = '<button class="secondary" data-action="uninstall" data-key="'+escHtml(inst.key)+'" style="font-size:11px;">Uninstall</button>';
    } else {
      badge  = '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;">Not installed</span>';
      action = '<button class="secondary" data-action="install" data-name="'+escHtml(r.name)+'" data-ep="'+escHtml(ep)+'" data-placement="'+escHtml(r.placement)+'" style="font-size:11px;">Install</button>';
    }
    html += '<tr style="border-bottom:.5px solid #f3f4f6;"><td style="padding:7px 8px;font-size:12px;font-weight:500;">'+escHtml(r.name)+'</td><td style="padding:7px 8px;font-size:11px;color:#6b7280;">'+escHtml(r.placement)+'</td><td style="padding:7px 8px;text-align:center;">'+badge+'</td><td style="padding:7px 8px;text-align:center;">'+action+'</td></tr>';
  });
  html += '</tbody></table>';

  container.innerHTML = html;
  container.querySelectorAll('button[data-action]').forEach(function(btn){
    btn.addEventListener('click', function(){ onBatchImportAction(btn, biz); });
  });
}

async function onBatchImportAction(btn, biz) {
  var action = btn.dataset.action;
  btn.disabled = true;
  btn.textContent = action === 'install' ? 'Installing...' : 'Uninstalling...';
  try {
    if (action === 'install') {
      await apiRequest('POST', '/api4/extension', {
        business: biz,
        value: { Name: btn.dataset.name, Source: 0, Endpoint: btn.dataset.ep, Placement: btn.dataset.placement }
      });
    } else {
      await apiRequest('DELETE', '/api4/extension?business='+encodeURIComponent(biz)+'&key='+encodeURIComponent(btn.dataset.key));
    }
    await renderBatchImportSetupTab(biz);
  } catch(err) {
    btn.disabled = false;
    btn.textContent = action === 'install' ? 'Install' : 'Uninstall';
    alert('Failed: ' + err.message);
  }
}

// ?? TAX CODES TAB ????????????????????????????????????????????
var _taxCodes = [];
var _tcCoa = {};        // accountGuid -> {key,name,group,isProfitAndLossAccount}
var _tcAccountLinks = {}; // 'tc:<Name>' -> accountGuid

var refreshBtn = document.getElementById('refreshSetup');
if (refreshBtn) refreshBtn.addEventListener('click', loadTaxCodesTab);

// VAT tax codes that can be linked to a specific GL account (Manager otherwise
// posts these to its generic Tax Payable/Receivable control accounts).
var VAT_ACCOUNT_LINKABLE = [
  'Output VAT 12%',
  'Input VAT 12% (Capital Goods)',
  'Input VAT 12% (Other Goods)',
  'Input VAT 12% (Services)',
];

async function loadTaxCodesTab() {
  var biz = currentBiz();
  var out = document.getElementById('setupOutput');
  if (!biz) { out.innerHTML = '<div class="error">Please select a business.</div>'; return; }
  out.innerHTML = '<div class="status">Loading tax codes...</div>';
  try {
    var results = await Promise.all([
      apiRequest('GET', '/api4/tax-code-batch?business='+encodeURIComponent(biz)+'&Skip=0&PageSize=200'),
      (typeof loadChartOfAccounts === 'function') ? loadChartOfAccounts(biz, true) : Promise.resolve({}),
      (typeof getAccountLinkMapping === 'function') ? getAccountLinkMapping(biz) : Promise.resolve({}),
    ]);
    var res = results[0];
    _taxCodes = (res && res.items ? res.items : []).map(function(it){ return { key: it.key, value: it.item || {} }; });
    _tcCoa = results[1] || {};
    _tcAccountLinks = results[2] || {};
  } catch(err) {
    out.innerHTML = '<div class="error">Failed to load: ' + escHtml(err.message) + '</div>';
    return;
  }
  renderTaxCodesOutput(biz, out);
}

// ── TAX CODE GROUP DEFINITIONS ────────────────────────────────
var TC_GROUPS = [
  { key: 'VAT',  label: 'Business Tax Codes — VAT',                        sub: 'Output and input VAT for VAT-registered businesses' },
  { key: 'PT',   label: 'Business Tax Codes — Percentage Tax',             sub: 'PT010, PT040, PT101 — for non-VAT / specific industries' },
  { key: 'EWT',  label: 'EWT / CWT on Income Payments',                   sub: 'Withheld from suppliers (WI/WC series) — Manager rate = 100%' },
  { key: 'GOVT', label: 'EWT / CWT — Government Withheld from You',       sub: 'Final withholding VAT (WV) + PT (WB) — Manager rate = 100%' },
  { key: 'FWT',  label: 'Final Withholding Tax',                          sub: 'Passive income: royalties, interest, dividends — Manager rate = 100%' },
];

function renderTaxCodesOutput(biz, out) {
  // Build name → {key, value} lookup from Manager tax codes
  var tcByName = {};
  _taxCodes.forEach(function(tc) {
    var n = (tc.value.Name || tc.value.name || '').toLowerCase().trim();
    if (n) tcByName[n] = tc;
  });

  var html = '<p style="font-size:11px;color:#6b7280;margin-bottom:16px;">' +
    'All tax codes are pre-defined. Status shows whether each code exists in this business. ' +
    'Click <strong>Create</strong> to add missing codes or <strong>Create All Missing</strong> per group.' +
    '</p>';

  TC_GROUPS.forEach(function(grp) {
    var codes = TAX_CODE_TEMPLATES.filter(function(t){ return t.group === grp.key; });
    if (!codes.length) return;

    var missing = codes.filter(function(t){ return !tcByName[t.Name.toLowerCase().trim()]; });

    html += '<div style="margin-bottom:24px;">';
    html += '<div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:1.5px solid #e5e7eb;padding-bottom:6px;margin-bottom:8px;">';
    html += '<div>';
    html += '<span style="font-size:13px;font-weight:600;color:#1a2f5e;">'+escHtml(grp.label)+'</span>';
    html += '<span style="font-size:11px;color:#9ca3af;margin-left:8px;">'+escHtml(grp.sub)+'</span>';
    html += '</div>';
    if (missing.length) {
      html += '<button class="secondary" data-action="create-group" data-group="'+escHtml(grp.key)+'" style="font-size:11px;padding:3px 10px;">Create All Missing ('+missing.length+')</button>';
    } else {
      html += '<span style="font-size:11px;color:#27ae60;font-weight:500;">✓ All present</span>';
    }
    html += '</div>';

    var hasAccountCol = grp.key === 'VAT';
    html += '<table style="width:100%;border-collapse:collapse;">';
    html += '<thead><tr style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em;">';
    html += '<th style="text-align:left;padding:4px 8px;font-weight:500;">Tax Code Name</th>';
    html += '<th style="padding:4px 8px;font-weight:500;text-align:center;">BIR Rate</th>';
    html += '<th style="padding:4px 8px;font-weight:500;text-align:center;">Manager Rate</th>';
    if (hasAccountCol) html += '<th style="padding:4px 8px;font-weight:500;text-align:left;">GL Account</th>';
    html += '<th style="padding:4px 8px;font-weight:500;text-align:center;">Status</th>';
    html += '<th style="padding:4px 8px;"></th>';
    html += '</tr></thead><tbody>';

    codes.forEach(function(tpl) {
      var match = tcByName[tpl.Name.toLowerCase().trim()];
      var birRateStr  = tpl.birRate > 0 ? tpl.birRate + '%' : '0%';
      var mgrRateStr  = tpl.managerRate === 100 ? '100% *' : tpl.managerRate + '%';
      var badge = match
        ? '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;">✓ Found</span>'
        : '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;">Missing</span>';
      var action = match
        ? '<span style="font-size:11px;color:#9ca3af;">—</span>'
        : '<button class="secondary" data-action="create-tc" data-name="'+escHtml(tpl.Name)+'" data-mgr-rate="'+tpl.managerRate+'" data-group="'+escHtml(tpl.group)+'" style="font-size:11px;padding:3px 10px;">Create</button>';
      html += '<tr style="border-bottom:.5px solid #f3f4f6;" data-tc-name="'+escHtml(tpl.Name)+'" data-tc-mgr-rate="'+tpl.managerRate+'" data-tc-group="'+escHtml(tpl.group)+'" data-tc-key="'+escHtml(match ? match.key : '')+'">';
      html += '<td style="padding:6px 8px;font-size:12px;font-weight:500;">'+escHtml(tpl.Name)+'</td>';
      html += '<td style="padding:6px 8px;font-size:12px;text-align:center;color:#374151;">'+birRateStr+'</td>';
      html += '<td style="padding:6px 8px;font-size:12px;text-align:center;color:'+(tpl.managerRate===100?'#b45309':'#374151')+';">'+mgrRateStr+'</td>';
      if (hasAccountCol) {
        if (VAT_ACCOUNT_LINKABLE.indexOf(tpl.Name) !== -1) {
          var linkKey = 'tc:' + tpl.Name;
          var nativeAccount = (match && match.value && match.value.account) || '';
          var selected = _tcAccountLinks[linkKey] || nativeAccount || '';
          var opts = (typeof COA !== 'undefined') ? COA.accountOptionsHtml(_tcCoa, { isPnL: false, selected: selected }) : '<option value="">-- none --</option>';
          html += '<td style="padding:6px 8px;"><div style="display:flex;gap:4px;">' +
            '<select data-role="tc-account" style="font-size:11px;flex:1;">' + opts + '</select>' +
            '<button class="secondary" data-action="save-tc-account" style="font-size:11px;padding:2px 8px;">Save</button>' +
            '</div></td>';
        } else {
          html += '<td style="padding:6px 8px;font-size:11px;color:#9ca3af;">—</td>';
        }
      }
      html += '<td style="padding:6px 8px;text-align:center;">'+badge+'</td>';
      html += '<td style="padding:6px 8px;text-align:center;">'+action+'</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (grp.key !== 'VAT' && grp.key !== 'PT') {
      html += '<p style="font-size:10px;color:#9ca3af;margin:4px 8px 0;">* Manager rate 100% = line amount entered by accountant IS the withholding tax amount.</p>';
    }
    html += '</div>';
  });

  out.innerHTML = html;

  // Single create
  out.querySelectorAll('[data-action="create-tc"]').forEach(function(btn){
    btn.addEventListener('click', function(){ onCreateTaxCode(btn, biz); });
  });
  // Create all missing in group
  out.querySelectorAll('[data-action="create-group"]').forEach(function(btn){
    btn.addEventListener('click', function(){ onCreateGroupTaxCodes(btn, biz); });
  });
  // Save GL account link for VAT codes
  out.querySelectorAll('[data-action="save-tc-account"]').forEach(function(btn){
    btn.addEventListener('click', function(){ onSaveTcAccount(btn, biz); });
  });
}

// Manager's tax-code schema (confirmed via /openapi/post-tax-code.json):
// fields are lowercase, taxRate/type are integer enums, rate+account are flat
// on the tax code itself — there is no per-component TaxType field.
//   taxRate: 0 = ZeroRate, 1 = TotalRate (withholding pass-through, rate=0),
//            2 = CustomRate (real percentage, e.g. 12)
//   type:    0 = SingleRate (the only type this app creates)
function taxRateEnum(group, managerRate) {
  if (group === 'EWT' || group === 'GOVT' || group === 'FWT') return 0;
  return managerRate > 0 ? 2 : 0;
}

function buildTaxCodeValue(name, managerRate, group, accountGuid) {
  var tr = taxRateEnum(group, managerRate);
  return {
    name: name,
    taxRate: tr,
    type: 0,
    rate: tr === 2 ? managerRate : 0,
    account: accountGuid || null,
  };
}

// Creates a tax code in Manager, then (if a GL account is linked) immediately
// PUTs the account onto the newly-created code's key.
async function createTaxCodeWithAccount(biz, name, mgrRate, group, accountGuid) {
  var created = await apiRequest('POST', '/api4/tax-code', {
    business: biz,
    value: buildTaxCodeValue(name, mgrRate, group, null)
  });
  if (accountGuid) {
    var tcKey = typeof created === 'string' ? created : (created && (created.key || created.Key));
    if (tcKey) {
      await apiRequest('PUT', '/api4/tax-code', {
        business: biz,
        key: tcKey,
        value: buildTaxCodeValue(name, mgrRate, group, accountGuid)
      });
    }
  }
}

async function onCreateTaxCode(btn, biz) {
  var name    = btn.dataset.name;
  var mgrRate = parseFloat(btn.dataset.mgrRate);
  var group   = btn.dataset.group || '';
  var accountGuid = (VAT_ACCOUNT_LINKABLE.indexOf(name) !== -1) ? (_tcAccountLinks['tc:' + name] || null) : null;
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await createTaxCodeWithAccount(biz, name, mgrRate, group, accountGuid);
    await loadTaxCodesTab();
  } catch(err) {
    btn.disabled = false; btn.textContent = 'Create';
    alert('Failed: ' + err.message);
  }
}

async function onCreateGroupTaxCodes(btn, biz) {
  var grpKey  = btn.dataset.group;
  var tcByName = {};
  _taxCodes.forEach(function(tc){
    var n = (tc.value.Name||tc.value.name||'').toLowerCase().trim();
    if (n) tcByName[n] = true;
  });
  var missing = TAX_CODE_TEMPLATES.filter(function(t){
    return t.group === grpKey && !tcByName[t.Name.toLowerCase().trim()];
  });
  if (!missing.length) return;
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    for (var i = 0; i < missing.length; i++) {
      var m = missing[i];
      var accountGuid = (VAT_ACCOUNT_LINKABLE.indexOf(m.Name) !== -1) ? (_tcAccountLinks['tc:' + m.Name] || null) : null;
      await createTaxCodeWithAccount(biz, m.Name, m.managerRate, m.group, accountGuid);
    }
    await loadTaxCodesTab();
  } catch(err) {
    btn.disabled = false; btn.textContent = 'Create All Missing';
    alert('Failed on "'+missing[i]+'": ' + err.message);
  }
}

// Save (or update) the GL account a VAT tax code posts to.
async function onSaveTcAccount(btn, biz) {
  var row = btn.closest('tr');
  var name = row.dataset.tcName;
  var mgrRate = parseFloat(row.dataset.tcMgrRate);
  var group = row.dataset.tcGroup;
  var tcKey = row.dataset.tcKey;
  var accountGuid = row.querySelector('[data-role="tc-account"]').value || null;

  btn.disabled = true; btn.textContent = '…';
  try {
    _tcAccountLinks['tc:' + name] = accountGuid || '';
    if (!accountGuid) delete _tcAccountLinks['tc:' + name];
    await saveAccountLinkMapping(biz, _tcAccountLinks);

    // If the tax code already exists in Manager, also update its account.
    if (tcKey) {
      await apiRequest('PUT', '/api4/tax-code', {
        business: biz,
        key: tcKey,
        value: buildTaxCodeValue(name, mgrRate, group, accountGuid),
      });
    }
    btn.disabled = false; btn.textContent = '✓ Saved';
    setTimeout(function(){ btn.textContent = 'Save'; }, 1400);
  } catch(err) {
    btn.disabled = false; btn.textContent = 'Save';
    alert('Failed: ' + err.message);
  }
}

// placeholder so nothing breaks if old ref exists
async function onSaveMapping() {}

