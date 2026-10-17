// offscreen-scale.spec.ts — ResolutionScaleOffscreen contract tests (mock
// device) plus a real-device blit→readback check when a native adapter is
// available (DOWNDRAFT_GPU=swiftshader / DD_REQUIRE_GPU=1 in CI).
import { describe, expect, it } from "bun:test";
import { ResolutionScaleOffscreen } from "./offscreen-scale";

(globalThis as Record<string, unknown>).GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
};
(globalThis as Record<string, unknown>).GPUShaderStage ??= {
  VERTEX: 0x0001,
  FRAGMENT: 0x0002,
  COMPUTE: 0x0004,
};
(globalThis as Record<string, unknown>).GPUMapMode ??= {
  READ: 0x0001,
  WRITE: 0x0002,
};

// ── Mock device ─────────────────────────────────────────────────────────────

function mockDevice() {
  const calls = {
    textures: [] as Array<{ size: { width: number; height: number }; format: string; usage: number }>,
    bindGroups: 0,
    draws: 0,
    passLabels: [] as string[],
    destroyed: 0,
  };
  const device = {
    createTexture: (d: { size: { width: number; height: number }; format: string; usage: number }) => {
      calls.textures.push(d);
      return { createView: () => ({ format: d.format }), destroy: () => { calls.destroyed++; } };
    },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createSampler: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => { calls.bindGroups++; return {}; },
    createCommandEncoder: () => ({
      beginRenderPass: (d: { label?: string }) => {
        calls.passLabels.push(d.label ?? "");
        return {
          setPipeline() {}, setBindGroup() {},
          draw() { calls.draws++; },
          end() {},
        };
      },
      finish: () => ({}),
    }),
    queue: { writeBuffer() {}, submit() {} },
  };
  return { device: device as unknown as GPUDevice, calls };
}

// ── Contract tests ───────────────────────────────────────────────────────────

describe("ResolutionScaleOffscreen", () => {
  it("creates scaled color+depth targets from canvas size", () => {
    const { device, calls } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.5 });
    mode.ensureTargets(1280, 720);

    expect(calls.textures.length).toBe(2);
    expect(calls.textures[0]).toMatchObject({ size: { width: 640, height: 360 }, format: "bgra8unorm" });
    expect(calls.textures[0]!.usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
    expect(calls.textures[0]!.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
    expect(calls.textures[1]).toMatchObject({ size: { width: 640, height: 360 }, format: "depth32float" });
  });

  it("reuses targets when the scaled size is unchanged", () => {
    const { device, calls } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.5 });
    mode.ensureTargets(1280, 720);
    mode.ensureTargets(1280, 720);
    expect(calls.textures.length).toBe(2);
    expect(calls.destroyed).toBe(0);
  });

  it("recreates targets on resize and on scale change", () => {
    const { device, calls } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.5 });
    mode.ensureTargets(1280, 720);
    mode.ensureTargets(1920, 1080);
    expect(calls.textures[2]).toMatchObject({ size: { width: 960, height: 540 } });

    mode.setScale(0.25);
    mode.ensureTargets(1920, 1080);
    expect(calls.textures[4]).toMatchObject({ size: { width: 480, height: 270 } });
  });

  it("clamps scaled dims to >= 1 for tiny canvases", () => {
    const { device, calls } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.25 });
    mode.ensureTargets(3, 2);
    expect(calls.textures[0]).toMatchObject({ size: { width: 1, height: 1 } });
  });

  it("scales viewports proportionally and keeps splits contiguous", () => {
    const { device } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.5 });
    expect(mode.scaleViewport!({ x: 0, y: 0, w: 1280, h: 720 })).toEqual({ x: 0, y: 0, w: 640, h: 360 });
    // Split-screen halves must tile the scaled canvas exactly (no seam).
    const left = mode.scaleViewport!({ x: 0, y: 0, w: 641, h: 720 });
    const right = mode.scaleViewport!({ x: 641, y: 0, w: 639, h: 720 });
    expect(left.w).toBe(321); // round(641*0.5)
    expect(right.x).toBe(321); // round(641*0.5) — no overlap, no gap
    expect(right.w).toBe(319); // round(1280*0.5) - 321 = 640-321
  });

  it("blits the scaled color target onto the canvas view", () => {
    const { device, calls } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.5 });
    mode.ensureTargets(1280, 720);
    const enc = device.createCommandEncoder();
    mode.applyPostprocess!(enc, {} as GPUTextureView, 1280, 720);
    expect(calls.passLabels).toEqual(["resolution-scale-blit"]);
    expect(calls.draws).toBe(1); // fullscreen triangle
    expect(calls.bindGroups).toBe(1);
  });

  it("rebuilds the blit bind group only when the color target is recreated", () => {
    const { device, calls } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.5 });
    mode.ensureTargets(1280, 720);
    mode.applyPostprocess!(device.createCommandEncoder(), {} as GPUTextureView, 1280, 720);
    mode.applyPostprocess!(device.createCommandEncoder(), {} as GPUTextureView, 1280, 720);
    expect(calls.bindGroups).toBe(1); // cached across frames
    mode.ensureTargets(640, 360); // resize → new color view
    mode.applyPostprocess!(device.createCommandEncoder(), {} as GPUTextureView, 640, 360);
    expect(calls.bindGroups).toBe(2);
  });

  it("destroy releases both textures", () => {
    const { device, calls } = mockDevice();
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "bgra8unorm", scale: 0.5 });
    mode.ensureTargets(1280, 720);
    mode.destroy();
    expect(calls.destroyed).toBe(2);
  });
});

