import { describe, expect, it } from "bun:test";
import { AsyncPipelinePool, pipelinePool } from "./pipeline-pool";

// ============================================================================
// pipeline-pool — async-first pipeline acquisition with per-device memoization.
// Mock devices emulate the three device flavors:
//   - async-capable (createRenderPipelineAsync returns a promise)
//   - sync-only (no async method — mock devices / pre-async platform libs)
//   - failing (compile error → error state)
// ============================================================================

function makeDesc(label = "test"): GPURenderPipelineDescriptor {
  return {
    label,
    vertex: { module: {} as GPUShaderModule, entryPoint: "vs_main" },
    fragment: { module: {} as GPUShaderModule, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  } as GPURenderPipelineDescriptor;
}

function makeComputeDesc(label = "test"): GPUComputePipelineDescriptor {
  return {
    label,
    compute: { module: {} as GPUShaderModule, entryPoint: "main" },
  } as GPUComputePipelineDescriptor;
}

/** Device whose async methods resolve on a microtask after recording the call. */
function makeAsyncDevice() {
  const calls: { render: number; compute: number } = { render: 0, compute: 0 };
  const device = {
    createRenderPipelineAsync: async (desc: GPURenderPipelineDescriptor) => {
      calls.render++;
      return { kind: "render-pipeline", desc } as unknown as GPURenderPipeline;
    },
    createComputePipelineAsync: async (desc: GPUComputePipelineDescriptor) => {
      calls.compute++;
      return { kind: "compute-pipeline", desc } as unknown as GPUComputePipeline;
    },
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) =>
      ({ kind: "sync-render-pipeline", desc }) as unknown as GPURenderPipeline,
    createComputePipeline: (desc: GPUComputePipelineDescriptor) =>
      ({ kind: "sync-compute-pipeline", desc }) as unknown as GPUComputePipeline,
  } as unknown as GPUDevice;
  return { device, calls };
}

/** Device with no async pipeline methods (mock devices, old native libs). */
function makeSyncOnlyDevice() {
  const calls = { render: 0 };
  const device = {
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => {
      calls.render++;
      return { kind: "sync-render-pipeline", desc } as unknown as GPURenderPipeline;
    },
  } as unknown as GPUDevice;
  return { device, calls };
}

describe("AsyncPipelinePool", () => {
  it("returns null while the async compile is in flight, then the pipeline", async () => {
    const { device, calls } = makeAsyncDevice();
    const pool = new AsyncPipelinePool(device);

    const pending = pool.acquireRender("k1", () => makeDesc());
    expect(pending).toBeNull(); // compile in flight — caller skips this frame
    expect(calls.render).toBe(1);
    expect(pool.pendingCount()).toBe(1);

    // A second acquire while pending must NOT start a duplicate compile.
    expect(pool.acquireRender("k1", () => makeDesc())).toBeNull();
    expect(calls.render).toBe(1);

    await pool.whenSettled();
    const ready = pool.acquireRender("k1", () => makeDesc());
    expect(ready).not.toBeNull();
    expect((ready as unknown as { kind: string }).kind).toBe("render-pipeline");
    expect(calls.render).toBe(1); // memoized — still one compile
    expect(pool.pendingCount()).toBe(0);
  });

  it("falls back to synchronous creation when the device lacks async methods", () => {
    const { device, calls } = makeSyncOnlyDevice();
    const pool = new AsyncPipelinePool(device);

    const pipeline = pool.acquireRender("k1", () => makeDesc());
    expect(pipeline).not.toBeNull(); // sync fallback returns immediately
    expect(calls.render).toBe(1);
    expect(pool.pendingCount()).toBe(0);
  });

  it("does not invoke makeDesc on a cache hit", async () => {
    const { device } = makeAsyncDevice();
    const pool = new AsyncPipelinePool(device);
    await pool.acquireRender("k1", () => makeDesc());
    await pool.whenSettled();

    let descCalls = 0;
    pool.acquireRender("k1", () => { descCalls++; return makeDesc(); });
    expect(descCalls).toBe(0);
  });

  it("shares the pool across devices via pipelinePool() and keeps pools separate", async () => {
    const { device: a } = makeAsyncDevice();
    const { device: b } = makeAsyncDevice();
    expect(pipelinePool(a)).toBe(pipelinePool(a));
    expect(pipelinePool(a)).not.toBe(pipelinePool(b));
  });

  it("marks compile failures as error and stops retrying", async () => {
    const device = {
      createRenderPipelineAsync: async () => { throw new Error("shader bad"); },
      createRenderPipeline: () => ({} as GPURenderPipeline),
    } as unknown as GPUDevice;
    const pool = new AsyncPipelinePool(device);

    expect(pool.acquireRender("bad", () => makeDesc())).toBeNull();
    await pool.whenSettled();
    // Error state — further acquires return null without recompiling.
    expect(pool.acquireRender("bad", () => { throw new Error("makeDesc should not run"); })).toBeNull();
  });

  it("handles synchronous descriptor-throw as an error state", () => {
    const { device } = makeSyncOnlyDevice();
    const pool = new AsyncPipelinePool(device);
    expect(pool.acquireRender("bad", () => { throw new Error("bad desc"); })).toBeNull();
    expect(pool.acquireRender("bad", () => { throw new Error("nope"); })).toBeNull();
  });

  it("acquires compute pipelines through the async path", async () => {
    const { device, calls } = makeAsyncDevice();
    const pool = new AsyncPipelinePool(device);

    expect(pool.acquireCompute("c1", () => makeComputeDesc())).toBeNull();
    expect(calls.compute).toBe(1);
    await pool.whenSettled();
    const p = pool.acquireCompute("c1", () => makeComputeDesc());
    expect((p as unknown as { kind: string }).kind).toBe("compute-pipeline");
  });

  it("whenSettled resolves only after all pending compiles settle", async () => {
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    const device = {
      createRenderPipelineAsync: async (d: GPURenderPipelineDescriptor) => {
        await gate;
        return { desc: d } as unknown as GPURenderPipeline;
      },
    } as unknown as GPUDevice;
    const pool = new AsyncPipelinePool(device);

    pool.acquireRender("a", () => makeDesc("a"));
    pool.acquireRender("b", () => makeDesc("b"));
    expect(pool.pendingCount()).toBe(2);

    let settled = false;
    void pool.whenSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveGate();
    await pool.whenSettled();
    expect(settled).toBe(true);
  });
});

