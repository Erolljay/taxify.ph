/* ============================================================
   Taxify it! — generic step engine
   Drives an ordered sequence of steps (review / validate / download /
   final) for one tax-filing workflow (VAT, EWT, Compensation, Income Tax).
   Each step is locked until the previous one is marked complete.
   Steps of type review/download/final embed an existing report .html
   page unchanged, in a same-origin iframe; validate steps run an inline
   JS check against Manager data with no iframe required.

   The rail + step bodies are built once in mount(); switching the active
   step only toggles visibility (it never tears down a step's DOM), so
   iframes created for earlier steps (and their generated report state)
   stay alive — this is what lets a later "final" step reach back into an
   earlier step's iframe and click its download buttons programmatically.
   ============================================================ */

const StepEngine = (function () {

  // localStorage sentinel so a completed step survives a page reload.
  function storageKey(biz, workflowKey, stepKey) {
    return `taxify:step:${biz}:${workflowKey}:${stepKey}`;
  }
  function isDone(biz, workflowKey, stepKey) {
    return localStorage.getItem(storageKey(biz, workflowKey, stepKey)) === '1';
  }
  function markDone(biz, workflowKey, stepKey, done) {
    const k = storageKey(biz, workflowKey, stepKey);
    if (done) localStorage.setItem(k, '1');
    else localStorage.removeItem(k);
  }

  // Reset all step completion flags for a workflow (e.g. when starting a new period).
  function resetWorkflow(biz, workflowKey, steps) {
    steps.forEach(s => markDone(biz, workflowKey, s.key, false));
  }

  const TYPE_ICON = { review: '📊', validate: '🔎', download: '📥', final: '🏁', instruction: 'ℹ️', period: '📅', payment: '💳', checklist: '📋' };

  function periodStorageKey(biz, workflowKey) {
    return `taxify:period:${biz}:${workflowKey}`;
  }
  function loadPeriod(biz, workflowKey) {
    try { return JSON.parse(localStorage.getItem(periodStorageKey(biz, workflowKey)) || 'null'); }
    catch (e) { return null; }
  }
  function savePeriod(biz, workflowKey, period) {
    localStorage.setItem(periodStorageKey(biz, workflowKey), JSON.stringify(period));
  }

  // Builds the query string a downstream report iframe reads to pre-fill
  // and auto-run its own period filter (see sls-report.js / sawt-report.js /
  // 2550q.html), so the period chosen in the workflow's 'period' step
  // cascades into every later step without the user re-picking it.
  function periodQueryString(state, step) {
    const p = state.period;
    if (!p) return '';
    const params = new URLSearchParams({ ptype: p.ptype, year: p.year });
    if (p.ptype !== 'annual') params.set('period', p.period);
    if (step.formParam) params.set('form', step.formParam);
    return params.toString();
  }

  function mount(container, workflow, biz) {
    const state = {
      biz, workflow,
      activeIndex: 0,
      doneCache: {},     // stepKey -> bool (mirrors localStorage)
      bodyEls: {},        // stepKey -> the persistent <div class="tfy-step-body"> for that step
      iframes: {},        // iframeId -> <iframe> (shared across steps that reuse the same report file)
      period: loadPeriod(biz, workflow.key),
    };

    workflow.steps.forEach(s => { state.doneCache[s.key] = isDone(biz, workflow.key, s.key); });
    const firstPending = workflow.steps.findIndex(s => !state.doneCache[s.key]);
    state.activeIndex = firstPending === -1 ? workflow.steps.length - 1 : firstPending;

    buildSkeleton(container, state);
    renderRail(container, state);
    showActiveStep(container, state);

    const handle = {
      reset() {
        resetWorkflow(state.biz, workflow.key, workflow.steps);
        workflow.steps.forEach(s => { state.doneCache[s.key] = false; });
        state.activeIndex = 0;
        renderRail(container, state);
        showActiveStep(container, state);
      },
    };
    container._tfyHandle = handle;
    return handle;
  }

  function isLocked(state, idx) {
    for (let i = 0; i < idx; i++) {
      if (!state.doneCache[state.workflow.steps[i].key]) return true;
    }
    return false;
  }

  // Built exactly once per mount(); never replaced afterwards so step bodies
  // (and the iframes inside them) persist across rail navigation.
  function buildSkeleton(container, state) {
    container.innerHTML = `
      <div class="tfy-step-wrap">
        <div class="tfy-step-rail">
          <div class="tfy-step-rail-title">${escHtml(state.workflow.label)}</div>
          <div class="tfy-step-rail-list"></div>
          <button type="button" class="tfy-step-restart" id="tfy-restart">↺ Restart workflow</button>
        </div>
        <div class="tfy-step-panel" id="tfy-step-panel"></div>
      </div>`;

    container.querySelector('#tfy-restart').addEventListener('click', () => {
      if (!confirm('Restart this workflow? Completion flags for every step will be cleared.')) return;
      resetWorkflow(state.biz, state.workflow.key, state.workflow.steps);
      state.workflow.steps.forEach(s => { state.doneCache[s.key] = false; });
      state.activeIndex = 0;
      renderRail(container, state);
      showActiveStep(container, state);
    });

    const panel = container.querySelector('#tfy-step-panel');
    state.workflow.steps.forEach((step, i) => {
      const header = document.createElement('div');
      header.className = 'tfy-step-header';
      header.dataset.stepKey = step.key;
      header.style.display = 'none';

      const body = document.createElement('div');
      body.className = 'tfy-step-body';
      body.dataset.stepKey = step.key;
      body.style.display = 'none';

      panel.appendChild(header);
      panel.appendChild(body);
      state.bodyEls[step.key] = body;

      mountStep(header, body, panel, state, step, i);
    });
  }

  function renderRail(container, state) {
    const { workflow } = state;
    const railHtml = workflow.steps.map((s, i) => {
      const done   = !!state.doneCache[s.key];
      const locked = isLocked(state, i);
      const active = i === state.activeIndex;
      const icon   = done ? '✅' : locked ? '🔒' : (TYPE_ICON[s.type] || '▫️');
      return `<button type="button" class="tfy-step-item${active ? ' active' : ''}${locked ? ' locked' : ''}${done ? ' done' : ''}"
                data-idx="${i}" ${locked ? 'disabled' : ''}>
        <span class="tfy-step-icon">${icon}</span>
        <span class="tfy-step-label">${escHtml(s.label)}</span>
      </button>`;
    }).join('');

    const list = container.querySelector('.tfy-step-rail-list');
    list.innerHTML = railHtml;
    list.querySelectorAll('.tfy-step-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        if (isLocked(state, idx)) return;
        state.activeIndex = idx;
        renderRail(container, state);
        showActiveStep(container, state);
      });
    });
  }

  function showActiveStep(container, state) {
    const activeStep = state.workflow.steps[state.activeIndex];
    state.workflow.steps.forEach(s => {
      const show = s.key === activeStep.key;
      const panel = container.querySelector('#tfy-step-panel');
      const header = panel.querySelector(`.tfy-step-header[data-step-key="${s.key}"]`);
      const body   = state.bodyEls[s.key];
      if (header) header.style.display = show ? '' : 'none';
      if (body)   body.style.display   = show ? '' : 'none';
    });
    const onShow = state._onShow && state._onShow[activeStep.key];
    if (onShow) onShow();
  }

  function setStepDone(container, state, stepKey, done) {
    markDone(state.biz, state.workflow.key, stepKey, done);
    state.doneCache[stepKey] = done;
    renderRail(container, state);
    refreshStepFooter(container, state, stepKey);

    if (done) {
      const idx = state.workflow.steps.findIndex(s => s.key === stepKey);
      if (idx === state.activeIndex && idx < state.workflow.steps.length - 1) {
        state.activeIndex = idx + 1;
        renderRail(container, state);
        showActiveStep(container, state);
      }
    }
  }

  function refreshStepFooter(container, state, stepKey) {
    const step = state.workflow.steps.find(s => s.key === stepKey);
    const body = state.bodyEls[stepKey];
    if (!step || !body) return;
    if (step.type === 'download') renderDownloadFooter(body, container, state, step);
    if (step.type === 'final')    renderFinalFooter(body, container, state, step);
  }

  function getOrCreateIframe(state, mountEl, iframeId, file) {
    if (state.iframes[iframeId]) return state.iframes[iframeId];
    let holder = mountEl.querySelector(`[data-iframe-id="${iframeId}"]`);
    if (!holder) {
      holder = document.createElement('div');
      holder.dataset.iframeId = iframeId;
      holder.className = 'tfy-iframe-holder';
      const iframe = document.createElement('iframe');
      iframe.className = 'tfy-iframe';
      iframe.src = file;
      holder.appendChild(iframe);
      mountEl.appendChild(holder);
      state.iframes[iframeId] = iframe;
    }
    return state.iframes[iframeId];
  }

  // Watches one or more button ids inside a same-origin iframe document and
  // fires onClicked the first time any of them is actually clicked (proof of
  // download), without modifying the report page itself.
  function watchDownloadButtons(iframe, buttonIds, onClicked) {
    const seen = new Set();
    const tryAttach = () => {
      const doc = iframe.contentDocument;
      if (!doc) return false;
      let allFound = true;
      buttonIds.forEach(id => {
        const btn = doc.getElementById(id);
        if (!btn) { allFound = false; return; }
        if (btn.dataset.tfyWatched) return;
        btn.dataset.tfyWatched = '1';
        btn.addEventListener('click', () => { seen.add(id); onClicked(seen); });
      });
      return allFound;
    };
    if (!tryAttach()) {
      const poll = setInterval(() => { if (tryAttach()) clearInterval(poll); }, 500);
      setTimeout(() => clearInterval(poll), 60000);
    }
  }

  // One-time setup of a step's header + body DOM. Called once per step at
  // skeleton-build time; visibility toggling is handled separately so the
  // step's internal state (iframe, listeners) is never recreated.
  function mountStep(header, body, panel, state, step, idx) {
    header.innerHTML = `
      <div class="tfy-step-header-title">${TYPE_ICON[step.type] || ''} ${escHtml(step.label)}</div>
      ${step.help ? `<div class="tfy-step-header-help">${step.help}</div>` : ''}`;

    if (step.type === 'review' || step.type === 'download' || (step.type === 'final' && step.file)) {
      mountIframeStep(body, panel, state, step);
    } else if (step.type === 'final') {
      mountBundleFinalStep(body, panel, state, step);
    } else if (step.type === 'validate') {
      mountValidateStep(body, panel, state, step);
    } else if (step.type === 'checklist') {
      mountChecklistStep(body, panel, state, step);
    } else if (step.type === 'instruction') {
      mountInstructionStep(body, panel, state, step);
    } else if (step.type === 'period') {
      mountPeriodStep(body, panel, state, step);
    } else if (step.type === 'payment') {
      mountPaymentStep(body, panel, state, step);
    }
  }

  // A 'final' step with no file/iframeId of its own (e.g. a working-paper
  // bundle step that only re-triggers downloads from earlier steps) — no
  // iframe to mount, just the final footer.
  function mountBundleFinalStep(body, panel, state, step) {
    const footer = document.createElement('div');
    footer.className = 'tfy-step-footer';
    body.appendChild(footer);
    renderFinalFooter(body, panel.closest('.tfy-step-wrap').parentElement, state, step);
  }

  // Iframe creation (and therefore each report's own API calls to Manager)
  // is deferred until the step is actually shown for the first time, rather
  // than happening eagerly for every step at mount() time. Two reasons:
  // (1) a 'period'-gated step built eagerly would read state.period before
  // the user ever reached the 'period' step and chose one, so its iframe
  // would load with no period query string at all; (2) building every
  // report iframe in a multi-step workflow up front fires all of their
  // Manager API calls at once, which is enough concurrent load to time out.
  function mountIframeStep(body, panel, state, step) {
    const mountEl = document.createElement('div');
    mountEl.className = 'tfy-iframe-mount';
    body.appendChild(mountEl);

    const footer = document.createElement('div');
    footer.className = 'tfy-step-footer';
    body.appendChild(footer);

    if (!state._onShow) state._onShow = {};
    let mounted = false;
    state._onShow[step.key] = () => {
      // Two steps can share one iframeId (e.g. the tax-status and report
      // steps both live inside 1601c.html) — re-focus this step's tab every
      // time it's shown again, not just the first time it's mounted.
      if (mounted) {
        if (step.focusTab) focusIframeTab(state.iframes[step.iframeId], step.focusTab);
        return;
      }
      mounted = true;
      mountIframeStepContent(mountEl, footer, body, panel, state, step);
    };
  }

  // Same-origin iframe embedding a tabbed report (e.g. 1601c.html) — click
  // the tab button matching `data-tab="<tabKey>"` so a step can deep-link
  // into one specific tab of a page shared with another step.
  function focusIframeTab(iframe, tabKey) {
    if (!iframe) return;
    const tryFocus = () => {
      const doc = iframe.contentDocument;
      const btn = doc && doc.querySelector(`.tab-btn[data-tab="${tabKey}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    };
    if (!tryFocus()) {
      const poll = setInterval(() => { if (tryFocus()) clearInterval(poll); }, 300);
      setTimeout(() => clearInterval(poll), 20000);
    }
  }

  function mountIframeStepContent(mountEl, footer, body, panel, state, step) {
    let file = step.fileFn ? step.fileFn(state.period) : step.file;
    // Always pass the already-known business along — the wizard already has
    // it from when the user picked a business before entering the workflow,
    // so the embedded report shouldn't ask again.
    const params = new URLSearchParams({ biz: state.biz });
    if (step.usesPeriod) {
      const qs = periodQueryString(state, step);
      if (qs) new URLSearchParams(qs).forEach((v, k) => params.set(k, v));
    }
    file = file + (file.includes('?') ? '&' : '?') + params.toString();
    const iframe = getOrCreateIframe(state, mountEl, step.iframeId, file);
    if (step.focusTab) focusIframeTab(iframe, step.focusTab);
    const root = panel.closest('.tfy-step-wrap').parentElement;

    if (step.type === 'review') {
      if (step.requireAllTaxStatus) {
        mountTaxStatusGate(footer, iframe, root, state, step);
      } else {
        footer.innerHTML = `<button class="btn btn-primary" id="tfy-continue">Continue →</button>`;
        footer.querySelector('#tfy-continue').onclick = () => setStepDone(root, state, step.key, true);
      }
    } else if (step.type === 'download') {
      renderDownloadFooter(body, panel.closest('.tfy-step-wrap').parentElement, state, step);
      if (!state.doneCache[step.key]) {
        const seenAll = (seen) => step.requireAll
          ? step.buttonIds.every(id => seen.has(id))
          : seen.size > 0;
        watchDownloadButtons(iframe, step.buttonIds, (seen) => {
          if (seenAll(seen)) setStepDone(panel.closest('.tfy-step-wrap').parentElement, state, step.key, true);
        });
      }
    } else if (step.type === 'final') {
      renderFinalFooter(body, panel.closest('.tfy-step-wrap').parentElement, state, step);
    }
  }

  // Gates a 'review' step's Continue button on every employee having a Tax
  // Status set (polls the embedded 1601c.html's own `_taxStatusState`, same-
  // origin iframe), while still requiring the user to click Continue
  // themselves — passing the count doesn't prove no one was misidentified.
  function mountTaxStatusGate(footer, iframe, root, state, step) {
    function render(ready, blanks, total) {
      footer.innerHTML = `
        <div class="alert ${ready ? 'alert-success' : 'alert-warn'}" style="margin-bottom:8px;">
          ${ready
            ? '✅ Every employee has a Tax Status. Double-check none were misidentified, then continue.'
            : total === 0
              ? 'Loading employees…'
              : `⚠️ ${blanks} employee(s) still have no Tax Status set — fix them above before continuing.`}
        </div>
        <button class="btn btn-primary" id="tfy-continue" ${ready ? '' : 'disabled'}>Continue →</button>`;
      footer.querySelector('#tfy-continue').onclick = () => setStepDone(root, state, step.key, true);
    }
    render(false, 0, 0);
    const poll = setInterval(() => {
      const s = iframe.contentWindow && iframe.contentWindow._taxStatusState;
      if (!s || !Array.isArray(s.employees)) return;
      const total = s.employees.length;
      const blanks = s.employees.filter(e => !e.taxStatus).length;
      render(total > 0 && blanks === 0, blanks, total);
    }, 500);
  }

  function renderDownloadFooter(body, root, state, step) {
    const footer = body.querySelector('.tfy-step-footer');
    const done = !!state.doneCache[step.key];
    footer.innerHTML = `
      <div class="alert ${done ? 'alert-success' : 'alert-warn'}" style="margin-bottom:8px;">
        ${done ? '✅ Download confirmed for this step.' : `⚠️ Click ${step.requireAll ? 'every' : 'one of the'} download button${step.buttonIds.length>1?'s':''} inside the report above (${step.buttonIds.map(escHtml).join(', ')}) to continue.`}
      </div>
      <button class="btn btn-primary" id="tfy-continue" ${done ? '' : 'disabled'}>Continue →</button>
      <button class="btn btn-outline" id="tfy-skip" style="margin-left:6px;">I already downloaded this — mark complete</button>
      ${step.skippable ? `<button class="btn btn-outline" id="tfy-noop" style="margin-left:6px;">${escHtml(step.skipLabel || 'Not applicable — skip')}</button>` : ''}`;
    footer.querySelector('#tfy-continue').onclick = () => setStepDone(root, state, step.key, true);
    footer.querySelector('#tfy-skip').onclick = () => setStepDone(root, state, step.key, true);
    const noop = footer.querySelector('#tfy-noop');
    if (noop) noop.onclick = () => setStepDone(root, state, step.key, true);
  }

  function renderFinalFooter(body, root, state, step) {
    const footer = body.querySelector('.tfy-step-footer');
    footer.innerHTML = `
      ${step.bundle ? `<button class="btn btn-success" id="tfy-download-all">⬇ Download all (${step.bundle.length} files)</button>` : ''}
      <button class="btn btn-primary" id="tfy-finish" style="margin-left:6px;">Mark workflow complete ✓</button>`;
    if (step.bundle) {
      footer.querySelector('#tfy-download-all').onclick = () => {
        step.bundle.forEach(targetStepKey => {
          const targetStep = state.workflow.steps.find(s => s.key === targetStepKey);
          if (!targetStep) return;
          const targetIframe = state.iframes[targetStep.iframeId];
          const doc = targetIframe && targetIframe.contentDocument;
          if (!doc) return;
          (targetStep.buttonIds || []).forEach(id => {
            const btn = doc.getElementById(id);
            if (btn && btn.style.display !== 'none') btn.click();
          });
        });
      };
    }
    footer.querySelector('#tfy-finish').onclick = () => {
      setStepDone(root, state, step.key, true);
      showCompletionCelebration(root, state);
    };
  }

  function showCompletionCelebration(root, state) {
    const p = state.period;
    const periodLabel = p
      ? (p.ptype === 'monthly' ? monthName(p.period) : p.ptype === 'quarterly' ? `Q${p.period}` : 'Annual') + ' ' + p.year
      : '';
    const workflowLabel = state.workflow.label || 'Workflow';

    const overlay = document.createElement('div');
    overlay.id = 'tfy-completion-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;
      display:flex;align-items:center;justify-content:center;`;
    overlay.innerHTML = `
      <div style="
        background:#fff;border-radius:16px;padding:40px 48px;max-width:480px;width:90%;
        text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.25);position:relative;">
        <div style="font-size:56px;line-height:1;margin-bottom:16px;">🎉</div>
        <h2 style="margin:0 0 6px;font-size:22px;color:#111827;">Filing Complete!</h2>
        <p style="margin:0 0 4px;font-size:15px;color:#374151;font-weight:600;">
          ${escHtml(workflowLabel)}${periodLabel ? ` — ${escHtml(periodLabel)}` : ''}
        </p>
        <p style="margin:12px 0 24px;font-size:13px;color:#6b7280;line-height:1.6;">
          Great work! Make sure you have downloaded and compiled all your
          working papers and DAT files for this filing period before
          starting a new one.
        </p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <button id="tfy-cel-close" class="btn btn-outline" style="min-width:120px;">Close</button>
          <button id="tfy-cel-restart" class="btn btn-primary" style="min-width:160px;">↺ Start New Period</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    overlay.querySelector('#tfy-cel-close').onclick = () => overlay.remove();
    overlay.querySelector('#tfy-cel-restart').onclick = () => {
      overlay.remove();
      // Trigger the workflow reset via the handle stored on the container
      const handle = root._tfyHandle;
      if (handle && handle.reset) handle.reset();
    };
    // Click outside to close
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ── Instruction step: static guidance with a Continue button. ──────────
  function mountInstructionStep(body, panel, state, step) {
    const footer = document.createElement('div');
    body.innerHTML = `<div class="alert alert-warn" style="margin-bottom:12px;">${step.body || ''}</div>`;
    footer.className = 'tfy-step-footer';
    body.appendChild(footer);
    footer.innerHTML = `<button class="btn btn-primary" id="tfy-continue">I've checked this — Continue →</button>`;
    footer.querySelector('#tfy-continue').onclick = () => {
      const root = panel.closest('.tfy-step-wrap').parentElement;
      setStepDone(root, state, step.key, true);
    };
  }

  // ── Period step: monthly/quarterly + month-or-quarter + year picker. ───
  // The chosen value is stored on state.period and persisted per (biz,
  // workflow), and picked up by any later step with usesPeriod:true via
  // periodQueryString() to pre-fill and auto-run that step's own report.
  function mountPeriodStep(body, panel, state, step) {
    const now = new Date();
    const curQ = Math.ceil((now.getMonth() + 1) / 3);
    const curY = now.getFullYear();
    const years = [curY - 2, curY - 1, curY, curY + 1];
    const saved = state.period || { ptype: 'quarterly', period: curQ, year: curY };

    body.innerHTML = `
      <div class="filter-bar">
        <label>Period type</label>
        <select id="tfy-ptype">
          <option value="quarterly"${saved.ptype === 'quarterly' ? ' selected' : ''}>Quarterly</option>
          <option value="monthly"${saved.ptype === 'monthly' ? ' selected' : ''}>Monthly</option>
        </select>
        <span id="tfy-qwrap" style="${saved.ptype === 'monthly' ? 'display:none;' : ''}">
          <label>Quarter</label>
          <select id="tfy-quarter">
            ${[1,2,3,4].map(q => `<option value="${q}"${q === saved.period && saved.ptype === 'quarterly' ? ' selected' : ''}>Q${q}</option>`).join('')}
          </select>
        </span>
        <span id="tfy-mwrap" style="${saved.ptype === 'quarterly' ? 'display:none;' : ''}">
          <label>Month</label>
          <select id="tfy-month">
            ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m => `<option value="${m}"${m === saved.period && saved.ptype === 'monthly' ? ' selected' : ''}>${monthName(m)}</option>`).join('')}
          </select>
        </span>
        <label>Year</label>
        <select id="tfy-year">
          ${years.map(y => `<option value="${y}"${y === saved.year ? ' selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>
      <div class="tfy-step-footer">
        <button class="btn btn-primary" id="tfy-continue">Use this period →</button>
      </div>`;

    body.querySelector('#tfy-ptype').addEventListener('change', function () {
      const isM = this.value === 'monthly';
      body.querySelector('#tfy-qwrap').style.display = isM ? 'none' : '';
      body.querySelector('#tfy-mwrap').style.display = isM ? '' : 'none';
    });

    body.querySelector('#tfy-continue').onclick = () => {
      const ptype = body.querySelector('#tfy-ptype').value;
      const period = parseInt(body.querySelector(ptype === 'monthly' ? '#tfy-month' : '#tfy-quarter').value, 10);
      const year = parseInt(body.querySelector('#tfy-year').value, 10);
      state.period = { ptype, period, year };
      savePeriod(state.biz, state.workflow.key, state.period);
      refreshPeriodIframes(state);
      const root = panel.closest('.tfy-step-wrap').parentElement;
      setStepDone(root, state, step.key, true);
    };
  }

  // Reloads any already-created report iframe whose step uses the period —
  // without this, changing the period after a report has already been
  // opened once would leave that iframe showing stale figures forever,
  // since getOrCreateIframe() only ever sets src the first time.
  function refreshPeriodIframes(state) {
    state.workflow.steps.forEach(s => {
      if (!s.usesPeriod || !s.iframeId) return;
      const iframe = state.iframes[s.iframeId];
      if (!iframe) return;
      const params = new URLSearchParams({ biz: state.biz });
      const qs = periodQueryString(state, s);
      if (qs) new URLSearchParams(qs).forEach((v, k) => params.set(k, v));
      iframe.src = s.file + (s.file.includes('?') ? '&' : '?') + params.toString();
    });
  }

  // ── Payment step: posts the VAT due/carryover into Manager. ────────────
  // Reads the net VAT figures the 2550Q step already computed (window._v
  // inside that iframe — i37 = output tax for the quarter, i61 = net VAT
  // payable after credits; i61 > 0 means cash is due, i61 <= 0 means the
  // balance carries over as input tax credit). Posts a Payment (clearing the
  // output/input tax accounts, cash out of the chosen bank/cash account) when
  // i61 > 0, or a Journal Entry (clearing output/input tax into a carryover
  // asset account) when i61 <= 0.
  // Deferred until the step is actually shown — like the iframe steps, this
  // is mounted once for every step at workflow-build time, but the 2550Q
  // step's iframe (which this reads window._v from) is itself only created
  // lazily when that step is first shown, so reading it eagerly here would
  // always find nothing.
  function mountPaymentStep(body, panel, state, step) {
    if (!state._onShow) state._onShow = {};
    let posted = false;
    state._onShow[step.key] = () => {
      // Re-attempt on every show (not just the first) until either the
      // source step's totals become readable or the user posts — the
      // return iframe is itself lazy-mounted and its computation is async,
      // so the totals may simply not exist yet on an earlier visit.
      if (posted) return;
      if (step.paymentFlavor === 'ewt') {
        mountEwtPaymentStepContent(body, panel, state, step, () => { posted = true; });
      } else if (step.paymentFlavor === 'itr') {
        mountItrPaymentStepContent(body, panel, state, step, () => { posted = true; });
      } else {
        mountPaymentStepContent(body, panel, state, step, () => { posted = true; });
      }
    };
  }

  function mountPaymentStepContent(body, panel, state, step, onPosted) {
    const root = panel.closest('.tfy-step-wrap').parentElement;
    body.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Reading VAT return totals…</span></div>`;

    const sourceStep = state.workflow.steps.find(s => s.key === step.sourceStepKey);
    const sourceIframe = sourceStep && state.iframes[sourceStep.iframeId];
    const win = sourceIframe && sourceIframe.contentWindow;
    const v = win && win._v;

    if (!v || v.i37 == null || v.i60 == null) {
      body.innerHTML = `<div class="alert alert-warn">⚠️ Open and generate the 2550Q step first so this step can read the computed VAT totals.<br><br>Once you've opened that step and it finishes generating, come back here — this will retry automatically.</div>`;
      return;
    }

    // i37 = output tax for the quarter. i60 = total available input tax
    // credit (this quarter + carried-over). i20/i25 = CWT and other credits
    // applied against VAT due (Schedule 3 / SAWT). Any unused input tax
    // simply stays in the Input Tax asset account as next quarter's
    // carryover — no entry is needed for it.
    const outputTax = v.i37;
    const inputUsed = Math.min(v.i60, outputTax);
    const remainingAfterInput = Math.max(outputTax - inputUsed, 0);
    const cwtPool = (v.i20 || 0) + (v.i25 || 0);
    const cwtUsed = Math.min(cwtPool, remainingAfterInput);
    const netCash = outputTax - inputUsed - cwtUsed;
    const isPayable = netCash > 0.005;

    Promise.all([
      fetchAllBatch('/api4/bank-or-cash-account-batch', state.biz).catch(() => []),
      fetchAllBatch('/api4/balance-sheet-account-batch', state.biz).catch(() => []),
      fetchAllBatch('/api4/profit-and-loss-statement-account-batch', state.biz).catch(() => []),
    ]).then(([bankAcctsRaw, bsAcctsRaw, plAcctsRaw]) => {
      // Batch items aren't flat {key, name} objects — the actual account
      // data is nested under it.item / it.value (same shape pnl-helpers.js
      // unwraps), with it.key as a fallback when the nested object has none.
      const unwrap = it => {
        const a = (it && (it.item || it.value)) || it;
        if (!a) return null;
        return { ...a, key: a.key || (it && it.key) };
      };
      const bankAccts = bankAcctsRaw.map(unwrap).filter(a => a && a.name && a.key);
      const allAccts = [...bsAcctsRaw, ...plAcctsRaw]
        .map(unwrap)
        .filter(a => a && a.name && a.key)
        .sort((a, b) => a.name.localeCompare(b.name));
      const today = new Date().toISOString().slice(0, 10);
      const reference = `VAT ${state.period ? `${state.period.ptype === 'monthly' ? monthName(state.period.period) : 'Q' + state.period.period} ${state.period.year}` : ''}`.trim();

      // Pre-fill the editable line rows with the same clearing entries the
      // engine would compute on its own; the user can edit, retitle, add,
      // or remove rows before posting — accounts aren't pre-selected since
      // we don't know which ones map to "Output VAT" / "Input Tax" /
      // "Creditable WV" for this business.
      const initialRows = [
        { desc: 'Clear Output VAT', debit: outputTax, credit: 0 },
      ];
      if (inputUsed > 0.005) initialRows.push({ desc: 'Apply Input Tax', debit: 0, credit: inputUsed });
      if (cwtUsed > 0.005) initialRows.push({ desc: 'Apply Creditable WV', debit: 0, credit: cwtUsed });
      if (!isPayable) {
        // No cash leg — debits must equal credits within the entry itself.
      }

      const acctOpts = sel => allAccts.map(a => `<option value="${a.key}"${a.key === sel ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('');
      const bankOpts = bankAccts.map(a => `<option value="${a.key}">${escHtml(a.name)}</option>`).join('');

      const rowHtml = (r, i) => `
        <tr data-row="${i}">
          <td><select class="tfy-je-acct">${acctOpts(r.account)}</select></td>
          <td><input type="text" class="tfy-je-desc" value="${escHtml(r.desc || '')}"></td>
          <td><input type="number" step="0.01" class="tfy-je-debit" value="${r.debit ? r.debit.toFixed(2) : ''}"></td>
          <td><input type="number" step="0.01" class="tfy-je-credit" value="${r.credit ? r.credit.toFixed(2) : ''}"></td>
          <td><button type="button" class="btn btn-outline tfy-je-remove" style="padding:2px 8px;">✕</button></td>
        </tr>`;

      body.innerHTML = `
        <div class="alert ${isPayable ? 'alert-warn' : 'alert-success'}" style="margin-bottom:10px;">
          Output VAT: <strong>${fmtMoney(outputTax)}</strong> &nbsp;|&nbsp;
          Input tax applied: <strong>${fmtMoney(inputUsed)}</strong> &nbsp;|&nbsp;
          CWT/other credits applied: <strong>${fmtMoney(cwtUsed)}</strong> &nbsp;|&nbsp;
          ${isPayable ? `Net VAT payable: <strong>${fmtMoney(netCash)}</strong> (posted as a Payment)` : `No cash due — posted as a Journal Entry.`}
        </div>
        <div class="filter-bar" style="flex-wrap:wrap;margin-bottom:10px;">
          <label>Date</label>
          <input type="date" id="tfy-je-date" value="${today}">
          ${isPayable ? `
          <label>Pay from (Bank/Cash)</label>
          <select id="tfy-acct-bank">${bankOpts}</select>` : ''}
        </div>
        <table class="tax-codes-table" id="tfy-je-table">
          <thead><tr><th>Account</th><th>Description</th><th style="width:110px;">Debit</th><th style="width:110px;">Credit</th><th style="width:30px;"></th></tr></thead>
          <tbody>${initialRows.map(rowHtml).join('')}</tbody>
          <tfoot><tr>
            <td colspan="2" style="text-align:right;font-weight:700;">Total</td>
            <td id="tfy-je-total-debit" class="num" style="font-weight:700;"></td>
            <td id="tfy-je-total-credit" class="num" style="font-weight:700;"></td>
            <td></td>
          </tr></tfoot>
        </table>
        <button type="button" class="btn btn-outline" id="tfy-je-add" style="margin-top:8px;">+ Add line</button>
        <div id="tfy-je-balance" style="margin-top:8px;font-size:12px;"></div>
        <div class="tfy-step-footer">
          <button class="btn btn-primary" id="tfy-post">${isPayable ? 'Record VAT payment' : 'Record VAT closing entry'}</button>
          <span id="tfy-post-status" style="font-size:12px;color:#6b7280;margin-left:8px;"></span>
        </div>`;

      const tbody = body.querySelector('#tfy-je-table tbody');

      function addRow(r) {
        const i = tbody.children.length;
        tbody.insertAdjacentHTML('beforeend', rowHtml(r || {}, i));
      }

      function readRows() {
        return Array.from(tbody.querySelectorAll('tr')).map(tr => ({
          account: tr.querySelector('.tfy-je-acct').value,
          desc: tr.querySelector('.tfy-je-desc').value.trim(),
          debit: parseFloat(tr.querySelector('.tfy-je-debit').value) || 0,
          credit: parseFloat(tr.querySelector('.tfy-je-credit').value) || 0,
        })).filter(r => r.debit > 0.005 || r.credit > 0.005);
      }

      function recalcTotals() {
        const rows = readRows();
        const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
        const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
        body.querySelector('#tfy-je-total-debit').textContent = fmtMoney(totalDebit);
        body.querySelector('#tfy-je-total-credit').textContent = fmtMoney(totalCredit);
        const balanceEl = body.querySelector('#tfy-je-balance');
        const diff = totalDebit - totalCredit;
        if (isPayable) {
          // For a Payment, the lines' net (debit − credit) is what's drawn
          // from the bank/cash account — it should equal the net VAT due.
          const ok = Math.abs(diff - netCash) < 0.01;
          balanceEl.innerHTML = ok
            ? `✅ Net of lines (${fmtMoney(diff)}) matches the amount to be paid from the bank/cash account.`
            : `⚠️ Net of lines (${fmtMoney(diff)}) should equal the net VAT payable (${fmtMoney(netCash)}).`;
        } else {
          const ok = Math.abs(diff) < 0.01;
          balanceEl.innerHTML = ok
            ? `✅ Entry is balanced.`
            : `⚠️ Debits and credits must be equal to post a journal entry (currently off by ${fmtMoney(diff)}).`;
        }
        return { totalDebit, totalCredit, diff };
      }

      tbody.addEventListener('input', recalcTotals);
      tbody.addEventListener('click', (e) => {
        if (e.target.classList.contains('tfy-je-remove')) {
          e.target.closest('tr').remove();
          recalcTotals();
        }
      });
      body.querySelector('#tfy-je-add').onclick = () => { addRow(); recalcTotals(); };
      recalcTotals();

      body.querySelector('#tfy-post').onclick = async () => {
        const statusEl = body.querySelector('#tfy-post-status');
        const rows = readRows();
        const postDate = body.querySelector('#tfy-je-date').value;
        if (!postDate) { statusEl.textContent = '❌ Pick a date.'; return; }
        if (!rows.length) { statusEl.textContent = '❌ Add at least one line.'; return; }
        if (rows.some(r => !r.account)) { statusEl.textContent = '❌ Every line needs an account.'; return; }

        statusEl.textContent = 'Posting…';
        try {
          if (isPayable) {
            const bankAcct = body.querySelector('#tfy-acct-bank').value;
            const lines = rows.map(r => ({
              account: r.account,
              lineDescription: r.desc || undefined,
              amount: r.debit - r.credit,
            }));
            await apiRequest('PUT', '/api4/payment', {
              key: crypto.randomUUID(),
              value: { date: postDate, reference, paidFrom: bankAcct, description: `VAT payment — ${reference}`, lines },
            });
          } else {
            const lines = rows.map(r => ({
              account: r.account,
              lineDescription: r.desc || undefined,
              debit: r.debit,
              credit: r.credit,
            }));
            await apiRequest('PUT', '/api4/journal-entry', {
              key: crypto.randomUUID(),
              value: { date: postDate, reference, narration: `VAT close — ${reference}`, lines },
            });
          }
          statusEl.textContent = '✅ Posted.';
          onPosted();
          setStepDone(root, state, step.key, true);
        } catch (e) {
          statusEl.textContent = `❌ ${e.message}`;
        }
      };
    });
  }

  // ── EWT payment step: posts the withholding tax remittance. ─────────────
  // Simpler than the VAT payment step — reads window._e.totalEwt from the
  // EWT return iframe (0619-E or 1601-EQ depending on ptype) and builds a
  // straight payment from a bank/cash account.
  function mountEwtPaymentStepContent(body, panel, state, step, onPosted) {
    const root = panel.closest('.tfy-step-wrap').parentElement;
    body.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Reading EWT return totals…</span></div>`;

    const sourceStep = state.workflow.steps.find(s => s.key === step.sourceStepKey);
    const sourceIframe = sourceStep && state.iframes[sourceStep.iframeId];
    const win = sourceIframe && sourceIframe.contentWindow;
    const e = win && win._e;

    if (!e || e.totalEwt == null) {
      body.innerHTML = `<div class="alert alert-warn">⚠️ Open and generate the EWT return step first so this step can read the computed totals.<br><br>Once that step has finished generating, come back here — this will retry automatically.</div>`;
      return;
    }

    const totalEwt = e.totalEwt;
    const isPayable = totalEwt > 0.005;

    Promise.all([
      fetchAllBatch('/api4/bank-or-cash-account-batch', state.biz).catch(() => []),
      fetchAllBatch('/api4/balance-sheet-account-batch', state.biz).catch(() => []),
      fetchAllBatch('/api4/profit-and-loss-statement-account-batch', state.biz).catch(() => []),
    ]).then(([bankAcctsRaw, bsAcctsRaw, plAcctsRaw]) => {
      const unwrap = it => {
        const a = (it && (it.item || it.value)) || it;
        if (!a) return null;
        return { ...a, key: a.key || (it && it.key) };
      };
      const bankAccts = bankAcctsRaw.map(unwrap).filter(a => a && a.name && a.key);
      const allAccts = [...bsAcctsRaw, ...plAcctsRaw]
        .map(unwrap)
        .filter(a => a && a.name && a.key)
        .sort((a, b) => a.name.localeCompare(b.name));
      const today = new Date().toISOString().slice(0, 10);
      const pLabel = state.period
        ? (state.period.ptype === 'monthly' ? monthName(state.period.period) : 'Q' + state.period.period) + ' ' + state.period.year
        : '';
      const reference = `EWT ${pLabel}`.trim();

      const initialRows = [
        { desc: 'Withholding Tax Payable (EWT)', debit: totalEwt, credit: 0 },
      ];

      const acctOpts = sel => allAccts.map(a => `<option value="${a.key}"${a.key === sel ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('');
      const bankOpts = bankAccts.map(a => `<option value="${a.key}">${escHtml(a.name)}</option>`).join('');

      const rowHtml = (r, i) => `
        <tr data-row="${i}">
          <td><select class="tfy-je-acct">${acctOpts(r.account)}</select></td>
          <td><input type="text" class="tfy-je-desc" value="${escHtml(r.desc || '')}"></td>
          <td><input type="number" step="0.01" class="tfy-je-debit" value="${r.debit ? r.debit.toFixed(2) : ''}"></td>
          <td><input type="number" step="0.01" class="tfy-je-credit" value="${r.credit ? r.credit.toFixed(2) : ''}"></td>
          <td><button type="button" class="btn btn-outline tfy-je-remove" style="padding:2px 8px;">✕</button></td>
        </tr>`;

      body.innerHTML = `
        <div class="alert ${isPayable ? 'alert-warn' : 'alert-success'}" style="margin-bottom:10px;">
          ${isPayable
            ? `EWT due: <strong>${fmtMoney(totalEwt)}</strong> — will be posted as a Payment from the chosen bank/cash account.`
            : `No EWT due this period — posted as a Journal Entry.`}
        </div>
        <div class="filter-bar" style="flex-wrap:wrap;margin-bottom:10px;">
          <label>Date</label>
          <input type="date" id="tfy-je-date" value="${today}">
          ${isPayable ? `
          <label>Pay from (Bank/Cash)</label>
          <select id="tfy-acct-bank">${bankOpts}</select>` : ''}
        </div>
        <table class="tax-codes-table" id="tfy-je-table">
          <thead><tr><th>Account</th><th>Description</th><th style="width:110px;">Debit</th><th style="width:110px;">Credit</th><th style="width:30px;"></th></tr></thead>
          <tbody>${initialRows.map(rowHtml).join('')}</tbody>
          <tfoot><tr>
            <td colspan="2" style="text-align:right;font-weight:700;">Total</td>
            <td id="tfy-je-total-debit" class="num" style="font-weight:700;"></td>
            <td id="tfy-je-total-credit" class="num" style="font-weight:700;"></td>
            <td></td>
          </tr></tfoot>
        </table>
        <button type="button" class="btn btn-outline" id="tfy-je-add" style="margin-top:8px;">+ Add line</button>
        <div id="tfy-je-balance" style="margin-top:8px;font-size:12px;"></div>
        <div class="tfy-step-footer">
          <button class="btn btn-primary" id="tfy-post">${isPayable ? 'Record EWT remittance' : 'Record EWT closing entry'}</button>
          <span id="tfy-post-status" style="font-size:12px;color:#6b7280;margin-left:8px;"></span>
        </div>`;

      const tbody = body.querySelector('#tfy-je-table tbody');

      function addRow(r) {
        const i = tbody.children.length;
        tbody.insertAdjacentHTML('beforeend', rowHtml(r || {}, i));
      }

      function readRows() {
        return Array.from(tbody.querySelectorAll('tr')).map(tr => ({
          account: tr.querySelector('.tfy-je-acct').value,
          desc: tr.querySelector('.tfy-je-desc').value.trim(),
          debit: parseFloat(tr.querySelector('.tfy-je-debit').value) || 0,
          credit: parseFloat(tr.querySelector('.tfy-je-credit').value) || 0,
        })).filter(r => r.debit > 0.005 || r.credit > 0.005);
      }

      function recalcTotals() {
        const rows = readRows();
        const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
        const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
        body.querySelector('#tfy-je-total-debit').textContent = fmtMoney(totalDebit);
        body.querySelector('#tfy-je-total-credit').textContent = fmtMoney(totalCredit);
        const balanceEl = body.querySelector('#tfy-je-balance');
        const diff = totalDebit - totalCredit;
        if (isPayable) {
          const ok = Math.abs(diff - totalEwt) < 0.01;
          balanceEl.innerHTML = ok
            ? `✅ Net of lines (${fmtMoney(diff)}) matches the EWT amount to be paid.`
            : `⚠️ Net of lines (${fmtMoney(diff)}) should equal the EWT due (${fmtMoney(totalEwt)}).`;
        } else {
          const ok = Math.abs(diff) < 0.01;
          balanceEl.innerHTML = ok
            ? `✅ Entry is balanced.`
            : `⚠️ Debits and credits must be equal (currently off by ${fmtMoney(diff)}).`;
        }
        return { totalDebit, totalCredit, diff };
      }

      tbody.addEventListener('input', recalcTotals);
      tbody.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('tfy-je-remove')) {
          ev.target.closest('tr').remove();
          recalcTotals();
        }
      });
      body.querySelector('#tfy-je-add').onclick = () => { addRow(); recalcTotals(); };
      recalcTotals();

      body.querySelector('#tfy-post').onclick = async () => {
        const statusEl = body.querySelector('#tfy-post-status');
        const rows = readRows();
        const postDate = body.querySelector('#tfy-je-date').value;
        if (!postDate) { statusEl.textContent = '❌ Pick a date.'; return; }
        if (!rows.length) { statusEl.textContent = '❌ Add at least one line.'; return; }
        if (rows.some(r => !r.account)) { statusEl.textContent = '❌ Every line needs an account.'; return; }

        statusEl.textContent = 'Posting…';
        try {
          if (isPayable) {
            const bankAcct = body.querySelector('#tfy-acct-bank').value;
            const lines = rows.map(r => ({
              account: r.account,
              lineDescription: r.desc || undefined,
              amount: r.debit - r.credit,
            }));
            await apiRequest('PUT', '/api4/payment', {
              key: crypto.randomUUID(),
              value: { date: postDate, reference, paidFrom: bankAcct, description: `EWT remittance — ${reference}`, lines },
            });
          } else {
            const lines = rows.map(r => ({
              account: r.account,
              lineDescription: r.desc || undefined,
              debit: r.debit,
              credit: r.credit,
            }));
            await apiRequest('PUT', '/api4/journal-entry', {
              key: crypto.randomUUID(),
              value: { date: postDate, reference, narration: `EWT close — ${reference}`, lines },
            });
          }
          statusEl.textContent = '✅ Posted.';
          onPosted();
          setStepDone(root, state, step.key, true);
        } catch (err) {
          statusEl.textContent = `❌ ${err.message}`;
        }
      };
    });
  }

  // ── Income Tax payment step: posts the ITR balance due. ─────────────────
  // Reads window._itr.totalPayable from the 1701Q/1702Q return iframe (the
  // "TOTAL AMOUNT PAYABLE/(OVERPAYMENT)" line, tax due + penalties). Unlike
  // VAT/EWT, which account clears the debit is a free choice the preparer
  // makes here — Income Tax has multiple Deferred Tax Asset roles (Regular
  // vs MCIT, e.g.) that could apply depending on which basis the return was
  // assessed under, and getting that right is the preparer's call, not
  // something worth guessing at automatically.
  function mountItrPaymentStepContent(body, panel, state, step, onPosted) {
    const root = panel.closest('.tfy-step-wrap').parentElement;
    body.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Reading return totals…</span></div>`;

    const sourceStep = state.workflow.steps.find(s => s.key === step.sourceStepKey);
    const sourceIframe = sourceStep && state.iframes[sourceStep.iframeId];
    const win = sourceIframe && sourceIframe.contentWindow;
    const itr = win && win._itr;

    if (!itr || itr.totalPayable == null) {
      body.innerHTML = `<div class="alert alert-warn">⚠️ Open and generate the return step first so this step can read the computed total.<br><br>Once that step has finished generating, come back here — this will retry automatically.</div>`;
      return;
    }

    const totalPayable = itr.totalPayable;
    const isPayable = totalPayable > 0.005;

    Promise.all([
      fetchAllBatch('/api4/bank-or-cash-account-batch', state.biz).catch(() => []),
      fetchAllBatch('/api4/balance-sheet-account-batch', state.biz).catch(() => []),
      fetchAllBatch('/api4/profit-and-loss-statement-account-batch', state.biz).catch(() => []),
    ]).then(([bankAcctsRaw, bsAcctsRaw, plAcctsRaw]) => {
      const unwrap = it => {
        const a = (it && (it.item || it.value)) || it;
        if (!a) return null;
        return { ...a, key: a.key || (it && it.key) };
      };
      const bankAccts = bankAcctsRaw.map(unwrap).filter(a => a && a.name && a.key);
      const allAccts = [...bsAcctsRaw, ...plAcctsRaw]
        .map(unwrap)
        .filter(a => a && a.name && a.key)
        .sort((a, b) => a.name.localeCompare(b.name));
      const today = new Date().toISOString().slice(0, 10);
      const pLabel = state.period
        ? (state.period.ptype === 'monthly' ? monthName(state.period.period) : 'Q' + state.period.period) + ' ' + state.period.year
        : '';
      const reference = `ITR ${pLabel}`.trim();

      // No account pre-selected — the preparer picks which Deferred Tax
      // Asset role (or other account) this payment applies to.
      const initialRows = [
        { desc: 'Income Tax Due Paid', debit: Math.abs(totalPayable), credit: 0 },
      ];

      const acctOpts = sel => allAccts.map(a => `<option value="${a.key}"${a.key === sel ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('');
      const bankOpts = bankAccts.map(a => `<option value="${a.key}">${escHtml(a.name)}</option>`).join('');

      const rowHtml = (r, i) => `
        <tr data-row="${i}">
          <td><select class="tfy-je-acct">${acctOpts(r.account)}</select></td>
          <td><input type="text" class="tfy-je-desc" value="${escHtml(r.desc || '')}"></td>
          <td><input type="number" step="0.01" class="tfy-je-debit" value="${r.debit ? r.debit.toFixed(2) : ''}"></td>
          <td><input type="number" step="0.01" class="tfy-je-credit" value="${r.credit ? r.credit.toFixed(2) : ''}"></td>
          <td><button type="button" class="btn btn-outline tfy-je-remove" style="padding:2px 8px;">✕</button></td>
        </tr>`;

      body.innerHTML = `
        <div class="alert ${isPayable ? 'alert-warn' : 'alert-success'}" style="margin-bottom:10px;">
          ${isPayable
            ? `Total amount payable: <strong>${fmtMoney(totalPayable)}</strong> — will be posted as a Payment from the chosen bank/cash account. Pick which account(s) this clears below (e.g. a Deferred Tax Asset - ITR Payments role).`
            : `No amount payable this period (overpayment or zero balance) — posted as a Journal Entry.`}
        </div>
        <div class="filter-bar" style="flex-wrap:wrap;margin-bottom:10px;">
          <label>Date</label>
          <input type="date" id="tfy-je-date" value="${today}">
          ${isPayable ? `
          <label>Pay from (Bank/Cash)</label>
          <select id="tfy-acct-bank">${bankOpts}</select>` : ''}
        </div>
        <table class="tax-codes-table" id="tfy-je-table">
          <thead><tr><th>Account</th><th>Description</th><th style="width:110px;">Debit</th><th style="width:110px;">Credit</th><th style="width:30px;"></th></tr></thead>
          <tbody>${initialRows.map(rowHtml).join('')}</tbody>
          <tfoot><tr>
            <td colspan="2" style="text-align:right;font-weight:700;">Total</td>
            <td id="tfy-je-total-debit" class="num" style="font-weight:700;"></td>
            <td id="tfy-je-total-credit" class="num" style="font-weight:700;"></td>
            <td></td>
          </tr></tfoot>
        </table>
        <button type="button" class="btn btn-outline" id="tfy-je-add" style="margin-top:8px;">+ Add line</button>
        <div id="tfy-je-balance" style="margin-top:8px;font-size:12px;"></div>
        <div class="tfy-step-footer">
          <button class="btn btn-primary" id="tfy-post">${isPayable ? 'Record ITR payment' : 'Record ITR closing entry'}</button>
          <span id="tfy-post-status" style="font-size:12px;color:#6b7280;margin-left:8px;"></span>
        </div>`;

      const tbody = body.querySelector('#tfy-je-table tbody');

      function addRow(r) {
        const i = tbody.children.length;
        tbody.insertAdjacentHTML('beforeend', rowHtml(r || {}, i));
      }

      function readRows() {
        return Array.from(tbody.querySelectorAll('tr')).map(tr => ({
          account: tr.querySelector('.tfy-je-acct').value,
          desc: tr.querySelector('.tfy-je-desc').value.trim(),
          debit: parseFloat(tr.querySelector('.tfy-je-debit').value) || 0,
          credit: parseFloat(tr.querySelector('.tfy-je-credit').value) || 0,
        })).filter(r => r.debit > 0.005 || r.credit > 0.005);
      }

      function recalcTotals() {
        const rows = readRows();
        const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
        const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
        body.querySelector('#tfy-je-total-debit').textContent = fmtMoney(totalDebit);
        body.querySelector('#tfy-je-total-credit').textContent = fmtMoney(totalCredit);
        const balanceEl = body.querySelector('#tfy-je-balance');
        const diff = totalDebit - totalCredit;
        if (isPayable) {
          const ok = Math.abs(diff - totalPayable) < 0.01;
          balanceEl.innerHTML = ok
            ? `✅ Net of lines (${fmtMoney(diff)}) matches the amount payable.`
            : `⚠️ Net of lines (${fmtMoney(diff)}) should equal the amount payable (${fmtMoney(totalPayable)}).`;
        } else {
          const ok = Math.abs(diff) < 0.01;
          balanceEl.innerHTML = ok
            ? `✅ Entry is balanced.`
            : `⚠️ Debits and credits must be equal (currently off by ${fmtMoney(diff)}).`;
        }
        return { totalDebit, totalCredit, diff };
      }

      tbody.addEventListener('input', recalcTotals);
      tbody.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('tfy-je-remove')) {
          ev.target.closest('tr').remove();
          recalcTotals();
        }
      });
      body.querySelector('#tfy-je-add').onclick = () => { addRow(); recalcTotals(); };
      recalcTotals();

      body.querySelector('#tfy-post').onclick = async () => {
        const statusEl = body.querySelector('#tfy-post-status');
        const rows = readRows();
        const postDate = body.querySelector('#tfy-je-date').value;
        if (!postDate) { statusEl.textContent = '❌ Pick a date.'; return; }
        if (!rows.length) { statusEl.textContent = '❌ Add at least one line.'; return; }
        if (rows.some(r => !r.account)) { statusEl.textContent = '❌ Every line needs an account.'; return; }

        statusEl.textContent = 'Posting…';
        try {
          if (isPayable) {
            const bankAcct = body.querySelector('#tfy-acct-bank').value;
            const lines = rows.map(r => ({
              account: r.account,
              lineDescription: r.desc || undefined,
              amount: r.debit - r.credit,
            }));
            await apiRequest('PUT', '/api4/payment', {
              key: crypto.randomUUID(),
              value: { date: postDate, reference, paidFrom: bankAcct, description: `Income Tax payment — ${reference}`, lines },
            });
          } else {
            const lines = rows.map(r => ({
              account: r.account,
              lineDescription: r.desc || undefined,
              debit: r.debit,
              credit: r.credit,
            }));
            await apiRequest('PUT', '/api4/journal-entry', {
              key: crypto.randomUUID(),
              value: { date: postDate, reference, narration: `Income Tax close — ${reference}`, lines },
            });
          }
          statusEl.textContent = '✅ Posted.';
          onPosted();
          setStepDone(root, state, step.key, true);
        } catch (err) {
          statusEl.textContent = `❌ ${err.message}`;
        }
      };
    });
  }

  function fmtMoney(n) {
    return (n < 0 ? '-' : '') + '₱' + Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function mountValidateStep(body, panel, state, step) {
    if (!state._onShow) state._onShow = {};
    let started = false;
    state._onShow[step.key] = () => {
      if (started && state.doneCache[step.key]) return; // already passed, don't re-check on every visit
      started = true;
      runValidateCheck(body, panel, state, step);
    };
  }

  async function runValidateCheck(body, panel, state, step) {
    body.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Checking…</span></div>`;
    let result;
    try {
      result = await step.check(state.biz);
    } catch (e) {
      body.innerHTML = `<div class="alert alert-error">❌ ${escHtml(e.message)}</div>`;
      return;
    }

    const root = panel.closest('.tfy-step-wrap').parentElement;

    if (result.ok) {
      setStepDone(root, state, step.key, true);
      body.innerHTML = `<div class="alert alert-success">✅ ${escHtml(step.passMessage || 'Check passed.')}</div>`;
      return;
    }

    setStepDone(root, state, step.key, false);
    const listHtml = (result.problems || []).slice(0, 25).map(p => `<li>${escHtml(p)}</li>`).join('');
    body.innerHTML = `
      <div class="alert alert-warn">⚠️ ${escHtml(result.message || 'Some records are missing required BIR fields.')}</div>
      ${listHtml ? `<ul class="tfy-problem-list">${listHtml}</ul>` : ''}
      <div class="tfy-step-footer">
        <button class="btn btn-primary" id="tfy-fix">${escHtml(step.fixLabel || 'Open the fix screen →')}</button>
        <button class="btn btn-outline" id="tfy-recheck" style="margin-left:6px;">↻ Re-check</button>
      </div>`;

    body.querySelector('#tfy-fix').onclick = () => {
      if (step.fixIframeId && step.fixTabSelector) {
        const mountEl = document.createElement('div');
        mountEl.className = 'tfy-iframe-mount';
        body.prepend(mountEl);
        const iframe = getOrCreateIframe(state, mountEl, step.fixIframeId, step.fixFile);
        const clickTab = () => {
          const doc = iframe.contentDocument;
          const tabBtn = doc && doc.querySelector(step.fixTabSelector);
          if (tabBtn) { tabBtn.click(); return true; }
          return false;
        };
        if (!clickTab()) {
          const poll = setInterval(() => { if (clickTab()) clearInterval(poll); }, 400);
          setTimeout(() => clearInterval(poll), 15000);
        }
      }
    };
    body.querySelector('#tfy-recheck').onclick = () => runValidateCheck(body, panel, state, step);
  }

  // Like 'validate', but never blocks: an async check(biz) informs the
  // preparer of something worth knowing (e.g. whether an optional account
  // is set up) without gating progress on it. Always shows a Continue
  // button, whether or not the check passed — the difference from
  // 'instruction' is that the body content is computed from live data
  // instead of a fixed string.
  function mountChecklistStep(body, panel, state, step) {
    if (!state._onShow) state._onShow = {};
    let started = false;
    state._onShow[step.key] = () => {
      if (started) return;
      started = true;
      runChecklist(body, panel, state, step);
    };
  }

  async function runChecklist(body, panel, state, step) {
    body.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Checking…</span></div>`;
    let result;
    try {
      result = await step.check(state.biz);
    } catch (e) {
      result = { ok: false, message: `Could not run this check: ${e.message}`, rows: [] };
    }

    const root = panel.closest('.tfy-step-wrap').parentElement;
    const rowsHtml = (result.rows || [])
      .map(r => `<li>${r.ok ? '✅' : '⚠️'} <strong>${escHtml(r.label)}</strong> — ${escHtml(r.detail || '')}</li>`)
      .join('');

    body.innerHTML = `
      <div class="alert ${result.ok ? 'alert-success' : 'alert-warn'}" style="margin-bottom:10px;">${result.ok ? '✅' : '⚠️'} ${escHtml(result.message || '')}</div>
      ${rowsHtml ? `<ul class="tfy-problem-list">${rowsHtml}</ul>` : ''}
      <div class="tfy-step-footer">
        <button class="btn btn-primary" id="tfy-continue">Continue →</button>
        <button class="btn btn-outline" id="tfy-recheck" style="margin-left:6px;">↻ Re-check</button>
      </div>`;

    body.querySelector('#tfy-continue').onclick = () => setStepDone(root, state, step.key, true);
    body.querySelector('#tfy-recheck').onclick = () => runChecklist(body, panel, state, step);
  }

  return { mount, isDone, markDone, resetWorkflow };
})();
