// ============================================================================
// Specs for the unified DevTools API — realm detection, SAB data feeds,
// manifest, panel/command registration.
// ============================================================================

import { beforeEach, describe, expect, test } from "bun:test";
import {
    _devtoolsImpl,
    allocateDevToolsSAB,
    computeDevToolsSABLayout,
    devtools,
    DEVTOOLS_REALM,
    DEVTOOLS_SAB_MAX_FEEDS,
} from "./api";
import type { IDevToolsPanelExtension } from "./types";

describe("DevTools API", () => {
  beforeEach(() => {
    devtools.clear();
  });

  test("realm detection returns main or worker", () => {
    expect(DEVTOOLS_REALM === "main" || DEVTOOLS_REALM === "worker").toBe(true);
    // Under bun test (no window), it should detect as worker or main depending on env
    // Just verify it doesn't crash
  });

  test("registerPanel adds to manifest", () => {
    const panel: IDevToolsPanelExtension = {
      id: "test-panel",
      tabLabel: "Test",
      html: "<div>test</div>",
    };
    devtools.registerPanel(panel);
    const manifest = devtools.getManifest();
    expect(manifest.panels.length).toBe(1);
    expect(manifest.panels[0].id).toBe("test-panel");
  });

  test("registerPanel with same id replaces existing", () => {
    devtools.registerPanel({ id: "p1", tabLabel: "V1", html: "" });
    devtools.registerPanel({ id: "p1", tabLabel: "V2", html: "" });
    const manifest = devtools.getManifest();
    expect(manifest.panels.length).toBe(1);
    expect(manifest.panels[0].tabLabel).toBe("V2");
  });

  test("registerDataFeed assigns feedIndex sequentially", () => {
    devtools.registerDataFeed("feed1", () => ({ a: 1 }));
    devtools.registerDataFeed("feed2", () => ({ b: 2 }));
    const manifest = devtools.getManifest();
    expect(manifest.dataFeeds.length).toBe(2);
    expect(manifest.dataFeeds[0].name).toBe("feed1");
    expect(manifest.dataFeeds[0].feedIndex).toBe(0);
    expect(manifest.dataFeeds[1].name).toBe("feed2");
    expect(manifest.dataFeeds[1].feedIndex).toBe(1);
  });

  test("registerDataFeed with same name updates fn but keeps feedIndex", () => {
    devtools.registerDataFeed("feed1", () => ({ a: 1 }));
    devtools.registerDataFeed("feed1", () => ({ a: 2 }));
    const manifest = devtools.getManifest();
    expect(manifest.dataFeeds.length).toBe(1);
    expect(manifest.dataFeeds[0].feedIndex).toBe(0);
  });

  test("registerCommand adds to manifest", () => {
    devtools.registerCommand("doThing", (x: number) => x * 2);
    const manifest = devtools.getManifest();
    expect(manifest.commands).toContain("doThing");
  });

  test("callCommand invokes registered command", () => {
    devtools.registerCommand("double", (x: number) => x * 2);
    expect(_devtoolsImpl.callCommand("double", [5])).toBe(10);
  });

  test("callCommand throws for unknown command", () => {
    expect(() => _devtoolsImpl.callCommand("unknown", [])).toThrow();
  });

  test("registerSABStat adds to manifest", () => {
    devtools.registerSABStat("entityCount", 0, "u32");
    devtools.registerSABStat("avgSpeed", 4, "f32");
    const manifest = devtools.getManifest();
    expect(manifest.sabStats.length).toBe(2);
    expect(manifest.sabStats[0].name).toBe("entityCount");
    expect(manifest.sabStats[0].type).toBe("u32");
  });

  test("manifest version increments on registration", () => {
    const v0 = devtools.getManifest().manifestVersion;
    devtools.registerPanel({ id: "p", tabLabel: "P", html: "" });
    const v1 = devtools.getManifest().manifestVersion;
    expect(v1).toBeGreaterThan(v0);
  });

  test("clear resets all registrations", () => {
    devtools.registerPanel({ id: "p", tabLabel: "P", html: "" });
    devtools.registerDataFeed("f", () => 1);
    devtools.registerCommand("c", () => {});
    devtools.registerSABStat("s", 0, "u32");
    devtools.clear();
    const manifest = devtools.getManifest();
    expect(manifest.panels.length).toBe(0);
    expect(manifest.dataFeeds.length).toBe(0);
    expect(manifest.commands.length).toBe(0);
    expect(manifest.sabStats.length).toBe(0);
  });
});

