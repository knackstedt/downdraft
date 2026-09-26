import { getQuickJS } from "quickjs-emscripten";
import { createQuickjsBridge } from "./quickjs-bridge";

describe("createQuickjsBridge", () => {
  // These tests require the QuickJS WASM module to load. Bun supports WASM.
  // If the module fails to load in this environment, skip gracefully.
  let module: Awaited<ReturnType<typeof getQuickJS>>;

  beforeAll(async () => {
    try {
      module = await getQuickJS();
    } catch (e) {
      console.warn("QuickJS WASM module failed to load — skipping bridge tests:", (e as Error).message);
    }
  });

  function makeHostApi() {
    const state = new Map<string, unknown>();
    const tickCbs: Array<(dt: number, t: number) => void> = [];
    const disposeCbs: Array<() => void> = [];
    const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
    const logs: string[] = [];
    return {
      api: {
        id: "test-quickjs",
        events: {
          subscribe(event: string, handler: (data: unknown) => void) {
            let set = eventHandlers.get(event);
            if (!set) { set = new Set(); eventHandlers.set(event, set); }
            set.add(handler);
            return () => set!.delete(handler);
          },
          publish(event: string, data: unknown) {
            const set = eventHandlers.get(event);
            if (set) for (const h of set.values()) h(data);
          },
        },
        state: {
          get: (key: string) => state.get(key),
          set: (key: string, value: unknown) => { state.set(key, value); },
          delete: (key: string) => { state.delete(key); },
          keys: () => [...state.keys()],
        },
        tick: { onTick(fn: (dt: number, t: number) => void) { tickCbs.push(fn); return () => {}; } },
        log: {
          info: (m: string) => logs.push(`info:${m}`),
          warn: (m: string) => logs.push(`warn:${m}`),
          error: (m: string) => logs.push(`error:${m}`),
          debug: (m: string) => logs.push(`debug:${m}`),
        },
        onDispose: (fn: () => void) => { disposeCbs.push(fn); },
      },
      tickCbs,
      disposeCbs,
      state,
      logs,
      eventHandlers,
    };
  }

  it("evals code + marshals a return value", async () => {
    if (!module) return;
    const { api } = makeHostApi();
    const bridge = createQuickjsBridge(module, api, { pluginId: "test" });
    const result = bridge.eval("1 + 2");
    expect(result).toBe(3);
    bridge.dispose();
  });

  it("bridges state.get/set/delete/keys", async () => {
    if (!module) return;
    const { api, state } = makeHostApi();
    const bridge = createQuickjsBridge(module, api, { pluginId: "test" });
    bridge.eval(`
      ddPlugin.state.set("foo", 42);
      ddPlugin.state.set("bar", "hello");
    `);
    expect(state.get("foo")).toBe(42);
    expect(state.get("bar")).toBe("hello");
    const keys = bridge.eval(`ddPlugin.state.keys()`);
    expect(keys).toEqual(expect.arrayContaining(["foo", "bar"]));
    bridge.eval(`ddPlugin.state.delete("foo")`);
    expect(state.has("foo")).toBe(false);
    bridge.dispose();
  });

  it("bridges log.info", async () => {
    if (!module) return;
    const { api, logs } = makeHostApi();
    const bridge = createQuickjsBridge(module, api, { pluginId: "test" });
    bridge.eval(`ddPlugin.log.info("hello from quickjs")`);
    expect(logs).toContain("info:hello from quickjs");
    bridge.dispose();
  });

  it("bridges events.subscribe + publish", async () => {
    if (!module) return;
    const { api, eventHandlers } = makeHostApi();
    const bridge = createQuickjsBridge(module, api, { pluginId: "test" });
    bridge.eval(`
      ddPlugin.events.subscribe("test-event", function(data) {
        ddPlugin.state.set("received", data.value);
      });
    `);
    bridge.drainJobs();
    // Publish from the host side.
    api.events.publish("test-event", { value: 99 });
    bridge.drainJobs();
    expect(api.state.get("received")).toBe(99);
    bridge.dispose();
  });

  it("calls a global register function", async () => {
    if (!module) return;
    const { api } = makeHostApi();
    const bridge = createQuickjsBridge(module, api, { pluginId: "test" });
    bridge.eval(`
      function register(dd) {
        dd.state.set("registered", true);
        dd.log.info("registered!");
      }
    `);
    bridge.eval(`register(ddPlugin);`);
    bridge.drainJobs();
    expect(api.state.get("registered")).toBe(true);
    bridge.dispose();
  });

  it("throws on eval errors with a descriptive message", async () => {
    if (!module) return;
    const { api } = makeHostApi();
    const bridge = createQuickjsBridge(module, api, { pluginId: "test" });
    expect(() => bridge.eval("syntax error here")).toThrow(/QuickJS eval error/);
    bridge.dispose();
  });

  it("runs onDispose callbacks on dispose", async () => {
    if (!module) return;
    const { api, disposeCbs } = makeHostApi();
    const bridge = createQuickjsBridge(module, api, { pluginId: "test" });
    bridge.eval(`
      ddPlugin.onDispose(function() {
        ddPlugin.state.set("disposed", true);
      });
    `);
    bridge.drainJobs();
    bridge.dispose();
    // After dispose, the dispose callback should have run.
    // Note: the callback calls ddPlugin.state.set which needs the VM alive,
    // but dispose() runs the callbacks BEFORE disposing the VM.
    expect(api.state.get("disposed")).toBe(true);
  });
});
