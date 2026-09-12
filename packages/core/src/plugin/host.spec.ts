import { resourceToken } from "../ecs/resource";
import { World } from "../ecs/world";
import { setStrict } from "../module/diagnostics";
import { ModuleHost } from "../module/host";
import type { NativePluginContext, ScriptPluginContext } from "./context";
import { PluginHost, type PluginLoader } from "./host";
import type { PluginManifest } from "./manifest";

function nativeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-native",
    name: "Test Native",
    version: "1.0.0",
    engineVersion: "^0.1.0",
    game: "test-game",
    format: "worker-js",
    tier: "native",
    thread: "sim",
    entry: "./irrelevant",
    permissions: ["ecs", "events"],
    ...overrides,
  };
}

function scriptManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-script",
    name: "Test Script",
    version: "1.0.0",
    engineVersion: "^0.1.0",
    game: "test-game",
    format: "quickjs",
    tier: "script",
    thread: "renderer",
    entry: "./irrelevant",
    permissions: ["events", "state", "tick"],
    ...overrides,
  };
}

/** A fake loader that calls a provided register fn with the ctx. */
function fakeLoader(
  format: PluginManifest["format"],
  register: (ctx: ScriptPluginContext | NativePluginContext) => void | Promise<void>,
): PluginLoader {
  return {
    format,
    async load(_m, ctx) {
      await register(ctx);
      return () => {};
    },
  };
}

