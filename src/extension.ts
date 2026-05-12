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
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { CallGraphPanel } from './webviewPanel';
import {
  buildFileCallGraph,
  buildFunctionCallGraph,
  buildWorkspaceCallGraph,
  EXCLUDE_GLOB,
  Backend,
  GraphData,
} from './callGraphBuilder';

const WARN_THRESHOLD = 50;

type OutputMode = 'webview' | 'html';

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: バックエンド選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickBackend(): Promise<Backend | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label:       '$(search) LSP (高精度)',
        description: 'clangd / C/C++ 拡張機能を使用。インデックスが必要。',
        backend:     'lsp' as const,
      },
      {
        label:       '$(zap) gtags (高速)',
        description: 'GNU Global を使用。LSP 不要で大規模プロジェクトに適する。',
        backend:     'gtags' as const,
      },
    ],
    { placeHolder: '解析バックエンドを選択してください', title: 'Call Map: バックエンド' }
  );
  return picked?.backend;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickPick: 出力モード選択
// ─────────────────────────────────────────────────────────────────────────────

async function pickOutputMode(): Promise<OutputMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(callhierarchy-outgoing) WebView で表示',        mode: 'webview' as const },
      { label: '$(browser) HTML ファイルに保存してブラウザで開く', mode: 'html'    as const },
    ],
    { placeHolder: '表示方法を選択してください', title: 'Call Map: 出力モード' }
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
      title:       'Call Map を構築中',
      // ★ ④: キャンセル可能にする
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const data = await build(progress, token);

        // キャンセル済みの場合はパネルを更新しない
        if (token.isCancellationRequested) return;

        if (data.errors.length > 0) console.warn('[CallMap] 解析警告:', data.errors);

        if (mode === 'webview') {
          panel!.updateGraph(data);
          vscode.window.setStatusBarMessage(
            `📞 Call Map: ${data.nodes.length} ノード / ${data.edges.length} エッジ (${data.buildTimeMs}ms)`,
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
        else vscode.window.showErrorMessage('Call Map エラー:\n' + msg);
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// コマンド登録
// ─────────────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

  // ── ファイル単位コールグラフ ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFileGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Call Map: C/C++ ファイルを開いてから実行してください。');
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
        vscode.window.showErrorMessage('Call Map: C/C++ ファイルを開いてから実行してください。');
        return;
      }
      const backend = await pickBackend();
      if (!backend) return;
      const mode = await pickOutputMode();
      if (!mode) return;

      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog, tok) => buildFunctionCallGraph(editor.document, editor.selection.active, 4, prog, backend, tok));
    })
  );

  // ── ワークスペース横断解析 ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showWorkspaceGraph', async () => {
      type ExtItem = vscode.QuickPickItem & { glob: string };
      const extPick = await vscode.window.showQuickPick<ExtItem>(
        [
          {
            label:       '$(files) すべて (ソースのみ)',
            description: '.c .cpp .cc .cxx .cu .cuh',
            glob:        '**/*.{c,cpp,cc,cxx,cu,cuh}',
          },
          {
            label:       '$(file-code) C ソース',
            description: '.c',
            glob:        '**/*.c',
          },
          {
            label:       '$(file-code) C++ ソース',
            description: '.cpp .cc .cxx',
            glob:        '**/*.{cpp,cc,cxx}',
          },
          {
            label:       '$(file-code) CUDA',
            description: '.cu .cuh',
            glob:        '**/*.{cu,cuh}',
          },
        ],
        { placeHolder: '解析対象の拡張子を選択してください', title: 'Call Map: ワークスペース横断解析' }
      );
      if (!extPick) return;

      const foundUris = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'C/C++ ファイルを検索中...', cancellable: false },
        () => vscode.workspace.findFiles(extPick.glob, EXCLUDE_GLOB)
      );
      if (!foundUris.length) {
        vscode.window.showErrorMessage(
          'Call Map: 対象ファイルが見つかりませんでした。\n対象: ' + extPick.description);
        return;
      }

      if (foundUris.length > WARN_THRESHOLD) {
        const answer = await vscode.window.showWarningMessage(
          `${foundUris.length} ファイルを解析します。続行しますか?`, { modal: true }, '続行');
        if (answer !== '続行') return;
      }

      const backend = await pickBackend();
      if (!backend) return;
      const mode = await pickOutputMode();
      if (!mode) return;

      await buildAndOutput(mode, `${foundUris.length} ファイル`, context.extensionUri,
        (prog, tok) => buildWorkspaceCallGraph(foundUris, prog, backend, tok));
    })
  );
}

// ★ ⑨: 拡張機能の非アクティブ化時に static パネルを明示的に解放する。
//   CallGraphPanel.currentPanel は context.subscriptions に入らないため、
//   deactivate() で手動 dispose する必要がある。
export function deactivate(): void {
  CallGraphPanel.currentPanel?.dispose();
}