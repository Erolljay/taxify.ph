/* ============================================================
   Txform Now! — app shell logic
   Settings mode: ported from app.js, but resolves a single business via
   getReportBusiness() instead of a manual <select id="business">, since
   each Txform Now! install is scoped to one business.
   User mode: category-card landing screen + StepEngine workflows.
   ============================================================ */

let biz = '';
let setup = null;

// ── SIDENAV (Data Intake / VAT / Expanded / Compensation / Income / Annual / Settings) ──
let _settingsActivated = false;

function goToNav(key) {
  document.querySelectorAll('.tfy-nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === key));
  const isSettings   = key === 'settings';
  const isDataIntake = key === 'data-intake';
  const isMonthEnd   = key === 'month-end';
  document.getElementById('settings-mode').hidden     = !isSettings;
  document.getElementById('data-intake-mode').hidden  = !isDataIntake;
  document.getElementById('month-end-mode').hidden    = !isMonthEnd;
  document.getElementById('user-mode').hidden         = isSettings || isDataIntake || isMonthEnd;

  if (isSettings) {
    if (!_settingsActivated) { _settingsActivated = true; activateTab('welcome'); }
    return;
  }
  if (isDataIntake) { renderDataIntake(); return; }
  if (isMonthEnd)   { renderMonthEndPrep(); return; }

  if (key === 'income') _userActiveCategory = workflowKeyForIncomeTax();
  else _userActiveCategory = key; // vat / expanded / compensation / annual
  renderUserMode();
}

document.querySelectorAll('.tfy-nav-item').forEach(b => {
  b.addEventListener('click', () => goToNav(b.dataset.nav));
});

// ── SETTINGS MODE: TAB SWITCHING ──────────────────────────────
const allViews = document.querySelectorAll('[id$="-view"]');
const cfLoaded = {};
const cfControllers = {};
let setupTabLoaded = false;
let coaTabLoaded = false;
let coaController = null;

function activateTab(view) {
  document.querySelectorAll('#settings-mode .tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  allViews.forEach(v => { v.hidden = v.id !== (view + '-view'); });

  if (view === 'reports')            renderReportsTab(biz);
  if (view === 'setup' && !setupTabLoaded) { setupTabLoaded = true; loadTaxCodesTab(); }
  if (view === 'batch-import-setup') renderBatchImportSetupTab(biz);
  if (view === 'business')           lazyMountCF('business', biz);
  if (view === 'payslip-items')      lazyMountCF('payslipItems', biz);
  if (view === 'coa')                lazyMountCoa(biz);
}

document.querySelectorAll('#settings-mode .tab').forEach(t => {
  t.addEventListener('click', () => activateTab(t.dataset.view));
});

function lazyMountCoa(b) {
  if (!b || typeof COA === 'undefined' || coaTabLoaded) return;
  coaTabLoaded = true;
  coaController = COA.mount(document.getElementById('coa-view'));
  coaController.refresh();
}

function lazyMountCF(section, b) {
  if (!b || typeof CF === 'undefined') return;
  const key = b + '__' + section;
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

// ── REPORTS TAB (raw extension install management) ────────────
let _installed = [];

async function renderReportsTab(b) {
  const container = document.getElementById('report-install-list');
  if (!container || !b) return;
  container.innerHTML = '<div class="status">Loading...</div>';
  try {
    const res = await apiRequest('GET', '/api4/extension-batch?business=' + encodeURIComponent(b) + '&Skip=0&PageSize=200');
    _installed = (res?.items || []).map(it => ({ key: it.key, value: it.item || {} }));
  } catch (e) { _installed = []; }
  buildReportTable(b, container);
}

function buildReportTable(b, container) {
  const groups = {};
  REPORTS.forEach(r => { (groups[r.group] = groups[r.group] || []).push(r); });

  let html = '';
  Object.keys(groups).forEach(group => {
    const list = groups[group];
    const installable = list.filter(r =>
      r.available && !_installed.find(e => (e.value.Endpoint || e.value.endpoint) === reportEndpoint(r))
    );
    const installAllBtn = installable.length > 0
      ? `<button class="secondary install-all-btn" data-group="${escHtml(group)}" style="font-size:11px;padding:3px 10px;">Install All</button>`
      : '';
    html += `<div style="display:flex;align-items:center;justify-content:space-between;margin:18px 0 6px;border-bottom:.5px solid #e5e7eb;padding-bottom:4px;">`;
    html += `<h3 style="margin:0;font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;">${escHtml(group)}</h3>`;
    html += installAllBtn + '</div>';
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:4px;">';
    html += '<thead><tr style="font-size:11px;color:#9ca3af;"><th style="text-align:left;padding:5px 8px;font-weight:500;">Report</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Status</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Action</th></tr></thead><tbody>';
    list.forEach(r => {
      const ep = reportEndpoint(r);
      const inst = _installed.find(e => (e.value.Endpoint || e.value.endpoint) === ep);
      let badge, action;
      if (!r.available) {
        const label = r.phase >= 3 ? 'Phase 3' : 'Phase 2';
        badge = `<span style="font-size:10px;background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:10px;">${label}</span>`;
        action = '<button class="secondary" disabled style="opacity:.4;font-size:11px;">Install</button>';
      } else if (inst) {
        badge = '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;">Installed</span>';
        action = `<button class="secondary" data-action="uninstall" data-key="${escHtml(inst.key)}" style="font-size:11px;">Uninstall</button>`;
      } else {
        badge = '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;">Not installed</span>';
        action = `<button class="secondary" data-action="install" data-name="${escHtml(r.name)}" data-ep="${escHtml(ep)}" style="font-size:11px;">Install</button>`;
      }
      html += `<tr style="border-bottom:.5px solid #f3f4f6;"><td style="padding:7px 8px;font-size:12px;font-weight:500;">${escHtml(r.name)}</td><td style="padding:7px 8px;text-align:center;">${badge}</td><td style="padding:7px 8px;text-align:center;">${action}</td></tr>`;
    });
    html += '</tbody></table>';
  });

  container.innerHTML = html;
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onReportAction(btn, b));
  });
  container.querySelectorAll('.install-all-btn').forEach(btn => {
    btn.addEventListener('click', () => onInstallAllGroup(btn, b));
  });
}

