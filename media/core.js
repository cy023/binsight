(function() {
const vscode = acquireVsCodeApi();
const report = window.__BINSIGHT_DATA__;
const schemas = (report.schemas || []).slice();
const discoveredLayouts = (report.layouts || []).slice();

const defaultSchema = schemas[0] ||
    {id: 'empty', name: 'EMPTY', endianness: 'little', baseAddress: 0, byteSpan: 16, groups: [], registers: []};

function getSchemaById(schemaId) {
  return schemas.find((s) => s.id === schemaId) || schemas[0] || defaultSchema;
}

function parseAddressInput(raw, fallback = 0) {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  const parsed = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isNaN(parsed) ? fallback : Math.max(0, parsed);
}

function toHex(num, pad = 2) {
  return '0x' + Number(num || 0).toString(16).toUpperCase().padStart(pad, '0');
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getUiState() {
  try {
    return vscode.getState() || {};
  } catch {
    return {};
  }
}

function patchUiState(partial) {
  try {
    const next = {...getUiState(), ...partial};
    vscode.setState(next);
    return next;
  } catch {
    return {};
  }
}

function restoreSelectOption(selectEl, savedValue) {
  if (!selectEl || !savedValue) return false;
  if (![...selectEl.options].some((o) => o.value === savedValue)) return false;
  const changed = selectEl.value !== savedValue;
  selectEl.value = savedValue;
  return changed;
}

function copyWithFeedback(text, btnEl) {
  if (text === undefined || text === null) return;
  vscode.postMessage({type: 'copyText', text: String(text)});
  if (btnEl) {
    const orig = btnEl.dataset.origLabel || btnEl.textContent;
    btnEl.dataset.origLabel = orig;
    btnEl.textContent = 'Copied!';
    clearTimeout(btnEl._copyTimer);
    btnEl._copyTimer = setTimeout(() => {
      btnEl.textContent = orig;
    }, 1200);
  }
}

const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
let activeTabId = 'tab-registers';
function switchTab(targetId) {
  activeTabId = targetId;
  patchUiState({activeTab: targetId});
  tabButtons.forEach((btn) => {
    const isMatch = btn.dataset.tab === targetId;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });
  tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === targetId));
  const modeKey = TAB_TO_MODE[targetId];
  const modeObj = modeKey && window.Binsight?.modes?.[modeKey];
  if (modeObj && typeof modeObj.onActivate === 'function') {
    modeObj.onActivate();
  }
}

function setTabDirty(tabId, isDirty) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (btn) btn.classList.toggle('dirty', Boolean(isDirty));
}
tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

let lastJumpOriginTab = null;

function jumpToHex(offset, length = 1) {
  const numOff = Number(offset);
  if (!Number.isFinite(numOff) || numOff < 0) return;
  if (activeTabId && activeTabId !== 'tab-hex') {
    lastJumpOriginTab = activeTabId;
    const originBtn = document.querySelector(`.tab-btn[data-tab="${activeTabId}"]`);
    const backBtn = document.getElementById('btn-jump-back');
    if (backBtn) {
      backBtn.textContent = `↩ ${originBtn ? originBtn.textContent.trim() : 'Back'}`;
      backBtn.classList.remove('hidden');
    }
  }
  switchTab('tab-hex');
  const hexMode = window.Binsight?.modes?.hexEditor;
  if (hexMode && typeof hexMode.jumpTo === 'function') {
    hexMode.jumpTo(numOff, Math.max(1, Number(length) || 1));
  }
}

document.getElementById('btn-jump-back')?.addEventListener('click', () => {
  if (lastJumpOriginTab) {
    const target = lastJumpOriginTab;
    lastJumpOriginTab = null;
    document.getElementById('btn-jump-back')?.classList.add('hidden');
    switchTab(target);
  }
});

document.addEventListener('click', (e) => {
  // Auto-close open toolbar dropdowns when clicking outside or clicking an action button inside
  document.querySelectorAll('details.cmd-more[open]').forEach((det) => {
    if (!det.contains(e.target) || e.target.closest('.cmd-more-menu .btn')) {
      det.removeAttribute('open');
    }
  });

  const jumpEl = e.target.closest('[data-jump-file-offset]');
  if (jumpEl) {
    const off = Number(jumpEl.dataset.jumpFileOffset);
    const len = Number(jumpEl.dataset.jumpLength) || 1;
    jumpToHex(off, len);
  }
});

