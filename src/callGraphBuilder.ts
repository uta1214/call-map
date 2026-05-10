/**
 * callGraphBuilder.ts  ─  LSP + gtags デュアルバックエンド
 *
 * 変更点:
 *  - Backend 型 / resolveBackend() を追加
 *  - 既存 LSP 実装を内部関数 *Lsp へ (API 互換維持)
 *  - gtags 実装 *Gtags を追加
 *  - 公開エントリーポイントが backend 引数で分岐
 *  - buildWorkspaceCallGraphLsp にヘッダー除外フィルタを追加 (既存バグ修正)
 */

import * as vscode  from 'vscode';
import * as path    from 'path';
import * as fs      from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id:            string;
  label:         string;
  labelShort:    string;
  labelFull:     string;
  file:          string;
  line:          number;
  source:        string;
  isCurrentFile: boolean;
}

export interface GraphEdge { from: string; to: string; }

export interface GraphData {
  nodes:       GraphNode[];
  edges:       GraphEdge[];
  fileName:    string;
  buildTimeMs: number;
  errors:      string[];
}

export type Backend = 'lsp' | 'gtags' | 'auto';

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE  = 2;
const BATCH_DELAY = 30;

// LSP バックエンドで caller としてスキャンするソース拡張子
const CC_SOURCE_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']);

// gtags バックエンドでタグ収集対象とするソース拡張子 (ヘッダー含む)
const CC_ALL_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh', '.h', '.hpp', '.hxx']);

// findFiles 用グロブ
const CC_SOURCE_GLOB = '**/*.{c,cpp,cc,cxx,cu,cuh}';
const EXCLUDE_GLOB   = '{**/node_modules/**,**/build/**,**/dist/**,**/out/**,**/.git/**}';

// ─────────────────────────────────────────────────────────────────────────────
// 共通ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

function splitEdges(edgeSet: Set<string>): GraphEdge[] {
  return Array.from(edgeSet).map(key => {
    const sep = key.indexOf('|||');
    return { from: key.slice(0, sep), to: key.slice(sep + 3) };
  });
}

function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

function getWorkspaceRoot(fallbackUri?: vscode.Uri): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? (fallbackUri ? path.dirname(fallbackUri.fsPath) : undefined);
}

function getWorkspaceRoots(fallbackUri?: vscode.Uri): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  if (folders.length === 0 && fallbackUri) return [path.dirname(fallbackUri.fsPath)];
  return folders;
}

// ─────────────────────────────────────────────────────────────────────────────
// バックエンド解決
// ─────────────────────────────────────────────────────────────────────────────

async function gtagsAvailable(): Promise<boolean> {
  try { await execFileAsync('gtags', ['--version']); return true; }
  catch { return false; }
}

