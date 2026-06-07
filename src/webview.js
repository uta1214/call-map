// src/webview.js
//
// 【変更点 (main ← gtags マージ)】
//  - caller ノード色: #74b9ff / #0984e3 → #00b894 / #00695c
//  - caller エッジ色: #0984e3 → #00b894
//  - 引数表示トグル (sig-toggle) を復元
//    → showFullSig 変数 / getLabel() / applyLabelMode() を追加
//    → renderGraph の visNodes 生成を getLabel() 経由に変更
//  - nodeInfoMap は label / labelFull のみ保持 (labelShort は GraphNode から削除済み)
//
(function () {
  'use strict';

  var isVscode = false;
  var vscode;
  try {
    vscode   = acquireVsCodeApi();
    isVscode = true;
  } catch (e) {
    vscode = { postMessage: function () {} };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // グローバル状態
  // ─────────────────────────────────────────────────────────────────────────

  var DEFAULT_FONT_SIZE = 11;

  // ★ 修正②: hierarchical レイアウトのノード数上限。
  //   vis-network の hierarchical + sortMethod:'directed' はトポロジカルソートを
  //   内部で行うため、この閾値を超えると計算が破綻して全ノードが (0,0) に集まり
  //   白紙グラフになる。閾値を超えた場合は physics ベースのレイアウトにフォールバック。
  var HIERARCHICAL_THRESHOLD = 150;
  var network  = null;
  var nodes    = null;
  var edges    = null;

  var nodeInfoMap          = {};   // id → { file, line, scopeEnd, label, labelFull, source? }
  var showFullSig          = false; // 引数表示トグル (sig-toggle)。デフォルトはオフ。
  var defaultNodeColors    = {};
  var canvasFontSize       = DEFAULT_FONT_SIZE;
  var currentNode          = null;
  var connectedEdgesOfNode = new Set();
  var _hadSelection        = false; // PERF-07: ノードが一度でも選択されたかを追跡
  var currentSourceNodeId  = null;
  var pendingSourceNodeId  = null; // ⑥ requestSource 送信済みで応答待ちの nodeId

  // ─────────────────────────────────────────────────────────────────────────
  // Extension → WebView メッセージ
  // ─────────────────────────────────────────────────────────────────────────

  window.addEventListener('message', function (e) {
    var msg = e.data;
    switch (msg.type) {
      case 'loading':    showLoading(msg.fileName);          break;
      case 'graphData':  renderGraph(msg);                   break;
      case 'error':      hideLoading(); showErrorInView(msg.message); break;
      case 'sourceData':
        // ⑥ requestSource の応答: source を nodeInfoMap にキャッシュして表示
        if (nodeInfoMap[msg.nodeId]) {
          nodeInfoMap[msg.nodeId].source = msg.source;
        }
        pendingSourceNodeId = null;
        // 現在表示中のノードと一致する場合のみ再描画
        if (msg.nodeId === currentSourceNodeId) _renderSourceContent(msg.nodeId);
        break;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ローディング / エラー
  // ─────────────────────────────────────────────────────────────────────────

  function showLoading(fileName) {
    document.getElementById('loading-overlay').style.display = 'flex';
    document.getElementById('loading-msg').textContent =
      fileName ? ('"' + fileName + '"  Analyzing...') : 'Analyzing...';
  }

  function hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
  }

  // SEC-04 修正: escapeHtml を5文字エスケープに統一。
  // webviewPanel.ts の escapeHtmlForTitle と一致させる。
  // " と ' を追加することで将来この関数を属性値に使っても XSS にならない。
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  // BUG-05 用: HTML 属性値 (title 等) のエスケープ（escapeHtml と同一）
  var escapeAttr = escapeHtml;

  function showErrorInView(msg) {
    document.getElementById('network').innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;' +
      'height:100%;flex-direction:column;gap:12px;padding:40px;">' +
      '<span style="font-size:36px;">⚠️</span>' +
      '<pre style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;' +
      'padding:16px;max-width:620px;white-space:pre-wrap;color:#856404;' +
      'font-family:monospace;font-size:12px;line-height:1.7;">' +
      escapeHtml(msg) + '</pre>' +
      '<p style="font-size:11px;color:#b2bec3;font-family:monospace;">' +
      'Check that clangd / gtags is enabled</p>' +
      '</div>';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // グラフ描画
  // ─────────────────────────────────────────────────────────────────────────

  function renderGraph(msg) {
    nodeInfoMap = {};
    msg.nodes.forEach(function (n) {
      nodeInfoMap[n.id] = {
        file:      n.file,
        line:      n.line,
        scopeEnd:  n.scopeEnd,
        label:     n.label,
        labelFull: n.labelFull || n.label,
        source:    n.source || null, // ⑥ 通常 null (スタンドアロン HTML 時のみ設定済み)
      };
    });

    var inDeg = {};
    msg.edges.forEach(function (e) { inDeg[e.to] = (inDeg[e.to] || 0) + 1; });

    // ─── BFS 最短パスレベル計算 ───────────────────────────────────────────────
    // vis-network のデフォルト動作 (longest-path) だと、同じ caller から呼ばれた
    // 兄弟ノードが異なる列に配置される問題がある。
    // 各ノードに level プロパティ (= root からの最短ホップ数) を明示することで
    // vis-network に対してレベルを強制し、兄弟を同列に揃える。
    //
    // 例:  main → A → X → Z
    //           → B ──────↗   (B の level は A と同じ 1 に固定)
    //           → C ──────↗   (C の level は A と同じ 1 に固定)
    //
    // 手順:
    //   1. 入次数 0 のノードを root として level = 0 に設定
    //   2. BFS で隣接ノードに level = min(現在値, 親level + 1) を伝播
    //      (複数の親を持つノードは最も浅い親 +1 を採用)
    var bfsLevel = {};
    var adjOut = {};   // nodeId → [隣接 to の nodeId]
    msg.nodes.forEach(function (n) { adjOut[n.id] = []; });
    msg.edges.forEach(function (e) {
      if (adjOut[e.from]) adjOut[e.from].push(e.to);
    });

    // root = 入次数 0 のノード
    var bfsQueue = [];
    msg.nodes.forEach(function (n) {
      if (!inDeg[n.id]) {           // 入次数 0
        bfsLevel[n.id] = 0;
        bfsQueue.push(n.id);
      }
    });
    // 孤立ノード保険: root が 0 件なら全ノードを level=0 で初期化して BFS
    if (bfsQueue.length === 0) {
      msg.nodes.forEach(function (n) { bfsLevel[n.id] = 0; bfsQueue.push(n.id); });
    }

    var qi = 0;
    // V4-6 修正: 相互再帰（A→B→A）などのサイクルグラフで bfsLevel の更新が
    // 収束するまで同じノードが bfsQueue に大量追加され O(N²) になる問題を修正する。
    // inQueue セットで「既にキューに積まれているノード」を管理し、重複追加を防ぐ。
    // ⑥ 追加: サイクルが多数ある場合の bfsQueue 膨張を防ぐため上限を設ける。
    // 強連結成分（双方向呼び出し）が多いグラフでも正確なレベル計算が行えるよう
    // * 2 から * 10 に拡張した（深いサイクルでも収束が保証される）。
    var BFS_QUEUE_LIMIT = msg.nodes.length * 10;
    var inQueue = new Set(bfsQueue);
    while (qi < bfsQueue.length) {
      var cur = bfsQueue[qi++];
      inQueue.delete(cur);
      var nextLevel = bfsLevel[cur] + 1;
      (adjOut[cur] || []).forEach(function (to) {
        // 未訪問 OR より浅いパスが見つかった場合にのみ更新
        if (bfsLevel[to] === undefined || bfsLevel[to] > nextLevel) {
          bfsLevel[to] = nextLevel;
          if (!inQueue.has(to) && bfsQueue.length < BFS_QUEUE_LIMIT) {
            inQueue.add(to);
            bfsQueue.push(to); // 更新があったので再伝播
          }
        }
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ─── level 内の縦順を固定 (order) ───────────────────────────────────────
    // Same level nodes are sorted by file name then line number so the layout
    // is deterministic across renders, and functions in the same file cluster together.
    var levelGroups = {};
    msg.nodes.forEach(function (n) {
      var lv = bfsLevel[n.id] !== undefined ? bfsLevel[n.id] : 0;
      if (!levelGroups[lv]) levelGroups[lv] = [];
      levelGroups[lv].push(n);
    });
    var nodeOrder = {};
    Object.keys(levelGroups).forEach(function (lv) {
      levelGroups[lv]
        .slice()
        .sort(function (a, b) {
          var fi = (nodeInfoMap[a.id] ? nodeInfoMap[a.id].file : '') || '';
          var fj = (nodeInfoMap[b.id] ? nodeInfoMap[b.id].file : '') || '';
          if (fi !== fj) return fi < fj ? -1 : 1;
          var li = (nodeInfoMap[a.id] ? nodeInfoMap[a.id].line : 0) || 0;
          var lj = (nodeInfoMap[b.id] ? nodeInfoMap[b.id].line : 0) || 0;
          return li - lj;
        })
        .forEach(function (n, i) { nodeOrder[n.id] = i; });
    });
    // ─────────────────────────────────────────────────────────────────────────

    var visNodes = msg.nodes.map(function (n) {
      return {
        id:          n.id,
        label:       getLabel(nodeInfoMap[n.id] || n),
        title:       n.title,
        color:       n.color,
        size:        Math.min(12 + ((inDeg[n.id] || 0) * 3), 40),
        shape:       'dot',
        borderWidth: n.isCurrentFile ? 2 : 1,
        font:        { size: DEFAULT_FONT_SIZE, face: 'monospace', color: '#2d3436' },
        shadow:      { enabled: true, size: 4, x: 2, y: 2, color: 'rgba(0,0,0,0.08)' },
        level:       bfsLevel[n.id]  !== undefined ? bfsLevel[n.id]  : 0,
        order:       nodeOrder[n.id] !== undefined ? nodeOrder[n.id] : 0
      };
    });

    var visEdges = msg.edges.map(function (e, i) {
      return {
        id: i, from: e.from, to: e.to, arrows: 'to',
        color:  { color: '#aaaaaa', hover: '#aaaaaa', highlight: '#aaaaaa' },
        width:  1,
        smooth: { enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.5 }
      };
    });

    // ★ 修正①: clear の順序は必ず edges → nodes。
    //   nodes を先に消すとエッジが存在しないノードを参照する状態になり
    //   vis-network が内部エラーで描画を中断するため白紙になる。
    // ★ 修正②: ノード数に応じてレイアウトを切り替える。
    //   hierarchical は大量ノードで破綻するため閾値を超えたら無効化する。
    if (network) {
      // BUG-8 修正: 前回の stabilize が完了していない状態で再レンダリングが呼ばれた場合、
      // 古い stabilizationIterationsDone ハンドラが先に発火してオーバーレイが消え、
      // 新しいハンドラが残るという競合が発生する。stopSimulation() で先に停止させる。
      network.stopSimulation();
      var useHierarchical = visNodes.length <= HIERARCHICAL_THRESHOLD;
      network.setOptions({ layout: { hierarchical: { enabled: useHierarchical } } });
      edges.clear(); edges.add(visEdges);
      nodes.clear(); nodes.add(visNodes);
      if (!useHierarchical) {
        document.getElementById('loading-overlay').style.display = 'flex';
        network.once('stabilizationIterationsDone', function () {
          network.fit();
          hideLoading();
        });
        network.stabilize(200);
      } else {
        // 🟡 Bug 6 修正: hierarchical モードで再描画したとき network.fit() が呼ばれておらず、
        //   前回のズーム・スクロール位置が残ったまま新グラフが画面外に出ることがあった。
        //   physics モードが stabilizationIterationsDone 内で fit() を呼ぶのと対称にする。
        network.fit();
      }
    } else {
      nodes = new vis.DataSet(visNodes);
      edges = new vis.DataSet(visEdges);
      initNetwork(visNodes.length);
    }

    defaultNodeColors = {};
    nodes.forEach(function (n) {
      defaultNodeColors[n.id] = {
        color:     JSON.parse(JSON.stringify(n.color || {})),
        fontColor: (n.font && n.font.color) ? n.font.color : '#2d3436'
      };
    });

    renderLegend(msg.fileLegend);

    var errNote = (msg.errors && msg.errors.length > 0)
      ? ' ⚠️ warnings: ' + msg.errors.length : '';
    var layoutNote = visNodes.length > HIERARCHICAL_THRESHOLD
      ? ' [physics]' : ' [hierarchical]';
    var buildInfoEl = document.getElementById('build-info');
    buildInfoEl.textContent =
      'Nodes: ' + msg.nodes.length + ' / Edges: ' + msg.edges.length +
      ' / ' + msg.buildTimeMs + 'ms' + layoutNote + errNote;

    // ④ 警告がある場合: hover で詳細を表示、クリックでアラート
    if (msg.errors && msg.errors.length > 0) {
      buildInfoEl.style.cursor  = 'pointer';
      buildInfoEl.style.color   = '#e17055';
      buildInfoEl.title = msg.errors.map(escapeAttr).join('\n');
      buildInfoEl.onclick = function () {
        // QUALITY-5 修正: escapeAttr では title 属性用にエスケープしているが
        // alert() は別文脈。一貫性のため escapeHtml を適用する。
        alert('Build warnings (' + msg.errors.length + '):\n\n' + msg.errors.map(escapeHtml).join('\n'));
      };
    } else {
      buildInfoEl.style.cursor  = '';
      buildInfoEl.style.color   = '';
      buildInfoEl.title = '';
      buildInfoEl.onclick = null;
    }

    resetAll();

    // 設定値 callmap.initialControlPanel に従って初期パネル状態を適用する。
    // グラフ表示のたびに設定値を参照するため、再描画時も反映される。
    if (typeof msg.controlPanelCollapsed === 'boolean') {
      setControlsCollapsed(msg.controlPanelCollapsed);
    }

    // ★ hierarchical モードは同期描画なのでここで即座にローディングを消す。
    //   physics モードは initNetwork 内の stabilizationIterationsDone で消す。
    if (visNodes.length <= HIERARCHICAL_THRESHOLD) {
      hideLoading();
    }
  }

  function initNetwork(nodeCount) {
    // ★ 修正②: ノード数が閾値以下なら hierarchical、超えたら physics フォールバック
    var useHierarchical = nodeCount <= HIERARCHICAL_THRESHOLD;

    var layoutOpt = useHierarchical
      ? {
          hierarchical: {
            enabled: true, direction: 'LR', sortMethod: 'hubsize',
            levelSeparation: 220, nodeSpacing: 70, treeSpacing: 130,
            blockShifting: true, edgeMinimization: true, parentCentralization: true
          }
        }
      : { hierarchical: { enabled: false } };

    var physicsOpt = useHierarchical
      ? { enabled: false }
      : {
          enabled: true,
          solver: 'forceAtlas2Based',
          forceAtlas2Based: { gravitationalConstant: -80, springLength: 120, springConstant: 0.08 },
          stabilization: { iterations: 200, fit: true },
        };

    network = new vis.Network(
      document.getElementById('network'),
      { nodes: nodes, edges: edges },
      {
        layout: layoutOpt,
        nodes: {
          shape: 'dot', borderWidth: 2,
          shadow: { enabled: true, size: 4, x: 2, y: 2, color: 'rgba(0,0,0,0.08)' },
          font:   { size: 11, face: 'monospace' }
        },
        edges: {
          smooth:         { enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.5 },
          arrows:         { to: { scaleFactor: 0.6 } },
          color:          { color: '#aaaaaa', hover: '#aaaaaa', highlight: '#aaaaaa' },
          hoverWidth:     0, selectionWidth: 0, width: 1
        },
        interaction: {
          hover: true, tooltipDelay: 80, navigationButtons: true,
          keyboard: false, zoomView: false
        },
        physics: physicsOpt,
      }
    );

    network.on('click', onNetworkClick);
    network.on('doubleClick', function (params) {
      if (params.nodes.length === 0) {
        resetAll(!!searchBox.value.trim());
      }
    });
    network.on('hoverNode', function (p) {
      if (currentNode !== null) return;
      edges.update(network.getConnectedEdges(p.node).map(function (id) {
        return { id: id, color: { color: '#636e72', opacity: 1.0 }, width: 2.5 };
      }));
    });
    network.on('blurNode', function (p) {
      if (currentNode !== null) return;
      edges.update(network.getConnectedEdges(p.node).map(function (id) {
        return { id: id, color: { color: '#aaaaaa', opacity: 0.8 }, width: 1 };
      }));
    });

    // ★ 修正②: physics フォールバック時はスタビライズ中にローディングを表示する
    if (!useHierarchical) {
      document.getElementById('loading-overlay').style.display = 'flex';
      network.on('stabilizationProgress', function (params) {
        document.getElementById('loading-msg').textContent =
          'Computing layout... ' + Math.round(params.iterations / params.total * 100) + '%';
      });
      network.once('stabilizationIterationsDone', function () {
        network.fit();
        hideLoading();
      });
    }

    network.body.container.addEventListener('wheel', function (e) {
      e.preventDefault(); e.stopPropagation();
      var scale = network.getScale();
      var pos   = network.getViewPosition();
      var speed = 120 / scale;
      if (e.ctrlKey) {
        network.moveTo({ scale: scale * (e.deltaY > 0 ? 0.85 : 1.15), animation: false });
      } else if (e.shiftKey) {
        network.moveTo({ position: { x: pos.x + e.deltaY * speed / 100, y: pos.y }, animation: false });
      } else {
        network.moveTo({ position: { x: pos.x, y: pos.y + e.deltaY * speed / 100 }, animation: false });
      }
    }, { passive: false, capture: true });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ソースへジャンプ
  // ─────────────────────────────────────────────────────────────────────────

  function openNodeSource(nodeId) {
    var info = nodeInfoMap[nodeId];
    if (!info || !info.file) return;
    if (isVscode) {
      vscode.postMessage({ type: 'openFile', file: info.file, line: info.line });
    } else {
      alert('File: ' + info.file + '\nLine: ' + info.line);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ノードクリック
  // ─────────────────────────────────────────────────────────────────────────

  function onNetworkClick(params) {
    if (params.nodes.length > 0 &&
        params.event && params.event.srcEvent && params.event.srcEvent.ctrlKey) {
      openNodeSource(params.nodes[0]);
      return;
    }

    if (!params.nodes.length) {
      // 検索中はノード選択だけリセットして検索を維持する。
      // 空のとき（非検索中）は通常どおり全リセット。
      resetAll(!!searchBox.value.trim());
      return;
    }
    var id = params.nodes[0];
    // 同じノードを再クリック: 選択解除（検索中は検索を維持）
    if (id === currentNode) { resetAll(!!searchBox.value.trim()); return; }

    currentNode          = id;
    connectedEdgesOfNode = new Set(network.getConnectedEdges(id));
    _hadSelection        = true; // PERF-07: 選択発生を記録

    // ② 修正: edges.forEach 全スキャン → getConnectedNodes で直接取得 (O(n) → O(k))
    var outgoing = new Set(network.getConnectedNodes(id, 'from')); // callees
    var incoming = new Set(network.getConnectedNodes(id, 'to'));   // callers

    nodes.update(nodes.getIds().map(function (nid) {
      if (nid === id)         return { id: nid, color: { background: '#97c2fc', border: '#5a9fd4' }, font: makeFont('#1a3d5c') };
      if (outgoing.has(nid)) return { id: nid, color: { background: '#fab1a0', border: '#e17055' }, font: makeFont('#6d2b1a') };
      // ★ caller 色変更: #74b9ff / #0984e3 → #00b894 / #00695c
      if (incoming.has(nid)) return { id: nid, color: { background: '#00b894', border: '#00695c' }, font: makeFont('#003d33') };
      return { id: nid, color: { background: '#ececec', border: '#cccccc' }, font: makeFont('#bbbbbb') };
    }));

    edges.update(edges.getIds().map(function (eid) {
      if (!connectedEdgesOfNode.has(eid)) return { id: eid, color: { color: '#e8e8e8', opacity: 0.3 }, width: 1 };
      var e   = edges.get(eid);
      // ★ caller エッジ色変更: #0984e3 → #00b894
      var col = (e.from === id) ? '#e17055' : '#00b894';
      return { id: eid, color: { color: col, opacity: 1.0 }, width: 2.5 };
    }));

    document.getElementById('hop-panel').style.display = 'block';
    document.querySelectorAll('.hop-btn').forEach(function (b) { b.classList.remove('active'); });

    if (document.getElementById('src-toggle').checked) showSource(id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ホップフィルタ
  // ─────────────────────────────────────────────────────────────────────────

  function getNodesWithinHops(startId, maxHops) {
    var visited  = new Set([startId]);
    var frontier = [startId];
    for (var hop = 0; hop < maxHops; hop++) {
      var next = [];
      frontier.forEach(function (id) {
        network.getConnectedNodes(id).forEach(function (nid) {
          if (!visited.has(nid)) { visited.add(nid); next.push(nid); }
        });
      });
      frontier = next;
      if (!frontier.length) break;
    }
    return visited;
  }

  // ★ グローバル公開不要: ボタンのイベントリスナーは下で直接セット済み
  function applyHopFilter(maxHops) {
    if (currentNode === null) return;

    var visible  = (maxHops === null) ? new Set(nodes.getIds()) : getNodesWithinHops(currentNode, maxHops);
    // ② 修正: edges.forEach 全スキャン → getConnectedNodes で直接取得
    var outgoing = new Set(network.getConnectedNodes(currentNode, 'from')); // callees
    var incoming = new Set(network.getConnectedNodes(currentNode, 'to'));   // callers

    nodes.update(nodes.getIds().map(function (id) {
      var d = defaultNodeColors[id] || {};
      if (!visible.has(id))        return { id: id, color: { background: '#f0f0f0', border: '#e0e0e0' }, font: makeFont('#e0e0e0') };
      if (id === currentNode)       return { id: id, color: { background: '#97c2fc', border: '#5a9fd4' }, font: makeFont('#1a3d5c') };
      if (outgoing.has(id))         return { id: id, color: { background: '#fab1a0', border: '#e17055' }, font: makeFont('#6d2b1a') };
      // ★ caller 色変更: #74b9ff / #0984e3 → #00b894 / #00695c
      if (incoming.has(id))         return { id: id, color: { background: '#00b894', border: '#00695c' }, font: makeFont('#003d33') };
      return { id: id, color: d.color, font: makeFont(d.fontColor || '#2d3436') };
    }));

    edges.update(edges.getIds().map(function (id) {
      var e = edges.get(id);
      if (!visible.has(e.from) || !visible.has(e.to))
        return { id: id, color: { color: '#eeeeee', opacity: 0.2 }, width: 1 };
      if (connectedEdgesOfNode.has(id)) {
        // ★ caller エッジ色変更: #0984e3 → #00b894
        var col = (e.from === currentNode) ? '#e17055' : '#00b894';
        return { id: id, color: { color: col, opacity: 1.0 }, width: 2.5 };
      }
      return { id: id, color: { color: '#aaaaaa', opacity: 0.6 }, width: 1 };
    }));

    document.querySelectorAll('.hop-btn').forEach(function (btn) {
      var _hop = maxHops === null ? 'all' : String(maxHops);
      btn.classList.toggle('active', btn.dataset.hop === _hop);
    });
  }

  document.querySelectorAll('.hop-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = btn.dataset.hop === 'all' ? null : parseInt(btn.dataset.hop, 10);
      applyHopFilter(v);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ソースコードパネル
  // ─────────────────────────────────────────────────────────────────────────

  // ⑥ ソースパネルの内容を実際に DOM に書き込む (source が既にある場合)
  function _renderSourceContent(nodeId) {
    var info        = nodeInfoMap[nodeId] || {};
    var placeholder = document.getElementById('source-placeholder');
    var content     = document.getElementById('source-content');
    var baseName    = info.file ? info.file.replace(/\\/g, '/').split('/').pop() : '';
    document.getElementById('source-func-name').textContent = info.labelFull || info.label || nodeId;
    document.getElementById('source-file-info').textContent =
      baseName ? (baseName + ' : line ' + info.line) : '';
    if (info.source !== null && info.source !== undefined) {
      // ⑤ 行番号を付与して表示 (info.line = スコープ開始行)
      var startLine = info.line || 1;
      var sourceLines = info.source.split('\n');
      var maxNum = startLine + sourceLines.length - 1;
      var pad    = String(maxNum).length;
      var numbered = sourceLines.map(function (l, i) {
        return String(startLine + i).padStart(pad) + '  ' + l;
      }).join('\n');
      document.getElementById('source-code').textContent = numbered;
      placeholder.style.display = 'none';
      content.style.display     = 'flex';
    } else {
      document.getElementById('source-code').textContent = '';
      placeholder.style.display = 'flex';
      content.style.display     = 'none';
    }
  }

  function showSource(nodeId) {
    var panel = document.getElementById('source-panel');
    panel.style.display = 'flex';

    if (!nodeId) {
      document.getElementById('source-placeholder').style.display = 'flex';
      document.getElementById('source-content').style.display     = 'none';
      currentSourceNodeId = null;
      return;
    }

    currentSourceNodeId = nodeId;
    var info = nodeInfoMap[nodeId] || {};

    // キャッシュ済みなら即表示
    if (info.source !== null && info.source !== undefined) {
      _renderSourceContent(nodeId);
      return;
    }

    // ⑥ VSCode WebView 環境: requestSource を送って非同期取得
    if (isVscode && info.file && pendingSourceNodeId !== nodeId) {
      pendingSourceNodeId = nodeId;
      // ヘッダ表示だけ先行描画し、ソース部分は "読み込み中..." を表示
      var baseName = info.file ? info.file.replace(/\\/g, '/').split('/').pop() : '';
      document.getElementById('source-func-name').textContent = info.labelFull || info.label || nodeId;
      document.getElementById('source-file-info').textContent =
        baseName ? (baseName + ' : line ' + info.line) : '';
      document.getElementById('source-code').textContent = '// Loading...';
      document.getElementById('source-placeholder').style.display = 'none';
      document.getElementById('source-content').style.display     = 'flex';
      vscode.postMessage({
        type: 'requestSource',
        nodeId:   nodeId,
        file:     info.file,
        line:     info.line,
        scopeEnd: info.scopeEnd,
      });
      return;
    }

    // スタンドアロン HTML またはファイル情報なし
    document.getElementById('source-code').textContent = '(Source not found)';
    document.getElementById('source-placeholder').style.display = 'none';
    document.getElementById('source-content').style.display     = 'flex';
  }

  function closeSrcPanel() {
    document.getElementById('src-toggle').checked         = false;
    document.getElementById('source-panel').style.display = 'none';
    // ④ 修正: パネルを閉じた後も currentSourceNodeId が残ると
    //   別ノードクリック時に _renderSourceContent が誤って呼ばれる問題を修正。
    currentSourceNodeId = null;
  }

  document.getElementById('src-close-btn').addEventListener('click', closeSrcPanel);
  document.getElementById('goto-btn').addEventListener('click', function () {
    if (currentSourceNodeId) openNodeSource(currentSourceNodeId);
  });
  document.getElementById('src-toggle').addEventListener('change', function () {
    if (!this.checked) {
      document.getElementById('source-panel').style.display = 'none';
    } else {
      showSource(currentNode);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HTML エクスポート
  // ─────────────────────────────────────────────────────────────────────────

  document.getElementById('export-btn').addEventListener('click', function () {
    if (isVscode) {
      vscode.postMessage({ type: 'exportHtml' });
    } else {
      alert('This file is already a standalone HTML.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 引数表示トグル
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * showFullSig が false なら label（短縮名）、true なら labelFull（フルシグネチャ）を返す。
   * labelFull が未設定の場合は label にフォールバックする。
   */
  function getLabel(info) {
    if (!showFullSig) return info.label || '';
    return info.labelFull || info.label || '';
  }

  /** 全ノードのラベルを現在の showFullSig に合わせて一括更新する。 */
  function applyLabelMode() {
    if (!nodes) return;
    nodes.update(nodes.getIds().map(function (id) {
      var info = nodeInfoMap[id];
      if (!info) return { id: id };
      return { id: id, label: getLabel(info) };
    }));
  }

  document.getElementById('sig-toggle').addEventListener('change', function () {
    showFullSig = this.checked;
    applyLabelMode();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // フォントサイズ
  // ─────────────────────────────────────────────────────────────────────────

  function makeFont(color) {
    return { size: canvasFontSize, face: 'monospace', color: color };
  }

  function applyFontSize() {
    if (!nodes) return;
    nodes.update(nodes.getIds().map(function (id) {
      var n  = nodes.get(id);
      var fc = (n.font && n.font.color) ? n.font.color : '#2d3436';
      return { id: id, font: { size: canvasFontSize, face: 'monospace', color: fc } };
    }));
  }

  // PERF-06 修正: applyFontSize のデバウンス版。
  // input イベントはキー押下ごとに連続発火するため、16ms のデバウンスで
  // 高頻度の全ノード再描画を抑制する。click イベント（+/- ボタン・リセット）は
  // 1回の操作につき1回しか発火しないためデバウンスなしで applyFontSize を直接呼ぶ。
  var _fontSizeTimer;
  function applyFontSizeDebounced() {
    clearTimeout(_fontSizeTimer);
    _fontSizeTimer = setTimeout(applyFontSize, 16);
  }

  document.getElementById('font-size-input').addEventListener('input', function () {
    var val = parseInt(this.value, 10);
    if (!isNaN(val) && val >= 6 && val <= 64) { canvasFontSize = val; applyFontSizeDebounced(); }
  });
  document.getElementById('font-size-reset').addEventListener('click', function () {
    canvasFontSize = DEFAULT_FONT_SIZE;
    document.getElementById('font-size-input').value = DEFAULT_FONT_SIZE;
    applyFontSize();
  });
  // ＋ / － ボタン: ネイティブスピナーを置き換える
  document.getElementById('font-size-up').addEventListener('click', function () {
    var input = document.getElementById('font-size-input');
    // NEW-5: input.value が空の場合 parseInt は NaN を返すため DEFAULT_FONT_SIZE にフォールバック
    var cur   = parseInt(input.value, 10);
    if (isNaN(cur)) cur = DEFAULT_FONT_SIZE;
    var val   = Math.min(cur + 1, 64);
    input.value    = val;
    canvasFontSize = val;
    applyFontSize();
  });
  document.getElementById('font-size-down').addEventListener('click', function () {
    var input = document.getElementById('font-size-input');
    // NEW-5: input.value が空の場合 parseInt は NaN を返すため DEFAULT_FONT_SIZE にフォールバック
    var cur   = parseInt(input.value, 10);
    if (isNaN(cur)) cur = DEFAULT_FONT_SIZE;
    var val   = Math.max(cur - 1, 6);
    input.value    = val;
    canvasFontSize = val;
    applyFontSize();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // コントロールパネル 折りたたみ
  // ─────────────────────────────────────────────────────────────────────────
  // コントロールパネル折りたたみ
  // collapsed 変数を module スコープに昇格し、renderGraph から初期状態を適用できるようにする。
  var _ctrlCollapsed = false;
  var _ctrlOpenWidth = '';

  function setControlsCollapsed(val) {
    var toggleBtn = document.getElementById('controls-toggle');
    var controls  = document.getElementById('controls');
    var body      = document.getElementById('controls-body');
    _ctrlCollapsed = val;
    if (_ctrlCollapsed) {
      // 閉じる直前に実幅を取得して固定（0 の場合は CSS デフォルト幅をそのまま使う）
      var w = controls.getBoundingClientRect().width;
      _ctrlOpenWidth       = w > 0 ? w + 'px' : '';
      controls.style.width = _ctrlOpenWidth;
    } else {
      // 開いたら固定幅を解除 (CSS の width: 230px に戻る)
      controls.style.width = '';
    }
    body.style.display    = _ctrlCollapsed ? 'none' : '';
    toggleBtn.textContent = _ctrlCollapsed ? '▶' : '▼';
    toggleBtn.title       = _ctrlCollapsed ? 'Expand panel' : 'Collapse panel';
  }

  (function () {
    var toggleBtn = document.getElementById('controls-toggle');
    toggleBtn.addEventListener('click', function () {
      setControlsCollapsed(!_ctrlCollapsed);
    });
  }());

  // ─────────────────────────────────────────────────────────────────────────
  // 検索
  // ─────────────────────────────────────────────────────────────────────────

  var searchBox = document.getElementById('search-box');

  // ─── 検索モードトグル（func / file、両方 ON がデフォルト） ──────────────
  var searchModeFunc = true;
  var searchModeFile = true;
  (function () {
    var btnFunc = document.getElementById('search-mode-func');
    var btnFile = document.getElementById('search-mode-file');
    function applyToggle(btn, isActive) {
      btn.classList.toggle('active', isActive);
    }
    btnFunc.addEventListener('click', function () {
      // 両方 OFF にはできない: 片方だけ ON の状態でそれを押した場合は無視
      if (searchModeFunc && !searchModeFile) return;
      searchModeFunc = !searchModeFunc;
      applyToggle(btnFunc, searchModeFunc);
      // モード変更時に検索クエリを再適用
      searchBox.dispatchEvent(new Event('input'));
    });
    btnFile.addEventListener('click', function () {
      if (searchModeFile && !searchModeFunc) return;
      searchModeFile = !searchModeFile;
      applyToggle(btnFile, searchModeFile);
      searchBox.dispatchEvent(new Event('input'));
    });
  }());

  // ─── 検索インデックス ────────────────────────────────────────────────────
  // -1 = 未フォーカス（初期値）。Enter で +1、Shift+Enter で -1 して循環。
  // ポストインクリメント方式を廃止し、index が「現在フォーカス中のノード」を
  // 常に指すようにすることで Enter → Shift+Enter の 1 回ずれバグを修正。
  var searchHitIndex = -1;
  // ② 修正: matchSet を外スコープで保持し、keydown ハンドラでの全スキャン再実行を廃止。
  var matchSet = new Set();

  searchBox.addEventListener('input', function () {
    searchHitIndex = -1; // 入力変更時はリセット
    matchSet = new Set();
    if (!nodes) return;
    var q = this.value.trim().toLowerCase();
    if (!q) { resetAll(); return; }
    Object.keys(nodeInfoMap).forEach(function (id) {
      var info    = nodeInfoMap[id];
      var matched = false;
      // func モード: label (短縮名) と labelFull (フルシグネチャ) で検索
      if (searchModeFunc) {
        if ((info.label     || '').toLowerCase().indexOf(q) !== -1 ||
            (info.labelFull || '').toLowerCase().indexOf(q) !== -1) {
          matched = true;
        }
      }
      // file モード: ファイルのベース名で検索（OR 条件）
      if (!matched && searchModeFile) {
        var basename = (info.file || '').replace(/\\/g, '/').split('/').pop() || '';
        if (basename.toLowerCase().indexOf(q) !== -1) matched = true;
      }
      if (matched) matchSet.add(id);
    });
    nodes.update(nodes.getIds().map(function (id) {
      if (matchSet.has(id)) {
        var d = defaultNodeColors[id] || {};
        return { id: id, color: d.color, font: makeFont('#2d3436') };
      }
      return { id: id, color: { background: '#f0f0f0', border: '#e0e0e0' }, font: makeFont('#dddddd') };
    }));
  });

  searchBox.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && nodes) {
      var hits = Array.from(matchSet);
      if (hits.length) {
        // フォーカス移動バグ修正: ポストインクリメント廃止 → index が現在位置を常に指す。
        //   旧実装: 使用後インクリメントのためShift+Enter直後に同ノードを再フォーカスしていた。
        //   新実装: Enter で +1、Shift+Enter で -1 してから表示するだけ。
        if (e.shiftKey) {
          searchHitIndex = (searchHitIndex - 1 + hits.length) % hits.length;
        } else {
          searchHitIndex = (searchHitIndex + 1) % hits.length;
        }
        network.focus(hits[searchHitIndex], { scale: 1.5, animation: { duration: 400 } });
      }
    }
    if (e.key === 'Escape') {
      // ① 修正: document の keydown ハンドラも Escape を捕捉するため
      //   stopPropagation で伝播を止めて resetAll の二重呼び出しを防ぐ。
      e.stopPropagation();
      resetAll();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // リセット
  // ─────────────────────────────────────────────────────────────────────────

  // preserveSearch=true のとき: ノード選択状態だけリセットし、
  //   検索ボックス・matchSet・ソースパネルには手を触れない。
  //   外から値を save/restore する方式は network.unselectAll() が
  //   synchronous に内部イベントを再発火したとき途中で崩れるため、
  //   resetAll 内部で完結させることで再入性の問題を回避する。
  function resetAll(preserveSearch) {
    // PERF-07 修正（再修正）: ノードクリック時は接続エッジ「も」非接続エッジ「も」
    // 両方のスタイルが変更される（接続→ハイライト、非接続→薄灰色 opacity:0.3）。
    // そのため選択があった場合は必ず全エッジをリセットする必要がある。
    // 最適化として「一度もノードを選択していない状態の resetAll（Esc 連打など）」のみスキップする。
    var prevHadSelection = _hadSelection;
    currentNode          = null;
    connectedEdgesOfNode = new Set();
    _hadSelection        = false;
    // High-1 修正: resetAll 後に同じノードを再クリックしても
    // pendingSourceNodeId が残っていると requestSource が再送されず
    // ソースパネルが空のまま固まる問題を修正。
    pendingSourceNodeId  = null;
    if (!preserveSearch) {
      // 🟡 Bug 9 修正: matchSet / searchHitIndex も明示的にクリア
      matchSet       = new Set();
      searchHitIndex = -1;
    } else {
      // 検索保持時もフォーカス位置はリセット（ノード選択が変わったため）
      searchHitIndex = -1;
    }
    if (network) network.unselectAll();
    if (nodes) {
      if (preserveSearch && matchSet.size > 0) {
        // 検索ハイライト色を維持したままノード選択だけ外す
        nodes.update(nodes.getIds().map(function (id) {
          if (matchSet.has(id)) {
            var d = defaultNodeColors[id] || {};
            return { id: id, color: d.color, font: makeFont('#2d3436') };
          }
          return { id: id, color: { background: '#f0f0f0', border: '#e0e0e0' }, font: makeFont('#dddddd') };
        }));
      } else {
        nodes.update(nodes.getIds().map(function (id) {
          var d = defaultNodeColors[id] || {};
          return { id: id, color: d.color, font: makeFont(d.fontColor || '#2d3436') };
        }));
      }
    }
    // PERF-07: 前回選択がなければエッジは変更されていないのでスキップ
    if (edges && prevHadSelection) {
      edges.update(edges.getIds().map(function (id) {
        return { id: id, color: { color: '#aaaaaa', opacity: 0.8 }, width: 1 };
      }));
    }
    document.getElementById('hop-panel').style.display = 'none';
    document.querySelectorAll('.hop-btn').forEach(function (b) { b.classList.remove('active'); });
    if (!preserveSearch) {
      document.getElementById('search-box').value = '';
      if (document.getElementById('src-toggle').checked) {
        showSource(null);
      } else {
        document.getElementById('source-panel').style.display = 'none';
      }
    }
  }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') resetAll(); });

  // ─────────────────────────────────────────────────────────────────────────
  // ファイル凡例
  // ─────────────────────────────────────────────────────────────────────────

  function renderLegend(fileLegend) {
    var container = document.getElementById('legend-items');
    container.innerHTML = '';
    (fileLegend || []).forEach(function (item) {
      var name = item.file.replace(/\\/g, '/').split('/').pop();
      var row  = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px;cursor:default;';
      row.title = escapeAttr(item.file); // BUG-05 修正: title 属性をエスケープ
      var dot  = document.createElement('span');
      // SEC-1 修正: cssText への直接連結は CSS インジェクションの経路になるため、
      // 個別プロパティ代入に変更する。値が不正な CSS であっても無視されるため安全。
      dot.style.width        = '10px';
      dot.style.height       = '10px';
      dot.style.borderRadius = '50%';
      dot.style.flexShrink   = '0';
      dot.style.background   = item.color;
      dot.style.border       = '1.5px solid ' + item.border;
      var label = document.createElement('span');
      // SEC-REMAIN-1 修正: dot と同様に cssText 直接代入を個別プロパティ代入に変更。
      // 値はリテラルのみなので実害はないが、将来的な動的値混入を気づかれにくくしないため統一する。
      label.style.color        = '#2d3436';
      label.style.overflow     = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.whiteSpace   = 'nowrap';
      label.style.maxWidth     = '160px';
      label.textContent = name;
      row.appendChild(dot); row.appendChild(label);
      container.appendChild(row);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 起動
  // ─────────────────────────────────────────────────────────────────────────

  if (typeof INITIAL_GRAPH_DATA !== 'undefined') {
    renderGraph(INITIAL_GRAPH_DATA);
  } else {
    vscode.postMessage({ type: 'ready' });
  }

})();