/**
 * AUDIT FIX smoke test: verifies the newly-implemented APIs work and that
 * unsupported APIs throw loudly. Run with: bun test src/gpu/test-gpu-audit.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { installGPU } from "./install";
import type { WgpuDevice, WgpuQuerySet } from "./wgpu-wrapper";

let device: WgpuDevice;

beforeAll(async () => {
  installGPU();
  const adapter = await navigator.gpu!.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter");
  device = (await adapter.requestDevice()) as unknown as WgpuDevice;
});

describe("AUDIT FIX: query sets", () => {
  test("createQuerySet creates a real query set (not a fake object)", () => {
    const qs = device.createQuerySet({ type: "occlusion", count: 4 }) as WgpuQuerySet;
    expect(qs).toBeDefined();
    expect(qs.ptr).toBeGreaterThan(0);
    expect(qs.type).toBe("occlusion");
    expect(qs.count).toBe(4);
    qs.destroy();
  });

  test("createQuerySet for timestamps works when feature is supported", () => {
    // Only test if the device actually supports timestamp-query.
    const hasTs = device.features.has("timestamp-query");
    if (!hasTs) {
      console.log("  (skipped: timestamp-query not supported on this device)");
      return;
    }
    const qs = device.createQuerySet({ type: "timestamp", count: 2 }) as WgpuQuerySet;
    expect(qs.ptr).toBeGreaterThan(0);
    expect(qs.type).toBe("timestamp");
    qs.destroy();
  });
});

describe("AUDIT FIX: clearBuffer", () => {
  test("clearBuffer does not throw", () => {
    const buf = device.createBuffer({ size: 256, usage: 0x0008 | 0x0040 /* COPY_DST | UNIFORM */ });
    const encoder = device.createCommandEncoder();
    expect(() => encoder.clearBuffer(buf, 0, 256)).not.toThrow();
    const cmd = encoder.finish();
    device.queue.submit([cmd]);
    buf.destroy();
  });
});

describe("AUDIT FIX: comparison sampler (shadow mapping)", () => {
  test("createSampler with compare: 'less' does not throw", () => {
    expect(() => {
      device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" });
    }).not.toThrow();
  });
});

describe("AUDIT FIX: error scopes", () => {
  test("popErrorScope returns null when no error", async () => {
    device.pushErrorScope("validation");
    const err = await device.popErrorScope();
    expect(err).toBeNull();
  });
});

describe("AUDIT FIX: executeBundles throws", () => {
  test("executeBundles throws (not silently no-op)", () => {
    const tex = device.createTexture({
      size: [64, 64, 1],
      format: "bgra8unorm",
      usage: 0x0010 /* RENDER_ATTACHMENT */,
    });
    const view = tex.createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: view as unknown as GPUTextureView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    expect(() => pass.executeBundles([])).toThrow();
    pass.end();
    tex.destroy();
  });
});

describe("AUDIT FIX: copyTextureToTexture", () => {
  test("copyTextureToTexture does not throw", () => {
    const usage = 0x01 | 0x02 /* COPY_SRC | COPY_DST */;
    const src = device.createTexture({ size: [64, 64, 1], format: "bgra8unorm", usage });
    const dst = device.createTexture({ size: [64, 64, 1], format: "bgra8unorm", usage });
    const encoder = device.createCommandEncoder();
    expect(() => {
      encoder.copyTextureToTexture(
        { texture: src as unknown as GPUTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { texture: dst as unknown as GPUTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { width: 64, height: 64, depthOrArrayLayers: 1 },
      );
    }).not.toThrow();
    const cmd = encoder.finish();
    device.queue.submit([cmd]);
    src.destroy();
    dst.destroy();
  });
});

describe("AUDIT FIX: real limits/features query", () => {
  test("device.limits has real values (not all-zero)", () => {
    const limits = device.limits as any;
    expect(limits.maxTextureDimension2D).toBeGreaterThan(0);
    expect(limits.maxBindGroups).toBeGreaterThan(0);
    expect(limits.maxColorAttachments).toBeGreaterThan(0);
  });

  test("device.features is a Set", () => {
    expect(device.features).toBeInstanceOf(Set);
  });
});

describe("AUDIT FIX: default texture-view caching", () => {
  // The render loop called texture.createView() several times per frame on the
  // same surface/depth texture; each call minted a native view handle that was
  // only reclaimed by GC, so live handles grew without bound. Descriptor-less
  // createView() now returns a per-texture cached default view.
  test("descriptor-less createView returns the cached default view", () => {
    const tex = device.createTexture({
      size: [64, 64, 1],
      format: "bgra8unorm",
      usage: 0x0010 /* RENDER_ATTACHMENT */,
    });
    const v1 = tex.createView();
    const v2 = tex.createView();
    expect(v2).toBe(v1);
    tex.destroy();
  });

  test("descriptor'd createView always mints a fresh view", () => {
    const tex = device.createTexture({
      size: [64, 64, 1],
      format: "bgra8unorm",
      usage: 0x0010 /* RENDER_ATTACHMENT */,
    });
    const v1 = tex.createView({ format: "bgra8unorm" });
    const v2 = tex.createView({ format: "bgra8unorm" });
    expect(v2).not.toBe(v1);
    tex.destroy();
  });

  test("destroy() releases the cached view", () => {
    const tex = device.createTexture({
      size: [64, 64, 1],
      format: "bgra8unorm",
      usage: 0x0010 /* RENDER_ATTACHMENT */,
    });
    const v1 = tex.createView() as import("./wgpu-resources").WgpuTextureView;
    tex.destroy();
    expect(v1.isReleased).toBe(true);
  });
});

describe("AUDIT FIX: setBlendConstant + setStencilReference", () => {
  test("setBlendConstant does not throw", () => {
    const tex = device.createTexture({
      size: [64, 64, 1],
      format: "bgra8unorm",
      usage: 0x0010 /* RENDER_ATTACHMENT */,
    });
    const view = tex.createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: view as unknown as GPUTextureView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    expect(() => pass.setBlendConstant({ r: 1, g: 0, b: 0, a: 1 })).not.toThrow();
    expect(() => pass.setStencilReference(0)).not.toThrow();
    pass.end();
    tex.destroy();
  });
});
