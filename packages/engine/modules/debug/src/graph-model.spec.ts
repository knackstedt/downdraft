import { GraphModel, GraphHistory, type NodeTypeDef, type SerializedGraph } from "./graph-model";

// ─── Test node type definitions ──────────────────────────────────────

const TestNodeTypes: Record<string, NodeTypeDef> = {
  number_input: {
    label: "Number",
    category: "input",
    inputs: [],
    outputs: [{ name: "value", type: "float" }],
    properties: [{ name: "value", type: "float", default: 0 }],
  },
  vec3_input: {
    label: "Vec3",
    category: "input",
    inputs: [],
    outputs: [{ name: "value", type: "vec3" }],
    properties: [{ name: "value", type: "vec3", default: [0, 0, 0] }],
  },
  multiply: {
    label: "Multiply",
    category: "math",
    inputs: [
      { name: "a", type: "float", optional: false },
      { name: "b", type: "float", optional: false },
    ],
    outputs: [{ name: "result", type: "float" }],
    properties: [],
  },
  add: {
    label: "Add",
    category: "math",
    inputs: [
      { name: "a", type: "float", optional: true },
      { name: "b", type: "float", optional: true },
    ],
    outputs: [{ name: "result", type: "float" }],
    properties: [],
  },
  any_input: {
    label: "Any Input",
    category: "input",
    inputs: [],
    outputs: [{ name: "value", type: "any" }],
    properties: [],
  },
  any_output: {
    label: "Any Output",
    category: "output",
    inputs: [{ name: "in", type: "any", optional: false }],
    outputs: [],
    properties: [],
  },
  output: {
    label: "Output",
    category: "output",
    inputs: [{ name: "value", type: "float", optional: false }],
    outputs: [],
    properties: [],
  },
  passthrough: {
    label: "Passthrough",
    category: "test",
    inputs: [{ name: "in", type: "float", optional: false }],
    outputs: [{ name: "out", type: "float" }],
    properties: [],
  },
};

// ─── Tests ───────────────────────────────────────────────────────────

describe("GraphModel — Node Management", () => {
  test("addNode creates a node with correct type and properties", () => {
    const g = new GraphModel(TestNodeTypes);
    const node = g.addNode("number_input", 100, 200);
    expect(node).not.toBeNull();
    expect(node!.type).toBe("number_input");
    expect(node!.label).toBe("Number");
    expect(node!.category).toBe("input");
    expect(node!.x).toBe(100);
    expect(node!.y).toBe(200);
    expect(node!.properties.value).toBe(0);
    expect(node!.outputs.length).toBe(1);
    expect(node!.outputs[0].name).toBe("value");
    expect(node!.outputs[0].type).toBe("float");
  });

  test("addNode with custom properties overrides defaults", () => {
    const g = new GraphModel(TestNodeTypes);
    const node = g.addNode("number_input", 0, 0, { value: 42 });
    expect(node!.properties.value).toBe(42);
  });

  test("addNode returns null for unknown type", () => {
    const g = new GraphModel(TestNodeTypes);
    const node = g.addNode("nonexistent", 0, 0);
    expect(node).toBeNull();
  });

  test("addNode generates unique IDs", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("number_input", 0, 0);
    expect(n1!.id).not.toBe(n2!.id);
  });

  test("removeNode deletes node and its connections", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    g.connect(n1!.id, "value", n2!.id, "a");
    expect(g.getConnections().length).toBe(1);

    g.removeNode(n1!.id);
    expect(g.getNode(n1!.id)).toBeNull();
    expect(g.getConnections().length).toBe(0);
  });

  test("removeNode returns false for non-existent node", () => {
    const g = new GraphModel(TestNodeTypes);
    expect(g.removeNode("fake")).toBe(false);
  });

  test("updateNodeProperty sets property value", () => {
    const g = new GraphModel(TestNodeTypes);
    const node = g.addNode("number_input", 0, 0);
    g.updateNodeProperty(node!.id, "value", 99);
    expect(g.getNode(node!.id)!.properties.value).toBe(99);
  });

  test("updateNodeProperty returns false for non-existent node", () => {
    const g = new GraphModel(TestNodeTypes);
    expect(g.updateNodeProperty("fake", "x", 1)).toBe(false);
  });

  test("registerNodeType adds new type dynamically", () => {
    const g = new GraphModel();
    g.registerNodeType("custom", { label: "Custom", category: "test", inputs: [], outputs: [], properties: [] });
    const node = g.addNode("custom", 0, 0);
    expect(node).not.toBeNull();
    expect(node!.label).toBe("Custom");
  });
});