// ── Real device: pooled async compile → resolve → draw → readback ────────────

async function tryCreateDevice() {
  const { wgpu } = await import("@downdraft/platform-native/gpu/wgpu-ffi");
  const { queryNativeFeatures, serializeRequiredFeatures, serializeRequiredLimits } = await import(
    "@downdraft/platform-native/gpu/limits"
  );
  const { computeDeviceDescriptor } = await import("@downdraft/platform-native/gpu/device-request");
  const { WgpuDevice } = await import("@downdraft/platform-native/gpu/wgpu-device");

  const inst = wgpu.wgpu_shim_create_instance() as unknown as number;
  const adapterPtr = wgpu.wgpu_shim_request_adapter(inst, 0) as unknown as number;
  if (!adapterPtr) return null;
  const features = queryNativeFeatures(adapterPtr, false);
  const has = (f: string) => (features as unknown as { has(f: string): boolean }).has(f);
  const desc = computeDeviceDescriptor({ features: { has }, limits: {} } as GPUAdapter);
  const wireFeatures = serializeRequiredFeatures(desc.requiredFeatures as unknown as string[]);
  const wireLimits = serializeRequiredLimits(desc.requiredLimits as Record<string, number>);
  const devicePtr = wgpu.wgpu_shim_request_device(
    adapterPtr,
    wireLimits as unknown as number,
    wireLimits.length / 3,
    wireFeatures as unknown as number,
    wireFeatures.length,
  ) as unknown as number;
  if (!devicePtr) return null;
  return new WgpuDevice(devicePtr, inst) as unknown as GPUDevice;
}

const POOL_WGSL = /* wgsl */ `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let x = f32(vi & 1u) * 4.0 - 1.0;
  let y = f32((vi >> 1u) & 1u) * 4.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }
`;

describe("AsyncPipelinePool — real device", () => {
  it("async-compiles through the pool and the resolved pipeline draws", async () => {
    let device: GPUDevice | null = null;
    try {
      device = await tryCreateDevice();
    } catch {
      /* no adapter */
    }
    if (!device) {
      if ((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.DD_REQUIRE_GPU === "1") {
        throw new Error("DD_REQUIRE_GPU=1 but no native adapter available");
      }
      return;
    }
    const { installGPU } = await import("@downdraft/platform-native/gpu/install");
    installGPU();
    const dev = device;

    const shader = dev.createShaderModule({ code: POOL_WGSL });
    const pool = pipelinePool(dev);
    const desc = (): GPURenderPipelineDescriptor => ({
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });

    const first = pool.acquireRender("e2e:green", desc);
    if ((dev as { createRenderPipelineAsync?: unknown }).createRenderPipelineAsync) {
      expect(first).toBeNull(); // compile in flight on the native worker
      await pool.whenSettled();
    } else {
      expect(first).not.toBeNull(); // sync fallback
    }
    const pipeline = pool.acquireRender("e2e:green", desc);
    expect(pipeline).not.toBeNull();

    const W = 16;
    const H = 16;
    const target = dev.createTexture({
      size: { width: W, height: H },
      format: "rgba8unorm",
      usage: 0x10 /* RENDER_ATTACHMENT */ | 0x01 /* COPY_SRC */,
    });
    const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
    const readback = dev.createBuffer({
      size: bytesPerRow * H,
      usage: 0x0001 /* MAP_READ */ | 0x0008 /* COPY_DST */,
    });

    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline!);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow },
      { width: W, height: H },
    );
    dev.queue.submit([encoder.finish()]);

    await readback.mapAsync(0x0001 /* GPUMapMode.READ */);
    const px = new Uint8Array(readback.getMappedRange());
    const i = Math.floor(H / 2) * bytesPerRow + Math.floor(W / 2) * 4;
    readback.unmap();

    expect(px[i]).toBeLessThan(50); // R
    expect(px[i + 1]).toBeGreaterThan(200); // G
    expect(px[i + 2]).toBeLessThan(50); // B
  });
});