// ── Real device: scaled render → upscale blit → pixel readback ───────────────

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

const RED_WGSL = /* wgsl */ `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let x = f32(vi & 1u) * 4.0 - 1.0;
  let y = f32((vi >> 1u) & 1u) * 4.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
`;

describe("ResolutionScaleOffscreen — real device", () => {
  it("renders scaled offscreen and upscales onto the canvas view", async () => {
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

    const CANVAS = 64;
    const SCALE = 0.5;
    const mode = new ResolutionScaleOffscreen({ device, surfaceFormat: "rgba8unorm", scale: SCALE });
    mode.ensureTargets(CANVAS, CANVAS);
    expect(mode.getTargetSize()).toEqual({ width: 32, height: 32 });

    // Render solid red into the scaled offscreen target.
    const fillModule = device.createShaderModule({ code: RED_WGSL });
    const fillPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: fillModule, entryPoint: "vs_main" },
      fragment: { module: fillModule, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    const sceneEnc = device.createCommandEncoder();
    const scenePass = sceneEnc.beginRenderPass({
      colorAttachments: [{ view: mode.getColorView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    scenePass.setPipeline(fillPipeline);
    scenePass.draw(3);
    scenePass.end();
    device.queue.submit([sceneEnc.finish()]);

    // Blit the 32×32 offscreen onto a 64×64 "canvas" texture via applyPostprocess.
    const canvasTex = device.createTexture({
      size: { width: CANVAS, height: CANVAS },
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const blitEnc = device.createCommandEncoder();
    mode.applyPostprocess!(blitEnc, canvasTex.createView(), CANVAS, CANVAS);
    device.queue.submit([blitEnc.finish()]);

    // Readback — every canvas pixel must be red.
    const readBuf = device.createBuffer({
      size: CANVAS * CANVAS * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const copyEnc = device.createCommandEncoder();
    copyEnc.copyTextureToBuffer(
      { texture: canvasTex },
      { buffer: readBuf, bytesPerRow: CANVAS * 4 },
      { width: CANVAS, height: CANVAS },
    );
    device.queue.submit([copyEnc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(readBuf.getMappedRange());
    // Corners + center — upscale must cover the whole canvas.
    for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63], [32, 32]]) {
      const i = (y * CANVAS + x) * 4;
      expect(px[i]).toBe(255);
      expect(px[i + 1]).toBe(0);
      expect(px[i + 2]).toBe(0);
      expect(px[i + 3]).toBe(255);
    }
    readBuf.unmap();
    mode.destroy();
  });
});
