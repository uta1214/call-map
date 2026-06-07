/**
 * extension.ts
 *
 * 【変更点 (main ← gtags マージ)】
 *  - pickBackend() を追加: 実行のたびに LSP / gtags をユーザーが選択する
 *  - backend は build コールバックのクロージャで渡すため buildAndOutput の引数には含めない
 *
 * 【追加修正】
 *  - buildAndOutput: cancellable: true に変更し、token を build コールバックに渡す。(④)
 *    CancellationError はユーザー操作によるキャンセルのためエラーメッセージを表示しない。
 *  - deactivate(): CallGraphPanel.currentPanel?.dispose() を呼ぶ。(⑨)
 *    static パネルを context.subscriptions に追加できないため、
 *    deactivate 時に明示的に解放する。
 *
 * 【Feature G】callgraph.showFolderGraph コマンドを追加。
 *  - フォルダを選択してそのフォルダ配下のファイルのみを対象に解析する。
 *  - explorer/context のフォルダ右クリックから URI を直接受け取ることも可能。
 *  - vscode.RelativePattern でフォルダ相対のファイル検索を実現。
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { CallGraphPanel } from './webviewPanel';
import {
  buildFileCallGraph,
  buildFunctionCallGraph,
  buildWorkspaceCallGraph,
  buildPathThroughCallGraph,
  warmupCache,
  Backend,
  GraphData,
} from './callGraphBuilder';
import { cache } from './cacheManager';
import { hasCppSourceExtension } from './utils';
/** ⑩ callmap.warnThreshold 設定値を読み取る。設定変更時も都度参照するため関数化する。 */
function getWarnThreshold(): number {
  return vscode.workspace.getConfiguration('callmap').get<number>('warnThreshold', 30);
}

type OutputMode = 'webview' | 'html';

// ─────────────────────────────────────────────────────────────────────────────
// フォルダ再帰探索
// vscode.workspace.findFiles + RelativePattern はワークスペース外フォルダや
// 特定 VS Code バージョンで 0 件を返すことがあるため、
// vscode.workspace.fs.readDirectory による再帰探索で代替する。
// ─────────────────────────────────────────────────────────────────────────────

/** 除外するディレクトリ名 (EXCLUDE_GLOB に対応) */
// Low-2 修正: CMake / Ninja / ccache 等が生成するディレクトリを追加。
//   これらに生成ファイル (.c/.cpp) が含まれると解析結果に混入する。
const EXCLUDE_DIRS = new Set([
  // 共通
  'node_modules', 'build', 'dist', 'out', '.git',
  // CMake 系
  'CMakeFiles', '_build', '_deps', 'cmake-build-debug', 'cmake-build-release',
  // ツール系
  '.cache', '.ccls-cache', 'vendor', '.deps',
]);

/**
 * folderUri 配下のファイルを再帰的に収集して extensions でフィルタする。
 * シンボリックリンクは無視（無限ループ防止）。
 */
async function findFilesInFolder(
  folderUri:  vscode.Uri,
  extensions: Set<string>
): Promise<vscode.Uri[]> {
  const result: vscode.Uri[] = [];

  async function walk(uri: vscode.Uri): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return; // 読み取り不可なディレクトリはスキップ
    }
    const subdirs: vscode.Uri[] = [];
    for (const [name, type] of entries) {
      // Bug-6 修正: vscode.FileType はビットフラグ。
      // シンボリックリンクのディレクトリは FileType.SymbolicLink(64)|Directory(2)=66 となり
      // 厳密等価 === では Directory(2) にマッチしない。ビットマスクで判定する。
      // シンボリックリンクは無限ループ防止のため意図的に除外する。
      const isSymlink = !!(type & vscode.FileType.SymbolicLink);
      if (!isSymlink && (type & vscode.FileType.Directory)) {
        if (EXCLUDE_DIRS.has(name)) continue;
        subdirs.push(vscode.Uri.joinPath(uri, name)); // ① 収集してから並列展開
      } else if (!isSymlink && (type & vscode.FileType.File)) {
        if (extensions.has(path.extname(name).toLowerCase())) {
          result.push(vscode.Uri.joinPath(uri, name));
        }
      }
      // SymbolicLink は無限ループ防止のため意図的にスキップ
    }
    await Promise.all(subdirs.map(walk)); // ① シリアル await → 並列 Promise.all
  }

  await walk(folderUri);
  return result;
}

