// ============================================================================
// DevTools Panel — 3D Scene Inspector (Core)
// Communicates with the renderer via chrome.devtools.inspectedWindow.eval
// Game-specific panels are loaded dynamically via the extension system.
// ============================================================================

(function () {
  "use strict";

  // --- State ---
  let sceneTree = null;
  let selectedId = null;
  let gizmoMode = "translate";
  let gizmoVisible = true;
  let labelsVisible = true;
  let hitboxesVisible = true;
  let refreshTimer = null;
  let filterModels = true;
  let filterEntities = true;
  var currentView = "scene";

  // Extension state
  var panelExtensions = [];
  var extensionLifecycle = {};
  var extensionTimers = {};

  // --- DOM Elements ---
  const sceneTreeEl = document.getElementById("scene-tree");
  const propertiesEl = document.getElementById("properties-content");
  const btnTranslate = document.getElementById("btn-translate");
  const btnRotate = document.getElementById("btn-rotate");
  const btnScale = document.getElementById("btn-scale");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnToggleGizmo = document.getElementById("btn-toggle-gizmo");
  const sceneToolbarEl = document.getElementById("scene-toolbar");
  const overlaysMenuEl = document.getElementById("overlays-menu");
  const btnOverlaysMenu = document.getElementById("btn-overlays-menu");
  const chkLabels = document.getElementById("chk-labels");
  const chkHitboxes = document.getElementById("chk-hitboxes");
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const importStatus = document.getElementById("import-status");
  const filterModelsEl = document.getElementById("filter-models");
  const filterEntitiesEl = document.getElementById("filter-entities");
  const btnScanModels = document.getElementById("btn-scan-models");
  const availableModelsListEl = document.getElementById("available-models-list");
  const modelSearchInput = document.getElementById("model-search");
  let availableModels = [];
  let modelViewMode = "grid";
  let modelThumbnails = {};
  let modelSearchQuery = "";
  var btnModelGrid = document.getElementById("btn-model-grid");
  var btnModelTree = document.getElementById("btn-model-tree");
  let ctxMenuEl = null;

  // Core view buttons
  var btnViewScene = document.getElementById("btn-view-scene");
  var btnViewImport = document.getElementById("btn-view-import");
  var btnViewPerf = document.getElementById("btn-view-perf");
  var mainContentEl = document.getElementById("main-content");
  var importPanel = document.getElementById("import-panel");
  var perfPanel = document.getElementById("perf-panel");
  var perfStatusEl = document.getElementById("perf-status");
  var perfTimer = null;
  var perfHistory = { gpu: [], renderer: [], main: [], worker: [] };
  var PERF_MAX_POINTS = 60;

  // --- Eval helper ---
  function evalInPage(code, callback) {
    chrome.devtools.inspectedWindow.eval(code, function (result, isException) {
      if (isException) {
        console.error("[3D Scene] Eval error:", result);
        callback(null, result);
      } else {
        callback(result, null);
      }
    });
  }

  function getSceneInspector() {
    return new Promise(function (resolve) {
      evalInPage("window.__sceneInspector", function (result, err) {
        if (err || !result) {
          resolve(null);
        } else {
          resolve(result);
        }
      });
    });
  }

  function callInspector(method, args) {
    var code = "(function(){ var r = window.__sceneInspector && window.__sceneInspector." + method + "(";
    if (args !== undefined && args !== null) {
      if (Array.isArray(args)) {
        code += args.map(function (a) { return JSON.stringify(a); }).join(",");
      } else {
        code += JSON.stringify(args);
      }
    }
    code += "); return r === undefined ? null : (typeof r === 'object' ? JSON.stringify(r) : r); })()";
    return new Promise(function (resolve) {
      evalInPage(code, function (result, err) {
        if (err || result === null || result === undefined) {
          resolve({ result: null, err: err });
          return;
        }
        if (typeof result === "string") {
          try { result = JSON.parse(result); } catch (e) { /* leave as string */ }
        }
        resolve({ result: result, err: err });
      });
    });
  }

  // --- Scene Tree ---
  function refreshSceneTree() {
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getSceneTree()) : null",
      function (result, err) {
        if (err || !result) {
          sceneTreeEl.innerHTML = '<p class="empty-state">Scene inspector not ready. Is the app running?</p>';
          return;
        }
        try {
          sceneTree = JSON.parse(result);
          renderSceneTree();
          if (sceneTree.selectedId !== selectedId) {
            selectedId = sceneTree.selectedId;
            renderProperties();
          }
          gizmoMode = sceneTree.gizmoMode || gizmoMode;
          gizmoVisible = sceneTree.gizmoVisible !== false;
          labelsVisible = sceneTree.showLabels === true;
          updateModeButtons();
          updateGizmoButton();
          updateLabelsButton();
        } catch (e) {
          console.error("[3D Scene] Parse error:", e);
        }
      },
    );
  }

  function renderSceneTree() {
    if (!sceneTree || !sceneTree.nodes) {
      sceneTreeEl.innerHTML = '<p class="empty-state">No nodes</p>';
      return;
    }

    var html = "";
    var nodes = sceneTree.nodes;

    nodes.sort(function (a, b) {
      if (a.type !== b.type) return a.type === "model" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === "model" && !filterModels) continue;
      if (node.type === "entity" && !filterEntities) continue;

      var isSelected = node.id === sceneTree.selectedId;
      var icon = node.type === "model" ? "📦" : "🔷";
      var typeLabel = node.type === "model" ? (node.modelFormat || "model").toUpperCase() : "ENT";

      html += '<div class="scene-node' + (isSelected ? " selected" : "") + '" data-id="' + node.id + '">';
      html += '<span class="node-icon">' + icon + "</span>";
      html += '<span class="node-type">' + typeLabel + "</span>";
      html += '<span class="node-name">' + escapeHtml(node.name) + "</span>";
      if (node.type === "model") {
        html += '<span class="node-actions"><button class="btn-remove-node" data-id="' + node.id + '" title="Delete">✕</button></span>';
      }
      html += "</div>";
    }

    if (html === "") {
      sceneTreeEl.innerHTML = '<p class="empty-state">No nodes match filters</p>';
    } else {
      sceneTreeEl.innerHTML = html;
    }

    var nodeEls = sceneTreeEl.querySelectorAll(".scene-node");
    for (var j = 0; j < nodeEls.length; j++) {
      nodeEls[j].addEventListener("click", function (e) {
        if (e.target.classList.contains("btn-remove-node")) {
          e.stopPropagation();
          var id = e.target.getAttribute("data-id");
          callInspector("removeNode", id);
          setTimeout(refreshSceneTree, 100);
          return;
        }
        var id = this.getAttribute("data-id");
        selectNode(id);
      });
      nodeEls[j].addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var id = this.getAttribute("data-id");
        var node = null;
        for (var k = 0; k < sceneTree.nodes.length; k++) {
          if (sceneTree.nodes[k].id === id) {
            node = sceneTree.nodes[k];
            break;
          }
        }
        if (node) {
          showContextMenu(e.clientX, e.clientY, id, node.type);
        }
      });
    }
  }

  function selectNode(id) {
    selectedId = id;
    callInspector("selectNode", id);
    renderPropertiesForId(id);
    if (id && currentView === "scene" && !gizmoVisible) {
      gizmoVisible = true;
      callInspector("setGizmoVisible", true);
      updateGizmoButton();
    }
    var nodeEls = sceneTreeEl.querySelectorAll(".scene-node");
    for (var i = 0; i < nodeEls.length; i++) {
      var el = nodeEls[i];
      if (el.getAttribute("data-id") === id) {
        el.classList.add("selected");
      } else {
        el.classList.remove("selected");
      }
    }
  }

  // --- Properties Panel ---
  function renderProperties() {
    if (!selectedId) {
      propertiesEl.innerHTML = '<p class="empty-state">Select a node to edit its properties</p>';
      return;
    }
    renderPropertiesForId(selectedId);
  }

  function renderPropertiesForId(id) {
    if (!sceneTree || !sceneTree.nodes) return;
    var node = null;
    for (var i = 0; i < sceneTree.nodes.length; i++) {
      if (sceneTree.nodes[i].id === id) {
        node = sceneTree.nodes[i];
        break;
      }
    }
    if (!node) {
      propertiesEl.innerHTML = '<p class="empty-state">Node not found</p>';
      return;
    }

    var isModel = node.type === "model";
    var isLocked = !!node.locked;
    var html = "";

    html += '<div class="prop-group">';
    html += '<div class="prop-group-title">Name</div>';
    html += '<div class="prop-row"><span class="prop-label">Name</span><div class="prop-value"><input type="text" id="prop-name" value="' + escapeHtml(node.name) + '"' + (isModel && !isLocked ? "" : " disabled") + "></div></div>";
    html += "</div>";

    html += '<div class="prop-group">';
    html += '<div class="prop-group-title">Transform' + (isLocked ? ' <span style="color:#888;font-size:9px">(locked)</span>' : '') + '</div>';
    html += '<div class="prop-row"><span class="prop-label">Position</span><div class="prop-value"><div class="vec3-input">';
    html += vec3Input("pos", node.position, isLocked);
    html += "</div></div></div>";
    html += '<div class="prop-row"><span class="prop-label">Rotation</span><div class="prop-value"><div class="vec3-input">';
    html += vec4Input("rot", node.rotation, isLocked);
    html += "</div></div></div>";
    html += '<div class="prop-row"><span class="prop-label">Scale</span><div class="prop-value"><div class="vec3-input">';
    html += vec3Input("scale", node.scale, isLocked);
    html += "</div></div></div>";
    html += "</div>";

    html += '<div class="prop-group">';
    html += '<div class="prop-group-title">Display</div>';
    html += '<div class="prop-row"><label class="prop-checkbox"><input type="checkbox" id="prop-visible"' + (node.visible ? " checked" : "") + (isModel && !isLocked ? "" : " disabled") + "> Visible</label></div>";
    html += '<div class="prop-row"><label class="prop-checkbox"><input type="checkbox" id="prop-locked"' + (node.locked ? " checked" : "") + (isModel ? "" : " disabled") + "> Locked</label></div>";
    html += "</div>";

    if (isModel) {
      html += '<div class="prop-actions"><button class="btn-duplicate" id="btn-duplicate-node">Duplicate</button><button class="btn-delete" id="btn-delete-node">Delete Model</button></div>';
    }

    propertiesEl.innerHTML = html;
    attachPropertyHandlers(id, node);
  }

  function vec3Input(prefix, values, disabled) {
    var axes = ["X", "Y", "Z"];
    var html = "";
    for (var i = 0; i < 3; i++) {
      html += '<span class="axis-label">' + axes[i] + "</span>";
      html += '<input type="number" step="0.1" id="prop-' + prefix + "-" + i + '" value="' + (values[i] !== undefined ? values[i].toFixed(3) : "0") + '"' + (disabled ? " disabled" : "") + '>';
    }
    return html;
  }

  function vec4Input(prefix, values, disabled) {
    var axes = ["X", "Y", "Z", "W"];
    var html = "";
    for (var i = 0; i < 4; i++) {
      html += '<span class="axis-label">' + axes[i] + "</span>";
      html += '<input type="number" step="0.01" id="prop-' + prefix + "-" + i + '" value="' + (values[i] !== undefined ? values[i].toFixed(4) : "0") + '"' + (disabled ? " disabled" : "") + '>';
    }
    return html;
  }

  function attachPropertyHandlers(id, node) {
    var isModel = node.type === "model";

    var nameEl = document.getElementById("prop-name");
    if (nameEl && isModel) {
      nameEl.addEventListener("change", function () {
        callInspector("updateNodeProperty", [id, "name", nameEl.value]);
      });
    }

    for (var i = 0; i < 3; i++) {
      (function (idx) {
        var el = document.getElementById("prop-pos-" + idx);
        if (el) {
          el.addEventListener("change", function () {
            var pos = readVec3("prop-pos");
            callInspector("updateNodeTransform", [id, { position: pos }]);
          });
        }
      })(i);
    }

    for (var j = 0; j < 4; j++) {
      (function (idx) {
        var el = document.getElementById("prop-rot-" + idx);
        if (el) {
          el.addEventListener("change", function () {
            var rot = readVec4("prop-rot");
            callInspector("updateNodeTransform", [id, { rotation: rot }]);
          });
        }
      })(j);
    }

    for (var k = 0; k < 3; k++) {
      (function (idx) {
        var el = document.getElementById("prop-scale-" + idx);
        if (el) {
          el.addEventListener("change", function () {
            var scale = readVec3("prop-scale");
            callInspector("updateNodeTransform", [id, { scale: scale }]);
          });
        }
      })(k);
    }

    var visEl = document.getElementById("prop-visible");
    if (visEl && isModel) {
      visEl.addEventListener("change", function () {
        callInspector("updateNodeProperty", [id, "visible", visEl.checked]);
      });
    }

    var lockEl = document.getElementById("prop-locked");
    if (lockEl && isModel) {
      lockEl.addEventListener("change", function () {
        callInspector("updateNodeProperty", [id, "locked", lockEl.checked]);
      });
    }

    var delBtn = document.getElementById("btn-delete-node");
    if (delBtn) {
      delBtn.addEventListener("click", function () {
        callInspector("removeNode", id);
        selectedId = null;
        setTimeout(refreshSceneTree, 100);
      });
    }

    var dupBtn = document.getElementById("btn-duplicate-node");
    if (dupBtn) {
      dupBtn.addEventListener("click", function () {
        callInspector("duplicateNode", id).then(function (res) {
          if (res.result && res.result.success) {
            importStatus.innerHTML = '<p class="success">Duplicated (id: ' + res.result.nodeId + ")</p>";
          } else {
            importStatus.innerHTML = '<p class="error">Duplicate failed: ' + escapeHtml(res.result?.error || "unknown") + "</p>";
          }
          refreshSceneTree();
        });
      });
    }
  }

  function readVec3(prefix) {
    return [
      parseFloat(document.getElementById(prefix + "-0").value) || 0,
      parseFloat(document.getElementById(prefix + "-1").value) || 0,
      parseFloat(document.getElementById(prefix + "-2").value) || 0,
    ];
  }

  function readVec4(prefix) {
    return [
      parseFloat(document.getElementById(prefix + "-0").value) || 0,
      parseFloat(document.getElementById(prefix + "-1").value) || 0,
      parseFloat(document.getElementById(prefix + "-2").value) || 0,
      parseFloat(document.getElementById(prefix + "-3").value) || 1,
    ];
  }

  // --- Gizmo Mode ---
  function setGizmoMode(mode) {
    gizmoMode = mode;
    callInspector("setGizmoMode", mode);
    updateModeButtons();
  }

  function updateModeButtons() {
    btnTranslate.classList.toggle("active", gizmoMode === "translate");
    btnRotate.classList.toggle("active", gizmoMode === "rotate");
    btnScale.classList.toggle("active", gizmoMode === "scale");
  }

  function updateGizmoButton() {
    btnToggleGizmo.textContent = "Gizmo: " + (gizmoVisible ? "On" : "Off");
    btnToggleGizmo.classList.toggle("active", gizmoVisible);
  }

  function updateLabelsButton() {
    chkLabels.checked = labelsVisible;
  }

  // --- Model Import ---
  function handleFile(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var arrayBuffer = e.target.result;
      var base64 = arrayBufferToBase64(arrayBuffer);
      importStatus.innerHTML = '<p>Importing ' + escapeHtml(file.name) + "...</p>";

      var CHUNK_SIZE = 100000;
      if (base64.length > CHUNK_SIZE) {
        var chunks = Math.ceil(base64.length / CHUNK_SIZE);
        var i = 0;
        function sendChunk() {
          if (i >= chunks) {
            callInspector("importModel", ["__importBuffer", file.name]).then(function (res) {
              evalInPage("delete window.__importBuffer", function () {});
              handleImportResult(res, file.name);
            });
            return;
          }
          var chunk = base64.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          var code;
          if (i === 0) {
            code = "window.__importBuffer = " + JSON.stringify(chunk);
          } else {
            code = "window.__importBuffer += " + JSON.stringify(chunk);
          }
          evalInPage(code, function (result, err) {
            if (err) {
              importStatus.innerHTML = '<p class="error">Transfer error: ' + escapeHtml(String(err)) + "</p>";
              return;
            }
            i++;
            sendChunk();
          });
        }
        sendChunk();
      } else {
        callInspector("importModel", [base64, file.name]).then(function (res) {
          handleImportResult(res, file.name);
        });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function handleImportResult(res, filename) {
    if (res.err) {
      importStatus.innerHTML = '<p class="error">Error: ' + escapeHtml(String(res.err)) + "</p>";
    } else if (res.result && res.result.success) {
      importStatus.innerHTML = '<p class="success">Imported: ' + escapeHtml(filename) + " (id: " + res.result.nodeId + ")</p>";
      refreshSceneTree();
    } else if (res.result && res.result.error) {
      importStatus.innerHTML = '<p class="error">Error: ' + escapeHtml(res.result.error) + "</p>";
    } else {
      importStatus.innerHTML = '<p class="error">Import failed: unknown error</p>';
    }
  }

  function arrayBufferToBase64(buffer) {
    var binary = "";
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  // --- Context Menu ---
  function showContextMenu(x, y, nodeId, nodeType) {
    hideContextMenu();
    var menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.appendChild(ctxMenuItem("📋", "Copy (JSON)", function () { copyNodeJSON(nodeId); }));
    menu.appendChild(ctxSeparator());
    if (nodeType === "model") {
      menu.appendChild(ctxMenuItem("⧉", "Duplicate", function () {
        callInspector("duplicateNode", nodeId).then(function (res) {
          if (res.result && res.result.success) {
            importStatus.innerHTML = '<p class="success">Duplicated (id: ' + res.result.nodeId + ")</p>";
          } else {
            importStatus.innerHTML = '<p class="error">Duplicate failed: ' + escapeHtml(res.result?.error || "unknown") + "</p>";
          }
          refreshSceneTree();
        });
      }));
    }
    menu.appendChild(ctxMenuItem("✕", "Delete", function () {
      callInspector("removeNode", nodeId);
      if (selectedId === nodeId) selectedId = null;
      setTimeout(refreshSceneTree, 100);
    }, true));
    document.body.appendChild(menu);
    ctxMenuEl = menu;
    setTimeout(function () { document.addEventListener("click", hideContextMenu, { once: true }); }, 0);
  }

  function ctxMenuItem(icon, label, onClick, isDanger) {
    var item = document.createElement("div");
    item.className = "ctx-menu-item" + (isDanger ? " danger" : "");
    item.innerHTML = '<span class="ctx-icon">' + icon + "</span><span>" + escapeHtml(label) + "</span>";
    item.addEventListener("click", function (e) { e.stopPropagation(); hideContextMenu(); onClick(); });
    return item;
  }

  function ctxSeparator() {
    var sep = document.createElement("div");
    sep.className = "ctx-menu-separator";
    return sep;
  }

  function hideContextMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }

  function showModelContextMenu(x, y, path) {
    hideContextMenu();
    var menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.appendChild(ctxMenuItem("📋", "Copy Path", function () {
      var textarea = document.createElement("textarea");
      textarea.value = path;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand("copy"); importStatus.innerHTML = '<p class="success">Copied: ' + escapeHtml(path) + "</p>"; }
      catch (e) { importStatus.innerHTML = '<p class="error">Copy failed</p>'; }
      document.body.removeChild(textarea);
    }));
    menu.appendChild(ctxMenuItem("📥", "Import", function () { importFromAssets(path); }));
    document.body.appendChild(menu);
    ctxMenuEl = menu;
    setTimeout(function () { document.addEventListener("click", hideContextMenu, { once: true }); }, 0);
  }

  function copyNodeJSON(nodeId) {
    callInspector("getNodeJSON", nodeId).then(function (res) {
      if (res.result) {
        var textarea = document.createElement("textarea");
        textarea.value = res.result;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand("copy"); importStatus.innerHTML = '<p class="success">Copied JSON to clipboard</p>'; }
        catch (e) { importStatus.innerHTML = '<p class="error">Copy failed</p>'; }
        document.body.removeChild(textarea);
      }
    });
  }

  // --- Available Models ---
  function scanAvailableModels() {
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getAvailableModels()) : null",
      function (result, err) {
        if (err || !result) {
          availableModelsListEl.innerHTML = '<p class="empty-state" style="padding:4px">No models found</p>';
          return;
        }
        try { availableModels = JSON.parse(result); renderAvailableModels(); }
        catch (e) { console.error("[3D Scene] Parse error scanning models:", e); }
      },
    );
  }

  function getFilteredModels() {
    if (!modelSearchQuery) return availableModels;
    var q = modelSearchQuery.toLowerCase();
    return availableModels.filter(function (m) {
      return m.name.toLowerCase().indexOf(q) >= 0 || m.path.toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderAvailableModels() {
    if (!availableModels || availableModels.length === 0) {
      availableModelsListEl.innerHTML = '<p class="empty-state" style="padding:4px">No models in assets/models</p>';
      return;
    }
    if (modelViewMode === "grid") renderAvailableModelsGrid();
    else renderAvailableModelsTree();
  }

  function renderAvailableModelsGrid() {
    var filtered = getFilteredModels();
    if (filtered.length === 0) {
      availableModelsListEl.innerHTML = '<p class="empty-state" style="padding:4px">No models match "' + escapeHtml(modelSearchQuery) + '"</p>';
      return;
    }
    var html = '<div class="model-grid">';
    for (var i = 0; i < filtered.length; i++) {
      var m = filtered[i];
      html += '<div class="model-grid-item" data-path="' + escapeHtml(m.path) + '">';
      html += '<div class="model-grid-thumb" id="thumb-' + i + '">';
      if (modelThumbnails[m.path] && modelThumbnails[m.path] !== "__none__") {
        html += '<img src="' + modelThumbnails[m.path] + '">';
      } else if (modelThumbnails[m.path] === "__none__") {
        html += '<span class="thumb-placeholder">\u{1F4E6}</span>';
      } else {
        html += '<span class="thumb-loading">...</span>';
      }
      html += '</div>';
      html += '<div class="model-grid-info">';
      html += '<div class="model-grid-name">' + escapeHtml(m.name) + '</div>';
      html += '<div class="model-grid-format">' + escapeHtml(m.format) + '</div>';
      html += '</div></div>';
    }
    html += '</div>';
    availableModelsListEl.innerHTML = html;

    var items = availableModelsListEl.querySelectorAll(".model-grid-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function () { importFromAssets(this.getAttribute("data-path")); });
      items[j].addEventListener("contextmenu", function (e) {
        e.preventDefault(); e.stopPropagation();
        showModelContextMenu(e.clientX, e.clientY, this.getAttribute("data-path"));
      });
    }

    var thumbQueue = [];
    for (var k = 0; k < filtered.length; k++) {
      if (!modelThumbnails[filtered[k].path]) thumbQueue.push({ idx: k, path: filtered[k].path });
    }
    processThumbQueue(thumbQueue);
  }

  function processThumbQueue(queue) {
    if (!queue || queue.length === 0) return;
    var item = queue.shift();
    callInspector("getModelThumbnail", item.path).then(function (res) {
      modelThumbnails[item.path] = res.result || "__none__";
      var thumbEl = document.getElementById("thumb-" + item.idx);
      if (thumbEl) {
        if (res.result) thumbEl.innerHTML = '<img src="' + res.result + '">';
        else thumbEl.innerHTML = '<span class="thumb-placeholder">\u{1F4E6}</span>';
      }
      if (queue.length > 0) setTimeout(function () { processThumbQueue(queue); }, 16);
    });
  }

  function renderAvailableModelsTree() {
    var filtered = getFilteredModels();
    if (filtered.length === 0) {
      availableModelsListEl.innerHTML = '<p class="empty-state" style="padding:4px">No models match "' + escapeHtml(modelSearchQuery) + '"</p>';
      return;
    }
    var tree = buildModelTree(filtered);
    var html = '<div class="model-tree">' + renderTreeNodes(tree, 0) + '</div>';
    availableModelsListEl.innerHTML = html;

    var folders = availableModelsListEl.querySelectorAll(".tree-folder");
    for (var i = 0; i < folders.length; i++) {
      folders[i].addEventListener("click", function (e) {
        e.stopPropagation();
        this.classList.toggle("collapsed");
        var next = this.nextElementSibling;
        if (next && next.classList.contains("tree-children")) next.classList.toggle("collapsed");
      });
    }
    var files = availableModelsListEl.querySelectorAll(".tree-file");
    for (var j = 0; j < files.length; j++) {
      files[j].addEventListener("click", function (e) {
        e.stopPropagation();
        importFromAssets(this.getAttribute("data-path"));
      });
    }
  }

  function buildModelTree(models) {
    var root = { folders: {}, files: [] };
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var parts = m.path.split("/");
      var node = root;
      for (var j = 0; j < parts.length - 1; j++) {
        var part = parts[j];
        if (!node.folders[part]) node.folders[part] = { folders: {}, files: [] };
        node = node.folders[part];
      }
      node.files.push(m);
    }
    return root;
  }

  function renderTreeNodes(node, depth) {
    var html = "";
    var folderKeys = Object.keys(node.folders).sort();
    for (var i = 0; i < folderKeys.length; i++) {
      var key = folderKeys[i];
      var child = node.folders[key];
      var fileCount = countFiles(child);
      html += '<div class="tree-node"><div class="tree-folder">';
      html += '<span class="tree-arrow">\u25BC</span><span class="tree-icon">\u{1F4C1}</span>';
      html += '<span class="tree-name">' + escapeHtml(key) + '</span>';
      html += '<span style="color:#666;font-size:9px">(' + fileCount + ')</span>';
      html += '</div><div class="tree-children">' + renderTreeNodes(child, depth + 1) + '</div></div>';
    }
    var files = node.files.sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      html += '<div class="tree-file" data-path="' + escapeHtml(f.path) + '">';
      html += '<span class="tree-file-format">' + escapeHtml(f.format) + '</span>';
      html += '<span class="tree-file-name">' + escapeHtml(f.name) + '</span>';
      html += '<span class="tree-file-add">+</span></div>';
    }
    return html;
  }

  function countFiles(node) {
    var count = node.files.length;
    var keys = Object.keys(node.folders);
    for (var i = 0; i < keys.length; i++) count += countFiles(node.folders[keys[i]]);
    return count;
  }

  function importFromAssets(path) {
    importStatus.innerHTML = '<p>Importing from assets...</p>';
    callInspector("importAssetModel", path).then(function (res) {
      if (res.err) {
        importStatus.innerHTML = '<p class="error">Error: ' + escapeHtml(String(res.err)) + "</p>";
      } else if (res.result && res.result.success) {
        importStatus.innerHTML = '<p class="success">Imported from assets (id: ' + res.result.nodeId + ")</p>";
        refreshSceneTree();
      } else if (res.result && res.result.error) {
        importStatus.innerHTML = '<p class="error">Error: ' + escapeHtml(res.result.error) + "</p>";
      } else {
        importStatus.innerHTML = '<p class="error">Import failed: unknown error</p>';
      }
    });
  }

  // --- Event Handlers ---
  btnTranslate.addEventListener("click", function () { setGizmoMode("translate"); });
  btnRotate.addEventListener("click", function () { setGizmoMode("rotate"); });
  btnScale.addEventListener("click", function () { setGizmoMode("scale"); });
  btnRefresh.addEventListener("click", refreshSceneTree);
  btnScanModels.addEventListener("click", scanAvailableModels);

  if (modelSearchInput) {
    modelSearchInput.addEventListener("input", function () {
      modelSearchQuery = this.value.trim();
      renderAvailableModels();
    });
  }

  btnModelGrid.addEventListener("click", function () {
    modelViewMode = "grid";
    btnModelGrid.classList.add("active");
    btnModelTree.classList.remove("active");
    renderAvailableModels();
  });

  btnModelTree.addEventListener("click", function () {
    modelViewMode = "tree";
    btnModelTree.classList.add("active");
    btnModelGrid.classList.remove("active");
    renderAvailableModels();
  });

  btnToggleGizmo.addEventListener("click", function () {
    gizmoVisible = !gizmoVisible;
    callInspector("setGizmoVisible", gizmoVisible);
    updateGizmoButton();
  });

  // --- Overlay toggles (core: labels, hitboxes) ---
  function saveOverlayState() {
    try {
      localStorage.setItem("devtools-overlays", JSON.stringify({
        labels: labelsVisible,
        hitboxes: hitboxesVisible,
      }));
    } catch (e) {}
  }

  function loadOverlayState() {
    try {
      var s = JSON.parse(localStorage.getItem("devtools-overlays") || "{}");
      if (typeof s.labels === "boolean") labelsVisible = s.labels;
      if (typeof s.hitboxes === "boolean") hitboxesVisible = s.hitboxes;
    } catch (e) {}
  }

  chkLabels.addEventListener("change", function () {
    labelsVisible = chkLabels.checked;
    callInspector("setShowLabels", labelsVisible);
    saveOverlayState();
  });

  chkHitboxes.addEventListener("change", function () {
    hitboxesVisible = chkHitboxes.checked;
    callInspector("setShowHitboxes", hitboxesVisible);
    saveOverlayState();
  });

  btnOverlaysMenu.addEventListener("click", function (e) {
    e.stopPropagation();
    overlaysMenuEl.style.display = overlaysMenuEl.style.display === "none" ? "flex" : "none";
  });
  document.addEventListener("click", function () { overlaysMenuEl.style.display = "none"; });
  overlaysMenuEl.addEventListener("click", function (e) { e.stopPropagation(); });

  filterModelsEl.addEventListener("change", function () { filterModels = filterModelsEl.checked; renderSceneTree(); });
  filterEntitiesEl.addEventListener("change", function () { filterEntities = filterEntitiesEl.checked; renderSceneTree(); });

  fileInput.addEventListener("change", function (e) {
    var files = e.target.files;
    for (var i = 0; i < files.length; i++) handleFile(files[i]);
    fileInput.value = "";
  });

  dropZone.addEventListener("click", function () { fileInput.click(); });
  dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("dragover"); });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault(); dropZone.classList.remove("dragover");
    var files = e.dataTransfer.files;
    for (var i = 0; i < files.length; i++) handleFile(files[i]);
  });

  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT") return;
    switch (e.key.toLowerCase()) {
      case "w": setGizmoMode("translate"); break;
      case "e": setGizmoMode("rotate"); break;
      case "r": setGizmoMode("scale"); break;
      case "f5": e.preventDefault(); refreshSceneTree(); break;
    }
  });

  // --- DevToolsPanel Helper API (exposed for game extensions) ---
  var DevToolsPanel = {
    callInspector: callInspector,
    evalInPage: evalInPage,
    escapeHtml: escapeHtml,
    fmtVal: fmtVal,
    fmtVec3: fmtVec3,
    debugGridHtml: debugGridHtml,
  };
  window.DevToolsPanel = DevToolsPanel;

  // --- Extension Loading System ---

  function loadExtensions(callback) {
    // Query the page for panel extensions and overlay toggles
    evalInPage(
      "(function(){ var s = window.__sceneInspector; if (!s) return null;" +
      " var exts = typeof s.getPanelExtensions === 'function' ? s.getPanelExtensions() : [];" +
      " var toggles = typeof s.getOverlayToggles === 'function' ? s.getOverlayToggles() : [];" +
      " return JSON.stringify({ extensions: exts, toggles: toggles }); })()",
      function (result, err) {
        if (err || !result) { callback({ extensions: [], toggles: [] }); return; }
        try {
          var data = JSON.parse(result);
          callback(data);
        } catch (e) {
          console.error("[DevTools] Failed to parse extensions:", e);
          callback({ extensions: [], toggles: [] });
        }
      },
    );
  }

  function checkRequiredMethods(methods, callback) {
    if (!methods || methods.length === 0) { callback(true); return; }
    var checks = methods.map(function (m) { return "'" + m + "': typeof s." + m + " === 'function'"; }).join(",");
    evalInPage(
      "(function(){ var s = window.__sceneInspector; if (!s) return null;" +
      " return JSON.stringify({" + checks + "}); })()",
      function (result, err) {
        if (err || !result) { callback(false); return; }
        try {
          var avail = JSON.parse(result);
          var allPresent = methods.every(function (m) { return avail[m] === true; });
          callback(allPresent);
        } catch (e) { callback(false); }
      },
    );
  }

  function createExtensionTab(ext) {
    var tabBar = document.getElementById("tab-bar");
    var contentArea = document.getElementById("content-area");

    // Create tab button
    var tabBtn = document.createElement("button");
    tabBtn.className = "tab";
    tabBtn.id = "btn-ext-" + ext.id;
    tabBtn.textContent = ext.tabLabel;
    if (ext.tabTooltip) tabBtn.title = ext.tabTooltip;
    tabBtn.addEventListener("click", function () {
      if (currentView === ext.id) switchView("scene");
      else switchView(ext.id);
    });

    // Insert tab in order (before the spacer)
    var spacer = tabBar.querySelector(".tab-spacer");
    if (spacer) tabBar.insertBefore(tabBtn, spacer);
    else tabBar.appendChild(tabBtn);

    // Create panel container
    var panel = document.createElement("div");
    panel.id = "ext-panel-" + ext.id;
    panel.style.display = "none";
    panel.style.flex = "1";
    panel.style.overflowY = "auto";
    panel.innerHTML = ext.html;
    contentArea.appendChild(panel);

    // Inject CSS
    if (ext.css) {
      var style = document.createElement("style");
      style.id = "ext-css-" + ext.id;
      style.textContent = ext.css;
      document.head.appendChild(style);
    }

    // Eval script
    if (ext.script) {
      try {
        var lifecycle = eval(ext.script);
        if (lifecycle && typeof lifecycle === "object") {
          extensionLifecycle[ext.id] = lifecycle;
        }
      } catch (e) {
        console.error("[DevTools] Extension script error (" + ext.id + "):", e);
      }
    }

    panelExtensions.push(ext);
  }

  function createOverlayToggle(toggle) {
    var label = document.createElement("label");
    label.className = "overlay-toggle-row";
    label.innerHTML = '<input type="checkbox" id="chk-' + toggle.id + '"> ' + escapeHtml(toggle.label);
    overlaysMenuEl.appendChild(label);

    if (toggle.script) {
      try {
        eval(toggle.script);
      } catch (e) {
        console.error("[DevTools] Overlay toggle script error (" + toggle.id + "):", e);
      }
    }
  }

  // --- View Switching ---
  function switchView(view) {
    currentView = view;

    // Update core tab button states
    btnViewScene.classList.toggle("active", view === "scene");
    btnViewImport.classList.toggle("active", view === "import");
    btnViewPerf.classList.toggle("active", view === "perf");

    // Update extension tab button states
    for (var i = 0; i < panelExtensions.length; i++) {
      var ext = panelExtensions[i];
      var btn = document.getElementById("btn-ext-" + ext.id);
      if (btn) btn.classList.toggle("active", view === ext.id);
    }

    // Show/hide scene toolbar
    sceneToolbarEl.classList.toggle("hidden", view !== "scene");

    // Show/hide core panels
    mainContentEl.style.display = view === "scene" ? "flex" : "none";
    importPanel.style.display = view === "import" ? "block" : "none";
    perfPanel.style.display = view === "perf" ? "block" : "none";

    // Show/hide extension panels
    for (var j = 0; j < panelExtensions.length; j++) {
      var extId = panelExtensions[j].id;
      var panel = document.getElementById("ext-panel-" + extId);
      if (panel) panel.style.display = view === extId ? "block" : "none";

      // Manage lifecycle
      var lc = extensionLifecycle[extId];
      if (view === extId) {
        if (lc && lc.onActivate) lc.onActivate();
        if (lc && lc.onRefresh) {
          lc.onRefresh();
          extensionTimers[extId] = setInterval(function () {
            var l = extensionLifecycle[extId];
            if (l && l.onRefresh) l.onRefresh();
          }, 500);
        }
      } else {
        if (extensionTimers[extId]) { clearInterval(extensionTimers[extId]); delete extensionTimers[extId]; }
        if (lc && lc.onDeactivate) lc.onDeactivate();
      }
    }

    // Performance panel timers
    if (view === "perf") {
      evalInPage(
        "window.__sceneInspector ? window.__sceneInspector.enablePerformanceMonitoring() : null",
        function () {
          refreshPerf();
          if (!perfTimer) perfTimer = setInterval(refreshPerf, 1000);
        },
      );
    } else {
      if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
      evalInPage(
        "window.__sceneInspector ? window.__sceneInspector.disablePerformanceMonitoring() : null",
        function () {},
      );
    }

    // Import panel auto-scan
    if (view === "import" && availableModels.length === 0) scanAvailableModels();
  }

  btnViewScene.addEventListener("click", function () { switchView("scene"); });
  btnViewImport.addEventListener("click", function () {
    if (currentView === "import") switchView("scene"); else switchView("import");
  });
  btnViewPerf.addEventListener("click", function () {
    if (currentView === "perf") switchView("scene"); else switchView("perf");
  });

  // --- Performance Panel ---
  var PERF_COLORS = {
    cpu: "#56b6c2", mem: "#e5c07b", disk: "#d19a66",
    network: "#c678dd", gc: "#e06c75", gpu: "#98c379",
  };

  function pushPerfHistory(key, point) {
    var arr = perfHistory[key];
    arr.push(point);
    if (arr.length > PERF_MAX_POINTS) arr.shift();
  }

  function refreshPerf() {
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getPerformanceMetrics()) : null",
      function (result, err) {
        if (err || !result) {
          perfStatusEl.textContent = "Not available — is debug mode enabled?";
          return;
        }
        try {
          var m = JSON.parse(result);
          if (!m) { perfStatusEl.textContent = "Not available"; return; }
          perfStatusEl.textContent =
            "GPU: " + fmtVal(m.gpu.fps, 0) + " FPS / " + fmtVal(m.gpu.utilization, 1) + "%  |  " +
            "R: " + fmtVal(m.renderer.cpuPercent, 0) + "%  " +
            "M: " + fmtVal(m.main.cpuPercent, 0) + "%  " +
            "W: " + fmtVal(m.worker.cpuPercent, 0) + "%";
          pushPerfHistory("gpu", { utilization: m.gpu.utilization, fps: m.gpu.fps });
          pushPerfHistory("renderer", m.renderer);
          pushPerfHistory("main", m.main);
          pushPerfHistory("worker", m.worker);
          drawGpuChart();
          drawProcessChart("renderer", "perf-chart-renderer", "perf-legend-renderer");
          drawProcessChart("main", "perf-chart-main", "perf-legend-main");
          drawProcessChart("worker", "perf-chart-worker", "perf-legend-worker");
        } catch (e) { perfStatusEl.textContent = "Error: " + String(e); }
      },
    );
  }

  function drawLine(ctx, data, color, maxVal, w, h) {
    if (!data || data.length === 0) return;
    var padL = 40, padR = 8, padT = 8, padB = 16;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = padL + (plotW * i) / (PERF_MAX_POINTS - 1);
      var v = Math.min(maxVal, data[i]);
      var y = padT + plotH - (plotH * v) / maxVal;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawAxis(ctx, w, h, maxVal, unit) {
    var padL = 40, padR = 8, padT = 8, padB = 16;
    var plotH = h - padT - padB;
    ctx.strokeStyle = "#3e3e3e"; ctx.fillStyle = "#888"; ctx.font = "10px monospace"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(w - padR, padT + plotH); ctx.stroke();
    for (var i = 0; i <= 4; i++) {
      var v = (maxVal * (4 - i)) / 4, y = padT + (plotH * i) / 4;
      ctx.fillText(fmtVal(v, 0) + unit, 2, y + 3);
    }
  }

  function drawGpuChart() {
    var canvas = document.getElementById("perf-chart-gpu");
    if (!canvas) return;
    var ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, w, h);
    var data = perfHistory.gpu.map(function (p) { return p.utilization; });
    drawAxis(ctx, w, h, 100, "%");
    drawLine(ctx, data, PERF_COLORS.gpu, 100, w, h);
    var legendEl = document.getElementById("perf-legend-gpu");
    if (legendEl) {
      var last = perfHistory.gpu[perfHistory.gpu.length - 1];
      legendEl.innerHTML = '<span class="legend-item" style="color:' + PERF_COLORS.gpu + '">GPU Util: ' +
        (last ? fmtVal(last.utilization, 1) + "%" : "\u2014") +
        "  (FPS: " + (last ? fmtVal(last.fps, 0) : "\u2014") + ")</span>";
    }
  }

  function drawProcessChart(key, canvasId, legendId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, w, h);
    var hist = perfHistory[key];
    if (!hist || hist.length === 0) return;
    var cpuData = hist.map(function (p) { return p.cpuPercent; });
    var memData = hist.map(function (p) { return p.memUsedMB; });
    var diskData = hist.map(function (p) { return p.diskKBps; });
    var netData = hist.map(function (p) { return p.networkKBps; });
    var gcData = hist.map(function (p) { return p.gc ? p.gc.count : 0; });
    drawAxis(ctx, w, h, 100, "%");
    drawLine(ctx, cpuData, PERF_COLORS.cpu, 100, w, h);
    var memMax = 200;
    drawLine(ctx, memData.map(function (v) { return (v / memMax) * 100; }), PERF_COLORS.mem, 100, w, h);
    drawLine(ctx, diskData.map(function (v) { return Math.min(100, v); }), PERF_COLORS.disk, 100, w, h);
    drawLine(ctx, netData.map(function (v) { return Math.min(100, v); }), PERF_COLORS.network, 100, w, h);
    drawLine(ctx, gcData.map(function (v) { return Math.min(100, (v / 20) * 100); }), PERF_COLORS.gc, 100, w, h);
    var legendEl = document.getElementById(legendId);
    if (legendEl) {
      var last = hist[hist.length - 1];
      legendEl.innerHTML =
        '<span class="legend-item" style="color:' + PERF_COLORS.cpu + '">CPU: ' + fmtVal(last.cpuPercent, 1) + '%</span>' +
        '<span class="legend-item" style="color:' + PERF_COLORS.mem + '">Mem: ' + fmtVal(last.memUsedMB, 1) + 'MB</span>' +
        '<span class="legend-item" style="color:' + PERF_COLORS.disk + '">Disk: ' + fmtVal(last.diskKBps, 1) + 'KB/s</span>' +
        '<span class="legend-item" style="color:' + PERF_COLORS.network + '">Net: ' + fmtVal(last.networkKBps, 1) + 'KB/s</span>' +
        '<span class="legend-item" style="color:' + PERF_COLORS.gc + '">GC: ' + (last.gc ? last.gc.count : 0) + ' (' + (last.gc ? fmtVal(last.gc.totalTime, 1) : "0") + 'ms)</span>';
    }
  }

  // --- Utils ---
  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  function fmtVal(v, decimals) {
    if (typeof v === "number") return v.toFixed(decimals || 2);
    return String(v);
  }

  function fmtVec3(arr, decimals) {
    if (!arr) return "—";
    var d = decimals || 1;
    return "(" + arr[0].toFixed(d) + ", " + arr[1].toFixed(d) + ", " + arr[2].toFixed(d) + ")";
  }

  function debugGridHtml(rows) {
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      html += '<div class="debug-row">';
      html += '<div class="debug-label">' + escapeHtml(rows[i][0]) + '</div>';
      html += '<div class="debug-value">' + escapeHtml(rows[i][1]) + '</div>';
      html += '</div>';
    }
    return html;
  }

  // --- Init ---
  function start() {
    refreshSceneTree();
    scanAvailableModels();
    loadOverlayState();
    chkLabels.checked = labelsVisible;
    chkHitboxes.checked = hitboxesVisible;
    callInspector("setShowLabels", labelsVisible);
    callInspector("setShowHitboxes", hitboxesVisible);
    refreshTimer = setInterval(refreshSceneTree, 500);
    switchView("scene");
  }

  function waitForInspector() {
    getSceneInspector().then(function (inspector) {
      if (inspector) {
        // Load game-specific extensions before starting
        loadExtensions(function (data) {
          // Create extension tabs (check required methods first)
          var pending = (data.extensions || []).length + (data.toggles || []).length;
          if (pending === 0) { start(); return; }

          var validExtensions = [];
          var validToggles = [];

          // Check extensions
          var extRemaining = (data.extensions || []).length;
          if (extRemaining === 0) {
            processToggles();
          } else {
            (data.extensions || []).forEach(function (ext) {
              checkRequiredMethods(ext.requiredMethods, function (ok) {
                if (ok) validExtensions.push(ext);
                extRemaining--;
                if (extRemaining === 0) processToggles();
              });
            });
          }

          function processToggles() {
            var toggleRemaining = (data.toggles || []).length;
            if (toggleRemaining === 0) {
              finish();
              return;
            }
            (data.toggles || []).forEach(function (toggle) {
              checkRequiredMethods(toggle.requiredMethods, function (ok) {
                if (ok) validToggles.push(toggle);
                toggleRemaining--;
                if (toggleRemaining === 0) finish();
              });
            });
          }

          function finish() {
            validExtensions.sort(function (a, b) { return (a.order || 100) - (b.order || 100); });
            for (var i = 0; i < validExtensions.length; i++) createExtensionTab(validExtensions[i]);
            for (var j = 0; j < validToggles.length; j++) createOverlayToggle(validToggles[j]);
            start();
          }
        });
      } else {
        setTimeout(waitForInspector, 1000);
      }
    });
  }

  waitForInspector();

  // Cleanup on unload
  window.addEventListener("beforeunload", function () {
    if (refreshTimer) clearInterval(refreshTimer);
    if (perfTimer) clearInterval(perfTimer);
    // Clean up extension timers
    for (var id in extensionTimers) {
      if (extensionTimers[id]) clearInterval(extensionTimers[id]);
    }
    // Call extension onDestroy
    for (var extId in extensionLifecycle) {
      var lc = extensionLifecycle[extId];
      if (lc && lc.onDestroy) lc.onDestroy();
    }
  });

})();
