(function(B) {
const {
  report,
  schemas,
  getSchemaById,
  escapeHtml,
  readWordBigInt,
  extractBitfield,
  computeFieldRepresentations,
  registersInternal
} = B;
const {state, isSegmentModified, isRegDifferentFromReset} = registersInternal;

function renderSegmentNavBar() {
  const navBar = document.getElementById('segment-nav-bar');
  if (state.segments.length <= 1) {
    navBar.classList.add('hidden');
    return;
  }
  navBar.classList.remove('hidden');
  navBar.innerHTML = state.segments
                         .map((seg, idx) => {
                           const startHex = '0x' + seg.startOffset.toString(16).toUpperCase().padStart(4, '0');
                           const dirtyCls = isSegmentModified(seg) ? 'modified' : '';
                           return `<button class="seg-nav-pill ${dirtyCls}" data-scroll-seg="${seg.id}">#${idx + 1} ${
                               escapeHtml(seg.label)} (@${startHex})</button>`;
                         })
                         .join('');
}

function renderBitGrid(seg, reg, regValBig) {
  if (!state.showBitGrid) return '';
  const totalBits = reg.size * 8;
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
      const rsvdCls = isRsvd ? 'rsvd-bit' : '';
      const sepCls = bit > rowEnd && bit % 8 === 0 ? 'byte-sep' : '';
      const bfObj = fIdx >= 0 ? reg.fields[fIdx] : null;
      const titleTip =
          bfObj ? `Bit ${bit}: ${bfObj.name} [${bfObj.msb}:${bfObj.lsb}] = ${bitVal}` : `Bit ${bit} = ${bitVal}`;

      cellsHtml += `
            <div class="bit-cell val-${bitVal} ${rsvdCls} ${sepCls} ${state.editMode ? 'editable' : ''}"
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
  return `<div class="bit-grid-wrapper">${bitRowsHtml.join('')}</div>`;
}

function renderBitfieldRow(seg, reg, bf, regValBig, baseRegValBig, hasBaseline) {
  const fValBig = extractBitfield(regValBig, bf.msb, bf.lsb);
  const fValNum = Number(fValBig);
  const rep = computeFieldRepresentations(fValBig, bf, seg.endianness);
  const bitLabel = bf.msb === bf.lsb ? `[${bf.msb}]` : `[${bf.msb}:${bf.lsb}]`;

  const overrideKey = `${seg.id}:${reg.offset}:${bf.msb}:${bf.lsb}`;
  const activeFmt = state.fieldFormatOverrides[overrideKey] || 'auto';

  let rawPillText = rep.hexStr;
  if (activeFmt === 'uint') {
    rawPillText = `${rep.uintStr}d`;
  } else if (activeFmt === 'int') {
    rawPillText = `${rep.intStr}s`;
  } else if (activeFmt === 'bin') {
    rawPillText = rep.binStr;
  } else if (activeFmt === 'hex') {
    rawPillText = rep.hexStr;
  } else if (bf.type === 'int') {
    rawPillText = `${rep.intStr} (${rep.hexStr})`;
  } else if (bf.type === 'uint' && !rep.engineeredStr && !rep.enumName) {
    rawPillText = `${rep.uintStr} (${rep.hexStr})`;
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
  if (!state.editMode) {
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
                         return `<option value="${kNum}" ${kNum === fValNum ? 'selected' : ''}>${
                             escapeHtml(bf.enums[k])} (${kNum})</option>`;
                       })
                       .join('');
      const undefOpt = !hasCurrent ? `<option value="${fValNum}" selected>${rep.hexStr} (RAW)</option>` : '';
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
}

function renderRegisterCard(seg, schema, reg) {
  const absFileOffset = seg.startOffset + reg.offset;
  const hwAddress = (seg.hwBaseAddress || 0) + reg.offset;
  const regValBig = readWordBigInt(seg.workingBytes, reg.offset, reg.size, seg.endianness);
  const origValBig = readWordBigInt(seg.originalBytes, reg.offset, reg.size, seg.endianness);
  const isModified = regValBig !== origValBig;
  const outOfBounds = absFileOffset + reg.size > report.fileSize;

  const hasBaseline = Array.isArray(seg.baselineBytes);
  const baseRegValBig =
      hasBaseline ? readWordBigInt(seg.baselineBytes, reg.offset, reg.size, seg.endianness) : regValBig;
  const isDiffBaseline = hasBaseline && baseRegValBig !== regValBig;
  const isDiffReset = isRegDifferentFromReset(reg, regValBig);

  const hexStr = '0x' + regValBig.toString(16).toUpperCase().padStart(reg.size * 2, '0');
  const baseHexStr = '0x' + baseRegValBig.toString(16).toUpperCase().padStart(reg.size * 2, '0');
  const hwAddrStr = '0x' + hwAddress.toString(16).toUpperCase().padStart(8, '0');
  const absOffsetStr = '@0x' + absFileOffset.toString(16).toUpperCase().padStart(4, '0');
  const relOffsetStr = '+0x' + reg.offset.toString(16).toUpperCase().padStart(2, '0');

  const bitGridHtml = renderBitGrid(seg, reg, regValBig);
  const visibleFields = (reg.fields || []).filter((bf) => !(state.hideReserved && bf.reserved));
  const bfRowsHtml =
      visibleFields.map((bf) => renderBitfieldRow(seg, reg, bf, regValBig, baseRegValBig, hasBaseline)).join('');

  const rawRegControlHtml = state.editMode ?
      `<input type="text"
                class="reg-hex-input"
                value="${hexStr}"
                data-reg-action="edit-reg-word"
                data-seg-id="${seg.id}"
                data-rel-offset="${reg.offset}"
                data-size="${reg.size}"
                title="Edit full ${reg.size * 8}-bit register value" />` :
      `<span class="reg-word-display" data-copy-hex="${hexStr}" title="Click to copy ${hexStr}">${hexStr}</span>`;

  const pinKey = `${schema.id}::${reg.name}`;
  const isPinned = state.pinnedRegs.has(pinKey);

  return `
      <div class="reg-card ${isModified ? 'modified' : ''} ${isDiffBaseline ? 'diff-baseline' : ''} ${
      isPinned ? 'pinned-card' : ''}">
        <div class="reg-header">
          <div class="reg-title-group">
            <button class="btn pin-btn ${isPinned ? 'pinned' : ''}" data-pin-reg="${escapeHtml(pinKey)}" title="${
      isPinned ? 'Unpin register' : 'Pin register to top'}">${isPinned ? 'Pinned' : 'Pin'}</button>
            <span class="hw-addr-pill" data-jump-file-offset="${absFileOffset}" data-jump-length="${
      reg.size}" title="Jump to File Offset ${absOffsetStr} in Hex Editor">
              ${hwAddrStr}
            </span>
            <span class="file-off-sub">${absOffsetStr} (${relOffsetStr})</span>
            <span class="reg-name">${escapeHtml(reg.name)}</span>
            <span class="reg-access-tag">${escapeHtml(reg.access || 'RW')}</span>
            <span class="reg-desc">${escapeHtml(reg.description || '')}</span>
          </div>
          <div class="reg-raw-group">
            ${
      isDiffReset ? `<span class="reset-diff-badge" title="Differs from Reset (${
                        escapeHtml(reg.resetValue)})">≠ Reset ${escapeHtml(reg.resetValue)}</span>` :
                    ''}
            ${
      isDiffBaseline ? `<span class="diff-badge" title="Differs from Baseline">${baseHexStr} → ${hexStr}</span>` :
                       ''}
            ${outOfBounds ? '<span class="diff-badge">Past EOF</span>' : ''}
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

