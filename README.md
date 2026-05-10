# Call Graph Viewer

C/C++ プロジェクト向けのインタラクティブコールグラフ VSCode 拡張機能。
**LSP の Call Hierarchy API** を使用するため、正規表現ベース解析より大幅に高精度。

## 必要なもの

- VSCode 1.85 以上
- 以下のいずれかの C/C++ 言語サーバー拡張機能（どちらか一方で OK）
  - **clangd** (`llvm-vs-code-extensions.vscode-clangd`) ← 推奨・高精度
  - **C/C++** (`ms-vscode.cpptools`)

> **clangd を使う場合の注意**: `compile_commands.json` があると精度が大幅に向上します。  
> CMake なら `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`、Bear なら `bear -- make` で生成できます。

---

## 開発環境セットアップ

```bash
# 1. Node.js 18+ をインストール (https://nodejs.org)
node --version  # v18 以上であることを確認

# 2. このフォルダで依存パッケージをインストール
npm install

# 3. ビルド
npm run compile

# 4. VSCode でデバッグ実行
#    → F5 キーで "Extension Development Host" ウィンドウが開く
```

---

## 使い方

1. C/C++ ファイルをエディタで開く
2. 右クリックメニュー or コマンドパレット (`Ctrl+Shift+P`) から実行:
   - **`Call Graph: このファイルのコールグラフを表示`** — ファイル内の全関数を解析
   - **`Call Graph: この関数を起点に表示`** — カーソル位置の関数から BFS で展開

---

## 操作方法

| 操作 | 内容 |
|------|------|
| ノードクリック | caller/callee をハイライト |
| ホップ数ボタン | 選択ノードから N ホップ以内を表示 |
| 🔍 検索ボックス | 関数名でフィルタ (Enter でフォーカス移動) |
| ソースコードパネル | チェックで右パネルを表示、クリックでソースへジャンプ |
| ダブルクリック / Esc | 選択解除・リセット |
| Ctrl + ホイール | ズーム |
| Shift + ホイール | 横スクロール |
| ホイール | 縦スクロール |

---

## 処理時間の目安

| ファイル規模 | 関数数 | 目安 |
|---|---|---|
| 小 | ~20 関数 | 100–300ms |
| 中 | ~80 関数 | 400–800ms |
| 大 | ~200 関数 | 1–2 秒 |

数万ファイルのプロジェクトでも **ファイル単位表示** のため、上記の時間は変わりません。
clangd がバックグラウンドでインデックスを保持しているためです。

---

## .vscodeignore (公開時)

```
node_modules/
src/
tsconfig.json
esbuild.js
```

---

## 開発メモ

- `src/callGraphBuilder.ts` — LSP Call Hierarchy を使ったグラフ構築ロジック
- `src/webviewPanel.ts`    — vis-network WebView パネル (元 callgraph.py の見た目を再現)
- `src/extension.ts`      — コマンド登録・進捗表示
- `dist/vis-network.min.js` — ビルド時に node_modules からコピーされる
