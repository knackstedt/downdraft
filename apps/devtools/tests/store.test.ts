import { describe, test, expect } from "bun:test";
import { MAIN_TABS, mainTabsFor, targetHasWorld, type TargetInfo } from "../src/app/store";

function t(over: Partial<TargetInfo> = {}): TargetInfo {
  return {
    id: "pid-1", pid: 1, kind: "downdraft", name: "t", status: "attached",
    channels: {}, caps: [], mcpTools: [], panels: [], inspectorMethods: [],
    threads: [], endpoints: [], ...over,
  };
}

describe("store tab gating", () => {
  test("world hidden when the target has nothing world-shaped", () => {
    expect(targetHasWorld(t())).toBe(false);
    expect(mainTabsFor(t())).not.toContain("world");
  });

  test("world shown with a world/scene provider panel", () => {
    const w = t({ panels: [{ slot: 0, name: "sim" }] });
    expect(targetHasWorld(w)).toBe(true);
    expect(mainTabsFor(w)).toContain("world");
  });

  test("world shown with get_world_state MCP tool", () => {
    expect(targetHasWorld(t({ mcpTools: ["get_world_state"] }))).toBe(true);
  });

  test("non-world provider names don't open the world tab", () => {
    expect(targetHasWorld(t({ panels: [{ slot: 0, name: "memory" }] }))).toBe(false);
  });

  test("null target → MAIN_TABS minus world", () => {
    expect(mainTabsFor(null)).toEqual(MAIN_TABS.filter((x) => x !== "world"));
    expect(mainTabsFor(undefined)).toEqual(MAIN_TABS.filter((x) => x !== "world"));
  });
});