describe("PluginHost", () => {
  beforeAll(() => setStrict(false));
  afterAll(() => setStrict(null));

  it("discovers + loads a script-tier plugin via fake loader", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    let called = false;
    host.registerLoader(
      fakeLoader("quickjs", (ctx) => {
        called = true;
        ctx.log.info("hi");
      }),
    );
    const r = host.discover(scriptManifest(), "local");
    expect(r.ok).toBe(true);
    await host.loadAll();
    expect(called).toBe(true);
    const snap = host.snapshot();
    expect(snap.find((p) => p.id === "test-script")?.status).toBe("active");
  });

  it("rejects a manifest targeting the wrong game", () => {
    const host = new PluginHost({ gameId: "other-game", engineVersion: "0.1.0" });
    const r = host.discover(scriptManifest({ game: "test-game" }), "local");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("does not match host game");
  });

  it("rejects an unsatisfied engine version", () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    const r = host.discover(scriptManifest({ engineVersion: "^1.0.0" }), "local");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("engineVersion");
  });

  it("loads a native-tier plugin and bridges into ModuleHost DI", async () => {
    const world = new World();
    const mh = new ModuleHost(world);
    const host = new PluginHost({
      gameId: "test-game",
      engineVersion: "0.1.0",
      moduleHost: mh,
    });
    const FooTok = resourceToken<{ n: number }>("foo");
    let injected: { n: number } | undefined;
    host.registerLoader(
      fakeLoader("worker-js", (ctx) => {
        const nctx = ctx as NativePluginContext;
        nctx.provide(FooTok, { n: 42 });
        injected = nctx.inject(FooTok);
      }),
    );
    host.discover(nativeManifest(), "local");
    await host.loadAll();
    expect(injected).toEqual({ n: 42 });
    expect(mh.injectOptional(FooTok)).toEqual({ n: 42 });
  });

  it("marks a plugin errored when its loader throws", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    host.registerLoader({
      format: "quickjs",
      async load() {
        throw new Error("boom");
      },
    });
    host.discover(scriptManifest(), "local");
    await host.loadAll();
    const snap = host.snapshot();
    const p = snap.find((s) => s.id === "test-script");
    expect(p?.status).toBe("error");
    expect(p?.error).toBe("boom");
  });

  it("skips a plugin whose dependency errored", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    host.registerLoader({
      format: "quickjs",
      async load(m) {
        if (m.id === "dep") throw new Error("dep boom");
      },
    });
    host.discover(scriptManifest({ id: "dep" }), "local");
    host.discover(
      scriptManifest({ id: "child", dependencies: ["dep"] }),
      "local",
    );
    await host.loadAll();
    const snap = host.snapshot();
    expect(snap.find((s) => s.id === "dep")?.status).toBe("error");
    expect(snap.find((s) => s.id === "child")?.status).toBe("error");
    expect(snap.find((s) => s.id === "child")?.error).toContain("dependency failed");
  });

  it("respects dependency load order", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    const order: string[] = [];
    host.registerLoader(
      fakeLoader("quickjs", (ctx) => {
        order.push(ctx.id);
      }),
    );
    // Register child before dep to verify topo sort.
    host.discover(scriptManifest({ id: "child", dependencies: ["dep"] }), "local");
    host.discover(scriptManifest({ id: "dep" }), "local");
    await host.loadAll();
    expect(order).toEqual(["dep", "child"]);
  });

  it("unload disposes + removes from snapshot", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    let disposed = false;
    host.registerLoader(
      fakeLoader("quickjs", (ctx) => {
        ctx.onDispose(() => {
          disposed = true;
        });
      }),
    );
    host.discover(scriptManifest(), "local");
    await host.loadAll();
    host.unload("test-script");
    expect(disposed).toBe(true);
    expect(host.snapshot().find((s) => s.id === "test-script")).toBeUndefined();
  });

  it("game allowlist denies disallowed native perms", async () => {
    const host = new PluginHost({
      gameId: "test-game",
      engineVersion: "0.1.0",
      moduleHost: new ModuleHost(new World()),
      gameAllow: new Set(["ecs", "events"]), // no sab
    });
    host.registerLoader(fakeLoader("worker-js", () => {}));
    host.discover(nativeManifest({ permissions: ["ecs", "sab", "events"] }), "local");
    await host.loadAll();
    const snap = host.snapshot();
    const p = snap.find((s) => s.id === "test-native");
    expect(p?.deniedPermissions?.some((d) => d.permission === "sab")).toBe(true);
    expect(p?.permissions).toContain("ecs");
  });

  it("reload re-runs register", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    let count = 0;
    host.registerLoader(fakeLoader("quickjs", () => { count++; }));
    host.discover(scriptManifest(), "local");
    await host.loadAll();
    expect(count).toBe(1);
    await host.reload("test-script");
    expect(count).toBe(2);
  });

  it("errors if no loader registered for format", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    host.discover(scriptManifest({ format: "wasm", thread: "own-worker", entry: "./x.wasm" }), "local");
    await host.loadAll();
    const snap = host.snapshot();
    expect(snap.find((s) => s.id === "test-script")?.status).toBe("error");
    expect(snap.find((s) => s.id === "test-script")?.error).toContain("no loader");
  });

  it("native tier without moduleHost errors", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    host.registerLoader(fakeLoader("worker-js", () => {}));
    host.discover(nativeManifest(), "local");
    await host.loadAll();
    const snap = host.snapshot();
    expect(snap.find((s) => s.id === "test-native")?.status).toBe("error");
  });

  it("dispatches declarative extensions to ExtensionLoaders after logic loads", async () => {
    const host = new PluginHost({
      gameId: "test-game",
      engineVersion: "0.1.0",
      moduleHost: new ModuleHost(new World()),
    });
    const logicLoaded: string[] = [];
    const extLoaded: string[] = [];
    host.registerLoader(fakeLoader("worker-js", (ctx) => { logicLoaded.push(ctx.id); }));
    const assetLoader: ExtensionLoader = {
      bucket: "assets",
      async load(_m, ext) { extLoaded.push(`assets:${ext.id}`); return () => {}; },
    };
    const postfxLoader: ExtensionLoader = {
      bucket: "shader-postfx",
      async load(_m, ext) { extLoaded.push(`shader-postfx:${ext.id}`); return () => {}; },
    };
    host.registerExtensionLoader(assetLoader);
    host.registerExtensionLoader(postfxLoader);
    host.discover(
      nativeManifest({
        logic: {
          format: "worker-js", thread: "sim", entry: "./src/index.ts",
          permissions: ["ecs", "events"],
        },
        extensions: {
          assets: [
            { kind: "mesh", id: "mod:crate", path: "./crate.glb" },
            { kind: "texture", id: "mod:paint", path: "./paint.png" },
          ],
          shaders: {
            postfx: [{
              id: "mod:acid", name: "Acid", wgsl: "./acid.wgsl",
              layout: "cc", order: "stylized",
            }],
          },
        },
      }),
      "local",
    );
    await host.loadAll();
    expect(logicLoaded).toEqual(["test-native"]);
    expect(extLoaded).toEqual(["assets:mod:crate", "assets:mod:paint", "shader-postfx:mod:acid"]);
    expect(host.snapshot().find((s) => s.id === "test-native")?.status).toBe("active");
  });

  it("loads a pure-data mod (no logic) via extension loaders only", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    const extLoaded: string[] = [];
    const mapLoader: ExtensionLoader = {
      bucket: "maps",
      async load(_m, ext) { extLoaded.push(`maps:${ext.id}`); return () => {}; },
    };
    host.registerExtensionLoader(mapLoader);
    host.discover(
      nativeManifest({
        format: "asset",
        tier: "data",
        thread: "renderer",
        entry: undefined,
        permissions: [],
        logic: undefined,
        extensions: {
          maps: [{ id: "mod:arena", path: "./arena.json" } as any],
        },
      }),
      "local",
    );
    await host.loadAll();
    expect(extLoaded).toEqual(["maps:mod:arena"]);
    expect(host.snapshot().find((s) => s.id === "test-native")?.status).toBe("active");
  });
});
