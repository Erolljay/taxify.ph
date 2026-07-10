/* ============================================================
   Tallo CPA – BIR Tax App
   tax-rates-admin.js – Settings → Tax Rates

   Lets a preparer introduce a new rate (VAT, Percentage Tax, the
   individual graduated income tax table, corporate rates, MCIT) with an
   effective date. Existing entries are never edited or removed once
   they can have been used by a filed return — a rate change is always a
   *new* dated entry (see tax-rates.js). "Undo" only exists to correct an
   entry added by mistake moments ago; built-in defaults can't be removed.
   ============================================================ */

function renderTaxRatesTab(el) {
  el.innerHTML = `
    <div class="tabs" id="tax-rates-subtabs" style="margin-bottom:14px;">
      <button type="button" class="tab active" data-tr-tab="vat">VAT &amp; Percentage Tax</button>
      <button type="button" class="tab" data-tr-tab="income">Individual Income Tax</button>
      <button type="button" class="tab" data-tr-tab="corporate">Corporate Tax &amp; MCIT</button>
    </div>
    <div data-tr-panel="vat"></div>
    <div data-tr-panel="income" hidden></div>
    <div data-tr-panel="corporate" hidden></div>
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
}

// ── SHARED HELPERS ──────────────────────────────────────────────
function trBadge(source) {
  return source === 'default'
    ? '<span style="font-size:10px;background:#e8edf5;color:#6b7280;padding:2px 8px;border-radius:10px;">Built-in</span>'
    : '';
}

function rateHistoryTableHtml(categoryKey, valueLabel, valueFormatter) {
  const rows = getTaxRateSeries(categoryKey);
  const trs = rows.map(r => `
    <tr style="border-bottom:.5px solid #f3f4f6;">
      <td style="padding:6px 10px;font-size:12px;">${escHtml(r.effectiveDate)}</td>
      <td style="padding:6px 10px;font-size:12px;font-weight:600;">${valueFormatter(r)}</td>
      <td style="padding:6px 10px;font-size:12px;color:#6b7280;">${escHtml(r.label || '')} ${trBadge(r.source)}</td>
      <td style="padding:6px 10px;text-align:center;">
        ${r.source === 'custom' ? `<button type="button" class="btn btn-outline btn-sm" data-tr-delete="${categoryKey}" data-tr-id="${r.id}">🗑 Undo</button>` : ''}
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
      <button type="button" class="btn btn-primary btn-sm" data-tr-add="${categoryKey}">+ Add Rate</button>
      <span class="tr-add-msg" data-tr-msg="${categoryKey}" style="font-size:11px;color:#6b7280;"></span>
    </div>`;
}

// Wires every generic add-form (data-tr-add / data-tr-field) and every
// delete button (data-tr-delete / data-tr-id) found inside `panel`.
function bindTaxRatePanel(panel, refresh) {
  panel.querySelectorAll('[data-tr-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Remove this entry? Only do this to undo a mistaken addition — a rate that may already have been used on a filed return should be superseded with a new dated entry instead, never removed.')) return;
      deleteTaxRateEntry(btn.dataset.trDelete, btn.dataset.trId);
      refresh();
    });
  });

  panel.querySelectorAll('[data-tr-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const categoryKey = btn.dataset.trAdd;
      const form = panel.querySelector(`.tr-add-form[data-tr-category="${categoryKey}"]`);
      const msg = panel.querySelector(`[data-tr-msg="${categoryKey}"]`);
      const entry = {};
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
      if (!entry.effectiveDate) { msg.textContent = '❌ Pick an effective date.'; msg.style.color = '#c0392b'; return; }
      if (hasInvalidNumber) { msg.textContent = '❌ Enter a valid rate.'; msg.style.color = '#c0392b'; return; }
      addTaxRateEntry(categoryKey, entry);
      msg.style.color = '#27ae60';
      msg.textContent = '✅ Added.';
      refresh();
    });
  });
}

// ── VAT & PERCENTAGE TAX ────────────────────────────────────────
function renderVatPtPanel(panel) {
  panel.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px;">
      ℹ️ Rates are never edited or removed once added — if BIR introduces a new rate, add it below with its
      effective date. Returns for earlier periods automatically keep using whatever rate was in force then.
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
  const tables = getTaxRateSeries('incomeTax');
  const tablesHtml = tables.map(r => `
    <div class="card" style="margin-bottom:10px;">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Effective ${escHtml(r.effectiveDate)}${r.label ? ' — ' + escHtml(r.label) : ''} ${trBadge(r.source)}</span>
        ${r.source === 'custom' ? `<button type="button" class="btn btn-outline btn-sm" data-tr-delete="incomeTax" data-tr-id="${r.id}">🗑 Undo</button>` : ''}
      </div>
      <table class="data-table" style="width:100%;margin-top:8px;">
        <thead><tr style="font-size:11px;color:#9ca3af;"><th style="text-align:left;padding:4px 10px;">Up To</th><th style="text-align:left;padding:4px 10px;">Rate</th></tr></thead>
        <tbody>${r.brackets.map(b => `<tr style="border-bottom:.5px solid #f3f4f6;"><td style="padding:5px 10px;font-size:12px;">${b.upTo === null || b.upTo === undefined ? 'No limit' : '₱' + Number(b.upTo).toLocaleString()}</td><td style="padding:5px 10px;font-size:12px;font-weight:600;">${(b.rate * 100).toFixed(2).replace(/\.?0+$/, '')}%</td></tr>`).join('')}</tbody>
      </table>
    </div>`).join('');

  panel.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px;">
      ℹ️ Add a new bracket table when the graduated rates change — earlier-year returns keep using whichever
      table was effective for that year.
    </div>
    ${tablesHtml}
    <div class="card">
      <div class="card-title">➕ Add a New Bracket Table</div>
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
        <button type="button" class="btn btn-primary btn-sm" id="tr-income-save">💾 Save New Table</button>
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
  const current = pickEffective('incomeTax', todayStr());
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
  addTaxRateEntry('incomeTax', { label, brackets });
  renderIncomeTaxPanel(panel);
}

// ── CORPORATE TAX & MCIT ────────────────────────────────────────
function renderCorporatePanel(panel) {
  const rows = getTaxRateSeries('corporate');
  const corpRowsHtml = rows.map(r => `
    <tr style="border-bottom:.5px solid #f3f4f6;">
      <td style="padding:6px 10px;font-size:12px;">${escHtml(r.effectiveDate)}</td>
      <td style="padding:6px 10px;font-size:12px;font-weight:600;">${r.regular}%</td>
      <td style="padding:6px 10px;font-size:12px;font-weight:600;">${r.small}%</td>
      <td style="padding:6px 10px;font-size:12px;color:#6b7280;">${escHtml(r.label || '')} ${trBadge(r.source)}</td>
      <td style="padding:6px 10px;text-align:center;">${r.source === 'custom' ? `<button type="button" class="btn btn-outline btn-sm" data-tr-delete="corporate" data-tr-id="${r.id}">🗑 Undo</button>` : ''}</td>
    </tr>`).join('');

  panel.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px;">
      ℹ️ Add a new dated entry when the corporate rate or MCIT rate changes — earlier-year returns keep
      using whatever rate was effective then.
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
        <button type="button" class="btn btn-primary btn-sm" id="tr-corp-add">+ Add Rate</button>
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
    addTaxRateEntry('corporate', { effectiveDate: date, regular, small, label });
    renderCorporatePanel(panel);
  });

  bindTaxRatePanel(panel, () => renderCorporatePanel(panel));
}
