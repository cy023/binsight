(function (B) {
  const {
    vscode,
    report,
    schemas,
    discoveredLayouts,
    defaultSchema,
    getSchemaById,
    parseAddressInput,
    toHex,
    escapeHtml,
    readWordBigInt,
    extractBitfield,
    replaceBitfield,
    computeFieldRepresentations
  } = B;

  let editMode = false;
  let hideReserved = true;
  let showBitGrid = true;
  let diffFilterMode = 'all';
  let searchFilter = '';
  let baselineFileName = null;
  const CYCLE_FORMATS = ['auto', 'hex', 'uint', 'int', 'bin'];
  const fieldFormatOverrides = {};
  let nextSegCounter = 1;

  let segments =
    Array.isArray(report.initialSegments) && report.initialSegments.length > 0
      ? report.initialSegments.map((hs) => {
          const sch = getSchemaById(hs.schemaId);
          return {
            id: `seg-${nextSegCounter++}`,
            label: hs.label || (sch ? sch.name.replace(/\s*\(.*\)$/, '') : 'SEG_0'),
            startOffset: Number(hs.startOffset) || 0,
            hwBaseAddress:
              hs.hwBaseAddress !== undefined && hs.hwBaseAddress !== null
                ? Number(hs.hwBaseAddress)
                : sch
                ? sch.baseAddress || 0
                : 0,
            schemaId: sch ? sch.id : defaultSchema.id,
            endianness: hs.endianness || (sch ? sch.endianness : 'little'),
            groupFilter: 'all',
            originalBytes: (hs.bytes || []).slice(),
            workingBytes: (hs.bytes || []).slice(),
            baselineBytes: hs.baselineBytes ? hs.baselineBytes.slice() : null,
            collapsed: false
          };
        })
      : [
          {
            id: `seg-${nextSegCounter++}`,
            label: defaultSchema.name.replace(/\s*\(.*\)$/, ''),
            startOffset: 0,
            hwBaseAddress: defaultSchema.baseAddress || 0,
            schemaId: defaultSchema.id,
            endianness: defaultSchema.endianness || 'little',
            groupFilter: 'all',
            originalBytes: [],
            workingBytes: [],
            baselineBytes: null,
            collapsed: false
          }
        ];

  function ensureSegCapacity(seg, minLen) {
    while (seg.workingBytes.length < minLen) seg.workingBytes.push(0);
  }

  function writeWordBigInt(seg, relOffset, size, endian, newValBig) {
    if (!editMode || relOffset < 0) return;
    ensureSegCapacity(seg, relOffset + size);
    const mask = (1n << BigInt(size * 8)) - 1n;
    const clamped = newValBig & mask;
    for (let i = 0; i < size; i++) {
      const byteVal = Number((clamped >> BigInt(i * 8)) & 0xffn);
      const targetIdx = endian === 'big' ? relOffset + (size - 1 - i) : relOffset + i;
      seg.workingBytes[targetIdx] = byteVal;
    }
    updateTopStatusBar();
    renderAllSegments();
  }

  function isSegmentModified(seg) {
    const maxLen = Math.max(seg.originalBytes.length, seg.workingBytes.length);
    for (let i = 0; i < maxLen; i++) {
      if ((seg.originalBytes[i] || 0) !== (seg.workingBytes[i] || 0)) return true;
    }
    return false;
  }

  function updateTopStatusBar() {
    const baseChip = document.getElementById('baseline-chip');
    const clearBaseBtn = document.getElementById('btn-clear-baseline');
    if (baselineFileName) {
      baseChip.textContent = `DIFF: ${baselineFileName}`;
      baseChip.classList.remove('hidden');
      baseChip.classList.add('diff-active');
      clearBaseBtn.classList.remove('hidden');
    } else {
      baseChip.classList.add('hidden');
      clearBaseBtn.classList.add('hidden');
    }

    let modifiedSegCount = 0;
    for (const seg of segments) {
      if (isSegmentModified(seg)) modifiedSegCount++;
    }

    const statusPill = document.getElementById('pill-mode-status');
    const resetBtn = document.getElementById('btn-reset-all');
    const saveBinBtn = document.getElementById('btn-save-as-bin');

    if (!editMode) {
      statusPill.textContent =
        modifiedSegCount > 0 ? `Read-Only (${modifiedSegCount} modified)` : 'Read-Only';
      statusPill.classList.toggle('dirty', modifiedSegCount > 0);
      resetBtn.classList.toggle('hidden', modifiedSegCount === 0);
      saveBinBtn.classList.toggle('hidden', modifiedSegCount === 0);
    } else {
      statusPill.textContent =
        modifiedSegCount > 0 ? `Edit Mode (${modifiedSegCount} modified)` : 'Edit Mode';
      statusPill.classList.add('dirty');
      resetBtn.classList.toggle('hidden', modifiedSegCount === 0);
      saveBinBtn.classList.remove('hidden');
    }
  }

  // 3. Top Toolbar Event Listeners
  const chkEditMode = document.getElementById('chk-edit-mode');
  chkEditMode.addEventListener('change', () => {
    editMode = chkEditMode.checked;
    updateTopStatusBar();
    renderAllSegments();
  });

  const chkHideReserved = document.getElementById('chk-hide-reserved');
  chkHideReserved.addEventListener('change', () => {
    hideReserved = chkHideReserved.checked;
    renderAllSegments();
  });

  const chkShowBitGrid = document.getElementById('chk-show-bitgrid');
  chkShowBitGrid.addEventListener('change', () => {
    showBitGrid = chkShowBitGrid.checked;
    renderAllSegments();
  });

  const diffFilterSelect = document.getElementById('diff-filter-select');
  diffFilterSelect.addEventListener('change', () => {
    diffFilterMode = diffFilterSelect.value;
    renderAllSegments();
  });

  document.getElementById('reg-search').addEventListener('input', (e) => {
    searchFilter = e.target.value.trim().toLowerCase();
    renderAllSegments();
  });

  document.getElementById('btn-add-segment').addEventListener('click', () => {
    const lastSeg = segments[segments.length - 1];
    const lastSchema = lastSeg ? getSchemaById(lastSeg.schemaId) : defaultSchema;
    const suggestedOffset = lastSeg ? lastSeg.startOffset + (lastSchema.byteSpan || 16) : 0;
    const nextSchema = schemas[segments.length % schemas.length] || defaultSchema;

    const newSeg = {
      id: `seg-${nextSegCounter++}`,
      label: `${nextSchema.name.replace(/\s*\(.*\)$/, '')}_${segments.length}`,
      startOffset: suggestedOffset,
      hwBaseAddress: nextSchema.baseAddress || 0,
      schemaId: nextSchema.id,
      endianness: nextSchema.endianness || 'little',
      groupFilter: 'all',
      originalBytes: [],
      workingBytes: [],
      baselineBytes: null,
      collapsed: false
    };
    segments.push(newSeg);
    requestSegmentSlice(newSeg);
    updateTopStatusBar();
    renderAllSegments();
  });

  document.getElementById('btn-compare-baseline').addEventListener('click', () => {
    const reqSegs = segments.map((s) => {
      const sch = getSchemaById(s.schemaId);
      return {
        id: s.id,
        startOffset: s.startOffset,
        byteSpan: sch ? sch.byteSpan : 64
      };
    });
    vscode.postMessage({
      type: 'loadBaselineBin',
      segments: reqSegs
    });
  });

  document.getElementById('btn-clear-baseline').addEventListener('click', () => {
    vscode.postMessage({ type: 'clearBaselineBin' });
  });

  const layoutSelect = document.getElementById('layout-select');
  function populateLayoutSelect() {
    const opts = ['<option value="">-- SELECT PROFILE --</option>'];
    discoveredLayouts.forEach((l, idx) => {
      const isSelected = report.activeLayoutFileName && l.fileName === report.activeLayoutFileName;
      opts.push(
        `<option value="${idx}" ${isSelected ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
      );
    });
    layoutSelect.innerHTML = opts.join('');
  }

  layoutSelect.addEventListener('change', () => {
    const idx = layoutSelect.value;
    if (idx === '') return;
    const chosen = discoveredLayouts[Number(idx)];
    if (chosen && chosen.filePath) {
      vscode.postMessage({
        type: 'applyDiscoveredLayout',
        layoutFilePath: chosen.filePath
      });
    }
  });

  document.getElementById('btn-load-layout-file').addEventListener('click', () => {
    vscode.postMessage({ type: 'loadLayoutProfileFromFile' });
  });

  document.getElementById('btn-save-layout-file').addEventListener('click', () => {
    const segExport = segments.map((s) => {
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
    vscode.postMessage({
      type: 'saveLayoutProfile',
      name: `${report.fileName} Multi-IP Layout`,
      segments: segExport
    });
  });

  document.getElementById('btn-reset-all').addEventListener('click', () => {
    for (const seg of segments) {
      seg.workingBytes = seg.originalBytes.slice();
    }
    updateTopStatusBar();
    renderAllSegments();
  });

  document.getElementById('btn-save-as-bin').addEventListener('click', () => {
    const patches = segments.map((seg) => ({
      label: seg.label,
      startOffset: seg.startOffset,
      bytes: seg.workingBytes
    }));
    vscode.postMessage({
      type: 'savePatchedBinaryAsNew',
      patches
    });
  });

  document.getElementById('btn-export-report').addEventListener('click', () => {
    const lines = [];
    lines.push(`# Binsight Multi-Segment Register Report`);
    lines.push(`# Target File: ${report.filePath} (${report.formattedSize})`);
    if (baselineFileName) {
      lines.push(`# Baseline Diff File: ${baselineFileName}`);
    }
    lines.push('');

    for (const seg of segments) {
      const sch = getSchemaById(seg.schemaId);
      const startHex = '0x' + seg.startOffset.toString(16).toUpperCase().padStart(8, '0');
      const hwBaseHex = '0x' + (seg.hwBaseAddress || 0).toString(16).toUpperCase().padStart(8, '0');
      lines.push(
        `========================================================================================`
      );
      lines.push(
        `[Segment: ${seg.label}]  File Offset: ${startHex} | HW Base: ${hwBaseHex} | Schema: ${sch.name} | Endian: ${seg.endianness.toUpperCase()}`
      );
      lines.push(
        `========================================================================================`
      );

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
          } catch (_) {}
        }

        lines.push(
          `HW ${hwHex} (${fileHex})  ${reg.name.padEnd(20, ' ')} = ${regHex}${diffNote}  // ${
            reg.description || ''
          }`
        );

        for (const bf of reg.fields || []) {
          if (hideReserved && bf.reserved) continue;
          const fValBig = extractBitfield(regValBig, bf.msb, bf.lsb);
          const rep = computeFieldRepresentations(fValBig, bf, seg.endianness);
          const bitRange = `[${bf.msb}:${bf.lsb}]`.padEnd(9, ' ');
          const extra = [rep.enumName, rep.engineeredStr].filter(Boolean).join(' | ');
          lines.push(
            `    ${bitRange} ${bf.name.padEnd(18, ' ')} = ${rep.hexStr} (${rep.uintStr})${
              extra ? ' -> ' + extra : ''
            }  // ${bf.description || ''}`
          );
        }
      }
      lines.push('');
    }

    vscode.postMessage({
      type: 'saveRegisterReport',
      content: lines.join('\n')
    });
  });

  function requestSegmentSlice(seg) {
    const sch = getSchemaById(seg.schemaId);
    vscode.postMessage({
      type: 'readSegmentSlice',
      segmentId: seg.id,
      startOffset: seg.startOffset,
      byteSpan: sch ? sch.byteSpan : 64
    });
  }

  // 4. Render Multi-Segment Navigation Bar & Segment Panels
  function renderSegmentNavBar() {
    const navBar = document.getElementById('segment-nav-bar');
    if (segments.length <= 1) {
      navBar.classList.add('hidden');
      return;
    }
    navBar.classList.remove('hidden');
    navBar.innerHTML = segments
      .map((seg, idx) => {
        const startHex = '0x' + seg.startOffset.toString(16).toUpperCase().padStart(4, '0');
        const dirtyCls = isSegmentModified(seg) ? 'modified' : '';
        return `<button class="seg-nav-pill ${dirtyCls}" data-scroll-seg="${seg.id}">#${idx + 1} ${escapeHtml(
          seg.label
        )} (@${startHex})</button>`;
      })
      .join('');
  }

  document.getElementById('segment-nav-bar').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-scroll-seg]');
    if (pill) {
      const el = document.getElementById(`panel-${pill.dataset.scrollSeg}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  function isRegDifferentFromReset(reg, regValBig) {
    if (reg.resetValue === null || reg.resetValue === undefined) return false;
    try {
      return BigInt(reg.resetValue) !== regValBig;
    } catch (_) {
      return false;
    }
  }

  function renderAllSegments() {
    renderSegmentNavBar();
    const container = document.getElementById('segments-container');

    const htmlParts = segments.map((seg, segIndex) => {
      const schema = getSchemaById(seg.schemaId);
      const segModified = isSegmentModified(seg);
      const startHex = '0x' + seg.startOffset.toString(16).toUpperCase().padStart(4, '0');
      const hwBaseHex = '0x' + (seg.hwBaseAddress || 0).toString(16).toUpperCase().padStart(8, '0');

      const schemaOptionsHtml =
        schemas
          .map(
            (s) =>
              `<option value="${escapeHtml(s.id)}" ${s.id === seg.schemaId ? 'selected' : ''}>${escapeHtml(
                s.name
              )}</option>`
          )
          .join('') + `<option value="__BROWSE_FILE__">+ Load *.binsight.json File...</option>`;

      // Channel / Array filter pills
      let groupFilterHtml = '';
      if (Array.isArray(schema.groups) && schema.groups.length > 0) {
        const pills = [
          `<button class="grp-pill ${seg.groupFilter === 'all' ? 'active' : ''}" data-seg-action="filter-group" data-seg-id="${seg.id}" data-grp="all">All</button>`
        ];
        const hasGlobals = (schema.registers || []).some((r) => r.groupName === null);
        if (hasGlobals) {
          pills.push(
            `<button class="grp-pill ${seg.groupFilter === 'globals' ? 'active' : ''}" data-seg-action="filter-group" data-seg-id="${seg.id}" data-grp="globals">Globals</button>`
          );
        }
        for (const grp of schema.groups) {
          for (let i = 0; i < grp.count; i++) {
            const key = `${grp.name}:${i}`;
            pills.push(
              `<button class="grp-pill ${seg.groupFilter === key ? 'active' : ''}" data-seg-action="filter-group" data-seg-id="${seg.id}" data-grp="${escapeHtml(
                key
              )}">${escapeHtml(grp.name)}[${i}]</button>`
            );
          }
        }
        groupFilterHtml = `<div class="group-filter-bar">${pills.join('')}</div>`;
      }

      const filteredRegs = (schema.registers || []).filter((reg) => {
        if (seg.groupFilter && seg.groupFilter !== 'all') {
          if (seg.groupFilter === 'globals') {
            if (reg.groupName !== null) return false;
          } else {
            const [gName, gIdxStr] = seg.groupFilter.split(':');
            if (reg.groupName !== gName || reg.groupIndex !== Number(gIdxStr)) return false;
          }
        }

        const regValBig = readWordBigInt(seg.workingBytes, reg.offset, reg.size, seg.endianness);
        const diffReset = isRegDifferentFromReset(reg, regValBig);
        const hasBase = Array.isArray(seg.baselineBytes);
        const baseValBig = hasBase
          ? readWordBigInt(seg.baselineBytes, reg.offset, reg.size, seg.endianness)
          : regValBig;
        const diffBase = hasBase && baseValBig !== regValBig;

        if (diffFilterMode === 'non-reset' && !diffReset) return false;
        if (diffFilterMode === 'diff-baseline' && !diffBase) return false;

        if (!searchFilter) return true;
        const hwAddrHex =
          '0x' + ((seg.hwBaseAddress || 0) + reg.offset).toString(16).toLowerCase();
        if (hwAddrHex.includes(searchFilter)) return true;
        if (seg.label.toLowerCase().includes(searchFilter)) return true;
        if (reg.name.toLowerCase().includes(searchFilter)) return true;
        if ((reg.description || '').toLowerCase().includes(searchFilter)) return true;
        return (reg.fields || []).some(
          (bf) =>
            bf.name.toLowerCase().includes(searchFilter) ||
            (bf.description || '').toLowerCase().includes(searchFilter)
        );
      });

      const regsHtml =
        filteredRegs.length === 0
          ? `<p class="hint">No registers match the current filter.</p>`
          : filteredRegs.map((reg) => renderRegisterCard(seg, schema, reg)).join('');

      return `
        <div class="segment-panel ${segModified ? 'modified' : ''}" id="panel-${seg.id}" data-seg-id="${seg.id}">
          <div class="segment-header">
            <div class="cmd-group">
              <button class="btn" data-seg-action="toggle-collapse" data-seg-id="${seg.id}" title="Collapse / Expand Segment">
                ${seg.collapsed ? '▶' : '▼'}
              </button>
              <input type="text"
                     class="seg-inline-input"
                     value="${escapeHtml(seg.label)}"
                     data-seg-action="edit-label"
                     data-seg-id="${seg.id}"
                     title="Click to rename segment label" />

              <div class="addr-box" title="Starting byte offset in the .bin file">
                <span>Offset:</span>
                <input type="text"
                       value="${startHex}"
                       data-seg-action="edit-offset"
                       data-seg-id="${seg.id}" />
              </div>

              <div class="addr-box hw-box" title="Hardware Physical Base Address">
                <span>HW Base:</span>
                <input type="text"
                       value="${hwBaseHex}"
                       data-seg-action="edit-hw-base"
                       data-seg-id="${seg.id}" />
              </div>
            </div>

            <div class="cmd-group">
              <select data-seg-action="change-schema" data-seg-id="${seg.id}" style="max-width:220px;" title="Select IP Schema (*.binsight.json)">
                ${schemaOptionsHtml}
              </select>
              <select data-seg-action="change-endian" data-seg-id="${seg.id}" title="Byte Endianness">
                <option value="little" ${seg.endianness === 'little' ? 'selected' : ''}>LE</option>
                <option value="big" ${seg.endianness === 'big' ? 'selected' : ''}>BE</option>
              </select>
              <button class="btn" data-seg-action="open-schema-editor" data-seg-id="${seg.id}" title="Open *.binsight.json in VS Code Editor (auto-reloads on save)">Edit JSON</button>
              <button class="btn" data-seg-action="duplicate-seg" data-seg-id="${seg.id}" title="Clone this IP segment at the next offset">Clone</button>
              ${
                segments.length > 1
                  ? `<button class="btn btn-alert" data-seg-action="remove-seg" data-seg-id="${seg.id}" title="Remove Segment">✕</button>`
                  : ''
              }
            </div>
          </div>

          <div class="segment-body ${seg.collapsed ? 'collapsed' : ''}">
            ${groupFilterHtml}
            ${regsHtml}
          </div>
        </div>`;
    });

    container.innerHTML = htmlParts.join('');
  }

  function renderRegisterCard(seg, schema, reg) {
    const absFileOffset = seg.startOffset + reg.offset;
    const hwAddress = (seg.hwBaseAddress || 0) + reg.offset;
    const totalBits = reg.size * 8;
    const regValBig = readWordBigInt(seg.workingBytes, reg.offset, reg.size, seg.endianness);
    const origValBig = readWordBigInt(seg.originalBytes, reg.offset, reg.size, seg.endianness);
    const isModified = regValBig !== origValBig;
    const outOfBounds = absFileOffset + reg.size > report.fileSize;

    const hasBaseline = Array.isArray(seg.baselineBytes);
    const baseRegValBig = hasBaseline
      ? readWordBigInt(seg.baselineBytes, reg.offset, reg.size, seg.endianness)
      : regValBig;
    const isDiffBaseline = hasBaseline && baseRegValBig !== regValBig;
    const isDiffReset = isRegDifferentFromReset(reg, regValBig);

    const hexStr = '0x' + regValBig.toString(16).toUpperCase().padStart(reg.size * 2, '0');
    const baseHexStr = '0x' + baseRegValBig.toString(16).toUpperCase().padStart(reg.size * 2, '0');

    const hwAddrStr = '0x' + hwAddress.toString(16).toUpperCase().padStart(8, '0');
    const absOffsetStr = '@0x' + absFileOffset.toString(16).toUpperCase().padStart(4, '0');
    const relOffsetStr = '+0x' + reg.offset.toString(16).toUpperCase().padStart(2, '0');

    // Hardware Logic Analyzer Bit-Ruler
    let bitGridHtml = '';
    if (showBitGrid) {
      const bitToFieldIdx = new Array(totalBits).fill(-1);
      const bitIsRsvd = new Array(totalBits).fill(false);
      (reg.fields || []).forEach((bf, bfIdx) => {
        for (let b = bf.lsb; b <= bf.msb && b < totalBits; b++) {
          bitToFieldIdx[b] = bfIdx;
          if (bf.reserved) bitIsRsvd[b] = true;
        }
      });

      const colsPerRow = Math.min(totalBits, 32);
      const bitRowsHtml = [];
      for (let rowStart = totalBits - 1; rowStart >= 0; rowStart -= colsPerRow) {
        const rowEnd = Math.max(0, rowStart - colsPerRow + 1);
        let cellsHtml = '';
        for (let bit = rowStart; bit >= rowEnd; bit--) {
          const bitVal = Number((regValBig >> BigInt(bit)) & 1n);
          const fIdx = bitToFieldIdx[bit];
          const isRsvd = bitIsRsvd[bit];
          const colorCls = !isRsvd && fIdx >= 0 ? `bf-color-${fIdx % 6}` : '';
          const rsvdCls = isRsvd ? 'rsvd-bit' : '';
          const sepCls = bit > rowEnd && bit % 8 === 0 ? 'byte-sep' : '';
          const bfObj = fIdx >= 0 ? reg.fields[fIdx] : null;
          const titleTip = bfObj
            ? `Bit ${bit}: ${bfObj.name} [${bfObj.msb}:${bfObj.lsb}] = ${bitVal}`
            : `Bit ${bit} = ${bitVal}`;

          cellsHtml += `
            <div class="bit-cell val-${bitVal} ${rsvdCls} ${sepCls} ${editMode ? 'editable' : ''}"
                 data-reg-action="toggle-bit"
                 data-seg-id="${seg.id}"
                 data-rel-offset="${reg.offset}"
                 data-size="${reg.size}"
                 data-bit="${bit}"
                 title="${escapeHtml(titleTip)}">
              <span class="bit-idx">${bit}</span>
              <span class="bit-val">${bitVal}</span>
            </div>`;
        }
        bitRowsHtml.push(`<div class="bit-row" style="--bit-cols:${colsPerRow}">${cellsHtml}</div>`);
      }
      bitGridHtml = `<div class="bit-grid-wrapper">${bitRowsHtml.join('')}</div>`;
    }

    const visibleFields = (reg.fields || []).filter((bf) => !(hideReserved && bf.reserved));

    const bfRowsHtml = visibleFields
      .map((bf, bfIdx) => {
        const fValBig = extractBitfield(regValBig, bf.msb, bf.lsb);
        const fValNum = Number(fValBig);
        const rep = computeFieldRepresentations(fValBig, bf, seg.endianness);
        const bitLabel = bf.msb === bf.lsb ? `[${bf.msb}]` : `[${bf.msb}:${bf.lsb}]`;

        const overrideKey = `${seg.id}:${reg.offset}:${bf.msb}:${bf.lsb}`;
        const activeFmt = fieldFormatOverrides[overrideKey] || 'auto';

        let rawPillText = rep.hexStr;
        if (activeFmt === 'uint') {
          rawPillText = `${rep.uintStr}d`;
        } else if (activeFmt === 'int') {
          rawPillText = `${rep.intStr}s`;
        } else if (activeFmt === 'bin') {
          rawPillText = rep.binStr;
        } else if (activeFmt === 'hex') {
          rawPillText = rep.hexStr;
        } else {
          if (bf.type === 'int') {
            rawPillText = `${rep.intStr} (${rep.hexStr})`;
          } else if (bf.type === 'uint' && !rep.engineeredStr && !rep.enumName) {
            rawPillText = `${rep.uintStr} (${rep.hexStr})`;
          } else {
            rawPillText = rep.hexStr;
          }
        }

        const badges = [];
        if (rep.enumName !== null) {
          badges.push(`<span class="enum-badge">${escapeHtml(rep.enumName)}</span>`);
        }
        if (rep.engineeredStr !== null) {
          badges.push(`<span class="scaled-badge">${escapeHtml(rep.engineeredStr)}</span>`);
        }
        if (hasBaseline) {
          const baseFValBig = extractBitfield(baseRegValBig, bf.msb, bf.lsb);
          if (baseFValBig !== fValBig) {
            const bHex = '0x' + baseFValBig.toString(16).toUpperCase();
            badges.push(`<span class="diff-badge">${bHex}→${rep.hexStr}</span>`);
          }
        }

        let valueColHtml = '';
        if (!editMode) {
          valueColHtml = `
            ${badges.join('')}
            <span class="raw-val-pill"
                  data-reg-action="cycle-field-fmt"
                  data-fmt-key="${escapeHtml(overrideKey)}"
                  title="Click to cycle format (AUTO -> HEX -> UINT -> SINT -> BIN)">
              ${escapeHtml(rawPillText)}
            </span>`;
        } else {
          let enumSelectHtml = '';
          if (bf.enums && Object.keys(bf.enums).length > 0) {
            const enumKeys = Object.keys(bf.enums);
            const hasCurrent = Object.prototype.hasOwnProperty.call(bf.enums, fValNum);
            const opts = enumKeys
              .map((k) => {
                const kNum = Number(k);
                return `<option value="${kNum}" ${kNum === fValNum ? 'selected' : ''}>${escapeHtml(
                  bf.enums[k]
                )} (${kNum})</option>`;
              })
              .join('');
            const undefOpt = !hasCurrent
              ? `<option value="${fValNum}" selected>${rep.hexStr} (RAW)</option>`
              : '';
            enumSelectHtml = `
              <select class="bf-enum-select"
                      data-reg-action="edit-bitfield"
                      data-seg-id="${seg.id}"
                      data-rel-offset="${reg.offset}"
                      data-size="${reg.size}"
                      data-msb="${bf.msb}"
                      data-lsb="${bf.lsb}">
                ${undefOpt}
                ${opts}
              </select>`;
          }
          valueColHtml = `
            <div class="cmd-group">
              ${enumSelectHtml}
              <input type="text"
                     class="bf-val-input"
                     value="${bf.type === 'int' ? rep.intStr : rep.hexStr}"
                     data-reg-action="edit-bitfield"
                     data-seg-id="${seg.id}"
                     data-rel-offset="${reg.offset}"
                     data-size="${reg.size}"
                     data-msb="${bf.msb}"
                     data-lsb="${bf.lsb}"
                     title="Enter Hex (0x...), Unsigned, or Negative Signed integer" />
              ${rep.engineeredStr ? `<span class="scaled-badge">${escapeHtml(rep.engineeredStr)}</span>` : ''}
            </div>`;
        }

        return `
          <tr>
            <td class="bf-bits-col">${bitLabel}</td>
            <td class="bf-name-col">${escapeHtml(bf.name)}</td>
            <td class="bf-val-col">${valueColHtml}</td>
            <td><span class="reg-desc">${escapeHtml(bf.description || '')}</span></td>
          </tr>`;
      })
      .join('');

    const rawRegControlHtml = editMode
      ? `<input type="text"
                class="reg-hex-input"
                value="${hexStr}"
                data-reg-action="edit-reg-word"
                data-seg-id="${seg.id}"
                data-rel-offset="${reg.offset}"
                data-size="${reg.size}"
                title="Edit full ${reg.size * 8}-bit register value" />`
      : `<span class="reg-word-display" data-copy-hex="${hexStr}" title="Click to copy ${hexStr}">${hexStr}</span>`;

    return `
      <div class="reg-card ${isModified ? 'modified' : ''} ${isDiffBaseline ? 'diff-baseline' : ''}">
        <div class="reg-header">
          <div class="reg-title-group">
            <span class="hw-addr-pill" data-jump-file-offset="${absFileOffset}" title="Jump to File Offset ${absOffsetStr} in Hex Dump">
              ${hwAddrStr}
            </span>
            <span class="file-off-sub">${absOffsetStr} (${relOffsetStr})</span>
            <span class="reg-name">${escapeHtml(reg.name)}</span>
            <span class="reg-access-tag">${escapeHtml(reg.access || 'RW')}</span>
            <span class="reg-desc">${escapeHtml(reg.description || '')}</span>
          </div>
          <div class="reg-raw-group">
            ${
              isDiffReset
                ? `<span class="reset-diff-badge" title="Differs from Reset (${escapeHtml(
                    reg.resetValue
                  )})">≠ Reset ${escapeHtml(reg.resetValue)}</span>`
                : ''
            }
            ${
              isDiffBaseline
                ? `<span class="diff-badge" title="Differs from Baseline .bin">${baseHexStr} → ${hexStr}</span>`
                : ''
            }
            ${
              outOfBounds
                ? '<span class="diff-badge">Past EOF</span>'
                : ''
            }
            ${rawRegControlHtml}
          </div>
        </div>

        ${bitGridHtml}

        <table class="bf-table">
          <tbody>
            ${bfRowsHtml}
          </tbody>
        </table>
      </div>`;
  }

  // 5. Event Delegation for Segment Controls & Register Editing
  const segsContainer = document.getElementById('segments-container');

  segsContainer.addEventListener('click', (e) => {
    const segBtn = e.target.closest('[data-seg-action]');
    if (segBtn && segBtn.tagName === 'BUTTON') {
      const action = segBtn.dataset.segAction;
      const segId = segBtn.dataset.segId;
      const seg = segments.find((s) => s.id === segId);
      if (!seg) return;

      if (action === 'toggle-collapse') {
        seg.collapsed = !seg.collapsed;
        renderAllSegments();
      } else if (action === 'filter-group') {
        seg.groupFilter = segBtn.dataset.grp || 'all';
        renderAllSegments();
      } else if (action === 'remove-seg') {
        if (segments.length > 1) {
          segments = segments.filter((s) => s.id !== segId);
          updateTopStatusBar();
          renderAllSegments();
        }
      } else if (action === 'duplicate-seg') {
        const sch = getSchemaById(seg.schemaId);
        const span = sch.byteSpan || 16;
        const dup = {
          id: `seg-${nextSegCounter++}`,
          label: `${seg.label}_CLONE`,
          startOffset: seg.startOffset + span,
          hwBaseAddress: (seg.hwBaseAddress || 0) + 0x1000,
          schemaId: seg.schemaId,
          endianness: seg.endianness,
          groupFilter: 'all',
          originalBytes: [],
          workingBytes: [],
          baselineBytes: null,
          collapsed: false
        };
        segments.push(dup);
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
      const cur = fieldFormatOverrides[key] || 'auto';
      const nextIdx = (CYCLE_FORMATS.indexOf(cur) + 1) % CYCLE_FORMATS.length;
      const nextFmt = CYCLE_FORMATS[nextIdx];
      if (nextFmt === 'auto') delete fieldFormatOverrides[key];
      else fieldFormatOverrides[key] = nextFmt;
      renderAllSegments();
      return;
    }

    const copyHexEl = e.target.closest('[data-copy-hex]');
    if (copyHexEl) {
      vscode.postMessage({ type: 'copyText', text: copyHexEl.dataset.copyHex });
      return;
    }

    const jumpBadge = e.target.closest('[data-jump-file-offset]');
    if (jumpBadge) {
      const absOff = Number(jumpBadge.dataset.jumpFileOffset);
      switchTab('tab-hex');
      requestHexOffset(absOff);
      return;
    }

    const bitCell = e.target.closest('[data-reg-action="toggle-bit"]');
    if (bitCell && editMode) {
      const seg = segments.find((s) => s.id === bitCell.dataset.segId);
      if (!seg) return;
      const relOffset = Number(bitCell.dataset.relOffset);
      const size = Number(bitCell.dataset.size);
      const bit = Number(bitCell.dataset.bit);
      const curBig = readWordBigInt(seg.workingBytes, relOffset, size, seg.endianness);
      const toggled = curBig ^ (1n << BigInt(bit));
      writeWordBigInt(seg, relOffset, size, seg.endianness, toggled);
    }
  });

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

  segsContainer.addEventListener('change', (e) => {
    const target = e.target;
    const segAction = target.dataset.segAction;

    if (segAction) {
      const seg = segments.find((s) => s.id === target.dataset.segId);
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
          vscode.postMessage({
            type: 'loadSchemaFromFile',
            targetSegmentId: seg.id
          });
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
    if (!regAction || !editMode) return;

    const seg = segments.find((s) => s.id === target.dataset.segId);
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


  B.modes.registerMap = {
    init() {
      populateLayoutSelect();
      updateTopStatusBar();
      renderAllSegments();
    },
    handleMessage(msg) {
      if (msg.type === 'segmentSliceData' && msg.segmentId !== '__struct_list__') {
        const seg = segments.find((s) => s.id === msg.segmentId);
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
        baselineFileName = msg.baselineFileName;
        for (const item of msg.segmentSlices || []) {
          const seg = segments.find((s) => s.id === item.segmentId);
          if (seg) seg.baselineBytes = (item.baselineBytes || []).slice();
        }
        updateTopStatusBar();
        renderAllSegments();
        return true;
      }
      if (msg.type === 'baselineCleared') {
        baselineFileName = null;
        for (const seg of segments) seg.baselineBytes = null;
        if (diffFilterMode === 'diff-baseline') {
          diffFilterMode = 'all';
          const el = document.getElementById('diff-filter-select');
          if (el) el.value = 'all';
        }
        updateTopStatusBar();
        renderAllSegments();
        return true;
      }
      if (msg.type === 'schemasLoaded' && Array.isArray(msg.schemas)) {
        for (const newSch of msg.schemas) {
          const idx = schemas.findIndex((s) => s.id === newSch.id);
          if (idx >= 0) schemas[idx] = newSch;
          else schemas.unshift(newSch);
        }
        if (msg.targetSegmentId) {
          const seg = segments.find((s) => s.id === msg.targetSegmentId);
          if (seg && msg.schemas[0]) {
            seg.schemaId = msg.schemas[0].id;
            seg.endianness = msg.schemas[0].endianness || seg.endianness;
            seg.hwBaseAddress = msg.schemas[0].baseAddress !== undefined ? msg.schemas[0].baseAddress : seg.hwBaseAddress;
            seg.groupFilter = 'all';
            requestSegmentSlice(seg);
          }
        } else if (msg.hotReloaded) {
          for (const seg of segments) {
            if (msg.schemas.some((s) => s.id === seg.schemaId)) requestSegmentSlice(seg);
          }
        }
        renderAllSegments();
        return true;
      }
      if (msg.type === 'layoutProfileHydrated' && Array.isArray(msg.hydratedSegments)) {
        for (const newSch of msg.extraSchemas || []) {
          const idx = schemas.findIndex((s) => s.id === newSch.id);
          if (idx >= 0) schemas[idx] = newSch;
          else schemas.unshift(newSch);
        }
        segments = msg.hydratedSegments.map((hs) => {
          const sch = getSchemaById(hs.schemaId);
          return {
            id: `seg-${nextSegCounter++}`,
            label: hs.label,
            startOffset: hs.startOffset,
            hwBaseAddress: hs.hwBaseAddress !== undefined && hs.hwBaseAddress !== null ? hs.hwBaseAddress : (sch ? sch.baseAddress || 0 : 0),
            schemaId: sch ? sch.id : defaultSchema.id,
            endianness: hs.endianness || (sch ? sch.endianness : 'little'),
            groupFilter: 'all',
            originalBytes: (hs.bytes || []).slice(),
            workingBytes: (hs.bytes || []).slice(),
            baselineBytes: hs.baselineBytes ? hs.baselineBytes.slice() : null,
            collapsed: false
          };
        });
        updateTopStatusBar();
        renderAllSegments();
        return true;
      }
      return false;
    }
  };
})(window.Binsight);