async function onInstallAllGroup(btn, b) {
  const group = btn.dataset.group;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  const toInstall = REPORTS.filter(r =>
    r.group === group && r.available &&
    !_installed.find(e => (e.value.Endpoint || e.value.endpoint) === reportEndpoint(r))
  );
  let failed = 0;
  for (const r of toInstall) {
    try {
      await apiRequest('POST', '/api4/extension', {
        business: b,
        value: { Name: r.name, Source: 0, Endpoint: reportEndpoint(r), Placement: 'reports' }
      });
    } catch { failed++; }
  }
  await renderReportsTab(b);
  if (failed) alert(`${failed} report(s) failed to install.`);
}

async function onReportAction(btn, b) {
  const action = btn.dataset.action;
  btn.disabled = true;
  btn.textContent = action === 'install' ? 'Installing...' : 'Uninstalling...';
  try {
    if (action === 'install') {
      await apiRequest('POST', '/api4/extension', {
        business: b,
        value: { Name: btn.dataset.name, Source: 0, Endpoint: btn.dataset.ep, Placement: 'reports' }
      });
    } else {
      await apiRequest('DELETE', '/api4/extension?business=' + encodeURIComponent(b) + '&key=' + encodeURIComponent(btn.dataset.key));
    }
    await renderReportsTab(b);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = action === 'install' ? 'Install' : 'Uninstall';
    alert('Failed: ' + err.message);
  }
}

// ── BATCH IMPORT SETUP TAB ─────────────────────────────────────
let _biInstalled = [];

async function renderBatchImportSetupTab(b) {
  const container = document.getElementById('batch-import-install-list');
  if (!container || !b) return;
  container.innerHTML = '<div class="status">Loading...</div>';
  try {
    const res = await apiRequest('GET', '/api4/extension-batch?business=' + encodeURIComponent(b) + '&Skip=0&PageSize=200');
    _biInstalled = (res?.items || []).map(it => ({ key: it.key, value: it.item || {} }));
  } catch (e) { _biInstalled = []; }
  buildBatchImportInstallTable(b, container);
}

function buildBatchImportInstallTable(b, container) {
  let html = '<table style="width:100%;border-collapse:collapse;margin-bottom:4px;">';
  html += '<thead><tr style="font-size:11px;color:#9ca3af;"><th style="text-align:left;padding:5px 8px;font-weight:500;">Tool</th><th style="padding:5px 8px;font-weight:500;text-align:left;">Placement</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Status</th><th style="padding:5px 8px;font-weight:500;text-align:center;">Action</th></tr></thead><tbody>';
  BATCH_IMPORT_INSTALLS.forEach(r => {
    const ep = reportEndpoint(r);
    const inst = _biInstalled.find(e => (e.value.Endpoint || e.value.endpoint) === ep);
    let badge, action;
    if (inst) {
      badge = '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;">Installed</span>';
      action = `<button class="secondary" data-action="uninstall" data-key="${escHtml(inst.key)}" style="font-size:11px;">Uninstall</button>`;
    } else {
      badge = '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;">Not installed</span>';
      action = `<button class="secondary" data-action="install" data-name="${escHtml(r.name)}" data-ep="${escHtml(ep)}" data-placement="${escHtml(r.placement)}" style="font-size:11px;">Install</button>`;
    }
    html += `<tr style="border-bottom:.5px solid #f3f4f6;"><td style="padding:7px 8px;font-size:12px;font-weight:500;">${escHtml(r.name)}</td><td style="padding:7px 8px;font-size:11px;color:#6b7280;">${escHtml(r.placement)}</td><td style="padding:7px 8px;text-align:center;">${badge}</td><td style="padding:7px 8px;text-align:center;">${action}</td></tr>`;
  });
  html += '</tbody></table>';

  container.innerHTML = html;
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onBatchImportAction(btn, b));
  });
}

