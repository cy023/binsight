const fs = require('fs');
const {resolveBinaryPath, readDiscriminatorHex, readDiskWithOverlay, getEffectiveSize} = require('./binaryIo');
const {evaluateEntryRules} = require('./rules');

/**
 * High-performance paged query for Record Trace (supports 64MB+ files with block padding).
 * e.g. 8192B blocks, 72B entries -> 113 entries/block, 56B padding skipped per block.
 */
function queryRepeatEntries(filePath, schema, options = {}) {
  const binPath = resolveBinaryPath(filePath);
  const fd = fs.openSync(binPath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const patchOverlay = options.patchOverlay || null;
    const fileSize = getEffectiveSize(stats.size, patchOverlay);
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
    const anomaliesOnly = Boolean(options.anomaliesOnly);
    const blockFilter = options.blockIndex !== undefined && options.blockIndex !== null && options.blockIndex !== '' ?
        Number(options.blockIndex) :
        null;

    const disc = schema.discriminator || {offset: 0, size: 1, mask: 0xff};
    const variants = schema.variants || {};
    const defVar = schema.defaultVariant || {name: 'ENTRY', skip: false};
    const endian = schema.endianness || 'little';

    // Fast O(1) direct math path when no filtering is active
    if (typeFilter === 'all' && !hideSkipped && !anomaliesOnly && blockFilter === null) {
      const startIdx = page * pageSize;
      const endIdx = Math.min(totalSlots, startIdx + pageSize);
      const entries = [];
      const singleBuf = Buffer.alloc(entrySize);
      const anomalyCounts = {error: 0, warn: 0, info: 0};
      const anomalies = [];

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
        readDiskWithOverlay(fd, stats.size, singleBuf, fileOffset, entrySize, patchOverlay);
        const typeHex = readDiscriminatorHex(singleBuf, 0, disc);
        const variant = variants[typeHex] || defVar;
        const bytes = Array.from(singleBuf);
        const {severity, ruleHits} = evaluateEntryRules(bytes, variant, schema, endian);
        if (severity) {
          anomalyCounts[severity] = (anomalyCounts[severity] || 0) + 1;
          anomalies.push({matchIdx: idx, severity});
        }
        entries.push({
          index: idx,
          blockIndex,
          slotIndex,
          fileOffset,
          typeHex,
          variantName: variant.name,
          skipped: Boolean(variant.skip),
          severity,
          ruleHits,
          bytes
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
        anomalyCounts,
        anomalies,
        entries
      };
    }

    // Filtered scan (reads in block-aligned chunks for high throughput up to 64MB+)
    const chunkBlockCount = blockSize > 0 ? Math.max(1, Math.floor((1024 * 1024) / blockSize)) : 1;
    const chunkByteSize =
        blockSize > 0 ? chunkBlockCount * blockSize : Math.floor((1024 * 1024) / entrySize) * entrySize;
    const chunkBuf = Buffer.alloc(chunkByteSize);

    const targetStart = page * pageSize;
    const targetEnd = targetStart + pageSize;
    const entries = [];
    const anomalyCounts = {error: 0, warn: 0, info: 0};
    const anomalies = [];
    const schemaHasRules = Array.isArray(schema.rules) && schema.rules.length > 0;
    let matchedCount = 0;

    function tryCollectEntry(entryInBuf, absFileOffset, absIdx, blockIndex, slotIndex) {
      const typeHex = readDiscriminatorHex(chunkBuf, entryInBuf, disc);
      const variant = variants[typeHex] || defVar;
      if (hideSkipped && variant.skip) return;
      if (typeFilter !== 'all' && typeHex !== typeFilter) return;

      const hasRules = schemaHasRules || (Array.isArray(variant.rules) && variant.rules.length > 0);
      let ruleEval = null;
      let bytes = null;
      if (hasRules || anomaliesOnly) {
        bytes = Array.from(chunkBuf.subarray(entryInBuf, entryInBuf + entrySize));
        ruleEval = evaluateEntryRules(bytes, variant, schema, endian);
        if (anomaliesOnly && !ruleEval.severity) return;
        if (ruleEval.severity) {
          anomalyCounts[ruleEval.severity] = (anomalyCounts[ruleEval.severity] || 0) + 1;
          if (anomalies.length < 2000) anomalies.push({matchIdx: matchedCount, severity: ruleEval.severity});
        }
      }

      if (matchedCount >= targetStart && matchedCount < targetEnd) {
        if (!bytes) bytes = Array.from(chunkBuf.subarray(entryInBuf, entryInBuf + entrySize));
        if (!ruleEval) ruleEval = {severity: null, ruleHits: []};
        entries.push({
          index: absIdx,
          blockIndex,
          slotIndex,
          fileOffset: absFileOffset,
          typeHex,
          variantName: variant.name,
          skipped: Boolean(variant.skip),
          severity: ruleEval.severity,
          ruleHits: ruleEval.ruleHits,
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
        readDiskWithOverlay(fd, stats.size, chunkBuf, readOffset, readLen, patchOverlay);

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
        readDiskWithOverlay(fd, stats.size, chunkBuf, off, readLen, patchOverlay);
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
      anomalyCounts,
      anomalies,
      entries
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  queryRepeatEntries
};
