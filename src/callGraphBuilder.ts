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
import * as os       from 'os';
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

// caller としてスキャンするソース拡張子 (ヘッダー除外)
const CC_SOURCE_EXTENSIONS = new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']);

// ⑤ 修正: CC_SOURCE_GLOB / WORKSPACE_FILE_CONCURRENCY は未使用のため削除。
// Precision ③: ヘッダーを callee ノードとして収集するための広域グロブ
const CC_ALL_GLOB         = '**/*.{c,cpp,cc,cxx,cu,cuh,h,hpp,hxx}';
// ③ 修正: EXCLUDE_DIRS (extension.ts) に追加した CMake/ツール系ディレクトリを同期。
//   vscode.workspace.findFiles の excludePattern はここを参照するため、
//   EXCLUDE_DIRS と揃えないと CMakeFiles 以下の生成ファイルが収集対象に混入する。
export const EXCLUDE_GLOB = '{'  + [
  '**/node_modules/**', '**/build/**', '**/dist/**', '**/out/**', '**/.git/**',
  '**/CMakeFiles/**', '**/_build/**', '**/_deps/**',
  '**/cmake-build-debug/**', '**/cmake-build-release/**',
  '**/.cache/**', '**/.ccls-cache/**', '**/vendor/**', '**/.deps/**',
].join(',') + '}';

// PERF-02 修正: global は I/O 集中型のため CPU コア数 × 2 まで並列度を引き上げる。
// 従来は最大 8 固定だったが、コア数が多い環境（開発ワークステーション等）では
// より高い並列数でスループットが改善する。最低 4 / 最大 cpus*2 (上限 32)。
const GLOBAL_RX_PARALLEL = Math.max(4, Math.min(os.cpus().length * 2, 32)); // 同時実行バッチ数

// ⑤ GTAGS 更新 TTL: この時間内の再実行は global -u をスキップ
// ②: FileSystemWatcher が変更時に invalidateCache() を呼ぶため、
//   TTL は「FileSystemWatcher が取りこぼした変更への安全網」として機能する。
//   取りこぼしは稀なので長い TTL で問題ない。30s → 5分に延長。
const GTAGS_UPDATE_TTL = 5 * 60_000; // ms

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

// ─── パフォーマンス改善: gtags タグキャッシュ ─────────────────────────────
// 問題: collectGtags (global -x -e '.') はプロジェクト全体を走査するため
//   大規模プロジェクトでは数十秒かかる。GraphData キャッシュとは独立して
//   タグマップをキャッシュすることで、2回目以降をほぼ一瞬にする。
// TTL: GTAGS_UPDATE_TTL (30s) と揃える。global -u 後に自動的に再収集する。
const TAGS_CACHE_TTL_MS = GTAGS_UPDATE_TTL; // 5 分 (GTAGS_UPDATE_TTL と同期)
interface TagsCacheEntry {
  tags:           Map<string, GtagEntry[]>;
  ambiguousNames: string[];
  // B: scopeMap を一緒にキャッシュ。buildGtagsScopeMap の再計算を省略できる。
  scopeMap:       Map<string, ScopeMapEntry>;
  timestamp:      number;
}
const tagsCache = new Map<string, TagsCacheEntry>(); // wsRoot → entry

// ─── パフォーマンス改善: findFiles キャッシュ ────────────────────────────
// vscode.workspace.findFiles は大規模プロジェクトで数秒かかる。
// 短い TTL でキャッシュして collectGtags の前コストを削減する。
// ②: FileSystemWatcher が onDidCreate/onDidDelete で invalidateCache() を呼ぶため
//   ファイルリストの TTL は長くしても安全。10s → 60s に延長。
const FILES_CACHE_TTL_MS = 60_000; // 60 s
interface FilesCacheEntry { uris: vscode.Uri[]; timestamp: number; }
const filesCache = new Map<string, FilesCacheEntry>(); // wsRoot → entry

// ─── 遅延ローディング用キャッシュ (buildFunctionCallGraphGtags 専用) ──────
// buildFunctionCallGraphGtags は全ダンプを行わず訪問した関数・ファイルだけをクエリする。
// ビルドをまたいでキャッシュすることで 2 回目以降を更に高速化する。
// TTL は GTAGS_UPDATE_TTL と揃え、ファイル変更時は invalidateCache() で全削除する。
// lineCache はビルド内ローカルのまま (document.getText() の未保存変更を反映するため)。
const LAZY_CACHE_TTL_MS = GTAGS_UPDATE_TTL; // 5 min (GTAGS_UPDATE_TTL と同期)

interface LazyTagCacheEntry   { entries: Map<string, GtagEntry[]>;   timestamp: number; }
interface LazyScopeCacheEntry { scopes:  Map<string, ScopeMapEntry>; timestamp: number; }

const lazyTagCache   = new Map<string, LazyTagCacheEntry>();   // wsRoot → entry
const lazyScopeCache = new Map<string, LazyScopeCacheEntry>(); // wsRoot → entry

// H: realpathSync 結果キャッシュ (sanitizeToWsRoot / findScopeMapEntry のホットパスを最適化)
// wsRoot はビルドをまたいで同一。ファイルパスも繰り返し出現するため効果が大きい。
// BUG-7 修正: 大規模プロジェクトでエントリが無制限に蓄積するメモリリークを防ぐため上限を設ける。
// 上限超過時は全クリア（LRU より実装シンプル、かつ次のビルドで再ウォームアップされる）。
const REALPATH_CACHE_MAX = 500;
const realpathCache = new Map<string, string>(); // rawPath → resolved realpath

/** realpathCache への書き込みヘルパー。上限を超えた場合にクリアしてから追加する。 */
function setRealpathCache(key: string, value: string): void {
  if (realpathCache.size >= REALPATH_CACHE_MAX) realpathCache.clear();
  realpathCache.set(key, value);
}

// B: gtagsAvailable キャッシュ (セッション内永続)
// gtags のインストール状態のキャッシュは gtagsAvailable() 関数内で管理する (BUG-20 参照)

/** BUG-03 修正: FIFO キャッシュ書き込み（Map の挿入順を利用）。
 * 旧実装は O(n) 線形スキャンで最古タイムスタンプを探していたが、
 * JS の Map はキーの挿入順を保証するため先頭エントリ削除で O(1) の FIFO を実現できる。
 * LRU より FIFO の方が実装シンプルかつ実運用（1ファイル反復編集）でも実害なし。
 */
