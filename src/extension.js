const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const {
  analyzeFile,
  readFileChunk,
  savePatchedBinary,
  queryRepeatEntries,
  scanProtocolPackets,
  hydrateLayoutFromFile,
  walkWorkspaceFiles,
  loadSchemaFromFile,
  DEFAULT_HEX_PAGE_SIZE
} = require('./analyzer');

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
      return { uri, dispose() {} };
    },
    async resolveCustomEditor(document, webviewPanel) {
      await setupBinsightWebview(context, webviewPanel, document.uri.fsPath);
    }
  };

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('binsight.binaryPreview', customEditorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  // 1b. Sidebar TreeDataProvider for Activity Bar Icon
  const sidebarProvider = new BinsightSidebarProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('binsight.sidebarView', sidebarProvider),
    vscode.commands.registerCommand('binsight.refreshSidebar', () => sidebarProvider.refresh())
  );

  // 2. Command: Inspect selected file (from Explorer right-click or file picker)
  const inspectFileCmd = vscode.commands.registerCommand('binsight.inspectFile', async (uri) => {
    let targetUri = uri;

    if (!targetUri) {
      targetUri = getActiveTabFileUri();
    }

    if (!targetUri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: false,
        openLabel: 'Inspect with Binsight'
      });
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

  context.subscriptions.push(inspectFileCmd, inspectActiveCmd);
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
  } catch (_) {}
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
  const panel = vscode.window.createWebviewPanel(
    'binsightInspector',
    `BINSIGHT // ${fileName}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    }
  );

  await setupBinsightWebview(context, panel, filePath);
}

/**
 * Configure a WebviewPanel (either standalone or from CustomReadonlyEditorProvider)
 */
async function setupBinsightWebview(context, panel, filePath) {
  const fileName = path.basename(filePath);
  let baselineFilePath = null;

  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
  };

  // Hot-Reload listener when user saves any *.binsight.json in VS Code
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme === 'file' && doc.fileName.endsWith('.binsight.json')) {
      try {
        const schema = loadSchemaFromFile(doc.fileName);
        panel.webview.postMessage({
          type: 'schemasLoaded',
          schemas: [schema],
          targetSegmentId: null,
          hotReloaded: true
        });
        vscode.window.setStatusBarMessage(
          `$(sync) Binsight: Hot-reloaded schema ${path.basename(real)}`,
          3000
        );
      } catch (err) {
        vscode.window.showWarningMessage(
          `Binsight Schema Validation Error in ${path.basename(doc.fileName)}: ${err.message}`
        );
      }
    }
  });
  panel.onDidDispose(() => saveListener.dispose(), null, context.subscriptions);

  try {
    const workspaceDirs = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const report = await analyzeFile(filePath, workspaceDirs);
    panel.webview.html = getWebviewHtml(context, panel.webview, report);

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        try {
          if (msg.type === 'readSegmentSlice') {
            const startOffset = Math.max(0, Number(msg.startOffset) || 0);
            const byteSpan = Math.max(1, Number(msg.byteSpan) || 64);
            const chunk = readFileChunk(filePath, startOffset, byteSpan);
            const baseChunk = baselineFilePath
              ? readFileChunk(baselineFilePath, startOffset, byteSpan)
              : null;
            panel.webview.postMessage({
              type: 'segmentSliceData',
              segmentId: msg.segmentId,
              startOffset: chunk.offset,
              bytes: chunk.bytes,
              baselineBytes: baseChunk ? baseChunk.bytes : null
            });
          } else if (msg.type === 'loadBaselineBin') {
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: false,
              openLabel: 'Select Baseline / Golden Binary (.bin) for Diff',
              filters: {
                'Binary Files (*.bin, *.raw, *.dat)': ['bin', 'raw', 'dat'],
                'All Files': ['*']
              }
            });
            if (picked && picked.length > 0) {
              baselineFilePath = picked[0].fsPath;
              const segSlices = (msg.segments || []).map((s) => {
                const c = readFileChunk(
                  baselineFilePath,
                  Math.max(0, Number(s.startOffset) || 0),
                  Math.max(1, Number(s.byteSpan) || 64)
                );
                return { segmentId: s.id, baselineBytes: c.bytes };
              });
              panel.webview.postMessage({
                type: 'baselineLoaded',
                baselineFileName: path.basename(baselineFilePath),
                baselineFilePath,
                segmentSlices: segSlices
              });
              vscode.window.setStatusBarMessage(
                `$(diff) Binsight: Comparing against baseline ${path.basename(baselineFilePath)}`,
                3500
              );
            }
          } else if (msg.type === 'clearBaselineBin') {
            baselineFilePath = null;
            panel.webview.postMessage({ type: 'baselineCleared' });
          } else if (msg.type === 'openSchemaInEditor') {
            let targetSchemaPath = msg.schemaFilePath;
            if (!targetSchemaPath || !fs.existsSync(targetSchemaPath)) {
              const defaultUri = vscode.Uri.file(
                path.join(path.dirname(filePath), `${(msg.schemaName || 'custom').toLowerCase()}.binsight.json`)
              );
              const saveUri = await vscode.window.showSaveDialog({
                defaultUri,
                saveLabel: 'Save & Edit *.binsight.json Schema',
                filters: { 'Binsight Schema': ['json'] }
              });
              if (!saveUri) return;
              fs.writeFileSync(saveUri.fsPath, String(msg.sourceText || '{}'), 'utf8');
              targetSchemaPath = saveUri.fsPath;
              const parsed = loadSchemaFromFile(targetSchemaPath);
              panel.webview.postMessage({
                type: 'schemasLoaded',
                schemas: [parsed],
                targetSegmentId: msg.targetSegmentId || null
              });
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetSchemaPath));
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          } else if (msg.type === 'queryRepeatEntries') {
            const result = queryRepeatEntries(filePath, msg.schema, msg.options || {});
            panel.webview.postMessage({ type: 'repeatEntriesResult', result });
          } else if (msg.type === 'scanProtocolPackets') {
            const result = scanProtocolPackets(filePath, msg.schema, msg.options || {});
            panel.webview.postMessage({ type: 'protocolPacketsResult', result });
          } else if (msg.type === 'loadHexPage') {
            const offset = Math.max(0, Number(msg.offset) || 0);
            const length = Number(msg.length) || DEFAULT_HEX_PAGE_SIZE;
            const chunk = readFileChunk(filePath, offset, length);
            panel.webview.postMessage({ type: 'hexPageData', chunk });
          } else if (msg.type === 'loadSchemaFromFile') {
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: true,
              openLabel: 'Load *.binsight.json Schema',
              filters: {
                'Binsight JSON Schema (*.binsight.json, *.json)': ['json'],
                'All Files': ['*']
              }
            });
            if (picked && picked.length > 0) {
              const loadedSchemas = picked.map((uri) => loadSchemaFromFile(uri.fsPath));
              panel.webview.postMessage({
                type: 'schemasLoaded',
                schemas: loadedSchemas,
                targetSegmentId: msg.targetSegmentId || null
              });
              vscode.window.setStatusBarMessage(
                `$(check) Binsight: Loaded ${loadedSchemas.length} schema file(s)`,
                3000
              );
            }
          } else if (msg.type === 'saveLayoutProfile') {
            const defaultUri = vscode.Uri.file(
              path.join(path.dirname(filePath), `${path.parse(fileName).name}.binsight-layout.json`)
            );
            const saveUri = await vscode.window.showSaveDialog({
              defaultUri,
              saveLabel: 'Save Multi-Segment Layout Profile',
              filters: { 'Binsight Layout Profile': ['json'] }
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
                  hwBaseAddress:
                    '0x' + Number(s.hwBaseAddress || 0).toString(16).toUpperCase().padStart(8, '0'),
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
              vscode.window.showInformationMessage(
                `Binsight: Saved Layout Profile to ${path.basename(saveUri.fsPath)}`
              );
            }
          } else if (msg.type === 'loadLayoutProfileFromFile') {
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: false,
              openLabel: 'Load *.binsight-layout.json Profile',
              filters: {
                'Binsight Layout Profile (*.binsight-layout.json, *.json)': ['json'],
                'All Files': ['*']
              }
            });
            if (picked && picked.length > 0) {
              const layoutPath = picked[0].fsPath;
              const hydrated = hydrateLayoutFromFile(layoutPath, filePath, baselineFilePath);
              panel.webview.postMessage({
                type: 'layoutProfileHydrated',
                layout: hydrated.layout,
                extraSchemas: hydrated.extraSchemas,
                hydratedSegments: hydrated.hydratedSegments
              });
              vscode.window.showInformationMessage(
                `Binsight: Loaded layout "${hydrated.layout.name}" (${hydrated.hydratedSegments.length} segments)`
              );
            }
          } else if (msg.type === 'applyDiscoveredLayout') {
            const hydrated = hydrateLayoutFromFile(msg.layoutFilePath, filePath, baselineFilePath);
            panel.webview.postMessage({
              type: 'layoutProfileHydrated',
              layout: hydrated.layout,
              extraSchemas: hydrated.extraSchemas,
              hydratedSegments: hydrated.hydratedSegments
            });
          } else if (msg.type === 'savePatchedBinaryAsNew') {
            const defaultUri = vscode.Uri.file(
              path.join(path.dirname(filePath), `${path.parse(fileName).name}_modified.bin`)
            );
            const saveUri = await vscode.window.showSaveDialog({
              defaultUri,
              saveLabel: 'Save As New Binary (.bin)',
              filters: { 'Binary Files': ['bin', 'raw', 'dat'], 'All Files': ['*'] }
            });
            if (saveUri) {
              savePatchedBinary(filePath, saveUri.fsPath, msg.patches || []);
              vscode.window.showInformationMessage(
                `Binsight: Saved modified binary to ${path.basename(saveUri.fsPath)}`
              );
            }
          } else if (msg.type === 'saveRegisterReport') {
            const defaultUri = vscode.Uri.file(
              path.join(path.dirname(filePath), `${path.parse(fileName).name}_report.txt`)
            );
            const saveUri = await vscode.window.showSaveDialog({
              defaultUri,
              saveLabel: 'Export Multi-Segment Report (.txt)',
              filters: { 'Text Report': ['txt', 'log'], 'All Files': ['*'] }
            });
            if (saveUri) {
              fs.writeFileSync(saveUri.fsPath, String(msg.content || ''), 'utf8');
              vscode.window.showInformationMessage(
                `Binsight: Exported report to ${path.basename(saveUri.fsPath)}`
              );
            }
          } else if (msg.type === 'copyText') {
            await vscode.env.clipboard.writeText(String(msg.text || ''));
            vscode.window.setStatusBarMessage('$(check) Binsight: Copied to clipboard', 2500);
          }
        } catch (e) {
          vscode.window.showErrorMessage(`Binsight Error: ${e.message}`);
        }
      },
      undefined,
      context.subscriptions
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Binsight failed to open file: ${err.message}`);
  }
}

