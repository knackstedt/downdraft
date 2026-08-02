// ============================================================================
// GraphEditor — Reusable node graph editor component
// Canvas 2D for viewport (pan/zoom/connections), DOM for node cards.
// Used by Material Editor, Render Graph Editor, and Particle Editor.
// ============================================================================

(function (global) {
  "use strict";

  var PORT_COLORS = {
    float: "#5b9bd5",
    vec2: "#7bd55b",
    vec3: "#d5a55b",
    vec4: "#d55b9b",
    texture: "#9b5bd5",
    sampler: "#5bd5c4",
    bool: "#d5d55b",
    int: "#d57b5b",
    pass: "#d5d5d5",
    textureHandle: "#c4a5d5",
    string: "#a5d5c4",
    any: "#888888",
  };

  var NODE_HEADER_COLORS = {
    input: "#4a7a4a",
    constant: "#555588",
    texture: "#885544",
    math: "#4466aa",
    pbr: "#aa6644",
    lighting: "#aa8844",
    output: "#884444",
    spawn: "#448844",
    initialize: "#448888",
    update: "#884488",
    render: "#444488",
    lifetime: "#884444",
    pass: "#446688",
    utility: "#666666",
    default: "#444444",
  };

  var GRID_SIZE = 20;
  var PORT_RADIUS = 6;
  var NODE_MIN_WIDTH = 160;
  var NODE_HEADER_HEIGHT = 28;
  var PORT_SPACING = 22;
  var PORT_START_Y = NODE_HEADER_HEIGHT + 14;
  var BEZIER_OFFSET = 50;

  function getPortColor(type) {
    return PORT_COLORS[type] || PORT_COLORS.any;
  }

  function getHeaderColor(category) {
    return NODE_HEADER_COLORS[category] || NODE_HEADER_COLORS.default;
  }

  function uid() {
    return "n_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // ─── GraphEditor ──────────────────────────────────────────────────────

  function GraphEditor(container, options) {
    this.container = container;
    this.options = options || {};

    this.nodes = new Map();       // id → NodeData
    this.connections = [];        // [{ id, fromNode, fromPort, toNode, toPort }]
    this.selectedNodeId = null;
    this.selectedConnectionId = null;
    this.nodeRegistry = options.nodeTypes || {};

    // Viewport state
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.minZoom = 0.25;
    this.maxZoom = 3;

    // Interaction state
    this.draggingNode = null;
    this.dragOffset = { x: 0, y: 0 };
    this.connecting = null;       // { nodeId, portName, portType, isOutput, x, y }
    this.panning = null;          // { startX, startY, startPanX, startPanY }
    this.marquee = null;          // { startX, startY, endX, endY }

    // History (undo/redo)
    this.history = [];
    this.historyIndex = -1;
    this.maxHistory = 50;

    // Callbacks
    this.onSelectNode = null;
    this.onGraphChanged = null;
    this.onConnectionCreated = null;
    this.onConnectionRemoved = null;
    this.onNodeAdded = null;
    this.onNodeRemoved = null;

    // Multi-select
    this.selectedNodeIds = new Set();

    // Clipboard
    this.clipboard = null;

    // Port element map for hit testing
    this._portPositions = new Map(); // nodeId → Map(portName → { x, y, type, isOutput })

    // Build DOM
    this._buildDOM();
    this._bindEvents();
    this._renderLoop();
  }

  GraphEditor.prototype._buildDOM = function () {
    var root = document.createElement("div");
    root.className = "ge-root";

    // Canvas for connections + grid
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ge-canvas";
    this.ctx = this.canvas.getContext("2d");

    // Node layer (DOM elements positioned absolutely)
    this.nodeLayer = document.createElement("div");
    this.nodeLayer.className = "ge-node-layer";

    // Connection overlay (temp connection while dragging)
    this.overlayCanvas = document.createElement("canvas");
    this.overlayCanvas.className = "ge-overlay-canvas";
    this.overlayCtx = this.overlayCanvas.getContext("2d");

    root.appendChild(this.canvas);
    root.appendChild(this.nodeLayer);
    root.appendChild(this.overlayCanvas);
    this.container.appendChild(root);

    this.root = root;
    this._resizeCanvas();
  };

  GraphEditor.prototype._resizeCanvas = function () {
    var rect = this.root.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.overlayCanvas.width = rect.width * dpr;
    this.overlayCanvas.height = rect.height * dpr;
    this.overlayCanvas.style.width = rect.width + "px";
    this.overlayCanvas.style.height = rect.height + "px";
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._viewportWidth = rect.width;
    this._viewportHeight = rect.height;
  };

  GraphEditor.prototype._bindEvents = function () {
    var self = this;

    // Resize observer
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(function () { self._resizeCanvas(); });
      this._resizeObserver.observe(this.root);
    } else {
      window.addEventListener("resize", function () { self._resizeCanvas(); });
    }

    // Canvas mouse events
    this.canvas.addEventListener("mousedown", function (e) { self._onCanvasMouseDown(e); });
    this.overlayCanvas.addEventListener("mousedown", function (e) { self._onCanvasMouseDown(e); });
    window.addEventListener("mousemove", function (e) { self._onMouseMove(e); });
    window.addEventListener("mouseup", function (e) { self._onMouseUp(e); });

    // Wheel zoom
    this.canvas.addEventListener("wheel", function (e) { self._onWheel(e); }, { passive: false });

    // Keyboard
    this.root.addEventListener("keydown", function (e) { self._onKeyDown(e); });
    this.root.tabIndex = 0;

    // Right-click context menu
    this.canvas.addEventListener("contextmenu", function (e) { self._onContextMenu(e); });
    this.overlayCanvas.addEventListener("contextmenu", function (e) { self._onContextMenu(e); });
  };

  // ─── Coordinate conversion ────────────────────────────────────────────

  GraphEditor.prototype.screenToGraph = function (sx, sy) {
    var rect = this.canvas.getBoundingClientRect();
    return {
      x: (sx - rect.left - this.panX) / this.zoom,
      y: (sy - rect.top - this.panY) / this.zoom,
    };
  };

  GraphEditor.prototype.graphToScreen = function (gx, gy) {
    var rect = this.canvas.getBoundingClientRect();
    return {
      x: gx * this.zoom + this.panX + rect.left,
      y: gy * this.zoom + this.panY + rect.top,
    };
  };

  // ─── Node management ──────────────────────────────────────────────────

  GraphEditor.prototype.addNode = function (type, gx, gy, properties) {
    var def = this.nodeRegistry[type];
    if (!def) {
      console.error("[GraphEditor] Unknown node type:", type);
      return null;
    }

    var id = uid();
    var node = {
      id: id,
      type: type,
      category: def.category || "default",
      label: def.label || type,
      x: gx,
      y: gy,
      width: def.width || NODE_MIN_WIDTH,
      properties: properties || this._defaultProperties(def),
    };

    // Deep clone inputs/outputs from definition
    node.inputs = (def.inputs || []).map(function (p) {
      return { name: p.name, type: p.type, optional: !!p.optional };
    });
    node.outputs = (def.outputs || []).map(function (p) {
      return { name: p.name, type: p.type };
    });

    // Calculate height based on port count
    var maxPorts = Math.max(node.inputs.length, node.outputs.length);
    node.height = NODE_HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 10;

    this.nodes.set(id, node);
    this._createNodeElement(node);
    this._pushHistory();
    if (this.onNodeAdded) this.onNodeAdded(node);
    if (this.onGraphChanged) this.onGraphChanged();
    return node;
  };

  GraphEditor.prototype._defaultProperties = function (def) {
    var props = {};
    if (def.properties) {
      for (var i = 0; i < def.properties.length; i++) {
        var p = def.properties[i];
        props[p.name] = p.default !== undefined ? p.default : null;
      }
    }
    return props;
  };

  GraphEditor.prototype.removeNode = function (id) {
    var node = this.nodes.get(id);
    if (!node) return;

    // Remove connections to/from this node
    var self = this;
    this.connections = this.connections.filter(function (c) {
      if (c.fromNode === id || c.toNode === id) {
        if (self.onConnectionRemoved) self.onConnectionRemoved(c);
        return false;
      }
      return true;
    });

    // Remove DOM element
    var el = document.getElementById("ge-node-" + id);
    if (el) el.remove();

    this.nodes.delete(id);
    this._portPositions.delete(id);

    if (this.selectedNodeId === id) {
      this.selectedNodeId = null;
      if (this.onSelectNode) this.onSelectNode(null);
    }
    this.selectedNodeIds.delete(id);

    this._pushHistory();
    if (this.onNodeRemoved) this.onNodeRemoved(node);
    if (this.onGraphChanged) this.onGraphChanged();
  };

  GraphEditor.prototype.selectNode = function (id) {
    // Clear previous selection highlight
    if (this.selectedNodeId) {
      var prevEl = document.getElementById("ge-node-" + this.selectedNodeId);
      if (prevEl) prevEl.classList.remove("selected");
    }

    this.selectedNodeId = id;
    this.selectedConnectionId = null;

    if (id) {
      var el = document.getElementById("ge-node-" + id);
      if (el) el.classList.add("selected");
    }

    if (this.onSelectNode) {
      this.onSelectNode(id ? this.nodes.get(id) : null);
    }
  };

  GraphEditor.prototype.updateNodeProperty = function (nodeId, propName, value) {
    var node = this.nodes.get(nodeId);
    if (!node) return;
    node.properties[propName] = value;
    this._pushHistory();
    if (this.onGraphChanged) this.onGraphChanged();
  };

  // ─── Connection management ────────────────────────────────────────────

  GraphEditor.prototype.connect = function (fromNode, fromPort, toNode, toPort) {
    // Validate: no duplicate connections to same input
    for (var i = 0; i < this.connections.length; i++) {
      if (this.connections[i].toNode === toNode && this.connections[i].toPort === toPort) {
        return null;
      }
    }

    // Validate: no self-connection
    if (fromNode === toNode) return null;

    // Validate: types compatible (check registry)
    var fromNodeData = this.nodes.get(fromNode);
    var toNodeData = this.nodes.get(toNode);
    if (!fromNodeData || !toNodeData) return null;

    var fromDef = this.nodeRegistry[fromNodeData.type];
    var toDef = this.nodeRegistry[toNodeData.type];
    if (!fromDef || !toDef) return null;

    var fromPortDef = (fromDef.outputs || []).find(function (p) { return p.name === fromPort; });
    var toPortDef = (toDef.inputs || []).find(function (p) { return p.name === toPort; });
    if (!fromPortDef || !toPortDef) return null;

    // Type check (allow 'any' to connect to anything)
    if (fromPortDef.type !== toPortDef.type && fromPortDef.type !== "any" && toPortDef.type !== "any") {
      return null;
    }

    var conn = {
      id: "c_" + Math.random().toString(36).slice(2, 10),
      fromNode: fromNode,
      fromPort: fromPort,
      toNode: toNode,
      toPort: toPort,
    };

    this.connections.push(conn);
    this._pushHistory();
    if (this.onConnectionCreated) this.onConnectionCreated(conn);
    if (this.onGraphChanged) this.onGraphChanged();
    return conn;
  };

  GraphEditor.prototype.disconnect = function (connectionId) {
    var self = this;
    this.connections = this.connections.filter(function (c) {
      if (c.id === connectionId) {
        if (self.onConnectionRemoved) self.onConnectionRemoved(c);
        return false;
      }
      return true;
    });
    this._pushHistory();
    if (this.onGraphChanged) this.onGraphChanged();
  };

  // ─── Node DOM element creation ────────────────────────────────────────

  GraphEditor.prototype._createNodeElement = function (node) {
    var self = this;
    var el = document.createElement("div");
    el.className = "ge-node";
    el.id = "ge-node-" + node.id;
    el.style.left = node.x + "px";
    el.style.top = node.y + "px";
    el.style.width = node.width + "px";

    var headerColor = getHeaderColor(node.category);
    var header = document.createElement("div");
    header.className = "ge-node-header";
    header.style.backgroundColor = headerColor;
    header.textContent = node.label;
    el.appendChild(header);

    // Body with ports
    var body = document.createElement("div");
    body.className = "ge-node-body";

    var inputsCol = document.createElement("div");
    inputsCol.className = "ge-node-inputs";
    var outputsCol = document.createElement("div");
    outputsCol.className = "ge-node-outputs";

    var portMap = new Map();

    for (var i = 0; i < node.inputs.length; i++) {
      var inp = node.inputs[i];
      var portEl = this._createPortElement(node.id, inp, false);
      inputsCol.appendChild(portEl);
      portMap.set("in_" + inp.name, { el: portEl, name: inp.name, type: inp.type, isOutput: false });
    }

    for (var j = 0; j < node.outputs.length; j++) {
      var out = node.outputs[j];
      var outPortEl = this._createPortElement(node.id, out, true);
      outputsCol.appendChild(outPortEl);
      portMap.set("out_" + out.name, { el: outPortEl, name: out.name, type: out.type, isOutput: true });
    }

    body.appendChild(inputsCol);
    body.appendChild(outputsCol);
    el.appendChild(body);

    this.nodeLayer.appendChild(el);

    // Store port positions for hit testing (updated in render)
    this._portPositions.set(node.id, portMap);

    // Node drag
    header.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      e.preventDefault();
      self.selectNode(node.id);
      self.draggingNode = node.id;
      var graphPt = self.screenToGraph(e.clientX, e.clientY);
      self.dragOffset = { x: graphPt.x - node.x, y: graphPt.y - node.y };
    });
  };

  GraphEditor.prototype._createPortElement = function (nodeId, port, isOutput) {
    var self = this;
    var wrapper = document.createElement("div");
    wrapper.className = "ge-port-wrapper" + (isOutput ? " ge-port-output" : "");

    var dot = document.createElement("div");
    dot.className = "ge-port-dot";
    dot.style.backgroundColor = getPortColor(port.type);
    dot.dataset.nodeId = nodeId;
    dot.dataset.portName = port.name;
    dot.dataset.portType = port.type;
    dot.dataset.isOutput = isOutput ? "true" : "false";

    var label = document.createElement("span");
    label.className = "ge-port-label";
    label.textContent = port.name;

    if (isOutput) {
      wrapper.appendChild(label);
      wrapper.appendChild(dot);
    } else {
      wrapper.appendChild(dot);
      wrapper.appendChild(label);
    }

    // Port drag for connecting
    dot.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      e.preventDefault();
      var rect = dot.getBoundingClientRect();
      self.connecting = {
        nodeId: nodeId,
        portName: port.name,
        portType: port.type,
        isOutput: isOutput,
        startX: rect.left + rect.width / 2,
        startY: rect.top + rect.height / 2,
      };
    });

    // Port mouseup for completing connection
    dot.addEventListener("mouseup", function (e) {
      if (!self.connecting) return;
      e.stopPropagation();

      var otherNodeId = dot.dataset.nodeId;
      var otherPortName = dot.dataset.portName;
      var otherIsOutput = dot.dataset.isOutput === "true";

      // Must connect output → input (one must be output, other must be input)
      if (self.connecting.isOutput && !otherIsOutput) {
        self.connect(self.connecting.nodeId, self.connecting.portName, otherNodeId, otherPortName);
      } else if (!self.connecting.isOutput && otherIsOutput) {
        self.connect(otherNodeId, otherPortName, self.connecting.nodeId, self.connecting.portName);
      }

      self.connecting = null;
    });

    return wrapper;
  };

  // ─── Mouse / interaction handlers ─────────────────────────────────────

  GraphEditor.prototype._onCanvasMouseDown = function (e) {
    if (e.button === 0) {
      // Left click — start panning or marquee select
      this.selectNode(null);
      this.panning = {
        startX: e.clientX,
        startY: e.clientY,
        startPanX: this.panX,
        startPanY: this.panY,
      };
      this.canvas.style.cursor = "grabbing";
    }
  };

  GraphEditor.prototype._onMouseMove = function (e) {
    // Pan
    if (this.panning) {
      this.panX = this.panning.startPanX + (e.clientX - this.panning.startX);
      this.panY = this.panning.startPanY + (e.clientY - this.panning.startY);
      this._updateNodePositions();
      return;
    }

    // Drag node
    if (this.draggingNode) {
      var node = this.nodes.get(this.draggingNode);
      if (node) {
        var graphPt = this.screenToGraph(e.clientX, e.clientY);
        node.x = graphPt.x - this.dragOffset.x;
        node.y = graphPt.y - this.dragOffset.y;

        // Snap to grid
        if (this.options.snapToGrid !== false) {
          node.x = Math.round(node.x / GRID_SIZE) * GRID_SIZE;
          node.y = Math.round(node.y / GRID_SIZE) * GRID_SIZE;
        }

        var el = document.getElementById("ge-node-" + node.id);
        if (el) {
          el.style.left = node.x + "px";
          el.style.top = node.y + "px";
        }
      }
      return;
    }

    // Connecting — draw temp line
    if (this.connecting) {
      this._connectingMouseX = e.clientX;
      this._connectingMouseY = e.clientY;
    }
  };

  GraphEditor.prototype._onMouseUp = function (e) {
    if (this.panning) {
      this.panning = null;
      this.canvas.style.cursor = "default";
    }
    if (this.draggingNode) {
      this.draggingNode = null;
      this._pushHistory();
    }
    if (this.connecting) {
      // Check if released on a port — if not, cancel
      var target = e.target;
      if (!target || !target.classList || !target.classList.contains("ge-port-dot")) {
        this.connecting = null;
      }
    }
  };

  GraphEditor.prototype._onWheel = function (e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    var newZoom = this.zoom * delta;
    newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));

    // Zoom toward mouse position
    var rect = this.canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    var graphX = (mx - this.panX) / this.zoom;
    var graphY = (my - this.panY) / this.zoom;

    this.zoom = newZoom;
    this.panX = mx - graphX * this.zoom;
    this.panY = my - graphY * this.zoom;

    this._updateNodePositions();
  };

  GraphEditor.prototype._onKeyDown = function (e) {
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedNodeId) {
        e.preventDefault();
        this.removeNode(this.selectedNodeId);
      } else if (this.selectedConnectionId) {
        e.preventDefault();
        this.disconnect(this.selectedConnectionId);
        this.selectedConnectionId = null;
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
      e.preventDefault();
      this.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      e.preventDefault();
      this._copySelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      e.preventDefault();
      this._paste();
    }
  };

  GraphEditor.prototype._onContextMenu = function (e) {
    e.preventDefault();
    if (this.options.onContextMenu) {
      var graphPt = this.screenToGraph(e.clientX, e.clientY);
      this.options.onContextMenu(e.clientX, e.clientY, graphPt.x, graphPt.y);
    }
  };

  // ─── Clipboard ────────────────────────────────────────────────────────

  GraphEditor.prototype._copySelected = function () {
    if (!this.selectedNodeId) return;
    var node = this.nodes.get(this.selectedNodeId);
    if (!node) return;
    this.clipboard = {
      type: node.type,
      properties: JSON.parse(JSON.stringify(node.properties)),
    };
  };

  GraphEditor.prototype._paste = function () {
    if (!this.clipboard) return;
    var center = this.screenToGraph(
      this._viewportWidth / 2 + this.canvas.getBoundingClientRect().left,
      this._viewportHeight / 2 + this.canvas.getBoundingClientRect().top,
    );
    this.addNode(this.clipboard.type, center.x + 20, center.y + 20, JSON.parse(JSON.stringify(this.clipboard.properties)));
  };

  // ─── Undo / Redo ──────────────────────────────────────────────────────

  GraphEditor.prototype._pushHistory = function () {
    // Truncate redo history
    this.history = this.history.slice(0, this.historyIndex + 1);

    var snapshot = this._serializeState();
    this.history.push(snapshot);

    if (this.history.length > this.maxHistory) {
      this.history.shift();
    } else {
      this.historyIndex++;
    }
  };

  GraphEditor.prototype._serializeState = function () {
    return {
      nodes: Array.from(this.nodes.values()).map(function (n) {
        return {
          id: n.id,
          type: n.type,
          x: n.x,
          y: n.y,
          properties: JSON.parse(JSON.stringify(n.properties)),
        };
      }),
      connections: this.connections.map(function (c) {
        return { fromNode: c.fromNode, fromPort: c.fromPort, toNode: c.toNode, toPort: c.toPort };
      }),
    };
  };

  GraphEditor.prototype._restoreState = function (state) {
    // Clear current
    var self = this;
    this.nodes.forEach(function (n) {
      var el = document.getElementById("ge-node-" + n.id);
      if (el) el.remove();
    });
    this.nodes.clear();
    this._portPositions.clear();
    this.connections = [];
    this.selectedNodeId = null;

    // Restore nodes
    state.nodes.forEach(function (n) {
      var def = self.nodeRegistry[n.type];
      if (!def) return;
      var node = {
        id: n.id,
        type: n.type,
        category: def.category || "default",
        label: def.label || n.type,
        x: n.x,
        y: n.y,
        width: def.width || NODE_MIN_WIDTH,
        properties: n.properties,
        inputs: (def.inputs || []).map(function (p) { return { name: p.name, type: p.type, optional: !!p.optional }; }),
        outputs: (def.outputs || []).map(function (p) { return { name: p.name, type: p.type }; }),
      };
      var maxPorts = Math.max(node.inputs.length, node.outputs.length);
      node.height = NODE_HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 10;
      self.nodes.set(node.id, node);
      self._createNodeElement(node);
    });

    // Restore connections
    state.connections.forEach(function (c) {
      self.connections.push({
        id: "c_" + Math.random().toString(36).slice(2, 10),
        fromNode: c.fromNode,
        fromPort: c.fromPort,
        toNode: c.toNode,
        toPort: c.toPort,
      });
    });

    if (this.onGraphChanged) this.onGraphChanged();
  };

  GraphEditor.prototype.undo = function () {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this._restoreState(this.history[this.historyIndex]);
  };

  GraphEditor.prototype.redo = function () {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this._restoreState(this.history[this.historyIndex]);
  };

  // ─── Position updates ─────────────────────────────────────────────────

  GraphEditor.prototype._updateNodePositions = function () {
    var self = this;
    this.nodes.forEach(function (node) {
      var el = document.getElementById("ge-node-" + node.id);
      if (el) {
        el.style.left = (node.x * self.zoom + self.panX) + "px";
        el.style.top = (node.y * self.zoom + self.panY) + "px";
        el.style.transform = "scale(" + self.zoom + ")";
        el.style.transformOrigin = "top left";
      }
    });
  };

  // ─── Connection hit testing ───────────────────────────────────────────

  GraphEditor.prototype._hitTestConnection = function (sx, sy) {
    var rect = this.canvas.getBoundingClientRect();
    var mx = sx - rect.left;
    var my = sy - rect.top;

    for (var i = this.connections.length - 1; i >= 0; i--) {
      var conn = this.connections[i];
      var fromPos = this._getPortPosition(conn.fromNode, conn.fromPort, true);
      var toPos = this._getPortPosition(conn.toNode, conn.toPort, false);
      if (!fromPos || !toPos) continue;

      // Convert to screen coords
      var fx = fromPos.x * this.zoom + this.panX;
      var fy = fromPos.y * this.zoom + this.panY;
      var tx = toPos.x * this.zoom + this.panX;
      var ty = toPos.y * this.zoom + this.panY;

      if (this._distToBezier(mx, my, fx, fy, tx, ty) < 8) {
        return conn;
      }
    }
    return null;
  };

  GraphEditor.prototype._distToBezier = function (px, py, x1, y1, x2, y2) {
    // Sample bezier curve and find min distance
    var minDist = Infinity;
    var steps = 20;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var bx = this._bezierX(t, x1, x2);
      var by = this._bezierY(t, y1, y2);
      var dx = px - bx;
      var dy = py - by;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  };

  GraphEditor.prototype._bezierX = function (t, x1, x2) {
    var cx1 = x1 + BEZIER_OFFSET;
    var cx2 = x2 - BEZIER_OFFSET;
    return Math.pow(1 - t, 3) * x1 + 3 * Math.pow(1 - t, 2) * t * cx1 + 3 * (1 - t) * t * t * cx2 + t * t * t * x2;
  };

  GraphEditor.prototype._bezierY = function (t, y1, y2) {
    var cy1 = y1;
    var cy2 = y2;
    return Math.pow(1 - t, 3) * y1 + 3 * Math.pow(1 - t, 2) * t * cy1 + 3 * (1 - t) * t * t * cy2 + t * t * t * y2;
  };

  GraphEditor.prototype._getPortPosition = function (nodeId, portName, isOutput) {
    var portMap = this._portPositions.get(nodeId);
    if (!portMap) return null;

    var key = (isOutput ? "out_" : "in_") + portName;
    var portData = portMap.get(key);
    if (!portData) return null;

    var node = this.nodes.get(nodeId);
    if (!node) return null;

    var el = portData.el;
    var dotEl = el.querySelector(".ge-port-dot");
    if (!dotEl) return null;

    // Get position relative to node
    var nodeEl = document.getElementById("ge-node-" + nodeId);
    if (!nodeEl) return null;

    // Calculate port Y based on index
    var ports = isOutput ? node.outputs : node.inputs;
    var idx = ports.findIndex(function (p) { return p.name === portName; });
    if (idx < 0) return null;

    var portY = PORT_START_Y + idx * PORT_SPACING + PORT_RADIUS;
    var portX = isOutput ? node.width : 0;

    return { x: node.x + portX, y: node.y + portY, type: portData.type };
  };

  // ─── Render loop ──────────────────────────────────────────────────────

  GraphEditor.prototype._renderLoop = function () {
    var self = this;
    function frame() {
      self._render();
      self._rafId = requestAnimationFrame(frame);
    }
    this._rafId = requestAnimationFrame(frame);
  };

  GraphEditor.prototype._render = function () {
    var ctx = this.ctx;
    var w = this._viewportWidth;
    var h = this._viewportHeight;

    ctx.clearRect(0, 0, w, h);

    // Draw grid
    this._drawGrid(ctx, w, h);

    // Draw connections
    this._drawConnections(ctx);

    // Draw temp connection
    if (this.connecting && this._connectingMouseX !== undefined) {
      this._drawTempConnection(ctx);
    }

    // Update port positions for DOM nodes
    this._updateNodePositions();
  };

  GraphEditor.prototype._drawGrid = function (ctx, w, h) {
    var gridSize = GRID_SIZE * this.zoom;
    if (gridSize < 4) return;

    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();

    var offsetX = this.panX % gridSize;
    var offsetY = this.panY % gridSize;

    for (var x = offsetX; x < w; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (var y = offsetY; y < h; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }

    ctx.stroke();
  };

  GraphEditor.prototype._drawConnections = function (ctx) {
    var self = this;
    this.connections.forEach(function (conn) {
      var fromPos = self._getPortPosition(conn.fromNode, conn.fromPort, true);
      var toPos = self._getPortPosition(conn.toNode, conn.toPort, false);
      if (!fromPos || !toPos) return;

      var fx = fromPos.x * self.zoom + self.panX;
      var fy = fromPos.y * self.zoom + self.panY;
      var tx = toPos.x * self.zoom + self.panX;
      var ty = toPos.y * self.zoom + self.panY;

      var color = getPortColor(fromPos.type);
      var isSelected = conn.id === self.selectedConnectionId;

      ctx.strokeStyle = isSelected ? "#ffffff" : color;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.bezierCurveTo(fx + BEZIER_OFFSET, fy, tx - BEZIER_OFFSET, ty, tx, ty);
      ctx.stroke();

      // Draw port dots at endpoints
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(fx, fy, PORT_RADIUS * self.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(tx, ty, PORT_RADIUS * self.zoom, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  GraphEditor.prototype._drawTempConnection = function (ctx) {
    var fromPos, toX, toY;

    if (this.connecting.isOutput) {
      fromPos = this._getPortPosition(this.connecting.nodeId, this.connecting.portName, true);
      if (!fromPos) return;
      toX = this._connectingMouseX - this.canvas.getBoundingClientRect().left;
      toY = this._connectingMouseY - this.canvas.getBoundingClientRect().top;
    } else {
      fromPos = this._getPortPosition(this.connecting.nodeId, this.connecting.portName, false);
      if (!fromPos) return;
      toX = this._connectingMouseX - this.canvas.getBoundingClientRect().left;
      toY = this._connectingMouseY - this.canvas.getBoundingClientRect().top;
      // Swap so bezier goes left→right
      var tmpX = fromPos.x * this.zoom + this.panX;
      var tmpY = fromPos.y * this.zoom + this.panY;
      fromPos = { x: toX / this.zoom, y: toY / this.zoom, type: this.connecting.portType };
      toX = tmpX;
      toY = tmpY;
    }

    var fx = this.connecting.isOutput
      ? fromPos.x * this.zoom + this.panX
      : toX;
    var fy = this.connecting.isOutput
      ? fromPos.y * this.zoom + this.panY
      : toY;

    if (!this.connecting.isOutput) {
      fx = toX;
      fy = toY;
      toX = fromPos.x * this.zoom + this.panX;
      toY = fromPos.y * this.zoom + this.panY;
    }

    var color = getPortColor(this.connecting.portType);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.bezierCurveTo(fx + BEZIER_OFFSET, fy, toX - BEZIER_OFFSET, toY, toX, toY);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // ─── Serialization ────────────────────────────────────────────────────

  GraphEditor.prototype.serializeGraph = function () {
    return {
      nodes: Array.from(this.nodes.values()).map(function (n) {
        return {
          id: n.id,
          type: n.type,
          x: n.x,
          y: n.y,
          properties: JSON.parse(JSON.stringify(n.properties)),
        };
      }),
      connections: this.connections.map(function (c) {
        return {
          fromNode: c.fromNode,
          fromPort: c.fromPort,
          toNode: c.toNode,
          toPort: c.toPort,
        };
      }),
      metadata: {
        version: 1,
        zoom: this.zoom,
        panX: this.panX,
        panY: this.panY,
      },
    };
  };

  GraphEditor.prototype.loadGraph = function (json) {
    var self = this;

    // Clear current
    this.nodes.forEach(function (n) {
      var el = document.getElementById("ge-node-" + n.id);
      if (el) el.remove();
    });
    this.nodes.clear();
    this._portPositions.clear();
    this.connections = [];
    this.selectedNodeId = null;

    // Load nodes
    if (json.nodes) {
      json.nodes.forEach(function (n) {
        var def = self.nodeRegistry[n.type];
        if (!def) {
          console.warn("[GraphEditor] Unknown node type in saved graph:", n.type);
          return;
        }
        var node = {
          id: n.id,
          type: n.type,
          category: def.category || "default",
          label: def.label || n.type,
          x: n.x,
          y: n.y,
          width: def.width || NODE_MIN_WIDTH,
          properties: n.properties || self._defaultProperties(def),
          inputs: (def.inputs || []).map(function (p) { return { name: p.name, type: p.type, optional: !!p.optional }; }),
          outputs: (def.outputs || []).map(function (p) { return { name: p.name, type: p.type }; }),
        };
        var maxPorts = Math.max(node.inputs.length, node.outputs.length);
        node.height = NODE_HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 10;
        self.nodes.set(node.id, node);
        self._createNodeElement(node);
      });
    }

    // Load connections
    if (json.connections) {
      json.connections.forEach(function (c) {
        if (self.nodes.has(c.fromNode) && self.nodes.has(c.toNode)) {
          self.connections.push({
            id: "c_" + Math.random().toString(36).slice(2, 10),
            fromNode: c.fromNode,
            fromPort: c.fromPort,
            toNode: c.toNode,
            toPort: c.toPort,
          });
        }
      });
    }

    // Load viewport
    if (json.metadata) {
      this.zoom = json.metadata.zoom || 1;
      this.panX = json.metadata.panX || 0;
      this.panY = json.metadata.panY || 0;
    }

    this.history = [];
    this.historyIndex = -1;
    this._pushHistory();

    if (this.onGraphChanged) this.onGraphChanged();
  };

  GraphEditor.prototype.clear = function () {
    var self = this;
    this.nodes.forEach(function (n) {
      var el = document.getElementById("ge-node-" + n.id);
      if (el) el.remove();
    });
    this.nodes.clear();
    this._portPositions.clear();
    this.connections = [];
    this.selectedNodeId = null;
    this.history = [];
    this.historyIndex = -1;
    this._pushHistory();
    if (this.onGraphChanged) this.onGraphChanged();
  };

  GraphEditor.prototype.destroy = function () {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this.root.remove();
  };

  GraphEditor.prototype.registerNodeType = function (type, def) {
    this.nodeRegistry[type] = def;
  };

  GraphEditor.prototype.registerNodeTypes = function (types) {
    for (var key in types) {
      this.nodeRegistry[key] = types[key];
    }
  };

  GraphEditor.prototype.getNodes = function () {
    return Array.from(this.nodes.values());
  };

  GraphEditor.prototype.getConnections = function () {
    return this.connections.slice();
  };

  // Export
  global.GraphEditor = GraphEditor;
  global.GE_PORT_COLORS = PORT_COLORS;
  global.GE_NODE_HEADER_COLORS = NODE_HEADER_COLORS;
})(typeof window !== "undefined" ? window : this);
