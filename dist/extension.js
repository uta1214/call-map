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
var vscode2 = __toESM(require("vscode"));
var path2 = __toESM(require("path"));
var fs2 = __toESM(require("fs"));
var crypto = __toESM(require("crypto"));
var os2 = __toESM(require("os"));

// src/callGraphBuilder.ts
var vscode = __toESM(require("vscode"));
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var import_child_process = require("child_process");
var import_util = require("util");
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
var BATCH_SIZE = 6;
var BATCH_DELAY_INIT = 20;
var BATCH_DELAY_MIN = 0;
var BATCH_DELAY_MAX = 150;
var CC_SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([".c", ".cpp", ".cc", ".cxx", ".cu", ".cuh"]);
var CC_ALL_GLOB = "**/*.{c,cpp,cc,cxx,cu,cuh,h,hpp,hxx}";
var EXCLUDE_GLOB = "{" + [
  "**/node_modules/**",
  "**/build/**",
  "**/dist/**",
  "**/out/**",
  "**/.git/**",
  "**/CMakeFiles/**",
  "**/_build/**",
  "**/_deps/**",
  "**/cmake-build-debug/**",
  "**/cmake-build-release/**",
  "**/.cache/**",
  "**/.ccls-cache/**",
  "**/vendor/**",
  "**/.deps/**"
].join(",") + "}";
var GLOBAL_RX_PARALLEL = Math.max(4, Math.min(os.cpus().length * 2, 32));
var GTAGS_UPDATE_TTL = 5 * 6e4;
var gtagsUpdateCache = /* @__PURE__ */ new Map();
var MAX_CACHE_ENTRIES = 20;
var CACHE_TTL_MS = 5 * 6e4;
var graphDataCache = /* @__PURE__ */ new Map();
var TAGS_CACHE_TTL_MS = GTAGS_UPDATE_TTL;
var tagsCache = /* @__PURE__ */ new Map();
var FILES_CACHE_TTL_MS = 6e4;
var filesCache = /* @__PURE__ */ new Map();
var LAZY_CACHE_TTL_MS = GTAGS_UPDATE_TTL;
var lazyTagCache = /* @__PURE__ */ new Map();
var lazyScopeCache = /* @__PURE__ */ new Map();
var REALPATH_CACHE_MAX = 500;
var realpathCache = /* @__PURE__ */ new Map();
function setRealpathCache(key, value) {
  if (realpathCache.size >= REALPATH_CACHE_MAX)
    realpathCache.clear();
  realpathCache.set(key, value);
}
function setGraphCache(key, entry) {
  if (graphDataCache.has(key))
    graphDataCache.delete(key);
  if (graphDataCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = graphDataCache.keys().next().value;
    if (firstKey !== void 0)
      graphDataCache.delete(firstKey);
  }
  graphDataCache.set(key, entry);
}
function invalidateCache(filePath) {
  if (!filePath) {
    graphDataCache.clear();
    tagsCache.clear();
    filesCache.clear();
    lazyTagCache.clear();
    lazyScopeCache.clear();
    realpathCache.clear();
    return;
  }
  const norm = normalizeFsPath(filePath);
  for (const key of graphDataCache.keys()) {
    const segments = key.split("::");
    const keyPath = segments[1] ?? "";
    if (keyPath === norm || keyPath === filePath)
      graphDataCache.delete(key);
  }
  const allWsRoots = /* @__PURE__ */ new Set([
    ...tagsCache.keys(),
    ...lazyTagCache.keys(),
    ...lazyScopeCache.keys()
  ]);
  const affectedRoots = [...allWsRoots].filter((wsRoot) => {
    const normRoot = normalizeFsPath(wsRoot);
    return norm.startsWith(normRoot + "/") || norm.startsWith(normRoot + path.sep);
  });
  if (affectedRoots.length === 0) {
    tagsCache.clear();
    filesCache.clear();
    lazyTagCache.clear();
    lazyScopeCache.clear();
  } else {
    for (const wsRoot of affectedRoots) {
      tagsCache.delete(wsRoot);
      lazyTagCache.delete(wsRoot);
      lazyScopeCache.delete(wsRoot);
    }
    filesCache.clear();
  }
  realpathCache.clear();
}
function normalizeFsPath(p) {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
var lowerScopeIndexCache = /* @__PURE__ */ new WeakMap();
function getLowerScopeIndex(scopeMap) {
  const cached = lowerScopeIndexCache.get(scopeMap);
  if (cached)
    return cached;
  const lower = /* @__PURE__ */ new Map();
  for (const [k, v] of scopeMap) {
    const lk = normalizeFsPath(k).toLowerCase();
    if (!lower.has(lk))
      lower.set(lk, v);
  }
  lowerScopeIndexCache.set(scopeMap, lower);
  return lower;
}
function findScopeMapEntry(scopeMap, filePath) {
  let entry = scopeMap.get(filePath);
  if (entry)
    return entry;
  const norm = normalizeFsPath(filePath);
  entry = scopeMap.get(norm);
  if (entry)
    return entry;
  if (process.platform !== "linux") {
    const lower = norm.toLowerCase();
    entry = getLowerScopeIndex(scopeMap).get(lower);
    if (entry)
      return entry;
  }
  try {
    const real = realpathCache.get(filePath) ?? (() => {
      const r = fs.realpathSync(filePath);
      setRealpathCache(filePath, r);
      return r;
    })();
    entry = scopeMap.get(real);
    if (entry)
      return entry;
    const realNorm = normalizeFsPath(real);
    for (const [k, v] of scopeMap) {
      if (normalizeFsPath(k) === realNorm)
        return v;
    }
  } catch {
  }
  return void 0;
}
function splitEdges(edgeSet) {
  return Array.from(edgeSet).map((key) => {
    const sep3 = key.indexOf("|||");
    return { from: key.slice(0, sep3), to: key.slice(sep3 + 3) };
  });
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nextAdaptiveDelay(current, hasErrors, streak) {
  if (hasErrors) {
    streak.val = 0;
    return Math.min(Math.round(current * 1.5) + 10, BATCH_DELAY_MAX);
  }
  streak.val++;
  if (streak.val >= 3) {
    return Math.max(Math.round(current * 0.5), BATCH_DELAY_MIN);
  }
  return Math.max(Math.round(current * 0.85) - 2, BATCH_DELAY_MIN);
}
var Pct = class {
  constructor(p) {
    this.p = p;
    this.cur = 0;
  }
  to(val) {
    const v = Math.min(100, Math.max(0, Math.round(val)));
    const delta = v - this.cur;
    if (delta > 0) {
      this.p?.report({ message: `${v}%`, increment: delta });
      this.cur = v;
    }
  }
  range(start, end, pos, total) {
    this.to(start + (end - start) * pos / Math.max(1, total));
  }
  /** touched.size - pending.length ≈ 処理済み件数 */
  bfsQ(start, end, touched, pending) {
    const total = touched.size;
    const done = Math.max(0, total - pending.length);
    this.to(total === 0 ? end : start + (end - start) * done / total);
  }
  /** ④ パフォーマンス改善: パーセントを変えずにメッセージだけ更新する */
  report(message) {
    this.p?.report({ message, increment: 0 });
  }
};
function getWorkspaceRoots(fallbackUri) {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0 && fallbackUri)
    return [path.dirname(fallbackUri.fsPath)];
  return folders;
}
function getWorkspaceRootForFile(fileUri) {
  const filePath = normalizeFsPath(fileUri.fsPath);
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = normalizeFsPath(folder.uri.fsPath);
    if (filePath === root || filePath.startsWith(root + path.sep) || filePath.startsWith(root + "/")) {
      return folder.uri.fsPath;
    }
  }
  return folders[0]?.uri.fsPath ?? path.dirname(fileUri.fsPath);
}
var _gtagsAvailableCache;
var _gtagsAvailableFalseTs;
var GTAGS_FALSE_TTL = 3e4;
async function gtagsAvailable() {
  if (_gtagsAvailableCache === true)
    return true;
  if (_gtagsAvailableCache === false && _gtagsAvailableFalseTs !== void 0) {
    if (Date.now() - _gtagsAvailableFalseTs < GTAGS_FALSE_TTL)
      return false;
  }
  try {
    await execFileAsync("gtags", ["--version"], { timeout: 5e3 });
    _gtagsAvailableCache = true;
    _gtagsAvailableFalseTs = void 0;
  } catch {
    _gtagsAvailableCache = false;
    _gtagsAvailableFalseTs = Date.now();
  }
  return _gtagsAvailableCache;
}
async function resolveBackend(backend) {
  if (backend === "lsp")
    return "lsp";
  if (backend === "gtags")
    return "gtags";
  return await gtagsAvailable() ? "gtags" : "lsp";
}
function hasCppSourceExtension(uri) {
  return CC_SOURCE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}
function isInWorkspace(uri, roots) {
  if (roots.length === 0)
    return true;
  const p = uri.fsPath;
  return roots.some((r) => p === r || p.startsWith(r + path.sep) || p.startsWith(r + "/"));
}
var CC_CALLEE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".cu",
  ".cuh",
  // ソース (既存)
  ".h",
  ".hpp",
  ".hxx"
  // ヘッダー (追加)
]);
function shouldIncludeCallee(uri, roots) {
  if (roots.length === 0)
    return false;
  return isInWorkspace(uri, roots) && CC_CALLEE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}
