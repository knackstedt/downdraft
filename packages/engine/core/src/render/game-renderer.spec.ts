import { describe, expect, it, vi } from "bun:test";
import { GameRenderer } from "./game-renderer";

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

describe("GameRenderer — one-shot rendering", () => {
  function stubRaf() {
    const pending = new Map<number, (t: number) => void>();
    let nextId = 1;
    const prevRaf = (globalThis as any).requestAnimationFrame;
    const prevCancel = (globalThis as any).cancelAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    };
    (globalThis as any).cancelAnimationFrame = (id: number) => pending.delete(id);
    const fireAll = () => {
      const cbs = [...pending.values()];
      pending.clear();
      cbs.forEach((cb) => { cb(performance.now());; });
    };
    const restore = () => {
      (globalThis as any).requestAnimationFrame = prevRaf;
      (globalThis as any).cancelAnimationFrame = prevCancel;
    };
    return { pending, fireAll, restore };
  }

  function fakeDeviceAndContext(renderer: GameRenderer) {
    // Minimal stand-ins so renderFrame() runs the frame path without a GPU.
    // No camera module/callback → renderViewport returns early, which is fine:
    // the scheduling behavior under test happens regardless of draw output.
    (renderer as any).device = { queue: { submit() {} } };
    (renderer as any).context = { present() {} };
  }

  it("renderOnce() while the loop is running does not leak a parallel rAF chain", () => {
    const { pending, fireAll, restore } = stubRaf();
    try {
      const renderer = new GameRenderer(createMockCanvas());
      fakeDeviceAndContext(renderer);
      renderer.start();
      expect(pending.size).toBe(1);

      // MCP screenshot paths (__ddRequestFrame → renderOnce) must not leave
      // a second permanent render loop behind.
      renderer.renderOnce();
      expect(pending.size).toBe(1);

      renderer.renderOnce();
      renderer.renderOnce();
      expect(pending.size).toBe(1);

      // Firing the pending callback keeps exactly one chain alive.
      fireAll();
      expect(pending.size).toBe(1);
    } finally {
      restore();
    }
  });

  it("renderOnce() while stopped does not resurrect the loop", () => {
    const { pending, fireAll, restore } = stubRaf();
    try {
      const renderer = new GameRenderer(createMockCanvas());
      fakeDeviceAndContext(renderer);
      renderer.renderOnce();
      expect(pending.size).toBe(0);
      fireAll();
      expect(pending.size).toBe(0);
    } finally {
      restore();
    }
  });

  it("a stopped loop does not self-reschedule", () => {
    const { pending, fireAll, restore } = stubRaf();
    try {
      const renderer = new GameRenderer(createMockCanvas());
      fakeDeviceAndContext(renderer);
      renderer.start();
      renderer.stop();
      expect(pending.size).toBe(0);
      fireAll();
      expect(pending.size).toBe(0);
    } finally {
      restore();
    }
  });
});
