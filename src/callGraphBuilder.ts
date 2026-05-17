/**
 * callGraphBuilder.ts  ─  LSP + gtags デュアルバックエンド
 *
 * 【修正履歴 (main ← gtags マージ)】省略 (以前のコメント参照)
 *
 * 【Bug A】buildGtagsScopeMap: isFunc=true のみでスコープを区切る。
 * 【Bug B】buildGtagsScopeMap: byName Map で O(1) ルックアップ。
 * 【Bug C】ensureGtagsDb: global -u でインクリメンタル更新。
 * 【Precision D】extractCallsFromLines: 文字列リテラル内誤検出を除去。
 * 【Precision E】isLikelyFuncDef: = 0 / = delete / = default を除外。
 *
 * 【BugFix F】ensureGtagsDb: global -u 失敗時に例外を飲み込んで古いタグで続行。
 *   GPATH 欠損・フォーマット非互換・パーミッション不足などで落ちていた問題を修正。
 *
 * 【BugFix G】buildFunctionCallGraphGtags BFS: callee を visited に先行登録して
 *   重複プッシュを防止。同一 callee が複数の親から参照されるとキューが肥大化していた。
 *
 * 【Security H】runGlobalF / buildEdgesGlobalRx: GTAGS 改ざんによる
 *   ワークスペース外ファイルアクセス (path traversal) を防止。
 *   sanitizeToWsRoot() で wsRoot 外のパスを無視する。
 *
 * 【Precision ①】buildEdgesGlobalRx: global -rx -e 'func1|func2|...' を
 *   100 関数ずつバッチ処理してエッジを構築。
 *   ソーステキストの正規表現スキャンではなく GNU Global のシンボル DB を使うため
 *   コメント・文字列リテラル・マクロ名との誤混同がなくなり false positive が大幅減。
 *   buildFileCallGraphGtags / buildWorkspaceCallGraphGtags で採用。
 *   buildFunctionCallGraphGtags (BFS) は extractCallsFromLines を維持
 *   (BFS は局所的なため source scan が効率的)。
 *   NOTE: global -rx の -e フラグ (POSIX 拡張正規表現) は GNU Global 5.0 以降が必要。
 *
 * 【Precision ②】collectGtags の戻り値を Map<name, GtagEntry[]> に変更。
 *   同名の static 関数が複数ファイルに存在する場合でも全候補を保持し、
 *   resolveCallee() が callerFile と同ファイルの定義を優先して返す。
 *
 * 【Precision ③】CC_ALL_GLOB でヘッダー (.h/.hpp/.hxx) も tag 収集対象に追加。
 *   ヘッダー定義の inline 関数・テンプレート関数が callee ノードとして登録される。
 *   ヘッダーは caller スキャン対象外 (CC_SOURCE_EXTENSIONS フィルタは維持)。
 */

import * as vscode   from 'vscode';
import * as path     from 'path';
import * as fs       from 'fs';
import { execFile }  from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// 型定義 (公開インターフェース)
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id:            string;
  label:         string;   // 表示用 (短縮名 = 引数なし関数名)
  labelFull:     string;   // フルシグネチャ (引数あり・ソースパネル用)
  file:          string;
  line:          number;
  scopeEnd?:     number;   // ⑥ 遅延読み込み用スコープ終端行 (1-indexed)
  source?:       string;   // ⑥ optional: スタンドアロン HTML 生成時のみ設定
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

/** 解析バックエンドの種別 */
export type Backend = 'lsp' | 'gtags' | 'auto';

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

// ① LSP adaptive batch: Canceled 発生率に応じて遅延を動的調整
const BATCH_SIZE       = 6;    // 2 → 6: clangd の同時処理能力を活かす
const BATCH_DELAY_INIT = 20;   // 初期遅延 ms
const BATCH_DELAY_MIN  = 0;    // 最小遅延 ms
const BATCH_DELAY_MAX  = 150;  // Canceled 急増時の上限 ms

// ② LSP ワークスペース: ファイルレベル並列処理数
const WORKSPACE_FILE_CONCURRENCY = 6;

// caller としてスキャンするソース拡張子 (ヘッダー除外)
const CC_SOURCE_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']);

// findFiles 用グロブ (extension.ts でも共有)
const CC_SOURCE_GLOB      = '**/*.{c,cpp,cc,cxx,cu,cuh}';
// Precision ③: ヘッダーを callee ノードとして収集するための広域グロブ
const CC_ALL_GLOB         = '**/*.{c,cpp,cc,cxx,cu,cuh,h,hpp,hxx}';
export const EXCLUDE_GLOB = '{**/node_modules/**,**/build/**,**/dist/**,**/out/**,**/.git/**}';

// ④ global -rx 並列バッチ設定
const GLOBAL_RX_BATCH    = 100;  // 1プロセスあたりの関数名上限
const GLOBAL_RX_PARALLEL = 4;    // 同時実行バッチ数

// ⑤ GTAGS 更新 TTL: この時間内の再実行は global -u をスキップ
const GTAGS_UPDATE_TTL = 30_000; // ms

// ─────────────────────────────────────────────────────────────────────────────
// モジュールレベル状態
// ─────────────────────────────────────────────────────────────────────────────

// ⑤ wsRoot → 最終 ensureGtagsDb 実行時刻
const gtagsUpdateCache = new Map<string, number>();

// ⑦ GraphData インメモリキャッシュ (上限付き LRU + TTL)
const MAX_CACHE_ENTRIES = 20;
const CACHE_TTL_MS      = 5 * 60_000; // 5 分: TTL 超過エントリは再ビルドする
interface GraphCacheEntry { data: GraphData; timestamp: number; }
const graphDataCache = new Map<string, GraphCacheEntry>();

/** ⑦ 上限付きキャッシュ書き込み: 上限超過時は最古エントリを削除 */
function setGraphCache(key: string, entry: GraphCacheEntry): void {
  if (graphDataCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey = '';
    let oldestTs  = Infinity;
    for (const [k, v] of graphDataCache) {
      if (v.timestamp < oldestTs) { oldestTs = v.timestamp; oldestKey = k; }
    }
    if (oldestKey) graphDataCache.delete(oldestKey);
  }
  graphDataCache.set(key, entry);
}

/**
 * ⑦ キャッシュを無効化する。
 * filePath を指定すると、そのファイルを含むキャッシュエントリのみ削除。
 * 省略するとすべて削除 (拡張機能の deactivate 時など)。
 * extension.ts の FileSystemWatcher から呼ばれる。
 */
