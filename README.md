# Call Map

**Call Map** is a VS Code extension that visualizes interactive call graphs of C/C++ projects.  
It supports two analysis backends: **LSP** (using the Call Hierarchy API) for high accuracy, and **gtags** (using GNU GLOBAL) for speed.

---

## Key Features

### Call Graph Analysis
- **File Graph**: Analyze all functions in the current file and display their call relationships
- **Function Graph**: Start from the function at the cursor position and expand via BFS up to N hops
- **Workspace Graph**: Cross-file analysis across multiple C/C++ source files
- **Folder Graph**: Analyze all C/C++ files within a selected folder
- **Dual Backend**:
  - **LSP** — Uses clangd / C/C++ extension. High accuracy with full type resolution. Requires an LSP index.
  - **gtags** — Uses GNU GLOBAL. Fast analysis without LSP. Suitable for large projects.

### Interactive Graph View
- Click nodes to highlight callers (green) and callees (orange)
- **Hop filter**: Show only nodes within N hops of the selected node
- **Search box**: Filter by function name with Enter-to-focus and Esc-to-reset
- **Source code panel**: View source inline and jump to editor
- **File legend**: Per-file color coding
- **Font size control**
- **Collapsible control panel**: Hide the control panel to maximize graph area
- **HTML export**: Save as a standalone HTML file for sharing

---

## Installation

### Visual Studio Code Marketplace
https://github.com/uta1214/call-map

### Manual Installation
1. Clone or download this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build
4. Run `vsce package` to create a `.vsix` file
5. In VS Code, open **Extensions** → `...` → **Install from VSIX**

---

## Usage

### Basic Usage
1. Open a C/C++ file in the editor
2. Right-click to open the context menu, or open the Command Palette (`Ctrl+Shift+P`)
3. Select a command, then choose a **backend** (LSP or gtags) and an **output mode** (WebView or HTML file)

### Commands
| Command | Description |
|---------|-------------|
| `Call Map: Show File Call Graph` | Analyze all functions in the current file |
| `Call Map: Show Function Graph (BFS)` | Expand from the function at the cursor position |
| `Call Map: Analyze Workspace` | Cross-file analysis across the workspace |
| `Call Map: Analyze Folder` | Analyze all C/C++ files in a selected folder |

### Keybindings
| Feature | Key |
|---------|-----|
| Show File Call Graph | `Ctrl+Alt+M` |
| Show Function Graph  | `Ctrl+Alt+F` |

### Graph Operations
| Action | Description |
|--------|-------------|
| Click node | Highlight callers (green) and callees (orange) |
| Ctrl + Click node | Jump to source in editor |
| Hop buttons (1 / 2 / 3 / All) | Show only nodes within N hops of selected node |
| 🔍 Search box | Filter by function name (Enter to focus, Esc to reset) |
| Source panel checkbox | Toggle the source code panel |
| ▼ / ▶ toggle button | Collapse / expand the control panel |
| Double-click / Esc | Deselect and reset |
| Ctrl + Wheel | Zoom |
| Shift + Wheel | Horizontal scroll |
| Wheel | Vertical scroll |

---

## Configuration

### Main Settings

#### Analysis Settings
- `callmap.defaultBackend`: Default backend for call graph analysis
  - `lsp`: Use LSP (clangd / C/C++ extension) — high accuracy
  - `gtags`: Use GNU GLOBAL (gtags) — fast, no LSP required
  - Default: `lsp`
- `callmap.maxHops`: Maximum number of BFS hops for Function Graph
  - Default: `4`

#### Display Settings
- `callmap.warnThreshold`: Warn when the number of files to analyze exceeds this value
  - Default: `30`

---

## Requirements

- VS Code 1.85 or later
- **For LSP backend** — one of the following C/C++ language server extensions:
  - **clangd** (`llvm-vs-code-extensions.vscode-clangd`) ← recommended
  - **C/C++** (`ms-vscode.cpptools`)
