import { component } from "../ecs/component";
import { resourceToken } from "../ecs/resource";
import { World } from "../ecs/world";
import { setStrict } from "./diagnostics";
import { PluginHost } from "./host";
import type { Plugin, PluginContext } from "./plugin";
import { PluginRegistry } from "./registry";

// Minimal plugins for testing activation order.
// Each records its name into an array when register() is called.
function makePlugin(name: string, dependencies?: string[]): { plugin: Plugin; register: () => void } {
  let called = false;
  const plugin: Plugin = {
    name,
    version: "1.0.0",
    dependencies,
    register(ctx: PluginContext) {
      called = true;
      // Touch the context to ensure it doesn't throw
      ctx.onDispose(() => {});
    },
  };
  return { plugin, register: () => { if (!called) throw new Error(`${name} was not activated`); } };
}

describe("PluginRegistry", () => {
  it("resolves dependency order via topological sort", () => {
    const reg = new PluginRegistry();
    // Register in dependency-first order (required by register())
    const a = makePlugin("a");
    const b = makePlugin("b", ["a"]);
    const c = makePlugin("c", ["a", "b"]);
    reg.register(a.plugin);
    reg.register(b.plugin);
    reg.register(c.plugin);

    const order = reg.resolveOrder();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("resolves diamond dependencies", () => {
    const reg = new PluginRegistry();
    const a = makePlugin("a");
    const b = makePlugin("b", ["a"]);
    const c = makePlugin("c", ["a"]);
    const d = makePlugin("d", ["b", "c"]);
    reg.register(a.plugin);
    reg.register(b.plugin);
    reg.register(c.plugin);
    reg.register(d.plugin);

    const order = reg.resolveOrder();
    // a must come first; d must come last; b and c can be in either order
    expect(order[0]).toBe("a");
    expect(order[order.length - 1]).toBe("d");
    expect(order.indexOf("b")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("d")).toBeGreaterThan(order.indexOf("b"));
    expect(order.indexOf("d")).toBeGreaterThan(order.indexOf("c"));
  });

  it("throws when registering a plugin with unregistered dependency", () => {
    const reg = new PluginRegistry();
    const b = makePlugin("b", ["a"]);
    expect(() => reg.register(b.plugin)).toThrow("requires \"a\"");
  });

  it("unregister removes from load order", () => {
    const reg = new PluginRegistry();
    const a = makePlugin("a");
    reg.register(a.plugin);
    expect(reg.has("a")).toBe(true);
    reg.unregister("a");
    expect(reg.has("a")).toBe(false);
    expect(reg.resolveOrder()).toEqual([]);
  });
});

describe("PluginHost activation", () => {
  function makeWorld(): World {
    const world = new World();
    // Register a dummy component so the world is usable
    component("Dummy", { x: 0 });
    return world;
  }

  it("registerPlugin activates immediately", () => {
    const host = new PluginHost(makeWorld());
    let activated = false;
    const plugin: Plugin = {
      name: "test-immediate",
      version: "1.0.0",
      register() { activated = true; },
    };
    host.registerPlugin(plugin);
    expect(activated).toBe(true);
    expect(host.listPlugins()).toContain("test-immediate");
  });

  it("registerPluginDeferred + activateAll activates in dependency order", () => {
    const host = new PluginHost(makeWorld());
    const activationOrder: string[] = [];

    const a: Plugin = {
      name: "a",
      version: "1.0.0",
      register() { activationOrder.push("a"); },
    };
    const b: Plugin = {
      name: "b",
      version: "1.0.0",
      dependencies: ["a"],
      register() { activationOrder.push("b"); },
    };
    const c: Plugin = {
      name: "c",
      version: "1.0.0",
      dependencies: ["a", "b"],
      register() { activationOrder.push("c"); },
    };

    // Register in dependency order (required by registry)
    host.registerPluginDeferred(a);
    host.registerPluginDeferred(b);
    host.registerPluginDeferred(c);

    // None should be activated yet
    expect(activationOrder).toEqual([]);

    host.activateAll();
    expect(activationOrder).toEqual(["a", "b", "c"]);
  });

  it("activateAll is idempotent — calling twice does not re-activate", () => {
    const host = new PluginHost(makeWorld());
    const activationOrder: string[] = [];

    const a: Plugin = {
      name: "a",
      version: "1.0.0",
      register() { activationOrder.push("a"); },
    };
    host.registerPluginDeferred(a);
    host.activateAll();
    expect(activationOrder).toEqual(["a"]);

    // Second call should not re-activate
    host.activateAll();
    expect(activationOrder).toEqual(["a"]);
  });

  it("disposeAll disposes in reverse dependency order", () => {
    const host = new PluginHost(makeWorld());
    const disposeOrder: string[] = [];

    const a: Plugin = {
      name: "a",
      version: "1.0.0",
      register(ctx) { ctx.onDispose(() => disposeOrder.push("a")); },
    };
    const b: Plugin = {
      name: "b",
      version: "1.0.0",
      dependencies: ["a"],
      register(ctx) { ctx.onDispose(() => disposeOrder.push("b")); },
    };
    const c: Plugin = {
      name: "c",
      version: "1.0.0",
      dependencies: ["a", "b"],
      register(ctx) { ctx.onDispose(() => disposeOrder.push("c")); },
    };

    host.registerPluginDeferred(a);
    host.registerPluginDeferred(b);
    host.registerPluginDeferred(c);
    host.activateAll();

    host.disposeAll();
    // Reverse order: c, b, a
    expect(disposeOrder).toEqual(["c", "b", "a"]);
  });

  it("unloadPlugin removes plugin and runs disposers", () => {
    const host = new PluginHost(makeWorld());
    let disposed = false;
    const plugin: Plugin = {
      name: "test-unload",
      version: "1.0.0",
      register(ctx) { ctx.onDispose(() => { disposed = true; }); },
    };
    host.registerPlugin(plugin);
    expect(host.getPlugin("test-unload")).toBeDefined();

    host.unloadPlugin("test-unload");
    expect(disposed).toBe(true);
    expect(host.getPlugin("test-unload")).toBeUndefined();
  });

  it("onDispose callbacks are called in reverse registration order", () => {
    const host = new PluginHost(makeWorld());
    const calls: number[] = [];
    const plugin: Plugin = {
      name: "test-dispose-order",
      version: "1.0.0",
      register(ctx) {
        ctx.onDispose(() => calls.push(1));
        ctx.onDispose(() => calls.push(2));
        ctx.onDispose(() => calls.push(3));
      },
    };
    host.registerPlugin(plugin);
    host.unloadPlugin("test-dispose-order");
    // Disposers run in reverse: 3, 2, 1
    expect(calls).toEqual([3, 2, 1]);
  });

  it("registerSystemObject adds to world schedule", () => {
    const world = makeWorld();
    const host = new PluginHost(world);
    let systemAdded = false;
    const plugin: Plugin = {
      name: "test-system",
      version: "1.0.0",
      register(ctx) {
        const originalAdd = world.schedule.add.bind(world.schedule);
        world.schedule.add = (sys) => {
          systemAdded = true;
          originalAdd(sys);
        };
        ctx.registerSystemObject({
          name: "test-sys",
          stage: "update" as never,
          fn: () => {},
          queries: [],
        });
      },
    };
    host.registerPlugin(plugin);
    expect(systemAdded).toBe(true);
  });

  it("provide/inject stores and retrieves typed values", () => {
    const world = makeWorld();
    const host = new PluginHost(world);
    const TestResource = resourceToken<{ count: number }>("test:resource");
    const testValue = { count: 42 };
    const plugin: Plugin = {
      name: "test-resource",
      version: "1.0.0",
      provides: [TestResource],
      register(ctx) {
        ctx.provide(TestResource, testValue);
        // Round-trip: inject what we just provided
        const got = ctx.inject(TestResource);
        expect(got).toBe(testValue);
      },
    };
    host.registerPlugin(plugin);
  });

  it("inject throws on missing provider", () => {
    const world = makeWorld();
    const host = new PluginHost(world);
    const MissingResource = resourceToken<unknown>("missing:resource");
    const plugin: Plugin = {
      name: "test-inject-missing",
      version: "1.0.0",
      register(ctx) {
        expect(() => ctx.inject(MissingResource)).toThrow();
      },
    };
    host.registerPlugin(plugin);
  });

  it("injectOptional returns undefined on missing provider", () => {
    const world = makeWorld();
    const host = new PluginHost(world);
    const MissingResource = resourceToken<unknown>("missing:resource");
    const plugin: Plugin = {
      name: "test-inject-optional",
      version: "1.0.0",
      register(ctx) {
        expect(ctx.injectOptional(MissingResource)).toBeUndefined();
      },
    };
    host.registerPlugin(plugin);
  });

  it("STRICT: duplicate provide throws DiagnosticError", () => {
    setStrict(true);
    try {
      const world = makeWorld();
      const host = new PluginHost(world);
      const DupResource = resourceToken<unknown>("dup:resource");
      const pluginA: Plugin = {
        name: "a",
        version: "1.0.0",
        provides: [DupResource],
        register(ctx) { ctx.provide(DupResource, "from-a"); },
      };
      const pluginB: Plugin = {
        name: "b",
        version: "1.0.0",
        provides: [DupResource],
        register(ctx) { ctx.provide(DupResource, "from-b"); },
      };
      host.registerPluginDeferred(pluginA);
      host.registerPluginDeferred(pluginB);
      expect(() => host.activateAll()).toThrow(/already provided/);
    } finally {
      setStrict(false);
    }
  });

  it("STRICT: missing requires throws with both plugin names", () => {
    setStrict(true);
    try {
      const world = makeWorld();
      const host = new PluginHost(world);
      const NeededResource = resourceToken<unknown>("needed:resource");
      const consumer: Plugin = {
        name: "consumer",
        version: "1.0.0",
        requires: [NeededResource],
        register() {},
      };
      host.registerPluginDeferred(consumer);
      expect(() => host.activateAll()).toThrow(/consumer.*needed:resource/);
    } finally {
      setStrict(false);
    }
  });
});
