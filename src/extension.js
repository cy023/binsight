const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  analyzeFile,
  readFileChunk,
  savePatchedBinary,
  searchFilePattern,
  scanBaselineDiffs,
  queryRepeatEntries,
  scanProtocolPackets,
  hydrateLayoutFromFile,
  loadSchemaFromFile,
  DEFAULT_HEX_PAGE_SIZE
} = require('./analyzer');
const {parseTextHexToBuffer, buildPatchOverlay, getEffectiveSize, resolveBinaryPath} = require('./binaryIo');
const {BinsightSidebarProvider} = require('./sidebarProvider');
const {getWebviewHtml} = require('./webviewHtml');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(symbol-struct) Binsight';
  statusBarItem.tooltip = 'Binsight: Open Register & Binary Inspector';
  statusBarItem.command = 'binsight.inspectActiveFile';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 1. CustomReadonlyEditorProvider so clicking any *.bin / *.raw / *.dat file opens directly in Binsight
  const customEditorProvider = {
    openCustomDocument(uri) {
      return {uri, dispose() {}};
    },
    async resolveCustomEditor(document, webviewPanel) {
      await setupBinsightWebview(context, webviewPanel, document.uri.fsPath);
    }
  };

  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
      'binsight.binaryPreview', customEditorProvider,
      {webviewOptions: {retainContextWhenHidden: true}, supportsMultipleEditorsPerDocument: false}));

  // 1b. Sidebar TreeDataProvider for Activity Bar Icon
  const sidebarProvider = new BinsightSidebarProvider();
  context.subscriptions.push(
      vscode.window.registerTreeDataProvider('binsight.sidebarView', sidebarProvider),
      vscode.commands.registerCommand('binsight.refreshSidebar', () => sidebarProvider.refresh()));

  // 2. Command: Inspect selected file (from Explorer right-click or file picker)
  const inspectFileCmd = vscode.commands.registerCommand('binsight.inspectFile', async (uri) => {
    let targetUri = uri;

    if (!targetUri) {
      targetUri = getActiveTabFileUri();
    }

    if (!targetUri) {
      const picked = await vscode.window.showOpenDialog(
          {canSelectMany: false, canSelectFolders: false, openLabel: 'Inspect with Binsight'});
      if (picked && picked.length > 0) {
        targetUri = picked[0];
      }
    }

    if (!targetUri || targetUri.scheme !== 'file') {
      vscode.window.showWarningMessage('Binsight: Please select a local file to inspect.');
      return;
    }

    await openBinsightPanel(context, targetUri.fsPath);
  });

  // 3. Command: Inspect currently active file (works for both text tabs and binary tabs)
  const inspectActiveCmd = vscode.commands.registerCommand('binsight.inspectActiveFile', async () => {
    const activeUri = getActiveTabFileUri();
    if (activeUri && activeUri.scheme === 'file') {
      await openBinsightPanel(context, activeUri.fsPath);
      return;
    }
    await vscode.commands.executeCommand('binsight.inspectFile');
  });

  // 3b. Command: Inspect pasted hex or plain text string as a scratchpad binary
  const inspectPastedHexCmd = vscode.commands.registerCommand('binsight.inspectPastedHex', async () => {
    const pickedMode = await vscode.window.showQuickPick(
        [
          {label: 'Hex Bytes', description: 'e.g. 48 65 6C 6C 6F, 0x1234ABCD, or Intel HEX', mode: 'hex'},
          {label: 'Plain Text (UTF-8)', description: 'Convert pasted text directly to UTF-8 bytes', mode: 'text'}
        ],
        {placeHolder: 'Select input format for pasted data'});
    if (!pickedMode) return;

    let clipboardPrefill = '';
    try {
      const clip = await vscode.env.clipboard.readText();
      if (clip && clip.length <= 8192) {
        if (pickedMode.mode === 'text' || /[0-9a-fA-F]{2}/.test(clip)) {
          clipboardPrefill = pickedMode.mode === 'text' ? clip : clip.trim();
        }
      }
    } catch (_) {
    }
    const raw = await vscode.window.showInputBox({
      prompt: pickedMode.mode === 'text' ? 'Paste plain text (UTF-8) to inspect across all 5 Binsight modes' :
                                           'Paste hex bytes, 0x-prefixed words, or Intel HEX to inspect',
      placeHolder: pickedMode.mode === 'text' ? 'e.g. Hello Binsight!' : 'e.g. 48 65 6C 6C 6F or 0x1234ABCD',
      value: clipboardPrefill,
      ignoreFocusOut: true
    });
    if (!raw) return;
    const buf = pickedMode.mode === 'text' ? Buffer.from(raw, 'utf8') : parseTextHexToBuffer(raw);
    if (buf.length === 0) {
      vscode.window.showWarningMessage('Binsight: No valid bytes found in pasted input.');
      return;
    }
    const tempPath = path.join(os.tmpdir(), `binsight-pasted-${Date.now()}.bin`);
    fs.writeFileSync(tempPath, buf);
    await openBinsightPanel(context, tempPath);
  });

  context.subscriptions.push(inspectFileCmd, inspectActiveCmd, inspectPastedHexCmd);
}