export function invalidateCache(filePath?: string): void {
  if (!filePath) { graphDataCache.clear(); return; }
  // パス正規化して比較（Fix 5）
  const norm = normalizeFsPath(filePath);
  for (const key of graphDataCache.keys()) {
    if (key.includes(norm) || key.includes(filePath)) graphDataCache.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// パスユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ファイルパスを正規化する。
 * Windows: バックスラッシュをスラッシュに統一 + 小文字化
 * macOS/Linux: path.normalize のみ
 * Fix 2: scopeMap / lineCache のキー比較に使用し、パス差異による不一致を防ぐ。
 */
function normalizeFsPath(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * scopeMap からファイルパスでエントリを検索する。
 * Fix 2: 完全一致 → 正規化一致 → 大文字小文字無視 → realpath の順でフォールバック。
 * シンボリックリンク・macOS の大文字小文字無視 FS・Windows パス区切り差異に対応する。
 */
function findScopeMapEntry(
  scopeMap: Map<string, ScopeMapEntry>, filePath: string
): ScopeMapEntry | undefined {
  // 1. 完全一致 (最速)
  let entry = scopeMap.get(filePath);
  if (entry) return entry;

  // 2. 正規化後一致
  const norm = normalizeFsPath(filePath);
  entry = scopeMap.get(norm);
  if (entry) return entry;

  // 3. 大文字小文字無視 (macOS / Windows)
  if (process.platform !== 'linux') {
    const lower = norm.toLowerCase();
    for (const [k, v] of scopeMap) {
      if (normalizeFsPath(k).toLowerCase() === lower) return v;
    }
  }

  // 4. realpath でシンボリックリンクを解決
  try {
    const real = fs.realpathSync(filePath);
    entry = scopeMap.get(real);
    if (entry) return entry;
    const realNorm = normalizeFsPath(real);
    for (const [k, v] of scopeMap) {
      if (normalizeFsPath(k) === realNorm) return v;
    }
  } catch { /* ファイルが存在しない場合は無視 */ }

  return undefined;
}

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

/**
 * 進捗バーをパーセント表示で制御するヘルパー。
 * - to(v)         : 絶対値で指定（後退しない）
 * - range(...)    : [start, end] 内で pos/total を線形補間
 * - bfsQ(...)     : BFS キュー近似（touched = 積んだ全 ID の Set）
 */
class Pct {
  private cur = 0;
  constructor(
    private readonly p?: vscode.Progress<{ message?: string; increment?: number }>
  ) {}

  to(val: number): void {
    const v     = Math.min(100, Math.max(0, Math.round(val)));
    const delta = v - this.cur;
    if (delta > 0) { this.p?.report({ message: `${v}%`, increment: delta }); this.cur = v; }
  }

  range(start: number, end: number, pos: number, total: number): void {
    this.to(start + (end - start) * pos / Math.max(1, total));
  }

  /** touched.size - pending.length ≈ 処理済み件数 */
  bfsQ(start: number, end: number, touched: { size: number }, pending: unknown[]): void {
    const total = touched.size;
    const done  = Math.max(0, total - pending.length);
    this.to(total === 0 ? end : start + (end - start) * done / total);
  }
}

function getWorkspaceRoot(fallbackUri?: vscode.Uri): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? (fallbackUri ? path.dirname(fallbackUri.fsPath) : undefined);
}

function getWorkspaceRoots(fallbackUri?: vscode.Uri): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  if (folders.length === 0 && fallbackUri) return [path.dirname(fallbackUri.fsPath)];
  return folders;
}

/**
 * Feat②: マルチルートワークスペース対応。
 * fileUri が属するワークスペースフォルダを返す。
 * どのフォルダにも属さない場合はフォールバック順で返す:
 *   1. workspaceFolders[0] (GTAGS が最初のルートにある想定)
 *   2. fileUri の親ディレクトリ
 */
function getWorkspaceRootForFile(fileUri: vscode.Uri): string | undefined {
  const filePath = fileUri.fsPath;
  const folders  = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (filePath === root
      || filePath.startsWith(root + path.sep)
      || filePath.startsWith(root + '/')) {
      return root;
    }
  }
  // どのフォルダにも属さない場合: 最初のフォルダか親ディレクトリ
  return folders[0]?.uri.fsPath ?? path.dirname(filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// バックエンド解決
// ─────────────────────────────────────────────────────────────────────────────

async function gtagsAvailable(): Promise<boolean> {
  try { await execFileAsync('gtags', ['--version']); return true; }
  catch { return false; }
}

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

/**
 * ★ 修正: baseNameOf() でノード名を正規化する。
 *
 * clangd は同じ関数に対して
 *   - DocumentSymbolProvider → "add(int a, int b)"  (仮引数名あり)
 *   - provideOutgoingCalls   → "add(int, int)"      (仮引数名なし)
 * と異なる文字列を返すことがある。
 * ノード ID にそのまま使うと同一関数が 2 ノード生成されてしまうため、
 * 両者とも baseName ("add") に正規化してから ID を生成することで一意性を保証する。
 */
function makeNodeId(uri: vscode.Uri, name: string, line: number): string {
  return `${uri.fsPath}||${baseNameOf(name)}||${line}`;
}

/** "func(T1, T2)" → "func" */
function baseNameOf(name: string): string {
  const idx = name.indexOf('(');
  return idx >= 0 ? name.slice(0, idx).trim() : name;
}

/**
 * callee のノード ID を既存マップから探す。
 * 正規化後は完全一致が大部分を占めるが、ヘッダー経由など
 * 行番号が異なるケースに備えてファジーマッチを残す。
 */
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

/**
 * ★ 修正: 重複排除キーを `line` 単体から `${line}:${baseName}` に変更。
 * 同一行に異なる名前のシンボルが来るケース (マクロ展開等) での誤脱落を防止。
 */
function flattenFunctions(syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
  const seen  = new Set<string>();
  const result: vscode.DocumentSymbol[] = [];
  function walk(arr: vscode.DocumentSymbol[]) {
    for (const s of arr) {
      if (KINDS.has(s.kind)) {
        const key = `${s.selectionRange.start.line}:${baseNameOf(s.name)}`;
        if (!seen.has(key)) { seen.add(key); result.push(s); }
      }
      if (s.children?.length) walk(s.children);
    }
  }
  walk(syms);
  return result;
}

/**
 * ソースパネルに表示する行数の上限。
 * - gtagsEntryToNode の scopeEnd フォールバック計算に使用
 * - webviewPanel.ts の requestSource ハンドラと値を共有する (Bug③ 修正)
 */
export const MAX_SOURCE_LINES = 200;

/**
 * ★ キャンセルチェックヘルパー
 * CancellationToken がセットされていてキャンセル済みなら CancellationError を投げる。
 */
function checkCancellation(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}

/**
 * ★ 指数バックオフ付きリトライ + キャンセル対応
 *   各リトライの前に token を確認し、キャンセル済みなら即座に CancellationError を投げる。
 *   待機時間: 200ms → 400ms → 800ms → 1600ms → 3200ms
 */
const MAX_RETRY     = 6;
const RETRY_BASE_MS = 200;

async function execWithRetry<T>(
  command: string,
  token:   vscode.CancellationToken | undefined,
  ...args: unknown[]
): Promise<T | undefined> {
  for (let i = 0; i < MAX_RETRY; i++) {
    checkCancellation(token);
    try {
      return await vscode.commands.executeCommand<T>(command, ...args);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found')) throw err; // コマンド自体が存在しない → 即終了
      // ★ Fix: Canceled に加え、LSP 過負荷による一時エラーも全てリトライ
      //   "not found" 以外のあらゆるエラーを最大 MAX_RETRY 回まで指数バックオフでリトライ。
      //   これにより Workspace/Folder モードの並列 LSP 呼び出しで発生する
      //   一時的失敗 (non-Canceled エラー) を救済する。
      if (i < MAX_RETRY - 1) {
        await delay(RETRY_BASE_MS * Math.pow(2, i)); // 200, 400, 800, 1600, 3200 ms
        continue;
      }
      throw err; // MAX_RETRY 回試しても失敗したら諦める
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP バックエンド  ─  実装
// ─────────────────────────────────────────────────────────────────────────────

async function buildFileCallGraphLsp(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct     = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  const rawSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', document.uri
  );
  if (!rawSyms?.length) throw new Error(
    'No symbols found.\n\n[Checklist]\n' +
    '  1. Is clangd or C/C++ extension enabled?\n' +
    '  2. Has the index finished building?\n' +
    '  3. (clangd) Does compile_commands.json exist?'
  );

  const functions = flattenFunctions(rawSyms);
  if (!functions.length) throw new Error('No function symbols found in this file.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // 現在ファイルの関数ノードを事前登録
  for (const f of functions) {
    const id = makeNodeId(document.uri, f.name, f.selectionRange.start.line);
    nodes.set(id, {
      id,
      label:         baseNameOf(f.name),
      labelFull:     f.name,
      file:          document.uri.fsPath,
      line:          f.selectionRange.start.line + 1,
      scopeEnd:      f.range.end.line + 1, // ⑥ lazy source 用
      isCurrentFile: true,
    });
  }

  // ── 下方向 BFS (callee) ──────────────────────────────────────────────────
  // コアノード（ファイル内関数）を起点に provideOutgoingCalls で再帰展開。
  // 深さ制限なし（downVisited でサイクル防止）。
  // BATCH_SIZE 個ずつ並列処理し、① adaptive delay でクラッシュ抑制を維持。
  //
  // ★ Fix 1: prepareCallHierarchy の初期化も BATCH_SIZE 並列化。
  //   取得した CallHierarchyItem を coreItemsMap に保存し、
  //   上方向 BFS 初期化で再利用することで重複呼び出しをゼロにする。
  pct.to(5);
  {
    type DownQ = [vscode.CallHierarchyItem, string]; // [item, callerNodeId]
    const downVisited = new Set<string>();
    const downQueue:   DownQ[] = [];
    let   adaptiveDelay = BATCH_DELAY_INIT;

    // ★ Fix 1: coreItemsMap — 上方向 BFS 初期化で prepareCallHierarchy を再呼び出しせず再利用する
    const coreItemsMap = new Map<string, vscode.CallHierarchyItem>(); // coreId → item

    // ★ Fix 1: prepareCallHierarchy を BATCH_SIZE 個ずつ並列化（シリアル → バッチ並列）
    for (let i = 0; i < functions.length; i += BATCH_SIZE) {
      checkCancellation(token);
      await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async f => {
        const coreId = makeNodeId(document.uri, f.name, f.selectionRange.start.line);
        try {
          const items = await execWithRetry<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy', token, document.uri, f.selectionRange.start);
          if (!items?.length) return;
          coreItemsMap.set(coreId, items[0]); // ★ 上方向 BFS 用に保存
          downQueue.push([items[0], coreId]);
          downVisited.add(coreId);
        } catch (err) {
          if (err instanceof vscode.CancellationError) throw err;
          errs.push(`(callee-prep) ${f.name}: ${String(err)}`);
        }
      }));
      pct.range(5, 20, Math.min(i + BATCH_SIZE, functions.length), functions.length);
    }

    while (downQueue.length > 0) {
      checkCancellation(token);
      const batch          = downQueue.splice(0, BATCH_SIZE);
      const processingIds  = new Set<string>();
      let   errorsInBatch  = 0;

      await Promise.all(batch.map(async ([callerItem, callerId]) => {
        try {
          const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls', token, callerItem);
          if (!outgoing?.length) return;

          for (const call of outgoing) {
            const { to } = call;
            let calleeId = findExistingCalleeId(nodes, to);
            if (!calleeId) {
              if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
              calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
              if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                processingIds.add(calleeId);
                nodes.set(calleeId, {
                  id:            calleeId,
                  label:         baseNameOf(to.name),
                  labelFull:     to.name,
                  file:          to.uri.fsPath,
                  line:          to.selectionRange.start.line + 1,
                  scopeEnd:      to.range.end.line + 1,
                  isCurrentFile: to.uri.fsPath === document.uri.fsPath,
                });
              }
            }
            edgeSet.add(`${callerId}|||${calleeId}`);

            // 未 visited なら再帰展開のためキューに追加
            if (!downVisited.has(calleeId)) {
              downVisited.add(calleeId);
              downQueue.push([to, calleeId]);
            }
          }
        } catch (err) {
          if (err instanceof vscode.CancellationError) throw err;
          errorsInBatch++;
          errs.push(`${callerItem.name}: ${String(err)}`);
        }
      }));

      // ① adaptive delay
      if (errorsInBatch > 0) {
        adaptiveDelay = Math.min(Math.round(adaptiveDelay * 1.5) + 10, BATCH_DELAY_MAX);
      } else {
        adaptiveDelay = Math.max(Math.round(adaptiveDelay * 0.85) - 2, BATCH_DELAY_MIN);
      }
      pct.bfsQ(20, 55, downVisited, downQueue);
      if (adaptiveDelay > 0 && downQueue.length > 0) await delay(adaptiveDelay);
    }

  // ── 上方向 BFS (caller) ──────────────────────────────────────────────────
  // ファイル内の全コア関数を起点に provideIncomingCalls で呼び出し元を遡る。
  // 深さ制限なし（visited でサイクル防止）。main() などルート関数まで到達したら終了。
  //
  // ★ Fix 1: prepareCallHierarchy の重複呼び出しを排除。
  //   下方向 BFS で保存した coreItemsMap を再利用し、呼び出し回数を N → 0 に削減。
  //   ループも BATCH_SIZE 個ずつ並列化し、adaptive delay を適用する。
  pct.to(55);
  {
    type UpQ = [vscode.CallHierarchyItem, string]; // [item, calleeNodeId]
    const upVisited = new Set<string>();
    const upQueue:   UpQ[] = [];

    // ★ Fix 1: coreItemsMap を再利用 (prepareCallHierarchy 呼び出しゼロ)
    for (const [coreId, item] of coreItemsMap) {
      upQueue.push([item, coreId]);
      upVisited.add(coreId); // コアノード自身は処理済みとしてマーク
    }

    let upAdaptiveDelay = BATCH_DELAY_INIT;

    // ★ Fix 1: シリアルループ → BATCH_SIZE 並列バッチ + adaptive delay
    while (upQueue.length > 0) {
      checkCancellation(token);
      const batch         = upQueue.splice(0, BATCH_SIZE);
      let   errorsInBatch = 0;

      await Promise.all(batch.map(async ([calleeItem, calleeId]) => {
        try {
          const incoming = await execWithRetry<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls', token, calleeItem);
          if (!incoming?.length) return;

          for (const call of incoming) {
            let callerId = findExistingCalleeId(nodes, call.from);
            if (!callerId) {
              if (!isInWorkspace(call.from.uri, wsRoots)) continue;
              callerId = makeNodeId(call.from.uri, call.from.name, call.from.selectionRange.start.line);
            }
            if (!nodes.has(callerId)) {
              nodes.set(callerId, {
                id:            callerId,
                label:         baseNameOf(call.from.name),
                labelFull:     call.from.name,
                file:          call.from.uri.fsPath,
                line:          call.from.selectionRange.start.line + 1,
                scopeEnd:      call.from.range.end.line + 1,
                isCurrentFile: call.from.uri.fsPath === document.uri.fsPath,
              });
            }
            // エッジ方向: caller → callee
            edgeSet.add(`${callerId}|||${calleeId}`);

            // caller をさらに上へ展開（未 visited なら）
            if (!upVisited.has(callerId)) {
              upVisited.add(callerId);
              upQueue.push([call.from, callerId]);
            }
          }
        } catch (err) {
          if (err instanceof vscode.CancellationError) throw err;
          errorsInBatch++;
          errs.push(`(incoming) ${calleeItem.name}: ${String(err)}`);
        }
      }));

      // ① adaptive delay (上方向 BFS にも適用)
      if (errorsInBatch > 0) {
        upAdaptiveDelay = Math.min(Math.round(upAdaptiveDelay * 1.5) + 10, BATCH_DELAY_MAX);
      } else {
        upAdaptiveDelay = Math.max(Math.round(upAdaptiveDelay * 0.85) - 2, BATCH_DELAY_MIN);
      }
      pct.bfsQ(55, 100, upVisited, upQueue);
      if (upAdaptiveDelay > 0 && upQueue.length > 0) await delay(upAdaptiveDelay);
    }
  }
  } // ← 下方向 BFS ブロックの閉じ括弧 (coreItemsMap のスコープを閉じる)

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    path.basename(document.uri.fsPath),
    buildTimeMs: Date.now() - t0,
    errors:      errs,
  };
}

async function buildFunctionCallGraphLsp(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct     = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  const startItems = await execWithRetry<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', token, document.uri, position);
  if (!startItems?.length) throw new Error(
    'No function found at cursor position.\nPlace the cursor on a function name and try again.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const visited = new Set<string>();                                 // dequeue 後に処理完了した nodeId
  const startNodeId = makeNodeId(startItems[0].uri, startItems[0].name, startItems[0].selectionRange.start.line);
  const queued  = new Set<string>([startNodeId]);                   // queue に投入済みの nodeId (重複投入防止)
  type Q = [vscode.CallHierarchyItem, number];
  const queue: Q[] = [[startItems[0], 0]];

  // ── 下方向 BFS (callee) ──────────────────────────────────────────────────
  while (queue.length > 0) {
    checkCancellation(token);
    const [item, hop] = queue.shift()!;
    const nodeId = makeNodeId(item.uri, item.name, item.selectionRange.start.line);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    if (!nodes.has(nodeId)) {
      nodes.set(nodeId, {
        id:            nodeId,
        label:         baseNameOf(item.name),
        labelFull:     item.name,
        file:          item.uri.fsPath,
        line:          item.selectionRange.start.line + 1,
        scopeEnd:      item.range.end.line + 1,
        isCurrentFile: item.uri.fsPath === document.uri.fsPath,
      });
    }
    if (hop >= maxHops) continue;

    try {
      const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls', token, item);
      if (!outgoing?.length) continue;
      for (const call of outgoing) {
        let calleeId = findExistingCalleeId(nodes, call.to);
        if (!calleeId) {
          if (!isInWorkspace(call.to.uri, wsRoots)) continue;
          calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
        }
        // エッジ方向: caller(左) → callee(右)
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!queued.has(calleeId)) {
          queued.add(calleeId);
          queue.push([call.to, hop + 1]);
        }
      }
    } catch (err) {
      if (err instanceof vscode.CancellationError) throw err;
      errs.push(`${item.name}: ${String(err)}`);
    }
    pct.bfsQ(5, 50, queued, queue);
  }

  // ── 上方向 BFS (caller) ──────────────────────────────────────────────────
  // provideIncomingCalls で起点関数を呼ぶ関数を遡り、左側のノードとして追加する。
  // エッジ方向は常に caller(左) → callee(右) を維持する。
  pct.to(50);
  {
    type UpQ = [vscode.CallHierarchyItem, number];
    const upQueued = new Set<string>([startNodeId]);
    const upQueue: UpQ[] = [[startItems[0], 0]];

    while (upQueue.length > 0) {
      checkCancellation(token);
      const [calleeItem, hop] = upQueue.shift()!;
      const calleeId = makeNodeId(calleeItem.uri, calleeItem.name, calleeItem.selectionRange.start.line);
      if (hop >= maxHops) continue;

      try {
        const incoming = await execWithRetry<vscode.CallHierarchyIncomingCall[]>(
          'vscode.provideIncomingCalls', token, calleeItem);
        if (!incoming?.length) continue;
        for (const call of incoming) {
          let callerId = findExistingCalleeId(nodes, call.from);
          if (!callerId) {
            if (!isInWorkspace(call.from.uri, wsRoots)) continue;
            callerId = makeNodeId(call.from.uri, call.from.name, call.from.selectionRange.start.line);
          }
          if (!nodes.has(callerId)) {
            nodes.set(callerId, {
              id:            callerId,
              label:         baseNameOf(call.from.name),
              labelFull:     call.from.name,
              file:          call.from.uri.fsPath,
              line:          call.from.selectionRange.start.line + 1,
              scopeEnd:      call.from.range.end.line + 1,
              isCurrentFile: call.from.uri.fsPath === document.uri.fsPath,
            });
          }
          // エッジ方向: caller(左) → callee(右)
          edgeSet.add(`${callerId}|||${calleeId}`);
          if (!upQueued.has(callerId)) {
            upQueued.add(callerId);
            upQueue.push([call.from, hop + 1]);
          }
        }
      } catch (err) {
        if (err instanceof vscode.CancellationError) throw err;
        errs.push(`(incoming) ${calleeItem.name}: ${String(err)}`);
      }
      pct.bfsQ(50, 100, upQueued, upQueue);
    }
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    `↕ ${baseNameOf(startItems[0].name)} (${path.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0,
    errors:      errs,
  };
}

async function buildWorkspaceCallGraphLsp(
  uris:      vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0         = Date.now();
  const errs:      string[] = [];
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => hasCppSourceExtension(u));
  const wsRoots = getWorkspaceRoots(uniqueUris[0]);
  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const pct     = new Pct(progress);

  // ★ Fix: 2フェーズに分離して最大並列 LSP 呼び出し数を 36 → BATCH_SIZE(6) に削減。
  //   フェーズ1: 全ファイルのシンボル取得を並列実行 (軽量・CallHierarchy未使用)
  //   フェーズ2: ファイル単位で順次・関数内は BATCH_SIZE 並列で OutgoingCalls を取得
  //
  // フェーズ1: シンボル取得 + ノード事前登録 (並列 OK)
  type FileEntry = { uri: vscode.Uri; functions: vscode.DocumentSymbol[] };
  const fileEntries: FileEntry[] = [];

  await Promise.all(uniqueUris.map(async (uri, idx) => {
    checkCancellation(token);
    let rawSyms: vscode.DocumentSymbol[] | undefined;
    try {
      rawSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri);
    } catch { return; }
    if (!rawSyms?.length) return;

    const functions = flattenFunctions(rawSyms);
    // シンボル取得と同時にノードを事前登録 (後続フェーズ2で findExistingCalleeId がヒットできるよう)
    for (const f of functions) {
      const id = makeNodeId(uri, f.name, f.selectionRange.start.line);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label:         baseNameOf(f.name),
          labelFull:     f.name,
          file:          uri.fsPath,
          line:          f.selectionRange.start.line + 1,
          scopeEnd:      f.range.end.line + 1,
          isCurrentFile: false,
        });
      }
    }
    pct.range(0, 40, idx + 1, uniqueUris.length);
    fileEntries.push({ uri, functions });
  }));

  // フェーズ2: ファイル単位で順次実行 (max BATCH_SIZE=6 並列 / ファイル)
  for (let fi = 0; fi < fileEntries.length; fi++) {
    checkCancellation(token);
    const { uri, functions } = fileEntries[fi];
    pct.range(40, 100, fi + 1, fileEntries.length);

    let adaptiveDelay = BATCH_DELAY_INIT;
    for (let i = 0; i < functions.length; i += BATCH_SIZE) {
      checkCancellation(token);
      const processingIds = new Set<string>();
      let   errorsInBatch = 0;

      await Promise.all(functions.slice(i, i + BATCH_SIZE).map(async (func) => {
        try {
          const items = await execWithRetry<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy', token, uri, func.selectionRange.start);
          if (!items?.length) return;

          const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls', token, items[0]);
          if (!outgoing?.length) return;

          const callerId = makeNodeId(uri, func.name, func.selectionRange.start.line);
          for (const call of outgoing) {
            const { to } = call;
            let calleeId = findExistingCalleeId(nodes, to);
            if (!calleeId) {
              if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
              calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
              if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                processingIds.add(calleeId);
                if (!nodes.has(calleeId)) {
                  nodes.set(calleeId, {
                    id:            calleeId,
                    label:         baseNameOf(to.name),
                    labelFull:     to.name,
                    file:          to.uri.fsPath,
                    line:          to.selectionRange.start.line + 1,
                    scopeEnd:      to.range.end.line + 1,
                    isCurrentFile: false,
                  });
                }
              }
            }
            edgeSet.add(`${callerId}|||${calleeId}`);
          }
        } catch (err) {
          if (err instanceof vscode.CancellationError) throw err;
          errorsInBatch++;
          errs.push(`${path.basename(uri.fsPath)}::${func.name}: ${String(err)}`);
        }
      }));

      // ① adaptive delay
      if (errorsInBatch > 0) {
        adaptiveDelay = Math.min(Math.round(adaptiveDelay * 1.5) + 10, BATCH_DELAY_MAX);
      } else {
        adaptiveDelay = Math.max(Math.round(adaptiveDelay * 0.85) - 2, BATCH_DELAY_MIN);
      }
      if (adaptiveDelay > 0 && i + BATCH_SIZE < functions.length) await delay(adaptiveDelay);
    }
  }

  const label = uniqueUris.length === 1
    ? path.basename(uniqueUris[0].fsPath)
    : `${uniqueUris.length} files`;
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
  start: number; // 関数開始行 (1-indexed)
  end:   number; // 関数終了行 (inclusive、次タグの直前)
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Python 版 is_function_def と同等のヒューリスティック。
 *
 * 【Precision E 修正】純粋仮想・deleted・defaulted 関数宣言を除外。
 *   = 0, = delete, = default で終わる行は定義ではなく宣言のため false を返す。
 */
function isLikelyFuncDef(line: string): boolean {
  const s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith('}')) return false;
  if (s.includes('typedef') || !s.includes('(') || s.endsWith(';')) return false;
  // 純粋仮想 / deleted / defaulted は宣言 (定義ではない)
  if (/=\s*(0|delete|default)\s*[;,]?\s*$/.test(s)) return false;
  return true;
}

/**
 * spawn ENOTDIR の原因と対処を説明するメッセージを生成する。
 * WSL + Windows ハイブリッド環境で PATH に Windows 形式パスが混入すると発生する。
 */
function spawnErrorMessage(cmd: string, err: unknown): string {
  const msg = String(err);
  if (msg.includes('ENOTDIR')) {
    return (
      `[gtags] Failed to launch ${cmd} (ENOTDIR).\n` +
      'Your PATH may contain Windows-style paths (e.g. C:\\Windows\\System32) in WSL.\n' +
      `Fix: add "export PATH=$(echo $PATH | tr ':' '\\n' | grep -v '^/mnt/' | tr '\\n' ':')" to ~/.bashrc`
    );
  }
  if (msg.includes('ENOENT')) {
    return `[gtags] ${cmd} not found. Check that the gtags/global install directory is in your PATH.`;
  }
  return `[gtags] Failed to launch ${cmd}: ${msg}`;
}

/**
 * GTAGS が存在しなければ gtags を実行して DB 構築。
 * 存在する場合は global -u でインクリメンタル更新する。
 *
 * 【Bug C】GTAGS が存在すれば常にスキップしていた問題を修正。
 * 【BugFix F】global -u 失敗時は例外を飲み込んで古いタグで続行。
 * 【⑤】GTAGS_UPDATE_TTL 以内の再実行は global -u をスキップ。
 *   コマンドを連続実行するたびに毎回 global -u が走っていた問題を解消。
 *
 * 戻り値: 警告メッセージ (問題なければ undefined)。呼び出し元が errs に追加する。
 */
async function ensureGtagsDb(wsRoot: string): Promise<string | undefined> {
  const now = Date.now();
  if (fs.existsSync(path.join(wsRoot, 'GTAGS'))) {
    const last = gtagsUpdateCache.get(wsRoot) ?? 0;
    if (now - last < GTAGS_UPDATE_TTL) return undefined; // ⑤ TTL 内はスキップ
    try {
      await execFileAsync('global', ['-u'], { cwd: wsRoot, timeout: 120_000 });
      gtagsUpdateCache.set(wsRoot, now);
    } catch (updateErr) {
      // ★ Fix: global -u 失敗時は gtags (フルリビルド) にフォールバックする。
      //   GPATH 欠損・フォーマット非互換などで -u が失敗した場合、
      //   古いタグのまま続行すると print_result など新規関数がエッジに現れない。
      //   フルリビルドすることでタグを最新化し欠落エッジを防ぐ。
      try {
        await execFileAsync('gtags', ['--accept-dotfiles'], { cwd: wsRoot, timeout: 120_000 });
        gtagsUpdateCache.set(wsRoot, now);
      } catch (rebuildErr) {
        // リビルドも失敗したら警告を返して古いタグで続行 (BugFix F の挙動を維持)
        return spawnErrorMessage('global -u / gtags rebuild', rebuildErr);
      }
    }
  } else {
    await execFileAsync('gtags', ['--accept-dotfiles'], { cwd: wsRoot, timeout: 120_000 });
    gtagsUpdateCache.set(wsRoot, now);
  }
  return undefined;
}

/**
 * GTAGS 出力パスの path traversal を防ぐ。
 * wsRoot 外のパスは null を返す。
 *
 * 【Security H】GTAGS が改ざんされていた場合に ../../etc/passwd などの
 *   ワークスペース外ファイルを read-only アクセスされる問題を防止。
 */
function sanitizeToWsRoot(rawPath: string, wsRoot: string): string | null {
  const fp          = path.isAbsolute(rawPath) ? rawPath : path.resolve(wsRoot, rawPath);
  const wsRootSlash = wsRoot.endsWith(path.sep) ? wsRoot : wsRoot + path.sep;
  // 一次チェック: パス文字列によるプレフィックス検証
  if (!(fp.startsWith(wsRootSlash) || fp === wsRoot)) return null;
  // 二次チェック (Security②): シンボリックリンクを解決して実パスで再検証。
  // ワークスペース内のシンボリックリンク → ワークスペース外ファイル のトラバーサルを防ぐ。
  try {
    const realFp    = fs.realpathSync(fp);
    const realRoot  = fs.realpathSync(wsRoot);
    const realSlash = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (!(realFp.startsWith(realSlash) || realFp === realRoot)) return null;
  } catch {
    // ファイルが存在しない / 解決不能な場合は安全のため除外
    return null;
  }
  return fp;
}

/**
 * `global -f <file>` を実行してそのファイルで定義されているタグを取得。
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
      // ★ Security H: wsRoot 外パスを除外
      const fp = sanitizeToWsRoot(parts[2], wsRoot);
      if (!fp) return [];
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
 * 【③】`global -x -e '.'` を1回実行してすべての定義タグを一括取得。
 * GNU Global 5.0 以降が必要 (-e で POSIX ERE を有効化)。
 * ソース行は global 出力に含まれるためファイルを読まない。
 * 出力形式: name<ws>line<ws>file<ws>source_line
 */
async function runGlobalXAll(
  wsRoot: string
): Promise<Array<{ name: string; line: number; file: string; sourceLine: string }>> {
  const { stdout } = await execFileAsync('global', ['-x', '-e', '.'], {
    cwd: wsRoot, maxBuffer: 200 * 1024 * 1024, timeout: 120_000,
  });
  return stdout.split('\n').flatMap(raw => {
    const trimmed = raw.trimEnd();
    if (!trimmed) return [];
    const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return [];
    const [, name, lineStr, fileStr, sourceLine] = m;
    const line = parseInt(lineStr, 10);
    if (isNaN(line)) return [];
    const file = sanitizeToWsRoot(fileStr, wsRoot); // Security H
    if (!file) return [];
    return [{ name, line, file, sourceLine }];
  });
}

/**
 * タグを収集して Map<name, GtagEntry[]> を返す。
 *
 * 【③】global -x -e '.' による一括取得 (O(1) プロセス起動) を優先。
 *   失敗した場合は per-file global -f にフォールバック (GNU Global < 5.0 対応)。
 * 【⑥】ソース行は global 出力またはオンデマンド読み込みで取得するため
 *   collectGtags 内ではファイルを読まない。lineCache は空で返す。
 * 【Precision ②】全候補を GtagEntry[] として保持。resolveCallee() が callerFile 優先で解決。
 */
async function collectGtags(
  files: string[],
  wsRoot: string
): Promise<{ tags: Map<string, GtagEntry[]>; lineCache: Map<string, string[]>; ambiguousNames: string[] }> {
  const lineCache = new Map<string, string[]>(); // ⑥ 空で返す (オンデマンド読み込み)

  // ③ 高速パス: global -x -e '.' 一括取得
  type RawEntry = { name: string; line: number; file: string; sourceLine: string };
  let rawEntries: RawEntry[];
  try {
    rawEntries = await runGlobalXAll(wsRoot);
  } catch {
    // フォールバック: per-file global -f
    const perFileResults: Array<{ name: string; line: number; file: string }> = [];
    const CONCURRENT = Math.min(16, Math.max(1, files.length));
    for (let i = 0; i < files.length; i += CONCURRENT) {
      const results = await Promise.all(
        files.slice(i, i + CONCURRENT).map(f => runGlobalF(f, wsRoot))
      );
      for (const entries of results) perFileResults.push(...entries);
    }
    rawEntries = perFileResults.map(e => ({ ...e, sourceLine: '' }));
  }

  const rawMap = new Map<string, RawEntry[]>();
  for (const e of rawEntries) {
    if (!rawMap.has(e.name)) rawMap.set(e.name, []);
    rawMap.get(e.name)!.push(e);
  }

  const tags           = new Map<string, GtagEntry[]>();
  const ambiguousNames: string[] = [];

  for (const [name, candidates] of rawMap) {
    const distinctFiles = new Set(candidates.map(c => c.file));
    if (distinctFiles.size > 1) ambiguousNames.push(name);

    const entries: GtagEntry[] = candidates.map(cand => {
      // sourceLine が空 (per-file fallback) の場合のみファイルを読む
      let sourceLine = cand.sourceLine;
      if (!sourceLine) {
        const ll = readFileLinesCached(cand.file, lineCache);
        sourceLine = ll[cand.line - 1]?.trimEnd() ?? '';
      }
      return { name, file: cand.file, line: cand.line, sourceLine, isFunc: isLikelyFuncDef(sourceLine) };
    });
    tags.set(name, entries);
  }
  return { tags, lineCache, ambiguousNames };
}

/**
 * タグマップからスコープマップを構築。
 *
 * 【Bug A 修正】isFunc=true のエントリのみでスコープを区切る。
 * 【Bug B 修正】byName: Map<name, ScopeEntry> で O(1) ルックアップ。
 * 【Precision ② 対応】tags が Map<name, GtagEntry[]> になったため全 entry を反復する。
 *   同名関数が複数ファイルにある場合、各 (file, name) ペアが独立したスコープとして登録される。
 */
interface ScopeMapEntry {
  list:   ScopeEntry[];            // 行範囲検索用
  byName: Map<string, ScopeEntry>; // 名前引き O(1) ルックアップ用
}

function buildGtagsScopeMap(tags: Map<string, GtagEntry[]>): Map<string, ScopeMapEntry> {
  const fileMap = new Map<string, { name: string; line: number }[]>();
  for (const [name, entries] of tags) {
    for (const info of entries) {
      // ★ Bug A: isFunc=true のエントリのみ対象にする
      if (!info.isFunc) continue;
      if (!fileMap.has(info.file)) fileMap.set(info.file, []);
      fileMap.get(info.file)!.push({ name, line: info.line });
    }
  }
  const scopeMap = new Map<string, ScopeMapEntry>();
  for (const [fp, entries] of fileMap) {
    entries.sort((a, b) => a.line - b.line);
    const list: ScopeEntry[] = entries.map((e, i) => ({
      name:  e.name,
      start: e.line,
      end:   i + 1 < entries.length ? entries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
    }));
    // ★ Bug B / Bug④: 同一ファイル内に同名関数が複数ある場合 (例: #ifdef 分岐)、
    //   後勝ちにならないよう最初のエントリを採用する。
    //   呼び出し元では可能な限り findScopeAtLine (行番号優先) を使うこと。
    const byName = new Map<string, ScopeEntry>();
    for (const s of list) {
      if (!byName.has(s.name)) byName.set(s.name, s); // 先勝ち (= 行番号が小さい定義を優先)
    }
    scopeMap.set(fp, { list, byName });
  }
  return scopeMap;
}

/**
 * ソース行の [start, end] 範囲を走査し、
 * knownTags に含まれる呼び出し先 (自己再帰除外) を返す。
 *
 * 【Precision D 修正】文字列リテラル内の誤検出を除去。
 * 【Feat③】C++11 RAW文字列リテラル `R"delimiter(...)delimiter"` に対応。
 *   行をまたぐ RAW 文字列の状態 (rawDelimiter) を行ループ間で持続させる。
 *
 *   状態遷移の優先順位 (inBlockComment / rawDelimiter を除く):
 *     1. R" → RAW 文字列リテラル (rawDelimiter が設定されるまで)
 *     2. " → 二重引用符文字列 (次の unescaped " まで読み飛ばす)
 *     3. ' → 文字リテラル     (次の unescaped ' まで読み飛ばす)
 *     4. // → 行末コメント
 *     5. /* → ブロックコメント開始 (行をまたいで持続)
 *     6. その他 → processed に追加
 */
function extractCallsFromLines(
  lines: string[], start: number, end: number,
  knownTags: Set<string>, selfName: string
): Set<string> {
  const callees        = new Set<string>();
  const re             = /\b([A-Za-z_]\w*)\s*\(/g;
  let   inBlockComment = false;
  let   rawDelimiter   = '';   // Feat③: RAW文字列の終端デリミタ。空文字列なら非RAW状態

  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    const line = lines[i];
    let   processed = '';
    let   j         = 0;

    while (j < line.length) {
      // ── RAW文字列状態 (Feat③) ──────────────────────────────────────────
      if (rawDelimiter) {
        const endIdx = line.indexOf(rawDelimiter, j);
        if (endIdx === -1) {
          j = line.length; // 行末まで RAW 文字列継続
        } else {
          j = endIdx + rawDelimiter.length;
          rawDelimiter = ''; // RAW 文字列終端
        }
        continue;
      }

      if (inBlockComment) {
        const endIdx = line.indexOf('*/', j);
        if (endIdx === -1) { j = line.length; }
        else { inBlockComment = false; j = endIdx + 2; }
        continue;
      }

      const ch  = line[j];
      const ch2 = j + 1 < line.length ? line[j] + line[j + 1] : '';

      // Feat③: R"delimiter(...)delimiter" の開始検出
      // 'R' の次が '"' のとき RAW 文字列リテラル開始
      if (ch === 'R' && j + 1 < line.length && line[j + 1] === '"') {
        j += 2; // R" をスキップ
        const parenIdx = line.indexOf('(', j);
        if (parenIdx === -1) {
          // '(' なし → 通常の識別子 R として扱う
          processed += ch;
          // j はすでに次の文字を指しているため調整
          j--; // ループ末尾の j++ で R" の " を再処理させるのではなく、
                // R だけ processed に積んで次ループで " を通常文字列として処理する
        } else {
          const delim  = line.slice(j, parenIdx); // R"DELIM( の DELIM 部分
          const terminator = ')' + delim + '"';   // 終端は )DELIM"
          j = parenIdx + 1;
          // 同一行内に終端があるか確認
          const endIdx = line.indexOf(terminator, j);
          if (endIdx !== -1) {
            j = endIdx + terminator.length; // 同一行内で終端
          } else {
            rawDelimiter = terminator; // 次の行に継続
            j = line.length;
          }
        }
        continue;
      }

      if (ch === '"') {
        // 二重引用符文字列: 次の unescaped " まで読み飛ばす
        j++;
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; }
          else if (line[j] === '"') { j++; break; }
          else { j++; }
        }
      } else if (ch === "'") {
        // 文字リテラル: 次の unescaped ' まで読み飛ばす
        j++;
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; }
          else if (line[j] === "'") { j++; break; }
          else { j++; }
        }
      } else if (ch2 === '//') {
        j = line.length; // 行末コメント
      } else if (ch2 === '/*') {
        inBlockComment = true;
        j += 2;
      } else {
        processed += ch;
        j++;
      }
    }

    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(processed)) !== null) {
      const callee = m[1];
      if (callee !== selfName && knownTags.has(callee)) callees.add(callee);
    }
  }
  return callees;
}

/**
 * callee スコープを解決する。
 * Bug④ 修正: calleeEntry.line が既知の場合は findScopeAtLine (行番号優先) を使い、
 *   同一ファイル内に同名関数が複数ある場合でも正しいスコープを返す。
 *   findScopeAtLine が失敗した場合のみ byName にフォールバックする。
 */
function resolveCalleeScope(
  scopeMap: Map<string, ScopeMapEntry>,
  file:     string,
  name:     string,
  line:     number
): ScopeEntry | undefined {
  const entry = scopeMap.get(file);
  if (!entry) return undefined;
  return findScopeAtLine(entry.list, line) ?? entry.byName.get(name);
}

function makeGtagsNodeId(file: string, name: string, line: number): string {
  return `${file}||${name}||${line}`;
}

/**
 * nodeId を (file, name, line) に分解する。
 * file パスに || が含まれても最後の 2 区切りで安全に分割する。
 */
function parseGtagsNodeId(id: string): { file: string; name: string; line: number } {
  const lastSep = id.lastIndexOf('||');
  const line    = parseInt(id.slice(lastSep + 2), 10);
  const rest    = id.slice(0, lastSep);
  const nameSep = rest.lastIndexOf('||');
  return { file: rest.slice(0, nameSep), name: rest.slice(nameSep + 2), line };
}

/**
 * 【Precision ②】callee エントリを全候補から解決する。
 * 優先順位: ① callerFile と同ファイル + isFunc (static 関数)
 *           ② 任意ファイルの isFunc
 *           ③ フォールバック (先頭候補)
 */
function resolveCallee(
  candidates: GtagEntry[] | undefined,
  callerFile: string
): GtagEntry | undefined {
  if (!candidates?.length) return undefined;
  return candidates.find(c => c.file === callerFile && c.isFunc)
      ?? candidates.find(c => c.isFunc)
      ?? candidates[0];
}

/**
 * 【Precision ①】global -rx 用の関数名エスケープ (POSIX ERE)。
 * 関数名に含まれる可能性のある特殊文字をエスケープする。
 */
function escapeRegexForGlobal(name: string): string {
  return name.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ソートされた ScopeEntry[] から refLine を含むエントリを二分探索で返す。
 * list.find(O(n)) を O(log n) に置き換える。
 */
function findScopeAtLine(list: ScopeEntry[], refLine: number): ScopeEntry | undefined {
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

/**
 * 【Precision ①】global -rx -e 'func1|func2|...' を GLOBAL_RX_BATCH 個ずつバッチ処理し、
 * callerFiles 内の参照からエッジセットを構築する。
 *
 * ソーステキストの正規表現スキャンではなく GNU Global のシンボル DB を使うため、
 * コメント・文字列リテラル・マクロ名との誤混同がなくなり false positive が大幅減少する。
 *
 * NOTE: -e フラグ (POSIX 拡張正規表現) は GNU Global 5.0 以降が必要。
 *
 * @param callerFiles  caller として対象にするファイルパスの集合
 * @param tags         全タグマップ (Precision ② 対応: name → GtagEntry[])
 * @param scopeMap     スコープマップ
 * @param wsRoot       GTAGS のあるワークスペースルート
 * @param token        キャンセルトークン
 * @param pct          Pct インスタンス（進捗レポーター）
 * @param startPct     この関数が担当するパーセント開始値
 * @param endPct       この関数が担当するパーセント終了値
 */
async function buildEdgesGlobalRx(
  callerFiles: Set<string>,
  tags:        Map<string, GtagEntry[]>,
  scopeMap:    Map<string, ScopeMapEntry>,
  wsRoot:      string,
  token?:      vscode.CancellationToken,
  pct?:        Pct,
  startPct     = 20,
  endPct       = 75,
): Promise<Set<string>> {
  const edgeSet = new Set<string>();

  // isFunc エントリを持つ関数名のみ対象にする
  const funcNames = Array.from(tags.entries())
    .filter(([, entries]) => entries.some(e => e.isFunc))
    .map(([name]) => name);

  // ④ バッチを GLOBAL_RX_PARALLEL 個ずつ並列実行して高速化
  const batchArrays: string[][] = [];
  for (let i = 0; i < funcNames.length; i += GLOBAL_RX_BATCH) {
    batchArrays.push(funcNames.slice(i, i + GLOBAL_RX_BATCH));
  }
  const totalGroups = Math.ceil(batchArrays.length / GLOBAL_RX_PARALLEL);

  for (let gi = 0; gi < batchArrays.length; gi += GLOBAL_RX_PARALLEL) {
    checkCancellation(token);
    pct?.range(startPct, endPct, Math.floor(gi / GLOBAL_RX_PARALLEL), totalGroups);

    await Promise.all(batchArrays.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async batch => {
      const pattern = batch.map(escapeRegexForGlobal).join('|');
      let stdout = '';
      try {
        ({ stdout } = await execFileAsync('global', ['-rx', '-e', pattern], {
          cwd: wsRoot, maxBuffer: 50 * 1024 * 1024, timeout: 60_000,
        }));
      } catch { return; }

      for (const rawLine of stdout.split('\n')) {
        const parts = rawLine.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const calleeName = parts[0];
        const refLine    = parseInt(parts[1], 10);
        if (!calleeName || isNaN(refLine)) continue;
        const refFile = sanitizeToWsRoot(parts[2], wsRoot); // Security H
        if (!refFile || !callerFiles.has(refFile)) continue;
        const fileScopeEntry = scopeMap.get(refFile);
        if (!fileScopeEntry) continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        if (!callerScope) continue;
        const callerEntry = tags.get(callerScope.name)
          ?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry) continue;
        const calleeEntry = resolveCallee(tags.get(calleeName), refFile);
        if (!calleeEntry?.isFunc) continue;
        // Bug④: resolveCalleeScope (findScopeAtLine 優先) で正確なスコープを取得
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, calleeName, calleeEntry.line);
        if (!calleeScope) continue;
        if (callerScope.name === calleeName && callerEntry.file === calleeEntry.file) continue;
        const callerId = makeGtagsNodeId(refFile, callerScope.name, callerEntry.line);
        const calleeId = makeGtagsNodeId(calleeEntry.file, calleeName, calleeEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
      }
    }));
  }
  return edgeSet;
}

/**
 * GtagEntry + ScopeEntry から GraphNode を生成する。
 * 【⑥】source をここでは設定しない (クリック時にオンデマンド読み込み)。
 *   代わりに scopeEnd を保持し、webviewPanel の requestSource ハンドラが利用する。
 */
function gtagsEntryToNode(
  name: string, entry: GtagEntry, scope: ScopeEntry, currentFile: string
): GraphNode {
  const scopeEnd = scope.end === Number.MAX_SAFE_INTEGER
    ? scope.start + MAX_SOURCE_LINES - 1
    : scope.end;
  // B: normalizeFsPath で比較してシンボリックリンク環境でも正しく判定する
  const isCurrentFile = currentFile !== ''
    && normalizeFsPath(entry.file) === normalizeFsPath(currentFile);
  return {
    id:            makeGtagsNodeId(entry.file, name, entry.line),
    label:         name,
    labelFull:     entry.sourceLine || name,
    file:          entry.file,
    line:          entry.line,
    scopeEnd,
    isCurrentFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  実装
// ─────────────────────────────────────────────────────────────────────────────

async function buildFileCallGraphGtags(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0     = Date.now();
  const errs:  string[] = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  // ★ Precision ③: ヘッダーも含めてタグを収集 (inline 関数・テンプレートを callee ノードとして登録)
  pct.to(5);
  const allUris  = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);

  pct.to(8);
  checkCancellation(token);
  const { tags, lineCache, ambiguousNames } = await collectGtags(allUris.map(u => u.fsPath), wsRoot);
  if (!tags.size) throw new Error(
    'No tags found.\nPlease verify that gtags is installed and GTAGS exists.');

  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(', ');
    const suffix  = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : '';
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }

  // 現在ファイルの内容を lineCache に上書き (未保存変更を反映)
  // Fix 3: normalizeFsPath で entry.file と同じキーになるよう正規化する
  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  const currentLines    = document.getText().split('\n');
  lineCache.set(currentFileNorm, currentLines);
  lineCache.set(currentFile, currentLines); // 両方登録して確実にヒットさせる

  const scopeMap   = buildGtagsScopeMap(tags);
  // Fix 2: findScopeMapEntry でパス差異に対応
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const nodes      = new Map<string, GraphNode>();

  // 現在ファイルの関数ノードを登録
  for (const scope of fileScopes) {
    // Fix 2: normalizeFsPath で比較してパス差異を吸収
    const entry = tags.get(scope.name)?.find(
      e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    if (!entry) continue;
    const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
    nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, currentFile));
  }
  if (!nodes.size) throw new Error('No functions found in this file.');

  // ★ Precision ①: global -rx でエッジを構築
  pct.to(20);
  checkCancellation(token);
  // callerFiles: GTAGS が返す実パス + document.uri.fsPath の両方を含める (Fix 2)
  const callerFiles = new Set<string>([currentFile, currentFileNorm]);
  for (const scope of fileScopes) {
    const e = tags.get(scope.name)?.find(
      e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    if (e) callerFiles.add(e.file);
  }
  const edgeSet     = await buildEdgesGlobalRx(callerFiles, tags, scopeMap, wsRoot, token, pct, 20, 75);

  // callee ノードを登録 (currentFile 外・ヘッダー定義も含む)
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split('|||')[1];
    if (nodes.has(calleeId)) continue;
    const { file: calleeFile, name: calleeName } = parseGtagsNodeId(calleeId);
    const calleeEntry = tags.get(calleeName)?.find(e => e.file === calleeFile && e.isFunc);
    if (!calleeEntry) continue;
    // Bug④: resolveCalleeScope (findScopeAtLine 優先)
    const calleeScope = resolveCalleeScope(scopeMap, calleeFile, calleeName, calleeEntry.line);
    if (!calleeScope) continue;
    nodes.set(calleeId, gtagsEntryToNode(calleeName, calleeEntry, calleeScope, currentFile));
  }

  // ── 下方向 BFS 再帰展開 ────────────────────────────────────────────────
  // buildEdgesGlobalRx で発見された callee ノードを起点に extractCallsFromLines で再帰展開。
  // 深さ制限なし（downVisited でサイクル防止）。
  // buildFunctionCallGraphGtags の下方向 BFS と同じロジックを使用。
  pct.to(75);
  {
    const knownTags   = new Set(tags.keys());
    const downVisited = new Set<string>();

    // コアノード（ファイル内関数）を visited 済みとしてマーク（buildEdgesGlobalRx で処理済み）
    for (const scope of fileScopes) {
      const entry = tags.get(scope.name)?.find(
        e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
      if (!entry) continue;
      downVisited.add(makeGtagsNodeId(entry.file, scope.name, entry.line));
    }

    // 第1フェーズ（buildEdgesGlobalRx）で発見された callee ノードをキューに積む
    type DownItem = { name: string; entry: GtagEntry; scope: ScopeEntry };
    const downQueue: DownItem[] = [];
    for (const nodeId of nodes.keys()) {
      if (downVisited.has(nodeId)) continue;
      downVisited.add(nodeId);
      const { file: nFile, name: nName } = parseGtagsNodeId(nodeId);
      const entry = tags.get(nName)?.find(e => e.file === nFile && e.isFunc);
      if (!entry) continue;
      // Bug④: resolveCalleeScope (findScopeAtLine 優先)
      const scope = resolveCalleeScope(scopeMap, nFile, nName, entry.line);
      if (!scope) continue;
      downQueue.push({ name: nName, entry, scope });
    }

    while (downQueue.length > 0) {
      checkCancellation(token);
      const { name, entry, scope } = downQueue.shift()!;
      const callerId = makeGtagsNodeId(entry.file, name, entry.line);

      const lines   = readFileLinesCached(entry.file, lineCache);
      const callees = extractCallsFromLines(lines, scope.start, scope.end, knownTags, name);

      for (const callee of callees) {
        const calleeEntry = resolveCallee(tags.get(callee), entry.file);
        if (!calleeEntry || !calleeEntry.isFunc) continue;
        // Bug④: resolveCalleeScope (findScopeAtLine 優先)
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, callee, calleeEntry.line);
        if (!calleeScope) continue;

        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);

        if (!nodes.has(calleeId)) {
          nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, currentFile));
        }

        // 未 visited なら再帰展開のためキューに追加
        if (!downVisited.has(calleeId)) {
          downVisited.add(calleeId);
          downQueue.push({ name: callee, entry: calleeEntry, scope: calleeScope });
        }
      }
      pct.bfsQ(75, 88, downVisited, downQueue);
    }
  }

  // ── 上方向 BFS (caller) ──────────────────────────────────────────────────
  // ファイル内の全コア関数を起点に global -rx で呼び出し元を遡る。
  // 深さ制限なし（upVisited でサイクル防止）。main() などルートまで到達したら終了。
  // buildPathThroughCallGraphGtags の上方向 BFS と同じロジックを使用。
  pct.to(88);
  {
    type UpItem = {
      funcName: string;  // この関数への参照を global -rx で探す
      calleeId: string;  // エッジの下流側 nodeId
    };

    // コアノード（ファイル内関数）を全てキューの初期値として積む
    const upVisited = new Set<string>();
    const upQueue:   UpItem[] = [];

    for (const scope of fileScopes) {
      const entry = tags.get(scope.name)?.find(
        e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
      if (!entry) continue;
      const coreId = makeGtagsNodeId(entry.file, scope.name, entry.line);
      upVisited.add(coreId);
      upQueue.push({ funcName: scope.name, calleeId: coreId });
    }

    while (upQueue.length > 0) {
      checkCancellation(token);
      const { funcName, calleeId } = upQueue.shift()!;

      for (const { refFile, refLine } of await runGlobalRxSingle(funcName, wsRoot)) {
        checkCancellation(token);

        const fileScopeEntry = scopeMap.get(refFile);
        if (!fileScopeEntry) continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        if (!callerScope || callerScope.name === funcName) continue; // 自己再帰を除外

        // Precision ②: refFile 優先で caller エントリを解決
        const callerEntry =
          tags.get(callerScope.name)?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry) continue;

        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);

        // エッジ: callerNode → calleeNode
        edgeSet.add(`${callerId}|||${calleeId}`);

        // caller ノード未登録なら追加
        if (!nodes.has(callerId)) {
          nodes.set(callerId, gtagsEntryToNode(
            callerScope.name, callerEntry, callerScope, currentFile));
        }

        // さらに上へ展開（未 visited なら）
        if (!upVisited.has(callerId)) {
          upVisited.add(callerId);
          upQueue.push({ funcName: callerScope.name, calleeId: callerId });
        }
      }
      pct.bfsQ(88, 100, upVisited, upQueue);
    }
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    path.basename(currentFile),
    buildTimeMs: Date.now() - t0,
    errors:      errs,
  };
}

async function buildFunctionCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0     = Date.now();
  const errs:  string[] = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  // ★ Precision ③: ヘッダーも callee ノードとして登録するため CC_ALL_GLOB で収集
  pct.to(5);
  checkCancellation(token);
  const allUris = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);
  const { tags, lineCache, ambiguousNames } = await collectGtags(allUris.map(u => u.fsPath), wsRoot);
  if (!tags.size) throw new Error('No tags found.');

  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(', ');
    const suffix  = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : '';
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }

  // 現在ファイルの内容を上書き (未保存変更を反映)
  // Fix 3: 両キーで登録
  const currentFile = document.uri.fsPath;
  const currentLines = document.getText().split('\n');
  lineCache.set(currentFile, currentLines);
  lineCache.set(normalizeFsPath(currentFile), currentLines);

  const knownTags = new Set(tags.keys());
  const scopeMap  = buildGtagsScopeMap(tags);

  // カーソル行を含むスコープを起点にする (1-indexed)
  // Fix 2: findScopeMapEntry でパス差異に対応
  const cursorLine = position.line + 1;
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const startScope = fileScopes.find(s => s.start <= cursorLine && cursorLine <= s.end);
  if (!startScope) throw new Error(
    'No function found at cursor position.\nPlace the cursor on a function name and try again.');

  // C: startScope はパス正規化済みで解決されているが、tags 内の entry.file は
  //    GTAGS が返すパスのため、currentFile と異なる可能性がある。
  //    normalizeFsPath で比較して正しい entry を選ぶ。
  const currentFileNorm2 = normalizeFsPath(currentFile);
  const startEntry = tags.get(startScope.name)
    ?.find(e => normalizeFsPath(e.file) === currentFileNorm2 && e.isFunc)
    ?? tags.get(startScope.name)?.find(e => e.isFunc)
    ?? tags.get(startScope.name)?.[0];
  if (!startEntry) throw new Error('Tag info for the start function was not found.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // 下方向 BFS (extractCallsFromLines を使用)
  //
  // 【BugFix G】visited (処理完了) と queued (投入済み) を分離して退行バグを修正。
  //   旧実装は callee を visited に先行登録していたため、pop 時に「処理済み」と
  //   誤判定されノードが未登録になり「ノード1つ・エッジ2本」現象が発生していた。
  const startNodeId = makeGtagsNodeId(startEntry.file, startScope.name, startEntry.line);
  type Q = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
  const visited = new Set<string>();                // pop して処理完了した nodeId
  const queued  = new Set<string>([startNodeId]);   // queue に積んだ nodeId (重複投入防止)
  const queue: Q[] = [{ name: startScope.name, entry: startEntry, scope: startScope, hop: 0 }];

  while (queue.length > 0) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue.shift()!;
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId); // ← pop 時にのみ登録

    const lines = readFileLinesCached(entry.file, lineCache);
    nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
    if (hop >= maxHops) continue;

    const callees = extractCallsFromLines(lines, scope.start, scope.end, knownTags, name);
    for (const callee of callees) {
      // Precision ②: callerFile 優先でエントリを解決
      const calleeEntry = resolveCallee(tags.get(callee), entry.file);
      // ★ Fix②: resolveCallee の最終フォールバックが isFunc=false（宣言のみ）エントリを
      //   返す場合がある。その場合 scopeMap にエントリが存在しないためサイレントスキップされ、
      //   callee が BFS キューに追加されない。isFunc=false は定義なしとして明示的に除外する。
      if (!calleeEntry || !calleeEntry.isFunc) continue;
      // Bug④: resolveCalleeScope (findScopeAtLine 優先)
      const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, callee, calleeEntry.line);
      if (!calleeScope) continue;

      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      edgeSet.add(`${nodeId}|||${calleeId}`);
      // queued で重複投入を防止 (visited への先行登録は行わない)
      if (!queued.has(calleeId)) {
        queued.add(calleeId);
        queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 });
      }
    }
    pct.bfsQ(20, 100, queued, queue);
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    `${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0,
    errors:      errs,
  };
}

async function buildWorkspaceCallGraphGtags(
  uris:      vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0   = Date.now();
  const errs: string[] = [];

  // ヘッダーを caller スキャン対象から除外 (ソース拡張子のみ対象)
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => CC_SOURCE_EXTENSIONS.has(path.extname(u.fsPath).toLowerCase()));
  if (!uniqueUris.length) throw new Error('No C/C++ source files found.');

  const wsRoot = getWorkspaceRootForFile(uniqueUris[0]);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  // ★ Precision ③: ヘッダーも callee ノードとして登録するため CC_ALL_GLOB で収集
  pct.to(5);
  checkCancellation(token);
  const allUris = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);
  const { tags, lineCache, ambiguousNames } = await collectGtags(allUris.map(u => u.fsPath), wsRoot);

  // Bug② 修正: workspace でも tags が空のときは早期終了する
  if (!tags.size) throw new Error('No tags found. Run `gtags` in the workspace root, or check that GTAGS/GRTAGS/GPATH files exist.');

  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(', ');
    const suffix  = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : '';
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }

  const scopeMap    = buildGtagsScopeMap(tags);
  const nodes       = new Map<string, GraphNode>();
  // G: GTAGS が返すパスと VSCode URI パスの両方を callerFiles に含める
  const callerFiles = new Set<string>();
  for (const uri of uniqueUris) {
    callerFiles.add(uri.fsPath);
    callerFiles.add(normalizeFsPath(uri.fsPath));
  }

  // ノード登録: uniqueUris に含まれるソースファイルの関数のみ caller ノードとして登録
  pct.to(20);
  for (const uri of uniqueUris) {
    checkCancellation(token);
    // G: findScopeMapEntry でパス差異に対応
    const fileScopes = findScopeMapEntry(scopeMap, uri.fsPath)?.list ?? [];
    for (const scope of fileScopes) {
      const entry = tags.get(scope.name)?.find(
        e => normalizeFsPath(e.file) === normalizeFsPath(uri.fsPath) && e.isFunc);
      if (!entry) continue;
      // G: GTAGS の実パスも callerFiles に追加
      callerFiles.add(entry.file);
      const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
      if (!nodes.has(nodeId)) nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, ''));
    }
  }

  // ★ Precision ①: global -rx でエッジを一括構築
  pct.to(30);
  checkCancellation(token);
  const edgeSet = await buildEdgesGlobalRx(callerFiles, tags, scopeMap, wsRoot, token, pct, 30, 90);

  // edgeSet に含まれる callee ノードを追加登録 (ヘッダー inline 関数を含む)
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split('|||')[1];
    if (nodes.has(calleeId)) continue;
    const { file: calleeFile, name: calleeName } = parseGtagsNodeId(calleeId);
    const calleeEntry = tags.get(calleeName)?.find(e => e.file === calleeFile && e.isFunc);
    if (!calleeEntry) continue;
    // Bug④: resolveCalleeScope (findScopeAtLine 優先)
    const calleeScope = resolveCalleeScope(scopeMap, calleeFile, calleeName, calleeEntry.line);
    if (!calleeScope) continue;
    nodes.set(calleeId, gtagsEntryToNode(calleeName, calleeEntry, calleeScope, ''));
  }

  const label = uniqueUris.length === 1
    ? path.basename(uniqueUris[0].fsPath)
    : `${uniqueUris.length} files`;
  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: label, buildTimeMs: Date.now() - t0, errors: errs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  パス貫通コールグラフ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `global -rx <funcName>` を 1 関数分実行して参照箇所 (refFile, refLine) の配列を返す。
 * パス貫通グラフの上方向 (caller) 探索で使用する。
 */
