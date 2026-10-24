import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { store } from "../src/app/store";
import {
  computeLayout, dockSelect, dockToggle, dockRemove, dockAdd, dockMove,
  dockResize, setMainTab, revealSource, panelTitle,
} from "../src/ui/drawer";

// Dock ops persist via saveLayout → redirect HOME so tests don't clobber the
// user's real layout.json.
const fakeHome = mkdtempSync(join(tmpdir(), "devtools-layout-"));
let realHome: string | undefined;
beforeAll(() => { realHome = process.env.HOME; process.env.HOME = fakeHome; });
afterAll(() => { process.env.HOME = realHome; rmSync(fakeHome, { recursive: true, force: true }); });

function reset(): void {
  store.setState({
    windowW: 1600, windowH: 1000, sidebarWidth: 230, topbarHeight: 30,
    mainTab: "console",
    docks: {
      bottom: { tabs: ["perfmon", "events", "network"], active: "perfmon", size: 250, collapsed: false },
      right: { tabs: ["source"], active: null, size: 420, collapsed: true },
    },
  });
  computeLayout();
}

describe("computeLayout", () => {
  test("carves main/bottom/right rects out of the window", () => {
    reset();
    const s = store.getState();
    expect(s.mainRect).toEqual({ x: 230, y: 30, w: 1370, h: 720 });
    expect(s.bottomRect).toEqual({ x: 230, y: 750, w: 1370, h: 250 });
    expect(s.rightRect.w).toBe(0);
  });

  test("open right dock shrinks the main area", () => {
    reset();
    dockAdd("right", "source");
    const s = store.getState();
    expect(s.rightRect).toEqual({ x: 1180, y: 30, w: 420, h: 720 });
    expect(s.mainRect.w).toBe(950);
    expect(s.bottomRect.w).toBe(950);
  });

  test("collapsed bottom dock zeroes its rect", () => {
    reset();
    dockToggle("bottom");
    const s = store.getState();
    expect(s.docks.bottom.collapsed).toBe(true);
    expect(s.bottomRect.h).toBe(0);
    expect(s.mainRect.h).toBe(970);
  });
});

describe("dock operations", () => {
  test("select/toggle/move/remove", () => {
    reset();
    dockSelect("bottom", "events");
    expect(store.getState().docks.bottom.active).toBe("events");

    dockMove("network", "bottom", "right");
    const s = store.getState();
    expect(s.docks.bottom.tabs).not.toContain("network");
    expect(s.docks.right.tabs).toContain("network");
    expect(s.docks.right.active).toBe("network");
    expect(s.docks.right.collapsed).toBe(false);

    dockRemove("bottom", "perfmon");
    expect(store.getState().docks.bottom.active).toBe("events");
  });

  test("removing the active tab falls back to the last tab", () => {
    reset();
    dockRemove("bottom", "perfmon");
    expect(store.getState().docks.bottom.active).toBe("network");
  });

  test("uncollapsing with no active tab picks the first", () => {
    reset();
    store.setState((st) => ({ docks: { ...st.docks, bottom: { ...st.docks.bottom, active: null } } }));
    dockToggle("bottom"); // collapse
    dockToggle("bottom"); // uncollapse
    expect(store.getState().docks.bottom.active).toBe("perfmon");
  });

  test("resize clamps to 80..2000", () => {
    reset();
    dockResize("bottom", -10_000);
    expect(store.getState().docks.bottom.size).toBe(80);
    dockResize("bottom", 10_000);
    expect(store.getState().docks.bottom.size).toBe(2000);
  });
});

describe("tabs + reveal", () => {
  test("setMainTab / revealSource", () => {
    reset();
    setMainTab("profiler");
    expect(store.getState().mainTab).toBe("profiler");

    revealSource("file:///src/x.ts", 12, 4);
    const s = store.getState();
    expect(s.docks.right.collapsed).toBe(false);
    expect(s.docks.right.active).toBe("source");
    expect(s.sourceRequest).toEqual({ url: "file:///src/x.ts", line: 12, col: 4 });
  });
});

describe("panelTitle", () => {
  test("strips snapshot:/feed: prefixes, falls back to id", () => {
    expect(panelTitle("feed:weather")).toBe("weather");
    expect(panelTitle("snapshot:sim")).toBe("sim");
    expect(panelTitle("console")).toBe("console");
  });
});
