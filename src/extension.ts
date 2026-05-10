/**
 * extension.ts
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { CallGraphPanel } from './webviewPanel';
import {
  buildFileCallGraph,
  buildFunctionCallGraph,
  buildWorkspaceCallGraph,
  GraphData,
  Backend,
} from './callGraphBuilder';

const EXCLUDE_GLOB   = '{**/node_modules/**,**/build/**,**/dist/**,**/out/**,**/.git/**}';
const WARN_THRESHOLD = 50;

type OutputMode = 'webview' | 'html';

function getBackend(): Backend {
  return vscode.workspace.getConfiguration('callgraph').get<Backend>('backend', 'auto');
}

async function pickOutputMode(): Promise<OutputMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(callhierarchy-outgoing) WebView で表示',       mode: 'webview' as const },
      { label: '$(browser) HTML ファイルに保存してブラウザで開く', mode: 'html'    as const },
    ],
    { placeHolder: '表示方法を選択してください', title: 'Call Graph: 出力モード' }
  );
  return picked?.mode;
}

async function buildAndOutput(
  mode:         OutputMode,
  fileName:     string,
  extensionUri: vscode.Uri,
  build: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<GraphData>
): Promise<void> {
  const panel = mode === 'webview' ? CallGraphPanel.createOrShow(extensionUri) : undefined;
  panel?.setLoading(path.basename(fileName));

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Call Graph を構築中', cancellable: false },
    async (progress) => {
      try {
        const data = await build(progress);

        if (data.errors.length > 0) console.warn('[CallGraph] 解析警告:', data.errors);

        if (mode === 'webview') {
          panel!.updateGraph(data);
          vscode.window.setStatusBarMessage(
            `📞 Call Graph: ${data.nodes.length} ノード / ${data.edges.length} エッジ (${data.buildTimeMs}ms)` +
            (data.errors.length > 0 ? ` ⚠ 警告: ${data.errors.length}件` : ''),
            6000
          );
        } else {
          await CallGraphPanel.exportHtmlFile(extensionUri, data);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (panel) panel.showError(msg);
        else vscode.window.showErrorMessage('Call Graph エラー:\n' + msg);
      }
    }
  );
}

export function activate(context: vscode.ExtensionContext): void {

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFileGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showErrorMessage('Call Graph: C/C++ ファイルを開いてから実行してください。'); return; }
      const mode = await pickOutputMode();
      if (!mode) return;
      const backend = getBackend();
      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog) => buildFileCallGraph(editor.document, prog, backend));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showFunctionGraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showErrorMessage('Call Graph: C/C++ ファイルを開いてから実行してください。'); return; }
      const mode = await pickOutputMode();
      if (!mode) return;
      const backend = getBackend();
      await buildAndOutput(mode, editor.document.fileName, context.extensionUri,
        (prog) => buildFunctionCallGraph(editor.document, editor.selection.active, 4, prog, backend));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showWorkspaceGraph', async () => {
      type ExtItem = vscode.QuickPickItem & { glob: string };
      const extPick = await vscode.window.showQuickPick<ExtItem>(
        [
          { label: '$(files) すべて',         description: '.c .cpp .cc .cxx .h .hpp .hxx .cu .cuh', glob: '**/*.{c,cpp,cc,cxx,h,hpp,hxx,cu,cuh}' },
          { label: '$(files) c/c++',          description: '.c .cpp',                                glob: '**/*.{c,cpp}'                           },
          { label: '$(file-code) C ソース',   description: '.c .h',                                  glob: '**/*.{c,h}'                             },
          { label: '$(file-code) C++ ソース', description: '.cpp .cc .cxx .hpp .hxx',                glob: '**/*.{cpp,cc,cxx,hpp,hxx}'              },
          { label: '$(file-code) CUDA',       description: '.cu .cuh',                               glob: '**/*.{cu,cuh}'                          },
        ],
        { placeHolder: '解析対象の拡張子を選択してください', title: 'Call Graph: ワークスペース横断解析' }
      );
      if (!extPick) return;

      const foundUris = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'C/C++ ファイルを検索中...', cancellable: false },
        () => vscode.workspace.findFiles(extPick.glob, EXCLUDE_GLOB)
      );
      if (!foundUris.length) {
        vscode.window.showErrorMessage('Call Graph: 対象ファイルが見つかりませんでした。\n対象: ' + extPick.description);
        return;
      }

      if (foundUris.length > WARN_THRESHOLD) {
        const answer = await vscode.window.showWarningMessage(
          `${foundUris.length} ファイルを解析します。続行しますか?`, { modal: true }, '続行');
        if (answer !== '続行') return;
      }

      const mode = await pickOutputMode();
      if (!mode) return;
      const backend = getBackend();
      await buildAndOutput(mode, `${foundUris.length} ファイル`, context.extensionUri,
        (prog) => buildWorkspaceCallGraph(foundUris, prog, backend));
    })
  );
}

export function deactivate(): void {}