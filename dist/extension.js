"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode3 = __toESM(require("vscode"));
var path3 = __toESM(require("path"));

// src/webviewPanel.ts
var vscode = __toESM(require("vscode"));
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var crypto = __toESM(require("crypto"));
var os = __toESM(require("os"));
var FILE_COLORS_BASE = [
  { background: "#ffeaa7", border: "#fdcb6e" },
  { background: "#fab1a0", border: "#e17055" },
  { background: "#a29bfe", border: "#6c5ce7" },
  { background: "#81ecec", border: "#00cec9" },
  { background: "#55efc4", border: "#00b894" },
  { background: "#fd79a8", border: "#e84393" },
  { background: "#74b9ff", border: "#0984e3" },
  { background: "#dfe6e9", border: "#b2bec3" }
];
function generateFileColors(files) {
  const map = {};
  files.forEach((f, i) => {
    map[f] = i < FILE_COLORS_BASE.length ? FILE_COLORS_BASE[i] : {
      background: `hsl(${Math.round(i * 360 / files.length % 360)},65%,80%)`,
      border: `hsl(${Math.round(i * 360 / files.length % 360)},65%,55%)`
    };
  });
  return map;
}
function buildGraphMsg(data) {
  const files = [...new Set(data.nodes.map((n) => n.file))].sort();
  const colorMap = generateFileColors(files);
  const fileLegend = files.map((f) => ({ file: f, color: colorMap[f].background, border: colorMap[f].border }));
  return {
    type: "graphData",
    nodes: data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      // 表示用 (短縮名)
      labelFull: n.labelFull,
      // ソースパネル用 (フルシグネチャ)
      file: n.file,
      line: n.line,
      source: n.source,
      isCurrentFile: n.isCurrentFile,
      color: colorMap[n.file] ?? FILE_COLORS_BASE[FILE_COLORS_BASE.length - 1],
      title: `${n.label}
${path.basename(n.file)} : ${n.line}\u884C`
    })),
    edges: data.edges,
    fileLegend,
    buildTimeMs: data.buildTimeMs,
    errors: data.errors
  };
}
function generateStandaloneHtml(extensionUri, data) {
  const distDir = vscode.Uri.joinPath(extensionUri, "dist").fsPath;
  const visJs = fs.readFileSync(path.join(distDir, "vis-network.min.js"), "utf-8");
  const webviewJs = fs.readFileSync(path.join(distDir, "webview.js"), "utf-8");
  const graphMsg = buildGraphMsg(data);
  const safeJson = JSON.stringify(graphMsg).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const escapeScript = (s) => s.replace(/<\/script/gi, "<\\/script");
  return htmlTemplate({ kind: "standalone" }, [
    `<script>var INITIAL_GRAPH_DATA = ${safeJson};</script>`,
    `<script>${escapeScript(visJs)}</script>`,
    `<script>${escapeScript(webviewJs)}</script>`
  ].join("\n"));
}
var CallGraphPanel = class _CallGraphPanel {
  constructor(panel, extensionUri) {
    this._disposables = [];
    this._isReady = false;
    // ★ ⑤: 単一メッセージ保留 → キュー方式に変更。
    //   setLoading() → updateGraph() の順で ready 前に呼ばれても
    //   両メッセージが順番通りに届くようにする。
    this._pendingMessages = [];
    this._lastGraphData = null;
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.type) {
          case "ready":
            this._isReady = true;
            for (const pending of this._pendingMessages) {
              this._panel.webview.postMessage(pending);
            }
            this._pendingMessages = [];
            break;
          case "openFile":
            if (msg.file && msg.line !== void 0)
              await this._openFileAtLine(msg.file, msg.line);
            break;
          case "exportHtml":
            if (this._lastGraphData)
              await _CallGraphPanel.exportHtmlFile(this._extensionUri, this._lastGraphData);
            else
              vscode.window.showWarningMessage("\u30A8\u30AF\u30B9\u30DD\u30FC\u30C8\u3059\u308B\u30B0\u30E9\u30D5\u304C\u3042\u308A\u307E\u305B\u3093\u3002");
            break;
        }
      },
      null,
      this._disposables
    );
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._buildHtml();
  }
  static createOrShow(extensionUri) {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (_CallGraphPanel.currentPanel) {
      _CallGraphPanel.currentPanel._panel.reveal(column);
      return _CallGraphPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      "callGraphViewer",
      "Call Map",
      column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    _CallGraphPanel.currentPanel = new _CallGraphPanel(panel, extensionUri);
    return _CallGraphPanel.currentPanel;
  }
  setLoading(fileName) {
    this._panel.title = "Call Map \u2014 \u89E3\u6790\u4E2D...";
    this._postOrQueue({ type: "loading", fileName });
  }
  updateGraph(data) {
    this._lastGraphData = data;
    this._panel.title = `Call Map \u2014 ${data.fileName}`;
    this._postOrQueue(buildGraphMsg(data));
  }
  showError(message) {
    this._panel.title = "Call Map \u2014 \u30A8\u30E9\u30FC";
    this._postOrQueue({ type: "error", message });
  }
  static async exportHtmlFile(extensionUri, data) {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const safeName = data.fileName.replace(/[^\w.-]/g, "_");
    const defaultUri = wsRoot ? vscode.Uri.joinPath(wsRoot, `callgraph_${safeName}.html`) : vscode.Uri.file(path.join(os.homedir(), `callgraph_${safeName}.html`));
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "HTML \u30D5\u30A1\u30A4\u30EB": ["html"] }
    });
    if (!saveUri)
      return;
    try {
      const html = generateStandaloneHtml(extensionUri, data);
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, "utf-8"));
      const open = await vscode.window.showInformationMessage(
        `\u4FDD\u5B58\u5B8C\u4E86: ${path.basename(saveUri.fsPath)}`,
        "\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F"
      );
      if (open === "\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F")
        await vscode.env.openExternal(saveUri);
    } catch (e) {
      vscode.window.showErrorMessage(`\u4FDD\u5B58\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ${e}`);
    }
  }
  dispose() {
    _CallGraphPanel.currentPanel = void 0;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
  }
  _postOrQueue(msg) {
    if (this._isReady)
      this._panel.webview.postMessage(msg);
    else
      this._pendingMessages.push(msg);
  }
  async _openFileAtLine(filePath, line) {
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const inWorkspace = wsRoots.length === 0 || wsRoots.some((r) => filePath === r || filePath.startsWith(r + path.sep) || filePath.startsWith(r + "/"));
    if (!inWorkspace) {
      vscode.window.showErrorMessage(
        `Call Map: \u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u5916\u306E\u30D5\u30A1\u30A4\u30EB\u306F\u958B\u3051\u307E\u305B\u3093:
${filePath}`
      );
      return;
    }
    try {
      const uri = vscode.Uri.file(filePath);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
    } catch {
      vscode.window.showErrorMessage(`\u30D5\u30A1\u30A4\u30EB\u3092\u958B\u3051\u307E\u305B\u3093\u3067\u3057\u305F: ${filePath}`);
    }
  }
  _buildHtml() {
    const nonce = crypto.randomBytes(16).toString("hex");
    const webview = this._panel.webview;
    const distDir = vscode.Uri.joinPath(this._extensionUri, "dist");
    const visUri = webview.asWebviewUri(vscode.Uri.joinPath(distDir, "vis-network.min.js"));
    const webviewUri = webview.asWebviewUri(vscode.Uri.joinPath(distDir, "webview.js"));
    return htmlTemplate(
      { kind: "webview", nonce, cspSource: webview.cspSource },
      `<script nonce="${nonce}" src="${visUri}"></script>
<script nonce="${nonce}" src="${webviewUri}"></script>`
    );
  }
};
function htmlTemplate(mode, scripts) {
  const cspMeta = mode.kind === "webview" ? `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'nonce-${mode.nonce}' ${mode.cspSource}; style-src 'unsafe-inline';">` : `<meta http-equiv="Content-Security-Policy"
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
  <b style="font-size:13px;">\u{1F4DE} Call Map</b>
  <div style="color:#636e72;font-size:11px;margin:2px 0 8px;">
    <b style="color:#97c2fc;">\u25CF</b> \u9078\u629E\u4E2D &nbsp;
    <b style="color:#e17055;">\u25CF</b> callee &nbsp;
    <b style="color:#00b894;">\u25CF</b> caller &nbsp;
    <span style="color:#aaa;font-size:10px;">Ctrl+\u30AF\u30EA\u30C3\u30AF\u2192\u30B8\u30E3\u30F3\u30D7</span>
  </div>
  <input id="search-box" type="text" placeholder="\u{1F50D} \u95A2\u6570\u540D\u3092\u691C\u7D22">

  <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;color:#2d3436;margin-bottom:4px;">
    <input id="src-toggle" type="checkbox" style="cursor:pointer;"> \u30BD\u30FC\u30B9\u30B3\u30FC\u30C9\u30D1\u30CD\u30EB\u3092\u8868\u793A
  </label>
  <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:#636e72;margin-bottom:6px;">
    <label for="font-size-input" style="white-space:nowrap;">\u6587\u5B57\u30B5\u30A4\u30BA:</label>
    <input id="font-size-input" type="number" value="11" min="6" max="64"
      style="width:46px;padding:2px 5px;border:1px solid #b2bec3;border-radius:4px;font-family:monospace;font-size:11px;text-align:center;outline:none;">
    <button id="font-size-reset" style="padding:2px 7px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-family:monospace;font-size:11px;cursor:pointer;color:#636e72;">Default</button>
  </div>
  <button id="export-btn" style="width:100%;padding:5px 0;margin-bottom:6px;border:1px solid #b2bec3;border-radius:4px;background:#f8f9fa;font-family:monospace;font-size:11px;cursor:pointer;color:#2d3436;">
    \u{1F4BE} HTML \u3068\u3057\u3066\u4FDD\u5B58
  </button>
  <div id="hop-panel" style="display:none;margin-top:2px;">
    <div style="color:#636e72;font-size:11px;margin-bottom:4px;">\u8868\u793A\u7BC4\u56F2\uFF08\u30DB\u30C3\u30D7\u6570\uFF09:</div>
    <div style="display:flex;gap:5px;">
      <button class="hop-btn" data-hop="1">1</button>
      <button class="hop-btn" data-hop="2">2</button>
      <button class="hop-btn" data-hop="3">3</button>
      <button class="hop-btn" data-hop="null">All</button>
    </div>
  </div>
  <div style="margin-top:10px;border-top:1px solid #ddd;padding-top:8px;">
    <div style="color:#636e72;font-size:11px;margin-bottom:5px;">\u30D5\u30A1\u30A4\u30EB\u51E1\u4F8B:</div>
    <div id="legend-items"></div>
  </div>
  <div id="build-info" style="margin-top:8px;border-top:1px solid #ddd;padding-top:6px;color:#b2bec3;font-size:10px;"></div>
</div>

<div id="source-panel">
  <div id="source-placeholder">
    <span style="font-size:28px;">\u2190</span>
    <span style="font-size:13px;">\u30CE\u30FC\u30C9\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u3066\u304F\u3060\u3055\u3044</span>
    <span style="font-size:11px;color:#6c7086;">Ctrl+\u30AF\u30EA\u30C3\u30AF\u3067\u30A8\u30C7\u30A3\u30BF\u3078\u30B8\u30E3\u30F3\u30D7</span>
  </div>
  <div id="source-content">
    <div style="padding:10px 16px;background:#181825;border-bottom:1px solid #45475a;display:flex;justify-content:space-between;align-items:flex-start;flex-shrink:0;">
      <div>
        <span id="source-func-name" style="color:#89b4fa;font-weight:bold;font-size:14px;"></span><br>
        <span id="source-file-info" style="color:#6c7086;font-size:11px;"></span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-left:8px;">
        <button id="goto-btn" style="background:#313244;border:1px solid #45475a;color:#cdd6f4;cursor:pointer;padding:4px 10px;border-radius:4px;font-family:monospace;font-size:11px;">\u25B7 \u30BD\u30FC\u30B9\u3078\u30B8\u30E3\u30F3\u30D7</button>
        <button id="src-close-btn" style="background:none;border:none;color:#6c7086;cursor:pointer;font-size:16px;">\u2715</button>
      </div>
    </div>
    <pre id="source-code"></pre>
  </div>
</div>

<div id="loading-overlay">
  <div class="spinner"></div>
  <div id="loading-msg" style="font-family:monospace;color:#636e72;font-size:13px;">\u89E3\u6790\u4E2D...</div>
</div>

${scripts}
</body>
</html>`;
}

