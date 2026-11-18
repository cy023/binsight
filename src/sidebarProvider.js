const vscode = require('vscode');
const path = require('path');
const {walkWorkspaceFiles} = require('./analyzer');

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
      this._cache = this._scanAllWorkspaceFiles(workspaceDirs);

      const openItem = new vscode.TreeItem('Open Binary / Hex File...', vscode.TreeItemCollapsibleState.None);
      openItem.iconPath = new vscode.ThemeIcon('folder-opened');
      openItem.command = {command: 'binsight.inspectFile', title: 'Inspect Binary / Hex File'};

      const pasteItem = new vscode.TreeItem('Inspect Pasted Hex / Text...', vscode.TreeItemCollapsibleState.None);
      pasteItem.iconPath = new vscode.ThemeIcon('clippy');
      pasteItem.command = {command: 'binsight.inspectPastedHex', title: 'Inspect Pasted Hex / Text'};

      const binsGroup = new vscode.TreeItem(
          'Binary / Hex Files (.bin / .raw / .dat / .hex)', vscode.TreeItemCollapsibleState.Expanded);
      binsGroup.contextValue = 'bins';

      const schemasGroup = new vscode.TreeItem('Schemas (*.binsight.json)', vscode.TreeItemCollapsibleState.Expanded);
      schemasGroup.contextValue = 'schemas';

      const layoutsGroup =
          new vscode.TreeItem('Layout Profiles (*.binsight-layout.json)', vscode.TreeItemCollapsibleState.Collapsed);
      layoutsGroup.contextValue = 'layouts';

      return [openItem, pasteItem, binsGroup, schemasGroup, layoutsGroup];
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
        item.command = {command: 'vscode.open', title: 'Open JSON', arguments: [vscode.Uri.file(fPath)]};
      }
      return item;
    });
  }

  _scanAllWorkspaceFiles(roots) {
    const out = {bins: [], schemas: [], layouts: []};
    walkWorkspaceFiles(roots, 3, (real, fileName) => {
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.bin') || lower.endsWith('.raw') || lower.endsWith('.dat') || lower.endsWith('.hex')) {
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

module.exports = {BinsightSidebarProvider};
