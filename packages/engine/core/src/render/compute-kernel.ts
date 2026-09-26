// ============================================================================
// runComputeKernel — thin imperative helper for quick one-off GPGPU dispatch.
// The "gpu.js replacement": throw a WGSL kernel at the GPU with typed inputs,
// dispatch once, and read back results. No graph, no frame graph, no editor.
// ============================================================================

import { createValidatedShaderModule } from "./shader-validator";

/** GPUBufferUsage flags. Defined locally for testability. */
const BUFFER_USAGE = {
  UNIFORM: 0x40,
  STORAGE: 0x80,
  COPY_DST: 0x8,
  COPY_SRC: 0x4,
  MAP_READ: 0x1,
} as const;

/** GPUShaderStage.COMPUTE = 0x4. */
const SHADER_STAGE_COMPUTE = 0x4;

/** GPUMapMode.READ = 0x1. */
const MAP_MODE_READ = 0x1;

export interface ComputeKernelInput {
  name: string;
  data: ArrayBufferView;
  type: "storage" | "uniform";
  access?: "read" | "write" | "read_write";
  /** For storage buffers: the WGSL binding type. Defaults to "read_write". */
}

export interface ComputeKernelResult {
  /** Map of buffer name → GPUBuffer (storage + uniform). */
  buffers: Map<string, GPUBuffer>;
  /** Read a storage buffer back to the CPU. Returns a new ArrayBuffer copy. */
  readBuffer: (name: string) => Promise<ArrayBuffer>;
}

/**
 * Run a WGSL compute kernel once and return a result handle for readback.
 *
 * The WGSL must declare `@group(0) @binding(N)` for each input, matching the
 * `name` → `binding` index in the `inputs` array (0-based). The entry point
 * must be `@compute @workgroup_size(...)` with the default name "cs_main"
 * (override via `entryPoint`).
 *
 * @example
 * ```ts
 * const result = await runComputeKernel(device, `
 *   @group(0) @binding(0) var<storage, read_write> data: array<f32>;
 *   @group(0) @binding(1) var<uniform> params: Params;
 *   @compute @workgroup_size(64)
 *   fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
 *     data[gid.x] = data[gid.x] * 2.0;
 *   }
 * `, [
 *   { name: "data", data: new Float32Array([1,2,3,4]), type: "storage", access: "read_write" },
 *   { name: "params", data: paramData, type: "uniform" },
 * ], [64,1,1], [1,1,1]);
 * const output = await result.readBuffer("data");
 * ```
 */
export async function runComputeKernel(
  device: GPUDevice,
  wgsl: string,
  inputs: ComputeKernelInput[],
  workgroupSize: [number, number, number],
  dispatchCount: [number, number, number],
  entryPoint: string = "cs_main",
): Promise<ComputeKernelResult> {
  const buffers = new Map<string, GPUBuffer>();
  const readbackBuffers = new Map<string, GPUBuffer>();
  const bindGroupEntries: GPUBindGroupEntry[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const data = input.data;
    const byteLength = data.byteLength;

    const isUniform = input.type === "uniform";
    const access = input.access ?? (isUniform ? "read" : "read_write");

    const usage = isUniform
      ? BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST
      : BUFFER_USAGE.STORAGE |
        BUFFER_USAGE.COPY_DST |
        BUFFER_USAGE.COPY_SRC;

    const buffer = device.createBuffer({
      label: `kernel:${input.name}`,
      size: Math.max(byteLength, 16),
      usage,
    });

    device.queue.writeBuffer(buffer, 0, data as unknown as BufferSource);
    buffers.set(input.name, buffer);
    bindGroupEntries.push({ binding: i, resource: { buffer } });

    // Create a readback buffer for storage buffers with read access
    if (!isUniform && access !== "write") {
      const readbackBuf = device.createBuffer({
        label: `kernel:${input.name}:readback`,
        size: Math.max(byteLength, 16),
        usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST,
      });
      readbackBuffers.set(input.name, readbackBuf);
    }
  }

  // Build bind group layout from inputs
  const layoutEntries: GPUBindGroupLayoutEntry[] = inputs.map((input, i) => {
    const isUniform = input.type === "uniform";
    const access = input.access ?? (isUniform ? "read" : "read_write");
    return {
      binding: i,
      visibility: SHADER_STAGE_COMPUTE,
      buffer: {
        type: isUniform
          ? "uniform"
          : access === "read"
            ? "read-only-storage"
            : "storage",
      },
    } as GPUBindGroupLayoutEntry;
  });

  const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  const shaderModule = createValidatedShaderModule(device, { code: wgsl, label: "ComputeKernel" });
  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module: shaderModule, entryPoint },
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: bindGroupEntries,
  });

  // Dispatch
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(dispatchCount[0], dispatchCount[1], dispatchCount[2]);
  pass.end();

  // Copy storage buffers to readback buffers
  for (const [name, readbackBuf] of readbackBuffers.entries()) {
    const src = buffers.get(name);
    if (src) {
      encoder.copyBufferToBuffer(src, 0, readbackBuf, 0, readbackBuf.size);
    }
  }

  device.queue.submit([encoder.finish()]);

  // Readback function
  const readBuffer = async (name: string): Promise<ArrayBuffer> => {
    const readbackBuf = readbackBuffers.get(name);
    if (!readbackBuf) {
      throw new Error(`No readback buffer for "${name}" (it may be write-only or uniform)`);
    }
    await readbackBuf.mapAsync(MAP_MODE_READ);
    const arrayBuffer = readbackBuf.getMappedRange().slice(0);
    readbackBuf.unmap();
    return arrayBuffer;
  };

  return { buffers, readBuffer };
}
