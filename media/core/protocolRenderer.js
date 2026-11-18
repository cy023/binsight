(function() {
const {readWordBigInt, extractBitfield, computeFieldRepresentations} = window.BinsightMath;
const toHex = (num, pad = 2) => "0x" + Number(num || 0).toString(16).toUpperCase().padStart(pad, "0");
const escapeHtml = (str) => String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function resolveProtocolPacketSpec(bytes, protoSch) {
  if (!Array.isArray(bytes) || !protoSch) return null;
  const disc = protoSch.discriminator || {offset: 0, size: 1, mask: 0x3f};
  const dOff = disc.offset || 0;
  const dSize = disc.size || 1;
  let raw = 0;
  for (let i = 0; i < dSize && dOff + i < bytes.length; i++) {
    raw |= bytes[dOff + i] << (i * 8);
  }
  const typeHex = '0x' + ((raw & (disc.mask ?? 0x3f)) >>> 0).toString(16).toUpperCase().padStart(2, '0');
  const variant = protoSch.variants && protoSch.variants[typeHex];
  if (!variant) return {typeHex, variant: null, title: `UNKNOWN (${typeHex})`, activeRows: []};

  let activeRows = variant.rows || [];
  let subLabel = '';
  if (variant.subVariants) {
    const subDisc = variant.subVariants.discriminator || {offset: 16, size: 1, mask: 0xff};
    const sOff = subDisc.offset || 0;
    const sSize = subDisc.size || 1;
    if (sOff + sSize <= bytes.length) {
      let rawSub = 0;
      for (let i = 0; i < sSize; i++) rawSub |= bytes[sOff + i] << (i * 8);
      const subHex = '0x' + ((rawSub & (subDisc.mask ?? 0xff)) >>> 0).toString(16).toUpperCase().padStart(2, '0');
      const subVar = variant.subVariants.variants && variant.subVariants.variants[subHex];
      if (subVar) {
        subLabel = ` — ${subVar.name}`;
        const byRow = new Map(activeRows.map((r) => [r.row, r]));
        for (const sr of subVar.rows || []) byRow.set(sr.row, sr);
        activeRows = Array.from(byRow.values()).sort((a, b) => a.row - b.row);
      }
    }
  }
  return {typeHex, variant, title: `${variant.name}${subLabel}`, activeRows};
}

function renderEmbeddedProtocolDiagram(bytes, absBaseOffset, protoSch) {
  const spec = resolveProtocolPacketSpec(bytes, protoSch);
  if (!spec || !spec.variant) {
    return `<p class="hint">Unknown embedded ${escapeHtml(protoSch?.name || 'Protocol')} type ${
        escapeHtml(spec?.typeHex || '')}</p>`;
  }
  const endian = protoSch.endianness || 'big';
  const offHex = toHex(absBaseOffset, 6);
  const rulerHtml = `
      <div class="proto-ruler-row">
        <div style="padding:4px 2px;font-weight:600;">Byte</div>
        <div class="proto-ruler-cell"><div>+0</div><div class="proto-bit-ticks"><span>31</span><span>24</span></div></div>
        <div class="proto-ruler-cell"><div>+1</div><div class="proto-bit-ticks"><span>23</span><span>16</span></div></div>
        <div class="proto-ruler-cell"><div>+2</div><div class="proto-bit-ticks"><span>15</span><span>8</span></div></div>
        <div class="proto-ruler-cell"><div>+3</div><div class="proto-bit-ticks"><span>7</span><span>0</span></div></div>
      </div>`;

  const allDecoded = [];
  const wordRowsHtml =
      spec.activeRows
          .map((r) => {
            const rowByteOffset = r.row * 4;
            if (rowByteOffset + 4 > bytes.length) return '';
            const wordValBig = readWordBigInt(bytes, rowByteOffset, 4, endian);
            const fields = (r.fields || []).slice().sort((a, b) => b.msb - a.msb);
            const boxesHtml =
                fields
                    .map((f) => {
                      const fValBig = extractBitfield(wordValBig, f.msb, f.lsb);
                      const rep = computeFieldRepresentations(fValBig, f, endian);
                      const span = f.msb - f.lsb + 1;
                      if (!f.reserved) allDecoded.push({row: r.row, byteOff: rowByteOffset, f, rep});
                      return `
              <div class="proto-field-box ${f.reserved ? 'rsvd-box' : ''}"
                   style="grid-column: span ${span};"
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
              <span style="font-size:10px;">${toHex(rowByteOffset, 2)}</span>
            </div>
            ${boxesHtml}
          </div>`;
          })
          .join('');

  const kvRowsHtml = allDecoded
                         .map((item) => {
                           const absOff = absBaseOffset + item.byteOff;
                           const bitLbl =
                               item.f.msb === item.f.lsb ? `[${item.f.msb}]` : `[${item.f.msb}:${item.f.lsb}]`;
                           return `
          <tr>
            <td class="k" style="width:44%;"><span class="jump-offset-link" data-jump-file-offset="${
                               absOff}" data-jump-length="4" title="Jump to Hex Editor (@${
                               toHex(absOff, 6)})">DW${item.row} ${bitLbl}</span> <strong>${
                               escapeHtml(item.f.name)}</strong></td>
            <td class="v">${escapeHtml(item.rep.enumName || item.rep.engineeredStr || item.rep.uintStr)} <span style="font-size:11px;color:var(--muted);">(${
                               escapeHtml(item.rep.hexStr)})</span></td>
          </tr>`;
                         })
                         .join('');

  return `
      <div class="term-box-hdr" style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
        <span>Embedded ${escapeHtml(spec.title)} (<span class="jump-offset-link" data-jump-file-offset="${
      absBaseOffset}" data-jump-length="${bytes.length}" title="Jump to Hex Editor (@${offHex})">@${offHex}</span>, ${
      bytes.length} B)</span>
      </div>
      <div class="proto-diagram-pane size-compact" style="padding:0;border:none;background:transparent;">
        <div class="proto-spec-grid">
          ${rulerHtml}
          ${wordRowsHtml}
        </div>
      </div>
      <table class="kv-table" style="margin-top:8px;">${kvRowsHtml}</table>`;
}

window.Binsight = {
  vscode,
  report,
  schemas,
  discoveredLayouts,
  defaultSchema,
  getSchemaById,

window.BinsightProto = {
  resolveProtocolPacketSpec,
  renderEmbeddedProtocolDiagram
};
})();
