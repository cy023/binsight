const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_HASH_SIZE = 64 * 1024 * 1024;  // 64 MB threshold for automatic full-file hashing
const DEFAULT_HEX_PAGE_SIZE = 4096;      // 4 KB per page in Hex Editor
const decodedHexCache = new Map();

/**
 * Parse Intel HEX or free-form text hex into a raw Buffer.
 */
function parseTextHexToBuffer(text) {
  const lines = String(text || '').split(/\r?\n/);
  const trimmedNonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const isIntelHex = trimmedNonEmpty.length > 0 && trimmedNonEmpty.every((l) => /^:[0-9a-fA-F]{10,}$/.test(l));

  if (isIntelHex) {
    let baseAddr = 0;
    const chunks = [];
    let maxEnd = 0;
    for (const line of trimmedNonEmpty) {
      const byteCount = parseInt(line.slice(1, 3), 16);
      const addr = parseInt(line.slice(3, 7), 16);
      const recType = parseInt(line.slice(7, 9), 16);
      if (recType === 0x00) {
        const data = Buffer.from(line.slice(9, 9 + byteCount * 2), 'hex');
        const abs = baseAddr + addr;
        chunks.push({offset: abs, data});
        if (abs + data.length > maxEnd) maxEnd = abs + data.length;
      } else if (recType === 0x01) {
        break;
      } else if (recType === 0x02) {
        baseAddr = parseInt(line.slice(9, 13), 16) << 4;
      } else if (recType === 0x04) {
        baseAddr = parseInt(line.slice(9, 13), 16) << 16;
      }
    }
    const out = Buffer.alloc(maxEnd, 0xff);
    for (const c of chunks) c.data.copy(out, c.offset);
    return out;
  }

  const bytes = [];
  for (const rawLine of lines) {
    let line = rawLine.replace(/(\/\/|#).*$/, '').trim();
    if (!line) continue;
    line = line.replace(/^(?:0x)?[0-9a-fA-F]{4,8}\s*:\s*/, '');
    const tokens = line.match(/(?:0x[0-9a-fA-F]{1,2}|[0-9a-fA-F]+)/g);
    if (!tokens) continue;
    for (const tok of tokens) {
      if (tok.toLowerCase().startsWith('0x')) {
        bytes.push(parseInt(tok.slice(2), 16) & 0xff);
      } else if (tok.length <= 2) {
        bytes.push(parseInt(tok, 16) & 0xff);
      } else {
        const padded = tok.length % 2 === 1 ? '0' + tok : tok;
        for (let i = 0; i < padded.length; i += 2) {
          bytes.push(parseInt(padded.slice(i, i + 2), 16) & 0xff);
        }
      }
    }
  }
  return Buffer.from(bytes);
}

/**
 * If filePath is a text hex file (.hex / .txt hex dump), decode it to a cached temp binary path.
 * Otherwise return filePath as-is.
 */
function resolveBinaryPath(filePath) {
  if (!filePath) return filePath;
  const lower = filePath.toLowerCase();
  const isHexExt = lower.endsWith('.hex') || lower.endsWith('.txt');
  if (!isHexExt) return filePath;

  const stats = fs.statSync(filePath);
  const cached = decodedHexCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && fs.existsSync(cached.tempPath)) {
    return cached.tempPath;
  }

  const text = fs.readFileSync(filePath, 'utf8');
  if (lower.endsWith('.txt') && /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 512))) {
    return filePath;
  }

  const buf = parseTextHexToBuffer(text);
  const key = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 12);
  const tempPath = path.join(os.tmpdir(), `binsight-hex-${key}.bin`);
  fs.writeFileSync(tempPath, buf);
  decodedHexCache.set(filePath, {mtimeMs: stats.mtimeMs, tempPath});
  return tempPath;
}

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
 * Build an in-memory sparse byte overlay from an array of {startOffset, bytes} patches.
 */
function buildPatchOverlay(patches) {
  const map = new Map();
  let maxEnd = 0;
  for (const patch of patches || []) {
    const base = Math.max(0, Number(patch.startOffset) || 0);
    const bytes = patch.bytes || [];
    for (let i = 0; i < bytes.length; i++) {
      const off = base + i;
      map.set(off, Number(bytes[i]) & 0xff);
      if (off + 1 > maxEnd) maxEnd = off + 1;
    }
  }
  return map.size > 0 ? {map, maxEnd} : null;
}

