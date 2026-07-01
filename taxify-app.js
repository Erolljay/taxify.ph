/* ============================================================
   Taxify it! — app shell logic
   Settings mode: ported from app.js, but resolves a single business via
   getReportBusiness() instead of a manual <select id="business">, since
   each Taxify it! install is scoped to one business.
   User mode: category-card landing screen + StepEngine workflows.
   ============================================================ */

let biz = '';
let setup = null;

// ── SIDENAV (Dashboard / VAT / Expanded / Compensation / Income / Others / Settings) ──
let _settingsActivated = false;

function goToNav(key) {
  document.querySelectorAll('.tfy-nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === key));
  const isSettings   = key === 'settings';
  const isDeadlines  = key === 'deadlines';
  const isDataIntake = key === 'data-intake';
  document.getElementById('settings-mode').hidden     = !isSettings;
  document.getElementById('deadlines-mode').hidden    = !isDeadlines;
  document.getElementById('data-intake-mode').hidden  = !isDataIntake;
  document.getElementById('user-mode').hidden         = isSettings || isDeadlines || isDataIntake;

  if (isSettings) {
    if (!_settingsActivated) { _settingsActivated = true; activateTab('welcome'); }
    return;
  }
  if (isDeadlines)  { renderDeadlineTracker(); return; }
  if (isDataIntake) { renderDataIntake(); return; }

  if (key === 'income') _userActiveCategory = workflowKeyForIncomeTax();
  else _userActiveCategory = key; // vat / expanded / compensation / others
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

  TC_GROUPS.forEach(grp => {
    const codes = TAX_CODE_TEMPLATES.filter(t => t.group === grp.key);
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
  const missing = TAX_CODE_TEMPLATES.filter(t => t.group === grpKey && !tcByName[t.Name.toLowerCase().trim()]);
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

// ── DEADLINE TRACKER ───────────────────────────────────────────

// Maps each BIR form to the sidenav workflow key it belongs to
const DTK_FORM_NAV = {
  '0619E':  'expanded',
  '1601EQ': 'expanded',
  '1604E':  'expanded',
  '1601C':  'compensation',
  '1604C':  'compensation',
  '1702':   'income',
  '1702Q':  'income',
  '2550Q':  'vat',
};

function dtkDate(y, m, d) {
  return new Date(y, m - 1, d);
}

function dtkComputeDeadlines(refDate) {
  const y = refDate.getFullYear();
  const deadlines = [];

  const push = (form, name, freq, date) => {
    deadlines.push({ form, name, freq, date, navKey: DTK_FORM_NAV[form] || null });
  };

  // 1604C — Annual, Jan 31
  for (const yr of [y - 1, y, y + 1]) push('1604C', 'Withholding Tax on Compensation', `Annual (for ${yr-1})`, dtkDate(yr, 1, 31));

  // 1604E — Annual, March 1
  for (const yr of [y - 1, y, y + 1]) push('1604E', 'Withholding Tax – Expanded', `Annual (for ${yr-1})`, dtkDate(yr, 3, 1));

  // 1702 — Annual, April 15
  for (const yr of [y - 1, y, y + 1]) push('1702', 'Corporate Income Tax', `Annual (for ${yr-1})`, dtkDate(yr, 4, 15));

  // Monthly: 1601C and 0619E — 10th of following month; December = Jan 15
  const monthlyForms = [
    { form: '1601C', name: 'Withholding Tax on Compensation' },
    { form: '0619E', name: 'Withholding Tax – Expanded' },
  ];
  for (const yr of [y - 1, y, y + 1]) {
    for (let m = 1; m <= 12; m++) {
      for (const mf of monthlyForms) {
        let dueY = yr, dueM, dueD;
        if (m === 12) { dueY = yr + 1; dueM = 1; dueD = 15; }
        else { dueM = m + 1; dueD = 10; }
        const monthName = new Date(yr, m - 1, 1).toLocaleString('default', { month: 'short' });
        push(mf.form, mf.name, `Monthly – ${monthName} ${yr}`, dtkDate(dueY, dueM, dueD));
      }
    }
  }

  // Quarterly: 1601EQ — last day of month following quarter end
  const qtr1601EQ = [
    { q: 'Q1', dueM: 4, dueD: 30 }, { q: 'Q2', dueM: 7, dueD: 31 },
    { q: 'Q3', dueM: 10, dueD: 31 }, { q: 'Q4', dueM: 1, dueD: 31, nextYear: true },
  ];
  for (const yr of [y - 1, y, y + 1]) {
    for (const q of qtr1601EQ) {
      const dueY = q.nextYear ? yr + 1 : yr;
      push('1601EQ', 'Withholding Tax – Expanded', `Quarterly ${q.q} ${yr}`, dtkDate(dueY, q.dueM, q.dueD));
    }
  }

  // Quarterly: 2550Q — 25th day following quarter close
  const qtr2550Q = [
    { q: 'Q1', dueM: 4, dueD: 25 }, { q: 'Q2', dueM: 7, dueD: 25 },
    { q: 'Q3', dueM: 10, dueD: 25 }, { q: 'Q4', dueM: 1, dueD: 25, nextYear: true },
  ];
  for (const yr of [y - 1, y, y + 1]) {
    for (const q of qtr2550Q) {
      const dueY = q.nextYear ? yr + 1 : yr;
      push('2550Q', 'Value Added Tax', `Quarterly ${q.q} ${yr}`, dtkDate(dueY, q.dueM, q.dueD));
    }
  }

  // Quarterly: 1702Q — 60 days after Q1/Q2/Q3 close
  const qtr1702Q = [
    { q: 'Q1', dueM: 5, dueD: 30 }, { q: 'Q2', dueM: 8, dueD: 29 }, { q: 'Q3', dueM: 11, dueD: 29 },
  ];
  for (const yr of [y - 1, y, y + 1]) {
    for (const q of qtr1702Q) {
      push('1702Q', 'Corporate Income Tax', `Quarterly ${q.q} ${yr}`, dtkDate(yr, q.dueM, q.dueD));
    }
  }

  return deadlines.sort((a, b) => a.date - b.date);
}

// Tracks which deadline cards the user has marked as filed / dismissed this session
const _dtkFiled     = new Set();
const _dtkDismissed = new Set();

let _dtkFilter = 'upcoming';

function dtkKey(d) { return d.form + '|' + d.date.getTime(); }

function dtkStatus(date, today) {
  const diff = Math.floor((date - today) / 86400000);
  if (diff < 0) return 'overdue';
  if (diff <= 7) return 'due-soon';
  if (diff <= 30) return 'upcoming';
  return 'done';
}

function dtkBadgeLabel(status, date, today) {
  const diff = Math.floor((date - today) / 86400000);
  if (status === 'overdue') return `${Math.abs(diff)}d overdue`;
  if (status === 'due-soon') return diff === 0 ? 'Due TODAY' : `In ${diff}d`;
  if (status === 'upcoming') return `In ${diff}d`;
  return 'Upcoming';
}

function renderDeadlineTracker() {
  const root = document.getElementById('deadlines-mode');
  if (!root) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toLocaleDateString('en-PH', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const allDeadlines = dtkComputeDeadlines(today);

  const windowStart = new Date(today); windowStart.setDate(windowStart.getDate() - 30);
  const windowEnd   = new Date(today); windowEnd.setDate(windowEnd.getDate() + 120);
  const visible = allDeadlines.filter(d => d.date >= windowStart && d.date <= windowEnd && !_dtkDismissed.has(dtkKey(d)));

  const filterLabels = { all:'All', overdue:'Overdue', 'due-soon':'Due Soon (7d)', upcoming:'Next 30 Days', done:'Future' };

  const counts = { all: visible.length, overdue: 0, 'due-soon': 0, upcoming: 0, done: 0 };
  visible.forEach(d => { const s = dtkStatus(d.date, today); if (counts[s] !== undefined) counts[s]++; });

  let html = `
    <div class="dtk-header">
      <div class="dtk-title">📅 Tax Compliance Deadlines</div>
      <div class="dtk-today">${escHtml(todayStr)}</div>
    </div>
    <div class="dtk-filter-bar">
      ${Object.entries(filterLabels).map(([k, lbl]) =>
        `<button class="dtk-filter-btn${_dtkFilter === k ? ' active' : ''}" data-filter="${k}">${escHtml(lbl)} <span style="opacity:.7">(${counts[k] ?? 0})</span></button>`
      ).join('')}
    </div>`;

  const filtered = _dtkFilter === 'all'
    ? visible
    : visible.filter(d => dtkStatus(d.date, today) === _dtkFilter);

  if (!filtered.length) {
    html += `<div class="dtk-empty">No deadlines in this view.</div>`;
  } else {
    let lastStatus = null;
    filtered.forEach(d => {
      const status = dtkStatus(d.date, today);
      const key = dtkKey(d);
      const filed = _dtkFiled.has(key);
      if (status !== lastStatus) {
        const sectionNames = { overdue:'🔴 Overdue', 'due-soon':'🟡 Due Soon (within 7 days)', upcoming:'🔵 Upcoming (within 30 days)', done:'⚪ Further Ahead' };
        if (_dtkFilter === 'all') html += `<div class="dtk-section-label">${sectionNames[status] || ''}</div>`;
        lastStatus = status;
      }
      const mo  = d.date.toLocaleString('default', { month: 'short' }).toUpperCase();
      const day = d.date.getDate();
      const yr  = d.date.getFullYear();
      const badge = dtkBadgeLabel(status, d.date, today);

      const filedBtn = filed
        ? `<button class="dtk-action-btn dtk-filed-active" data-key="${escHtml(key)}" title="Click to undo">✓ Already Filed</button>`
        : `<button class="dtk-action-btn dtk-filed-btn" data-key="${escHtml(key)}">Already Filed</button>`;

      const dismissBtn = `<button class="dtk-action-btn dtk-dismiss-btn" data-key="${escHtml(key)}" title="Remove from list">✕ Remove</button>`;

      const startBtn = d.navKey
        ? `<button class="dtk-action-btn dtk-start-btn" data-nav="${escHtml(d.navKey)}">Start Filing →</button>`
        : '';

      html += `
        <div class="dtk-card ${status}${filed ? ' dtk-card-filed' : ''}">
          <div class="dtk-date-box">
            <div class="dtk-date-month">${mo}</div>
            <div class="dtk-date-day">${day}</div>
            <div class="dtk-date-year">${yr}</div>
          </div>
          <div>
            <div class="dtk-info-form">BIR Form ${escHtml(d.form)}</div>
            <div class="dtk-info-name">${escHtml(d.name)}</div>
            <div class="dtk-info-freq">${escHtml(d.freq)}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
            <span class="dtk-badge ${filed ? 'filed' : status}">${filed ? '✓ Filed' : escHtml(badge)}</span>
            <div style="display:flex;gap:6px;">${filedBtn}${dismissBtn}${startBtn}</div>
          </div>
        </div>`;
    });
  }

  root.innerHTML = `<div class="dtk-grid">${html}</div>`;

  root.querySelectorAll('.dtk-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => { _dtkFilter = btn.dataset.filter; renderDeadlineTracker(); });
  });
  root.querySelectorAll('.dtk-filed-btn, .dtk-filed-active').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.key;
      if (_dtkFiled.has(k)) _dtkFiled.delete(k); else _dtkFiled.add(k);
      renderDeadlineTracker();
    });
  });
  root.querySelectorAll('.dtk-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', () => { _dtkDismissed.add(btn.dataset.key); renderDeadlineTracker(); });
  });
  root.querySelectorAll('.dtk-start-btn').forEach(btn => {
    btn.addEventListener('click', () => goToNav(btn.dataset.nav));
  });
}

