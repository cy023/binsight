(function(B) {
const {
  vscode,
  report,
  schemas,
  discoveredLayouts,
  defaultSchema,
  getSchemaById,
  parseAddressInput,
  readWordBigInt,
  replaceBitfield,
  getUiState,
  patchUiState,
  restoreSelectOption,
  registersInternal
} = B;
const {
  CYCLE_FORMATS,
  state,
  makeSegment,
  writeWordBigInt,
  parseUserBigIntWithWidth,
  updateTopStatusBar,
  populateLayoutSelect,
  requestSegmentSlice,
  buildRegisterReport,
  renderSegmentNavBar,
  renderAllSegments
} = registersInternal;

const chkEditMode = document.getElementById('chk-edit-mode');
const chkHideReserved = document.getElementById('chk-hide-reserved');
const chkShowBitGrid = document.getElementById('chk-show-bitgrid');
const chkPinnedOnly = document.getElementById('chk-pinned-only');
const diffFilterSelect = document.getElementById('diff-filter-select');
const regSearchInput = document.getElementById('reg-search');
const layoutSelect = document.getElementById('layout-select');
const segsContainer = document.getElementById('segments-container');

function bindToolbarEvents() {
  chkEditMode.addEventListener('change', () => {
    state.editMode = chkEditMode.checked;
    updateTopStatusBar();
    renderAllSegments();
  });

  chkHideReserved.addEventListener('change', () => {
    state.hideReserved = chkHideReserved.checked;
    patchUiState({regHideReserved: state.hideReserved});
    renderAllSegments();
  });

  chkShowBitGrid.addEventListener('change', () => {
    state.showBitGrid = chkShowBitGrid.checked;
    patchUiState({regShowBitGrid: state.showBitGrid});
    renderAllSegments();
  });

  chkPinnedOnly?.addEventListener('change', () => {
    state.pinnedOnly = chkPinnedOnly.checked;
    patchUiState({regPinnedOnly: state.pinnedOnly});
    renderAllSegments();
  });

  diffFilterSelect.addEventListener('change', () => {
    state.diffFilterMode = diffFilterSelect.value;
    patchUiState({regDiffFilter: state.diffFilterMode});
    renderAllSegments();
  });

  regSearchInput.addEventListener('input', (e) => {
    state.searchFilter = e.target.value.trim().toLowerCase();
    patchUiState({regSearch: e.target.value});
    renderAllSegments();
  });

  document.getElementById('btn-add-segment').addEventListener('click', () => {
    const lastSeg = state.segments[state.segments.length - 1];
    const lastSchema = lastSeg ? getSchemaById(lastSeg.schemaId) : defaultSchema;
    const suggestedOffset = lastSeg ? lastSeg.startOffset + (lastSchema.byteSpan || 16) : 0;
    const nextSchema = schemas[state.segments.length % schemas.length] || defaultSchema;

    const newSeg = makeSegment({
      label: `${nextSchema.name.replace(/\s*\(.*\)$/, '')}_${state.segments.length}`,
      startOffset: suggestedOffset,
      hwBaseAddress: nextSchema.baseAddress || 0,
      schemaId: nextSchema.id,
      endianness: nextSchema.endianness || 'little'
    });
    state.segments.push(newSeg);
    requestSegmentSlice(newSeg);
    updateTopStatusBar();
    renderAllSegments();
  });

  document.getElementById('btn-compare-baseline').addEventListener('click', () => {
    const reqSegs = state.segments.map((s) => {
      const sch = getSchemaById(s.schemaId);
      return {id: s.id, startOffset: s.startOffset, byteSpan: sch ? sch.byteSpan : 64};
    });
    vscode.postMessage({type: 'loadBaselineBin', segments: reqSegs});
  });

  document.getElementById('btn-clear-baseline').addEventListener('click', () => {
    vscode.postMessage({type: 'clearBaselineBin'});
  });

  layoutSelect.addEventListener('change', () => {
    const idx = layoutSelect.value;
    if (idx === '') return;
    const chosen = discoveredLayouts[Number(idx)];
    if (chosen && chosen.filePath) {
      vscode.postMessage({type: 'applyDiscoveredLayout', layoutFilePath: chosen.filePath});
    }
  });

  document.getElementById('btn-load-layout-file').addEventListener('click', () => {
    vscode.postMessage({type: 'loadLayoutProfileFromFile'});
  });

  document.getElementById('btn-save-layout-file').addEventListener('click', () => {
    const segExport = state.segments.map((s) => {
      const sch = getSchemaById(s.schemaId);
      return {
        label: s.label,
        startOffset: s.startOffset,
        hwBaseAddress: s.hwBaseAddress,
        schemaId: s.schemaId,
        schemaFilePath: sch ? sch.filePath : null,
        endianness: s.endianness
      };
    });
    vscode.postMessage({type: 'saveLayoutProfile', name: `${report.fileName} Multi-IP Layout`, segments: segExport});
  });

  document.getElementById('btn-reset-all').addEventListener('click', () => {
    for (const seg of state.segments) {
      seg.workingBytes = seg.originalBytes.slice();
    }
    updateTopStatusBar();
    renderAllSegments();
  });

  document.getElementById('btn-save-as-bin').addEventListener('click', () => {
    const patches =
        state.segments.map((seg) => ({label: seg.label, startOffset: seg.startOffset, bytes: seg.workingBytes}));
    vscode.postMessage({type: 'savePatchedBinaryAsNew', patches});
  });

  document.getElementById('btn-export-report').addEventListener('click', () => {
    vscode.postMessage({type: 'saveRegisterReport', content: buildRegisterReport()});
  });

  document.getElementById('segment-nav-bar').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-scroll-seg]');
    if (pill) {
      const el = document.getElementById(`panel-${pill.dataset.scrollSeg}`);
      if (el) el.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  });
}