- **For gtags backend** — GNU GLOBAL must be installed and available in PATH:
  - macOS: `brew install global`
  - Ubuntu/Debian: `sudo apt install global`
  - Windows: download from [GNU GLOBAL website](https://www.gnu.org/software/global/)

> **Tip for clangd users**: Having `compile_commands.json` in your project root greatly improves accuracy.
> Generate it with `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` (CMake) or `bear -- make` (Bear).

---

## Processing Time Reference

| Project size | Functions | Estimated time |
|---|---|---|
| Small | ~20 | 100–300 ms |
| Medium | ~80 | 400–800 ms |
| Large | ~200 | 1–2 s |

File-level display time is independent of total project size, since clangd maintains a persistent background index.

---

## Troubleshooting

### LSP: No symbols found
1. Verify that clangd or C/C++ extension is installed and enabled
2. Wait for the background index to complete (see status bar)
3. If using clangd: check that `compile_commands.json` exists in your project root

### gtags: No tags found
1. Verify that `gtags` is installed and available in PATH: `gtags --version`
2. Verify that `GTAGS`, `GRTAGS`, and `GPATH` files exist in your project root
3. Run `gtags` manually in the project root to generate the database

### Graph is empty
- Confirm that the file contains C/C++ function definitions recognized by the language server
- For gtags backend, make sure the project root is open as a workspace folder in VS Code

### Symbolic links are not followed
- `Analyze Folder` and `Analyze Workspace` do not follow symbolic links intentionally.
  If your project relies on symlinked source directories, add the real directory as a workspace folder instead.

### Function Graph (BFS) behavior differs between backends
- Both LSP and gtags backends perform **downward BFS only** (callee direction) for the `Show Function Graph (BFS)` command.
- If you need a bidirectional graph (both callers and callees), use the `Show Path-Through Graph (gtags)` command (gtags backend only).

---

## License

This project is licensed under the MIT License. (See LICENSE file)
Free to use, modify, and redistribute.

---

## Author

uta

---

## Repository

https://github.com/uta1214/call-map

---

# 日本語版 (Japanese)

# Call Map

**Call Map** は C/C++ プロジェクト向けのインタラクティブコールグラフ VSCode 拡張機能です。  
**LSP**（Call Hierarchy API 使用）による高精度解析と、**gtags**（GNU GLOBAL 使用）による高速解析の2バックエンドに対応しています。

---

## 主な機能

### コールグラフ解析
- **ファイルグラフ**: 現在のファイル内の全関数を解析し、コール関係を可視化
- **関数グラフ**: カーソル位置の関数を起点に BFS で N ホップ展開
- **ワークスペースグラフ**: 複数の C/C++ ソースファイルをまたいだ横断解析
- **フォルダグラフ**: 選択したフォルダ内の全 C/C++ ファイルを解析
- **デュアルバックエンド対応**:
  - **LSP** — clangd / C/C++ 拡張機能を使用。型解析込みの高精度解析。LSP インデックスが必要。
  - **gtags** — GNU GLOBAL を使用。LSP 不要で高速。大規模プロジェクトに適する。

### インタラクティブグラフ表示
- ノードクリックで caller（緑）と callee（橙）をハイライト
- **ホップフィルタ**: 選択ノードから N ホップ以内のノードのみ表示
- **検索ボックス**: 関数名でフィルタ（Enter でフォーカス移動、Esc でリセット）
- **ソースコードパネル**: ソースをインライン表示してエディタへジャンプ
- **ファイル凡例**: ファイル単位の色分け表示
- **文字サイズ調整**
- **コントロールパネル折りたたみ**: パネルを非表示にしてグラフ表示領域を最大化
- **HTML エクスポート**: スタンドアロン HTML として保存・共有

---

## インストール方法

### Visual Studio Code Marketplace
https://github.com/uta1214/call-map

### 手動インストール
1. このリポジトリをクローンまたはダウンロード
2. `npm install` で依存パッケージをインストール
3. `npm run compile` でビルド
4. `vsce package` で `.vsix` ファイルを作成
5. VS Code で「拡張機能」→「…」→「VSIX からインストール」を選択

---

## 使い方

### 基本的な使い方
1. C/C++ ファイルをエディタで開く
2. 右クリックメニュー or コマンドパレット（`Ctrl+Shift+P`）から実行
3. コマンドを選択後、**バックエンド**（LSP または gtags）と**出力モード**（WebView または HTML ファイル）を選択

### コマンド一覧
| コマンド | 説明 |
|---------|------|
| `Call Map: Show File Call Graph` | ファイル内の全関数を解析 |
| `Call Map: Show Function Graph (BFS)` | カーソル位置の関数から BFS で展開 |
| `Call Map: Analyze Workspace` | ワークスペース全体を横断解析 |
| `Call Map: Analyze Folder` | 選択フォルダ内の全 C/C++ ファイルを解析 |

### キーバインド
| 機能 | キー |
|------|------|
| Show File Call Graph | `Ctrl+Alt+M` |
| Show Function Graph  | `Ctrl+Alt+F` |

### グラフの操作方法
| 操作 | 内容 |
|------|------|
| ノードクリック | caller（緑）と callee（橙）をハイライト |
| Ctrl + クリック | エディタのソースへジャンプ |
| ホップ数ボタン（1 / 2 / 3 / All） | 選択ノードから N ホップ以内のみ表示 |
| 🔍 検索ボックス | 関数名でフィルタ（Enter でフォーカス移動、Esc でリセット） |
| ソースコードパネル チェックボックス | 右パネルを表示・非表示 |
| ▼ / ▶ トグルボタン | コントロールパネルを折りたたむ・展開する |
| ダブルクリック / Esc | 選択解除・リセット |
| Ctrl + ホイール | ズーム |
| Shift + ホイール | 横スクロール |
| ホイール | 縦スクロール |

---

## 設定

### 主な設定項目

#### 解析設定
- `callmap.defaultBackend`: コールグラフ解析のデフォルトバックエンド
  - `lsp`：LSP（clangd / C/C++ 拡張）を使用 — 高精度
  - `gtags`：GNU GLOBAL（gtags）を使用 — 高速、LSP 不要
  - デフォルト: `lsp`
- `callmap.maxHops`: Function Graph の BFS 最大ホップ数
  - デフォルト: `4`

#### 表示設定
- `callmap.warnThreshold`: 解析対象ファイル数がこの値を超えると警告を表示する
  - デフォルト: `30`

---

## 必要なもの

- VS Code 1.85 以上
- **LSP バックエンド使用時** — 以下のいずれかの C/C++ 言語サーバー拡張機能:
  - **clangd** (`llvm-vs-code-extensions.vscode-clangd`) ← 推奨・高精度
  - **C/C++** (`ms-vscode.cpptools`)
- **gtags バックエンド使用時** — GNU GLOBAL のインストールが必要（PATH に追加すること）:
  - macOS: `brew install global`
  - Ubuntu/Debian: `sudo apt install global`
  - Windows: [GNU GLOBAL 公式サイト](https://www.gnu.org/software/global/) からダウンロード

> **clangd を使う場合の注意**: プロジェクトルートに `compile_commands.json` があると精度が大幅に向上します。
> CMake なら `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`、Bear なら `bear -- make` で生成できます。

---

## 処理時間の目安

| ファイル規模 | 関数数 | 目安 |
|---|---|---|
| 小 | ~20 関数 | 100–300 ms |
| 中 | ~80 関数 | 400–800 ms |
| 大 | ~200 関数 | 1–2 秒 |

数万ファイルのプロジェクトでも **ファイル単位表示** の時間は変わりません。clangd がバックグラウンドでインデックスを保持しているためです。

---

## トラブルシューティング

### LSP: シンボルが見つからない
1. clangd または C/C++ 拡張機能がインストール・有効化されているか確認
2. バックグラウンドインデックスの完了を待つ（ステータスバーを確認）
3. clangd 使用時: プロジェクトルートに `compile_commands.json` があるか確認

### gtags: タグが見つからない
1. `gtags` が PATH に存在するか確認: `gtags --version`
2. プロジェクトルートに `GTAGS`・`GRTAGS`・`GPATH` ファイルが存在するか確認
3. プロジェクトルートで `gtags` を手動実行してデータベースを生成

### グラフが空になる
- ファイルに言語サーバーが認識できる C/C++ 関数定義が含まれているか確認
- gtags バックエンドの場合、プロジェクトルートが VS Code のワークスペースフォルダとして開かれているか確認

### シンボリックリンクが辿られない
- `Analyze Folder` および `Analyze Workspace` はシンボリックリンクを意図的に辿りません。
  プロジェクトがシンボリックリンクで繋がれたソースディレクトリに依存している場合は、
  リンク先の実ディレクトリをワークスペースフォルダとして追加してください。

### Function Graph (BFS) の動作がバックエンドで異なる
- LSP・gtags 両バックエンドとも、`Show Function Graph (BFS)` コマンドは **下方向 BFS のみ**（callee 方向）です。
- 上下双方向グラフ（caller と callee の両方）が必要な場合は、`Show Path-Through Graph (gtags)` コマンドを使用してください（gtags バックエンドのみ対応）。

---

## ライセンス

このプロジェクトのライセンスは MIT です。（LICENSE ファイル参照）
自由に利用・改変・再配布が可能です。

---

## 作者

uta

---

## リポジトリ

https://github.com/uta1214/call-map