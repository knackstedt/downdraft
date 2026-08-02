// ============================================================================
// NodePalette — Draggable node catalog sidebar for the GraphEditor
// ============================================================================

(function (global) {
  "use strict";

  function NodePalette(container, graphEditor, nodeRegistry) {
    this.container = container;
    this.graphEditor = graphEditor;
    this.nodeRegistry = nodeRegistry || {};
    this.searchQuery = "";
    this._buildDOM();
    this._bindEvents();
    this.render();
  }

  NodePalette.prototype._buildDOM = function () {
    this.root = document.createElement("div");
    this.root.className = "ge-palette";

    var header = document.createElement("div");
    header.className = "ge-palette-header";
    header.textContent = "Nodes";

    this.searchContainer = document.createElement("div");
    this.searchContainer.className = "ge-palette-search";
    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.placeholder = "Search nodes...";
    this.searchContainer.appendChild(this.searchInput);

    this.listEl = document.createElement("div");
    this.listEl.className = "ge-palette-list";

    this.root.appendChild(header);
    this.root.appendChild(this.searchContainer);
    this.root.appendChild(this.listEl);
    this.container.appendChild(this.root);
  };

  NodePalette.prototype._bindEvents = function () {
    var self = this;
    this.searchInput.addEventListener("input", function () {
      self.searchQuery = self.searchInput.value.toLowerCase();
      self.render();
    });
  };

  NodePalette.prototype.setNodeRegistry = function (registry) {
    this.nodeRegistry = registry;
    this.render();
  };

  NodePalette.prototype.render = function () {
    this.listEl.innerHTML = "";

    // Group by category
    var categories = {};
    for (var type in this.nodeRegistry) {
      var def = this.nodeRegistry[type];
      var cat = def.category || "default";
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ type: type, def: def });
    }

    // Sort categories alphabetically
    var sortedCats = Object.keys(categories).sort();
    var self = this;

    sortedCats.forEach(function (cat) {
      // Filter by search
      var items = categories[cat].filter(function (item) {
        if (!self.searchQuery) return true;
        var label = (item.def.label || item.type).toLowerCase();
        return label.indexOf(self.searchQuery) >= 0 || item.type.toLowerCase().indexOf(self.searchQuery) >= 0;
      });

      if (items.length === 0) return;

      var catEl = document.createElement("div");
      catEl.className = "ge-palette-category";
      catEl.textContent = cat;
      self.listEl.appendChild(catEl);

      items.forEach(function (item) {
        var el = document.createElement("div");
        el.className = "ge-palette-item";
        el.textContent = item.def.label || item.type;
        el.draggable = true;
        el.dataset.nodeType = item.type;

        // Color dot
        var icon = document.createElement("span");
        icon.className = "ge-palette-item-icon";
        var headerColors = global.GE_NODE_HEADER_COLORS || {};
        icon.style.backgroundColor = headerColors[item.def.category] || headerColors.default || "#444444";
        el.insertBefore(icon, el.firstChild);

        // Drag start
        el.addEventListener("dragstart", function (e) {
          e.dataTransfer.setData("text/node-type", item.type);
          e.dataTransfer.effectAllowed = "copy";
        });

        // Click to add at center
        el.addEventListener("click", function () {
          var rect = self.graphEditor.root.getBoundingClientRect();
          var center = self.graphEditor.screenToGraph(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          var node = self.graphEditor.addNode(item.type, center.x, center.y);
          if (node) self.graphEditor.selectNode(node.id);
        });

        self.listEl.appendChild(el);
      });
    });
  };

  NodePalette.prototype.destroy = function () {
    this.root.remove();
  };

  global.NodePalette = NodePalette;
})(typeof window !== "undefined" ? window : this);