// ── USER MODE: CATEGORY CARDS + STEP ENGINE ────────────────────
let _userActiveCategory = null;
let _stepEngineHandle = null;

function workflowKeyForIncomeTax() {
  if (setup && setup.classification === 'Individual') return 'individual';
  return 'nonindividual';
}

function renderUserMode() {
  const root = document.getElementById('user-mode');
  if (_userActiveCategory === 'others') { renderOthersScreen(root); return; }
  renderWorkflowScreen(root, _userActiveCategory);
}

function renderOthersScreen(root) {
  root.innerHTML = `
    <p class="muted">These categories aren't built yet:</p>
    <ul>
      <li>Percentage Tax</li>
      <li>Final Withholding Tax</li>
    </ul>`;
}

function renderWorkflowScreen(root, workflowKey) {
  const workflow = WORKFLOWS[workflowKey];
  root.innerHTML = `<div id="tfy-workflow-mount"></div>`;
  if (!workflow) {
    root.querySelector('#tfy-workflow-mount').innerHTML = '<p class="muted">This workflow isn\'t configured yet.</p>';
    return;
  }
  _stepEngineHandle = StepEngine.mount(root.querySelector('#tfy-workflow-mount'), workflow, biz);
}

// ── DATA INTAKE (Batch Upload: Sales / Purchases / Payroll) ───
// Each tab embeds the existing standalone batch-import page (already used
// as an installable Manager placement) in a same-origin iframe, passing the
// already-known business via ?biz= so it skips Manager's own page-context
// lookup (see getReportBusiness() in shared.js) — same technique StepEngine
// uses to embed report pages inside this wizard.
const DATA_INTAKE_FILES = {
  sales:     'batch-import-sales.html',
  purchases: 'batch-import-purchase.html',
  payroll:   'batch-import-payroll.html',
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
