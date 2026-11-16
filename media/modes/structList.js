(function (B) {
  const {
    vscode,
    report,
    getSchemaById,
    parseAddressInput,
    decodeEntryFieldValue,
    populateModeSchemaSelect,
    bindEditSchemaButton,
    escapeHtml
  } = B;

  const slSchemaSelect = document.getElementById('sl-schema-select');
  const slOffsetInput = document.getElementById('sl-offset-input');
  const slEndianSelect = document.getElementById('sl-endian-select');
  const slSearchInput = document.getElementById('sl-search');
  let slBytes = (report.initialSegments && report.initialSegments[0]?.bytes) || [];

  function populateStructListSelect() {
    if (!slSchemaSelect) return;
    populateModeSchemaSelect(slSchemaSelect, 'struct-list');
    const active = getSchemaById(slSchemaSelect.value);
    if (active && slEndianSelect) slEndianSelect.value = active.endianness || 'little';
  }

  function renderStructListView() {
    const container = document.getElementById('sl-container');
    if (!container || !slSchemaSelect) return;
    const schema = getSchemaById(slSchemaSelect.value);
    const endian = slEndianSelect ? slEndianSelect.value : 'little';
    const q = slSearchInput ? slSearchInput.value.trim().toLowerCase() : '';
    const baseOff = parseAddressInput(slOffsetInput?.value, 0);

    const fields =
      schema.mode === 'struct-list'
        ? schema.fields || []
        : (schema.registers || []).map((r) => ({
            name: r.name,
            offset: r.offset,
            size: r.size,
            type: 'hex',
            description: r.description
          }));

    const filtered = fields.filter(
      (f) => !q || f.name.toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q)
    );

    if (filtered.length === 0) {
      container.innerHTML = '<p class="hint">No struct fields match your filter.</p>';
      return;
    }

    const rowsHtml = filtered
      .map((f) => {
        const res = decodeEntryFieldValue(slBytes, f, endian);
        const absOff = baseOff + f.offset;
        return `
          <tr>
            <td class="bf-mono" style="color:var(--muted);">+0x${f.offset
              .toString(16)
              .toUpperCase()
              .padStart(2, '0')} <span style="opacity:0.65;">(@0x${absOff
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')})</span></td>
            <td class="bf-mono">${f.size} B</td>
            <td class="bf-mono"><strong>${escapeHtml(f.name)}</strong></td>
            <td class="bf-mono">${escapeHtml(res.hex)}</td>
            <td class="bf-mono" style="color:var(--accent);font-weight:600;">${escapeHtml(res.decoded)}</td>
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

  function requestStructListSlice(syncEndian = false) {
    if (!slSchemaSelect) return;
    const sch = getSchemaById(slSchemaSelect.value);
    if (syncEndian && sch && slEndianSelect) slEndianSelect.value = sch.endianness || 'little';
    vscode.postMessage({
      type: 'readSegmentSlice',
      segmentId: '__struct_list__',
      startOffset: parseAddressInput(slOffsetInput?.value, 0),
      byteSpan: sch ? sch.byteSpan : 64
    });
  }

  B.modes.structList = {
    init() {
      slSchemaSelect?.addEventListener('change', () => requestStructListSlice(true));
      slOffsetInput?.addEventListener('change', () => requestStructListSlice(false));
      slEndianSelect?.addEventListener('change', renderStructListView);
      slSearchInput?.addEventListener('input', renderStructListView);
      bindEditSchemaButton('sl-edit-json-btn', slSchemaSelect, 'struct_list');
      populateStructListSelect();
      renderStructListView();
    },
    handleMessage(msg) {
      if (msg.type === 'segmentSliceData' && msg.segmentId === '__struct_list__') {
        slBytes = (msg.bytes || []).slice();
        renderStructListView();
        return true;
      }
      return false;
    }
  };
})(window.Binsight);
