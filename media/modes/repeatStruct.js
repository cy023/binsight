(function(B) {
const {
  vscode,
  report,
  getSchemaById,
  parseAddressInput,
  toHex,
  decodeEntryFieldValue,
  populateModeSchemaSelect,
  populateVariantFilterSelect,
  bindEditSchemaButton,
  updatePagination,
  initSplitResizer,
  renderRuleHitsBox,
  updateAnomalyBar,
  findNextAnomalyMatch,
  getUiState,
  patchUiState,
  restoreSelectOption,
  escapeHtml
} = B;

const rsSchemaSelect = document.getElementById('rs-schema-select');
const rsOffsetInput = document.getElementById('rs-offset-input');
const rsTypeFilter = document.getElementById('rs-type-filter');
const rsHideSkipped = document.getElementById('rs-hide-skipped');
const rsAnomaliesOnly = document.getElementById('rs-anomalies-only');
const rsBlockInput = document.getElementById('rs-block-input');
let repeatResult = report.initialRepeatResult || null;
let repeatPage = 0;
let selectedRepeatIdx = -1;
let pendingSelectRepeatIdx = null;

function populateRepeatStructControls() {
  if (!rsSchemaSelect) return;
  populateModeSchemaSelect(rsSchemaSelect, 'repeat-struct');
  populateVariantFilterSelect(rsTypeFilter, rsSchemaSelect?.value, 'All Types');
}

function requestRepeatQuery(pageNum = 0) {
  if (!rsSchemaSelect) return;
  const sch = getSchemaById(rsSchemaSelect.value);
  if (!sch) return;
  repeatPage = Math.max(0, pageNum);
  const startOffset = parseAddressInput(rsOffsetInput?.value, 0);
  const blockStr = rsBlockInput ? rsBlockInput.value.trim() : '';
  const blockIndex = blockStr !== '' ? parseInt(blockStr, 10) : null;

  vscode.postMessage({
    type: 'queryRepeatEntries',
    schema: sch,
    options: {
      startOffset,
      page: repeatPage,
      pageSize: 100,
      typeFilter: rsTypeFilter ? rsTypeFilter.value : 'all',
      hideSkipped: rsHideSkipped ? rsHideSkipped.checked : false,
      anomaliesOnly: rsAnomaliesOnly ? rsAnomaliesOnly.checked : false,
      blockIndex: Number.isNaN(blockIndex) ? null : blockIndex
    }
  });
}

function renderRepeatEntryDetail(ent, sch) {
  const detailWrap = document.getElementById('rs-detail-wrap');
  if (!detailWrap || !ent) return;
  const variant = (sch.variants && sch.variants[ent.typeHex]) || sch.defaultVariant;
  const offHex = toHex(ent.fileOffset, 6);

  const rows = (variant?.fields || [])
                   .map((f) => {
                     const val = decodeEntryFieldValue(ent.bytes, f, sch.endianness);
                     const fAbsOff = ent.fileOffset + (f.offset || 0);
                     return `
          <tr>
            <td class="k" style="width:44%;"><span class="jump-offset-link" data-jump-file-offset="${
                         fAbsOff}" data-jump-length="${f.size || 1}" title="Jump to Hex Dump (@${
                         toHex(fAbsOff, 6)})">+${toHex(f.offset, 2)}</span> <strong>${escapeHtml(f.name)}</strong></td>
            <td class="v">${escapeHtml(val.decoded)} <span style="font-size:10.5px;color:var(--muted);">(${
                         escapeHtml(val.hex)})</span></td>
          </tr>`;
                   })
                   .join('');

  detailWrap.innerHTML = `
      <div class="term-box-hdr" style="display:flex;justify-content:space-between;align-items:center;">
        <span>#${ent.index} ${escapeHtml(ent.variantName)} (<span class="jump-offset-link" data-jump-file-offset="${
      ent.fileOffset}" data-jump-length="${sch.entrySize || 1}" title="Jump to Hex Dump (@${offHex})">@${
      offHex}</span>)</span>
        <button id="rs-close-detail" class="btn" style="padding:1px 6px;" title="Close side panel">✕</button>
      </div>
      ${renderRuleHitsBox(ent.ruleHits)}
      <table class="kv-table">${rows}</table>`;
}

function renderRepeatStructView() {
  const tableWrap = document.getElementById('rs-table-wrap');
  const detailWrap = document.getElementById('rs-detail-wrap');
  const geoBadge = document.getElementById('rs-geometry-badge');
  if (!tableWrap || !rsSchemaSelect) return;

  const sch = getSchemaById(rsSchemaSelect.value);
  if (!repeatResult || sch.mode !== 'repeat-struct') {
    if (geoBadge) geoBadge.textContent = '';
    tableWrap.innerHTML = '<p class="hint">Select a Repeat Struct schema to inspect entries.</p>';
    return;
  }

  if (geoBadge) {
    geoBadge.textContent = sch.blockSize > 0 ? `${sch.blockSize}B blk · ${sch.entrySize}B` : `${sch.entrySize}B`;
    geoBadge.title = sch.blockSize > 0 ? `${sch.blockSize}B Block / ${sch.entrySize}B Entry (${
                                             repeatResult.entriesPerBlock}/blk, ${repeatResult.paddingPerBlock}B pad)` :
                                         `${sch.entrySize}B Entry (Contiguous)`;
  }

  updatePagination(
      'rs', repeatResult.page, repeatResult.totalPages,
      `${repeatResult.page + 1} / ${repeatResult.totalPages} (${repeatResult.matchedCount.toLocaleString()})`);

  updateAnomalyBar('rs-anomaly-bar', 'rs-anomaly-badge', repeatResult.anomalyCounts);

  const entries = repeatResult.entries || [];
  const layoutEl = tableWrap.parentElement;
  if (entries.length === 0) {
    tableWrap.innerHTML = `
        <div class="empty-state-box">
          <p>No entries match the current filter or offset.</p>
          <button id="rs-reset-filters" class="btn">Reset Filters</button>
        </div>`;
    document.getElementById('rs-reset-filters')?.addEventListener('click', () => {
      if (rsTypeFilter) rsTypeFilter.value = 'all';
      if (rsBlockInput) rsBlockInput.value = '';
      if (rsHideSkipped) rsHideSkipped.checked = false;
      if (rsAnomaliesOnly) rsAnomaliesOnly.checked = false;
      saveRepeatState();
      requestRepeatQuery(0);
    });
    detailWrap.classList.add('hidden');
    layoutEl?.classList?.add('no-detail');
    return;
  }

  if (selectedRepeatIdx >= entries.length) selectedRepeatIdx = -1;

  const rowsHtml = entries
                       .map((ent, idx) => {
                         const variant = (sch.variants && sch.variants[ent.typeHex]) || sch.defaultVariant;
                         const summaryParts = (variant?.summaryFields || [])
                                                  .map((fn) => {
                                                    const fld = (variant.fields || []).find((f) => f.name === fn);
                                                    if (!fld) return '';
                                                    const val = decodeEntryFieldValue(ent.bytes, fld, sch.endianness);
                                                    return `${fn}=${val.decoded}`;
                                                  })
                                                  .filter(Boolean)
                                                  .join(' · ');

                         const offHex = toHex(ent.fileOffset, 6);
                         const locStr = sch.blockSize > 0 ? `B${ent.blockIndex}:${ent.slotIndex}` : `#${ent.index}`;
                         const selCls = idx === selectedRepeatIdx ? 'selected' : '';
                         const skipCls = ent.skipped ? 'skipped-row' : '';
                         const sevCls = ent.severity ? `sev-${ent.severity}` : '';

                         return `
          <tr class="entry-row ${selCls} ${skipCls} ${sevCls}" data-rs-idx="${idx}">
            <td class="bf-mono">${locStr}</td>
            <td class="bf-mono"><span class="jump-offset-link" data-jump-file-offset="${
                             ent.fileOffset}" data-jump-length="${sch.entrySize || 1}" title="Jump to Hex Dump (@${
                             offHex})">${offHex}</span></td>
            <td class="bf-mono"><span class="enum-badge">${escapeHtml(ent.typeHex)}</span>${
                             escapeHtml(ent.variantName)}</td>
            <td class="bf-mono" style="font-size:11px;color:var(--muted);">${escapeHtml(summaryParts)}</td>
          </tr>`;
                       })
                       .join('');

  tableWrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:68px;">Blk:Slot</th>
            <th style="width:82px;">Offset</th>
            <th style="width:160px;">Type</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;

  if (selectedRepeatIdx >= 0 && entries[selectedRepeatIdx]) {
    detailWrap.classList.remove('hidden');
    layoutEl?.classList?.remove('no-detail');
    renderRepeatEntryDetail(entries[selectedRepeatIdx], sch);
  } else {
    detailWrap.classList.add('hidden');
    layoutEl?.classList?.add('no-detail');
  }
}

function jumpToRepeatAnomaly(dir) {
  const curGlobal =
      selectedRepeatIdx >= 0 ? (repeatResult?.page || 0) * (repeatResult?.pageSize || 100) + selectedRepeatIdx : -1;
  const target = findNextAnomalyMatch(repeatResult?.anomalies, curGlobal, dir);
  if (!target) return;
  const pSize = repeatResult.pageSize || 100;
  const targetPage = Math.floor(target.matchIdx / pSize);
  const idxInPage = target.matchIdx % pSize;
  if (targetPage === (repeatResult.page || 0)) {
    selectedRepeatIdx = idxInPage;
    renderRepeatStructView();
    document.querySelector(`#rs-table-wrap [data-rs-idx="${selectedRepeatIdx}"]`)?.scrollIntoView({block: 'nearest'});
  } else {
    pendingSelectRepeatIdx = idxInPage;
    requestRepeatQuery(targetPage);
  }
}

function saveRepeatState() {
  patchUiState({
    rsSchemaId: rsSchemaSelect?.value,
    rsOffset: rsOffsetInput?.value,
    rsTypeFilter: rsTypeFilter?.value,
    rsHideSkipped: rsHideSkipped?.checked,
    rsAnomaliesOnly: rsAnomaliesOnly?.checked,
    rsBlockInput: rsBlockInput?.value
  });
}

B.modes.repeatStruct = {
  init() {
    document.getElementById('rs-table-wrap')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-jump-file-offset]')) return;
      const row = e.target.closest('[data-rs-idx]');
      if (row && repeatResult) {
        const clicked = Number(row.dataset.rsIdx);
        selectedRepeatIdx = selectedRepeatIdx === clicked ? -1 : clicked;
        renderRepeatStructView();
      }
    });
    document.getElementById('rs-detail-wrap')?.addEventListener('click', (e) => {
      if (e.target.closest('#rs-close-detail')) {
        selectedRepeatIdx = -1;
        renderRepeatStructView();
      }
    });
    rsSchemaSelect?.addEventListener('change', () => {
      populateVariantFilterSelect(rsTypeFilter, rsSchemaSelect?.value, 'All Types');
      saveRepeatState();
      requestRepeatQuery(0);
    });
    rsOffsetInput?.addEventListener('change', () => {
      saveRepeatState();
      requestRepeatQuery(0);
    });
    rsTypeFilter?.addEventListener('change', () => {
      saveRepeatState();
      requestRepeatQuery(0);
    });
    rsHideSkipped?.addEventListener('change', () => {
      saveRepeatState();
      requestRepeatQuery(0);
    });
    rsAnomaliesOnly?.addEventListener('change', () => {
      saveRepeatState();
      requestRepeatQuery(0);
    });
    rsBlockInput?.addEventListener('change', () => {
      saveRepeatState();
      requestRepeatQuery(0);
    });
    document.getElementById('rs-prev-err')?.addEventListener('click', () => jumpToRepeatAnomaly(-1));
    document.getElementById('rs-next-err')?.addEventListener('click', () => jumpToRepeatAnomaly(1));
    document.getElementById('rs-prev-page')?.addEventListener('click', () => requestRepeatQuery(repeatPage - 1));
    document.getElementById('rs-next-page')?.addEventListener('click', () => requestRepeatQuery(repeatPage + 1));
    bindEditSchemaButton('rs-edit-json-btn', rsSchemaSelect, 'repeat_struct');
    initSplitResizer('rs-resizer', '--rs-detail-w', true, 240, 720);
    populateRepeatStructControls();

    const ui = getUiState();
    let needsQuery = false;
    if (restoreSelectOption(rsSchemaSelect, ui.rsSchemaId)) {
      populateVariantFilterSelect(rsTypeFilter, rsSchemaSelect.value, 'All Types');
      needsQuery = true;
    }
    if (ui.rsOffset && rsOffsetInput && rsOffsetInput.value !== ui.rsOffset) {
      rsOffsetInput.value = ui.rsOffset;
      needsQuery = true;
    }
    if (restoreSelectOption(rsTypeFilter, ui.rsTypeFilter)) {
      needsQuery = true;
    }
    if (typeof ui.rsHideSkipped === 'boolean' && rsHideSkipped && rsHideSkipped.checked !== ui.rsHideSkipped) {
      rsHideSkipped.checked = ui.rsHideSkipped;
      needsQuery = true;
    }
    if (typeof ui.rsAnomaliesOnly === 'boolean' && rsAnomaliesOnly && rsAnomaliesOnly.checked !== ui.rsAnomaliesOnly) {
      rsAnomaliesOnly.checked = ui.rsAnomaliesOnly;
      needsQuery = true;
    }
    if (typeof ui.rsBlockInput === 'string' && rsBlockInput && rsBlockInput.value !== ui.rsBlockInput) {
      rsBlockInput.value = ui.rsBlockInput;
      needsQuery = true;
    }
    renderRepeatStructView();
    if (needsQuery) requestRepeatQuery(0);
  },
  handleKeyDown(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const entries = repeatResult?.entries || [];
    if (entries.length === 0) return;
    e.preventDefault();
    if (selectedRepeatIdx < 0) {
      selectedRepeatIdx = e.key === 'ArrowDown' ? 0 : entries.length - 1;
    } else {
      selectedRepeatIdx =
          Math.max(0, Math.min(entries.length - 1, selectedRepeatIdx + (e.key === 'ArrowDown' ? 1 : -1)));
    }
    renderRepeatStructView();
    document.querySelector(`#rs-table-wrap [data-rs-idx="${selectedRepeatIdx}"]`)?.scrollIntoView({block: 'nearest'});
  },
  handleMessage(msg) {
    if (msg.type === 'repeatEntriesResult' && msg.result) {
      repeatResult = msg.result;
      if (pendingSelectRepeatIdx !== null) {
        selectedRepeatIdx = pendingSelectRepeatIdx;
        pendingSelectRepeatIdx = null;
      }
      renderRepeatStructView();
      if (selectedRepeatIdx >= 0) {
        document.querySelector(`#rs-table-wrap [data-rs-idx="${selectedRepeatIdx}"]`)?.scrollIntoView({
          block: 'nearest'
        });
      }
      return true;
    }
    return false;
  }
};
})(window.Binsight);