/** 'auto' の場合は gtags が使えれば 'gtags'、なければ 'lsp' を返す */
export async function resolveBackend(backend: Backend): Promise<'lsp' | 'gtags'> {
  if (backend === 'lsp')   return 'lsp';
  if (backend === 'gtags') return 'gtags';
  return (await gtagsAvailable()) ? 'gtags' : 'lsp';
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP バックエンド  ─  内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

function hasCppSourceExtension(uri: vscode.Uri): boolean {
  return CC_SOURCE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

function isInWorkspace(uri: vscode.Uri, roots: string[]): boolean {
  if (roots.length === 0) return true;
  const p = uri.fsPath;
  return roots.some(r => p === r || p.startsWith(r + path.sep) || p.startsWith(r + '/'));
}

function shouldIncludeCallee(uri: vscode.Uri, roots: string[]): boolean {
  return isInWorkspace(uri, roots) && hasCppSourceExtension(uri);
}

function makeNodeId(uri: vscode.Uri, name: string, line: number): string {
  return `${uri.fsPath}||${name}||${line}`;
}

function baseNameOf(name: string): string {
  const idx = name.indexOf('(');
  return idx >= 0 ? name.slice(0, idx).trim() : name;
}

function findExistingCalleeId(
  nodes: Map<string, GraphNode>,
  to: vscode.CallHierarchyItem
): string | null {
  const exactId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
  if (nodes.has(exactId)) return exactId;

  const base = baseNameOf(to.name);
  const fp   = to.uri.fsPath;
  for (const [id, node] of nodes) {
    if (node.file === fp && (node.label === base || baseNameOf(node.label) === base)) return id;
  }
  const ext = path.extname(fp).toLowerCase();
  if (['.h', '.hpp', '.hxx'].includes(ext)) {
    for (const [id, node] of nodes) {
      if (node.label === base || baseNameOf(node.label) === base) return id;
    }
  }
  return null;
}

function flattenFunctions(syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
  const seen  = new Set<number>();
  const result: vscode.DocumentSymbol[] = [];
  function walk(arr: vscode.DocumentSymbol[]) {
    for (const s of arr) {
      if (KINDS.has(s.kind)) {
        const key = s.selectionRange.start.line;
        if (!seen.has(key)) { seen.add(key); result.push(s); }
      }
      if (s.children?.length) walk(s.children);
    }
  }
  walk(syms);
  return result;
}

async function openLines(uri: vscode.Uri, cache: Map<string, string[]>): Promise<string[]> {
  const key = uri.fsPath;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const lines = (await vscode.workspace.openTextDocument(uri)).getText().split('\n');
    cache.set(key, lines);
    return lines;
  } catch { cache.set(key, []); return []; }
}

function sliceSource(lines: string[], s: number, e: number): string {
  return lines.slice(s, Math.min(e + 1, lines.length)).join('\n');
}

async function execWithRetry<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  for (let i = 0; i <= 2; i++) {
    try { return await vscode.commands.executeCommand<T>(command, ...args); }
    catch (err) {
      const msg = String(err);
      if (msg.includes('not found')) throw err;
      if (i < 2 && msg.includes('Canceled')) { await delay(100 * (i + 1)); continue; }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP バックエンド  ─  実装
// ─────────────────────────────────────────────────────────────────────────────

async function buildFileCallGraphLsp(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const cache   = new Map<string, string[]>();
  const wsRoots = getWorkspaceRoots(document.uri);

  const currentLines = document.getText().split('\n');
  cache.set(document.uri.fsPath, currentLines);

  progress?.report({ message: 'シンボルを取得中...' });
  const rawSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', document.uri
  );
  if (!rawSyms?.length) throw new Error(
    'シンボルが見つかりませんでした。\n\n【確認事項】\n' +
    '  1. clangd または C/C++ 拡張機能が有効か\n' +
    '  2. インデックス作成が完了しているか\n' +
    '  3. clangd の場合: compile_commands.json があるか'
  );

  const functions = flattenFunctions(rawSyms);
  if (!functions.length) throw new Error('このファイルに関数シンボルが見つかりませんでした。');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  for (const f of functions) {
    const id = makeNodeId(document.uri, f.name, f.selectionRange.start.line);
    nodes.set(id, {
      id, label: f.name, labelShort: baseNameOf(f.name), labelFull:  f.name, file: document.uri.fsPath,
      line:   f.selectionRange.start.line + 1,
      source: sliceSource(currentLines, f.range.start.line, f.range.end.line),
      isCurrentFile: true,
    });
  }

  const total = functions.length;
  for (let i = 0; i < functions.length; i += BATCH_SIZE) {
    const batch = functions.slice(i, i + BATCH_SIZE);
    progress?.report({
      message:   `コール解析中... (${Math.min(i + BATCH_SIZE, total)}/${total})`,
      increment: (batch.length / total) * 80,
    });
    await Promise.all(batch.map(async (func) => {
      try {
        const items = await execWithRetry<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy', document.uri, func.selectionRange.start);
        if (!items?.length) return;
        const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls', items[0]);
        if (!outgoing?.length) return;

        const callerId = makeNodeId(document.uri, func.name, func.selectionRange.start.line);
        for (const call of outgoing) {
          const { to } = call;
          let calleeId = findExistingCalleeId(nodes, to);
          if (!calleeId) {
            if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
            calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
            const ll = await openLines(to.uri, cache);
            nodes.set(calleeId, {
              id: calleeId, label: baseNameOf(to.name), file: to.uri.fsPath,
              line:   to.selectionRange.start.line + 1,
              source: sliceSource(ll, to.range.start.line, to.range.end.line),
              isCurrentFile: false,
            });
          }
          edgeSet.add(`${callerId}|||${calleeId}`);
        }
      } catch (err) { errs.push(`${func.name}: ${String(err)}`); }
    }));
    if (i + BATCH_SIZE < functions.length) await delay(BATCH_DELAY);
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: path.basename(document.uri.fsPath),
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}

async function buildFunctionCallGraphLsp(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const cache   = new Map<string, string[]>();
  const wsRoots = getWorkspaceRoots(document.uri);

  progress?.report({ message: '起点関数を特定中...' });
  const startItems = await execWithRetry<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', document.uri, position);
  if (!startItems?.length) throw new Error(
    'カーソル位置に関数が見つかりませんでした。\n関数名の上にカーソルを置いてから実行してください。');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const visited = new Set<string>();
  type Q = [vscode.CallHierarchyItem, number];
  const queue: Q[] = [[startItems[0], 0]];

  while (queue.length > 0) {
    const [item, hop] = queue.shift()!;
    const nodeId = makeNodeId(item.uri, item.name, item.selectionRange.start.line);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    if (!nodes.has(nodeId)) {
      const ll = await openLines(item.uri, cache);
      nodes.set(nodeId, {
        id: nodeId, label: baseNameOf(item.name), file: item.uri.fsPath,
        line:   item.selectionRange.start.line + 1,
        source: sliceSource(ll, item.range.start.line, item.range.end.line),
        isCurrentFile: item.uri.fsPath === document.uri.fsPath,
      });
    }
    if (hop >= maxHops) continue;
    progress?.report({ message: `BFS 展開中... (ノード: ${nodes.size})` });

    try {
      const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls', item);
      if (!outgoing?.length) continue;
      for (const call of outgoing) {
        let calleeId = findExistingCalleeId(nodes, call.to);
        if (!calleeId) {
          if (!shouldIncludeCallee(call.to.uri, wsRoots)) continue;
          calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
        }
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!visited.has(calleeId)) queue.push([call.to, hop + 1]);
      }
    } catch (err) { errs.push(`${item.name}: ${String(err)}`); }
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: `${baseNameOf(startItems[0].name)} (${path.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}

async function buildWorkspaceCallGraphLsp(
  uris: vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GraphData> {
  const t0         = Date.now();
  const errs:      string[] = [];
  const cache      = new Map<string, string[]>();
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values());
  const wsRoots    = getWorkspaceRoots(uniqueUris[0]);
  const nodes      = new Map<string, GraphNode>();
  const edgeSet    = new Set<string>();

  for (let fi = 0; fi < uniqueUris.length; fi++) {
    const uri = uniqueUris[fi];

    // ★ ヘッダーは caller としてスキャンしない (宣言に対して prepareCallHierarchy を
    //    呼ぶと clangd が Canceled を返す原因になるため)
    if (!hasCppSourceExtension(uri)) continue;

    progress?.report({
      message:   `解析中 ${fi + 1}/${uniqueUris.length}: ${path.basename(uri.fsPath)}`,
      increment: (1 / uniqueUris.length) * 100,
    });

    let rawSyms: vscode.DocumentSymbol[] | undefined;
    try {
      rawSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri);
    } catch { continue; }
    if (!rawSyms?.length) continue;

    const functions = flattenFunctions(rawSyms);
    const lines     = await openLines(uri, cache);
    for (const f of functions) {
      const id = makeNodeId(uri, f.name, f.selectionRange.start.line);
      if (!nodes.has(id)) nodes.set(id, {
        id, label: f.name, labelShort: baseNameOf(f.name), labelFull:  f.name, file: uri.fsPath,
        line:   f.selectionRange.start.line + 1,
        source: sliceSource(lines, f.range.start.line, f.range.end.line),
        isCurrentFile: false,
      });
    }

    for (let i = 0; i < functions.length; i += BATCH_SIZE) {
      await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async (func) => {
        try {
          const items = await execWithRetry<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy', uri, func.selectionRange.start);
          if (!items?.length) return;
          const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls', items[0]);
          if (!outgoing?.length) return;

          const callerId = makeNodeId(uri, func.name, func.selectionRange.start.line);
          for (const call of outgoing) {
            const { to } = call;
            let calleeId = findExistingCalleeId(nodes, to);
            if (!calleeId) {
              if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
              calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
              const ll = await openLines(to.uri, cache);
              nodes.set(calleeId, {
                id: calleeId, label: baseNameOf(to.name), file: to.uri.fsPath,
                line:   to.selectionRange.start.line + 1,
                source: sliceSource(ll, to.range.start.line, to.range.end.line),
                isCurrentFile: false,
              });
            }
            edgeSet.add(`${callerId}|||${calleeId}`);
          }
        } catch (err) { errs.push(`${path.basename(uri.fsPath)}::${func.name}: ${String(err)}`); }
      }));
      if (i + BATCH_SIZE < functions.length) await delay(BATCH_DELAY);
    }
  }

  const label = uniqueUris.length === 1
    ? path.basename(uniqueUris[0].fsPath)
    : `${uniqueUris.length} ファイル`;
  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: label, buildTimeMs: Date.now() - t0, errors: errs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  型定義
// ─────────────────────────────────────────────────────────────────────────────

interface GtagEntry {
  name:       string;
  file:       string;   // 絶対パス
  line:       number;
  sourceLine: string;
  isFunc:     boolean;
}

interface ScopeEntry {
  name:  string;
  start: number;        // 関数開始行 (1-indexed)
  end:   number;        // 関数終了行 (inclusive, 次タグの直前)
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

/** Python 版 is_function_def と同等のヒューリスティック */
function isLikelyFuncDef(line: string): boolean {
  const s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith('}')) return false;
  if (s.includes('typedef') || !s.includes('(') || s.endsWith(';')) return false;
  return true;
}

/** GTAGS が存在しなければ gtags を実行してDB構築 */
async function ensureGtagsDb(wsRoot: string): Promise<void> {
  if (fs.existsSync(path.join(wsRoot, 'GTAGS'))) return;
  await execFileAsync('gtags', ['--accept-dotfiles'], { cwd: wsRoot, timeout: 120_000 });
}

/**
 * `global -f <file>` を実行してそのファイルで定義されているタグを取得。
 * 出力形式: `tag_name  line_number  file_path`
 */
async function runGlobalF(
  absFile: string, wsRoot: string
): Promise<Array<{ name: string; line: number; file: string }>> {
  try {
    const relFile = path.relative(wsRoot, absFile);
    const { stdout } = await execFileAsync('global', ['-f', relFile], {
      cwd: wsRoot, maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.split('\n').flatMap(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return [];
      const name   = parts[0];
      const lineno = parseInt(parts[1], 10);
      if (!name || isNaN(lineno)) return [];
      const fp = path.isAbsolute(parts[2]) ? parts[2] : path.resolve(wsRoot, parts[2]);
      return [{ name, line: lineno, file: fp }];
    });
  } catch {
    return [];
  }
}

/** ファイルを行配列で読み込み、キャッシュする */
function readFileLinesCached(filePath: string, cache: Map<string, string[]>): string[] {
  if (cache.has(filePath)) return cache.get(filePath)!;
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    cache.set(filePath, lines);
    return lines;
  } catch {
    cache.set(filePath, []);
    return [];
  }
}

/**
 * 指定ファイル群に対して `global -f` を並列実行し、
 * タグ名 → GtagEntry のマップを返す。
 * 同名タグが複数ある場合は isFunc=true の定義を優先する。
 */
async function collectGtags(
  files: string[],
  wsRoot: string
): Promise<{ tags: Map<string, GtagEntry>; lineCache: Map<string, string[]> }> {
  const lineCache = new Map<string, string[]>();
  const rawMap    = new Map<string, Array<{ name: string; line: number; file: string }>>();

  // global -f を最大 16 並列で実行
  const CONCURRENT = Math.min(16, Math.max(1, files.length));
  for (let i = 0; i < files.length; i += CONCURRENT) {
    const results = await Promise.all(
      files.slice(i, i + CONCURRENT).map(f => runGlobalF(f, wsRoot))
    );
    for (const entries of results) {
      for (const e of entries) {
        if (!rawMap.has(e.name)) rawMap.set(e.name, []);
        rawMap.get(e.name)!.push(e);
      }
    }
  }

  // ソース行を読んで isFunc 判定し、定義行を優先して best を選ぶ
  const tags = new Map<string, GtagEntry>();
  for (const [name, candidates] of rawMap) {
    let best: GtagEntry | null = null;
    for (const cand of candidates) {
      const lines   = readFileLinesCached(cand.file, lineCache);
      const srcLine = lines[cand.line - 1]?.trimEnd() ?? '';
      const isFunc  = isLikelyFuncDef(srcLine);
      const entry: GtagEntry = { name, file: cand.file, line: cand.line, sourceLine: srcLine, isFunc };
      if (!best || (isFunc && !best.isFunc)) best = entry;
    }
    if (best) tags.set(name, best);
  }
  return { tags, lineCache };
}

/**
 * タグマップからスコープマップを構築。
 * 各ファイルでタグを行番号順に並べ、隣接タグ間が一つの関数スコープ。
 */
function buildGtagsScopeMap(tags: Map<string, GtagEntry>): Map<string, ScopeEntry[]> {
  const fileMap = new Map<string, { name: string; line: number }[]>();
  for (const [name, info] of tags) {
    if (!fileMap.has(info.file)) fileMap.set(info.file, []);
    fileMap.get(info.file)!.push({ name, line: info.line });
  }
  const scopeMap = new Map<string, ScopeEntry[]>();
  for (const [fp, entries] of fileMap) {
    entries.sort((a, b) => a.line - b.line);
    scopeMap.set(fp, entries.map((e, i) => ({
      name:  e.name,
      start: e.line,
      end:   i + 1 < entries.length ? entries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
    })));
  }
  return scopeMap;
}

/**
 * ソース行の [start, end] 範囲を正規表現でスキャンし、
 * knownTags に含まれる呼び出し先 (自己再帰除外) を返す。
 */
function extractCallsFromLines(
  lines: string[], start: number, end: number,
  knownTags: Set<string>, selfName: string
): Set<string> {
  const callees = new Set<string>();
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    // 行コメント・ブロックコメントを除去してからマッチ
    const stripped = lines[i]
      .replace(/\/\/.*/g, '')
      .replace(/\/\*.*?\*\//g, '');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const callee = m[1];
      if (callee !== selfName && knownTags.has(callee)) callees.add(callee);
    }
  }
  return callees;
}

function makeGtagsNodeId(file: string, name: string, line: number): string {
  return `${file}||${name}||${line}`;
}

function gtagsEntryToNode(
  name: string, entry: GtagEntry, scope: ScopeEntry,
  lines: string[], currentFile: string
): GraphNode {
  return {
    id:            makeGtagsNodeId(entry.file, name, entry.line),
    labelShort: name,
    labelFull:  name,
    label:         name,
    file:          entry.file,
    line:          entry.line,
    source:        lines.slice(scope.start - 1, Math.min(scope.end, lines.length)).join('\n'),
    isCurrentFile: entry.file === currentFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  実装
// ─────────────────────────────────────────────────────────────────────────────

async function buildFileCallGraphGtags(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GraphData> {
  const t0      = Date.now();
  const wsRoot  = getWorkspaceRoot(document.uri);
  if (!wsRoot) throw new Error('ワークスペースが開かれていません。');

  progress?.report({ message: '[gtags] DB を確認中...' });
  await ensureGtagsDb(wsRoot);

  progress?.report({ message: '[gtags] C/C++ ファイルを検索中...' });
  const allUris  = await vscode.workspace.findFiles(CC_SOURCE_GLOB, EXCLUDE_GLOB);
  const allFiles = allUris.map(u => u.fsPath);

  progress?.report({ message: '[gtags] タグを収集中...' });
  const { tags, lineCache } = await collectGtags(allFiles, wsRoot);
  if (!tags.size) throw new Error('タグが見つかりませんでした。gtags のインストールと GTAGS の確認をしてください。');

  // 現在ファイルの内容を lineCache に上書き (未保存変更を反映)
  const currentFile = document.uri.fsPath;
  const currentLines = document.getText().split('\n');
  lineCache.set(currentFile, currentLines);

  const knownTags = new Set(tags.keys());
  const scopeMap  = buildGtagsScopeMap(tags);
  const fileScopes = scopeMap.get(currentFile) ?? [];

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // 現在ファイルの関数ノードを登録
  for (const scope of fileScopes) {
    const entry = tags.get(scope.name);
    if (!entry || !entry.isFunc || entry.file !== currentFile) continue;
    const node = gtagsEntryToNode(scope.name, entry, scope, currentLines, currentFile);
    nodes.set(node.id, node);
  }
  if (!nodes.size) throw new Error('このファイルに関数が見つかりませんでした。');

  // エッジ抽出: 現在ファイル内の各関数の呼び出し先を解析
  progress?.report({ message: '[gtags] コール関係を解析中...', increment: 50 });
  for (const scope of fileScopes) {
    const entry = tags.get(scope.name);
    if (!entry || !entry.isFunc || entry.file !== currentFile) continue;

    const callerId = makeGtagsNodeId(currentFile, scope.name, entry.line);
    const callees  = extractCallsFromLines(currentLines, scope.start, scope.end, knownTags, scope.name);

    for (const callee of callees) {
      const calleeEntry = tags.get(callee);
      if (!calleeEntry) continue;
      const calleeScope = scopeMap.get(calleeEntry.file)?.find(s => s.name === callee);
      if (!calleeScope) continue;

      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      if (!nodes.has(calleeId)) {
        const ll = readFileLinesCached(calleeEntry.file, lineCache);
        nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, ll, currentFile));
      }
      edgeSet.add(`${callerId}|||${calleeId}`);
    }
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: path.basename(currentFile),
    buildTimeMs: Date.now() - t0, errors: [],
  };
}

async function buildFunctionCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GraphData> {
  const t0      = Date.now();
  const wsRoot  = getWorkspaceRoot(document.uri);
  if (!wsRoot) throw new Error('ワークスペースが開かれていません。');

  progress?.report({ message: '[gtags] DB を確認中...' });
  await ensureGtagsDb(wsRoot);

  progress?.report({ message: '[gtags] タグを収集中...' });
  const allUris  = await vscode.workspace.findFiles(CC_SOURCE_GLOB, EXCLUDE_GLOB);
  const { tags, lineCache } = await collectGtags(allUris.map(u => u.fsPath), wsRoot);
  if (!tags.size) throw new Error('タグが見つかりませんでした。');

  // 現在ファイルの内容を上書き
  const currentFile = document.uri.fsPath;
  lineCache.set(currentFile, document.getText().split('\n'));

  const knownTags = new Set(tags.keys());
  const scopeMap  = buildGtagsScopeMap(tags);

  // カーソル行を含むスコープを起点にする (1-indexed)
  const cursorLine = position.line + 1;
  const fileScopes = scopeMap.get(currentFile) ?? [];
  const startScope = fileScopes.find(s => s.start <= cursorLine && cursorLine <= s.end);
  if (!startScope) throw new Error(
    'カーソル位置に関数が見つかりませんでした。\n関数名の上にカーソルを置いてから実行してください。');

  const startEntry = tags.get(startScope.name);
  if (!startEntry) throw new Error('起点関数のタグ情報が見つかりませんでした。');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const visited = new Set<string>();

  // BFS
  type Q = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
  const queue: Q[] = [{ name: startScope.name, entry: startEntry, scope: startScope, hop: 0 }];

  while (queue.length > 0) {
    const { name, entry, scope, hop } = queue.shift()!;
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const lines = readFileLinesCached(entry.file, lineCache);
    if (!nodes.has(nodeId)) {
      nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, lines, currentFile));
    }
    if (hop >= maxHops) continue;
    progress?.report({ message: `[gtags] BFS 展開中... (ノード: ${nodes.size})` });

    const callees = extractCallsFromLines(lines, scope.start, scope.end, knownTags, name);
    for (const callee of callees) {
      const calleeEntry = tags.get(callee);
      if (!calleeEntry) continue;
      const calleeScope = scopeMap.get(calleeEntry.file)?.find(s => s.name === callee);
      if (!calleeScope) continue;

      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      edgeSet.add(`${nodeId}|||${calleeId}`);
      if (!visited.has(calleeId)) {
        queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 });
      }
    }
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: `${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0, errors: [],
  };
}

async function buildWorkspaceCallGraphGtags(
  uris: vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GraphData> {
  const t0         = Date.now();
  // ヘッダーを caller スキャン対象から除外
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => CC_ALL_EXTENSIONS.has(path.extname(u.fsPath).toLowerCase()));
  if (!uniqueUris.length) throw new Error('C/C++ ソースファイルが見つかりませんでした。');

  const wsRoot = getWorkspaceRoot(uniqueUris[0]);
  if (!wsRoot) throw new Error('ワークスペースが開かれていません。');

  progress?.report({ message: '[gtags] DB を確認中...' });
  await ensureGtagsDb(wsRoot);

  // callee 解決のためにワークスペース全体のソースからタグ収集
  progress?.report({ message: '[gtags] タグを収集中...' });
  const allUris  = await vscode.workspace.findFiles(CC_SOURCE_GLOB, EXCLUDE_GLOB);
  const { tags, lineCache } = await collectGtags(allUris.map(u => u.fsPath), wsRoot);

  const knownTags   = new Set(tags.keys());
  const scopeMap    = buildGtagsScopeMap(tags);
  const targetFiles = new Set(uniqueUris.map(u => u.fsPath));
  const nodes       = new Map<string, GraphNode>();
  const edgeSet     = new Set<string>();
  const total       = uniqueUris.length;

  for (let fi = 0; fi < uniqueUris.length; fi++) {
    const uri = uniqueUris[fi];
    progress?.report({
      message:   `[gtags] 解析中 ${fi + 1}/${total}: ${path.basename(uri.fsPath)}`,
      increment: (1 / total) * 100,
    });

    const fileScopes = scopeMap.get(uri.fsPath) ?? [];
    const lines      = readFileLinesCached(uri.fsPath, lineCache);

    // ノード登録
    for (const scope of fileScopes) {
      const entry = tags.get(scope.name);
      if (!entry || !entry.isFunc || entry.file !== uri.fsPath) continue;
      const node = gtagsEntryToNode(scope.name, entry, scope, lines, '');
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }

    // エッジ抽出
    for (const scope of fileScopes) {
      const entry = tags.get(scope.name);
      if (!entry || !entry.isFunc || entry.file !== uri.fsPath) continue;

      const callerId = makeGtagsNodeId(uri.fsPath, scope.name, entry.line);
      const callees  = extractCallsFromLines(lines, scope.start, scope.end, knownTags, scope.name);

      for (const callee of callees) {
        const calleeEntry = tags.get(callee);
        if (!calleeEntry) continue;
        const calleeScope = scopeMap.get(calleeEntry.file)?.find(s => s.name === callee);
        if (!calleeScope) continue;

        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        if (!nodes.has(calleeId)) {
          const ll = readFileLinesCached(calleeEntry.file, lineCache);
          nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, ll, ''));
        }
        edgeSet.add(`${callerId}|||${calleeId}`);
      }
    }
  }

  const label = uniqueUris.length === 1
    ? path.basename(uniqueUris[0].fsPath)
    : `${uniqueUris.length} ファイル`;
  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: label, buildTimeMs: Date.now() - t0, errors: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 公開エントリーポイント  ─  backend 引数で LSP / gtags を切り替える
// ─────────────────────────────────────────────────────────────────────────────

export async function buildFileCallGraph(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend: Backend = 'auto'
): Promise<GraphData> {
  return (await resolveBackend(backend)) === 'gtags'
    ? buildFileCallGraphGtags(document, progress)
    : buildFileCallGraphLsp(document, progress);
}

export async function buildFunctionCallGraph(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend: Backend = 'auto'
): Promise<GraphData> {
  return (await resolveBackend(backend)) === 'gtags'
    ? buildFunctionCallGraphGtags(document, position, maxHops, progress)
    : buildFunctionCallGraphLsp(document, position, maxHops, progress);
}

export async function buildWorkspaceCallGraph(
  uris: vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend: Backend = 'auto'
): Promise<GraphData> {
  return (await resolveBackend(backend)) === 'gtags'
    ? buildWorkspaceCallGraphGtags(uris, progress)
    : buildWorkspaceCallGraphLsp(uris, progress);
}