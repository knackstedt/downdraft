// ============================================================================
// Unit tests for PixiUiHost — SAB layout, bridge-protocol guards, and
// pointer-events toggle logic. These don't spawn a real worker or GPU
// (PixiJS rendering is exercised by the e2e smoke test).
// ============================================================================

import { describe, expect, it } from "bun:test";
import type { UiStatsLayout } from "./bridge-protocol";
import { DEFAULT_STATS_LAYOUT, isInitMessage } from "./bridge-protocol";
import {
    allocateUiStatsSab,
    buildSlotMap,
    MAGIC,
    readFrameCounter,
    readUiStat,
    readUiStats,
    validateUiStatsSab,
    VERSION,
    writeUiStats,
} from "./ui-stats-sab";

describe("UiStatsSAB", () => {
  it("allocates a SAB with the correct header + slot space", () => {
    const layout: UiStatsLayout = { slots: ["fps", "health"] };
    const sab = allocateUiStatsSab(layout);
    expect(sab).toBeInstanceOf(SharedArrayBuffer);
    // 16-byte header + 2 float32 slots = 24 bytes
    expect(sab.byteLength).toBe(16 + 8);
    const u32 = new Uint32Array(sab);
    expect(u32[0]).toBe(MAGIC);
    expect(u32[1]).toBe(VERSION);
    expect(u32[3]).toBe(2); // slot count
  });

  it("writeUiStats + readUiStats round-trip", () => {
    const layout = DEFAULT_STATS_LAYOUT;
    const sab = allocateUiStatsSab(layout);
    writeUiStats(sab, layout, { fps: 60, health: 75.5, tick: 42 });
    const values = readUiStats(sab, layout);
    expect(values.fps).toBe(60);
    expect(values.health).toBe(75.5);
    expect(values.tick).toBe(42);
    // Slots not written default to 0
    expect(values.hunger).toBe(0);
  });

  it("readUiStat reads a single named slot", () => {
    const layout: UiStatsLayout = { slots: ["a", "b", "c"] };
    const sab = allocateUiStatsSab(layout);
    writeUiStats(sab, layout, { b: 99 });
    expect(readUiStat(sab, layout, "b")).toBe(99);
    expect(readUiStat(sab, layout, "a")).toBe(0);
    expect(readUiStat(sab, layout, "unknown")).toBeUndefined();
  });

  it("increments the frame counter on each write", () => {
    const layout: UiStatsLayout = { slots: ["x"] };
    const sab = allocateUiStatsSab(layout);
    expect(readFrameCounter(sab)).toBe(0);
    writeUiStats(sab, layout, { x: 1 });
    expect(readFrameCounter(sab)).toBe(1);
    writeUiStats(sab, layout, { x: 2 });
    expect(readFrameCounter(sab)).toBe(2);
  });

  it("ignores unknown keys in values", () => {
    const layout: UiStatsLayout = { slots: ["a"] };
    const sab = allocateUiStatsSab(layout);
    writeUiStats(sab, layout, { a: 1, unknown: 99 } as any);
    expect(readUiStat(sab, layout, "a")).toBe(1);
  });

  it("validateUiStatsSab passes for a matching layout", () => {
    const layout = DEFAULT_STATS_LAYOUT;
    const sab = allocateUiStatsSab(layout);
    expect(() => validateUiStatsSab(sab, layout)).not.toThrow();
  });

  it("validateUiStatsSab throws on slot count mismatch", () => {
    const layout: UiStatsLayout = { slots: ["a", "b"] };
    const sab = allocateUiStatsSab(layout);
    const wrongLayout: UiStatsLayout = { slots: ["a"] };
    expect(() => validateUiStatsSab(sab, wrongLayout)).toThrow(/slot count/i);
  });

  it("buildSlotMap maps names to indices", () => {
    const layout: UiStatsLayout = { slots: ["x", "y", "z"] };
    const map = buildSlotMap(layout);
    expect(map.get("x")).toBe(0);
    expect(map.get("y")).toBe(1);
    expect(map.get("z")).toBe(2);
    expect(map.get("w")).toBeUndefined();
  });
});