async function onBatchImportAction(btn, b) {
  const action = btn.dataset.action;
  btn.disabled = true;
  btn.textContent = action === 'install' ? 'Installing...' : 'Uninstalling...';
  try {
    if (action === 'install') {
      await apiRequest('POST', '/api4/extension', {
        business: b,
        value: { Name: btn.dataset.name, Source: 0, Endpoint: btn.dataset.ep, Placement: btn.dataset.placement }
      });
    } else {
      await apiRequest('DELETE', '/api4/extension?business=' + encodeURIComponent(b) + '&key=' + encodeURIComponent(btn.dataset.key));
    }
    await renderBatchImportSetupTab(b);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = action === 'install' ? 'Install' : 'Uninstall';
    alert('Failed: ' + err.message);
  }
}

// ── TAX CODES TAB ───────────────────────────────────────────────
let _taxCodes = [];
let _tcCoa = {};
let _tcAccountLinks = {};

const refreshBtn = document.getElementById('refreshSetup');
if (refreshBtn) refreshBtn.addEventListener('click', loadTaxCodesTab);

const VAT_ACCOUNT_LINKABLE = [
  'Output VAT 12%',
  'Input VAT 12% (Capital Goods)',
  'Input VAT 12% (Other Goods)',
  'Input VAT 12% (Services)',
];

async function loadTaxCodesTab() {
  const out = document.getElementById('setupOutput');
  if (!biz) { out.innerHTML = '<div class="error">Business not detected yet.</div>'; return; }
  out.innerHTML = '<div class="status">Loading tax codes...</div>';
  try {
    const results = await Promise.all([
      apiRequest('GET', '/api4/tax-code-batch?business=' + encodeURIComponent(biz) + '&Skip=0&PageSize=200'),
      (typeof loadChartOfAccounts === 'function') ? loadChartOfAccounts(biz, true) : Promise.resolve({}),
      (typeof getAccountLinkMapping === 'function') ? getAccountLinkMapping(biz) : Promise.resolve({}),
      loadTaxRatesData(),
    ]);
    const res = results[0];
    _taxCodes = (res?.items || []).map(it => ({ key: it.key, value: it.item || {} }));
    _tcCoa = results[1] || {};
    _tcAccountLinks = results[2] || {};
  } catch (err) {
    out.innerHTML = '<div class="error">Failed to load: ' + escHtml(err.message) + '</div>';
    return;
  }
  renderTaxCodesOutput(biz, out);
}

const TC_GROUPS = [
  { key: 'VAT',  label: 'Business Tax Codes — VAT',                  sub: 'Output and input VAT for VAT-registered businesses' },
  { key: 'PT',   label: 'Business Tax Codes — Percentage Tax',       sub: 'PT010, PT040, PT101 — for non-VAT / specific industries' },
  { key: 'EWT',  label: 'EWT / CWT on Income Payments',              sub: 'Withheld from suppliers (WI/WC series) — Manager rate = 100%' },
  { key: 'GOVT', label: 'EWT / CWT — Government Withheld from You',  sub: 'Final withholding VAT (WV) + PT (WB) — Manager rate = 100%' },
  { key: 'FWT',  label: 'Final Withholding Tax',                     sub: 'Passive income: royalties, interest, dividends — Manager rate = 100%' },
];

