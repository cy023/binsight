(function(B) {
const {vscode, report, parseAddressInput, toHex, getUiState, patchUiState, copyWithFeedback, escapeHtml, setTabDirty} = B;
let currentHexChunk = report.hexChunk;
let currentBaselineBytes = null;
let rowWidth = 16;
let pageSize = report.hexChunk.pageSize || 4096;
let selectedIdx = 0;
let selectedRangeLen = 1;
let pendingHexSelection = null;
let dragAnchorIdx = null;
let hexEditMode = false;
let hexInputMode = 'hex';
const hexEdits = new Map();
let pendingHighNibble = null;
let syncTimer = null;
let diffSummary = null;

function updateHexDiffBar() {
  const bar = document.getElementById('hex-diff-bar');
  const badge = document.getElementById('hex-diff-badge');
  const prevBtn = document.getElementById('hex-prev-diff');
  const nextBtn = document.getElementById('hex-next-diff');
  if (!bar || !badge) return;
  if (!diffSummary) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const n = diffSummary.totalDiffBytes || 0;
  const rCount = (diffSummary.regions || []).length;
  badge.textContent = n === 0 ? '0 B diff' : `${n.toLocaleString()} B diff (${rCount}${diffSummary.truncated ? '+' : ''})`;
  badge.classList.toggle('anomaly-err', n > 0);
  if (prevBtn) prevBtn.disabled = rCount === 0;
  if (nextBtn) nextBtn.disabled = rCount === 0;
}

function jumpToHexDiff(dir) {
  const regions = diffSummary?.regions || [];
  if (regions.length === 0) return;
  const curAbs = (currentHexChunk.offset || 0) + Math.max(0, selectedIdx);
  let target = null;
  if (dir > 0) {
    target = regions.find((r) => r.offset > curAbs) || regions[0];
  } else {
    for (let i = regions.length - 1; i >= 0; i--) {
      if (regions[i].offset < curAbs) {
        target = regions[i];
        break;
      }
    }
    if (!target) target = regions[regions.length - 1];
  }
  if (target) {
    jumpTo(target.offset, Math.max(1, target.length));
  }
}

document.getElementById('hex-prev-diff')?.addEventListener('click', () => jumpToHexDiff(-1));
document.getElementById('hex-next-diff')?.addEventListener('click', () => jumpToHexDiff(1));

function buildHexPatches() {
  return Array.from(hexEdits.entries()).sort((a, b) => a[0] - b[0]).map(([offset, val]) => ({
                                                                          startOffset: offset,
                                                                          bytes: [val]
                                                                        }));
}

function scheduleWorkingCopySync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (hexEdits.size === 0) {
      vscode.postMessage({type: 'revertWorkingCopy'});
    } else {
      vscode.postMessage({type: 'applyWorkingPatches', patches: buildHexPatches()});
    }
  }, 120);
}

function parseClipboardBytes(rawText, mode) {
  if (!rawText) return [];
  if (mode === 'text') {
    const out = [];
    for (let i = 0; i < rawText.length; i++) {
      out.push(rawText.charCodeAt(i) & 0xff);
    }
    return out;
  }
  const cleaned = String(rawText).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length < 2) return [];
  const even = cleaned.length % 2 === 1 ? '0' + cleaned : cleaned;
  const out = [];
  for (let i = 0; i < even.length; i += 2) {
    out.push(parseInt(even.slice(i, i + 2), 16) & 0xff);
  }
  return out;
}

function getEffectiveByte(idx) {
  const baseOffset = currentHexChunk.offset || 0;
  const absOffset = baseOffset + idx;
  if (hexEdits.has(absOffset)) return hexEdits.get(absOffset);
  return (currentHexChunk.bytes || [])[idx];
}

function updateHexEditControls() {
  const hasEdits = hexEdits.size > 0;
  document.getElementById('hex-input-mode')?.classList.toggle('hidden', !hexEditMode);
  document.getElementById('hex-revert-btn')?.classList.toggle('hidden', !hexEditMode || !hasEdits);
  document.getElementById('hex-save-btn')?.classList.toggle('hidden', !hexEditMode || !hasEdits);
  setTabDirty?.('tab-hex', hasEdits);
}

// Paged Hex Viewer, Data Inspector & File Hashes
function renderHexColumnHeader() {
  const hdrEl = document.getElementById('hex-col-header');
  if (!hdrEl) return;
  let html = '';
  for (let j = 0; j < rowWidth; j++) {
    html += `<span class="hb-hdr">${j.toString(16).toUpperCase().padStart(2, '0')}</span> `;
    if ((j + 1) % 8 === 0 && j + 1 < rowWidth) html += ' ';
  }
  hdrEl.innerHTML = html;
}

