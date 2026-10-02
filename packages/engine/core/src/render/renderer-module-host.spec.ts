import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resourceToken } from "../ecs/resource";
import { setStrict } from "../module/diagnostics";
import type { RendererModule } from "../module/renderer-module";
import { RendererModuleHost } from "./renderer-module-host";

// Reset strict mode after each test.
afterEach(() => setStrict(null));

// Mock `window` for RendererInputBusImpl which adds event listeners on construction.
// Install per-test and restore so the fake doesn't leak into later spec files.
const origWindow = (globalThis as any).window;
beforeEach(() => {
  if (origWindow === undefined) {
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
});
afterEach(() => {
  if (origWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = origWindow;
});

function createMockCanvas(): HTMLCanvasElement {
  return {
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
}

function createMockCallbacks() {
  return {
    getSurface: () => createMockCanvas() as unknown as import("../platform/render-surface").RenderSurface,
    getDevice: () => ({} as GPUDevice),
    getFormat: () => "bgra8unorm" as GPUTextureFormat,
    getGraph: () => ({} as any),
    getSlotRegistry: () => ({} as any),
    setOffscreenMode: vi.fn(),
    setRenderTargetProvider: vi.fn(),
    setRAFSource: vi.fn(),
    setViewportCount: vi.fn(),
    getUIInputRouter: () => null,
  };
}

function makeModule(
  name: string,
  opts: { dependencies?: string[]; provides?: any[]; requires?: any[] } = {},
): { plugin: RendererModule; activated: () => boolean } {
  let activated = false;
  const plugin: RendererModule = {
    name,
    version: "1.0.0",
    dependencies: opts.dependencies,
    provides: opts.provides,
    requires: opts.requires,
    register() {
      activated = true;
    },
  };
  return { plugin, activated: () => activated };
}

const TokenA = resourceToken("renderer:test:a");
const TokenB = resourceToken("renderer:test:b");

describe("RendererModuleHost — batch registration", () => {
  it("registerModuleDeferred + activateAll activates in dependency order", () => {
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    const a = makeModule("a");
    const b = makeModule("b", { dependencies: ["a"] });
    const c = makeModule("c", { dependencies: ["a", "b"] });

    host.registerModuleDeferred(a.plugin);
    host.registerModuleDeferred(b.plugin);
    host.registerModuleDeferred(c.plugin);

    expect(a.activated()).toBe(false);
    expect(b.activated()).toBe(false);
    expect(c.activated()).toBe(false);

    host.activateAll();

    expect(a.activated()).toBe(true);
    expect(b.activated()).toBe(true);
    expect(c.activated()).toBe(true);
  });

  it("useModules activates all in order", () => {
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    const a = makeModule("a");
    const b = makeModule("b", { dependencies: ["a"] });

    host.useModules([a.plugin, b.plugin]);

    expect(a.activated()).toBe(true);
    expect(b.activated()).toBe(true);
  });

  it("detects circular dependencies", () => {
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    const a = makeModule("a", { dependencies: ["b"] });
    const b = makeModule("b", { dependencies: ["a"] });

    host.registerModuleDeferred(a.plugin);
    host.registerModuleDeferred(b.plugin);

    expect(() => host.activateAll()).toThrow(/Circular/);
  });

  it("validateGraph throws on duplicate provides in strict mode", () => {
    setStrict(true);
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    const a = makeModule("a", { provides: [TokenA] });
    const b = makeModule("b", { provides: [TokenA] });

    host.registerModuleDeferred(a.plugin);
    host.registerModuleDeferred(b.plugin);

    expect(() => host.activateAll()).toThrow(/already provided/);
  });

  it("validateGraph throws on missing requires in strict mode", () => {
    setStrict(true);
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    const a = makeModule("a", { requires: [TokenB] });

    host.registerModuleDeferred(a.plugin);

    expect(() => host.activateAll()).toThrow(/not provided/);
  });

  it("does not validate when strict is off", () => {
    setStrict(false);
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    const a = makeModule("a", { provides: [TokenA] });
    const b = makeModule("b", { provides: [TokenA] });

    host.registerModuleDeferred(a.plugin);
    host.registerModuleDeferred(b.plugin);

    expect(() => host.activateAll()).not.toThrow();
  });

  it("provideExternal registers a resource without an active plugin", () => {
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    host.provideExternal("library", TokenA, { data: "test" });

    // A plugin should be able to inject it.
    let injected: unknown = null;
    const consumer = makeModule("consumer", {
      requires: [TokenA],
    });
    // Override register to inject.
    consumer.plugin.register = (ctx) => {
      injected = ctx.injectOptional(TokenA);
    };

    host.registerModule(consumer.plugin);
    expect(injected).toEqual({ data: "test" });
  });

  it("injectResource/injectResourceOptional work publicly", () => {
    const host = new RendererModuleHost(createMockCanvas(), createMockCallbacks());
    host.provideExternal("ext", TokenB, { value: 42 });

    expect(host.injectResource(TokenB)).toEqual({ value: 42 });
    expect(host.injectResourceOptional(TokenA)).toBeUndefined();
  });
});
