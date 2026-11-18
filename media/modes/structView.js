(function(B) {
const {
  vscode,
  report,
  getSchemaById,
  parseAddressInput,
  decodeEntryFieldValue,
  populateModeSchemaSelect,
  bindEditSchemaButton,
  getUiState,
  patchUiState,
  restoreSelectOption,
  escapeHtml
} = B;

const slSchemaSelect = document.getElementById('sl-schema-select');
const slOffsetInput = document.getElementById('sl-offset-input');
const slEndianSelect = document.getElementById('sl-endian-select');
const slSearchInput = document.getElementById('sl-search');
let slBytes = (report.initialSegments && report.initialSegments[0]?.bytes) || [];
let slBaselineBytes = null;

function populateStructViewSelect() {
  if (!slSchemaSelect) return;
  populateModeSchemaSelect(slSchemaSelect, 'struct-view');
  const active = getSchemaById(slSchemaSelect.value);
  if (active && slEndianSelect) slEndianSelect.value = active.endianness || 'little';
}

function renderStructView() {
  const container = document.getElementById('sl-container');
  if (!container || !slSchemaSelect) return;
  const schema = getSchemaById(slSchemaSelect.value);
  const endian = slEndianSelect ? slEndianSelect.value : 'little';
  const q = slSearchInput ? slSearchInput.value.trim().toLowerCase() : '';
  const baseOff = parseAddressInput(slOffsetInput?.value, 0);

  const fields = schema.mode === 'struct-view' ?
      schema.fields || [] :
      (schema.registers ||
       []).map((r) => ({name: r.name, offset: r.offset, size: r.size, type: 'hex', description: r.description}));

  const filtered =
      fields.filter((f) => !q || f.name.toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q));

  if (filtered.length === 0) {
    container.innerHTML = '<p class="hint">No struct fields match your filter.</p>';
    return;
  }

  const rowsHtml =
      filtered
          .map((f) => {
            const res = decodeEntryFieldValue(slBytes, f, endian);
            const absOff = baseOff + f.offset;
            const baseRes = slBaselineBytes ? decodeEntryFieldValue(slBaselineBytes, f, endian) : null;
            const isDiff = Boolean(baseRes && baseRes.hex !== res.hex);
            return `
          <tr class="${isDiff ? 'diff-baseline' : ''}">
            <td class="bf-mono" style="color:var(--muted);">+0x${
                f.offset.toString(16).toUpperCase().padStart(
                    2, '0')} <span class="jump-offset-link" data-jump-file-offset="${absOff}" data-jump-length="${
                f.size}" title="Jump to Hex Editor (@0x${absOff.toString(16).toUpperCase().padStart(4, '0')})">@0x${
                absOff.toString(16).toUpperCase().padStart(4, '0')}</span></td>
            <td class="bf-mono">${f.size} B</td>
            <td class="bf-mono"><strong>${escapeHtml(f.name)}</strong></td>
            <td class="bf-mono">${escapeHtml(res.hex)}</td>
            <td class="bf-mono" style="color:var(--accent);font-weight:600;">${escapeHtml(res.decoded)}${
                isDiff ? ` <span class="diff-badge" title="Baseline: ${escapeHtml(baseRes.decoded)}">${
                             escapeHtml(baseRes.hex)} → ${escapeHtml(res.hex)}</span>` :
                         ''}</td>
            <td><span class="reg-desc">${escapeHtml(f.description || '')}</span></td>
          </tr>`;
          })
          .join('');

  container.innerHTML = `
      <div class="term-box-hdr">${escapeHtml(schema.name)} (${schema.byteSpan} Bytes, ${endian.toUpperCase()})</div>
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:130px;">Offset</th>
            <th style="width:55px;">Size</th>
            <th style="width:180px;">Member</th>
            <th style="width:140px;">Raw Hex</th>
            <th style="width:190px;">Decoded Value</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
}

function requestStructViewSlice(syncEndian = false) {
  if (!slSchemaSelect) return;
  const sch = getSchemaById(slSchemaSelect.value);
  if (syncEndian && sch && slEndianSelect) slEndianSelect.value = sch.endianness || 'little';
  vscode.postMessage({
    type: 'readSegmentSlice',
    segmentId: '__struct_view__',
    startOffset: parseAddressInput(slOffsetInput?.value, 0),
    byteSpan: sch ? sch.byteSpan : 64
  });
}

function saveStructViewState() {
  patchUiState({slSchemaId: slSchemaSelect?.value, slOffset: slOffsetInput?.value, slEndian: slEndianSelect?.value});
}

let needsWorkingRefresh = false;

B.modes.structView = {
  init() {
    slSchemaSelect?.addEventListener('change', () => {
      requestStructViewSlice(true);
      saveStructViewState();
    });
    slOffsetInput?.addEventListener('change', () => {
      saveStructViewState();
      requestStructViewSlice(false);
    });
    slEndianSelect?.addEventListener('change', () => {
      saveStructViewState();
      renderStructView();
    });
    slSearchInput?.addEventListener('input', renderStructView);
    bindEditSchemaButton('sl-edit-json-btn', slSchemaSelect, 'struct-view');
    populateStructViewSelect();

    const ui = getUiState();
    let needsReload = restoreSelectOption(slSchemaSelect, ui.slSchemaId);
    if (ui.slOffset && slOffsetInput && slOffsetInput.value !== ui.slOffset) {
      slOffsetInput.value = ui.slOffset;
      needsReload = true;
    }
    restoreSelectOption(slEndianSelect, ui.slEndian);
    renderStructView();
    if (needsReload) requestStructViewSlice(false);
  },
  onActivate() {
    if (needsWorkingRefresh) {
      needsWorkingRefresh = false;
      requestStructViewSlice(false);
    }
  },
  handleMessage(msg) {
    if (msg.type === 'workingCopySynced') {
      needsWorkingRefresh = true;
      if (B.getActiveTabId?.() === 'tab-struct-view') {
        needsWorkingRefresh = false;
        requestStructViewSlice(false);
      }
      return false;
    }
    if (msg.type === 'baselineLoaded') {
      needsWorkingRefresh = true;
      if (B.getActiveTabId?.() === 'tab-struct-view') {
        needsWorkingRefresh = false;
        requestStructViewSlice(false);
      }
      return false;
    }
    if (msg.type === 'baselineCleared') {
      slBaselineBytes = null;
      renderStructView();
      return false;
    }
    if (msg.type === 'segmentSliceData' && msg.segmentId === '__struct_view__') {
      slBytes = (msg.bytes || []).slice();
      slBaselineBytes = Array.isArray(msg.baselineBytes) ? msg.baselineBytes.slice() : null;
      renderStructView();
      return true;
    }
    return false;
  }
};
})(window.Binsight);