describe("bridge-protocol", () => {
  it("isInitMessage identifies init messages", () => {
    expect(isInitMessage({ kind: "init" })).toBe(true);
    expect(isInitMessage({ kind: "event" })).toBe(false);
    expect(isInitMessage(null)).toBe(false);
    expect(isInitMessage("init")).toBe(false);
  });

  it("DEFAULT_STATS_LAYOUT has the expected slots", () => {
    expect(DEFAULT_STATS_LAYOUT.slots).toContain("fps");
    expect(DEFAULT_STATS_LAYOUT.slots).toContain("health");
    expect(DEFAULT_STATS_LAYOUT.slots.length).toBeGreaterThan(10);
  });

  it("serializeConfig includes extraSharedBufferKeys when extraSharedBuffers is set", () => {
    const { serializeConfig } = require("./bridge-protocol");
    const config = {
      backend: "webgl2" as const,
      statsLayout: DEFAULT_STATS_LAYOUT,
      extraSharedBuffers: {
        profiling: new SharedArrayBuffer(64),
        devtools: new SharedArrayBuffer(128),
      },
    };
    const serialized = serializeConfig(config);
    expect(serialized.extraSharedBufferKeys).toBeDefined();
    expect(serialized.extraSharedBufferKeys).toContain("profiling");
    expect(serialized.extraSharedBufferKeys).toContain("devtools");
  });

  it("serializeConfig omits extraSharedBufferKeys when no extraSharedBuffers", () => {
    const { serializeConfig } = require("./bridge-protocol");
    const serialized = serializeConfig({ backend: "webgl2", statsLayout: DEFAULT_STATS_LAYOUT });
    expect(serialized.extraSharedBufferKeys).toBeUndefined();
  });
});

describe("PixiUiHost (logic, no worker spawn)", () => {
  // We test the host's non-worker logic by constructing it without calling
  // start(). The pointer-events toggle + config defaults are testable
  // without a real worker or GPU.

  it("constructs with default config", async () => {
    const { PixiUiHost } = await import("./host");
    const host = new PixiUiHost({
      backend: "webgl2",
      statsLayout: DEFAULT_STATS_LAYOUT,
    });
    expect(host.isReady).toBe(false);
    expect(host.isInteractive).toBe(false);
    expect(host.overlayCanvas).toBeNull(); // not started
    expect(host.statsBuffer).toBeNull(); // not started
    host.dispose();
  });

  it("setInteractive toggles isInteractive (no canvas until started)", async () => {
    const { PixiUiHost } = await import("./host");
    const host = new PixiUiHost({
      backend: "webgl2",
      statsLayout: DEFAULT_STATS_LAYOUT,
    });
    let changed = false;
    host.onInteractiveChange = (v) => { changed = v; };
    host.setInteractive(true);
    expect(host.isInteractive).toBe(true);
    expect(changed).toBe(true);
    host.setInteractive(false);
    expect(host.isInteractive).toBe(false);
    host.dispose();
  });

  it("writeStats is a no-op before start (no SAB)", async () => {
    const { PixiUiHost } = await import("./host");
    const host = new PixiUiHost({
      backend: "webgl2",
      statsLayout: DEFAULT_STATS_LAYOUT,
    });
    // Should not throw — just no-ops.
    expect(() => host.writeStats({ fps: 60 })).not.toThrow();
    host.dispose();
  });

  it("queryScene rejects before start", async () => {
    const { PixiUiHost } = await import("./host");
    const host = new PixiUiHost({
      backend: "webgl2",
      statsLayout: DEFAULT_STATS_LAYOUT,
    });
    await expect(host.queryScene()).rejects.toThrow(/not started/);
    host.dispose();
  });
});