function renderHexChunk() {
  renderHexColumnHeader();
  const container = document.getElementById('hex-rows');
  const bytes = currentHexChunk.bytes || [];
  const baseOffset = currentHexChunk.offset || 0;
  const totalSize = report.fileSize || bytes.length;

  const endOffset = Math.max(0, baseOffset + bytes.length - 1);
  document.getElementById('page-indicator').textContent = bytes.length > 0 ?
      `0x${baseOffset.toString(16).toUpperCase().padStart(8, '0')} .. 0x${
          endOffset.toString(16).toUpperCase().padStart(8, '0')}` :
      'EMPTY (0 B)';

  document.getElementById('btn-prev-page').disabled = baseOffset <= 0;
  document.getElementById('btn-next-page').disabled = baseOffset + bytes.length >= totalSize;

  if (bytes.length === 0) {
    container.innerHTML = `
        <div class="empty-state-box">
          <p>No binary data available in this offset range.</p>
          <button id="btn-hex-reset-zero" class="btn">Reset to 0x00000000</button>
        </div>`;
    document.getElementById('btn-hex-reset-zero')?.addEventListener('click', () => requestHexOffset(0));
    return;
  }

  const rowsHtml = [];
  for (let i = 0; i < bytes.length; i += rowWidth) {
    const rowOffset = (baseOffset + i).toString(16).toUpperCase().padStart(8, '0');
    let hexPart = '';
    let asciiPart = '';

    for (let j = 0; j < rowWidth; j++) {
      const idx = i + j;
      if (idx < bytes.length) {
        const absOff = baseOffset + idx;
        const b = getEffectiveByte(idx);
        const isMod = hexEdits.has(absOff);
        const isDiff = currentBaselineBytes &&
            (idx < currentBaselineBytes.length ? b !== currentBaselineBytes[idx] : true);
        const cls = `${isMod ? ' modified' : ''}${isDiff ? ' diff-baseline' : ''}`;
        const hexStr = b.toString(16).toUpperCase().padStart(2, '0');
        const ch = b >= 32 && b <= 126 ? escapeHtml(String.fromCharCode(b)) : '.';
        let diffTitle = '';
        if (isDiff) {
          if (idx < currentBaselineBytes.length) {
            const baseB = currentBaselineBytes[idx];
            const baseHex = baseB.toString(16).toUpperCase().padStart(2, '0');
            const baseCh = baseB >= 32 && baseB <= 126 ? escapeHtml(String.fromCharCode(baseB)) : '.';
            diffTitle = ` title="Baseline: 0x${baseHex} ('${baseCh}') → Current: 0x${hexStr}"`;
          } else {
            diffTitle = ` title="Past Baseline EOF → Current: 0x${hexStr}"`;
          }
        }
        hexPart += `<span class="hb${cls}" data-idx="${idx}"${diffTitle}>${hexStr}</span> `;
        asciiPart += `<span class="ab${cls}" data-idx="${idx}"${diffTitle}>${ch}</span>`;
      } else {
        hexPart += '   ';
        asciiPart += ' ';
      }
      if ((j + 1) % 8 === 0 && j + 1 < rowWidth) hexPart += ' ';
    }

    rowsHtml.push(`<div class="hex-row"><span class="hex-offset">${rowOffset}</span><span class="hex-bytes">${
        hexPart}</span><span class="hex-ascii">${asciiPart}</span></div>`);
  }

  container.innerHTML = rowsHtml.join('');
  if (pendingHexSelection && pendingHexSelection.offset >= baseOffset &&
      pendingHexSelection.offset < baseOffset + bytes.length) {
    const targetIdx = pendingHexSelection.offset - baseOffset;
    const targetLen = pendingHexSelection.length || 1;
    pendingHexSelection = null;
    selectHexByte(targetIdx, targetLen, true);
  } else {
    pendingHexSelection = null;
    selectHexByte(0);
  }
}

