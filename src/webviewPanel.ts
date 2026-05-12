/**
 * webviewPanel.ts
 *
 * 【変更点 (main ← gtags マージ)】
 *  - buildGraphMsg: labelFull をソースパネル用に維持し label をノード表示に使用
 *  - HTML 凡例の色変更: 選択中 #00b894 → #97c2fc、caller #0984e3 → #00b894
 *  - HTML から引数表示トグル (sig-toggle) を削除
 *  - CSS の .ctrl-label クラスを削除してインラインスタイルに統一
 *
 * 【追加修正】
 *  - _pendingMessage (単一) → _pendingMessages: object[] (配列) に変更。
 *    ready 受信前に setLoading() → updateGraph() の順で呼ばれた場合に
 *    loading メッセージが消えてしまう問題を修正。(⑤)
 *  - exportHtmlFile: process.env.HOME → os.homedir() に変更。
 *    Windows で HOME 未定義になる問題を修正。(⑦)
 *  - htmlTemplate: スタンドアロン HTML にも CSP メタタグを付与。(⑧)
 *    WebView 版: nonce ベース CSP (既存通り)
 *    スタンドアロン版: script-src 'unsafe-inline' の CSP を追加
 *  - deactivate() で dispose できるよう currentPanel を外部から参照可能にする。(⑨)
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import * as crypto from 'crypto';
import * as os     from 'os';   // ★ ⑦: os.homedir() 用
import { GraphData } from './callGraphBuilder';

const FILE_COLORS_BASE = [
  { background: '#ffeaa7', border: '#fdcb6e' },
  { background: '#fab1a0', border: '#e17055' },
  { background: '#a29bfe', border: '#6c5ce7' },
  { background: '#81ecec', border: '#00cec9' },
  { background: '#55efc4', border: '#00b894' },
  { background: '#fd79a8', border: '#e84393' },
  { background: '#74b9ff', border: '#0984e3' },
  { background: '#dfe6e9', border: '#b2bec3' },
];

function generateFileColors(files: string[]): Record<string, { background: string; border: string }> {
  const map: Record<string, { background: string; border: string }> = {};
  files.forEach((f, i) => {
    map[f] = i < FILE_COLORS_BASE.length
      ? FILE_COLORS_BASE[i]
      : { background: `hsl(${Math.round((i * 360 / files.length) % 360)},65%,80%)`,
          border:     `hsl(${Math.round((i * 360 / files.length) % 360)},65%,55%)` };
  });
  return map;
}

function buildGraphMsg(data: GraphData): object {
  const files      = [...new Set(data.nodes.map(n => n.file))].sort();
  const colorMap   = generateFileColors(files);
  const fileLegend = files.map(f => ({ file: f, color: colorMap[f].background, border: colorMap[f].border }));
  return {
    type: 'graphData',
    nodes: data.nodes.map(n => ({
      id:            n.id,
      label:         n.label,     // 表示用 (短縮名)
      labelFull:     n.labelFull, // ソースパネル用 (フルシグネチャ)
      file:          n.file,
      line:          n.line,
      source:        n.source,
      isCurrentFile: n.isCurrentFile,
      color:  colorMap[n.file] ?? FILE_COLORS_BASE[FILE_COLORS_BASE.length - 1],
      title:  `${n.label}\n${path.basename(n.file)} : ${n.line}行`,
    })),
    edges: data.edges, fileLegend,
    buildTimeMs: data.buildTimeMs, errors: data.errors,
  };
}

function generateStandaloneHtml(extensionUri: vscode.Uri, data: GraphData): string {
  const distDir   = vscode.Uri.joinPath(extensionUri, 'dist').fsPath;
  const visJs     = fs.readFileSync(path.join(distDir, 'vis-network.min.js'), 'utf-8');
  const webviewJs = fs.readFileSync(path.join(distDir, 'webview.js'), 'utf-8');
  const graphMsg  = buildGraphMsg(data);

  // ★ セキュリティ: JSON.stringify は </script> をエスケープしないため
  //   ソースコード中に </script> が含まれると HTML が破壊される (XSS)。
  //   Unicodeエスケープで < と > を無害化する。
  const safeJson = JSON.stringify(graphMsg)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  // ★ ④: visJs / webviewJs をインラインで埋め込む際に </script> が含まれると
  //   ブラウザの HTML パーサーがスクリプトブロックを早期終端してしまう。
  //   </script → <\/script に変換して安全に埋め込む。
  const escapeScript = (s: string): string => s.replace(/<\/script/gi, '<\\/script');

  return htmlTemplate({ kind: 'standalone' }, [
    `<script>var INITIAL_GRAPH_DATA = ${safeJson};</script>`,
    `<script>${escapeScript(visJs)}</script>`,
    `<script>${escapeScript(webviewJs)}</script>`,
  ].join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// CallGraphPanel
// ─────────────────────────────────────────────────────────────────────────────

export class CallGraphPanel {
  public static currentPanel: CallGraphPanel | undefined;

  private readonly _panel:        vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _disposables:  vscode.Disposable[] = [];
  private _isReady          = false;
  // ★ ⑤: 単一メッセージ保留 → キュー方式に変更。
  //   setLoading() → updateGraph() の順で ready 前に呼ばれても
  //   両メッセージが順番通りに届くようにする。
  private _pendingMessages: object[] = [];
  private _lastGraphData:  GraphData | null = null;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel        = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.onDidReceiveMessage(
      async (msg: { type: string; file?: string; line?: number }) => {
        switch (msg.type) {
          case 'ready':
            this._isReady = true;
            // ★ ⑤: キューに溜まったメッセージを順番に送信
            for (const pending of this._pendingMessages) {
              this._panel.webview.postMessage(pending);
            }
            this._pendingMessages = [];
            break;
          case 'openFile':
            if (msg.file && msg.line !== undefined) await this._openFileAtLine(msg.file, msg.line);
            break;
          case 'exportHtml':
            if (this._lastGraphData) await CallGraphPanel.exportHtmlFile(this._extensionUri, this._lastGraphData);
            else vscode.window.showWarningMessage('エクスポートするグラフがありません。');
            break;
        }
      },
      null, this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._buildHtml();
  }

  public static createOrShow(extensionUri: vscode.Uri): CallGraphPanel {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (CallGraphPanel.currentPanel) { CallGraphPanel.currentPanel._panel.reveal(column); return CallGraphPanel.currentPanel; }
    const panel = vscode.window.createWebviewPanel(
      'callGraphViewer', 'Call Map', column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    CallGraphPanel.currentPanel = new CallGraphPanel(panel, extensionUri);
    return CallGraphPanel.currentPanel;
  }

  public setLoading(fileName: string): void {
    this._panel.title = 'Call Map — 解析中...';
    this._postOrQueue({ type: 'loading', fileName });
  }

  public updateGraph(data: GraphData): void {
    this._lastGraphData = data;
    this._panel.title   = `Call Map — ${data.fileName}`;
    this._postOrQueue(buildGraphMsg(data));
  }

  public showError(message: string): void {
    this._panel.title = 'Call Map — エラー';
    this._postOrQueue({ type: 'error', message });
  }

  public static async exportHtmlFile(extensionUri: vscode.Uri, data: GraphData): Promise<void> {
    const wsRoot    = vscode.workspace.workspaceFolders?.[0]?.uri;
    const safeName  = data.fileName.replace(/[^\w.-]/g, '_');
    // ★ ⑦: process.env.HOME → os.homedir() に変更 (Windows 対応)
    const defaultUri = wsRoot
      ? vscode.Uri.joinPath(wsRoot, `callgraph_${safeName}.html`)
      : vscode.Uri.file(path.join(os.homedir(), `callgraph_${safeName}.html`));

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'HTML ファイル': ['html'] },
    });
    if (!saveUri) return;

    try {
      const html = generateStandaloneHtml(extensionUri, data);
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf-8'));
      const open = await vscode.window.showInformationMessage(
        `保存完了: ${path.basename(saveUri.fsPath)}`, 'ブラウザで開く'
      );
      if (open === 'ブラウザで開く') await vscode.env.openExternal(saveUri);
    } catch (e) {
      vscode.window.showErrorMessage(`保存に失敗しました: ${e}`);
    }
  }

  public dispose(): void {
    CallGraphPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }

  private _postOrQueue(msg: object): void {
    if (this._isReady) this._panel.webview.postMessage(msg);
    // ★ ⑤: push で追加 (上書きしない)
    else this._pendingMessages.push(msg);
  }

  private async _openFileAtLine(filePath: string, line: number): Promise<void> {
    // ★ ⑤: webview メッセージ経由で任意パスが渡される可能性を防ぐ。
    //   ワークスペースフォルダのいずれかの配下にあるファイルのみ許可する。
    //   ワークスペースが未設定の場合は制限なし (単一ファイル編集モード)。
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const inWorkspace = wsRoots.length === 0
      || wsRoots.some(r => filePath === r
          || filePath.startsWith(r + path.sep)
          || filePath.startsWith(r + '/'));
    if (!inWorkspace) {
      vscode.window.showErrorMessage(
        `Call Map: ワークスペース外のファイルは開けません:\n${filePath}`);
      return;
    }
    try {
      const uri = vscode.Uri.file(filePath);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
    } catch {
      vscode.window.showErrorMessage(`ファイルを開けませんでした: ${filePath}`);
    }
  }

  private _buildHtml(): string {
    const nonce      = crypto.randomBytes(16).toString('hex');
    const webview    = this._panel.webview;
    const distDir    = vscode.Uri.joinPath(this._extensionUri, 'dist');
    const visUri     = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'vis-network.min.js'));
    const webviewUri = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview.js'));

    // ★ ⑥: 型安全な mode オブジェクトを渡す
    return htmlTemplate(
      { kind: 'webview', nonce, cspSource: webview.cspSource },
      `<script nonce="${nonce}" src="${visUri}"></script>\n<script nonce="${nonce}" src="${webviewUri}"></script>`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML テンプレート (WebView / スタンドアロン 共用)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ ⑥: モード判定を文字列比較から判別可能な共用体型に変更。
 *   nonce が空文字列だった場合に誤って standalone 扱いになるバグを型レベルで排除する。
 */
