const fs = require('fs');
const path = require('path');
const {parseBinsightSchema, parseLayoutProfile} = require('./registerParser');
const {readFileChunk} = require('./binaryIo');

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
      entries = fs.readdirSync(dir, {withFileTypes: true});
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

const BUILTIN_SCHEMAS_DIR = path.resolve(__dirname, '..', 'schemas');

/**
 * Discover *.binsight.json and *.binsight-layout.json files in given root directories (up to depth 3)
 */
function discoverWorkspaceConfigs(searchDirs) {
  const discoveredSchemas = [];
  const discoveredLayouts = [];

  walkWorkspaceFiles(searchDirs, 3, (real, fileName) => {
    if (real.startsWith(BUILTIN_SCHEMAS_DIR + path.sep)) return;
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

  return {discoveredSchemas, discoveredLayouts};
}

/**
 * Hydrate a layout file against a target binary file
 */
function hydrateLayoutFromFile(layoutFilePath, binFilePath, baselineFilePath = null, patchOverlay = null) {
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
      const candidatePath =
          path.isAbsolute(schemaId) ? path.resolve(schemaId) : path.resolve(layoutDir, schemaId.replace(/^file:/, ''));
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

    const slice = readFileChunk(binFilePath, seg.startOffset, byteSpan, patchOverlay);
    const baseSlice = baselineFilePath ? readFileChunk(baselineFilePath, seg.startOffset, byteSpan) : null;

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

  return {layout, extraSchemas, hydratedSegments};
}

/**
 * Smartly match a binary/hex file to a discovered Layout Profile or the most relevant Schema (across all 4 schema modes)
 */
function matchBestConfigForFile(filePath, allSchemas, discoveredLayouts) {
  const stem = path.parse(filePath).name.toLowerCase();
  const tokens = stem.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !/^scenario\d*$/.test(t));

  for (const layout of discoveredLayouts) {
    const layoutStem = layout.fileName.replace(/\.binsight-layout\.json$/i, '').toLowerCase();
    if (stem === layoutStem || stem.startsWith(layoutStem) || layoutStem.startsWith(stem)) {
      return {matchedLayout: layout, matchedSchema: null};
    }
  }

  let bestSchema = allSchemas[0];
  let bestScore = -1;

  for (const sch of allSchemas) {
    const primaryName = `${sch.name} ${sch.filePath ? path.basename(sch.filePath) : sch.id}`.toLowerCase();
    const descText = `${sch.mode} ${sch.description || ''}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (primaryName.includes(tok))
        score += 20;
      else if (descText.includes(tok))
        score += 3;
    }
    if (sch.filePath) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestSchema = sch;
    }
  }

  return {matchedLayout: null, matchedSchema: bestSchema};
}

module.exports = {
  walkWorkspaceFiles,
  loadSchemaFromFile,
  discoverWorkspaceConfigs,
  hydrateLayoutFromFile,
  matchBestConfigForFile
};
