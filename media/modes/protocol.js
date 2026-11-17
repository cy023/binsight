(function(B) {
const {
  vscode,
  report,
  getSchemaById,
  parseAddressInput,
  toHex,
  readWordBigInt,
  extractBitfield,
  computeFieldRepresentations,
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

const protoSchemaSelect = document.getElementById('proto-schema-select');
const protoOffsetInput = document.getElementById('proto-offset-input');
const protoTypeFilter = document.getElementById('proto-type-filter');
const protoAnomaliesOnly = document.getElementById('proto-anomalies-only');
const protoHideRsvd = document.getElementById('proto-hide-rsvd');
const protoShowDetails = document.getElementById('proto-show-details');
const protoSizeSelect = document.getElementById('proto-size-select');
const protoEntryInput = document.getElementById('proto-entry-input');
const protoFieldSearch = document.getElementById('proto-field-search');
let protoResult = report.initialProtocolResult || null;
let protoPage = 0;
let selectedProtoIdx = 0;
let pendingSelectMatchIdx = null;
let selectedProtoField = null;

function populateProtocolControls() {
  if (!protoSchemaSelect) return;
  populateModeSchemaSelect(protoSchemaSelect, 'protocol');
  populateVariantFilterSelect(protoTypeFilter, protoSchemaSelect?.value, 'All Packet Types');
}

function requestProtocolScan(pageNum = 0) {
  if (!protoSchemaSelect) return;
  const sch = getSchemaById(protoSchemaSelect.value);
  if (!sch) return;
  protoPage = Math.max(0, pageNum);
  const startOffset = parseAddressInput(protoOffsetInput?.value, 0);
  const typeFilter = protoTypeFilter ? protoTypeFilter.value : 'all';
  const anomaliesOnly = protoAnomaliesOnly ? protoAnomaliesOnly.checked : false;
  vscode.postMessage({
    type: 'scanProtocolPackets',
    schema: sch,
    options: {startOffset, page: protoPage, pageSize: 100, typeFilter, anomaliesOnly}
  });
}

function renderProtocolDiagram(pkt, sch) {
  const diagWrap = document.getElementById('proto-diagram-wrap');
  if (!diagWrap || !pkt) return;
  const variant = sch.variants && sch.variants[pkt.typeHex];
  const hideRsvd = protoHideRsvd ? protoHideRsvd.checked : false;
  const offHex = toHex(pkt.fileOffset, 4);

  if (!variant) {
    diagWrap.innerHTML = `
        <div class="term-box-hdr">Packet #${pkt.index} (<span class="jump-offset-link" data-jump-file-offset="${
        pkt.fileOffset}" data-jump-length="${pkt.totalLength || 1}" title="Jump to Hex Dump (@${offHex})">@${
        offHex}</span>) — Unknown Type ${escapeHtml(pkt.typeHex)}</div>
        <p class="hint">No diagram definition found for type ${escapeHtml(pkt.typeHex)}.</p>`;
    return;
  }

  const headerHtml = `
      <div class="term-box-hdr" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Packet #${pkt.index}: ${
      escapeHtml(
          variant.name)} (<span class="jump-offset-link" data-jump-file-offset="${pkt.fileOffset}" data-jump-length="${
      pkt.totalLength || 1}" title="Jump to Hex Dump (@${offHex})">@${offHex}</span>, ${pkt.totalLength} B)</span>
        <span class="hint">${escapeHtml(variant.description || '')}</span>
      </div>`;

  const rulerHtml = `
      <div class="proto-ruler-row">
        <div style="padding:4px 2px;font-weight:600;">Byte</div>
        <div class="proto-ruler-cell"><div>+0</div><div class="proto-bit-ticks"><span>31</span><span>24</span></div></div>
        <div class="proto-ruler-cell"><div>+1</div><div class="proto-bit-ticks"><span>23</span><span>16</span></div></div>
        <div class="proto-ruler-cell"><div>+2</div><div class="proto-bit-ticks"><span>15</span><span>8</span></div></div>
        <div class="proto-ruler-cell"><div>+3</div><div class="proto-bit-ticks"><span>7</span><span>0</span></div></div>
      </div>`;

  const fieldQ = protoFieldSearch ? protoFieldSearch.value.trim().toLowerCase() : '';
  const allDecodedRows = [];
  const wordRowsHtml =
      (variant.rows || [])
          .map((r) => {
            const rowByteOffset = r.row * 4;
            const wordValBig = readWordBigInt(pkt.headerBytes, rowByteOffset, 4, sch.endianness || 'big');
            const fields = (r.fields || []).slice().sort((a, b) => b.msb - a.msb);

            const boxesHtml =
                fields
                    .map((f) => {
                      const fValBig = extractBitfield(wordValBig, f.msb, f.lsb);
                      const rep = computeFieldRepresentations(fValBig, f, sch.endianness || 'big');
                      const span = f.msb - f.lsb + 1;
                      const isActive =
                          selectedProtoField && selectedProtoField.row === r.row && selectedProtoField.msb === f.msb;
                      const matchesSearch = !fieldQ || (f.name || '').toLowerCase().includes(fieldQ) ||
                          (f.description || '').toLowerCase().includes(fieldQ);
                      const searchCls = fieldQ ? (matchesSearch ? 'search-match' : 'search-dim') : '';

                      allDecodedRows.push({row: r.row, byteOff: rowByteOffset, f, rep, matchesSearch});

                      if (hideRsvd && f.reserved) {
                        return `<div class="proto-field-box rsvd-box ${searchCls}" style="grid-column: span ${
                            span};"><span class="proto-fld-name">—</span></div>`;
                      }

                      return `
              <div class="proto-field-box ${f.reserved ? 'rsvd-box' : ''} ${isActive ? 'active' : ''} ${searchCls}"
                   style="grid-column: span ${span};"
                   data-proto-row="${r.row}" data-proto-msb="${f.msb}"
                   title="${escapeHtml(f.name)} [${f.bits}] = ${escapeHtml(rep.hexStr)} — ${
                          escapeHtml(f.description || '')}">
                <span class="proto-fld-name">${escapeHtml(f.name)}</span>
                ${
                          rep.enumName ?
                              `<span class="proto-fld-enum">${escapeHtml(rep.enumName)}</span>` :
                              `<span class="proto-fld-val">${escapeHtml(rep.engineeredStr || rep.hexStr)}</span>`}
              </div>`;
                    })
                    .join('');

            return `
          <div class="proto-word-row">
            <div class="proto-row-offset">
              <strong>+${rowByteOffset}</strong>
              <span style="font-size:9.5px;">${toHex(rowByteOffset, 2)}</span>
            </div>
            ${boxesHtml}
          </div>`;
          })
          .join('');

  const detailRowsHtml =
      allDecodedRows.filter((item) => !(hideRsvd && item.f.reserved) && (!fieldQ || item.matchesSearch))
          .map((item) => {
            const isActive =
                selectedProtoField && selectedProtoField.row === item.row && selectedProtoField.msb === item.f.msb;
            const bitLbl = item.f.msb === item.f.lsb ? `[${item.f.msb}]` : `[${item.f.msb}:${item.f.lsb}]`;
            return `
          <tr class="entry-row ${isActive ? 'selected' : ''}" data-proto-row="${item.row}" data-proto-msb="${
                item.f.msb}">
            <td class="bf-mono" style="color:var(--muted);">DW${item.row} ${bitLbl}</td>
            <td class="bf-mono"><strong>${escapeHtml(item.f.name)}</strong></td>
            <td class="bf-mono">${escapeHtml(item.rep.hexStr)}</td>
            <td class="bf-mono" style="color:var(--accent);">${
                escapeHtml(item.rep.enumName || item.rep.engineeredStr || item.rep.uintStr)}</td>
            <td><span class="reg-desc">${escapeHtml(item.f.description || '')}</span></td>
          </tr>`;
          })
          .join('');

  const payloadHtml = pkt.payloadBytes && pkt.payloadBytes.length > 0 ? `<div style="margin-top:8px;">
             <div class="term-box-hdr">Payload (${pkt.dataSegBytes} B)</div>
             <div class="bf-mono" style="font-size:11px;color:var(--muted);word-break:break-all;">
               ${pkt.payloadBytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}
             </div>
           </div>` :
                                                                        '';

  const showDetails = protoShowDetails ? protoShowDetails.checked : true;
  const detailsSectionHtml = showDetails ? `<div style="margin-top:8px;">
           <table class="data-table">
             <tbody>${detailRowsHtml}</tbody>
           </table>
         </div>` :
                                           '';

  diagWrap.innerHTML = `
      ${headerHtml}
      ${renderRuleHitsBox(pkt.ruleHits)}
      <div class="proto-spec-grid">
        ${rulerHtml}
        ${wordRowsHtml}
      </div>
      ${payloadHtml}
      ${detailsSectionHtml}`;
}

function renderProtocolView() {
  const listWrap = document.getElementById('proto-list-wrap');
  const diagWrap = document.getElementById('proto-diagram-wrap');
  const countBadge = document.getElementById('proto-pkt-count');
  if (!listWrap || !diagWrap || !protoSchemaSelect) return;

  const sch = getSchemaById(protoSchemaSelect.value);
  if (!protoResult || sch.mode !== 'protocol') {
    listWrap.innerHTML = '<p class="hint">Select a Protocol schema (e.g. UFS_UPIU).</p>';
    diagWrap.innerHTML = '';
    return;
  }

  const totalMatched = protoResult.matchedCount ?? (protoResult.packets || []).length;
  const curPage = protoResult.page ?? 0;
  const totalPages = protoResult.totalPages ?? 1;
  if (countBadge) countBadge.textContent = `${totalMatched.toLocaleString()}`;
  updateAnomalyBar('proto-anomaly-bar', 'proto-anomaly-badge', protoResult.anomalyCounts);
  updatePagination('proto', curPage, totalPages, `${curPage + 1} / ${totalPages}`);

  const packets = protoResult.packets || [];
  if (packets.length === 0) {
    listWrap.innerHTML = `
        <div class="empty-state-box">
          <p>No packets match the current filter or offset.</p>
          <button id="proto-reset-filters" class="btn">Reset Filters</button>
        </div>`;
    document.getElementById('proto-reset-filters')?.addEventListener('click', () => {
      if (protoTypeFilter) protoTypeFilter.value = 'all';
      if (protoAnomaliesOnly) protoAnomaliesOnly.checked = false;
      saveProtocolState();
      requestProtocolScan(0);
    });
    diagWrap.innerHTML = '<p class="hint">No packet selected.</p>';
    return;
  }

  if (selectedProtoIdx >= packets.length) selectedProtoIdx = 0;

  const curGlobalMatchIdx = curPage * (protoResult.pageSize || 100) + selectedProtoIdx;
  if (protoEntryInput) protoEntryInput.value = String(curGlobalMatchIdx);
  const prevEntryBtn = document.getElementById('proto-prev-entry');
  const nextEntryBtn = document.getElementById('proto-next-entry');
  if (prevEntryBtn) prevEntryBtn.disabled = curGlobalMatchIdx <= 0;
  if (nextEntryBtn) nextEntryBtn.disabled = curGlobalMatchIdx + 1 >= totalMatched;

  const sizeMode = protoSizeSelect ? protoSizeSelect.value : 'compact';
  diagWrap.classList.remove('size-compact', 'size-normal', 'size-large');
  diagWrap.classList.add(`size-${sizeMode}`);

  const listRows = packets
                       .map((pkt, idx) => {
                         const selCls = idx === selectedProtoIdx ? 'selected' : '';
                         const sevCls = pkt.severity ? `sev-${pkt.severity}` : '';
                         const offHex = toHex(pkt.fileOffset, 4);
                         return `
          <tr class="entry-row ${selCls} ${sevCls}" data-proto-idx="${idx}">
            <td class="bf-mono">#${pkt.index}</td>
            <td class="bf-mono"><span class="jump-offset-link" data-jump-file-offset="${
                             pkt.fileOffset}" data-jump-length="${pkt.totalLength || 1}" title="Jump to Hex Dump (@${
                             offHex})">${offHex}</span></td>
            <td class="bf-mono"><strong>${escapeHtml(pkt.variantName)}</strong></td>
            <td class="bf-mono" style="color:var(--muted);">${pkt.taskTag}</td>
          </tr>`;
                       })
                       .join('');

  listWrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:42px;">#</th>
            <th style="width:68px;">Offset</th>
            <th>Transaction Type</th>
            <th style="width:65px;">Tag</th>
          </tr>
        </thead>
        <tbody>${listRows}</tbody>
      </table>`;

  renderProtocolDiagram(packets[selectedProtoIdx], sch);
}

function jumpToProtocolEntry(targetGlobalIdx) {
  if (!protoResult) return;
  const total = protoResult.matchedCount ?? (protoResult.packets || []).length;
  const clamped = Math.max(0, Math.min(targetGlobalIdx, Math.max(0, total - 1)));
  const pSize = protoResult.pageSize || 100;
  const targetPage = Math.floor(clamped / pSize);
  const idxInPage = clamped % pSize;
  selectedProtoField = null;

  if (targetPage === (protoResult.page ?? 0)) {
    selectedProtoIdx = idxInPage;
    renderProtocolView();
  } else {
    pendingSelectMatchIdx = idxInPage;
    requestProtocolScan(targetPage);
  }
}

function jumpToProtocolAnomaly(dir) {
  const curGlobal = (protoResult?.page ?? 0) * (protoResult?.pageSize || 100) + selectedProtoIdx;
  const target = findNextAnomalyMatch(protoResult?.anomalies, curGlobal, dir);
  if (target) jumpToProtocolEntry(target.matchIdx);
}

function saveProtocolState() {
  patchUiState({
    protoSchemaId: protoSchemaSelect?.value,
    protoOffset: protoOffsetInput?.value,
    protoTypeFilter: protoTypeFilter?.value,
    protoAnomaliesOnly: protoAnomaliesOnly?.checked,
    protoSize: protoSizeSelect?.value,
    protoHideRsvd: protoHideRsvd?.checked,
    protoShowDetails: protoShowDetails?.checked
  });
}

B.modes.protocol = {
  init() {
    document.getElementById('proto-list-wrap')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-jump-file-offset]')) return;
      const row = e.target.closest('[data-proto-idx]');
      if (row) {
        selectedProtoIdx = Number(row.dataset.protoIdx);
        selectedProtoField = null;
        renderProtocolView();
      }
    });
    document.getElementById('proto-diagram-wrap')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-jump-file-offset]')) return;
      const box = e.target.closest('[data-proto-row]');
      if (box) {
        const fromTable = Boolean(box.closest('table'));
        selectedProtoField = {row: Number(box.dataset.protoRow), msb: Number(box.dataset.protoMsb)};
        renderProtocolView();
        const selector = fromTable ?
            `.proto-field-box[data-proto-row="${selectedProtoField.row}"][data-proto-msb="${selectedProtoField.msb}"]` :
            `tr[data-proto-row="${selectedProtoField.row}"][data-proto-msb="${selectedProtoField.msb}"]`;
        document.querySelector(`#proto-diagram-wrap ${selector}`)?.scrollIntoView({block: 'nearest'});
      }
    });
    protoFieldSearch?.addEventListener('input', renderProtocolView);
    document.getElementById('proto-prev-err')?.addEventListener('click', () => jumpToProtocolAnomaly(-1));
    document.getElementById('proto-next-err')?.addEventListener('click', () => jumpToProtocolAnomaly(1));
    protoSchemaSelect?.addEventListener('change', () => {
      populateVariantFilterSelect(protoTypeFilter, protoSchemaSelect?.value, 'All Packet Types');
      saveProtocolState();
      requestProtocolScan(0);
    });
    protoOffsetInput?.addEventListener('change', () => {
      saveProtocolState();
      requestProtocolScan(0);
    });
    protoTypeFilter?.addEventListener('change', () => {
      saveProtocolState();
      requestProtocolScan(0);
    });
    protoAnomaliesOnly?.addEventListener('change', () => {
      saveProtocolState();
      requestProtocolScan(0);
    });
    document.getElementById('proto-prev-page')?.addEventListener('click', () => requestProtocolScan(protoPage - 1));
    document.getElementById('proto-next-page')?.addEventListener('click', () => requestProtocolScan(protoPage + 1));
    protoEntryInput?.addEventListener('change', () => {
      const parsed = parseInt(protoEntryInput.value.trim(), 10);
      if (!Number.isNaN(parsed)) jumpToProtocolEntry(parsed);
    });
    document.getElementById('proto-prev-entry')?.addEventListener('click', () => {
      const cur = (protoResult?.page ?? 0) * (protoResult?.pageSize || 100) + selectedProtoIdx;
      jumpToProtocolEntry(cur - 1);
    });
    document.getElementById('proto-next-entry')?.addEventListener('click', () => {
      const cur = (protoResult?.page ?? 0) * (protoResult?.pageSize || 100) + selectedProtoIdx;
      jumpToProtocolEntry(cur + 1);
    });
    protoSizeSelect?.addEventListener('change', () => {
      saveProtocolState();
      renderProtocolView();
    });
    protoShowDetails?.addEventListener('change', () => {
      saveProtocolState();
      renderProtocolView();
    });
    protoHideRsvd?.addEventListener('change', () => {
      saveProtocolState();
      renderProtocolView();
    });
    bindEditSchemaButton('proto-edit-json-btn', protoSchemaSelect, 'protocol');
    initSplitResizer('proto-resizer', '--proto-list-w', false, 180, 560);
    populateProtocolControls();

    const ui = getUiState();
    let needsScan = false;
    if (restoreSelectOption(protoSchemaSelect, ui.protoSchemaId)) {
      populateVariantFilterSelect(protoTypeFilter, protoSchemaSelect.value, 'All Packet Types');
      needsScan = true;
    }
    if (ui.protoOffset && protoOffsetInput && protoOffsetInput.value !== ui.protoOffset) {
      protoOffsetInput.value = ui.protoOffset;
      needsScan = true;
    }
    if (restoreSelectOption(protoTypeFilter, ui.protoTypeFilter)) {
      needsScan = true;
    }
    if (typeof ui.protoAnomaliesOnly === 'boolean' && protoAnomaliesOnly &&
        protoAnomaliesOnly.checked !== ui.protoAnomaliesOnly) {
      protoAnomaliesOnly.checked = ui.protoAnomaliesOnly;
      needsScan = true;
    }
    restoreSelectOption(protoSizeSelect, ui.protoSize);
    if (typeof ui.protoHideRsvd === 'boolean' && protoHideRsvd) protoHideRsvd.checked = ui.protoHideRsvd;
    if (typeof ui.protoShowDetails === 'boolean' && protoShowDetails) protoShowDetails.checked = ui.protoShowDetails;

    renderProtocolView();
    if (needsScan) requestProtocolScan(0);
  },
  handleKeyDown(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!protoResult || !(protoResult.packets || []).length) return;
    e.preventDefault();
    const cur = (protoResult.page ?? 0) * (protoResult.pageSize || 100) + selectedProtoIdx;
    jumpToProtocolEntry(cur + (e.key === 'ArrowDown' ? 1 : -1));
    document.querySelector(`#proto-list-wrap [data-proto-idx="${selectedProtoIdx}"]`)?.scrollIntoView({
      block: 'nearest'
    });
  },
  handleMessage(msg) {
    if (msg.type === 'protocolPacketsResult' && msg.result) {
      protoResult = msg.result;
      selectedProtoIdx = pendingSelectMatchIdx !== null ? pendingSelectMatchIdx : 0;
      pendingSelectMatchIdx = null;
      renderProtocolView();
      return true;
    }
    return false;
  }
};
})(window.Binsight);
