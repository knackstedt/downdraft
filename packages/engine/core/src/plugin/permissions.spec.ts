import type { PluginPermission } from "./manifest";
import {
    BASELINE_GLOBALS,
    computeGlobalAllowlist,
    PERMISSION_GLOBALS,
    resolvePermissions,
    TIER_ALLOWED,
} from "./permissions";

describe("permissions", () => {
  describe("TIER_ALLOWED", () => {
    it("data tier allows nothing", () => {
      expect(TIER_ALLOWED.data.size).toBe(0);
    });
    it("script tier allows only safe perms", () => {
      expect(([...TIER_ALLOWED.script] as string[]).sort()).toEqual(
        ["events", "log", "state", "storage", "tick"].sort(),
      );
    });
    it("native tier allows all known permissions", () => {
      expect(TIER_ALLOWED.native.size).toBe(11);
    });
  });

  describe("resolvePermissions", () => {
    it("grants all requested native perms when no game allowlist", () => {
      const r = resolvePermissions(["ecs", "sab", "events"], "native");
      expect(r.granted.has("ecs")).toBe(true);
      expect(r.granted.has("sab")).toBe(true);
      expect(r.granted.has("events")).toBe(true);
      expect(r.denied).toEqual([]);
    });

    it("denies native-only perms for script tier", () => {
      const r = resolvePermissions(["ecs", "events"], "script");
      expect(r.granted.has("events")).toBe(true);
      expect(r.granted.has("ecs")).toBe(false);
      expect(r.denied.some((d) => d.permission === "ecs")).toBe(true);
    });

    it("denies everything for data tier", () => {
      const r = resolvePermissions(["events"], "data");
      expect(r.granted.size).toBe(0);
      expect(r.denied.some((d) => d.permission === "events")).toBe(true);
    });

    it("game allowlist further restricts native tier", () => {
      const allow = new Set<PluginPermission>(["ecs", "events"]);
      const r = resolvePermissions(["ecs", "sab", "network", "events"], "native", allow);
      expect(r.granted.has("ecs")).toBe(true);
      expect(r.granted.has("events")).toBe(true);
      expect(r.granted.has("sab")).toBe(false);
      expect(r.granted.has("network")).toBe(false);
      expect(r.denied.some((d) => d.permission === "sab" && d.reason.includes("allowlist"))).toBe(true);
    });

    it("empty requested → empty granted", () => {
      const r = resolvePermissions([], "native");
      expect(r.granted.size).toBe(0);
      expect(r.denied).toEqual([]);
    });
  });

  describe("computeGlobalAllowlist", () => {
    it("baseline only when no perms granted", () => {
      const keep = computeGlobalAllowlist(new Set());
      BASELINE_GLOBALS.forEach((g) => { expect(keep.has(g)).toBe(true);; });
      expect(keep.has("fetch")).toBe(false);
      expect(keep.has("WebSocket")).toBe(false);
      expect(keep.has("indexedDB")).toBe(false);
    });

    it("network perm adds fetch/WebSocket/XHR", () => {
      const keep = computeGlobalAllowlist(new Set(["network"] as PluginPermission[]));
      expect(keep.has("fetch")).toBe(true);
      expect(keep.has("WebSocket")).toBe(true);
      expect(keep.has("XMLHttpRequest")).toBe(true);
      // storage globals still absent
      expect(keep.has("indexedDB")).toBe(false);
    });

    it("storage perm adds indexedDB/caches", () => {
      const keep = computeGlobalAllowlist(new Set(["storage"] as PluginPermission[]));
      expect(keep.has("indexedDB")).toBe(true);
      expect(keep.has("caches")).toBe(true);
      expect(keep.has("fetch")).toBe(false);
    });

    it("union of multiple perms", () => {
      const keep = computeGlobalAllowlist(new Set(["network", "storage"] as PluginPermission[]));
      expect(keep.has("fetch")).toBe(true);
      expect(keep.has("indexedDB")).toBe(true);
    });

    it("mediated perms (ecs/sab/events) add no raw globals", () => {
      const mediated: PluginPermission[] = ["ecs", "sab", "gpu", "events", "state", "tick", "log"];
      const keep = computeGlobalAllowlist(new Set(mediated));
      // Only baseline globals present (no raw network/storage globals)
      expect(keep.has("fetch")).toBe(false);
      expect(keep.has("indexedDB")).toBe(false);
    });
  });

  it("PERMISSION_GLOBALS lists every permission", () => {
    const all: PluginPermission[] = ["ecs", "sab", "gpu", "events", "state", "tick", "storage", "network", "log"];
    all.forEach((p) => { expect(Array.isArray(PERMISSION_GLOBALS[p])).toBe(true);; });
  });
});
