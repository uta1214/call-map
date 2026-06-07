/**
 * gtagsBackend.ts  ─  gtags バックエンド実装
 *
 * GNU Global を使ったコールグラフ構築。
 * BFS エンジン (gtagsBfsDown, gtagsBfsUp 各バリアント) も含む。
 */

import * as vscode    from 'vscode';
import * as path      from 'path';
import * as fs        from 'fs';
import * as os        from 'os';
import { execFile }   from 'child_process';
import { promisify }  from 'util';
import { cache }      from './cacheManager';
import {
  GraphNode, GraphData,
  GtagEntry, ScopeEntry, ScopeMapEntry,
  MAX_SOURCE_LINES,
} from './types';
import {
  normalizeFsPath, splitEdges, fnv1a32, delay,
  getWorkspaceRoots, getWorkspaceRootForFile, hasCppSourceExtension,
  findScopeMapEntry, findScopeAtLine,
  isLikelyFuncDef, makeGtagsNodeId, parseGtagsNodeId, escapeRegexForGlobal,
  NodeIndex, Pct, checkCancellation, CC_SOURCE_EXTENSIONS,
} from './utils';
export type { GraphData };

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

const CC_ALL_GLOB       = '**/*.{c,cpp,cc,cxx,cu,cuh,h,hpp,hxx}';
const EXCLUDE_GLOB      = '{**/node_modules/**,**/.git/**,**/build/**,**/dist/**,**/.cache/**,**/out/**,**/__pycache__/**,**/.venv/**,**/.mypy_cache/**}';
const GTAGS_UPDATE_TTL  = 5 * 60_000;  // ms
const GLOBAL_RX_PARALLEL = Math.max(4, Math.min(os.cpus().length * 2, 32));
const WORKSPACE_FILES_KEY = '__workspace__';
// QUALITY-3 修正: ファイルスコープ CONCURRENT = 4 は prefetchFileLines で未使用だったため削除。
// collectGtags フォールバック内のローカル変数は perFileConcurrent にリネーム（シャドーイング解消）。

/** promisify した execFile。全 global / gtags 呼び出しで共用する。 */
const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// gtags インストール確認
// ─────────────────────────────────────────────────────────────────────────────

/**
 * gtags コマンドが使用可能かを確認する。
 * true は永続キャッシュ（インストール済み gtags が突然消えることはない）。
 * false は 30 秒 TTL で再チェック可能にする。
 */
export async function gtagsAvailable(): Promise<boolean> {
  const cached = cache.getGtagsAvailable();
  if (cached?.value === true) return true;
  if (cached?.value === false && cached.falseTs !== undefined) {
    if (Date.now() - cached.falseTs < cache.gtagsFalseTtl) return false;
  }
  try {
    await execFileAsync('gtags', ['--version'], { timeout: 5_000 });
    cache.setGtagsAvailable(true);
  } catch {
    cache.setGtagsAvailable(false);
  }
  return cache.getGtagsAvailable()!.value;
}