function renderTaxCodesOutput(b, out) {
  const tcByName = {};
  _taxCodes.forEach(tc => {
    const n = (tc.value.Name || tc.value.name || '').toLowerCase().trim();
    if (n) tcByName[n] = tc;
  });

  let html = '<p style="font-size:11px;color:#6b7280;margin-bottom:16px;">' +
    'All tax codes are pre-defined. Status shows whether each code exists in this business. ' +
    'Click <strong>Create</strong> to add missing codes or <strong>Create All Missing</strong> per group.' +
    '</p>';

  const taxCodeTemplates = buildTaxCodeTemplates();
  TC_GROUPS.forEach(grp => {
    const codes = taxCodeTemplates.filter(t => t.group === grp.key);
    if (!codes.length) return;
    const missing = codes.filter(t => !tcByName[t.Name.toLowerCase().trim()]);

    html += '<div style="margin-bottom:24px;">';
    html += '<div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:1.5px solid #e5e7eb;padding-bottom:6px;margin-bottom:8px;">';
    html += '<div>';
    html += `<span style="font-size:13px;font-weight:600;color:#1a2f5e;">${escHtml(grp.label)}</span>`;
    html += `<span style="font-size:11px;color:#9ca3af;margin-left:8px;">${escHtml(grp.sub)}</span>`;
    html += '</div>';
    if (missing.length) {
      html += `<button class="secondary" data-action="create-group" data-group="${escHtml(grp.key)}" style="font-size:11px;padding:3px 10px;">Create All Missing (${missing.length})</button>`;
    } else {
      html += '<span style="font-size:11px;color:#27ae60;font-weight:500;">✓ All present</span>';
    }
    html += '</div>';

    const hasAccountCol = grp.key === 'VAT';
    html += '<table style="width:100%;border-collapse:collapse;">';
    html += '<thead><tr style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em;">';
    html += '<th style="text-align:left;padding:4px 8px;font-weight:500;">Tax Code Name</th>';
    html += '<th style="padding:4px 8px;font-weight:500;text-align:center;">BIR Rate</th>';
    html += '<th style="padding:4px 8px;font-weight:500;text-align:center;">Manager Rate</th>';
    if (hasAccountCol) html += '<th style="padding:4px 8px;font-weight:500;text-align:left;">GL Account</th>';
    html += '<th style="padding:4px 8px;font-weight:500;text-align:center;">Status</th>';
    html += '<th style="padding:4px 8px;"></th>';
    html += '</tr></thead><tbody>';

    codes.forEach(tpl => {
      const match = tcByName[tpl.Name.toLowerCase().trim()];
      const birRateStr = tpl.birRate > 0 ? tpl.birRate + '%' : '0%';
      const mgrRateStr = tpl.managerRate === 100 ? '100% *' : tpl.managerRate + '%';
      const badge = match
        ? '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;">✓ Found</span>'
        : '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;">Missing</span>';
      const action = match
        ? '<span style="font-size:11px;color:#9ca3af;">—</span>'
        : `<button class="secondary" data-action="create-tc" data-name="${escHtml(tpl.Name)}" data-mgr-rate="${tpl.managerRate}" data-group="${escHtml(tpl.group)}" style="font-size:11px;padding:3px 10px;">Create</button>`;
      html += `<tr style="border-bottom:.5px solid #f3f4f6;" data-tc-name="${escHtml(tpl.Name)}" data-tc-mgr-rate="${tpl.managerRate}" data-tc-group="${escHtml(tpl.group)}" data-tc-key="${escHtml(match ? match.key : '')}">`;
      html += `<td style="padding:6px 8px;font-size:12px;font-weight:500;">${escHtml(tpl.Name)}</td>`;
      html += `<td style="padding:6px 8px;font-size:12px;text-align:center;color:#374151;">${birRateStr}</td>`;
      html += `<td style="padding:6px 8px;font-size:12px;text-align:center;color:${tpl.managerRate === 100 ? '#b45309' : '#374151'};">${mgrRateStr}</td>`;
      if (hasAccountCol) {
        if (VAT_ACCOUNT_LINKABLE.indexOf(tpl.Name) !== -1) {
          const linkKey = 'tc:' + tpl.Name;
          const nativeAccount = (match && match.value && match.value.account) || '';
          const selected = _tcAccountLinks[linkKey] || nativeAccount || '';
          const opts = (typeof COA !== 'undefined') ? COA.accountOptionsHtml(_tcCoa, { isPnL: false, selected }) : '<option value="">-- none --</option>';
          html += `<td style="padding:6px 8px;"><div style="display:flex;gap:4px;">
            <select data-role="tc-account" style="font-size:11px;flex:1;">${opts}</select>
            <button class="secondary" data-action="save-tc-account" style="font-size:11px;padding:2px 8px;">Save</button>
            </div></td>`;
        } else {
          html += '<td style="padding:6px 8px;font-size:11px;color:#9ca3af;">—</td>';
        }
      }
      html += `<td style="padding:6px 8px;text-align:center;">${badge}</td>`;
      html += `<td style="padding:6px 8px;text-align:center;">${action}</td>`;
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (grp.key !== 'VAT' && grp.key !== 'PT') {
      html += '<p style="font-size:10px;color:#9ca3af;margin:4px 8px 0;">* Manager rate 100% = line amount entered by accountant IS the withholding tax amount.</p>';
    }
    html += '</div>';
  });

  out.innerHTML = html;
  out.querySelectorAll('[data-action="create-tc"]').forEach(btn => btn.addEventListener('click', () => onCreateTaxCode(btn, b)));
  out.querySelectorAll('[data-action="create-group"]').forEach(btn => btn.addEventListener('click', () => onCreateGroupTaxCodes(btn, b)));
  out.querySelectorAll('[data-action="save-tc-account"]').forEach(btn => btn.addEventListener('click', () => onSaveTcAccount(btn, b)));
}

function taxRateEnum(group, managerRate) {
  if (group === 'EWT' || group === 'GOVT' || group === 'FWT') return 0;
  return managerRate > 0 ? 2 : 0;
}

function buildTaxCodeValue(name, managerRate, group, accountGuid) {
  const tr = taxRateEnum(group, managerRate);
  return {
    name,
    taxRate: tr,
    type: 0,
    rate: tr === 2 ? managerRate : 0,
    account: accountGuid || null,
  };
}

async function createTaxCodeWithAccount(b, name, mgrRate, group, accountGuid) {
  const created = await apiRequest('POST', '/api4/tax-code', {
    business: b,
    value: buildTaxCodeValue(name, mgrRate, group, null)
  });
  if (accountGuid) {
    const tcKey = typeof created === 'string' ? created : (created?.key || created?.Key);
    if (tcKey) {
      await apiRequest('PUT', '/api4/tax-code', {
        business: b,
        key: tcKey,
        value: buildTaxCodeValue(name, mgrRate, group, accountGuid)
      });
    }
  }
}

async function onCreateTaxCode(btn, b) {
  const name = btn.dataset.name;
  const mgrRate = parseFloat(btn.dataset.mgrRate);
  const group = btn.dataset.group || '';
  const accountGuid = VAT_ACCOUNT_LINKABLE.indexOf(name) !== -1 ? (_tcAccountLinks['tc:' + name] || null) : null;
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await createTaxCodeWithAccount(b, name, mgrRate, group, accountGuid);
    await loadTaxCodesTab();
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Create';
    alert('Failed: ' + err.message);
  }
}

async function onCreateGroupTaxCodes(btn, b) {
  const grpKey = btn.dataset.group;
  const tcByName = {};
  _taxCodes.forEach(tc => {
    const n = (tc.value.Name || tc.value.name || '').toLowerCase().trim();
    if (n) tcByName[n] = true;
  });
  await loadTaxRatesData();
  const missing = buildTaxCodeTemplates().filter(t => t.group === grpKey && !tcByName[t.Name.toLowerCase().trim()]);
  if (!missing.length) return;
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    for (const m of missing) {
      const accountGuid = VAT_ACCOUNT_LINKABLE.indexOf(m.Name) !== -1 ? (_tcAccountLinks['tc:' + m.Name] || null) : null;
      await createTaxCodeWithAccount(b, m.Name, m.managerRate, m.group, accountGuid);
    }
    await loadTaxCodesTab();
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Create All Missing';
    alert('Failed: ' + err.message);
  }
}

