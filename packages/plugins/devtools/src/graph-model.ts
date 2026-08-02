// ============================================================================
// GraphModel — Pure logic for node graph editor (no DOM dependencies).
// Extracted from graph-editor.js for testability.
// The browser JS file uses this same logic via a parallel implementation.
// ============================================================================

export interface PortDef {
  name: string;
  type: string;
  optional?: boolean;
}

export interface PropertyDef {
  name: string;
  label?: string;
  type: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface NodeTypeDef {
  label?: string;
  category?: string;
  width?: number;
  inputs?: PortDef[];
  outputs?: PortDef[];
  properties?: PropertyDef[];
}

export interface GraphNode {
  id: string;
  type: string;
  category: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  properties: Record<string, unknown>;
  inputs: PortDef[];
  outputs: PortDef[];
}

export interface GraphConnection {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface SerializedGraph {
  nodes: Array<{ id: string; type: string; x: number; y: number; properties: Record<string, unknown> }>;
  connections: Array<{ fromNode: string; fromPort: string; toNode: string; toPort: string }>;
  metadata?: { version: number; zoom: number; panX: number; panY: number };
}

export interface UINodeData {
  id: string;
  type: string;
  inputs: Array<{ id: string; name: string; type: string }>;
  outputs: Array<{ id: string; name: string; type: string }>;
  properties: Record<string, unknown>;
}

export interface UIConnection {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  valid: boolean;
}

let _idCounter = 0;
function uid(): string {
  _idCounter++;
  return "n_" + _idCounter.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

let _connCounter = 0;
function connId(): string {
  _connCounter++;
  return "c_" + _connCounter.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

const PORT_TYPE_ANY = "any";

const NODE_HEADER_HEIGHT = 28;
const PORT_SPACING = 22;
const PORT_START_Y = NODE_HEADER_HEIGHT + 14;

// ─── GraphModel ──────────────────────────────────────────────────────

export class GraphModel {
  nodes: Map<string, GraphNode> = new Map();
  connections: GraphConnection[] = [];
  nodeRegistry: Record<string, NodeTypeDef> = {};

  constructor(nodeTypes?: Record<string, NodeTypeDef>) {
    if (nodeTypes) this.nodeRegistry = nodeTypes;
  }

  registerNodeType(type: string, def: NodeTypeDef): void {
    this.nodeRegistry[type] = def;
  }

  registerNodeTypes(types: Record<string, NodeTypeDef>): void {
    for (const key in types) this.nodeRegistry[key] = types[key];
  }

  // ─── Node management ──────────────────────────────────────────────

  addNode(type: string, x: number, y: number, properties?: Record<string, unknown>): GraphNode | null {
    const def = this.nodeRegistry[type];
    if (!def) return null;

    const id = uid();
    const node: GraphNode = {
      id,
      type,
      category: def.category || "default",
      label: def.label || type,
      x,
      y,
      width: def.width || 160,
      height: this._calcNodeHeight(def),
      properties: properties || this._defaultProperties(def),
      inputs: (def.inputs || []).map((p) => ({ ...p })),
      outputs: (def.outputs || []).map((p) => ({ ...p })),
    };

    this.nodes.set(id, node);
    return node;
  }

  removeNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    this.connections = this.connections.filter((c) => c.fromNode !== id && c.toNode !== id);
    this.nodes.delete(id);
    return true;
  }

  getNode(id: string): GraphNode | null {
    return this.nodes.get(id) || null;
  }

  getNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getConnections(): GraphConnection[] {
    return this.connections.slice();
  }

  updateNodeProperty(nodeId: string, propName: string, value: unknown): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.properties[propName] = value;
    return true;
  }

  // ─── Connection management ────────────────────────────────────────

  connect(fromNode: string, fromPort: string, toNode: string, toPort: string): GraphConnection | null {
    // No self-connection
    if (fromNode === toNode) return null;

    // Nodes must exist
    const fromNodeData = this.nodes.get(fromNode);
    const toNodeData = this.nodes.get(toNode);
    if (!fromNodeData || !toNodeData) return null;

    // No duplicate connections to same input
    for (const c of this.connections) {
      if (c.toNode === toNode && c.toPort === toPort) return null;
    }

    // Type checking
    const fromDef = this.nodeRegistry[fromNodeData.type];
    const toDef = this.nodeRegistry[toNodeData.type];
    if (!fromDef || !toDef) return null;

    const fromPortDef = (fromDef.outputs || []).find((p) => p.name === fromPort);
    const toPortDef = (toDef.inputs || []).find((p) => p.name === toPort);
    if (!fromPortDef || !toPortDef) return null;

    if (fromPortDef.type !== toPortDef.type && fromPortDef.type !== PORT_TYPE_ANY && toPortDef.type !== PORT_TYPE_ANY) {
      return null;
    }

    const conn: GraphConnection = {
      id: connId(),
      fromNode,
      fromPort,
      toNode,
      toPort,
    };

    this.connections.push(conn);
    return conn;
  }

  disconnect(connectionId: string): boolean {
    const len = this.connections.length;
    this.connections = this.connections.filter((c) => c.id !== connectionId);
    return this.connections.length < len;
  }

  // ─── Serialization ────────────────────────────────────────────────

  serialize(): SerializedGraph {
    return {
      nodes: this.getNodes().map((n) => ({
        id: n.id,
        type: n.type,
        x: n.x,
        y: n.y,
        properties: JSON.parse(JSON.stringify(n.properties)),
      })),
      connections: this.connections.map((c) => ({
        fromNode: c.fromNode,
        fromPort: c.fromPort,
        toNode: c.toNode,
        toPort: c.toPort,
      })),
      metadata: { version: 1, zoom: 1, panX: 0, panY: 0 },
    };
  }

  load(data: SerializedGraph): void {
    this.nodes.clear();
    this.connections = [];

    if (data.nodes) {
      for (const n of data.nodes) {
        const def = this.nodeRegistry[n.type];
        if (!def) continue;
        const node: GraphNode = {
          id: n.id,
          type: n.type,
          category: def.category || "default",
          label: def.label || n.type,
          x: n.x,
          y: n.y,
          width: def.width || 160,
          height: this._calcNodeHeight(def),
          properties: n.properties || this._defaultProperties(def),
          inputs: (def.inputs || []).map((p) => ({ ...p })),
          outputs: (def.outputs || []).map((p) => ({ ...p })),
        };
        this.nodes.set(node.id, node);
      }
    }

    if (data.connections) {
      for (const c of data.connections) {
        if (this.nodes.has(c.fromNode) && this.nodes.has(c.toNode)) {
          this.connections.push({
            id: connId(),
            fromNode: c.fromNode,
            fromPort: c.fromPort,
            toNode: c.toNode,
            toPort: c.toPort,
          });
        }
      }
    }
  }

  clear(): void {
    this.nodes.clear();
    this.connections = [];
  }

  // ─── Engine format conversion ─────────────────────────────────────

  toEngineFormat(): { nodes: UINodeData[]; connections: UIConnection[] } {
    return {
      nodes: this.getNodes().map((n) => ({
        id: n.id,
        type: n.type,
        inputs: (n.inputs || []).map((p) => ({
          id: n.id + "_in_" + p.name,
          name: p.name,
          type: p.type,
        })),
        outputs: (n.outputs || []).map((p) => ({
          id: n.id + "_out_" + p.name,
          name: p.name,
          type: p.type,
        })),
        properties: n.properties,
      })),
      connections: this.connections.map((c) => ({
        id: c.id,
        fromNode: c.fromNode,
        fromPort: c.fromPort,
        toNode: c.toNode,
        toPort: c.toPort,
      })),
    };
  }

  // ─── Validation ───────────────────────────────────────────────────

  validate(): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const nodes = this.getNodes();
    const connections = this.connections;

    // Cycle detection via DFS
    const adj: Record<string, string[]> = {};
    for (const n of nodes) adj[n.id] = [];
    for (const c of connections) {
      if (adj[c.fromNode]) adj[c.fromNode].push(c.toNode);
    }

    const visited = new Set<string>();
    const stack = new Set<string>();

    function dfs(nodeId: string): boolean {
      visited.add(nodeId);
      stack.add(nodeId);
      const neighbors = adj[nodeId] || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (stack.has(neighbor)) {
          return true;
        }
      }
      stack.delete(nodeId);
      return false;
    }

