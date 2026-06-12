/**
 * webviewPanel.ts  ─  WebView パネル管理
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import * as crypto from 'crypto';
import * as os     from 'os';
import { GraphData, MAX_SOURCE_LINES } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// パスセキュリティユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebView から渡されたファイルパスを安全に正規化する。
 *
 * path.normalize のみでは "../../etc/passwd" のような相対パスを
 * startsWith でのワークスペースチェックが弾けない場合がある。
 * path.resolve で絶対パスに変換した上で比較することで
 * ディレクトリトラバーサルを確実に防ぐ。
 *
 * シンボリックリンクパストラバーサル対策:
 *   path.resolve はシンボリックリンクを解決しないため、
 *   ワークスペース内のシンボリックリンク → ワークスペース外ファイル という経路が
 *   isPathInWorkspace のチェックを通過し、fs.readFile で実体ファイルを読まれる恐れがある。
 *   fs.realpathSync でシンボリックリンクを解決してから比較する。
 *   ファイルが存在しない場合は null を返してアクセスを拒否する。
 *
 * macOS / Windows では大文字小文字を統一するため toLowerCase() を適用する。
 */
function resolveAndNormalize(p: string): string | null {
  const resolved = path.resolve(p);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  return (process.platform === 'win32' || process.platform === 'darwin')
    ? real.toLowerCase() : real;
}

/**
 * filePath がワークスペースルートのいずれかの配下にあるか検証する。
 *
 * wsRoots が空（単一ファイル編集モード）のときは allowedFiles（現グラフに含まれるファイル）
 * にフォールバックする。wsRoots が空のときに無条件で true を返すと、
 * WebView から任意のパス（/etc/passwd 等）を要求できる脆弱性になる。
 */
function isPathInWorkspace(
  filePath:     string,
  wsRoots:      string[],
  allowedFiles: ReadonlySet<string>
): boolean {
  const fileResolved = resolveAndNormalize(filePath);
  if (fileResolved === null) return false;
  // ワークスペースが開いている場合: フォルダ配下かどうかで判断
  if (wsRoots.length > 0) {
    return wsRoots.some(r => {
      const rResolved = resolveAndNormalize(r);
      if (rResolved === null) return false;
      return fileResolved === rResolved
        || fileResolved.startsWith(rResolved + path.sep)
        || fileResolved.startsWith(rResolved + '/');
    });
  }
  // ワークスペースなし（単一ファイル編集モード）: グラフに含まれるファイルのみ許可
  if (allowedFiles.size > 0) {
    return allowedFiles.has(fileResolved);
  }
  // グラフもまだ無い状態（初期化中）: 安全のため拒否
  return false;
}

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
  const extra = files.length - FILE_COLORS_BASE.length; // プリセット外のファイル数
  files.forEach((f, i) => {
    if (i < FILE_COLORS_BASE.length) {
      map[f] = FILE_COLORS_BASE[i];
    } else {
      // プリセット以降を 0 から数え直し、extra 個を色相環で均等配置する
      const hue = Math.round(((i - FILE_COLORS_BASE.length) * 360 / Math.max(1, extra)) % 360);
      map[f] = {
        background: `hsl(${hue},65%,80%)`,
        border:     `hsl(${hue},65%,55%)`,
      };
    }
  });
  return map;
}

/**
 * vis-network の title プロパティ用 HTML エスケープ。
 * vis-network v9 は string 型の title を innerHTML で挿入するため、
 * ファイル名などに HTML メタ文字が含まれると XSS になる。
 * &, <, >, ", ' の5文字を安全な HTML エンティティに変換する。
 * 改行は <br> に変換し、ツールチップの表示を維持する。
 */
function escapeHtmlForTitle(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;')
    .replace(/\n/g, '<br>');
}

