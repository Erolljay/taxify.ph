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

  const TYPE_ICON = { review: '📊', validate: '🔎', download: '📥', final: '🏁' };

  function mount(container, workflow, biz) {
    const state = {
      biz, workflow,
      activeIndex: 0,
      doneCache: {},     // stepKey -> bool (mirrors localStorage)
      bodyEls: {},        // stepKey -> the persistent <div class="tfy-step-body"> for that step
      iframes: {},        // iframeId -> <iframe> (shared across steps that reuse the same report file)
    };

    workflow.steps.forEach(s => { state.doneCache[s.key] = isDone(biz, workflow.key, s.key); });
    const firstPending = workflow.steps.findIndex(s => !state.doneCache[s.key]);
    state.activeIndex = firstPending === -1 ? workflow.steps.length - 1 : firstPending;

    buildSkeleton(container, state);
    renderRail(container, state);
    showActiveStep(container, state);

    return {
      reset() {
        resetWorkflow(state.biz, workflow.key, workflow.steps);
        workflow.steps.forEach(s => { state.doneCache[s.key] = false; });
        state.activeIndex = 0;
        renderRail(container, state);
        showActiveStep(container, state);
      },
    };
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

    if (step.type === 'review' || step.type === 'download' || step.type === 'final') {
      mountIframeStep(body, panel, state, step);
    } else if (step.type === 'validate') {
      mountValidateStep(body, panel, state, step);
    }
  }

  function mountIframeStep(body, panel, state, step) {
    const mountEl = document.createElement('div');
    mountEl.className = 'tfy-iframe-mount';
    body.appendChild(mountEl);

    const footer = document.createElement('div');
    footer.className = 'tfy-step-footer';
    body.appendChild(footer);

    const iframe = getOrCreateIframe(state, mountEl, step.iframeId, step.file);

    if (step.type === 'review') {
      footer.innerHTML = `<button class="btn btn-primary" id="tfy-continue">Continue →</button>`;
      footer.querySelector('#tfy-continue').onclick = () => {
        const root = panel.closest('.tfy-step-wrap').parentElement;
        setStepDone(root, state, step.key, true);
      };
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
    footer.querySelector('#tfy-finish').onclick = () => setStepDone(root, state, step.key, true);
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

  return { mount, isDone, markDone, resetWorkflow };
})();