    for (const n of nodes) {
      if (!visited.has(n.id)) {
        if (dfs(n.id)) {
          errors.push("Graph contains a cycle");
          break;
        }
      }
    }

    // Check disconnected non-optional inputs
    for (const n of nodes) {
      for (const inp of n.inputs || []) {
        if (inp.optional) continue;
        const hasConn = connections.some((c) => c.toNode === n.id && c.toPort === inp.name);
        if (!hasConn) {
          warnings.push(`Node '${n.label || n.type}' has unconnected input: ${inp.name}`);
        }
      }
    }

    // Check for orphan nodes
    if (nodes.length > 1) {
      for (const n of nodes) {
        const hasConn = connections.some((c) => c.fromNode === n.id || c.toNode === n.id);
        if (!hasConn) {
          warnings.push(`Node '${n.label || n.type}' is not connected to anything`);
        }
      }
    }

    return { errors, warnings, valid: errors.length === 0 };
  }

  // ─── History snapshots ────────────────────────────────────────────

  snapshot(): SerializedGraph {
    return this.serialize();
  }

  restore(data: SerializedGraph): void {
    this.load(data);
  }

  // ─── Coordinate conversion (pure math) ────────────────────────────

  static screenToGraph(sx: number, sy: number, panX: number, panY: number, zoom: number): { x: number; y: number } {
    return {
      x: (sx - panX) / zoom,
      y: (sy - panY) / zoom,
    };
  }