function selectHexByte(idx, rangeLen = 1, scrollIntoView = false) {
  const bytes = currentHexChunk.bytes || [];
  if (idx < 0 || idx >= bytes.length) return;
  selectedIdx = idx;
  selectedRangeLen = Math.max(1, Math.min(rangeLen, bytes.length - idx));

  const container = document.getElementById('hex-rows');
  container.querySelectorAll('.hb.active, .ab.active, .hb.in-range, .ab.in-range').forEach((el) => {
    el.classList.remove('active', 'in-range');
  });
  const endIdx = Math.min(bytes.length, idx + selectedRangeLen);
  for (let k = idx; k < endIdx; k++) {
    const cls = k === idx ? 'active' : 'in-range';
    container.querySelectorAll(`[data-idx="${k}"]`).forEach((el) => el.classList.add(cls));
  }
  if (scrollIntoView) {
    container.querySelector(`.hb[data-idx="${idx}"]`)?.scrollIntoView({block: 'nearest'});
  }
}

document.getElementById('btn-copy-hex-range')?.addEventListener('click', (e) => {
  const bytes = currentHexChunk.bytes || [];
  const end = Math.min(bytes.length, selectedIdx + selectedRangeLen);
  const slice = [];
  for (let k = selectedIdx; k < end; k++) slice.push(getEffectiveByte(k));
  const hexText = slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  copyWithFeedback(hexText, e.currentTarget);
});

document.getElementById('hex-edit-mode')?.addEventListener('change', (e) => {
  hexEditMode = e.target.checked;
  pendingHighNibble = null;
  updateHexEditControls();
});

document.getElementById('hex-input-mode')?.addEventListener('change', (e) => {
  hexInputMode = e.target.value === 'text' ? 'text' : 'hex';
  pendingHighNibble = null;
});

document.getElementById('hex-revert-btn')?.addEventListener('click', () => {
  hexEdits.clear();
  pendingHighNibble = null;
  updateHexEditControls();
  renderHexChunk();
  vscode.postMessage({type: 'revertWorkingCopy'});
});

document.getElementById('hex-save-btn')?.addEventListener('click', () => {
  if (hexEdits.size === 0) return;
  vscode.postMessage({type: 'savePatchedBinaryAsNew', patches: buildHexPatches()});
});

const hexRowsEl = document.getElementById('hex-rows');
hexRowsEl?.addEventListener('mousedown', (e) => {
  const target = e.target.closest('[data-idx]');
  if (!target) return;
  if (target.classList.contains('ab')) {
    hexInputMode = 'text';
  } else if (target.classList.contains('hb')) {
    hexInputMode = 'hex';
  }
  const inputModeEl = document.getElementById('hex-input-mode');
  if (inputModeEl) inputModeEl.value = hexInputMode;
  pendingHighNibble = null;

  const idx = Number(target.dataset.idx);
  if (e.shiftKey) {
    const start = Math.min(selectedIdx, idx);
    const len = Math.abs(idx - selectedIdx) + 1;
    selectHexByte(start, len);
  } else {
    dragAnchorIdx = idx;
    selectHexByte(idx, 1);
  }
});

document.addEventListener('paste', (e) => {
  if (B.getActiveTabId?.() !== 'tab-hex') return;
  const activeEl = document.activeElement;
  if (activeEl &&
      (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA' ||
       activeEl.isContentEditable)) {
    return;
  }
  const text = e.clipboardData?.getData('text');
  const pastedBytes = parseClipboardBytes(text, hexInputMode);
  if (pastedBytes.length === 0) return;

  e.preventDefault();
  if (!hexEditMode) {
    hexEditMode = true;
    const chk = document.getElementById('hex-edit-mode');
    if (chk) chk.checked = true;
  }
  pendingHighNibble = null;

  const baseOffset = currentHexChunk.offset || 0;
  const startAbs = baseOffset + Math.max(0, selectedIdx);
  const bytes = currentHexChunk.bytes || [];
  const maxBytes = Math.max(bytes.length, report.fileSize || 0);
  const writeCount = Math.min(pastedBytes.length, Math.max(0, maxBytes - startAbs));
  for (let i = 0; i < writeCount; i++) {
    hexEdits.set(startAbs + i, pastedBytes[i]);
  }
  if (writeCount > 0) {
    updateHexEditControls();
    renderHexChunk();
    selectHexByte(selectedIdx, Math.min(writeCount, bytes.length - selectedIdx), true);
    scheduleWorkingCopySync();
  }
});

hexRowsEl?.addEventListener('mouseover', (e) => {
  if (dragAnchorIdx === null) return;
  const target = e.target.closest('[data-idx]');
  if (!target) return;
  const idx = Number(target.dataset.idx);
  const start = Math.min(dragAnchorIdx, idx);
  const len = Math.abs(idx - dragAnchorIdx) + 1;
  selectHexByte(start, len);
});

window.addEventListener('mouseup', () => {
  dragAnchorIdx = null;
});

