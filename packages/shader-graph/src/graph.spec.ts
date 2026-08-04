import { GraphCompiler } from "./compiler";
import { MaterialGraph } from "./graph";
import { PBR_INSTANCED_PROFILE, PBR_PROFILE, PBR_SKINNED_PROFILE, PBR_TEXTURED_PROFILE } from "./profiles";
import { GraphValidator } from "./validator";

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

  it("should generate textureSample for texture_sample node", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "tex", type: "texture_sample", inputs: { uv: "" }, outputs: { color: "vec4" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("tex", "color", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("textureSample(albedoMap, albedoSampler, input.uv)");
  });

  it("should generate multiply expression for multiply node", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "c1", type: "vec4_constant", inputs: {}, outputs: { value: "vec4" }, properties: { value: [1, 0, 0, 1] } });
    g.addNode({ id: "c2", type: "vec4_constant", inputs: {}, outputs: { value: "vec4" }, properties: { value: [0.5, 0.5, 0.5, 1] } });
    g.addNode({ id: "mul", type: "multiply", inputs: { a: "", b: "" }, outputs: { result: "vec4" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("c1", "value", "mul", "a");
    g.connect("c2", "value", "mul", "b");
    g.connect("mul", "result", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("*");
    expect(wgsl).toContain("vec4<f32>(1, 0, 0, 1)");
    expect(wgsl).toContain("vec4<f32>(0.5, 0.5, 0.5, 1)");
  });

  it("should generate time expression for time node", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "t", type: "time", inputs: {}, outputs: { value: "f32" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("t", "value", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("time");
  });

  it("should generate uv expression for uv node", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "uv", type: "uv", inputs: {}, outputs: { value: "vec2" }, properties: {} });
    g.addNode({ id: "tex", type: "texture_sample", inputs: { uv: "" }, outputs: { color: "vec4" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("uv", "value", "tex", "uv");
    g.connect("tex", "color", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("textureSample(albedoMap, albedoSampler, input.uv)");
  });

  it("should report errors for graph with no output node", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "c", type: "constant", inputs: {}, outputs: { value: "f32" }, properties: { value: 1 } });
    const compiler = new GraphCompiler();
    const result = compiler.compileDetailed(g);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("No output"))).toBe(true);
  });

  it("should report errors for unknown node type", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "weird", type: "unknown_type", inputs: {}, outputs: { value: "f32" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("weird", "value", "out", "value");
    const compiler = new GraphCompiler();
    const result = compiler.compileDetailed(g);
    expect(result.errors.some((e) => e.includes("Unknown node type"))).toBe(true);
  });

  it("should chain multiple operations correctly", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "uv", type: "uv", inputs: {}, outputs: { value: "vec2" }, properties: {} });
    g.addNode({ id: "tex", type: "texture_sample", inputs: { uv: "" }, outputs: { color: "vec4" }, properties: {} });
    g.addNode({ id: "c", type: "vec4_constant", inputs: {}, outputs: { value: "vec4" }, properties: { value: [1, 1, 1, 1] } });
    g.addNode({ id: "mul", type: "multiply", inputs: { a: "", b: "" }, outputs: { result: "vec4" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("uv", "value", "tex", "uv");
    g.connect("tex", "color", "mul", "a");
    g.connect("c", "value", "mul", "b");
    g.connect("mul", "result", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("textureSample(albedoMap, albedoSampler, input.uv)");
    expect(wgsl).toContain("*");
    expect(wgsl).toContain("vec4<f32>(1, 1, 1, 1)");
  });

  it("should compile with PBR profile and generate entity transform", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n", type: "normal", inputs: {}, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("n", "value", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g, { profile: PBR_PROFILE });
    expect(wgsl).toContain("entityPos");
    expect(wgsl).toContain("entityScale");
    expect(wgsl).toContain("qrotate");
    expect(wgsl).toContain("sunDirIntensity");
    expect(wgsl).toContain("fogColor");
  });

  it("should compile with PBR profile and generate pbrLighting call", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n", type: "normal", inputs: {}, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "wp", type: "world_pos", inputs: {}, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "vc", type: "vec3_constant", inputs: {}, outputs: { value: "vec3" }, properties: { value: [0.8, 0.6, 0.4] } });
    g.addNode({ id: "m", type: "constant", inputs: {}, outputs: { value: "f32" }, properties: { value: 0.0 } });
    g.addNode({ id: "r", type: "constant", inputs: {}, outputs: { value: "f32" }, properties: { value: 0.5 } });
    g.addNode({ id: "pbr", type: "pbr_lighting", inputs: { N: "", worldPos: "", baseColor: "", metallic: "", roughness: "" }, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("n", "value", "pbr", "N");
    g.connect("wp", "value", "pbr", "worldPos");
    g.connect("vc", "value", "pbr", "baseColor");
    g.connect("m", "value", "pbr", "metallic");
    g.connect("r", "value", "pbr", "roughness");
    g.connect("pbr", "value", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g, { profile: PBR_PROFILE });
    expect(wgsl).toContain("pbrLighting(");
    expect(wgsl).toContain("cookTorranceSpecular");
    expect(wgsl).toContain("fresnelSchlick");
    expect(wgsl).toContain("brdfLUT");
  });

  it("should compile with instanced profile and generate instance_index", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n", type: "normal", inputs: {}, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("n", "value", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g, { profile: PBR_INSTANCED_PROFILE });
    expect(wgsl).toContain("instance_index");
    expect(wgsl).toContain("InstanceData");
    expect(wgsl).toContain("instances");
  });

  it("should compile with skinned profile and generate skinning code", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n", type: "normal", inputs: {}, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("n", "value", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g, { profile: PBR_SKINNED_PROFILE });
    expect(wgsl).toContain("boneMatrices");
    expect(wgsl).toContain("joints");
    expect(wgsl).toContain("weights");
    expect(wgsl).toContain("skinMat");
  });

  it("should compile with textured PBR profile and include texture bindings", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "uv", type: "uv", inputs: {}, outputs: { value: "vec2" }, properties: {} });
    g.addNode({ id: "tex", type: "texture_sample", inputs: { uv: "" }, outputs: { color: "vec4" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("uv", "value", "tex", "uv");
    g.connect("tex", "color", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g, { profile: PBR_TEXTURED_PROFILE });
    expect(wgsl).toContain("albedoMap");
    expect(wgsl).toContain("albedoSampler");
  });

  it("should generate fog node correctly", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "src", type: "vec3_constant", inputs: {}, outputs: { value: "vec3" }, properties: { value: [1, 0, 0] } });
    g.addNode({ id: "fog", type: "fog", inputs: { color: "", dist: "", source: "" }, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("src", "value", "fog", "source");
    g.connect("fog", "value", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g, { profile: PBR_PROFILE });
    expect(wgsl).toContain("mix(");
    expect(wgsl).toContain("fogColor");
  });

  it("should generate dynamic_lights node correctly", () => {
    const g = new MaterialGraph();
    g.addNode({ id: "n", type: "normal", inputs: {}, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "wp", type: "world_pos", inputs: {}, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "dl", type: "dynamic_lights", inputs: { N: "", worldPos: "", viewDir: "", specPower: "", specIntensity: "" }, outputs: { value: "vec3" }, properties: {} });
    g.addNode({ id: "out", type: "output", inputs: { value: "" }, outputs: {}, properties: {} });
    g.connect("n", "value", "dl", "N");
    g.connect("wp", "value", "dl", "worldPos");
    g.connect("dl", "value", "out", "value");
    const compiler = new GraphCompiler();
    const wgsl = compiler.compile(g, { profile: PBR_PROFILE });
    expect(wgsl).toContain("applyDynamicLights(");
    expect(wgsl).toContain("PointLight");
    expect(wgsl).toContain("SpotLight");
  });
});
