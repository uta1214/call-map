/**
 * callGraphBuilder.ts
 *
 * 【修正履歴】
 *  - ワークスペース外 / ヘッダーファイルの除外
 *  - ワークスペースフォルダ未設定時のフォールバック
 *  - labelFull / labelShort 追加 (webview 側で引数表示切り替え用)
 *  - makeNodeId でベース名を使いIDを統一 (パラメータ名有無の揺れを吸収)
 *
 *  - 【今回修正】clangd "Canceled" エラーへの対処
 *    バッチ並列処理で clangd に同時リクエストが集中すると "Canceled" が返る。
 *    BATCH_SIZE を 4→2 に削減し同時リクエスト数を減らす。
 *    execWithRetry のリトライ回数を 3→6 回、待機時間を指数バックオフに変更。
 */

import * as vscode from 'vscode';
import * as path   from 'path';

export interface GraphNode {
  id:            string;
  label:         string;
  labelFull:     string;
  labelShort:    string;
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

// ★ clangd への同時リクエスト数を減らして Canceled を防ぐ
const BATCH_SIZE  = 2;
const BATCH_DELAY = 50;

// ヘッダー (.h .hpp .hxx) を除外: 宣言と定義の二重ノードを防ぐ
const CC_SOURCE_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']);

// ─────────────────────────────────────────────────────────────────────────────
// ワークスペースフィルタ
// ─────────────────────────────────────────────────────────────────────────────

function getWorkspaceRoots(fallbackUri?: vscode.Uri): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  if (folders.length === 0 && fallbackUri) {
    return [path.dirname(fallbackUri.fsPath)];
  }
  return folders;
}

function isInWorkspace(uri: vscode.Uri, roots: string[]): boolean {
  if (roots.length === 0) return true;
  const p = uri.fsPath;
  return roots.some(root => p === root || p.startsWith(root + path.sep) || p.startsWith(root + '/'));
}