function buildGraphMsg(data: GraphData): object {
  const files      = [...new Set(data.nodes.map(n => n.file))].sort();
  const colorMap   = generateFileColors(files);
  const fileLegend = files.map(f => ({ file: f, color: colorMap[f].background, border: colorMap[f].border }));
  return {
    type: 'graphData',
    nodes: data.nodes.map(n => ({
      id:            n.id,
      label:         n.label,
      labelFull:     n.labelFull,
      file:          n.file,
      line:          n.line,
      scopeEnd:      n.scopeEnd,   // lazy source 読み込み用（通常は source を送らない）
      isCurrentFile: n.isCurrentFile,
      color:  colorMap[n.file] ?? FILE_COLORS_BASE[FILE_COLORS_BASE.length - 1],
      // vis-network v9 は title を innerHTML でレンダリングするため XSS 対策が必要
      title:  escapeHtmlForTitle(`${n.label}\n${path.basename(n.file)} : line ${n.line}`),
    })),
    edges: data.edges, fileLegend,
    buildTimeMs: data.buildTimeMs, errors: data.errors,
    // callmap.initialControlPanel 設定値をメッセージに含める。
    // webview.js の renderGraph で setControlsCollapsed() に渡して初期状態を適用する。
    controlPanelCollapsed: vscode.workspace.getConfiguration('callmap')
      .get<string>('initialControlPanel', 'expanded') === 'collapsed',
  };
}

// vis-network.min.js / webview.js のインメモリキャッシュ。
// HTML エクスポートのたびに約 1MB の vis-network.min.js を readFile するのを避ける。
// Promise シングルトンパターンで並行呼び出し時の二重読み込みも防ぐ。
// 拡張機能のバージョンアップ時はプロセス再起動されるためキャッシュは常に有効。
let _filesCachePromise: Promise<[string, string]> | undefined;