export async function findFilesCached(): Promise<vscode.Uri[]> {
  const cached = cache.getFiles(WORKSPACE_FILES_KEY);
  if (cached) return cached;
  const uris = await vscode.workspace.findFiles(CC_ALL_GLOB, EXCLUDE_GLOB);
  cache.setFiles(WORKSPACE_FILES_KEY, uris);
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
export async function collectGtagsCached(wsRoot: string): Promise<{
  tags:           Map<string, GtagEntry[]>;
  lineCache:      Map<string, string[]>;
  ambiguousNames: string[];
  scopeMap:       Map<string, ScopeMapEntry>;
}> {
  const cached = cache.getTags(wsRoot);
  if (cached) {
    return {
      tags:           cached.tags,
      lineCache:      new Map(),
      ambiguousNames: cached.ambiguousNames,
      scopeMap:       cached.scopeMap,
    };
  }
  const allUris  = await findFilesCached();
  // BUG-2 修正: findFilesCached() は全ワークスペースのファイルを返す。
  // collectGtags のフォールバックパス（global -x 失敗時の per-file global -f）は
  // cwd: wsRoot で実行するため、別ルートの絶対パスを渡すと相対化に失敗して空結果になる。
  // wsRoot 配下のファイルのみに絞り込んでから渡す。
  const wsRootNorm = normalizeFsPath(wsRoot);
  const wsUris     = allUris.filter(u => {
    const n = normalizeFsPath(u.fsPath);
    return n === wsRootNorm || n.startsWith(wsRootNorm + '/') || n.startsWith(wsRootNorm + path.sep);
  });
  const result   = await collectGtags(wsUris.map(u => u.fsPath), wsRoot);
  const scopeMap = buildGtagsScopeMap(result.tags);
  cache.setTags(wsRoot, {
    tags:           result.tags,
    ambiguousNames: result.ambiguousNames,
    scopeMap,
    timestamp:      Date.now(),
  });
  return { ...result, scopeMap };
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
  // Sec-3 修正: wsRoot が空文字列や相対パスの場合、意図しないディレクトリで
  // gtags が実行されるリスクがあるため早期リターンする。
  if (!wsRoot || !path.isAbsolute(wsRoot)) {
    return '[gtags] Internal error: wsRoot is not an absolute path.';
  }
  const now = Date.now();
  if (fs.existsSync(path.join(wsRoot, 'GTAGS'))) {
    const last = cache.getGtagsUpdateTs(wsRoot);
    if (now - last < GTAGS_UPDATE_TTL) return undefined; // ⑤ TTL 内はスキップ
    try {
      await execFileAsync('global', ['-u'], { cwd: wsRoot, timeout: 120_000 });
      cache.setGtagsUpdateTs(wsRoot, now);
    } catch (updateErr) {
      try {
        await runGtagsWithDotfilesCompat(wsRoot);
        cache.setGtagsUpdateTs(wsRoot, now);
      } catch (rebuildErr) {
        return spawnErrorMessage('global -u / gtags rebuild', rebuildErr);
      }
    }
  } else {
    try {
      await runGtagsWithDotfilesCompat(wsRoot);
    } catch (initErr) {
      return spawnErrorMessage('gtags', initErr);
    }
    cache.setGtagsUpdateTs(wsRoot, now);
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
    const realFp = cache.getRealpath(fp) ?? (() => {
      const r = fs.realpathSync(fp); cache.setRealpath(fp, r); return r;
    })();
    const realRoot = cache.getRealpath(wsRoot) ?? (() => {
      const r = fs.realpathSync(wsRoot); cache.setRealpath(wsRoot, r); return r;
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
    cwd: wsRoot, maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
  });
  return stdout.split('\n').flatMap(raw => {
    const trimmed = raw.trimEnd();
    if (!trimmed) return [];
    const m = trimmed.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return [];
    const [, name, lineStr, fileStr, sourceLine] = m;
    const line = parseInt(lineStr, 10);
    if (isNaN(line)) return [];
    // Sec-1 修正: GTAGS 改ざん等で name に NodeId/EdgeKey のセパレータが混入した場合、
    // makeGtagsNodeId / エッジキーのパースが破壊されるためスキップする。
    if (!name || name.includes('\x00') || name.includes('|||')) return [];
    const file = sanitizeToWsRoot(fileStr, wsRoot);
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
    const perFileConcurrent = Math.min(16, files.length);
    for (let i = 0; i < files.length; i += perFileConcurrent) {
      const results = await Promise.all(
        files.slice(i, i + perFileConcurrent).map(f => runGlobalF(f, wsRoot))
      );
      for (const entries of results) perFileResults.push(...entries);
    }
    rawEntries = perFileResults.map(e => ({ ...e, sourceLine: '' }));
  }

  const rawMap = new Map<string, RawEntry[]>();
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
  errs:        string[] = [],
  wsRoots?:    string[],
): Promise<Set<string>> {
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
        if (ex.killed || msg.includes('cancel')) { return; }
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
        const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots);
        // BUG-4 修正: sanitizeToAnyWsRoot が返すパスと callerFiles のパス形式が
        // macOS/Windows の大文字小文字・区切り文字の差異で一致しない場合がある。
        // normalizeFsPath を通した正規化済みパスで比較することで確実に一致させる。
        if (!refFile || !callerFiles.has(normalizeFsPath(refFile))) continue;
        const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
        if (!fileScopeEntry) continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        if (!callerScope) continue;
        const callerEntry = tags.get(callerScope.name)
          ?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry) continue;
        // BUG-NEW-A 修正: resolveCallee のフォールバックで別ファイルのエントリが返った場合、
        // callerScope は refFile 上のスコープなのに callerEntry.file が異なる状態になる。
        // downStartItems で tags.get(nn)?.find(e => e.file === nf) がヒットせず
        // 下方向 BFS の起点から除外されるため、スキップして安全側に倒す。
        if (callerEntry.file !== refFile) continue;
        const calleeEntry = resolveCallee(tags.get(calleeName), refFile);
        if (!calleeEntry?.isFunc) continue;
        // Bug④: resolveCalleeScope (findScopeAtLine 優先) で正確なスコープを取得
        const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, calleeName, calleeEntry.line);
        if (!calleeScope) continue;
        if (callerScope.name === calleeName && callerEntry.file === calleeEntry.file) continue;
        // callerEntry.file === refFile が保証されているため、どちらを使っても同値。
        // 意図を明示するため callerEntry.file を使う（gtagsBfsUpFull/Lazy と統一）。
        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
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
// gtags バックエンド  ─  実装 (Phase 2: 内部 BFS エンジン使用)
// ─────────────────────────────────────────────────────────────────────────────

// ── 内部 BFS エンジン ─────────────────────────────────────────────────────────

interface GtagsBfsDownFullOpts {
  nodes:      Map<string, GraphNode>;
  edgeSet:    Set<string>;
  errs:       string[];
  tags:       Map<string, GtagEntry[]>;
  scopeMap:   Map<string, ScopeMapEntry>;
  lineCache:  Map<string, string[]>;
  wsRoot:     string;
  currentFile: string;
  startItems: Array<{ name: string; entry: GtagEntry; scope: ScopeEntry }>;
  maxHops?:   number;
  token?:     vscode.CancellationToken;
  pct:        Pct;
  pctRange:   [number, number];
}

/** gtags 下方向 BFS (全量キャッシュ版)。extractCallsFromLines + resolveCallee で展開する。
 *
 * NOTE: opts.wsRoot はインターフェース上存在するが、この関数内では使用しない。
 * getFileLinesAsync は filePath（絶対パス）で直接読み込むため wsRoot に依存しない。
 * マルチルート対応で将来 wsRoot を利用する場合は、各 entry.file の所属ルートを
 * getWorkspaceRootForFile で動的に解決すること。
 */
async function gtagsBfsDownFull(opts: GtagsBfsDownFullOpts): Promise<void> {
  const { nodes, edgeSet, tags, scopeMap, lineCache, currentFile, startItems, maxHops, token, pct, pctRange } = opts;
  const knownTags = new Set(tags.keys());
  type QItem = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
  const queue:   QItem[]      = startItems.map(s => ({ ...s, hop: 0 }));
  const visited  = new Set<string>(startItems.map(s => makeGtagsNodeId(s.entry.file, s.name, s.entry.line)));
  let qi = 0;
  while (qi < queue.length) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue[qi++];
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    const lines  = await getFileLinesAsync(entry.file, lineCache);
    if (!nodes.has(nodeId)) nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));
    pct.bfsQ(pctRange[0], pctRange[1], visited, { length: queue.length - qi });
    if (maxHops !== undefined && hop >= maxHops) continue;
    for (const callee of extractCallsFromLines(lines, scope.start, scope.end, name, knownTags)) {
      const calleeEntry = resolveCallee(tags.get(callee), entry.file);
      if (!calleeEntry?.isFunc) continue;
      const calleeScope = resolveCalleeScope(scopeMap, calleeEntry.file, callee, calleeEntry.line);
      if (!calleeScope) continue;
      const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
      edgeSet.add(`${nodeId}|||${calleeId}`);
      if (!nodes.has(calleeId)) nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, currentFile));
      if (!visited.has(calleeId)) { visited.add(calleeId); queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 }); }
    }
  }
}

