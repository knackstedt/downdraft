import { afterEach, describe, expect, it, vi } from "bun:test";
import { resourceToken } from "../ecs/resource";
import { setStrict } from "../plugin/diagnostics";
import type { RendererPlugin } from "../plugin/renderer-plugin";
import { RendererPluginHost } from "./renderer-plugin-host";

// Reset strict mode after each test.
afterEach(() => setStrict(null));

// Mock `window` for RendererInputBusImpl which adds event listeners on construction.
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

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
    getCanvas: () => createMockCanvas(),
    getDevice: () => ({} as GPUDevice),
    getFormat: () => "bgra8unorm" as GPUTextureFormat,
    getGraph: () => ({} as any),
    getSlotRegistry: () => ({} as any),
    setOffscreenMode: vi.fn(),
    setRenderTargetProvider: vi.fn(),
    setRAFSource: vi.fn(),
    setViewportCount: vi.fn(),
  };
}

function makePlugin(
  name: string,
  opts: { dependencies?: string[]; provides?: any[]; requires?: any[] } = {},
): { plugin: RendererPlugin; activated: () => boolean } {
  let activated = false;
  const plugin: RendererPlugin = {
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

describe("RendererPluginHost — batch registration", () => {
  it("registerPluginDeferred + activateAll activates in dependency order", () => {
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    const a = makePlugin("a");
    const b = makePlugin("b", { dependencies: ["a"] });
    const c = makePlugin("c", { dependencies: ["a", "b"] });

    host.registerPluginDeferred(a.plugin);
    host.registerPluginDeferred(b.plugin);
    host.registerPluginDeferred(c.plugin);

    expect(a.activated()).toBe(false);
    expect(b.activated()).toBe(false);
    expect(c.activated()).toBe(false);

    host.activateAll();

    expect(a.activated()).toBe(true);
    expect(b.activated()).toBe(true);
    expect(c.activated()).toBe(true);
  });

  it("usePlugins activates all in order", () => {
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    const a = makePlugin("a");
    const b = makePlugin("b", { dependencies: ["a"] });

    host.usePlugins([a.plugin, b.plugin]);

    expect(a.activated()).toBe(true);
    expect(b.activated()).toBe(true);
  });

  it("detects circular dependencies", () => {
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    const a = makePlugin("a", { dependencies: ["b"] });
    const b = makePlugin("b", { dependencies: ["a"] });

    host.registerPluginDeferred(a.plugin);
    host.registerPluginDeferred(b.plugin);

    expect(() => host.activateAll()).toThrow(/Circular/);
  });

  it("validateGraph throws on duplicate provides in strict mode", () => {
    setStrict(true);
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    const a = makePlugin("a", { provides: [TokenA] });
    const b = makePlugin("b", { provides: [TokenA] });

    host.registerPluginDeferred(a.plugin);
    host.registerPluginDeferred(b.plugin);

    expect(() => host.activateAll()).toThrow(/already provided/);
  });

  it("validateGraph throws on missing requires in strict mode", () => {
    setStrict(true);
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    const a = makePlugin("a", { requires: [TokenB] });

    host.registerPluginDeferred(a.plugin);

    expect(() => host.activateAll()).toThrow(/not provided/);
  });

  it("does not validate when strict is off", () => {
    setStrict(false);
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    const a = makePlugin("a", { provides: [TokenA] });
    const b = makePlugin("b", { provides: [TokenA] });

    host.registerPluginDeferred(a.plugin);
    host.registerPluginDeferred(b.plugin);

    expect(() => host.activateAll()).not.toThrow();
  });

  it("provideExternal registers a resource without an active plugin", () => {
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    host.provideExternal("library", TokenA, { data: "test" });

    // A plugin should be able to inject it.
    let injected: unknown = null;
    const consumer = makePlugin("consumer", {
      requires: [TokenA],
    });
    // Override register to inject.
    consumer.plugin.register = (ctx) => {
      injected = ctx.injectOptional(TokenA);
    };

    host.registerPlugin(consumer.plugin);
    expect(injected).toEqual({ data: "test" });
  });

  it("injectResource/injectResourceOptional work publicly", () => {
    const host = new RendererPluginHost(createMockCanvas(), createMockCallbacks());
    host.provideExternal("ext", TokenB, { value: 42 });

    expect(host.injectResource(TokenB)).toEqual({ value: 42 });
    expect(host.injectResourceOptional(TokenA)).toBeUndefined();
  });
});
