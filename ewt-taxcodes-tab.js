/* ============================================================
   Tallo CPA – BIR Tax App
   ewt-taxcodes-tab.js – Shared "Tax Codes" tab for mapping
                         Manager tax codes to BIR ATC codes
                         (used by 1601EQ and 0619E)
   ============================================================ */

async function loadEwtTaxCodesTab() {
  const biz = App.currentBusiness || '';
  const out = document.getElementById('taxcodes-output');
  if (!out) return;
  if (!biz) { out.innerHTML = `<div class="alert alert-warn">⚠️ No business selected.</div>`; return; }

  out.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Loading tax codes…</span></div>`;
  try {
    const { atcToTcKey, taxCodes } = await getEwtTcMap(biz);

    const optionsHtml = taxCodes
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(tc => `<option value="${escHtml(tc.key)}">${escHtml(tc.name)}</option>`)
      .join('');

    const rows = Object.entries(ATC_MASTER).map(([atc, info]) => `
      <tr>
        <td>
          <strong>${escHtml(atc)}</strong> — ${escHtml(info.desc)} <span style="color:#9ca3af;">(${info.rate}%)</span>
          ${atcToTcKey[atc] ? '' : `<div style="font-size:10px;color:#c0392b;">⚠️ No matching tax code found in Manager</div>`}
        </td>
        <td>
          <select class="ewt-map-sel" data-atc="${atc}">
            <option value="">— Not mapped —</option>
            ${optionsHtml}
          </select>
        </td>
      </tr>`).join('');

    out.innerHTML = `
      <div class="alert alert-info" style="margin-bottom:14px;font-size:11px;">
        ℹ️ Each BIR ATC code is matched by default to a Manager tax code whose name contains the ATC code (e.g. "WC158").
        If your tax code names differ, choose the correct one here. This affects the figures pulled into 1601-EQ, 0619-E, 2307 and QAP.
      </div>
      <div class="card" style="padding:0;overflow:hidden;">
        <table class="tax-codes-table">
          <thead><tr><th style="width:55%;">BIR ATC Code</th><th>Tax Code in Manager (${taxCodes.length} found)</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end;">
        <button class="btn btn-primary" id="btn-save-ewt-taxcodes">💾 Save Mapping</button>
      </div>`;

    out.querySelectorAll('.ewt-map-sel').forEach(sel => {
      sel.value = atcToTcKey[sel.dataset.atc] || '';
    });

    document.getElementById('btn-save-ewt-taxcodes').addEventListener('click', () => {
      const overrides = {};
      out.querySelectorAll('.ewt-map-sel').forEach(sel => {
        overrides[sel.dataset.atc] = sel.value;
      });
      saveEwtMappingOverrides(biz, overrides);
      showToast('✅ EWT tax code mapping saved.', 'success');
    });
  } catch (err) {
    out.innerHTML = `<div class="alert alert-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// Wire up tab-switching for pages that include a `#eq-tabs`/`#me-tabs`-style
// tab bar with a "taxcodes" tab and `#tab-report` / `#tab-taxcodes` panels.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-bar').forEach(bar => {
    bar.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn'); if (!btn) return;
      const tab = btn.dataset.tab;
      if (!document.getElementById(`tab-${tab}`)) return;
      bar.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
      if (tab === 'taxcodes') loadEwtTaxCodesTab();
    });
  });
});
