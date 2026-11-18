const fs = require('fs');
const {resolveBinaryPath, readDiscriminatorHex, readDiskWithOverlay, getEffectiveSize} = require('./binaryIo');
const {evaluateEntryRules} = require('./rules');

/**
 * Scan communication protocol packets (e.g. UFS UPIU stream) with pagination & type filtering
 */
function scanProtocolPackets(filePath, schema, options = {}) {
  const binPath = resolveBinaryPath(filePath);
  const fd = fs.openSync(binPath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const patchOverlay = options.patchOverlay || null;
    const fileSize = getEffectiveSize(stats.size, patchOverlay);
    const startOffset = Math.max(0, Number(options.startOffset) || 0);
    const framing = schema.packetFraming || {headerSize: 32, ehsLenOffset: -1, dataSegLenOffset: -1};
    const headerSize = Math.max(4, framing.headerSize || 32);
    const disc = schema.discriminator || {offset: 0, size: 1, mask: 0x3f};
    const variants = schema.variants || {};

    const page = Math.max(0, Number(options.page) || 0);
    const pageSize = Math.max(1, Math.min(500, Number(options.pageSize) || 100));
    const typeFilter = options.typeFilter || 'all';
    const anomaliesOnly = Boolean(options.anomaliesOnly);
    const targetStart = page * pageSize;
    const targetEnd = targetStart + pageSize;

    const packets = [];
    const anomalyCounts = {error: 0, warn: 0, info: 0};
    const anomalies = [];
    const schemaHasRules = Array.isArray(schema.rules) && schema.rules.length > 0;
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
        winLen = Math.min(WINDOW_SIZE, fileSize - winStart);
        readDiskWithOverlay(fd, stats.size, winBuf, winStart, winLen, patchOverlay);
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
        dataSegBytes = winBuf.readUInt16BE(rel + framing.dataSegLenOffset);
      }

      const totalPktLen = Math.min(fileSize - cursor, headerSize + ehsBytes + dataSegBytes);

      if (typeFilter === 'all' || typeHex === typeFilter) {
        const hasRules = schemaHasRules || (variant && Array.isArray(variant.rules) && variant.rules.length > 0);
        const inTargetPage = matchedCount >= targetStart && matchedCount < targetEnd;
        let headerBytes = null;
        let ruleEval = null;
        if (hasRules || anomaliesOnly || inTargetPage) {
          headerBytes = Array.from(winBuf.subarray(rel, rel + headerSize));
          ruleEval = hasRules ? evaluateEntryRules(headerBytes, variant, schema, schema.endianness || 'big') :
                                {severity: null, ruleHits: []};
          if (anomaliesOnly && !ruleEval.severity) {
            totalPackets++;
            cursor += Math.max(headerSize, totalPktLen);
            continue;
          }
          if (ruleEval.severity) {
            anomalyCounts[ruleEval.severity] = (anomalyCounts[ruleEval.severity] || 0) + 1;
            if (anomalies.length < 2000) anomalies.push({matchIdx: matchedCount, severity: ruleEval.severity});
          }
        }
        if (inTargetPage) {
          const payloadLen = Math.min(256, Math.max(0, totalPktLen - headerSize));
          let payloadBytes = [];
          if (payloadLen > 0) {
            if (rel + headerSize + payloadLen <= winLen) {
              payloadBytes = Array.from(winBuf.subarray(rel + headerSize, rel + headerSize + payloadLen));
            } else {
              const pBuf = Buffer.alloc(payloadLen);
              readDiskWithOverlay(fd, stats.size, pBuf, cursor + headerSize, payloadLen, patchOverlay);
              payloadBytes = Array.from(pBuf);
            }
          }
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
            severity: ruleEval.severity,
            ruleHits: ruleEval.ruleHits,
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
      anomalyCounts,
      anomalies,
      packets
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  scanProtocolPackets
};