function bindSegmentDelegation() {
  segsContainer.addEventListener('click', (e) => {
    const segBtn = e.target.closest('[data-seg-action]');
    if (segBtn && segBtn.tagName === 'BUTTON') {
      const action = segBtn.dataset.segAction;
      const segId = segBtn.dataset.segId;
      const seg = state.segments.find((s) => s.id === segId);
      if (!seg) return;

      if (action === 'toggle-collapse') {
        seg.collapsed = !seg.collapsed;
        renderAllSegments();
      } else if (action === 'filter-group') {
        seg.groupFilter = segBtn.dataset.grp || 'all';
        renderAllSegments();
      } else if (action === 'remove-seg') {
        if (state.segments.length > 1) {
          state.segments = state.segments.filter((s) => s.id !== segId);
          updateTopStatusBar();
          renderAllSegments();
        }
      } else if (action === 'duplicate-seg') {
        const sch = getSchemaById(seg.schemaId);
        const span = sch.byteSpan || 16;
        const dup = makeSegment({
          label: `${seg.label}_CLONE`,
          startOffset: seg.startOffset + span,
          hwBaseAddress: (seg.hwBaseAddress || 0) + 0x1000,
          schemaId: seg.schemaId,
          endianness: seg.endianness
        });
        state.segments.push(dup);
        requestSegmentSlice(dup);
        updateTopStatusBar();
        renderAllSegments();
      } else if (action === 'open-schema-editor') {
        const sch = getSchemaById(seg.schemaId);
        vscode.postMessage({
          type: 'openSchemaInEditor',
          targetSegmentId: seg.id,
          schemaFilePath: sch ? sch.filePath : null,
          schemaName: sch ? sch.name.replace(/\s*\(.*\)$/, '') : 'custom_ip',
          sourceText: sch ? sch.sourceText : '{}'
        });
      }
      return;
    }

    const cyclePill = e.target.closest('[data-reg-action="cycle-field-fmt"]');
    if (cyclePill) {
      const key = cyclePill.dataset.fmtKey;
      const cur = state.fieldFormatOverrides[key] || 'auto';
      const nextIdx = (CYCLE_FORMATS.indexOf(cur) + 1) % CYCLE_FORMATS.length;
      const nextFmt = CYCLE_FORMATS[nextIdx];
      if (nextFmt === 'auto')
        delete state.fieldFormatOverrides[key];
      else
        state.fieldFormatOverrides[key] = nextFmt;
      renderAllSegments();
      return;
    }

    const copyHexEl = e.target.closest('[data-copy-hex]');
    if (copyHexEl) {
      vscode.postMessage({type: 'copyText', text: copyHexEl.dataset.copyHex});
      return;
    }

    const pinBtn = e.target.closest('[data-pin-reg]');
    if (pinBtn) {
      const key = pinBtn.dataset.pinReg;
      if (state.pinnedRegs.has(key))
        state.pinnedRegs.delete(key);
      else
        state.pinnedRegs.add(key);
      patchUiState({regPinned: Array.from(state.pinnedRegs)});
      renderAllSegments();
      return;
    }

    const bitCell = e.target.closest('[data-reg-action="toggle-bit"]');
    if (bitCell && state.editMode) {
      const seg = state.segments.find((s) => s.id === bitCell.dataset.segId);
      if (!seg) return;
      const relOffset = Number(bitCell.dataset.relOffset);
      const size = Number(bitCell.dataset.size);
      const bit = Number(bitCell.dataset.bit);
      const curBig = readWordBigInt(seg.workingBytes, relOffset, size, seg.endianness);
      const toggled = curBig ^ (1n << BigInt(bit));
      writeWordBigInt(seg, relOffset, size, seg.endianness, toggled);
    }
  });

  segsContainer.addEventListener('change', (e) => {
    const target = e.target;
    const segAction = target.dataset.segAction;

    if (segAction) {
      const seg = state.segments.find((s) => s.id === target.dataset.segId);
      if (!seg) return;

      if (segAction === 'edit-label') {
        seg.label = target.value.trim() || seg.label;
        renderSegmentNavBar();
      } else if (segAction === 'edit-offset') {
        seg.startOffset = parseAddressInput(target.value, 0);
        requestSegmentSlice(seg);
      } else if (segAction === 'edit-hw-base') {
        seg.hwBaseAddress = parseAddressInput(target.value, 0);
        renderAllSegments();
      } else if (segAction === 'change-schema') {
        if (target.value === '__BROWSE_FILE__') {
          target.value = seg.schemaId;
          vscode.postMessage({type: 'loadSchemaFromFile', targetSegmentId: seg.id});
          return;
        }
        seg.schemaId = target.value;
        const sch = getSchemaById(seg.schemaId);
        seg.endianness = sch.endianness || seg.endianness;
        seg.hwBaseAddress = sch.baseAddress !== undefined ? sch.baseAddress : seg.hwBaseAddress;
        seg.groupFilter = 'all';
        requestSegmentSlice(seg);
      } else if (segAction === 'change-endian') {
        seg.endianness = target.value;
        renderAllSegments();
      }
      return;
    }

    const regAction = target.dataset.regAction;
    if (!regAction || !state.editMode) return;

    const seg = state.segments.find((s) => s.id === target.dataset.segId);
    if (!seg) return;
    const relOffset = Number(target.dataset.relOffset);
    const size = Number(target.dataset.size);

    if (regAction === 'edit-bitfield') {
      const msb = Number(target.dataset.msb);
      const lsb = Number(target.dataset.lsb);
      const width = msb - lsb + 1;
      const parsedVal = parseUserBigIntWithWidth(target.value, width);
      if (parsedVal === null) {
        renderAllSegments();
        return;
      }
      const curRegBig = readWordBigInt(seg.workingBytes, relOffset, size, seg.endianness);
      const updatedBig = replaceBitfield(curRegBig, msb, lsb, parsedVal);
      writeWordBigInt(seg, relOffset, size, seg.endianness, updatedBig);
    } else if (regAction === 'edit-reg-word') {
      const parsedVal = parseUserBigIntWithWidth(target.value, size * 8);
      if (parsedVal === null) {
        renderAllSegments();
        return;
      }
      writeWordBigInt(seg, relOffset, size, seg.endianness, parsedVal);
    }
  });
}

