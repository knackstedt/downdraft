import { describe, expect, it, vi } from "bun:test";
import { RenderPipeline, type RenderContext } from "./render-pipeline";

function createMockContext(): RenderContext {
  return {
    device: {} as GPUDevice,
    encoder: {} as GPUCommandEncoder,
    passEncoder: {} as GPURenderPassEncoder,
    camera: {
      position: [0, 0, 0],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: 60,
      near: 0.1,
      far: 1000,
      aspect: 1,
    },
    viewport: { x: 0, y: 0, w: 800, h: 600 },
    viewportIdx: 0,
    viewportCount: 1,
    dt: 0.016,
    elapsedTime: 0,
    isFirstViewport: true,
    isLastViewport: true,
  };
}

describe("RenderContext", () => {
  it("includes device, encoder, and passEncoder fields", () => {
    const ctx = createMockContext();
    expect(ctx.device).toBeDefined();
    expect(ctx.encoder).toBeDefined();
    expect(ctx.passEncoder).toBeDefined();
  });
});

describe("RenderPipeline", () => {
  it("executes registered passes with context", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque", "transparent", "ui"]);

    const renderFn = vi.fn();
    pipeline.registerPass("opaque", "opaque-pass", renderFn);

    const ctx = createMockContext();
    pipeline.render(ctx);

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(renderFn).toHaveBeenCalledWith(ctx);
  });

  it("maintains slot ordering", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b", "c"]);

    const order: string[] = [];
    pipeline.registerPass("c", "pass-c", () => order.push("c"));
    pipeline.registerPass("a", "pass-a", () => order.push("a"));
    pipeline.registerPass("b", "pass-b", () => order.push("b"));

    const ctx = createMockContext();
    pipeline.render(ctx);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("unregisterPass removes passes", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const fn1 = vi.fn();
    const fn2 = vi.fn();
    pipeline.registerPass("opaque", "pass1", fn1);
    pipeline.registerPass("opaque", "pass2", fn2);
    pipeline.unregisterPass("pass1");

    pipeline.render(createMockContext());

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("clear removes all passes", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const fn = vi.fn();
    pipeline.registerPass("opaque", "pass1", fn);
    pipeline.clear();

    pipeline.render(createMockContext());

    expect(fn).not.toHaveBeenCalled();
  });

  it("getEntries returns sorted entries", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b", "c"]);

    pipeline.registerPass("c", "pass-c", vi.fn());
    pipeline.registerPass("a", "pass-a", vi.fn());
    pipeline.registerPass("b", "pass-b", vi.fn());

    const entries = pipeline.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].slot).toBe("a");
    expect(entries[1].slot).toBe("b");
    expect(entries[2].slot).toBe("c");
  });

  it("getEntries caches sorted order until dirty", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b"]);

    pipeline.registerPass("a", "pass-a", vi.fn());
    const entries1 = pipeline.getEntries();
    const entries2 = pipeline.getEntries();
    expect(entries1).toBe(entries2); // Same reference (cached)
  });

  it("supports multiple passes in the same slot", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const fn1 = vi.fn();
    const fn2 = vi.fn();
    pipeline.registerPass("opaque", "pass1", fn1);
    pipeline.registerPass("opaque", "pass2", fn2);

    pipeline.render(createMockContext());

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("passes with unknown slots get order after known slots", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b"]);

    const order: string[] = [];
    pipeline.registerPass("b", "pass-b", () => order.push("b"));
    pipeline.registerPass("unknown", "pass-unknown", () => order.push("unknown"));
    pipeline.registerPass("a", "pass-a", () => order.push("a"));

    pipeline.render(createMockContext());

    expect(order).toEqual(["a", "b", "unknown"]);
  });

  it("RenderPassEntry has correct structure", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const renderFn = vi.fn();
    pipeline.registerPass("opaque", "my-pass", renderFn);

    const entries = pipeline.getEntries();
    expect(entries[0].slot).toBe("opaque");
    expect(entries[0].name).toBe("my-pass");
    expect(entries[0].render).toBe(renderFn);
    expect(typeof entries[0].order).toBe("number");
  });
});
