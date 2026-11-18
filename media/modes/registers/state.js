(function(B) {
const {
  vscode,
  report,
  discoveredLayouts,
  defaultSchema,
  getSchemaById,
  escapeHtml,
  readWordBigInt,
  extractBitfield,
  computeFieldRepresentations
} = B;

const CYCLE_FORMATS = ['auto', 'hex', 'uint', 'int', 'bin'];

const state = {
  editMode: false,
  hideReserved: true,
  showBitGrid: true,
  pinnedOnly: false,
  diffFilterMode: 'all',
  searchFilter: '',
  baselineFileName: null,
  pinnedRegs: new Set(),
  fieldFormatOverrides: {},
  nextSegCounter: 1,
  segments: []
};

function makeSegment(overrides = {}) {
  const sch = getSchemaById(overrides.schemaId || defaultSchema.id);
  const id = `seg-${state.nextSegCounter++}`;
  const defaultLabel = sch ? sch.name.replace(/\s*\(.*\)$/, '') : 'SEG_0';
  return {
    id,
    label: overrides.label || defaultLabel,
    startOffset: Number(overrides.startOffset) || 0,
    hwBaseAddress:
        overrides.hwBaseAddress !== undefined && overrides.hwBaseAddress !== null ?
        Number(overrides.hwBaseAddress) :
        (sch ? sch.baseAddress || 0 : 0),
    schemaId: sch ? sch.id : defaultSchema.id,
    endianness: overrides.endianness || (sch ? sch.endianness : 'little'),
    groupFilter: 'all',
    originalBytes: Array.isArray(overrides.bytes) ? overrides.bytes.slice() : [],
    workingBytes: Array.isArray(overrides.bytes) ? overrides.bytes.slice() : [],
    baselineBytes: Array.isArray(overrides.baselineBytes) ? overrides.baselineBytes.slice() : null,
    collapsed: false
  };
}

state.segments = Array.isArray(report.initialSegments) && report.initialSegments.length > 0 ?
    report.initialSegments.map((hs) => makeSegment(hs)) :
    [makeSegment()];

function ensureSegCapacity(seg, minLen) {
  while (seg.workingBytes.length < minLen) seg.workingBytes.push(0);
}

function writeWordBigInt(seg, relOffset, size, endian, newValBig) {
  if (!state.editMode || relOffset < 0) return;
  ensureSegCapacity(seg, relOffset + size);
  const mask = (1n << BigInt(size * 8)) - 1n;
  const clamped = newValBig & mask;
  for (let i = 0; i < size; i++) {
    const byteVal = Number((clamped >> BigInt(i * 8)) & 0xffn);
    const targetIdx = endian === 'big' ? relOffset + (size - 1 - i) : relOffset + i;
    seg.workingBytes[targetIdx] = byteVal;
  }
  updateTopStatusBar();
  B.registersInternal.renderAllSegments();
}

function isSegmentModified(seg) {
  const maxLen = Math.max(seg.originalBytes.length, seg.workingBytes.length);
  for (let i = 0; i < maxLen; i++) {
    if ((seg.originalBytes[i] || 0) !== (seg.workingBytes[i] || 0)) return true;
  }
  return false;
}

function isRegDifferentFromReset(reg, regValBig) {
  if (reg.resetValue === null || reg.resetValue === undefined) return false;
  try {
    return BigInt(reg.resetValue) !== regValBig;
  } catch (_) {
    return false;
  }
}

function parseUserBigIntWithWidth(str, bitWidth) {
  const raw = String(str || '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('-')) {
      const negVal = BigInt(raw);
      const mod = 1n << BigInt(bitWidth);
      return ((negVal % mod) + mod) % mod;
    }
    if (raw.toLowerCase().startsWith('0x') || raw.toLowerCase().startsWith('0b')) {
      return BigInt(raw);
    }
    if (/^[0-9a-fA-F]+$/.test(raw) && /[a-fA-F]/.test(raw)) {
      return BigInt('0x' + raw);
    }
    return BigInt(raw);
  } catch (_) {
    return null;
  }
}

function updateTopStatusBar() {
  const baseChip = document.getElementById('baseline-chip');
  const clearBaseBtn = document.getElementById('btn-clear-baseline');
  if (state.baselineFileName) {
    baseChip.textContent = `DIFF: ${state.baselineFileName}`;
    baseChip.classList.remove('hidden');
    baseChip.classList.add('diff-active');
    clearBaseBtn.classList.remove('hidden');
  } else {
    baseChip.classList.add('hidden');
    clearBaseBtn.classList.add('hidden');
  }

  let modifiedSegCount = 0;
  for (const seg of state.segments) {
    if (isSegmentModified(seg)) modifiedSegCount++;
  }

  const statusPill = document.getElementById('pill-mode-status');
  const resetBtn = document.getElementById('btn-reset-all');
  const saveBinBtn = document.getElementById('btn-save-as-bin');

  if (!state.editMode) {
    statusPill.textContent = modifiedSegCount > 0 ? `${modifiedSegCount} modified` : 'Read-Only';
    statusPill.classList.toggle('dirty', modifiedSegCount > 0);
    statusPill.classList.toggle('hidden', modifiedSegCount === 0);
    resetBtn.classList.toggle('hidden', modifiedSegCount === 0);
    saveBinBtn.classList.toggle('hidden', modifiedSegCount === 0);
  } else {
    statusPill.classList.remove('hidden');
    statusPill.textContent = modifiedSegCount > 0 ? `Edit (${modifiedSegCount} mod)` : 'Edit';
    statusPill.classList.add('dirty');
    resetBtn.classList.toggle('hidden', modifiedSegCount === 0);
    saveBinBtn.classList.remove('hidden');
  }
}

function populateLayoutSelect() {
  const layoutSelect = document.getElementById('layout-select');
  const opts = ['<option value="">-- SELECT PROFILE --</option>'];
  discoveredLayouts.forEach((l, idx) => {
    const isSelected = report.activeLayoutFileName && l.fileName === report.activeLayoutFileName;
    opts.push(`<option value="${idx}" ${isSelected ? 'selected' : ''}>${escapeHtml(l.name)}</option>`);
  });
  layoutSelect.innerHTML = opts.join('');
}

function requestSegmentSlice(seg) {
  const sch = getSchemaById(seg.schemaId);
  vscode.postMessage(
      {type: 'readSegmentSlice', segmentId: seg.id, startOffset: seg.startOffset, byteSpan: sch ? sch.byteSpan : 64});
}

function buildRegisterReport() {
  const lines = [];
  lines.push(`# Binsight Multi-Segment Register Report`);
  lines.push(`# Target File: ${report.filePath} (${report.formattedSize})`);
  if (state.baselineFileName) {
    lines.push(`# Baseline Diff File: ${state.baselineFileName}`);
  }
  lines.push('');

  for (const seg of state.segments) {
    const sch = getSchemaById(seg.schemaId);
    const startHex = '0x' + seg.startOffset.toString(16).toUpperCase().padStart(8, '0');
    const hwBaseHex = '0x' + (seg.hwBaseAddress || 0).toString(16).toUpperCase().padStart(8, '0');
    lines.push(`========================================================================================`);
    lines.push(`[Segment: ${seg.label}]  File Offset: ${startHex} | HW Base: ${hwBaseHex} | Schema: ${
        sch.name} | Endian: ${seg.endianness.toUpperCase()}`);
    lines.push(`========================================================================================`);

    for (const reg of sch.registers || []) {
      const absFileOff = seg.startOffset + reg.offset;
      const hwAddr = (seg.hwBaseAddress || 0) + reg.offset;
      const hwHex = '0x' + hwAddr.toString(16).toUpperCase().padStart(8, '0');
      const fileHex = '@0x' + absFileOff.toString(16).toUpperCase().padStart(4, '0');

      const regValBig = readWordBigInt(seg.workingBytes, reg.offset, reg.size, seg.endianness);
      const regHex = '0x' + regValBig.toString(16).toUpperCase().padStart(reg.size * 2, '0');

      let diffNote = '';
      if (seg.baselineBytes) {
        const baseValBig = readWordBigInt(seg.baselineBytes, reg.offset, reg.size, seg.endianness);
        if (baseValBig !== regValBig) {
          const bHex = '0x' + baseValBig.toString(16).toUpperCase().padStart(reg.size * 2, '0');
          diffNote += ` [DIFF vs Baseline: ${bHex} -> ${regHex}]`;
        }
      }
      if (reg.resetValue !== null) {
        try {
          const rstBig = BigInt(reg.resetValue);
          if (rstBig !== regValBig) diffNote += ` [!= Reset ${reg.resetValue}]`;
        } catch (_) {
        }
      }

      lines.push(
          `HW ${hwHex} (${fileHex})  ${reg.name.padEnd(20, ' ')} = ${regHex}${diffNote}  // ${reg.description || ''}`);

      for (const bf of reg.fields || []) {
        if (state.hideReserved && bf.reserved) continue;
        const fValBig = extractBitfield(regValBig, bf.msb, bf.lsb);
        const rep = computeFieldRepresentations(fValBig, bf, seg.endianness);
        const bitRange = `[${bf.msb}:${bf.lsb}]`.padEnd(9, ' ');
        const extra = [rep.enumName, rep.engineeredStr].filter(Boolean).join(' | ');
        lines.push(`    ${bitRange} ${bf.name.padEnd(18, ' ')} = ${rep.hexStr} (${rep.uintStr})${
            extra ? ' -> ' + extra : ''}  // ${bf.description || ''}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

B.registersInternal = {
  CYCLE_FORMATS,
  state,
  makeSegment,
  writeWordBigInt,
  isSegmentModified,
  isRegDifferentFromReset,
  parseUserBigIntWithWidth,
  updateTopStatusBar,
  populateLayoutSelect,
  requestSegmentSlice,
  buildRegisterReport,
  renderSegmentNavBar() {},
  renderAllSegments() {}
};
})(window.Binsight);
