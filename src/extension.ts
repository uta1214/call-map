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
  invalidateCache,
  Backend,
  GraphData,
} from './callGraphBuilder';

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
const EXCLUDE_DIRS = new Set(['node_modules', 'build', 'dist', 'out', '.git']);

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
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        if (EXCLUDE_DIRS.has(name)) continue;
        await walk(vscode.Uri.joinPath(uri, name));
      } else if (type === vscode.FileType.File) {
        if (extensions.has(path.extname(name).toLowerCase())) {
          result.push(vscode.Uri.joinPath(uri, name));
        }
      }
      // SymbolicLink は意図的に無視
    }
  }

  await walk(folderUri);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: バックエンド選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickBackend(): Promise<Backend | undefined> {
  // ⑩ callmap.defaultBackend 設定値を初期アクティブ項目として反映する
  const defaultBackend = vscode.workspace.getConfiguration('callmap').get<string>('defaultBackend', 'lsp');
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
  const picked = await vscode.window.showQuickPick(
    items,
    {
      placeHolder:   'Select analysis backend',
      title:         'Call Map: Backend',
      // デフォルトバックエンドに対応するインデックスを初期選択に設定
      activeItems:   items.filter(i => i.backend === defaultBackend),
    } as vscode.QuickPickOptions & { activeItems: typeof items }
  );
  return picked?.backend;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: 出力モード選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickOutputMode(): Promise<OutputMode | undefined> {
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
  const onChanged = (uri: vscode.Uri) => invalidateCache(uri.fsPath);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onChanged),
    watcher.onDidCreate(onChanged),
    watcher.onDidDelete(onChanged),
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
      const mode = await pickOutputMode();
      if (!mode) return;

      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog, tok) => buildFileCallGraph(editor.document, prog, backend, tok));
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
      const mode = await pickOutputMode();
      if (!mode) return;

      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        // ⑩ callmap.maxHops 設定値を参照する（デフォルト 4）。
        //   旧実装は Number.MAX_SAFE_INTEGER をハードコードしており設定が無視されていた。
        (prog, tok) => {
          const maxHops = vscode.workspace.getConfiguration('callmap').get<number>('maxHops', 4);
          return buildFunctionCallGraph(editor.document, editor.selection.active, maxHops, prog, backend, tok);
        });
    })
  );

  // ── ワークスペース横断解析 ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showWorkspaceGraph', async () => {
      // ★ Fix 2: showFolderGraph と同じ extensions Set ベースの QuickPick に統一
      //   glob ベースの vscode.workspace.findFiles → findFilesInFolder (fs.readDirectory) に変更。
      //   動作の一貫性を保ちつつ、RelativePattern の互換問題も回避する。
      type ExtItem = vscode.QuickPickItem & { extensions: Set<string> };
      const extPick = await vscode.window.showQuickPick<ExtItem>(
        [
          {
            label:       '$(files) All (source only)',
            description: '.c .cpp .cc .cxx .cu .cuh',
            extensions:  new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']),
          },
          {
            label:       '$(file-code) C source',
            description: '.c',
            extensions:  new Set(['.c']),
          },
          {
            label:       '$(file-code) C++ source',
            description: '.cpp .cc .cxx',
            extensions:  new Set(['.cpp', '.cc', '.cxx']),
          },
          {
            label:       '$(file-code) CUDA',
            description: '.cu .cuh',
            extensions:  new Set(['.cu', '.cuh']),
          },
        ],
        { placeHolder: 'Select file extensions to analyze', title: 'Call Map: Workspace analysis' }
      );
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
            workspaceFolders.map(folder => findFilesInFolder(folder.uri, extPick.extensions))
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
      const mode = await pickOutputMode();
      if (!mode) return;

      await buildAndOutput(mode, `${foundUris.length} files`, context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, prog, backend, tok));
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
          folderUri = stat.type === vscode.FileType.Directory
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

      type ExtItem = vscode.QuickPickItem & { extensions: Set<string> };
      const extPick = await vscode.window.showQuickPick<ExtItem>(
        [
          {
            label:       '$(files) All (source only)',
            description: '.c .cpp .cc .cxx .cu .cuh',
            extensions:  new Set(['.c', '.cpp', '.cc', '.cxx', '.cu', '.cuh']),
          },
          {
            label:       '$(file-code) C source',
            description: '.c',
            extensions:  new Set(['.c']),
          },
          {
            label:       '$(file-code) C++ source',
            description: '.cpp .cc .cxx',
            extensions:  new Set(['.cpp', '.cc', '.cxx']),
          },
          {
            label:       '$(file-code) CUDA',
            description: '.cu .cuh',
            extensions:  new Set(['.cu', '.cuh']),
          },
        ],
        { placeHolder: 'Select file extensions to analyze', title: 'Call Map: Folder analysis' }
      );
      if (!extPick) return;
      if (!folderUri) return; // 型ガード (到達しないが TypeScript の安全のため)

      // vscode.workspace.fs.readDirectory による再帰探索
      // （RelativePattern + findFiles はワークスペース外フォルダで 0 件になる場合がある）
      const foundUris = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Searching C/C++ files...', cancellable: false },
        () => findFilesInFolder(folderUri, extPick.extensions)
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
      const mode = await pickOutputMode();
      if (!mode) return;

      const folderName = path.basename(folderUri.fsPath);
      await buildAndOutput(mode, folderName, context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, prog, backend, tok));
    })
  );
  // ── パス貫通コールグラフ ─────────────────────────────────────────────────
  // 選択した関数を中心に、上方向 (callers) + 下方向 (callees) を展開して
  // "F を通る" パスのみを左→右の流れで表示する。gtags バックエンド専用。
  // コマンドパレット: Ctrl+Alt+P / 右クリックメニュー
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showPathGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Map: Please open a C/C++ file first.');
        return;
      }
      const mode = await pickOutputMode();
      if (!mode) return;

      // ⑩ callmap.maxHops 設定値を参照する（デフォルト 4）
      const maxHops = vscode.workspace.getConfiguration('callmap').get<number>('maxHops', 4);
      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog, tok) => buildPathThroughCallGraph(
          editor.document, editor.selection.active, maxHops, prog, 'gtags', tok));
    })
  );
}

// ★ ⑨: 拡張機能の非アクティブ化時に static パネルを明示的に解放する。
//   CallGraphPanel.currentPanel は context.subscriptions に入らないため、
//   deactivate() で手動 dispose する必要がある。
export function deactivate(): void {
  CallGraphPanel.currentPanel?.dispose();
}