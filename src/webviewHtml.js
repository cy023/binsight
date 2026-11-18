const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Generate Hardware Debugger HUD HTML for Webview
 */
function getWebviewHtml(context, webview, initialReport) {
  const mediaDir = path.join(context.extensionPath, 'media');
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'main.css')));
  const nonce = getNonce();
  const scriptFiles = [
    'core/math.js', 'core/protocolRenderer.js', 'core/ui.js', 'core.js', 'modes/hexEditor.js',
    'modes/structView.js', 'modes/recordTrace.js', 'modes/protocolAnalyze.js', 'modes/registers/state.js',
    'modes/registers/render.js', 'modes/registers/index.js', 'main.js'
  ];
  const scriptsHtml = scriptFiles
                          .map((rel) => {
                            const uri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, rel)));
                            return `<script nonce="${nonce}" src="${uri}"></script>`;
                          })
                          .join('\n  ');
  const serializedReport = JSON.stringify(initialReport).replace(/</g, '\\u003c');
  const template = fs.readFileSync(path.join(mediaDir, 'webview.html'), 'utf8');

  return template.replaceAll('{{CSP_SOURCE}}', webview.cspSource)
      .replaceAll('{{NONCE}}', nonce)
      .replaceAll('{{STYLE_URI}}', String(styleUri))
      .replaceAll('{{TITLE_FILE_NAME}}', escapeHtml(initialReport.fileName))
      .replaceAll('{{FILE_PATH}}', escapeHtml(initialReport.filePath))
      .replaceAll('{{FILE_NAME}}', escapeHtml(initialReport.fileName))
      .replaceAll('{{FORMATTED_SIZE}}', escapeHtml(initialReport.formattedSize))
      .replaceAll('{{SERIALIZED_REPORT}}', serializedReport)
      .replaceAll('{{SCRIPTS}}', scriptsHtml);
}

module.exports = {getWebviewHtml};
