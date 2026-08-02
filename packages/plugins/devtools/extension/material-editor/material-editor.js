// ============================================================================
// MaterialEditor — Node Material Editor panel for DevTools
// Uses GraphEditor + NodePalette + PropertiesSidebar + live preview
// Communicates with engine via __sceneInspector API
// ============================================================================

(function (global) {
  "use strict";

  function MaterialEditor(container, helpers) {
    this.container = container;
    this.evalInPage = helpers.evalInPage;
    this.callInspector = helpers.callInspector;
    this.active = false;
    this.graphEditor = null;
    this.palette = null;
    this.properties = null;
    this.previewCanvas = null;
    this.previewCtx = null;
    this.errorPanel = null;
    this.materialName = "graph_material";
    this.blendMode = "opaque";
    this.cullMode = "back";
    this.profile = "pbr";
    this._buildDOM();
    this._initEditor();
  }

  MaterialEditor.prototype._buildDOM = function () {
    var self = this;

    // Main layout: toolbar + (palette | graph editor | properties)
    this.root = document.createElement("div");
    this.root.style.display = "flex";
    this.root.style.flexDirection = "column";
    this.root.style.width = "100%";
    this.root.style.height = "100%";

    // Toolbar
    var toolbar = document.createElement("div");
    toolbar.className = "ge-toolbar";

    var btnCompile = document.createElement("button");
    btnCompile.className = "ge-toolbar-btn";
    btnCompile.textContent = "Compile";
    btnCompile.addEventListener("click", function () { self.compile(); });

    var btnApply = document.createElement("button");
    btnApply.className = "ge-toolbar-btn";
    btnApply.textContent = "Apply to Selected";
    btnApply.addEventListener("click", function () { self.applyToSelected(); });

    var btnSave = document.createElement("button");
    btnSave.className = "ge-toolbar-btn";
    btnSave.textContent = "Save";
    btnSave.addEventListener("click", function () { self.saveToLibrary(); });

    var btnExport = document.createElement("button");
    btnExport.className = "ge-toolbar-btn";
    btnExport.textContent = "Export JSON";
    btnExport.addEventListener("click", function () { self.exportJSON(); });

    var btnImport = document.createElement("button");
    btnImport.className = "ge-toolbar-btn";
    btnImport.textContent = "Import JSON";
    btnImport.addEventListener("click", function () { self.importJSON(); });

    var btnClear = document.createElement("button");
    btnClear.className = "ge-toolbar-btn";
    btnClear.textContent = "Clear";
    btnClear.addEventListener("click", function () {
      if (self.graphEditor) self.graphEditor.clear();
    });

    var sep1 = document.createElement("span");
    sep1.className = "ge-toolbar-separator";

    // Template selector
    var templateLabel = document.createElement("span");
    templateLabel.className = "ge-toolbar-label";
    templateLabel.textContent = "Template:";

    var templateSelect = document.createElement("select");
    templateSelect.className = "ge-property-select";
    templateSelect.style.width = "auto";
    templateSelect.style.fontSize = "11px";
    var defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "— Select —";
    templateSelect.appendChild(defaultOpt);
    for (var key in global.MaterialTemplates) {
      var opt = document.createElement("option");
      opt.value = key;
      opt.textContent = global.MaterialTemplates[key].name;
      templateSelect.appendChild(opt);
    }
    templateSelect.addEventListener("change", function () {
      if (templateSelect.value && global.MaterialTemplates[templateSelect.value]) {
        self.graphEditor.loadGraph(global.MaterialTemplates[templateSelect.value].graph);
        templateSelect.value = "";
      }
    });

    var sep2 = document.createElement("span");
    sep2.className = "ge-toolbar-separator";

    // Blend mode
    var blendLabel = document.createElement("span");
    blendLabel.className = "ge-toolbar-label";
    blendLabel.textContent = "Blend:";
    var blendSelect = document.createElement("select");
    blendSelect.className = "ge-property-select";
    blendSelect.style.width = "auto";
    blendSelect.style.fontSize = "11px";
    ["opaque", "alpha-blend", "alpha-clip", "additive"].forEach(function (mode) {
      var opt = document.createElement("option");
      opt.value = mode;
      opt.textContent = mode;
      blendSelect.appendChild(opt);
    });
    blendSelect.addEventListener("change", function () {
      self.blendMode = blendSelect.value;
    });

    // Cull mode
    var cullLabel = document.createElement("span");
    cullLabel.className = "ge-toolbar-label";
    cullLabel.textContent = "Cull:";
    var cullSelect = document.createElement("select");
    cullSelect.className = "ge-property-select";
    cullSelect.style.width = "auto";
    cullSelect.style.fontSize = "11px";
    ["back", "front", "none"].forEach(function (mode) {
      var opt = document.createElement("option");
      opt.value = mode;
      opt.textContent = mode;
      cullSelect.appendChild(opt);
    });
    cullSelect.addEventListener("change", function () {
      self.cullMode = cullSelect.value;
    });

    toolbar.appendChild(btnCompile);
    toolbar.appendChild(btnApply);
    toolbar.appendChild(btnSave);
    toolbar.appendChild(btnExport);
    toolbar.appendChild(btnImport);
    toolbar.appendChild(btnClear);
    toolbar.appendChild(sep1);
    toolbar.appendChild(templateLabel);
    toolbar.appendChild(templateSelect);
    toolbar.appendChild(sep2);
    toolbar.appendChild(blendLabel);
    toolbar.appendChild(blendSelect);
    toolbar.appendChild(cullLabel);
    toolbar.appendChild(cullSelect);

    // Content area: palette | graph | properties + preview
    var content = document.createElement("div");
    content.style.display = "flex";
    content.style.flex = "1";
    content.style.overflow = "hidden";

    // Palette container
    var paletteContainer = document.createElement("div");
    paletteContainer.style.position = "relative";
    paletteContainer.style.flexShrink = "0";

    // Graph editor container
    var graphContainer = document.createElement("div");
    graphContainer.style.position = "relative";
    graphContainer.style.flex = "1";
    graphContainer.style.overflow = "hidden";

    // Right sidebar: properties + preview + errors
    var sidebar = document.createElement("div");
    sidebar.style.width = "280px";
    sidebar.style.display = "flex";
    sidebar.style.flexDirection = "column";
    sidebar.style.borderLeft = "1px solid #333355";
    sidebar.style.flexShrink = "0";

    // Properties container
    var propsContainer = document.createElement("div");
    propsContainer.style.position = "relative";
    propsContainer.style.flex = "1";
    propsContainer.style.overflow = "hidden";
    propsContainer.style.minHeight = "200px";

    // Preview
    var previewHeader = document.createElement("div");
    previewHeader.className = "ge-properties-header";
    previewHeader.textContent = "Preview";

    this.previewCanvas = document.createElement("canvas");
    this.previewCanvas.width = 256;
    this.previewCanvas.height = 256;
    this.previewCanvas.style.display = "block";
    this.previewCanvas.style.width = "100%";
    this.previewCanvas.style.height = "200px";
    this.previewCanvas.style.background = "#1a1a2e";

    this.previewCtx = this.previewCanvas.getContext("2d");
    this._drawPreviewPlaceholder();

    // Error panel
    this.errorPanel = document.createElement("div");
    this.errorPanel.style.padding = "8px";
    this.errorPanel.style.overflowY = "auto";
    this.errorPanel.style.maxHeight = "120px";

    sidebar.appendChild(propsContainer);
    sidebar.appendChild(previewHeader);
    sidebar.appendChild(this.previewCanvas);
    sidebar.appendChild(this.errorPanel);

    content.appendChild(paletteContainer);
    content.appendChild(graphContainer);
    content.appendChild(sidebar);

    this.root.appendChild(toolbar);
    this.root.appendChild(content);
    this.container.appendChild(this.root);

    this._paletteContainer = paletteContainer;
    this._graphContainer = graphContainer;
    this._propsContainer = propsContainer;
  };

  MaterialEditor.prototype._initEditor = function () {
    var self = this;

    // Create graph editor with material node types
    this.graphEditor = new global.GraphEditor(this._graphContainer, {
      nodeTypes: global.MaterialNodes,
      snapToGrid: true,
      onContextMenu: function (sx, sy, gx, gy) {
        self._showContextMenu(sx, sy, gx, gy);
      },
    });

    // Wire graph changed callback for live compile
    this.graphEditor.onGraphChanged = function () {
      if (self.active) self.compile();
    };

    // Create palette
    this.palette = new global.NodePalette(this._paletteContainer, this.graphEditor, global.MaterialNodes);

    // Create properties sidebar
    this.properties = new global.PropertiesSidebar(this._propsContainer, this.graphEditor);

    // Handle drag-drop from palette to graph
    this._graphContainer.addEventListener("dragover", function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });

    this._graphContainer.addEventListener("drop", function (e) {
      e.preventDefault();
      var type = e.dataTransfer.getData("text/node-type");
      if (!type) return;
      var rect = self._graphContainer.getBoundingClientRect();
      var pt = self.graphEditor.screenToGraph(e.clientX, e.clientY);
      var node = self.graphEditor.addNode(type, pt.x, pt.y);
      if (node) self.graphEditor.selectNode(node.id);
    });
  };

  MaterialEditor.prototype._showContextMenu = function (sx, sy, gx, gy) {
    var self = this;
    // Remove existing menu
    var existing = document.querySelector(".ge-context-menu");
    if (existing) existing.remove();

    var menu = document.createElement("div");
    menu.className = "ge-context-menu";
    menu.style.left = sx + "px";
    menu.style.top = sy + "px";

    var categories = {};
    for (var type in global.MaterialNodes) {
      var def = global.MaterialNodes[type];
      var cat = def.category || "default";
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ type: type, label: def.label || type });
    }

    Object.keys(categories).sort().forEach(function (cat) {
      var catEl = document.createElement("div");
      catEl.className = "ge-context-menu-category";
      catEl.textContent = cat;
      menu.appendChild(catEl);

      categories[cat].forEach(function (item) {
        var itemEl = document.createElement("div");
        itemEl.className = "ge-context-menu-item";
        itemEl.textContent = item.label;
        itemEl.addEventListener("click", function () {
          var node = self.graphEditor.addNode(item.type, gx, gy);
          if (node) self.graphEditor.selectNode(node.id);
          menu.remove();
        });
        menu.appendChild(itemEl);
      });
    });

    document.body.appendChild(menu);

    // Close on click outside
    setTimeout(function () {
      document.addEventListener("click", function closeMenu() {
        menu.remove();
        document.removeEventListener("click", closeMenu);
      });
    }, 0);
  };

  MaterialEditor.prototype.setActive = function (active) {
    this.active = active;
  };

  // ─── Compile graph to material ──────────────────────────────────────

  MaterialEditor.prototype.compile = function () {
    var self = this;
    var engineFormat = global.GraphSerializer.toEngineFormat(this.graphEditor);
    var validation = global.GraphSerializer.validate(this.graphEditor);

    // Show errors/warnings
    this._showErrors(validation.errors, validation.warnings);

    if (validation.errors.length > 0) return;

    // Send to engine for compilation
    var code = "(function(){ var s = window.__sceneInspector;" +
      " if (!s || typeof s.compileMaterialGraph !== 'function') return JSON.stringify({ errors: ['Material graph API not available'] });" +
      " var r = s.compileMaterialGraph(" + JSON.stringify(engineFormat.nodes) + ", " + JSON.stringify(engineFormat.connections) + ", " +
      JSON.stringify({ blendMode: self.blendMode, cullMode: self.cullMode, profile: self.profile }) + ");" +
      " return JSON.stringify(r); })()";

    this.evalInPage(code, function (result, err) {
      if (err || !result) {
        self._showErrors(["Failed to compile: " + (err || "no response")], []);
        return;
      }
      try {
        var compiled = JSON.parse(result);
        if (compiled.errors && compiled.errors.length > 0) {
          self._showErrors(compiled.errors, compiled.warnings || []);
        } else {
          self._showErrors([], compiled.warnings || []);
          self._compiledWgsl = compiled.wgsl;
          self._drawPreviewCompiled();
        }
      } catch (e) {
        self._showErrors(["Parse error: " + e.message], []);
      }
    });
  };

  MaterialEditor.prototype.applyToSelected = function () {
    var self = this;
    var engineFormat = global.GraphSerializer.toEngineFormat(this.graphEditor);

    var code = "(function(){ var s = window.__sceneInspector;" +
      " if (!s || typeof s.createMaterialFromGraph !== 'function') return JSON.stringify({ success: false, error: 'API not available' });" +
      " var r = s.createMaterialFromGraph(" + JSON.stringify(engineFormat.nodes) + ", " + JSON.stringify(engineFormat.connections) + ", " +
      JSON.stringify({ name: self.materialName, blendMode: self.blendMode, cullMode: self.cullMode, profile: self.profile }) + ");" +
      " return JSON.stringify(r); })()";

    this.evalInPage(code, function (result, err) {
      if (err || !result) {
        self._showErrors(["Failed to create material: " + (err || "no response")], []);
        return;
      }
      try {
        var res = JSON.parse(result);
        if (!res.success) {
          self._showErrors([res.error || "Unknown error"], []);
        } else {
          self._showErrors([], ["Material created: " + res.materialName]);
        }
      } catch (e) {
        self._showErrors(["Parse error: " + e.message], []);
      }
    });
  };

  MaterialEditor.prototype.saveToLibrary = function () {
    var self = this;
    var engineFormat = global.GraphSerializer.toEngineFormat(this.graphEditor);

    var code = "(function(){ var s = window.__sceneInspector;" +
      " if (!s || typeof s.saveMaterialToLibrary !== 'function') return JSON.stringify({ success: false, error: 'API not available' });" +
      " var r = s.saveMaterialToLibrary(" + JSON.stringify(self.materialName) + ", " +
      JSON.stringify({ nodes: engineFormat.nodes, connections: engineFormat.connections, blendMode: self.blendMode, cullMode: self.cullMode }) + ");" +
      " return JSON.stringify(r); })()";

    this.evalInPage(code, function (result, err) {
      if (err || !result) return;
      try {
        var res = JSON.parse(result);
        if (!res.success) self._showErrors([res.error || "Save failed"], []);
        else self._showErrors([], ["Saved to library: " + self.materialName]);
      } catch (e) {}
    });
  };

  MaterialEditor.prototype.exportJSON = function () {
    var data = this.graphEditor.serializeGraph();
    data.materialSettings = {
      blendMode: this.blendMode,
      cullMode: this.cullMode,
      profile: this.profile,
    };
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = this.materialName + ".json";
    a.click();
    URL.revokeObjectURL(url);
  };

  MaterialEditor.prototype.importJSON = function () {
    var self = this;
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var data = JSON.parse(ev.target.result);
          self.graphEditor.loadGraph(data);
          if (data.materialSettings) {
            self.blendMode = data.materialSettings.blendMode || "opaque";
            self.cullMode = data.materialSettings.cullMode || "back";
            self.profile = data.materialSettings.profile || "pbr";
          }
        } catch (e) {
          self._showErrors(["Failed to import: " + e.message], []);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  };

  // ─── Error/warning display ──────────────────────────────────────────

  MaterialEditor.prototype._showErrors = function (errors, warnings) {
    this.errorPanel.innerHTML = "";

    if (errors.length > 0) {
      var errDiv = document.createElement("div");
      errDiv.className = "ge-error-panel";
      var errTitle = document.createElement("div");
      errTitle.className = "ge-error-panel-title";
      errTitle.textContent = "Errors (" + errors.length + ")";
      errDiv.appendChild(errTitle);
      errors.forEach(function (e) {
        var item = document.createElement("div");
        item.className = "ge-error-item";
        item.textContent = e;
        errDiv.appendChild(item);
      });
      this.errorPanel.appendChild(errDiv);
    }

    if (warnings.length > 0) {
      var warnDiv = document.createElement("div");
      warnDiv.className = "ge-warning-panel";
      var warnTitle = document.createElement("div");
      warnTitle.className = "ge-error-panel-title";
      warnTitle.textContent = "Warnings (" + warnings.length + ")";
      warnDiv.appendChild(warnTitle);
      warnings.forEach(function (w) {
        var item = document.createElement("div");
        item.className = "ge-error-item";
        item.textContent = w;
        warnDiv.appendChild(item);
      });
      this.errorPanel.appendChild(warnDiv);
    }
  };

  // ─── Preview rendering ──────────────────────────────────────────────

  MaterialEditor.prototype._drawPreviewPlaceholder = function () {
    var ctx = this.previewCtx;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = "#555577";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Preview", 128, 120);
    ctx.fillText("(compile to see result)", 128, 140);
  };

  MaterialEditor.prototype._drawPreviewCompiled = function () {
    var ctx = this.previewCtx;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, 256, 256);

    // Draw a simple sphere with gradient (placeholder for actual GPU preview)
    if (this._compiledWgsl) {
      ctx.fillStyle = "#4a7a4a";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Compiled WGSL: " + this._compiledWgsl.length + " chars", 128, 128);
    } else {
      this._drawPreviewPlaceholder();
    }
  };

  MaterialEditor.prototype.destroy = function () {
    if (this.graphEditor) this.graphEditor.destroy();
    if (this.palette) this.palette.destroy();
    if (this.properties) this.properties.destroy();
    this.root.remove();
  };

  global.MaterialEditor = MaterialEditor;
})(typeof window !== "undefined" ? window : this);