/**
 * Apply sparse in-memory byte overlay onto a buffer representing [bufFileOffset, bufFileOffset + validLen).
 */
function applyOverlayToBuffer(buf, bufFileOffset, overlay, validLen = buf.length) {
  if (!overlay || !overlay.map || overlay.map.size === 0 || validLen <= 0) return;
  const end = bufFileOffset + validLen;
  for (const [off, val] of overlay.map) {
    if (off >= bufFileOffset && off < end) {
      buf[off - bufFileOffset] = val;
    }
  }
}

function getEffectiveSize(diskSize, overlay) {
  return overlay && overlay.maxEnd > diskSize ? overlay.maxEnd : diskSize;
}

/**
 * Read `len` bytes from disk at `fileOffset` (zero-padding past diskSize) and apply sparse patch overlay.
 */
function readDiskWithOverlay(fd, diskSize, buf, fileOffset, len, patchOverlay) {
  if (len <= 0) return;
  const diskReadable = Math.max(0, Math.min(len, diskSize - fileOffset));
  if (diskReadable < len) buf.fill(0, diskReadable, len);
  if (diskReadable > 0) fs.readSync(fd, buf, 0, diskReadable, fileOffset);
  applyOverlayToBuffer(buf, fileOffset, patchOverlay, len);
}

/**
 * Read a slice of bytes from filePath at given offset and length (On-demand random access I/O)
 */
