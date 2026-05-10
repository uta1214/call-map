"use strict";var re=Object.create;var F=Object.defineProperty;var ae=Object.getOwnPropertyDescriptor;var le=Object.getOwnPropertyNames;var ce=Object.getPrototypeOf,de=Object.prototype.hasOwnProperty;var pe=(t,e)=>{for(var o in e)F(t,o,{get:e[o],enumerable:!0})},V=(t,e,o,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of le(e))!de.call(t,i)&&i!==o&&F(t,i,{get:()=>e[i],enumerable:!(n=ae(e,i))||n.enumerable});return t};var S=(t,e,o)=>(o=t!=null?re(ce(t)):{},V(e||!t||!t.__esModule?F(o,"default",{value:t,enumerable:!0}):o,t)),ue=t=>V(F({},"__esModule",{value:!0}),t);var Ce={};pe(Ce,{activate:()=>xe,deactivate:()=>ye});module.exports=ue(Ce);var p=S(require("vscode")),ie=S(require("path"));var r=S(require("vscode")),M=S(require("path")),I=S(require("fs")),K=S(require("crypto")),O=[{background:"#ffeaa7",border:"#fdcb6e"},{background:"#fab1a0",border:"#e17055"},{background:"#a29bfe",border:"#6c5ce7"},{background:"#81ecec",border:"#00cec9"},{background:"#55efc4",border:"#00b894"},{background:"#fd79a8",border:"#e84393"},{background:"#74b9ff",border:"#0984e3"},{background:"#dfe6e9",border:"#b2bec3"}];function ge(t){let e={};return t.forEach((o,n)=>{e[o]=n<O.length?O[n]:{background:`hsl(${Math.round(n*360/t.length%360)},65%,80%)`,border:`hsl(${Math.round(n*360/t.length%360)},65%,55%)`}}),e}function Y(t){let e=[...new Set(t.nodes.map(i=>i.file))].sort(),o=ge(e),n=e.map(i=>({file:i,color:o[i].background,border:o[i].border}));return{type:"graphData",nodes:t.nodes.map(i=>({id:i.id,label:i.labelShort,labelFull:i.labelFull,labelShort:i.labelShort,file:i.file,line:i.line,source:i.source,isCurrentFile:i.isCurrentFile,color:o[i.file]??O[O.length-1],title:`${i.labelShort}
${M.basename(i.file)} : ${i.line}\u884C`})),edges:t.edges,fileLegend:n,buildTimeMs:t.buildTimeMs,errors:t.errors}}function he(t,e){let o=r.Uri.joinPath(t,"dist").fsPath,n=I.readFileSync(M.join(o,"vis-network.min.js"),"utf-8"),i=I.readFileSync(M.join(o,"webview.js"),"utf-8"),a=Y(e);return q("",[`<script>var INITIAL_GRAPH_DATA = ${JSON.stringify(a)};</script>`,`<script>${n}</script>`,`<script>${i}</script>`].join(`
`),"")}var R=class t{constructor(e,o){this._disposables=[];this._isReady=!1;this._pendingMessage=null;this._lastGraphData=null;this._panel=e,this._extensionUri=o,this._panel.webview.onDidReceiveMessage(async n=>{switch(n.type){case"ready":this._isReady=!0,this._pendingMessage&&(this._panel.webview.postMessage(this._pendingMessage),this._pendingMessage=null);break;case"openFile":n.file&&n.line!==void 0&&await this._openFileAtLine(n.file,n.line);break;case"exportHtml":this._lastGraphData?await t.exportHtmlFile(this._extensionUri,this._lastGraphData):r.window.showWarningMessage("\u30A8\u30AF\u30B9\u30DD\u30FC\u30C8\u3059\u308B\u30B0\u30E9\u30D5\u304C\u3042\u308A\u307E\u305B\u3093\u3002");break}},null,this._disposables),this._panel.onDidDispose(()=>this.dispose(),null,this._disposables),this._panel.webview.html=this._buildHtml()}static createOrShow(e){let o=r.window.activeTextEditor?r.ViewColumn.Beside:r.ViewColumn.One;if(t.currentPanel)return t.currentPanel._panel.reveal(o),t.currentPanel;let n=r.window.createWebviewPanel("callGraphViewer","Call Graph",o,{enableScripts:!0,retainContextWhenHidden:!0,localResourceRoots:[e]});return t.currentPanel=new t(n,e),t.currentPanel}setLoading(e){this._panel.title="Call Graph \u2014 \u89E3\u6790\u4E2D...",this._postOrQueue({type:"loading",fileName:e})}updateGraph(e){this._lastGraphData=e,this._panel.title=`Call Graph \u2014 ${e.fileName}`,this._postOrQueue(Y(e))}showError(e){this._panel.title="Call Graph \u2014 \u30A8\u30E9\u30FC",this._postOrQueue({type:"error",message:e})}static async exportHtmlFile(e,o){let n=r.workspace.workspaceFolders?.[0]?.uri,i=o.fileName.replace(/[^\w.-]/g,"_"),a=n?r.Uri.joinPath(n,`callgraph_${i}.html`):r.Uri.file(M.join(process.env.HOME??"/tmp",`callgraph_${i}.html`)),s=await r.window.showSaveDialog({defaultUri:a,filters:{"HTML \u30D5\u30A1\u30A4\u30EB":["html"]}});if(s)try{let d=he(e,o);await r.workspace.fs.writeFile(s,Buffer.from(d,"utf-8")),await r.window.showInformationMessage(`\u4FDD\u5B58\u5B8C\u4E86: ${M.basename(s.fsPath)}`,"\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F")==="\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F"&&await r.env.openExternal(s)}catch(d){r.window.showErrorMessage(`\u4FDD\u5B58\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ${d}`)}}dispose(){t.currentPanel=void 0,this._panel.dispose(),this._disposables.forEach(e=>e.dispose())}_postOrQueue(e){this._isReady?this._panel.webview.postMessage(e):this._pendingMessage=e}async _openFileAtLine(e,o){try{let n=r.Uri.file(e),i=new r.Position(Math.max(0,o-1),0),a=await r.workspace.openTextDocument(n);await r.window.showTextDocument(a,{selection:new r.Range(i,i),viewColumn:r.ViewColumn.One})}catch{r.window.showErrorMessage(`\u30D5\u30A1\u30A4\u30EB\u3092\u958B\u3051\u307E\u305B\u3093\u3067\u3057\u305F: ${e}`)}}_buildHtml(){let e=K.randomBytes(16).toString("hex"),o=this._panel.webview,n=r.Uri.joinPath(this._extensionUri,"dist"),i=o.asWebviewUri(r.Uri.joinPath(n,"vis-network.min.js")),a=o.asWebviewUri(r.Uri.joinPath(n,"webview.js")),s=o.cspSource;return q(e,`<script nonce="${e}" src="${i}"></script>
<script nonce="${e}" src="${a}"></script>`,s)}};function q(t,e,o){return`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
${t?`<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'nonce-${t}' ${o}; style-src 'unsafe-inline';">`:""}
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
.ctrl-label { cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 11px; color: #2d3436; margin-bottom: 4px; }
</style>
</head>
<body>
<div id="network"></div>

<div id="controls">
  <b style="font-size:13px;">\u{1F4DE} Call Graph</b>
  <div style="color:#636e72;font-size:11px;margin:2px 0 8px;">
    <b style="color:#00b894;">\u25CF</b> \u9078\u629E\u4E2D &nbsp;
    <b style="color:#e17055;">\u25CF</b> callee &nbsp;
    <b style="color:#0984e3;">\u25CF</b> caller &nbsp;
    <span style="color:#aaa;font-size:10px;">Ctrl+\u30AF\u30EA\u30C3\u30AF\u2192\u30B8\u30E3\u30F3\u30D7</span>
  </div>
  <input id="search-box" type="text" placeholder="\u{1F50D} \u95A2\u6570\u540D\u3092\u691C\u7D22">

  <!-- \u5F15\u6570\u8868\u793A\u5207\u308A\u66FF\u3048 -->
  <label class="ctrl-label">
    <input id="sig-toggle" type="checkbox" checked style="cursor:pointer;"> \u5F15\u6570\u3092\u8868\u793A
  </label>

  <label class="ctrl-label">
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

${e}
</body>
</html>`}var C=S(require("vscode")),y=S(require("path")),D=2,X=50,me=new Set([".c",".cpp",".cc",".cxx",".cu",".cuh"]);function N(t){let e=(C.workspace.workspaceFolders??[]).map(o=>o.uri.fsPath);return e.length===0&&t?[y.dirname(t.fsPath)]:e}function fe(t,e){if(e.length===0)return!0;let o=t.fsPath;return e.some(n=>o===n||o.startsWith(n+y.sep)||o.startsWith(n+"/"))}function Z(t){return me.has(y.extname(t.fsPath).toLowerCase())}function j(t,e){return fe(t,e)&&Z(t)}function A(t){let e=t.indexOf("(");return e>=0?t.slice(0,e).trim():t}function $(t,e,o){return`${t.fsPath}||${A(e)}||${o}`}function U(t,e,o,n,i,a){let s=A(e);return{id:t,label:s,labelFull:e,labelShort:s,file:o,line:n,source:i,isCurrentFile:a}}function z(t,e,o){if(!o.includes("("))return;let n=t.get(e);n&&(n.labelFull.includes("(")||(n.labelFull=o,t.set(e,n)))}function ee(t){let e=new Set([C.SymbolKind.Function,C.SymbolKind.Method,C.SymbolKind.Constructor]),o=new Set,n=[];function i(a){for(let s of a){if(e.has(s.kind)){let d=s.selectionRange.start.line;o.has(d)||(o.add(d),n.push(s))}s.children?.length&&i(s.children)}}return i(t),n}async function H(t,e){let o=t.fsPath;if(e.has(o))return e.get(o);try{let n=(await C.workspace.openTextDocument(t)).getText().split(`
`);return e.set(o,n),n}catch{return e.set(o,[]),[]}}function T(t,e,o){return t.slice(e,Math.min(o+1,t.length)).join(`
`)}function L(t){return new Promise(e=>setTimeout(e,t))}var J=6,be=200;async function _(t,...e){for(let o=0;o<J;o++)try{return await C.commands.executeCommand(t,...e)}catch(n){let i=String(n);if(i.includes("not found"))throw n;if(i.includes("Canceled")&&o<J-1){await L(be*Math.pow(2,o));continue}throw n}}function W(t){return Array.from(t).map(e=>{let o=e.indexOf("|||");return{from:e.slice(0,o),to:e.slice(o+3)}})}async function te(t,e){let o=Date.now(),n=[],i=new Map,a=N(t.uri),s=t.getText().split(`
`);i.set(t.uri.fsPath,s),e?.report({message:"\u30B7\u30F3\u30DC\u30EB\u3092\u53D6\u5F97\u4E2D..."});let d=await C.commands.executeCommand("vscode.executeDocumentSymbolProvider",t.uri);if(!d?.length)throw new Error(`\u30B7\u30F3\u30DC\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002

\u3010\u78BA\u8A8D\u4E8B\u9805\u3011
  1. clangd \u307E\u305F\u306F C/C++ \u62E1\u5F35\u6A5F\u80FD\u304C\u6709\u52B9\u304B
  2. \u30A4\u30F3\u30C7\u30C3\u30AF\u30B9\u4F5C\u6210\u304C\u5B8C\u4E86\u3057\u3066\u3044\u308B\u304B
  3. clangd \u306E\u5834\u5408: compile_commands.json \u304C\u3042\u308B\u304B`);let b=ee(d);if(!b.length)throw new Error("\u3053\u306E\u30D5\u30A1\u30A4\u30EB\u306B\u95A2\u6570\u30B7\u30F3\u30DC\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002");let m=new Map,w=new Set;for(let u of b){let c=$(t.uri,u.name,u.selectionRange.start.line);m.has(c)||m.set(c,U(c,u.name,t.uri.fsPath,u.selectionRange.start.line+1,T(s,u.range.start.line,u.range.end.line),!0))}let h=b.length;for(let u=0;u<b.length;u+=D){let c=b.slice(u,u+D);e?.report({message:`\u30B3\u30FC\u30EB\u89E3\u6790\u4E2D... (${Math.min(u+D,h)}/${h})`,increment:c.length/h*80}),await Promise.all(c.map(async k=>{try{let l=await _("vscode.prepareCallHierarchy",t.uri,k.selectionRange.start);if(!l?.length)return;let g=$(t.uri,k.name,k.selectionRange.start.line);z(m,g,l[0].name);let f=await _("vscode.provideOutgoingCalls",l[0]);if(!f?.length)return;for(let P of f){let{to:v}=P,G=$(v.uri,v.name,v.selectionRange.start.line);if(m.has(G))z(m,G,v.name);else{if(!j(v.uri,a))continue;let x=await H(v.uri,i);m.set(G,U(G,v.name,v.uri.fsPath,v.selectionRange.start.line+1,T(x,v.range.start.line,v.range.end.line),!1))}w.add(`${g}|||${G}`)}}catch(l){n.push(`${k.name}: ${String(l)}`)}})),u+D<b.length&&await L(X)}return{nodes:Array.from(m.values()),edges:W(w),fileName:y.basename(t.uri.fsPath),buildTimeMs:Date.now()-o,errors:n}}async function oe(t,e,o=4,n){let i=Date.now(),a=[],s=new Map,d=N(t.uri);n?.report({message:"\u8D77\u70B9\u95A2\u6570\u3092\u7279\u5B9A\u4E2D..."});let b=await _("vscode.prepareCallHierarchy",t.uri,e);if(!b?.length)throw new Error(`\u30AB\u30FC\u30BD\u30EB\u4F4D\u7F6E\u306B\u95A2\u6570\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002
\u95A2\u6570\u540D\u306E\u4E0A\u306B\u30AB\u30FC\u30BD\u30EB\u3092\u7F6E\u3044\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);let m=new Map,w=new Set,h=new Set,u=[[b[0],0]];for(;u.length>0;){let[c,k]=u.shift(),l=$(c.uri,c.name,c.selectionRange.start.line);if(!h.has(l)){if(h.add(l),!m.has(l)){let g=await H(c.uri,s);m.set(l,U(l,c.name,c.uri.fsPath,c.selectionRange.start.line+1,T(g,c.range.start.line,c.range.end.line),c.uri.fsPath===t.uri.fsPath))}if(!(k>=o)){n?.report({message:`BFS \u5C55\u958B\u4E2D... (\u30CE\u30FC\u30C9: ${m.size})`});try{let g=await _("vscode.provideOutgoingCalls",c);if(!g?.length)continue;for(let f of g){if(!j(f.to.uri,d))continue;let P=$(f.to.uri,f.to.name,f.to.selectionRange.start.line);m.has(P)&&z(m,P,f.to.name),w.add(`${l}|||${P}`),h.has(P)||u.push([f.to,k+1])}}catch(g){a.push(`${c.name}: ${String(g)}`)}}}}return{nodes:Array.from(m.values()),edges:W(w),fileName:`${A(b[0].name)} (${y.basename(t.uri.fsPath)})`,buildTimeMs:Date.now()-i,errors:a}}async function ne(t,e){let o=Date.now(),n=[],i=new Map,a=Array.from(new Map(t.map(w=>[w.fsPath,w])).values()),s=N(a[0]),d=new Map,b=new Set;for(let w=0;w<a.length;w++){let h=a[w];if(!Z(h))continue;e?.report({message:`\u89E3\u6790\u4E2D ${w+1}/${a.length}: ${y.basename(h.fsPath)}`,increment:1/a.length*100});let u;try{u=await C.commands.executeCommand("vscode.executeDocumentSymbolProvider",h)}catch{continue}if(!u?.length)continue;let c=ee(u),k=await H(h,i);for(let l of c){let g=$(h,l.name,l.selectionRange.start.line);d.has(g)||d.set(g,U(g,l.name,h.fsPath,l.selectionRange.start.line+1,T(k,l.range.start.line,l.range.end.line),!1))}for(let l=0;l<c.length;l+=D)await Promise.all(c.slice(l,l+D).map(async g=>{try{let f=await _("vscode.prepareCallHierarchy",h,g.selectionRange.start);if(!f?.length)return;let P=$(h,g.name,g.selectionRange.start.line);z(d,P,f[0].name);let v=await _("vscode.provideOutgoingCalls",f[0]);if(!v?.length)return;for(let G of v){let{to:x}=G,E=$(x.uri,x.name,x.selectionRange.start.line);if(d.has(E))z(d,E,x.name);else{if(!j(x.uri,s))continue;let se=await H(x.uri,i);d.set(E,U(E,x.name,x.uri.fsPath,x.selectionRange.start.line+1,T(se,x.range.start.line,x.range.end.line),!1))}b.add(`${P}|||${E}`)}}catch(f){n.push(`${y.basename(h.fsPath)}::${g.name}: ${String(f)}`)}})),l+D<c.length&&await L(X)}let m=a.length===1?y.basename(a[0].fsPath):`${a.length} \u30D5\u30A1\u30A4\u30EB`;return{nodes:Array.from(d.values()),edges:W(b),fileName:m,buildTimeMs:Date.now()-o,errors:n}}var ve="{**/node_modules/**,**/build/**,**/dist/**,**/out/**,**/.git/**}",we=50;async function B(){return(await p.window.showQuickPick([{label:"$(callhierarchy-outgoing) WebView \u3067\u8868\u793A",mode:"webview"},{label:"$(browser) HTML \u30D5\u30A1\u30A4\u30EB\u306B\u4FDD\u5B58\u3057\u3066\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F",mode:"html"}],{placeHolder:"\u8868\u793A\u65B9\u6CD5\u3092\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044",title:"Call Graph: \u51FA\u529B\u30E2\u30FC\u30C9"}))?.mode}async function Q(t,e,o,n){let i=t==="webview"?R.createOrShow(o):void 0;i?.setLoading(ie.basename(e)),await p.window.withProgress({location:p.ProgressLocation.Notification,title:"Call Graph \u3092\u69CB\u7BC9\u4E2D",cancellable:!1},async a=>{try{let s=await n(a);s.errors.length>0&&console.warn("[CallGraph] \u89E3\u6790\u8B66\u544A:",s.errors),t==="webview"?(i.updateGraph(s),p.window.setStatusBarMessage(`\u{1F4DE} Call Graph: ${s.nodes.length} \u30CE\u30FC\u30C9 / ${s.edges.length} \u30A8\u30C3\u30B8 (${s.buildTimeMs}ms)`,6e3)):await R.exportHtmlFile(o,s)}catch(s){let d=s instanceof Error?s.message:String(s);i?i.showError(d):p.window.showErrorMessage(`Call Graph \u30A8\u30E9\u30FC:
`+d)}})}function xe(t){t.subscriptions.push(p.commands.registerCommand("callgraph.showFileGraph",async()=>{let e=p.window.activeTextEditor;if(!e){p.window.showErrorMessage("Call Graph: C/C++ \u30D5\u30A1\u30A4\u30EB\u3092\u958B\u3044\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");return}let o=await B();o&&await Q(o,e.document.fileName,t.extensionUri,n=>te(e.document,n))})),t.subscriptions.push(p.commands.registerCommand("callgraph.showFunctionGraph",async()=>{let e=p.window.activeTextEditor;if(!e){p.window.showErrorMessage("Call Graph: C/C++ \u30D5\u30A1\u30A4\u30EB\u3092\u958B\u3044\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");return}let o=await B();o&&await Q(o,e.document.fileName,t.extensionUri,n=>oe(e.document,e.selection.active,4,n))})),t.subscriptions.push(p.commands.registerCommand("callgraph.showWorkspaceGraph",async()=>{let e=await p.window.showQuickPick([{label:"$(files) \u3059\u3079\u3066 (\u30BD\u30FC\u30B9\u306E\u307F)",description:".c .cpp .cc .cxx .cu .cuh",glob:"**/*.{c,cpp,cc,cxx,cu,cuh}"},{label:"$(file-code) C \u30BD\u30FC\u30B9",description:".c",glob:"**/*.c"},{label:"$(file-code) C++ \u30BD\u30FC\u30B9",description:".cpp .cc .cxx",glob:"**/*.{cpp,cc,cxx}"},{label:"$(file-code) CUDA",description:".cu .cuh",glob:"**/*.{cu,cuh}"}],{placeHolder:"\u89E3\u6790\u5BFE\u8C61\u306E\u62E1\u5F35\u5B50\u3092\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044",title:"Call Graph: \u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u6A2A\u65AD\u89E3\u6790"});if(!e)return;let o=await p.window.withProgress({location:p.ProgressLocation.Notification,title:"C/C++ \u30D5\u30A1\u30A4\u30EB\u3092\u691C\u7D22\u4E2D...",cancellable:!1},()=>p.workspace.findFiles(e.glob,ve));if(!o.length){p.window.showErrorMessage(`Call Graph: \u5BFE\u8C61\u30D5\u30A1\u30A4\u30EB\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002
\u5BFE\u8C61: `+e.description);return}if(o.length>we&&await p.window.showWarningMessage(`${o.length} \u30D5\u30A1\u30A4\u30EB\u3092\u89E3\u6790\u3057\u307E\u3059\u3002\u7D9A\u884C\u3057\u307E\u3059\u304B?`,{modal:!0},"\u7D9A\u884C")!=="\u7D9A\u884C")return;let n=await B();n&&await Q(n,`${o.length} \u30D5\u30A1\u30A4\u30EB`,t.extensionUri,i=>ne(o,i))}))}function ye(){}0&&(module.exports={activate,deactivate});