// src/callGraphBuilder.ts
var vscode2 = __toESM(require("vscode"));
var path2 = __toESM(require("path"));
var fs2 = __toESM(require("fs"));
var import_child_process = require("child_process");
var import_util = require("util");
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
var BATCH_SIZE = 2;
var BATCH_DELAY = 50;
var CC_SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([".c", ".cpp", ".cc", ".cxx", ".cu", ".cuh"]);
var CC_SOURCE_GLOB = "**/*.{c,cpp,cc,cxx,cu,cuh}";
var EXCLUDE_GLOB = "{**/node_modules/**,**/build/**,**/dist/**,**/out/**,**/.git/**}";
function splitEdges(edgeSet) {
  return Array.from(edgeSet).map((key) => {
    const sep3 = key.indexOf("|||");
    return { from: key.slice(0, sep3), to: key.slice(sep3 + 3) };
  });
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function getWorkspaceRoot(fallbackUri) {
  return vscode2.workspace.workspaceFolders?.[0]?.uri.fsPath ?? (fallbackUri ? path2.dirname(fallbackUri.fsPath) : void 0);
}
function getWorkspaceRoots(fallbackUri) {
  const folders = (vscode2.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0 && fallbackUri)
    return [path2.dirname(fallbackUri.fsPath)];
  return folders;
}
async function gtagsAvailable() {
  try {
    await execFileAsync("gtags", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
async function resolveBackend(backend) {
  if (backend === "lsp")
    return "lsp";
  if (backend === "gtags")
    return "gtags";
  return await gtagsAvailable() ? "gtags" : "lsp";
}
function hasCppSourceExtension(uri) {
  return CC_SOURCE_EXTENSIONS.has(path2.extname(uri.fsPath).toLowerCase());
}
function isInWorkspace(uri, roots) {
  if (roots.length === 0)
    return true;
  const p = uri.fsPath;
  return roots.some((r) => p === r || p.startsWith(r + path2.sep) || p.startsWith(r + "/"));
}
function shouldIncludeCallee(uri, roots) {
  return isInWorkspace(uri, roots) && hasCppSourceExtension(uri);
}
function makeNodeId(uri, name, line) {
  return `${uri.fsPath}||${baseNameOf(name)}||${line}`;
}
function baseNameOf(name) {
  const idx = name.indexOf("(");
  return idx >= 0 ? name.slice(0, idx).trim() : name;
}
function findExistingCalleeId(nodes, to) {
  const exactId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
  if (nodes.has(exactId))
    return exactId;
  const base = baseNameOf(to.name);
  const fp = to.uri.fsPath;
  for (const [id, node] of nodes) {
    if (node.file === fp && (node.label === base || baseNameOf(node.label) === base))
      return id;
  }
  const ext = path2.extname(fp).toLowerCase();
  if ([".h", ".hpp", ".hxx"].includes(ext)) {
    for (const [id, node] of nodes) {
      if (node.label === base || baseNameOf(node.label) === base)
        return id;
    }
  }
  return null;
}
function flattenFunctions(syms) {
  const KINDS = /* @__PURE__ */ new Set([vscode2.SymbolKind.Function, vscode2.SymbolKind.Method, vscode2.SymbolKind.Constructor]);
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  function walk(arr) {
    for (const s of arr) {
      if (KINDS.has(s.kind)) {
        const key = `${s.selectionRange.start.line}:${baseNameOf(s.name)}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(s);
        }
      }
      if (s.children?.length)
        walk(s.children);
    }
  }
  walk(syms);
  return result;
}
async function openLines(uri, cache) {
  const key = uri.fsPath;
  if (cache.has(key))
    return cache.get(key);
  try {
    const openDoc = vscode2.workspace.textDocuments.find((d) => d.uri.fsPath === key);
    if (openDoc) {
      const lines2 = openDoc.getText().split("\n");
      cache.set(key, lines2);
      return lines2;
    }
    const content = await fs2.promises.readFile(key, "utf-8");
    const lines = content.split("\n");
    cache.set(key, lines);
    return lines;
  } catch {
    cache.set(key, []);
    return [];
  }
}
var MAX_SOURCE_LINES = 200;
function sliceSource(lines, s, e) {
  const end = Math.min(e + 1, s + MAX_SOURCE_LINES, lines.length);
  return lines.slice(s, end).join("\n");
}
function checkCancellation(token) {
  if (token?.isCancellationRequested)
    throw new vscode2.CancellationError();
}
var MAX_RETRY = 6;
var RETRY_BASE_MS = 200;
async function execWithRetry(command, token, ...args) {
  for (let i = 0; i < MAX_RETRY; i++) {
    checkCancellation(token);
    try {
      return await vscode2.commands.executeCommand(command, ...args);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("not found"))
        throw err;
      if (msg.includes("Canceled")) {
        if (i < MAX_RETRY - 1) {
          await delay(RETRY_BASE_MS * Math.pow(2, i));
          continue;
        }
      }
      throw err;
    }
  }
}
async function buildFileCallGraphLsp(document, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const cache = /* @__PURE__ */ new Map();
  const wsRoots = getWorkspaceRoots(document.uri);
  const currentLines = document.getText().split("\n");
  cache.set(document.uri.fsPath, currentLines);
  progress?.report({ message: "\u30B7\u30F3\u30DC\u30EB\u3092\u53D6\u5F97\u4E2D..." });
  checkCancellation(token);
  const rawSyms = await vscode2.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    document.uri
  );
  if (!rawSyms?.length)
    throw new Error(
      "\u30B7\u30F3\u30DC\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\n\n\u3010\u78BA\u8A8D\u4E8B\u9805\u3011\n  1. clangd \u307E\u305F\u306F C/C++ \u62E1\u5F35\u6A5F\u80FD\u304C\u6709\u52B9\u304B\n  2. \u30A4\u30F3\u30C7\u30C3\u30AF\u30B9\u4F5C\u6210\u304C\u5B8C\u4E86\u3057\u3066\u3044\u308B\u304B\n  3. clangd \u306E\u5834\u5408: compile_commands.json \u304C\u3042\u308B\u304B"
    );
  const functions = flattenFunctions(rawSyms);
  if (!functions.length)
    throw new Error("\u3053\u306E\u30D5\u30A1\u30A4\u30EB\u306B\u95A2\u6570\u30B7\u30F3\u30DC\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  for (const f of functions) {
    const id = makeNodeId(document.uri, f.name, f.selectionRange.start.line);
    nodes.set(id, {
      id,
      label: baseNameOf(f.name),
      labelFull: f.name,
      file: document.uri.fsPath,
      line: f.selectionRange.start.line + 1,
      source: sliceSource(currentLines, f.range.start.line, f.range.end.line),
      isCurrentFile: true
    });
  }
  const total = functions.length;
  for (let i = 0; i < functions.length; i += BATCH_SIZE) {
    checkCancellation(token);
    const batch = functions.slice(i, i + BATCH_SIZE);
    progress?.report({
      message: `\u30B3\u30FC\u30EB\u89E3\u6790\u4E2D... (${Math.min(i + BATCH_SIZE, total)}/${total})`,
      increment: batch.length / total * 80
    });
    const processingIds = /* @__PURE__ */ new Set();
    await Promise.all(batch.map(async (func) => {
      try {
        const items = await execWithRetry(
          "vscode.prepareCallHierarchy",
          token,
          document.uri,
          func.selectionRange.start
        );
        if (!items?.length)
          return;
        const outgoing = await execWithRetry(
          "vscode.provideOutgoingCalls",
          token,
          items[0]
        );
        if (!outgoing?.length)
          return;
        const callerId = makeNodeId(document.uri, func.name, func.selectionRange.start.line);
        for (const call of outgoing) {
          const { to } = call;
          let calleeId = findExistingCalleeId(nodes, to);
          if (!calleeId) {
            if (!shouldIncludeCallee(to.uri, wsRoots))
              continue;
            calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
            if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
              processingIds.add(calleeId);
              const ll = await openLines(to.uri, cache);
              if (!nodes.has(calleeId)) {
                nodes.set(calleeId, {
                  id: calleeId,
                  label: baseNameOf(to.name),
                  labelFull: to.name,
                  file: to.uri.fsPath,
                  line: to.selectionRange.start.line + 1,
                  source: sliceSource(ll, to.range.start.line, to.range.end.line),
                  isCurrentFile: false
                });
              }
            }
          }
          edgeSet.add(`${callerId}|||${calleeId}`);
        }
      } catch (err) {
        if (err instanceof vscode2.CancellationError)
          throw err;
        errs.push(`${func.name}: ${String(err)}`);
      }
    }));
    if (i + BATCH_SIZE < functions.length)
      await delay(BATCH_DELAY);
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: path2.basename(document.uri.fsPath),
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildFunctionCallGraphLsp(document, position, maxHops = 4, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const cache = /* @__PURE__ */ new Map();
  const wsRoots = getWorkspaceRoots(document.uri);
  progress?.report({ message: "\u8D77\u70B9\u95A2\u6570\u3092\u7279\u5B9A\u4E2D..." });
  checkCancellation(token);
  const startItems = await execWithRetry(
    "vscode.prepareCallHierarchy",
    token,
    document.uri,
    position
  );
  if (!startItems?.length)
    throw new Error(
      "\u30AB\u30FC\u30BD\u30EB\u4F4D\u7F6E\u306B\u95A2\u6570\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\n\u95A2\u6570\u540D\u306E\u4E0A\u306B\u30AB\u30FC\u30BD\u30EB\u3092\u7F6E\u3044\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
    );
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const queue = [[startItems[0], 0]];
  while (queue.length > 0) {
    checkCancellation(token);
    const [item, hop] = queue.shift();
    const nodeId = makeNodeId(item.uri, item.name, item.selectionRange.start.line);
    if (visited.has(nodeId))
      continue;
    visited.add(nodeId);
    if (!nodes.has(nodeId)) {
      const ll = await openLines(item.uri, cache);
      nodes.set(nodeId, {
        id: nodeId,
        label: baseNameOf(item.name),
        labelFull: item.name,
        file: item.uri.fsPath,
        line: item.selectionRange.start.line + 1,
        source: sliceSource(ll, item.range.start.line, item.range.end.line),
        isCurrentFile: item.uri.fsPath === document.uri.fsPath
      });
    }
    if (hop >= maxHops)
      continue;
    progress?.report({ message: `BFS \u5C55\u958B\u4E2D... (\u30CE\u30FC\u30C9: ${nodes.size})` });
    try {
      const outgoing = await execWithRetry(
        "vscode.provideOutgoingCalls",
        token,
        item
      );
      if (!outgoing?.length)
        continue;
      for (const call of outgoing) {
        let calleeId = findExistingCalleeId(nodes, call.to);
        if (!calleeId) {
          if (!shouldIncludeCallee(call.to.uri, wsRoots))
            continue;
          calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
        }
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!visited.has(calleeId)) {
          visited.add(calleeId);
          queue.push([call.to, hop + 1]);
        }
      }
    } catch (err) {
      if (err instanceof vscode2.CancellationError)
        throw err;
      errs.push(`${item.name}: ${String(err)}`);
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: `${baseNameOf(startItems[0].name)} (${path2.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildWorkspaceCallGraphLsp(uris, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const cache = /* @__PURE__ */ new Map();
  const uniqueUris = Array.from(new Map(uris.map((u) => [u.fsPath, u])).values());
  const wsRoots = getWorkspaceRoots(uniqueUris[0]);
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  for (let fi = 0; fi < uniqueUris.length; fi++) {
    checkCancellation(token);
    const uri = uniqueUris[fi];
    if (!hasCppSourceExtension(uri))
      continue;
    progress?.report({
      message: `\u89E3\u6790\u4E2D ${fi + 1}/${uniqueUris.length}: ${path2.basename(uri.fsPath)}`,
      increment: 1 / uniqueUris.length * 100
    });
    let rawSyms;
    try {
      rawSyms = await vscode2.commands.executeCommand(
        "vscode.executeDocumentSymbolProvider",
        uri
      );
    } catch {
      continue;
    }
    if (!rawSyms?.length)
      continue;
    const functions = flattenFunctions(rawSyms);
    const lines = await openLines(uri, cache);
    for (const f of functions) {
      const id = makeNodeId(uri, f.name, f.selectionRange.start.line);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: baseNameOf(f.name),
          labelFull: f.name,
          file: uri.fsPath,
          line: f.selectionRange.start.line + 1,
          source: sliceSource(lines, f.range.start.line, f.range.end.line),
          isCurrentFile: false
        });
      }
    }
    for (let i = 0; i < functions.length; i += BATCH_SIZE) {
      checkCancellation(token);
      const processingIds = /* @__PURE__ */ new Set();
      await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async (func) => {
        try {
          const items = await execWithRetry(
            "vscode.prepareCallHierarchy",
            token,
            uri,
            func.selectionRange.start
          );
          if (!items?.length)
            return;
          const outgoing = await execWithRetry(
            "vscode.provideOutgoingCalls",
            token,
            items[0]
          );
          if (!outgoing?.length)
            return;
          const callerId = makeNodeId(uri, func.name, func.selectionRange.start.line);
          for (const call of outgoing) {
            const { to } = call;
            let calleeId = findExistingCalleeId(nodes, to);
            if (!calleeId) {
              if (!shouldIncludeCallee(to.uri, wsRoots))
                continue;
              calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
              if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                processingIds.add(calleeId);
                const ll = await openLines(to.uri, cache);
                if (!nodes.has(calleeId)) {
                  nodes.set(calleeId, {
                    id: calleeId,
                    label: baseNameOf(to.name),
                    labelFull: to.name,
                    file: to.uri.fsPath,
                    line: to.selectionRange.start.line + 1,
                    source: sliceSource(ll, to.range.start.line, to.range.end.line),
                    isCurrentFile: false
                  });
                }
              }
            }
            edgeSet.add(`${callerId}|||${calleeId}`);
          }
        } catch (err) {
          if (err instanceof vscode2.CancellationError)
            throw err;
          errs.push(`${path2.basename(uri.fsPath)}::${func.name}: ${String(err)}`);
        }
      }));
      if (i + BATCH_SIZE < functions.length)
        await delay(BATCH_DELAY);
    }
  }
  const label = uniqueUris.length === 1 ? path2.basename(uniqueUris[0].fsPath) : `${uniqueUris.length} \u30D5\u30A1\u30A4\u30EB`;
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: label,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
function isLikelyFuncDef(line) {
  const s = line.trim();
  if (!s || s.startsWith("#") || s.startsWith("}"))
    return false;
  if (s.includes("typedef") || !s.includes("(") || s.endsWith(";"))
    return false;
  return true;
}
async function ensureGtagsDb(wsRoot) {
  if (fs2.existsSync(path2.join(wsRoot, "GTAGS")))
    return;
  await execFileAsync("gtags", ["--accept-dotfiles"], { cwd: wsRoot, timeout: 12e4 });
}
async function runGlobalF(absFile, wsRoot) {
  try {
    const relFile = path2.relative(wsRoot, absFile);
    const { stdout } = await execFileAsync("global", ["-f", relFile], {
      cwd: wsRoot,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout.split("\n").flatMap((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 3)
        return [];
      const name = parts[0];
      const lineno = parseInt(parts[1], 10);
      if (!name || isNaN(lineno))
        return [];
      const fp = path2.isAbsolute(parts[2]) ? parts[2] : path2.resolve(wsRoot, parts[2]);
      return [{ name, line: lineno, file: fp }];
    });
  } catch {
    return [];
  }
}
function readFileLinesCached(filePath, cache) {
  if (cache.has(filePath))
    return cache.get(filePath);
  try {
    const lines = fs2.readFileSync(filePath, "utf-8").split("\n");
    cache.set(filePath, lines);
    return lines;
  } catch {
    cache.set(filePath, []);
    return [];
  }
}
async function collectGtags(files, wsRoot) {
  const lineCache = /* @__PURE__ */ new Map();
  const rawMap = /* @__PURE__ */ new Map();
  const CONCURRENT = Math.min(16, Math.max(1, files.length));
  for (let i = 0; i < files.length; i += CONCURRENT) {
    const results = await Promise.all(
      files.slice(i, i + CONCURRENT).map((f) => runGlobalF(f, wsRoot))
    );
    for (const entries of results) {
      for (const e of entries) {
        if (!rawMap.has(e.name))
          rawMap.set(e.name, []);
        rawMap.get(e.name).push(e);
      }
    }
  }
  const tags = /* @__PURE__ */ new Map();
  const ambiguousNames = [];
  for (const [name, candidates] of rawMap) {
    const distinctFiles = new Set(candidates.map((c) => c.file));
    if (distinctFiles.size > 1)
      ambiguousNames.push(name);
    let best = null;
    for (const cand of candidates) {
      const lines = readFileLinesCached(cand.file, lineCache);
      const srcLine = lines[cand.line - 1]?.trimEnd() ?? "";
      const isFunc = isLikelyFuncDef(srcLine);
      const entry = { name, file: cand.file, line: cand.line, sourceLine: srcLine, isFunc };
      if (!best || isFunc && !best.isFunc)
        best = entry;
    }
    if (best)
      tags.set(name, best);
  }
  return { tags, lineCache, ambiguousNames };
}
function buildGtagsScopeMap(tags) {
  const fileMap = /* @__PURE__ */ new Map();
  for (const [name, info] of tags) {
    if (!fileMap.has(info.file))
      fileMap.set(info.file, []);
    fileMap.get(info.file).push({ name, line: info.line });
  }
  const scopeMap = /* @__PURE__ */ new Map();
  for (const [fp, entries] of fileMap) {
    entries.sort((a, b) => a.line - b.line);
    scopeMap.set(fp, entries.map((e, i) => ({
      name: e.name,
      start: e.line,
      end: i + 1 < entries.length ? entries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER
    })));
  }
  return scopeMap;
}
function extractCallsFromLines(lines, start, end, knownTags, selfName) {
  const callees = /* @__PURE__ */ new Set();
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let inBlockComment = false;
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    const line = lines[i];
    let processed = "";
    let j = 0;
    while (j < line.length) {
      if (inBlockComment) {
        const endIdx = line.indexOf("*/", j);
        if (endIdx === -1) {
          j = line.length;
        } else {
          inBlockComment = false;
          j = endIdx + 2;
        }
      } else {
        const lineCommentIdx = line.indexOf("//", j);
        const blockCommentIdx = line.indexOf("/*", j);
        if (blockCommentIdx !== -1 && (lineCommentIdx === -1 || blockCommentIdx < lineCommentIdx)) {
          processed += line.slice(j, blockCommentIdx);
          inBlockComment = true;
          j = blockCommentIdx + 2;
        } else if (lineCommentIdx !== -1) {
          processed += line.slice(j, lineCommentIdx);
          j = line.length;
        } else {
          processed += line.slice(j);
          j = line.length;
        }
      }
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(processed)) !== null) {
      const callee = m[1];
      if (callee !== selfName && knownTags.has(callee))
        callees.add(callee);
    }
  }
  return callees;
}
function makeGtagsNodeId(file, name, line) {
  return `${file}||${name}||${line}`;
}
function gtagsEntryToNode(name, entry, scope, lines, currentFile) {
  return {
    id: makeGtagsNodeId(entry.file, name, entry.line),
    label: name,
    labelFull: name,
    file: entry.file,
    line: entry.line,
    source: lines.slice(scope.start - 1, Math.min(scope.end, scope.start - 1 + MAX_SOURCE_LINES, lines.length)).join("\n"),
    isCurrentFile: entry.file === currentFile
  };
}
async function buildFileCallGraphGtags(document, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoot = getWorkspaceRoot(document.uri);
  if (!wsRoot)
    throw new Error("\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u304C\u958B\u304B\u308C\u3066\u3044\u307E\u305B\u3093\u3002");
  progress?.report({ message: "[gtags] DB \u3092\u78BA\u8A8D\u4E2D..." });
  checkCancellation(token);
  await ensureGtagsDb(wsRoot);
  progress?.report({ message: "[gtags] C/C++ \u30D5\u30A1\u30A4\u30EB\u3092\u691C\u7D22\u4E2D..." });
  const allUris = await vscode2.workspace.findFiles(CC_SOURCE_GLOB, EXCLUDE_GLOB);
  const allFiles = allUris.map((u) => u.fsPath);
  progress?.report({ message: "[gtags] \u30BF\u30B0\u3092\u53CE\u96C6\u4E2D..." });
  checkCancellation(token);
  const { tags, lineCache, ambiguousNames } = await collectGtags(allFiles, wsRoot);
  if (!tags.size)
    throw new Error(
      "\u30BF\u30B0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\ngtags \u306E\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3068 GTAGS \u306E\u78BA\u8A8D\u3092\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
    );
  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(", ");
    const suffix = ambiguousNames.length > 5 ? ` \u307B\u304B ${ambiguousNames.length - 5} \u4EF6` : "";
    errs.push(`[gtags] \u8907\u6570\u30D5\u30A1\u30A4\u30EB\u306B\u540C\u540D\u95A2\u6570\u304C\u5B58\u5728\u3057\u307E\u3059 (\u5148\u982D\u30D2\u30C3\u30C8\u3092\u4F7F\u7528): ${preview}${suffix}`);
  }
  const currentFile = document.uri.fsPath;
  const currentLines = document.getText().split("\n");
  lineCache.set(currentFile, currentLines);
  const knownTags = new Set(tags.keys());
  const scopeMap = buildGtagsScopeMap(tags);
  const fileScopes = scopeMap.get(currentFile) ?? [];
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  for (const scope of fileScopes) {
    const entry = tags.get(scope.name);
    if (!entry || !entry.isFunc || entry.file !== currentFile)
      continue;
    const node = gtagsEntryToNode(scope.name, entry, scope, currentLines, currentFile);
    nodes.set(node.id, node);
  }
  if (!nodes.size)
    throw new Error("\u3053\u306E\u30D5\u30A1\u30A4\u30EB\u306B\u95A2\u6570\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
  progress?.report({ message: "[gtags] \u30B3\u30FC\u30EB\u95A2\u4FC2\u3092\u89E3\u6790\u4E2D...", increment: 50 });
  checkCancellation(token);
  for (const scope of fileScopes) {
    const entry = tags.get(scope.name);
    if (!entry || !entry.isFunc || entry.file !== currentFile)
      continue;
    const callerId = makeGtagsNodeId(currentFile, scope.name, entry.line);
    const callees = extractCallsFromLines(currentLines, scope.start, scope.end, knownTags, scope.name);
    for (const callee of callees) {
      const calleeEntry = tags.get(callee);
      if (!calleeEntry)
        continue;
      const calleeScope = scopeMap.get(calleeEntry.file)?.find((s) => s.name === callee);
      if (!calleeScope)
        continue;
      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      if (!nodes.has(calleeId)) {
        const ll = readFileLinesCached(calleeEntry.file, lineCache);
        nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, ll, currentFile));
      }
      edgeSet.add(`${callerId}|||${calleeId}`);
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: path2.basename(currentFile),
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildFunctionCallGraphGtags(document, position, maxHops = 4, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoot = getWorkspaceRoot(document.uri);
  if (!wsRoot)
    throw new Error("\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u304C\u958B\u304B\u308C\u3066\u3044\u307E\u305B\u3093\u3002");
  progress?.report({ message: "[gtags] DB \u3092\u78BA\u8A8D\u4E2D..." });
  checkCancellation(token);
  await ensureGtagsDb(wsRoot);
  progress?.report({ message: "[gtags] \u30BF\u30B0\u3092\u53CE\u96C6\u4E2D..." });
  checkCancellation(token);
  const allUris = await vscode2.workspace.findFiles(CC_SOURCE_GLOB, EXCLUDE_GLOB);
  const { tags, lineCache, ambiguousNames } = await collectGtags(allUris.map((u) => u.fsPath), wsRoot);
  if (!tags.size)
    throw new Error("\u30BF\u30B0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(", ");
    const suffix = ambiguousNames.length > 5 ? ` \u307B\u304B ${ambiguousNames.length - 5} \u4EF6` : "";
    errs.push(`[gtags] \u8907\u6570\u30D5\u30A1\u30A4\u30EB\u306B\u540C\u540D\u95A2\u6570\u304C\u5B58\u5728\u3057\u307E\u3059 (\u5148\u982D\u30D2\u30C3\u30C8\u3092\u4F7F\u7528): ${preview}${suffix}`);
  }
  const currentFile = document.uri.fsPath;
  lineCache.set(currentFile, document.getText().split("\n"));
  const knownTags = new Set(tags.keys());
  const scopeMap = buildGtagsScopeMap(tags);
  const cursorLine = position.line + 1;
  const fileScopes = scopeMap.get(currentFile) ?? [];
  const startScope = fileScopes.find((s) => s.start <= cursorLine && cursorLine <= s.end);
  if (!startScope)
    throw new Error(
      "\u30AB\u30FC\u30BD\u30EB\u4F4D\u7F6E\u306B\u95A2\u6570\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\n\u95A2\u6570\u540D\u306E\u4E0A\u306B\u30AB\u30FC\u30BD\u30EB\u3092\u7F6E\u3044\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
    );
  const startEntry = tags.get(startScope.name);
  if (!startEntry)
    throw new Error("\u8D77\u70B9\u95A2\u6570\u306E\u30BF\u30B0\u60C5\u5831\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const queue = [{ name: startScope.name, entry: startEntry, scope: startScope, hop: 0 }];
  while (queue.length > 0) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue.shift();
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    if (visited.has(nodeId))
      continue;
    visited.add(nodeId);
    const lines = readFileLinesCached(entry.file, lineCache);
    if (!nodes.has(nodeId)) {
      nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, lines, currentFile));
    }
    if (hop >= maxHops)
      continue;
    progress?.report({ message: `[gtags] BFS \u5C55\u958B\u4E2D... (\u30CE\u30FC\u30C9: ${nodes.size})` });
    const callees = extractCallsFromLines(lines, scope.start, scope.end, knownTags, name);
    for (const callee of callees) {
      const calleeEntry = tags.get(callee);
      if (!calleeEntry)
        continue;
      const calleeScope = scopeMap.get(calleeEntry.file)?.find((s) => s.name === callee);
      if (!calleeScope)
        continue;
      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      edgeSet.add(`${nodeId}|||${calleeId}`);
      if (!visited.has(calleeId)) {
        queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 });
      }
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: `${startScope.name} (${path2.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildWorkspaceCallGraphGtags(uris, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const uniqueUris = Array.from(new Map(uris.map((u) => [u.fsPath, u])).values()).filter((u) => CC_SOURCE_EXTENSIONS.has(path2.extname(u.fsPath).toLowerCase()));
  if (!uniqueUris.length)
    throw new Error("C/C++ \u30BD\u30FC\u30B9\u30D5\u30A1\u30A4\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
  const wsRoot = getWorkspaceRoot(uniqueUris[0]);
  if (!wsRoot)
    throw new Error("\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u304C\u958B\u304B\u308C\u3066\u3044\u307E\u305B\u3093\u3002");
  progress?.report({ message: "[gtags] DB \u3092\u78BA\u8A8D\u4E2D..." });
  checkCancellation(token);
  await ensureGtagsDb(wsRoot);
  progress?.report({ message: "[gtags] \u30BF\u30B0\u3092\u53CE\u96C6\u4E2D..." });
  checkCancellation(token);
  const allUris = await vscode2.workspace.findFiles(CC_SOURCE_GLOB, EXCLUDE_GLOB);
  const { tags, lineCache, ambiguousNames } = await collectGtags(allUris.map((u) => u.fsPath), wsRoot);
  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(", ");
    const suffix = ambiguousNames.length > 5 ? ` \u307B\u304B ${ambiguousNames.length - 5} \u4EF6` : "";
    errs.push(`[gtags] \u8907\u6570\u30D5\u30A1\u30A4\u30EB\u306B\u540C\u540D\u95A2\u6570\u304C\u5B58\u5728\u3057\u307E\u3059 (\u5148\u982D\u30D2\u30C3\u30C8\u3092\u4F7F\u7528): ${preview}${suffix}`);
  }
  const knownTags = new Set(tags.keys());
  const scopeMap = buildGtagsScopeMap(tags);
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  const total = uniqueUris.length;
  for (let fi = 0; fi < uniqueUris.length; fi++) {
    checkCancellation(token);
    const uri = uniqueUris[fi];
    progress?.report({
      message: `[gtags] \u89E3\u6790\u4E2D ${fi + 1}/${total}: ${path2.basename(uri.fsPath)}`,
      increment: 1 / total * 100
    });
    const fileScopes = scopeMap.get(uri.fsPath) ?? [];
    const lines = readFileLinesCached(uri.fsPath, lineCache);
    for (const scope of fileScopes) {
      const entry = tags.get(scope.name);
      if (!entry || !entry.isFunc || entry.file !== uri.fsPath)
        continue;
      const node = gtagsEntryToNode(scope.name, entry, scope, lines, "");
      if (!nodes.has(node.id))
        nodes.set(node.id, node);
    }
    for (const scope of fileScopes) {
      const entry = tags.get(scope.name);
      if (!entry || !entry.isFunc || entry.file !== uri.fsPath)
        continue;
      const callerId = makeGtagsNodeId(uri.fsPath, scope.name, entry.line);
      const callees = extractCallsFromLines(lines, scope.start, scope.end, knownTags, scope.name);
      for (const callee of callees) {
        const calleeEntry = tags.get(callee);
        if (!calleeEntry)
          continue;
        const calleeScope = scopeMap.get(calleeEntry.file)?.find((s) => s.name === callee);
        if (!calleeScope)
          continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        if (!nodes.has(calleeId)) {
          const ll = readFileLinesCached(calleeEntry.file, lineCache);
          nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, ll, ""));
        }
        edgeSet.add(`${callerId}|||${calleeId}`);
      }
    }
  }
  const label = uniqueUris.length === 1 ? path2.basename(uniqueUris[0].fsPath) : `${uniqueUris.length} \u30D5\u30A1\u30A4\u30EB`;
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: label,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildFileCallGraph(document, progress, backend = "auto", token) {
  return await resolveBackend(backend) === "gtags" ? buildFileCallGraphGtags(document, progress, token) : buildFileCallGraphLsp(document, progress, token);
}
async function buildFunctionCallGraph(document, position, maxHops = 4, progress, backend = "auto", token) {
  return await resolveBackend(backend) === "gtags" ? buildFunctionCallGraphGtags(document, position, maxHops, progress, token) : buildFunctionCallGraphLsp(document, position, maxHops, progress, token);
}
async function buildWorkspaceCallGraph(uris, progress, backend = "auto", token) {
  return await resolveBackend(backend) === "gtags" ? buildWorkspaceCallGraphGtags(uris, progress, token) : buildWorkspaceCallGraphLsp(uris, progress, token);
}

// src/extension.ts
var WARN_THRESHOLD = 50;
async function pickBackend() {
  const picked = await vscode3.window.showQuickPick(
    [
      {
        label: "$(search) LSP (\u9AD8\u7CBE\u5EA6)",
        description: "clangd / C/C++ \u62E1\u5F35\u6A5F\u80FD\u3092\u4F7F\u7528\u3002\u30A4\u30F3\u30C7\u30C3\u30AF\u30B9\u304C\u5FC5\u8981\u3002",
        backend: "lsp"
      },
      {
        label: "$(zap) gtags (\u9AD8\u901F)",
        description: "GNU Global \u3092\u4F7F\u7528\u3002LSP \u4E0D\u8981\u3067\u5927\u898F\u6A21\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306B\u9069\u3059\u308B\u3002",
        backend: "gtags"
      }
    ],
    { placeHolder: "\u89E3\u6790\u30D0\u30C3\u30AF\u30A8\u30F3\u30C9\u3092\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044", title: "Call Map: \u30D0\u30C3\u30AF\u30A8\u30F3\u30C9" }
  );
  return picked?.backend;
}
async function pickOutputMode() {
  const picked = await vscode3.window.showQuickPick(
    [
      { label: "$(callhierarchy-outgoing) WebView \u3067\u8868\u793A", mode: "webview" },
      { label: "$(browser) HTML \u30D5\u30A1\u30A4\u30EB\u306B\u4FDD\u5B58\u3057\u3066\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F", mode: "html" }
    ],
    { placeHolder: "\u8868\u793A\u65B9\u6CD5\u3092\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044", title: "Call Map: \u51FA\u529B\u30E2\u30FC\u30C9" }
  );
  return picked?.mode;
}
async function buildAndOutput(mode, fileName, extensionUri, build) {
  const panel = mode === "webview" ? CallGraphPanel.createOrShow(extensionUri) : void 0;
  panel?.setLoading(path3.basename(fileName));
  await vscode3.window.withProgress(
    {
      location: vscode3.ProgressLocation.Notification,
      title: "Call Map \u3092\u69CB\u7BC9\u4E2D",
      // ★ ④: キャンセル可能にする
      cancellable: true
    },
    async (progress, token) => {
      try {
        const data = await build(progress, token);
        if (token.isCancellationRequested)
          return;
        if (data.errors.length > 0)
          console.warn("[CallMap] \u89E3\u6790\u8B66\u544A:", data.errors);
        if (mode === "webview") {
          panel.updateGraph(data);
          vscode3.window.setStatusBarMessage(
            `\u{1F4DE} Call Map: ${data.nodes.length} \u30CE\u30FC\u30C9 / ${data.edges.length} \u30A8\u30C3\u30B8 (${data.buildTimeMs}ms)`,
            6e3
          );
        } else {
          await CallGraphPanel.exportHtmlFile(extensionUri, data);
        }
      } catch (err) {
        if (err instanceof vscode3.CancellationError)
          return;
        const msg = err instanceof Error ? err.message : String(err);
        if (panel)
          panel.showError(msg);
        else
          vscode3.window.showErrorMessage("Call Map \u30A8\u30E9\u30FC:\n" + msg);
      }
    }
  );
}
function activate(context) {
  context.subscriptions.push(
    vscode3.commands.registerCommand("callgraph.showFileGraph", async () => {
      const editor = vscode3.window.activeTextEditor;
      if (!editor) {
        vscode3.window.showErrorMessage("Call Map: C/C++ \u30D5\u30A1\u30A4\u30EB\u3092\u958B\u3044\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
        return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const mode = await pickOutputMode();
      if (!mode)
        return;
      await buildAndOutput(
        mode,
        editor.document.fileName,
        context.extensionUri,
        (prog, tok) => buildFileCallGraph(editor.document, prog, backend, tok)
      );
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("callgraph.showFunctionGraph", async () => {
      const editor = vscode3.window.activeTextEditor;
      if (!editor) {
        vscode3.window.showErrorMessage("Call Map: C/C++ \u30D5\u30A1\u30A4\u30EB\u3092\u958B\u3044\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
        return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const mode = await pickOutputMode();
      if (!mode)
        return;
      await buildAndOutput(
        mode,
        editor.document.fileName,
        context.extensionUri,
        (prog, tok) => buildFunctionCallGraph(editor.document, editor.selection.active, 4, prog, backend, tok)
      );
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("callgraph.showWorkspaceGraph", async () => {
      const extPick = await vscode3.window.showQuickPick(
        [
          {
            label: "$(files) \u3059\u3079\u3066 (\u30BD\u30FC\u30B9\u306E\u307F)",
            description: ".c .cpp .cc .cxx .cu .cuh",
            glob: "**/*.{c,cpp,cc,cxx,cu,cuh}"
          },
          {
            label: "$(file-code) C \u30BD\u30FC\u30B9",
            description: ".c",
            glob: "**/*.c"
          },
          {
            label: "$(file-code) C++ \u30BD\u30FC\u30B9",
            description: ".cpp .cc .cxx",
            glob: "**/*.{cpp,cc,cxx}"
          },
          {
            label: "$(file-code) CUDA",
            description: ".cu .cuh",
            glob: "**/*.{cu,cuh}"
          }
        ],
        { placeHolder: "\u89E3\u6790\u5BFE\u8C61\u306E\u62E1\u5F35\u5B50\u3092\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044", title: "Call Map: \u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u6A2A\u65AD\u89E3\u6790" }
      );
      if (!extPick)
        return;
      const foundUris = await vscode3.window.withProgress(
        { location: vscode3.ProgressLocation.Notification, title: "C/C++ \u30D5\u30A1\u30A4\u30EB\u3092\u691C\u7D22\u4E2D...", cancellable: false },
        () => vscode3.workspace.findFiles(extPick.glob, EXCLUDE_GLOB)
      );
      if (!foundUris.length) {
        vscode3.window.showErrorMessage(
          "Call Map: \u5BFE\u8C61\u30D5\u30A1\u30A4\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\n\u5BFE\u8C61: " + extPick.description
        );
        return;
      }
      if (foundUris.length > WARN_THRESHOLD) {
        const answer = await vscode3.window.showWarningMessage(
          `${foundUris.length} \u30D5\u30A1\u30A4\u30EB\u3092\u89E3\u6790\u3057\u307E\u3059\u3002\u7D9A\u884C\u3057\u307E\u3059\u304B?`,
          { modal: true },
          "\u7D9A\u884C"
        );
        if (answer !== "\u7D9A\u884C")
          return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const mode = await pickOutputMode();
      if (!mode)
        return;
      await buildAndOutput(
        mode,
        `${foundUris.length} \u30D5\u30A1\u30A4\u30EB`,
        context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, prog, backend, tok)
      );
    })
  );
}
function deactivate() {
  CallGraphPanel.currentPanel?.dispose();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