function readFileChunk(filePath, offset, length, patchOverlay = null) {
  const binPath = resolveBinaryPath(filePath);
  const fd = fs.openSync(binPath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    const totalSize = getEffectiveSize(stats.size, patchOverlay);
    const safeOffset = Math.max(0, Math.min(Number(offset) || 0, totalSize));
    const maxReadable = Math.max(0, totalSize - safeOffset);
    const readLen = Math.max(0, Math.min(Number(length) || 0, maxReadable));
    const buffer = Buffer.alloc(readLen);
    readDiskWithOverlay(fd, stats.size, buffer, safeOffset, readLen, patchOverlay);
    return {offset: safeOffset, length: readLen, totalSize, bytes: Array.from(buffer)};
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy source binary to a new file and apply sparse segment patches at their exact offsets
 */
function savePatchedBinary(sourceFilePath, destFilePath, patches, patchOverlay = null) {
  const binSource = resolveBinaryPath(sourceFilePath);
  if (path.resolve(binSource) !== path.resolve(destFilePath)) {
    fs.copyFileSync(binSource, destFilePath);
  }

  const fd = fs.openSync(destFilePath, 'r+');
  try {
    if (patchOverlay && patchOverlay.map && patchOverlay.map.size > 0) {
      const single = Buffer.alloc(1);
      for (const [off, val] of patchOverlay.map) {
        single[0] = val;
        fs.writeSync(fd, single, 0, 1, off);
      }
    }
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
 * Calculate MD5, SHA-1, SHA-256 hashes of a file using streams
 */
function computeFileHashes(filePath, fileSize) {
  return new Promise((resolve, reject) => {
    if (fileSize > MAX_HASH_SIZE) {
      resolve({
        skipped: true,
        reason: `File size (${formatBytes(fileSize)}) exceeds ${
            formatBytes(MAX_HASH_SIZE)}. Full-file hashing is skipped for instant loading.`
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
      resolve({skipped: false, md5: md5.digest('hex'), sha1: sha1.digest('hex'), sha256: sha256.digest('hex')});
    });
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Search for a hex byte sequence or ASCII text pattern in a file (supports wrap-around).
 */
function searchFilePattern(filePath, query, mode = 'hex', startOffset = 0, patchOverlay = null) {
  const raw = String(query || '').trim();
  if (!raw) return {found: false};

  let needle = null;
  if (mode === 'text') {
    needle = Buffer.from(raw, 'utf8');
  } else {
    const cleaned = raw.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    if (cleaned.length < 2) return {found: false};
    const even = cleaned.length % 2 === 1 ? '0' + cleaned : cleaned;
    needle = Buffer.from(even, 'hex');
  }
  if (!needle || needle.length === 0) return {found: false};

  const binPath = resolveBinaryPath(filePath);
  const fd = fs.openSync(binPath, 'r');
  try {
    const {size: diskSize} = fs.fstatSync(fd);
    const size = getEffectiveSize(diskSize, patchOverlay);
    if (size < needle.length) return {found: false};

    const CHUNK = 256 * 1024;
    const overlap = needle.length - 1;
    const buf = Buffer.alloc(CHUNK + overlap);

    const scanRange = (from, to) => {
      let pos = from;
      while (pos < to) {
        const readLen = Math.min(CHUNK + overlap, to - pos);
        readDiskWithOverlay(fd, diskSize, buf, pos, readLen, patchOverlay);
        const idx = buf.subarray(0, readLen).indexOf(needle);
        if (idx >= 0) return pos + idx;
        pos += CHUNK;
      }
      return -1;
    };

    const clampedStart = Math.max(0, Math.min(Number(startOffset) || 0, size));
    let hit = scanRange(clampedStart, size);
    if (hit < 0 && clampedStart > 0) {
      hit = scanRange(0, Math.min(size, clampedStart + overlap));
    }
    return hit >= 0 ? {found: true, offset: hit, length: needle.length} : {found: false};
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
 * Compare two binary/hex files and return differing byte count + contiguous diff regions.
 */
function scanBaselineDiffs(targetFilePath, baselineFilePath, maxRegions = 2000, patchOverlay = null) {
  const targetPath = resolveBinaryPath(targetFilePath);
  const basePath = resolveBinaryPath(baselineFilePath);
  const fdA = fs.openSync(targetPath, 'r');
  const fdB = fs.openSync(basePath, 'r');
  try {
    const diskSizeA = fs.fstatSync(fdA).size;
    const sizeA = getEffectiveSize(diskSizeA, patchOverlay);
    const sizeB = fs.fstatSync(fdB).size;
    const minSize = Math.min(sizeA, sizeB);
    const CHUNK = 256 * 1024;
    const bufA = Buffer.alloc(CHUNK);
    const bufB = Buffer.alloc(CHUNK);

    let totalDiffBytes = Math.abs(sizeA - sizeB);
    const regions = [];
    let truncated = false;
    let inRegion = false;
    let regionStart = 0;

    for (let pos = 0; pos < minSize; pos += CHUNK) {
      const len = Math.min(CHUNK, minSize - pos);
      readDiskWithOverlay(fdA, diskSizeA, bufA, pos, len, patchOverlay);
      const rB = fs.readSync(fdB, bufB, 0, len, pos);
      const n = Math.min(len, rB);
      for (let i = 0; i < n; i++) {
        if (bufA[i] !== bufB[i]) {
          totalDiffBytes++;
          if (!inRegion) {
            inRegion = true;
            regionStart = pos + i;
          }
        } else if (inRegion) {
          if (regions.length < maxRegions) {
            regions.push({offset: regionStart, length: pos + i - regionStart});
          } else {
            truncated = true;
          }
          inRegion = false;
        }
      }
    }
    if (inRegion) {
      if (regions.length < maxRegions) {
        regions.push({offset: regionStart, length: minSize - regionStart});
      } else {
        truncated = true;
      }
    }
    if (sizeA !== sizeB) {
      if (regions.length < maxRegions) {
        regions.push({offset: minSize, length: Math.abs(sizeA - sizeB)});
      } else {
        truncated = true;
      }
    }

    return {totalDiffBytes, targetSize: sizeA, baseSize: sizeB, regions, truncated};
  } finally {
    fs.closeSync(fdA);
    fs.closeSync(fdB);
  }
}

module.exports = {
  DEFAULT_HEX_PAGE_SIZE,
  parseTextHexToBuffer,
  resolveBinaryPath,
  formatBytes,
  buildPatchOverlay,
  applyOverlayToBuffer,
  getEffectiveSize,
  readDiskWithOverlay,
  readFileChunk,
  savePatchedBinary,
  computeFileHashes,
  searchFilePattern,
  readDiscriminatorHex,
  scanBaselineDiffs
};