interface GtagsBfsUpFullOpts {
  nodes:      Map<string, GraphNode>;
  edgeSet:    Set<string>;
  errs:       string[];
  tags:       Map<string, GtagEntry[]>;
  scopeMap:   Map<string, ScopeMapEntry>;
  wsRoot:     string;
  wsRoots:    string[];
  currentFile: string;
  startItems: Array<{ funcName: string; calleeId: string }>;
  maxHops?:   number;
  token?:     vscode.CancellationToken;
  pct:        Pct;
  pctRange:   [number, number];
}

/** gtags 上方向 BFS (全量キャッシュ版)。level-by-level + runGlobalRxBatch で遡る。 */
async function gtagsBfsUpFull(opts: GtagsBfsUpFullOpts): Promise<void> {
  const { nodes, edgeSet, errs, tags, scopeMap, wsRoot, wsRoots, currentFile, startItems, maxHops, token, pct, pctRange } = opts;
  const upQueued = new Set<string>(startItems.map(s => s.calleeId));
  let upCurrentLevel = [...startItems];
  let hop = 0;
  while (upCurrentLevel.length > 0 && (maxHops === undefined || hop < maxHops)) {
    checkCancellation(token);
    const refMap = await runGlobalRxBatch(upCurrentLevel.map(s => s.funcName), wsRoot, errs, wsRoots);
    const upNextLevel: typeof startItems = [];
    for (const { funcName, calleeId } of upCurrentLevel) {
      // H-1 修正: isSelfRef の比較ファイルは tags の先頭候補ではなく、
      // 今追いかけている callee 自身のファイル（calleeId から確定）を使う。
      // tags.get(funcName)?.find(...) は同名関数が複数ファイルにある場合に
      // 別ファイルを返すことがあり、正当な caller を誤ってスキップしてしまう。
      const { file: calleeFile } = parseGtagsNodeId(calleeId);
      for (const { refFile, refLine } of refMap.get(funcName) ?? []) {
        checkCancellation(token);
        const fileScopeEntry = findScopeMapEntry(scopeMap, refFile);
        if (!fileScopeEntry) continue;
        const callerScope = findScopeAtLine(fileScopeEntry.list, refLine);
        // 自己参照（callee と同一ファイル・同一スコープ名）のみスキップする。
        // 別ファイルの同名関数は正当な caller なので除外しない。
        const isSelfRef = callerScope?.name === funcName
          && normalizeFsPath(refFile) === normalizeFsPath(calleeFile);
        if (!callerScope || isSelfRef) continue;
        const callerEntry =
          tags.get(callerScope.name)?.find(e => e.file === refFile && e.isFunc)
          ?? resolveCallee(tags.get(callerScope.name), refFile);
        if (!callerEntry) continue;
        // Bug-1 修正: buildEdgesGlobalRx (737行) と同等のガード。
        // resolveCallee のフォールバックで別ファイルのエントリが返ると
        // 孤立エッジ（存在しない caller ノード）が生まれるためスキップする。
        if (callerEntry.file !== refFile) continue;
        const callerId = makeGtagsNodeId(callerEntry.file, callerScope.name, callerEntry.line);
        edgeSet.add(`${callerId}|||${calleeId}`);
        if (!nodes.has(callerId)) nodes.set(callerId, gtagsEntryToNode(callerScope.name, callerEntry, callerScope, currentFile));
        if (!upQueued.has(callerId)) { upQueued.add(callerId); upNextLevel.push({ funcName: callerScope.name, calleeId: callerId }); }
      }
    }
    pct.range(pctRange[0], pctRange[1], hop + 1, maxHops ?? hop + 2);
    upCurrentLevel = upNextLevel;
    hop++;
  }
  // QUALITY-NEW-1 修正: maxHops=undefined（無制限）時は分母が hop+2 となり
  // 進捗が 100% に到達しない。ループ終了後に明示的に pctRange[1] まで進める。
  pct.to(pctRange[1]);
}

interface GtagsBfsDownLazyOpts {
  nodes:       Map<string, GraphNode>;
  edgeSet:     Set<string>;
  errs:        string[];
  startEntry:  { name: string; entry: GtagEntry; scope: ScopeEntry };
  tagCache:    Map<string, GtagEntry[]>;
  scopeCache:  Map<string, ScopeMapEntry>;
  lineCache:   Map<string, string[]>;
  wsRoot:      string;
  wsRoots:     string[]; // Bug-A/B 追加: マルチルート対応
  currentFile: string;
  maxHops:     number;
  token?:      vscode.CancellationToken;
  pct:         Pct;
  pctRange:    [number, number];
}

