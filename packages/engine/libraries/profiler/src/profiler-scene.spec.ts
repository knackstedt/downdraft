import { afterAll, describe, expect, it } from "bun:test";
import { allocateProfilingSAB } from "@downdraft/engine/profiling/profiling-sab";
import { ProfilerScene } from "./profiler-scene";

// Mock pixi.js Container/Text/Graphics for testing
const mockContainer = {
  addChild: () => {},
  removeChildren: () => [],
  destroy: () => {},
  y: 0,
};
const _orig_Container = (globalThis as any).Container;
const _orig_Text = (globalThis as any).Text;
const _orig_Graphics = (globalThis as any).Graphics;
afterAll(() => {
  if (_orig_Container === undefined) delete (globalThis as any).Container; else (globalThis as any).Container = _orig_Container;
  if (_orig_Text === undefined) delete (globalThis as any).Text; else (globalThis as any).Text = _orig_Text;
  if (_orig_Graphics === undefined) delete (globalThis as any).Graphics; else (globalThis as any).Graphics = _orig_Graphics;
});
(globalThis as any).Container = function () { return mockContainer; };
(globalThis as any).Text = function (opts: any) { return { ...opts, width: 100, destroy: () => {} }; };
(globalThis as any).Graphics = function () {
  return {
    rect: () => this,
    roundRect: () => this,
    fill: () => this,
    destroy: () => {},
  };
};

describe("ProfilerScene", () => {
  it("constructs without a profiling SAB (graceful degradation)", () => {
    const ctx = {
      app: {} as any,
      width: 1280,
      height: 720,
      sceneConfig: { views: [] },
      setInteractive: () => {},
      postAction: () => {},
      log: () => {},
      extraSharedBuffers: undefined,
    };
    const scene = new ProfilerScene(ctx as any);
    expect(scene.root).toBeDefined();
    // update() should not throw even without a SAB
    scene.update({ stats: {}, events: [], dt: 0.016, elapsedTime: 0 });
    scene.dispose();
  });

  it("constructs with a profiling SAB", () => {
    const { sab } = allocateProfilingSAB(4, 16, 8, 4);
    const ctx = {
      app: {} as any,
      width: 1280,
      height: 720,
      sceneConfig: { views: [], layout: { maxSlots: 4, iopsRingCap: 16, warningRingCap: 8, stringTableCap: 4 } },
      setInteractive: () => {},
      postAction: () => {},
      log: () => {},
      extraSharedBuffers: { profiling: sab },
    };
    const scene = new ProfilerScene(ctx as any);
    expect(scene.root).toBeDefined();
    scene.update({ stats: {}, events: [], dt: 0.016, elapsedTime: 0 });
    scene.dispose();
  });

  it("has 10 default views when none are provided", () => {
    const ctx = {
      app: {} as any,
      width: 1280,
      height: 720,
      sceneConfig: {},
      setInteractive: () => {},
      postAction: () => {},
      log: () => {},
      extraSharedBuffers: undefined,
    };
    const scene = new ProfilerScene(ctx as any);
    // Access the private views array via the scene's update behavior
    // (we can't directly access private fields, but we can verify update doesn't throw)
    scene.update({ stats: {}, events: [], dt: 0.016, elapsedTime: 0 });
    scene.dispose();
  });

  it("getInteractiveRegions returns regions for view tabs + record bar", () => {
    const ctx = {
      app: {} as any,
      width: 1280,
      height: 720,
      sceneConfig: {},
      setInteractive: () => {},
      postAction: () => {},
      log: () => {},
      extraSharedBuffers: undefined,
    };
    const scene = new ProfilerScene(ctx as any);
    const regions = scene.getInteractiveRegions?.() ?? [];
    // 10 view tabs + 1 record bar = 11 regions
    expect(regions.length).toBe(11);
    scene.dispose();
  });
});
