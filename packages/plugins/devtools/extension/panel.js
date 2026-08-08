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
  var chkPhysicsProfiler = document.getElementById("chk-physics-profiler");
  var physicsTimingGrid = document.getElementById("physics-timing-grid");
  var physicsProfilerEnabled = false;

  // GC tab elements
  var btnViewGC = document.getElementById("btn-view-gc");
  var gcPanel = document.getElementById("gc-panel");
  var gcStatusEl = document.getElementById("gc-status");
  var gcTimer = null;
  var gcHistory = { renderer: [], worker: [] };
  var gcWarnList = [];
  var GC_MAX_POINTS = 60;
  var GC_COLORS = { auto: "#56b6c2", v8: "#e06c75", headroom: "#98c379", slow: "#e5c07b" };

  // Editor panel elements
  var btnViewMaterial = document.getElementById("btn-view-material");
  var btnViewRenderGraph = document.getElementById("btn-view-rendergraph");
  var btnViewParticles = document.getElementById("btn-view-particles");
  var btnViewPlayground = document.getElementById("btn-view-playground");
  var btnViewInspector2 = document.getElementById("btn-view-inspector2");
  var materialPanel = document.getElementById("material-panel");
  var renderGraphPanel = document.getElementById("rendergraph-panel");
  var particlesPanel = document.getElementById("particles-panel");
  var playgroundPanel = document.getElementById("playground-panel");
  var inspector2Panel = document.getElementById("inspector2-panel");

  // Editor instances (lazy-initialized)
  var materialEditor = null;
  var renderGraphEditor = null;
  var particleEditor = null;
  var playgroundInstance = null;
  var inspector2Instance = null;

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

  // --- Sandboxed script execution ---
  // Uses new Function() to prevent access to closure variables while still
  // allowing DOM manipulation via a controlled API object. This is less secure
  // than iframe sandboxing but prevents accidental access to panel internals.
  function sandboxEval(code, api) {
    var fn = new Function("api", "with (api) { return (" + code + "\n); }");
    return fn(api);
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
    // SECURITY: validate method name to prevent code injection via string concatenation
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(method)) {
      console.error("[3D Scene] callInspector rejected invalid method name:", method);
      return Promise.resolve({ result: null, err: "Invalid method name" });
    }
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
      var nodeId = res.result.nodeId;
      var html = '<p class="success">Imported: ' + escapeHtml(filename) + " (id: " + nodeId + ")</p>";

      // Show normalization warnings if present
      if (res.result.warnings && res.result.warnings.length > 0) {
        html += '<div class="import-warnings">';
        res.result.warnings.forEach(function (w) {
          html += '<p class="warning">' + escapeHtml(w) + "</p>";
        });
        html += "</div>";
      }

      // Auto-fit prompt for extreme-scale models
      if (res.result.needsAutoFit) {
        var maxDim = res.result.maxDim ? res.result.maxDim.toFixed(4) : "?";
        html += '<div class="autofit-prompt">';
        html += '<p class="warning">Model has extreme scale (max dim: ' + maxDim + 'm). Auto-fit?</p>';
        html += '<button class="ge-toolbar-btn" id="autofit-yes">Auto-fit to 2m</button>';
        html += '<button class="ge-toolbar-btn" id="autofit-no">Dismiss</button>';
        html += "</div>";
        importStatus.innerHTML = html;
        refreshSceneTree();

        document.getElementById("autofit-yes").addEventListener("click", function () {
          callInspector("autoFitModel", [nodeId, 2.0]).then(function (fitRes) {
            if (fitRes.err || (fitRes.result && !fitRes.result.success)) {
              importStatus.innerHTML += '<p class="error">Auto-fit failed: ' + escapeHtml(fitRes.err || fitRes.result.error) + "</p>";
            } else {
              var sidecarLink = fitRes.result.sidecar
                ? '<p class="info">Sidecar generated. Save as <code>' + escapeHtml(filename.replace(/\.[^.]+$/, ".ddmeta.json")) + '</code> alongside the model.</p>'
                : "";
              importStatus.innerHTML = '<p class="success">Auto-fit applied.</p>' + sidecarLink;
              refreshSceneTree();
            }
          });
        });
        document.getElementById("autofit-no").addEventListener("click", function () {
          importStatus.innerHTML = '<p class="success">Imported: ' + escapeHtml(filename) + " (id: " + nodeId + ")</p>";
        });
        return;
      }

      importStatus.innerHTML = html;
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

    // Eval script (sandboxed — no access to panel closure variables)
    if (ext.script) {
      try {
        var lifecycle = sandboxEval(ext.script, { document: document, console: console, panel: panel });
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
        sandboxEval(toggle.script, { document: document, console: console });
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
    if (btnViewGC) btnViewGC.classList.toggle("active", view === "gc");

    // Update extension tab button states
    for (var i = 0; i < panelExtensions.length; i++) {
      var ext = panelExtensions[i];
      var btn = document.getElementById("btn-ext-" + ext.id);
      if (btn) btn.classList.toggle("active", view === ext.id);
    }

    // Show/hide scene toolbar
    sceneToolbarEl.classList.toggle("hidden", view !== "scene");

    // Update editor tab button states
    if (btnViewMaterial) btnViewMaterial.classList.toggle("active", view === "material");
    if (btnViewRenderGraph) btnViewRenderGraph.classList.toggle("active", view === "rendergraph");
    if (btnViewParticles) btnViewParticles.classList.toggle("active", view === "particles");
    if (btnViewPlayground) btnViewPlayground.classList.toggle("active", view === "playground");
    if (btnViewInspector2) btnViewInspector2.classList.toggle("active", view === "inspector2");

    // Show/hide core panels
    mainContentEl.style.display = view === "scene" ? "flex" : "none";
    importPanel.style.display = view === "import" ? "block" : "none";
    perfPanel.style.display = view === "perf" ? "block" : "none";
    if (gcPanel) gcPanel.style.display = view === "gc" ? "block" : "none";

    // Show/hide editor panels
    if (materialPanel) materialPanel.style.display = view === "material" ? "flex" : "none";
    if (renderGraphPanel) renderGraphPanel.style.display = view === "rendergraph" ? "flex" : "none";
    if (particlesPanel) particlesPanel.style.display = view === "particles" ? "flex" : "none";
    if (playgroundPanel) playgroundPanel.style.display = view === "playground" ? "flex" : "none";
    if (inspector2Panel) inspector2Panel.style.display = view === "inspector2" ? "flex" : "none";

    // Lazy-init editors on first view
    if (view === "material" && !materialEditor && typeof MaterialEditor !== "undefined") {
      materialEditor = new MaterialEditor(materialPanel, { evalInPage: evalInPage, callInspector: callInspector });
    }
    if (view === "rendergraph" && !renderGraphEditor && typeof RenderGraphEditor !== "undefined") {
      renderGraphEditor = new RenderGraphEditor(renderGraphPanel, { evalInPage: evalInPage, callInspector: callInspector });
    }
    if (view === "particles" && !particleEditor && typeof ParticleEditor !== "undefined") {
      particleEditor = new ParticleEditor(particlesPanel, { evalInPage: evalInPage, callInspector: callInspector });
    }
    if (view === "playground" && !playgroundInstance && typeof Playground !== "undefined") {
      playgroundInstance = new Playground(playgroundPanel, { evalInPage: evalInPage, callInspector: callInspector });
    }
    if (view === "inspector2" && !inspector2Instance && typeof InspectorV2 !== "undefined") {
      inspector2Instance = new InspectorV2(inspector2Panel, { evalInPage: evalInPage, callInspector: callInspector });
    }

    // Activate/deactivate editors
    if (materialEditor) materialEditor.setActive(view === "material");
    if (renderGraphEditor) renderGraphEditor.setActive(view === "rendergraph");
    if (particleEditor) particleEditor.setActive(view === "particles");
    if (playgroundInstance) playgroundInstance.setActive(view === "playground");
    if (inspector2Instance) inspector2Instance.setActive(view === "inspector2");

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
    if (view === "perf" || view === "gc") {
      evalInPage(
        "window.__sceneInspector ? window.__sceneInspector.enablePerformanceMonitoring() : null",
        function () {
          if (view === "perf") {
            refreshPerf();
            if (!perfTimer) perfTimer = setInterval(refreshPerf, 1000);
          } else {
            refreshGC();
            if (!gcTimer) gcTimer = setInterval(refreshGC, 1000);
          }
        },
      );
    } else {
      if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
      if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
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
  if (btnViewGC) btnViewGC.addEventListener("click", function () {
    if (currentView === "gc") switchView("scene"); else switchView("gc");
  });
  if (btnViewMaterial) btnViewMaterial.addEventListener("click", function () {
    if (currentView === "material") switchView("scene"); else switchView("material");
  });
  if (btnViewRenderGraph) btnViewRenderGraph.addEventListener("click", function () {
    if (currentView === "rendergraph") switchView("scene"); else switchView("rendergraph");
  });
  if (btnViewParticles) btnViewParticles.addEventListener("click", function () {
    if (currentView === "particles") switchView("scene"); else switchView("particles");
  });
  if (btnViewPlayground) btnViewPlayground.addEventListener("click", function () {
    if (currentView === "playground") switchView("scene"); else switchView("playground");
  });
  if (btnViewInspector2) btnViewInspector2.addEventListener("click", function () {
    if (currentView === "inspector2") switchView("scene"); else switchView("inspector2");
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
          if (m.physics) updatePhysicsTiming(m.physics);
        } catch (e) { perfStatusEl.textContent = "Error: " + String(e); }
      },
    );
  }

  // --- Physics Profiler ---
  if (chkPhysicsProfiler) {
    chkPhysicsProfiler.addEventListener("change", function () {
      physicsProfilerEnabled = chkPhysicsProfiler.checked;
      evalInPage(
        "window.__sceneInspector ? window.__sceneInspector.setPhysicsProfiler(" + physicsProfilerEnabled + ") : null",
        function () {},
      );
      if (!physicsProfilerEnabled) {
        physicsTimingGrid.innerHTML = '<p class="empty-state">Enable profiler to see timing breakdown</p>';
      }
    });
  }

  var PHYS_TIMING_LABELS = {
    step: "Total Step",
    collisionDetection: "Collision Detection",
    broadPhase: "Broad Phase",
    narrowPhase: "Narrow Phase",
    solver: "Solver",
    velocityAssembly: "Velocity Assembly",
    velocityResolution: "Velocity Resolution",
    velocityUpdate: "Velocity Update",
    velocityWriteback: "Velocity Writeback",
    ccd: "CCD",
    ccdToiComputation: "CCD TOI Computation",
    ccdBroadPhase: "CCD Broad Phase",
    ccdNarrowPhase: "CCD Narrow Phase",
    ccdSolver: "CCD Solver",
    islandConstruction: "Island Construction",
    userChanges: "User Changes",
  };

  function updatePhysicsTiming(physics) {
    if (!physics) return;
    if (physics.profilerEnabled !== undefined && chkPhysicsProfiler) {
      chkPhysicsProfiler.checked = physics.profilerEnabled;
      physicsProfilerEnabled = physics.profilerEnabled;
    }
    if (!physics.timing) {
      if (physicsProfilerEnabled) {
        physicsTimingGrid.innerHTML = '<p class="empty-state">Waiting for timing data...</p>';
      }
      return;
    }
    var t = physics.timing;
    var maxVal = t.step || 0.001;
    var html = '';
    var keys = Object.keys(PHYS_TIMING_LABELS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = t[k] || 0;
      var pct = Math.min(100, (v / maxVal) * 100);
      html += '<div class="physics-timing-row">' +
        '<span class="physics-timing-label">' + PHYS_TIMING_LABELS[k] + '</span>' +
        '<span class="physics-timing-value">' + fmtVal(v, 3) + 'ms</span>' +
        '</div>';
      html += '<div class="physics-timing-bar" style="width:' + pct + '%"></div>';
    }
    if (physics.bodyCount !== undefined || physics.tickCount !== undefined) {
      html += '<div class="physics-timing-row" style="grid-column:1/-1;margin-top:4px">' +
        '<span class="physics-timing-label">Bodies: ' + (physics.bodyCount || 0) + '</span>' +
        '<span class="physics-timing-label">Ticks: ' + (physics.tickCount || 0) + '</span>' +
        '</div>';
    }
    physicsTimingGrid.innerHTML = html;
  }

  // --- GC Tab ---

  function refreshGC() {
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getGCStats()) : null",
      function (result, err) {
        if (err || !result) {
          if (gcStatusEl) gcStatusEl.textContent = "Not available — is debug mode enabled?";
          return;
        }
        try {
          var stats = JSON.parse(result);
          if (!stats) { if (gcStatusEl) gcStatusEl.textContent = "Not available"; return; }
          var r = stats.renderer;
          var w = stats["sim-worker"];
          if (r) { gcHistory.renderer.push(r); if (gcHistory.renderer.length > GC_MAX_POINTS) gcHistory.renderer.shift(); }
          if (w) { gcHistory.worker.push(w); if (gcHistory.worker.length > GC_MAX_POINTS) gcHistory.worker.shift(); }
          if (gcStatusEl) {
            var rAuto = r ? r.interval.autoMinorCount + r.interval.autoMajorCount : 0;
            var wAuto = w ? w.interval.autoMinorCount + w.interval.autoMajorCount : 0;
            gcStatusEl.textContent = "Auto-GC: R:" + rAuto + " W:" + wAuto + "  |  V8: R:" + (r ? r.interval.v8AutoGcCount : 0) + " W:" + (w ? w.interval.v8AutoGcCount : 0);
          }
          drawGCChart("renderer", "gc-chart-renderer", "gc-legend-renderer");
          drawGCChart("worker", "gc-chart-worker", "gc-legend-worker");
          drawHeadroomChart();
          updateGCWarnings(r, w);
          updateGCComparison(r, w);
          // Sync controls with current config
          syncGCControls(r || w);
        } catch (e) { if (gcStatusEl) gcStatusEl.textContent = "Error: " + String(e); }
      },
    );
  }

  function drawGCChart(key, canvasId, legendId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, w, h);
    var hist = gcHistory[key];
    if (!hist || hist.length === 0) return;
    var autoCountData = hist.map(function (s) { return s.interval.autoMinorCount + s.interval.autoMajorCount; });
    var autoMsData = hist.map(function (s) { return s.interval.autoGcTotalMs; });
    var v8CountData = hist.map(function (s) { return s.interval.v8AutoGcCount; });
    drawAxis(ctx, w, h, 100, "");
    drawLine(ctx, autoCountData.map(function (v) { return Math.min(100, (v / 20) * 100); }), GC_COLORS.auto, 100, w, h);
    drawLine(ctx, v8CountData.map(function (v) { return Math.min(100, (v / 20) * 100); }), GC_COLORS.v8, 100, w, h);
    drawLine(ctx, autoMsData.map(function (v) { return Math.min(100, (v / 10) * 100); }), GC_COLORS.slow, 100, w, h);
    var legendEl = document.getElementById(legendId);
    if (legendEl) {
      var last = hist[hist.length - 1];
      legendEl.innerHTML =
        '<span class="legend-item" style="color:' + GC_COLORS.auto + '">Auto-GC: ' + (last.interval.autoMinorCount + last.interval.autoMajorCount) + ' (' + fmtVal(last.interval.autoGcTotalMs, 1) + 'ms)</span>' +
        '<span class="legend-item" style="color:' + GC_COLORS.v8 + '">V8 Auto: ' + last.interval.v8AutoGcCount + ' (' + fmtVal(last.interval.v8AutoGcTotalMs, 1) + 'ms)</span>' +
        '<span class="legend-item" style="color:' + GC_COLORS.slow + '">Slow: ' + last.interval.slowGcCount + ' Max: ' + fmtVal(last.interval.autoGcMaxMs, 1) + 'ms</span>' +
        '<span class="legend-item">GC avail: ' + (last.gcAvailable ? "yes" : "no") + '</span>';
    }
  }

  function drawHeadroomChart() {
    var canvas = document.getElementById("gc-chart-headroom");
    if (!canvas) return;
    var ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, w, h);
    drawAxis(ctx, w, h, 100, "%");
    var rHist = gcHistory.renderer;
    var wHist = gcHistory.worker;
    if (rHist && rHist.length > 0) {
      var rData = rHist.map(function (s) {
        if (!s.headroomSamples || s.headroomSamples.length === 0) return 0;
        var last = s.headroomSamples[s.headroomSamples.length - 1];
        var interval = s.config.minorIntervalMs || 16;
        return Math.min(100, (last / interval) * 100);
      });
      drawLine(ctx, rData, GC_COLORS.auto, 100, w, h);
    }
    if (wHist && wHist.length > 0) {
      var wData = wHist.map(function (s) {
        if (!s.headroomSamples || s.headroomSamples.length === 0) return 0;
        var last = s.headroomSamples[s.headroomSamples.length - 1];
        var interval = s.config.minorIntervalMs || 16;
        return Math.min(100, (last / interval) * 100);
      });
      drawLine(ctx, wData, GC_COLORS.headroom, 100, w, h);
    }
    var legendEl = document.getElementById("gc-legend-headroom");
    if (legendEl) {
      legendEl.innerHTML =
        '<span class="legend-item" style="color:' + GC_COLORS.auto + '">Renderer headroom</span>' +
        '<span class="legend-item" style="color:' + GC_COLORS.headroom + '">Worker headroom</span>';
    }
  }

  function updateGCWarnings(r, w) {
    var warnEl = document.getElementById("gc-warnings");
    if (!warnEl) return;
    var warns = [];
    if (r && r.recentInvocations) {
      for (var i = 0; i < r.recentInvocations.length; i++) {
        if (r.recentInvocations[i].slow) warns.push({ label: "renderer", inv: r.recentInvocations[i] });
      }
    }
    if (w && w.recentInvocations) {
      for (var j = 0; j < w.recentInvocations.length; j++) {
        if (w.recentInvocations[j].slow) warns.push({ label: "worker", inv: w.recentInvocations[j] });
      }
    }
    if (warns.length === 0) {
      warnEl.innerHTML = '<p class="empty-state">No warnings</p>';
      return;
    }
    var html = "";
    for (var k = 0; k < warns.length; k++) {
      var inv = warns[k].inv;
      html += '<div class="physics-timing-row">' +
        '<span class="physics-timing-label">' + warns[k].label + ' ' + inv.type + '</span>' +
        '<span class="physics-timing-value">' + fmtVal(inv.durationMs, 2) + 'ms (headroom: ' + fmtVal(inv.headroomMs, 1) + 'ms)</span>' +
        '</div>';
    }
    warnEl.innerHTML = html;
  }

  function updateGCComparison(r, w) {
    var el = document.getElementById("gc-comparison");
    if (!el) return;
    function row(label, rVal, wVal) {
      return '<div class="physics-timing-row">' +
        '<span class="physics-timing-label">' + label + '</span>' +
        '<span class="physics-timing-value">R: ' + rVal + '  W: ' + wVal + '</span>' +
        '</div>';
    }
    var rAuto = r ? r.interval.autoMinorCount + r.interval.autoMajorCount : 0;
    var wAuto = w ? w.interval.autoMinorCount + w.interval.autoMajorCount : 0;
    var rV8 = r ? r.interval.v8AutoGcCount : 0;
    var wV8 = w ? w.interval.v8AutoGcCount : 0;
    var rAutoMs = r ? r.interval.autoGcTotalMs : 0;
    var wAutoMs = w ? w.interval.autoGcTotalMs : 0;
    var rV8Ms = r ? r.interval.v8AutoGcTotalMs : 0;
    var wV8Ms = w ? w.interval.v8AutoGcTotalMs : 0;
    var rSkipH = r ? r.interval.skippedNoHeadroom : 0;
    var wSkipH = w ? w.interval.skippedNoHeadroom : 0;
    var rSkipP = r ? r.interval.skippedNoPressure : 0;
    var wSkipP = w ? w.interval.skippedNoPressure : 0;
    el.innerHTML =
      row("Auto-GC count", rAuto, wAuto) +
      row("Auto-GC time (ms)", fmtVal(rAutoMs, 1), fmtVal(wAutoMs, 1)) +
      row("V8 auto-GC count", rV8, wV8) +
      row("V8 auto-GC time (ms)", fmtVal(rV8Ms, 1), fmtVal(wV8Ms, 1)) +
      row("Skipped (no headroom)", rSkipH, wSkipH) +
      row("Skipped (no pressure)", rSkipP, wSkipP) +
      row("Heap used (MB)", r ? fmtVal(r.heapUsedBytes / 1048576, 1) : "0", w ? fmtVal(w.heapUsedBytes / 1048576, 1) : "0");
  }

  function syncGCControls(stats) {
    if (!stats || !stats.config) return;
    var c = stats.config;
    var chkEnabled = document.getElementById("chk-gc-enabled");
    var chkMajor = document.getElementById("chk-gc-major-transitions");
    var sliderInterval = document.getElementById("slider-gc-minor-interval");
    var valInterval = document.getElementById("val-gc-minor-interval");
    var sliderHeadroom = document.getElementById("slider-gc-headroom");
    var valHeadroom = document.getElementById("val-gc-headroom");
    var sliderWarn = document.getElementById("slider-gc-warn");
    var valWarn = document.getElementById("val-gc-warn");
    if (chkEnabled && chkEnabled.checked !== c.enabled) chkEnabled.checked = c.enabled;
    if (chkMajor && chkMajor.checked !== c.majorOnTransitions) chkMajor.checked = c.majorOnTransitions;
    if (sliderInterval && sliderInterval.value != c.minorIntervalMs) sliderInterval.value = c.minorIntervalMs;
    if (valInterval) valInterval.textContent = c.minorIntervalMs + "ms";
    if (sliderHeadroom && sliderHeadroom.value != Math.round(c.headroomThreshold * 100)) sliderHeadroom.value = Math.round(c.headroomThreshold * 100);
    if (valHeadroom) valHeadroom.textContent = Math.round(c.headroomThreshold * 100) + "%";
    if (sliderWarn && sliderWarn.value != c.gcDurationWarnMs) sliderWarn.value = c.gcDurationWarnMs;
    if (valWarn) valWarn.textContent = c.gcDurationWarnMs + "ms";
  }

  // Wire GC controls
  var chkGCEnabled = document.getElementById("chk-gc-enabled");
  var chkGCMajor = document.getElementById("chk-gc-major-transitions");
  var sliderGCMinorInterval = document.getElementById("slider-gc-minor-interval");
  var valGCMinorInterval = document.getElementById("val-gc-minor-interval");
  var sliderGCHeadroom = document.getElementById("slider-gc-headroom");
  var valGCHeadroom = document.getElementById("val-gc-headroom");
  var sliderGCWarn = document.getElementById("slider-gc-warn");
  var valGCWarn = document.getElementById("val-gc-warn");
  var btnGCMajorNow = document.getElementById("btn-gc-major-now");

  if (chkGCEnabled) chkGCEnabled.addEventListener("change", function () {
    callInspector("setGCConfig", [{ enabled: chkGCEnabled.checked }]);
  });
  if (chkGCMajor) chkGCMajor.addEventListener("change", function () {
    callInspector("setGCConfig", [{ majorOnTransitions: chkGCMajor.checked }]);
  });
  if (sliderGCMinorInterval) sliderGCMinorInterval.addEventListener("input", function () {
    if (valGCMinorInterval) valGCMinorInterval.textContent = sliderGCMinorInterval.value + "ms";
  });
  if (sliderGCMinorInterval) sliderGCMinorInterval.addEventListener("change", function () {
    callInspector("setGCConfig", [{ minorIntervalMs: parseInt(sliderGCMinorInterval.value, 10) }]);
  });
  if (sliderGCHeadroom) sliderGCHeadroom.addEventListener("input", function () {
    if (valGCHeadroom) valGCHeadroom.textContent = sliderGCHeadroom.value + "%";
  });
  if (sliderGCHeadroom) sliderGCHeadroom.addEventListener("change", function () {
    callInspector("setGCConfig", [{ headroomThreshold: parseInt(sliderGCHeadroom.value, 10) / 100 }]);
  });
  if (sliderGCWarn) sliderGCWarn.addEventListener("input", function () {
    if (valGCWarn) valGCWarn.textContent = sliderGCWarn.value + "ms";
  });
  if (sliderGCWarn) sliderGCWarn.addEventListener("change", function () {
    callInspector("setGCConfig", [{ gcDurationWarnMs: parseInt(sliderGCWarn.value, 10) }]);
  });
  if (btnGCMajorNow) btnGCMajorNow.addEventListener("click", function () {
    callInspector("forceMajorGC", null);
  });

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
    if (gcTimer) clearInterval(gcTimer);
    // Clean up editor instances
    if (materialEditor) materialEditor.destroy();
    if (renderGraphEditor) renderGraphEditor.destroy();
    if (particleEditor) particleEditor.destroy();
    if (playgroundInstance) playgroundInstance.destroy();
    if (inspector2Instance) inspector2Instance.destroy();
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