/**
 * gtags 下方向 BFS (遅延ローディング版)。
 * knownTags フィルタなしで候補抽出 → runGlobalXNames で後検証するオンデマンド方式。
 * BugFix G: visited (処理完了) と queued (投入済み) を分離して退行バグを防止。
 */
async function gtagsBfsDownLazy(opts: GtagsBfsDownLazyOpts): Promise<void> {
  const { nodes, edgeSet, errs, startEntry, tagCache, scopeCache, lineCache, wsRoot, wsRoots, currentFile, maxHops, token, pct, pctRange } = opts;
  const startNodeId = makeGtagsNodeId(startEntry.entry.file, startEntry.name, startEntry.entry.line);
  type Q = { name: string; entry: GtagEntry; scope: ScopeEntry; hop: number };
  const queue:   Q[]          = [{ ...startEntry, hop: 0 }];
  const visited  = new Set<string>();
  const queued   = new Set<string>([startNodeId]);
  let qi = 0;
  while (qi < queue.length) {
    checkCancellation(token);
    const { name, entry, scope, hop } = queue[qi++];
    const nodeId = makeGtagsNodeId(entry.file, name, entry.line);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const lines = await getFileLinesAsync(entry.file, lineCache);
    nodes.set(nodeId, gtagsEntryToNode(name, entry, scope, currentFile));

    // BUG-NEW-B 修正: hop>=maxHops と通常展開でほぼ同一のコードが重複していた。
    // 共通処理を processLazyCallees ヘルパーに切り出して重複を解消する。
    // expandQueue: true なら未訪問 callee をキューに積む（通常展開）、
    //              false ならノード登録のみでキューに積まない（maxHops 到達時）。
    const expandQueue = hop < maxHops;
    const rawCandidates = extractCallsFromLines(lines, scope.start, scope.end, name);
    if (rawCandidates.size > 0) {
      const uncached = [...rawCandidates].filter(c => !tagCache.has(c));
      if (uncached.length > 0) {
        const freshMap = await runGlobalXNames(uncached, wsRoot, errs, wsRoots);
        for (const [n, es] of freshMap) tagCache.set(n, es);
        for (const n of uncached) { if (!tagCache.has(n)) tagCache.set(n, []); }
      }
      const resolvedCallees: Array<{ callee: string; calleeEntry: GtagEntry }> = [];
      for (const callee of rawCandidates) {
        const calleeEntry = resolveCallee(tagCache.get(callee), entry.file);
        if (calleeEntry?.isFunc) resolvedCallees.push({ callee, calleeEntry });
      }
      // スコープを並列プリフェッチ（expandQueue=false でも callee ノード登録のために必要）
      await Promise.all([...new Set(resolvedCallees.map(c => c.calleeEntry.file))].map(f =>
        buildScopeForFileCached(f, wsRoot, scopeCache, lineCache, wsRoots)));
      for (const { callee, calleeEntry } of resolvedCallees) {
        const calleeScopeEntry = scopeCache.get(normalizeFsPath(calleeEntry.file)) ?? scopeCache.get(calleeEntry.file);
        if (!calleeScopeEntry) continue;
        const calleeScope = findScopeAtLine(calleeScopeEntry.list, calleeEntry.line) ?? calleeScopeEntry.byName.get(callee);
        if (!calleeScope) continue;
        const calleeId = makeGtagsNodeId(calleeEntry.file, callee, calleeEntry.line);
        edgeSet.add(`${nodeId}|||${calleeId}`);
        if (expandQueue) {
          // 通常展開: 未訪問の callee をキューに積む
          if (!queued.has(calleeId)) { queued.add(calleeId); queue.push({ name: callee, entry: calleeEntry, scope: calleeScope, hop: hop + 1 }); }
        } else {
          // maxHops 到達: キューには積まずノード登録のみ（BUG-3 修正）
          if (!nodes.has(calleeId)) {
            nodes.set(calleeId, gtagsEntryToNode(callee, calleeEntry, calleeScope, currentFile));
          }
        }
      }
    }
    pct.bfsQ(pctRange[0], pctRange[1], queued, { length: queue.length - qi });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// gtags バックエンド  ─  遅延ローディング用ヘルパー
//   buildFunctionCallGraphGtags / buildPathThroughCallGraphGtags で共用する。
//
// 【高速化】全量キャッシュ版 (collectGtagsCached + buildGtagsScopeMap) は
//   大規模プロジェクトで数分かかることがあった。
//   遅延版は BFS を進めながら必要な関数・ファイルだけをオンデマンドでクエリする:
//     runGlobalXNames         : global -x -e 'func1|func2|...' で複数定義を一括取得
//     buildScopeForFileCached : global -f <file> でそのファイルのスコープだけ構築
//     extractCallsFromLines   : knownTags フィルタなしで候補抽出 → runGlobalXNames で検証
//
//   これにより訪問した関数・ファイル数に比例した処理量に抑え、数秒以内を目指す。
// ─────────────────────────────────────────────────────────────────────────────

async function runGlobalRxBatch(
  funcNames: string[],
  wsRoot:    string,
  errs:      string[] = [],
  wsRoots?:  string[],
): Promise<Map<string, Array<{ refFile: string; refLine: number }>>> {
  const result = new Map<string, Array<{ refFile: string; refLine: number }>>();
  for (const n of funcNames) result.set(n, []);
  if (funcNames.length === 0) return result;
  const effectiveRoots = (wsRoots && wsRoots.length > 0) ? wsRoots : [wsRoot];
  const patterns = buildPatternBatches(funcNames);
  const errorMessages = new Set<string>();
  // Bug-4 修正: Promise.all による全パターン同時起動を廃止し、
  // buildEdgesGlobalRx と同様に GLOBAL_RX_PARALLEL 個ずつ逐次バッチ実行する。
  // 大規模プロジェクトで数百プロセスが同時起動してリソース枯渇するリスクを防ぐ。
  for (let gi = 0; gi < patterns.length; gi += GLOBAL_RX_PARALLEL) {
    await Promise.all(patterns.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async pattern => {
      let stdout = '';
      try {
        ({ stdout } = await execFileAsync('global', ['-rx', '-e', pattern], {
          cwd: wsRoot, maxBuffer: 50 * 1024 * 1024, timeout: 60_000,
        }));
      } catch (e) {
        const ex  = e as NodeJS.ErrnoException & { killed?: boolean };
        const msg = ex instanceof Error ? ex.message : String(ex);
        if (ex.killed || msg.includes('cancel')) return;
        errorMessages.add(`global -rx: ${msg.split('\n')[0]}`);
        return;
      }
      for (const raw of stdout.split('\n')) {
        const parts = raw.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const name    = parts[0];
        const refLine = parseInt(parts[1], 10);
        if (!name || isNaN(refLine)) continue;
        // Sec-1 修正: name にセパレータ文字が含まれる場合はスキップ（runGlobalXAll と統一）
        if (name.includes('\x00') || name.includes('|||')) continue;
        const refFile = sanitizeToAnyWsRoot(parts[2], effectiveRoots);
        if (!refFile) continue;
        result.get(name)?.push({ refFile, refLine });
      }
    }));
  }
  for (const msg of errorMessages) errs.push(msg);
  return result;
}


const MAX_PATTERN_LENGTH = 400;

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
function buildPatternBatches(names: string[]): string[] {
  if (names.length === 0) return [];
  const batches: string[] = [];
  let batch: string[] = [];
  // 旧実装は 0 から始めており、生成パターンが MAX_PATTERN_LENGTH を超える可能性があった。
  const WRAPPER_LEN = 4; // '^(' + ')$'
  let len = WRAPPER_LEN;

  for (const name of names) {
    const escaped = escapeRegexForGlobal(name);
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
  names:   string[],
  wsRoot:  string,
  errs:    string[] = [],
  wsRoots?: string[], // Bug-A 追加: マルチルート対応
): Promise<Map<string, GtagEntry[]>> {
  const result = new Map<string, GtagEntry[]>();
  if (names.length === 0) return result;

  // Bug-A 修正: マルチルート時は全ルートを検索対象とする
  const effectiveRoots = (wsRoots && wsRoots.length > 0) ? wsRoots : [wsRoot];
  const patterns = buildPatternBatches(names); // B-2+S-3
  const errorMessages = new Set<string>(); // 重複除去

  // Quality-B 修正: runGlobalRxBatch と統一して GLOBAL_RX_PARALLEL 上限付きバッチ並列に変更
  for (let gi = 0; gi < patterns.length; gi += GLOBAL_RX_PARALLEL) {
    await Promise.all(patterns.slice(gi, gi + GLOBAL_RX_PARALLEL).map(async pattern => {
      let stdout = '';
      try {
        ({ stdout } = await execFileAsync('global', ['-x', '-e', pattern], {
          cwd: wsRoot, maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
        }));
      } catch (e) {
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
        // Sec-1 修正と統一: name にセパレータが含まれる場合はスキップ
        if (!name || name.includes('\x00') || name.includes('|||')) continue;
        // Bug-A 修正: sanitizeToAnyWsRoot でマルチルートに対応
        const file = sanitizeToAnyWsRoot(fileStr, effectiveRoots);
        if (!file) continue;
        const entry: GtagEntry = { name, file, line, sourceLine, isFunc: isLikelyFuncDef(sourceLine) };
        if (!result.has(name)) result.set(name, []);
        result.get(name)!.push(entry);
      }
    }));
  }

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
  wsRoots?: string[],      // Bug-A 追加: マルチルート対応
): Promise<GtagEntry[] | undefined> {
  if (tagCache.has(name)) {
    const cached = tagCache.get(name)!;
    return cached.length > 0 ? cached : undefined;
  }
  const resolved = await runGlobalXNames([name], wsRoot, errs, wsRoots);
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
  wsRoots?:   string[], // Bug-B 追加: マルチルート対応
): Promise<ScopeMapEntry | undefined> {
  const norm = normalizeFsPath(file);
  const hit  = scopeCache.get(norm) ?? scopeCache.get(file);
  if (hit) return hit;

  // Bug-B 修正: file が wsRoot と異なるルートに属する場合、
  // path.relative(wsRoot, file) が '../other-root/...' になり global -f が空を返す。
  // getWorkspaceRootForFile で file の実際のルートを動的解決して runGlobalF に渡す。
  const effectiveRoot = (wsRoots && wsRoots.length > 0)
    ? (getWorkspaceRootForFile(vscode.Uri.file(file)) ?? wsRoot)
    : wsRoot;
  const tagEntries = await runGlobalF(file, effectiveRoot);
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


export async function buildFileCallGraphGtags(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0      = Date.now();
  const errs:   string[] = [];
  const wsRoot  = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }
  pct.to(5);
  pct.report('📂 Loading tags...');
  const { tags, lineCache, ambiguousNames, scopeMap } = await collectGtagsCached(wsRoot);
  if (!tags.size) throw new Error('No tags found.\nPlease verify that gtags is installed and GTAGS exists.');
  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(', ');
    const suffix  = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : '';
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }

  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  const currentLines    = document.getText().split('\n');
  lineCache.set(currentFileNorm, currentLines);
  lineCache.set(currentFile, currentLines);

  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const nodes      = new Map<string, GraphNode>();
  for (const scope of fileScopes) {
    const entry = tags.get(scope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    if (!entry) continue;
    const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
    nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, currentFile));
  }
  if (!nodes.size) throw new Error('No functions found in this file.');

  // global -rx でエッジ構築
  pct.to(20);
  checkCancellation(token);
  // BUG-4 修正: callerFiles は normalizeFsPath 済みパスのみ格納し、
  // buildEdgesGlobalRx 側の has() 比較と形式を統一する。
  const callerFiles = new Set<string>([currentFileNorm]);
  for (const scope of fileScopes) {
    const e = tags.get(scope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    if (e) callerFiles.add(normalizeFsPath(e.file));
  }
  const edgeSet = await buildEdgesGlobalRx(callerFiles, tags, scopeMap, wsRoot, token, pct, 20, 75, errs, wsRoots);

  // edgeSet の callee ノードを登録
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split('|||')[1];
    if (nodes.has(calleeId)) continue;
    const { file: cf, name: cn } = parseGtagsNodeId(calleeId);
    const ce = tags.get(cn)?.find(e => e.file === cf && e.isFunc);
    if (!ce) continue;
    const cs = resolveCalleeScope(scopeMap, cf, cn, ce.line);
    if (cs) nodes.set(calleeId, gtagsEntryToNode(cn, ce, cs, currentFile));
  }

  // 下方向 BFS (全ノードを起点に再帰展開)
  pct.to(75);
  const downStartItems: Array<{ name: string; entry: GtagEntry; scope: ScopeEntry }> = [];
  for (const nodeId of nodes.keys()) {
    const { file: nf, name: nn } = parseGtagsNodeId(nodeId);
    const e = tags.get(nn)?.find(e => e.file === nf && e.isFunc);
    if (!e) continue;
    const s = resolveCalleeScope(scopeMap, nf, nn, e.line);
    if (s) downStartItems.push({ name: nn, entry: e, scope: s });
  }
  await gtagsBfsDownFull({ nodes, edgeSet, errs, tags, scopeMap, lineCache, wsRoot, currentFile, startItems: downStartItems, token, pct, pctRange: [75, 88] });

  // 上方向 BFS (コアノードを起点に遡る)
  pct.to(88);
  const upStartItems = fileScopes.flatMap(scope => {
    const entry = tags.get(scope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc);
    return entry ? [{ funcName: scope.name, calleeId: makeGtagsNodeId(entry.file, scope.name, entry.line) }] : [];
  });
  await gtagsBfsUpFull({ nodes, edgeSet, errs, tags, scopeMap, wsRoot, wsRoots, currentFile, startItems: upStartItems, token, pct, pctRange: [88, 100] });

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: path.basename(currentFile), buildTimeMs: Date.now() - t0, errors: errs,
  };
}

