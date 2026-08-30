// ============================================================================
// InspectorV2 — Enhanced scene inspector with hierarchy tree, multi-select,
// material/mesh/light inspectors, debug overlays, and frame capture.
// Extends the existing Scene panel as a DevTools extension panel.
// ============================================================================

(function (global) {
  "use strict";

  function InspectorV2(container, helpers) {
    this.container = container;
    this.evalInPage = helpers.evalInPage;
    this.callInspector = helpers.callInspector;
    this.active = false;
    this.selectedIds = [];
    this.sceneTreeData = null;
    this.refreshTimer = null;
    this.debugMode = "none";
    this.frameHistory = [];
    this.maxFrameHistory = 60;
    this._buildDOM();
    this._bindEvents();
  }

  // ─── DOM Construction ────────────────────────────────────────────────

  InspectorV2.prototype._buildDOM = function () {
    this.root = document.createElement("div");
    this.root.style.display = "flex";
    this.root.style.flexDirection = "column";
    this.root.style.width = "100%";
    this.root.style.height = "100%";

    // Toolbar
    var toolbar = document.createElement("div");
    toolbar.className = "ge-toolbar";

    var btnRefresh = document.createElement("button");
    btnRefresh.className = "ge-toolbar-btn";
    btnRefresh.textContent = "Refresh";
    var self = this;
    btnRefresh.addEventListener("click", function () { self.refreshSceneTree(); });

    var btnExpandAll = document.createElement("button");
    btnExpandAll.className = "ge-toolbar-btn";
    btnExpandAll.textContent = "Expand All";
    btnExpandAll.addEventListener("click", function () { self._expandAll(); });

    var btnCollapseAll = document.createElement("button");
    btnCollapseAll.className = "ge-toolbar-btn";
    btnCollapseAll.textContent = "Collapse All";
    btnCollapseAll.addEventListener("click", function () { self._collapseAll(); });

    var sep1 = document.createElement("span");
    sep1.className = "ge-toolbar-separator";

    // Debug mode selector
    var debugLabel = document.createElement("span");
    debugLabel.className = "ge-toolbar-label";
    debugLabel.textContent = "Debug:";

    var debugSelect = document.createElement("select");
    debugSelect.className = "ge-property-select";
    debugSelect.style.width = "auto";
    debugSelect.style.fontSize = "11px";
    ["none", "wireframe", "normals", "uv", "bounding-box", "depth", "mipmaps", "overdraw"].forEach(function (mode) {
      var opt = document.createElement("option");
      opt.value = mode;
      opt.textContent = mode;
      debugSelect.appendChild(opt);
    });
    debugSelect.addEventListener("change", function () {
      self.setDebugMode(debugSelect.value);
    });

    var sep2 = document.createElement("span");
    sep2.className = "ge-toolbar-separator";

    // Frame capture
    var btnCapture = document.createElement("button");
    btnCapture.className = "ge-toolbar-btn";
    btnCapture.textContent = "Capture Frame";
    btnCapture.addEventListener("click", function () { self.captureFrame(); });

    var btnStepForward = document.createElement("button");
    btnStepForward.className = "ge-toolbar-btn";
    btnStepForward.textContent = "Step ▶";
    btnStepForward.addEventListener("click", function () { self.stepFrame(1); });

    var btnStepBack = document.createElement("button");
    btnStepBack.className = "ge-toolbar-btn";
    btnStepBack.textContent = "◀ Step";
    btnStepBack.addEventListener("click", function () { self.stepFrame(-1); });

    toolbar.appendChild(btnRefresh);
    toolbar.appendChild(btnExpandAll);
    toolbar.appendChild(btnCollapseAll);
    toolbar.appendChild(sep1);
    toolbar.appendChild(debugLabel);
    toolbar.appendChild(debugSelect);
    toolbar.appendChild(sep2);
    toolbar.appendChild(btnCapture);
    toolbar.appendChild(btnStepBack);
    toolbar.appendChild(btnStepForward);

    // Main content: tree | inspector
    var content = document.createElement("div");
    content.style.display = "flex";
    content.style.flex = "1";
    content.style.overflow = "hidden";

    // Hierarchy tree
    var treeContainer = document.createElement("div");
    treeContainer.style.width = "300px";
    treeContainer.style.borderRight = "1px solid #333355";
    treeContainer.style.overflowY = "auto";
    treeContainer.style.overflowX = "hidden";
    treeContainer.style.flexShrink = "0";

    var treeHeader = document.createElement("div");
    treeHeader.className = "ge-properties-header";
    treeHeader.textContent = "Hierarchy";
    treeContainer.appendChild(treeHeader);

    this.treeEl = document.createElement("div");
    this.treeEl.className = "iv2-tree";
    treeContainer.appendChild(this.treeEl);

    // Inspector panel
    var inspectorContainer = document.createElement("div");
    inspectorContainer.style.flex = "1";
    inspectorContainer.style.overflowY = "auto";
    inspectorContainer.style.padding = "8px";

    this.inspectorEl = document.createElement("div");
    inspectorContainer.appendChild(this.inspectorEl);

    content.appendChild(treeContainer);
    content.appendChild(inspectorContainer);

    this.root.appendChild(toolbar);
    this.root.appendChild(content);
    this.container.appendChild(this.root);

    this._showEmptyInspector();
  };

  InspectorV2.prototype._bindEvents = function () {
    var self = this;
    // Keyboard shortcuts
    this.root.addEventListener("keydown", function (e) {
      if (e.key === "r" && e.ctrlKey) {
        e.preventDefault();
        self.refreshSceneTree();
      }
    });
    this.root.tabIndex = 0;
  };

  // ─── Lifecycle ───────────────────────────────────────────────────────

  InspectorV2.prototype.setActive = function (active) {
    this.active = active;
    if (active) {
      this.refreshSceneTree();
      this.refreshTimer = setInterval(this.refreshSceneTree.bind(this), 500);
    } else {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
      this.setDebugMode("none");
    }
  };

  // ─── Scene Tree ──────────────────────────────────────────────────────

  InspectorV2.prototype.refreshSceneTree = function () {
    var self = this;
    this.callInspector("getSceneTree").then(function (response) {
      if (response.err || !response.result) {
        self.treeEl.innerHTML = '<div class="ge-empty-properties">No scene data</div>';
        return;
      }
      self.sceneTreeData = response.result;
      self._renderTree(response.result);
    });
  };

  InspectorV2.prototype._renderTree = function (tree) {
    this.treeEl.innerHTML = "";
    if (!tree || !tree.nodes || tree.nodes.length === 0) {
      this.treeEl.innerHTML = '<div class="ge-empty-properties">Empty scene</div>';
      return;
    }
    var self = this;
    tree.nodes.forEach(function (node) {
      self._renderTreeNode(node, self.treeEl, 0);
    });
  };

  InspectorV2.prototype._renderTreeNode = function (node, parent, depth) {
    var self = this;
    var row = document.createElement("div");
    row.className = "iv2-tree-row";
    row.style.paddingLeft = (depth * 16 + 4) + "px";
    row.dataset.nodeId = node.id;

    var isSelected = this.selectedIds.indexOf(node.id) >= 0;
    if (isSelected) row.classList.add("iv2-selected");

    // Expand/collapse toggle
    var toggle = document.createElement("span");
    toggle.className = "iv2-tree-toggle";
    if (node.children && node.children.length > 0) {
      toggle.textContent = "▼";
      toggle.style.cursor = "pointer";
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        var childContainer = row.nextElementSibling;
        if (childContainer && childContainer.classList.contains("iv2-tree-children")) {
          var isHidden = childContainer.style.display === "none";
          childContainer.style.display = isHidden ? "block" : "none";
          toggle.textContent = isHidden ? "▼" : "▶";
        }
      });
    } else {
      toggle.textContent = "·";
      toggle.style.opacity = "0.3";
    }
    row.appendChild(toggle);

    // Visibility toggle
    var visBtn = document.createElement("span");
    visBtn.className = "iv2-tree-vis";
    visBtn.textContent = node.visible !== false ? "👁" : "—";
    visBtn.style.cursor = "pointer";
    visBtn.style.fontSize = "10px";
    visBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var newVis = node.visible === false;
      self.callInspector("updateNodeProperty", [node.id, "visible", newVis]);
      node.visible = newVis;
      visBtn.textContent = newVis ? "👁" : "—";
    });
    row.appendChild(visBtn);

    // Node name
    var name = document.createElement("span");
    name.className = "iv2-tree-name";
    name.textContent = node.name || node.id;
    if (node.type) {
      var typeBadge = document.createElement("span");
      typeBadge.className = "iv2-type-badge";
      typeBadge.textContent = node.type;
      typeBadge.style.fontSize = "9px";
      typeBadge.style.color = "#8888aa";
      typeBadge.style.marginLeft = "4px";
      name.appendChild(typeBadge);
    }
    row.appendChild(name);

    // Click to select (ctrl/cmd for multi-select)
    row.addEventListener("click", function (e) {
      if (e.ctrlKey || e.metaKey) {
        self._toggleSelect(node.id);
      } else {
        self._selectSingle(node.id);
      }
    });

    parent.appendChild(row);

    // Render children
    if (node.children && node.children.length > 0) {
      var childContainer = document.createElement("div");
      childContainer.className = "iv2-tree-children";
      node.children.forEach(function (child) {
        self._renderTreeNode(child, childContainer, depth + 1);
      });
      parent.appendChild(childContainer);
    }
  };

  InspectorV2.prototype._selectSingle = function (id) {
    this.selectedIds = [id];
    this._updateTreeSelection();
    this._showInspector(id);
    this.callInspector("selectNode", id);
  };

  InspectorV2.prototype._toggleSelect = function (id) {
    var idx = this.selectedIds.indexOf(id);
    if (idx >= 0) {
      this.selectedIds.splice(idx, 1);
    } else {
      this.selectedIds.push(id);
    }
    this._updateTreeSelection();
    if (this.selectedIds.length === 1) {
      this._showInspector(this.selectedIds[0]);
      this.callInspector("selectNode", this.selectedIds[0]);
    } else if (this.selectedIds.length === 0) {
      this._showEmptyInspector();
      this.callInspector("selectNode", null);
    } else {
      this._showMultiSelectInspector();
    }
  };

  InspectorV2.prototype._updateTreeSelection = function () {
    var self = this;
    var rows = this.treeEl.querySelectorAll(".iv2-tree-row");
    rows.forEach(function (row) {
      var id = row.dataset.nodeId;
      row.classList.toggle("iv2-selected", self.selectedIds.indexOf(id) >= 0);
    });
  };

  InspectorV2.prototype._expandAll = function () {
    var children = this.treeEl.querySelectorAll(".iv2-tree-children");
    children.forEach(function (c) { c.style.display = "block"; });
    var toggles = this.treeEl.querySelectorAll(".iv2-tree-toggle");
    toggles.forEach(function (t) { if (t.textContent === "▶") t.textContent = "▼"; });
  };

  InspectorV2.prototype._collapseAll = function () {
    var children = this.treeEl.querySelectorAll(".iv2-tree-children");
    children.forEach(function (c) { c.style.display = "none"; });
    var toggles = this.treeEl.querySelectorAll(".iv2-tree-toggle");
    toggles.forEach(function (t) { if (t.textContent === "▼") t.textContent = "▶"; });
  };

  // ─── Inspector Panel ─────────────────────────────────────────────────

  InspectorV2.prototype._showEmptyInspector = function () {
    this.inspectorEl.innerHTML = '<div class="ge-empty-properties">Select a node to inspect</div>';
  };

  InspectorV2.prototype._showMultiSelectInspector = function () {
    this.inspectorEl.innerHTML = "";
    var header = document.createElement("div");
    header.className = "ge-properties-header";
    header.textContent = this.selectedIds.length + " nodes selected";
    this.inspectorEl.appendChild(header);

    var actions = document.createElement("div");
    actions.style.padding = "8px 0";

    var btnDelete = document.createElement("button");
    btnDelete.className = "ge-toolbar-btn";
    btnDelete.textContent = "Delete All";
    var self = this;
    btnDelete.addEventListener("click", function () {
      self.selectedIds.forEach(function (id) {
        self.callInspector("removeNode", id);
      });
      self.selectedIds = [];
      self._showEmptyInspector();
      self.refreshSceneTree();
    });
    actions.appendChild(btnDelete);

    var btnDuplicate = document.createElement("button");
    btnDuplicate.className = "ge-toolbar-btn";
    btnDuplicate.textContent = "Duplicate All";
    btnDuplicate.addEventListener("click", function () {
      self.selectedIds.forEach(function (id) {
        self.callInspector("duplicateNode", id);
      });
      self.refreshSceneTree();
    });
    actions.appendChild(btnDuplicate);

    this.inspectorEl.appendChild(actions);
  };

  InspectorV2.prototype._showInspector = function (id) {
    var self = this;
    this.callInspector("getNodeJSON", id).then(function (response) {
      if (response.err || !response.result) {
        self._showEmptyInspector();
        return;
      }

      var node;
      try { node = typeof response.result === "string" ? JSON.parse(response.result) : response.result; }
      catch (e) { self._showEmptyInspector(); return; }

      self.inspectorEl.innerHTML = "";
      self._renderNodeInspector(node);
    });
  };

  InspectorV2.prototype._renderNodeInspector = function (node) {
    var self = this;

    // Header
    var header = document.createElement("div");
    header.className = "ge-properties-header";
    header.textContent = node.name || node.id;
    this.inspectorEl.appendChild(header);

    // Type badge
    if (node.type) {
      var typeRow = document.createElement("div");
      typeRow.className = "ge-property-row";
      var typeLabel = document.createElement("label");
      typeLabel.className = "ge-property-label";
      typeLabel.textContent = "Type: " + node.type;
      typeRow.appendChild(typeLabel);
      this.inspectorEl.appendChild(typeRow);
    }

    // Separator
    var sep = document.createElement("hr");
    sep.style.border = "none";
    sep.style.borderTop = "1px solid #333355";
    sep.style.margin = "6px 0";
    this.inspectorEl.appendChild(sep);

    // Transform section
    this._renderTransformSection(node);

    // Material section (if applicable)
    if (node.type === "model" || node.type === "entity") {
      this._renderMaterialSection(node);
    }

    // Mesh section (if applicable)
    if (node.type === "model") {
      this._renderMeshSection(node);
    }

    // Actions
    var actions = document.createElement("div");
    actions.style.padding = "8px 0";
    actions.style.display = "flex";
    actions.style.gap = "6px";

    var btnDuplicate = document.createElement("button");
    btnDuplicate.className = "ge-toolbar-btn";
    btnDuplicate.textContent = "Duplicate";
    btnDuplicate.addEventListener("click", function () {
      self.callInspector("duplicateNode", node.id).then(function () { self.refreshSceneTree(); });
    });

    var btnDelete = document.createElement("button");
    btnDelete.className = "ge-toolbar-btn";
    btnDelete.textContent = "Delete";
    btnDelete.style.color = "#ff8888";
    btnDelete.addEventListener("click", function () {
      self.callInspector("removeNode", node.id);
      self.selectedIds = [];
      self._showEmptyInspector();
      self.refreshSceneTree();
    });

    actions.appendChild(btnDuplicate);
    actions.appendChild(btnDelete);
    this.inspectorEl.appendChild(actions);
  };

  InspectorV2.prototype._renderTransformSection = function (node) {
    var self = this;

    var section = document.createElement("div");
    section.className = "ge-property-row";

    var label = document.createElement("label");
    label.className = "ge-property-label";
    label.textContent = "Transform";
    section.appendChild(label);

    // Position
    this._renderVec3Input(section, "Position", node.position, function (vals) {
      self.callInspector("updateNodeTransform", [node.id, { position: vals }]);
    });

    // Rotation
    this._renderVec4Input(section, "Rotation (quat)", node.rotation, function (vals) {
      self.callInspector("updateNodeTransform", [node.id, { rotation: vals }]);
    });

    // Scale
    this._renderVec3Input(section, "Scale", node.scale, function (vals) {
      self.callInspector("updateNodeTransform", [node.id, { scale: vals }]);
    });

    this.inspectorEl.appendChild(section);
  };

  InspectorV2.prototype._renderVec3Input = function (parent, label, values, onChange) {
    var row = document.createElement("div");
    row.style.marginBottom = "4px";

    var lbl = document.createElement("label");
    lbl.className = "ge-property-label";
    lbl.textContent = label;
    row.appendChild(lbl);

    var container = document.createElement("div");
    container.style.display = "flex";
    container.style.gap = "4px";

    var axes = ["X", "Y", "Z"];
    var inputs = [];
    for (var i = 0; i < 3; i++) {
      var input = document.createElement("input");
      input.type = "number";
      input.className = "ge-property-input";
      input.step = 0.01;
      input.style.flex = "1";
      input.value = values ? (values[i] || 0) : 0;
      inputs.push(input);
      container.appendChild(input);
    }

    inputs.forEach(function (inp, idx) {
      inp.addEventListener("change", function () {
        var vals = inputs.map(function (i) { return parseFloat(i.value) || 0; });
        onChange(vals);
      });
    });

    row.appendChild(container);
    parent.appendChild(row);
  };

  InspectorV2.prototype._renderVec4Input = function (parent, label, values, onChange) {
    var row = document.createElement("div");
    row.style.marginBottom = "4px";

    var lbl = document.createElement("label");
    lbl.className = "ge-property-label";
    lbl.textContent = label;
    row.appendChild(lbl);

    var container = document.createElement("div");
    container.style.display = "flex";
    container.style.gap = "4px";

    var axes = ["X", "Y", "Z", "W"];
    var inputs = [];
    for (var i = 0; i < 4; i++) {
      var input = document.createElement("input");
      input.type = "number";
      input.className = "ge-property-input";
      input.step = 0.001;
      input.style.flex = "1";
      input.value = values ? (values[i] || 0) : 0;
      inputs.push(input);
      container.appendChild(input);
    }

    inputs.forEach(function (inp, idx) {
      inp.addEventListener("change", function () {
        var vals = inputs.map(function (i) { return parseFloat(i.value) || 0; });
        onChange(vals);
      });
    });

    row.appendChild(container);
    parent.appendChild(row);
  };

  InspectorV2.prototype._renderMaterialSection = function (node) {
    var section = document.createElement("div");
    section.className = "ge-property-row";

    var label = document.createElement("label");
    label.className = "ge-property-label";
    label.textContent = "Material";
    section.appendChild(label);

    var info = document.createElement("div");
    info.style.fontSize = "11px";
    info.style.color = "#aaaacc";
    info.style.padding = "4px 0";
    info.textContent = "Material info available when API supports getMaterialInfo";
    section.appendChild(info);

    // Edit in Material Editor button
    var btnEdit = document.createElement("button");
    btnEdit.className = "ge-toolbar-btn";
    btnEdit.textContent = "Edit in Material Editor";
    btnEdit.style.marginTop = "4px";
    btnEdit.addEventListener("click", function () {
      // Switch to material editor tab
      var btn = document.getElementById("btn-view-material");
      if (btn) btn.click();
    });
    section.appendChild(btnEdit);

    this.inspectorEl.appendChild(section);
  };

  InspectorV2.prototype._renderMeshSection = function (node) {
    var section = document.createElement("div");
    section.className = "ge-property-row";

    var label = document.createElement("label");
    label.className = "ge-property-label";
    label.textContent = "Mesh";
    section.appendChild(label);

    var info = document.createElement("div");
    info.style.fontSize = "11px";
    info.style.color = "#aaaacc";
    info.style.padding = "4px 0";
    if (node.modelFormat) {
      info.textContent = "Format: " + node.modelFormat;
      var br = document.createElement("br");
      info.appendChild(br);
      info.appendChild(document.createTextNode("Meshes: (load to view)"));
    } else {
      info.textContent = "No mesh data available";
    }
    section.appendChild(info);

    this.inspectorEl.appendChild(section);
  };

  // ─── Debug Mode ──────────────────────────────────────────────────────

  InspectorV2.prototype.setDebugMode = function (mode) {
    this.debugMode = mode;
    var code = "(function(){ var s = window.__sceneInspector;" +
      " if (!s || typeof s.setDebugMode !== 'function') return null;" +
      " s.setDebugMode(" + JSON.stringify(mode) + "); })()";
    this.evalInPage(code, function () {});
  };

  // ─── Frame Capture ───────────────────────────────────────────────────

  InspectorV2.prototype.captureFrame = function () {
    var self = this;
    this.callInspector("getFrameGraph").then(function (response) {
      if (response.err || !response.result) return;
      var frame = {
        timestamp: Date.now(),
        frameGraph: response.result,
        passTimings: null,
      };
      self.frameHistory.push(frame);
      if (self.frameHistory.length > self.maxFrameHistory) {
        self.frameHistory.shift();
      }
      self._renderFrameInfo();
    });
  };

  InspectorV2.prototype.stepFrame = function (direction) {
    // Frame stepping is conceptual — we navigate captured frame history
    if (this.frameHistory.length === 0) return;
    this._frameIndex = (this._frameIndex || 0) + direction;
    this._frameIndex = Math.max(0, Math.min(this.frameHistory.length - 1, this._frameIndex));
    this._renderFrameInfo();
  };

  InspectorV2.prototype._renderFrameInfo = function () {
    // Show frame info in inspector
    if (this.frameHistory.length === 0) return;
    var idx = this._frameIndex || (this.frameHistory.length - 1);
    var frame = this.frameHistory[idx];
    if (!frame) return;

    // Create or update frame info panel
    var existing = document.getElementById("iv2-frame-info");
    if (existing) existing.remove();

    var panel = document.createElement("div");
    panel.id = "iv2-frame-info";
    panel.className = "ge-warning-panel";
    panel.style.margin = "8px 0";

    var title = document.createElement("div");
    title.className = "ge-error-panel-title";
    title.textContent = "Frame " + idx + "/" + (this.frameHistory.length - 1);
    panel.appendChild(title);

    if (frame.frameGraph && frame.frameGraph.passes) {
      frame.frameGraph.passes.forEach(function (pass) {
        var item = document.createElement("div");
        item.className = "ge-error-item";
        item.textContent = "• " + pass.name + " (" + pass.type + ")";
        panel.appendChild(item);
      });
    }

    this.inspectorEl.insertBefore(panel, this.inspectorEl.firstChild);
  };

  InspectorV2.prototype.destroy = function () {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.setDebugMode("none");
    this.root.remove();
  };

  global.InspectorV2 = InspectorV2;
})(typeof window !== "undefined" ? window : this);