async function runGlobalRxSingle(
  funcName: string,
  wsRoot:   string,
): Promise<Array<{ refFile: string; refLine: number }>> {
  try {
    const { stdout } = await execFileAsync(
      'global', ['-rx', funcName],
      { cwd: wsRoot, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }
    );
    return stdout.split('\n').flatMap(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) return [];
      const refLine = parseInt(parts[1], 10);
      if (isNaN(refLine)) return [];
      // Security H: wsRoot 外パスを除外
      const refFile = sanitizeToWsRoot(parts[2], wsRoot);
      if (!refFile) return [];
      return [{ refFile, refLine }];
    });
  } catch {
    return [];
  }
}

/**
 * パス貫通コールグラフを構築する。
 *
 * 選択した関数 F を中心に、F を経由するコールチェーン全体を可視化する。
 *
 *   ancestors (上方向 BFS)  ──→  F  ──→  descendants (下方向 BFS)
 *
 * 【下方向】extractCallsFromLines で F から呼ばれる全関数を再帰展開。
 * 【上方向】global -rx <funcName> で F を呼ぶ関数を逐次取得し BFS で遡る。
 *   取得した ancNode が持つエッジは「ancNode → ancNode/F」のみ。
 *   つまり ancNode が F と無関係な sibling_func を呼んでいても、
 *   sibling_func は ancNodes に含まれないためエッジが生成されない。
 *   → "F を通るパスのみ" が自然に実現される。
 *
 * @param maxHops  上下各方向の最大ホップ数 (合計ではなく方向ごと)
 */