const TAB_ORDER = ['tab-hex', 'tab-struct-view', 'tab-record-trace', 'tab-protocol-analyze', 'tab-registers'];
const TAB_SEARCH_INPUT = {
  'tab-registers': 'reg-search',
  'tab-struct-view': 'sl-search',
  'tab-record-trace': 'rs-block-input',
  'tab-protocol-analyze': 'proto-entry-input',
  'tab-hex': 'jump-input'
};
const TAB_TO_MODE = {
  'tab-registers': 'registers',
  'tab-struct-view': 'structView',
  'tab-record-trace': 'recordTrace',
  'tab-protocol-analyze': 'protocolAnalyze',
  'tab-hex': 'hexEditor'
};

document.addEventListener('keydown', (e) => {
  const pasteModal = document.getElementById('paste-hex-modal');
  if (pasteModal && !pasteModal.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      pasteModal.classList.add('hidden');
      e.preventDefault();
    }
    return;
  }

  const activeEl = document.activeElement;
  const isEditing = activeEl &&
      (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA' ||
       activeEl.isContentEditable);

  if (e.key === 'Escape') {
    document.querySelectorAll('details.cmd-more[open]').forEach((det) => det.removeAttribute('open'));
    if (isEditing) {
      activeEl.blur();
      e.preventDefault();
      return;
    }
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    const inputId = TAB_SEARCH_INPUT[activeTabId];
    const inputEl = inputId && document.getElementById(inputId);
    if (inputEl) {
      e.preventDefault();
      inputEl.focus();
      inputEl.select?.();
    }
    return;
  }

  if (isEditing) return;

  const modeKey = TAB_TO_MODE[activeTabId];
  const modeObj = modeKey && window.Binsight?.modes?.[modeKey];
  if (activeTabId === 'tab-hex' && modeObj?.isTextInputActive?.() && e.key.length === 1 && !e.ctrlKey && !e.metaKey &&
      !e.altKey) {
    modeObj.handleKeyDown(e);
    return;
  }

  if (e.key === '/') {
    const inputId = TAB_SEARCH_INPUT[activeTabId];
    const inputEl = inputId && document.getElementById(inputId);
    if (inputEl) {
      e.preventDefault();
      inputEl.focus();
      inputEl.select?.();
    }
    return;
  }

  if (e.altKey && e.key === 'ArrowLeft' && activeTabId === 'tab-hex' && lastJumpOriginTab) {
    e.preventDefault();
    document.getElementById('btn-jump-back')?.click();
    return;
  }

  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '1' && e.key <= '5') {
    const targetTab = TAB_ORDER[Number(e.key) - 1];
    if (targetTab) {
      e.preventDefault();
      switchTab(targetTab);
    }
    return;
  }

  if (modeObj && typeof modeObj.handleKeyDown === 'function') {
    modeObj.handleKeyDown(e);
  }
});

// UI Scale selector (persisted via vscode.setState)
  const submitModal = () => {
    const mode = modeSelect?.value === 'text' ? 'text' : 'hex';
    const text = textarea?.value || '';
    if (mode === 'text') {
      if (text.length === 0) {
        if (errEl) errEl.textContent = 'Please enter or paste some text.';
        return;
      }
    } else if (!/[0-9a-fA-F]{2}/.test(text)) {
      if (errEl) errEl.textContent = 'Please paste at least one valid hex byte.';
      return;
    }
    if (errEl) errEl.textContent = '';
    closeModal();
    if (pasteTarget === 'baseline') {
      vscode.postMessage({type: 'loadBaselinePasted', mode, text});
    } else {
      vscode.postMessage({type: 'loadPastedHex', mode, text});
    }
  };
  openBtn?.addEventListener('click', () => openModalFor('scratchpad'));
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'openPasteModalForBaseline') {
      openModalFor('baseline');
    }
  });
  document.getElementById('btn-paste-hex-close')?.addEventListener('click', closeModal);
  document.getElementById('btn-paste-hex-cancel')?.addEventListener('click', closeModal);
  document.getElementById('btn-paste-hex-load')?.addEventListener('click', submitModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  textarea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitModal();
    }
  });
})();

const baseB = {
  vscode,
  report,
  schemas,
  discoveredLayouts,
  defaultSchema,
  getSchemaById,
  parseAddressInput,
  toHex,
  escapeHtml,
  switchTab,
  setTabDirty,
  getActiveTabId: () => activeTabId,
  jumpToHex,
  getUiState,
  patchUiState,
  restoreSelectOption,
  copyWithFeedback
};
const uiApi = window.BinsightUi.bindCoreUi(baseB);
window.Binsight = {
  ...baseB,
  ...window.BinsightMath,
  ...window.BinsightProto,
  ...uiApi,
  modes: {}
};
})();
