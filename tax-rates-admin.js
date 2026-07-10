/* ============================================================
   Tallo CPA – BIR Tax App
   tax-rates-admin.js – Txform.ph Super Admin → Tax Rates

   Lets you introduce a new rate (VAT, Percentage Tax, the individual
   graduated income tax table, corporate rates, MCIT) with an effective
   date. "Add Rate" only edits an in-memory draft — nothing reaches any
   business until you publish. Publishing has two paths:
     1. Save to Server — POSTs the draft to save-tax-rates.php, which
        overwrites tax-rates-data.json directly (see
        DEPLOY-TAX-RATES-SAVE.md for the one-time server setup this
        needs). Protected by an nginx login prompt only you know the
        password to.
     2. Copy JSON — a manual fallback if the server endpoint isn't set
        up yet: copy the JSON and commit it through GitHub instead
        (branch → PR → merge).
   Either way, once the file is updated, every installed business picks
   it up automatically next time it loads a report — they all fetch the
   same file.

   Entries that were already in the published file when this page loaded
   can't be deleted here — only a rate you just added *this session* (not
   yet published) can be undone. This keeps the "never edit or remove a
   rate that may already be in use" rule enforced even while drafting.
   ============================================================ */

let _trDraft = null;
let _trPublishedIds = null;

async function renderTaxRatesTab(el) {
  el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Loading current tax rates…</span></div>`;
  try {
    const published = await loadTaxRatesData();
    _trDraft = JSON.parse(JSON.stringify(published));
    _trPublishedIds = new Set();
    Object.keys(_trDraft).forEach(key => {
      if (Array.isArray(_trDraft[key])) _trDraft[key].forEach(e => e.id && _trPublishedIds.add(e.id));
    });
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">❌ Could not load tax-rates-data.json: ${escHtml(err.message)}</div>`;
    return;
  }

  el.innerHTML = `
    <div class="tabs" id="tax-rates-subtabs" style="margin-bottom:14px;">
      <button type="button" class="tab active" data-tr-tab="vat">VAT &amp; Percentage Tax</button>
      <button type="button" class="tab" data-tr-tab="income">Individual Income Tax</button>
      <button type="button" class="tab" data-tr-tab="corporate">Corporate Tax &amp; MCIT</button>
      <button type="button" class="tab" data-tr-tab="publish">Publish</button>
    </div>
    <div data-tr-panel="vat"></div>
    <div data-tr-panel="income" hidden></div>
    <div data-tr-panel="corporate" hidden></div>
    <div data-tr-panel="publish" hidden></div>
  `;
  el.querySelectorAll('[data-tr-tab]').forEach(btn => {
    btn.addEventListener('click', () => showTaxRatesSubtab(el, btn.dataset.trTab));
  });
  showTaxRatesSubtab(el, 'vat');
}

function showTaxRatesSubtab(el, tab) {
  el.querySelectorAll('[data-tr-tab]').forEach(b => b.classList.toggle('active', b.dataset.trTab === tab));
  el.querySelectorAll('[data-tr-panel]').forEach(p => { p.hidden = p.dataset.trPanel !== tab; });
  const panel = el.querySelector(`[data-tr-panel="${tab}"]`);
  if (tab === 'vat') renderVatPtPanel(panel);
  if (tab === 'income') renderIncomeTaxPanel(panel);
  if (tab === 'corporate') renderCorporatePanel(panel);
  if (tab === 'publish') renderPublishPanel(panel);
}

// ── SHARED HELPERS ──────────────────────────────────────────────
function trIsPublished(id) { return _trPublishedIds.has(id); }

function trBadge(id) {
  return trIsPublished(id)
    ? '<span style="font-size:10px;background:#e8edf5;color:#6b7280;padding:2px 8px;border-radius:10px;">Published</span>'
    : '<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;">Not published yet</span>';
}

