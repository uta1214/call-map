// src/webview.js
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
  var network  = null;
  var nodes    = null;
  var edges    = null;

  var nodeInfoMap          = {};   // id → { file, line, source, labelFull, labelShort }
  var defaultNodeColors    = {};
  var canvasFontSize       = DEFAULT_FONT_SIZE;
  var showFullSig          = true; // 引数表示フラグ (チェックボックスと連動)
  var currentNode          = null;
  var currentHop           = null;
  var connectedEdgesOfNode = new Set();
  var currentSourceNodeId  = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Extension → WebView メッセージ
  // ─────────────────────────────────────────────────────────────────────────

  window.addEventListener('message', function (e) {
    var msg = e.data;
    switch (msg.type) {
      case 'loading':   showLoading(msg.fileName);        break;
      case 'graphData': hideLoading(); renderGraph(msg);  break;
      case 'error':     hideLoading(); showErrorInView(msg.message); break;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ローディング / エラー
  // ─────────────────────────────────────────────────────────────────────────

  function showLoading(fileName) {
    document.getElementById('loading-overlay').style.display = 'flex';
    document.getElementById('loading-msg').textContent =
      fileName ? ('"' + fileName + '" を解析中...') : '解析中...';
  }

  function hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

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
      'clangd または C/C++ 拡張機能が有効か確認してください</p>' +
      '</div>';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ラベル取得ヘルパー
  // ─────────────────────────────────────────────────────────────────────────

  /** 現在の showFullSig に応じたラベルを返す */
  function getLabel(info) {
    if (!info) return '';
    return showFullSig ? info.labelFull : info.labelShort;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // グラフ描画
  // ─────────────────────────────────────────────────────────────────────────

  function renderGraph(msg) {
    nodeInfoMap = {};
    msg.nodes.forEach(function (n) {
      nodeInfoMap[n.id] = {
        file:       n.file,
        line:       n.line,
        source:     n.source,
        labelFull:  n.labelFull  || n.label,
        labelShort: n.labelShort || n.label,
      };
    });

    var inDeg = {};
    msg.edges.forEach(function (e) { inDeg[e.to] = (inDeg[e.to] || 0) + 1; });

    var visNodes = msg.nodes.map(function (n) {
      return {
        id: n.id,
        label: getLabel(nodeInfoMap[n.id]),
        title: n.title, color: n.color,
        size:        Math.min(12 + ((inDeg[n.id] || 0) * 3), 40),
        shape:       'dot',
        borderWidth: n.isCurrentFile ? 2 : 1,
        font:        { size: DEFAULT_FONT_SIZE, face: 'monospace', color: '#2d3436' },
        shadow:      { enabled: true, size: 4, x: 2, y: 2, color: 'rgba(0,0,0,0.08)' }
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

    if (network) {
      nodes.clear(); nodes.add(visNodes);
      edges.clear(); edges.add(visEdges);
    } else {
      nodes = new vis.DataSet(visNodes);
      edges = new vis.DataSet(visEdges);
      initNetwork();
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
      ? ' (警告: ' + msg.errors.length + '件)' : '';
    document.getElementById('build-info').textContent =
      'ノード: ' + msg.nodes.length + ' / エッジ: ' + msg.edges.length +
      ' / ' + msg.buildTimeMs + 'ms' + errNote;

    resetAll();
  }

  function initNetwork() {
    network = new vis.Network(
      document.getElementById('network'),
      { nodes: nodes, edges: edges },
      {
        layout: {
          hierarchical: {
            enabled: true, direction: 'LR', sortMethod: 'directed',
            levelSeparation: 220, nodeSpacing: 70, treeSpacing: 130,
            blockShifting: true, edgeMinimization: true, parentCentralization: true
          }
        },
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
        physics: { enabled: false }
      }
    );

    network.on('click', onNetworkClick);
    network.on('doubleClick', function (params) {
      if (params.nodes.length === 0) resetAll();
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
      alert('ファイル: ' + info.file + '\n行番号: ' + info.line);
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

    if (!params.nodes.length) { resetAll(); return; }
    var id = params.nodes[0];
    if (id === currentNode) { resetAll(); return; }

    currentNode          = id;
    currentHop           = null;
    connectedEdgesOfNode = new Set(network.getConnectedEdges(id));

    var outgoing = new Set();
    var incoming = new Set();
    edges.forEach(function (e) {
      if (e.from === id) outgoing.add(e.to);
      if (e.to   === id) incoming.add(e.from);
    });

    nodes.update(nodes.getIds().map(function (nid) {
      if (nid === id)         return { id: nid, color: { background: '#00b894', border: '#00695c' }, font: makeFont('#003d33') };
      if (outgoing.has(nid)) return { id: nid, color: { background: '#fab1a0', border: '#e17055' }, font: makeFont('#6d2b1a') };
      if (incoming.has(nid)) return { id: nid, color: { background: '#74b9ff', border: '#0984e3' }, font: makeFont('#003580') };
      return { id: nid, color: { background: '#ececec', border: '#cccccc' }, font: makeFont('#bbbbbb') };
    }));

    edges.update(edges.getIds().map(function (eid) {
      if (!connectedEdgesOfNode.has(eid)) return { id: eid, color: { color: '#e8e8e8', opacity: 0.3 }, width: 1 };
      var e   = edges.get(eid);
      var col = (e.from === id) ? '#e17055' : '#0984e3';
      return { id: eid, color: { color: col, opacity: 1.0 }, width: 2.5 };
    }));

    document.getElementById('hop-panel').style.display = 'block';
    document.querySelectorAll('.hop-btn').forEach(function (b) { b.classList.remove('active'); });

    if (document.getElementById('src-toggle').checked) showSource(id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 引数表示切り替え
  // ─────────────────────────────────────────────────────────────────────────

  document.getElementById('sig-toggle').addEventListener('change', function () {
    showFullSig = this.checked;
    applyLabelMode();
  });

  /** 全ノードのラベルを現在の showFullSig に合わせて更新する */
  function applyLabelMode() {
    if (!nodes) return;
    nodes.update(nodes.getIds().map(function (id) {
      var info = nodeInfoMap[id];
      return { id: id, label: getLabel(info) };
    }));
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

  window.applyHopFilter = function (maxHops) {
    currentHop = maxHops;
    if (currentNode === null) return;

    var visible  = (maxHops === null) ? new Set(nodes.getIds()) : getNodesWithinHops(currentNode, maxHops);
    var outgoing = new Set();
    var incoming = new Set();
    edges.forEach(function (e) {
      if (e.from === currentNode) outgoing.add(e.to);
      if (e.to   === currentNode) incoming.add(e.from);
    });

    nodes.update(nodes.getIds().map(function (id) {
      var d = defaultNodeColors[id] || {};
      if (!visible.has(id))        return { id: id, color: { background: '#f0f0f0', border: '#e0e0e0' }, font: makeFont('#e0e0e0') };
      if (id === currentNode)       return { id: id, color: { background: '#00b894', border: '#00695c' }, font: makeFont('#003d33') };
      if (outgoing.has(id))         return { id: id, color: { background: '#fab1a0', border: '#e17055' }, font: makeFont('#6d2b1a') };
      if (incoming.has(id))         return { id: id, color: { background: '#74b9ff', border: '#0984e3' }, font: makeFont('#003580') };
      return { id: id, color: d.color, font: makeFont(d.fontColor || '#2d3436') };
    }));

    edges.update(edges.getIds().map(function (id) {
      var e = edges.get(id);
      if (!visible.has(e.from) || !visible.has(e.to))
        return { id: id, color: { color: '#eeeeee', opacity: 0.2 }, width: 1 };
      if (connectedEdgesOfNode.has(id)) {
        var col = (e.from === currentNode) ? '#e17055' : '#0984e3';
        return { id: id, color: { color: col, opacity: 1.0 }, width: 2.5 };
      }
      return { id: id, color: { color: '#aaaaaa', opacity: 0.6 }, width: 1 };
    }));

    document.querySelectorAll('.hop-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.hop === String(maxHops));
    });
  };

  document.querySelectorAll('.hop-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = btn.dataset.hop === 'null' ? null : parseInt(btn.dataset.hop, 10);
      window.applyHopFilter(v);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ソースコードパネル
  // ─────────────────────────────────────────────────────────────────────────

  function showSource(nodeId) {
    var panel       = document.getElementById('source-panel');
    var placeholder = document.getElementById('source-placeholder');
    var content     = document.getElementById('source-content');
    panel.style.display = 'flex';

    if (!nodeId) {
      placeholder.style.display = 'flex';
      content.style.display     = 'none';
      currentSourceNodeId = null;
      return;
    }

    currentSourceNodeId = nodeId;
    var info     = nodeInfoMap[nodeId] || {};
    var baseName = info.file ? info.file.replace(/\\/g, '/').split('/').pop() : '';

    document.getElementById('source-func-name').textContent = info.labelFull || nodeId;
    document.getElementById('source-file-info').textContent =
      baseName ? (baseName + ' : ' + info.line + '行目') : '';
    document.getElementById('source-code').textContent = info.source || '(ソースが見つかりません)';

    placeholder.style.display = 'none';
    content.style.display     = 'flex';
  }

  function closeSrcPanel() {
    document.getElementById('src-toggle').checked         = false;
    document.getElementById('source-panel').style.display = 'none';
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
      alert('このファイル自体がすでにスタンドアロン HTML です。');
    }
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

  document.getElementById('font-size-input').addEventListener('input', function () {
    var val = parseInt(this.value, 10);
    if (!isNaN(val) && val >= 6 && val <= 64) { canvasFontSize = val; applyFontSize(); }
  });
  document.getElementById('font-size-reset').addEventListener('click', function () {
    canvasFontSize = DEFAULT_FONT_SIZE;
    document.getElementById('font-size-input').value = DEFAULT_FONT_SIZE;
    applyFontSize();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 検索
  // ─────────────────────────────────────────────────────────────────────────

  var searchBox = document.getElementById('search-box');
  searchBox.addEventListener('input', function () {
    if (!nodes) return;
    var q = this.value.trim().toLowerCase();
    if (!q) { resetAll(); return; }
    var matchSet = new Set();
    // labelFull / labelShort 両方で検索
    Object.keys(nodeInfoMap).forEach(function (id) {
      var info = nodeInfoMap[id];
      if ((info.labelFull  || '').toLowerCase().indexOf(q) !== -1 ||
          (info.labelShort || '').toLowerCase().indexOf(q) !== -1) {
        matchSet.add(id);
      }
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
      var q    = this.value.trim().toLowerCase();
      var hits = nodes.get({
        filter: function (n) {
          var info = nodeInfoMap[n.id] || {};
          return (info.labelFull  || '').toLowerCase().indexOf(q) !== -1 ||
                 (info.labelShort || '').toLowerCase().indexOf(q) !== -1;
        }
      });
      if (hits.length) network.focus(hits[0].id, { scale: 1.5, animation: { duration: 400 } });
    }
    if (e.key === 'Escape') resetAll();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // リセット
  // ─────────────────────────────────────────────────────────────────────────

  function resetAll() {
    currentNode = null; currentHop = null;
    connectedEdgesOfNode = new Set();
    if (network) network.unselectAll();
    if (nodes) {
      nodes.update(nodes.getIds().map(function (id) {
        var d = defaultNodeColors[id] || {};
        return { id: id, color: d.color, font: makeFont(d.fontColor || '#2d3436') };
      }));
    }
    if (edges) {
      edges.update(edges.getIds().map(function (id) {
        return { id: id, color: { color: '#aaaaaa', opacity: 0.8 }, width: 1 };
      }));
    }
    document.getElementById('hop-panel').style.display    = 'none';
    document.getElementById('search-box').value           = '';
    document.querySelectorAll('.hop-btn').forEach(function (b) { b.classList.remove('active'); });
    if (document.getElementById('src-toggle').checked) {
      showSource(null);
    } else {
      document.getElementById('source-panel').style.display = 'none';
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
      row.title = item.file;
      var dot  = document.createElement('span');
      dot.style.cssText = 'width:10px;height:10px;border-radius:50%;flex-shrink:0;' +
        'background:' + item.color + ';border:1.5px solid ' + item.border + ';';
      var label = document.createElement('span');
      label.style.cssText = 'color:#2d3436;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;';
      label.textContent = name;
      row.appendChild(dot); row.appendChild(label);
      container.appendChild(row);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 起動
  // ─────────────────────────────────────────────────────────────────────────

  // 初期チェックボックス状態を showFullSig に同期
  showFullSig = document.getElementById('sig-toggle').checked;

  if (typeof INITIAL_GRAPH_DATA !== 'undefined') {
    renderGraph(INITIAL_GRAPH_DATA);
  } else {
    vscode.postMessage({ type: 'ready' });
  }

})();