export async function buildFunctionCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0    = Date.now();
  const errs: string[] = [];
  const wsRoot = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }

  // モジュールレベルキャッシュを取得 (TTL 内なら前回ビルドを再利用)
  const now = Date.now();
  let lazyTagEntry = cache.getLazyTagEntry(wsRoot);
  if (!lazyTagEntry) { lazyTagEntry = { entries: new Map(), timestamp: now }; cache.setLazyTagEntry(wsRoot, lazyTagEntry); }
  const tagCache = lazyTagEntry.entries;
  let lazyScopeEntry = cache.getLazyScopeEntry(wsRoot);
  if (!lazyScopeEntry) { lazyScopeEntry = { scopes: new Map(), timestamp: now }; cache.setLazyScopeEntry(wsRoot, lazyScopeEntry); }
  const scopeCache = lazyScopeEntry.scopes;
  const lineCache: Map<string, string[]> = new Map();

  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  const currentLines    = document.getText().split('\n');
  lineCache.set(currentFile, currentLines);
  lineCache.set(currentFileNorm, currentLines);

  // 起点関数を特定 (遅延ローディング)
  pct.to(5);
  checkCancellation(token);
  pct.report('🔍 Finding start function...');
  const startFileScopeEntry = await buildScopeForFileCached(currentFile, wsRoot, scopeCache, lineCache);
  if (!startFileScopeEntry?.list.length) throw new Error('No functions found in this file.');
  const startScope = findScopeAtLine(startFileScopeEntry.list, position.line + 1);
  if (!startScope) throw new Error('No function found at cursor position.\nPlace the cursor on a function name and try again.');
  const startCandidates = await resolveOrFetchTag(startScope.name, wsRoot, tagCache, errs);
  const startEntry =
    startCandidates?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc)
    ?? startCandidates?.find(e => e.isFunc)
    ?? startCandidates?.[0];
  if (!startEntry) throw new Error('Tag info for the start function was not found.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // 下方向 BFS のみ (遅延ローディング版)
  // LSP バックエンドの buildFunctionCallGraphLsp と挙動を統一する。
  // 双方向グラフが必要な場合は buildPathThroughCallGraphGtags を使用すること。
  pct.to(15);
  pct.report('⬇ Building callee graph...');
  await gtagsBfsDownLazy({ nodes, edgeSet, errs, startEntry: { name: startScope.name, entry: startEntry, scope: startScope }, tagCache, scopeCache, lineCache, wsRoot, wsRoots, currentFile, maxHops, token, pct, pctRange: [15, 100] });

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: `${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}

/** ルートごとに tags / scopeMap / nodes を収集してマージする (buildWorkspaceCallGraphGtags 専用) */
async function collectWsTagsAndNodes(
  rootList: [string, vscode.Uri[]][],
  errs:     string[],
  pct:      Pct,
  token?:   vscode.CancellationToken,
): Promise<{ mergedTags: Map<string, GtagEntry[]>; mergedScopeMap: Map<string, ScopeMapEntry>; nodes: Map<string, GraphNode> }> {
  const mergedTags     = new Map<string, GtagEntry[]>();
  const mergedScopeMap = new Map<string, ScopeMapEntry>();
  const nodes          = new Map<string, GraphNode>();
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    pct.range(0, 20, ri, rootList.length);
    { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }
    let rootTags: Map<string, GtagEntry[]>, rootAmbiguous: string[], rootScopeMap: Map<string, ScopeMapEntry>;
    try {
      const r = await collectGtagsCached(wsRoot);
      rootTags = r.tags; rootAmbiguous = r.ambiguousNames; rootScopeMap = r.scopeMap;
    } catch (e) { errs.push(`[gtags] Failed to collect tags for ${wsRoot}: ${e}`); continue; }
    if (!rootTags.size) { errs.push(`[gtags] No tags found in ${wsRoot}. Run \`gtags\` in that folder.`); continue; }
    if (rootAmbiguous.length > 0) {
      const p = rootAmbiguous.slice(0, 5).join(', ');
      errs.push(`[gtags] Duplicate names in ${path.basename(wsRoot)}: ${p}${rootAmbiguous.length > 5 ? ` (+${rootAmbiguous.length - 5})` : ''}`);
    }
    for (const [name, entries] of rootTags) {
      if (!mergedTags.has(name)) mergedTags.set(name, []);
      mergedTags.get(name)!.push(...entries);
    }
    for (const [fp, entry] of rootScopeMap) mergedScopeMap.set(fp, entry);
    for (const uri of rootUris) {
      for (const scope of findScopeMapEntry(mergedScopeMap, uri.fsPath)?.list ?? []) {
        const entry = rootTags.get(scope.name)?.find(e => normalizeFsPath(e.file) === normalizeFsPath(uri.fsPath) && e.isFunc);
        if (!entry) continue;
        const nodeId = makeGtagsNodeId(entry.file, scope.name, entry.line);
        if (!nodes.has(nodeId)) nodes.set(nodeId, gtagsEntryToNode(scope.name, entry, scope, ''));
      }
    }
  }
  return { mergedTags, mergedScopeMap, nodes };
}

