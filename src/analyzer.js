const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  getBuiltinSchemas,
  parseBinsightSchema,
  parseLayoutProfile
} = require('./registerParser');
const { evaluateEntryRules } = require('./rules');

const MAX_HASH_SIZE = 64 * 1024 * 1024; // 64 MB threshold for automatic full-file hashing
const DEFAULT_HEX_PAGE_SIZE = 4096;     // 4 KB per page in Hex viewer

/**
 * Format byte count into human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]} (${bytes.toLocaleString()} B)`;
}

/**
 * Read a slice of bytes from filePath at given offset and length (On-demand random access I/O)
 */
function readFileChunk(filePath, offset, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const safeOffset = Math.max(0, Math.min(Number(offset) || 0, stats.size));
    const maxReadable = Math.max(0, stats.size - safeOffset);
    const readLen = Math.max(0, Math.min(Number(length) || 0, maxReadable));
    const buffer = Buffer.alloc(readLen);
    if (readLen > 0) {
      fs.readSync(fd, buffer, 0, readLen, safeOffset);
    }
    return {
      offset: safeOffset,
      length: readLen,
      totalSize: stats.size,
      bytes: Array.from(buffer)
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy source binary to a new file and apply sparse segment patches at their exact offsets
 */
function savePatchedBinary(sourceFilePath, destFilePath, patches) {
  if (path.resolve(sourceFilePath) !== path.resolve(destFilePath)) {
    fs.copyFileSync(sourceFilePath, destFilePath);
  }

  const fd = fs.openSync(destFilePath, 'r+');
  try {
    for (const patch of patches || []) {
      const startOffset = Math.max(0, Number(patch.startOffset) || 0);
      const buf = Buffer.from(patch.bytes || []);
      if (buf.length > 0) {
        fs.writeSync(fd, buf, 0, buf.length, startOffset);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read discriminator key from an entry/packet buffer
 */
function readDiscriminatorHex(buf, offset, disc) {
  const dOff = offset + (disc.offset || 0);
  const dSize = disc.size || 1;
  if (dOff + dSize > buf.length) return '0x00';
  let raw = 0;
  for (let i = 0; i < dSize; i++) {
    raw |= buf[dOff + i] << (i * 8);
  }
  const masked = (raw & (disc.mask ?? 0xff)) >>> 0;
  return '0x' + masked.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * High-performance paged query for Repeat Struct List (supports 64MB+ files with block padding).
 * e.g. 8192B blocks, 72B entries -> 113 entries/block, 56B padding skipped per block.
 */
function queryRepeatEntries(filePath, schema, options = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const fileSize = stats.size;
    const startOffset = Math.max(0, Number(options.startOffset) || 0);
    const usableSize = Math.max(0, fileSize - startOffset);

    const entrySize = Math.max(1, schema.entrySize || 64);
    const blockSize = schema.blockSize || 0;
    const entriesPerBlock = blockSize > 0 ? Math.floor(blockSize / entrySize) : 0;
    const paddingPerBlock = blockSize > 0 ? blockSize % entrySize : 0;

    let totalSlots = 0;
    let totalBlocks = 1;
    if (blockSize > 0 && entriesPerBlock > 0) {
      const fullBlocks = Math.floor(usableSize / blockSize);
      const remBytes = usableSize % blockSize;
      const remEntries = Math.floor(remBytes / entrySize);
      totalSlots = fullBlocks * entriesPerBlock + Math.min(entriesPerBlock, remEntries);
      totalBlocks = Math.ceil(usableSize / blockSize) || 1;
    } else {
      totalSlots = Math.floor(usableSize / entrySize);
    }

    const page = Math.max(0, Number(options.page) || 0);
    const pageSize = Math.max(1, Math.min(500, Number(options.pageSize) || 100));
    const typeFilter = options.typeFilter || 'all';
    const hideSkipped = Boolean(options.hideSkipped);
    const blockFilter =
      options.blockIndex !== undefined && options.blockIndex !== null && options.blockIndex !== ''
        ? Number(options.blockIndex)
        : null;

    const disc = schema.discriminator || { offset: 0, size: 1, mask: 0xff };
    const variants = schema.variants || {};
    const defVar = schema.defaultVariant || { name: 'ENTRY', skip: false };

    // Fast O(1) direct math path when no filtering is active
    if (typeFilter === 'all' && !hideSkipped && blockFilter === null) {
      const startIdx = page * pageSize;
      const endIdx = Math.min(totalSlots, startIdx + pageSize);
      const entries = [];
      const singleBuf = Buffer.alloc(entrySize);

      for (let idx = startIdx; idx < endIdx; idx++) {
        let blockIndex = 0;
        let slotIndex = idx;
        let fileOffset = startOffset + idx * entrySize;
        if (blockSize > 0 && entriesPerBlock > 0) {
          blockIndex = Math.floor(idx / entriesPerBlock);
          slotIndex = idx % entriesPerBlock;
          fileOffset = startOffset + blockIndex * blockSize + slotIndex * entrySize;
        }
        if (fileOffset + entrySize > fileSize) break;
        fs.readSync(fd, singleBuf, 0, entrySize, fileOffset);
        const typeHex = readDiscriminatorHex(singleBuf, 0, disc);
        const variant = variants[typeHex] || defVar;
        entries.push({
          index: idx,
          blockIndex,
          slotIndex,
          fileOffset,
          typeHex,
          variantName: variant.name,
          skipped: Boolean(variant.skip),
          bytes: Array.from(singleBuf)
        });
      }

      return {
        totalSlots,
        matchedCount: totalSlots,
        totalBlocks,
        entriesPerBlock,
        paddingPerBlock,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(totalSlots / pageSize)),
        entries
      };
    }

    // Filtered scan (reads in block-aligned chunks for high throughput up to 64MB+)
    const chunkBlockCount = blockSize > 0 ? Math.max(1, Math.floor((1024 * 1024) / blockSize)) : 1;
    const chunkByteSize = blockSize > 0 ? chunkBlockCount * blockSize : Math.floor((1024 * 1024) / entrySize) * entrySize;
    const chunkBuf = Buffer.alloc(chunkByteSize);

    const targetStart = page * pageSize;
    const targetEnd = targetStart + pageSize;
    const entries = [];
    let matchedCount = 0;

    function tryCollectEntry(entryInBuf, absFileOffset, absIdx, blockIndex, slotIndex) {
      const typeHex = readDiscriminatorHex(chunkBuf, entryInBuf, disc);
      const variant = variants[typeHex] || defVar;
      if (hideSkipped && variant.skip) return;
      if (typeFilter !== 'all' && typeHex !== typeFilter) return;

      if (matchedCount >= targetStart && matchedCount < targetEnd) {
        const bytes = Array.from(chunkBuf.subarray(entryInBuf, entryInBuf + entrySize));
        const { severity, ruleHits } = evaluateEntryRules(bytes, variant, schema, schema.endianness || 'little');
        entries.push({
          index: absIdx,
          blockIndex,
          slotIndex,
          fileOffset: absFileOffset,
          typeHex,
          variantName: variant.name,
          skipped: Boolean(variant.skip),
          severity,
          ruleHits,
          bytes
        });
      }
      matchedCount++;
    }

    if (blockSize > 0 && entriesPerBlock > 0) {
      const bStart = blockFilter !== null ? Math.max(0, blockFilter) : 0;
      const bEnd = blockFilter !== null ? Math.min(totalBlocks - 1, blockFilter) : totalBlocks - 1;

      for (let b = bStart; b <= bEnd; b += chunkBlockCount) {
        const blocksToRead = Math.min(chunkBlockCount, bEnd - b + 1);
        const readOffset = startOffset + b * blockSize;
        const readLen = Math.min(blocksToRead * blockSize, Math.max(0, fileSize - readOffset));
        if (readLen <= 0) break;
        fs.readSync(fd, chunkBuf, 0, readLen, readOffset);

        for (let lb = 0; lb < blocksToRead; lb++) {
          const blkIdx = b + lb;
          const blkBaseInBuf = lb * blockSize;
          for (let s = 0; s < entriesPerBlock; s++) {
            const entryInBuf = blkBaseInBuf + s * entrySize;
            if (entryInBuf + entrySize > readLen) break;
            tryCollectEntry(entryInBuf, readOffset + entryInBuf, blkIdx * entriesPerBlock + s, blkIdx, s);
          }
        }
      }
    } else {
      for (let off = startOffset; off + entrySize <= fileSize; off += chunkByteSize) {
        const readLen = Math.min(chunkByteSize, fileSize - off);
        fs.readSync(fd, chunkBuf, 0, readLen, off);
        const countInChunk = Math.floor(readLen / entrySize);
        for (let i = 0; i < countInChunk; i++) {
          const entryInBuf = i * entrySize;
          const absIdx = Math.floor((off - startOffset) / entrySize) + i;
          tryCollectEntry(entryInBuf, off + entryInBuf, absIdx, 0, absIdx);
        }
      }
    }

    return {
      totalSlots,
      matchedCount,
      totalBlocks,
      entriesPerBlock,
      paddingPerBlock,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(matchedCount / pageSize)),
      entries
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Scan communication protocol packets (e.g. UFS UPIU stream) with pagination & type filtering
 */
function scanProtocolPackets(filePath, schema, options = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const fileSize = stats.size;
    const startOffset = Math.max(0, Number(options.startOffset) || 0);
    const framing = schema.packetFraming || { headerSize: 32, ehsLenOffset: -1, dataSegLenOffset: -1 };
    const headerSize = Math.max(4, framing.headerSize || 32);
    const disc = schema.discriminator || { offset: 0, size: 1, mask: 0x3f };
    const variants = schema.variants || {};

    const page = Math.max(0, Number(options.page) || 0);
    const pageSize = Math.max(1, Math.min(500, Number(options.pageSize) || 100));
    const typeFilter = options.typeFilter || 'all';
    const targetStart = page * pageSize;
    const targetEnd = targetStart + pageSize;

    const packets = [];
    const WINDOW_SIZE = 256 * 1024;
    const winBuf = Buffer.alloc(WINDOW_SIZE);
    let winStart = -1;
    let winLen = 0;

    let cursor = startOffset;
    let totalPackets = 0;
    let matchedCount = 0;
    const maxScanPackets = 50000;

    while (cursor + headerSize <= fileSize && totalPackets < maxScanPackets) {
      // Refill 256KB read-ahead window only when cursor passes buffered region
      if (winStart < 0 || cursor < winStart || cursor + headerSize > winStart + winLen) {
        winStart = cursor;
        winLen = fs.readSync(fd, winBuf, 0, Math.min(WINDOW_SIZE, fileSize - winStart), winStart);
        if (winLen < headerSize) break;
      }

      const rel = cursor - winStart;
      const typeHex = readDiscriminatorHex(winBuf, rel, disc);
      const variant = variants[typeHex] || null;

      let ehsBytes = 0;
      if (framing.ehsLenOffset >= 0 && framing.ehsLenOffset < headerSize) {
        ehsBytes = winBuf[rel + framing.ehsLenOffset] * 4;
      }

      let dataSegBytes = 0;
      if (framing.dataSegLenOffset >= 0 && framing.dataSegLenOffset + 1 < headerSize) {
        const lenOff = framing.dataSegLenOffset === 9 ? 10 : framing.dataSegLenOffset;
        if (lenOff + 1 < headerSize) {
          dataSegBytes = winBuf.readUInt16BE(rel + lenOff);
        }
      }

      const totalPktLen = Math.min(fileSize - cursor, headerSize + ehsBytes + dataSegBytes);

      if (typeFilter === 'all' || typeHex === typeFilter) {
        if (matchedCount >= targetStart && matchedCount < targetEnd) {
          const payloadLen = Math.min(64, Math.max(0, totalPktLen - headerSize));
          let payloadBytes = [];
          if (payloadLen > 0) {
            if (rel + headerSize + payloadLen <= winLen) {
              payloadBytes = Array.from(winBuf.subarray(rel + headerSize, rel + headerSize + payloadLen));
            } else {
              const pBuf = Buffer.alloc(payloadLen);
              fs.readSync(fd, pBuf, 0, payloadLen, cursor + headerSize);
              payloadBytes = Array.from(pBuf);
            }
          }
          const headerBytes = Array.from(winBuf.subarray(rel, rel + headerSize));
          const { severity, ruleHits } = evaluateEntryRules(headerBytes, variant, schema, schema.endianness || 'big');
          packets.push({
            index: totalPackets,
            fileOffset: cursor,
            totalLength: totalPktLen,
            headerSize,
            ehsBytes,
            dataSegBytes,
            typeHex,
            variantName: variant ? variant.name : `UNKNOWN (${typeHex})`,
            taskTag: '0x' + winBuf[rel + 3].toString(16).toUpperCase().padStart(2, '0'),
            lun: '0x' + winBuf[rel + 2].toString(16).toUpperCase().padStart(2, '0'),
            severity,
            ruleHits,
            headerBytes,
            payloadBytes
          });
        }
        matchedCount++;
      }

      totalPackets++;
      cursor += Math.max(headerSize, totalPktLen);
    }

    return {
      totalPackets,
      matchedCount,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(matchedCount / pageSize)),
      packets
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walk directories up to maxDepth, skipping dotfiles and node_modules,
 * invoking onFile(resolvedPath, entryName) once per unique file.
 */
function walkWorkspaceFiles(searchDirs, maxDepth, onFile) {
  const visitedFiles = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth || !dir || !fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const real = path.resolve(fullPath);
        if (visitedFiles.has(real)) continue;
        visitedFiles.add(real);
        onFile(real, entry.name);
      }
    }
  }

  for (const d of searchDirs || []) {
    walk(d, 0);
  }
}

/**
 * Read, parse, and label a *.binsight.json schema file from disk.
 */
function loadSchemaFromFile(filePath) {
  const real = path.resolve(filePath);
  const text = fs.readFileSync(real, 'utf8');
  const schema = parseBinsightSchema(text, `file:${real}`, real);
  schema.name = `${schema.name} (${path.basename(real)})`;
  return schema;
}

/**
 * Discover *.binsight.json and *.binsight-layout.json files in given root directories (up to depth 3)
 */
function discoverWorkspaceConfigs(searchDirs) {
  const discoveredSchemas = [];
  const discoveredLayouts = [];

  walkWorkspaceFiles(searchDirs, 3, (real, fileName) => {
    if (fileName.endsWith('.binsight.json')) {
      try {
        discoveredSchemas.push(loadSchemaFromFile(real));
      } catch (_) {
        // Ignore malformed files during auto-discovery
      }
    } else if (fileName.endsWith('.binsight-layout.json')) {
      try {
        const text = fs.readFileSync(real, 'utf8');
        const layout = parseLayoutProfile(text);
        layout.filePath = real;
        layout.fileName = fileName;
        discoveredLayouts.push(layout);
      } catch (_) {
        // Ignore malformed layout files
      }
    }
  });

  return { discoveredSchemas, discoveredLayouts };
}

/**
 * Hydrate a layout file against a target binary file
 */
function hydrateLayoutFromFile(layoutFilePath, binFilePath, baselineFilePath = null) {
  const layoutDir = path.dirname(layoutFilePath);
  const rawText = fs.readFileSync(layoutFilePath, 'utf8');
  const layout = parseLayoutProfile(rawText);
  const extraSchemas = [];
  const hydratedSegments = [];

  for (const seg of layout.segments) {
    let schemaId = seg.schemaRef;
    let byteSpan = 64;
    let schemaBaseAddr = 0;

    if (!schemaId.startsWith('builtin-')) {
      const candidatePath = path.isAbsolute(schemaId)
        ? path.resolve(schemaId)
        : path.resolve(layoutDir, schemaId.replace(/^file:/, ''));
      if (fs.existsSync(candidatePath)) {
        const sText = fs.readFileSync(candidatePath, 'utf8');
        const parsedSchema = parseBinsightSchema(sText, `file:${candidatePath}`, candidatePath);
        parsedSchema.name = `${parsedSchema.name} (${path.basename(candidatePath)})`;
        extraSchemas.push(parsedSchema);
        schemaId = parsedSchema.id;
        byteSpan = parsedSchema.byteSpan;
        schemaBaseAddr = parsedSchema.baseAddress || 0;
      }
    }

    const slice = readFileChunk(binFilePath, seg.startOffset, byteSpan);
    const baseSlice = baselineFilePath
      ? readFileChunk(baselineFilePath, seg.startOffset, byteSpan)
      : null;

    hydratedSegments.push({
      label: seg.label,
      startOffset: seg.startOffset,
      hwBaseAddress: seg.hwBaseAddress !== null ? seg.hwBaseAddress : schemaBaseAddr,
      schemaId,
      endianness: seg.endianness || null,
      bytes: slice.bytes,
      baselineBytes: baseSlice ? baseSlice.bytes : null
    });
  }

  return { layout, extraSchemas, hydratedSegments };
}

/**
 * Smartly match a .bin file to a discovered Layout Profile or the most relevant Schema (across all 4 modes)
 */
function matchBestConfigForFile(filePath, allSchemas, discoveredLayouts) {
  const stem = path.parse(filePath).name.toLowerCase();
  const tokens = stem.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !/^scenario\d*$/.test(t));

  for (const layout of discoveredLayouts) {
    const layoutStem = layout.fileName.replace(/\.binsight-layout\.json$/i, '').toLowerCase();
    if (stem === layoutStem || stem.startsWith(layoutStem) || layoutStem.startsWith(stem)) {
      return { matchedLayout: layout, matchedSchema: null };
    }
  }

  let bestSchema = allSchemas[0];
  let bestScore = -1;

  for (const sch of allSchemas) {
    const primaryName = `${sch.name} ${sch.filePath ? path.basename(sch.filePath) : sch.id}`.toLowerCase();
    const descText = `${sch.mode} ${sch.description || ''}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (primaryName.includes(tok)) score += 20;
      else if (descText.includes(tok)) score += 3;
    }
    if (sch.filePath) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestSchema = sch;
    }
  }

  return { matchedLayout: null, matchedSchema: bestSchema };
}

/**
 * Calculate MD5, SHA-1, SHA-256 hashes of a file using streams
 */
function computeFileHashes(filePath, fileSize) {
  return new Promise((resolve, reject) => {
    if (fileSize > MAX_HASH_SIZE) {
      resolve({
        skipped: true,
        reason: `File size (${formatBytes(fileSize)}) exceeds ${formatBytes(
          MAX_HASH_SIZE
        )}. Full-file hashing is skipped for instant loading.`
      });
      return;
    }

    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    const sha256 = crypto.createHash('sha256');

    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      md5.update(chunk);
      sha1.update(chunk);
      sha256.update(chunk);
    });
    stream.on('end', () => {
      resolve({
        skipped: false,
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex'),
        sha256: sha256.digest('hex')
      });
    });
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Perform fast initial analysis and smartly hydrate the matching mode (Register Map, Struct List, Repeat Struct, or Protocol)
 */
async function analyzeFile(filePath, extraSearchDirs = []) {
  const stats = fs.statSync(filePath);
  const initialHexChunk = readFileChunk(filePath, 0, DEFAULT_HEX_PAGE_SIZE);
  const hashes = await computeFileHashes(filePath, stats.size);

  const searchRoots = [path.dirname(filePath), path.dirname(path.dirname(filePath)), ...extraSearchDirs];
  const { discoveredSchemas, discoveredLayouts } = discoverWorkspaceConfigs(searchRoots);

  const allSchemas = [...discoveredSchemas, ...getBuiltinSchemas()];
  const { matchedLayout, matchedSchema } = matchBestConfigForFile(
    filePath,
    allSchemas,
    discoveredLayouts
  );

  let initialSegments = [];
  let activeLayoutFileName = null;
  let initialRepeatResult = null;
  let initialProtocolResult = null;
  const activeMode = matchedLayout ? 'register-map' : matchedSchema ? matchedSchema.mode : 'register-map';

  if (matchedLayout && matchedLayout.filePath) {
    try {
      const hydrated = hydrateLayoutFromFile(matchedLayout.filePath, filePath, null);
      for (const extra of hydrated.extraSchemas) {
        if (!allSchemas.some((s) => s.id === extra.id)) {
          allSchemas.unshift(extra);
        }
      }
      initialSegments = hydrated.hydratedSegments;
      activeLayoutFileName = matchedLayout.fileName;
    } catch (_) {}
  }

  if (initialSegments.length === 0) {
    const chosenSchema = matchedSchema || allSchemas[0];
    if (chosenSchema && chosenSchema.mode === 'repeat-struct') {
      initialRepeatResult = queryRepeatEntries(filePath, chosenSchema, { page: 0, pageSize: 100 });
    } else if (chosenSchema && chosenSchema.mode === 'protocol') {
      initialProtocolResult = scanProtocolPackets(filePath, chosenSchema, {});
    }

    const slice = readFileChunk(filePath, 0, chosenSchema ? chosenSchema.byteSpan : 64);
    initialSegments = [
      {
        label: chosenSchema ? chosenSchema.name.replace(/\s*\(.*\)$/, '') : 'SEG_0',
        startOffset: 0,
        hwBaseAddress: chosenSchema ? chosenSchema.baseAddress || 0 : 0,
        schemaId: chosenSchema ? chosenSchema.id : 'empty',
        endianness: chosenSchema ? chosenSchema.endianness || 'little' : 'little',
        bytes: slice.bytes,
        baselineBytes: null
      }
    ];
  }

  return {
    fileName: path.basename(filePath),
    filePath,
    fileSize: stats.size,
    formattedSize: formatBytes(stats.size),
    modifiedTime: stats.mtime.toISOString(),
    hashes,
    schemas: allSchemas,
    layouts: discoveredLayouts,
    activeLayoutFileName,
    initialMode: activeMode,
    initialSchemaId: matchedSchema ? matchedSchema.id : initialSegments[0]?.schemaId,
    initialSegments,
    initialRepeatResult,
    initialProtocolResult,
    hexChunk: {
      ...initialHexChunk,
      pageSize: DEFAULT_HEX_PAGE_SIZE
    }
  };
}

module.exports = {
  analyzeFile,
  readFileChunk,
  savePatchedBinary,
  queryRepeatEntries,
  scanProtocolPackets,
  discoverWorkspaceConfigs,
  walkWorkspaceFiles,
  loadSchemaFromFile,
  hydrateLayoutFromFile,
  formatBytes,
  DEFAULT_HEX_PAGE_SIZE
};
