import { ComputeGraph } from "./compute-graph";
import { ComputeGraphCompiler } from "./compute-compiler";
import { SIMPLE_COMPUTE_PROFILE } from "./compute-profiles";

describe("ComputeGraph", () => {
  it("should add nodes and connections", () => {
    const g = new ComputeGraph();
    g.addNode({ id: "n1", type: "global_id", inputs: {}, outputs: { value: "u32" }, properties: {} });
    g.addNode({ id: "n2", type: "buffer_store", inputs: { index: "", value: "" }, outputs: {}, properties: { buffer: "data", field: "value" } });
    g.connect("n1", "value", "n2", "index");
    expect(g.getNodes().length).toBe(2);
    expect(g.getConnections().length).toBe(1);
  });

  it("should add storage and uniform buffer declarations", () => {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "particles",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Particle",
      structFields: [{ name: "pos", type: "vec3<f32>" }, { name: "vel", type: "vec3<f32>" }],
    });
    g.addUniformBuffer({
      name: "params",
      binding: 1,
      group: 0,
      structName: "Params",
      structFields: [{ name: "dt", type: "f32" }],
    });
    expect(g.getStorageBuffers().length).toBe(1);
    expect(g.getUniformBuffers().length).toBe(1);
    expect(g.getStorageBuffers()[0].structName).toBe("Particle");
  });

  it("should set and get dispatch config", () => {
    const g = new ComputeGraph();
    g.setDispatchConfig({ workgroupSize: [8, 8, 1], dispatchCount: [16, 16, 1] });
    const d = g.getDispatchConfig();
    expect(d.workgroupSize).toEqual([8, 8, 1]);
    expect(d.dispatchCount).toEqual([16, 16, 1]);
  });
});