function renderAllSegments() {
  renderSegmentNavBar();
  const container = document.getElementById('segments-container');

  const htmlParts = state.segments.map((seg) => {
    const schema = getSchemaById(seg.schemaId);
    const segModified = isSegmentModified(seg);
    const startHex = '0x' + seg.startOffset.toString(16).toUpperCase().padStart(4, '0');
    const hwBaseHex = '0x' + (seg.hwBaseAddress || 0).toString(16).toUpperCase().padStart(8, '0');

    const schemaOptionsHtml = schemas
                                  .map(
                                      (s) => `<option value="${escapeHtml(s.id)}" ${
                                          s.id === seg.schemaId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
                                  .join('') +
        `<option value="__BROWSE_FILE__">+ Load *.binsight.json File...</option>`;

    let groupFilterHtml = '';
    if (Array.isArray(schema.groups) && schema.groups.length > 0) {
      const pills = [`<button class="grp-pill ${
          seg.groupFilter === 'all' ?
              'active' :
              ''}" data-seg-action="filter-group" data-seg-id="${seg.id}" data-grp="all">All</button>`];
      const hasGlobals = (schema.registers || []).some((r) => r.groupName === null);
      if (hasGlobals) {
        pills.push(`<button class="grp-pill ${
            seg.groupFilter === 'globals' ?
                'active' :
                ''}" data-seg-action="filter-group" data-seg-id="${seg.id}" data-grp="globals">Globals</button>`);
      }
      for (const grp of schema.groups) {
        for (let i = 0; i < grp.count; i++) {
          const key = `${grp.name}:${i}`;
          pills.push(`<button class="grp-pill ${
              seg.groupFilter === key ? 'active' : ''}" data-seg-action="filter-group" data-seg-id="${
              seg.id}" data-grp="${escapeHtml(key)}">${escapeHtml(grp.name)}[${i}]</button>`);
        }
      }
      groupFilterHtml = `<div class="group-filter-bar">${pills.join('')}</div>`;
    }

    const getPinKey = (reg) => `${schema.id}::${reg.name}`;
    const filteredRegs = (schema.registers || []).filter((reg) => {
      if (state.pinnedOnly && !state.pinnedRegs.has(getPinKey(reg))) return false;
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
      const baseValBig = hasBase ? readWordBigInt(seg.baselineBytes, reg.offset, reg.size, seg.endianness) : regValBig;
      const diffBase = hasBase && baseValBig !== regValBig;

      if (state.diffFilterMode === 'non-reset' && !diffReset) return false;
      if (state.diffFilterMode === 'diff-baseline' && !diffBase) return false;

      if (!state.searchFilter) return true;
      const hwAddrHex = '0x' + ((seg.hwBaseAddress || 0) + reg.offset).toString(16).toLowerCase();
      if (hwAddrHex.includes(state.searchFilter)) return true;
      if (seg.label.toLowerCase().includes(state.searchFilter)) return true;
      if (reg.name.toLowerCase().includes(state.searchFilter)) return true;
      if ((reg.description || '').toLowerCase().includes(state.searchFilter)) return true;
      return (reg.fields || [])
          .some(
              (bf) => bf.name.toLowerCase().includes(state.searchFilter) ||
                  (bf.description || '').toLowerCase().includes(state.searchFilter));
    });

    filteredRegs.sort((a, b) => {
      const pa = state.pinnedRegs.has(getPinKey(a)) ? 1 : 0;
      const pb = state.pinnedRegs.has(getPinKey(b)) ? 1 : 0;
      return pb - pa;
    });

    const regsHtml = filteredRegs.length === 0 ?
        `<p class="hint">No registers match the current filter.</p>` :
        filteredRegs.map((reg) => renderRegisterCard(seg, schema, reg)).join('');

    return `
        <div class="segment-panel ${segModified ? 'modified' : ''}" id="panel-${seg.id}" data-seg-id="${seg.id}">
          <div class="segment-header">
            <div class="cmd-group">
              <button class="btn" data-seg-action="toggle-collapse" data-seg-id="${
        seg.id}" title="Collapse / Expand Segment">
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
              <select data-seg-action="change-schema" data-seg-id="${
        seg.id}" title="Select IP Schema (*.binsight.json)">
                ${schemaOptionsHtml}
              </select>
              <select data-seg-action="change-endian" data-seg-id="${seg.id}" title="Byte Endianness">
                <option value="little" ${seg.endianness === 'little' ? 'selected' : ''}>LE</option>
                <option value="big" ${seg.endianness === 'big' ? 'selected' : ''}>BE</option>
              </select>
              <button class="btn" data-seg-action="open-schema-editor" data-seg-id="${
        seg.id}" title="Open *.binsight.json in VS Code Editor (auto-reloads on save)">Edit JSON</button>
              <button class="btn" data-seg-action="duplicate-seg" data-seg-id="${
        seg.id}" title="Clone this IP segment at the next offset">Clone</button>
              ${
        state.segments.length > 1 ? `<button class="btn btn-alert" data-seg-action="remove-seg" data-seg-id="${
                                        seg.id}" title="Remove Segment">✕</button>` :
                                    ''}
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

registersInternal.renderSegmentNavBar = renderSegmentNavBar;
registersInternal.renderAllSegments = renderAllSegments;
})(window.Binsight);