async function onSaveTcAccount(btn, b) {
  const row = btn.closest('tr');
  const name = row.dataset.tcName;
  const mgrRate = parseFloat(row.dataset.tcMgrRate);
  const group = row.dataset.tcGroup;
  const tcKey = row.dataset.tcKey;
  const accountGuid = row.querySelector('[data-role="tc-account"]').value || null;

  btn.disabled = true; btn.textContent = '…';
  try {
    _tcAccountLinks['tc:' + name] = accountGuid || '';
    if (!accountGuid) delete _tcAccountLinks['tc:' + name];
    await saveAccountLinkMapping(b, _tcAccountLinks);
    if (tcKey) {
      await apiRequest('PUT', '/api4/tax-code', {
        business: b,
        key: tcKey,
        value: buildTaxCodeValue(name, mgrRate, group, accountGuid),
      });
    }
    btn.disabled = false; btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = 'Save'; }, 1400);
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Save';
    alert('Failed: ' + err.message);
  }
}

// dtkDate — date helper retained for enumerateWorkflowPeriods. The Deadline
// Tracker that used to live here was removed (2026-07-15): deadlines now
// surface on each category’s Filings overview via due dates + Overdue pills.
function dtkDate(y, m, d) {
  return new Date(y, m - 1, d);
}


// ── USER MODE: CATEGORY CARDS + STEP ENGINE ────────────────────
let _userActiveCategory = null;
let _stepEngineHandle = null;

function workflowKeyForIncomeTax() {
  if (setup && setup.classification === 'Individual') return 'individual';
  return 'nonindividual';
}

// Annual Filing items open a single report page directly (their own year
// picker lives inside the report). Value is a function so classification is
// read at click time.
const ANNUAL_REPORTS = {
  'annual-itr':   () => (setup && setup.classification === 'Individual') ? '1701.html' : '1702rt.html',
  'annual-1604c': () => 'alphalist.html',
};

// Nav items that are placeholders for now (no report page built yet).
const PLACEHOLDER_SCREENS = {
  'annual-1604e': {
    title: '1604-E — Annual Alphalist of Payees',
    body: `The annual alphalist of income payments subject to expanded withholding isn't generated in Txform
      yet. For now, compile it from your quarterly QAP data and file it directly in eFPS / eBIRForms.
      <em>A dedicated 1604-E report is on the roadmap.</em>`,
  },
  'annual-inventory': {
    title: 'Annual Inventory List',
    body: `<strong>Only if this client maintains inventory.</strong> The annual Inventory List (due January 30)
      isn't generated in Txform yet — export your closing inventory from Manager and file it with the RDO in the
      BIR's prescribed format. <em>A dedicated Inventory List report is on the roadmap.</em>`,
  },
};

function renderUserMode() {
  const root = document.getElementById('user-mode');
  const key = _userActiveCategory;
  if (ANNUAL_REPORTS[key])       { renderEmbeddedReport(root, ANNUAL_REPORTS[key]()); return; }
  if (PLACEHOLDER_SCREENS[key])  { renderPlaceholder(root, PLACEHOLDER_SCREENS[key]); return; }
  renderWorkflowScreen(root, key);
}

// Embed a standalone report page full-width (passes ?biz= so it skips
// Manager's page-context lookup, same as the Data Intake iframes).
function renderEmbeddedReport(root, file) {
  const src = `${file}${file.includes('?') ? '&' : '?'}${new URLSearchParams({ biz }).toString()}`;
  root.innerHTML = `<div class="tfy-di-panel"><iframe class="tfy-di-iframe" src="${escHtml(src)}"></iframe></div>`;
}

function renderPlaceholder(root, screen) {
  root.innerHTML = `
    <div class="tfy-ov">
      <div class="tfy-ov-head"><div class="tfy-ov-title">${escHtml(screen.title)}</div></div>
      <div class="tfy-ov-help">${screen.body}</div>
    </div>`;
}