  static graphToScreen(gx: number, gy: number, panX: number, panY: number, zoom: number): { x: number; y: number } {
    return {
      x: gx * zoom + panX,
      y: gy * zoom + panY,
    };
  }

  static snapToGrid(value: number, gridSize: number): number {
    return Math.round(value / gridSize) * gridSize + 0;
  }

  // ─── Bezier curve math ────────────────────────────────────────────

  static bezierPoint(t: number, x1: number, y1: number, x2: number, y2: number, offset: number): { x: number; y: number } {
    const cx1 = x1 + offset;
    const cx2 = x2 - offset;
    const cy1 = y1;
    const cy2 = y2;
    const omt = 1 - t;
    return {
      x: omt * omt * omt * x1 + 3 * omt * omt * t * cx1 + 3 * omt * t * t * cx2 + t * t * t * x2,
      y: omt * omt * omt * y1 + 3 * omt * omt * t * cy1 + 3 * omt * t * t * cy2 + t * t * t * y2,
    };
  }

  static distToBezier(px: number, py: number, x1: number, y1: number, x2: number, y2: number, offset: number, steps = 20): number {
    let minDist = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pt = GraphModel.bezierPoint(t, x1, y1, x2, y2, offset);
      const dx = px - pt.x;
      const dy = py - pt.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private _calcNodeHeight(def: NodeTypeDef): number {
    const maxPorts = Math.max((def.inputs || []).length, (def.outputs || []).length);
    return NODE_HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 10;
  }

  private _defaultProperties(def: NodeTypeDef): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    if (def.properties) {
      for (const p of def.properties) {
        props[p.name] = p.default !== undefined ? p.default : null;
      }
    }
    return props;
  }
}

// ─── History manager ──────────────────────────────────────────────────

export class GraphHistory {
  private history: SerializedGraph[] = [];
  private index = -1;
  private maxHistory: number;

  constructor(maxHistory = 50) {
    this.maxHistory = maxHistory;
  }

  push(state: SerializedGraph): void {
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(JSON.parse(JSON.stringify(state)));
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    } else {
      this.index++;
    }
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.history.length - 1;
  }

  undo(): SerializedGraph | null {
    if (!this.canUndo()) return null;
    this.index--;
    return this.history[this.index];
  }

  redo(): SerializedGraph | null {
    if (!this.canRedo()) return null;
    this.index++;
    return this.history[this.index];
  }

  clear(): void {
    this.history = [];
    this.index = -1;
  }

  size(): number {
    return this.history.length;
  }

  currentIndex(): number {
    return this.index;
  }
}