function makeNodeId(uri, name, line) {
  return `${uri.fsPath}\0${baseNameOf(name)}\0${line}`;
}
function baseNameOf(name) {
  const idx = name.indexOf("(");
  return idx >= 0 ? name.slice(0, idx).trim() : name;
}
function addToNodeIndex(index, id, node) {
  const key = `${node.file}\0${node.label}`;
  if (!index.has(key))
    index.set(key, id);
}
function findExistingCalleeId(nodes, index, to) {
  const exactId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
  if (nodes.has(exactId))
    return exactId;
  const base = baseNameOf(to.name);
  const fp = to.uri.fsPath;
  const indexed = index.get(`${fp}\0${base}`);
  if (indexed)
    return indexed;
  const ext = path.extname(fp).toLowerCase();
  if ([".h", ".hpp", ".hxx"].includes(ext)) {
    for (const [id, node] of nodes) {
      if (node.label === base || baseNameOf(node.label) === base)
        return id;
    }
  }
  return null;
}
function flattenFunctions(syms) {
  const KINDS = /* @__PURE__ */ new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
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
var MAX_SOURCE_LINES = 200;
function checkCancellation(token) {
  if (token?.isCancellationRequested)
    throw new vscode.CancellationError();
}
var MAX_RETRY = 4;
var RETRY_BASE_MS = 200;
var CANCELED_RETRY_DELAY = 3e3;
async function execWithRetry(command, token, ...args) {
  for (let i = 0; i < MAX_RETRY; i++) {
    checkCancellation(token);
    try {
      return await vscode.commands.executeCommand(command, ...args);
    } catch (err) {
      if (err instanceof vscode.CancellationError)
        throw err;
      const msg = String(err);
      if (msg.includes("not found"))
        throw err;
      if (i < MAX_RETRY - 1) {
        await delay(RETRY_BASE_MS * Math.pow(2, i));
        continue;
      }
      throw err;
    }
  }
}
function isCanceledByClangd(err) {
  return !(err instanceof vscode.CancellationError) && String(err).includes("Canceled");
}
async function buildFileCallGraphLsp(document, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);
  const rawSyms = await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    document.uri
  );
  if (!rawSyms?.length)
    throw new Error(
      "No symbols found.\n\n[Checklist]\n  1. Is clangd or C/C++ extension enabled?\n  2. Has the index finished building?\n  3. (clangd) Does compile_commands.json exist?"
    );
  const functions = flattenFunctions(rawSyms);
  if (!functions.length)
    throw new Error("No function symbols found in this file.");
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  const nodeIndex = /* @__PURE__ */ new Map();
  for (const f of functions) {
    const id = makeNodeId(document.uri, f.name, f.selectionRange.start.line);
    const node = {
      id,
      label: baseNameOf(f.name),
      labelFull: f.name,
      file: document.uri.fsPath,
      line: f.selectionRange.start.line + 1,
      scopeEnd: f.range.end.line + 1,
      // ⑥ lazy source 用
      isCurrentFile: true
    };
    nodes.set(id, node);
    addToNodeIndex(nodeIndex, id, node);
  }
  pct.to(5);
  {
    const downVisited = /* @__PURE__ */ new Set();
    const downQueue = [];
    let adaptiveDelay = BATCH_DELAY_INIT;
    const downStreak = { val: 0 };
    const coreItemsMap = /* @__PURE__ */ new Map();
    for (let i = 0; i < functions.length; i += BATCH_SIZE) {
      checkCancellation(token);
      await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async (f) => {
        const coreId = makeNodeId(document.uri, f.name, f.selectionRange.start.line);
        try {
          const items = await execWithRetry(
            "vscode.prepareCallHierarchy",
            token,
            document.uri,
            f.selectionRange.start
          );
          if (!items?.length)
            return;
          coreItemsMap.set(coreId, items[0]);
          downQueue.push([items[0], coreId]);
          downVisited.add(coreId);
        } catch (err) {
          if (err instanceof vscode.CancellationError)
            throw err;
          errs.push(`(callee-prep) ${f.name}: ${String(err)}`);
        }
      }));
      pct.range(5, 20, Math.min(i + BATCH_SIZE, functions.length), functions.length);
    }
    let dqi = 0;
    while (dqi < downQueue.length) {
      checkCancellation(token);
      const batch = downQueue.slice(dqi, dqi + BATCH_SIZE);
      dqi += batch.length;
      const processingIds = /* @__PURE__ */ new Set();
      let errorsInBatch = 0;
      await Promise.all(batch.map(async ([callerItem, callerId]) => {
        try {
          const outgoing = await execWithRetry(
            "vscode.provideOutgoingCalls",
            token,
            callerItem
          );
          if (!outgoing?.length)
            return;
          for (const call of outgoing) {
            const { to } = call;
            let calleeId = findExistingCalleeId(nodes, nodeIndex, to);
            if (!calleeId) {
              if (!shouldIncludeCallee(to.uri, wsRoots))
                continue;
              calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
              if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                processingIds.add(calleeId);
                const calleeNode = {
                  id: calleeId,
                  label: baseNameOf(to.name),
                  labelFull: to.name,
                  file: to.uri.fsPath,
                  line: to.selectionRange.start.line + 1,
                  scopeEnd: to.range.end.line + 1,
                  isCurrentFile: to.uri.fsPath === document.uri.fsPath
                };
                nodes.set(calleeId, calleeNode);
                addToNodeIndex(nodeIndex, calleeId, calleeNode);
              }
            }
            edgeSet.add(`${callerId}|||${calleeId}`);
            if (!downVisited.has(calleeId)) {
              downVisited.add(calleeId);
              downQueue.push([to, calleeId]);
            }
          }
        } catch (err) {
          if (err instanceof vscode.CancellationError)
            throw err;
          errorsInBatch++;
          errs.push(`${callerItem.name}: ${String(err)}`);
        }
      }));
      adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, errorsInBatch > 0, downStreak);
      pct.bfsQ(20, 55, downVisited, downQueue);
      if (adaptiveDelay > 0 && downQueue.length > 0)
        await delay(adaptiveDelay);
    }
    pct.to(55);
    {
      const upVisited = /* @__PURE__ */ new Set();
      const upQueue = [];
      for (const [coreId, item] of coreItemsMap) {
        upQueue.push([item, coreId]);
        upVisited.add(coreId);
      }
      let upAdaptiveDelay = BATCH_DELAY_INIT;
      const upStreak = { val: 0 };
      let uqi = 0;
      while (uqi < upQueue.length) {
        checkCancellation(token);
        const batch = upQueue.slice(uqi, uqi + BATCH_SIZE);
        uqi += batch.length;
        let errorsInBatch = 0;
        await Promise.all(batch.map(async ([calleeItem, calleeId]) => {
          try {
            const incoming = await execWithRetry(
              "vscode.provideIncomingCalls",
              token,
              calleeItem
            );
            if (!incoming?.length)
              return;
            for (const call of incoming) {
              let callerId = findExistingCalleeId(nodes, nodeIndex, call.from);
              if (!callerId) {
                if (wsRoots.length === 0)
                  continue;
                if (!isInWorkspace(call.from.uri, wsRoots))
                  continue;
                callerId = makeNodeId(call.from.uri, call.from.name, call.from.selectionRange.start.line);
              }
              if (!nodes.has(callerId)) {
                const callerNode = {
                  id: callerId,
                  label: baseNameOf(call.from.name),
                  labelFull: call.from.name,
                  file: call.from.uri.fsPath,
                  line: call.from.selectionRange.start.line + 1,
                  scopeEnd: call.from.range.end.line + 1,
                  isCurrentFile: call.from.uri.fsPath === document.uri.fsPath
                };
                nodes.set(callerId, callerNode);
                addToNodeIndex(nodeIndex, callerId, callerNode);
              }
              edgeSet.add(`${callerId}|||${calleeId}`);
              if (!upVisited.has(callerId)) {
                upVisited.add(callerId);
                upQueue.push([call.from, callerId]);
              }
            }
          } catch (err) {
            if (err instanceof vscode.CancellationError)
              throw err;
            errorsInBatch++;
            errs.push(`(incoming) ${calleeItem.name}: ${String(err)}`);
          }
        }));
        upAdaptiveDelay = nextAdaptiveDelay(upAdaptiveDelay, errorsInBatch > 0, upStreak);
        pct.bfsQ(55, 100, upVisited, upQueue);
        if (upAdaptiveDelay > 0 && upQueue.length > 0)
          await delay(upAdaptiveDelay);
      }
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: path.basename(document.uri.fsPath),
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildFunctionCallGraphLsp(document, position, maxHops = 4, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);
  const startItems = await execWithRetry(
    "vscode.prepareCallHierarchy",
    token,
    document.uri,
    position
  );
  if (!startItems?.length)
    throw new Error(
      "No function found at cursor position.\nPlace the cursor on a function name and try again."
    );
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  const nodeIndex = /* @__PURE__ */ new Map();
  const visited = /* @__PURE__ */ new Set();
  const startNodeId = makeNodeId(startItems[0].uri, startItems[0].name, startItems[0].selectionRange.start.line);
  const queued = /* @__PURE__ */ new Set([startNodeId]);
  const queue = [[startItems[0], 0]];
  let qi = 0;
  let adaptiveDelay = BATCH_DELAY_INIT;
  const downStreak = { val: 0 };
  while (qi < queue.length) {
    checkCancellation(token);
    const batch = [];
    while (batch.length < BATCH_SIZE && qi < queue.length) {
      const [item, hop] = queue[qi++];
      const nodeId = makeNodeId(item.uri, item.name, item.selectionRange.start.line);
      if (visited.has(nodeId))
        continue;
      visited.add(nodeId);
      if (!nodes.has(nodeId)) {
        const newNode = {
          id: nodeId,
          label: baseNameOf(item.name),
          labelFull: item.name,
          file: item.uri.fsPath,
          line: item.selectionRange.start.line + 1,
          scopeEnd: item.range.end.line + 1,
          isCurrentFile: item.uri.fsPath === document.uri.fsPath
        };
        nodes.set(nodeId, newNode);
        addToNodeIndex(nodeIndex, nodeId, newNode);
      }
      if (hop < maxHops)
        batch.push({ item, hop, nodeId });
    }
    if (batch.length === 0)
      continue;
    let lspErrors = 0;
    const batchResults = await Promise.all(batch.map(async ({ item, hop, nodeId }) => {
      try {
        const outgoing = await execWithRetry(
          "vscode.provideOutgoingCalls",
          token,
          item
        );
        return { nodeId, hop, outgoing: outgoing ?? [] };
      } catch (err) {
        if (err instanceof vscode.CancellationError)
          throw err;
        errs.push(`${item.name}: ${String(err)}`);
        lspErrors++;
        return { nodeId, hop, outgoing: [] };
      }
    }));
    for (const { nodeId, hop, outgoing } of batchResults) {
      for (const call of outgoing) {
        let calleeId = findExistingCalleeId(nodes, nodeIndex, call.to);
        if (!calleeId) {
          if (!shouldIncludeCallee(call.to.uri, wsRoots))
            continue;
          calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
          if (!nodes.has(calleeId)) {
            const calleeNode = {
              id: calleeId,
              label: baseNameOf(call.to.name),
              labelFull: call.to.name,
              file: call.to.uri.fsPath,
              line: call.to.selectionRange.start.line + 1,
              scopeEnd: call.to.range.end.line + 1,
              isCurrentFile: call.to.uri.fsPath === document.uri.fsPath
            };
            nodes.set(calleeId, calleeNode);
            addToNodeIndex(nodeIndex, calleeId, calleeNode);
          }
        }
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!queued.has(calleeId)) {
          queued.add(calleeId);
          queue.push([call.to, hop + 1]);
        }
      }
    }
    adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, lspErrors > 0, downStreak);
    if (adaptiveDelay > 0 && qi < queue.length)
      await delay(adaptiveDelay);
    pct.bfsQ(5, 100, queued, { length: queue.length - qi });
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: `${baseNameOf(startItems[0].name)} (${path.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildPathThroughCallGraphLsp(document, position, maxHops = 4, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);
  const startItems = await execWithRetry(
    "vscode.prepareCallHierarchy",
    token,
    document.uri,
    position
  );
  if (!startItems?.length)
    throw new Error(
      "No function found at cursor position.\nPlace the cursor on a function name and try again."
    );
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  const nodeIndex = /* @__PURE__ */ new Map();
  const visited = /* @__PURE__ */ new Set();
  const startNodeId = makeNodeId(startItems[0].uri, startItems[0].name, startItems[0].selectionRange.start.line);
  const queued = /* @__PURE__ */ new Set([startNodeId]);
  const queue = [[startItems[0], 0]];
  let qi = 0;
  let adaptiveDelay = BATCH_DELAY_INIT;
  const downStreak2 = { val: 0 };
  while (qi < queue.length) {
    checkCancellation(token);
    const batch = [];
    while (batch.length < BATCH_SIZE && qi < queue.length) {
      const [item, hop] = queue[qi++];
      const nodeId = makeNodeId(item.uri, item.name, item.selectionRange.start.line);
      if (visited.has(nodeId))
        continue;
      visited.add(nodeId);
      if (!nodes.has(nodeId)) {
        const newNode = {
          id: nodeId,
          label: baseNameOf(item.name),
          labelFull: item.name,
          file: item.uri.fsPath,
          line: item.selectionRange.start.line + 1,
          scopeEnd: item.range.end.line + 1,
          isCurrentFile: item.uri.fsPath === document.uri.fsPath
        };
        nodes.set(nodeId, newNode);
        addToNodeIndex(nodeIndex, nodeId, newNode);
      }
      if (hop < maxHops)
        batch.push({ item, hop, nodeId });
    }
    if (batch.length === 0)
      continue;
    let lspErrors = 0;
    const batchResults = await Promise.all(batch.map(async ({ item, hop, nodeId }) => {
      try {
        const outgoing = await execWithRetry(
          "vscode.provideOutgoingCalls",
          token,
          item
        );
        return { nodeId, hop, outgoing: outgoing ?? [] };
      } catch (err) {
        if (err instanceof vscode.CancellationError)
          throw err;
        errs.push(`${item.name}: ${String(err)}`);
        lspErrors++;
        return { nodeId, hop, outgoing: [] };
      }
    }));
    for (const { nodeId, hop, outgoing } of batchResults) {
      for (const call of outgoing) {
        let calleeId = findExistingCalleeId(nodes, nodeIndex, call.to);
        if (!calleeId) {
          if (!shouldIncludeCallee(call.to.uri, wsRoots))
            continue;
          calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
          if (!nodes.has(calleeId)) {
            const calleeNode = {
              id: calleeId,
              label: baseNameOf(call.to.name),
              labelFull: call.to.name,
              file: call.to.uri.fsPath,
              line: call.to.selectionRange.start.line + 1,
              scopeEnd: call.to.range.end.line + 1,
              isCurrentFile: call.to.uri.fsPath === document.uri.fsPath
            };
            nodes.set(calleeId, calleeNode);
            addToNodeIndex(nodeIndex, calleeId, calleeNode);
          }
        }
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!queued.has(calleeId)) {
          queued.add(calleeId);
          queue.push([call.to, hop + 1]);
        }
      }
    }
    adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, lspErrors > 0, downStreak2);
    if (adaptiveDelay > 0 && qi < queue.length)
      await delay(adaptiveDelay);
    pct.bfsQ(5, 50, queued, { length: queue.length - qi });
  }
  pct.to(50);
  {
    const upQueued = /* @__PURE__ */ new Set([startNodeId]);
    let upCurrentLevel = [startItems[0]];
    let adaptiveDelay2 = BATCH_DELAY_INIT;
    const upStreak2 = { val: 0 };
    for (let hop = 0; hop < maxHops && upCurrentLevel.length > 0; hop++) {
      checkCancellation(token);
      const upNextLevel = [];
      for (let i = 0; i < upCurrentLevel.length; i += BATCH_SIZE) {
        checkCancellation(token);
        const batch = upCurrentLevel.slice(i, i + BATCH_SIZE);
        let lspErrors = 0;
        const batchResults = await Promise.all(batch.map(async (calleeItem) => {
          try {
            const incoming = await execWithRetry(
              "vscode.provideIncomingCalls",
              token,
              calleeItem
            );
            return { calleeItem, incoming: incoming ?? [] };
          } catch (err) {
            if (err instanceof vscode.CancellationError)
              throw err;
            errs.push(`(incoming) ${calleeItem.name}: ${String(err)}`);
            lspErrors++;
            return { calleeItem, incoming: [] };
          }
        }));
        for (const { calleeItem, incoming } of batchResults) {
          const calleeId = makeNodeId(calleeItem.uri, calleeItem.name, calleeItem.selectionRange.start.line);
          for (const call of incoming) {
            let callerId = findExistingCalleeId(nodes, nodeIndex, call.from);
            if (!callerId) {
              if (wsRoots.length === 0)
                continue;
              if (!isInWorkspace(call.from.uri, wsRoots))
                continue;
              callerId = makeNodeId(call.from.uri, call.from.name, call.from.selectionRange.start.line);
            }
            if (!nodes.has(callerId)) {
              const callerNode = {
                id: callerId,
                label: baseNameOf(call.from.name),
                labelFull: call.from.name,
                file: call.from.uri.fsPath,
                line: call.from.selectionRange.start.line + 1,
                scopeEnd: call.from.range.end.line + 1,
                isCurrentFile: call.from.uri.fsPath === document.uri.fsPath
              };
              nodes.set(callerId, callerNode);
              addToNodeIndex(nodeIndex, callerId, callerNode);
            }
            edgeSet.add(`${callerId}|||${calleeId}`);
            if (!upQueued.has(callerId)) {
              upQueued.add(callerId);
              upNextLevel.push(call.from);
            }
          }
        }
        adaptiveDelay2 = nextAdaptiveDelay(adaptiveDelay2, lspErrors > 0, upStreak2);
        if (adaptiveDelay2 > 0 && (i + BATCH_SIZE < upCurrentLevel.length || upNextLevel.length > 0)) {
          await delay(adaptiveDelay2);
        }
      }
      pct.range(50, 100, hop + 1, maxHops);
      upCurrentLevel = upNextLevel;
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: `\u2195 ${baseNameOf(startItems[0].name)} (${path.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildWorkspaceCallGraphLsp(uris, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const FILE_PARALLEL = 3;
  const uniqueUris = Array.from(new Map(uris.map((u) => [u.fsPath, u])).values()).filter((u) => hasCppSourceExtension(u));
  if (!uniqueUris.length)
    throw new Error("No C/C++ source files found.");
  const wsRoots = getWorkspaceRoots(uniqueUris[0]);
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  const nodeIndex = /* @__PURE__ */ new Map();
  const pct = new Pct(progress);
  const fileEntries = [];
  for (let si = 0; si < uniqueUris.length; si += FILE_PARALLEL) {
    checkCancellation(token);
    await Promise.all(uniqueUris.slice(si, si + FILE_PARALLEL).map(async (uri) => {
      let rawSyms;
      try {
        rawSyms = await vscode.commands.executeCommand(
          "vscode.executeDocumentSymbolProvider",
          uri
        );
      } catch {
        return;
      }
      if (!rawSyms?.length)
        return;
      const functions = flattenFunctions(rawSyms);
      for (const f of functions) {
        const id = makeNodeId(uri, f.name, f.selectionRange.start.line);
        if (!nodes.has(id)) {
          const newNode = {
            id,
            label: baseNameOf(f.name),
            labelFull: f.name,
            file: uri.fsPath,
            line: f.selectionRange.start.line + 1,
            scopeEnd: f.range.end.line + 1,
            isCurrentFile: false
          };
          nodes.set(id, newNode);
          addToNodeIndex(nodeIndex, id, newNode);
        }
      }
      fileEntries.push({ uri, functions });
    }));
    pct.range(0, 40, Math.min(si + FILE_PARALLEL, uniqueUris.length), uniqueUris.length);
  }
  const canceledFuncsByFile = /* @__PURE__ */ new Map();
  for (let fi = 0; fi < fileEntries.length; fi += FILE_PARALLEL) {
    checkCancellation(token);
    pct.range(40, 100, fi, fileEntries.length);
    await Promise.all(fileEntries.slice(fi, fi + FILE_PARALLEL).map(async ({ uri, functions }) => {
      let adaptiveDelay = BATCH_DELAY_INIT;
      const wsFileStreak = { val: 0 };
      const canceledFuncs = [];
      for (let i = 0; i < functions.length; i += BATCH_SIZE) {
        checkCancellation(token);
        const processingIds = /* @__PURE__ */ new Set();
        let errorsInBatch = 0;
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
              let calleeId = findExistingCalleeId(nodes, nodeIndex, to);
              if (!calleeId) {
                if (!shouldIncludeCallee(to.uri, wsRoots))
                  continue;
                calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
                if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                  processingIds.add(calleeId);
                  const calleeNode = {
                    id: calleeId,
                    label: baseNameOf(to.name),
                    labelFull: to.name,
                    file: to.uri.fsPath,
                    line: to.selectionRange.start.line + 1,
                    scopeEnd: to.range.end.line + 1,
                    isCurrentFile: false
                  };
                  nodes.set(calleeId, calleeNode);
                  addToNodeIndex(nodeIndex, calleeId, calleeNode);
                }
              }
              edgeSet.add(`${callerId}|||${calleeId}`);
            }
          } catch (err) {
            if (err instanceof vscode.CancellationError)
              throw err;
            errorsInBatch++;
            if (isCanceledByClangd(err)) {
              canceledFuncs.push(func);
            } else {
              errs.push(`${path.basename(uri.fsPath)}::${func.name}: ${String(err)}`);
            }
          }
        }));
        adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, errorsInBatch > 0, wsFileStreak);
        if (adaptiveDelay > 0 && i + BATCH_SIZE < functions.length)
          await delay(adaptiveDelay);
      }
      if (canceledFuncs.length > 0) {
        canceledFuncsByFile.set(uri.fsPath, { uri, funcs: canceledFuncs });
      }
    }));
  }
  if (canceledFuncsByFile.size > 0) {
    await delay(CANCELED_RETRY_DELAY);
    checkCancellation(token);
    for (const { uri, funcs } of canceledFuncsByFile.values()) {
      checkCancellation(token);
      const fileBase = path.basename(uri.fsPath);
      let adaptiveDelay = BATCH_DELAY_INIT;
      const wsFileStreak = { val: 0 };
      for (let i = 0; i < funcs.length; i += BATCH_SIZE) {
        checkCancellation(token);
        const processingIds = /* @__PURE__ */ new Set();
        let errorsInBatch = 0;
        await Promise.all(funcs.slice(i, i + BATCH_SIZE).map(async (func) => {
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
              let calleeId = findExistingCalleeId(nodes, nodeIndex, to);
              if (!calleeId) {
                if (!shouldIncludeCallee(to.uri, wsRoots))
                  continue;
                calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
                if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                  processingIds.add(calleeId);
                  const calleeNode = {
                    id: calleeId,
                    label: baseNameOf(to.name),
                    labelFull: to.name,
                    file: to.uri.fsPath,
                    line: to.selectionRange.start.line + 1,
                    scopeEnd: to.range.end.line + 1,
                    isCurrentFile: false
                  };
                  nodes.set(calleeId, calleeNode);
                  addToNodeIndex(nodeIndex, calleeId, calleeNode);
                }
              }
              edgeSet.add(`${callerId}|||${calleeId}`);
            }
          } catch (err) {
            if (err instanceof vscode.CancellationError)
              throw err;
            errorsInBatch++;
            errs.push(`${fileBase}::${func.name}: ${String(err)}`);
          }
        }));
        adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, errorsInBatch > 0, wsFileStreak);
        if (adaptiveDelay > 0 && i + BATCH_SIZE < funcs.length)
          await delay(adaptiveDelay);
      }
    }
  }
  const label = uniqueUris.length === 1 ? path.basename(uniqueUris[0].fsPath) : `${uniqueUris.length} files`;
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: label,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
var WORKSPACE_FILES_KEY = "__workspace__";
async function findFilesCached() {
  const now = Date.now();
  const cached = filesCache.get(WORKSPACE_FILES_KEY);
  if (cached && now - cached.timestamp < FILES_CACHE_TTL_MS)
    return cached.uris;
  const uris = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);
  filesCache.set(WORKSPACE_FILES_KEY, { uris, timestamp: now });
  return uris;
}
async function collectGtagsCached(wsRoot) {
  const now = Date.now();
  const cached = tagsCache.get(wsRoot);
  if (cached && now - cached.timestamp < TAGS_CACHE_TTL_MS) {
    return {
      tags: cached.tags,
      lineCache: /* @__PURE__ */ new Map(),
      ambiguousNames: cached.ambiguousNames,
      scopeMap: cached.scopeMap
      // B: キャッシュヒット時もそのまま返す
    };
  }
  const allUris = await findFilesCached();
  const result = await collectGtags(allUris.map((u) => u.fsPath), wsRoot);
  const scopeMap = buildGtagsScopeMap(result.tags);
  tagsCache.set(wsRoot, {
    tags: result.tags,
    ambiguousNames: result.ambiguousNames,
    scopeMap,
    timestamp: now
  });
  return { ...result, scopeMap };
}
function isLikelyFuncDef(line) {
  const s = line.trim();
  if (!s || s.startsWith("#") || s.startsWith("}"))
    return false;
  if (s.includes("typedef") || !s.includes("(") || s.endsWith(";"))
    return false;
  if (/=\s*(0|delete|default)\s*[;,]?\s*$/.test(s))
    return false;
  return true;
}
function spawnErrorMessage(cmd, err) {
  const msg = String(err);
  if (msg.includes("ENOTDIR")) {
    return `[gtags] Failed to launch ${cmd} (ENOTDIR).
Your PATH may contain Windows-style paths (e.g. C:\\Windows\\System32) in WSL.
Fix: add "export PATH=$(echo $PATH | tr ':' '\\n' | grep -v '^/mnt/' | tr '\\n' ':')" to ~/.bashrc`;
  }
  if (msg.includes("ENOENT")) {
    return `[gtags] ${cmd} not found. Check that the gtags/global install directory is in your PATH.`;
  }
  return `[gtags] Failed to launch ${cmd}: ${msg}`;
}
async function ensureGtagsDb(wsRoot) {
  const now = Date.now();
  if (fs.existsSync(path.join(wsRoot, "GTAGS"))) {
    const last = gtagsUpdateCache.get(wsRoot) ?? 0;
    if (now - last < GTAGS_UPDATE_TTL)
      return void 0;
    try {
      await execFileAsync("global", ["-u"], { cwd: wsRoot, timeout: 12e4 });
      gtagsUpdateCache.set(wsRoot, now);
    } catch (updateErr) {
      try {
        await runGtagsWithDotfilesCompat(wsRoot);
        gtagsUpdateCache.set(wsRoot, now);
      } catch (rebuildErr) {
        return spawnErrorMessage("global -u / gtags rebuild", rebuildErr);
      }
    }
  } else {
    try {
      await runGtagsWithDotfilesCompat(wsRoot);
    } catch (initErr) {
      return spawnErrorMessage("gtags", initErr);
    }
    gtagsUpdateCache.set(wsRoot, now);
  }
  return void 0;
}
async function runGtagsWithDotfilesCompat(wsRoot) {
  try {
    await execFileAsync("gtags", ["--accept-dotfiles"], { cwd: wsRoot, timeout: 12e4 });
  } catch (err) {
    const msg = String(err);
    if (/unrecognized option|invalid option|unknown option/i.test(msg)) {
      await execFileAsync("gtags", [], { cwd: wsRoot, timeout: 12e4 });
    } else {
      throw err;
    }
  }
}
function sanitizeToWsRoot(rawPath, wsRoot) {
  const fp = path.isAbsolute(rawPath) ? rawPath : path.resolve(wsRoot, rawPath);
  const fpNorm = normalizeFsPath(fp);
  const wsRootNorm = normalizeFsPath(wsRoot);
  const wsRootSlash = wsRootNorm.endsWith(path.sep) ? wsRootNorm : wsRootNorm + path.sep;
  if (!(fpNorm.startsWith(wsRootSlash) || fpNorm === wsRootNorm))
    return null;
  try {
    const realFp = realpathCache.get(fp) ?? (() => {
      const r = fs.realpathSync(fp);
      setRealpathCache(fp, r);
      return r;
    })();
    const realRoot = realpathCache.get(wsRoot) ?? (() => {
      const r = fs.realpathSync(wsRoot);
      setRealpathCache(wsRoot, r);
      return r;
    })();
    const realFpNorm = normalizeFsPath(realFp);
    const realRootNorm = normalizeFsPath(realRoot);
    const realSlash = realRootNorm.endsWith(path.sep) ? realRootNorm : realRootNorm + path.sep;
    if (!(realFpNorm.startsWith(realSlash) || realFpNorm === realRootNorm))
      return null;
  } catch {
    return null;
  }
  return fp;
}
function sanitizeToAnyWsRoot(rawPath, wsRoots) {
  for (const root of wsRoots) {
    const result = sanitizeToWsRoot(rawPath, root);
    if (result !== null)
      return result;
  }
  return null;
}
async function runGlobalF(absFile, wsRoot) {
  try {
    const relFile = path.relative(wsRoot, absFile);
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
      const fp = sanitizeToWsRoot(parts[2], wsRoot);
      if (!fp)
        return [];
      return [{ name, line: lineno, file: fp }];
    });
  } catch {
    return [];
  }
}
function readFileLinesCached(filePath, cache) {
  if (cache.has(filePath))
    return cache.get(filePath);
  return [];
}
async function getFileLinesAsync(filePath, cache) {
  if (cache.has(filePath))
    return cache.get(filePath);
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    cache.set(filePath, lines);
    return lines;
  } catch {
    return [];
  }
}
async function prefetchFileLines(files, cache) {
  const needed = [...new Set(files)].filter((f) => !cache.has(f));
  if (needed.length === 0)
    return;
  await Promise.all(needed.map((f) => getFileLinesAsync(f, cache)));
}
async function runGlobalXAll(wsRoot) {
  const { stdout } = await execFileAsync("global", ["-x", "-e", "."], {
    cwd: wsRoot,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 12e4
    // SEC-02: 256MB (詳細は JSDoc 参照)
  });
  return stdout.split("\n").flatMap((raw) => {
    const trimmed = raw.trimEnd();
    if (!trimmed)
      return [];
    const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m)
      return [];
    const [, name, lineStr, fileStr, sourceLine] = m;
    const line = parseInt(lineStr, 10);
    if (isNaN(line))
      return [];
    const file = sanitizeToWsRoot(fileStr, wsRoot);
    if (!file)
      return [];
    return [{ name, line, file, sourceLine }];
  });
}
async function collectGtags(files, wsRoot) {
  const lineCache = /* @__PURE__ */ new Map();
  let rawEntries;
  try {
    rawEntries = await runGlobalXAll(wsRoot);
  } catch {
    const perFileResults = [];
    const CONCURRENT = Math.min(16, files.length);
    for (let i = 0; i < files.length; i += CONCURRENT) {
      const results = await Promise.all(
        files.slice(i, i + CONCURRENT).map((f) => runGlobalF(f, wsRoot))
      );
      for (const entries of results)
        perFileResults.push(...entries);
    }
    rawEntries = perFileResults.map((e) => ({ ...e, sourceLine: "" }));
  }
  const rawMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < rawEntries.length; i++) {
    if (i > 0 && i % 1e4 === 0)
      await new Promise((r) => setImmediate(r));
    const e = rawEntries[i];
    if (!rawMap.has(e.name))
      rawMap.set(e.name, []);
    rawMap.get(e.name).push(e);
  }
  const tags = /* @__PURE__ */ new Map();
  const ambiguousNames = [];
  {
    const filesNeedingRead = [];
    for (const [, candidates] of rawMap) {
      for (const cand of candidates) {
        if (!cand.sourceLine)
          filesNeedingRead.push(cand.file);
      }
    }
    await prefetchFileLines(filesNeedingRead, lineCache);
  }
  for (const [name, candidates] of rawMap) {
    const distinctFiles = new Set(candidates.map((c) => c.file));
    if (distinctFiles.size > 1)
      ambiguousNames.push(name);
    const entries = candidates.map((cand) => {
      let sourceLine = cand.sourceLine;
      if (!sourceLine) {
        const ll = readFileLinesCached(cand.file, lineCache);
        sourceLine = ll[cand.line - 1]?.trimEnd() ?? "";
      }
      return { name, file: cand.file, line: cand.line, sourceLine, isFunc: isLikelyFuncDef(sourceLine) };
    });
    tags.set(name, entries);
  }
  return { tags, lineCache, ambiguousNames };
}
function buildGtagsScopeMap(tags) {
  const fileMap = /* @__PURE__ */ new Map();
  for (const [name, entries] of tags) {
    for (const info of entries) {
      if (!info.isFunc)
        continue;
      if (!fileMap.has(info.file))
        fileMap.set(info.file, []);
      fileMap.get(info.file).push({ name, line: info.line });
    }
  }
  const scopeMap = /* @__PURE__ */ new Map();
  for (const [fp, entries] of fileMap) {
    entries.sort((a, b) => a.line - b.line);
    const list = entries.map((e, i) => ({
      name: e.name,
      start: e.line,
      end: i + 1 < entries.length ? entries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER
    }));
    const byName = /* @__PURE__ */ new Map();
    for (const s of list) {
      if (!byName.has(s.name))
        byName.set(s.name, s);
    }
    scopeMap.set(fp, { list, byName });
  }
  return scopeMap;
}
function extractCallsFromLines(lines, start, end, selfName, knownTags) {
  const callees = /* @__PURE__ */ new Set();
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let inBlockComment = false;
  let rawDelimiter = "";
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    const line = lines[i];
    let processed = [];
    let j = 0;
    while (j < line.length) {
      if (rawDelimiter) {
        const endIdx = line.indexOf(rawDelimiter, j);
        if (endIdx === -1) {
          j = line.length;
        } else {
          j = endIdx + rawDelimiter.length;
          rawDelimiter = "";
        }
        continue;
      }
      if (inBlockComment) {
        const endIdx = line.indexOf("*/", j);
        if (endIdx === -1) {
          j = line.length;
        } else {
          inBlockComment = false;
          j = endIdx + 2;
        }
        continue;
      }
      const ch = line[j];
      const ch2 = j + 1 < line.length ? line[j] + line[j + 1] : "";
      if (ch === "R" && j + 1 < line.length && line[j + 1] === '"') {
        j += 2;
        const parenIdx = line.indexOf("(", j);
        if (parenIdx === -1) {
          processed.push(ch);
          j--;
        } else {
          const delim = line.slice(j, parenIdx);
          const terminator = ")" + delim + '"';
          j = parenIdx + 1;
          const endIdx = line.indexOf(terminator, j);
          if (endIdx !== -1) {
            j = endIdx + terminator.length;
          } else {
            rawDelimiter = terminator;
            j = line.length;
          }
        }
        continue;
      }
      if (ch === '"') {
        j++;
        while (j < line.length) {
          if (line[j] === "\\") {
            j += 2;
          } else if (line[j] === '"') {
            j++;
            break;
          } else {
            j++;
          }
        }
      } else if (ch === "'") {
        j++;
        while (j < line.length) {
          if (line[j] === "\\") {
            j += 2;
          } else if (line[j] === "'") {
            j++;
            break;
          } else {
            j++;
          }
        }
      } else if (ch2 === "//") {
        j = line.length;
      } else if (ch2 === "/*") {
        inBlockComment = true;
        j += 2;
      } else {
        processed.push(ch);
        j++;
      }
    }
    const processedStr = processed.join("");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(processedStr)) !== null) {
      const callee = m[1];
      if (callee !== selfName && (!knownTags || knownTags.has(callee)))
        callees.add(callee);
    }
  }
  return callees;
}
function resolveCalleeScope(scopeMap, file, name, line) {
  const entry = scopeMap.get(file);
  if (!entry)
    return void 0;
  return findScopeAtLine(entry.list, line) ?? entry.byName.get(name);
}
function makeGtagsNodeId(file, name, line) {
  return `${file}\0${name}\0${line}`;
}
function parseGtagsNodeId(id) {
  const first = id.indexOf("\0");
  const last = id.lastIndexOf("\0");
  return {
    file: id.slice(0, first),
    name: id.slice(first + 1, last),
    line: parseInt(id.slice(last + 1), 10)
  };
}
function resolveCallee(candidates, callerFile) {
  if (!candidates?.length)
    return void 0;
  return candidates.find((c) => c.file === callerFile && c.isFunc) ?? candidates.find((c) => c.isFunc) ?? candidates[0];
}
function escapeRegexForGlobal(name) {
  return name.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
}
function findScopeAtLine(list, refLine) {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const s = list[mid];
    if (refLine < s.start)
      hi = mid - 1;
    else if (refLine > s.end)
      lo = mid + 1;
    else
      return s;
  }
  return void 0;
}
async function buildEdgesGlobalRx(callerFiles, tags, scopeMap, wsRoot, token, pct, startPct = 20, endPct = 75, errs = [], wsRoots) {
  const effectiveRoots = wsRoots && wsRoots.length > 0 ? wsRoots : [wsRoot];
  const edgeSet = /* @__PURE__ */ new Set();
  const funcNames = Array.from(tags.entries()).filter(([, entries]) => entries.some((e) => e.isFunc)).map(([name]) => name);
  const patterns = buildPatternBatches(funcNames);
  const totalGroups = Math.ceil(patterns.length / GLOBAL_RX_PARALLEL);
  const errorMessages = /* @__PURE__ */ new Set();
  for (let gi = 0; gi < patterns.length; gi += GLOBAL_RX_PARALLEL) {
    checkCancellation(token);
    pct?.range(startPct, endPct, Math.floor(gi / GLOBAL_RX_PARALLEL), totalGroups);
    await Promise.all(patterns.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async (pattern) => {
      let stdout = "";
      try {
        ({ stdout } = await execFileAsync("global", ["-rx", "-e", pattern], {
          cwd: wsRoot,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 6e4
        }));
      } catch (e) {
        const ex = e;
        const msg = ex instanceof Error ? ex.message : String(ex);
        if (ex.killed || msg.includes("cancel")) {
          return;
        }
        if (msg.includes("maxBuffer") || msg.includes("STDIO_MAXBUFFER") || msg.includes("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
          errorMessages.add(
            "[gtags] global -rx: Output too large (>50MB). Some call edges may be missing. Consider splitting the analysis with Folder Graph."
          );
          return;
        }
        const firstLine = msg.split("\n")[0];
        const isUnsupportedE = /invalid option|unknown option|illegal option/i.test(firstLine);
        const normalized = isUnsupportedE ? "global -rx: -e flag not supported (GNU GLOBAL < 5.0). Using regex fallback for callee detection. Upgrade to GLOBAL 5.0+ for better accuracy." : `global -rx: ${firstLine}`;
        errorMessages.add(normalized);
        return;
      }
      for (const rawLine of stdout.split("\n")) {
        const parts = rawLine.trim().split(/\s+/);
        if (parts.length < 3)
          continue;
        const calleeName = parts[0];
        const refLine = parseInt(parts[1], 10);
        if (!calleeName || isNaN(refLine))
          continue;
        const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots);
        if (!refFile || !callerFiles.has(refFile))
          continue;
        const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
        if (!fileScopeEntry)
          continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        if (!callerScope)
          continue;
        const callerEntry = tags.get(callerScope.name)?.find((e) => e.file === refFile && e.isFunc) ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry)
          continue;
        const calleeEntry = resolveCallee(tags.get(calleeName), refFile);
        if (!calleeEntry?.isFunc)
          continue;
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, calleeName, calleeEntry.line);
        if (!calleeScope)
          continue;
        if (callerScope.name === calleeName && callerEntry.file === calleeEntry.file)
          continue;
        const callerId = makeGtagsNodeId(refFile, callerScope.name, callerEntry.line);
        const calleeId = makeGtagsNodeId(calleeEntry.file, calleeName, calleeEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
      }
    }));
  }
  for (const msg of errorMessages)
    errs.push(msg);
  return edgeSet;
}
function gtagsEntryToNode(name, entry, scope, currentFile) {
  const scopeEnd = scope.end === Number.MAX_SAFE_INTEGER ? scope.start + MAX_SOURCE_LINES - 1 : scope.end;
  const isCurrentFile = currentFile !== "" && normalizeFsPath(entry.file) === normalizeFsPath(currentFile);
  return {
    id: makeGtagsNodeId(entry.file, name, entry.line),
    label: name,
    labelFull: entry.sourceLine || name,
    file: entry.file,
    line: entry.line,
    scopeEnd,
    isCurrentFile
  };
}
async function buildFileCallGraphGtags(document, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot)
    throw new Error("No workspace folder is open.");
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);
  {
    const w = await ensureGtagsDb(wsRoot);
    if (w)
      errs.push(w);
  }
  pct.to(5);
  pct.report("\u{1F4C2} Loading tags...");
  const { tags, lineCache, ambiguousNames, scopeMap } = await collectGtagsCached(wsRoot);
  if (!tags.size)
    throw new Error(
      "No tags found.\nPlease verify that gtags is installed and GTAGS exists."
    );
  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(", ");
    const suffix = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : "";
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }
  const currentFile = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  const currentLines = document.getText().split("\n");
  lineCache.set(currentFileNorm, currentLines);
  lineCache.set(currentFile, currentLines);
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const nodes = /* @__PURE__ */ new Map();
  for (const scope of fileScopes) {
    const entry = tags.get(scope.name)?.find(
      (e) => normalizeFsPath(e.file) === currentFileNorm && e.isFunc
    );
    if (!entry)
      continue;
    const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
    nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, currentFile));
  }
  if (!nodes.size)
    throw new Error("No functions found in this file.");
  pct.to(20);
  checkCancellation(token);
  const callerFiles = /* @__PURE__ */ new Set([currentFile, currentFileNorm]);
  for (const scope of fileScopes) {
    const e = tags.get(scope.name)?.find(
      (e2) => normalizeFsPath(e2.file) === currentFileNorm && e2.isFunc
    );
    if (e)
      callerFiles.add(e.file);
  }
  const edgeSet = await buildEdgesGlobalRx(callerFiles, tags, scopeMap, wsRoot, token, pct, 20, 75, errs, wsRoots);
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split("|||")[1];
    if (nodes.has(calleeId))
      continue;
    const { file: calleeFile, name: calleeName } = parseGtagsNodeId(calleeId);
    const calleeEntry = tags.get(calleeName)?.find((e) => e.file === calleeFile && e.isFunc);
    if (!calleeEntry)
      continue;
    const calleeScope = resolveCalleeScope(scopeMap, calleeFile, calleeName, calleeEntry.line);
    if (!calleeScope)
      continue;
    nodes.set(calleeId, gtagsEntryToNode(calleeName, calleeEntry, calleeScope, currentFile));
  }
  pct.to(75);
  {
    const knownTags = new Set(tags.keys());
    const downVisited = /* @__PURE__ */ new Set();
    const downQueue = [];
    for (const nodeId of nodes.keys()) {
      if (downVisited.has(nodeId))
        continue;
      downVisited.add(nodeId);
      const { file: nFile, name: nName } = parseGtagsNodeId(nodeId);
      const entry = tags.get(nName)?.find((e) => e.file === nFile && e.isFunc);
      if (!entry)
        continue;
      const scope = resolveCalleeScope(scopeMap, nFile, nName, entry.line);
      if (!scope)
        continue;
      downQueue.push({ name: nName, entry, scope });
    }
    let dqi = 0;
    while (dqi < downQueue.length) {
      checkCancellation(token);
      const { name, entry, scope } = downQueue[dqi++];
      const callerId = makeGtagsNodeId(entry.file, name, entry.line);
      const lines = await getFileLinesAsync(entry.file, lineCache);
      const callees = extractCallsFromLines(lines, scope.start, scope.end, name, knownTags);
      for (const callee of callees) {
        const calleeEntry = resolveCallee(tags.get(callee), entry.file);
        if (!calleeEntry || !calleeEntry.isFunc)
          continue;
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, callee, calleeEntry.line);
        if (!calleeScope)
          continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
        if (!nodes.has(calleeId)) {
          nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, currentFile));
        }
        if (!downVisited.has(calleeId)) {
          downVisited.add(calleeId);
          downQueue.push({ name: callee, entry: calleeEntry, scope: calleeScope });
        }
      }
      pct.bfsQ(75, 88, downVisited, { length: downQueue.length - dqi });
    }
  }
  pct.to(88);
  {
    const upVisited = /* @__PURE__ */ new Set();
    let upCurrentLevel = [];
    for (const scope of fileScopes) {
      const entry = tags.get(scope.name)?.find(
        (e) => normalizeFsPath(e.file) === currentFileNorm && e.isFunc
      );
      if (!entry)
        continue;
      const coreId = makeGtagsNodeId(entry.file, scope.name, entry.line);
      upVisited.add(coreId);
      upCurrentLevel.push({ funcName: scope.name, calleeId: coreId });
    }
    while (upCurrentLevel.length > 0) {
      checkCancellation(token);
      const levelFuncNames = upCurrentLevel.map((item) => item.funcName);
      const refMap = await runGlobalRxBatch(levelFuncNames, wsRoot, errs, wsRoots);
      const upNextLevel = [];
      for (const { funcName, calleeId } of upCurrentLevel) {
        for (const { refFile, refLine } of refMap.get(funcName) ?? []) {
          checkCancellation(token);
          const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
          if (!fileScopeEntry)
            continue;
          const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
          if (!callerScope || callerScope.name === funcName)
            continue;
          const callerEntry = tags.get(callerScope.name)?.find((e) => e.file === refFile && e.isFunc) ?? resolveCallee(tags.get(callerScope.name), refFile);
          if (!callerEntry)
            continue;
          const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
          edgeSet.add(`${callerId}|||${calleeId}`);
          if (!nodes.has(callerId)) {
            nodes.set(callerId, gtagsEntryToNode(
              callerScope.name,
              callerEntry,
              callerScope,
              currentFile
            ));
          }
          if (!upVisited.has(callerId)) {
            upVisited.add(callerId);
            upNextLevel.push({ funcName: callerScope.name, calleeId: callerId });
          }
        }
      }
      pct.bfsQ(88, 100, upVisited, upNextLevel);
      upCurrentLevel = upNextLevel;
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: path.basename(currentFile),
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
var MAX_PATTERN_LENGTH = 5e4;
function buildPatternBatches(names) {
  if (names.length === 0)
    return [];
  const batches = [];
  let batch = [];
  const WRAPPER_LEN = 4;
  let len = WRAPPER_LEN;
  for (const name of names) {
    const escaped = escapeRegexForGlobal(name);
    if (WRAPPER_LEN + escaped.length > MAX_PATTERN_LENGTH)
      continue;
    const add = (batch.length > 0 ? 1 : 0) + escaped.length;
    if (len + add > MAX_PATTERN_LENGTH && batch.length > 0) {
      batches.push("^(" + batch.join("|") + ")$");
      batch = [];
      len = WRAPPER_LEN;
    }
    batch.push(escaped);
    len += add;
  }
  if (batch.length > 0)
    batches.push("^(" + batch.join("|") + ")$");
  return batches;
}
async function runGlobalXNames(names, wsRoot, errs = []) {
  const result = /* @__PURE__ */ new Map();
  if (names.length === 0)
    return result;
  const patterns = buildPatternBatches(names);
  const errorMessages = /* @__PURE__ */ new Set();
  await Promise.all(patterns.map(async (pattern) => {
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("global", ["-x", "-e", pattern], {
        cwd: wsRoot,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 3e4
      }));
    } catch (e) {
      const ex = e;
      const msg = ex instanceof Error ? ex.message : String(ex);
      if (ex.killed || msg.includes("cancel")) {
        return;
      }
      errorMessages.add(`global -x: ${msg.split("\n")[0]}`);
      return;
    }
    for (const raw of stdout.split("\n")) {
      const trimmed = raw.trimEnd();
      if (!trimmed)
        continue;
      const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m)
        continue;
      const [, name, lineStr, fileStr, sourceLine] = m;
      const line = parseInt(lineStr, 10);
      if (isNaN(line))
        continue;
      const file = sanitizeToWsRoot(fileStr, wsRoot);
      if (!file)
        continue;
      const entry = { name, file, line, sourceLine, isFunc: isLikelyFuncDef(sourceLine) };
      if (!result.has(name))
        result.set(name, []);
      result.get(name).push(entry);
    }
  }));
  for (const msg of errorMessages)
    errs.push(msg);
  return result;
}
async function resolveOrFetchTag(name, wsRoot, tagCache, errs = []) {
  if (tagCache.has(name)) {
    const cached = tagCache.get(name);
    return cached.length > 0 ? cached : void 0;
  }
  const resolved = await runGlobalXNames([name], wsRoot, errs);
  const entries = resolved.get(name) ?? [];
  tagCache.set(name, entries);
  return entries.length > 0 ? entries : void 0;
}
async function buildScopeForFileCached(file, wsRoot, scopeCache, lineCache) {
  const norm = normalizeFsPath(file);
  const hit = scopeCache.get(norm) ?? scopeCache.get(file);
  if (hit)
    return hit;
  const tagEntries = await runGlobalF(file, wsRoot);
  if (!tagEntries.length)
    return void 0;
  const lines = await getFileLinesAsync(file, lineCache);
  if (norm !== file && !lineCache.has(norm))
    lineCache.set(norm, lines);
  const funcEntries = [];
  for (const { name, line } of tagEntries) {
    const sourceLine = lines[line - 1]?.trimEnd() ?? "";
    if (isLikelyFuncDef(sourceLine))
      funcEntries.push({ name, line });
  }
  if (!funcEntries.length)
    return void 0;
  funcEntries.sort((a, b) => a.line - b.line);
  const list = funcEntries.map((e, i) => ({
    name: e.name,
    start: e.line,
    end: i + 1 < funcEntries.length ? funcEntries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER
  }));
  const byName = /* @__PURE__ */ new Map();
  for (const s of list) {
    if (!byName.has(s.name))
      byName.set(s.name, s);
  }
  const entry = { list, byName };
  scopeCache.set(norm, entry);
  scopeCache.set(file, entry);
  return entry;
}
async function buildFunctionCallGraphGtags(document, position, maxHops = 4, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot)
    throw new Error("No workspace folder is open.");
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);
  {
    const w = await ensureGtagsDb(wsRoot);
    if (w)
      errs.push(w);
  }
  const now = Date.now();
  let lazyTagEntry = lazyTagCache.get(wsRoot);
  if (!lazyTagEntry || now - lazyTagEntry.timestamp > LAZY_CACHE_TTL_MS) {
    lazyTagEntry = { entries: /* @__PURE__ */ new Map(), timestamp: now };
    lazyTagCache.set(wsRoot, lazyTagEntry);
  }
  const tagCache = lazyTagEntry.entries;
  let lazyScopeEntry = lazyScopeCache.get(wsRoot);
  if (!lazyScopeEntry || now - lazyScopeEntry.timestamp > LAZY_CACHE_TTL_MS) {
    lazyScopeEntry = { scopes: /* @__PURE__ */ new Map(), timestamp: now };
    lazyScopeCache.set(wsRoot, lazyScopeEntry);
  }
  const fileScopeCache = lazyScopeEntry.scopes;
  const lineCache = /* @__PURE__ */ new Map();
  const currentFile = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  const currentLines = document.getText().split("\n");
  lineCache.set(currentFile, currentLines);
  lineCache.set(currentFileNorm, currentLines);
  pct.to(5);
  checkCancellation(token);
  pct.report("\u{1F50D} Finding start function...");
  const startFileScopeEntry = await buildScopeForFileCached(
    currentFile,
    wsRoot,
    fileScopeCache,
    lineCache
  );
  if (!startFileScopeEntry?.list.length)
    throw new Error(
      "No functions found in this file."
    );
  const cursorLine = position.line + 1;
  const startScope = findScopeAtLine(startFileScopeEntry.list, cursorLine);
  if (!startScope)
    throw new Error(
      "No function found at cursor position.\nPlace the cursor on a function name and try again."
    );
  const startCandidates = await resolveOrFetchTag(startScope.name, wsRoot, tagCache, errs);
  const startEntry = startCandidates?.find((e) => normalizeFsPath(e.file) === currentFileNorm && e.isFunc) ?? startCandidates?.find((e) => e.isFunc) ?? startCandidates?.[0];
  if (!startEntry)
    throw new Error("Tag info for the start function was not found.");
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  pct.to(15);
  pct.report("\u2B07 Building callee graph...");
  checkCancellation(token);
  const startNodeId = makeGtagsNodeId(startEntry.file, startScope.name, startEntry.line);
  const visited = /* @__PURE__ */ new Set();
  const queued = /* @__PURE__ */ new Set([startNodeId]);
  const queue = [{ name: startScope.name, entry: startEntry, scope: startScope, hop: 0 }];
  let qi = 0;
  while (qi < queue.length) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue[qi++];
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    if (visited.has(nodeId))
      continue;
    visited.add(nodeId);
    const lines = await getFileLinesAsync(entry.file, lineCache);
    nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
    if (hop >= maxHops)
      continue;
    const rawCandidates = extractCallsFromLines(lines, scope.start, scope.end, name);
    if (rawCandidates.size === 0)
      continue;
    const uncached = [...rawCandidates].filter((c) => !tagCache.has(c));
    if (uncached.length > 0) {
      const freshMap = await runGlobalXNames(uncached, wsRoot, errs);
      for (const [n, entries] of freshMap)
        tagCache.set(n, entries);
      for (const n of uncached) {
        if (!tagCache.has(n))
          tagCache.set(n, []);
      }
    }
    const resolvedCallees = [];
    for (const callee of rawCandidates) {
      const calleeEntry = resolveCallee(tagCache.get(callee), entry.file);
      if (!calleeEntry?.isFunc)
        continue;
      resolvedCallees.push({ callee, calleeEntry });
    }
    const uniqueCalleeFiles = [...new Set(resolvedCallees.map((c) => c.calleeEntry.file))];
    await Promise.all(uniqueCalleeFiles.map((f) => buildScopeForFileCached(f, wsRoot, fileScopeCache, lineCache)));
    for (const { callee, calleeEntry } of resolvedCallees) {
      const calleeScopeEntry = fileScopeCache.get(normalizeFsPath(calleeEntry.file)) ?? fileScopeCache.get(calleeEntry.file);
      if (!calleeScopeEntry)
        continue;
      const calleeScope = findScopeAtLine(calleeScopeEntry.list, calleeEntry.line) ?? calleeScopeEntry.byName.get(callee);
      if (!calleeScope)
        continue;
      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      edgeSet.add(`${nodeId}|||${calleeId}`);
      if (!queued.has(calleeId)) {
        queued.add(calleeId);
        queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 });
      }
    }
    pct.bfsQ(15, 65, queued, { length: queue.length - qi });
  }
  pct.to(65);
  pct.report("\u2B06 Building caller graph...");
  checkCancellation(token);
  const upVisited = /* @__PURE__ */ new Set([startNodeId]);
  let upCurrentLevel = [{ funcName: startScope.name, calleeId: startNodeId }];
  for (let hop = 0; hop < maxHops && upCurrentLevel.length > 0; hop++) {
    checkCancellation(token);
    const levelFuncNames = upCurrentLevel.map((item) => item.funcName);
    const refMap = await runGlobalRxBatch(levelFuncNames, wsRoot, errs, wsRoots);
    const upNextLevel = [];
    const uniqueRefFiles = [...new Set(
      [...upCurrentLevel].flatMap(
        ({ funcName }) => (refMap.get(funcName) ?? []).map((r) => r.refFile)
      )
    )];
    await Promise.all(uniqueRefFiles.map((f) => buildScopeForFileCached(f, wsRoot, fileScopeCache, lineCache)));
    for (const { funcName, calleeId } of upCurrentLevel) {
      for (const { refFile, refLine } of refMap.get(funcName) ?? []) {
        checkCancellation(token);
        const callerFileScopeEntry = fileScopeCache.get(normalizeFsPath(refFile)) ?? fileScopeCache.get(refFile);
        if (!callerFileScopeEntry)
          continue;
        const callerScope = findScopeAtLine(callerFileScopeEntry.list, refLine);
        if (!callerScope || callerScope.name === funcName)
          continue;
        const callerEntries = await resolveOrFetchTag(callerScope.name, wsRoot, tagCache, errs);
        const callerEntry = callerEntries?.find((e) => e.file === refFile && e.isFunc) ?? resolveCallee(callerEntries, refFile);
        if (!callerEntry)
          continue;
        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
        if (!nodes.has(callerId)) {
          nodes.set(callerId, gtagsEntryToNode(
            callerScope.name,
            callerEntry,
            callerScope,
            currentFile
          ));
        }
        if (!upVisited.has(callerId)) {
          upVisited.add(callerId);
          upNextLevel.push({ funcName: callerScope.name, calleeId: callerId });
        }
      }
    }
    pct.range(65, 100, hop + 1, maxHops);
    upCurrentLevel = upNextLevel;
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: `${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function buildWorkspaceCallGraphGtags(uris, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const uniqueUris = Array.from(new Map(uris.map((u) => [u.fsPath, u])).values()).filter((u) => CC_SOURCE_EXTENSIONS.has(path.extname(u.fsPath).toLowerCase()));
  if (!uniqueUris.length)
    throw new Error("No C/C++ source files found.");
  const rootGroups = /* @__PURE__ */ new Map();
  for (const uri of uniqueUris) {
    const root = getWorkspaceRootForFile(uri);
    if (!root)
      continue;
    if (!rootGroups.has(root))
      rootGroups.set(root, []);
    rootGroups.get(root).push(uri);
  }
  if (!rootGroups.size)
    throw new Error("No workspace folder is open.");
  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);
  const mergedTags = /* @__PURE__ */ new Map();
  const mergedScopeMap = /* @__PURE__ */ new Map();
  const callerFiles = /* @__PURE__ */ new Set();
  const nodes = /* @__PURE__ */ new Map();
  const rootList = Array.from(rootGroups.entries());
  const rootCount = rootList.length;
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    pct.range(0, 20, ri, rootCount);
    {
      const w = await ensureGtagsDb(wsRoot);
      if (w)
        errs.push(w);
    }
    let rootTags;
    let rootAmbiguousNames;
    let rootScopeMap;
    try {
      const result = await collectGtagsCached(wsRoot);
      rootTags = result.tags;
      rootAmbiguousNames = result.ambiguousNames;
      rootScopeMap = result.scopeMap;
    } catch (e) {
      errs.push(`[gtags] Failed to collect tags for ${wsRoot}: ${e}`);
      continue;
    }
    if (!rootTags.size) {
      errs.push(`[gtags] No tags found in ${wsRoot}. Run \`gtags\` in that folder.`);
      continue;
    }
    if (rootAmbiguousNames.length > 0) {
      const preview = rootAmbiguousNames.slice(0, 5).join(", ");
      const suffix = rootAmbiguousNames.length > 5 ? ` and ${rootAmbiguousNames.length - 5} more` : "";
      errs.push(`[gtags] Duplicate function names in ${path.basename(wsRoot)}: ${preview}${suffix}`);
    }
    for (const [name, entries] of rootTags) {
      if (!mergedTags.has(name))
        mergedTags.set(name, []);
      mergedTags.get(name).push(...entries);
    }
    for (const [fp, entry] of rootScopeMap) {
      mergedScopeMap.set(fp, entry);
    }
    for (const uri of rootUris) {
      callerFiles.add(uri.fsPath);
      callerFiles.add(normalizeFsPath(uri.fsPath));
      const fileScopes = findScopeMapEntry(mergedScopeMap, uri.fsPath)?.list ?? [];
      for (const scope of fileScopes) {
        const entry = rootTags.get(scope.name)?.find(
          (e) => normalizeFsPath(e.file) === normalizeFsPath(uri.fsPath) && e.isFunc
        );
        if (!entry)
          continue;
        callerFiles.add(entry.file);
        const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
        if (!nodes.has(nodeId))
          nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, ""));
      }
    }
  }
  if (!mergedTags.size)
    throw new Error("No tags found. Run `gtags` in each workspace root.");
  const edgeSet = /* @__PURE__ */ new Set();
  const allWsRoots = rootList.map(([root]) => root);
  pct.to(20);
  checkCancellation(token);
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    const rootCallerFiles = /* @__PURE__ */ new Set();
    for (const uri of rootUris) {
      rootCallerFiles.add(uri.fsPath);
      rootCallerFiles.add(normalizeFsPath(uri.fsPath));
    }
    const rootEdges = await buildEdgesGlobalRx(
      rootCallerFiles,
      mergedTags,
      mergedScopeMap,
      wsRoot,
      token,
      pct,
      20 + Math.floor(ri * 70 / rootList.length),
      20 + Math.floor((ri + 1) * 70 / rootList.length),
      errs,
      // ① 修正: エラーを呼び出し元の errs に記録
      allWsRoots
      // V4-4: 全ルートを渡してクロスルートエッジを検出
    );
    for (const e of rootEdges)
      edgeSet.add(e);
  }
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split("|||")[1];
    if (nodes.has(calleeId))
      continue;
    const { file: calleeFile, name: calleeName } = parseGtagsNodeId(calleeId);
    const calleeEntry = mergedTags.get(calleeName)?.find((e) => e.file === calleeFile && e.isFunc);
    if (!calleeEntry)
      continue;
    const calleeScope = resolveCalleeScope(mergedScopeMap, calleeFile, calleeName, calleeEntry.line);
    if (!calleeScope)
      continue;
    nodes.set(calleeId, gtagsEntryToNode(calleeName, calleeEntry, calleeScope, ""));
  }
  pct.to(90);
  {
    const bfsLineCache = /* @__PURE__ */ new Map();
    const knownTags = new Set(mergedTags.keys());
    const downVisited = /* @__PURE__ */ new Set();
    const downQueue = [];
    for (const nodeId of nodes.keys()) {
      if (downVisited.has(nodeId))
        continue;
      downVisited.add(nodeId);
      const { file: nFile, name: nName } = parseGtagsNodeId(nodeId);
      const entry = mergedTags.get(nName)?.find((e) => e.file === nFile && e.isFunc);
      if (!entry)
        continue;
      const scope = resolveCalleeScope(mergedScopeMap, nFile, nName, entry.line);
      if (!scope)
        continue;
      downQueue.push({ name: nName, entry, scope });
    }
    let dqi = 0;
    while (dqi < downQueue.length) {
      checkCancellation(token);
      const { name, entry, scope } = downQueue[dqi++];
      const callerId = makeGtagsNodeId(entry.file, name, entry.line);
      const lines = await getFileLinesAsync(entry.file, bfsLineCache);
      const callees = extractCallsFromLines(lines, scope.start, scope.end, name, knownTags);
      for (const callee of callees) {
        const calleeEntry = resolveCallee(mergedTags.get(callee), entry.file);
        if (!calleeEntry || !calleeEntry.isFunc)
          continue;
        const calleeScope = resolveCalleeScope(mergedScopeMap, calleeEntry.file, callee, calleeEntry.line);
        if (!calleeScope)
          continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
        if (!nodes.has(calleeId)) {
          nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, ""));
        }
        if (!downVisited.has(calleeId)) {
          downVisited.add(calleeId);
          downQueue.push({ name: callee, entry: calleeEntry, scope: calleeScope });
        }
      }
    }
  }
  const label = uniqueUris.length === 1 ? path.basename(uniqueUris[0].fsPath) : `${uniqueUris.length} files`;
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: label,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
async function runGlobalRxBatch(funcNames, wsRoot, errs = [], wsRoots) {
  const result = /* @__PURE__ */ new Map();
  for (const n of funcNames)
    result.set(n, []);
  if (funcNames.length === 0)
    return result;
  const effectiveRoots = wsRoots && wsRoots.length > 0 ? wsRoots : [wsRoot];
  const patterns = buildPatternBatches(funcNames);
  const errorMessages = /* @__PURE__ */ new Set();
  await Promise.all(patterns.map(async (pattern) => {
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("global", ["-rx", "-e", pattern], {
        cwd: wsRoot,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 6e4
      }));
    } catch (e) {
      const ex = e;
      const msg = ex instanceof Error ? ex.message : String(ex);
      if (ex.killed || msg.includes("cancel")) {
        return;
      }
      errorMessages.add(`global -rx: ${msg.split("\n")[0]}`);
      return;
    }
    for (const raw of stdout.split("\n")) {
      const parts = raw.trim().split(/\s+/);
      if (parts.length < 3)
        continue;
      const name = parts[0];
      const refLine = parseInt(parts[1], 10);
      if (!name || isNaN(refLine))
        continue;
      const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots);
      if (!refFile)
        continue;
      result.get(name)?.push({ refFile, refLine });
    }
  }));
  for (const msg of errorMessages)
    errs.push(msg);
  return result;
}
async function buildPathThroughCallGraphGtags(document, position, maxHops = 4, progress, token) {
  const t0 = Date.now();
  const errs = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot)
    throw new Error("No workspace folder is open.");
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);
  {
    const w = await ensureGtagsDb(wsRoot);
    if (w)
      errs.push(w);
  }
  pct.to(5);
  checkCancellation(token);
  pct.report("\u{1F4C2} Loading tags...");
  const { tags, lineCache, ambiguousNames, scopeMap } = await collectGtagsCached(wsRoot);
  if (!tags.size)
    throw new Error("No tags found.");
  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(", ");
    const suffix = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : "";
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }
  const currentFile = document.uri.fsPath;
  const currentLines = document.getText().split("\n");
  lineCache.set(currentFile, currentLines);
  lineCache.set(normalizeFsPath(currentFile), currentLines);
  const knownTags = new Set(tags.keys());
  const cursorLine = position.line + 1;
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const startScope = findScopeAtLine(fileScopes, cursorLine);
  if (!startScope)
    throw new Error(
      "No function found at cursor position.\nPlace the cursor on a function name and try again."
    );
  const currentFileNorm2 = normalizeFsPath(currentFile);
  const startEntry = tags.get(startScope.name)?.find((e) => normalizeFsPath(e.file) === currentFileNorm2 && e.isFunc) ?? tags.get(startScope.name)?.find((e) => e.isFunc) ?? tags.get(startScope.name)?.[0];
  if (!startEntry)
    throw new Error("Tag info for the start function was not found.");
  const startNodeId = makeGtagsNodeId(startEntry.file, startScope.name, startEntry.line);
  const nodes = /* @__PURE__ */ new Map();
  const edgeSet = /* @__PURE__ */ new Set();
  pct.to(20);
  {
    const visited = /* @__PURE__ */ new Set();
    const queued = /* @__PURE__ */ new Set([startNodeId]);
    const queue = [{ name: startScope.name, entry: startEntry, scope: startScope, hop: 0 }];
    let qi = 0;
    while (qi < queue.length) {
      checkCancellation(token);
      const { name, entry, scope, hop } = queue[qi++];
      const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
      if (visited.has(nodeId))
        continue;
      visited.add(nodeId);
      const lines = await getFileLinesAsync(entry.file, lineCache);
      nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
      if (hop >= maxHops)
        continue;
      for (const callee of extractCallsFromLines(lines, scope.start, scope.end, name, knownTags)) {
        const calleeEntry = resolveCallee(tags.get(callee), entry.file);
        if (!calleeEntry?.isFunc)
          continue;
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, callee, calleeEntry.line);
        if (!calleeScope)
          continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!queued.has(calleeId)) {
          queued.add(calleeId);
          queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 });
        }
      }
      pct.bfsQ(20, 55, queued, { length: queue.length - qi });
    }
  }
  pct.to(55);
  {
    const queued = /* @__PURE__ */ new Set([startNodeId]);
    let upCurrentLevel = [{ funcName: startScope.name, calleeId: startNodeId }];
    for (let hop = 0; hop < maxHops && upCurrentLevel.length > 0; hop++) {
      checkCancellation(token);
      const levelFuncNames = upCurrentLevel.map((item) => item.funcName);
      const refMap = await runGlobalRxBatch(levelFuncNames, wsRoot, errs, wsRoots);
      const upNextLevel = [];
      for (const { funcName, calleeId } of upCurrentLevel) {
        for (const { refFile, refLine } of refMap.get(funcName) ?? []) {
          checkCancellation(token);
          const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
          if (!fileScopeEntry)
            continue;
          const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
          if (!callerScope || callerScope.name === funcName)
            continue;
          const callerEntry = tags.get(callerScope.name)?.find((e) => e.file === refFile && e.isFunc) ?? resolveCallee(tags.get(callerScope.name), refFile);
          if (!callerEntry)
            continue;
          const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
          edgeSet.add(`${callerId}|||${calleeId}`);
          if (!nodes.has(callerId)) {
            nodes.set(callerId, gtagsEntryToNode(
              callerScope.name,
              callerEntry,
              callerScope,
              currentFile
            ));
          }
          if (!queued.has(callerId)) {
            queued.add(callerId);
            upNextLevel.push({ funcName: callerScope.name, calleeId: callerId });
          }
        }
      }
      pct.range(55, 100, hop + 1, maxHops);
      upCurrentLevel = upNextLevel;
    }
  }
  return {
    nodes: Array.from(nodes.values()),
    edges: splitEdges(edgeSet),
    fileName: `\u2195 ${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0,
    errors: errs
  };
}
function makeCacheKey(type, ...parts) {
  return `${type}::${parts.join("::")}`;
}
function fnv1a32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
async function buildFileCallGraph(document, progress, backend = "auto", token) {
  const resolved = await resolveBackend(backend);
  const key = makeCacheKey("file", document.uri.fsPath, resolved);
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS)
    return cached.data;
  const result = await (resolved === "gtags" ? buildFileCallGraphGtags(document, progress, token) : buildFileCallGraphLsp(document, progress, token));
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}
async function buildFunctionCallGraph(document, position, maxHops = 4, progress, backend = "auto", token) {
  const resolved = await resolveBackend(backend);
  const key = makeCacheKey(
    "func",
    document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`
  );
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS)
    return cached.data;
  const result = await (resolved === "gtags" ? buildFunctionCallGraphGtags(document, position, maxHops, progress, token) : buildFunctionCallGraphLsp(document, position, maxHops, progress, token));
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}
async function buildWorkspaceCallGraph(uris, progress, backend = "auto", token) {
  const resolved = await resolveBackend(backend);
  const sorted = uris.map((u) => u.fsPath).sort();
  const pathsHash = fnv1a32(sorted.join("\0"));
  const key = makeCacheKey("workspace", String(sorted.length), pathsHash, resolved);
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS)
    return cached.data;
  const result = await (resolved === "gtags" ? buildWorkspaceCallGraphGtags(uris, progress, token) : buildWorkspaceCallGraphLsp(uris, progress, token));
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}
async function warmupCache(document, backend) {
  try {
    const resolved = await resolveBackend(backend);
    if (resolved === "gtags") {
      const wsRoot = getWorkspaceRootForFile(document.uri);
      if (!wsRoot)
        return;
      const dbWarning = await ensureGtagsDb(wsRoot);
      if (dbWarning) {
        console.warn("[CallMap] warmupCache:", dbWarning);
      }
      await collectGtagsCached(wsRoot);
    } else {
      await vscode.commands.executeCommand(
        "vscode.executeDocumentSymbolProvider",
        document.uri
      );
    }
  } catch (e) {
    console.warn("[CallMap] warmupCache failed:", e instanceof Error ? e.message : String(e));
  }
}
async function buildPathThroughCallGraph(document, position, maxHops = 4, progress, backend = "auto", token) {
  const resolved = await resolveBackend(backend);
  const key = makeCacheKey(
    "path",
    document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`
  );
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS)
    return cached.data;
  const result = resolved === "gtags" ? await buildPathThroughCallGraphGtags(document, position, maxHops, progress, token) : await buildPathThroughCallGraphLsp(document, position, maxHops, progress, token);
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}

// src/webviewPanel.ts
function resolveAndNormalize(p) {
  const resolved = path2.resolve(p);
  let real;
  try {
    real = fs2.realpathSync(resolved);
  } catch {
    real = resolved;
  }
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}
function isPathInWorkspace(filePath, wsRoots, allowedFiles) {
  const fileResolved = resolveAndNormalize(filePath);
  if (wsRoots.length > 0) {
    return wsRoots.some((r) => {
      const rResolved = resolveAndNormalize(r);
      return fileResolved === rResolved || fileResolved.startsWith(rResolved + path2.sep) || fileResolved.startsWith(rResolved + "/");
    });
  }
  if (allowedFiles.size > 0) {
    return allowedFiles.has(fileResolved);
  }
  return false;
}
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
  const extra = files.length - FILE_COLORS_BASE.length;
  files.forEach((f, i) => {
    if (i < FILE_COLORS_BASE.length) {
      map[f] = FILE_COLORS_BASE[i];
    } else {
      const hue = Math.round((i - FILE_COLORS_BASE.length) * 360 / Math.max(1, extra) % 360);
      map[f] = {
        background: `hsl(${hue},65%,80%)`,
        border: `hsl(${hue},65%,55%)`
      };
    }
  });
  return map;
}
function escapeHtmlForTitle(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "<br>");
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
      labelFull: n.labelFull,
      file: n.file,
      line: n.line,
      scopeEnd: n.scopeEnd,
      // ⑥ lazy source 用 (source は送らない)
      isCurrentFile: n.isCurrentFile,
      color: colorMap[n.file] ?? FILE_COLORS_BASE[FILE_COLORS_BASE.length - 1],
      // ④ Security 修正: vis-network v9 は title プロパティを HTML としてレンダリングする。
      // ファイル名に <img onerror=...> 等の文字列が含まれると WebView 内でスクリプトが実行される恐れがある。
      // escapeHtmlForTitle でメタ文字をエスケープして XSS を防ぐ。
      title: escapeHtmlForTitle(`${n.label}
${path2.basename(n.file)} : line ${n.line}`)
    })),
    edges: data.edges,
    fileLegend,
    buildTimeMs: data.buildTimeMs,
    errors: data.errors,
    // callmap.initialControlPanel 設定値をメッセージに含める。
    // webview.js の renderGraph で setControlsCollapsed() に渡して初期状態を適用する。
    controlPanelCollapsed: vscode2.workspace.getConfiguration("callmap").get("initialControlPanel", "expanded") === "collapsed"
  };
}
var _filesCachePromise;
async function generateStandaloneHtml(extensionUri, data) {
  const distDir = vscode2.Uri.joinPath(extensionUri, "dist").fsPath;
  if (!_filesCachePromise) {
    _filesCachePromise = Promise.all([
      fs2.promises.readFile(path2.join(distDir, "vis-network.min.js"), "utf-8"),
      fs2.promises.readFile(path2.join(distDir, "webview.js"), "utf-8")
    ]);
  }
  const [visJs, webviewJs] = await _filesCachePromise;
  const graphMsg = buildGraphMsg(data);
  const safeJson = JSON.stringify(graphMsg).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
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
    // Security①: グラフに含まれるファイルパス（正規化済み）のセット。
    //   wsRoots が空の単一ファイル編集モードでのアクセス制限に使用する。
    this._allowedFiles = /* @__PURE__ */ new Set();
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
          case "requestSource": {
            const req = msg;
            const { nodeId, file, line, scopeEnd } = req;
            if (!file || line === void 0)
              break;
            const wsRoots = vscode2.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
            if (!isPathInWorkspace(file, wsRoots, this._allowedFiles))
              break;
            let resolvedFile;
            try {
              resolvedFile = await fs2.promises.realpath(path2.resolve(file));
            } catch {
              break;
            }
            if (!isPathInWorkspace(resolvedFile, wsRoots, this._allowedFiles))
              break;
            try {
              const content = await fs2.promises.readFile(resolvedFile, "utf-8");
              const lines = content.split("\n");
              const startIdx = Math.max(0, line - 1);
              const endIdx = scopeEnd !== void 0 ? Math.min(scopeEnd, startIdx + MAX_SOURCE_LINES, lines.length) : Math.min(startIdx + MAX_SOURCE_LINES, lines.length);
              const source = lines.slice(startIdx, endIdx).join("\n");
              this._panel.webview.postMessage({ type: "sourceData", nodeId, source });
            } catch {
              this._panel.webview.postMessage({ type: "sourceData", nodeId, source: "// Could not read source" });
            }
            break;
          }
          case "exportHtml":
            if (this._lastGraphData)
              await _CallGraphPanel.exportHtmlFile(this._extensionUri, this._lastGraphData);
            else
              vscode2.window.showWarningMessage("No graph data to export.");
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
    const column = vscode2.window.activeTextEditor ? vscode2.ViewColumn.Beside : vscode2.ViewColumn.One;
    if (_CallGraphPanel.currentPanel) {
      _CallGraphPanel.currentPanel._panel.reveal(column);
      return _CallGraphPanel.currentPanel;
    }
    const panel = vscode2.window.createWebviewPanel(
      "callGraphViewer",
      "Call Map",
      column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    _CallGraphPanel.currentPanel = new _CallGraphPanel(panel, extensionUri);
    return _CallGraphPanel.currentPanel;
  }
  setLoading(fileName) {
    this._panel.title = "Call Map \u2014 Analyzing...";
    this._postOrQueue({ type: "loading", fileName });
  }
  updateGraph(data) {
    this._lastGraphData = data;
    this._panel.title = `Call Map \u2014 ${data.fileName}`;
    this._allowedFiles = new Set(data.nodes.map((n) => resolveAndNormalize(n.file)));
    this._postOrQueue(buildGraphMsg(data));
  }
  showError(message) {
    this._panel.title = "Call Map \u2014 Error";
    this._postOrQueue({ type: "error", message });
  }
  static async exportHtmlFile(extensionUri, data) {
    const wsRoot = vscode2.workspace.workspaceFolders?.[0]?.uri;
    const safeName = data.fileName.replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 80) || "graph";
    const defaultUri = wsRoot ? vscode2.Uri.joinPath(wsRoot, `callgraph_${safeName}.html`) : vscode2.Uri.file(path2.join(os2.homedir(), `callgraph_${safeName}.html`));
    const saveUri = await vscode2.window.showSaveDialog({
      defaultUri,
      filters: { "HTML File": ["html"] }
    });
    if (!saveUri)
      return;
    try {
      const html = await generateStandaloneHtml(extensionUri, data);
      await vscode2.workspace.fs.writeFile(saveUri, Buffer.from(html, "utf-8"));
      const open = await vscode2.window.showInformationMessage(
        `Saved: ${path2.basename(saveUri.fsPath)}`,
        "Open in Browser"
      );
      if (open === "Open in Browser")
        await vscode2.env.openExternal(saveUri);
    } catch (e) {
      vscode2.window.showErrorMessage(`Failed to save: ${e}`);
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
    const wsRoots = (vscode2.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!isPathInWorkspace(filePath, wsRoots, this._allowedFiles)) {
      vscode2.window.showErrorMessage(
        `Call Map: Cannot open file outside workspace:
${filePath}`
      );
      return;
    }
    let resolvedPath;
    try {
      resolvedPath = await fs2.promises.realpath(path2.resolve(filePath));
    } catch {
      vscode2.window.showErrorMessage(`Could not open file: ${filePath}`);
      return;
    }
    if (!isPathInWorkspace(resolvedPath, wsRoots, this._allowedFiles)) {
      vscode2.window.showErrorMessage(
        `Call Map: Cannot open file outside workspace:
${resolvedPath}`
      );
      return;
    }
    try {
      const uri = vscode2.Uri.file(resolvedPath);
      const pos = new vscode2.Position(Math.max(0, line - 1), 0);
      const doc = await vscode2.workspace.openTextDocument(uri);
      await vscode2.window.showTextDocument(doc, { selection: new vscode2.Range(pos, pos), viewColumn: vscode2.ViewColumn.One });
    } catch {
      vscode2.window.showErrorMessage(`Could not open file: ${resolvedPath}`);
    }
  }
  _buildHtml() {
    const nonce = crypto.randomBytes(16).toString("hex");
    const webview = this._panel.webview;
    const distDir = vscode2.Uri.joinPath(this._extensionUri, "dist");
    const visUri = webview.asWebviewUri(vscode2.Uri.joinPath(distDir, "vis-network.min.js"));
    const webviewUri = webview.asWebviewUri(vscode2.Uri.joinPath(distDir, "webview.js"));
    return htmlTemplate(
      { kind: "webview", nonce, cspSource: webview.cspSource },
      `<script nonce="${nonce}" src="${visUri}"></script>
<script nonce="${nonce}" src="${webviewUri}"></script>`
    );
  }
};
function htmlTemplate(mode, scripts) {
  const cspMeta = mode.kind === "webview" ? `<meta http-equiv="Content-Security-Policy"
         content="default-src 'none'; script-src 'nonce-${mode.nonce}' ${mode.cspSource}; style-src 'unsafe-inline'; img-src data: blob:;">` : `<meta http-equiv="Content-Security-Policy"
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
/* \u30CD\u30A4\u30C6\u30A3\u30D6 number \u30B9\u30D4\u30CA\u30FC\u3092\u975E\u8868\u793A\u306B\u3057\u3066\u898B\u5207\u308C\u3092\u9632\u3050 */
#font-size-input::-webkit-inner-spin-button,
#font-size-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
#font-size-input { -moz-appearance: textfield; text-align: center; }
/* \u30B3\u30F3\u30C8\u30ED\u30FC\u30EB\u30D1\u30CD\u30EB\u6298\u308A\u305F\u305F\u307F */
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
    <b style="font-size:13px;">\u{1F4DE} Call Map</b>
    <button id="controls-toggle" title="Collapse panel">\u25BC</button>
  </div>
  <div id="controls-body">
  <div style="color:#636e72;font-size:11px;margin:2px 0 8px;">
    <b style="color:#97c2fc;">\u25CF</b> selected &nbsp;
    <b style="color:#e17055;">\u25CF</b> callee &nbsp;
    <b style="color:#00b894;">\u25CF</b> caller &nbsp;
    <span style="color:#aaa;font-size:10px;">Ctrl+Click to jump</span>
  </div>
  <div style="display:flex;margin-bottom:4px;">
    <button class="search-mode-btn active" id="search-mode-func" title="Search by function name">func</button>
    <button class="search-mode-btn active" id="search-mode-file" title="Search by file name">file</button>
  </div>
  <input id="search-box" type="text" placeholder="\u{1F50D} Search">

  <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;color:#2d3436;margin-bottom:4px;">
    <input id="src-toggle" type="checkbox" style="cursor:pointer;"> Show source panel
  </label>
  <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:#636e72;margin-bottom:6px;">
    <label for="font-size-input" style="white-space:nowrap;">Font size:</label>
    <button id="font-size-down" style="width:22px;height:22px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-size:13px;line-height:1;cursor:pointer;color:#636e72;padding:0;display:flex;align-items:center;justify-content:center;">\uFF0D</button>
    <input id="font-size-input" type="number" value="11" min="6" max="64"
      style="width:38px;height:22px;padding:0 2px;border:1px solid #b2bec3;border-radius:4px;font-family:monospace;font-size:11px;outline:none;">
    <button id="font-size-up" style="width:22px;height:22px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-size:13px;line-height:1;cursor:pointer;color:#636e72;padding:0;display:flex;align-items:center;justify-content:center;">\uFF0B</button>
    <button id="font-size-reset" style="padding:2px 7px;height:22px;border:1px solid #b2bec3;border-radius:4px;background:#f0f0f0;font-family:monospace;font-size:11px;cursor:pointer;color:#636e72;">Reset</button>
  </div>
  <button id="export-btn" style="width:100%;padding:5px 0;margin-bottom:6px;border:1px solid #b2bec3;border-radius:4px;background:#f8f9fa;font-family:monospace;font-size:11px;cursor:pointer;color:#2d3436;">
    \u{1F4BE} Save as HTML
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
    <span style="font-size:28px;">\u2190</span>
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
        <button id="goto-btn" style="background:#313244;border:1px solid #45475a;color:#cdd6f4;cursor:pointer;padding:4px 10px;border-radius:4px;font-family:monospace;font-size:11px;">\u25B7 Go to source</button>
        <button id="src-close-btn" style="background:none;border:none;color:#6c7086;cursor:pointer;font-size:16px;">\u2715</button>
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

// src/extension.ts
function getWarnThreshold() {
  return vscode3.workspace.getConfiguration("callmap").get("warnThreshold", 30);
}
var EXCLUDE_DIRS = /* @__PURE__ */ new Set([
  // 共通
  "node_modules",
  "build",
  "dist",
  "out",
  ".git",
  // CMake 系
  "CMakeFiles",
  "_build",
  "_deps",
  "cmake-build-debug",
  "cmake-build-release",
  // ツール系
  ".cache",
  ".ccls-cache",
  "vendor",
  ".deps"
]);
async function findFilesInFolder(folderUri, extensions) {
  const result = [];
  async function walk(uri) {
    let entries;
    try {
      entries = await vscode3.workspace.fs.readDirectory(uri);
    } catch {
      return;
    }
    const subdirs = [];
    for (const [name, type] of entries) {
      if (type === vscode3.FileType.Directory) {
        if (EXCLUDE_DIRS.has(name))
          continue;
        subdirs.push(vscode3.Uri.joinPath(uri, name));
      } else if (type === vscode3.FileType.File) {
        if (extensions.has(path3.extname(name).toLowerCase())) {
          result.push(vscode3.Uri.joinPath(uri, name));
        }
      }
    }
    await Promise.all(subdirs.map(walk));
  }
  await walk(folderUri);
  return result;
}
var FOLDER_FILES_CACHE_TTL = 6e4;
var folderFilesCache = /* @__PURE__ */ new Map();
async function findFilesInFolderCached(folderUri, extensions) {
  const key = `${folderUri.fsPath}\0${[...extensions].sort().join(",")}`;
  const now = Date.now();
  const hit = folderFilesCache.get(key);
  if (hit && now - hit.ts < FOLDER_FILES_CACHE_TTL)
    return hit.uris;
  const uris = await findFilesInFolder(folderUri, extensions);
  folderFilesCache.set(key, { uris, ts: now });
  return uris;
}
async function pickBackend() {
  const defaultBackend = vscode3.workspace.getConfiguration("callmap").get("defaultBackend", "ask");
  if (defaultBackend === "lsp")
    return "lsp";
  if (defaultBackend === "gtags")
    return "gtags";
  const items = [
    {
      label: "$(search) LSP (High accuracy)",
      description: "Uses clangd / C/C++ extension. Requires LSP index.",
      backend: "lsp"
    },
    {
      label: "$(zap) gtags (Fast)",
      description: "Uses GNU GLOBAL. No LSP required. Suitable for large projects.",
      backend: "gtags"
    }
  ];
  const qp = vscode3.window.createQuickPick();
  qp.items = items;
  qp.placeholder = "Select analysis backend";
  qp.title = "Call Map: Backend";
  qp.activeItems = items.filter((i) => i.backend === defaultBackend);
  return new Promise((resolve3) => {
    qp.onDidAccept(() => {
      resolve3(qp.selectedItems[0]?.backend);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve3(void 0);
      qp.dispose();
    });
    qp.show();
  });
}
async function pickOutputMode() {
  const defaultMode = vscode3.workspace.getConfiguration("callmap").get("defaultOutputMode", "ask");
  if (defaultMode === "webview")
    return "webview";
  if (defaultMode === "html")
    return "html";
  const picked = await vscode3.window.showQuickPick(
    [
      { label: "$(callhierarchy-outgoing) Open in WebView", mode: "webview" },
      { label: "$(browser) Save as HTML and open in browser", mode: "html" }
    ],
    { placeHolder: "Select output mode", title: "Call Map: Output mode" }
  );
  return picked?.mode;
}
async function pickExtensions(title) {
  return vscode3.window.showQuickPick(
    [
      {
        label: "$(files) C / C++ (all source)",
        description: ".c .cpp .cc .cxx .cu .cuh",
        extensions: /* @__PURE__ */ new Set([".c", ".cpp", ".cc", ".cxx", ".cu", ".cuh"])
      },
      {
        label: "$(files) C + C++ (no CUDA)",
        description: ".c .cpp .cc .cxx",
        extensions: /* @__PURE__ */ new Set([".c", ".cpp", ".cc", ".cxx"])
      },
      {
        label: "$(file-code) C only",
        description: ".c",
        extensions: /* @__PURE__ */ new Set([".c"])
      },
      {
        label: "$(file-code) C++ only",
        description: ".cpp .cc .cxx",
        extensions: /* @__PURE__ */ new Set([".cpp", ".cc", ".cxx"])
      }
    ],
    { placeHolder: "Select file extensions to analyze", title }
  );
}
async function buildAndOutput(mode, fileName, extensionUri, build) {
  const panel = mode === "webview" ? CallGraphPanel.createOrShow(extensionUri) : void 0;
  panel?.setLoading(path3.basename(fileName));
  await vscode3.window.withProgress(
    {
      location: vscode3.ProgressLocation.Notification,
      title: "Building Call Map",
      // ★ ④: キャンセル可能にする
      cancellable: true
    },
    async (progress, token) => {
      try {
        const data = await build(progress, token);
        if (token.isCancellationRequested)
          return;
        if (data.errors.length > 0)
          console.warn("[CallMap] Analysis warnings:", data.errors);
        if (mode === "webview") {
          panel.updateGraph(data);
          vscode3.window.setStatusBarMessage(
            `\u{1F4DE} Call Map: ${data.nodes.length} nodes / ${data.edges.length} edges (${data.buildTimeMs}ms)`,
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
          vscode3.window.showErrorMessage("Call Map error:\n" + msg);
      }
    }
  );
}
function activate(context) {
  const watcher = vscode3.workspace.createFileSystemWatcher(
    "**/*.{c,cpp,cc,cxx,cu,cuh,h,hpp,hxx}",
    false,
    false,
    false
  );
  const isExcludedPath = (fsPath) => fsPath.split(/[/\\]/).some((seg) => EXCLUDE_DIRS.has(seg));
  let _contentTimer;
  const _contentPending = /* @__PURE__ */ new Set();
  const onContentChanged = (uri) => {
    if (isExcludedPath(uri.fsPath))
      return;
    _contentPending.add(uri.fsPath);
    clearTimeout(_contentTimer);
    _contentTimer = setTimeout(() => {
      const paths = [..._contentPending];
      _contentPending.clear();
      if (paths.length >= 5)
        invalidateCache();
      else
        paths.forEach((fp) => invalidateCache(fp));
    }, 300);
  };
  let _structTimer;
  const _structPending = /* @__PURE__ */ new Set();
  const onFsStructureChanged = (uri) => {
    if (isExcludedPath(uri.fsPath))
      return;
    _structPending.add(uri.fsPath);
    clearTimeout(_structTimer);
    _structTimer = setTimeout(() => {
      const paths = [..._structPending];
      _structPending.clear();
      if (paths.length >= 5)
        invalidateCache();
      else
        paths.forEach((fp) => invalidateCache(fp));
      folderFilesCache.clear();
    }, 300);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onContentChanged),
    watcher.onDidCreate(onFsStructureChanged),
    watcher.onDidDelete(onFsStructureChanged)
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("callgraph.showWorkspaceGraph", async () => {
      const extPick = await pickExtensions("Call Map: Workspace analysis");
      if (!extPick)
        return;
      const workspaceFolders = vscode3.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode3.window.showErrorMessage("Call Map: No workspace folder is open.");
        return;
      }
      const foundUris = await vscode3.window.withProgress(
        { location: vscode3.ProgressLocation.Notification, title: "Searching C/C++ files...", cancellable: false },
        async () => {
          const results = await Promise.all(
            workspaceFolders.map((folder) => findFilesInFolderCached(folder.uri, extPick.extensions))
          );
          return results.flat();
        }
      );
      if (!foundUris.length) {
        vscode3.window.showErrorMessage(
          "Call Map: No target files found.\nExtension: " + extPick.description
        );
        return;
      }
      if (foundUris.length > getWarnThreshold()) {
        const answer = await vscode3.window.showWarningMessage(
          `Analyze ${foundUris.length} files. Continue?`,
          { modal: true },
          "Continue"
        );
        if (answer !== "Continue")
          return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const activeEditor = vscode3.window.activeTextEditor;
      const warmupDone = activeEditor && hasCppSourceExtension(activeEditor.document.uri) ? warmupCache(activeEditor.document, backend) : Promise.resolve();
      const mode = await pickOutputMode();
      if (!mode) {
        await warmupDone;
        return;
      }
      await warmupDone;
      await buildAndOutput(
        mode,
        `${foundUris.length} files`,
        context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, prog, backend, tok)
      );
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("callgraph.showFolderGraph", async (uri) => {
      let folderUri;
      if (uri) {
        try {
          const stat = await vscode3.workspace.fs.stat(uri);
          folderUri = stat.type === vscode3.FileType.Directory ? uri : vscode3.Uri.file(path3.dirname(uri.fsPath));
        } catch {
          folderUri = vscode3.Uri.file(path3.dirname(uri.fsPath));
        }
      } else {
        const activeFile = vscode3.window.activeTextEditor?.document.uri;
        const defaultUri = activeFile ? vscode3.Uri.file(path3.dirname(activeFile.fsPath)) : vscode3.workspace.workspaceFolders?.[0]?.uri;
        const result = await vscode3.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "Analyze this folder",
          title: "Call Map: Select folder to analyze",
          defaultUri
        });
        if (!result?.length)
          return;
        folderUri = result[0];
      }
      const extPick = await pickExtensions("Call Map: Folder analysis");
      if (!extPick)
        return;
      if (!folderUri)
        return;
      const foundUris = await vscode3.window.withProgress(
        { location: vscode3.ProgressLocation.Notification, title: "Searching C/C++ files...", cancellable: false },
        () => findFilesInFolderCached(folderUri, extPick.extensions)
      );
      if (!foundUris.length) {
        vscode3.window.showErrorMessage(
          `Call Map: No target files found.
Folder: ${folderUri.fsPath}
Extension: ${extPick.description}`
        );
        return;
      }
      if (foundUris.length > getWarnThreshold()) {
        const answer = await vscode3.window.showWarningMessage(
          `Analyze ${foundUris.length} files. Continue?`,
          { modal: true },
          "Continue"
        );
        if (answer !== "Continue")
          return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const activeEditorF = vscode3.window.activeTextEditor;
      const warmupDoneF = activeEditorF && hasCppSourceExtension(activeEditorF.document.uri) ? warmupCache(activeEditorF.document, backend) : Promise.resolve();
      const mode = await pickOutputMode();
      if (!mode) {
        await warmupDoneF;
        return;
      }
      await warmupDoneF;
      const folderName = path3.basename(folderUri.fsPath);
      await buildAndOutput(
        mode,
        folderName,
        context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, prog, backend, tok)
      );
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("callgraph.showFileGraph", async () => {
      const editor = vscode3.window.activeTextEditor;
      if (!editor) {
        vscode3.window.showErrorMessage("Call Map: Please open a C/C++ file first.");
        return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const warmupDone = warmupCache(editor.document, backend);
      const mode = await pickOutputMode();
      if (!mode) {
        await warmupDone;
        return;
      }
      await warmupDone;
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
        vscode3.window.showErrorMessage("Call Map: Please open a C/C++ file first.");
        return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const warmupDone = warmupCache(editor.document, backend);
      const mode = await pickOutputMode();
      if (!mode) {
        await warmupDone;
        return;
      }
      await warmupDone;
      await buildAndOutput(
        mode,
        editor.document.fileName,
        context.extensionUri,
        // ⑩ callmap.maxHops 設定値を参照する（デフォルト 4）。
        //   旧実装は Number.MAX_SAFE_INTEGER をハードコードしており設定が無視されていた。
        (prog, tok) => {
          const maxHops = vscode3.workspace.getConfiguration("callmap").get("maxHops", 4);
          return buildFunctionCallGraph(editor.document, editor.selection.active, maxHops, prog, backend, tok);
        }
      );
    })
  );
  context.subscriptions.push(
    vscode3.commands.registerCommand("callgraph.showPathGraph", async () => {
      const editor = vscode3.window.activeTextEditor;
      if (!editor) {
        vscode3.window.showErrorMessage("Call Map: Please open a C/C++ file first.");
        return;
      }
      const backend = await pickBackend();
      if (!backend)
        return;
      const warmupDone = warmupCache(editor.document, backend);
      const mode = await pickOutputMode();
      if (!mode) {
        await warmupDone;
        return;
      }
      await warmupDone;
      const maxHops = vscode3.workspace.getConfiguration("callmap").get("maxHops", 4);
      await buildAndOutput(
        mode,
        editor.document.fileName,
        context.extensionUri,
        (prog, tok) => buildPathThroughCallGraph(
          editor.document,
          editor.selection.active,
          maxHops,
          prog,
          backend,
          tok
        )
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