let _ovFilter = 'all';
let _ovArchiveYear = null; // selected year for the Archived tab (past years)

// The set of filing periods a workflow files, each with its BIR due date, so
// the overview can show status + sort by recency. Bounded to a window around
// today so the list stays scannable.
function enumerateWorkflowPeriods(workflowKey, today) {
  const y = today.getFullYear();
  // Include a few past years so the Archived tab has history to browse.
  const years = [y - 3, y - 2, y - 1, y, y + 1];
  const out = [];
  const push = (ptype, year, period, form, dueDate) => out.push({ period: { ptype, year, period }, form, dueDate });

  if (workflowKey === 'vat') {
    const due = { 1: [4, 25], 2: [7, 25], 3: [10, 25], 4: [1, 25] };
    years.forEach(yr => [1, 2, 3, 4].forEach(q => {
      const [dm, dd] = due[q]; push('quarterly', yr, q, '2550Q', dtkDate(q === 4 ? yr + 1 : yr, dm, dd));
    }));
  } else if (workflowKey === 'expanded') {
    const dueQ = { 1: [4, 30], 2: [7, 31], 3: [10, 31], 4: [1, 31] };
    years.forEach(yr => [1, 2, 3, 4].forEach(q => {
      const [dm, dd] = dueQ[q]; push('quarterly', yr, q, '1601EQ', dtkDate(q === 4 ? yr + 1 : yr, dm, dd));
    }));
    years.forEach(yr => { for (let m = 0; m < 12; m++) push('monthly', yr, m, '0619E', dtkDate(m === 11 ? yr + 1 : yr, m === 11 ? 1 : m + 2, m === 11 ? 15 : 10)); });
  } else if (workflowKey === 'compensation') {
    years.forEach(yr => { for (let m = 0; m < 12; m++) push('monthly', yr, m, '1601C', dtkDate(m === 11 ? yr + 1 : yr, m === 11 ? 1 : m + 2, m === 11 ? 15 : 10)); });
  } else if (workflowKey === 'individual') {
    const dueQ = { 1: [5, 15], 2: [8, 15], 3: [11, 15] };
    years.forEach(yr => [1, 2, 3].forEach(q => { const [dm, dd] = dueQ[q]; push('quarterly', yr, q, '1701Q', dtkDate(yr, dm, dd)); }));
  } else if (workflowKey === 'nonindividual') {
    const dueQ = { 1: [5, 30], 2: [8, 29], 3: [11, 29] };
    years.forEach(yr => [1, 2, 3].forEach(q => { const [dm, dd] = dueQ[q]; push('quarterly', yr, q, '1702Q', dtkDate(yr, dm, dd)); }));
  }
  return out;
}

// Entry screen for a tax category: a status dashboard of filing periods
// (Draft / Filed / Amended / Overdue). Clicking a period opens its filing.
function renderWorkflowScreen(root, workflowKey) {
  const workflow = WORKFLOWS[workflowKey];
  if (!workflow) {
    root.innerHTML = '<div class="tfy-ov"><p class="muted">This workflow isn\'t configured yet.</p></div>';
    return;
  }
  renderWorkflowOverview(root, workflowKey);
}

