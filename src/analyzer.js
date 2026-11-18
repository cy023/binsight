const fs = require('fs');
const path = require('path');
const {getBuiltinSchemas} = require('./registerParser');
const {
  DEFAULT_HEX_PAGE_SIZE,
  resolveBinaryPath,
  formatBytes,
  readFileChunk,
  savePatchedBinary,
  computeFileHashes,
  searchFilePattern,
  scanBaselineDiffs
} = require('./binaryIo');
const {queryRepeatEntries} = require('./recordTraceScanner');
const {scanProtocolPackets} = require('./protocolScanner');
const {
  walkWorkspaceFiles,
  loadSchemaFromFile,
  discoverWorkspaceConfigs,
  hydrateLayoutFromFile,
  matchBestConfigForFile
} = require('./configDiscovery');

/**
 * Perform fast initial analysis and smartly hydrate the matching mode (Registers, Struct View, Record Trace, or
 * Protocol Analyze)
 */
async function analyzeFile(filePath, extraSearchDirs = []) {
  const binPath = resolveBinaryPath(filePath);
  const stats = fs.statSync(binPath);
  const initialHexChunk = readFileChunk(binPath, 0, DEFAULT_HEX_PAGE_SIZE);
  const hashes = await computeFileHashes(binPath, stats.size);

  const searchRoots = [path.dirname(filePath), path.dirname(path.dirname(filePath)), ...extraSearchDirs];
  const {discoveredSchemas, discoveredLayouts} = discoverWorkspaceConfigs(searchRoots);

  const allSchemas = [...discoveredSchemas, ...getBuiltinSchemas()];
  const {matchedLayout, matchedSchema} = matchBestConfigForFile(filePath, allSchemas, discoveredLayouts);

  let initialSegments = [];
  let activeLayoutFileName = null;
  let initialRepeatResult = null;
  let initialProtocolResult = null;
  const activeMode = matchedLayout ? 'registers' : matchedSchema ? matchedSchema.mode : 'registers';

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
    } catch (_) {
    }
  }

  if (initialSegments.length === 0) {
    const chosenSchema = matchedSchema || allSchemas[0];
    if (chosenSchema && chosenSchema.mode === 'record-trace') {
      initialRepeatResult = queryRepeatEntries(filePath, chosenSchema, {page: 0, pageSize: 100});
    } else if (chosenSchema && chosenSchema.mode === 'protocol-analyze') {
      initialProtocolResult = scanProtocolPackets(filePath, chosenSchema, {});
    }

    const slice = readFileChunk(filePath, 0, chosenSchema ? chosenSchema.byteSpan : 64);
    initialSegments = [{
      label: chosenSchema ? chosenSchema.name.replace(/\s*\(.*\)$/, '') : 'SEG_0',
      startOffset: 0,
      hwBaseAddress: chosenSchema ? chosenSchema.baseAddress || 0 : 0,
      schemaId: chosenSchema ? chosenSchema.id : 'empty',
      endianness: chosenSchema ? chosenSchema.endianness || 'little' : 'little',
      bytes: slice.bytes,
      baselineBytes: null
    }];
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
    hexChunk: {...initialHexChunk, pageSize: DEFAULT_HEX_PAGE_SIZE}
  };
}

module.exports = {
  analyzeFile,
  readFileChunk,
  savePatchedBinary,
  searchFilePattern,
  scanBaselineDiffs,
  queryRepeatEntries,
  scanProtocolPackets,
  discoverWorkspaceConfigs,
  walkWorkspaceFiles,
  loadSchemaFromFile,
  hydrateLayoutFromFile,
  formatBytes,
  DEFAULT_HEX_PAGE_SIZE
};
