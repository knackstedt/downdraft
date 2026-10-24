import { describe, test, expect } from "bun:test";
import { sidebarMarkup, tabstripMarkup, statusbarMarkup, dockStripMarkup } from "../src/ui/markup";
import { store, type AppState, type TargetInfo } from "../src/app/store";

function target(over: Partial<TargetInfo> = {}): TargetInfo {
  return {
    id: "pid-7", pid: 7, kind: "downdraft", name: "my-app", detail: "bun · proj",
    status: "attached",
    channels: { mirror: true, cdp: false, mcp: true, procfs: true },
    caps: ["console", "eval", "profile-cpu"], mcpTools: ["x"], panels: [],
    inspectorMethods: [], threads: [{ id: "main", name: "main", kind: 0 }],
    endpoints: [], ...over,
  };
}

function st(over: Partial<AppState> = {}): AppState {
  return { ...store.getState(), targets: [], ...over };
}

describe("sidebarMarkup", () => {
  test("renders target rows with channel badges + detach control", () => {
    const html = sidebarMarkup(st({ targets: [target()], activeTargetId: "pid-7" }));
    expect(html).toContain("Targets");
    expect(html).toContain("my-app");
    expect(html).toContain("bun · proj");
    expect(html).toContain('data-action="detach-target"');
    expect(html).toContain('badge on">mirror');
    expect(html).not.toContain('badge on">cdp');
  });

  test("empty state + attach affordance", () => {
    const html = sidebarMarkup(st());
    expect(html).toContain("No targets discovered");
    expect(html).toContain('data-action="attach-manual"');
  });

  test("attachOpen renders the input row", () => {
    expect(sidebarMarkup(st({ attachOpen: true }))).toContain('id="attach-input"');
  });

  test("lost targets get a reattach control and lost styling", () => {
    const html = sidebarMarkup(st({ targets: [target({ status: "lost" })] }));
    expect(html).toContain('data-action="attach-target"');
    expect(html).toContain("lost");
  });

  test("escapes html in names", () => {
    const html = sidebarMarkup(st({ targets: [target({ name: "<b>x</b>" })] }));
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("tabstripMarkup", () => {
  test("main tabs minus world for plain targets", () => {
    const html = tabstripMarkup(st({ targets: [target()], activeTargetId: "pid-7" }));
    expect(html).toContain('data-tab="console"');
    expect(html).not.toContain('data-tab="world"');
  });

  test("world tab appears with a sim provider", () => {
    const html = tabstripMarkup(st({
      targets: [target({ panels: [{ slot: 3, name: "sim" }] })],
      activeTargetId: "pid-7",
    }));
    expect(html).toContain('data-tab="world"');
    // Provider panels that aren't rolled into bespoke tabs get their own tab.
    const html2 = tabstripMarkup(st({
      targets: [target({ panels: [{ slot: 4, name: "custom" }] })],
      activeTargetId: "pid-7",
    }));
    expect(html2).toContain('data-tab="panel:4"');
  });
});

describe("statusbarMarkup / dockStripMarkup", () => {
  test("statusbar shows active target + caps", () => {
    const html = statusbarMarkup(st({ targets: [target()], activeTargetId: "pid-7" }));
    expect(html).toContain("my-app");
    expect(html).toContain("console · eval");
  });

  test("dock strip renders tabs and collapse chip", () => {
    const s = st();
    const html = dockStripMarkup(s.docks.bottom, "bottom", s);
    expect(html).toContain('data-action="dock-tab-bottom"');
    expect(html).toContain('data-action="dock-collapse-bottom"');
  });
});
