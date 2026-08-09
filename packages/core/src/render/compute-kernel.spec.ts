import { runComputeKernel, type ComputeKernelInput } from "./compute-kernel";

// Mock GPUDevice for testing the kernel helper's buffer/pipeline construction.
function createMockDevice(): any {
  const buffers: any[] = [];
  return {
    createBuffer: (desc: any) => {
      const buf = {
        size: desc.size,
        usage: desc.usage,
        label: desc.label,
        destroy: () => {},
        mapAsync: async () => {},
        getMappedRange: () => new ArrayBuffer(desc.size),
        unmap: () => {},
        _desc: desc,
      };
      buffers.push(buf);
      return buf;
    },
    createShaderModule: (desc: any) => ({ code: desc.code }),
    createBindGroupLayout: (desc: any) => ({ entries: desc.entries }),
    createPipelineLayout: (desc: any) => ({ bindGroupLayouts: desc.bindGroupLayouts }),
    createComputePipeline: (desc: any) => ({
      layout: desc.layout,
      compute: desc.compute,
    }),
    createBindGroup: (desc: any) => ({ layout: desc.layout, entries: desc.entries }),
    createCommandEncoder: (desc?: any) => ({
      beginComputePass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        dispatchWorkgroups: () => {},
        end: () => {},
      }),
      copyBufferToBuffer: () => {},
      finish: () => ({}),
      label: desc?.label,
    }),
    queue: {
      writeBuffer: () => {},
      submit: () => {},
    },
    _buffers: buffers,
  };
}

describe("runComputeKernel", () => {
  it("should create buffers for each input", async () => {
    const mockDevice = createMockDevice();
    const inputs: ComputeKernelInput[] = [
      { name: "data", data: new Float32Array([1, 2, 3, 4]), type: "storage", access: "read_write" },
      { name: "params", data: new Float32Array([2.0]), type: "uniform" },
    ];

    const result = await runComputeKernel(
      mockDevice,
      `@group(0) @binding(0) var<storage, read_write> data: array<f32>;
       @group(0) @binding(1) var<uniform> params: f32;
       @compute @workgroup_size(64) fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {}`,
      inputs,
      [64, 1, 1],
      [1, 1, 1],
    );

    expect(result.buffers.size).toBe(2);
    expect(result.buffers.has("data")).toBe(true);
    expect(result.buffers.has("params")).toBe(true);
  });

  it("should create readback buffer for read_write storage", async () => {
    const mockDevice = createMockDevice();
    const inputs: ComputeKernelInput[] = [
      { name: "data", data: new Float32Array([1, 2, 3, 4]), type: "storage", access: "read_write" },
    ];

    const result = await runComputeKernel(
      mockDevice,
      `@group(0) @binding(0) var<storage, read_write> data: array<f32>;
       @compute @workgroup_size(64) fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {}`,
      inputs,
      [64, 1, 1],
      [1, 1, 1],
    );

    // readBuffer should work for read_write storage
    const data = await result.readBuffer("data");
    expect(data).toBeInstanceOf(ArrayBuffer);
  });

  it("should not create readback buffer for write-only storage", async () => {
    const mockDevice = createMockDevice();
    const inputs: ComputeKernelInput[] = [
      { name: "output", data: new Float32Array([0, 0, 0, 0]), type: "storage", access: "write" },
    ];

    const result = await runComputeKernel(
      mockDevice,
      `@group(0) @binding(0) var<storage, write> output: array<f32>;
       @compute @workgroup_size(64) fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {}`,
      inputs,
      [64, 1, 1],
      [1, 1, 1],
    );

    // readBuffer should throw for write-only
    await expect(result.readBuffer("output")).rejects.toThrow("No readback buffer");
  });

  it("should throw on readBuffer for unknown name", async () => {
    const mockDevice = createMockDevice();
    const result = await runComputeKernel(
      mockDevice,
      `@compute @workgroup_size(64) fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {}`,
      [],
      [64, 1, 1],
      [1, 1, 1],
    );

    await expect(result.readBuffer("nonexistent")).rejects.toThrow("No readback buffer");
  });

  it("should handle empty inputs", async () => {
    const mockDevice = createMockDevice();
    const result = await runComputeKernel(
      mockDevice,
      `@compute @workgroup_size(64) fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {}`,
      [],
      [64, 1, 1],
      [1, 1, 1],
    );

    expect(result.buffers.size).toBe(0);
  });
});