function trDraftSeries(categoryKey) {
  return (_trDraft[categoryKey] || []).slice().sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

function rateHistoryTableHtml(categoryKey, valueLabel, valueFormatter) {
  const rows = trDraftSeries(categoryKey);
  const trs = rows.map(r => `
    <tr style="border-bottom:.5px solid #f3f4f6;">
      <td style="padding:6px 10px;font-size:12px;">${escHtml(r.effectiveDate)}</td>
      <td style="padding:6px 10px;font-size:12px;font-weight:600;">${valueFormatter(r)}</td>
      <td style="padding:6px 10px;font-size:12px;color:#6b7280;">${escHtml(r.label || '')} ${trBadge(r.id)}</td>
      <td style="padding:6px 10px;text-align:center;">
        ${!trIsPublished(r.id) ? `<button type="button" class="btn btn-outline btn-sm" data-tr-delete="${categoryKey}" data-tr-id="${r.id}">🗑 Undo</button>` : ''}
      </td>
    </tr>`).join('');
  return `
    <table class="data-table" style="width:100%;">
      <thead><tr style="font-size:11px;color:#9ca3af;">
        <th style="text-align:left;padding:4px 10px;">Effective Date</th>
        <th style="text-align:left;padding:4px 10px;">${escHtml(valueLabel)}</th>
        <th style="text-align:left;padding:4px 10px;">Note</th>
        <th></th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>`;
}

function addRateFormHtml(categoryKey, numericFields) {
  const fieldsHtml = numericFields.map(f => `
    <div>
      <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">${escHtml(f.label)}</label>
      <input type="number" step="0.01" data-tr-field="${f.id}" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:120px;">
    </div>`).join('');
  return `
    <div class="tr-add-form" data-tr-category="${categoryKey}" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px dashed #e5e7eb;">
      <div>
        <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Effective Date</label>
        <input type="date" data-tr-field="effectiveDate" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
      </div>
      ${fieldsHtml}
      <div>
        <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Note (optional)</label>
        <input type="text" data-tr-field="label" placeholder="e.g. RR 12-2026" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:200px;">
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-tr-add="${categoryKey}">+ Add Rate (draft)</button>
      <span class="tr-add-msg" data-tr-msg="${categoryKey}" style="font-size:11px;color:#6b7280;"></span>
    </div>`;
}

function trNewId(categoryKey) {
  return `draft-${categoryKey}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// Wires every generic add-form (data-tr-add / data-tr-field) and every
// delete button (data-tr-delete / data-tr-id) found inside `panel`.
function bindTaxRatePanel(panel, refresh) {
  panel.querySelectorAll('[data-tr-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Remove this draft entry? It hasn\'t been published, so this just undoes what you added this session.')) return;
      const categoryKey = btn.dataset.trDelete;
      const id = btn.dataset.trId;
      _trDraft[categoryKey] = (_trDraft[categoryKey] || []).filter(e => e.id !== id);
      refresh();
    });
  });

  panel.querySelectorAll('[data-tr-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const categoryKey = btn.dataset.trAdd;
      const form = panel.querySelector(`.tr-add-form[data-tr-category="${categoryKey}"]`);
      const msg = panel.querySelector(`[data-tr-msg="${categoryKey}"]`);
      const entry = { id: trNewId(categoryKey) };
      let hasInvalidNumber = false;
      form.querySelectorAll('[data-tr-field]').forEach(inp => {
        const key = inp.dataset.trField;
        if (inp.type === 'number') {
          const n = parseFloat(inp.value);
          if (isNaN(n)) hasInvalidNumber = true;
          entry[key] = n;
        } else {
          entry[key] = inp.value.trim();
        }
      });
      if (!entry.effectiveDate) { msg.style.color = '#c0392b'; msg.textContent = '❌ Pick an effective date.'; return; }
      if (hasInvalidNumber) { msg.style.color = '#c0392b'; msg.textContent = '❌ Enter a valid rate.'; return; }
      _trDraft[categoryKey] = [...(_trDraft[categoryKey] || []), entry];
      msg.style.color = '#27ae60';
      msg.textContent = '✅ Added to draft — see the Publish tab when ready.';
      refresh();
    });
  });
}

// ── VAT & PERCENTAGE TAX ────────────────────────────────────────
function renderVatPtPanel(panel) {
  panel.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px;">
      ℹ️ Rates are never edited or removed once published — add a new dated entry when BIR introduces a new
      rate. Returns for earlier periods automatically keep using whatever rate was in force then. Nothing here
      reaches any business until you publish it (see the <strong>Publish</strong> tab).
    </div>
    <div class="card">
      <div class="card-title">VAT Rate</div>
      ${rateHistoryTableHtml('vat', 'Rate', r => r.rate + '%')}
      ${addRateFormHtml('vat', [{ id: 'rate', label: 'New Rate (%)' }])}
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="card-title">Percentage Tax — Non-VAT (NIRC Sec. 116)</div>
      ${rateHistoryTableHtml('pt', 'Rate', r => r.rate + '%')}
      ${addRateFormHtml('pt', [{ id: 'rate', label: 'New Rate (%)' }])}
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="card-title">Percentage Tax — Nonbank Financial Intermediaries</div>
      ${rateHistoryTableHtml('ptNonbank', 'Rate', r => r.rate + '%')}
      ${addRateFormHtml('ptNonbank', [{ id: 'rate', label: 'New Rate (%)' }])}
    </div>`;
  bindTaxRatePanel(panel, () => renderVatPtPanel(panel));
}

// ── INDIVIDUAL INCOME TAX ───────────────────────────────────────
function incomeBracketRowHtml(b) {
  b = b || {};
  const upToVal = (b.upTo === null || b.upTo === undefined) ? '' : b.upTo;
  const rateVal = (b.rate === undefined) ? '' : (b.rate * 100);
  return `<tr>
    <td style="padding:4px 8px;"><input type="number" step="1" class="tr-bracket-upto" value="${upToVal}" placeholder="no limit" style="width:140px;font-size:12px;padding:5px 7px;border:1px solid #d1d5db;border-radius:6px;"></td>
    <td style="padding:4px 8px;"><input type="number" step="0.01" class="tr-bracket-rate" value="${rateVal}" style="width:90px;font-size:12px;padding:5px 7px;border:1px solid #d1d5db;border-radius:6px;"></td>
    <td style="padding:4px 8px;"><button type="button" class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">✕</button></td>
  </tr>`;
}

function renderIncomeTaxPanel(panel) {
  const tables = trDraftSeries('incomeTax');
  const tablesHtml = tables.map(r => `
    <div class="card" style="margin-bottom:10px;">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Effective ${escHtml(r.effectiveDate)}${r.label ? ' — ' + escHtml(r.label) : ''} ${trBadge(r.id)}</span>
        ${!trIsPublished(r.id) ? `<button type="button" class="btn btn-outline btn-sm" data-tr-delete="incomeTax" data-tr-id="${r.id}">🗑 Undo</button>` : ''}
      </div>
      <table class="data-table" style="width:100%;margin-top:8px;">
        <thead><tr style="font-size:11px;color:#9ca3af;"><th style="text-align:left;padding:4px 10px;">Up To</th><th style="text-align:left;padding:4px 10px;">Rate</th></tr></thead>
        <tbody>${r.brackets.map(b => `<tr style="border-bottom:.5px solid #f3f4f6;"><td style="padding:5px 10px;font-size:12px;">${b.upTo === null || b.upTo === undefined ? 'No limit' : '₱' + Number(b.upTo).toLocaleString()}</td><td style="padding:5px 10px;font-size:12px;font-weight:600;">${(b.rate * 100).toFixed(2).replace(/\.?0+$/, '')}%</td></tr>`).join('')}</tbody>
      </table>
    </div>`).join('');

  panel.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px;">
      ℹ️ Add a new bracket table when the graduated rates change — earlier-year returns keep using whichever
      table was effective for that year. Nothing here reaches any business until you publish it.
    </div>
    ${tablesHtml}
    <div class="card">
      <div class="card-title">➕ Add a New Bracket Table (draft)</div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px;">
        <div>
          <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Effective Date</label>
          <input type="date" id="tr-income-date" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
        </div>
        <div>
          <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Note (optional)</label>
          <input type="text" id="tr-income-label" placeholder="e.g. RA 12345" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:220px;">
        </div>
      </div>
      <table class="data-table" style="width:100%;">
        <thead><tr style="font-size:11px;color:#9ca3af;"><th style="text-align:left;padding:4px 8px;">Up To (₱, blank = no limit)</th><th style="text-align:left;padding:4px 8px;">Rate (%)</th><th></th></tr></thead>
        <tbody id="tr-income-brackets-body"></tbody>
      </table>
      <button type="button" class="btn btn-outline btn-sm" id="tr-income-add-bracket" style="margin-top:8px;">+ Add Bracket Row</button>
      <div style="margin-top:12px;">
        <button type="button" class="btn btn-primary btn-sm" id="tr-income-save">💾 Add Table to Draft</button>
        <span id="tr-income-msg" style="font-size:11px;color:#6b7280;margin-left:8px;"></span>
      </div>
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="card-title">8% Flat Rate (in lieu of graduated rate + percentage tax)</div>
      ${rateHistoryTableHtml('eightPct', 'Rate', r => r.rate + '%')}
      ${addRateFormHtml('eightPct', [{ id: 'rate', label: 'New Rate (%)' }])}
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="card-title">Optional Standard Deduction (OSD) <small style="font-weight:400;color:#6b7280;">— also used by 1702-Q / 1702-RT</small></div>
      ${rateHistoryTableHtml('osd', 'Rate', r => r.rate + '%')}
      ${addRateFormHtml('osd', [{ id: 'rate', label: 'New Rate (%)' }])}
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="card-title">13th-Month Pay &amp; Other Benefits — Non-Taxable Ceiling</div>
      ${rateHistoryTableHtml('thirteenthCap', 'Amount', r => '₱' + Number(r.amount).toLocaleString())}
      ${addRateFormHtml('thirteenthCap', [{ id: 'amount', label: 'New Amount (₱)' }])}
    </div>`;

  // Seed the "add bracket table" form with whichever table is effective
  // today, so the preparer only edits the bracket(s) that actually changed.
  const current = trDraftSeries('incomeTax').filter(e => e.effectiveDate <= todayStr()).pop()
    || trDraftSeries('incomeTax')[0];
  document.getElementById('tr-income-brackets-body').innerHTML =
    (current ? current.brackets : []).map(b => incomeBracketRowHtml(b)).join('');

  document.getElementById('tr-income-add-bracket').addEventListener('click', () => {
    document.getElementById('tr-income-brackets-body').insertAdjacentHTML('beforeend', incomeBracketRowHtml());
  });
  document.getElementById('tr-income-save').addEventListener('click', () => saveNewIncomeTable(panel));

  bindTaxRatePanel(panel, () => renderIncomeTaxPanel(panel));
}

function saveNewIncomeTable(panel) {
  const msg = document.getElementById('tr-income-msg');
  const date = document.getElementById('tr-income-date').value;
  const label = document.getElementById('tr-income-label').value.trim();
  if (!date) { msg.style.color = '#c0392b'; msg.textContent = '❌ Pick an effective date.'; return; }

  const rows = [...document.querySelectorAll('#tr-income-brackets-body tr')];
  const brackets = rows.map(tr => {
    const upToRaw = tr.querySelector('.tr-bracket-upto').value;
    const rateRaw = tr.querySelector('.tr-bracket-rate').value;
    return { upTo: upToRaw === '' ? null : Number(upToRaw), rate: Number(rateRaw) / 100 };
  });
  if (!brackets.length || brackets.some(b => isNaN(b.rate))) {
    msg.style.color = '#c0392b'; msg.textContent = '❌ Add at least one bracket with a valid rate.'; return;
  }
  _trDraft.incomeTax = [...(_trDraft.incomeTax || []), { id: trNewId('incomeTax'), effectiveDate: date, label, brackets }];
  renderIncomeTaxPanel(panel);
}

// ── CORPORATE TAX & MCIT ────────────────────────────────────────
function renderCorporatePanel(panel) {
  const rows = trDraftSeries('corporate');
  const corpRowsHtml = rows.map(r => `
    <tr style="border-bottom:.5px solid #f3f4f6;">
      <td style="padding:6px 10px;font-size:12px;">${escHtml(r.effectiveDate)}</td>
      <td style="padding:6px 10px;font-size:12px;font-weight:600;">${r.regular}%</td>
      <td style="padding:6px 10px;font-size:12px;font-weight:600;">${r.small}%</td>
      <td style="padding:6px 10px;font-size:12px;color:#6b7280;">${escHtml(r.label || '')} ${trBadge(r.id)}</td>
      <td style="padding:6px 10px;text-align:center;">${!trIsPublished(r.id) ? `<button type="button" class="btn btn-outline btn-sm" data-tr-delete="corporate" data-tr-id="${r.id}">🗑 Undo</button>` : ''}</td>
    </tr>`).join('');

  panel.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px;">
      ℹ️ Add a new dated entry when the corporate rate or MCIT rate changes — earlier-year returns keep
      using whatever rate was effective then. Nothing here reaches any business until you publish it.
    </div>
    <div class="card">
      <div class="card-title">Corporate Income Tax Rates</div>
      <table class="data-table" style="width:100%;">
        <thead><tr style="font-size:11px;color:#9ca3af;">
          <th style="text-align:left;padding:4px 10px;">Effective Date</th>
          <th style="text-align:left;padding:4px 10px;">Regular</th>
          <th style="text-align:left;padding:4px 10px;">Small Corp*</th>
          <th style="text-align:left;padding:4px 10px;">Note</th><th></th>
        </tr></thead>
        <tbody>${corpRowsHtml}</tbody>
      </table>
      <p style="font-size:10px;color:#9ca3af;margin:6px 0 0;">* Net Taxable Income ≤ ₱5M &amp; Total Assets ≤ ₱100M excl. land</p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px dashed #e5e7eb;">
        <div>
          <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Effective Date</label>
          <input type="date" id="tr-corp-date" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
        </div>
        <div>
          <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Regular Rate (%)</label>
          <input type="number" step="0.01" id="tr-corp-regular" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:110px;">
        </div>
        <div>
          <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Small Corp Rate (%)</label>
          <input type="number" step="0.01" id="tr-corp-small" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:110px;">
        </div>
        <div>
          <label style="font-size:11px;display:block;margin-bottom:4px;font-weight:600;">Note (optional)</label>
          <input type="text" id="tr-corp-label" placeholder="e.g. RA 12345" style="font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;width:200px;">
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="tr-corp-add">+ Add Rate (draft)</button>
        <span id="tr-corp-msg" style="font-size:11px;color:#6b7280;"></span>
      </div>
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="card-title">MCIT Rate</div>
      ${rateHistoryTableHtml('mcit', 'Rate', r => r.rate + '%')}
      ${addRateFormHtml('mcit', [{ id: 'rate', label: 'New Rate (%)' }])}
    </div>`;

  document.getElementById('tr-corp-add').addEventListener('click', () => {
    const msg = document.getElementById('tr-corp-msg');
    const date = document.getElementById('tr-corp-date').value;
    const regular = parseFloat(document.getElementById('tr-corp-regular').value);
    const small = parseFloat(document.getElementById('tr-corp-small').value);
    const label = document.getElementById('tr-corp-label').value.trim();
    if (!date || isNaN(regular) || isNaN(small)) {
      msg.style.color = '#c0392b'; msg.textContent = '❌ Fill in date, regular rate, and small-corp rate.'; return;
    }
    _trDraft.corporate = [...(_trDraft.corporate || []), { id: trNewId('corporate'), effectiveDate: date, regular, small, label }];
    renderCorporatePanel(panel);
  });

  bindTaxRatePanel(panel, () => renderCorporatePanel(panel));
}

// ── PUBLISH ──────────────────────────────────────────────────────
const TAX_RATES_SAVE_ENDPOINT = 'save-tax-rates.php';

function renderPublishPanel(panel, justSavedMsg) {
  const unpublishedCount = Object.values(_trDraft)
    .filter(Array.isArray)
    .reduce((n, arr) => n + arr.filter(e => !trIsPublished(e.id)).length, 0);

  const json = JSON.stringify(_trDraft, null, 2);

  panel.innerHTML = `
    ${justSavedMsg ? `<div class="alert alert-success" style="margin-bottom:14px;">✅ ${escHtml(justSavedMsg)}</div>` : ''}
    <div class="alert ${unpublishedCount ? 'alert-warn' : 'alert-info'}" style="margin-bottom:14px;">
      ${unpublishedCount
        ? `⚠️ ${unpublishedCount} new rate${unpublishedCount === 1 ? '' : 's'} added this session, not yet live for any business.`
        : 'ℹ️ No unpublished changes — this is the currently-live data.'}
    </div>
    <div class="card">
      <div class="card-title">Save to Server</div>
      <p style="font-size:12.5px;color:#6b7280;margin:0 0 12px;">
        Writes directly to <code>tax-rates-data.json</code> on the server. Live for every business the moment
        it succeeds — no GitHub step needed. Your browser will ask for the admin password the first time.
        Requires the one-time server setup in <code>DEPLOY-TAX-RATES-SAVE.md</code>.
      </p>
      <button type="button" class="btn btn-primary btn-sm" id="tr-publish-save">💾 Save to Server</button>
      <span id="tr-publish-save-msg" style="font-size:11px;color:#6b7280;margin-left:8px;"></span>
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="card-title">Or: Copy JSON &amp; Commit via GitHub</div>
      <p style="font-size:12.5px;color:#6b7280;margin:0 0 12px;">
        Fallback if the server endpoint above isn't set up yet.
      </p>
      <ol style="font-size:12.5px;line-height:1.7;color:#374151;margin:0 0 14px 18px;padding:0;">
        <li>Click <strong>Copy JSON</strong> below.</li>
        <li>On GitHub, create a new branch (or use one you already have).</li>
        <li>Open <code>tax-rates-data.json</code> in that branch, replace its contents with what you copied, and commit.</li>
        <li>Open a Pull Request, review the diff, and merge it.</li>
        <li>Once merged, every business's extension picks up the new rate automatically — no per-business action needed.</li>
      </ol>
      <button type="button" class="btn btn-outline btn-sm" id="tr-publish-copy">📋 Copy JSON</button>
      <span id="tr-publish-msg" style="font-size:11px;color:#6b7280;margin-left:8px;"></span>
      <textarea readonly id="tr-publish-json" style="width:100%;height:340px;margin-top:12px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;padding:10px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;">${escHtml(json)}</textarea>
    </div>`;

  document.getElementById('tr-publish-copy').addEventListener('click', () => {
    const msg = document.getElementById('tr-publish-msg');
    navigator.clipboard?.writeText(json)
      .then(() => { msg.style.color = '#27ae60'; msg.textContent = '✅ Copied — paste it into tax-rates-data.json on GitHub.'; })
      .catch(() => { msg.style.color = '#c0392b'; msg.textContent = '❌ Copy failed — select the text box manually.'; });
  });

  document.getElementById('tr-publish-save').addEventListener('click', async () => {
    const btn = document.getElementById('tr-publish-save');
    const msg = document.getElementById('tr-publish-save-msg');
    btn.disabled = true;
    msg.style.color = '#6b7280';
    msg.textContent = 'Saving…';
    try {
      const res = await fetch(TAX_RATES_SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Server returned ${res.status}`);

      // What was "draft" is now "published" — reload the just-saved data
      // and rebuild the draft/published bookkeeping from it, WITHOUT
      // calling renderTaxRatesTab() (that rebuilds the whole tab bar and
      // always resets back to the VAT sub-tab, wiping this success
      // message before it could be read — re-render just this panel
      // instead, so we stay put on Publish and the message sticks).
      _taxRatesLoadPromise = null;
      const published = await loadTaxRatesData();
      _trDraft = JSON.parse(JSON.stringify(published));
      _trPublishedIds = new Set();
      Object.keys(_trDraft).forEach(key => {
        if (Array.isArray(_trDraft[key])) _trDraft[key].forEach(e => e.id && _trPublishedIds.add(e.id));
      });
      renderPublishPanel(panel, 'Saved — live for every business now.');
      return;
    } catch (err) {
      msg.style.color = '#c0392b';
      msg.textContent = `❌ ${err.message} — use Copy JSON below instead, or check DEPLOY-TAX-RATES-SAVE.md.`;
    } finally {
      btn.disabled = false;
    }
  });
}
