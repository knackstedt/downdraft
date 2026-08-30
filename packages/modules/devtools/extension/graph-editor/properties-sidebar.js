// ============================================================================
// PropertiesSidebar — Editable properties panel for the selected graph node
// ============================================================================

(function (global) {
  "use strict";

  function PropertiesSidebar(container, graphEditor) {
    this.container = container;
    this.graphEditor = graphEditor;
    this.currentNode = null;
    this._buildDOM();

    var self = this;
    this.graphEditor.onSelectNode = function (node) {
      self.showNode(node);
    };
  }

  PropertiesSidebar.prototype._buildDOM = function () {
    this.root = document.createElement("div");
    this.root.className = "ge-properties";

    var header = document.createElement("div");
    header.className = "ge-properties-header";
    header.textContent = "Properties";

    this.body = document.createElement("div");
    this.body.className = "ge-properties-body";

    this.emptyState = document.createElement("div");
    this.emptyState.className = "ge-empty-properties";
    this.emptyState.textContent = "Select a node to edit properties";
    this.body.appendChild(this.emptyState);

    this.root.appendChild(header);
    this.root.appendChild(this.body);
    this.container.appendChild(this.root);
  };

  PropertiesSidebar.prototype.showNode = function (node) {
    this.currentNode = node;
    this.body.innerHTML = "";

    if (!node) {
      var empty = document.createElement("div");
      empty.className = "ge-empty-properties";
      empty.textContent = "Select a node to edit properties";
      this.body.appendChild(empty);
      return;
    }

    var def = this.graphEditor.nodeRegistry[node.type];
    if (!def || !def.properties || def.properties.length === 0) {
      var noProps = document.createElement("div");
      noProps.className = "ge-empty-properties";
      noProps.textContent = "No editable properties";
      this.body.appendChild(noProps);
      return;
    }

    var self = this;

    // Node type label
    var typeLabel = document.createElement("div");
    typeLabel.className = "ge-property-label";
    typeLabel.textContent = "Type: " + node.type;
    this.body.appendChild(typeLabel);

    // Separator
    var sep = document.createElement("hr");
    sep.style.border = "none";
    sep.style.borderTop = "1px solid #333355";
    sep.style.margin = "6px 0";
    this.body.appendChild(sep);

    def.properties.forEach(function (propDef) {
      var row = self._createPropertyRow(node, propDef);
      self.body.appendChild(row);
    });
  };

  PropertiesSidebar.prototype._createPropertyRow = function (node, propDef) {
    var self = this;
    var row = document.createElement("div");
    row.className = "ge-property-row";

    var label = document.createElement("label");
    label.className = "ge-property-label";
    label.textContent = propDef.label || propDef.name;
    row.appendChild(label);

    var value = node.properties[propDef.name];

    switch (propDef.type) {
      case "float":
      case "number":
        if (propDef.min !== undefined && propDef.max !== undefined) {
          var slider = document.createElement("input");
          slider.type = "range";
          slider.className = "ge-property-slider";
          slider.min = propDef.min;
          slider.max = propDef.max;
          slider.step = propDef.step || 0.01;
          slider.value = value !== null ? value : (propDef.default || 0);
          slider.addEventListener("input", function () {
            var v = parseFloat(slider.value);
            node.properties[propDef.name] = v;
            if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
          });
          slider.addEventListener("change", function () {
            self.graphEditor._pushHistory();
          });
          row.appendChild(slider);

          var valLabel = document.createElement("span");
          valLabel.className = "ge-property-label";
          valLabel.style.fontSize = "10px";
          valLabel.textContent = (value !== null ? value : (propDef.default || 0)).toFixed(2);
          slider.addEventListener("input", function () {
            valLabel.textContent = parseFloat(slider.value).toFixed(2);
          });
          row.appendChild(valLabel);
        } else {
          var input = document.createElement("input");
          input.type = "number";
          input.className = "ge-property-input";
          input.step = propDef.step || 0.01;
          input.value = value !== null ? value : (propDef.default || 0);
          input.addEventListener("change", function () {
            var v = parseFloat(input.value);
            node.properties[propDef.name] = v;
            self.graphEditor._pushHistory();
            if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
          });
          row.appendChild(input);
        }
        break;

      case "int":
      case "integer":
        var intInput = document.createElement("input");
        intInput.type = "number";
        intInput.className = "ge-property-input";
        intInput.step = 1;
        intInput.value = value !== null ? value : (propDef.default || 0);
        intInput.addEventListener("change", function () {
          var v = parseInt(intInput.value, 10);
          node.properties[propDef.name] = v;
          self.graphEditor._pushHistory();
          if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
        });
        row.appendChild(intInput);
        break;

      case "string":
      case "text":
        var textInput = document.createElement("input");
        textInput.type = "text";
        textInput.className = "ge-property-input";
        textInput.value = value !== null ? value : (propDef.default || "");
        textInput.addEventListener("change", function () {
          node.properties[propDef.name] = textInput.value;
          self.graphEditor._pushHistory();
          if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
        });
        row.appendChild(textInput);
        break;

      case "bool":
      case "boolean":
        var checkRow = document.createElement("div");
        checkRow.className = "ge-property-checkbox-row";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "ge-property-checkbox";
        checkbox.checked = !!value;
        checkbox.addEventListener("change", function () {
          node.properties[propDef.name] = checkbox.checked;
          self.graphEditor._pushHistory();
          if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
        });
        checkRow.appendChild(checkbox);
        row.appendChild(checkRow);
        break;

      case "color":
        var colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "ge-property-color";
        var colorVal = value;
        if (Array.isArray(colorVal)) {
          var hex = "#";
          for (var ci = 0; ci < 3; ci++) {
            var cv = Math.round((colorVal[ci] || 0) * 255);
            hex += cv.toString(16).padStart(2, "0");
          }
          colorInput.value = hex;
        } else if (typeof colorVal === "string") {
          colorInput.value = colorVal;
        } else {
          colorInput.value = "#ffffff";
        }
        colorInput.addEventListener("change", function () {
          var hex = colorInput.value;
          var r = parseInt(hex.slice(1, 3), 16) / 255;
          var g = parseInt(hex.slice(3, 5), 16) / 255;
          var b = parseInt(hex.slice(5, 7), 16) / 255;
          node.properties[propDef.name] = [r, g, b, 1.0];
          self.graphEditor._pushHistory();
          if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
        });
        row.appendChild(colorInput);
        break;

      case "vec3":
        var vec3Container = document.createElement("div");
        vec3Container.style.display = "flex";
        vec3Container.style.gap = "4px";
        var axes = ["x", "y", "z"];
        axes.forEach(function (axis, ai) {
          var vecInput = document.createElement("input");
          vecInput.type = "number";
          vecInput.className = "ge-property-input";
          vecInput.step = 0.01;
          vecInput.style.flex = "1";
          vecInput.value = Array.isArray(value) ? (value[ai] || 0) : 0;
          vecInput.addEventListener("change", function () {
            if (!Array.isArray(node.properties[propDef.name])) {
              node.properties[propDef.name] = [0, 0, 0];
            }
            node.properties[propDef.name][ai] = parseFloat(vecInput.value);
            self.graphEditor._pushHistory();
            if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
          });
          vec3Container.appendChild(vecInput);
        });
        row.appendChild(vec3Container);
        break;

      case "vec4":
        var vec4Container = document.createElement("div");
        vec4Container.style.display = "flex";
        vec4Container.style.gap = "4px";
        var axes4 = ["x", "y", "z", "w"];
        axes4.forEach(function (axis, ai) {
          var vecInput = document.createElement("input");
          vecInput.type = "number";
          vecInput.className = "ge-property-input";
          vecInput.step = 0.01;
          vecInput.style.flex = "1";
          vecInput.value = Array.isArray(value) ? (value[ai] || 0) : 0;
          vecInput.addEventListener("change", function () {
            if (!Array.isArray(node.properties[propDef.name])) {
              node.properties[propDef.name] = [0, 0, 0, 1];
            }
            node.properties[propDef.name][ai] = parseFloat(vecInput.value);
            self.graphEditor._pushHistory();
            if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
          });
          vec4Container.appendChild(vecInput);
        });
        row.appendChild(vec4Container);
        break;

      case "select":
      case "enum":
        var select = document.createElement("select");
        select.className = "ge-property-select";
        (propDef.options || []).forEach(function (opt) {
          var option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label;
          if (value === opt.value) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener("change", function () {
          node.properties[propDef.name] = select.value;
          self.graphEditor._pushHistory();
          if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
        });
        row.appendChild(select);
        break;

      default:
        var genericInput = document.createElement("input");
        genericInput.type = "text";
        genericInput.className = "ge-property-input";
        genericInput.value = value !== null ? String(value) : "";
        genericInput.addEventListener("change", function () {
          node.properties[propDef.name] = genericInput.value;
          self.graphEditor._pushHistory();
          if (self.graphEditor.onGraphChanged) self.graphEditor.onGraphChanged();
        });
        row.appendChild(genericInput);
    }

    return row;
  };

  PropertiesSidebar.prototype.destroy = function () {
    this.root.remove();
  };

  global.PropertiesSidebar = PropertiesSidebar;
})(typeof window !== "undefined" ? window : this);
