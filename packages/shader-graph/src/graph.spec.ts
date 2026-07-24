import { MaterialGraph, type GraphNode } from "./graph.ts";
import { GraphValidator } from "./validator.ts";
import { GraphCompiler } from "./compiler.ts";

describe("MaterialGraph", () => {
  it("should add nodes", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "constant", inputs: {}, outputs: { value: "f32" }, properties: { value: 1.0 } });
    expect(g.getNodes().length).toBe(1);
    expect(g.getNodes()[0].id).toBe("n1");
  });

  it("should connect nodes", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "input", inputs: {}, outputs: { value: "f32" }, properties: {} });
    g.addNode({ id: "n2", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("n1", "value", "n2", "value");
    expect(g.getConnections().length).toBe(1);
  });

  it("should return a copy of nodes array", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "test", inputs: {}, outputs: {}, properties: {} });
    const nodes1 = g.getNodes();
    g.addNode({ id: "n2", type: "test", inputs: {}, outputs: {}, properties: {} });
    expect(nodes1.length).toBe(1);
    expect(g.getNodes().length).toBe(2);
  });

  it("should return a copy of connections array", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "a", inputs: {}, outputs: { v: "f32" }, properties: {} });
    g.addNode({ id: "n2", type: "b", inputs: { v: "" }, outputs: {}, properties: {} });
    g.connect("n1", "v", "n2", "v");
    const conns1 = g.getConnections();
    g.connect("n1", "v", "n2", "v");
    expect(conns1.length).toBe(1);
    expect(g.getConnections().length).toBe(2);
  });

  it("input() helper should create an input node and return its id", () => {
    const g = new MaterialGraph();
    const id = g.input("color", "vec4");
    expect(id).toBe("input_color");
    const nodes = g.getNodes();
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe("input");
    expect(nodes[0].properties.name).toBe("color");
  });

  it("output() helper should create an output node and connect it", () => {
    const g = new MaterialGraph();
    const inputId = g.input("color", "vec4");
    g.output("baseColor", inputId, "value");
    const nodes = g.getNodes();
    expect(nodes.length).toBe(2);
    expect(g.getConnections().length).toBe(1);
    expect(g.getConnections()[0].from).toBe(inputId);
  });

  it("should handle duplicate node IDs (overwrite)", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "a", inputs: {}, outputs: {}, properties: { v: 1 } });
    g.addNode({ id: "n1", type: "b", inputs: {}, outputs: {}, properties: { v: 2 } });
    expect(g.getNodes().length).toBe(1);
    expect(g.getNodes()[0].type).toBe("b");
  });
});

describe("GraphValidator", () => {
  it("should validate a simple valid graph", () => {
    const g = new MaterialGraph();
    g.input("color", "vec4");
    g.output("baseColor", "input_color");
    const validator = new GraphValidator();
    const result = validator.validate(g);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("should detect unknown source node in connection", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("unknown", "value", "n1", "value");
    const validator = new GraphValidator();
    const result = validator.validate(g);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown node"))).toBe(true);
  });

  it("should detect unknown target node in connection", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "input", inputs: {}, outputs: { value: "f32" }, properties: {} });
    g.connect("n1", "value", "unknown", "value");
    const validator = new GraphValidator();
    const result = validator.validate(g);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown node"))).toBe(true);
  });

  it("should detect cycles", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "a", type: "op", inputs: { in: "" }, outputs: { out: "f32" }, properties: {} });
    g.addNode({ id: "b", type: "op", inputs: { in: "" }, outputs: { out: "f32" }, properties: {} });
    g.connect("a", "out", "b", "in");
    g.connect("b", "out", "a", "in");
    const validator = new GraphValidator();
    const result = validator.validate(g);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Cycle"))).toBe(true);
  });

  it("should validate empty graph", () => {
    const g = new MaterialGraph();
    const validator = new GraphValidator();
    const result = validator.validate(g);
    expect(result.valid).toBe(true);
  });

  it("should validate graph with no connections", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n1", type: "input", inputs: {}, outputs: { value: "f32" }, properties: {} });
    const validator = new GraphValidator();
    const result = validator.validate(g);
    expect(result.valid).toBe(true);
  });
});

describe("GraphCompiler", () => {
  it("should compile a graph to WGSL string", () => {
    const g = new MaterialGraph();
    g.input("color", "vec4");
    g.output("baseColor", "input_color");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(typeof wgsl).toBe("string");
    expect(wgsl.length).toBeGreaterThan(0);
  });

  it("should include vertex shader in output", () => {
    const g = new MaterialGraph();
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("@vertex");
    expect(wgsl).toContain("vs_main");
  });

  it("should include fragment shader in output", () => {
    const g = new MaterialGraph();
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("@fragment");
    expect(wgsl).toContain("fs_main");
  });

  it("should include VertexInput and VertexOutput structs", () => {
    const g = new MaterialGraph();
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("VertexInput");
    expect(wgsl).toContain("VertexOutput");
  });

  it("should compile empty graph without error", () => {
    const g = new MaterialGraph();
    const compiler = new GraphCompiler();
    expect(() => compiler.compile(g)).not.toThrow();
  });
});
