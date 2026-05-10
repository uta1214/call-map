// esbuild.js
const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const production = process.argv.includes('--production');
const watch      = process.argv.includes('--watch');

function copyAssets() {
  if (!fs.existsSync('dist')) fs.mkdirSync('dist', { recursive: true });

  // vis-network standalone UMD をコピー
  // sourceMappingURL を除去して CSP 違反を防ぐ
  const visSrc  = path.join('node_modules', 'vis-network', 'standalone', 'umd', 'vis-network.min.js');
  const visDest = path.join('dist', 'vis-network.min.js');
  if (!fs.existsSync(visSrc)) {
    console.error('[ERROR] vis-network が見つかりません。npm install を実行してください。');
    process.exit(1);
  }
  let visContent = fs.readFileSync(visSrc, 'utf-8');
  visContent = visContent.replace(/\/\/# sourceMappingURL=\S+/g, ''); // ← CSP fix
  fs.writeFileSync(visDest, visContent);
  const size = (fs.statSync(visDest).size / 1024).toFixed(0);
  console.log(`[copy] vis-network.min.js → dist/ (${size} KB, sourcemap 除去済み)`);

  // ブラウザ側 JS をコピー
  const webviewSrc  = path.join('src', 'webview.js');
  const webviewDest = path.join('dist', 'webview.js');
  if (!fs.existsSync(webviewSrc)) {
    console.error('[ERROR] src/webview.js が見つかりません。');
    process.exit(1);
  }
  fs.copyFileSync(webviewSrc, webviewDest);
  console.log('[copy] webview.js → dist/');
}

async function main() {
  copyAssets();

  const ctx = await esbuild.context({
    entryPoints:    ['src/extension.ts'],
    bundle:         true,
    format:         'cjs',
    minify:         production,
    sourcemap:      !production,
    sourcesContent: false,
    platform:       'node',
    outfile:        'dist/extension.js',
    // ★ vis-network を external に追加:
    //   vis-network は WebView 内で UMD バンドルとして読み込むため
    //   Node.js 側バンドル (extension.js) に混入させてはいけない。
    //   混入すると vis-network が window / document を参照して
    //   "window is not defined" が発生する。
    external:       ['vscode', 'vis-network'],
    logLevel:       'silent',
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('[esbuild] build complete');
  }
}

main().catch(e => { console.error(e); process.exit(1); });