describe("DevTools SAB layout", () => {
  test("computeDevToolsSABLayout produces valid offsets", () => {
    const layout = computeDevToolsSABLayout();
    expect(layout.totalBytes).toBeGreaterThan(0);
    expect(layout.feedOffset(0)).toBe(8); // after header
    expect(layout.feedOffset(1)).toBeGreaterThan(layout.feedOffset(0));
    expect(layout.feedBlobOffset(0)).toBe(layout.feedOffset(0) + 4);
    expect(layout.statsBaseOffset).toBeGreaterThan(layout.feedBlobOffset(DEVTOOLS_SAB_MAX_FEEDS - 1));
  });

  test("allocateDevToolsSAB creates a buffer of the right size", () => {
    const layout = computeDevToolsSABLayout();
    const sab = allocateDevToolsSAB();
    expect(sab.byteLength).toBe(layout.totalBytes);
  });

  test("attachSAB + flushDataFeeds writes JSON to SAB", () => {
    devtools.clear();
    const sab = allocateDevToolsSAB();
    devtools.attachSAB(sab);

    devtools.registerDataFeed("stats", () => ({ fps: 60, tick: 100 }));
    devtools.flushDataFeeds();

    // Read back from SAB using the impl
    const result = _devtoolsImpl.readDataFeed(0);
    expect(result).not.toBeNull();
    expect(result.fps).toBe(60);
    expect(result.tick).toBe(100);
  });

  test("flushDataFeeds respects writeRateHz", () => {
    devtools.clear();
    const sab = allocateDevToolsSAB();
    devtools.attachSAB(sab);

    let callCount = 0;
    // writeRateHz = 0 means "flush every call" (no rate limiting)
    devtools.registerDataFeed("fast", () => { callCount++; return { n: callCount }; }, 0);
    devtools.flushDataFeeds();
    expect(callCount).toBe(1);
    devtools.flushDataFeeds();
    expect(callCount).toBe(2);

    // With writeRateHz = 1 (every 1000ms), second immediate call should be skipped
    devtools.clear();
    devtools.attachSAB(sab);
    callCount = 0;
    devtools.registerDataFeed("slow", () => { callCount++; return { n: callCount }; }, 1);
    devtools.flushDataFeeds();
    expect(callCount).toBe(1);
    devtools.flushDataFeeds(); // should skip (within 1000ms window)
    expect(callCount).toBe(1);
  });

  test("flushDataFeeds handles fn that throws", () => {
    devtools.clear();
    const sab = allocateDevToolsSAB();
    devtools.attachSAB(sab);

    devtools.registerDataFeed("error", () => { throw new Error("boom"); }, 1000);
    devtools.flushDataFeeds(); // should not throw

    // Read back — should return null (length = 0)
    const result = _devtoolsImpl.readDataFeed(0);
    expect(result).toBeNull();
  });

  test("SAB stats can be written and read", () => {
    devtools.clear();
    const sab = allocateDevToolsSAB();
    devtools.attachSAB(sab);

    devtools.registerSABStat("count", 0, "u32");
    devtools.registerSABStat("temp", 4, "f32");

    // Write values directly to SAB
    const u32 = new Uint32Array(sab);
    const f32 = new Float32Array(sab);
    const layout = computeDevToolsSABLayout();
    u32[layout.statsBaseOffset / 4] = 42;
    f32[(layout.statsBaseOffset + 4) / 4] = 23.5;

    expect(_devtoolsImpl.readSABStat("count")).toBe(42);
    expect(_devtoolsImpl.readSABStat("temp")).toBeCloseTo(23.5);
  });
});
