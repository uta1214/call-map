/**
 * utils.ts  ─  共有ユーティリティ
 *
 * 依存関係: types.ts, cacheManager.ts, vscode, path, fs
 * このファイルはビジネスロジック（BFS・ビルド処理）を持たない。
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { GraphNode, GraphEdge, GtagEntry, ScopeEntry, ScopeMapEntry } from './types';
import { cache } from './cacheManager';

// ─────────────────────────────────────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────────────────────────────────────

/** ファイル+baseName → nodeId の O(1) ルックアップインデックス */
export type NodeIndex = Map<string, string>;

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

export const CC_SOURCE_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']);
export const CC_CALLEE_EXTENSIONS  = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.c++',
  '.h', '.hh', '.hpp', '.hxx', '.h++',
  '.inl', '.ipp', '.tpp', '.tcc',
]);

export const BATCH_SIZE           = 6;
export const BATCH_DELAY_INIT     = 20;
export const MAX_RETRY            = 4;
export const RETRY_BASE_MS        = 200;
export const CANCELED_RETRY_DELAY = 3000;

// ─────────────────────────────────────────────────────────────────────────────
// 汎用ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeFsPath(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function splitEdges(edgeSet: Set<string>): GraphEdge[] {
  return Array.from(edgeSet).map(key => {
    const sep = key.indexOf('|||');
    return { from: key.slice(0, sep), to: key.slice(sep + 3) };
  });
}

export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h.toString(16).padStart(8, '0');
}

export function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function nextAdaptiveDelay(
  current:  number,
  hadError: boolean,
  streak:   { val: number },
): number {
  if (hadError) { streak.val = 0; return Math.min(current + 50, 500); }
  streak.val++;
  if (streak.val >= 3) { streak.val = 0; return Math.max(0, Math.floor(current / 2)); }
  return current;
}

export function checkCancellation(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}

export function isCanceledByClangd(err: unknown): boolean {
  return !(err instanceof vscode.CancellationError) && String(err).includes('Canceled');
}