/**
 * Generate Geek / Hardware Debugger HUD HTML for Webview
 */
function getWebviewHtml(context, webview, initialReport) {
  const mediaDir = path.join(context.extensionPath, 'media');
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'main.css')));
  const nonce = getNonce();
  const scriptFiles = [
    'core.js',
    'modes/registerMap.js',
    'modes/structList.js',
    'modes/repeatStruct.js',
    'modes/protocol.js',
    'modes/hexOverview.js',
    'main.js'
  ];
  const scriptsHtml = scriptFiles
    .map((rel) => {
      const uri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, rel)));
      return `<script nonce="${nonce}" src="${uri}"></script>`;
    })
    .join('\n  ');
  const serializedReport = JSON.stringify(initialReport).replace(/</g, '\\u003c');
  const template = fs.readFileSync(path.join(mediaDir, 'webview.html'), 'utf8');

  return template
    .replaceAll('{{CSP_SOURCE}}', webview.cspSource)
    .replaceAll('{{NONCE}}', nonce)
    .replaceAll('{{STYLE_URI}}', String(styleUri))
    .replaceAll('{{TITLE_FILE_NAME}}', escapeHtml(initialReport.fileName))
    .replaceAll('{{FILE_PATH}}', escapeHtml(initialReport.filePath))
    .replaceAll('{{FILE_NAME}}', escapeHtml(initialReport.fileName))
    .replaceAll('{{FORMATTED_SIZE}}', escapeHtml(initialReport.formattedSize))
    .replaceAll('{{SERIALIZED_REPORT}}', serializedReport)
    .replaceAll('{{SCRIPTS}}', scriptsHtml);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

class BinsightSidebarProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
  }

  refresh() {
    this._cache = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    const workspaceDirs = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!element) {
      // Single-pass scan for all 3 categories
      this._cache = this._scanAllWorkspaceFiles(workspaceDirs);

      const openItem = new vscode.TreeItem('Open Binary File...', vscode.TreeItemCollapsibleState.None);
      openItem.iconPath = new vscode.ThemeIcon('folder-opened');
      openItem.command = { command: 'binsight.inspectFile', title: 'Inspect Binary File' };

      const binsGroup = new vscode.TreeItem('Binary Files (.bin / .raw / .dat)', vscode.TreeItemCollapsibleState.Expanded);
      binsGroup.contextValue = 'bins';

      const schemasGroup = new vscode.TreeItem('Schemas (*.binsight.json)', vscode.TreeItemCollapsibleState.Expanded);
      schemasGroup.contextValue = 'schemas';

      const layoutsGroup = new vscode.TreeItem('Layout Profiles (*.binsight-layout.json)', vscode.TreeItemCollapsibleState.Collapsed);
      layoutsGroup.contextValue = 'layouts';

      return [openItem, binsGroup, schemasGroup, layoutsGroup];
    }

    if (!this._cache) {
      this._cache = this._scanAllWorkspaceFiles(workspaceDirs);
    }
    const files = this._cache[element.contextValue] || [];
    return files.map((fPath) => {
      const name = path.basename(fPath);
      const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
      item.tooltip = fPath;
      item.description = path.relative(workspaceDirs[0] || path.dirname(fPath), path.dirname(fPath));
      if (element.contextValue === 'bins') {
        item.iconPath = new vscode.ThemeIcon('file-binary');
        item.command = {
          command: 'binsight.inspectFile',
          title: 'Inspect with Binsight',
          arguments: [vscode.Uri.file(fPath)]
        };
      } else {
        item.iconPath = new vscode.ThemeIcon('json');
        item.command = {
          command: 'vscode.open',
          title: 'Open JSON',
          arguments: [vscode.Uri.file(fPath)]
        };
      }
      return item;
    });
  }

  _scanAllWorkspaceFiles(roots) {
    const out = { bins: [], schemas: [], layouts: [] };
    walkWorkspaceFiles(roots, 3, (real, fileName) => {
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.bin') || lower.endsWith('.raw') || lower.endsWith('.dat')) {
        out.bins.push(real);
      } else if (lower.endsWith('.binsight.json')) {
        out.schemas.push(real);
      } else if (lower.endsWith('.binsight-layout.json')) {
        out.layouts.push(real);
      }
    });
    out.bins.sort();
    out.schemas.sort();
    out.layouts.sort();
    return out;
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