async function buildPathThroughCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0     = Date.now();
  const errs:  string[] = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  pct.to(5);
  checkCancellation(token);
  const allUris = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);
  const { tags, lineCache, ambiguousNames } =
    await collectGtags(allUris.map(u => u.fsPath), wsRoot);
  if (!tags.size) throw new Error('No tags found.');

  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(', ');
    const suffix  = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : '';
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }

  const currentFile  = document.uri.fsPath;
  const currentLines = document.getText().split('\n');
  lineCache.set(currentFile, currentLines);
  lineCache.set(normalizeFsPath(currentFile), currentLines);

  const knownTags = new Set(tags.keys());
  const scopeMap  = buildGtagsScopeMap(tags);

  // 起点関数を特定 (Fix 2: findScopeMapEntry でパス差異に対応)
  const cursorLine = position.line + 1;
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const startScope = fileScopes.find(s => s.start <= cursorLine && cursorLine <= s.end);
  if (!startScope) throw new Error(
    'No function found at cursor position.\nPlace the cursor on a function name and try again.');

  // C: GTAGS パスと document.uri.fsPath の差異を normalizeFsPath で吸収する
  const currentFileNorm2 = normalizeFsPath(currentFile);
  const startEntry = tags.get(startScope.name)
    ?.find(e => normalizeFsPath(e.file) === currentFileNorm2 && e.isFunc)
    ?? tags.get(startScope.name)?.find(e => e.isFunc)
    ?? tags.get(startScope.name)?.[0];
  if (!startEntry) throw new Error('Tag info for the start function was not found.');

  const startNodeId = makeGtagsNodeId(startEntry.file, startScope.name, startEntry.line);
  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // ── 下方向 BFS (callee) ──────────────────────────────────────────────────
  pct.to(20);
  {
    type Q = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
    const visited = new Set<string>();
    const queued  = new Set<string>([startNodeId]);
    const queue: Q[] = [{ name: startScope.name, entry: startEntry, scope: startScope, hop: 0 }];

    while (queue.length > 0) {
      checkCancellation(token);
      const { name, entry, scope, hop } = queue.shift()!;
      const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const lines = readFileLinesCached(entry.file, lineCache);
      nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
      if (hop >= maxHops) continue;

      for (const callee of extractCallsFromLines(lines, scope.start, scope.end, knownTags, name)) {
        const calleeEntry = resolveCallee(tags.get(callee), entry.file);
        if (!calleeEntry) continue;
        // Bug④: resolveCalleeScope (findScopeAtLine 優先)
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, callee, calleeEntry.line);
        if (!calleeScope) continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (!queued.has(calleeId)) {
          queued.add(calleeId);
          queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 });
        }
      }
      pct.bfsQ(20, 55, queued, queue);
    }
  }

  // ── 上方向 BFS (caller) ──────────────────────────────────────────────────
  // global -rx <funcName> で参照箇所を逆辿りし、scopeMap で caller スコープを特定する。
  // ancEdges は「ancNode → ancNode/F」のみ収集されるため sibling は自然に除外される。
  pct.to(55);
  {
    type UpItem = {
      funcName: string;   // この関数への参照を global -rx で探す
      calleeId: string;   // エッジの下流側 nodeId
      hop:      number;
    };
    const queued = new Set<string>([startNodeId]);
    const queue: UpItem[] = [{
      funcName: startScope.name, calleeId: startNodeId, hop: 0,
    }];

    while (queue.length > 0) {
      checkCancellation(token);
      const { funcName, calleeId, hop } = queue.shift()!;
      if (hop >= maxHops) continue;

      for (const { refFile, refLine } of await runGlobalRxSingle(funcName, wsRoot)) {
        checkCancellation(token);

        // 参照行が含まれる caller スコープを二分探索で特定
        const fileScopeEntry = scopeMap.get(refFile);
        if (!fileScopeEntry) continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        if (!callerScope || callerScope.name === funcName) continue; // 自己再帰を除外

        // Precision ②: refFile 優先で caller エントリを解決
        const callerEntry =
          tags.get(callerScope.name)?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry) continue;

        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);

        // エッジ: callerNode → calleeNode (下流側はすでに nodes に登録済み or 起点)
        edgeSet.add(`${callerId}|||${calleeId}`);

        // caller ノード未登録なら追加
        if (!nodes.has(callerId)) {
          nodes.set(callerId, gtagsEntryToNode(
            callerScope.name, callerEntry, callerScope, currentFile));
        }

        // さらに上へ展開
        if (!queued.has(callerId)) {
          queued.add(callerId);
          queue.push({ funcName: callerScope.name, calleeId: callerId, hop: hop + 1 });
        }
      }
      pct.bfsQ(55, 100, queued, queue);
    }
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    `↕ ${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0,
    errors:      errs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 公開エントリーポイント  ─  backend 引数で LSP / gtags を切り替える
// ─────────────────────────────────────────────────────────────────────────────

/** ⑦ キャッシュキーを生成する共通ヘルパー */
function makeCacheKey(type: string, ...parts: string[]): string {
  return `${type}::${parts.join('::')}`;
}

export async function buildFileCallGraph(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend:   Backend = 'auto',
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const key     = makeCacheKey('file', document.uri.fsPath);
  const cached  = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data; // ⑦ キャッシュヒット (TTL 内)
  const result  = await ((await resolveBackend(backend)) === 'gtags'
    ? buildFileCallGraphGtags(document, progress, token)
    : buildFileCallGraphLsp(document, progress, token));
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}

export async function buildFunctionCallGraph(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend:   Backend = 'auto',
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const key    = makeCacheKey('func', document.uri.fsPath, String(position.line));
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  // Bug⑤ + Feat① 修正:
  //   旧実装では gtags が buildPathThroughCallGraphGtags (上下双方向) を呼んでいたため、
  //   LSP バックエンド (下方向 BFS のみ) と動作が異なり、同じコマンドで結果の性質が変わっていた。
  //   buildFunctionCallGraphGtags (下方向 BFS のみ) に統一し、LSP と一致させる。
  //   上下双方向が欲しい場合は "Show Path-Through Graph (gtags)" コマンドを使用すること。
  const result = await ((await resolveBackend(backend)) === 'gtags'
    ? buildFunctionCallGraphGtags(document, position, maxHops, progress, token)
    : buildFunctionCallGraphLsp(document, position, maxHops, progress, token));
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}

export async function buildWorkspaceCallGraph(
  uris:      vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend:   Backend = 'auto',
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  // F: 10k ファイルでキーが数MB になるのを防ぐため、ソートしたパス一覧のハッシュを使う
  // Feat④ 修正: XOR + 可換性による衝突を避けるため、順序依存の多項式ハッシュを採用する。
  //   hash = hash * PRIME + charCode の累積演算により、異なるパスの順列が異なるハッシュになる。
  const sorted = uris.map(u => u.fsPath).sort();
  const PRIME  = 31;
  const hashSeed = sorted.reduce((acc, p) => {
    // パス全体をシリアルに処理（パス間のセパレータとして 0 を挿入）
    let h = (acc * PRIME + 0) | 0;
    for (let i = 0; i < p.length; i++) {
      h = (h * PRIME + p.charCodeAt(i)) | 0;
    }
    return h;
  }, 17); // 素数 17 を初期値にして空リストが 0 になるのを避ける
  const key    = makeCacheKey('workspace', String(hashSeed), String(sorted.length));
  const cached   = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  const result = await ((await resolveBackend(backend)) === 'gtags'
    ? buildWorkspaceCallGraphGtags(uris, progress, token)
    : buildWorkspaceCallGraphLsp(uris, progress, token));
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * パス貫通コールグラフ: 選択した関数を中心に ancestors (上方向) + descendants (下方向) を展開。
 * 現在は gtags バックエンドのみ対応 (上方向探索に global -rx を使用するため)。
 */
export async function buildPathThroughCallGraph(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend:   Backend = 'auto',
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const resolved = await resolveBackend(backend);
  if (resolved !== 'gtags') {
    throw new Error(
      'Path-through graph is only supported with the gtags backend.\n' +
      'Please select "gtags (Fast)" as the backend.'
    );
  }
  const key    = makeCacheKey('path', document.uri.fsPath, String(position.line));
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  const result = await buildPathThroughCallGraphGtags(document, position, maxHops, progress, token);
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}