async function renderWorkflowOverview(root, workflowKey) {
  const workflow = WORKFLOWS[workflowKey];
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // The tabs scope by year now (All = this year, Archived = a past year), so
  // enumerate every period and let the tab filter below narrow it.
  const periods = enumerateWorkflowPeriods(workflowKey, today)
    .sort((a, b) => b.dueDate - a.dueDate);

  root.innerHTML = `
    <div class="tfy-ov">
      <div class="tfy-ov-head"><div class="tfy-ov-title">${escHtml(workflow.label)} — Filings</div></div>
      <div class="tfy-ov-help">Pick a period to prepare, file, or review. Filing a period <strong>freezes</strong> its figures so later book edits don't change the filed return.</div>
      <div id="tfy-ov-note"></div>
      <div class="tfy-ov-filter-bar" id="tfy-ov-filter"></div>
      <div class="tfy-ov-grid" id="tfy-ov-grid"><div class="status">Loading filing status…</div></div>
    </div>`;

  // Real filed status (server-only). No session → drafts still work; show a note.
  let filedIndex = {};
  let authNote = false;
  if (typeof FilingStore !== 'undefined') {
    try {
      const filings = await FilingStore.loadBusinessFilings(biz);
      (filings || []).forEach(f => { filedIndex[f.period_key] = f; });
    } catch (e) {
      if (e && e.isAuthError) authNote = true;
    }
  }

  const noteEl = root.querySelector('#tfy-ov-note');
  if (noteEl && authNote) {
    noteEl.innerHTML = `<div class="alert alert-warn" style="margin-bottom:14px;">🔑 Sign in at <a href="https://txform.ph/account" target="_blank" rel="noopener">txform.ph/account</a> to freeze filings and track which periods are filed. You can still prepare drafts without signing in.</div>`;
  }

  const rows = periods.map(p => {
    const pk = FilingCore.periodKey(p.period);
    const filing = filedIndex[pk] || null;
    let status;
    if (filing) status = (filing.version > 1) ? 'amended' : 'filed';
    else status = (p.dueDate < today) ? 'overdue' : 'draft';
    return { p, pk, filing, status };
  });

  const currentYear = today.getFullYear();
  // Past years that actually have periods, newest first — the Archived picker.
  const archiveYears = [...new Set(rows.map(r => r.p.period.year).filter(yr => yr < currentYear))].sort((a, b) => b - a);
  if (_ovArchiveYear === null || !archiveYears.includes(_ovArchiveYear)) {
    _ovArchiveYear = archiveYears.length ? archiveYears[0] : currentYear - 1;
  }

  const filterDefs = { all: 'All', needed: 'Needs filing', filed: 'Filed', archived: 'Archived' };
  const filterBar = root.querySelector('#tfy-ov-filter');
  const yearPicker = _ovFilter === 'archived' && archiveYears.length
    ? `<select id="tfy-ov-year" style="margin-left:8px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;">${archiveYears.map(yr => `<option value="${yr}"${yr === _ovArchiveYear ? ' selected' : ''}>${yr}</option>`).join('')}</select>`
    : '';
  filterBar.innerHTML = Object.entries(filterDefs).map(([k, lbl]) =>
    `<button class="dtk-filter-btn${_ovFilter === k ? ' active' : ''}" data-ovf="${k}">${escHtml(lbl)}</button>`).join('') + yearPicker;
  filterBar.querySelectorAll('[data-ovf]').forEach(b => b.addEventListener('click', () => { _ovFilter = b.dataset.ovf; renderWorkflowOverview(root, workflowKey); }));
  const yearSel = filterBar.querySelector('#tfy-ov-year');
  if (yearSel) yearSel.addEventListener('change', () => { _ovArchiveYear = parseInt(yearSel.value, 10); renderWorkflowOverview(root, workflowKey); });

  // All / Needs filing / Filed scope to the current year; Archived shows a
  // chosen past year (any status).
  const isFiled = (r) => r.status === 'filed' || r.status === 'amended';
  const isNeeded = (r) => r.status === 'draft' || r.status === 'overdue';
  const shown = rows.filter(r => {
    if (_ovFilter === 'archived') return r.p.period.year === _ovArchiveYear;
    if (r.p.period.year !== currentYear) return false;
    if (_ovFilter === 'filed') return isFiled(r);
    if (_ovFilter === 'needed') return isNeeded(r);
    return true; // all
  });

  const grid = root.querySelector('#tfy-ov-grid');
  if (!shown.length) { grid.innerHTML = `<div class="dtk-empty">No periods in this view.</div>`; return; }

  grid.innerHTML = shown.map((r, i) => {
    const big = r.p.period.ptype === 'quarterly' ? 'Q' + r.p.period.period : (r.p.period.ptype === 'monthly' ? shortMonth(r.p.period.period) : 'YR');
    const headline = (r.filing && r.filing.headline && typeof r.filing.headline.amount === 'number')
      ? '₱' + Math.abs(r.filing.headline.amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
    const pill = r.status === 'overdue'
      ? `<span class="tfy-status-pill overdue">Overdue</span>`
      : `<span class="tfy-status-pill ${r.status}">${r.status === 'draft' ? 'Draft' : r.status === 'amended' ? 'Amended' : 'Filed'}</span>`;
    return `
      <div class="tfy-ov-card ${r.status}" data-idx="${i}">
        <div class="tfy-ov-date-box"><div class="tfy-ov-date-q">${escHtml(big)}</div><div class="tfy-ov-date-y">${r.p.period.year}</div></div>
        <div>
          <div class="tfy-ov-info-form">${escHtml(FilingCore.periodLabel(r.p.period))}</div>
          <div class="tfy-ov-info-sub">BIR Form ${escHtml(r.p.form)}</div>
          <div class="tfy-ov-info-due">Due ${r.p.dueDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}${r.filing ? ' · filed ' + escHtml((r.filing.filed_at || '').slice(0, 10)) : ''}</div>
        </div>
        <div class="tfy-ov-headline">${headline}</div>
        ${pill}
      </div>`;
  }).join('');

  grid.querySelectorAll('.tfy-ov-card').forEach(card => {
    card.addEventListener('click', () => {
      const r = shown[parseInt(card.dataset.idx, 10)];
      openFiling(root, workflowKey, r.p.period, r.status);
    });
  });
}

function shortMonth(m0) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m0] || '?';
}

function openFiling(root, workflowKey, period, status) {
  const workflow = WORKFLOWS[workflowKey];
  root.innerHTML = `
    <div style="padding:24px 24px 0;">
      <button class="tfy-ov-back" id="tfy-ov-back">← All ${escHtml(workflow.label)} periods</button>
    </div>
    <div id="tfy-workflow-mount"></div>`;
  root.querySelector('#tfy-ov-back').addEventListener('click', () => renderWorkflowOverview(root, workflowKey));
  _stepEngineHandle = StepEngine.mount(root.querySelector('#tfy-workflow-mount'), workflow, biz, { period, status });
}