async function generateStandaloneHtml(extensionUri: vscode.Uri, data: GraphData): Promise<string> {
  const distDir   = vscode.Uri.joinPath(extensionUri, 'dist').fsPath;
  // if チェックと await の間に別呼び出しが入っても Promise を再利用するため二重読み込みしない。
  // readFile が失敗した場合は catch でキャッシュをクリアして次回再試行を可能にする。
  if (!_filesCachePromise) {
    _filesCachePromise = Promise.all([
      fs.promises.readFile(path.join(distDir, 'vis-network.min.js'), 'utf-8'),
      fs.promises.readFile(path.join(distDir, 'webview.js'),         'utf-8'),
    ]).catch(err => {
      _filesCachePromise = undefined; // エラー時はキャッシュをクリアして次回再試行を可能にする
      throw err;
    });
  }
  const [visJs, webviewJs] = await _filesCachePromise;
  const graphMsg  = buildGraphMsg(data);

  // JSON.stringify は </script> をエスケープしないためソースコード中に含まれると HTML が破壊される。
  // Unicodeエスケープで < と > を無害化する。
  // U+2028 / U+2029 も一部パーサーで改行扱いされるためエスケープする。
  const safeJson = JSON.stringify(graphMsg)
    .replace(/</g,      '\\u003c')
    .replace(/>/g,      '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  // visJs / webviewJs をインラインで埋め込む際に </script> が含まれると
  // ブラウザの HTML パーサーがスクリプトブロックを早期終端してしまうため変換する。
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
  // ready 受信前に複数メッセージが積まれても順番通りに届くようキュー方式にする
  private _pendingMessages: object[] = [];
  private _lastGraphData:  GraphData | null = null;
  // wsRoots が空の単一ファイル編集モードでのアクセス制限用に
  // グラフに含まれるファイルパス（正規化済み）のセットを保持する
  private _allowedFiles: Set<string> = new Set();

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel        = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.onDidReceiveMessage(
      async (msg: { type: string; file?: string; line?: number }) => {
        switch (msg.type) {
          case 'ready':
            this._isReady = true;
            for (const pending of this._pendingMessages) {
              this._panel.webview.postMessage(pending);
            }
            this._pendingMessages = [];
            break;
          case 'openFile':
            if (msg.file && msg.line !== undefined) await this._openFileAtLine(msg.file, msg.line);
            break;
          case 'requestSource': {
            // ソース遅延読み込み: ノードクリック時にファイルを読んで返す
            // msg の宣言型に nodeId が含まれないため unknown 経由でキャストする
            const req = msg as unknown as { nodeId: string; file: string; line: number; scopeEnd?: number };
            const { nodeId, file, line, scopeEnd } = req;
            if (!file || line === undefined) break;
            // WebView 由来の nodeId は型・長さを検証する
            if (!nodeId || typeof nodeId !== 'string' || nodeId.length > 1000) break;
            const wsRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
            if (!isPathInWorkspace(file, wsRoots, this._allowedFiles)) break;
            // TOCTOU 対策: isPathInWorkspace のチェック後に realpath を再取得して
            // 「チェックしたパス = 読み取るパス」を一致させる
            let resolvedFile: string;
            try {
              resolvedFile = await fs.promises.realpath(path.resolve(file));
            } catch {
              break;
            }
            // 解決済みパスで再チェック（シンボリックリンクが変更された場合の二重確認）
            if (!isPathInWorkspace(resolvedFile, wsRoots, this._allowedFiles)) break;
            try {
              const content = await fs.promises.readFile(resolvedFile, 'utf-8');
              const lines   = content.split('\n');
              const startIdx = Math.max(0, line - 1);
              // WebView 由来の scopeEnd が NaN/Infinity の場合に備えて有限な正の整数のみ受け入れる
              const safeScopeEnd = (typeof scopeEnd === 'number' && isFinite(scopeEnd) && scopeEnd > 0)
                ? scopeEnd : undefined;
              const endIdx   = safeScopeEnd !== undefined
                ? Math.min(safeScopeEnd, startIdx + MAX_SOURCE_LINES, lines.length)
                : Math.min(startIdx + MAX_SOURCE_LINES, lines.length);
              const source = lines.slice(startIdx, endIdx).join('\n');
              this._panel.webview.postMessage({ type: 'sourceData', nodeId, source });
            } catch {
              this._panel.webview.postMessage({ type: 'sourceData', nodeId, source: '// Could not read source' });
            }
            break;
          }
          case 'exportHtml':
            if (this._lastGraphData) await CallGraphPanel.exportHtmlFile(this._extensionUri, this._lastGraphData);
            else vscode.window.showWarningMessage('No graph data to export.');
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
    this._panel.title = 'Call Map — Analyzing...';
    this._postOrQueue({ type: 'loading', fileName });
  }

  public updateGraph(data: GraphData): void {
    this._lastGraphData = data;
    this._panel.title   = `Call Map — ${data.fileName}`;
    this._allowedFiles = new Set(
      data.nodes.map(n => resolveAndNormalize(n.file)).filter((p): p is string => p !== null)
    );
    this._postOrQueue(buildGraphMsg(data));
  }

  public showError(message: string): void {
    this._panel.title = 'Call Map — Error';
    this._postOrQueue({ type: 'error', message });
  }

  public static async exportHtmlFile(extensionUri: vscode.Uri, data: GraphData): Promise<void> {
    const wsRoot    = vscode.workspace.workspaceFolders?.[0]?.uri;
    // FS 危険文字のみ除去し、空白は _ に、連続 _ は畳む。最大 80 文字。
    const safeName = data.fileName
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g,  '_')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 80) || 'graph';
    // ワークスペースがない場合は os.homedir() を使用（Windows で HOME 未定義になる問題に対応）
    const defaultUri = wsRoot
      ? vscode.Uri.joinPath(wsRoot, `callgraph_${safeName}.html`)
      : vscode.Uri.file(path.join(os.homedir(), `callgraph_${safeName}.html`));

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'HTML File': ['html'] },
    });
    if (!saveUri) return;

    try {
      const html = await generateStandaloneHtml(extensionUri, data);
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf-8'));
      const open = await vscode.window.showInformationMessage(
        `Saved: ${path.basename(saveUri.fsPath)}`, 'Open in Browser'
      );
      if (open === 'Open in Browser') await vscode.env.openExternal(saveUri);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to save: ${e}`);
    }
  }

  public dispose(): void {
    CallGraphPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }

  private _postOrQueue(msg: object): void {
    if (this._isReady) this._panel.webview.postMessage(msg);
    else this._pendingMessages.push(msg);
  }

  private async _openFileAtLine(filePath: string, line: number): Promise<void> {
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    if (!isPathInWorkspace(filePath, wsRoots, this._allowedFiles)) {
      vscode.window.showErrorMessage(
        `Call Map: Cannot open file outside workspace:\n${filePath}`);
      return;
    }
    // TOCTOU 対策: 検証済みの実パスで URI を生成する
    let resolvedPath: string;
    try {
      resolvedPath = await fs.promises.realpath(path.resolve(filePath));
    } catch {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
      return;
    }
    // 解決後のパスで再チェック（シンボリックリンクが変更された場合の二重確認）
    if (!isPathInWorkspace(resolvedPath, wsRoots, this._allowedFiles)) {
      vscode.window.showErrorMessage(
        `Call Map: Cannot open file outside workspace:\n${resolvedPath}`);
      return;
    }
    try {
      const uri = vscode.Uri.file(resolvedPath);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
    } catch {
      vscode.window.showErrorMessage(`Could not open file: ${resolvedPath}`);
    }
  }

  private _buildHtml(): string {
    const nonce      = crypto.randomBytes(16).toString('hex');
    const webview    = this._panel.webview;
    const distDir    = vscode.Uri.joinPath(this._extensionUri, 'dist');
    const visUri     = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'vis-network.min.js'));
    const webviewUri = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview.js'));

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
 * webview / standalone の判別を共用体型で行う。
 * nonce が空文字列のときに誤って standalone 扱いになるバグを型レベルで排除する。
 */
type HtmlTemplateMode =
  | { kind: 'webview';    nonce: string; cspSource: string }
  | { kind: 'standalone' };

function htmlTemplate(mode: HtmlTemplateMode, scripts: string): string {
  const cspMeta = mode.kind === 'webview'
    ? `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'nonce-${mode.nonce}' ${mode.cspSource}; style-src 'unsafe-inline'; img-src data: blob:;">`
    : `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; object-src 'none'; base-uri 'none';">`;

  return `<!DOCTYPE html>
<html lang="en">
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
  width: auto; line-height: 1.8;
}
#search-box {
  width: 100%; padding: 5px 8px; border: 1px solid #b2bec3;
  border-radius: 5px; font-family: monospace; font-size: 12px;
  outline: none; margin-bottom: 8px; box-sizing: border-box;
}
.hop-btn { flex: 1; padding: 4px 0; border: 1px solid #b2bec3; border-radius: 4px; cursor: pointer; background: #dfe6e9; font-family: monospace; font-size: 12px; }
.hop-btn.active { background: #636e72 !important; color: #fff !important; }
.search-mode-btn { flex: 1; padding: 3px 0; border: 1px solid #b2bec3; cursor: pointer; background: #dfe6e9; font-family: monospace; font-size: 11px; color: #636e72; }
.search-mode-btn:first-child { border-radius: 4px 0 0 4px; }
.search-mode-btn:last-child  { border-radius: 0 4px 4px 0; border-left: none; }
.search-mode-btn.active { background: #636e72 !important; color: #fff !important; }
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
/* ネイティブ number スピナーを非表示にして見切れを防ぐ */
#font-size-input::-webkit-inner-spin-button,
#font-size-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
#font-size-input { -moz-appearance: textfield; text-align: center; }
/* コントロールパネル折りたたみ */
#controls-toggle {
  background: none; border: none; cursor: pointer;
  font-size: 12px; color: #636e72; padding: 0 2px; line-height: 1;
  transition: transform 0.15s;
}
#controls-toggle.collapsed { transform: rotate(-90deg); }
#controls-body { overflow: hidden; }
</style>
</head>
<body>
<div id="network"></div>

<div id="controls">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
    <b style="font-size:13px;">📞 Call Map</b>
    <button id="controls-toggle" title="Collapse panel">▼</button>
  </div>
  <div id="controls-body">
  <div style="color:#636e72;font-size:11px;margin:2px 0 8px;">
    <b style="color:#97c2fc;">●</b> selected &nbsp;
    <b style="color:#e17055;">●</b> callee &nbsp;
    <b style="color:#00b894;">●</b> caller &nbsp;
    <span style="color:#aaa;font-size:10px;">Ctrl+Click to jump</span>
  </div>
  <div style="display:flex;margin-bottom:4px;">
    <button class="search-mode-btn active" id="search-mode-func" title="Search by function name">func</button>
    <button class="search-mode-btn active" id="search-mode-file" title="Search by file name">file</button>
  </div>
  <input id="search-box" type="text" placeholder="🔍 Search">

  <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;color:#2d3436;margin-bottom:4px;">
    <input id="sig-toggle" type="checkbox" style="cursor:pointer;"> Show parameters
  </label>
  <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;color:#2d3436;margin-bottom:4px;">
    <input id="src-toggle" type="checkbox" style="cursor:pointer;"> Show source panel
  </label>
  <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:#636e72;margin-bottom:6px;">
    <label for="font-size-input" style="white-space:nowrap;">Font size:</label>
    <button id="font-size-down" style="width:22px;height:22px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-size:13px;line-height:1;cursor:pointer;color:#636e72;padding:0;display:flex;align-items:center;justify-content:center;">－</button>
    <input id="font-size-input" type="number" value="11" min="6" max="64"
      style="width:38px;height:22px;padding:0 2px;border:1px solid #b2bec3;border-radius:4px;font-family:monospace;font-size:11px;outline:none;">
    <button id="font-size-up" style="width:22px;height:22px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-size:13px;line-height:1;cursor:pointer;color:#636e72;padding:0;display:flex;align-items:center;justify-content:center;">＋</button>
    <button id="font-size-reset" style="padding:2px 7px;height:22px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-family:monospace;font-size:11px;cursor:pointer;color:#636e72;">Reset</button>
  </div>
  <button id="export-btn" style="width:100%;padding:5px 0;margin-bottom:6px;border:1px solid #b2bec3;border-radius:4px;background:#f8f9fa;font-family:monospace;font-size:11px;cursor:pointer;color:#2d3436;">
    💾 Save as HTML
  </button>
  <div id="hop-panel" style="display:none;margin-top:2px;">
    <div style="color:#636e72;font-size:11px;margin-bottom:4px;">Hop filter:</div>
    <div style="display:flex;gap:5px;">
      <button class="hop-btn" data-hop="1">1</button>
      <button class="hop-btn" data-hop="2">2</button>
      <button class="hop-btn" data-hop="3">3</button>
      <button class="hop-btn" data-hop="all">All</button>
    </div>
  </div>
  <div style="margin-top:10px;border-top:1px solid #ddd;padding-top:8px;">
    <div style="color:#636e72;font-size:11px;margin-bottom:5px;">File legend:</div>
    <div id="legend-items"></div>
  </div>
  <div id="build-info" style="margin-top:8px;border-top:1px solid #ddd;padding-top:6px;color:#b2bec3;font-size:10px;"></div>
  </div><!-- #controls-body -->
</div>

<div id="source-panel">
  <div id="source-placeholder">
    <span style="font-size:28px;">←</span>
    <span style="font-size:13px;">Click a node</span>
    <span style="font-size:11px;color:#6c7086;">Ctrl+Click to jump to editor</span>
  </div>
  <div id="source-content">
    <div style="padding:10px 16px;background:#181825;border-bottom:1px solid #45475a;display:flex;justify-content:space-between;align-items:flex-start;flex-shrink:0;">
      <div>
        <span id="source-func-name" style="color:#89b4fa;font-weight:bold;font-size:14px;"></span><br>
        <span id="source-file-info" style="color:#6c7086;font-size:11px;"></span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-left:8px;">
        <button id="goto-btn" style="background:#313244;border:1px solid #45475a;color:#cdd6f4;cursor:pointer;padding:4px 10px;border-radius:4px;font-family:monospace;font-size:11px;">▷ Go to source</button>
        <button id="src-close-btn" style="background:none;border:none;color:#6c7086;cursor:pointer;font-size:16px;">✕</button>
      </div>
    </div>
    <pre id="source-code"></pre>
  </div>
</div>

<div id="loading-overlay">
  <div class="spinner"></div>
  <div id="loading-msg" style="font-family:monospace;color:#636e72;font-size:13px;">Analyzing...</div>
</div>

${scripts}
</body>
</html>`;
}