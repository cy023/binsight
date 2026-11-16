(function () {
  const vscode = acquireVsCodeApi();
  const report = window.__BINSIGHT_DATA__;
  const schemas = (report.schemas || []).slice();
  const discoveredLayouts = (report.layouts || []).slice();

  const defaultSchema = schemas[0] || {
    id: 'empty',
    name: 'EMPTY',
    endianness: 'little',
    baseAddress: 0,
    byteSpan: 16,
    groups: [],
    registers: []
  };

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
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  function switchTab(targetId) {
    tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === targetId));
    tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === targetId));
  }
  tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

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

    return { hexStr, uintStr, intStr, binStr, fltRaw, enumName, engineeredStr };
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
      const rep = computeFieldRepresentations(valBig, { ...field, msb: size * 8 - 1, lsb: 0 }, endian);
      const primary =
        rep.enumName ||
        rep.engineeredStr ||
        (field.type === 'int' ? rep.intStr : field.type === 'uint' ? rep.uintStr : rep.hexStr);
      return { hex: rep.hexStr, decoded: primary };
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
    selectEl.innerHTML = pool
      .map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === targetId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
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
    let dragging = false;
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
      resizer.parentElement.style.setProperty(cssVarName, `${Math.max(minPx, Math.min(maxPx, Math.round(rawWidth)))}px`);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
    });
  }

  function renderRuleHitsBox(ruleHits) {
    if (!Array.isArray(ruleHits) || ruleHits.length === 0) return '';
    const items = ruleHits
      .map((h) => `<div class="rule-hit sev-${escapeHtml(h.severity)}"><strong>[${escapeHtml(h.severity.toUpperCase())}]</strong> ${escapeHtml(h.name)}: ${escapeHtml(h.message)}</div>`)
      .join('');
    return `<div class="rule-hits-box">${items}</div>`;
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
    modes: {}
  };
})();