// C: findFilesInFolder の結果キャッシュ (60 秒 TTL)
// showWorkspaceGraph / showFolderGraph は毎回 readDirectory 再帰走査を行っていたが、
// 大規模プロジェクトでは数百ms〜数秒かかる。2回目以降はキャッシュから即座に返す。
// FSW の onChanged でキャッシュをクリアするため、ファイル追加・削除も自動的に反映される。
// QUALITY-2 修正: TTL チェックは CacheManager.getFolderFiles() 内部に移管したため
// FOLDER_FILES_CACHE_TTL 定数と getFolderFilesEntry の呼び出しを削除。


async function findFilesInFolderCached(
  folderUri:  vscode.Uri,
  extensions: Set<string>,
): Promise<vscode.Uri[]> {
  // BUG-3 修正: Unix ではファイルパスに '|' を含めることができるため \\x00 (NUL) を使用する。
  // NUL はファイルパスに含まれない唯一の文字であるためキー衝突が起きない。
  const key = `${folderUri.fsPath}\x00${[...extensions].sort().join(',')}`;
  const hit = cache.getFolderFiles(key);
  if (hit) return hit;
  const uris = await findFilesInFolder(folderUri, extensions);
  cache.setFolderFiles(key, uris);
  return uris;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: バックエンド選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickBackend(): Promise<Backend | undefined> {
  // ⑩ callmap.defaultBackend 設定値を反映する
  // 'lsp' または 'gtags' に設定されている場合は QuickPick をスキップして即返す。
  // defaultOutputMode と同じ設計。'ask'（デフォルト）なら毎回選択を促す。
  const defaultBackend = vscode.workspace.getConfiguration('callmap').get<string>('defaultBackend', 'ask');
  if (defaultBackend === 'lsp')   return 'lsp';
  if (defaultBackend === 'gtags') return 'gtags';
  const items = [
    {
      label:       '$(search) LSP (High accuracy)',
      description: 'Uses clangd / C/C++ extension. Requires LSP index.',
      backend:     'lsp' as const,
    },
    {
      label:       '$(zap) gtags (Fast)',
      description: 'Uses GNU GLOBAL. No LSP required. Suitable for large projects.',
      backend:     'gtags' as const,
    },
  ];
  // 🟠 Bug 2 修正: vscode.window.showQuickPick の QuickPickOptions に activeItems は存在しないため
  //   型キャストで誤魔化しても実行時には完全に無視されていた。
  //   createQuickPick() に切り替えることで qp.activeItems が正しく機能し、
  //   callmap.defaultBackend 設定値が初期選択に反映される。
  type BackendItem = typeof items[number];
  const qp = vscode.window.createQuickPick<BackendItem>();
  qp.items       = items;
  qp.placeholder = 'Select analysis backend';
  qp.title       = 'Call Map: Backend';
  qp.activeItems = items.filter(i => i.backend === defaultBackend);
  return new Promise(resolve => {
    // BUG-2 修正: onDidAccept → qp.hide() の順で呼ぶと onDidHide も必ず発火し
    // resolve(undefined) が再実行される。accepted フラグで二重解決を防ぐ。
    let accepted = false;
    qp.onDidAccept(() => {
      accepted = true;
      resolve(qp.selectedItems[0]?.backend);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!accepted) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: 出力モード選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickOutputMode(): Promise<OutputMode | undefined> {
  // ③ callmap.defaultOutputMode が 'webview' or 'html' なら QuickPick をスキップ
  const defaultMode = vscode.workspace.getConfiguration('callmap').get<string>('defaultOutputMode', 'ask');
  if (defaultMode === 'webview') return 'webview';
  if (defaultMode === 'html')    return 'html';

  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(callhierarchy-outgoing) Open in WebView',        mode: 'webview' as const },
      { label: '$(browser) Save as HTML and open in browser', mode: 'html'    as const },
    ],
    { placeHolder: 'Select output mode', title: 'Call Map: Output mode' }
  );
  return picked?.mode;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: ファイル拡張子選択 (⑦ showWorkspaceGraph / showFolderGraph で共用)
// ─────────────────────────────────────────────────────────────────────────────

type ExtItem = vscode.QuickPickItem & { extensions: Set<string> };

async function pickExtensions(title: string): Promise<ExtItem | undefined> {
  return vscode.window.showQuickPick<ExtItem>(
    [
      {
        label:       '$(files) C / C++ (all source)',
        description: '.c .cpp .cc .cxx .cu .cuh',
        extensions:  new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']),
      },
      {
        label:       '$(files) C + C++ (no CUDA)',
        description: '.c .cpp .cc .cxx',
        extensions:  new Set(['.c', '.cpp', '.cc', '.cxx']),
      },
      {
        label:       '$(file-code) C only',
        description: '.c',
        extensions:  new Set(['.c']),
      },
      {
        label:       '$(file-code) C++ only',
        description: '.cpp .cc .cxx',
        extensions:  new Set(['.cpp', '.cc', '.cxx']),
      },
    ],
    { placeHolder: 'Select file extensions to analyze', title }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ビルド & 出力
// ─────────────────────────────────────────────────────────────────────────────

async function buildAndOutput(
  mode:         OutputMode,
  fileName:     string,
  extensionUri: vscode.Uri,
  // ★ ④: token を build コールバックに渡すため引数に追加
  build: (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token:    vscode.CancellationToken
  ) => Promise<GraphData>
): Promise<void> {
  const panel = mode === 'webview' ? CallGraphPanel.createOrShow(extensionUri) : undefined;
  panel?.setLoading(path.basename(fileName));

  await vscode.window.withProgress(
    {
      location:    vscode.ProgressLocation.Notification,
      title:       'Building Call Map',
      // ★ ④: キャンセル可能にする
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const data = await build(progress, token);

        // キャンセル済みの場合はパネルを更新しない
        if (token.isCancellationRequested) return;

        if (data.errors.length > 0) console.warn('[CallMap] Analysis warnings:', data.errors);

        if (mode === 'webview') {
          panel!.updateGraph(data);
          vscode.window.setStatusBarMessage(
            `📞 Call Map: ${data.nodes.length} nodes / ${data.edges.length} edges (${data.buildTimeMs}ms)`,
            6000
          );
        } else {
          await CallGraphPanel.exportHtmlFile(extensionUri, data);
        }
      } catch (err) {
        // ★ ④: CancellationError はユーザー操作によるキャンセルのため通知しない
        if (err instanceof vscode.CancellationError) return;

        const msg = err instanceof Error ? err.message : String(err);
        if (panel) panel.showError(msg);
        else vscode.window.showErrorMessage('Call Map error:\n' + msg);
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// コマンド登録
// ─────────────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

  // ⑦ ファイル変更時にキャッシュを無効化する FileSystemWatcher
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{c,cpp,cc,cxx,cu,cuh,h,hpp,hxx}',
    false, false, false
  );
  // A: FileSystemWatcher デバウンス（バグ修正版）
  // ──────────────────────────────────────────────────────────────────────────
  // ① onDidChange（ファイル内容変更）: graphData / tags キャッシュのみ無効化。
  //    ファイル一覧は変わらないため invalidateFileList は呼ばない。
  // ② onDidCreate / onDidDelete（ファイル構造変更）: 全キャッシュ + fileList 系を無効化。
  //    デバウンスタイマーを分離することで、両イベントが混在しても確実に動作する。
  // SEC-05 修正: ウォッチャーグロブ '**' は node_modules / build 等を含む。
  //   VS Code の createFileSystemWatcher は exclude パターンをサポートしないため、
  //   イベントハンドラ内で EXCLUDE_DIRS を使って除外する。
  // ──────────────────────────────────────────────────────────────────────────

  // SEC-05: パスのいずれかのセグメントが EXCLUDE_DIRS に含まれていればスキップ
  // / と \ 両方を区切りとして扱うことで Windows/WSL 混在環境でも正しく動作する
  const isExcludedPath = (fsPath: string): boolean =>
    fsPath.split(/[/\\]/).some(seg => EXCLUDE_DIRS.has(seg));

  let _contentTimer: ReturnType<typeof setTimeout> | undefined;
  const _contentPending = new Set<string>();
  const onContentChanged = (uri: vscode.Uri) => {
    if (isExcludedPath(uri.fsPath)) return; // SEC-05 除外
    _contentPending.add(uri.fsPath);
    clearTimeout(_contentTimer);
    _contentTimer = setTimeout(() => {
      const paths = [..._contentPending];
      _contentPending.clear();
      if (paths.length >= 5) cache.invalidateAll();
      else paths.forEach(fp => cache.invalidateFile(fp));

    }, 300);
  };

  let _structTimer: ReturnType<typeof setTimeout> | undefined;
  const _structPending = new Set<string>();
  const onFsStructureChanged = (uri: vscode.Uri) => {
    if (isExcludedPath(uri.fsPath)) return; // SEC-05 除外
    _structPending.add(uri.fsPath);
    clearTimeout(_structTimer);
    _structTimer = setTimeout(() => {
      const paths = [..._structPending];
      _structPending.clear();
      if (paths.length >= 5) cache.invalidateAll();
      else {
        paths.forEach(fp => cache.invalidateFile(fp));
        cache.invalidateFileList(); // 構造変更時のみ fileList 系もクリア
      }
    }, 300);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onContentChanged),
    watcher.onDidCreate(onFsStructureChanged),
    watcher.onDidDelete(onFsStructureChanged),
  );

  // ── ワークスペース横断解析 ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showWorkspaceGraph', async () => {
      // ★ Fix 2: showFolderGraph と同じ extensions Set ベースの QuickPick に統一
      //   glob ベースの vscode.workspace.findFiles → findFilesInFolder (fs.readDirectory) に変更。
      //   動作の一貫性を保ちつつ、RelativePattern の互換問題も回避する。
      const extPick = await pickExtensions('Call Map: Workspace analysis'); // ⑦ 共通化
      if (!extPick) return;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode.window.showErrorMessage('Call Map: No workspace folder is open.');
        return;
      }

      // ★ Fix 2: 全ワークスペースフォルダを findFilesInFolder で並列収集してフラット化
      const foundUris = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Searching C/C++ files...', cancellable: false },
        async () => {
          const results = await Promise.all(
            workspaceFolders.map(folder => findFilesInFolderCached(folder.uri, extPick.extensions))
          );
          return results.flat();
        }
      );
      if (!foundUris.length) {
        vscode.window.showErrorMessage(
          'Call Map: No target files found.\nExtension: ' + extPick.description);
        return;
      }

      if (foundUris.length > getWarnThreshold()) {
        const answer = await vscode.window.showWarningMessage(
          `Analyze ${foundUris.length} files. Continue?`, { modal: true }, 'Continue');
        if (answer !== 'Continue') return;
      }

      const backend = await pickBackend();
      if (!backend) return;
      // BUG-02 修正: showWorkspaceGraph でも backend 確定後に warmupCache を呼ぶ。
      // pickOutputMode の待機中に gtags DB 更新・タグキャッシュ温めを並行実行する。
      const activeEditor = vscode.window.activeTextEditor;
      // BUG-08 修正: 非 C/C++ ファイルを開いていると warmup が無意味になる（LSP は無関係なシンボルを取得）。
      const warmupDone = (activeEditor && hasCppSourceExtension(activeEditor.document.uri))
        ? warmupCache(activeEditor.document, backend).catch(() => {}) : Promise.resolve();
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; }
      await warmupDone;

      await buildAndOutput(mode, `${foundUris.length} files`, context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, backend, prog, tok));
    })
  );

  // ── フォルダ指定コールグラフ ──────────────────────────────────────────────
  // explorer/context のフォルダ右クリックから呼ばれた場合は uri が渡される。
  // コマンドパレット / エディタ右クリックから呼ばれた場合は uri が undefined のため
  // showOpenDialog でフォルダを選択させる。
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFolderGraph', async (uri?: vscode.Uri) => {
      let folderUri: vscode.Uri | undefined;

      if (uri) {
        // explorer/context（フォルダ右クリック）: フォルダ URI が渡される
        // editor/context（エディタ右クリック）: ファイル URI が渡されるため親ディレクトリを使う
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          // Bug-6 同様、FileType はビットフラグ。シンボリックリンクのディレクトリは
          // FileType.SymbolicLink(64)|Directory(2)=66 となるため厳密等価では判定できない。
          folderUri = (stat.type & vscode.FileType.Directory)
            ? uri
            : vscode.Uri.file(path.dirname(uri.fsPath));
        } catch {
          // stat 失敗時は親ディレクトリにフォールバック
          folderUri = vscode.Uri.file(path.dirname(uri.fsPath));
        }
      } else {
        // コマンドパレット / エディタ右クリック経由: ダイアログでフォルダを選択
        // デフォルト位置を現在のファイルのフォルダに設定する
        const activeFile = vscode.window.activeTextEditor?.document.uri;
        const defaultUri = activeFile
          ? vscode.Uri.file(path.dirname(activeFile.fsPath))
          : vscode.workspace.workspaceFolders?.[0]?.uri;
        const result = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles:   false,
          canSelectMany:    false,
          openLabel:        'Analyze this folder',
          title:            'Call Map: Select folder to analyze',
          defaultUri,
        });
        if (!result?.length) return;
        folderUri = result[0];
      }

      const extPick = await pickExtensions('Call Map: Folder analysis'); // ⑦ 共通化
      if (!extPick) return;
      if (!folderUri) return; // 型ガード (到達しないが TypeScript の安全のため)

      // vscode.workspace.fs.readDirectory による再帰探索
      // （RelativePattern + findFiles はワークスペース外フォルダで 0 件になる場合がある）
      const foundUris = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Searching C/C++ files...', cancellable: false },
        () => findFilesInFolderCached(folderUri, extPick.extensions)
      );

      if (!foundUris.length) {
        vscode.window.showErrorMessage(
          `Call Map: No target files found.\nFolder: ${folderUri.fsPath}\nExtension: ${extPick.description}`);
        return;
      }

      if (foundUris.length > getWarnThreshold()) {
        const answer = await vscode.window.showWarningMessage(
          `Analyze ${foundUris.length} files. Continue?`, { modal: true }, 'Continue');
        if (answer !== 'Continue') return;
      }

      const backend = await pickBackend();
      if (!backend) return;
      // BUG-02 修正: showFolderGraph でも warmupCache を並行実行する。
      const activeEditorF = vscode.window.activeTextEditor;
      // BUG-08 修正: 非 C/C++ ファイルを開いていると warmup が無意味になる。
      const warmupDoneF = (activeEditorF && hasCppSourceExtension(activeEditorF.document.uri))
        ? warmupCache(activeEditorF.document, backend).catch(() => {}) : Promise.resolve();
      const mode = await pickOutputMode();
      if (!mode) { await warmupDoneF; return; }
      await warmupDoneF;

      const folderName = path.basename(folderUri.fsPath);
      await buildAndOutput(mode, folderName, context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, backend, prog, tok));
    })
  );

  // ── ファイル単位コールグラフ ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFileGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Map: Please open a C/C++ file first.');
        return;
      }
      const backend = await pickBackend();
      if (!backend) return;
      // B: バックエンド確定直後に初期化を先行起動。pickOutputMode 待ちの間に走る。
      const warmupDone = warmupCache(editor.document, backend).catch(() => {});
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; } // キャンセル時も Promise を settle させる
      await warmupDone; // すでに完了していれば即座に返る

      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog, tok) => buildFileCallGraph(editor.document, backend, prog, tok));
    })
  );

  // ── 関数起点 BFS コールグラフ ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFunctionGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Map: Please open a C/C++ file first.');
        return;
      }
      const backend = await pickBackend();
      if (!backend) return;
      // B: バックエンド確定直後に初期化を先行起動
      const warmupDone = warmupCache(editor.document, backend).catch(() => {});
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; }
      await warmupDone;

      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        // ⑩ callmap.maxHops 設定値を参照する（デフォルト 4）。
        //   旧実装は Number.MAX_SAFE_INTEGER をハードコードしており設定が無視されていた。
        (prog, tok) => {
          const maxHops = vscode.workspace.getConfiguration('callmap').get<number>('maxHops', 4);
          return buildFunctionCallGraph(editor.document, editor.selection.active, maxHops, backend, prog, tok);
        });
    })
  );

  // ── パス貫通コールグラフ ─────────────────────────────────────────────────
  // 選択した関数を中心に、上方向 (callers) + 下方向 (callees) を展開して
  // "F を通る" パスを表示する。LSP / gtags 両バックエンド対応。
  // コマンドパレット: Ctrl+Alt+P / 右クリックメニュー
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showPathGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Map: Please open a C/C++ file first.');
        return;
      }
      const backend = await pickBackend();
      if (!backend) return;
      // バックエンド選択後に warmup を先行起動（pickOutputMode 待ちの間に DB 更新が走る）
      const warmupDone = warmupCache(editor.document, backend).catch(() => {});
      const mode = await pickOutputMode();
      if (!mode) { await warmupDone; return; }
      await warmupDone;

      // ⑩ callmap.maxHops 設定値を参照する（デフォルト 4）
      const maxHops = vscode.workspace.getConfiguration('callmap').get<number>('maxHops', 4);
      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog, tok) => buildPathThroughCallGraph(
          editor.document, editor.selection.active, maxHops, backend, prog, tok));
    })
  );
}

// ★ ⑨: 拡張機能の非アクティブ化時に static パネルを明示的に解放する。
//   CallGraphPanel.currentPanel は context.subscriptions に入らないため、
//   deactivate() で手動 dispose する必要がある。
export function deactivate(): void {
  CallGraphPanel.currentPanel?.dispose();
  cache.invalidateAll();
}