describe("GraphModel — Connection Management", () => {
  test("connect creates a valid connection", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    const conn = g.connect(n1!.id, "value", n2!.id, "a");
    expect(conn).not.toBeNull();
    expect(conn!.fromNode).toBe(n1!.id);
    expect(conn!.fromPort).toBe("value");
    expect(conn!.toNode).toBe(n2!.id);
    expect(conn!.toPort).toBe("a");
  });

  test("connect prevents self-connection", () => {
    const g = new GraphModel(TestNodeTypes);
    const n = g.addNode("passthrough", 0, 0);
    const conn = g.connect(n!.id, "out", n!.id, "in");
    expect(conn).toBeNull();
  });

  test("connect prevents duplicate connections to same input", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    g.connect(n1!.id, "value", n2!.id, "a");
    const second = g.connect(n1!.id, "value", n2!.id, "a");
    expect(second).toBeNull();
    expect(g.getConnections().length).toBe(1);
  });

  test("connect rejects type mismatch", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("vec3_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    const conn = g.connect(n1!.id, "value", n2!.id, "a");
    expect(conn).toBeNull();
  });

  test("connect allows any type to connect to specific type", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("any_input", 0, 0);
    const n2 = g.addNode("output", 200, 0);
    const conn = g.connect(n1!.id, "value", n2!.id, "value");
    expect(conn).not.toBeNull();
  });

  test("connect allows specific type to connect to any type", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("any_output", 200, 0);
    const conn = g.connect(n1!.id, "value", n2!.id, "in");
    expect(conn).not.toBeNull();
  });

  test("connect returns null for non-existent nodes", () => {
    const g = new GraphModel(TestNodeTypes);
    const conn = g.connect("fake", "value", "also_fake", "a");
    expect(conn).toBeNull();
  });

  test("connect returns null for non-existent ports", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    expect(g.connect(n1!.id, "nonexistent", n2!.id, "a")).toBeNull();
    expect(g.connect(n1!.id, "value", n2!.id, "nonexistent")).toBeNull();
  });

  test("disconnect removes a connection by ID", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    const conn = g.connect(n1!.id, "value", n2!.id, "a");
    expect(g.disconnect(conn!.id)).toBe(true);
    expect(g.getConnections().length).toBe(0);
  });

  test("disconnect returns false for non-existent connection", () => {
    const g = new GraphModel(TestNodeTypes);
    expect(g.disconnect("fake")).toBe(false);
  });
});

describe("GraphModel — Serialization", () => {
  test("serialize produces correct format", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 10, 20, { value: 5 });
    const n2 = g.addNode("output", 200, 20);
    g.connect(n1!.id, "value", n2!.id, "value");

    const data = g.serialize();
    expect(data.nodes.length).toBe(2);
    expect(data.nodes[0].type).toBe("number_input");
    expect(data.nodes[0].x).toBe(10);
    expect(data.nodes[0].y).toBe(20);
    expect(data.nodes[0].properties.value).toBe(5);
    expect(data.connections.length).toBe(1);
    expect(data.connections[0].fromNode).toBe(n1!.id);
    expect(data.connections[0].toNode).toBe(n2!.id);
    expect(data.metadata).toBeDefined();
    expect(data.metadata!.version).toBe(1);
  });

  test("load restores nodes and connections", () => {
    const g = new GraphModel(TestNodeTypes);
    const data: SerializedGraph = {
      nodes: [
        { id: "n_a", type: "number_input", x: 50, y: 60, properties: { value: 10 } },
        { id: "n_b", type: "output", x: 300, y: 60, properties: {} },
      ],
      connections: [
        { fromNode: "n_a", fromPort: "value", toNode: "n_b", toPort: "value" },
      ],
    };
    g.load(data);

    expect(g.getNodes().length).toBe(2);
    expect(g.getNode("n_a")).not.toBeNull();
    expect(g.getNode("n_a")!.properties.value).toBe(10);
    expect(g.getConnections().length).toBe(1);
  });

  test("load skips unknown node types", () => {
    const g = new GraphModel(TestNodeTypes);
    const data: SerializedGraph = {
      nodes: [
        { id: "n_a", type: "unknown_type", x: 0, y: 0, properties: {} },
        { id: "n_b", type: "number_input", x: 0, y: 0, properties: {} },
      ],
      connections: [],
    };
    g.load(data);
    expect(g.getNodes().length).toBe(1);
  });

  test("load skips connections referencing missing nodes", () => {
    const g = new GraphModel(TestNodeTypes);
    const data: SerializedGraph = {
      nodes: [
        { id: "n_a", type: "number_input", x: 0, y: 0, properties: {} },
      ],
      connections: [
        { fromNode: "n_a", fromPort: "value", toNode: "n_missing", toPort: "value" },
      ],
    };
    g.load(data);
    expect(g.getConnections().length).toBe(0);
  });

  test("serialize then load produces equivalent graph", () => {
    const g1 = new GraphModel(TestNodeTypes);
    const n1 = g1.addNode("number_input", 100, 200, { value: 42 });
    const n2 = g1.addNode("multiply", 300, 200);
    g1.connect(n1!.id, "value", n2!.id, "a");

    const data = g1.serialize();

    const g2 = new GraphModel(TestNodeTypes);
    g2.load(data);

    expect(g2.getNodes().length).toBe(2);
    expect(g2.getConnections().length).toBe(1);
    expect(g2.getNode(n1!.id)!.properties.value).toBe(42);
  });

  test("clear removes all nodes and connections", () => {
    const g = new GraphModel(TestNodeTypes);
    g.addNode("number_input", 0, 0);
    g.addNode("output", 200, 0);
    g.clear();
    expect(g.getNodes().length).toBe(0);
    expect(g.getConnections().length).toBe(0);
  });
});