function requestHexOffset(offset) {
  const clamped = Math.max(0, Math.min(offset, Math.max(0, report.fileSize - 1)));
  const aligned = Math.floor(clamped / rowWidth) * rowWidth;
  patchUiState({hexOffset: aligned});
  vscode.postMessage({type: 'loadHexPage', offset: aligned, length: pageSize});
}

document.getElementById('hex-row-width')?.addEventListener('change', (e) => {
  const val = Math.max(1, Math.min(128, parseInt(e.target.value, 10) || 16));
  e.target.value = String(val);
  rowWidth = val;
  patchUiState({hexRowWidth: val});
  renderHexChunk();
});

document.getElementById('hex-page-size')?.addEventListener('change', (e) => {
  const val = Math.max(16, Math.min(65536, parseInt(e.target.value, 10) || 4096));
  e.target.value = String(val);
  pageSize = val;
  patchUiState({hexPageSize: val});
  requestHexOffset(currentHexChunk.offset || 0);
});

document.getElementById('btn-prev-page').addEventListener('click', () => {
  requestHexOffset((currentHexChunk.offset || 0) - pageSize);
});

document.getElementById('btn-next-page').addEventListener('click', () => {
  requestHexOffset((currentHexChunk.offset || 0) + pageSize);
});

document.getElementById('btn-jump').addEventListener('click', () => {
  const parsed = parseAddressInput(document.getElementById('jump-input').value, null);
  if (parsed !== null) jumpTo(parsed, 1);
});

document.getElementById('jump-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const parsed = parseAddressInput(e.target.value, null);
    if (parsed !== null) jumpTo(parsed, 1);
  }
});

function triggerHexFind() {
  const query = document.getElementById('hex-find-input')?.value || '';
  const mode = document.getElementById('hex-find-mode')?.value || 'hex';
  if (!query.trim()) return;
  const curAbs = (currentHexChunk.offset || 0) + selectedIdx + 1;
  vscode.postMessage({type: 'findInBinary', query, mode, startOffset: curAbs});
}

document.getElementById('btn-hex-find')?.addEventListener('click', triggerHexFind);
document.getElementById('hex-find-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') triggerHexFind();
});

function renderHashes() {
  const hashBox = document.getElementById('hash-box');
  if (report.hashes.skipped) {
    hashBox.innerHTML = `<p class="hint">${escapeHtml(report.hashes.reason)}</p>`;
  } else {
    const algos = [{label: 'SHA256', val: report.hashes.sha256}, {label: 'MD5', val: report.hashes.md5}];
    hashBox.innerHTML = algos
                            .map((a) => `
        <div class="hash-row">
          <span class="hash-algo">${a.label}</span>
          <code class="hash-val" title="${a.val}">${a.val}</code>
          <button class="btn copy-btn" data-copy="${a.val}">COPY</button>
        </div>`).join('');

    hashBox.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyWithFeedback(btn.dataset.copy, btn);
      });
    });
  }
}

function jumpTo(offset, length = 1) {
  const totalSize = report.fileSize || (currentHexChunk.bytes || []).length;
  if (totalSize <= 0) return;
  const clamped = Math.max(0, Math.min(offset, totalSize - 1));
  const jumpInput = document.getElementById('jump-input');
  if (jumpInput) jumpInput.value = toHex(clamped, 4);

  const baseOffset = currentHexChunk.offset || 0;
  const bytes = currentHexChunk.bytes || [];
  if (clamped >= baseOffset && clamped < baseOffset + bytes.length) {
    selectHexByte(clamped - baseOffset, length, true);
  } else {
    pendingHexSelection = {offset: clamped, length};
    requestHexOffset(clamped);
  }
}

