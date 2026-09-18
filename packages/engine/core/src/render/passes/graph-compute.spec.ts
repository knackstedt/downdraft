import { ComputeGraph } from "@downdraft/shader-graph";
import { GraphComputePass } from "./graph-compute";

// Minimal mock GPUDevice for unit testing buffer allocation + pipeline creation.
// We can't test actual dispatch without a real GPU, but we can verify the
// pass correctly builds its layout, allocates buffers, and creates a pipeline.
function createMockDevice(): any {
  const buffers: any[] = [];
  return {
    createBuffer: (desc: any) => {
      const buf = {
        size: desc.size,
        usage: desc.usage,
        label: desc.label,
        destroy: () => {},
        _desc: desc,
      };
      buffers.push(buf);
      return buf;
    },
    createShaderModule: (desc: any) => ({ code: desc.code, label: desc.label }),
    createBindGroupLayout: (desc: any) => ({ entries: desc.entries, _desc: desc }),
    createPipelineLayout: (desc: any) => ({ bindGroupLayouts: desc.bindGroupLayouts }),
    createComputePipeline: (desc: any) => ({
      layout: desc.layout,
      compute: desc.compute,
      getBindGroupLayout: (_idx: number) => ({ entries: [] }),
    }),
    createBindGroup: (desc: any) => ({ layout: desc.layout, entries: desc.entries, label: desc.label }),
    queue: {
      writeBuffer: () => {},
    },
    _buffers: buffers,
  };
}

describe("GraphComputePass", () => {
  function createSimpleGraph(): ComputeGraph {
    const g = new ComputeGraph();
    g.addStorageBuffer({
      name: "data",
      binding: 0,
      group: 0,
      access: "read_write",
      structName: "Element",
      structFields: [{ name: "value", type: "f32" }],
      elementCount: 256,
    });
    g.addUniformBuffer({
      name: "params",
      binding: 1,
      group: 0,
      structName: "Params",
      structFields: [{ name: "scale", type: "f32" }],
    });
    g.addNode({ id: "gid", type: "global_id", inputs: {}, outputs: { value: "u32" }, properties: {} });
    g.addNode({ id: "load", type: "buffer_load", inputs: { index: "" }, outputs: { value: "f32" }, properties: { buffer: "data", field: "value" } });
    g.addNode({ id: "store", type: "buffer_store", inputs: { index: "", value: "" }, outputs: {}, properties: { buffer: "data", field: "value" } });
    g.connect("gid", "value", "load", "index");
    g.connect("gid", "value", "store", "index");
    g.connect("load", "value", "store", "value");
    g.setDispatchConfig({ workgroupSize: [64, 1, 1], dispatchCount: [4, 1, 1] });
    return g;
  }

  it("should create a pass with correct name and pass type", () => {
    const g = createSimpleGraph();
    const pass = new GraphComputePass("test-compute", g);
    expect(pass.name).toBe("test-compute");
    expect(pass.passType).toBe("custom");
  });

  it("should prepare and auto-allocate buffers", () => {
    const g = createSimpleGraph();
    const pass = new GraphComputePass("test-compute", g);
    const mockDevice = createMockDevice();
    pass.prepare(mockDevice);

    const owned = pass.getOwnedBuffers();
    expect(owned.length).toBe(2);
    expect(owned.some((b) => b.name === "data")).toBe(true);
    expect(owned.some((b) => b.name === "params")).toBe(true);
    pass.destroy();
  });

  it("should use external buffers when provided", () => {
    const g = createSimpleGraph();
    const pass = new GraphComputePass("test-compute", g);

    const externalDataBuffer = { size: 1024, usage: 0, destroy: () => {} };
    pass.setExternalBuffer("data", externalDataBuffer as any);

    const mockDevice = createMockDevice();
    pass.prepare(mockDevice);

    // "data" should NOT be in owned buffers (it's external)
    const owned = pass.getOwnedBuffers();
    expect(owned.some((b) => b.name === "data")).toBe(false);
    // "params" should still be auto-allocated
    expect(owned.some((b) => b.name === "params")).toBe(true);

    // getBuffer should return the external one
    expect(pass.getBuffer("data")).toBe(externalDataBuffer);
    pass.destroy();
  });

  it("should get buffer by name (owned or external)", () => {
    const g = createSimpleGraph();
    const pass = new GraphComputePass("test-compute", g);
    const mockDevice = createMockDevice();
    pass.prepare(mockDevice);

    const dataBuf = pass.getBuffer("data");
    expect(dataBuf).not.toBeNull();
    expect(dataBuf?.size).toBeGreaterThan(0);

    const paramsBuf = pass.getBuffer("params");
    expect(paramsBuf).not.toBeNull();

    expect(pass.getBuffer("nonexistent")).toBeNull();
    pass.destroy();
  });

  it("should queue uniform data via writeUniform", () => {
    const g = createSimpleGraph();
    const pass = new GraphComputePass("test-compute", g);
    const mockDevice = createMockDevice();
    pass.prepare(mockDevice);

    // Should not throw
    pass.writeUniform("params", new Float32Array([1.0]));
    pass.destroy();
  });

  it("should handle recompile for hot-reload", () => {
    const g = createSimpleGraph();
    const pass = new GraphComputePass("test-compute", g);
    const mockDevice = createMockDevice();
    pass.prepare(mockDevice);

    // Should not throw
    pass.recompile();
    pass.destroy();
  });

  it("should handle destroy cleanly", () => {
    const g = createSimpleGraph();
    const pass = new GraphComputePass("test-compute", g);
    const mockDevice = createMockDevice();
    pass.prepare(mockDevice);
    pass.destroy();

    expect(pass.getOwnedBuffers().length).toBe(0);
    expect(pass.getBuffer("data")).toBeNull();
  });
});