describe("GraphModel — Engine Format Conversion", () => {
  test("toEngineFormat produces UINodeData with port IDs", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    g.connect(n1!.id, "value", n2!.id, "a");

    const result = g.toEngineFormat();
    expect(result.nodes.length).toBe(2);
    expect(result.nodes[0].id).toBe(n1!.id);
    expect(result.nodes[0].outputs.length).toBe(1);
    expect(result.nodes[0].outputs[0].id).toBe(n1!.id + "_out_value");
    expect(result.nodes[0].outputs[0].name).toBe("value");
    expect(result.nodes[0].outputs[0].type).toBe("float");
    expect(result.nodes[1].inputs.length).toBe(2);
    expect(result.nodes[1].inputs[0].id).toBe(n2!.id + "_in_a");
    expect(result.connections.length).toBe(1);
    expect(result.connections[0].fromNode).toBe(n1!.id);
    expect(result.connections[0].fromPort).toBe("value");
  });
});

describe("GraphModel — Validation", () => {
  test("valid graph with no cycles passes", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    const n3 = g.addNode("output", 400, 0);
    g.connect(n1!.id, "value", n2!.id, "a");
    g.connect(n2!.id, "result", n3!.id, "value");

    const result = g.validate();
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("cycle is detected", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("passthrough", 0, 0);
    const n2 = g.addNode("passthrough", 200, 0);
    g.connect(n1!.id, "out", n2!.id, "in");
    g.connect(n2!.id, "out", n1!.id, "in");

    const result = g.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  test("self-cycle is detected", () => {
    // Can't create self-connection via connect(), so manually inject
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("passthrough", 0, 0);
    // Manually push a self-connection to test cycle detection
    g.connections.push({ id: "manual", fromNode: n1!.id, fromPort: "out", toNode: n1!.id, toPort: "in" });

    const result = g.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  test("unconnected non-optional inputs generate warnings", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("multiply", 200, 0);
    // Only connect one of two required inputs
    g.connect(n1!.id, "value", n2!.id, "a");

    const result = g.validate();
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("unconnected input"))).toBe(true);
  });

  test("optional unconnected inputs do not generate warnings", () => {
    const g = new GraphModel(TestNodeTypes);
    const n1 = g.addNode("number_input", 0, 0);
    const n2 = g.addNode("add", 200, 0);
    g.connect(n1!.id, "value", n2!.id, "a");
    // 'b' is optional, should not warn

    const result = g.validate();
    expect(result.warnings.filter((w) => w.includes("unconnected input"))).toHaveLength(0);
  });

  test("orphan nodes generate warnings", () => {
    const g = new GraphModel(TestNodeTypes);
    g.addNode("number_input", 0, 0);
    const n2 = g.addNode("number_input", 200, 0);
    // n2 is not connected to anything
    g.addNode("output", 400, 0);

    const result = g.validate();
    expect(result.warnings.some((w) => w.includes("not connected"))).toBe(true);
  });

  test("single node does not generate orphan warning", () => {
    const g = new GraphModel(TestNodeTypes);
    g.addNode("number_input", 0, 0);

    const result = g.validate();
    expect(result.warnings.filter((w) => w.includes("not connected"))).toHaveLength(0);
  });

  test("empty graph is valid", () => {
    const g = new GraphModel(TestNodeTypes);
    const result = g.validate();
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBe(0);
  });
});

describe("GraphModel — Coordinate Conversion", () => {
  test("screenToGraph converts screen to graph coordinates", () => {
    const result = GraphModel.screenToGraph(150, 250, 50, 50, 2);
    expect(result.x).toBe(50);
    expect(result.y).toBe(100);
  });

  test("graphToScreen converts graph to screen coordinates", () => {
    const result = GraphModel.graphToScreen(50, 100, 50, 50, 2);
    expect(result.x).toBe(150);
    expect(result.y).toBe(250);
  });

  test("screenToGraph and graphToScreen are inverse operations", () => {
    const panX = 30, panY = 40, zoom = 1.5;
    const sx = 200, sy = 300;
    const graph = GraphModel.screenToGraph(sx, sy, panX, panY, zoom);
    const screen = GraphModel.graphToScreen(graph.x, graph.y, panX, panY, zoom);
    expect(screen.x).toBeCloseTo(sx, 5);
    expect(screen.y).toBeCloseTo(sy, 5);
  });

  test("snapToGrid rounds to nearest grid", () => {
    expect(GraphModel.snapToGrid(17, 20)).toBe(20);
    expect(GraphModel.snapToGrid(8, 20)).toBe(0);
    expect(GraphModel.snapToGrid(10, 20)).toBe(20);
    expect(GraphModel.snapToGrid(-3, 20)).toBe(0);
    expect(GraphModel.snapToGrid(-13, 20)).toBe(-20);
  });
});

describe("GraphModel — Bezier Math", () => {
  test("bezierPoint at t=0 returns start point", () => {
    const pt = GraphModel.bezierPoint(0, 10, 20, 100, 40, 50);
    expect(pt.x).toBe(10);
    expect(pt.y).toBe(20);
  });

  test("bezierPoint at t=1 returns end point", () => {
    const pt = GraphModel.bezierPoint(1, 10, 20, 100, 40, 50);
    expect(pt.x).toBe(100);
    expect(pt.y).toBe(40);
  });

  test("bezierPoint at t=0.5 is between start and end", () => {
    const pt = GraphModel.bezierPoint(0.5, 0, 0, 100, 0, 50);
    expect(pt.x).toBeGreaterThan(0);
    expect(pt.x).toBeLessThan(100);
    expect(pt.y).toBe(0);
  });

  test("distToBezier returns 0 for point on curve", () => {
    const pt = GraphModel.bezierPoint(0.5, 0, 0, 100, 0, 50);
    const dist = GraphModel.distToBezier(pt.x, pt.y, 0, 0, 100, 0, 50);
    expect(dist).toBeLessThan(2);
  });

  test("distToBezier returns larger distance for far point", () => {
    const dist = GraphModel.distToBezier(50, 100, 0, 0, 100, 0, 50);
    expect(dist).toBeGreaterThan(50);
  });
});

describe("GraphHistory", () => {
  test("push stores state and advances index", () => {
    const h = new GraphHistory(10);
    const state: SerializedGraph = { nodes: [], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } };
    h.push(state);
    expect(h.size()).toBe(1);
    expect(h.currentIndex()).toBe(0);
  });

  test("canUndo returns false initially", () => {
    const h = new GraphHistory(10);
    expect(h.canUndo()).toBe(false);
  });

  test("canRedo returns false initially", () => {
    const h = new GraphHistory(10);
    expect(h.canRedo()).toBe(false);
  });

  test("undo returns previous state", () => {
    const h = new GraphHistory(10);
    const s1: SerializedGraph = { nodes: [], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } };
    const s2: SerializedGraph = { nodes: [{ id: "n1", type: "test", x: 0, y: 0, properties: {} }], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } };
    h.push(s1);
    h.push(s2);
    expect(h.canUndo()).toBe(true);
    const prev = h.undo();
    expect(prev).not.toBeNull();
    expect(prev!.nodes.length).toBe(0);
  });

  test("redo returns next state after undo", () => {
    const h = new GraphHistory(10);
    const s1: SerializedGraph = { nodes: [], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } };
    const s2: SerializedGraph = { nodes: [{ id: "n1", type: "test", x: 0, y: 0, properties: {} }], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } };
    h.push(s1);
    h.push(s2);
    h.undo();
    expect(h.canRedo()).toBe(true);
    const next = h.redo();
    expect(next).not.toBeNull();
    expect(next!.nodes.length).toBe(1);
  });

  test("undo returns null when no history", () => {
    const h = new GraphHistory(10);
    expect(h.undo()).toBeNull();
  });

  test("redo returns null when no future history", () => {
    const h = new GraphHistory(10);
    h.push({ nodes: [], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } });
    expect(h.redo()).toBeNull();
  });

  test("push after undo truncates future history", () => {
    const h = new GraphHistory(10);
    h.push({ nodes: [], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } });
    h.push({ nodes: [{ id: "n1", type: "test", x: 0, y: 0, properties: {} }], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } });
    h.undo();
    h.push({ nodes: [{ id: "n2", type: "test", x: 10, y: 10, properties: {} }], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } });
    expect(h.size()).toBe(2);
    expect(h.canRedo()).toBe(false);
  });

  test("maxHistory limits stored states", () => {
    const h = new GraphHistory(3);
    for (let i = 0; i < 5; i++) {
      h.push({ nodes: [{ id: `n${i}`, type: "test", x: i, y: 0, properties: {} }], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } });
    }
    expect(h.size()).toBe(3);
  });

  test("clear resets history", () => {
    const h = new GraphHistory(10);
    h.push({ nodes: [], connections: [], metadata: { version: 1, zoom: 1, panX: 0, panY: 0 } });
    h.clear();
    expect(h.size()).toBe(0);
    expect(h.currentIndex()).toBe(-1);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  test("snapshot and restore round-trip", () => {
    const g = new GraphModel(TestNodeTypes);
    g.addNode("number_input", 50, 60, { value: 7 });
    const snap = g.snapshot();

    g.clear();
    expect(g.getNodes().length).toBe(0);

    g.restore(snap);
    expect(g.getNodes().length).toBe(1);
    const node = g.getNodes()[0];
    expect(node.properties.value).toBe(7);
    expect(node.x).toBe(50);
    expect(node.y).toBe(60);
  });
});

