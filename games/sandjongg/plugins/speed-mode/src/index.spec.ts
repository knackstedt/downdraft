import { createQuickjsBridge, getQuickJS } from "@downdraft/core";
import { readFileSync } from "fs";
import { join } from "path";

const PLUGIN_SOURCE = readFileSync(
  join(import.meta.dir, "..", "src", "index.js"),
  "utf-8",
);

describe("sandjongg-speed-mode plugin", () => {
  let module: Awaited<ReturnType<typeof getQuickJS>>;
  beforeAll(async () => {
    try { module = await getQuickJS(); } catch (e) { console.warn("QuickJS unavailable:", (e as Error).message); }
  });

  function makeHostApi() {
    const state = new Map<string, unknown>();
    const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
    const tickCbs: Array<(dt: number, t: number) => void> = [];
    const logs: string[] = [];
    const published: Array<{ event: string; data: unknown }> = [];
    return {
      api: {
        id: "sandjongg-speed-mode",
        events: {
          subscribe(event: string, handler: (data: unknown) => void) {
            let set = eventHandlers.get(event);
            if (!set) { set = new Set(); eventHandlers.set(event, set); }
            set.add(handler);
            return () => set!.delete(handler);
          },
          publish(event: string, data: unknown) { published.push({ event, data }); },
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
        onDispose: () => {},
      },
      tickCbs,
      state,
      logs,
      published,
      eventHandlers,
      // Helper to publish an event into the plugin.
      publish(event: string, data: unknown) {
        const set = eventHandlers.get(event);
        if (set) for (const h of set) h(data);
      },
      // Helper to tick the plugin.
      tick(dt: number, t: number) {
        for (const cb of tickCbs) cb(dt, t);
      },
    };
  }

  it("registers + activates speed mode on event", async () => {
    if (!module) return;
    const h = makeHostApi();
    const bridge = createQuickjsBridge(module, h.api, { pluginId: "sandjongg-speed-mode" });
    bridge.eval(PLUGIN_SOURCE, "index.js");
    bridge.eval("register(ddPlugin);", "index.js#register");
    bridge.drainJobs();

    // Plugin should have logged registration.
    expect(h.logs.some((l) => l.includes("Speed mode plugin registered"))).toBe(true);

    // Activate speed mode.
    h.publish("sandjongg:activate_speed_mode", {});
    bridge.drainJobs();

    // Should have published speed_mode_activated.
    expect(h.published.some((p) => p.event === "sandjongg:speed_mode_activated")).toBe(true);
    expect(h.state.get("speedModeActive")).toBe(true);
    expect(h.state.get("speedModeRemaining")).toBe(30);

    // Match a tile → should boost the score.
    h.publish("sandjongg:tile_matched", { score: 100 });
    bridge.drainJobs();
    const boosted = h.published.find((p) => p.event === "sandjongg:score_boosted");
    expect(boosted).toBeDefined();
    expect((boosted!.data as any).boostedScore).toBe(200);
    expect((boosted!.data as any).multiplier).toBe(2);

    bridge.dispose();
  });

  it("expires speed mode after the duration", async () => {
    if (!module) return;
    const h = makeHostApi();
    const bridge = createQuickjsBridge(module, h.api, { pluginId: "sandjongg-speed-mode" });
    bridge.eval(PLUGIN_SOURCE, "index.js");
    bridge.eval("register(ddPlugin);", "index.js#register");
    bridge.drainJobs();

    // Activate.
    h.publish("sandjongg:activate_speed_mode", {});
    bridge.drainJobs();
    expect(h.state.get("speedModeActive")).toBe(true);

    // Tick 31 seconds (dt is in seconds).
    h.tick(31, 31);
    bridge.drainJobs();

    // Should have expired.
    expect(h.state.get("speedModeActive")).toBe(false);
    expect(h.published.some((p) => p.event === "sandjongg:speed_mode_expired")).toBe(true);

    // Tile match after expiry → no boost.
    h.published.length = 0;
    h.publish("sandjongg:tile_matched", { score: 100 });
    bridge.drainJobs();
    expect(h.published.find((p) => p.event === "sandjongg:score_boosted")).toBeUndefined();

    bridge.dispose();
  });
});
