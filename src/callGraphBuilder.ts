/**
 * callGraphBuilder.ts  ─  公開エントリーポイント
 *
 * LSP / gtags バックエンドを backend 引数で切り替えてグラフを構築する。
 * キャッシュ管理・バックエンド解決のみ担当し、BFS ロジックは各バックエンドに委譲する。
 */

import * as vscode   from 'vscode';
import * as path     from 'path';
import { cache }     from './cacheManager';
import {
  buildFileCallGraphLsp,
  buildFunctionCallGraphLsp,
  buildWorkspaceCallGraphLsp,
  buildPathThroughCallGraphLsp,
} from './lspBackend';
import {
  buildFileCallGraphGtags,
  buildFunctionCallGraphGtags,
  buildWorkspaceCallGraphGtags,
  buildPathThroughCallGraphGtags,
  gtagsAvailable,
  collectGtagsCached,
} from './gtagsBackend';
import {
  fnv1a32,
  getWorkspaceRootForFile, hasCppSourceExtension,
} from './utils';

// Re-export for extension.ts backward compatibility
export type { Backend } from './types';
export type { GraphData } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

function makeCacheKey(type: string, ...parts: string[]): string {
  return [type, ...parts].join('\x00');
}

async function resolveBackend(
  backend: import('./types').Backend,
): Promise<'lsp' | 'gtags'> {
  if (backend === 'gtags') return 'gtags';
  if (backend === 'lsp')   return 'lsp';
  return (await gtagsAvailable()) ? 'gtags' : 'lsp';
}

// ─────────────────────────────────────────────────────────────────────────────
// 公開 API
// ─────────────────────────────────────────────────────────────────────────────

export async function buildFileCallGraph(
  document: vscode.TextDocument,
  backend:  import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved = await resolveBackend(backend);
  const key      = makeCacheKey('file', document.uri.fsPath, resolved);
  const cached   = cache.getGraph(key);
  if (cached) return cached;
  const result   = resolved === 'gtags'
    ? await buildFileCallGraphGtags(document, progress, token)
    : await buildFileCallGraphLsp(document, progress, token);
  cache.setGraph(key, result);
  return result;
}

export async function buildFunctionCallGraph(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxHops:  number,
  backend:  import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved = await resolveBackend(backend);
  const key      = makeCacheKey('func', document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`);
  const cached = cache.getGraph(key);
  if (cached) return cached;
  const result = resolved === 'gtags'
    ? await buildFunctionCallGraphGtags(document, position, maxHops, progress, token)
    : await buildFunctionCallGraphLsp(document, position, maxHops, progress, token);
  cache.setGraph(key, result);
  return result;
}

export async function buildWorkspaceCallGraph(
  uris:      vscode.Uri[],
  backend:   import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved   = await resolveBackend(backend);

  // ① uniqueUris の計算と空チェックをキャッシュキー生成より前に行う。
  // uris[0] が undefined のままキャッシュキーを作ると無効なキーでキャッシュが汚染される。
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => hasCppSourceExtension(u));
  if (!uniqueUris.length) throw new Error('No C/C++ source files found.');

  const sorted    = uniqueUris.map(u => u.fsPath).sort();
  const pathsHash = fnv1a32(sorted.join('\x00'));
  // ⑧ wsRootKey を sorted（重複排除済み）から導出することでキー順序依存を排除する。
  const wsRootKey = Array.from(new Set(
    sorted.map(p => getWorkspaceRootForFile(vscode.Uri.file(p)) ?? path.dirname(p))
  )).sort().join('\x01');
  const key       = makeCacheKey('workspace', wsRootKey, String(sorted.length), pathsHash, resolved);
  const cached    = cache.getGraph(key);
  if (cached) return cached;
  const result    = resolved === 'gtags'
    ? await buildWorkspaceCallGraphGtags(uniqueUris, progress, token)
    : await buildWorkspaceCallGraphLsp(uniqueUris, progress, token);
  cache.setGraph(key, result);
  return result;
}

export async function buildPathThroughCallGraph(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxHops:  number,
  backend:  import('./types').Backend,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken,
): Promise<import('./types').GraphData> {
  const resolved = await resolveBackend(backend);
  const key      = makeCacheKey('path', document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`);
  const cached = cache.getGraph(key);
  if (cached) return cached;
  const result = resolved === 'gtags'
    ? await buildPathThroughCallGraphGtags(document, position, maxHops, progress, token)
    : await buildPathThroughCallGraphLsp(document, position, maxHops, progress, token);
  cache.setGraph(key, result);
  return result;
}

export async function warmupCache(
  document: vscode.TextDocument,
  backend:  import('./types').Backend,
): Promise<void> {
  const resolved = await resolveBackend(backend);
  if (resolved !== 'gtags') return;
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) return;
  await collectGtagsCached(wsRoot).catch(() => {/* warmup は失敗してもよい */});
}