describe("GraphModel — Integration", () => {
  test("full workflow: add nodes, connect, serialize, load, validate", () => {
    const g1 = new GraphModel(TestNodeTypes);
    const n1 = g1.addNode("number_input", 0, 0, { value: 10 });
    const n2 = g1.addNode("number_input", 0, 100, { value: 20 });
    const mul = g1.addNode("multiply", 200, 50);
    const out = g1.addNode("output", 400, 50);

    g1.connect(n1!.id, "value", mul!.id, "a");
    g1.connect(n2!.id, "value", mul!.id, "b");
    g1.connect(mul!.id, "result", out!.id, "value");

    const validation = g1.validate();
    expect(validation.valid).toBe(true);
    expect(validation.warnings.length).toBe(0);

    const data = g1.serialize();
    const g2 = new GraphModel(TestNodeTypes);
    g2.load(data);

    expect(g2.getNodes().length).toBe(4);
    expect(g2.getConnections().length).toBe(3);

    const validation2 = g2.validate();
    expect(validation2.valid).toBe(true);
  });

  test("history integration: add, undo, redo", () => {
    const g = new GraphModel(TestNodeTypes);
    const h = new GraphHistory(20);

    // State 1: empty
    h.push(g.serialize());

    // State 2: add a node
    g.addNode("number_input", 0, 0);
    h.push(g.serialize());

    // State 3: add another node
    g.addNode("output", 200, 0);
    h.push(g.serialize());

    expect(g.getNodes().length).toBe(2);

    // Undo to state 2
    g.restore(h.undo()!);
    expect(g.getNodes().length).toBe(1);

    // Undo to state 1
    g.restore(h.undo()!);
    expect(g.getNodes().length).toBe(0);

    // Redo to state 2
    g.restore(h.redo()!);
    expect(g.getNodes().length).toBe(1);

    // Redo to state 3
    g.restore(h.redo()!);
    expect(g.getNodes().length).toBe(2);
  });
});