export async function buildWorkspaceCallGraphGtags(
  uris:      vscode.Uri[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0   = Date.now();
  const errs: string[] = [];
  const uniqueUris = Array.from(new Map(uris.map(u => [u.fsPath, u])).values())
    .filter(u => CC_SOURCE_EXTENSIONS.has(path.extname(u.fsPath).toLowerCase()));
  if (!uniqueUris.length) throw new Error('No C/C++ source files found.');

  const rootGroups = new Map<string, vscode.Uri[]>();
  for (const uri of uniqueUris) {
    const root = getWorkspaceRootForFile(uri);
    if (!root) continue;
    if (!rootGroups.has(root)) rootGroups.set(root, []);
    rootGroups.get(root)!.push(uri);
  }
  if (!rootGroups.size) throw new Error('No workspace folder is open.');

  const pct      = new Pct(progress);
  const rootList = Array.from(rootGroups.entries());
  pct.to(0); checkCancellation(token);

  const { mergedTags, mergedScopeMap, nodes } = await collectWsTagsAndNodes(rootList, errs, pct, token);
  if (!mergedTags.size) throw new Error('No tags found. Run `gtags` in each workspace root.');

  // ルートごとに global -rx でエッジ構築
  const edgeSet     = new Set<string>();
  const allWsRoots  = rootList.map(([root]) => root);
  pct.to(20);
  checkCancellation(token);
  for (let ri = 0; ri < rootList.length; ri++) {
    const [wsRoot, rootUris] = rootList[ri];
    checkCancellation(token);
    // BUG-4 修正漏れ: buildFileCallGraphGtags 側は修正済みだが、こちらは
    // 生パスと正規化パスの両方を混在させたままだった。
    // buildEdgesGlobalRx 側で normalizeFsPath(refFile) と比較するため、
    // callerFiles も normalizeFsPath 済みパスのみ格納して形式を統一する。
    const rootCallerFiles = new Set<string>();
    for (const uri of rootUris) { rootCallerFiles.add(normalizeFsPath(uri.fsPath)); }
    const rootEdges = await buildEdgesGlobalRx(rootCallerFiles, mergedTags, mergedScopeMap, wsRoot, token, pct,
      20 + Math.floor(ri * 70 / rootList.length), 20 + Math.floor((ri + 1) * 70 / rootList.length), errs, allWsRoots);
    for (const e of rootEdges) edgeSet.add(e);
  }

  // edgeSet の callee ノードを登録
  for (const edgeKey of edgeSet) {
    const calleeId = edgeKey.split('|||')[1];
    if (nodes.has(calleeId)) continue;
    const { file: cf, name: cn } = parseGtagsNodeId(calleeId);
    const ce = mergedTags.get(cn)?.find(e => e.file === cf && e.isFunc);
    if (!ce) continue;
    const cs = resolveCalleeScope(mergedScopeMap, cf, cn, ce.line);
    if (cs) nodes.set(calleeId, gtagsEntryToNode(cn, ce, cs, ''));
  }

  // 下方向 BFS (全ノードを起点に再帰展開)
  pct.to(90);
  const bfsLineCache = new Map<string, string[]>();
  const downStartItems: Array<{ name: string; entry: GtagEntry; scope: ScopeEntry }> = [];
  for (const nodeId of nodes.keys()) {
    const { file: nf, name: nn } = parseGtagsNodeId(nodeId);
    const e = mergedTags.get(nn)?.find(e => e.file === nf && e.isFunc);
    if (!e) continue;
    const s = resolveCalleeScope(mergedScopeMap, nf, nn, e.line);
    if (s) downStartItems.push({ name: nn, entry: e, scope: s });
  }
  // Bug-1 修正: pctRange を [90,95] に縮め、[95,100] を上方向 BFS に割り当てる
  await gtagsBfsDownFull({ nodes, edgeSet, errs, tags: mergedTags, scopeMap: mergedScopeMap, lineCache: bfsLineCache, wsRoot: rootList[0][0], currentFile: '', startItems: downStartItems, token, pct, pctRange: [90, 95] });

  // Bug-1 修正: 上方向 BFS を追加。
  // buildFileCallGraphGtags / buildPathThroughCallGraphGtags と同様に、
  // 全登録ノードを起点として caller 方向を遡り、上方向エッジを収集する。
  pct.to(95);
  const allWsRootsForUp = rootList.map(([r]) => r);
  const upStartItems: Array<{ funcName: string; calleeId: string }> = [];
  for (const nodeId of nodes.keys()) {
    const { name: nn } = parseGtagsNodeId(nodeId);
    upStartItems.push({ funcName: nn, calleeId: nodeId });
  }
  await gtagsBfsUpFull({ nodes, edgeSet, errs, tags: mergedTags, scopeMap: mergedScopeMap, wsRoot: rootList[0][0], wsRoots: allWsRootsForUp, currentFile: '', startItems: upStartItems, token, pct, pctRange: [95, 100] });

  const label = uniqueUris.length === 1 ? path.basename(uniqueUris[0].fsPath) : `${uniqueUris.length} files`;
  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: label, buildTimeMs: Date.now() - t0, errors: errs,
  };
}