describe("ComputeGraphCompiler", () => {
  it("should compile a simple compute graph to WGSL string", () => {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "data",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Element",
      structFields: [{ name: "value", type: "f32" }],
    });
    g.addNode({ id: "gid", type: "global_id", inputs: {}, outputs: { value: "u32" }, properties: {} });
    g.addNode({ id: "load", type: "buffer_load", inputs: { index: "" }, outputs: { value: "f32" }, properties: { buffer: "data", field: "value" } });
    g.addNode({ id: "mul", type: "multiply", inputs: { a: "", b: "" }, outputs: { result: "f32" }, properties: {} });
    g.addNode({ id: "store", type: "buffer_store", inputs: { index: "", value: "" }, outputs: {}, properties: { buffer: "data", field: "value" } });
    g.addNode({ id: "two", type: "constant", inputs: {}, outputs: { value: "f32" }, properties: { value: 2.0 } });
    g.connect("gid", "value", "load", "index");
    g.connect("load", "value", "mul", "a");
    g.connect("two", "value", "mul", "b");
    g.connect("gid", "value", "store", "index");
    g.connect("mul", "result", "store", "value");

    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g, { profile: SIMPLE_COMPUTE_PROFILE });
    expect(typeof wgsl).toBe("string");
    expect(wgsl.length).toBeGreaterThan(0);
  });

  it("should include @compute and @workgroup_size in output", () => {
    const g = new ComputeGraph();
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g, { profile: SIMPLE_COMPUTE_PROFILE });
    expect(wgsl).toContain("@compute");
    expect(wgsl).toContain("@workgroup_size(64, 1, 1)");
  });

  it("should include global_invocation_id builtin", () => {
    const g = new ComputeGraph();
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("global_invocation_id");
    expect(wgsl).toContain("local_invocation_id");
    expect(wgsl).toContain("workgroup_id");
    expect(wgsl).toContain("num_workgroups");
  });

  it("should emit storage buffer declarations from StorageBufferDecl", () => {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "particles",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Particle",
      structFields: [
        { name: "position", type: "vec3<f32>" },
        { name: "_pad0", type: "f32" },
        { name: "velocity", type: "vec3<f32>" },
        { name: "_pad1", type: "f32" },
      ],
    });
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("struct Particle");
    expect(wgsl).toContain("position: vec3<f32>");
    expect(wgsl).toContain("@group(0) @binding(0) var<storage, read_write> particles: array<Particle>");
  });

  it("should emit uniform buffer declarations from UniformBufferDecl", () => {
    const g = new ComputeGraph();
    g.addUniformBuffer({
      name: "params",
      binding: 1,
      group: 0,
      structName: "SimParams",
      structFields: [{ name: "deltaTime", type: "f32" }, { name: "gravity", type: "vec3<f32>" }],
    });
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("struct SimParams");
    expect(wgsl).toContain("deltaTime: f32");
    expect(wgsl).toContain("@group(0) @binding(1) var<uniform> params: SimParams");
  });

  it("should generate buffer_store write statements", () => {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "data",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Element",
      structFields: [{ name: "value", type: "f32" }],
    });
    g.addNode({ id: "gid", type: "global_id", inputs: {}, outputs: { value: "u32" }, properties: {} });
    g.addNode({ id: "val", type: "constant", inputs: {}, outputs: { value: "f32" }, properties: { value: 42.0 } });
    g.addNode({ id: "store", type: "buffer_store", inputs: { index: "", value: "" }, outputs: {}, properties: { buffer: "data", field: "value" } });
    g.connect("gid", "value", "store", "index");
    g.connect("val", "value", "store", "value");

    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("data[gid.x].value = f32(42)");
  });

  it("should generate atomicAdd for atomic_add node", () => {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "counter",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Counter",
      structFields: [{ name: "value", type: "u32" }],
    });
    g.addNode({ id: "gid", type: "global_id", inputs: {}, outputs: { value: "u32" }, properties: {} });
    g.addNode({ id: "one", type: "u32_constant", inputs: {}, outputs: { value: "u32" }, properties: { value: 1 } });
    g.addNode({ id: "atomic", type: "atomic_add", inputs: { index: "", value: "" }, outputs: { result: "u32" }, properties: { buffer: "counter", field: "value" } });
    g.connect("gid", "value", "atomic", "index");
    g.connect("one", "value", "atomic", "value");

    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("atomicAdd(&counter[gid.x].value");
  });

  it("should generate workgroupBarrier for barrier nodes", () => {
    const g = new ComputeGraph();
    g.addNode({ id: "barrier", type: "workgroup_barrier", inputs: {}, outputs: {}, properties: {} });
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("workgroupBarrier()");
  });

  it("should use workgroup size from profile", () => {
    const g = new ComputeGraph();
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g, { profile: { name: "test", chunks: [], workgroupSize: [8, 8, 1] } });
    expect(wgsl).toContain("@workgroup_size(8, 8, 1)");
  });

  it("should use workgroup size from graph dispatch config when no profile", () => {
    const g = new ComputeGraph();
    g.setDispatchConfig({ workgroupSize: [32, 1, 1], dispatchCount: [1, 1, 1] });
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("@workgroup_size(32, 1, 1)");
  });

  it("should emit fixed-size array when elementCount is set", () => {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "data",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Element",
      structFields: [{ name: "value", type: "f32" }],
      elementCount: 1024,
    });
    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g);
    expect(wgsl).toContain("array<Element, 1024>");
  });

  it("should report errors for unknown node types", () => {
    const g = new ComputeGraph();
    g.addNode({ id: "bad", type: "nonexistent_node", inputs: {}, outputs: {}, properties: {} });
    g.addNode({ id: "store", type: "buffer_store", inputs: { index: "", value: "" }, outputs: {}, properties: { buffer: "data", field: "value" } });
    g.connect("bad", "value", "store", "value");
    const compiler = new ComputeGraphCompiler();
    const result = compiler.compileDetailed(g);
    expect(result.errors.some((e) => e.includes("Unknown node type"))).toBe(true);
  });

  it("should handle empty graph without error", () => {
    const g = new ComputeGraph();
    const compiler = new ComputeGraphCompiler();
    expect(() => compiler.compile(g)).not.toThrow();
  });

  it("should compile a particle-update-style graph", () => {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "particles",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Particle",
      structFields: [
        { name: "position", type: "vec3<f32>" },
        { name: "_pad0", type: "f32" },
        { name: "velocity", type: "vec3<f32>" },
        { name: "lifetime", type: "f32" },
      ],
    });
    g.addUniformBuffer({
      name: "params",
      binding: 1,
      group: 0,
      structName: "SimParams",
      structFields: [{ name: "deltaTime", type: "f32" }, { name: "gravity", type: "vec3<f32>" }],
    });

    // gid.x → load particle position
    g.addNode({ id: "gid", type: "global_id", inputs: {}, outputs: { value: "u32" }, properties: {} });
    g.addNode({ id: "loadPos", type: "buffer_load", inputs: { index: "" }, outputs: { value: "vec3" }, properties: { buffer: "particles", field: "position" } });
    g.addNode({ id: "loadVel", type: "buffer_load", inputs: { index: "" }, outputs: { value: "vec3" }, properties: { buffer: "particles", field: "velocity" } });
    g.connect("gid", "value", "loadPos", "index");
    g.connect("gid", "value", "loadVel", "index");

    // newVel = vel + gravity * dt (simplified)
    g.addNode({ id: "dt", type: "constant", inputs: {}, outputs: { value: "f32" }, properties: { value: 0.016 } });
    g.addNode({ id: "newVel", type: "add", inputs: { a: "", b: "" }, outputs: { result: "vec3" }, properties: {} });
    g.connect("loadVel", "value", "newVel", "a");
    g.connect("dt", "value", "newVel", "b");

    // store new velocity
    g.addNode({ id: "storeVel", type: "buffer_store", inputs: { index: "", value: "" }, outputs: {}, properties: { buffer: "particles", field: "velocity" } });
    g.connect("gid", "value", "storeVel", "index");
    g.connect("newVel", "result", "storeVel", "value");

    const compiler = new ComputeGraphCompiler();
    const wgsl = compiler.compile(g, { profile: SIMPLE_COMPUTE_PROFILE });
    expect(wgsl).toContain("struct Particle");
    expect(wgsl).toContain("struct SimParams");
    expect(wgsl).toContain("@compute @workgroup_size(64, 1, 1)");
    expect(wgsl).toContain("particles[gid.x].velocity =");
  });
});
