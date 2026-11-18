(function() {
function bindCoreUi(B) {
  const {vscode, report, schemas, getSchemaById, escapeHtml, getUiState, patchUiState} = B;

function populateModeSchemaSelect(selectEl, mode) {
  if (!selectEl) return;
  const filtered = schemas.filter((s) => s.mode === mode);
  const pool = filtered.length > 0 ? filtered : schemas;
  const targetId = report.initialMode === mode && report.initialSchemaId ? report.initialSchemaId : pool[0]?.id;
  selectEl.innerHTML = pool.map(
                               (s) => `<option value="${escapeHtml(s.id)}" ${s.id === targetId ? 'selected' : ''}>${
                                   escapeHtml(s.name)}</option>`)
                           .join('');
  if (targetId) selectEl.value = targetId;
}

function populateVariantFilterSelect(selectEl, schemaId, allLabel) {
  if (!selectEl) return;
  const sch = getSchemaById(schemaId);
  const opts = [`<option value="all">${escapeHtml(allLabel)}</option>`];
  for (const [k, v] of Object.entries(sch.variants || {})) {
    opts.push(`<option value="${escapeHtml(k)}">${escapeHtml(k)}: ${escapeHtml(v.name)}</option>`);
  }
  selectEl.innerHTML = opts.join('');
  selectEl.value = 'all';
}

function bindEditSchemaButton(btnId, selectEl, fallbackName) {
  document.getElementById(btnId)?.addEventListener('click', () => {
    const sch = getSchemaById(selectEl?.value);
    vscode.postMessage({
      type: 'openSchemaInEditor',
      schemaFilePath: sch?.filePath || null,
      schemaName: sch?.name || fallbackName,
      sourceText: sch?.sourceText || '{}'
    });
  });
}

function updatePagination(prefix, page, totalPages, infoText) {
  const pageInfo = document.getElementById(`${prefix}-page-info`);
  const prevBtn = document.getElementById(`${prefix}-prev-page`);
  const nextBtn = document.getElementById(`${prefix}-next-page`);
  if (pageInfo) pageInfo.textContent = infoText;
  if (prevBtn) prevBtn.disabled = page <= 0;
  if (nextBtn) nextBtn.disabled = page + 1 >= totalPages;
}

function initSplitResizer(resizerId, cssVarName, fromRight, minPx, maxPx) {
  const resizer = document.getElementById(resizerId);
  if (!resizer || !resizer.parentElement) return;
  const savedWidth = getUiState().splits?.[cssVarName];
  if (typeof savedWidth === 'number' && savedWidth >= minPx) {
    resizer.parentElement.style.setProperty(cssVarName, `${savedWidth}px`);
  }
  let dragging = false;
  let lastWidth = null;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = resizer.parentElement.getBoundingClientRect();
    const rawWidth = fromRight ? rect.right - e.clientX : e.clientX - rect.left;
    const dynamicMax = Math.max(maxPx, Math.round(rect.width * 0.8));
    const boundedMax = Math.min(dynamicMax, Math.max(minPx, Math.round(rect.width - minPx)));
    lastWidth = Math.max(minPx, Math.min(boundedMax, Math.round(rawWidth)));
    resizer.parentElement.style.setProperty(cssVarName, `${lastWidth}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    if (lastWidth !== null) {
      const splits = {...(getUiState().splits || {}), [cssVarName]: lastWidth};
      patchUiState({splits});
    }
  });
}

function renderRuleHitsBox(ruleHits) {
  if (!Array.isArray(ruleHits) || ruleHits.length === 0) return '';
  const items =
      ruleHits
          .map(
              (h) => `<div class="rule-hit sev-${escapeHtml(h.severity)}"><strong>[${
                  escapeHtml(
                      h.severity.toUpperCase())}]</strong> ${escapeHtml(h.name)}: ${escapeHtml(h.message)}</div>`)
          .join('');
  return `<div class="rule-hits-box">${items}</div>`;
}

function updateAnomalyBar(barId, badgeId, counts) {
  const bar = document.getElementById(barId);
  const badge = document.getElementById(badgeId);
  if (!bar || !badge) return;
  const errCnt = counts?.error || 0;
  const warnCnt = counts?.warn || 0;
  if (errCnt + warnCnt > 0) {
    bar.classList.remove('hidden');
    badge.className = `hud-chip ${errCnt > 0 ? 'anomaly-err' : 'anomaly-warn'}`;
    badge.textContent = `${errCnt} Err · ${warnCnt} Warn`;
  } else {
    bar.classList.add('hidden');
  }
}

function findNextAnomalyMatch(anomalies, curGlobalIdx, dir) {
  if (!Array.isArray(anomalies) || anomalies.length === 0) return null;
  if (dir > 0) {
    return anomalies.find((a) => a.matchIdx > curGlobalIdx) || anomalies[0];
  }
  for (let i = anomalies.length - 1; i >= 0; i--) {
    if (anomalies[i].matchIdx < curGlobalIdx) return anomalies[i];
  }
  return anomalies[anomalies.length - 1];
}

(function initUiScaleControl() {
  const scaleSelect = document.getElementById('ui-scale-select');
  if (!scaleSelect) return;
  const ZOOM_STEPS = [0.75, 0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.65, 1.75];
  const applyScale = (val) => {
    const num = Number(val);
    const safe = Number.isFinite(num) && num >= 0.7 && num <= 1.8 ? num : 1;
    document.body.style.zoom = safe === 1 ? '' : String(safe);
    scaleSelect.value = String(safe);
  };
  const saved = getUiState().uiScale;
  if (saved !== undefined) applyScale(saved);
  scaleSelect.addEventListener('change', () => {
    applyScale(scaleSelect.value);
    patchUiState({uiScale: Number(scaleSelect.value)});
  });
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0') {
      e.preventDefault();
      const cur = Number(scaleSelect.value) || 1;
      let next = 1;
      if (e.key === '=' || e.key === '+') {
        next = ZOOM_STEPS.find((s) => s > cur + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
      } else if (e.key === '-') {
        for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
          if (ZOOM_STEPS[i] < cur - 0.001) {
            next = ZOOM_STEPS[i];
            break;
          }
        }
        if (cur <= ZOOM_STEPS[0]) next = ZOOM_STEPS[0];
      }
      applyScale(next);
      patchUiState({uiScale: next});
    }
  });
})();

// Global Paste Hex / Text Modal wiring
(function initPasteHexModal() {
  const modal = document.getElementById('paste-hex-modal');
  const titleEl = document.getElementById('paste-hex-title');
  const textarea = document.getElementById('paste-hex-textarea');
  const modeSelect = document.getElementById('paste-input-mode');
  const hintEl = document.getElementById('paste-hex-hint');
  const errEl = document.getElementById('paste-hex-error');
  const openBtn = document.getElementById('btn-paste-hex');
  const loadBtn = document.getElementById('btn-paste-hex-load');
  let pasteTarget = 'scratchpad'; // 'scratchpad' | 'baseline'
  const closeModal = () => modal?.classList.add('hidden');

  const updateModeUi = () => {
    const isText = modeSelect?.value === 'text';
    if (titleEl) {
      titleEl.textContent = pasteTarget === 'baseline' ? 'Paste Baseline Hex / Text to Compare' : 'Paste Hex / Text to Inspect';
    }
    if (loadBtn) {
      loadBtn.textContent = pasteTarget === 'baseline' ? 'Compare (Ctrl+Enter)' : 'Load & Parse (Ctrl+Enter)';
    }
    if (hintEl) {
      hintEl.innerHTML = isText ?
          'Paste any plain ASCII / UTF-8 text. Its raw bytes will be ' +
              (pasteTarget === 'baseline' ? 'used as the comparison baseline.' : 'loaded and parsed across all 5 tabs.') :
          'Supports space-separated bytes, <code>0x</code> words, Intel HEX, or offset-prefixed hex dumps. ' +
              (pasteTarget === 'baseline' ? 'Will be used as the comparison baseline.' : 'All 5 tabs will parse the loaded bytes.');
    }
    if (textarea) {
      textarea.placeholder = isText ? 'e.g. Hello Binsight! Paste any plain text here...' :
                                      'e.g. 48 65 6C 6C 6F 20 57 6F 72 6C 64\nor 0x0000: DE AD BE EF 01 02 03 04';
    }
    if (errEl) errEl.textContent = '';
  };

  const openModalFor = (target) => {
    if (!modal) return;
    pasteTarget = target;
    if (errEl) errEl.textContent = '';
    updateModeUi();
    modal.classList.remove('hidden');
    textarea?.focus();
    textarea?.select();
  };

  modeSelect?.addEventListener('change', updateModeUi);


  return {
    populateModeSchemaSelect,
    populateVariantFilterSelect,
    bindEditSchemaButton,
    updatePagination,
    initSplitResizer,
    renderRuleHitsBox,
    updateAnomalyBar,
    findNextAnomalyMatch
  };
}
window.BinsightUi = {bindCoreUi};
})();