export async function buildPathThroughCallGraphGtags(
  document: vscode.TextDocument, position: vscode.Position, maxHops = 4,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?:    vscode.CancellationToken
): Promise<GraphData> {
  const t0    = Date.now();
  const errs: string[] = [];
  const wsRoot  = getWorkspaceRootForFile(document.uri);
  if (!wsRoot) throw new Error('No workspace folder is open.');
  const wsRoots = getWorkspaceRoots(document.uri);
  const pct = new Pct(progress);

  pct.to(0);
  checkCancellation(token);
  { const w = await ensureGtagsDb(wsRoot); if (w) errs.push(w); }
  pct.to(5);
  pct.report('📂 Loading tags...');
  const { tags, lineCache, ambiguousNames, scopeMap } = await collectGtagsCached(wsRoot);
  if (!tags.size) throw new Error('No tags found.');
  if (ambiguousNames.length > 0) {
    const preview = ambiguousNames.slice(0, 5).join(', ');
    const suffix  = ambiguousNames.length > 5 ? ` and ${ambiguousNames.length - 5} more` : '';
    errs.push(`[gtags] Duplicate function names across files (resolved by callerFile priority): ${preview}${suffix}`);
  }

  const currentFile     = document.uri.fsPath;
  const currentFileNorm = normalizeFsPath(currentFile);
  const currentLines    = document.getText().split('\n');
  lineCache.set(currentFile, currentLines);
  lineCache.set(currentFileNorm, currentLines);

  // 起点関数を特定
  const cursorLine = position.line + 1;
  const fileScopes = findScopeMapEntry(scopeMap, currentFile)?.list ?? [];
  const startScope = findScopeAtLine(fileScopes, cursorLine);
  if (!startScope) throw new Error('No function found at cursor position.\nPlace the cursor on a function name and try again.');
  const startEntry =
    tags.get(startScope.name)?.find(e => normalizeFsPath(e.file) === currentFileNorm && e.isFunc)
    ?? tags.get(startScope.name)?.find(e => e.isFunc)
    ?? tags.get(startScope.name)?.[0];
  if (!startEntry) throw new Error('Tag info for the start function was not found.');

  const nodes   = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // 下方向 BFS
  pct.to(20);
  await gtagsBfsDownFull({ nodes, edgeSet, errs, tags, scopeMap, lineCache, wsRoot, currentFile,
    startItems: [{ name: startScope.name, entry: startEntry, scope: startScope }],
    maxHops, token, pct, pctRange: [20, 55] });

  // 上方向 BFS
  pct.to(55);
  const startNodeId = makeGtagsNodeId(startEntry.file, startScope.name, startEntry.line);
  await gtagsBfsUpFull({ nodes, edgeSet, errs, tags, scopeMap, wsRoot, wsRoots, currentFile,
    startItems: [{ funcName: startScope.name, calleeId: startNodeId }],
    maxHops, token, pct, pctRange: [55, 100] });

  return {
    nodes: Array.from(nodes.values()), edges: splitEdges(edgeSet),
    fileName: `↕ ${startScope.name} (${path.basename(currentFile)})`,
    buildTimeMs: Date.now() - t0, errors: errs,
  };
}