(function (B) {
  const { vscode, report, parseAddressInput, escapeHtml } = B;
  let currentHexChunk = report.hexChunk;
  const pageSize = report.hexChunk.pageSize || 4096;

  // 6. Paged Hex Viewer & File Hashes
  function byteClass(b) {
    if (b === 0) return 'b-null';
    if (b >= 32 && b <= 126) return 'b-ascii';
    if (b < 32 || b === 127) return 'b-ctrl';
    return 'b-high';
  }

  function renderHexChunk() {
    const container = document.getElementById('hex-rows');
    const bytes = currentHexChunk.bytes || [];
    const baseOffset = currentHexChunk.offset || 0;
    const totalSize = report.fileSize || bytes.length;

    const endOffset = Math.max(0, baseOffset + bytes.length - 1);
    document.getElementById('page-indicator').textContent =
      bytes.length > 0
        ? `0x${baseOffset.toString(16).toUpperCase().padStart(8, '0')} .. 0x${endOffset
            .toString(16)
            .toUpperCase()
            .padStart(8, '0')}`
        : 'EMPTY (0 B)';

    document.getElementById('btn-prev-page').disabled = baseOffset <= 0;
    document.getElementById('btn-next-page').disabled = baseOffset + bytes.length >= totalSize;

    if (bytes.length === 0) {
      container.innerHTML = '<p class="hint">NO_DATA_IN_RANGE</p>';
      return;
    }

    const rowsHtml = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const rowOffset = (baseOffset + i).toString(16).toUpperCase().padStart(8, '0');
      let hexPart = '';
      let asciiPart = '';

      for (let j = 0; j < 16; j++) {
        const idx = i + j;
        if (idx < bytes.length) {
          const b = bytes[idx];
          const cls = byteClass(b);
          const hexStr = b.toString(16).toUpperCase().padStart(2, '0');
          const ch = b >= 32 && b <= 126 ? escapeHtml(String.fromCharCode(b)) : '.';
          hexPart += `<span class="hb ${cls}" data-idx="${idx}">${hexStr}</span> `;
          asciiPart += `<span class="ab ${cls}" data-idx="${idx}">${ch}</span>`;
        } else {
          hexPart += '   ';
          asciiPart += ' ';
        }
        if (j === 7) hexPart += ' ';
      }

      rowsHtml.push(
        `<div class="hex-row"><span class="hex-offset">${rowOffset}</span><span class="hex-bytes">${hexPart}</span><span class="hex-ascii">${asciiPart}</span></div>`
      );
    }

    container.innerHTML = rowsHtml.join('');
    selectHexByte(0);
  }

  function selectHexByte(idx) {
    const bytes = currentHexChunk.bytes || [];
    if (idx < 0 || idx >= bytes.length) return;

    const container = document.getElementById('hex-rows');
    container.querySelectorAll('.hb.active, .ab.active').forEach((el) => el.classList.remove('active'));
    container.querySelectorAll(`[data-idx="${idx}"]`).forEach((el) => el.classList.add('active'));

    const absOffset = (currentHexChunk.offset || 0) + idx;
    document.getElementById('inspector-offset').textContent = `OFFSET: 0x${absOffset
      .toString(16)
      .toUpperCase()
      .padStart(8, '0')} (${absOffset})`;

    const slice = new Uint8Array(bytes.slice(idx, Math.min(bytes.length, idx + 8)));
    const dv = new DataView(slice.buffer);

    const u8 = dv.getUint8(0);
    const i8 = dv.getInt8(0);
    const bin8 = u8.toString(2).padStart(8, '0');
    const charRepr = u8 >= 32 && u8 <= 126 ? `'${String.fromCharCode(u8)}'` : 'NON_PRINT';

    const u16le = slice.length >= 2 ? `${dv.getUint16(0, true)} (BE: ${dv.getUint16(0, false)})` : 'N/A';
    const i16le = slice.length >= 2 ? `${dv.getInt16(0, true)} (BE: ${dv.getInt16(0, false)})` : 'N/A';
    const u32le =
      slice.length >= 4
        ? '0x' + dv.getUint32(0, true).toString(16).toUpperCase().padStart(8, '0')
        : 'N/A';
    const u32be =
      slice.length >= 4
        ? '0x' + dv.getUint32(0, false).toString(16).toUpperCase().padStart(8, '0')
        : 'N/A';
    const i32le = slice.length >= 4 ? `${dv.getInt32(0, true)}` : 'N/A';
    const f32le = slice.length >= 4 ? `${dv.getFloat32(0, true).toPrecision(6)}` : 'N/A';

    const items = [
      { k: 'BIN_8', v: bin8 },
      { k: 'HEX / CHR', v: `0x${u8.toString(16).toUpperCase().padStart(2, '0')} (${charRepr})` },
      { k: 'U8 / S8', v: `${u8} / ${i8}` },
      { k: 'U16 (LE/BE)', v: u16le },
      { k: 'S16 (LE/BE)', v: i16le },
      { k: 'U32 (LE/BE)', v: `${u32le} / ${u32be}` },
      { k: 'S32 (LE)', v: i32le },
      { k: 'F32 (LE)', v: f32le }
    ];

    document.getElementById('inspector-table').innerHTML = items
      .map((r) => `<tr><td class="k">${escapeHtml(r.k)}</td><td class="v">${escapeHtml(String(r.v))}</td></tr>`)
      .join('');
  }

  document.getElementById('hex-rows').addEventListener('click', (e) => {
    const target = e.target.closest('[data-idx]');
    if (target) selectHexByte(Number(target.dataset.idx));
  });

  function requestHexOffset(offset) {
    const clamped = Math.max(0, Math.min(offset, Math.max(0, report.fileSize - 1)));
    const aligned = Math.floor(clamped / 16) * 16;
    vscode.postMessage({
      type: 'loadHexPage',
      offset: aligned,
      length: pageSize
    });
  }

  document.getElementById('btn-prev-page').addEventListener('click', () => {
    requestHexOffset((currentHexChunk.offset || 0) - pageSize);
  });

  document.getElementById('btn-next-page').addEventListener('click', () => {
    requestHexOffset((currentHexChunk.offset || 0) + pageSize);
  });

  document.getElementById('btn-jump').addEventListener('click', () => {
    const parsed = parseAddressInput(document.getElementById('jump-input').value, null);
    if (parsed !== null) requestHexOffset(parsed);
  });

  function renderHashes() {
    const hashBox = document.getElementById('hash-box');
    if (report.hashes.skipped) {
      hashBox.innerHTML = `<p class="hint">${escapeHtml(report.hashes.reason)}</p>`;
    } else {
      const algos = [
        { label: 'SHA256', val: report.hashes.sha256 },
        { label: 'MD5', val: report.hashes.md5 }
      ];
      hashBox.innerHTML = algos
        .map(
          (a) => `
        <div class="hash-row">
          <span class="hash-algo">${a.label}</span>
          <code class="hash-val" title="${a.val}">${a.val}</code>
          <button class="btn copy-btn" data-copy="${a.val}">COPY</button>
        </div>`
        )
        .join('');

      hashBox.querySelectorAll('.copy-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'copyText', text: btn.dataset.copy });
        });
      });
    }
  }

  B.modes.hexOverview = {
    init() {
      renderHashes();
      renderHexChunk();
    },
    handleMessage(msg) {
      if (msg.type === 'hexPageData' && msg.chunk) {
        currentHexChunk = msg.chunk;
        renderHexChunk();
        return true;
      }
      return false;
    }
  };
})(window.Binsight);
