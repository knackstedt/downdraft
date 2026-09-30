import { afterAll, describe, expect, it } from "bun:test";
import { GPUProfiler } from "./gpu-profiler";
import type { PassTiming } from "./collector";

// Stub WebGPU constants
const _orig_GPUBufferUsage = (globalThis as any).GPUBufferUsage;
afterAll(() => {
  if (_orig_GPUBufferUsage === undefined) delete (globalThis as any).GPUBufferUsage; else (globalThis as any).GPUBufferUsage = _orig_GPUBufferUsage;
});
(globalThis as any).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
  INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
  INDIRECT: 256, QUERY_RESOLVE: 512,
};

function createMockDevice(features: string[]): any {
  return {
    features: { has: (f: string) => features.includes(f) },
    createQuerySet: (opts: any) => ({ ...opts, destroy: () => {} }),
    createBuffer: (opts: any) => ({
      ...opts, destroy: () => {},
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(opts.size),
      unmap: () => {},
    }),
    onuncapturederror: null as any,
    lost: Promise.resolve({ reason: "ok", message: "" }),
  };
}

describe("GPUProfiler compute/blit pass timing", () => {
  it("beginComputePass/endComputePass record category='compute'", () => {
    const device = createMockDevice(["timestamp-query", "timestamp-query-inside-passes"]);
    const profiler = new GPUProfiler();
    profiler.init(device, null, "bgra8unorm", 16);

    profiler.beginFrame();
    const mockComputePass = { writeTimestamp: () => {} };
    profiler.beginComputePass("fluid-compute", mockComputePass as any);
    profiler.endComputePass("fluid-compute", mockComputePass as any, 64);

    const timings = profiler.getPassTimings();
    const fluidTiming = timings.find((t) => t.name === "fluid-compute");
    expect(fluidTiming).toBeDefined();
    expect(fluidTiming!.category).toBe("compute");
    expect(fluidTiming!.drawCalls).toBe(64); // workgroups stored in drawCalls
  });

  it("beginBlitPass/endBlitPass record category='blit'", () => {
    const device = createMockDevice(["timestamp-query", "timestamp-query-inside-passes"]);
    const profiler = new GPUProfiler();
    profiler.init(device, null, "bgra8unorm", 16);

    profiler.beginFrame();
    const mockEncoder = { writeTimestamp: () => {} };
    profiler.beginBlitPass("copy-buffers", mockEncoder as any);
    profiler.endBlitPass("copy-buffers", mockEncoder as any);

    const timings = profiler.getPassTimings();
    const blitTiming = timings.find((t) => t.name === "copy-buffers");
    expect(blitTiming).toBeDefined();
    expect(blitTiming!.category).toBe("blit");
  });

  it("beginPass/endPass still record category='render'", () => {
    const device = createMockDevice(["timestamp-query", "timestamp-query-inside-passes"]);
    const profiler = new GPUProfiler();
    profiler.init(device, null, "bgra8unorm", 16);

    profiler.beginFrame();
    const mockRenderPass = { writeTimestamp: () => {} };
    profiler.beginPass("scene-opaque", mockRenderPass as any, 0);
    profiler.endPass("scene-opaque", mockRenderPass as any, 0, 10, 1000);

    const timings = profiler.getPassTimings();
    const renderTiming = timings.find((t) => t.name === "scene-opaque");
    expect(renderTiming).toBeDefined();
    expect(renderTiming!.category).toBe("render");
  });

  it("blit pass works with only timestamp-query (encoder-level)", () => {
    const device = createMockDevice(["timestamp-query"]); // no inside-passes
    const profiler = new GPUProfiler();
    profiler.init(device, null, "bgra8unorm", 16);

    // Inside-pass timers not supported, but encoder-level should work
    expect(profiler.isGpuTimerSupported()).toBe(false);

    profiler.beginFrame();
    const mockEncoder = { writeTimestamp: () => {} };
    // Should not throw even though inside-pass is unsupported
    profiler.beginBlitPass("blit-test", mockEncoder as any);
    profiler.endBlitPass("blit-test", mockEncoder as any);

    const timings = profiler.getPassTimings();
    expect(timings.find((t) => t.name === "blit-test")).toBeDefined();
  });

  it("beginFrame clears all pass timings", () => {
    const device = createMockDevice(["timestamp-query", "timestamp-query-inside-passes"]);
    const profiler = new GPUProfiler();
    profiler.init(device, null, "bgra8unorm", 16);

    profiler.beginFrame();
    const mockPass = { writeTimestamp: () => {} };
    profiler.beginPass("pass1", mockPass as any, 0);
    profiler.endPass("pass1", mockPass as any, 0);
    expect(profiler.getPassTimings().length).toBe(1);

    profiler.beginFrame();
    expect(profiler.getPassTimings().length).toBe(0);
  });
});