export async function execWithRetry<T>(
  command: string,
  token:   vscode.CancellationToken | undefined,
  ...args: unknown[]
): Promise<T | undefined> {
  for (let i = 0; i < MAX_RETRY; i++) {
    checkCancellation(token);
    try {
      return await vscode.commands.executeCommand<T>(command, ...args);
    } catch (err) {
      if (err instanceof vscode.CancellationError) throw err;
      if (String(err).includes('not found')) throw err;
      if (i < MAX_RETRY - 1) { await delay(RETRY_BASE_MS * Math.pow(2, i)); continue; }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ワークスペースルート
// ─────────────────────────────────────────────────────────────────────────────

export function getWorkspaceRoots(fallbackUri?: vscode.Uri): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  if (folders.length === 0 && fallbackUri) return [path.dirname(fallbackUri.fsPath)];
  return folders;
}

export function getWorkspaceRootForFile(fileUri: vscode.Uri): string | undefined {
  const filePath = normalizeFsPath(fileUri.fsPath);
  const folders  = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = normalizeFsPath(folder.uri.fsPath);
    if (filePath === root || filePath.startsWith(root + path.sep) || filePath.startsWith(root + '/'))
      return folder.uri.fsPath;
  }
  return folders[0]?.uri.fsPath ?? path.dirname(fileUri.fsPath);
}

export function hasCppSourceExtension(uri: vscode.Uri): boolean {
  return CC_SOURCE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// スコープ検索 (WeakMap キャッシュ付き O(1) 大文字小文字無視)
// ─────────────────────────────────────────────────────────────────────────────

const lowerScopeIndexCache = new WeakMap<
  Map<string, ScopeMapEntry>,
  Map<string, ScopeMapEntry>
>();

function getLowerScopeIndex(scopeMap: Map<string, ScopeMapEntry>): Map<string, ScopeMapEntry> {
  const cached = lowerScopeIndexCache.get(scopeMap);
  if (cached) return cached;
  const lower = new Map<string, ScopeMapEntry>();
  for (const [k, v] of scopeMap) {
    const lk = normalizeFsPath(k).toLowerCase();
    if (!lower.has(lk)) lower.set(lk, v);
  }
  lowerScopeIndexCache.set(scopeMap, lower);
  return lower;
}

export function findScopeMapEntry(
  scopeMap: Map<string, ScopeMapEntry>,
  filePath: string,
): ScopeMapEntry | undefined {
  let entry = scopeMap.get(filePath);
  if (entry) return entry;
  const norm = normalizeFsPath(filePath);
  entry = scopeMap.get(norm);
  if (entry) return entry;
  if (process.platform !== 'linux') {
    entry = getLowerScopeIndex(scopeMap).get(norm.toLowerCase());
    if (entry) return entry;
  }
  try {
    const real = cache.getRealpath(filePath) ?? (() => {
      const r = fs.realpathSync(filePath); cache.setRealpath(filePath, r); return r;
    })();
    entry = scopeMap.get(real);
    if (entry) return entry;
    const realNorm = normalizeFsPath(real);
    for (const [k, v] of scopeMap) {
      if (normalizeFsPath(k) === realNorm) return v;
    }
  } catch { /* ファイル不存在は無視 */ }
  return undefined;
}

export function findScopeAtLine(list: ScopeEntry[], refLine: number): ScopeEntry | undefined {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s   = list[mid];
    if      (refLine < s.start) hi = mid - 1;
    else if (refLine > s.end)   lo = mid + 1;
    else                        return s;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP ノード操作ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

export function makeNodeId(uri: vscode.Uri, name: string, line: number): string {
  return `${uri.fsPath}\x00${name}\x00${line}`;
}

export function baseNameOf(name: string): string {
  // clangd の CallHierarchyItem.name は "Ns::Class::method(int, float)" の形で返ることがある。
  // まず "(" より前の部分だけ取り出してから :: を処理することで
  // 引数部分がラベルに混入するのを防ぐ。
  const parenIdx = name.indexOf('(');
  const base     = parenIdx >= 0 ? name.slice(0, parenIdx) : name;
  const colonIdx = base.lastIndexOf('::');
  return colonIdx >= 0 ? base.slice(colonIdx + 2) : base;
}

export function addToNodeIndex(index: NodeIndex, id: string, node: GraphNode): void {
  const key = `${node.file}\x00${node.label}`;
  if (!index.has(key)) index.set(key, id);
}

export function findExistingCalleeId(
  nodes: ReadonlyMap<string, GraphNode>,
  index: ReadonlyMap<string, string>,
  to:    vscode.CallHierarchyItem,
): string | null {
  const exactId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
  if (nodes.has(exactId)) return exactId;
  const base    = baseNameOf(to.name);
  const indexed = index.get(`${to.uri.fsPath}\x00${base}`);
  if (indexed) return indexed;
  const ext = path.extname(to.uri.fsPath).toLowerCase();
  if (['.h', '.hpp', '.hxx'].includes(ext)) {
    for (const [id, node] of nodes) {
      if (node.label === base || baseNameOf(node.label) === base) return id;
    }
  }
  return null;
}

export function isInWorkspace(uri: vscode.Uri, roots: string[]): boolean {
  const fp = uri.fsPath;
  return roots.some(r => fp === r || fp.startsWith(r + '/') || fp.startsWith(r + path.sep));
}

export function shouldIncludeCallee(uri: vscode.Uri, roots: string[]): boolean {
  return isInWorkspace(uri, roots)
    && CC_CALLEE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

export function flattenFunctions(syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
  ]);
  const seen = new Set<string>(); const result: vscode.DocumentSymbol[] = [];
  function walk(arr: vscode.DocumentSymbol[]) {
    for (const s of arr) {
      if (KINDS.has(s.kind)) {
        const key = `${s.selectionRange.start.line}:${baseNameOf(s.name)}`;
        if (!seen.has(key)) { seen.add(key); result.push(s); }
      }
      if (s.children?.length) walk(s.children);
    }
  }
  walk(syms); return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pct — 進捗ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

export class Pct {
  private cur = 0;
  constructor(private readonly p?: vscode.Progress<{ message?: string; increment?: number }>) {}

  private safeReport(msg: { message?: string; increment?: number }): void {
    if (this.p !== undefined && this.p !== null && typeof (this.p as any).report === 'function') {
      (this.p as vscode.Progress<{ message?: string; increment?: number }>).report(msg);
    }
  }

  to(val: number): void {
    const v = Math.min(100, Math.max(0, Math.round(val)));
    const d = v - this.cur;
    if (d > 0) {
      this.safeReport({ message: `${v}%`, increment: d });
      this.cur = v;
    }
  }
  range(start: number, end: number, pos: number, total: number): void {
    this.to(start + (end - start) * pos / Math.max(1, total));
  }
  bfsQ(start: number, end: number, touched: { size: number }, pending: { length: number }): void {
    const total = touched.size;
    const done  = Math.max(0, total - pending.length);
    this.to(total === 0 ? end : start + (end - start) * done / total);
  }
  report(message: string): void {
    this.safeReport({ message, increment: 0 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags ヘルパー (pure / ほぼ純粋)
// ─────────────────────────────────────────────────────────────────────────────

export function isLikelyFuncDef(line: string): boolean {
  const s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith('}')) return false;
  if (s.includes('typedef') || !s.includes('(') || s.endsWith(';')) return false;
  if (/=\s*(0|delete|default)\s*[;,]?\s*$/.test(s)) return false;
  return true;
}

export function makeGtagsNodeId(file: string, name: string, line: number): string {
  return `${file}\x00${name}\x00${line}`;
}

export function parseGtagsNodeId(nodeId: string): { file: string; name: string; line: number } {
  const [file, name, lineStr] = nodeId.split('\x00');
  return { file, name, line: parseInt(lineStr, 10) };
}

export function escapeRegexForGlobal(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}