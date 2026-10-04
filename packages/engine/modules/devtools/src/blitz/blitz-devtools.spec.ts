// blitz-devtools.spec.ts — headless BlitzDevtoolsHost tests.
//
// The doc layer is faked (DevtoolsUiSurface is an interface): FakePanel
// records setInnerHtml/setText/setAttr calls so we can assert on the HTML
// the host would ship to Blitz. A FakeServer backend feed exercises the
// real DevtoolsBackend → panel render path.
import type { OsrDomEvent, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { describe, expect, test } from "bun:test";
import { BlitzDevtoolsHost, type DevtoolsUiSurface } from "./host";

// ── Fakes ──

interface Mutation { kind: string; target?: string; html?: string; text?: string; name?: string; value?: string }

class FakePanel {
  rect = { x: 0, y: 0, w: 0, h: 0 };
  mutations: Mutation[] = [];
  html = "";
  disposed = false;
  events: ((ev: OsrDomEvent) => void)[] = [];

  inner(sel: string): string {
    return this.mutations.filter((m) => m.kind === "innerHtml" && m.target === sel).at(-1)?.html ?? "";
  }
  fire(ev: Partial<OsrDomEvent>): void {
    this.events.forEach((fn) => fn({ t: "click", n: 1, ...ev } as OsrDomEvent));
  }
  last(sel: string): string { return this.inner(sel); }
}

function fakeSurface(): { surface: DevtoolsUiSurface; panel: FakePanel } {
  const fp = new FakePanel();
  const handle = {
    id: "devtools",
    get rect() { return fp.rect; },
    setHtml: (h: string) => { fp.html = h; },
    setText: (t: string | number, text: string) => { fp.mutations.push({ kind: "text", target: String(t), text }); },
    setAttr: (t: string | number, name: string, value: string) => { fp.mutations.push({ kind: "attr", target: String(t), name, value }); },
    removeAttr: (t: string | number, name: string) => { fp.mutations.push({ kind: "rattr", target: String(t), name }); },
    setStyle: (t: string | number, prop: string, value: string) => { fp.mutations.push({ kind: "style", target: String(t), name: prop, value }); },
    setInnerHtml: (t: string | number, html: string) => { fp.mutations.push({ kind: "innerHtml", target: String(t), html }); },
    mutate: (ops: unknown[]) => { fp.mutations.push({ kind: "mutate", value: JSON.stringify(ops) }); },
    focus: () => {},
    setMaxFps: () => {},
    setRect: (r: { x: number; y: number; w: number; h: number }) => { fp.rect = { ...r }; },
    setDocHeight: () => {},
    setSrcRect: () => {},
    setZ: () => {},
    setInteractive: () => {},
    onEvent: (fn: (ev: OsrDomEvent) => void) => { fp.events.push(fn); return () => {}; },
    getAttr: async () => null,
    getRect: async () => null,
    queryAll: async () => [],
    getRects: async () => [],
    focusedNode: async () => 0,
    scrollIntoView: (t: string | number) => { fp.mutations.push({ kind: "scrollIntoView", target: String(t) }); },
    scrollTo: (t: string | number, x: number, y: number) => { fp.mutations.push({ kind: "scrollTo", target: String(t), value: `${x},${y}` }); },
    navSnapshot: async () => [],
    click: () => {},
    sendKey: () => {},
    sendPointer: () => {},
    dispose: () => { fp.disposed = true; },
  } as unknown as UiPanelHandle;
  return {
    surface: {
      mount: (markup: string, spec: { onEvent?: (ev: OsrDomEvent) => void; rect: { x: number; y: number; w: number; h: number } }) => {
        fp.html = markup;
        fp.rect = { ...spec.rect };
        if (spec.onEvent) fp.events.push(spec.onEvent);
        return handle;
      },
    },
    panel: fp,
  };
}

function makeHost(): { host: BlitzDevtoolsHost; fake: FakePanel } {
  const { surface, panel } = fakeSurface();
  const host = new BlitzDevtoolsHost({
    ui: surface,
    renderer: {},
    surface: { clientWidth: 1280, clientHeight: 720 },
  });
  host.start();
  return { host, fake: panel };
}

// ── Tests ──

describe("BlitzDevtoolsHost", () => {
  test("F12 toggle mounts/unmounts the dock", () => {
    const { host, fake } = makeHost();
    expect(host.visible).toBe(false);
    host.toggle();
    expect(host.visible).toBe(true);
    expect(fake.disposed).toBe(false);
    expect(fake.rect.h).toBeGreaterThan(100);
    expect(fake.rect.y + fake.rect.h).toBe(720); // docked at bottom
    host.toggle();
    expect(host.visible).toBe(false);
    expect(fake.disposed).toBe(true);
  });

  test("tab bar lists fixed panels + activate renders console", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    const tabs = fake.inner("#dt-tabs");
    expect(tabs).toContain("Console");
    expect(tabs).toContain("Elements");
    expect(tabs).toContain("Performance");
    expect(tabs).toContain("GPU");
    expect(fake.inner("#dt-body")).toContain("console-log");
    expect(fake.inner("#dt-bottom")).toContain("data-dt=\"repl\"");
  });

  test("console receives backend log entries", () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({ sections: [] }));
    // Simulate a logger-sink entry pushed through the backend emit path.
    (host as any).backend.emit("console", { text: "hello world", severity: 1, thread: "main", ts: 0 });
    host.update();
    expect(fake.inner("#dt-body")).toContain("hello world");
  });

  test("tab click switches panels", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "gpu" } });
    expect(host.getActivePanel()).toBe("gpu");
    expect(fake.inner("#dt-body")).toContain("Frame times");
  });

  test("provider registration adds a snapshot tab", () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({
      sections: [{ kind: "kv", name: "", rows: [{ key: "HP", value: "100" }] }],
    }));
    host.update(); // syncProviders runs in update
    const tabs = fake.inner("#dt-tabs");
    expect(tabs).toContain("Game");
  });

  test("snapshot tab renders provider data", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({
      sections: [{ kind: "kv", name: "", rows: [{ key: "HP", value: "100" }] }],
    }));
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-game" } });
    await new Promise((r) => setTimeout(r, 10)); // refresh() is async
    host.update();
    expect(fake.inner("#dt-body")).toContain("HP");
    expect(fake.inner("#dt-body")).toContain("100");
  });

  test("REPL Enter evaluates via backend dispatch", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    // Type into the repl, then press Enter.
    fake.fire({ t: "input", d: { dt: "repl" }, v: "1+1" });
    fake.fire({ t: "keydown", d: { dt: "repl" }, k: "Enter" });
    await new Promise((r) => setTimeout(r, 10));
    host.update();
    const body = fake.inner("#dt-body");
    expect(body).toContain("&gt; 1+1");
  });

  test("grip drag resizes the dock", () => {
    const { host, fake } = makeHost();
    host.show();
    const h0 = fake.rect.h;
    fake.fire({ t: "mousedown", id: "dt-grip", y: 2 });
    fake.fire({ t: "pointermove", y: -50 });
    expect(fake.rect.h).toBe(h0 + 52);
    fake.fire({ t: "mouseup", y: -50 });
    fake.fire({ t: "pointermove", y: -100 });
    expect(fake.rect.h).toBe(h0 + 52); // drag ended
  });

  test("resize keeps the dock bottom-anchored", () => {
    const { host, fake } = makeHost();
    host.show();
    host.resize(1600, 900);
    expect(fake.rect.y + fake.rect.h).toBe(900);
    expect(fake.rect.w).toBe(1600);
  });
});