type HtmlTemplateMode =
  | { kind: 'webview';    nonce: string; cspSource: string }
  | { kind: 'standalone' };

function htmlTemplate(mode: HtmlTemplateMode, scripts: string): string {
  const cspMeta = mode.kind === 'webview'
    ? `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'nonce-${mode.nonce}' ${mode.cspSource}; style-src 'unsafe-inline';">`
    : `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
${cspMeta}
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #f8f9fa; }
#network { width: 100%; height: 100vh; }
div.vis-network div.vis-navigation div.vis-button {
  background-color: transparent !important; border-radius: 4px !important;
  border: none !important; filter: grayscale(100%) brightness(0.6) !important;
  opacity: 0.65; transition: opacity 0.15s;
}
div.vis-network div.vis-navigation div.vis-button:hover { background-color: rgba(100,100,100,0.15) !important; opacity: 1.0; }
div.vis-network div.vis-navigation div.vis-button.vis-up    { left: 38px !important; bottom: 76px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-left  { left:  0px !important; bottom: 38px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-right { left: 76px !important; bottom: 38px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-down  { left: 38px !important; bottom:  0px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-zoomIn      { left: 122px !important; bottom: 76px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-zoomExtends { left: 122px !important; bottom: 38px !important; right: auto !important; }
div.vis-network div.vis-navigation div.vis-button.vis-zoomOut     { left: 122px !important; bottom:  0px !important; right: auto !important; }
#controls {
  position: fixed; top: 12px; left: 12px; z-index: 999;
  background: rgba(255,255,255,0.95); border: 1px solid #ddd;
  border-radius: 8px; padding: 12px 14px; font-family: monospace;
  font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  min-width: 230px; line-height: 1.8;
}
#search-box {
  width: 100%; padding: 5px 8px; border: 1px solid #b2bec3;
  border-radius: 5px; font-family: monospace; font-size: 12px;
  outline: none; margin-bottom: 8px; box-sizing: border-box;
}
.hop-btn { flex: 1; padding: 4px 0; border: 1px solid #b2bec3; border-radius: 4px; cursor: pointer; background: #dfe6e9; font-family: monospace; font-size: 12px; }
.hop-btn.active { background: #636e72 !important; color: #fff !important; }
#source-panel {
  display: none; position: fixed; top: 0; right: 0; bottom: 0;
  width: 40%; max-width: 600px; z-index: 998;
  background: #1e1e2e; color: #cdd6f4; font-family: monospace; font-size: 13px;
  flex-direction: column; border-left: 2px solid #45475a; box-shadow: -4px 0 16px rgba(0,0,0,0.2);
}
#source-placeholder { display: flex; flex: 1; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: #6c7086; }
#source-content { display: none; flex-direction: column; flex: 1; overflow: hidden; }
#source-code { margin: 0; padding: 16px; overflow: auto; flex: 1; line-height: 1.6; white-space: pre; color: #cdd6f4; background: #1e1e2e; }
#loading-overlay {
  display: none; position: fixed; inset: 0; z-index: 9999;
  background: rgba(248,249,250,0.92); align-items: center; justify-content: center;
  flex-direction: column; gap: 16px; font-family: monospace;
}
.spinner { width: 36px; height: 36px; border: 3px solid #dfe6e9; border-top-color: #00b894; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="network"></div>

<div id="controls">
  <b style="font-size:13px;">📞 Call Map</b>
  <div style="color:#636e72;font-size:11px;margin:2px 0 8px;">
    <b style="color:#97c2fc;">●</b> 選択中 &nbsp;
    <b style="color:#e17055;">●</b> callee &nbsp;
    <b style="color:#00b894;">●</b> caller &nbsp;
    <span style="color:#aaa;font-size:10px;">Ctrl+クリック→ジャンプ</span>
  </div>
  <input id="search-box" type="text" placeholder="🔍 関数名を検索">

  <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;color:#2d3436;margin-bottom:4px;">
    <input id="src-toggle" type="checkbox" style="cursor:pointer;"> ソースコードパネルを表示
  </label>
  <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:#636e72;margin-bottom:6px;">
    <label for="font-size-input" style="white-space:nowrap;">文字サイズ:</label>
    <input id="font-size-input" type="number" value="11" min="6" max="64"
      style="width:46px;padding:2px 5px;border:1px solid #b2bec3;border-radius:4px;font-family:monospace;font-size:11px;text-align:center;outline:none;">
    <button id="font-size-reset" style="padding:2px 7px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-family:monospace;font-size:11px;cursor:pointer;color:#636e72;">Default</button>
  </div>
  <button id="export-btn" style="width:100%;padding:5px 0;margin-bottom:6px;border:1px solid #b2bec3;border-radius:4px;background:#f8f9fa;font-family:monospace;font-size:11px;cursor:pointer;color:#2d3436;">
    💾 HTML として保存
  </button>
  <div id="hop-panel" style="display:none;margin-top:2px;">
    <div style="color:#636e72;font-size:11px;margin-bottom:4px;">表示範囲（ホップ数）:</div>
    <div style="display:flex;gap:5px;">
      <button class="hop-btn" data-hop="1">1</button>
      <button class="hop-btn" data-hop="2">2</button>
      <button class="hop-btn" data-hop="3">3</button>
      <button class="hop-btn" data-hop="null">All</button>
    </div>
  </div>
  <div style="margin-top:10px;border-top:1px solid #ddd;padding-top:8px;">
    <div style="color:#636e72;font-size:11px;margin-bottom:5px;">ファイル凡例:</div>
    <div id="legend-items"></div>
  </div>
  <div id="build-info" style="margin-top:8px;border-top:1px solid #ddd;padding-top:6px;color:#b2bec3;font-size:10px;"></div>
</div>

<div id="source-panel">
  <div id="source-placeholder">
    <span style="font-size:28px;">←</span>
    <span style="font-size:13px;">ノードをクリックしてください</span>
    <span style="font-size:11px;color:#6c7086;">Ctrl+クリックでエディタへジャンプ</span>
  </div>
  <div id="source-content">
    <div style="padding:10px 16px;background:#181825;border-bottom:1px solid #45475a;display:flex;justify-content:space-between;align-items:flex-start;flex-shrink:0;">
      <div>
        <span id="source-func-name" style="color:#89b4fa;font-weight:bold;font-size:14px;"></span><br>
        <span id="source-file-info" style="color:#6c7086;font-size:11px;"></span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-left:8px;">
        <button id="goto-btn" style="background:#313244;border:1px solid #45475a;color:#cdd6f4;cursor:pointer;padding:4px 10px;border-radius:4px;font-family:monospace;font-size:11px;">▷ ソースへジャンプ</button>
        <button id="src-close-btn" style="background:none;border:none;color:#6c7086;cursor:pointer;font-size:16px;">✕</button>
      </div>
    </div>
    <pre id="source-code"></pre>
  </div>
</div>

<div id="loading-overlay">
  <div class="spinner"></div>
  <div id="loading-msg" style="font-family:monospace;color:#636e72;font-size:13px;">解析中...</div>
</div>

${scripts}
</body>
</html>`;
}