bindToolbarEvents();
bindSegmentDelegation();

let needsWorkingRefresh = false;

B.modes.registers = {
  init() {
    const ui = getUiState();
    if (typeof ui.regHideReserved === 'boolean') {
      state.hideReserved = ui.regHideReserved;
      chkHideReserved.checked = state.hideReserved;
    }
    if (typeof ui.regShowBitGrid === 'boolean') {
      state.showBitGrid = ui.regShowBitGrid;
      chkShowBitGrid.checked = state.showBitGrid;
    }
    if (typeof ui.regPinnedOnly === 'boolean' && chkPinnedOnly) {
      state.pinnedOnly = ui.regPinnedOnly;
      chkPinnedOnly.checked = state.pinnedOnly;
    }
    if (Array.isArray(ui.regPinned)) {
      ui.regPinned.forEach((k) => state.pinnedRegs.add(k));
    }
    if (restoreSelectOption(diffFilterSelect, ui.regDiffFilter)) {
      state.diffFilterMode = diffFilterSelect.value;
    }
    if (typeof ui.regSearch === 'string') {
      regSearchInput.value = ui.regSearch;
      state.searchFilter = ui.regSearch.trim().toLowerCase();
    }
    populateLayoutSelect();
    updateTopStatusBar();
    renderAllSegments();
  },
  onActivate() {
    if (needsWorkingRefresh) {
      needsWorkingRefresh = false;
      state.segments.forEach((seg) => requestSegmentSlice(seg));
    }
  },
  handleMessage(msg) {
    if (msg.type === 'workingCopySynced') {
      needsWorkingRefresh = true;
      if (B.getActiveTabId?.() === 'tab-registers') {
        needsWorkingRefresh = false;
        state.segments.forEach((seg) => requestSegmentSlice(seg));
      }
      return false;
    }
    if (msg.type === 'segmentSliceData' && msg.segmentId !== '__struct_view__') {
      const seg = state.segments.find((s) => s.id === msg.segmentId);
      if (seg) {
        seg.originalBytes = (msg.bytes || []).slice();
        seg.workingBytes = (msg.bytes || []).slice();
        if (msg.baselineBytes) seg.baselineBytes = msg.baselineBytes.slice();
        updateTopStatusBar();
        renderAllSegments();
      }
      return true;
    }
    if (msg.type === 'baselineLoaded') {
      state.baselineFileName = msg.baselineFileName;
      for (const item of msg.segmentSlices || []) {
        const seg = state.segments.find((s) => s.id === item.segmentId);
        if (seg) seg.baselineBytes = (item.baselineBytes || []).slice();
      }
      updateTopStatusBar();
      renderAllSegments();
      return true;
    }
    if (msg.type === 'baselineCleared') {
      state.baselineFileName = null;
      for (const seg of state.segments) seg.baselineBytes = null;
      if (state.diffFilterMode === 'diff-baseline') {
        state.diffFilterMode = 'all';
        diffFilterSelect.value = 'all';
      }
      updateTopStatusBar();
      renderAllSegments();
      return true;
    }
    if (msg.type === 'schemasLoaded' && Array.isArray(msg.schemas)) {
      for (const newSch of msg.schemas) {
        const idx = schemas.findIndex((s) => s.id === newSch.id);
        if (idx >= 0)
          schemas[idx] = newSch;
        else
          schemas.unshift(newSch);
      }
      if (msg.targetSegmentId) {
        const seg = state.segments.find((s) => s.id === msg.targetSegmentId);
        if (seg && msg.schemas[0]) {
          seg.schemaId = msg.schemas[0].id;
          seg.endianness = msg.schemas[0].endianness || seg.endianness;
          seg.hwBaseAddress = msg.schemas[0].baseAddress !== undefined ? msg.schemas[0].baseAddress : seg.hwBaseAddress;
          seg.groupFilter = 'all';
          requestSegmentSlice(seg);
        }
      } else if (msg.hotReloaded) {
        for (const seg of state.segments) {
          if (msg.schemas.some((s) => s.id === seg.schemaId)) requestSegmentSlice(seg);
        }
      }
      renderAllSegments();
      return true;
    }
    if (msg.type === 'layoutProfileHydrated' && Array.isArray(msg.hydratedSegments)) {
      for (const newSch of msg.extraSchemas || []) {
        const idx = schemas.findIndex((s) => s.id === newSch.id);
        if (idx >= 0)
          schemas[idx] = newSch;
        else
          schemas.unshift(newSch);
      }
      state.segments = msg.hydratedSegments.map((hs) => makeSegment(hs));
      updateTopStatusBar();
      renderAllSegments();
      return true;
    }
    return false;
  }
};
})(window.Binsight);