/**
 * Retrieve the URI of the currently active editor or custom tab (including binary tabs)
 */
function getActiveTabFileUri() {
  if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
    return vscode.window.activeTextEditor.document.uri;
  }
  try {
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab && activeTab.input && activeTab.input.uri && activeTab.input.uri.scheme === 'file') {
      return activeTab.input.uri;
    }
  } catch (_) {
  }
  return null;
}

/**
 * Open a standalone WebviewPanel for Binsight
 */
async function openBinsightPanel(context, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      vscode.window.showInformationMessage('Binsight: Selected item is a directory. Please select a file.');
      return;
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Binsight failed to read file: ${err.message}`);
    return;
  }

  const fileName = path.basename(filePath);
  const panel =
      vscode.window.createWebviewPanel('binsightInspector', `BINSIGHT // ${fileName}`, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
      });

  await setupBinsightWebview(context, panel, filePath);
}

/**
 * Configure a WebviewPanel (either standalone or from CustomReadonlyEditorProvider)
 */
async function setupBinsightWebview(context, panel, filePath) {
  let baseFilePath = filePath;
  let workingPatchOverlay = null;
  const tempPaths = new Set();
  let fileName = path.basename(baseFilePath);
  let baselineFilePath = null;
  let lastKnownSegments = [];

  function sendBaselineLoaded(targetBasePath, displayName, segs) {
    baselineFilePath = targetBasePath;
    if (Array.isArray(segs)) lastKnownSegments = segs;
    const segSlices = lastKnownSegments.map((s) => {
      const c = readFileChunk(
          baselineFilePath, Math.max(0, Number(s.startOffset) || 0), Math.max(1, Number(s.byteSpan) || 64));
      return {segmentId: s.id, baselineBytes: c.bytes};
    });
    const diffSummary = scanBaselineDiffs(baseFilePath, baselineFilePath, 2000, workingPatchOverlay);
    panel.webview.postMessage({
      type: 'baselineLoaded',
      baselineFileName: displayName,
      baselineFilePath,
      segmentSlices: segSlices,
      diffSummary
    });
    vscode.window.setStatusBarMessage(
        `$(diff) Binsight: Comparing against ${displayName} (${diffSummary.totalDiffBytes} B diff)`, 3500);
  }

  function syncWorkingCopyState() {
    const diskSize = fs.statSync(resolveBinaryPath(baseFilePath)).size;
    const fileSize = getEffectiveSize(diskSize, workingPatchOverlay);
    const diffSummary =
        baselineFilePath ? scanBaselineDiffs(baseFilePath, baselineFilePath, 2000, workingPatchOverlay) : null;
    panel.webview.postMessage({type: 'workingCopySynced', fileSize, diffSummary});
  }

  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
  };

  // Hot-Reload listener when user saves any *.binsight.json in VS Code
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme === 'file' && doc.fileName.endsWith('.binsight.json')) {
      try {
        const schema = loadSchemaFromFile(doc.fileName);
        panel.webview.postMessage({type: 'schemasLoaded', schemas: [schema], targetSegmentId: null, hotReloaded: true});
        vscode.window.setStatusBarMessage(`$(sync) Binsight: Hot-reloaded schema ${path.basename(doc.fileName)}`, 3000);
      } catch (err) {
        vscode.window.showWarningMessage(
            `Binsight Schema Validation Error in ${path.basename(doc.fileName)}: ${err.message}`);
      }
    }
  });
  panel.onDidDispose(() => {
    saveListener.dispose();
    for (const p of tempPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {
      }
    }
  }, null, context.subscriptions);

  try {
    const workspaceDirs = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const report = await analyzeFile(baseFilePath, workspaceDirs);
    panel.webview.html = getWebviewHtml(context, panel.webview, report);

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'readSegmentSlice') {
          const startOffset = Math.max(0, Number(msg.startOffset) || 0);
          const byteSpan = Math.max(1, Number(msg.byteSpan) || 64);
          const chunk = readFileChunk(baseFilePath, startOffset, byteSpan, workingPatchOverlay);
          const baseChunk = baselineFilePath ? readFileChunk(baselineFilePath, startOffset, byteSpan) : null;
          panel.webview.postMessage({
            type: 'segmentSliceData',
            segmentId: msg.segmentId,
            startOffset: chunk.offset,
            bytes: chunk.bytes,
            baselineBytes: baseChunk ? baseChunk.bytes : null
          });
        } else if (msg.type === 'loadBaselineBin') {
          if (Array.isArray(msg.segments)) lastKnownSegments = msg.segments;
          const choice = await vscode.window.showQuickPick(
              [
                {label: '$(file-binary) Compare with File...', description: 'Select a .bin / .raw / .dat / .hex file', id: 'file'},
                {label: '$(clippy) Compare with Pasted Hex / Text...', description: 'Paste raw hex bytes or plain text as baseline', id: 'paste'}
              ],
              {placeHolder: 'Choose baseline source to compare against'});
          if (!choice) return;
          if (choice.id === 'paste') {
            panel.webview.postMessage({type: 'openPasteModalForBaseline'});
            return;
          }
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select Baseline / Golden Binary (.bin) for Diff',
            filters: {
              'Binary / Hex Files (*.bin, *.raw, *.dat, *.hex, *.txt)': ['bin', 'raw', 'dat', 'hex', 'txt'],
              'All Files': ['*']
            }
          });
          if (picked && picked.length > 0) {
            sendBaselineLoaded(picked[0].fsPath, path.basename(picked[0].fsPath), msg.segments);
          }
        } else if (msg.type === 'loadBaselinePasted') {
          const isText = msg.mode === 'text';
          const buf = isText ? Buffer.from(String(msg.text || ''), 'utf8') : parseTextHexToBuffer(msg.text || '');
          if (buf.length === 0) {
            vscode.window.showWarningMessage('Binsight: No valid bytes found in pasted baseline.');
            return;
          }
          const baseTemp = path.join(os.tmpdir(), `binsight-base-${Date.now()}.bin`);
          fs.writeFileSync(baseTemp, buf);
          tempPaths.add(baseTemp);
          sendBaselineLoaded(baseTemp, isText ? 'Pasted Text' : 'Pasted Hex', msg.segments);
        } else if (msg.type === 'clearBaselineBin') {
          baselineFilePath = null;
          panel.webview.postMessage({type: 'baselineCleared'});
        } else if (msg.type === 'openSchemaInEditor') {
          let targetSchemaPath = msg.schemaFilePath;
          if (!targetSchemaPath || !fs.existsSync(targetSchemaPath)) {
            const defaultUri = vscode.Uri.file(
                path.join(path.dirname(baseFilePath), `${(msg.schemaName || 'custom').toLowerCase()}.binsight.json`));
            const saveUri = await vscode.window.showSaveDialog(
                {defaultUri, saveLabel: 'Save & Edit *.binsight.json Schema', filters: {'Binsight Schema': ['json']}});
            if (!saveUri) return;
            fs.writeFileSync(saveUri.fsPath, String(msg.sourceText || '{}'), 'utf8');
            targetSchemaPath = saveUri.fsPath;
            const parsed = loadSchemaFromFile(targetSchemaPath);
            panel.webview.postMessage(
                {type: 'schemasLoaded', schemas: [parsed], targetSegmentId: msg.targetSegmentId || null});
          }
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetSchemaPath));
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        } else if (msg.type === 'queryRepeatEntries') {
          const result = queryRepeatEntries(
              baseFilePath, msg.schema, {...(msg.options || {}), patchOverlay: workingPatchOverlay});
          panel.webview.postMessage({type: 'repeatEntriesResult', result});
        } else if (msg.type === 'scanProtocolPackets') {
          const result = scanProtocolPackets(
              baseFilePath, msg.schema, {...(msg.options || {}), patchOverlay: workingPatchOverlay});
          panel.webview.postMessage({type: 'protocolPacketsResult', result});
        } else if (msg.type === 'loadHexPage') {
          const offset = Math.max(0, Number(msg.offset) || 0);
          const length = Number(msg.length) || DEFAULT_HEX_PAGE_SIZE;
          const chunk = readFileChunk(baseFilePath, offset, length, workingPatchOverlay);
          const baseChunk = baselineFilePath ? readFileChunk(baselineFilePath, offset, length) : null;
          panel.webview.postMessage({type: 'hexPageData', chunk, baselineBytes: baseChunk ? baseChunk.bytes : null});
        } else if (msg.type === 'findInBinary') {
          const result = searchFilePattern(baseFilePath, msg.query, msg.mode, msg.startOffset, workingPatchOverlay);
          panel.webview.postMessage({type: 'findInBinaryResult', result});
        } else if (msg.type === 'applyWorkingPatches') {
          workingPatchOverlay = buildPatchOverlay(msg.patches || []);
          syncWorkingCopyState();
        } else if (msg.type === 'revertWorkingCopy') {
          workingPatchOverlay = null;
          syncWorkingCopyState();
        } else if (msg.type === 'loadPastedHex') {
          const isText = msg.mode === 'text';
          const buf = isText ? Buffer.from(String(msg.text || ''), 'utf8') : parseTextHexToBuffer(msg.text || '');
          if (buf.length === 0) {
            vscode.window.showWarningMessage('Binsight: No valid bytes found in pasted input.');
            return;
          }
          const pastedPath = path.join(os.tmpdir(), `binsight-pasted-${Date.now()}.bin`);
          fs.writeFileSync(pastedPath, buf);
          tempPaths.add(pastedPath);
          baseFilePath = pastedPath;
          workingPatchOverlay = null;
          fileName = path.basename(pastedPath);
          const newReport = await analyzeFile(baseFilePath, workspaceDirs);
          newReport.fileName = isText ? 'Pasted Text Scratchpad' : 'Pasted Hex Scratchpad';
          panel.title = isText ? 'Binsight: Pasted Text' : 'Binsight: Pasted Hex';
          panel.webview.html = getWebviewHtml(context, panel.webview, newReport);
        } else if (msg.type === 'loadSchemaFromFile') {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Load *.binsight.json Schema',
            filters: {'Binsight JSON Schema (*.binsight.json, *.json)': ['json'], 'All Files': ['*']}
          });
          if (picked && picked.length > 0) {
            const loadedSchemas = picked.map((uri) => loadSchemaFromFile(uri.fsPath));
            panel.webview.postMessage(
                {type: 'schemasLoaded', schemas: loadedSchemas, targetSegmentId: msg.targetSegmentId || null});
            vscode.window.setStatusBarMessage(`$(check) Binsight: Loaded ${loadedSchemas.length} schema file(s)`, 3000);
          }
        } else if (msg.type === 'saveLayoutProfile') {
          const defaultUri = vscode.Uri.file(
              path.join(path.dirname(baseFilePath), `${path.parse(fileName).name}.binsight-layout.json`));
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            saveLabel: 'Save Multi-Segment Layout Profile',
            filters: {'Binsight Layout Profile': ['json']}
          });
          if (saveUri) {
            const layoutDir = path.dirname(saveUri.fsPath);
            const outSegments = (msg.segments || []).map((s) => {
              let schemaRef = s.schemaId;
              if (s.schemaFilePath) {
                const rel = path.relative(layoutDir, s.schemaFilePath).replace(/\\/g, '/');
                schemaRef = rel.startsWith('.') ? rel : './' + rel;
              }
              return {
                label: s.label,
                startOffset: '0x' + Number(s.startOffset || 0).toString(16).toUpperCase().padStart(4, '0'),
                hwBaseAddress: '0x' + Number(s.hwBaseAddress || 0).toString(16).toUpperCase().padStart(8, '0'),
                schema: schemaRef,
                endianness: s.endianness
              };
            });
            const layoutObj = {
              $schema: './schemas/binsight-layout.schema.json',
              name: msg.name || `${path.parse(fileName).name} Layout`,
              description: `Multi-segment register layout for ${fileName}`,
              segments: outSegments
            };
            fs.writeFileSync(saveUri.fsPath, JSON.stringify(layoutObj, null, 2), 'utf8');
            vscode.window.showInformationMessage(`Binsight: Saved Layout Profile to ${path.basename(saveUri.fsPath)}`);
          }
        } else if (msg.type === 'loadLayoutProfileFromFile') {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Load *.binsight-layout.json Profile',
            filters: {'Binsight Layout Profile (*.binsight-layout.json, *.json)': ['json'], 'All Files': ['*']}
          });
          if (picked && picked.length > 0) {
            const layoutPath = picked[0].fsPath;
            const hydrated = hydrateLayoutFromFile(layoutPath, baseFilePath, baselineFilePath, workingPatchOverlay);
            panel.webview.postMessage({
              type: 'layoutProfileHydrated',
              layout: hydrated.layout,
              extraSchemas: hydrated.extraSchemas,
              hydratedSegments: hydrated.hydratedSegments
            });
            vscode.window.showInformationMessage(
                `Binsight: Loaded layout "${hydrated.layout.name}" (${hydrated.hydratedSegments.length} segments)`);
          }
        } else if (msg.type === 'applyDiscoveredLayout') {
          const hydrated = hydrateLayoutFromFile(msg.layoutFilePath, baseFilePath, baselineFilePath, workingPatchOverlay);
          panel.webview.postMessage({
            type: 'layoutProfileHydrated',
            layout: hydrated.layout,
            extraSchemas: hydrated.extraSchemas,
            hydratedSegments: hydrated.hydratedSegments
          });
        } else if (msg.type === 'savePatchedBinaryAsNew') {
          const baseDir = path.dirname(baseFilePath);
          const defaultUri =
              vscode.Uri.file(path.join(baseDir, `${path.parse(fileName).name}_modified.bin`));
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            saveLabel: 'Save As New Binary (.bin)',
            filters: {'Binary Files': ['bin', 'raw', 'dat'], 'All Files': ['*']}
          });
          if (saveUri) {
            savePatchedBinary(baseFilePath, saveUri.fsPath, msg.patches || [], workingPatchOverlay);
            vscode.window.showInformationMessage(`Binsight: Saved modified binary to ${path.basename(saveUri.fsPath)}`);
          }
        } else if (msg.type === 'saveRegisterReport') {
          const defaultUri =
              vscode.Uri.file(path.join(path.dirname(baseFilePath), `${path.parse(fileName).name}_report.txt`));
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            saveLabel: 'Export Multi-Segment Report (.txt)',
            filters: {'Text Report': ['txt', 'log'], 'All Files': ['*']}
          });
          if (saveUri) {
            fs.writeFileSync(saveUri.fsPath, String(msg.content || ''), 'utf8');
            vscode.window.showInformationMessage(`Binsight: Exported report to ${path.basename(saveUri.fsPath)}`);
          }
        } else if (msg.type === 'copyText') {
          await vscode.env.clipboard.writeText(String(msg.text || ''));
          vscode.window.setStatusBarMessage('$(check) Binsight: Copied to clipboard', 2500);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Binsight Error: ${e.message}`);
      }
    }, undefined, context.subscriptions);
  } catch (err) {
    vscode.window.showErrorMessage(`Binsight failed to open file: ${err.message}`);
  }
}


function deactivate() {}

module.exports = {
  activate,
  deactivate
};
