/* ============================================================
   Txform Now! — generic step engine
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

  // Draft step progress is a localStorage sentinel so a half-finished filing
  // survives a page reload. It is scoped to the FILING (biz + workflow +
  // period), so each period tracks its own progress independently — this is
  // the ephemeral draft state (NOT the frozen snapshot, which is server-only).
  // filingId = `${biz}:${workflowKey}:${periodKey}`.
  function stepStorageKey(filingId, stepKey) {
    return `taxify:step:${filingId}:${stepKey}`;
  }
  function isStepDone(filingId, stepKey) {
    return localStorage.getItem(stepStorageKey(filingId, stepKey)) === '1';
  }
  function setStepDoneFlag(filingId, stepKey, done) {
    const k = stepStorageKey(filingId, stepKey);
    if (done) localStorage.setItem(k, '1');
    else localStorage.removeItem(k);
  }

  // Reset all step completion flags for a filing (e.g. when amending).
  function resetSteps(filingId, steps) {
    steps.forEach(s => setStepDoneFlag(filingId, s.key, false));
  }

  const TYPE_ICON = { review: '📊', validate: '🔎', download: '📥', document: '📄', final: '🏁', file: '🔒', instruction: 'ℹ️', period: '📅', payment: '💳', checklist: '📋' };

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

  // Mount a filing. opts = { period, status }:
  //   period — the filing's period, chosen in the Filing overview (Phase D).
  //   status — its known lifecycle state from the overview batch
  //            ('draft' | 'filed' | 'amended').
  // A filed/amended filing opens in frozen read-only mode (snapshot + variance);
  // a draft opens the live step rail. A filing is identified by
  // (biz, workflow, period) — see filingId.
  function mount(container, workflow, biz, opts) {
    opts = opts || {};
    const period = opts.period || loadPeriod(biz, workflow.key) || null;
    const periodKey = (typeof FilingCore !== 'undefined' && period) ? FilingCore.periodKey(period) : null;

    const state = {
      biz, workflow, period, periodKey,
      filingId: `${biz}:${workflow.key}:${periodKey || 'noperiod'}`,
      status: opts.status || 'draft',
      activeIndex: 0,
      hiddenKeys: new Set(), // stepKeys hidden by a false showIf() — see computeHiddenSteps
      doneCache: {},     // stepKey -> bool (mirrors localStorage)
      bodyEls: {},        // stepKey -> the persistent <div class="tfy-step-body"> for that step
      iframes: {},        // iframeId -> <iframe> (shared across steps that reuse the same report file)
      _onShow: {},
    };

    const handle = {
      reset() { amendFiling(container, state); },
      amend() { amendFiling(container, state); },
    };
    container._tfyHandle = handle;
    container._tfyState = state;

    if (state.status === 'filed' || state.status === 'amended') {
      renderFrozenView(container, state);
    } else {
      buildDraft(container, state);
    }
    return handle;
  }

  // A step with a showIf(biz, state) predicate is hidden entirely when the
  // predicate resolves false (e.g. the VAT Tax-Codes step when everything is
  // already mapped). Hidden steps are treated as auto-done so they never gate
  // the rail, and are skipped when navigating. Resolved once per draft build.
  // On predicate error we default to SHOWING the step — never hide something
  // that might actually be needed.
  async function computeHiddenSteps(state) {
    state.hiddenKeys = new Set();
    for (const step of state.workflow.steps) {
      if (typeof step.showIf !== 'function') continue;
      try {
        const show = await step.showIf(state.biz, state);
        if (!show) state.hiddenKeys.add(step.key);
      } catch (e) { /* keep it visible */ }
    }
  }

  function firstVisibleIndex(state) {
    for (let i = 0; i < state.workflow.steps.length; i++) {
      if (!state.hiddenKeys.has(state.workflow.steps[i].key)) return i;
    }
    return 0;
  }

  function lastVisibleIndex(state) {
    for (let i = state.workflow.steps.length - 1; i >= 0; i--) {
      if (!state.hiddenKeys.has(state.workflow.steps[i].key)) return i;
    }
    return state.workflow.steps.length - 1;
  }

  function nextVisibleIndex(state, from) {
    for (let i = from + 1; i < state.workflow.steps.length; i++) {
      if (!state.hiddenKeys.has(state.workflow.steps[i].key)) return i;
    }
    return -1;
  }

  // Build (or rebuild) the live step rail for a draft filing.
  async function buildDraft(container, state) {
    const { workflow, filingId } = state;
    container.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Preparing…</span></div>`;
    await computeHiddenSteps(state);
    workflow.steps.forEach(s => {
      // Hidden steps never gate and never show: treat them as done.
      state.doneCache[s.key] = state.hiddenKeys.has(s.key) ? true : isStepDone(filingId, s.key);
    });
    const firstPending = workflow.steps.findIndex(s => !state.hiddenKeys.has(s.key) && !state.doneCache[s.key]);
    state.activeIndex = firstPending === -1 ? lastVisibleIndex(state) : firstPending;

    buildSkeleton(container, state);
    renderRail(container, state);
    showActiveStep(container, state);
  }

  // Leave frozen mode to prepare an amendment: the next freeze writes
  // version+1 (the server supersedes the prior filed row). Draft step flags
  // are preserved, so the preparer can jump straight to the freeze step and
  // re-file, or revisit any step to change figures first.
  function amendFiling(container, state) {
    state.status = 'draft';
    state.doneCache = {};
    state.bodyEls = {};
    state.iframes = {};
    state._onShow = {};
    buildDraft(container, state);
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
    const periodLabel = (typeof FilingCore !== 'undefined' && state.period)
      ? FilingCore.periodLabel(state.period) : '';
    container.innerHTML = `
      <div class="tfy-step-wrap">
        <div class="tfy-step-topbar">
          <div class="tfy-step-topbar-head">
            <div class="tfy-step-rail-title">${escHtml(state.workflow.label)}</div>
            ${periodLabel ? `<div class="tfy-step-rail-period">${escHtml(periodLabel)} · <span class="tfy-status-pill draft">Draft</span></div>` : ''}
            <button type="button" class="tfy-step-restart" id="tfy-restart">↺ Restart this filing</button>
          </div>
          <div class="tfy-step-flow tfy-step-rail-list"></div>
        </div>
        <div class="tfy-step-panel" id="tfy-step-panel"></div>
      </div>`;

    container.querySelector('#tfy-restart').addEventListener('click', () => {
      if (!confirm('Restart this filing? Completion flags for every step will be cleared (the frozen return, if any, is not affected).')) return;
      resetSteps(state.filingId, state.workflow.steps);
      // Hidden steps stay auto-done so a restart doesn't resurrect them.
      state.workflow.steps.forEach(s => { state.doneCache[s.key] = state.hiddenKeys.has(s.key); });
      state.activeIndex = firstVisibleIndex(state);
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
      if (state.hiddenKeys.has(s.key)) return ''; // conditional step, not applicable
      const done   = !!state.doneCache[s.key];
      const locked = isLocked(state, i);
      const active = i === state.activeIndex;
      const num    = done ? '✓' : locked ? '🔒' : (i + 1);
      return `<button type="button" class="tfy-step-item${active ? ' active' : ''}${locked ? ' locked' : ''}${done ? ' done' : ''}${s.optional ? ' optional' : ''}"
                data-idx="${i}" ${locked ? 'disabled' : ''}>
        <span class="tfy-step-num">${num}</span>
        <span class="tfy-step-label">${escHtml(s.short || s.label)}${s.optional ? '<span class="tfy-step-opt">if&nbsp;needed</span>' : ''}</span>
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
    setStepDoneFlag(state.filingId, stepKey, done);
    state.doneCache[stepKey] = done;
    renderRail(container, state);
    refreshStepFooter(container, state, stepKey);

    if (done) {
      const idx = state.workflow.steps.findIndex(s => s.key === stepKey);
      const next = nextVisibleIndex(state, idx);
      if (idx === state.activeIndex && next !== -1) {
        state.activeIndex = next;
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

    if (step.type === 'review' || step.type === 'download' || step.type === 'document' || (step.type === 'final' && step.file)) {
      mountIframeStep(body, panel, state, step);
    } else if (step.type === 'final') {
      mountBundleFinalStep(body, panel, state, step);
    } else if (step.type === 'file') {
      mountFileStep(body, panel, state, step);
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
    } else if (step.type === 'document') {
      renderDocumentFooter(footer, root, state, step, iframe);
    } else if (step.type === 'final') {
      renderFinalFooter(body, panel.closest('.tfy-step-wrap').parentElement, state, step);
    }
  }

  // Clicks a selector inside a same-origin iframe once it appears (used by the
  // 'document' step's "fix TINs" button to deep-link into the report's own
  // Customers/Suppliers tab without leaving the step).
  function clickIframeSelector(iframe, selector) {
    if (!iframe) return;
    const tryClick = () => {
      const doc = iframe.contentDocument;
      const el = doc && doc.querySelector(selector);
      if (el) { el.click(); return true; }
      return false;
    };
    if (!tryClick()) {
      const poll = setInterval(() => { if (tryClick()) clearInterval(poll); }, 400);
      setTimeout(() => clearInterval(poll), 15000);
    }
  }

  // ── 'document' step: one screen that merges review + TIN validation +
  //    download for a single report (SLS / SLP / QAP). The report renders in the
  //    iframe above; this footer runs the party-TIN check as an inline banner
  //    (blocking, since BIR rejects DAT files with missing TINs) and gates
  //    Continue on both a passing check and a confirmed download. ────────────
  function renderDocumentFooter(footer, root, state, step, iframe) {
    const done = !!state.doneCache[step.key];
    let tinOk = !step.check;   // no check ⇒ nothing to block on
    let downloaded = done;     // resuming a completed step ⇒ already downloaded

    footer.innerHTML = `
      <div id="tfy-doc-tin" style="width:100%;"></div>
      <div id="tfy-doc-dl" class="alert alert-warn" style="width:100%;margin:0 0 10px;">
        ⚠️ Download the file${step.buttonIds.length > 1 ? 's' : ''} below (or mark it done) to continue.
        ${step.datHint || 'A full quarter downloads one DAT file per month (3 files).'}
      </div>
      <button class="btn btn-primary" id="tfy-continue" disabled>Continue →</button>
      <button class="btn btn-outline" id="tfy-skip" style="margin-left:6px;">I already downloaded this — mark complete</button>
      ${step.skippable ? `<button class="btn btn-outline" id="tfy-skip-all" style="margin-left:6px;">${escHtml(step.skipLabel || 'Skip — nothing to file')}</button>` : ''}`;

    const contBtn = footer.querySelector('#tfy-continue');
    const dlAlert = footer.querySelector('#tfy-doc-dl');
    const tinEl   = footer.querySelector('#tfy-doc-tin');
    // Optional attachment (e.g. SAWT): skip the whole step — no TIN gate, no
    // download required — when there's nothing to file this period.
    if (step.skippable) footer.querySelector('#tfy-skip-all').onclick = () => setStepDone(root, state, step.key, true);

    function refresh() {
      if (downloaded) {
        dlAlert.className = 'alert alert-success';
        dlAlert.textContent = '✅ Download confirmed for this step.';
      }
      contBtn.disabled = !(tinOk && downloaded);
    }
    function markDownloaded() { downloaded = true; refresh(); }

    footer.querySelector('#tfy-skip').onclick = markDownloaded;
    contBtn.onclick = () => setStepDone(root, state, step.key, true);

    if (!downloaded) {
      const seenAll = (seen) => step.requireAll
        ? step.buttonIds.every(id => seen.has(id))
        : seen.size > 0;
      watchDownloadButtons(iframe, step.buttonIds, (seen) => { if (seenAll(seen)) markDownloaded(); });
    }

    function runTinCheck() {
      if (!step.check) return;
      tinEl.innerHTML = `<div class="alert" style="margin:0 0 10px;">Checking TINs…</div>`;
      step.check(state.biz).then(result => {
        if (result.ok) {
          tinOk = true;
          tinEl.innerHTML = `<div class="alert alert-success" style="margin:0 0 10px;">✅ ${escHtml(result.passMessage || 'Every party has a TIN.')}</div>`;
        } else {
          tinOk = false;
          const listHtml = (result.problems || []).slice(0, 15).map(p => `<li>${escHtml(p)}</li>`).join('');
          tinEl.innerHTML = `
            <div class="alert alert-error" style="margin:0 0 10px;">
              ⚠️ ${escHtml(result.message || 'Some parties are missing a TIN — BIR will reject the DAT file until fixed.')}
              ${listHtml ? `<ul class="tfy-problem-list">${listHtml}</ul>` : ''}
              <div style="margin-top:6px;">
                <button class="btn btn-outline" id="tfy-doc-fix">${escHtml(step.fixLabel || 'Fix TINs →')}</button>
                <button class="btn btn-outline" id="tfy-doc-recheck" style="margin-left:6px;">↻ Re-check</button>
              </div>
            </div>`;
          tinEl.querySelector('#tfy-doc-fix').onclick = () => clickIframeSelector(iframe, step.fixTabSelector);
          tinEl.querySelector('#tfy-doc-recheck').onclick = runTinCheck;
        }
        refresh();
      }).catch(e => {
        tinOk = true; // a failed check shouldn't hard-block; surface it instead
        tinEl.innerHTML = `<div class="alert alert-warn" style="margin:0 0 10px;">Couldn't check TINs (${escHtml(e.message)}). You can still continue.</div>`;
        refresh();
      });
    }

    runTinCheck();
    refresh();
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

  // A 'final' bundle step (working-paper downloads) is no longer the terminal
  // action — the 'file' (freeze) step is. So its footer just re-triggers the
  // bundled downloads and advances to the freeze step.
  function renderFinalFooter(body, root, state, step) {
    const footer = body.querySelector('.tfy-step-footer');
    footer.innerHTML = `
      ${step.bundle ? `<button class="btn btn-success" id="tfy-download-all">⬇ Download all (${step.bundle.length} files)</button>` : ''}
      <button class="btn btn-primary" id="tfy-finish" style="margin-left:6px;">Continue to filing →</button>`;
    if (step.bundle) {
      footer.querySelector('#tfy-download-all').onclick = () => triggerBundleDownloads(state, step.bundle);
    }
    footer.querySelector('#tfy-finish').onclick = () => setStepDone(root, state, step.key, true);
  }

  // ── Instruction step: static guidance with a Continue button. ──────────
  function mountInstructionStep(body, panel, state, step) {
    const footer = document.createElement('div');
    // `info: true` marks read-only guidance — a softer info banner and a plain
    // "Continue" rather than the checklist-style "I've checked this" gate.
    body.innerHTML = `<div class="alert ${step.info ? 'alert-info' : 'alert-warn'}" style="margin-bottom:12px;">${step.body || ''}</div>`;
    footer.className = 'tfy-step-footer';
    body.appendChild(footer);
    footer.innerHTML = `<button class="btn btn-primary" id="tfy-continue">${step.info ? 'Continue →' : "I've checked this — Continue →"}</button>`;
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
      } else if (step.paymentFlavor === 'compensation') {
        mountCompensationPaymentStepContent(body, panel, state, step, () => { posted = true; });
      } else if (step.paymentFlavor === 'itr') {
        mountItrPaymentStepContent(body, panel, state, step, () => { posted = true; });
      } else {
        mountPaymentStepContent(body, panel, state, step, () => { posted = true; });
      }
    };
  }

  // The posting guard: a ledger line only reaches Manager if it moves at
  // least a centavo. Delegates to filing-core so this filter and the
  // voucher's "is there anything to post?" check share one rule — if the
  // two ever drift, a zero-activity period becomes unfileable again.
  function isRecordableLine(row) {
    return FilingCore.isRecordableLine(row);
  }

  // ── "Nothing to record" panel. ──────────────────────────────────────────
  // Shown when a period had no activity at all, so the computed voucher has
  // no line worth posting (e.g. a 0619E month where nothing was withheld).
  // The return is still a mandatory BIR filing, so the step closes without
  // posting anything: a ₱0.00 entry would be meaningless in the books and
  // would be rejected by Manager. Marking it done unlocks the freeze step —
  // without this the filing could never be filed at all.
  function renderNothingToRecord(body, root, state, step, cfg, onDone) {
    body.innerHTML = `
      <div class="alert alert-info" style="margin-bottom:12px;">
        <strong>Nothing to record for this period.</strong> ${escHtml(cfg.zeroExplain)}
        There's no entry to post to your books, so you can go straight to filing —
        a nil return is still due with the BIR.
      </div>
      <div class="tfy-step-footer">
        <button class="btn btn-primary" id="tfy-continue">Continue →</button>
      </div>`;
    body.querySelector('#tfy-continue').onclick = () => {
      if (typeof onDone === 'function') onDone();
      setStepDone(root, state, step.key, true);
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
    // carryover — the engine posts no line for it. Preparers who instead
    // close the excess to a separate Input Tax Carry Over account add that
    // line themselves via "+ Add line"; deliberately not automated, since
    // which treatment applies is a per-client bookkeeping choice.
    const outputTax = v.i37;
    const inputUsed = Math.min(v.i60, outputTax);
    const remainingAfterInput = Math.max(outputTax - inputUsed, 0);
    const cwtPool = (v.i20 || 0) + (v.i25 || 0);
    const cwtUsed = Math.min(cwtPool, remainingAfterInput);
    const netCash = outputTax - inputUsed - cwtUsed;
    const isPayable = netCash > 0.005;

    // Pre-filled line rows: the same clearing entries the engine would
    // compute on its own. The preparer can edit, retitle, add or remove
    // rows before posting — accounts aren't pre-selected since we don't
    // know which ones map to "Output VAT" / "Input Tax" / "Creditable WV"
    // for this business. Built before the account fetch so a quarter with
    // nothing to record can short-circuit without three wasted API calls.
    const initialRows = [
      { desc: 'Clear Output VAT', debit: outputTax, credit: 0 },
    ];
    if (inputUsed > 0.005) initialRows.push({ desc: 'Apply Input Tax', debit: 0, credit: inputUsed });
    if (cwtUsed > 0.005) initialRows.push({ desc: 'Apply Creditable WV', debit: 0, credit: cwtUsed });

    // Only a dormant quarter has nothing to post. This deliberately asks
    // whether the books moved rather than whether the rows above came out
    // at zero: with purchases but no sales every row reads ₱0.00 (inputUsed
    // is capped at outputTax) while the quarter's input tax still has to be
    // closed out. See FilingCore.vatHasRecordableActivity.
    if (!FilingCore.vatHasRecordableActivity(v)) {
      renderNothingToRecord(body, root, state, step, {
        zeroExplain: 'This quarter has no sales, no purchases and no credits to report.',
      }, onPosted);
      return;
    }

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
      // Editable entry description, pre-filled as e.g. "VAT - Q2 2026". The
      // preparer can change it; it becomes the payment description / journal
      // narration on posting.
      const defaultDesc = reference.replace(/^VAT /, 'VAT - ');

      const acctOpts = sel => allAccts.map(a => `<option value="${a.key}"${a.key === sel ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('');
      const bankOpts = bankAccts.map(a => `<option value="${a.key}">${escHtml(a.name)}</option>`).join('');

      const rowHtml = (r, i) => `
        <tr data-row="${i}">
          <td><select class="tfy-je-acct">${acctOpts(r.account)}</select></td>
          <td><input type="text" class="tfy-je-desc" value="${escHtml(r.desc || '')}"></td>
          <td class="amt"><input type="number" step="0.01" class="tfy-je-debit" value="${r.debit ? r.debit.toFixed(2) : ''}"></td>
          <td class="amt"><input type="number" step="0.01" class="tfy-je-credit" value="${r.credit ? r.credit.toFixed(2) : ''}"></td>
          <td class="rm-col"><button type="button" class="tfy-je-remove" title="Remove line">✕</button></td>
        </tr>`;

      // Compound journal-entry voucher: a header band (kind · date · pay-from ·
      // editable description), the DR/CR ledger, and a footer with the balance
      // badge + post button. Markup is presentational only — the ids/classes
      // the recalc/post logic below reads (#tfy-je-*, .tfy-je-*) are unchanged.
      body.innerHTML = `
        <div class="tfy-voucher">
          <div class="tfy-voucher-head">
            <div class="tfy-voucher-kind">
              <span class="tfy-voucher-badge">${isPayable ? 'Payment' : 'Journal Entry'}</span>
              <h4 id="tfy-voucher-title">${escHtml(defaultDesc)}</h4>
            </div>
            <div class="tfy-voucher-fields">
              <div class="tfy-vf"><label>Date</label><input type="date" id="tfy-je-date" value="${today}"></div>
              ${isPayable ? `<div class="tfy-vf"><label>Pay from (Bank / Cash)</label><select id="tfy-acct-bank">${bankOpts}</select></div>` : ''}
              <div class="tfy-vf tfy-vf-wide"><label>Description</label><input type="text" id="tfy-je-ref" value="${escHtml(defaultDesc)}"></div>
            </div>
          </div>

          <div class="tfy-vat-strip">
            <div class="tfy-vat-cell"><span class="k">Output VAT</span><span class="v">${fmtMoney(outputTax)}</span></div>
            <div class="tfy-vat-cell"><span class="k">Input tax applied</span><span class="v">${fmtMoney(inputUsed)}</span></div>
            <div class="tfy-vat-cell"><span class="k">CWT / credits</span><span class="v">${fmtMoney(cwtUsed)}</span></div>
            <div class="tfy-vat-cell ${isPayable ? 'due' : ''}"><span class="k">${isPayable ? 'Net VAT payable' : 'Cash due'}</span><span class="v">${isPayable ? fmtMoney(netCash) : '—'}</span></div>
          </div>

          <table class="tfy-ledger" id="tfy-je-table">
            <thead><tr><th>Account</th><th>Description</th><th class="amt">Debit</th><th class="amt">Credit</th><th class="rm-col"></th></tr></thead>
            <tbody>${initialRows.map(rowHtml).join('')}</tbody>
            <tfoot><tr>
              <td colspan="2" class="lbl">Total</td>
              <td id="tfy-je-total-debit" class="amt"></td>
              <td id="tfy-je-total-credit" class="amt"></td>
              <td></td>
            </tr></tfoot>
          </table>
          <div class="tfy-ledger-add"><button type="button" class="btn btn-outline" id="tfy-je-add">+ Add line</button></div>

          <div class="tfy-voucher-foot">
            <div id="tfy-je-balance" class="tfy-balance"></div>
            <div class="tfy-voucher-actions">
              <button class="btn btn-primary" id="tfy-post">${isPayable ? 'Record VAT payment' : 'Record VAT closing entry'}</button>
              <span id="tfy-post-status" style="font-size:12px;color:#6b7280;margin-left:8px;"></span>
            </div>
          </div>
        </div>`;

      // Keep the voucher heading in sync as the preparer edits the description.
      body.querySelector('#tfy-je-ref').addEventListener('input', function () {
        body.querySelector('#tfy-voucher-title').textContent = this.value || defaultDesc;
      });

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
        })).filter(isRecordableLine);
      }

      function recalcTotals() {
        const rows = readRows();
        const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
        const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
        body.querySelector('#tfy-je-total-debit').textContent = fmtMoney(totalDebit);
        body.querySelector('#tfy-je-total-credit').textContent = fmtMoney(totalCredit);
        const balanceEl = body.querySelector('#tfy-je-balance');
        const diff = totalDebit - totalCredit;
        let ok;
        if (isPayable) {
          // For a Payment, the lines' net (debit − credit) is what's drawn
          // from the bank/cash account — it should equal the net VAT due.
          ok = Math.abs(diff - netCash) < 0.01;
          balanceEl.innerHTML = ok
            ? `✔ Balanced — net of lines (${fmtMoney(diff)}) matches the amount paid`
            : `⚠ Net of lines (${fmtMoney(diff)}) should equal the net VAT payable (${fmtMoney(netCash)})`;
        } else {
          ok = Math.abs(diff) < 0.01;
          balanceEl.innerHTML = ok
            ? `✔ Balanced — debits equal credits`
            : `⚠ Debits and credits must be equal (off by ${fmtMoney(diff)})`;
        }
        balanceEl.classList.toggle('ok', ok);
        balanceEl.classList.toggle('bad', !ok);
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

        const entryDesc = (body.querySelector('#tfy-je-ref').value || '').trim() || defaultDesc;
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
              value: { date: postDate, reference, paidFrom: bankAcct, description: entryDesc, lines },
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
              value: { date: postDate, reference, narration: entryDesc, lines },
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
  // Reads window._e.totalEwt from the EWT return iframe (0619-E or 1601-EQ
  // depending on ptype). Thin wrapper over the shared remittance voucher.
  function mountEwtPaymentStepContent(body, panel, state, step, onPosted) {
    mountRemittanceVoucherContent(body, panel, state, step, onPosted, {
      spinnerLabel: 'Reading EWT return totals…',
      sourceVar: '_e',
      amountField: 'totalEwt',
      missingHtml: '⚠️ Open and generate the EWT return step first so this step can read the computed totals.<br><br>Once that step has finished generating, come back here — this will retry automatically.',
      taxLabel: 'EWT',
      refPrefix: 'EWT',
      debitDesc: 'Withholding Tax Payable (EWT)',
      dueLabel: 'EWT due',
      payBtn: 'Record EWT remittance',
      closeBtn: 'Record EWT closing entry',
      zeroExplain: 'No expanded withholding tax was withheld for this period.',
    });
  }

  // ── Compensation (1601-C) payment step: posts the payroll withholding
  //    remittance. Reads window._c.totalRemittance from the 1601-C report
  //    iframe (the "Tax still due" line). Structurally identical to EWT — a
  //    single Withholding Tax Payable debit cleared by a bank/cash payment —
  //    so it shares the remittance voucher.
  function mountCompensationPaymentStepContent(body, panel, state, step, onPosted) {
    mountRemittanceVoucherContent(body, panel, state, step, onPosted, {
      spinnerLabel: 'Reading 1601-C totals…',
      sourceVar: '_c',
      amountField: 'totalRemittance',
      missingHtml: '⚠️ Open and generate the payroll-withholding review step first so this step can read the computed 1601-C total.<br><br>Once that step has finished generating, come back here — this will retry automatically.',
      taxLabel: '1601-C',
      refPrefix: '1601C',
      debitDesc: 'Withholding Tax Payable – Compensation',
      dueLabel: 'Tax to remit',
      payBtn: 'Record 1601-C remittance',
      closeBtn: 'Record 1601-C closing entry',
      zeroExplain: 'No tax was withheld on compensation for this period.',
    });
  }

  // ── Shared remittance voucher (EWT + compensation). ─────────────────────
  // A withholding remittance is always the same shape: clear a single
  // Withholding Tax Payable liability against a bank/cash account (a Payment
  // when there's tax to remit, or a balanced Journal Entry when there isn't).
  // The only differences are which window var/field holds the total and the
  // wording — passed in via cfg. Presentation matches the VAT voucher
  // (mountPaymentStepContent): a header band with an editable Description, a
  // one-figure strip, the DR/CR ledger, and a balance badge. The ids/classes
  // the recalc/post logic reads (#tfy-je-*, .tfy-je-*) are the shared ones.
  function mountRemittanceVoucherContent(body, panel, state, step, onPosted, cfg) {
    const root = panel.closest('.tfy-step-wrap').parentElement;
    body.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>${escHtml(cfg.spinnerLabel)}</span></div>`;

    const sourceStep = state.workflow.steps.find(s => s.key === step.sourceStepKey);
    const sourceIframe = sourceStep && state.iframes[sourceStep.iframeId];
    const win = sourceIframe && sourceIframe.contentWindow;
    const src = win && win[cfg.sourceVar];

    if (!src || src[cfg.amountField] == null) {
      body.innerHTML = `<div class="alert alert-warn">${cfg.missingHtml}</div>`;
      return;
    }

    const total = src[cfg.amountField];
    const amt = Math.abs(total);           // row/strip amount (ITR can be an overpayment)
    const isPayable = total > 0.005;

    // The single clearing line this voucher posts. Built before the account
    // fetch so a period with nothing to record short-circuits without three
    // wasted API calls.
    const initialRows = [
      { desc: cfg.debitDesc, debit: amt, credit: 0 },
    ];

    // Nothing was withheld or owed this period, so there's no liability to
    // clear — close the step without inventing a ₱0.00 entry.
    if (!FilingCore.hasRecordableLines(initialRows)) {
      renderNothingToRecord(body, root, state, step, { zeroExplain: cfg.zeroExplain }, onPosted);
      return;
    }

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
      const reference = `${cfg.refPrefix} ${pLabel}`.trim();
      // Editable entry description, pre-filled as e.g. "EWT - Q2 2026" /
      // "1601-C - March 2026"; becomes the payment description / journal
      // narration on posting.
      const defaultDesc = `${cfg.taxLabel} - ${pLabel}`.trim();

      const acctOpts = sel => allAccts.map(a => `<option value="${a.key}"${a.key === sel ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('');
      const bankOpts = bankAccts.map(a => `<option value="${a.key}">${escHtml(a.name)}</option>`).join('');

      const rowHtml = (r, i) => `
        <tr data-row="${i}">
          <td><select class="tfy-je-acct">${acctOpts(r.account)}</select></td>
          <td><input type="text" class="tfy-je-desc" value="${escHtml(r.desc || '')}"></td>
          <td class="amt"><input type="number" step="0.01" class="tfy-je-debit" value="${r.debit ? r.debit.toFixed(2) : ''}"></td>
          <td class="amt"><input type="number" step="0.01" class="tfy-je-credit" value="${r.credit ? r.credit.toFixed(2) : ''}"></td>
          <td class="rm-col"><button type="button" class="tfy-je-remove" title="Remove line">✕</button></td>
        </tr>`;

      body.innerHTML = `
        <div class="tfy-voucher">
          <div class="tfy-voucher-head">
            <div class="tfy-voucher-kind">
              <span class="tfy-voucher-badge">${isPayable ? 'Payment' : 'Journal Entry'}</span>
              <h4 id="tfy-voucher-title">${escHtml(defaultDesc)}</h4>
            </div>
            <div class="tfy-voucher-fields">
              <div class="tfy-vf"><label>Date</label><input type="date" id="tfy-je-date" value="${today}"></div>
              ${isPayable ? `<div class="tfy-vf"><label>Pay from (Bank / Cash)</label><select id="tfy-acct-bank">${bankOpts}</select></div>` : ''}
              <div class="tfy-vf tfy-vf-wide"><label>Description</label><input type="text" id="tfy-je-ref" value="${escHtml(defaultDesc)}"></div>
            </div>
          </div>

          <div class="tfy-vat-strip">
            <div class="tfy-vat-cell ${isPayable ? 'due' : ''}"><span class="k">${escHtml(cfg.dueLabel)}</span><span class="v">${isPayable ? fmtMoney(amt) : '—'}</span></div>
          </div>
          ${cfg.extraNote ? `<div class="alert" style="margin:0 0 10px;font-size:12px;">${cfg.extraNote}</div>` : ''}

          <table class="tfy-ledger" id="tfy-je-table">
            <thead><tr><th>Account</th><th>Description</th><th class="amt">Debit</th><th class="amt">Credit</th><th class="rm-col"></th></tr></thead>
            <tbody>${initialRows.map(rowHtml).join('')}</tbody>
            <tfoot><tr>
              <td colspan="2" class="lbl">Total</td>
              <td id="tfy-je-total-debit" class="amt"></td>
              <td id="tfy-je-total-credit" class="amt"></td>
              <td></td>
            </tr></tfoot>
          </table>
          <div class="tfy-ledger-add"><button type="button" class="btn btn-outline" id="tfy-je-add">+ Add line</button></div>

          <div class="tfy-voucher-foot">
            <div id="tfy-je-balance" class="tfy-balance"></div>
            <div class="tfy-voucher-actions">
              <button class="btn btn-primary" id="tfy-post">${isPayable ? escHtml(cfg.payBtn) : escHtml(cfg.closeBtn)}</button>
              <span id="tfy-post-status" style="font-size:12px;color:#6b7280;margin-left:8px;"></span>
            </div>
          </div>
        </div>`;

      body.querySelector('#tfy-je-ref').addEventListener('input', function () {
        body.querySelector('#tfy-voucher-title').textContent = this.value || defaultDesc;
      });

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
        })).filter(isRecordableLine);
      }

      function recalcTotals() {
        const rows = readRows();
        const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
        const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
        body.querySelector('#tfy-je-total-debit').textContent = fmtMoney(totalDebit);
        body.querySelector('#tfy-je-total-credit').textContent = fmtMoney(totalCredit);
        const balanceEl = body.querySelector('#tfy-je-balance');
        const diff = totalDebit - totalCredit;
        let ok;
        if (isPayable) {
          ok = Math.abs(diff - amt) < 0.01;
          balanceEl.innerHTML = ok
            ? `✔ Balanced — net of lines (${fmtMoney(diff)}) matches the amount paid`
            : `⚠ Net of lines (${fmtMoney(diff)}) should equal the ${escHtml(cfg.dueLabel.toLowerCase())} (${fmtMoney(amt)})`;
        } else {
          ok = Math.abs(diff) < 0.01;
          balanceEl.innerHTML = ok
            ? `✔ Balanced — debits equal credits`
            : `⚠ Debits and credits must be equal (off by ${fmtMoney(diff)})`;
        }
        balanceEl.classList.toggle('ok', ok);
        balanceEl.classList.toggle('bad', !ok);
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

        const entryDesc = (body.querySelector('#tfy-je-ref').value || '').trim() || defaultDesc;
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
              value: { date: postDate, reference, paidFrom: bankAcct, description: entryDesc, lines },
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
              value: { date: postDate, reference, narration: entryDesc, lines },
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
  // "TOTAL AMOUNT PAYABLE/(OVERPAYMENT)" line, tax due + penalties). Routes
  // through the shared remittance voucher — the only ITR nuance is that which
  // account clears the debit is a free choice the preparer makes here (Income
  // Tax has multiple Deferred Tax Asset roles — Regular vs MCIT, etc. — that
  // could apply depending on the basis the return was assessed under; getting
  // that right is the preparer's call), surfaced via extraNote.
  function mountItrPaymentStepContent(body, panel, state, step, onPosted) {
    mountRemittanceVoucherContent(body, panel, state, step, onPosted, {
      spinnerLabel: 'Reading return totals…',
      sourceVar: '_itr',
      amountField: 'totalPayable',
      missingHtml: '⚠️ Open and generate the return step first so this step can read the computed total.<br><br>Once that step has finished generating, come back here — this will retry automatically.',
      taxLabel: 'Income Tax',
      refPrefix: 'ITR',
      debitDesc: 'Income Tax Due Paid',
      dueLabel: 'Total amount payable',
      payBtn: 'Record income tax payment',
      closeBtn: 'Record income tax closing entry',
      zeroExplain: 'This return has no income tax payable and no penalties for the period.',
      extraNote: 'Pick which account this payment clears (e.g. a <strong>Deferred Tax Asset — ITR Payments</strong> role) — that choice is yours, not automated. An overpayment posts as a balanced Journal Entry instead; a nil return has nothing to post at all.',
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

    // A gating checklist (step.gate) blocks Continue until the check passes and
    // offers a Fix button that jumps to the Month-end Prep tab named by
    // step.fixTab. A plain (informational) checklist always lets you continue.
    const gate   = !!step.gate;
    const passed = !gate || result.ok;
    const icon       = result.ok ? '✅' : (gate ? '⛔' : '⚠️');
    const alertClass = result.ok ? 'alert-success' : (gate ? 'alert-error' : 'alert-warn');
    // Offer the Fix button whenever the check failed and a target tab is named —
    // for a gating check it's the primary action (Continue is blocked); for an
    // informational check it's a convenience (Continue still works).
    const fixBtn = (!result.ok && step.fixTab)
      ? `<button class="btn ${gate ? 'btn-primary' : 'btn-outline'}" id="tfy-fix">${escHtml(step.fixLabel || 'Fix in Month-end Prep →')}</button>`
      : '';

    body.innerHTML = `
      <div class="alert ${alertClass}" style="margin-bottom:10px;">${icon} ${escHtml(result.message || '')}</div>
      ${rowsHtml ? `<ul class="tfy-problem-list">${rowsHtml}</ul>` : ''}
      <div class="tfy-step-footer">
        ${fixBtn}
        <button class="btn btn-primary" id="tfy-continue" ${passed ? '' : 'disabled'}>Continue →</button>
        <button class="btn btn-outline" id="tfy-recheck" style="margin-left:6px;">↻ Re-check</button>
      </div>`;

    body.querySelector('#tfy-continue').onclick = () => { if (passed) setStepDone(root, state, step.key, true); };
    body.querySelector('#tfy-recheck').onclick = () => runChecklist(body, panel, state, step);
    const fx = body.querySelector('#tfy-fix');
    if (fx) fx.onclick = () => { if (typeof window.tfyGoToMonthEnd === 'function') window.tfyGoToMonthEnd(step.fixTab); };
  }

  // ── FILE (freeze) step: the terminal action that snapshots the return. ──
  // Reads the headline figure + the report's own period + manual inputs from
  // the primary return iframe (the review step named by step.sourceStepKey,
  // same technique the payment steps use to read window._v / _e / _itr), then
  // POSTs a frozen snapshot. Success → the filing flips to frozen mode.
  function mountFileStep(body, panel, state, step) {
    if (!state._onShow) state._onShow = {};
    state._onShow[step.key] = () => renderFileStep(body, panel, state, step);
  }

  // The primary return step (whose iframe holds the figures/period to freeze).
  function primaryReturnStep(state) {
    const fileStep = state.workflow.steps.find(s => s.type === 'file');
    if (!fileStep || !fileStep.sourceStepKey) return null;
    return state.workflow.steps.find(s => s.key === fileStep.sourceStepKey) || null;
  }

  function primaryReturnUrl(state, step) {
    let file = step.fileFn ? step.fileFn(state.period) : step.file;
    const params = new URLSearchParams({ biz: state.biz });
    if (step.usesPeriod) {
      const qs = periodQueryString(state, step);
      if (qs) new URLSearchParams(qs).forEach((v, k) => params.set(k, v));
    }
    return file + (file.includes('?') ? '&' : '?') + params.toString();
  }

  // Read {figures, amount, period, form, manualInputs} out of the already-open
  // primary return iframe. Returns null (or amount:null) if it hasn't generated
  // yet — renderFileStep then shows a retry hint.
  function readReturnFromIframe(state, fileStep) {
    const srcStep = state.workflow.steps.find(s => s.key === fileStep.sourceStepKey);
    if (!srcStep) return null;
    const iframe = state.iframes[srcStep.iframeId];
    const win = iframe && iframe.contentWindow;
    if (!win) return null;
    const headlineDef = (typeof FilingCore !== 'undefined') ? FilingCore.headlineFor(state.workflow.key) : null;
    const figures = headlineDef ? win[headlineDef.winVar] : null;
    const amount = (figures && headlineDef && typeof figures[headlineDef.field] === 'number')
      ? figures[headlineDef.field] : null;
    return {
      figures: figures || null,
      amount: amount,
      period: win._period || state.period || null,
      form: (win._period && win._period.form) || null,
      manualInputs: captureManualInputs(state),
    };
  }

  // First element matching any of `selectors`, in order.
  function firstMatch(root, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = root.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  // Capture of every manual field the preparer typed, keyed by iframe.
  //
  // Scoped to the report's own page root. An unscoped sweep of the document
  // also picks up inputs that browser extensions inject at <body> level —
  // those were being frozen into filings and stored server-side, which put
  // third-party data in the tenant's audit record. Hidden inputs are
  // skipped too: by definition nobody typed them.
  function captureManualInputs(state) {
    const out = {};
    Object.keys(state.iframes || {}).forEach(iframeId => {
      const iframe = state.iframes[iframeId];
      const doc = iframe && iframe.contentDocument;
      if (!doc) return;
      const scope = firstMatch(doc, FilingCore.PAGE_ROOT_SELECTORS);
      if (!scope) return;
      const fields = {};
      scope.querySelectorAll('input[id], select[id], textarea[id]').forEach(el => {
        if (['button', 'submit', 'file', 'image', 'reset', 'hidden'].indexOf(el.type) !== -1) return;
        fields[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
      });
      if (Object.keys(fields).length) out[iframeId] = fields;
    });
    return out;
  }

  // ── Filed-document capture ──────────────────────────────────────────────
  // Build a standalone copy of the return exactly as it stands on screen,
  // so a filed period can be shown back as it was rather than recomputed
  // from books that have since moved on.
  //
  // Scoped to the return root, so extension-injected nodes never make it in.
  // Only <script> and .no-print are dropped — NOT .no-print-wrap, which on
  // 2550q is the wrapper around the return itself.
  // Best-effort by contract: ANY failure returns null and the freeze goes
  // ahead without a document. This must never throw — it runs on the path
  // between the preparer and their filing, and an escaping error would
  // leave the freeze button dead with the filing unsaved.
  function captureReturnDocument(iframe) {
    try {
      return buildReturnDocument(iframe);
    } catch (e) {
      return null;
    }
  }

  function buildReturnDocument(iframe) {
    const doc = iframe && iframe.contentDocument;
    const win = iframe && iframe.contentWindow;
    if (!doc || !win || !doc.head) return null;
    const source = firstMatch(doc, FilingCore.RETURN_ROOT_SELECTORS);
    if (!source) return null;

    const clone = source.cloneNode(true);
    clone.querySelectorAll('script, .no-print').forEach(el => el.remove());

    // cloneNode copies the ATTRIBUTE, not the live value — an untouched
    // clone would render every field at its original default. Walk both
    // trees together and write the on-screen state into the clone.
    const live = source.querySelectorAll('input, select, textarea');
    const copy = clone.querySelectorAll('input, select, textarea');
    for (let i = 0; i < live.length && i < copy.length; i++) {
      const l = live[i], c = copy[i];
      if (l.type === 'checkbox' || l.type === 'radio') {
        if (l.checked) c.setAttribute('checked', 'checked'); else c.removeAttribute('checked');
      } else if (l.tagName === 'SELECT') {
        Array.from(c.options).forEach((o, oi) => {
          if (oi === l.selectedIndex) o.setAttribute('selected', 'selected');
          else o.removeAttribute('selected');
        });
      } else if (l.tagName === 'TEXTAREA') {
        c.textContent = l.value;
      } else {
        c.setAttribute('value', l.value);
      }
      c.setAttribute('readonly', 'readonly');
    }

    // The report's own stylesheets, plus a <base> so the relative
    // styles.css href still resolves once this is rendered from srcdoc.
    const styles = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"], style'))
      .map(el => el.outerHTML).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<base href="${escHtml(win.location.href)}">${styles}</head>`
      + `<body>${clone.outerHTML}</body></html>`;
  }

  // gzip + base64 the captured document for transport. Returns null when
  // the browser lacks CompressionStream — the freeze then stores figures
  // only rather than failing, since losing the visual record beats losing
  // the filing.
  async function packDocument(html) {
    if (!html || typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([new TextEncoder().encode(html)]).stream()
        .pipeThrough(new CompressionStream('gzip'));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      let bin = '';
      const CHUNK = 0x8000; // chunked so a big doc can't blow the arg limit
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return { base64: btoa(bin), bytes: bytes.length, rawBytes: html.length };
    } catch (e) {
      return null;
    }
  }

  // Inverse of packDocument, for rendering a filed document back.
  async function unpackDocument(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  function renderFileStep(body, panel, state, step) {
    const root = panel.closest('.tfy-step-wrap').parentElement;
    const headlineDef = (typeof FilingCore !== 'undefined') ? FilingCore.headlineFor(state.workflow.key) : null;
    const ret = readReturnFromIframe(state, step);

    if (!ret || ret.amount == null) {
      body.innerHTML = `<div class="alert alert-warn">⚠️ Open and generate the return step above first, then come back here to freeze this filing. This will retry automatically when the figures are ready.</div>`;
      return;
    }

    const periodLabel = (typeof FilingCore !== 'undefined' && ret.period) ? FilingCore.periodLabel(ret.period) : '';
    body.innerHTML = `
      <div class="alert alert-info" style="margin-bottom:12px;">
        You're about to <strong>freeze</strong> this filing. The figures below are saved as of now, so later edits to
        this period's books won't rewrite the filed return — they flow into an amendment instead.
      </div>
      <table class="tax-codes-table" style="margin-bottom:12px;">
        <tbody>
          <tr><td style="width:180px;">Filing</td><td><strong>${escHtml(state.workflow.label)}${ret.form ? ' — ' + escHtml(ret.form) : ''}</strong></td></tr>
          <tr><td>Period</td><td><strong>${escHtml(periodLabel)}</strong></td></tr>
          <tr><td>${escHtml((headlineDef && headlineDef.label) || 'Headline figure')}</td><td><strong>${fmtMoney(ret.amount)}</strong></td></tr>
        </tbody>
      </table>
      <div class="tfy-step-footer">
        ${step.bundle ? `<button class="btn btn-outline" id="tfy-download-all">⬇ Download working-paper files</button>` : ''}
        <button class="btn btn-primary" id="tfy-mark-filed" ${step.bundle ? 'style="margin-left:6px;"' : ''}>🔒 Mark as Filed</button>
        <span id="tfy-file-status" style="font-size:12px;color:#6b7280;margin-left:8px;"></span>
      </div>`;

    if (step.bundle) {
      body.querySelector('#tfy-download-all').onclick = () => triggerBundleDownloads(state, step.bundle);
    }
    body.querySelector('#tfy-mark-filed').onclick = () => doFreeze(body, root, state, step, ret, headlineDef);
  }

  // Re-fire the download buttons of a set of earlier steps' report iframes
  // (working-paper bundle). Shared by the 'final' bundle step and the 'file'
  // step's folded-in working-paper button. Only clicks visible buttons, so a
  // skipped/optional step (e.g. SAWT) with hidden buttons is silently ignored.
  function triggerBundleDownloads(state, bundle) {
    bundle.forEach(targetStepKey => {
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
  }

  async function doFreeze(body, root, state, step, ret, headlineDef) {
    const statusEl = body.querySelector('#tfy-file-status');
    const btn = body.querySelector('#tfy-mark-filed');
    if (typeof FilingStore === 'undefined') { statusEl.textContent = '❌ Filing store unavailable.'; return; }

    const periodKey = (typeof FilingCore !== 'undefined') ? FilingCore.periodKey(ret.period || state.period) : state.periodKey;
    if (!periodKey) { statusEl.textContent = '❌ This filing has no period.'; return; }

    btn.disabled = true;
    statusEl.textContent = 'Freezing…';
    const payload = {
      figures: ret.figures || null,
      period: ret.period || state.period || null,
      manualInputs: ret.manualInputs || {},
      filedAtClient: new Date().toISOString(),
    };

    // Store the return as rendered, so the filed period can be shown back
    // exactly as it stood. If it can't be captured or won't fit the request
    // cap, file WITHOUT it — the figures still freeze. A missing visual
    // record is a degraded filing; a failed freeze is no filing at all.
    const srcStep = state.workflow.steps.find(s => s.key === step.sourceStepKey);
    const packed = await packDocument(captureReturnDocument(srcStep && state.iframes[srcStep.iframeId]));
    if (packed) {
      const otherBytes = JSON.stringify(payload).length;
      if (FilingCore.documentFitsCap(packed.bytes, FilingStore.MAX_BODY_BYTES, otherBytes)) {
        payload.document = { encoding: 'gzip+base64', data: packed.base64, rawBytes: packed.rawBytes };
      }
    }

    const snapshot = {
      workflowKey: state.workflow.key,
      periodKey: periodKey,
      form: ret.form || null,
      headline: { label: (headlineDef && headlineDef.label) || 'Headline figure', amount: ret.amount },
      payload: payload,
    };

    try {
      const res = await FilingStore.saveFilingSnapshot(state.biz, snapshot);
      setStepDone(root, state, step.key, true);
      // Keep periodKey aligned to what was actually filed (the report's own
      // period may differ from the launch hint).
      state.period = ret.period || state.period;
      state.periodKey = periodKey;
      state.status = (res.version > 1) ? 'amended' : 'filed';
      renderFrozenView(root, state);
    } catch (e) {
      btn.disabled = false;
      if (e && e.isAuthError) {
        // Server-only store: a freeze must fail LOUDLY when there's no session.
        statusEl.textContent = '';
        body.querySelector('.tfy-step-footer').insertAdjacentHTML('beforebegin',
          `<div class="alert alert-warn" style="margin-bottom:10px;">🔑 <strong>Sign in to freeze filings.</strong>
             Freezing saves the return to your Txform account. Sign in at
             <a href="/account" target="_blank" rel="noopener">txform.ph/account</a>, then click Mark as Filed again.
             Your draft progress is kept.</div>`);
      } else {
        statusEl.textContent = '❌ ' + ((e && e.message) || 'Could not freeze filing.');
      }
    }
  }

  // ── FROZEN read-only mode: a filed/amended filing renders from its
  //    snapshot instead of the live rail, with a variance check. ────────────
  async function renderFrozenView(container, state) {
    const periodLabel = (typeof FilingCore !== 'undefined' && state.period) ? FilingCore.periodLabel(state.period) : '';
    container.innerHTML = `<div class="tfy-frozen"><div class="spinner-wrap"><div class="spinner"></div><span>Loading filed return…</span></div></div>`;

    if (typeof FilingStore === 'undefined') {
      container.innerHTML = `<div class="tfy-frozen"><div class="alert alert-error">Filing store unavailable.</div></div>`;
      return;
    }

    let history = [];
    try {
      history = await FilingStore.loadFilingSnapshots(state.biz, state.workflow.key, state.periodKey);
    } catch (e) {
      const msg = (e && e.isAuthError)
        ? `🔑 Sign in at <a href="/account" target="_blank" rel="noopener">txform.ph/account</a> to view filed returns.`
        : `❌ ${escHtml((e && e.message) || 'Could not load filed return.')}`;
      container.innerHTML = `<div class="tfy-frozen"><div class="alert ${e && e.isAuthError ? 'alert-warn' : 'alert-error'}">${msg}</div></div>`;
      return;
    }

    const current = (typeof FilingCore !== 'undefined') ? FilingCore.currentSnapshot(history) : (history[0] || null);
    if (!current) { state.status = 'draft'; buildDraft(container, state); return; }

    const filedAtStr = current.filed_at
      ? new Date(current.filed_at.replace(' ', 'T') + 'Z').toLocaleString('en-PH',
          { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const amended = current.version > 1;
    const headline = current.headline || {};

    const historyRows = history.slice().sort((a, b) => (b.version || 0) - (a.version || 0)).map(s => {
      const badge = (s.status === 'filed' || s.status == null)
        ? '<span class="tfy-status-pill filed">current</span>'
        : '<span class="tfy-status-pill">superseded</span>';
      const amt = (s.headline && typeof s.headline.amount === 'number') ? fmtMoney(s.headline.amount) : '';
      return `<tr><td>v${s.version || ''}</td><td>${badge}</td><td class="num">${amt}</td><td>${escHtml(s.filed_at || '')}</td><td>${escHtml(s.filed_by || '')}</td></tr>`;
    }).join('');

    container.innerHTML = `
      <div class="tfy-frozen">
        <div class="tfy-frozen-banner ${amended ? 'amended' : ''}">
          <div>
            <div class="tfy-frozen-title">🔒 ${escHtml(state.workflow.label)}${current.form ? ' — ' + escHtml(current.form) : ''} · ${escHtml(periodLabel)}</div>
            <div class="tfy-frozen-sub">${amended ? 'Amended' : 'Filed'} — version ${current.version || 1}, on ${escHtml(filedAtStr)}${current.filed_by ? ' by ' + escHtml(current.filed_by) : ''}</div>
          </div>
          <span class="tfy-status-pill ${amended ? 'amended' : 'filed'}">${amended ? 'Amended' : 'Filed'}</span>
        </div>

        <div id="tfy-variance" class="tfy-variance checking">Checking live books against the filed figures…</div>

        <div class="tfy-frozen-figure">
          <div class="tfy-frozen-figure-label">${escHtml(headline.label || 'Filed figure')}</div>
          <div class="tfy-frozen-figure-amt">${typeof headline.amount === 'number' ? fmtMoney(headline.amount) : '—'}</div>
        </div>

        ${renderFrozenDocument(current)}

        ${renderFrozenManualInputs(current)}

        <details class="tfy-frozen-history">
          <summary>Amendment history (${history.length} version${history.length === 1 ? '' : 's'})</summary>
          <table class="tax-codes-table"><thead><tr><th>Ver</th><th>Status</th><th>Headline</th><th>Filed at (UTC)</th><th>By</th></tr></thead>
          <tbody>${historyRows}</tbody></table>
        </details>

        <div class="tfy-step-footer">
          <button class="btn btn-outline" id="tfy-amend">✎ Amend filing</button>
        </div>
      </div>`;

    container.querySelector('#tfy-amend').onclick = () => {
      if (!confirm('Amend this filing? Change the figures and re-file — the new version supersedes the current one, and both are kept in history.')) return;
      const handle = container._tfyHandle;
      if (handle && handle.amend) handle.amend();
    };

    mountFrozenDocument(container, current);
    runFrozenVariance(container, state, current);
  }

  // The filed return, as it was rendered on the day it was filed. Absent on
  // snapshots frozen before documents were captured, and on any freeze where
  // the document didn't fit the request cap — say so plainly rather than
  // showing an empty frame.
  function renderFrozenDocument(current) {
    const doc = current.payload && current.payload.document;
    if (!doc || !doc.data) {
      return `<div class="alert alert-info" style="margin-bottom:12px;">
        No filed document was stored for this version — the figures below are the record.
      </div>`;
    }
    return `
      <details class="tfy-frozen-doc" open>
        <summary>Filed return (as submitted)</summary>
        <div class="tfy-frozen-doc-actions">
          <button type="button" class="btn btn-outline" id="tfy-print-filed">🖨 Print / Save as PDF</button>
        </div>
        <div id="tfy-filed-doc-wrap"><div class="spinner-wrap"><div class="spinner"></div><span>Opening filed return…</span></div></div>
      </details>`;
  }

  // Decompress and render the filed document into a sandboxed frame.
  // sandbox="" (no allow-scripts) means the stored markup renders but can
  // never execute — it was captured from a live page, so it is treated as
  // untrusted on the way back in.
  async function mountFrozenDocument(container, current) {
    const wrap = container.querySelector('#tfy-filed-doc-wrap');
    const doc = current.payload && current.payload.document;
    if (!wrap || !doc || !doc.data) return;
    try {
      const html = await unpackDocument(doc.data);
      const frame = document.createElement('iframe');
      frame.className = 'tfy-filed-doc';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('title', 'Filed return');
      frame.srcdoc = html;
      wrap.innerHTML = '';
      wrap.appendChild(frame);

      const printBtn = container.querySelector('#tfy-print-filed');
      if (printBtn) {
        printBtn.onclick = () => {
          // A sandboxed frame can't print itself — hand the stored markup
          // to a fresh window and let the browser's own print flow run.
          const w = window.open('', '_blank');
          if (!w) { alert('Allow pop-ups to print the filed return.'); return; }
          w.document.write(html);
          w.document.close();
          w.focus();
          setTimeout(() => w.print(), 300);
        };
      }
    } catch (e) {
      wrap.innerHTML = `<div class="alert alert-warn">⚠️ The stored filed return could not be opened. The figures below are still the filed record.</div>`;
    }
  }

  function renderFrozenManualInputs(current) {
    const mi = current.payload && current.payload.manualInputs;
    if (!mi || !Object.keys(mi).length) return '';
    let rows = '';
    Object.keys(mi).forEach(iframeId => {
      const fields = mi[iframeId] || {};
      Object.keys(fields).forEach(id => {
        const v = fields[id];
        // Only true blanks are skipped. 0/'0'/false are answers on a filing
        // record — January is a month, an unticked box is a deliberate No.
        if (FilingCore.isEmptyManualInput(v)) return;
        rows += `<tr><td>${escHtml(FilingCore.manualInputLabel(id))}</td>`
          + `<td class="num">${escHtml(FilingCore.manualInputDisplay(id, v))}</td></tr>`;
      });
    });
    if (!rows) return '';
    return `<details class="tfy-frozen-history"><summary>Frozen manual inputs</summary>
      <table class="tax-codes-table"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  }

  // Regenerate the same return for the same period in a hidden iframe and
  // compare its headline against the frozen one. Auto-runs for returns that
  // honor URL period params (VAT/EWT); degrades to a "check manually" note
  // for those that don't — never blocks the frozen view.
  function runFrozenVariance(container, state, current) {
    const varEl = container.querySelector('#tfy-variance');
    if (!varEl) return;
    const headlineDef = (typeof FilingCore !== 'undefined') ? FilingCore.headlineFor(state.workflow.key) : null;
    const srcStep = primaryReturnStep(state);
    if (!headlineDef || !srcStep) { varEl.style.display = 'none'; return; }

    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;left:-9999px;top:-9999px;';
    const iframe = document.createElement('iframe');
    iframe.src = primaryReturnUrl(state, srcStep);
    holder.appendChild(iframe);
    container.appendChild(holder);

    let done = false;
    const finish = (liveAmount) => {
      if (done) return; done = true;
      const v = (typeof FilingCore !== 'undefined')
        ? FilingCore.computeVariance(current.headline || {}, liveAmount)
        : { changed: false };
      if (liveAmount == null) {
        varEl.className = 'tfy-variance none';
        varEl.textContent = 'Could not read live books automatically — open the workflow return to compare manually.';
      } else if (v.changed) {
        varEl.className = 'tfy-variance changed';
        varEl.innerHTML = `⚠️ <strong>Books changed since filing.</strong> Filed ${fmtMoney(v.filedAmount)}, books now ${fmtMoney(v.liveAmount)} (${v.delta >= 0 ? '+' : ''}${fmtMoney(v.delta)}) — consider amending.`;
      } else {
        varEl.className = 'tfy-variance ok';
        varEl.innerHTML = `✅ Live books still match the filed figure (${fmtMoney(v.filedAmount)}).`;
      }
      setTimeout(() => holder.remove(), 500);
    };

    const poll = setInterval(() => {
      const win = iframe.contentWindow;
      const figures = win && win[headlineDef.winVar];
      if (figures && typeof figures[headlineDef.field] === 'number') {
        clearInterval(poll);
        finish(figures[headlineDef.field]);
      }
    }, 500);
    setTimeout(() => { clearInterval(poll); if (!done) finish(null); }, 30000);
  }

  return { mount };
})();