function setGraphCache(key: string, entry: GraphCacheEntry): void {
  // すでに存在するキーは削除して再挿入（挿入順を末尾に更新）
  if (graphDataCache.has(key)) graphDataCache.delete(key);
  if (graphDataCache.size >= MAX_CACHE_ENTRIES) {
    // Map の先頭エントリ（最も古い挿入）を O(1) で削除
    const firstKey = graphDataCache.keys().next().value;
    if (firstKey !== undefined) graphDataCache.delete(firstKey);
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
  if (!filePath) {
    graphDataCache.clear();
    tagsCache.clear();
    filesCache.clear();
    lazyTagCache.clear();
    lazyScopeCache.clear();
    realpathCache.clear(); // H
    return;
  }
  const norm = normalizeFsPath(filePath);
  // BUG-03 修正: key.includes(norm) は部分文字列一致のため '/src/a.c' が '/src/a.c.bak' にも
  //   マッチして無関係なキャッシュを削除していた。
  //   makeCacheKey の形式 'type::filePath::backend' を前提に :: 区切りで
  //   ファイルパスのセグメント完全一致に切り替える。
  for (const key of graphDataCache.keys()) {
    const segments = key.split('::');
    const keyPath  = segments[1] ?? '';
    if (keyPath === norm || keyPath === filePath) graphDataCache.delete(key);
  }
  // E: 変更ファイルが属する wsRoot のキャッシュだけ削除。
  // マルチルートワークスペースで別プロジェクトのキャッシュを巻き添えにしない。
  const allWsRoots = new Set([
    ...tagsCache.keys(), ...lazyTagCache.keys(), ...lazyScopeCache.keys(),
  ]);
  const affectedRoots = [...allWsRoots].filter(wsRoot => {
    const normRoot = normalizeFsPath(wsRoot);
    return norm.startsWith(normRoot + '/') || norm.startsWith(normRoot + path.sep);
  });

  if (affectedRoots.length === 0) {
    // どの wsRoot にも属さない変更は全削除（安全側）
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
    filesCache.clear(); // F: filesCache のキーは wsRoot で区別できないため全削除
  }
  // SEC-2 修正: realpathCache はフルクリアする。
  // 変更ファイルのエントリのみ削除する旧実装では、シンボリックリンクの向き先が変更された場合に
  // 古いキャッシュ値でワークスペース外参照チェック (Security H) を通過できてしまう。
  // realpathCache のエントリは文字列のみで小さく、フルクリアのコスト増は無視できる。
  realpathCache.clear();
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
 * BUG-07 修正: findScopeMapEntry の大文字小文字無視フォールバック (macOS/Windows) を O(1) 化。
 * WeakMap を使うことで scopeMap のライフタイムに紐付けたキャッシュを実現し、
 * scopeMap インスタンスが GC されると自動的に回収される（メモリリークなし）。
 */
const lowerScopeIndexCache = new WeakMap<Map<string, ScopeMapEntry>, Map<string, ScopeMapEntry>>();

function getLowerScopeIndex(scopeMap: Map<string, ScopeMapEntry>): Map<string, ScopeMapEntry> {
  const cached = lowerScopeIndexCache.get(scopeMap);
  if (cached) return cached;
  const lower = new Map<string, ScopeMapEntry>();
  for (const [k, v] of scopeMap) {
    const lk = normalizeFsPath(k).toLowerCase();
    if (!lower.has(lk)) lower.set(lk, v); // 先勝ち
  }
  lowerScopeIndexCache.set(scopeMap, lower);
  return lower;
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

  // 3. BUG-07 修正: 大文字小文字無視 (macOS / Windows) — WeakMap キャッシュで O(1) に高速化
  if (process.platform !== 'linux') {
    const lower = norm.toLowerCase();
    entry = getLowerScopeIndex(scopeMap).get(lower);
    if (entry) return entry;
  }

  // 4. realpath でシンボリックリンクを解決 (H: realpathCache でキャッシュ)
  try {
    const real = realpathCache.get(filePath) ?? (() => {
      const r = fs.realpathSync(filePath); setRealpathCache(filePath, r); return r;
    })();
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
 * D: adaptive delay を更新するヘルパー。
 *
 * 従来実装: 毎バッチ固定係数 (0.85倍 - 2ms) で収束 → 初期 20ms から 0 まで 6〜7 バッチ必要。
 * 新実装  : 連続成功 3 回以上で係数を 0.5 倍に切り替え → 安定環境では 3〜4 バッチで収束。
 *           エラー発生時は streak をリセットして従来と同じ増加ロジックを適用。
 *
 * @param current      現在の遅延 ms
 * @param hasErrors    このバッチでエラーが発生したか
 * @param streak       連続成功バッチ数を保持するオブジェクト (参照渡し)
 */
function nextAdaptiveDelay(
  current:   number,
  hasErrors: boolean,
  streak:    { val: number },
): number {
  if (hasErrors) {
    streak.val = 0;
    return Math.min(Math.round(current * 1.5) + 10, BATCH_DELAY_MAX);
  }
  streak.val++;
  // 連続成功 3 回以上 → 急速収束 (0.5 倍)
  if (streak.val >= 3) {
    return Math.max(Math.round(current * 0.5), BATCH_DELAY_MIN);
  }
  // 通常収束 (0.85 倍 − 2ms)
  return Math.max(Math.round(current * 0.85) - 2, BATCH_DELAY_MIN);
}

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
  bfsQ(start: number, end: number, touched: { size: number }, pending: { length: number }): void {
    const total = touched.size;
    const done  = Math.max(0, total - pending.length);
    this.to(total === 0 ? end : start + (end - start) * done / total);
  }

  /** ④ パフォーマンス改善: パーセントを変えずにメッセージだけ更新する */
  report(message: string): void {
    this.p?.report({ message, increment: 0 });
  }
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
 *
 * Mid-1 修正: Windows はファイルシステムがケースインセンシティブなため
 *   startsWith による大文字小文字の不一致を防ぐため normalizeFsPath で比較する。
 */
function getWorkspaceRootForFile(fileUri: vscode.Uri): string | undefined {
  const filePath = normalizeFsPath(fileUri.fsPath);
  const folders  = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = normalizeFsPath(folder.uri.fsPath);
    if (filePath === root
      || filePath.startsWith(root + path.sep)
      || filePath.startsWith(root + '/')) {
      return folder.uri.fsPath; // 元のパス（正規化前）を返す
    }
  }
  // どのフォルダにも属さない場合: 最初のフォルダか親ディレクトリ
  return folders[0]?.uri.fsPath ?? path.dirname(fileUri.fsPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// バックエンド解決
// ─────────────────────────────────────────────────────────────────────────────

let _gtagsAvailableCache:     boolean   | undefined;
let _gtagsAvailableFalseTs:   number    | undefined; // BUG-20: false キャッシュのタイムスタンプ
const GTAGS_FALSE_TTL = 30_000; // 30秒後に再チェック

async function gtagsAvailable(): Promise<boolean> {
  // BUG-20 修正: true は永続キャッシュ（インストール済み gtags が突然消えることはない）。
  // false は 30秒 TTL で再チェック可能にする。
  // ユーザーが gtags をインストールしてから PATH を更新しても VS Code 再起動なしに認識できる。
  if (_gtagsAvailableCache === true) return true;
  if (_gtagsAvailableCache === false && _gtagsAvailableFalseTs !== undefined) {
    if (Date.now() - _gtagsAvailableFalseTs < GTAGS_FALSE_TTL) return false;
  }
  try {
    await execFileAsync('gtags', ['--version'], { timeout: 5_000 });
    _gtagsAvailableCache   = true;
    _gtagsAvailableFalseTs = undefined;
  } catch {
    _gtagsAvailableCache   = false;
    _gtagsAvailableFalseTs = Date.now();
  }
  return _gtagsAvailableCache;
}

export async function resolveBackend(backend: Backend): Promise<'lsp' | 'gtags'> {
  if (backend === 'lsp')   return 'lsp';
  if (backend === 'gtags') return 'gtags';
  return (await gtagsAvailable()) ? 'gtags' : 'lsp';
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP バックエンド  ─  内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

export function hasCppSourceExtension(uri: vscode.Uri): boolean {
  return CC_SOURCE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

function isInWorkspace(uri: vscode.Uri, roots: string[]): boolean {
  if (roots.length === 0) return true;
  const p = uri.fsPath;
  return roots.some(r => p === r || p.startsWith(r + path.sep) || p.startsWith(r + '/'));
}

/**
 * BUG-01 修正: callee として受け入れるかを判定。
 * `isInWorkspace` は単一ファイルモード（wsRoots が空）で `true` を返す設計だが、
 * `shouldIncludeCallee` でワークスペース外の任意ファイルまで取り込むのは過剰。
 * wsRoots が空のとき（フォルダ未開放の単一ファイル編集）は
 * ワークスペース境界が確定できないため callee の取り込みを拒否する。
 * これにより LSP がシステムヘッダー等を callee として返しても無視される。
 */

/** callee として受け入れる拡張子 (ソース + ヘッダー)
 *
 * 🐛 ファイルグラフ修正: CC_SOURCE_EXTENSIONS (.h/.hpp/.hxx を除外) を使っていたため、
 *   clangd が callee のヘッダー宣言位置を返すプロジェクトでは全エッジがスキップされ、
 *   全ノードが level=0 (縦1列) + ファイル内関数のみ表示になっていた。
 *   Precision ③ でヘッダーを callee ノードとして収集するよう変更済みの gtags 側と統一する。
 *   ヘッダーは caller スキャン対象外 (CC_SOURCE_EXTENSIONS フィルタ) のまま維持。
 */
const CC_CALLEE_EXTENSIONS = new Set([
  '.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh',   // ソース (既存)
  '.h', '.hpp', '.hxx',                           // ヘッダー (追加)
]);

function shouldIncludeCallee(uri: vscode.Uri, roots: string[]): boolean {
  if (roots.length === 0) return false; // 境界不明のため安全側に倒す
  return isInWorkspace(uri, roots)
    && CC_CALLEE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

/** BUG-18 修正: LSP ノード ID 生成。
 * 旧セパレータ `||` は C++ の `operator||` を含む baseName (`operator||`) と組み合わさると
 * `file||operator||||line` のように `||||` が生じ、splitEdges の `indexOf('|||')` が
 * エッジセパレータより前で誤マッチしてグラフが壊れていた。
 * `\x00`（NUL）は関数名・ファイルパスに含まれないため安全。
 * gtags バックエンドの makeGtagsNodeId と同じ方針に統一する。
 */
function makeNodeId(uri: vscode.Uri, name: string, line: number): string {
  return `${uri.fsPath}\x00${baseNameOf(name)}\x00${line}`;
}

/** "func(T1, T2)" → "func" */
function baseNameOf(name: string): string {
  const idx = name.indexOf('(');
  return idx >= 0 ? name.slice(0, idx).trim() : name;
}

/**
 * ⑥ Performance 追加: ノードの二次インデックス型。
 * key = `${file}\x00${baseName}` → nodeId のマッピング。
 * findExistingCalleeId の O(n) 線形スキャンを O(1) に高速化するために使用する。
 * nodes Map と同期して更新すること。
 */
type NodeIndex = Map<string, string>;

/** NodeIndex への追加ヘルパー。同一キーは先勝ち（行番号の小さい定義を優先）。
 * BUG-16: この関数は必ず同期のまま維持すること。
 * buildWorkspaceCallGraphLsp フェーズ1 の Promise.all 内で呼ばれており、
 * もし async になった場合はコルーチン間の競合でノードが重複登録される。
 */
function addToNodeIndex(index: NodeIndex, id: string, node: GraphNode): void {
  const key = `${node.file}\x00${node.label}`;
  if (!index.has(key)) index.set(key, id);
}

/**
 * callee のノード ID を既存マップから探す。
 * ⑥ Performance 修正: ファイル+名前の O(n) 線形スキャン → NodeIndex による O(1) ルックアップ。
 * ヘッダー経由（ファイル不一致）のケースのみ線形スキャンのフォールバックを残す（稀なパス）。
 */
function findExistingCalleeId(
  nodes: Map<string, GraphNode>,
  index: NodeIndex,
  to: vscode.CallHierarchyItem
): string | null {
  const exactId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
  if (nodes.has(exactId)) return exactId;

  const base = baseNameOf(to.name);
  const fp   = to.uri.fsPath;

  // O(1): ファイル + baseName による二次インデックス検索
  const indexed = index.get(`${fp}\x00${base}`);
  if (indexed) return indexed;

  // ヘッダーファイル経由のフォールバック（稀）: ファイルを問わず baseName で一致検索
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
 *   待機時間: 200ms → 400ms → 800ms  (MAX_RETRY=4 のとき最大 3 段)
 */
const MAX_RETRY          = 4;    // ③ 6 → 4: 最大待機 200+400+800ms = 1,400ms に短縮
const RETRY_BASE_MS      = 200;
const CANCELED_RETRY_DELAY = 3000; // clangd indexing 安定化待ち: ファイルレベルリトライの遅延 ms

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
      // Bug3 修正: CancellationError はリトライせず即座に再スロー。
      //   修正前は 'not found' チェックのみで、CancellationError が 200ms 待機後に
      //   ようやく checkCancellation で検出されていた。
      if (err instanceof vscode.CancellationError) throw err;
      const msg = String(err);
      if (msg.includes('not found')) throw err; // コマンド自体が存在しない → 即終了
      // ★ Fix: Canceled に加え、LSP 過負荷による一時エラーも全てリトライ
      //   "not found" 以外のあらゆるエラーを最大 MAX_RETRY 回まで指数バックオフでリトライ。
      //   これにより Workspace/Folder モードの並列 LSP 呼び出しで発生する
      //   一時的失敗 (non-Canceled エラー) を救済する。
      if (i < MAX_RETRY - 1) {
        await delay(RETRY_BASE_MS * Math.pow(2, i)); // 200ms, 400ms, 800ms
        continue;
      }
      throw err; // MAX_RETRY 回試しても失敗したら諦める
    }
  }
}

/**
 * clangd が indexing 中に返す "Canceled: Canceled" エラーかを判定する。
 * vscode.CancellationError（ユーザー操作によるキャンセル）とは区別する。
 * ファイルレベルリトライの対象判定に使用する。
 */
function isCanceledByClangd(err: unknown): boolean {
  return !(err instanceof vscode.CancellationError) && String(err).includes('Canceled');
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

  const nodes     = new Map<string, GraphNode>();
  const edgeSet   = new Set<string>();
  // ⑥ Performance 追加: ファイル+baseName による O(1) ルックアップ用二次インデックス
  const nodeIndex: NodeIndex = new Map();

  // 現在ファイルの関数ノードを事前登録
  for (const f of functions) {
    const id   = makeNodeId(document.uri, f.name, f.selectionRange.start.line);
    const node: GraphNode = {
      id,
      label:         baseNameOf(f.name),
      labelFull:     f.name,
      file:          document.uri.fsPath,
      line:          f.selectionRange.start.line + 1,
      scopeEnd:      f.range.end.line + 1, // ⑥ lazy source 用
      isCurrentFile: true,
    };
    nodes.set(id, node);
    addToNodeIndex(nodeIndex, id, node);
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
    const downStreak    = { val: 0 }; // D: 連続成功カウンタ (nextAdaptiveDelay 用)

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

    // BUG-19 修正: downQueue.splice(0, N) は配列の先頭シフトで O(n) になる。
    // qi インデックスポインタ方式で O(1) 取り出しに変更する（他の BFS 関数と統一）。
    let dqi = 0;
    while (dqi < downQueue.length) {
      checkCancellation(token);
      const batch          = downQueue.slice(dqi, dqi + BATCH_SIZE);
      dqi += batch.length;
      const processingIds  = new Set<string>();
      let   errorsInBatch  = 0;

      await Promise.all(batch.map(async ([callerItem, callerId]) => {
        try {
          const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls', token, callerItem);
          if (!outgoing?.length) return;

          for (const call of outgoing) {
            const { to } = call;
            let calleeId = findExistingCalleeId(nodes, nodeIndex, to);
            if (!calleeId) {
              if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
              calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
              if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                processingIds.add(calleeId);
                const calleeNode: GraphNode = {
                  id:            calleeId,
                  label:         baseNameOf(to.name),
                  labelFull:     to.name,
                  file:          to.uri.fsPath,
                  line:          to.selectionRange.start.line + 1,
                  scopeEnd:      to.range.end.line + 1,
                  isCurrentFile: to.uri.fsPath === document.uri.fsPath,
                };
                nodes.set(calleeId, calleeNode);
                addToNodeIndex(nodeIndex, calleeId, calleeNode);
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

      // ① adaptive delay (D: nextAdaptiveDelay で連続成功時に急速収束)
      adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, errorsInBatch > 0, downStreak);
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
    const upStreak      = { val: 0 }; // D: 連続成功カウンタ

    // ★ Fix 1: シリアルループ → BATCH_SIZE 並列バッチ + adaptive delay
    // BUG-19 修正: upQueue.splice(0, N) → uqi インデックスポインタ方式で O(1) 取り出し
    let uqi = 0;
    while (uqi < upQueue.length) {
      checkCancellation(token);
      const batch         = upQueue.slice(uqi, uqi + BATCH_SIZE);
      uqi += batch.length;
      let   errorsInBatch = 0;

      await Promise.all(batch.map(async ([calleeItem, calleeId]) => {
        try {
          const incoming = await execWithRetry<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls', token, calleeItem);
          if (!incoming?.length) return;

          for (const call of incoming) {
            let callerId = findExistingCalleeId(nodes, nodeIndex, call.from);
            if (!callerId) {
              // 🟡 Bug 3 修正: 下方向 BFS は shouldIncludeCallee で wsRoots=[] のとき false を返して
              //   安全側に倒しているが、上方向 BFS は isInWorkspace を使っており wsRoots=[] のとき
              //   true を返すため非対称だった。明示的なガードを追加して対称にする。
              if (wsRoots.length === 0) continue;
              if (!isInWorkspace(call.from.uri, wsRoots)) continue;
              callerId = makeNodeId(call.from.uri, call.from.name, call.from.selectionRange.start.line);
            }
            if (!nodes.has(callerId)) {
              const callerNode: GraphNode = {
                id:            callerId,
                label:         baseNameOf(call.from.name),
                labelFull:     call.from.name,
                file:          call.from.uri.fsPath,
                line:          call.from.selectionRange.start.line + 1,
                scopeEnd:      call.from.range.end.line + 1,
                isCurrentFile: call.from.uri.fsPath === document.uri.fsPath,
              };
              nodes.set(callerId, callerNode);
              addToNodeIndex(nodeIndex, callerId, callerNode);
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

      // ① adaptive delay (上方向 BFS にも適用) (D: nextAdaptiveDelay で連続成功時に急速収束)
      upAdaptiveDelay = nextAdaptiveDelay(upAdaptiveDelay, errorsInBatch > 0, upStreak);
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

/**
 * LSP バックエンド版・関数グラフ（下方向 BFS のみ）。
 *
 * buildPathThroughCallGraphLsp との違い:
 *   - 上方向 BFS (provideIncomingCalls) を持たない → callee ツリーのみ
 *   - fileName に `↕` が付かない
 *   - gtags 版 buildFunctionCallGraphGtags と動作を揃える
 */
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

  const nodes    = new Map<string, GraphNode>();
  const edgeSet  = new Set<string>();
  // ⑥ Performance 追加: ファイル+baseName による O(1) ルックアップ用二次インデックス
  const nodeIndex: NodeIndex = new Map();
  const visited  = new Set<string>();
  const startNodeId = makeNodeId(startItems[0].uri, startItems[0].name, startItems[0].selectionRange.start.line);
  const queued   = new Set<string>([startNodeId]);
  type Q = [vscode.CallHierarchyItem, number]; // [item, hop]
  const queue: Q[] = [[startItems[0], 0]];
  let   qi = 0; // D: shift() O(n) → インデックスポインタ O(1)

  // ── 下方向 BFS (callee) ──────────────────────────────────────────────────
  let adaptiveDelay = BATCH_DELAY_INIT;
  const downStreak  = { val: 0 }; // D: 連続成功カウンタ

  while (qi < queue.length) {
    checkCancellation(token);

    type QItem = { item: vscode.CallHierarchyItem; hop: number; nodeId: string };
    const batch: QItem[] = [];
    while (batch.length < BATCH_SIZE && qi < queue.length) {
      const [item, hop] = queue[qi++];
      const nodeId = makeNodeId(item.uri, item.name, item.selectionRange.start.line);
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      if (!nodes.has(nodeId)) {
        const newNode: GraphNode = {
          id:            nodeId,
          label:         baseNameOf(item.name),
          labelFull:     item.name,
          file:          item.uri.fsPath,
          line:          item.selectionRange.start.line + 1,
          scopeEnd:      item.range.end.line + 1,
          isCurrentFile: item.uri.fsPath === document.uri.fsPath,
        };
        nodes.set(nodeId, newNode);
        addToNodeIndex(nodeIndex, nodeId, newNode);
      }
      if (hop < maxHops) batch.push({ item, hop, nodeId });
    }
    if (batch.length === 0) continue;

    let lspErrors = 0;
    const batchResults = await Promise.all(batch.map(async ({ item, hop, nodeId }) => {
      try {
        const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls', token, item);
        return { nodeId, hop, outgoing: outgoing ?? [] };
      } catch (err) {
        if (err instanceof vscode.CancellationError) throw err;
        errs.push(`${item.name}: ${String(err)}`);
        lspErrors++;
        return { nodeId, hop, outgoing: [] as vscode.CallHierarchyOutgoingCall[] };
      }
    }));

    for (const { nodeId, hop, outgoing } of batchResults) {
      for (const call of outgoing) {
        let calleeId = findExistingCalleeId(nodes, nodeIndex, call.to);
        if (!calleeId) {
          // 🟡 Bug 7 修正: 下方向 BFS の境界チェックを shouldIncludeCallee に統一する。
          //   isInWorkspace は wsRoots=[] で true を返すが shouldIncludeCallee は false を返す（安全側）。
          //   さらに CC_CALLEE_EXTENSIONS でファイル拡張子も確認する点でより厳しい。
          //   buildFileCallGraphLsp / buildWorkspaceCallGraphLsp は正しく使っていたが
          //   buildFunctionCallGraphLsp / buildPathThroughCallGraphLsp だけ漏れていた（Bug 3 の対称問題）。
          if (!shouldIncludeCallee(call.to.uri, wsRoots)) continue;
          calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
          // BUG-01 修正: callee 発見時に nodes / nodeIndex に登録する。
          //   未登録のまま次の findExistingCalleeId が呼ばれると O(1) ルックアップが機能せず
          //   makeNodeId が毎回呼ばれてパフォーマンスが低下する。
          if (!nodes.has(calleeId)) {
            const calleeNode: GraphNode = {
              id:            calleeId,
              label:         baseNameOf(call.to.name),
              labelFull:     call.to.name,
              file:          call.to.uri.fsPath,
              line:          call.to.selectionRange.start.line + 1,
              scopeEnd:      call.to.range.end.line + 1,
              isCurrentFile: call.to.uri.fsPath === document.uri.fsPath,
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
    if (adaptiveDelay > 0 && qi < queue.length) await delay(adaptiveDelay);
    pct.bfsQ(5, 100, queued, { length: queue.length - qi });
  }

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    `${baseNameOf(startItems[0].name)} (${path.basename(document.uri.fsPath)})`,
    buildTimeMs: Date.now() - t0,
    errors:      errs,
  };
}

async function buildPathThroughCallGraphLsp(
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
  // ⑥ Performance 追加: ファイル+baseName による O(1) ルックアップ用二次インデックス
  const nodeIndex: NodeIndex = new Map();
  const visited = new Set<string>();                                 // dequeue 後に処理完了した nodeId
  const startNodeId = makeNodeId(startItems[0].uri, startItems[0].name, startItems[0].selectionRange.start.line);
  const queued  = new Set<string>([startNodeId]);                   // queue に投入済みの nodeId (重複投入防止)
  type Q = [vscode.CallHierarchyItem, number];
  const queue: Q[] = [[startItems[0], 0]];
  let qi = 0; // D: shift() O(n) → インデックスポインタ O(1)

  // ── 下方向 BFS (callee) ──────────────────────────────────────────────────
  // ①: シリアル実行 → BATCH_SIZE 個ずつ並列 + adaptiveDelay (上方向 BFS と同方式)
  // 旧実装: 1ノードずつ provideOutgoingCalls をシリアル呼び出し
  // 新実装: BATCH_SIZE 個まとめて並列呼び出し → clangd の応答待ちを重ねる
  let adaptiveDelay = BATCH_DELAY_INIT;
  const downStreak2 = { val: 0 }; // D: 連続成功カウンタ (nextAdaptiveDelay 用)

  while (qi < queue.length) {
    checkCancellation(token);

    // キューから最大 BATCH_SIZE 個の未 visited アイテムを取り出す
    type QItem = { item: vscode.CallHierarchyItem; hop: number; nodeId: string };
    const batch: QItem[] = [];
    while (batch.length < BATCH_SIZE && qi < queue.length) {
      const [item, hop] = queue[qi++];
      const nodeId = makeNodeId(item.uri, item.name, item.selectionRange.start.line);
      if (visited.has(nodeId)) continue;
      visited.add(nodeId); // 先行マークで並列処理中の重複を防止

      if (!nodes.has(nodeId)) {
        const newNode: GraphNode = {
          id:            nodeId,
          label:         baseNameOf(item.name),
          labelFull:     item.name,
          file:          item.uri.fsPath,
          line:          item.selectionRange.start.line + 1,
          scopeEnd:      item.range.end.line + 1,
          isCurrentFile: item.uri.fsPath === document.uri.fsPath,
        };
        nodes.set(nodeId, newNode);
        addToNodeIndex(nodeIndex, nodeId, newNode);
      }
      if (hop < maxHops) batch.push({ item, hop, nodeId });
    }
    if (batch.length === 0) continue;

    // BATCH_SIZE 個並列で provideOutgoingCalls
    let lspErrors = 0;
    const batchResults = await Promise.all(batch.map(async ({ item, hop, nodeId }) => {
      try {
        const outgoing = await execWithRetry<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls', token, item);
        return { nodeId, hop, outgoing: outgoing ?? [] };
      } catch (err) {
        if (err instanceof vscode.CancellationError) throw err;
        errs.push(`${item.name}: ${String(err)}`);
        lspErrors++;
        return { nodeId, hop, outgoing: [] as vscode.CallHierarchyOutgoingCall[] };
      }
    }));

    // エッジ生成・次ホップをキューに追加
    for (const { nodeId, hop, outgoing } of batchResults) {
      for (const call of outgoing) {
        let calleeId = findExistingCalleeId(nodes, nodeIndex, call.to);
        if (!calleeId) {
          // 🟡 Bug 7 修正: 下方向 BFS の境界チェックを shouldIncludeCallee に統一する。
          //   isInWorkspace は wsRoots=[] で true を返すが shouldIncludeCallee は false を返す（安全側）。
          //   さらに CC_CALLEE_EXTENSIONS でファイル拡張子も確認する点でより厳しい。
          //   buildFileCallGraphLsp / buildWorkspaceCallGraphLsp は正しく使っていたが
          //   buildFunctionCallGraphLsp / buildPathThroughCallGraphLsp だけ漏れていた（Bug 3 の対称問題）。
          if (!shouldIncludeCallee(call.to.uri, wsRoots)) continue;
          calleeId = makeNodeId(call.to.uri, call.to.name, call.to.selectionRange.start.line);
          // BUG-01 修正: callee 発見時に nodes / nodeIndex に登録する。
          //   未登録のまま次の findExistingCalleeId が呼ばれると O(1) ルックアップが機能せず
          //   makeNodeId が毎回呼ばれてパフォーマンスが低下する。
          if (!nodes.has(calleeId)) {
            const calleeNode: GraphNode = {
              id:            calleeId,
              label:         baseNameOf(call.to.name),
              labelFull:     call.to.name,
              file:          call.to.uri.fsPath,
              line:          call.to.selectionRange.start.line + 1,
              scopeEnd:      call.to.range.end.line + 1,
              isCurrentFile: call.to.uri.fsPath === document.uri.fsPath,
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

    // adaptiveDelay: clangd 過負荷を防止 (D: nextAdaptiveDelay で連続成功時に急速収束)
    adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, lspErrors > 0, downStreak2);
    if (adaptiveDelay > 0 && qi < queue.length) await delay(adaptiveDelay);
    pct.bfsQ(5, 50, queued, { length: queue.length - qi });
  }

  // ── 上方向 BFS (caller) ──────────────────────────────────────────────────
  // provideIncomingCalls で起点関数を呼ぶ関数を遡り、左側のノードとして追加する。
  // C: シリアル実行 → level-by-level バッチ並列 (BATCH_SIZE 個ずつ並列 + adaptiveDelay)
  pct.to(50);
  {
    const upQueued = new Set<string>([startNodeId]);
    let upCurrentLevel: vscode.CallHierarchyItem[] = [startItems[0]];
    let adaptiveDelay = BATCH_DELAY_INIT;
    const upStreak2   = { val: 0 }; // D: 連続成功カウンタ (nextAdaptiveDelay 用)

    for (let hop = 0; hop < maxHops && upCurrentLevel.length > 0; hop++) {
      checkCancellation(token);
      const upNextLevel: vscode.CallHierarchyItem[] = [];

      for (let i = 0; i < upCurrentLevel.length; i += BATCH_SIZE) {
        checkCancellation(token);
        const batch = upCurrentLevel.slice(i, i + BATCH_SIZE);
        let lspErrors = 0; // B-2: CancellationError 以外の clangd エラー数（adaptiveDelay 調整用）

        const batchResults = await Promise.all(batch.map(async calleeItem => {
          try {
            const incoming = await execWithRetry<vscode.CallHierarchyIncomingCall[]>(
              'vscode.provideIncomingCalls', token, calleeItem);
            return { calleeItem, incoming: incoming ?? [] };
          } catch (err) {
            if (err instanceof vscode.CancellationError) throw err;
            errs.push(`(incoming) ${calleeItem.name}: ${String(err)}`);
            lspErrors++;
            return { calleeItem, incoming: [] as vscode.CallHierarchyIncomingCall[] };
          }
        }));

        for (const { calleeItem, incoming } of batchResults) {
          const calleeId = makeNodeId(calleeItem.uri, calleeItem.name, calleeItem.selectionRange.start.line);
          for (const call of incoming) {
            let callerId = findExistingCalleeId(nodes, nodeIndex, call.from);
            if (!callerId) {
              // 🟡 Bug 3 修正: 下方向 BFS は shouldIncludeCallee で wsRoots=[] のとき false を返して
              //   安全側に倒しているが、上方向 BFS は isInWorkspace を使っており wsRoots=[] のとき
              //   true を返すため非対称だった。明示的なガードを追加して対称にする。
              if (wsRoots.length === 0) continue;
              if (!isInWorkspace(call.from.uri, wsRoots)) continue;
              callerId = makeNodeId(call.from.uri, call.from.name, call.from.selectionRange.start.line);
            }
            if (!nodes.has(callerId)) {
              const callerNode: GraphNode = {
                id:            callerId,
                label:         baseNameOf(call.from.name),
                labelFull:     call.from.name,
                file:          call.from.uri.fsPath,
                line:          call.from.selectionRange.start.line + 1,
                scopeEnd:      call.from.range.end.line + 1,
                isCurrentFile: call.from.uri.fsPath === document.uri.fsPath,
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

        // adaptiveDelay: Canceled エラーが多いほど遅延を増やし clangd を保護 (D: 連続成功時急速収束)
        adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, lspErrors > 0, upStreak2);
        if (adaptiveDelay > 0 && (i + BATCH_SIZE < upCurrentLevel.length || upNextLevel.length > 0)) {
          await delay(adaptiveDelay);
        }
      }

      pct.range(50, 100, hop + 1, maxHops);
      upCurrentLevel = upNextLevel;
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
  // FILE_PARALLEL: フェーズ1・フェーズ2 共通の並列数定数。関数先頭で宣言して両フェーズで参照する。
  const FILE_PARALLEL = 3;
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => hasCppSourceExtension(u));
  // BUG-02 修正: gtags 版と同様に空チェックを追加（uniqueUris[0] への未防衛アクセスを防ぐ）
  if (!uniqueUris.length) throw new Error('No C/C++ source files found.');
  const wsRoots = getWorkspaceRoots(uniqueUris[0]);
  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  // ⑥ Performance 追加: ファイル+baseName による O(1) ルックアップ用二次インデックス
  const nodeIndex: NodeIndex = new Map();
  const pct     = new Pct(progress);

  // ★ Fix: 2フェーズに分離して最大並列 LSP 呼び出し数を 36 → BATCH_SIZE(6) に削減。
  //   フェーズ1: 全ファイルのシンボル取得を並列実行 (軽量・CallHierarchy未使用)
  //   フェーズ2: ファイル単位で順次・関数内は BATCH_SIZE 並列で OutgoingCalls を取得
  //
  // フェーズ1: シンボル取得 + ノード事前登録
  // BUG-11/PERF-08 修正: 旧実装は全ファイルを Promise.all で完全並列に LSP へ投入していた。
  // ファイル数が多い場合（100+）に clangd が過負荷になり Canceled エラーが多発する。
  // フェーズ2 と同じく FILE_PARALLEL (= 3) 個ずつバッチ化してスループットを維持しながら
  // LSP への同時リクエスト数を制限する。
  type FileEntry = { uri: vscode.Uri; functions: vscode.DocumentSymbol[] };
  const fileEntries: FileEntry[] = [];

  for (let si = 0; si < uniqueUris.length; si += FILE_PARALLEL) {
    checkCancellation(token);
    await Promise.all(uniqueUris.slice(si, si + FILE_PARALLEL).map(async uri => {
      let rawSyms: vscode.DocumentSymbol[] | undefined;
      try {
        rawSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', uri);
      } catch { return; }
      if (!rawSyms?.length) return;

      const functions = flattenFunctions(rawSyms);
      for (const f of functions) {
        const id = makeNodeId(uri, f.name, f.selectionRange.start.line);
        if (!nodes.has(id)) {
          const newNode: GraphNode = {
            id,
            label:         baseNameOf(f.name),
            labelFull:     f.name,
            file:          uri.fsPath,
            line:          f.selectionRange.start.line + 1,
            scopeEnd:      f.range.end.line + 1,
            isCurrentFile: false,
          };
          nodes.set(id, newNode);
          addToNodeIndex(nodeIndex, id, newNode);
        }
      }
      fileEntries.push({ uri, functions });
    }));
    pct.range(0, 40, Math.min(si + FILE_PARALLEL, uniqueUris.length), uniqueUris.length);
  }

  // フェーズ2: ファイルを FILE_PARALLEL 個ずつ並列で処理する。
  // A: 従来はファイルをシリアル処理していたが、FILE_PARALLEL=3 の並列化で
  //    大規模プロジェクトでは最大 ~3x のスループット向上が見込める。
  //    各ファイルの adaptive delay は独立して管理するため、エラー回復も正常に動作する。
  //    JS は単一スレッドなので nodes/edgeSet への同時書き込みも安全（race なし）。
  // BUG-11: FILE_PARALLEL は関数先頭で宣言済み。

  // ★ Fix-Canceled: clangd が indexing 中に "Canceled" を返した関数をファイル単位で収集し、
  //   フェーズ2 完了後に CANCELED_RETRY_DELAY ms 待機してから再処理する。
  //   これにより indexing 完了前の一時的な Canceled ワーニングを解消する。
  const canceledFuncsByFile = new Map<string, { uri: vscode.Uri; funcs: vscode.DocumentSymbol[] }>();

  for (let fi = 0; fi < fileEntries.length; fi += FILE_PARALLEL) {
    checkCancellation(token);
    pct.range(40, 100, fi, fileEntries.length);

    await Promise.all(fileEntries.slice(fi, fi + FILE_PARALLEL).map(async ({ uri, functions }) => {
      let adaptiveDelay  = BATCH_DELAY_INIT;
      const wsFileStreak = { val: 0 }; // D: 連続成功カウンタ (nextAdaptiveDelay 用)
      const canceledFuncs: vscode.DocumentSymbol[] = []; // ★ Fix-Canceled: Canceled 関数を収集

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
              let calleeId = findExistingCalleeId(nodes, nodeIndex, to);
              if (!calleeId) {
                if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
                calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
                if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                  // Bug① 修正: 外側の nodes.has チェック済みのため内側の重複チェックを削除。
                  // JSシングルスレッドにより await のない同期ブロック内で他コルーチンは割り込まない。
                  processingIds.add(calleeId);
                  const calleeNode: GraphNode = {
                    id:            calleeId,
                    label:         baseNameOf(to.name),
                    labelFull:     to.name,
                    file:          to.uri.fsPath,
                    line:          to.selectionRange.start.line + 1,
                    scopeEnd:      to.range.end.line + 1,
                    isCurrentFile: false,
                  };
                  nodes.set(calleeId, calleeNode);
                  addToNodeIndex(nodeIndex, calleeId, calleeNode);
                }
              }
              edgeSet.add(`${callerId}|||${calleeId}`);
            }
          } catch (err) {
            if (err instanceof vscode.CancellationError) throw err;
            errorsInBatch++;
            // ★ Fix-Canceled: clangd の Canceled はリトライ候補に追加し、errs には積まない
            if (isCanceledByClangd(err)) {
              canceledFuncs.push(func);
            } else {
              errs.push(`${path.basename(uri.fsPath)}::${func.name}: ${String(err)}`);
            }
          }
        }));

        // ① adaptive delay (D: nextAdaptiveDelay で連続成功時に急速収束)
        adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, errorsInBatch > 0, wsFileStreak);
        if (adaptiveDelay > 0 && i + BATCH_SIZE < functions.length) await delay(adaptiveDelay);
      }

      // ★ Fix-Canceled: Canceled 関数が残っていればリトライ候補マップに登録
      if (canceledFuncs.length > 0) {
        canceledFuncsByFile.set(uri.fsPath, { uri, funcs: canceledFuncs });
      }
    }));
  }

  // ★ Fix-Canceled: フェーズ2 ファイルレベルリトライ
  // clangd indexing が完了するまで CANCELED_RETRY_DELAY ms 待機してから再処理する。
  // リトライ後も失敗した場合のみ errs に追加する（真のエラーのみワーニング表示）。
  if (canceledFuncsByFile.size > 0) {
    await delay(CANCELED_RETRY_DELAY);
    checkCancellation(token);

    for (const { uri, funcs } of canceledFuncsByFile.values()) {
      checkCancellation(token);
      const fileBase     = path.basename(uri.fsPath);
      let adaptiveDelay  = BATCH_DELAY_INIT;
      const wsFileStreak = { val: 0 };

      for (let i = 0; i < funcs.length; i += BATCH_SIZE) {
        checkCancellation(token);
        const processingIds = new Set<string>();
        let   errorsInBatch = 0;

        await Promise.all(funcs.slice(i, i + BATCH_SIZE).map(async (func) => {
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
              let calleeId = findExistingCalleeId(nodes, nodeIndex, to);
              if (!calleeId) {
                if (!shouldIncludeCallee(to.uri, wsRoots)) continue;
                calleeId = makeNodeId(to.uri, to.name, to.selectionRange.start.line);
                if (!nodes.has(calleeId) && !processingIds.has(calleeId)) {
                  processingIds.add(calleeId);
                  const calleeNode: GraphNode = {
                    id:            calleeId,
                    label:         baseNameOf(to.name),
                    labelFull:     to.name,
                    file:          to.uri.fsPath,
                    line:          to.selectionRange.start.line + 1,
                    scopeEnd:      to.range.end.line + 1,
                    isCurrentFile: false,
                  };
                  nodes.set(calleeId, calleeNode);
                  addToNodeIndex(nodeIndex, calleeId, calleeNode);
                }
              }
              edgeSet.add(`${callerId}|||${calleeId}`);
            }
          } catch (err) {
            if (err instanceof vscode.CancellationError) throw err;
            errorsInBatch++;
            // リトライ後も失敗した場合のみ errs に追加する
            errs.push(`${fileBase}::${func.name}: ${String(err)}`);
          }
        }));

        adaptiveDelay = nextAdaptiveDelay(adaptiveDelay, errorsInBatch > 0, wsFileStreak);
        if (adaptiveDelay > 0 && i + BATCH_SIZE < funcs.length) await delay(adaptiveDelay);
      }
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

/**
 * パフォーマンス改善②: vscode.workspace.findFiles の結果を FILES_CACHE_TTL_MS キャッシュする。
 * wsRoot ごとに独立したキャッシュエントリを持つ。
 */
// F: findFiles はワークスペース全体を返すため wsRoot キーは実質無意味。
// 固定キーを使い、全 wsRoot からの呼び出しが同一エントリを共有するようにする。
const WORKSPACE_FILES_KEY = '__workspace__';

async function findFilesCached(): Promise<vscode.Uri[]> {
  const now    = Date.now();
  const cached = filesCache.get(WORKSPACE_FILES_KEY);
  if (cached && now - cached.timestamp < FILES_CACHE_TTL_MS) return cached.uris;
  const uris = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);
  filesCache.set(WORKSPACE_FILES_KEY, { uris, timestamp: now });
  return uris;
}

/**
 * パフォーマンス改善①: collectGtags の結果を TAGS_CACHE_TTL_MS キャッシュする。
 *
 * 【Before】毎回 global -x -e '.' を実行 → 大規模プロジェクトで数十秒
 * 【After】 2回目以降はキャッシュから即座に返す → ほぼ 0ms
 *
 * lineCache は毎回空で返す (ファイル内容はビルド関数側で都度読む)。
 * タグマップ自体は読み取り専用で参照するため共有しても安全。
 */
async function collectGtagsCached(wsRoot: string): Promise<{
  tags:           Map<string, GtagEntry[]>;
  lineCache:      Map<string, string[]>;
  ambiguousNames: string[];
  scopeMap:       Map<string, ScopeMapEntry>; // B: キャッシュ済みスコープマップ
}> {
  const now    = Date.now();
  const cached = tagsCache.get(wsRoot);
  if (cached && now - cached.timestamp < TAGS_CACHE_TTL_MS) {
    return {
      tags:           cached.tags,
      lineCache:      new Map(),
      ambiguousNames: cached.ambiguousNames,
      scopeMap:       cached.scopeMap,    // B: キャッシュヒット時もそのまま返す
    };
  }
  const allUris  = await findFilesCached();
  const result   = await collectGtags(allUris.map(u => u.fsPath), wsRoot);
  // B: buildGtagsScopeMap はタグから決定的に生成できるため、タグと一緒にキャッシュする。
  //   以降の build 関数は scopeMap を受け取るだけでよく、再計算コストがゼロになる。
  const scopeMap = buildGtagsScopeMap(result.tags);
  tagsCache.set(wsRoot, {
    tags:           result.tags,
    ambiguousNames: result.ambiguousNames,
    scopeMap,
    timestamp:      now,
  });
  return { ...result, scopeMap };
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
        await runGtagsWithDotfilesCompat(wsRoot);
        gtagsUpdateCache.set(wsRoot, now);
      } catch (rebuildErr) {
        // リビルドも失敗したら警告を返して古いタグで続行 (BugFix F の挙動を維持)
        return spawnErrorMessage('global -u / gtags rebuild', rebuildErr);
      }
    }
  } else {
    try {
      await runGtagsWithDotfilesCompat(wsRoot);
    } catch (initErr) {
      return spawnErrorMessage('gtags', initErr);
    }
    gtagsUpdateCache.set(wsRoot, now);
  }
  return undefined;
}

/**
 * BUG-5 修正: GNU GLOBAL のバージョン互換を考慮した gtags 実行ヘルパー。
 * --accept-dotfiles は 6.5 以降のオプション。Ubuntu 20.04 の標準パッケージ (6.3 系) など
 * 旧バージョンでは "unrecognized option" で終了コード 1 になるため、
 * 失敗した場合はオプションなしで再試行する。
 */
async function runGtagsWithDotfilesCompat(wsRoot: string): Promise<void> {
  try {
    await execFileAsync('gtags', ['--accept-dotfiles'], { cwd: wsRoot, timeout: 120_000 });
  } catch (err) {
    const msg = String(err);
    // --accept-dotfiles 未サポートの場合のみフォールバック
    if (/unrecognized option|invalid option|unknown option/i.test(msg)) {
      await execFileAsync('gtags', [], { cwd: wsRoot, timeout: 120_000 });
    } else {
      throw err;
    }
  }
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
  // Bug③ 修正: 一次チェックも normalizeFsPath で大文字小文字を統一する。
  // Windows (大文字小文字無視 FS) でパスが混在しても正しく判定できるようにする。
  const fpNorm      = normalizeFsPath(fp);
  const wsRootNorm  = normalizeFsPath(wsRoot);
  const wsRootSlash = wsRootNorm.endsWith(path.sep) ? wsRootNorm : wsRootNorm + path.sep;
  // 一次チェック: 正規化済みパス文字列によるプレフィックス検証
  if (!(fpNorm.startsWith(wsRootSlash) || fpNorm === wsRootNorm)) return null;
  // 二次チェック (Security②): シンボリックリンクを解決して実パスで再検証。
  // ワークスペース内のシンボリックリンク → ワークスペース外ファイル のトラバーサルを防ぐ。
  try {
    // H: realpathSync 結果をキャッシュ。wsRoot は不変、fp も繰り返し出現するため効果大。
    const realFp = realpathCache.get(fp) ?? (() => {
      const r = fs.realpathSync(fp); setRealpathCache(fp, r); return r;
    })();
    const realRoot = realpathCache.get(wsRoot) ?? (() => {
      const r = fs.realpathSync(wsRoot); setRealpathCache(wsRoot, r); return r;
    })();
    const realFpNorm   = normalizeFsPath(realFp);
    const realRootNorm = normalizeFsPath(realRoot);
    const realSlash    = realRootNorm.endsWith(path.sep) ? realRootNorm : realRootNorm + path.sep;
    if (!(realFpNorm.startsWith(realSlash) || realFpNorm === realRootNorm)) return null;
  } catch {
    // ファイルが存在しない / 解決不能な場合は安全のため除外
    return null;
  }
  return fp;
}

/**
 * BUG-4 修正: マルチルートワークスペース対応の sanitize ヘルパー。
 * LSP バックエンドでは全ワークスペースフォルダが callee 対象になるが、
 * gtags バックエンドは単一 wsRoot のみ対象だった非対称を修正する。
 * wsRoots の中の任意のルートに含まれるパスを受け入れる。
 * wsRoots が空の場合は単一 wsRoot にフォールバックする。
 */
function sanitizeToAnyWsRoot(rawPath: string, wsRoots: string[]): string | null {
  for (const root of wsRoots) {
    const result = sanitizeToWsRoot(rawPath, root);
    if (result !== null) return result;
  }
  return null;
}

/**
 * `global -f <file>` を実行してそのファイルで定義されているタグを取得。
 * per-file フォールバックパスおよび buildScopeForFileCached で使用する。
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

/** ファイルを行配列で読み込み、キャッシュする（同期版・キャッシュヒット専用） */
function readFileLinesCached(filePath: string, cache: Map<string, string[]>): string[] {
  if (cache.has(filePath)) return cache.get(filePath)!;
  // ⑤ Performance 修正: 同期I/Oは廃止し空配列を返す。
  // 呼び出し元は事前に prefetchFileLines / getFileLinesAsync でキャッシュを温めること。
  // フォールバックとして同期読み込みを残すと大規模プロジェクトでホストをブロックするため削除。
  // BUG-2 派生修正: キャッシュミス時に空配列をキャッシュしない。
  // キャッシュすると同一ビルド内でそのファイルの呼び出し関係が欠落し続ける。
  return [];
}

/**
 * ⑤ Performance 追加: 非同期ファイル行読み込み。
 * キャッシュヒット時は即座に返し、ミス時のみ fs.promises.readFile で非同期読み込みする。
 * BFS ループ・buildScopeForFileCached など async コンテキストで使用する。
 */
async function getFileLinesAsync(filePath: string, cache: Map<string, string[]>): Promise<string[]> {
  if (cache.has(filePath)) return cache.get(filePath)!;
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines   = content.split('\n');
    cache.set(filePath, lines);
    return lines;
  } catch {
    // BUG-2 修正: 一時的な I/O エラー（ファイルロック等）を永続キャッシュしない。
    // キャッシュすると lazyTagCache 経由でモジュールレベルに残り、TTL 内ずっとそのファイルが
    // グラフから消える。エラー時はキャッシュせず空配列だけ返す。
    return [];
  }
}

/**
 * ⑤ Performance 追加: 必要なファイルを事前に並列プリフェッチしてキャッシュを温める。
 * collectGtags のフォールバックパスなど「直後に同期読みが走る」箇所で呼ぶ。
 */
async function prefetchFileLines(files: readonly string[], cache: Map<string, string[]>): Promise<void> {
  const needed = [...new Set(files)].filter(f => !cache.has(f));
  if (needed.length === 0) return;
  await Promise.all(needed.map(f => getFileLinesAsync(f, cache)));
}

/**
 * 【③】`global -x -e '.'` を1回実行してすべての定義タグを一括取得。
 * GNU Global 5.0 以降が必要 (-e で POSIX ERE を有効化)。
 * ソース行は global 出力に含まれるためファイルを読まない。
 * 出力形式: name<ws>line<ws>file<ws>source_line
 *
 * 【maxBuffer について】
 *   SEC-02 修正により 256MB を設定している（旧 High-3 コメントの「50MB」は廃止済み）。
 *   50MB では大規模プロジェクトで RangeError が発生しタグ収集が全滅していた。
 *   256MB を超えるプロジェクトには spawn + readline によるストリーム処理への移行を推奨。
 */
async function runGlobalXAll(
  wsRoot: string
): Promise<Array<{ name: string; line: number; file: string; sourceLine: string }>> {
  const { stdout } = await execFileAsync('global', ['-x', '-e', '.'], {
    cwd: wsRoot, maxBuffer: 256 * 1024 * 1024, timeout: 120_000, // SEC-02: 256MB (詳細は JSDoc 参照)
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
    // B-2: Math.max(1, ...) を除去。files.length=0 の場合ループは自然に空回りする
    const CONCURRENT = Math.min(16, files.length);
    for (let i = 0; i < files.length; i += CONCURRENT) {
      const results = await Promise.all(
        files.slice(i, i + CONCURRENT).map(f => runGlobalF(f, wsRoot))
      );
      for (const entries of results) perFileResults.push(...entries);
    }
    rawEntries = perFileResults.map(e => ({ ...e, sourceLine: '' }));
  }

  const rawMap = new Map<string, RawEntry[]>();
  // PERF-01 修正: 数万行のエントリを逐行処理するとイベントループがブロックされる。
  // 10000 件ごとに setImmediate で制御を返し VS Code の応答性を維持する。
  for (let i = 0; i < rawEntries.length; i++) {
    if (i > 0 && i % 10_000 === 0) await new Promise<void>(r => setImmediate(r));
    const e = rawEntries[i];
    if (!rawMap.has(e.name)) rawMap.set(e.name, []);
    rawMap.get(e.name)!.push(e);
  }

  const tags           = new Map<string, GtagEntry[]>();
  const ambiguousNames: string[] = [];

  // ⑤ Performance 修正: sourceLine が空のエントリのファイルを事前に並列プリフェッチ。
  // フォールバックパス (per-file global -f) では sourceLine が常に空のため、
  // ここで非同期プリフェッチしておくことで後続の readFileLinesCached がキャッシュヒットする。
  {
    const filesNeedingRead: string[] = [];
    for (const [, candidates] of rawMap) {
      for (const cand of candidates) {
        if (!cand.sourceLine) filesNeedingRead.push(cand.file);
      }
    }
    await prefetchFileLines(filesNeedingRead, lineCache);
  }

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
  selfName: string, knownTags?: Set<string>
): Set<string> {
  const callees        = new Set<string>();
  const re             = /\b([A-Za-z_]\w*)\s*\(/g;
  let   inBlockComment = false;
  let   rawDelimiter   = '';   // Feat③: RAW文字列の終端デリミタ。空文字列なら非RAW状態

  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    const line = lines[i];
    let   processed: string[] = []; // A: string += ch は O(n²) → 配列 + join('') で O(n) に
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
          processed.push(ch);
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
        processed.push(ch);
        j++;
      }
    }

    const processedStr = processed.join('');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(processedStr)) !== null) {
      const callee = m[1];
      // knownTags が指定されている場合のみフィルタ (省略時は全候補を返す)
      if (callee !== selfName && (!knownTags || knownTags.has(callee))) callees.add(callee);
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

/**
 * gtags ノード ID を (file, name, line) から生成する。
 *
 * B-4: セパレータに \x00 (NUL) を使用する。
 *   旧実装の '||' は C++ の operator|| などの演算子関数名に含まれるため、
 *   parseGtagsNodeId が誤って分割する問題があった。
 *   NUL はファイルパス・C/C++ 関数名のいずれにも含まれない文字なので安全。
 */
function makeGtagsNodeId(file: string, name: string, line: number): string {
  return `${file}\x00${name}\x00${line}`;
}

/**
 * nodeId を (file, name, line) に分解する。
 * \x00 セパレータで単純分割するため operator|| などを含む名前も正しく処理できる。
 */
function parseGtagsNodeId(id: string): { file: string; name: string; line: number } {
  const first = id.indexOf('\x00');
  const last  = id.lastIndexOf('\x00');
  return {
    file: id.slice(0, first),
    name: id.slice(first + 1, last),
    line: parseInt(id.slice(last + 1), 10),
  };
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
 * 【Precision ①】global -rx -e '^(func1|func2|...)$' を buildPatternBatches で動的分割し、
 * GLOBAL_RX_PARALLEL 個ずつ並列実行してエッジセットを構築する。
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
  errs:        string[] = [],  // ① 修正: エラー記録用配列を追加
  wsRoots?:    string[],       // BUG-4 修正: マルチルート対応 (未指定時は wsRoot のみ)
): Promise<Set<string>> {
  // BUG-4: wsRoots が渡されていない場合は単一 wsRoot で動作 (後方互換)
  const effectiveRoots = (wsRoots && wsRoots.length > 0) ? wsRoots : [wsRoot];
  const edgeSet = new Set<string>();

  // isFunc エントリを持つ関数名のみ対象にする
  const funcNames = Array.from(tags.entries())
    .filter(([, entries]) => entries.some(e => e.isFunc))
    .map(([name]) => name);

  // ④ buildPatternBatches で動的長さベース分割 + GLOBAL_RX_PARALLEL 個ずつ並列実行
  // 旧実装: 固定件数 GLOBAL_RX_BATCH=100 で分割 → 長い C++ テンプレート名で MAX_PATTERN_LENGTH 超過の恐れ
  // 新実装: buildPatternBatches で長さベース分割 (S-3 完全適用) + アンカー付き (B-2 完全適用)
  const patterns    = buildPatternBatches(funcNames);
  const totalGroups = Math.ceil(patterns.length / GLOBAL_RX_PARALLEL);

  // Warning修正: 同一エラーを集約するための一時セット。
  // global -rx -e がすべてのバッチで同じ理由（-e 未サポート等）で失敗する場合に
  // 同一メッセージが N 件 push されるのを防ぐ。
  const errorMessages = new Set<string>();

  for (let gi = 0; gi < patterns.length; gi += GLOBAL_RX_PARALLEL) {
    checkCancellation(token);
    pct?.range(startPct, endPct, Math.floor(gi / GLOBAL_RX_PARALLEL), totalGroups);

    await Promise.all(patterns.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async pattern => {
      let stdout = '';
      try {
        ({ stdout } = await execFileAsync('global', ['-rx', '-e', pattern], {
          cwd: wsRoot, maxBuffer: 50 * 1024 * 1024, timeout: 60_000,
        }));
      } catch (e) {
        // Warning修正: エラーを集約 (重複除去)。
        //   GNU GLOBAL < 5.0 で -e フラグ非サポートの場合は全バッチが同じエラーになるため、
        //   同一メッセージを1件に絞ってユーザーへの警告量を最小化する。
        //   キャンセルによる中断は警告として報告しない。
        const ex  = e as NodeJS.ErrnoException & { killed?: boolean };
        const msg = ex instanceof Error ? ex.message : String(ex);
        // SEC-3 修正: SIGTERM 文字列マッチ → .killed フラグで確実にタイムアウトを検出
        if (ex.killed || msg.includes('cancel')) { return; }
        // BUG-6 修正: maxBuffer 超過は「グラフが不完全」とユーザーに明示する
        if (msg.includes('maxBuffer') || msg.includes('STDIO_MAXBUFFER') || msg.includes('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
          errorMessages.add(
            '[gtags] global -rx: Output too large (>50MB). ' +
            'Some call edges may be missing. ' +
            'Consider splitting the analysis with Folder Graph.'
          );
          return;
        }
        const firstLine = msg.split('\n')[0];
        // -e フラグ未サポートの場合に分かりやすいメッセージに変換する
        const isUnsupportedE = /invalid option|unknown option|illegal option/i.test(firstLine);
        const normalized = isUnsupportedE
          ? 'global -rx: -e flag not supported (GNU GLOBAL < 5.0). ' +
            'Using regex fallback for callee detection. Upgrade to GLOBAL 5.0+ for better accuracy.'
          : `global -rx: ${firstLine}`;
        errorMessages.add(normalized);
        return;
      }

      for (const rawLine of stdout.split('\n')) {
        const parts = rawLine.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const calleeName = parts[0];
        const refLine    = parseInt(parts[1], 10);
        if (!calleeName || isNaN(refLine)) continue;
        const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots); // Security H + BUG-4
        if (!refFile || !callerFiles.has(refFile)) continue;
      // 🔴 Bug 4 修正: scopeMap のキーと refFile のパスは取得経路が異なるため
      //   macOS/Windows でパス大文字小文字・区切り文字が不一致になることがある。
      //   findScopeMapEntry() はこの差異を吸収するために実装されており、
      //   他箇所では正しく使われていたがこの3箇所だけ漏れていた。
      const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
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
  // Warning修正: 集約したエラーメッセージを errs に追加する。
  // ループ内で都度 push すると同一エラーが N 件になるためループ外でまとめて push する。
  for (const msg of errorMessages) errs.push(msg);
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
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoot  = getWorkspaceRootForFile(document.uri); // gtags DB 操作用 (単一ルート)
  if (!wsRoot) throw new Error('No workspace folder is open.');
  // BUG-4 修正: callee フィルタには全ワークスペースフォルダを使用 (LSP バックエンドと統一)
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  // ★ Precision ③: ヘッダーも含めてタグを収集 (inline 関数・テンプレートを callee ノードとして登録)
  pct.to(5);
  pct.report('📂 Loading tags...');
  const { tags, lineCache, ambiguousNames, scopeMap } = await collectGtagsCached(wsRoot);
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

  // B: scopeMap は collectGtagsCached がキャッシュ済みのものを返す（再計算なし）
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
  const edgeSet = await buildEdgesGlobalRx(callerFiles, tags, scopeMap, wsRoot, token, pct, 20, 75, errs, wsRoots);

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
  //
  // 🐛 gtags ファイルグラフ修正:
  //   旧実装はコアノード（ファイル内関数）を downVisited に先行登録し、
  //   「buildEdgesGlobalRx で処理済み」としてキューから除外していた。
  //   しかし global -rx -e が失敗（GNU GLOBAL < 5.0 等）して edgeSet が空の場合、
  //   コアノードは一切処理されず extractCallsFromLines フォールバックも走らないため、
  //   エッジゼロ → 全ノード level=0 → 縦1列になっていた。
  //   先行登録を削除し、コアノードも通常の BFS キューで処理するよう修正する。
  //   edgeSet が非空の場合でも Set の冪等性（重複エッジは無視）により正確性は維持される。
  pct.to(75);
  {
    const knownTags   = new Set(tags.keys());
    const downVisited = new Set<string>();

    // buildEdgesGlobalRx で発見されたノード＋コアノードをまとめてキューに積む
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

    let dqi = 0; // D: shift() O(n) → インデックスポインタ O(1)
    while (dqi < downQueue.length) {
      checkCancellation(token);
      const { name, entry, scope } = downQueue[dqi++];
      const callerId = makeGtagsNodeId(entry.file, name, entry.line);

      // ⑤ Performance 修正: readFileLinesCached (同期) → getFileLinesAsync (非同期)
      const lines   = await getFileLinesAsync(entry.file, lineCache);
      const callees = extractCallsFromLines(lines, scope.start, scope.end, name, knownTags);

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
      pct.bfsQ(75, 88, downVisited, { length: downQueue.length - dqi });
    }
  }

  // ── 上方向 BFS (caller) ──────────────────────────────────────────────────
  // ファイル内の全コア関数を起点に global -rx で呼び出し元を遡る。
  // 深さ制限なし（upVisited でサイクル防止）。main() などルートまで到達したら終了。
  // buildPathThroughCallGraphGtags の上方向 BFS と同じロジックを使用。
  // I-1: runGlobalRxSingle (1 関数ずつシリアル) → runGlobalRxBatch (レベル単位バッチ) に変更。
  pct.to(88);
  {
    type UpItem = {
      funcName: string;  // この関数への参照を global -rx で探す
      calleeId: string;  // エッジの下流側 nodeId
    };

    // コアノード（ファイル内関数）を全て初期レベルとして積む
    const upVisited = new Set<string>();
    let upCurrentLevel: UpItem[] = [];

    for (const scope of fileScopes) {
      const entry = tags.get(scope.name)?.find(
        e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
      if (!entry) continue;
      const coreId = makeGtagsNodeId(entry.file, scope.name, entry.line);
      upVisited.add(coreId);
      upCurrentLevel.push({ funcName: scope.name, calleeId: coreId });
    }

    // レベル別 BFS: 1 レベル = 1 バッチクエリ (runGlobalRxSingle × N → runGlobalRxBatch × 1)
    while (upCurrentLevel.length > 0) {
      checkCancellation(token);

      const levelFuncNames = upCurrentLevel.map(item => item.funcName);
      const refMap = await runGlobalRxBatch(levelFuncNames, wsRoot, errs, wsRoots);
      const upNextLevel: UpItem[] = [];

      for (const { funcName, calleeId } of upCurrentLevel) {
        for (const { refFile, refLine } of refMap.get(funcName) ?? []) {
          checkCancellation(token);

        // 🔴 Bug 4 修正: scopeMap のキーと refFile のパスは取得経路が異なるため
      //   macOS/Windows でパス大文字小文字・区切り文字が不一致になることがある。
      //   findScopeMapEntry() はこの差異を吸収するために実装されており、
      //   他箇所では正しく使われていたがこの3箇所だけ漏れていた。
      const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
          if (!fileScopeEntry) continue;
          const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
          if (!callerScope || callerScope.name === funcName) continue; // 自己再帰を除外

          // Precision ②: refFile 優先で caller エントリを解決
          const callerEntry =
            tags.get(callerScope.name)?.find(e => e.file === refFile && e.isFunc)
            ?? resolveCallee(tags.get(callerScope.name), refFile);
          if (!callerEntry) continue;

          const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
          edgeSet.add(`${callerId}|||${calleeId}`);

          if (!nodes.has(callerId)) {
            nodes.set(callerId, gtagsEntryToNode(
              callerScope.name, callerEntry, callerScope, currentFile));
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
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName:    path.basename(currentFile),
    buildTimeMs: Date.now() - t0,
    errors:      errs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  遅延ローディング用ヘルパー (buildFunctionCallGraphGtags 専用)
//
// 【高速化】buildFunctionCallGraphGtags の旧実装は collectGtagsCached (global -x -e '.')
//   と buildGtagsScopeMap でプロジェクト全体を事前ロードしていたため、
//   大規模プロジェクトでは 1 関数起点のグラフでも 2 分以上かかっていた。
//
//   新実装は BFS を進めながら必要な関数・ファイルだけをオンデマンドでクエリする:
//     runGlobalXNames  : global -x -e 'func1|func2|...' で複数定義を一括取得
//     buildScopeForFileCached : global -f <file> でそのファイルのスコープだけ構築
//     extractRawCallCandidates: knownTags フィルタなしで候補抽出 → runGlobalXNames で検証
//
//   これにより訪問した関数・ファイル数に比例した処理量に抑え、数秒以内を目指す。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * B-2 + S-3: アンカー付き ERE パターンのバッチ配列を生成する。
 *
 * - ^ と $ アンカーで部分一致を防止する (B-2)。
 *   例: 'func1' が 'func1_helper' にマッチしなくなる。
 * - MAX_PATTERN_LENGTH を超えないよう動的分割することで OS の ARG_MAX 超過を防ぐ (S-3)。
 * - runGlobalXNames と runGlobalRxBatch の両方で共用する。
 *
 * NOTE: ^ と $ アンカーは GNU Global 5.0 以降の POSIX ERE で動作する。
 */
const MAX_PATTERN_LENGTH = 50_000; // OS の ARG_MAX に対して十分な余裕を持たせた上限

function buildPatternBatches(names: string[]): string[] {
  if (names.length === 0) return [];
  const batches: string[] = [];
  let batch: string[] = [];
  // BUG-12 修正: `^(` と `)$` の計4文字分をラッパー長として初期値に加える。
  // 旧実装は 0 から始めており、生成パターンが MAX_PATTERN_LENGTH を超える可能性があった。
  const WRAPPER_LEN = 4; // '^(' + ')$'
  let len = WRAPPER_LEN;

  for (const name of names) {
    const escaped = escapeRegexForGlobal(name);
    // SEC-07 修正: 単一エントリが MAX_PATTERN_LENGTH を超える場合はスキップ（無限ループ防止）。
    // C++ のテンプレート特殊化など極端に長い関数名で buildPatternBatches が停止しなくなる問題を防ぐ。
    if (WRAPPER_LEN + escaped.length > MAX_PATTERN_LENGTH) continue;
    const add = (batch.length > 0 ? 1 : 0) + escaped.length; // 1 = '|' セパレータ
    if (len + add > MAX_PATTERN_LENGTH && batch.length > 0) {
      batches.push('^(' + batch.join('|') + ')$');
      batch = []; len = WRAPPER_LEN;
    }
    batch.push(escaped);
    len += add;
  }
  if (batch.length > 0) batches.push('^(' + batch.join('|') + ')$');
  return batches;
}

/**
 * 指定した関数名リストの定義エントリを global -x -e '^(func1|func2|...)$' で一括取得する。
 * runGlobalXAll の全ダンプ版に対する、部分クエリ版。
 * buildPatternBatches で動的分割した複数パターンを並列実行し Map<name, GtagEntry[]> で返す。
 */
async function runGlobalXNames(
  names:  string[],
  wsRoot: string,
  errs:   string[] = [], // BUG-22 修正: エラーを呼び出し元に伝搬
): Promise<Map<string, GtagEntry[]>> {
  const result = new Map<string, GtagEntry[]>();
  if (names.length === 0) return result;

  const patterns = buildPatternBatches(names); // B-2+S-3
  const errorMessages = new Set<string>(); // 重複除去

  await Promise.all(patterns.map(async pattern => {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('global', ['-x', '-e', pattern], {
        cwd: wsRoot, maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
      }));
    } catch (e) {
      // BUG-22 修正: サイレント握り潰しをやめて errs に記録
      // NEW-1 修正: SIGTERM 文字列マッチ → ex.killed フラグで確実にタイムアウトを検出
      const ex  = e as NodeJS.ErrnoException & { killed?: boolean };
      const msg = ex instanceof Error ? ex.message : String(ex);
      if (ex.killed || msg.includes('cancel')) { return; }
      errorMessages.add(`global -x: ${msg.split('\n')[0]}`);
      return;
    }

    for (const raw of stdout.split('\n')) {
      const trimmed = raw.trimEnd();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const [, name, lineStr, fileStr, sourceLine] = m;
      const line = parseInt(lineStr, 10);
      if (isNaN(line)) continue;
      const file = sanitizeToWsRoot(fileStr, wsRoot); // Security H
      if (!file) continue;
      const entry: GtagEntry = { name, file, line, sourceLine, isFunc: isLikelyFuncDef(sourceLine) };
      if (!result.has(name)) result.set(name, []);
      result.get(name)!.push(entry);
    }
  }));

  // V3-2 修正: runGlobalRxBatch と同様に、収集したエラーを呼び出し元の errs に転送する。
  // これがないと BUG-22 修正コメントの「errs に伝搬する」が実装されていない状態になる。
  for (const msg of errorMessages) errs.push(msg);
  return result;
}

/**
 * tagCache に name のエントリがあれば返し、なければ runGlobalXNames でフェッチしてキャッシュする。
 * キャッシュミス時の二重フェッチを防ぐため、未ヒット時は空配列もキャッシュする。
 */
async function resolveOrFetchTag(
  name:     string,
  wsRoot:   string,
  tagCache: Map<string, GtagEntry[]>,
  errs:     string[] = [], // NEW-3: global -x エラーを呼び出し元に伝搬
): Promise<GtagEntry[] | undefined> {
  if (tagCache.has(name)) {
    const cached = tagCache.get(name)!;
    return cached.length > 0 ? cached : undefined;
  }
  const resolved = await runGlobalXNames([name], wsRoot, errs);
  const entries  = resolved.get(name) ?? [];
  tagCache.set(name, entries); // 空配列もキャッシュして再フェッチを防止
  return entries.length > 0 ? entries : undefined;
}

/**
 * global -f <file> を使って fileScopeCache に ScopeMapEntry を構築して返す。
 * isFunc 判定のため lineCache からファイル行を読む（未保存変更も反映される）。
 *
 * @param file         対象ファイルの絶対パス
 * @param wsRoot       GTAGS のあるワークスペースルート
 * @param scopeCache   ビルド内で共有するスコープキャッシュ
 * @param lineCache    ビルド内で共有する行キャッシュ
 */
async function buildScopeForFileCached(
  file:       string,
  wsRoot:     string,
  scopeCache: Map<string, ScopeMapEntry>,
  lineCache:  Map<string, string[]>,
): Promise<ScopeMapEntry | undefined> {
  const norm = normalizeFsPath(file);
  const hit  = scopeCache.get(norm) ?? scopeCache.get(file);
  if (hit) return hit;

  const tagEntries = await runGlobalF(file, wsRoot);
  if (!tagEntries.length) return undefined;

  // ⑤ Performance 修正: fs.readFileSync → getFileLinesAsync で非同期読み込み
  const lines = await getFileLinesAsync(file, lineCache);
  // B-3: 正規化パスも lineCache に登録してキャッシュヒット率を向上させる
  if (norm !== file && !lineCache.has(norm)) lineCache.set(norm, lines);
  const funcEntries: { name: string; line: number }[] = [];
  for (const { name, line } of tagEntries) {
    const sourceLine = lines[line - 1]?.trimEnd() ?? '';
    if (isLikelyFuncDef(sourceLine)) funcEntries.push({ name, line });
  }
  if (!funcEntries.length) return undefined;

  funcEntries.sort((a, b) => a.line - b.line);
  const list: ScopeEntry[] = funcEntries.map((e, i) => ({
    name:  e.name,
    start: e.line,
    end:   i + 1 < funcEntries.length ? funcEntries[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
  }));
  const byName = new Map<string, ScopeEntry>();
  for (const s of list) {
    if (!byName.has(s.name)) byName.set(s.name, s); // 先勝ち (行番号が小さい定義を優先)
  }
  const entry: ScopeMapEntry = { list, byName };
  // 正規化・非正規化の両キーで登録してヒット率を上げる
  scopeCache.set(norm, entry);
  scopeCache.set(file, entry);
  return entry;
}

async function buildFunctionCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoot  = getWorkspaceRootForFile(document.uri); // gtags DB 操作用 (単一ルート)
  if (!wsRoot) throw new Error('No workspace folder is open.');
  // NEW-2: 上方向 BFS でもマルチルートのファイルを caller として検出できるよう wsRoots を取得
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  // ── モジュールレベルキャッシュを取得 (I-2) ──────────────────────────────────
  // TTL 内であれば前回ビルドの tagCache / fileScopeCache が再利用され 2 回目以降が高速化される。
  // lineCache はビルド内ローカルのまま (document.getText() の未保存変更を反映するため)。
  const now = Date.now();
  let lazyTagEntry = lazyTagCache.get(wsRoot);
  if (!lazyTagEntry || now - lazyTagEntry.timestamp > LAZY_CACHE_TTL_MS) {
    lazyTagEntry = { entries: new Map(), timestamp: now };
    lazyTagCache.set(wsRoot, lazyTagEntry);
  }
  const tagCache = lazyTagEntry.entries;

  let lazyScopeEntry = lazyScopeCache.get(wsRoot);
  if (!lazyScopeEntry || now - lazyScopeEntry.timestamp > LAZY_CACHE_TTL_MS) {
    lazyScopeEntry = { scopes: new Map(), timestamp: now };
    lazyScopeCache.set(wsRoot, lazyScopeEntry);
  }
  const fileScopeCache = lazyScopeEntry.scopes;

  const lineCache: Map<string, string[]> = new Map(); // ビルド内ローカル

  // 現在ファイルの行は document から取得 (未保存変更を反映)
  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  const currentLines    = document.getText().split('\n');
  lineCache.set(currentFile, currentLines);
  lineCache.set(currentFileNorm, currentLines);

  // ── 起点関数を特定 ──────────────────────────────────────────────────────────
  pct.to(5);
  checkCancellation(token);
  pct.report('🔍 Finding start function...');

  // global -f で現在ファイルのスコープのみ構築 (全ダンプ不要)
  const startFileScopeEntry = await buildScopeForFileCached(
    currentFile, wsRoot, fileScopeCache, lineCache);
  if (!startFileScopeEntry?.list.length) throw new Error(
    'No functions found in this file.');

  const cursorLine = position.line + 1;
  const startScope = findScopeAtLine(startFileScopeEntry.list, cursorLine);
  if (!startScope) throw new Error(
    'No function found at cursor position.\nPlace the cursor on a function name and try again.');

  // global -x で起点関数のエントリだけを取得 (全ダンプ不要)
  const startCandidates = await resolveOrFetchTag(startScope.name, wsRoot, tagCache, errs);
  const startEntry =
    startCandidates?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc)
    ?? startCandidates?.find(e => e.isFunc)
    ?? startCandidates?.[0];
  if (!startEntry) throw new Error('Tag info for the start function was not found.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // ── 下方向 BFS (callee) ──────────────────────────────────────────────────────
  // 【BugFix G 維持】visited (処理完了) と queued (投入済み) を分離して退行バグを防止。
  pct.to(15);
  pct.report('⬇ Building callee graph...');
  checkCancellation(token);

  const startNodeId = makeGtagsNodeId(startEntry.file, startScope.name, startEntry.line);
  type Q = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
  const visited = new Set<string>();
  const queued  = new Set<string>([startNodeId]);
  const queue: Q[] = [{ name: startScope.name, entry: startEntry, scope: startScope, hop: 0 }];
  let qi = 0; // D: shift() O(n) → インデックスポインタ O(1)

  while (qi < queue.length) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue[qi++];
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    // ⑤ Performance 修正: readFileLinesCached (同期) → getFileLinesAsync (非同期)
    const lines = await getFileLinesAsync(entry.file, lineCache);
    nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
    if (hop >= maxHops) continue;

    // ① knownTags なしで callee 候補識別子を抽出 → runGlobalXNames で後検証
    const rawCandidates = extractCallsFromLines(lines, scope.start, scope.end, name);
    if (rawCandidates.size === 0) continue;

    // ② キャッシュ未ヒット分だけ global -x でバッチ取得 (buildPatternBatches で動的分割・並列実行)
    const uncached = [...rawCandidates].filter(c => !tagCache.has(c));
    if (uncached.length > 0) {
      const freshMap = await runGlobalXNames(uncached, wsRoot, errs);
      for (const [n, entries] of freshMap) tagCache.set(n, entries);
      // GTAGS に存在しなかった候補は空エントリをキャッシュして再クエリを防止
      for (const n of uncached) { if (!tagCache.has(n)) tagCache.set(n, []); }
    }

    // ③ 解決済みエントリからエッジを生成 (I-3: ファイルスコープを並列プリフェッチ)
    type ResolvedCallee = { callee: string; calleeEntry: GtagEntry };
    const resolvedCallees: ResolvedCallee[] = [];
    for (const callee of rawCandidates) {
      const calleeEntry = resolveCallee(tagCache.get(callee), entry.file);
      if (!calleeEntry?.isFunc) continue;
      resolvedCallees.push({ callee, calleeEntry });
    }

    // 必要なファイルのスコープを並列プリフェッチ (キャッシュ済みなら即返る)
    const uniqueCalleeFiles = [...new Set(resolvedCallees.map(c => c.calleeEntry.file))];
    await Promise.all(uniqueCalleeFiles.map(f =>
      buildScopeForFileCached(f, wsRoot, fileScopeCache, lineCache)));

    // エッジ生成 (スコープは全てキャッシュ済みのため await なし)
    for (const { callee, calleeEntry } of resolvedCallees) {
      const calleeScopeEntry =
        fileScopeCache.get(normalizeFsPath(calleeEntry.file))
        ?? fileScopeCache.get(calleeEntry.file);
      if (!calleeScopeEntry) continue;
      // Bug④ 維持: findScopeAtLine 優先, byName フォールバック
      const calleeScope =
        findScopeAtLine(calleeScopeEntry.list, calleeEntry.line)
        ?? calleeScopeEntry.byName.get(callee);
      if (!calleeScope) continue;

      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      edgeSet.add(`${nodeId}|||${calleeId}`);
      if (!queued.has(calleeId)) {
        queued.add(calleeId);
        queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 });
      }
    }
    pct.bfsQ(15, 65, queued, { length: queue.length - qi });
  }

  // ── 上方向 BFS (caller): level-by-level バッチ処理 (I-1) ──────────────────
  // 旧実装: 関数 1 つにつき runGlobalRxSingle を 1 回 → N 回のプロセス起動
  // 新実装: BFS の各レベルを runGlobalRxBatch で一括クエリ → レベル数回のプロセス起動
  pct.to(65);
  pct.report('⬆ Building caller graph...');
  checkCancellation(token);

  type UpItem = { funcName: string; calleeId: string };
  const upVisited = new Set<string>([startNodeId]);
  let upCurrentLevel: UpItem[] = [{ funcName: startScope.name, calleeId: startNodeId }];

  for (let hop = 0; hop < maxHops && upCurrentLevel.length > 0; hop++) {
    checkCancellation(token);

    // 現レベルの全関数名を一括 global -rx でクエリ
    const levelFuncNames = upCurrentLevel.map(item => item.funcName);
    const refMap = await runGlobalRxBatch(levelFuncNames, wsRoot, errs, wsRoots);
    const upNextLevel: UpItem[] = [];

    // BUG-24 修正: refFile のスコープ取得を並列プリフェッチしてから処理する。
    // 旧実装は 1 件ずつ直列 await していたため、参照先ファイル数 × I/O 待機の合計が大きかった。
    // 下方向 BFS の uniqueCalleeFiles プリフェッチと同じパターンを適用する。
    const uniqueRefFiles = [...new Set(
      [...upCurrentLevel].flatMap(({ funcName }) =>
        (refMap.get(funcName) ?? []).map(r => r.refFile)
      )
    )];
    await Promise.all(uniqueRefFiles.map(f =>
      buildScopeForFileCached(f, wsRoot, fileScopeCache, lineCache)));

    for (const { funcName, calleeId } of upCurrentLevel) {
      for (const { refFile, refLine } of refMap.get(funcName) ?? []) {
        checkCancellation(token);

        // スコープはプリフェッチ済みのためキャッシュから即取得
        const callerFileScopeEntry =
          fileScopeCache.get(normalizeFsPath(refFile)) ?? fileScopeCache.get(refFile);
        if (!callerFileScopeEntry) continue;
        const callerScope = findScopeAtLine(callerFileScopeEntry.list, refLine);
        if (!callerScope || callerScope.name === funcName) continue;

        const callerEntries = await resolveOrFetchTag(callerScope.name, wsRoot, tagCache, errs);
        const callerEntry   =
          callerEntries?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(callerEntries, refFile);
        if (!callerEntry) continue;

        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);

        if (!nodes.has(callerId)) {
          nodes.set(callerId, gtagsEntryToNode(
            callerScope.name, callerEntry, callerScope, currentFile));
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

  // Mid-3 修正: マルチルートワークスペース対応。
  //   旧実装は uniqueUris[0] のルートのみ参照するため、
  //   2番目以降のワークスペースフォルダのファイルが sanitizeToWsRoot に弾かれていた。
  //   ルートごとに URI をグループ化し、各 GTAGS を個別参照して結果をマージする。

  // ルートごとに URI をグループ化
  const rootGroups = new Map<string, vscode.Uri[]>();
  for (const uri of uniqueUris) {
    const root = getWorkspaceRootForFile(uri);
    if (!root) continue;
    if (!rootGroups.has(root)) rootGroups.set(root, []);
    rootGroups.get(root)!.push(uri);
  }
  if (!rootGroups.size) throw new Error('No workspace folder is open.');

  const pct = new Pct(progress);
  pct.to(0);
  checkCancellation(token);

  // 全ルートの tags / scopeMap をマージするためのコンテナ
  const mergedTags     = new Map<string, GtagEntry[]>();
  const mergedScopeMap = new Map<string, ScopeMapEntry>();
  const callerFiles    = new Set<string>();
  const nodes          = new Map<string, GraphNode>();

  // ルートごとに GTAGS を参照 (並列処理)
  const rootList     = Array.from(rootGroups.entries());
  const rootCount    = rootList.length;
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    pct.range(0, 20, ri, rootCount);

    { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

    // 🔧 ④ 修正: rootAllUris は collectGtagsCached に渡されておらず完全な死コードだったため削除。
    //   collectGtagsCached は内部で findFilesCached() を使用し wsRoot の GTAGS のみを参照するため
    //   ルートごとのフィルタリングは sanitizeToWsRoot で担保される。

    let rootTags:           Map<string, GtagEntry[]>;
    let rootAmbiguousNames: string[];
    let rootScopeMap:       Map<string, ScopeMapEntry>;
    try {
      // パフォーマンス改善①: collectGtagsCached でルートのタグをキャッシュ
      // B: scopeMap もキャッシュ済みのものをそのまま受け取る（再計算・二重呼び出しなし）
      const result   = await collectGtagsCached(wsRoot);
      rootTags           = result.tags;
      rootAmbiguousNames = result.ambiguousNames;
      rootScopeMap       = result.scopeMap;
    } catch (e) {
      errs.push(`[gtags] Failed to collect tags for ${wsRoot}: ${e}`);
      continue;
    }

    if (!rootTags.size) {
      errs.push(`[gtags] No tags found in ${wsRoot}. Run \`gtags\` in that folder.`);
      continue;
    }
    if (rootAmbiguousNames.length > 0) {
      const preview = rootAmbiguousNames.slice(0, 5).join(', ');
      const suffix  = rootAmbiguousNames.length > 5 ? ` and ${rootAmbiguousNames.length - 5} more` : '';
      errs.push(`[gtags] Duplicate function names in ${path.basename(wsRoot)}: ${preview}${suffix}`);
    }

    // タグをマージ (同名関数のエントリを結合)
    for (const [name, entries] of rootTags) {
      if (!mergedTags.has(name)) mergedTags.set(name, []);
      mergedTags.get(name)!.push(...entries);
    }

    for (const [fp, entry] of rootScopeMap) {
      mergedScopeMap.set(fp, entry);
    }

    // callerFiles と caller ノードを登録
    for (const uri of rootUris) {
      callerFiles.add(uri.fsPath);
      callerFiles.add(normalizeFsPath(uri.fsPath));
      const fileScopes = findScopeMapEntry(mergedScopeMap, uri.fsPath)?.list ?? [];
      for (const scope of fileScopes) {
        const entry = rootTags.get(scope.name)?.find(
          e => normalizeFsPath(e.file) === normalizeFsPath(uri.fsPath) && e.isFunc);
        if (!entry) continue;
        callerFiles.add(entry.file);
        const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
        if (!nodes.has(nodeId)) nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, ''));
      }
    }
  }

  if (!mergedTags.size) throw new Error('No tags found. Run `gtags` in each workspace root.');

  // ルートごとに global -rx でエッジを構築 (callerFiles フィルタで混在を防ぐ)
  const edgeSet = new Set<string>();
  // V4-4 修正: mergedTags/mergedScopeMap には全ルートのエントリが含まれるため、
  // buildEdgesGlobalRx の callee フィルタにも全ルートを渡す。
  // 単一 wsRoot のみ渡すと他ルートのファイルが callee として弾かれクロスルートエッジが欠落する。
  const allWsRoots = rootList.map(([root]) => root);
  pct.to(20);
  checkCancellation(token);
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    const rootCallerFiles = new Set<string>();
    for (const uri of rootUris) {
      rootCallerFiles.add(uri.fsPath);
      rootCallerFiles.add(normalizeFsPath(uri.fsPath));
    }
    const rootEdges = await buildEdgesGlobalRx(
      rootCallerFiles, mergedTags, mergedScopeMap, wsRoot, token, pct,
      20 + Math.floor(ri * 70 / rootList.length),
      20 + Math.floor((ri + 1) * 70 / rootList.length),
      errs,       // ① 修正: エラーを呼び出し元の errs に記録
      allWsRoots  // V4-4: 全ルートを渡してクロスルートエッジを検出
    );
    for (const e of rootEdges) edgeSet.add(e);
  }

  // edgeSet に含まれる callee ノードを追加登録 (ヘッダー inline 関数を含む)
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split('|||')[1];
    if (nodes.has(calleeId)) continue;
    const { file: calleeFile, name: calleeName } = parseGtagsNodeId(calleeId);
    const calleeEntry = mergedTags.get(calleeName)?.find(e => e.file === calleeFile && e.isFunc);
    if (!calleeEntry) continue;
    const calleeScope = resolveCalleeScope(mergedScopeMap, calleeFile, calleeName, calleeEntry.line);
    if (!calleeScope) continue;
    nodes.set(calleeId, gtagsEntryToNode(calleeName, calleeEntry, calleeScope, ''));
  }

  // ── 下方向 BFS 再帰展開 ────────────────────────────────────────────────
  // Mid-2 修正: buildEdgesGlobalRx で発見されたヘッダー inline callee ノードから
  //   さらに呼ばれる関数のエッジが欠落していた問題を修正。
  //   buildFileCallGraphGtags と同じ下方向 BFS を追加してエッジを補完する。
  //
  // 🐛 ① 修正 (Workspace縦1列バグ):
  //   旧実装は downVisited を全ノードで初期化し、callerFiles 由来ノードを BFS キューから
  //   除外していた。「buildEdgesGlobalRx で処理済み」の前提だが、global -rx -e が失敗
  //   (GNU GLOBAL < 5.0 等) して edgeSet が空の場合、ソースノードは一切処理されず
  //   エッジゼロ → 全ノード level=0 → 縦1列になっていた。
  //   buildFileCallGraphGtags (同じ修正済み) に揃え:
  //     - downVisited を空で初期化
  //     - callerFiles フィルタを削除して全ノードを BFS キューに積む
  //   edgeSet が非空の場合でも Set の冪等性で重複エッジは無視される。
  pct.to(90);
  {
    // ② 修正: new Map() を毎ループ渡すとキャッシュが一切効かないため
    //   BFS スコープ全体で共有するキャッシュを1つ定義する。
    const bfsLineCache = new Map<string, string[]>();
    const knownTags    = new Set(mergedTags.keys());
    const downVisited  = new Set<string>(); // 🐛 ① 修正: 全ノード pre-mark を削除
    type DownItem = { name: string; entry: GtagEntry; scope: ScopeEntry };
    const downQueue: DownItem[] = [];
    for (const nodeId of nodes.keys()) {
      if (downVisited.has(nodeId)) continue;
      downVisited.add(nodeId);
      const { file: nFile, name: nName } = parseGtagsNodeId(nodeId);
      // 🐛 ① 修正: callerFiles フィルタを削除。全ノードを BFS で処理する。
      const entry = mergedTags.get(nName)?.find(e => e.file === nFile && e.isFunc);
      if (!entry) continue;
      const scope = resolveCalleeScope(mergedScopeMap, nFile, nName, entry.line);
      if (!scope) continue;
      downQueue.push({ name: nName, entry, scope });
    }

    let dqi = 0; // D: shift() O(n) → インデックスポインタ O(1)
    while (dqi < downQueue.length) {
      checkCancellation(token);
      const { name, entry, scope } = downQueue[dqi++];
      const callerId = makeGtagsNodeId(entry.file, name, entry.line);
      // ⑤ Performance 修正 (漏れ補完): readFileLinesCached (同期) → getFileLinesAsync (非同期)
      // buildFileCallGraphGtags BFS と同様に非同期読み込みに統一する。
      const lines    = await getFileLinesAsync(entry.file, bfsLineCache);
      const callees  = extractCallsFromLines(lines, scope.start, scope.end, name, knownTags);

      for (const callee of callees) {
        const calleeEntry = resolveCallee(mergedTags.get(callee), entry.file);
        if (!calleeEntry || !calleeEntry.isFunc) continue;
        const calleeScope = resolveCalleeScope(mergedScopeMap, calleeEntry.file, callee, calleeEntry.line);
        if (!calleeScope) continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
        if (!nodes.has(calleeId)) {
          nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, ''));
        }
        if (!downVisited.has(calleeId)) {
          downVisited.add(calleeId);
          downQueue.push({ name: callee, entry: calleeEntry, scope: calleeScope });
        }
      }
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
// gtags バックエンド  ─  パス貫通コールグラフ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I-1: 複数の関数名に対する参照を global -rx -e '^(func1|func2|...)$' で一括取得する。
 * buildPatternBatches で ARG_MAX 対策済み (S-3)、アンカーで部分一致防止 (B-2)。
 *
 * @returns Map<funcName, {refFile, refLine}[]>
 */
async function runGlobalRxBatch(
  funcNames: string[],
  wsRoot:    string,
  errs:      string[] = [], // BUG-10 修正: エラーを呼び出し元に伝搬
  wsRoots?:  string[],      // NEW-2: マルチルート対応 (未指定時は wsRoot のみ)
): Promise<Map<string, Array<{ refFile: string; refLine: number }>>> {
  const result = new Map<string, Array<{ refFile: string; refLine: number }>>();
  for (const n of funcNames) result.set(n, []);
  if (funcNames.length === 0) return result;

  // NEW-2: wsRoots が渡されていない場合は単一 wsRoot で動作 (後方互換)
  const effectiveRoots = (wsRoots && wsRoots.length > 0) ? wsRoots : [wsRoot];

  const patterns = buildPatternBatches(funcNames); // B-2+S-3
  const errorMessages = new Set<string>(); // 重複除去

  await Promise.all(patterns.map(async pattern => {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('global', ['-rx', '-e', pattern], {
        cwd: wsRoot, maxBuffer: 50 * 1024 * 1024, timeout: 60_000,
      }));
    } catch (e) {
      // BUG-10 修正: サイレント握り潰しをやめて errs に記録
      // NEW-1 修正: SIGTERM 文字列マッチ → ex.killed フラグで確実にタイムアウトを検出
      const ex  = e as NodeJS.ErrnoException & { killed?: boolean };
      const msg = ex instanceof Error ? ex.message : String(ex);
      if (ex.killed || msg.includes('cancel')) { return; }
      errorMessages.add(`global -rx: ${msg.split('\n')[0]}`);
      return;
    }

    for (const raw of stdout.split('\n')) {
      const parts = raw.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const name    = parts[0];
      const refLine = parseInt(parts[1], 10);
      if (!name || isNaN(refLine)) continue;
      const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots); // Security H + NEW-2
      if (!refFile) continue;
      result.get(name)?.push({ refFile, refLine });
    }
  }));
  for (const msg of errorMessages) errs.push(msg); // BUG-10: 集約エラーを伝搬
  return result;
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
  const wsRoot  = getWorkspaceRootForFile(document.uri); // gtags DB 操作用 (単一ルート)
  if (!wsRoot) throw new Error('No workspace folder is open.');
  // V4-3 修正: 他の gtags 関数と同様に wsRoots を取得して上方向 BFS でもマルチルート対応する
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  pct.to(5);
  checkCancellation(token);
  pct.report('📂 Loading tags...');
  const { tags, lineCache, ambiguousNames, scopeMap } =
    await collectGtagsCached(wsRoot);
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
  // B: scopeMap は collectGtagsCached がキャッシュ済みのものを返す（再計算なし）

  // 起点関数を特定 (Fix 2: findScopeMapEntry でパス差異に対応)
  const cursorLine = position.line + 1;
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  // BUG-23 修正: Array.find (O(n)) → findScopeAtLine (二分探索 O(log n)) に変更。
  // buildFileCallGraphGtags および全BFS処理と統一する。
  const startScope = findScopeAtLine(fileScopes, cursorLine);
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
    let qi = 0; // D: shift() O(n) → インデックスポインタ O(1)

    while (qi < queue.length) {
      checkCancellation(token);
      const { name, entry, scope, hop } = queue[qi++];
      const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const lines = await getFileLinesAsync(entry.file, lineCache); // BUG-09 修正: 同期→非同期
      nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
      if (hop >= maxHops) continue;

      for (const callee of extractCallsFromLines(lines, scope.start, scope.end, name, knownTags)) {
        const calleeEntry = resolveCallee(tags.get(callee), entry.file);
        // 🐛 ③ 修正: isFunc チェックが抜けていた。struct/enum 宣言行が callee ノードとして
        //   混入する問題を修正。buildFunctionCallGraphGtags と同じ条件に統一する。
        if (!calleeEntry?.isFunc) continue;
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
      pct.bfsQ(20, 55, queued, { length: queue.length - qi });
    }
  }

  // ── 上方向 BFS (caller) ──────────────────────────────────────────────────
  // global -rx <funcName> で参照箇所を逆辿りし、scopeMap で caller スコープを特定する。
  // ancEdges は「ancNode → ancNode/F」のみ収集されるため sibling は自然に除外される。
  // I-1: runGlobalRxSingle (1 関数ずつシリアル) → runGlobalRxBatch (レベル単位バッチ) に変更。
  pct.to(55);
  {
    type UpItem = {
      funcName: string;   // この関数への参照を global -rx で探す
      calleeId: string;   // エッジの下流側 nodeId
    };
    const queued = new Set<string>([startNodeId]);
    let upCurrentLevel: UpItem[] = [{ funcName: startScope.name, calleeId: startNodeId }];

    for (let hop = 0; hop < maxHops && upCurrentLevel.length > 0; hop++) {
      checkCancellation(token);

      const levelFuncNames = upCurrentLevel.map(item => item.funcName);
      const refMap = await runGlobalRxBatch(levelFuncNames, wsRoot, errs, wsRoots);
      const upNextLevel: UpItem[] = [];

      for (const { funcName, calleeId } of upCurrentLevel) {
        for (const { refFile, refLine } of refMap.get(funcName) ?? []) {
          checkCancellation(token);

          // 参照行が含まれる caller スコープを二分探索で特定
        // 🔴 Bug 4 修正: scopeMap のキーと refFile のパスは取得経路が異なるため
      //   macOS/Windows でパス大文字小文字・区切り文字が不一致になることがある。
      //   findScopeMapEntry() はこの差異を吸収するために実装されており、
      //   他箇所では正しく使われていたがこの3箇所だけ漏れていた。
      const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
          if (!fileScopeEntry) continue;
          const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
          if (!callerScope || callerScope.name === funcName) continue; // 自己再帰を除外

          // Precision ②: refFile 優先で caller エントリを解決
          const callerEntry =
            tags.get(callerScope.name)?.find(e => e.file === refFile && e.isFunc)
            ?? resolveCallee(tags.get(callerScope.name), refFile);
          if (!callerEntry) continue;

          const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
          edgeSet.add(`${callerId}|||${calleeId}`);

          if (!nodes.has(callerId)) {
            nodes.set(callerId, gtagsEntryToNode(
              callerScope.name, callerEntry, callerScope, currentFile));
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

/**
 * Bug② 修正: FNV-1a (32-bit) ハッシュ。
 * buildWorkspaceCallGraph のキャッシュキーに全ファイルパスのダイジェストを含めることで、
 * 「先頭5ファイル+ファイル数が同じ別プロジェクト」での誤ヒットを防止する。
 * 純粋なJS実装なのでNode.js crypto 依存なし。
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32bit乗算を2^16分割で近似 (JS の整数精度対策)
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h.toString(16).padStart(8, '0');
}

export async function buildFileCallGraph(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend:   Backend = 'auto',
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  // Bug2 修正: バックエンドが異なると結果も異なるため resolved backend をキーに含める。
  //   LSP で実行後 gtags に切り替えても古い結果が返らないよう修正。
  const resolved = await resolveBackend(backend);
  const key     = makeCacheKey('file', document.uri.fsPath, resolved);
  const cached  = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data; // ⑦ キャッシュヒット (TTL 内)
  const result  = await (resolved === 'gtags'
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
  // Low-1 修正: 同一行に複数関数シンボルが並ぶ場合 (マクロ展開など) に
  //   position.character を含めることでキャッシュの誤ヒットを防ぐ。
  // Bug1 修正: バックエンドが異なると結果も異なるため resolved backend をキーに含める。
  // 🟠 Bug 5 修正: maxHops が欠落していたため、callmap.maxHops を変更しても TTL(5分) が
  //   切れるまで古いホップ数の結果が返り続けていた。キーに maxHops を追加して即時反映させる。
  const resolved = await resolveBackend(backend);
  const key    = makeCacheKey('func', document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`);
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  const result = await (resolved === 'gtags'
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
  // Bug② 修正: 先頭5ファイル+総数のみのキーでは異なるプロジェクトが衝突する恐れがある。
  // 全ソートパスを結合した文字列の FNV-1a ハッシュをキーに含めることで
  // どのファイルセットの組み合わせも一意に識別できるようにする。
  // FNV-1a (32-bit) は衝突確率 1/2^32。ファイル数と組み合わせることで実用上は無視できる水準。
  // Bug2 修正: バックエンドが異なると結果も異なるため resolved backend をキーに含める。
  const resolved  = await resolveBackend(backend);
  const sorted    = uris.map(u => u.fsPath).sort();
  const pathsHash = fnv1a32(sorted.join('\x00'));
  // ファイル数をハッシュと組み合わせることで同ハッシュ・異ファイル数の衝突を排除
  const key       = makeCacheKey('workspace', String(sorted.length), pathsHash, resolved);
  const cached   = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  const result = await (resolved === 'gtags'
    ? buildWorkspaceCallGraphGtags(uris, progress, token)
    : buildWorkspaceCallGraphLsp(uris, progress, token));
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * B: ダイアログ待ち時間を活用するウォームアップ関数。
 *
 * pickBackend() 確定後、pickOutputMode() を待つ間（~0.5〜1秒）に
 * 最初の重い初期化処理を先行実行してキャッシュを温める。
 * build 関数呼び出し時にはキャッシュヒットするため実質コスト 0 になる。
 *
 * - gtags: ensureGtagsDb + collectGtagsCached (global -x と DB 更新)
 * - lsp  : executeDocumentSymbolProvider (VSCode 内部のシンボルキャッシュを温める)
 *
 * エラーは全て握り潰す（warmup 失敗は build 時のエラーで改めて報告される）。
 * キャンセルトークンは渡さない（build とは独立した短命タスクのため）。
 */
export async function warmupCache(
  document: vscode.TextDocument,
  backend:  Backend,
): Promise<void> {
  try {
    const resolved = await resolveBackend(backend);
    if (resolved === 'gtags') {
      const wsRoot = getWorkspaceRootForFile(document.uri);
      if (!wsRoot) return;
      // BUG-17 修正: ensureGtagsDb が返す警告メッセージをコンソールに記録する。
      // 旧実装は全エラーを握り潰していたため、global -u 失敗時も原因が分からなかった。
      const dbWarning = await ensureGtagsDb(wsRoot);
      if (dbWarning) {
        console.warn('[CallMap] warmupCache:', dbWarning);
      }
      await collectGtagsCached(wsRoot);
    } else {
      // LSP: VSCode 内部でシンボルキャッシュを温める（結果は捨てる）
      await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider', document.uri);
    }
  } catch (e) {
    console.warn('[CallMap] warmupCache failed:', e instanceof Error ? e.message : String(e));
  }
}
export async function buildPathThroughCallGraph(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  backend:   Backend = 'auto',
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  // ② 修正: position.character を含めないと同一行の別関数が同じキャッシュにヒットする。
  //   buildFunctionCallGraph と同じ形式 `${line}:${character}:${resolved}` に統一する。
  // Bug1 修正: バックエンドが異なると結果も異なるため resolved backend をキーに含める。
  // 🟠 Bug 5 修正: maxHops が欠落していたため、callmap.maxHops を変更しても TTL(5分) が
  //   切れるまで古いホップ数の結果が返り続けていた。キーに maxHops を追加して即時反映させる。
  const resolved = await resolveBackend(backend);
  const key    = makeCacheKey('path', document.uri.fsPath,
    `${position.line}:${position.character}:${maxHops}:${resolved}`);
  const cached = graphDataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  const result = resolved === 'gtags'
    ? await buildPathThroughCallGraphGtags(document, position, maxHops, progress, token)
    : await buildPathThroughCallGraphLsp(document, position, maxHops, progress, token);
  setGraphCache(key, { data: result, timestamp: Date.now() });
  return result;
}