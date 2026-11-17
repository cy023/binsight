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
let activeTabId = 'tab-segments';
function switchTab(targetId) {
  activeTabId = targetId;
  patchUiState({activeTab: targetId});
  tabButtons.forEach((btn) => {
    const isMatch = btn.dataset.tab === targetId;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });
  tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === targetId));
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
  const hexMode = window.Binsight?.modes?.hexOverview;
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

const TAB_ORDER = ['tab-segments', 'tab-struct-list', 'tab-repeat-struct', 'tab-protocol', 'tab-hex'];
const TAB_SEARCH_INPUT = {
  'tab-segments': 'reg-search',
  'tab-struct-list': 'sl-search',
  'tab-repeat-struct': 'rs-block-input',
  'tab-protocol': 'proto-entry-input',
  'tab-hex': 'jump-input'
};
const TAB_TO_MODE = {
  'tab-segments': 'registerMap',
  'tab-struct-list': 'structList',
  'tab-repeat-struct': 'repeatStruct',
  'tab-protocol': 'protocol',
  'tab-hex': 'hexOverview'
};

document.addEventListener('keydown', (e) => {
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

  const modeKey = TAB_TO_MODE[activeTabId];
  const modeObj = modeKey && window.Binsight?.modes?.[modeKey];
  if (modeObj && typeof modeObj.handleKeyDown === 'function') {
    modeObj.handleKeyDown(e);
  }
});

function readWordBigInt(byteArray, relOffset, size, endian) {
  let val = 0n;
  for (let i = 0; i < size; i++) {
    const idx = relOffset + i;
    const b = BigInt(idx >= 0 && idx < byteArray.length ? byteArray[idx] : 0);
    val = endian === 'big' ? (val << 8n) | b : val | (b << BigInt(i * 8));
  }
  return val;
}

function extractBitfield(regValBig, msb, lsb) {
  const width = BigInt(msb - lsb + 1);
  return (regValBig >> BigInt(lsb)) & ((1n << width) - 1n);
}

function replaceBitfield(regValBig, msb, lsb, newFieldValBig) {
  const width = BigInt(msb - lsb + 1);
  const fieldMask = (1n << width) - 1n;
  return (regValBig & ~(fieldMask << BigInt(lsb))) | ((newFieldValBig & fieldMask) << BigInt(lsb));
}

function toSignedBigInt(uValBig, bitWidth) {
  if (bitWidth <= 0) return 0n;
  const signBit = 1n << BigInt(bitWidth - 1);
  return (uValBig & signBit) !== 0n ? uValBig - (1n << BigInt(bitWidth)) : uValBig;
}

function decodeFloatFromBits(uValBig, bitWidth) {
  if (bitWidth === 32) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, Number(uValBig & 0xffffffffn), true);
    const f = dv.getFloat32(0, true);
    return Number.isFinite(f) ? Number(f.toPrecision(7)).toString() : String(f);
  }
  if (bitWidth === 64) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigUint64(0, uValBig, true);
    const d = dv.getFloat64(0, true);
    return Number.isFinite(d) ? Number(d.toPrecision(10)).toString() : String(d);
  }
  if (bitWidth === 16) {
    const h = Number(uValBig & 0xffffn);
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return ((s ? -1 : 1) * Math.pow(2, -14) * (f / 1024)).toPrecision(4);
    if (e === 0x1f) return f ? 'NaN' : s ? '-Infinity' : 'Infinity';
    return ((s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024)).toPrecision(5);
  }
  return null;
}

function decodeAsciiFromBits(uValBig, bitWidth, endian) {
  const byteCount = Math.ceil(bitWidth / 8);
  const chars = [];
  for (let i = 0; i < byteCount; i++) {
    const b = Number((uValBig >> BigInt(i * 8)) & 0xffn);
    chars.push(b >= 32 && b <= 126 ? String.fromCharCode(b) : '.');
  }
  if (endian === 'big') chars.reverse();
  return `"${chars.join('')}"`;
}

function computeFieldRepresentations(uValBig, bf, endian) {
  const width = bf.msb - bf.lsb + 1;
  const hexStr = '0x' + uValBig.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0');
  const uintStr = uValBig.toString(10);
  const sValBig = toSignedBigInt(uValBig, width);
  const intStr = sValBig.toString(10);
  const binStr = '0b' + uValBig.toString(2).padStart(width, '0');
  const fltRaw = decodeFloatFromBits(uValBig, width);

  let enumName = null;
  if (bf.enums && Object.prototype.hasOwnProperty.call(bf.enums, Number(uValBig))) {
    enumName = bf.enums[Number(uValBig)];
  }

  let engineeredStr = null;
  const unitSuffix = bf.unit ? ` ${bf.unit}` : '';
  if (bf.type === 'float' && fltRaw !== null) engineeredStr = `${fltRaw}${unitSuffix}`;

  if (!engineeredStr && bf.qFormat) {
    const m = bf.qFormat.match(/^(U?)Q(\d+)\.(\d+)$/i);
    if (m) {
      const rawNum = m[1].toUpperCase() === 'U' ? Number(uValBig) : Number(sValBig);
      engineeredStr = `${Number((rawNum / Math.pow(2, parseInt(m[3], 10))).toFixed(6))} (${bf.qFormat}${unitSuffix})`;
    }
  }

  if (!engineeredStr && bf.scale !== null && bf.scale !== undefined) {
    const baseNum = bf.type === 'int' ? Number(sValBig) : Number(uValBig);
    engineeredStr = `${Number((baseNum * Number(bf.scale) + Number(bf.valueOffset || 0)).toFixed(4))}${unitSuffix}`;
  }

  if (!engineeredStr && bf.type === 'ascii') engineeredStr = decodeAsciiFromBits(uValBig, width, endian);
  if (!engineeredStr && bf.unit && bf.scale === null) {
    engineeredStr = `${bf.type === 'int' ? intStr : uintStr}${unitSuffix}`;
  }

  return {hexStr, uintStr, intStr, binStr, fltRaw, enumName, engineeredStr};
}

function decodeEntryFieldValue(byteArr, field, endian) {
  const size = field.size || 4;
  if (field.type === 'ascii') {
    const slice = byteArr.slice(field.offset, field.offset + size);
    return {
      hex: '0x' + slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''),
      decoded: '"' + slice.map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('') + '"'
    };
  }
  if (size <= 8) {
    const valBig = readWordBigInt(byteArr, field.offset, size, endian);
    const rep = computeFieldRepresentations(valBig, {...field, msb: size * 8 - 1, lsb: 0}, endian);
    const primary = rep.enumName || rep.engineeredStr ||
        (field.type === 'int'      ? rep.intStr :
             field.type === 'uint' ? rep.uintStr :
                                     rep.hexStr);
    return {hex: rep.hexStr, decoded: primary};
  }
  const slice = byteArr.slice(field.offset, field.offset + Math.min(size, 8));
  return {
    hex: slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') + (size > 8 ? ' ...' : ''),
    decoded: `${size} bytes`
  };
}

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

window.Binsight = {
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
  jumpToHex,
  getUiState,
  patchUiState,
  restoreSelectOption,
  copyWithFeedback,
  readWordBigInt,
  extractBitfield,
  replaceBitfield,
  computeFieldRepresentations,
  decodeEntryFieldValue,
  populateModeSchemaSelect,
  populateVariantFilterSelect,
  bindEditSchemaButton,
  updatePagination,
  initSplitResizer,
  renderRuleHitsBox,
  updateAnomalyBar,
  findNextAnomalyMatch,
  modes: {}
};
})();
