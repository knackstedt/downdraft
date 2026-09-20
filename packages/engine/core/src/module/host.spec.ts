import { component } from "../ecs/component";
import { resourceToken } from "../ecs/resource";
import { World } from "../ecs/world";
import { setStrict } from "./diagnostics";
import { ModuleHost } from "./host";
import type { Module, ModuleContext } from "./module";
import { ModuleRegistry } from "./registry";

// Minimal plugins for testing activation order.
// Each records its name into an array when register() is called.
function makeModule(name: string, dependencies?: string[]): { plugin: Module; register: () => void } {
  let called = false;
  const plugin: Module = {
    name,
    version: "1.0.0",
    dependencies,
    register(ctx: ModuleContext) {
      called = true;
      // Touch the context to ensure it doesn't throw
      ctx.onDispose(() => {});
    },
  };
  return { plugin, register: () => { if (!called) throw new Error(`${name} was not activated`); } };
}

describe("ModuleRegistry", () => {
  it("resolves dependency order via topological sort", () => {
    const reg = new ModuleRegistry();
    // Register in dependency-first order (required by register())
    const a = makeModule("a");
    const b = makeModule("b", ["a"]);
    const c = makeModule("c", ["a", "b"]);
    reg.register(a.plugin);
    reg.register(b.plugin);
    reg.register(c.plugin);

    const order = reg.resolveOrder();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("resolves diamond dependencies", () => {
    const reg = new ModuleRegistry();
    const a = makeModule("a");
    const b = makeModule("b", ["a"]);
    const c = makeModule("c", ["a"]);
    const d = makeModule("d", ["b", "c"]);
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
    const reg = new ModuleRegistry();
    const b = makeModule("b", ["a"]);
    expect(() => reg.register(b.plugin)).toThrow("requires \"a\"");
  });

  it("unregister removes from load order", () => {
    const reg = new ModuleRegistry();
    const a = makeModule("a");
    reg.register(a.plugin);
    expect(reg.has("a")).toBe(true);
    reg.unregister("a");
    expect(reg.has("a")).toBe(false);
    expect(reg.resolveOrder()).toEqual([]);
  });

  it("throws on duplicate registration", () => {
    const reg = new ModuleRegistry();
    const a = makeModule("a");
    reg.register(a.plugin);
    expect(() => reg.register(makeModule("a").plugin)).toThrow("already registered");
    // The original module is intact — a single entry, still resolvable.
    expect(reg.resolveOrder()).toEqual(["a"]);
  });

  it("orders a module after the provider of a token it requires", () => {
    const reg = new ModuleRegistry();
    const Tok = resourceToken<number>("shared-num");
    // "consumer" registers FIRST — it requires Tok but has no name-level
    // dependency on "provider", so registration order is arbitrary.
    const consumer: Module = {
      name: "consumer", version: "1.0.0",
      requires: [Tok],
      register() {},
    };
    const provider: Module = {
      name: "provider", version: "1.0.0",
      provides: [Tok],
      register() {},
    };
    reg.register(consumer);
    reg.register(provider);

    const order = reg.resolveOrder();
    expect(order.indexOf("provider")).toBeLessThan(order.indexOf("consumer"));
  });

  it("detects requires-token dependency cycles", () => {
    const reg = new ModuleRegistry();
    const TokA = resourceToken<number>("tok-a");
    const TokB = resourceToken<number>("tok-b");
    // a provides TokA but requires TokB; b provides TokB but requires TokA —
    // neither can satisfy the other's inject() first.
    reg.register({
      name: "a", version: "1.0.0",
      provides: [TokA], requires: [TokB],
      register() {},
    });
    reg.register({
      name: "b", version: "1.0.0",
      provides: [TokB], requires: [TokA],
      register() {},
    });
    expect(() => reg.resolveOrder()).toThrow("cycle");
  });
});

describe("ModuleHost activation", () => {
  function makeWorld(): World {
    const world = new World();
    // Register a dummy component so the world is usable
    component("Dummy", { x: 0 });
    return world;
  }

  it("registerModule activates immediately", () => {
    const host = new ModuleHost(makeWorld());
    let activated = false;
    const plugin: Module = {
      name: "test-immediate",
      version: "1.0.0",
      register() { activated = true; },
    };
    host.registerModule(plugin);
    expect(activated).toBe(true);
    expect(host.listModules()).toContain("test-immediate");
  });

  it("registerModuleDeferred + activateAll activates in dependency order", () => {
    const host = new ModuleHost(makeWorld());
    const activationOrder: string[] = [];

    const a: Module = {
      name: "a",
      version: "1.0.0",
      register() { activationOrder.push("a"); },
    };
    const b: Module = {
      name: "b",
      version: "1.0.0",
      dependencies: ["a"],
      register() { activationOrder.push("b"); },
    };
    const c: Module = {
      name: "c",
      version: "1.0.0",
      dependencies: ["a", "b"],
      register() { activationOrder.push("c"); },
    };

    // Register in dependency order (required by registry)
    host.registerModuleDeferred(a);
    host.registerModuleDeferred(b);
    host.registerModuleDeferred(c);

    // None should be activated yet
    expect(activationOrder).toEqual([]);

    host.activateAll();
    expect(activationOrder).toEqual(["a", "b", "c"]);
  });

  it("activateAll is idempotent — calling twice does not re-activate", () => {
    const host = new ModuleHost(makeWorld());
    const activationOrder: string[] = [];

    const a: Module = {
      name: "a",
      version: "1.0.0",
      register() { activationOrder.push("a"); },
    };
    host.registerModuleDeferred(a);
    host.activateAll();
    expect(activationOrder).toEqual(["a"]);

    // Second call should not re-activate
    host.activateAll();
    expect(activationOrder).toEqual(["a"]);
  });

  it("disposeAll disposes in reverse dependency order", () => {
    const host = new ModuleHost(makeWorld());
    const disposeOrder: string[] = [];

    const a: Module = {
      name: "a",
      version: "1.0.0",
      register(ctx) { ctx.onDispose(() => disposeOrder.push("a")); },
    };
    const b: Module = {
      name: "b",
      version: "1.0.0",
      dependencies: ["a"],
      register(ctx) { ctx.onDispose(() => disposeOrder.push("b")); },
    };
    const c: Module = {
      name: "c",
      version: "1.0.0",
      dependencies: ["a", "b"],
      register(ctx) { ctx.onDispose(() => disposeOrder.push("c")); },
    };

    host.registerModuleDeferred(a);
    host.registerModuleDeferred(b);
    host.registerModuleDeferred(c);
    host.activateAll();

    host.disposeAll();
    // Reverse order: c, b, a
    expect(disposeOrder).toEqual(["c", "b", "a"]);
  });

  it("unloadModule removes plugin and runs disposers", () => {
    const host = new ModuleHost(makeWorld());
    let disposed = false;
    const plugin: Module = {
      name: "test-unload",
      version: "1.0.0",
      register(ctx) { ctx.onDispose(() => { disposed = true; }); },
    };
    host.registerModule(plugin);
    expect(host.getModule("test-unload")).toBeDefined();

    host.unloadModule("test-unload");
    expect(disposed).toBe(true);
    expect(host.getModule("test-unload")).toBeUndefined();
  });

  it("onDispose callbacks are called in reverse registration order", () => {
    const host = new ModuleHost(makeWorld());
    const calls: number[] = [];
    const plugin: Module = {
      name: "test-dispose-order",
      version: "1.0.0",
      register(ctx) {
        ctx.onDispose(() => calls.push(1));
        ctx.onDispose(() => calls.push(2));
        ctx.onDispose(() => calls.push(3));
      },
    };
    host.registerModule(plugin);
    host.unloadModule("test-dispose-order");
    // Disposers run in reverse: 3, 2, 1
    expect(calls).toEqual([3, 2, 1]);
  });

  it("registerSystemObject adds to world schedule", () => {
    const world = makeWorld();
    const host = new ModuleHost(world);
    let systemAdded = false;
    const plugin: Module = {
      name: "test-system",
      version: "1.0.0",
      register(ctx) {
        const originalAdd = world.schedule.add.bind(world.schedule);
        world.schedule.add = (sys) => {
          systemAdded = true;
          return originalAdd(sys);
        };
        ctx.registerSystemObject({
          name: "test-sys",
          stage: "update" as never,
          fn: () => {},
          queries: [],
        });
      },
    };
    host.registerModule(plugin);
    expect(systemAdded).toBe(true);
  });

  it("unloadModule removes the module's systems from the schedule", () => {
    const world = makeWorld();
    const host = new ModuleHost(world);
    let ticked = false;
    const plugin: Module = {
      name: "test-unload-sys",
      version: "1.0.0",
      register(ctx) {
        ctx.registerSystem("update" as never, () => { ticked = true; });
        ctx.registerSystemObject({
          name: "test-unload-sys-obj",
          stage: "update" as never,
          fn: () => { ticked = true; },
          queries: [],
        });
      },
    };
    host.registerModule(plugin);
    host.unloadModule("test-unload-sys");
    // Neither system should remain scheduled.
    const names = world.schedule.getAllSystems().map((s) => s.name);
    expect(names).not.toContain("test-unload-sys-obj");
    expect(names.filter((n) => n.startsWith("module:test-unload-sys:")).length).toBe(0);
    // Sanity: running the schedule must not invoke the removed systems.
    ticked = false;
    world.schedule.run(world, 0.016, 1);
    expect(ticked).toBe(false);
  });

  it("provide/inject stores and retrieves typed values", () => {
    const world = makeWorld();
    const host = new ModuleHost(world);
    const TestResource = resourceToken<{ count: number }>("test:resource");
    const testValue = { count: 42 };
    const plugin: Module = {
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
    host.registerModule(plugin);
  });

  it("inject throws on missing provider", () => {
    const world = makeWorld();
    const host = new ModuleHost(world);
    const MissingResource = resourceToken<unknown>("missing:resource");
    const plugin: Module = {
      name: "test-inject-missing",
      version: "1.0.0",
      register(ctx) {
        expect(() => ctx.inject(MissingResource)).toThrow();
      },
    };
    host.registerModule(plugin);
  });

  it("injectOptional returns undefined on missing provider", () => {
    const world = makeWorld();
    const host = new ModuleHost(world);
    const MissingResource = resourceToken<unknown>("missing:resource");
    const plugin: Module = {
      name: "test-inject-optional",
      version: "1.0.0",
      register(ctx) {
        expect(ctx.injectOptional(MissingResource)).toBeUndefined();
      },
    };
    host.registerModule(plugin);
  });

  it("STRICT: duplicate provide throws DiagnosticError", () => {
    setStrict(true);
    try {
      const world = makeWorld();
      const host = new ModuleHost(world);
      const DupResource = resourceToken<unknown>("dup:resource");
      const pluginA: Module = {
        name: "a",
        version: "1.0.0",
        provides: [DupResource],
        register(ctx) { ctx.provide(DupResource, "from-a"); },
      };
      const pluginB: Module = {
        name: "b",
        version: "1.0.0",
        provides: [DupResource],
        register(ctx) { ctx.provide(DupResource, "from-b"); },
      };
      host.registerModuleDeferred(pluginA);
      host.registerModuleDeferred(pluginB);
      expect(() => host.activateAll()).toThrow(/already provided/);
    } finally {
      setStrict(false);
    }
  });

  it("STRICT: missing requires throws with both plugin names", () => {
    setStrict(true);
    try {
      const world = makeWorld();
      const host = new ModuleHost(world);
      const NeededResource = resourceToken<unknown>("needed:resource");
      const consumer: Module = {
        name: "consumer",
        version: "1.0.0",
        requires: [NeededResource],
        register() {},
      };
      host.registerModuleDeferred(consumer);
      expect(() => host.activateAll()).toThrow(/consumer.*needed:resource/);
    } finally {
      setStrict(false);
    }
  });

  it("rolls back partial activation when register() throws", () => {
    const world = makeWorld();
    const host = new ModuleHost(world);
    const Res = resourceToken<string>("rollback:res");
    let disposed = false;
    const bad: Module = {
      name: "bad",
      version: "1.0.0",
      provides: [Res],
      register(ctx) {
        ctx.provide(Res, "leak-me");
        ctx.onDispose(() => { disposed = true; });
        throw new Error("register blew up");
      },
    };
    expect(() => host.registerModule(bad)).toThrow("register blew up");
    // The provided resource was rolled back and its disposers ran.
    expect(host.injectOptional(Res)).toBeUndefined();
    expect(disposed).toBe(true);
    // A second module registered later must still work and can provide the
    // same token (no phantom provider left behind).
    const good: Module = {
      name: "good",
      version: "1.0.0",
      provides: [Res],
      register(ctx) { ctx.provide(Res, "ok"); },
    };
    host.registerModule(good);
    expect(host.inject(Res)).toBe("ok");
  });

  it("does not attribute lifecycle calls made outside register()", () => {
    const world = makeWorld();
    const host = new ModuleHost(world);
    const Res = resourceToken<string>("late:res");
    let capturedCtx: ModuleContext | null = null;
    const mod: Module = {
      name: "mod",
      version: "1.0.0",
      register(ctx) { capturedCtx = ctx; },
    };
    host.registerModule(mod);
    // A late provide() (async callback, game code) must not be attributed to
    // "mod" — unloading "mod" must not remove a resource it never registered.
    capturedCtx!.provide(Res, "late");
    host.unloadModule("mod");
    expect(host.injectOptional(Res)).toBe("late");
  });
});
