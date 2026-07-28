// ============================================================================
// DevTools Panel — 3D Scene Inspector
// Communicates with the renderer via chrome.devtools.inspectedWindow.eval
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
  let chunkGridVisible = true;
  let velArrowsVisible = true;
  let refreshTimer = null;
  let filterModels = true;
  let filterEntities = true;
  var currentView = "scene";

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
  const chkChunkGrid = document.getElementById("chk-chunkgrid");
  const chkVelArrows = document.getElementById("chk-velarrows");
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
    var code = "(window.__sceneInspector && window.__sceneInspector." + method + "(";
    if (args !== undefined && args !== null) {
      if (Array.isArray(args)) {
        code += args.map(function (a) { return JSON.stringify(a); }).join(",");
      } else {
        code += JSON.stringify(args);
      }
    }
    code += "))";
    return new Promise(function (resolve) {
      evalInPage(code, function (result, err) {
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
          // Update gizmo mode buttons
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

    // Sort: models first, then entities
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

    // Attach click + context menu handlers
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
    // Auto-enable gizmo when a node is selected in scene tab
    if (id && currentView === "scene" && !gizmoVisible) {
      gizmoVisible = true;
      callInspector("setGizmoVisible", true);
      updateGizmoButton();
    }
    // Update selected styling
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

    // Name
    html += '<div class="prop-group">';
    html += '<div class="prop-group-title">Name</div>';
    html += '<div class="prop-row"><span class="prop-label">Name</span><div class="prop-value"><input type="text" id="prop-name" value="' + escapeHtml(node.name) + '"' + (isModel && !isLocked ? "" : " disabled") + "></div></div>";
    html += "</div>";

    // Transform
    html += '<div class="prop-group">';
    html += '<div class="prop-group-title">Transform' + (isLocked ? ' <span style="color:#888;font-size:9px">(locked)</span>' : '') + '</div>';

    // Position
    html += '<div class="prop-row"><span class="prop-label">Position</span><div class="prop-value"><div class="vec3-input">';
    html += vec3Input("pos", node.position, isLocked);
    html += "</div></div></div>";

    // Rotation (quaternion)
    html += '<div class="prop-row"><span class="prop-label">Rotation</span><div class="prop-value"><div class="vec3-input">';
    html += vec4Input("rot", node.rotation, isLocked);
    html += "</div></div></div>";

    // Scale
    html += '<div class="prop-row"><span class="prop-label">Scale</span><div class="prop-value"><div class="vec3-input">';
    html += vec3Input("scale", node.scale, isLocked);
    html += "</div></div></div>";

    html += "</div>";

    // Visibility
    html += '<div class="prop-group">';
    html += '<div class="prop-group-title">Display</div>';
    html += '<div class="prop-row"><label class="prop-checkbox"><input type="checkbox" id="prop-visible"' + (node.visible ? " checked" : "") + (isModel && !isLocked ? "" : " disabled") + "> Visible</label></div>";
    html += '<div class="prop-row"><label class="prop-checkbox"><input type="checkbox" id="prop-locked"' + (node.locked ? " checked" : "") + (isModel ? "" : " disabled") + "> Locked</label></div>";
    html += "</div>";

    // Delete button for models
    if (isModel) {
      html += '<div class="prop-actions"><button class="btn-duplicate" id="btn-duplicate-node">Duplicate</button><button class="btn-delete" id="btn-delete-node">Delete Model</button></div>';
    }

    propertiesEl.innerHTML = html;

    // Attach change handlers
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

    // Name
    var nameEl = document.getElementById("prop-name");
    if (nameEl && isModel) {
      nameEl.addEventListener("change", function () {
        callInspector("updateNodeProperty", [id, "name", nameEl.value]);
      });
    }

    // Position
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

    // Rotation
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

    // Scale
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

    // Visibility
    var visEl = document.getElementById("prop-visible");
    if (visEl && isModel) {
      visEl.addEventListener("change", function () {
        callInspector("updateNodeProperty", [id, "visible", visEl.checked]);
      });
    }

    // Locked
    var lockEl = document.getElementById("prop-locked");
    if (lockEl && isModel) {
      lockEl.addEventListener("change", function () {
        callInspector("updateNodeProperty", [id, "locked", lockEl.checked]);
      });
    }

    // Delete
    var delBtn = document.getElementById("btn-delete-node");
    if (delBtn) {
      delBtn.addEventListener("click", function () {
        callInspector("removeNode", id);
        selectedId = null;
        setTimeout(refreshSceneTree, 100);
      });
    }

    // Duplicate
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

      // For large files, chunk the base64 into window.__importBuffer to avoid
      // exceeding chrome.devtools.inspectedWindow.eval string limits
      var CHUNK_SIZE = 100000;
      if (base64.length > CHUNK_SIZE) {
        var chunks = Math.ceil(base64.length / CHUNK_SIZE);
        var i = 0;
        function sendChunk() {
          if (i >= chunks) {
            // All chunks sent, call importModel
            callInspector("importModel", ["__importBuffer", file.name]).then(function (res) {
              // Clean up
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
      importStatus.innerHTML = '<p class="error">Import failed: unknown error (result=' + escapeHtml(JSON.stringify(res.result)) + ", err=" + escapeHtml(String(res.err)) + ")</p>";
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

    // Copy JSON
    menu.appendChild(ctxMenuItem("📋", "Copy (JSON)", function () {
      copyNodeJSON(nodeId);
    }));

    menu.appendChild(ctxSeparator());

    // Duplicate (models only)
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

    // Delete
    menu.appendChild(ctxMenuItem("✕", "Delete", function () {
      callInspector("removeNode", nodeId);
      if (selectedId === nodeId) selectedId = null;
      setTimeout(refreshSceneTree, 100);
    }, true));

    document.body.appendChild(menu);
    ctxMenuEl = menu;

    // Close on click elsewhere
    setTimeout(function () {
      document.addEventListener("click", hideContextMenu, { once: true });
    }, 0);
  }

  function ctxMenuItem(icon, label, onClick, isDanger) {
    var item = document.createElement("div");
    item.className = "ctx-menu-item" + (isDanger ? " danger" : "");
    item.innerHTML = '<span class="ctx-icon">' + icon + "</span><span>" + escapeHtml(label) + "</span>";
    item.addEventListener("click", function (e) {
      e.stopPropagation();
      hideContextMenu();
      onClick();
    });
    return item;
  }

  function ctxSeparator() {
    var sep = document.createElement("div");
    sep.className = "ctx-menu-separator";
    return sep;
  }

  function hideContextMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
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
      try {
        document.execCommand("copy");
        importStatus.innerHTML = '<p class="success">Copied: ' + escapeHtml(path) + "</p>";
      } catch (e) {
        importStatus.innerHTML = '<p class="error">Copy failed</p>';
      }
      document.body.removeChild(textarea);
    }));

    menu.appendChild(ctxMenuItem("📥", "Import", function () {
      importFromAssets(path);
    }));

    document.body.appendChild(menu);
    ctxMenuEl = menu;

    setTimeout(function () {
      document.addEventListener("click", hideContextMenu, { once: true });
    }, 0);
  }

  function copyNodeJSON(nodeId) {
    callInspector("getNodeJSON", nodeId).then(function (res) {
      if (res.result) {
        // Use clipboard API via execCommand fallback for DevTools
        var textarea = document.createElement("textarea");
        textarea.value = res.result;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand("copy");
          importStatus.innerHTML = '<p class="success">Copied JSON to clipboard</p>';
        } catch (e) {
          importStatus.innerHTML = '<p class="error">Copy failed</p>';
        }
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
        try {
          availableModels = JSON.parse(result);
          renderAvailableModels();
        } catch (e) {
          console.error("[3D Scene] Parse error scanning models:", e);
        }
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
    if (modelViewMode === "grid") {
      renderAvailableModelsGrid();
    } else {
      renderAvailableModelsTree();
    }
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
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    availableModelsListEl.innerHTML = html;

    var items = availableModelsListEl.querySelectorAll(".model-grid-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function () {
        var path = this.getAttribute("data-path");
        importFromAssets(path);
      });
      items[j].addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var path = this.getAttribute("data-path");
        showModelContextMenu(e.clientX, e.clientY, path);
      });
    }

    var thumbQueue = [];
    for (var k = 0; k < filtered.length; k++) {
      if (!modelThumbnails[filtered[k].path]) {
        thumbQueue.push({ idx: k, path: filtered[k].path });
      }
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
        if (res.result) {
          thumbEl.innerHTML = '<img src="' + res.result + '">';
        } else {
          thumbEl.innerHTML = '<span class="thumb-placeholder">\u{1F4E6}</span>';
        }
      }
      if (queue.length > 0) {
        setTimeout(function () { processThumbQueue(queue); }, 16);
      }
    });
  }

  function renderAvailableModelsTree() {
    var filtered = getFilteredModels();
    if (filtered.length === 0) {
      availableModelsListEl.innerHTML = '<p class="empty-state" style="padding:4px">No models match "' + escapeHtml(modelSearchQuery) + '"</p>';
      return;
    }
    var tree = buildModelTree(filtered);
    var html = '<div class="model-tree">';
    html += renderTreeNodes(tree, 0);
    html += '</div>';
    availableModelsListEl.innerHTML = html;

    var folders = availableModelsListEl.querySelectorAll(".tree-folder");
    for (var i = 0; i < folders.length; i++) {
      folders[i].addEventListener("click", function (e) {
        e.stopPropagation();
        this.classList.toggle("collapsed");
        var next = this.nextElementSibling;
        if (next && next.classList.contains("tree-children")) {
          next.classList.toggle("collapsed");
        }
      });
    }

    var files = availableModelsListEl.querySelectorAll(".tree-file");
    for (var j = 0; j < files.length; j++) {
      files[j].addEventListener("click", function (e) {
        e.stopPropagation();
        var path = this.getAttribute("data-path");
        importFromAssets(path);
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
      html += '<div class="tree-node">';
      html += '<div class="tree-folder">';
      html += '<span class="tree-arrow">\u25BC</span>';
      html += '<span class="tree-icon">\u{1F4C1}</span>';
      html += '<span class="tree-name">' + escapeHtml(key) + '</span>';
      html += '<span style="color:#666;font-size:9px">(' + fileCount + ')</span>';
      html += '</div>';
      html += '<div class="tree-children">';
      html += renderTreeNodes(child, depth + 1);
      html += '</div>';
      html += '</div>';
    }
    var files = node.files.sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      html += '<div class="tree-file" data-path="' + escapeHtml(f.path) + '">';
      html += '<span class="tree-file-format">' + escapeHtml(f.format) + '</span>';
      html += '<span class="tree-file-name">' + escapeHtml(f.name) + '</span>';
      html += '<span class="tree-file-add">+</span>';
      html += '</div>';
    }
    return html;
  }

  function countFiles(node) {
    var count = node.files.length;
    var keys = Object.keys(node.folders);
    for (var i = 0; i < keys.length; i++) {
      count += countFiles(node.folders[keys[i]]);
    }
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

  // --- Overlay toggles (checkboxes in dropdown menu) ---
  function saveOverlayState() {
    try {
      localStorage.setItem("devtools-overlays", JSON.stringify({
        labels: labelsVisible,
        hitboxes: hitboxesVisible,
        chunkGrid: chunkGridVisible,
        velArrows: velArrowsVisible,
      }));
    } catch (e) {}
  }

  function loadOverlayState() {
    try {
      var s = JSON.parse(localStorage.getItem("devtools-overlays") || "{}");
      if (typeof s.labels === "boolean") labelsVisible = s.labels;
      if (typeof s.hitboxes === "boolean") hitboxesVisible = s.hitboxes;
      if (typeof s.chunkGrid === "boolean") chunkGridVisible = s.chunkGrid;
      if (typeof s.velArrows === "boolean") velArrowsVisible = s.velArrows;
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

  chkChunkGrid.addEventListener("change", function () {
    chunkGridVisible = chkChunkGrid.checked;
    callInspector("setShowChunkGrid", chunkGridVisible);
    saveOverlayState();
  });

  chkVelArrows.addEventListener("change", function () {
    velArrowsVisible = chkVelArrows.checked;
    callInspector("setShowVelocityArrows", velArrowsVisible);
    saveOverlayState();
  });

  // Overlays menu dropdown toggle
  btnOverlaysMenu.addEventListener("click", function (e) {
    e.stopPropagation();
    overlaysMenuEl.style.display = overlaysMenuEl.style.display === "none" ? "flex" : "none";
  });
  document.addEventListener("click", function () {
    overlaysMenuEl.style.display = "none";
  });
  overlaysMenuEl.addEventListener("click", function (e) { e.stopPropagation(); });

  filterModelsEl.addEventListener("change", function () {
    filterModels = filterModelsEl.checked;
    renderSceneTree();
  });

  filterEntitiesEl.addEventListener("change", function () {
    filterEntities = filterEntitiesEl.checked;
    renderSceneTree();
  });

  // File input
  fileInput.addEventListener("change", function (e) {
    var files = e.target.files;
    for (var i = 0; i < files.length; i++) {
      handleFile(files[i]);
    }
    fileInput.value = "";
  });

  // Drag and drop
  dropZone.addEventListener("click", function () {
    fileInput.click();
  });

  dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    var files = e.dataTransfer.files;
    for (var i = 0; i < files.length; i++) {
      handleFile(files[i]);
    }
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT") return;
    switch (e.key.toLowerCase()) {
      case "w": setGizmoMode("translate"); break;
      case "e": setGizmoMode("rotate"); break;
      case "r": setGizmoMode("scale"); break;
      case "f5": e.preventDefault(); refreshSceneTree(); break;
    }
  });

  // --- Init ---
  function start() {
    refreshSceneTree();
    scanAvailableModels();
    // Load saved overlay state and apply
    loadOverlayState();
    chkLabels.checked = labelsVisible;
    chkHitboxes.checked = hitboxesVisible;
    chkChunkGrid.checked = chunkGridVisible;
    chkVelArrows.checked = velArrowsVisible;
    callInspector("setShowLabels", labelsVisible);
    callInspector("setShowHitboxes", hitboxesVisible);
    callInspector("setShowChunkGrid", chunkGridVisible);
    callInspector("setShowVelocityArrows", velArrowsVisible);
    // Auto-refresh every 500ms
    refreshTimer = setInterval(refreshSceneTree, 500);
    // Auto-open debug info view on startup
    switchView("debug");
  }

  // Check if inspector is ready, then start
  function waitForInspector() {
    getSceneInspector().then(function (inspector) {
      if (inspector) {
        start();
      } else {
        setTimeout(waitForInspector, 1000);
      }
    });
  }

  waitForInspector();

  // Cleanup on unload
  window.addEventListener("beforeunload", function () {
    if (refreshTimer) clearInterval(refreshTimer);
    if (debugInfoTimer) clearInterval(debugInfoTimer);
    if (boatRefreshTimer) clearInterval(boatRefreshTimer);
  });

  // --- Boat Layout ---
  var boatLayoutData = null;
  var boatRefreshTimer = null;
  var selectedBoatIdx = 0;
  var btnBoatLayout = document.getElementById("btn-boat-layout");
  var boatLayoutPanel = document.getElementById("boat-layout-panel");
  var boatSelect = document.getElementById("boat-select");
  var boatLayersEl = document.getElementById("boat-layers");
  var boatTooltipEl = document.getElementById("boat-cell-tooltip");
  var boatLayerHitData = {};

  // Cell type constants (mirror BoatCellType from constants.ts)
  var CELL_HULL = 0, CELL_BOW = 1, CELL_CABIN = 2, CELL_MAST = 3, CELL_DECK = 4,
      CELL_RAIL = 5, CELL_WALL = 6, CELL_HULL_CURVE_L = 7, CELL_HULL_CURVE_R = 8,
      CELL_BOW_MODERN = 9, CELL_STERN = 10, CELL_PONTOON = 11, CELL_BRIDGE = 12, CELL_HELM = 13;

  var CELL_NAMES = {
    0: "HULL", 1: "BOW", 2: "CABIN", 3: "MAST", 4: "DECK",
    5: "RAIL", 6: "WALL", 7: "CURVE_L", 8: "CURVE_R", 9: "BOW_MOD",
    10: "STERN", 11: "PONTOON", 12: "BRIDGE", 13: "HELM",
  };

  var CELL_COLORS_CSS = {
    0: "#735a3f", 1: "#8c6647", 2: "#997a4d", 3: "#594026",
    4: "#806138", 5: "#664d33", 6: "#805933", 7: "#6b5238",
    8: "#6b5238", 9: "#806140", 10: "#7a5c3d", 11: "#594d47",
    12: "#806138", 13: "#8c734d",
  };

  var CELL_HEIGHTS = {
    0: { y0: -0.3, y1: 0.9 }, 1: { y0: -0.3, y1: 0.9 }, 9: { y0: -0.3, y1: 0.9 },
    7: { y0: -0.3, y1: 0.9 }, 8: { y0: -0.3, y1: 0.9 }, 10: { y0: -0.3, y1: 0.9 },
    11: { y0: -0.3, y1: 0.5 }, 6: { y0: -0.1, y1: 0.6 }, 2: { y0: 0.1, y1: 0.35 },
    3: { y0: -0.1, y1: 2.0 }, 13: { y0: -0.1, y1: 0.4 }, 5: { y0: -0.1, y1: 0.35 },
    4: { y0: 0.1, y1: 0.1 }, 12: { y0: -0.05, y1: 0.05 },
  };

  var CELL_SIZE = 2;
  var LAYER_HEIGHT = 1.0;

  function getCellShape2D(gridX, gridZ, type, rotation) {
    var s = CELL_SIZE / 2;
    var cx = gridX * CELL_SIZE;
    var cz = gridZ * CELL_SIZE;
    var x0 = cx - s, x1 = cx + s;
    var z0 = cz - s, z1 = cz + s;
    var rot = rotation % 4;
    var shape;

    switch (type) {
      case CELL_BOW:
      case CELL_BOW_MODERN:
        shape = {
          polygon: [[cx, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: 2, p0: 1, p1: 2 }, { dir: -1, p0: 2, p1: 0 }],
        };
        break;
      case CELL_HULL_CURVE_L:
        shape = {
          polygon: [[cx, z0], [x1, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: 1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: -1, p0: 3, p1: 0 }],
        };
        break;
      case CELL_HULL_CURVE_R:
        shape = {
          polygon: [[x0, z0], [cx, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: -1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: 3, p0: 3, p1: 0 }],
        };
        break;
      default:
        shape = {
          polygon: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: 0, p0: 0, p1: 1 }, { dir: 1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: 3, p0: 3, p1: 0 }],
        };
        break;
    }

    if (rot > 0) {
      var angle = rot * Math.PI / 2;
      var cosA = Math.cos(angle);
      var sinA = Math.sin(angle);
      shape = {
        polygon: shape.polygon.map(function (p) {
          return [
            cx + (p[0] - cx) * cosA - (p[1] - cz) * sinA,
            cz + (p[0] - cx) * sinA + (p[1] - cz) * cosA,
          ];
        }),
        edges: shape.edges.map(function (e) {
          return { dir: e.dir >= 0 ? (e.dir + rot) % 4 : -1, p0: e.p0, p1: e.p1 };
        }),
      };
    }
    return shape;
  }

  function fetchBoatLayout() {
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getBoatLayout()) : null",
      function (result, err) {
        if (err || !result) {
          boatLayoutData = null;
          return;
        }
        try {
          boatLayoutData = JSON.parse(result);
          renderBoatLayout();
        } catch (e) {
          console.error("[Boat Layout] Parse error:", e);
        }
      },
    );
  }

  function renderBoatLayout() {
    if (!boatLayoutData || !boatLayoutData.boats || boatLayoutData.boats.length === 0) {
      boatLayersEl.innerHTML = '<p class="empty-state">No boats found</p>';
      boatSelect.innerHTML = "";
      clearOrthos();
      return;
    }

    // Populate boat selector
    var opts = "";
    for (var i = 0; i < boatLayoutData.boats.length; i++) {
      opts += '<option value="' + i + '">Boat #' + boatLayoutData.boats[i].entityId + "</option>";
    }
    boatSelect.innerHTML = opts;
    if (selectedBoatIdx >= boatLayoutData.boats.length) selectedBoatIdx = 0;
    boatSelect.value = String(selectedBoatIdx);

    var boat = boatLayoutData.boats[selectedBoatIdx];
    if (!boat) return;

    // Group cells by layer (gridY)
    var layers = {};
    var minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
    for (var i = 0; i < boat.cells.length; i++) {
      var c = boat.cells[i];
      var key = c.gridY;
      if (!layers[key]) layers[key] = [];
      layers[key].push(c);
      if (c.gridX < minX) minX = c.gridX;
      if (c.gridX > maxX) maxX = c.gridX;
      if (c.gridZ < minZ) minZ = c.gridZ;
      if (c.gridZ > maxZ) maxZ = c.gridZ;
    }

    var layerKeys = Object.keys(layers).sort(function (a, b) { return Number(a) - Number(b); });

    // Render each layer as a canvas
    var html = "";
    for (var li = 0; li < layerKeys.length; li++) {
      var yk = layerKeys[li];
      html += '<div class="boat-layer-card">';
      html += '<h4>Layer Y=' + yk + ' (' + layers[yk].length + ' cells)</h4>';
      html += '<canvas id="boat-layer-' + yk + '" width="220" height="280"></canvas>';
      html += '</div>';
    }
    boatLayersEl.innerHTML = html;

    var scale = 18;
    var padX = 20, padZ = 20;
    var gridW = (maxX - minX + 1) * CELL_SIZE;
    var gridH = (maxZ - minZ + 1) * CELL_SIZE;

    boatLayerHitData = {};

    for (var li2 = 0; li2 < layerKeys.length; li2++) {
      var yk2 = layerKeys[li2];
      var canvas = document.getElementById("boat-layer-" + yk2);
      if (!canvas) continue;
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Auto-fit
      var sx = (canvas.width - padX * 2) / gridW;
      var sz = (canvas.height - padZ * 2) / gridH;
      var sc = Math.min(sx, sz, scale);

      var cells = layers[yk2];
      // Build cell map for neighbor culling
      var cellMap = {};
      for (var ci = 0; ci < cells.length; ci++) {
        cellMap[cells[ci].gridX + "," + cells[ci].gridY + "," + cells[ci].gridZ] = cells[ci];
      }

      var hitPolygons = [];

      for (var ci2 = 0; ci2 < cells.length; ci2++) {
        var cell = cells[ci2];
        var shape = getCellShape2D(cell.gridX, cell.gridZ, cell.type, cell.rotation);
        var color = CELL_COLORS_CSS[cell.type] || "#888";

        ctx.fillStyle = color;
        ctx.strokeStyle = "#222";
        ctx.lineWidth = 1;

        // Draw polygon
        var screenPoly = [];
        ctx.beginPath();
        for (var pi = 0; pi < shape.polygon.length; pi++) {
          var px = shape.polygon[pi][0];
          var pz = shape.polygon[pi][1];
          var cx2 = padX + (px - minX * CELL_SIZE) * sc;
          var cz2 = padZ + (pz - minZ * CELL_SIZE) * sc;
          screenPoly.push([cx2, cz2]);
          if (pi === 0) ctx.moveTo(cx2, cz2);
          else ctx.lineTo(cx2, cz2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        hitPolygons.push({ poly: screenPoly, cell: cell });

        // Label
        var labelX = padX + (cell.gridX * CELL_SIZE - minX * CELL_SIZE) * sc + CELL_SIZE * sc / 2;
        var labelZ = padZ + (cell.gridZ * CELL_SIZE - minZ * CELL_SIZE) * sc + CELL_SIZE * sc / 2;
        ctx.fillStyle = "#fff";
        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.fillText(CELL_NAMES[cell.type] || "?", labelX, labelZ);
      }

      // Draw axis indicators
      ctx.fillStyle = "#666";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Z+ (back)", 4, canvas.height - 4);
      ctx.textAlign = "right";
      ctx.fillText("X+ (right)", canvas.width - 4, canvas.height - 4);

      boatLayerHitData["boat-layer-" + yk2] = hitPolygons;
      attachCanvasTooltip(canvas, hitPolygons);
    }

    // Draw orthographic projections
    drawOrthos(boat.cells, minX, maxX, minZ, maxZ);
  }

  function pointInPolygon(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1];
      var xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function attachCanvasTooltip(canvas, hitPolygons) {
    canvas.addEventListener("mousemove", function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var found = null;
      for (var i = 0; i < hitPolygons.length; i++) {
        if (pointInPolygon(mx, my, hitPolygons[i].poly)) {
          found = hitPolygons[i].cell;
          break;
        }
      }
      if (found) {
        var cellName = CELL_NAMES[found.type] || "UNKNOWN";
        var rotNames = ["0°", "90°", "180°", "270°"];
        var rotStr = rotNames[found.rotation % 4] || (found.rotation + "°");
        var html = '<div class="tooltip-title">' + escapeHtml(cellName) + '</div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Type</span><span class="tooltip-value">' + found.type + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Rotation</span><span class="tooltip-value">' + rotStr + ' (' + found.rotation + ')</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Grid X</span><span class="tooltip-value">' + found.gridX + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Grid Y</span><span class="tooltip-value">' + found.gridY + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Grid Z</span><span class="tooltip-value">' + found.gridZ + '</span></div>';
        boatTooltipEl.innerHTML = html;
        boatTooltipEl.style.display = "block";
        boatTooltipEl.style.left = (e.clientX + 14) + "px";
        boatTooltipEl.style.top = (e.clientY + 14) + "px";
      } else {
        boatTooltipEl.style.display = "none";
      }
    });
    canvas.addEventListener("mouseleave", function () {
      boatTooltipEl.style.display = "none";
    });
  }

  function clearOrthos() {
    ["boat-side", "boat-front", "boat-top"].forEach(function (id) {
      var c = document.getElementById(id);
      if (c) {
        var ctx = c.getContext("2d");
        ctx.clearRect(0, 0, c.width, c.height);
      }
    });
  }

  function drawOrthos(cells, minX, maxX, minZ, maxZ) {
    var sideCanvas = document.getElementById("boat-side");
    var frontCanvas = document.getElementById("boat-front");
    var topCanvas = document.getElementById("boat-top");

    // Compute world bounds
    var worldMinX = minX * CELL_SIZE - CELL_SIZE;
    var worldMaxX = (maxX + 1) * CELL_SIZE;
    var worldMinZ = minZ * CELL_SIZE - CELL_SIZE;
    var worldMaxZ = (maxZ + 1) * CELL_SIZE;

    // Compute Y bounds from CELL_HEIGHTS
    var worldMinY = Infinity, worldMaxY = -Infinity;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var h = CELL_HEIGHTS[c.type] || { y0: -0.3, y1: 0.9 };
      var y0 = c.gridY * LAYER_HEIGHT + h.y0;
      var y1 = c.gridY * LAYER_HEIGHT + h.y1;
      if (y0 < worldMinY) worldMinY = y0;
      if (y1 > worldMaxY) worldMaxY = y1;
    }

    // Side view (X-Y): shows beam width and height profile
    drawOrtho(sideCanvas, cells, function (c) { return c.gridX * CELL_SIZE; }, function (c) {
      var h = CELL_HEIGHTS[c.type] || { y0: -0.3, y1: 0.9 };
      return [c.gridY * LAYER_HEIGHT + h.y0, c.gridY * LAYER_HEIGHT + h.y1];
    }, worldMinX, worldMaxX, worldMinY, worldMaxY, "X", "Y");

    // Front view (Z-Y): shows length and height profile
    drawOrtho(frontCanvas, cells, function (c) { return c.gridZ * CELL_SIZE; }, function (c) {
      var h = CELL_HEIGHTS[c.type] || { y0: -0.3, y1: 0.9 };
      return [c.gridY * LAYER_HEIGHT + h.y0, c.gridY * LAYER_HEIGHT + h.y1];
    }, worldMinZ, worldMaxZ, worldMinY, worldMaxY, "Z", "Y");

    // Top view (X-Z): shows deck plan
    drawOrthoTop(topCanvas, cells, worldMinX, worldMaxX, worldMinZ, worldMaxZ);
  }

  function drawOrtho(canvas, cells, horizFn, yFn, hMin, hMax, vMin, vMax, hLabel, vLabel) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var pad = 20;
    var sc = Math.min((canvas.width - pad * 2) / (hMax - hMin), (canvas.height - pad * 2) / (vMax - vMin));

    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var hPos = horizFn(c);
      var yRange = yFn(c);
      var color = CELL_COLORS_CSS[c.type] || "#888";

      var x = pad + (hPos - hMin) * sc;
      var w = CELL_SIZE * sc;
      var y0 = canvas.height - pad - (yRange[0] - vMin) * sc;
      var y1 = canvas.height - pad - (yRange[1] - vMin) * sc;

      ctx.fillStyle = color;
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 0.5;
      ctx.fillRect(x, y1, w, y0 - y1);
      ctx.strokeRect(x, y1, w, y0 - y1);
    }

    ctx.fillStyle = "#666";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(hLabel + " →", 4, canvas.height - 4);
    ctx.fillText(vLabel + " ↑", 4, 12);
  }

  function drawOrthoTop(canvas, cells, xMin, xMax, zMin, zMax) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var pad = 20;
    var sx = (canvas.width - pad * 2) / (xMax - xMin);
    var sz = (canvas.height - pad * 2) / (zMax - zMin);
    var sc = Math.min(sx, sz);

    // Build cell map for neighbor culling
    var cellMap = {};
    for (var i = 0; i < cells.length; i++) {
      cellMap[cells[i].gridX + "," + cells[i].gridY + "," + cells[i].gridZ] = cells[i];
    }

    for (var i2 = 0; i2 < cells.length; i2++) {
      var c = cells[i2];
      var shape = getCellShape2D(c.gridX, c.gridZ, c.type, c.rotation);
      var color = CELL_COLORS_CSS[c.type] || "#888";

      ctx.fillStyle = color;
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 0.5;

      ctx.beginPath();
      for (var pi = 0; pi < shape.polygon.length; pi++) {
        var px = pad + (shape.polygon[pi][0] - xMin) * sc;
        var pz = pad + (shape.polygon[pi][1] - zMin) * sc;
        if (pi === 0) ctx.moveTo(px, pz);
        else ctx.lineTo(px, pz);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.fillStyle = "#666";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("X →, Z ↓", 4, canvas.height - 4);
  }

  function toggleBoatLayout() {
    if (currentView === "boat") {
      switchView("scene");
    } else {
      switchView("boat");
    }
  }

  btnBoatLayout.addEventListener("click", toggleBoatLayout);
  boatSelect.addEventListener("change", function () {
    selectedBoatIdx = parseInt(boatSelect.value, 10) || 0;
    renderBoatLayout();
  });

  // --- View Tab Switching ---
  var btnViewScene = document.getElementById("btn-view-scene");
  var btnViewImport = document.getElementById("btn-view-import");
  var importPanel = document.getElementById("import-panel");
  var btnViewWorld = document.getElementById("btn-view-world");
  var worldPanel = document.getElementById("world-panel");
  var worldRefreshTimer = null;
  var mainContentEl = document.getElementById("main-content");
  var debugInfoTimer = null;
  var btnDebugInfo = document.getElementById("btn-debug-info");
  var debugInfoPanel = document.getElementById("debug-info-panel");
  var rendererStatsEl = document.getElementById("renderer-stats");
  var simStateEl = document.getElementById("sim-state");
  var physicsStatsEl = document.getElementById("physics-stats");
  var playerStatsEl = document.getElementById("player-stats");
  var btnViewPerf = document.getElementById("btn-view-perf");
  var perfPanel = document.getElementById("perf-panel");
  var perfStatusEl = document.getElementById("perf-status");
  var perfTimer = null;
  var perfHistory = { gpu: [], renderer: [], main: [], worker: [] };
  var PERF_MAX_POINTS = 60;

  function switchView(view) {
    currentView = view;
    // Update tab button states
    btnViewScene.classList.toggle("active", view === "scene");
    btnDebugInfo.classList.toggle("active", view === "debug");
    btnBoatLayout.classList.toggle("active", view === "boat");
    btnViewImport.classList.toggle("active", view === "import");
    btnViewWorld.classList.toggle("active", view === "world");
    btnViewPerf.classList.toggle("active", view === "perf");
    // Show/hide scene toolbar (only for scene tab)
    sceneToolbarEl.classList.toggle("hidden", view !== "scene");
    // Show/hide panels
    mainContentEl.style.display = view === "scene" ? "flex" : "none";
    debugInfoPanel.style.display = view === "debug" ? "block" : "none";
    boatLayoutPanel.style.display = view === "boat" ? "flex" : "none";
    importPanel.style.display = view === "import" ? "block" : "none";
    worldPanel.style.display = view === "world" ? "block" : "none";
    perfPanel.style.display = view === "perf" ? "block" : "none";
    // Manage timers
    if (view === "debug") {
      refreshDebugInfo();
      if (!debugInfoTimer) debugInfoTimer = setInterval(refreshDebugInfo, 500);
    } else {
      if (debugInfoTimer) { clearInterval(debugInfoTimer); debugInfoTimer = null; }
    }
    if (view === "boat") {
      fetchBoatLayout();
      if (!boatRefreshTimer) boatRefreshTimer = setInterval(fetchBoatLayout, 1000);
    } else {
      if (boatRefreshTimer) { clearInterval(boatRefreshTimer); boatRefreshTimer = null; }
    }
    if (view === "world") {
      refreshWorldPanel();
      if (!worldRefreshTimer) worldRefreshTimer = setInterval(refreshWorldPanel, 1000);
    } else {
      if (worldRefreshTimer) { clearInterval(worldRefreshTimer); worldRefreshTimer = null; }
    }
    if (view === "import" && availableModels.length === 0) {
      scanAvailableModels();
    }
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
  }

  btnViewScene.addEventListener("click", function () { switchView("scene"); });
  btnViewImport.addEventListener("click", function () {
    if (currentView === "import") { switchView("scene"); } else { switchView("import"); }
  });
  btnViewWorld.addEventListener("click", function () {
    if (currentView === "world") { switchView("scene"); } else { switchView("world"); }
  });
  btnDebugInfo.addEventListener("click", function () {
    if (currentView === "debug") { switchView("scene"); } else { switchView("debug"); }
  });
  btnViewPerf.addEventListener("click", function () {
    if (currentView === "perf") { switchView("scene"); } else { switchView("perf"); }
  });

  // --- Toggles (scene overlays, not view tabs) ---

  function fmtVal(v, decimals) {
    if (typeof v === "number") {
      return v.toFixed(decimals || 2);
    }
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

  var CAMERA_MODES = { 0: "FirstPerson", 1: "ThirdPerson", 2: "FreeCam" };

  function refreshDebugInfo() {
    // Renderer stats
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getRendererStats()) : null",
      function (result, err) {
        if (err || !result) {
          rendererStatsEl.innerHTML = '<div class="debug-label">Not available</div>';
          return;
        }
        try {
          var s = JSON.parse(result);
          if (!s) {
            rendererStatsEl.innerHTML = '<div class="debug-label">Not available</div>';
            return;
          }
          var rows = [
            ["FPS", fmtVal(s.fps, 0)],
            ["Tick", s.tick],
            ["Entities", s.entityCount],
            ["Players", s.playerCount],
            ["Canvas", s.canvasW + "x" + s.canvasH],
            ["Viewport", s.viewportW + "x" + s.viewportH],
            ["Water Valid", s.waterValid ? "Yes" : "No"],
            ["Water Grid", s.waterGrid],
            ["Player Pos", fmtVec3(s.playerPos, 1)],
            ["Heading", fmtVal(s.heading, 2)],
            ["Pitch", fmtVal(s.pitch, 2)],
            ["Camera Mode", CAMERA_MODES[s.cameraMode] || s.cameraMode],
            ["Keys", s.keys || "—"],
          ];
          rendererStatsEl.innerHTML = debugGridHtml(rows);
        } catch (e) {
          rendererStatsEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>';
        }
      },
    );

    // Sim state
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getSimState()) : null",
      function (result, err) {
        if (err || !result) {
          simStateEl.innerHTML = '<div class="debug-label">Not available</div>';
          return;
        }
        try {
          var s = JSON.parse(result);
          if (!s) {
            simStateEl.innerHTML = '<div class="debug-label">Not available</div>';
            return;
          }
          var rows = [
            ["Tick", s.tick],
            ["Time of Day", s.timeStr + " (" + fmtVal(s.timeOfDay, 3) + ")"],
            ["Weather", s.weatherName + " (" + fmtVal(s.weatherIntensity, 2) + ")"],
            ["Wind Speed", fmtVal(s.windSpeed, 1) + " m/s"],
            ["Wind Dir", "(" + fmtVal(s.windDirX, 2) + ", " + fmtVal(s.windDirZ, 2) + ")"],
            ["Visibility", fmtVal(s.visibility, 1)],
            ["Ambient Temp", fmtVal(s.ambientTemp, 1) + "°C"],
            ["Active Players", "0x" + s.activePlayers.toString(16)],
            ["Gamemode", s.gamemode],
            ["Entity Count", s.entityCount],
            ["Player Count", s.playerCount],
            ["Chunk Count", s.chunkCount],
          ];
          simStateEl.innerHTML = debugGridHtml(rows);
        } catch (e) {
          simStateEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>';
        }
      },
    );

    // Physics stats
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getPhysicsStats()) : null",
      function (result, err) {
        if (err || !result) {
          physicsStatsEl.innerHTML = '<div class="debug-label">Not available</div>';
          return;
        }
        try {
          var s = JSON.parse(result);
          if (!s) {
            physicsStatsEl.innerHTML = '<div class="debug-label">Not available</div>';
            return;
          }
          var rows = [
            ["Initialized", s.initialized ? "Yes" : "No"],
            ["Failed", s.failed ? "Yes" : "No"],
            ["Body Count", s.bodyCount],
            ["Physics Tick", s.tickCount],
          ];
          physicsStatsEl.innerHTML = debugGridHtml(rows);
        } catch (e) {
          physicsStatsEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>';
        }
      },
    );

    // Player stats — rendered as editable property graph
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getPlayerStats()) : null",
      function (result, err) {
        if (err || !result) {
          playerStatsEl.innerHTML = '<p class="empty-state">Not available</p>';
          return;
        }
        try {
          var s = JSON.parse(result);
          if (!s || !s.players || s.players.length === 0) {
            playerStatsEl.innerHTML = '<p class="empty-state">No players</p>';
            return;
          }
          var html = "";
          for (var i = 0; i < s.players.length; i++) {
            var p = s.players[i];
            html += '<div class="player-card">';
            html += '<div class="player-card-header">Player #' + p.playerId + ' (slot ' + p.slot + ')</div>';

            // Readonly properties
            html += '<div class="prop-group">';
            html += '<div class="prop-group-title">Identity (read-only)</div>';
            html += '<div class="prop-row"><span class="prop-label">Entity ID</span><div class="prop-value" style="color:#dcdcaa;font-family:monospace;">' + p.entityId + '</div></div>';
            html += '<div class="prop-row"><span class="prop-label">Slot</span><div class="prop-value" style="color:#dcdcaa;font-family:monospace;">' + p.slot + '</div></div>';
            html += '<div class="prop-row"><span class="prop-label">Player ID</span><div class="prop-value" style="color:#dcdcaa;font-family:monospace;">' + p.playerId + '</div></div>';
            html += '<div class="prop-row"><span class="prop-label">Flags</span><div class="prop-value" style="color:#dcdcaa;font-family:monospace;">0x' + p.flags.toString(16) + '</div></div>';
            html += '<div class="prop-row"><span class="prop-label">Camera</span><div class="prop-value" style="color:#dcdcaa;font-family:monospace;">' + escapeHtml(CAMERA_MODES[p.cameraMode] || p.cameraMode) + '</div></div>';
            html += '</div>';

            // Position (read-only, sim-controlled)
            html += '<div class="prop-group">';
            html += '<div class="prop-group-title">Position <span style="color:#888;font-size:9px">(sim-controlled)</span></div>';
            html += '<div class="prop-row"><span class="prop-label">Pos</span><div class="prop-value"><div class="vec3-input">';
            html += '<span class="axis-label">X</span><input type="number" step="0.1" value="' + p.position[0].toFixed(1) + '" disabled>';
            html += '<span class="axis-label">Y</span><input type="number" step="0.1" value="' + p.position[1].toFixed(1) + '" disabled>';
            html += '<span class="axis-label">Z</span><input type="number" step="0.1" value="' + p.position[2].toFixed(1) + '" disabled>';
            html += '</div></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Heading</span><div class="prop-value"><input type="number" step="0.01" value="' + p.heading.toFixed(2) + '" disabled style="width:60px;"></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Pitch</span><div class="prop-value"><input type="number" step="0.01" value="' + p.pitch.toFixed(2) + '" disabled style="width:60px;"></div></div>';
            html += '</div>';

            // Vitals (editable display)
            html += '<div class="prop-group">';
            html += '<div class="prop-group-title">Vitals</div>';
            html += '<div class="prop-row"><span class="prop-label">Health</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-health" value="' + p.health.toFixed(1) + '" style="width:50px;"> <span style="color:#666;font-size:10px">/ ' + p.maxHealth.toFixed(1) + '</span></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Hunger</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-hunger" value="' + p.hunger.toFixed(1) + '" style="width:50px;"></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Thirst</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-thirst" value="' + p.thirst.toFixed(1) + '" style="width:50px;"></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Oxygen</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-oxygen" value="' + p.oxygen.toFixed(1) + '" style="width:50px;"> <span style="color:#666;font-size:10px">/ ' + p.maxOxygen.toFixed(1) + '</span></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Temp</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-temp" value="' + p.temperature.toFixed(1) + '" style="width:50px;"> <span style="color:#666;font-size:10px">°C</span></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Gold</span><div class="prop-value"><input type="number" step="1" id="plr-' + i + '-gold" value="' + p.gold.toFixed(0) + '" style="width:60px;"></div></div>';
            html += '</div>';

            // Flags as badges
            if (p.flagNames && p.flagNames.length > 0) {
              html += '<div class="player-flags">';
              for (var fi = 0; fi < p.flagNames.length; fi++) {
                var badgeClass = p.flagNames[fi] === "DEAD" ? "" : "safe";
                html += '<span class="player-flag-badge ' + badgeClass + '">' + escapeHtml(p.flagNames[fi]) + '</span>';
              }
              html += '</div>';
            }
            html += '</div>';
          }
          playerStatsEl.innerHTML = html;
        } catch (e) {
          playerStatsEl.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(String(e)) + '</p>';
        }
      },
    );
  }

  // --- Entity Sim Data in Properties Panel ---
  var entitySimDataTimer = null;

  function maybeAddEntitySimData() {
    if (!selectedId || !selectedId.startsWith("entity-")) {
      if (entitySimDataTimer) {
        clearInterval(entitySimDataTimer);
        entitySimDataTimer = null;
      }
      return;
    }
    var entityId = parseInt(selectedId.replace("entity-", ""), 10);
    if (isNaN(entityId)) return;

    // Fetch immediately, then set up polling
    fetchAndRenderEntitySimData(entityId);
    if (entitySimDataTimer) clearInterval(entitySimDataTimer);
    entitySimDataTimer = setInterval(function () {
      fetchAndRenderEntitySimData(entityId);
    }, 500);
  }

  function fetchAndRenderEntitySimData(entityId) {
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getEntitySimData(" + entityId + ")) : null",
      function (result, err) {
        if (err || !result) return;
        try {
          var s = JSON.parse(result);
          if (!s) return;
          renderEntitySimData(s);
        } catch (e) {
          // ignore parse errors
        }
      },
    );
  }

  function renderEntitySimData(s) {
    var existing = document.getElementById("entity-sim-data");
    if (existing) existing.remove();

    var html = '<div class="prop-group" id="entity-sim-data">';
    html += '<div class="prop-group-title">Sim Data (read-only)</div>';

    var rows = [
      ["Type", s.typeName + " (" + s.type + ")"],
      ["Velocity", fmtVec3(s.velocity, 2)],
      ["Angular Vel", fmtVec3(s.angularVelocity, 2)],
      ["Health", fmtVal(s.health, 1) + "/" + fmtVal(s.maxHealth, 1)],
      ["Flags", "0x" + s.flags.toString(16)],
      ["Parent ID", s.parentId || "—"],
      ["Chunk", s.chunkX + ", " + s.chunkZ],
    ];
    for (var i = 0; i < s.data.length; i++) {
      rows.push(["data[" + i + "]", fmtVal(s.data[i], 3)]);
    }

    html += '<div style="font-size:11px;">';
    for (var ri = 0; ri < rows.length; ri++) {
      html += '<div class="prop-row"><span class="prop-label">' + escapeHtml(rows[ri][0]) + '</span>';
      html += '<div class="prop-value" style="color:#dcdcaa;font-family:monospace;">' + escapeHtml(rows[ri][1]) + '</div></div>';
    }
    html += '</div>';
    html += '</div>';

    propertiesEl.insertAdjacentHTML("beforeend", html);
  }

  // Override renderPropertiesForId to also trigger sim data loading
  var origRenderPropertiesForId = renderPropertiesForId;
  renderPropertiesForId = function (id) {
    origRenderPropertiesForId(id);
    maybeAddEntitySimData();
  };

  // --- World Panel ---

  var biomeNames = [
    "Lake", "Arctic", "Desert", "Boreal Forest", "Tropical", "Sub-Tropical",
    "Freshwater", "Ocean", "Deep Ocean", "Coral Reef", "Kelp Forest",
    "Volcanic", "Garbage Patch", "Hell",
  ];

  var portSizeNames = ["Small", "Medium", "Large"];
  var islandSizeNames = ["Small", "Medium", "Large"];

  // Populate biome select
  var worldBiomeSelect = document.getElementById("world-biome-select");
  if (worldBiomeSelect) {
    for (var bi = 0; bi < biomeNames.length; bi++) {
      var opt = document.createElement("option");
      opt.value = String(bi);
      opt.textContent = biomeNames[bi];
      worldBiomeSelect.appendChild(opt);
    }
  }

  function refreshWorldPanel() {
    var playerPos = { worldX: 0, worldZ: 0, chunkX: 0, chunkZ: 0 };

    // Fetch player position first, then use it for sorting
    callInspector("getPlayerChunk").then(function (res) {
      if (res.err || !res.result) return;
      playerPos = res.result;
      var infoEl = document.getElementById("world-player-info");
      if (infoEl) {
        infoEl.innerHTML = debugGridHtml([
          ["World Pos", "(" + playerPos.worldX.toFixed(1) + ", " + playerPos.worldZ.toFixed(1) + ")"],
          ["Chunk", playerPos.chunkX + ", " + playerPos.chunkZ],
        ]);
      }
      // Auto-fill chunk inputs with player's current chunk
      var biomeCx = document.getElementById("world-biome-cx");
      var biomeCz = document.getElementById("world-biome-cz");
      if (biomeCx && biomeCz && !biomeCx.dataset.touched) {
        biomeCx.value = playerPos.chunkX;
        biomeCz.value = playerPos.chunkZ;
      }
      var portCx = document.getElementById("world-port-cx");
      var portCz = document.getElementById("world-port-cz");
      if (portCx && portCz && !portCx.dataset.touched) {
        portCx.value = playerPos.chunkX;
        portCz.value = playerPos.chunkZ;
      }
      var islandCx = document.getElementById("world-island-cx");
      var islandCz = document.getElementById("world-island-cz");
      if (islandCx && islandCz && !islandCx.dataset.touched) {
        islandCx.value = playerPos.chunkX;
        islandCz.value = playerPos.chunkZ;
      }

      // Now fetch world entities and sort by distance to player
      callInspector("getWorldEntities").then(function (res2) {
        if (res2.err || !res2.result) return;
        var data = res2.result;
        var portListEl = document.getElementById("world-port-list");
        var islandListEl = document.getElementById("world-island-list");
        var portCountEl = document.getElementById("world-port-count");
        var islandCountEl = document.getElementById("world-island-count");

        // Sort ports by distance to player
        var sortedPorts = data.ports.slice();
        sortedPorts.sort(function (a, b) {
          var da = (a.position[0] - playerPos.worldX) * (a.position[0] - playerPos.worldX) +
                   (a.position[2] - playerPos.worldZ) * (a.position[2] - playerPos.worldZ);
          var db = (b.position[0] - playerPos.worldX) * (b.position[0] - playerPos.worldX) +
                   (b.position[2] - playerPos.worldZ) * (b.position[2] - playerPos.worldZ);
          return da - db;
        });

        // Sort islands by distance to player
        var sortedIslands = data.islands.slice();
        sortedIslands.sort(function (a, b) {
          var da = (a.position[0] - playerPos.worldX) * (a.position[0] - playerPos.worldX) +
                   (a.position[2] - playerPos.worldZ) * (a.position[2] - playerPos.worldZ);
          var db = (b.position[0] - playerPos.worldX) * (b.position[0] - playerPos.worldX) +
                   (b.position[2] - playerPos.worldZ) * (b.position[2] - playerPos.worldZ);
          return da - db;
        });

        if (portCountEl) portCountEl.textContent = String(sortedPorts.length);
        if (islandCountEl) islandCountEl.textContent = String(sortedIslands.length);

        if (portListEl) {
          var portHtml = "";
          for (var i = 0; i < sortedPorts.length; i++) {
            var port = sortedPorts[i];
            var biomeName = biomeNames[Math.round(port.biome)] || "Unknown";
            var sizeName = portSizeNames[Math.round(port.size)] || "Unknown";
            portHtml += '<div class="world-entity-card">';
            portHtml += '<div class="entity-info">';
            portHtml += '<span class="entity-id">Port #' + port.entityId + '</span>';
            portHtml += '<span class="entity-pos">' + fmtVec3(port.position, 0) + '</span>';
            portHtml += '<span class="entity-biome">' + escapeHtml(biomeName) + '</span>';
            portHtml += '<span class="entity-chunk">chunk(' + port.chunkX + ',' + port.chunkZ + ')</span>';
            portHtml += '</div>';
            portHtml += '<span style="color:#888;">' + escapeHtml(sizeName) + '</span>';
            portHtml += '</div>';
          }
          portListEl.innerHTML = portHtml || '<p style="color:#666;padding:4px;">No ports loaded nearby</p>';
        }

        if (islandListEl) {
          var islandHtml = "";
          for (var j = 0; j < sortedIslands.length; j++) {
            var island = sortedIslands[j];
            var iBiomeName = biomeNames[Math.round(island.biome)] || "Unknown";
            var iSizeName = islandSizeNames[Math.round(island.size)] || "Unknown";
            islandHtml += '<div class="world-entity-card">';
            islandHtml += '<div class="entity-info">';
            islandHtml += '<span class="entity-id">Island #' + island.entityId + '</span>';
            islandHtml += '<span class="entity-pos">' + fmtVec3(island.position, 0) + '</span>';
            islandHtml += '<span class="entity-biome">' + escapeHtml(iBiomeName) + '</span>';
            islandHtml += '<span class="entity-chunk">chunk(' + island.chunkX + ',' + island.chunkZ + ')</span>';
            islandHtml += '</div>';
            islandHtml += '<span style="color:#888;">r=' + island.radius.toFixed(0) + ' ' + escapeHtml(iSizeName) + '</span>';
            islandHtml += '</div>';
          }
          islandListEl.innerHTML = islandHtml || '<p style="color:#666;padding:4px;">No islands loaded nearby</p>';
        }
      });
    });
  }

  // Mark inputs as touched when user edits them
  var worldInputs = ["world-biome-cx", "world-biome-cz", "world-port-cx", "world-port-cz", "world-island-cx", "world-island-cz"];
  for (var wi = 0; wi < worldInputs.length; wi++) {
    var el = document.getElementById(worldInputs[wi]);
    if (el) {
      (function (e) {
        e.addEventListener("input", function () { e.dataset.touched = "1"; });
      })(el);
    }
  }

  // Apply biome override
  var btnApplyBiome = document.getElementById("btn-apply-biome");
  if (btnApplyBiome) {
    btnApplyBiome.addEventListener("click", function () {
      var cx = parseInt(document.getElementById("world-biome-cx").value, 10) || 0;
      var cz = parseInt(document.getElementById("world-biome-cz").value, 10) || 0;
      var biome = parseInt(worldBiomeSelect.value, 10) || 0;
      callInspector("sendWorldCommand", [{ type: "override_biome", payload: { chunkX: cx, chunkZ: cz, biome: biome } }]);
      setTimeout(refreshWorldPanel, 500);
    });
  }

  // Force port
  var btnForcePort = document.getElementById("btn-force-port");
  if (btnForcePort) {
    btnForcePort.addEventListener("click", function () {
      var cx = parseInt(document.getElementById("world-port-cx").value, 10) || 0;
      var cz = parseInt(document.getElementById("world-port-cz").value, 10) || 0;
      callInspector("sendWorldCommand", [{ type: "force_port", payload: { chunkX: cx, chunkZ: cz } }]);
      setTimeout(refreshWorldPanel, 500);
    });
  }

  // Remove port
  var btnRemovePort = document.getElementById("btn-remove-port");
  if (btnRemovePort) {
    btnRemovePort.addEventListener("click", function () {
      var cx = parseInt(document.getElementById("world-port-cx").value, 10) || 0;
      var cz = parseInt(document.getElementById("world-port-cz").value, 10) || 0;
      callInspector("sendWorldCommand", [{ type: "remove_port", payload: { chunkX: cx, chunkZ: cz } }]);
      setTimeout(refreshWorldPanel, 500);
    });
  }

  // Force island
  var btnForceIsland = document.getElementById("btn-force-island");
  if (btnForceIsland) {
    btnForceIsland.addEventListener("click", function () {
      var cx = parseInt(document.getElementById("world-island-cx").value, 10) || 0;
      var cz = parseInt(document.getElementById("world-island-cz").value, 10) || 0;
      callInspector("sendWorldCommand", [{ type: "force_island", payload: { chunkX: cx, chunkZ: cz } }]);
      setTimeout(refreshWorldPanel, 500);
    });
  }

  // Remove island
  var btnRemoveIsland = document.getElementById("btn-remove-island");
  if (btnRemoveIsland) {
    btnRemoveIsland.addEventListener("click", function () {
      var cx = parseInt(document.getElementById("world-island-cx").value, 10) || 0;
      var cz = parseInt(document.getElementById("world-island-cz").value, 10) || 0;
      callInspector("sendWorldCommand", [{ type: "remove_island", payload: { chunkX: cx, chunkZ: cz } }]);
      setTimeout(refreshWorldPanel, 500);
    });
  }

  // Clear overrides
  var btnClearOverrides = document.getElementById("btn-clear-overrides");
  if (btnClearOverrides) {
    btnClearOverrides.addEventListener("click", function () {
      callInspector("sendWorldCommand", [{ type: "clear_overrides", payload: {} }]);
      setTimeout(refreshWorldPanel, 500);
    });
  }

  // Set seed
  var btnSetSeed = document.getElementById("btn-set-seed");
  if (btnSetSeed) {
    btnSetSeed.addEventListener("click", function () {
      var seed = parseInt(document.getElementById("world-seed-input").value, 10) || 12345;
      callInspector("sendWorldCommand", [{ type: "set_seed", payload: { seed: seed } }]);
      setTimeout(refreshWorldPanel, 500);
    });
  }

  // Manual refresh
  var btnRefreshWorld = document.getElementById("btn-refresh-world");
  if (btnRefreshWorld) {
    btnRefreshWorld.addEventListener("click", refreshWorldPanel);
  }

  // --- External Performance Charts ---

  var PERF_COLORS = {
    cpu: "#56b6c2",
    mem: "#e5c07b",
    disk: "#d19a66",
    network: "#c678dd",
    gc: "#e06c75",
    gpu: "#98c379",
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
          if (!m) {
            perfStatusEl.textContent = "Not available";
            return;
          }

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
        } catch (e) {
          perfStatusEl.textContent = "Error: " + String(e);
        }
      },
    );
  }

  function drawLine(ctx, data, color, maxVal, w, h) {
    if (!data || data.length === 0) return;
    var padL = 40, padR = 8, padT = 8, padB = 16;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x = padL + (plotW * i) / (PERF_MAX_POINTS - 1);
      var v = Math.min(maxVal, data[i]);
      var y = padT + plotH - (plotH * v) / maxVal;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawAxis(ctx, w, h, maxVal, unit) {
    var padL = 40, padR = 8, padT = 8, padB = 16;
    var plotH = h - padT - padB;
    ctx.strokeStyle = "#3e3e3e";
    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(w - padR, padT + plotH);
    ctx.stroke();
    for (var i = 0; i <= 4; i++) {
      var v = (maxVal * (4 - i)) / 4;
      var y = padT + (plotH * i) / 4;
      ctx.fillText(fmtVal(v, 0) + unit, 2, y + 3);
    }
  }

  function drawGpuChart() {
    var canvas = document.getElementById("perf-chart-gpu");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, w, h);
    var data = perfHistory.gpu.map(function (p) { return p.utilization; });
    drawAxis(ctx, w, h, 100, "%");
    drawLine(ctx, data, PERF_COLORS.gpu, 100, w, h);
    var legendEl = document.getElementById("perf-legend-gpu");
    if (legendEl) {
      var last = perfHistory.gpu[perfHistory.gpu.length - 1];
      legendEl.innerHTML =
        '<span class="legend-item" style="color:' + PERF_COLORS.gpu + '">GPU Util: ' +
        (last ? fmtVal(last.utilization, 1) + "%" : "\u2014") +
        "  (FPS: " + (last ? fmtVal(last.fps, 0) : "\u2014") + ")</span>";
    }
  }

  function drawProcessChart(key, canvasId, legendId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, w, h);

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
})();
