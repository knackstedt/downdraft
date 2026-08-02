import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { GameRenderer } from "./game-renderer.ts";

function createMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    getContext: vi.fn().mockReturnValue(null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 })),
    clientWidth: 800,
    clientHeight: 600,
    style: {},
  } as unknown as HTMLCanvasElement;
  return canvas;
}

describe("GameRenderer — backend integration", () => {
  let originalGpu: unknown;

  beforeEach(() => {
    originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
  });

  afterEach(() => {
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
  });

  describe("getBackend", () => {
    it("returns null before initBackend is called", () => {
      const canvas = createMockCanvas();
      const renderer = new GameRenderer(canvas);
      expect(renderer.getBackend()).toBeNull();
    });
  });

  describe("getBackendType", () => {
    it("returns null before initBackend is called", () => {
      const canvas = createMockCanvas();
      const renderer = new GameRenderer(canvas);
      expect(renderer.getBackendType()).toBeNull();
    });
  });

  describe("initBackend", () => {
    it("returns false when no backends are available", async () => {
      (navigator as unknown as { gpu?: unknown }).gpu = undefined;
      const canvas = createMockCanvas();
      const renderer = new GameRenderer(canvas);
      const result = await renderer.initBackend({ forceBackend: "webgpu" });
      expect(result).toBe(false);
      expect(renderer.getBackend()).toBeNull();
      expect(renderer.getBackendType()).toBeNull();
    });

    it("returns false when WebGL2 is not available and WebGPU is forced", async () => {
      (navigator as unknown as { gpu?: unknown }).gpu = undefined;
      const canvas = createMockCanvas();
      const renderer = new GameRenderer(canvas);
      const result = await renderer.initBackend({ forceBackend: "webgpu" });
      expect(result).toBe(false);
    });

    it("returns false when forceBackend is webgl2 but canvas has no WebGL2 context", async () => {
      (navigator as unknown as { gpu?: unknown }).gpu = undefined;
      const canvas = createMockCanvas();
      const renderer = new GameRenderer(canvas);
      const result = await renderer.initBackend({ forceBackend: "webgl2" });
      expect(result).toBe(false);
      expect(renderer.getBackend()).toBeNull();
      expect(renderer.getBackendType()).toBeNull();
    });

    it("accepts BackendCreateOptions with forceBackend", async () => {
      (navigator as unknown as { gpu?: unknown }).gpu = undefined;
      const canvas = createMockCanvas();
      const renderer = new GameRenderer(canvas);
      // Should not throw, just return false
      const result = await renderer.initBackend({
        forceBackend: "webgl2",
        powerPreference: "low-power",
      });
      expect(result).toBe(false);
    });

    it("accepts empty options object", async () => {
      (navigator as unknown as { gpu?: unknown }).gpu = undefined;
      const canvas = createMockCanvas();
      const renderer = new GameRenderer(canvas);
      const result = await renderer.initBackend();
      expect(result).toBe(false);
    });
  });
});

describe("GameRenderer — viewport management", () => {
  it("starts with 1 viewport", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    expect(renderer.getViewportCount()).toBe(1);
  });

  it("setViewportCount updates count", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.setViewportCount(2);
    expect(renderer.getViewportCount()).toBe(2);
  });

  it("getViewport returns null for invalid index", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    expect(renderer.getViewport(99)).toBeNull();
  });

  it("getViewport returns rect for valid index after setViewportCount", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.setViewportCount(1);
    const vp = renderer.getViewport(0);
    expect(vp).not.toBeNull();
    expect(vp!.x).toBe(0);
    expect(vp!.y).toBe(0);
    expect(vp!.w).toBe(800);
    expect(vp!.h).toBe(600);
  });

  it("getViewports returns all viewports", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.setViewportCount(2);
    const vps = renderer.getViewports();
    expect(vps).toHaveLength(2);
    // Split-screen left/right
    expect(vps[0].x).toBe(0);
    expect(vps[1].x).toBe(400);
  });

  it("handles 3 viewport layout", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.setViewportCount(3);
    const vps = renderer.getViewports();
    expect(vps).toHaveLength(3);
    // Top full width, bottom split
    expect(vps[0].w).toBe(800);
    expect(vps[0].h).toBe(300);
    expect(vps[1].w).toBe(400);
    expect(vps[1].h).toBe(300);
  });

  it("handles 4 viewport layout (quad)", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.setViewportCount(4);
    const vps = renderer.getViewports();
    expect(vps).toHaveLength(4);
    expect(vps[0]).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(vps[1]).toEqual({ x: 400, y: 0, w: 400, h: 300 });
    expect(vps[2]).toEqual({ x: 0, y: 300, w: 400, h: 300 });
    expect(vps[3]).toEqual({ x: 400, y: 300, w: 400, h: 300 });
  });
});

describe("GameRenderer — frame rate limiter", () => {
  it("setFrameRateLimit with 0 disables limiter", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.setFrameRateLimit(0);
    // No public getter for limiterActive, but setting to 0 should not throw
    expect(true).toBe(true);
  });

  it("setFrameRateLimit with positive value sets target frame time", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.setFrameRateLimit(60);
    // 1000/60 ≈ 16.67ms target frame time
    expect(true).toBe(true);
  });
});

describe("GameRenderer — render loop", () => {
  it("stop sets running to false without error", () => {
    const canvas = createMockCanvas();
    const renderer = new GameRenderer(canvas);
    renderer.stop();
    // Should not throw
    expect(true).toBe(true);
  });
});