// ── DATA INTAKE (Batch Upload: Sales / Purchases / Payroll) ───
// Each tab embeds the existing standalone batch-import page (already used
// as an installable Manager placement) in a same-origin iframe, passing the
// already-known business via ?biz= so it skips Manager's own page-context
// lookup (see getReportBusiness() in shared.js) — same technique StepEngine
// uses to embed report pages inside this wizard.
// Receivables + Payables moved to the Month-end Prep screen (see
// MONTH_END_INTAKE_FILES) — settling AR/AP is closing work, not raw intake.
const DATA_INTAKE_FILES = {
  sales:        'batch-import-sales.html',
  purchases:    'batch-import-purchase.html',
  payroll:      'batch-import-payroll.html',
};
const _diIframes = {};
let _diActiveTab = 'sales';

function renderDataIntake() {
  showDataIntakeTab(_diActiveTab);
}

function showDataIntakeTab(tabKey) {
  _diActiveTab = tabKey;
  document.querySelectorAll('#data-intake-mode .tab').forEach(t => t.classList.toggle('active', t.dataset.diTab === tabKey));
  document.querySelectorAll('.tfy-di-panel').forEach(p => { p.hidden = p.dataset.diPanel !== tabKey; });
  ensureDataIntakeIframe(tabKey);
}

function ensureDataIntakeIframe(tabKey) {
  if (_diIframes[tabKey] || !biz) return;
  const panel = document.querySelector(`.tfy-di-panel[data-di-panel="${tabKey}"]`);
  if (!panel) return;
  const iframe = document.createElement('iframe');
  iframe.className = 'tfy-di-iframe';
  iframe.src = `${DATA_INTAKE_FILES[tabKey]}?${new URLSearchParams({ biz }).toString()}`;
  panel.appendChild(iframe);
  _diIframes[tabKey] = iframe;
}

document.querySelectorAll('#data-intake-mode .tab').forEach(t => {
  t.addEventListener('click', () => showDataIntakeTab(t.dataset.diTab));
});

// ── MONTH-END PREP (Customers / Suppliers / Employees / Receivables / Payables) ──
// The "update first" hub: party master data + AR/AP settled before returns pull
// from the books. Party/employee tabs mount the shared CF editors inline (same as
// Settings); Receivables/Payables embed the batch-import pages (moved here from
// Data Intake). Each tab mounts lazily on first view, then persists (this whole
// container is hidden/shown, never re-rendered — like Data Intake).
const MONTH_END_INTAKE_FILES = {
  receivables: 'batch-import-receivables.html',
  payables:    'batch-import-payables.html',
};
const _meMounted = {};
const _meControllers = {};
const _meIframes = {};
let _meActiveTab = 'customers';

function renderMonthEndPrep() {
  showMonthEndTab(_meActiveTab);
}

function showMonthEndTab(tabKey) {
  _meActiveTab = tabKey;
  document.querySelectorAll('#month-end-mode .tab').forEach(t => t.classList.toggle('active', t.dataset.meTab === tabKey));
  document.querySelectorAll('#month-end-mode .tfy-di-panel').forEach(p => { p.hidden = p.dataset.mePanel !== tabKey; });
  ensureMonthEndTab(tabKey);
}

function ensureMonthEndTab(tabKey) {
  if (_meMounted[tabKey] || !biz) return;
  const panel = document.querySelector(`#month-end-mode .tfy-di-panel[data-me-panel="${tabKey}"]`);
  if (!panel || typeof CF === 'undefined') return;

  if (tabKey === 'customers') {
    _meControllers.customers = CF.mountParty(panel, 'customer');
    _meControllers.customers.refresh();
  } else if (tabKey === 'suppliers') {
    _meControllers.suppliers = CF.mountParty(panel, 'supplier');
    _meControllers.suppliers.refresh();
  } else if (tabKey === 'employees') {
    _meControllers.employees = CF.mountEmployees(panel);
    _meControllers.employees.refresh();
  } else if (MONTH_END_INTAKE_FILES[tabKey]) {
    const iframe = document.createElement('iframe');
    iframe.className = 'tfy-di-iframe';
    iframe.src = `${MONTH_END_INTAKE_FILES[tabKey]}?${new URLSearchParams({ biz }).toString()}`;
    panel.appendChild(iframe);
    _meIframes[tabKey] = iframe;
  }
  _meMounted[tabKey] = true;
}

document.querySelectorAll('#month-end-mode .tab').forEach(t => {
  t.addEventListener('click', () => showMonthEndTab(t.dataset.meTab));
});

// Host hook for the workflow readiness gate's "Fix in Month-end Prep →" button
// (step-engine.js): jump to the Month-end Prep screen and open a specific tab.
window.tfyGoToMonthEnd = function(tab) {
  goToNav('month-end');
  if (tab) showMonthEndTab(tab);
};

// ── BOOTSTRAP ────────────────────────────────────────────────
(async function init() {
  try {
    biz = await getReportBusiness(document.getElementById('biz-context-wrap'));
  } catch (e) {
    document.getElementById('biz-context-wrap').innerHTML =
      `<div class="alert alert-error">Could not detect a business: ${escHtml(e.message)}</div>`;
    return;
  }
  setup = await loadSetup(biz);
  document.getElementById('tfy-biz-name').textContent = biz;
  goToNav('data-intake');
})();