function hasCppSourceExtension(uri: vscode.Uri): boolean {
  return CC_SOURCE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

function shouldIncludeCallee(uri: vscode.Uri, roots: string[]): boolean {
  return isInWorkspace(uri, roots) && hasCppSourceExtension(uri);
}

// ─────────────────────────────────────────────────────────────────────────────
// 名前正規化
// ─────────────────────────────────────────────────────────────────────────────

/** "func(T1, T2)" → "func" */
function baseNameOf(name: string): string {
  const idx = name.indexOf('(');
  return idx >= 0 ? name.slice(0, idx).trim() : name;
}

/**
 * ノードIDはベース名で作成する。
 * documentSymbolProvider と CallHierarchy でパラメータ名の有無が異なっても
 * 同じファイル + 同じ関数名 + 同じ行 → 同じID になる。
 */
function makeNodeId(uri: vscode.Uri, name: string, line: number): string {
  return `${uri.fsPath}||${baseNameOf(name)}||${line}`;
}

function makeNode(
  id: string, name: string, file: string, line: number,
  source: string, isCurrentFile: boolean
): GraphNode {
  const short = baseNameOf(name);
  return { id, label: short, labelFull: name, labelShort: short, file, line, source, isCurrentFile };
}

function maybeUpgradeLabelFull(nodes: Map<string, GraphNode>, id: string, fullName: string): void {
  if (!fullName.includes('(')) return;
  const node = nodes.get(id);
  if (!node) return;
  if (!node.labelFull.includes('(')) {
    node.labelFull = fullName;
    nodes.set(id, node);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

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

function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

/**
 * ★ 指数バックオフ付きリトライ。
 *   clangd が "Canceled" を返す場合は最大 MAX_RETRY 回まで再試行する。
 *   待機時間: 200ms → 400ms → 800ms → 1600ms → 3200ms
 */
const MAX_RETRY     = 6;
const RETRY_BASE_MS = 200;

async function execWithRetry<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  for (let i = 0; i < MAX_RETRY; i++) {
    try {
      return await vscode.commands.executeCommand<T>(command, ...args);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found')) throw err;               // コマンド自体が存在しない → 即リトライ不要
      if (msg.includes('Canceled')) {
        if (i < MAX_RETRY - 1) {
          await delay(RETRY_BASE_MS * Math.pow(2, i));        // 200, 400, 800, 1600, 3200 ms
          continue;
        }
      }
      throw err;
    }
  }
}

function splitEdges(edgeSet: Set<string>): GraphEdge[] {
  return Array.from(edgeSet).map(key => {
    const sep = key.indexOf('|||');
    return { from: key.slice(0, sep), to: key.slice(sep + 3) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ファイル単位
// ─────────────────────────────────────────────────────────────────────────────

export async function buildFileCallGraph(
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
    if (!nodes.has(id)) {
      nodes.set(id, makeNode(
        id, f.name, document.uri.fsPath,
        f.selectionRange.start.line + 1,
        sliceSource(currentLines, f.range.start.line, f.range.end.line),
        true
      ));
    }
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

        const callerId = makeNodeId(document.uri, func.name, func.selectionRange.start.line);
        maybeUpgradeLabelFull(nodes, callerId, items[0].name);

        const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls', items[0]);
        if (!outgoing?.length) return;

        for (const call of outgoing) {
          const { to } = call;
          const calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);

          if (!nodes.has(calleeId)) {
            if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
            const ll = await openLines(to.uri, cache);
            nodes.set(calleeId, makeNode(
              calleeId, to.name, to.uri.fsPath,
              to.selectionRange.start.line + 1,
              sliceSource(ll, to.range.start.line, to.range.end.line),
              false
            ));
          } else {
            maybeUpgradeLabelFull(nodes, calleeId, to.name);
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

// ─────────────────────────────────────────────────────────────────────────────
// 関数起点 BFS
// ─────────────────────────────────────────────────────────────────────────────

export async function buildFunctionCallGraph(
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
      nodes.set(nodeId, makeNode(
        nodeId, item.name, item.uri.fsPath,
        item.selectionRange.start.line + 1,
        sliceSource(ll, item.range.start.line, item.range.end.line),
        item.uri.fsPath === document.uri.fsPath
      ));
    }
    if (hop >= maxHops) continue;
    progress?.report({ message: `BFS 展開中... (ノード: ${nodes.size})` });

    try {
      const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls', item);
      if (!outgoing?.length) continue;
      for (const call of outgoing) {
        if (!shouldIncludeCallee(call.to.uri, wsRoots)) continue;
        const calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
        if (nodes.has(calleeId)) {
          maybeUpgradeLabelFull(nodes, calleeId, call.to.name);
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

// ─────────────────────────────────────────────────────────────────────────────
// ワークスペース横断
// ─────────────────────────────────────────────────────────────────────────────

export async function buildWorkspaceCallGraph(
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
      if (!nodes.has(id)) nodes.set(id, makeNode(
        id, f.name, uri.fsPath,
        f.selectionRange.start.line + 1,
        sliceSource(lines, f.range.start.line, f.range.end.line),
        false
      ));
    }

    for (let i = 0; i < functions.length; i += BATCH_SIZE) {
      await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async (func) => {
        try {
          const items = await execWithRetry<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy', uri, func.selectionRange.start);
          if (!items?.length) return;

          const callerId = makeNodeId(uri, func.name, func.selectionRange.start.line);
          maybeUpgradeLabelFull(nodes, callerId, items[0].name);

          const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls', items[0]);
          if (!outgoing?.length) return;

          for (const call of outgoing) {
            const { to } = call;
            const calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);

            if (!nodes.has(calleeId)) {
              if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
              const ll = await openLines(to.uri, cache);
              nodes.set(calleeId, makeNode(
                calleeId, to.name, to.uri.fsPath,
                to.selectionRange.start.line + 1,
                sliceSource(ll, to.range.start.line, to.range.end.line),
                false
              ));
            } else {
              maybeUpgradeLabelFull(nodes, calleeId, to.name);
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