B.modes.hexEditor = {
  init() {
    const ui = getUiState();
    const rowInput = document.getElementById('hex-row-width');
    const savedRowWidth = Number(ui.hexRowWidth);
    if (rowInput && Number.isFinite(savedRowWidth) && savedRowWidth >= 1 && savedRowWidth <= 128) {
      rowWidth = savedRowWidth;
      rowInput.value = String(savedRowWidth);
    }
    const pageInput = document.getElementById('hex-page-size');
    const savedPageSize = Number(ui.hexPageSize);
    let needReload = false;
    if (pageInput && Number.isFinite(savedPageSize) && savedPageSize >= 16 && savedPageSize <= 65536) {
      if (pageSize !== savedPageSize) needReload = true;
      pageSize = savedPageSize;
      pageInput.value = String(savedPageSize);
    }
    renderHashes();
    renderHexChunk();
    if (typeof ui.hexOffset === 'number' && ui.hexOffset !== (currentHexChunk.offset || 0)) {
      requestHexOffset(ui.hexOffset);
    } else if (needReload) {
      requestHexOffset(currentHexChunk.offset || 0);
    }
  },
  jumpTo,
  isTextInputActive() {
    return hexEditMode && hexInputMode === 'text';
  },
  handleKeyDown(e) {
    if (hexEditMode && hexInputMode === 'text' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const bytes = currentHexChunk.bytes || [];
      if (selectedIdx < 0 || selectedIdx >= bytes.length) return;
      const absOffset = (currentHexChunk.offset || 0) + selectedIdx;
      const code = e.key.charCodeAt(0) & 0xff;
      hexEdits.set(absOffset, code);
      updateHexEditControls();
      renderHexChunk();
      scheduleWorkingCopySync();
      const totalSize = report.fileSize || bytes.length;
      jumpTo(Math.min(absOffset + 1, Math.max(0, totalSize - 1)), 1);
      return;
    }
    if (hexEditMode && hexInputMode === 'hex' && /^[0-9a-fA-F]$/.test(e.key) && !e.ctrlKey && !e.metaKey &&
        !e.altKey) {
      e.preventDefault();
      const nib = parseInt(e.key, 16);
      const bytes = currentHexChunk.bytes || [];
      if (selectedIdx < 0 || selectedIdx >= bytes.length) return;
      const absOffset = (currentHexChunk.offset || 0) + selectedIdx;
      if (pendingHighNibble === null) {
        pendingHighNibble = nib;
        const nextVal = (nib << 4) | (getEffectiveByte(selectedIdx) & 0x0f);
        hexEdits.set(absOffset, nextVal);
        updateHexEditControls();
        renderHexChunk();
        selectHexByte(selectedIdx, 1);
        scheduleWorkingCopySync();
      } else {
        const nextVal = (pendingHighNibble << 4) | nib;
        pendingHighNibble = null;
        hexEdits.set(absOffset, nextVal);
        updateHexEditControls();
        renderHexChunk();
        scheduleWorkingCopySync();
        const totalSize = report.fileSize || bytes.length;
        jumpTo(Math.min(absOffset + 1, Math.max(0, totalSize - 1)), 1);
      }
      return;
    }
    if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      document.getElementById('btn-copy-hex-range')?.click();
      return;
    }
    const deltaMap = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -rowWidth, ArrowDown: rowWidth};
    const delta = deltaMap[e.key];
    if (!delta) return;
    e.preventDefault();
    pendingHighNibble = null;
    const absOffset = (currentHexChunk.offset || 0) + selectedIdx;
    const totalSize = report.fileSize || (currentHexChunk.bytes || []).length;
    const nextAbs = Math.max(0, Math.min(absOffset + delta, Math.max(0, totalSize - 1)));
    jumpTo(nextAbs, 1);
  },
  handleMessage(msg) {
    if (msg.type === 'hexPageData' && msg.chunk) {
      currentHexChunk = msg.chunk;
      currentBaselineBytes = Array.isArray(msg.baselineBytes) ? msg.baselineBytes : null;
      renderHexChunk();
      return true;
    }
    if (msg.type === 'findInBinaryResult' && msg.result) {
      if (msg.result.found) {
        jumpTo(msg.result.offset, msg.result.length || 1);
      } else {
        const findBtn = document.getElementById('btn-hex-find');
        if (findBtn) {
          const orig = findBtn.dataset.origLabel || findBtn.textContent;
          findBtn.dataset.origLabel = orig;
          findBtn.textContent = 'Not found';
          clearTimeout(findBtn._nfTimer);
          findBtn._nfTimer = setTimeout(() => {
            findBtn.textContent = orig;
          }, 1200);
        }
      }
      return true;
    }
    if (msg.type === 'workingCopySynced') {
      if (msg.diffSummary !== undefined) {
        diffSummary = msg.diffSummary;
        updateHexDiffBar();
      }
      return false;
    }
    if (msg.type === 'baselineLoaded' || msg.type === 'baselineCleared') {
      if (msg.type === 'baselineCleared') {
        currentBaselineBytes = null;
        diffSummary = null;
      } else {
        diffSummary = msg.diffSummary || null;
      }
      updateHexDiffBar();
      requestHexOffset(currentHexChunk.offset || 0);
      return false;
    }
    return false;
  }
};
})(window.Binsight);
