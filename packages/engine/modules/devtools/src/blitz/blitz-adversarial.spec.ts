// blitz-adversarial.spec.ts — fault-injection tests for the Blitz devtools
// dock: malformed provider data, throwing panels, stale ids, event abuse.
import type { OsrDomEvent, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { BlitzDevtoolsHost, type DevtoolsUiSurface } from "./host";

// ── Fakes (same shape as blitz-devtools.spec.ts) ──

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
  attrWrites(): Mutation[] { return this.mutations.filter((m) => m.kind === "attr"); }
  mutateOps(): any[] {
    return this.mutations.filter((m) => m.kind === "mutate")
      .flatMap((m) => JSON.parse(m.value ?? "[]"));
  }
  fire(ev: Partial<OsrDomEvent>): void {
    this.events.forEach((fn) => fn({ t: "click", n: 1, ...ev } as OsrDomEvent));
  }
}

function fakeSurface(opts?: { incrementalDom?: boolean; throwOnMount?: boolean }) {
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
    appendHtml: (t: string | number, html: string) => { fp.mutations.push({ kind: "appendHtml", target: String(t), html }); },
    trimChildren: (t: string | number, keep: number) => { fp.mutations.push({ kind: "trimChildren", target: String(t), value: String(keep) }); },
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
  const surface: DevtoolsUiSurface = {
    mount: (markup, spec) => {
      if (opts?.throwOnMount) throw new Error("mount failed: worker dead");
      fp.html = markup;
      fp.rect = { ...spec.rect };
      if (spec.onEvent) fp.events.push(spec.onEvent);
      return handle;
    },
    docCaps: () => ({ incrementalDom: opts?.incrementalDom === true }),
  };
  return { surface, panel: fp };
}

function makeHost(opts?: { incrementalDom?: boolean; surface?: DevtoolsUiSurface }): { host: BlitzDevtoolsHost; fake: FakePanel } {
  const { surface, panel } = opts?.surface
    ? { surface: opts.surface, panel: new FakePanel() }
    : fakeSurface(opts);
  const host = new BlitzDevtoolsHost({
    ui: surface,
    renderer: {},
    surface: { clientWidth: 1280, clientHeight: 720 },
  });
  host.start();
  return { host, fake: panel };
}

function bypassThrottle(host: BlitzDevtoolsHost): void {
  (host as any).lastPanelRender = -1e9;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  delete (globalThis as any).__sceneInspector;
});

// ── Adversarial rounds ──

describe("devtools adversarial — host", () => {
  test("right-click on a tab does NOT switch panels", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "contextmenu", d: { action: "dt.tab", tab: "gpu" } });
    expect(host.getActivePanel()).toBe("console");
  });

  test("two bespoke provider names get distinct tabs (no slot-0 collapse)", () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("vitals", () => ({ sections: [] }));
    host.devtoolsMirror.registerProvider("inventory", () => ({ sections: [] }));
    host.update();
    const tabs = fake.inner("#dt-tabs");
    expect(tabs).toContain("Vitals");
    expect(tabs).toContain("Inventory");
    // Exactly one "Console" tab — the fixed panel's.
    expect(tabs.match(/data-tab="snap-/g)?.length).toBe(2);
  });

  test("provider name with markup chars is escaped in the tab strip", () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider('x"><img src=a>' as any, () => ({ sections: [] }));
    host.update();
    const tabs = fake.inner("#dt-tabs");
    expect(tabs).not.toContain('"><img src=a>');
    expect(tabs).toContain("&lt;img");
  });

  test("a throwing renderBody cannot kill update()", () => {
    const { host } = makeHost();
    host.show();
    host.update();
    const panel = (host as any).panels.get("console");
    const orig = panel.renderBody.bind(panel);
    panel.renderBody = () => { throw new Error("panel boom"); };
    panel.dirty = true;
    bypassThrottle(host);
    expect(() => host.update()).not.toThrow();
    panel.renderBody = orig;
  });

  test("a throwing onAction is contained", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    const panel = (host as any).panels.get("console");
    panel.onAction = () => { throw new Error("action boom"); };
    expect(() => fake.fire({ t: "click", d: { action: "anything" } })).not.toThrow();
  });

  test("console rows pushed while hidden appear on show", () => {
    const { host, fake } = makeHost();
    (host as any).backend.emit("console", { text: "buffered while hidden", severity: 1, thread: "main", ts: 0 });
    host.show();
    host.update();
    const body = fake.inner("#dt-body");
    const saw = body.includes("buffered while hidden")
      || fake.mutations.some((m) => m.value?.includes("buffered while hidden"));
    expect(saw).toBe(true);
  });

  test("resize to a tiny surface never produces a negative dock height", () => {
    const { host, fake } = makeHost();
    host.show();
    host.resize(200, 50);
    expect(fake.rect.h).toBeGreaterThan(0);
  });

  test("update() and show() after dispose are safe no-ops", () => {
    const { host } = makeHost();
    host.show();
    host.dispose();
    expect(() => { host.update(); host.show(); host.toggle(); }).not.toThrow();
    expect(host.visible).toBe(false);
  });

  test("mount failure leaves the host unmounted, not half-open", () => {
    const { surface } = fakeSurface({ throwOnMount: true });
    const host = new BlitzDevtoolsHost({ ui: surface, renderer: {}, surface: { clientWidth: 800, clientHeight: 600 } });
    host.start();
    expect(() => host.show()).not.toThrow();
    expect(host.visible).toBe(false);
    expect(() => host.show()).not.toThrow(); // retry-able
  });
});

describe("devtools adversarial — elements", () => {
  const STAGE = {
    label: "root", id: "root", children: [
      { label: "child-a", id: "model-1", children: [] },
      { label: "child-b", id: "model-2", children: [] },
    ],
  };

  function makeSceneHost(): { host: BlitzDevtoolsHost; fake: FakePanel } {
    const { surface, panel } = fakeSurface();
    const host = new BlitzDevtoolsHost({
      ui: surface, renderer: {},
      surface: { clientWidth: 1280, clientHeight: 720 },
      gameScene: { stage: STAGE },
    });
    host.start();
    return { host, fake: panel };
  }

  function panelRows(host: BlitzDevtoolsHost): any[] {
    return (host as any).panels.get("elements").rows;
  }

  async function openElements(host: BlitzDevtoolsHost, fake: FakePanel): Promise<void> {
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "elements" } });
    // activate() → refresh() resolves the collect on a microtask.
    await tick();
    bypassThrottle(host);
    host.update();
  }

  test("el.pick selects a row via attr mutation and shows the details strip", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    const childA = panelRows(host).find((r) => r.label === "child-a");
    fake.mutations.length = 0;
    fake.fire({ t: "click", d: { action: "el.pick", node: String(childA.id) } });
    await tick();
    bypassThrottle(host);
    host.update();
    const ops = fake.mutateOps();
    expect(ops.some((o) => o.op === "attr" && o.sel === `[data-node="${childA.id}"]` && o.value === "trow sel")).toBe(true);
    expect(fake.inner("#dt-bottom")).toContain("child-a");
  });

  test("el.pick enriches details via inspector.getNodeJSON", async () => {
    (globalThis as any).__sceneInspector = {
      getNodeJSON: (id: string) => JSON.stringify({ id, hp: 100 }),
      selectNode: () => {},
    };
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    const childB = panelRows(host).find((r) => r.label === "child-b");
    fake.fire({ t: "click", d: { action: "el.pick", node: String(childB.id) } });
    await tick();
    bypassThrottle(host);
    host.update();
    const bottom = fake.inner("#dt-bottom");
    expect(bottom).toContain("hp");
  });

  test("el.pick on a stale node id is a safe no-op", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    expect(() => fake.fire({ t: "click", d: { action: "el.pick", node: "999" } })).not.toThrow();
    expect(fake.inner("#dt-bottom")).not.toContain("dt-title");
  });

  test("selection survives a tree refresh via nodeId keys", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    const childA = panelRows(host).find((r) => r.label === "child-a");
    fake.fire({ t: "click", d: { action: "el.pick", node: String(childA.id) } });
    await tick();
    // Simulate a refresh that returns the same tree under new ephemeral ids.
    fake.mutations.length = 0;
    (host as any).backend.emit("scene", panelRows(host).map((r, i) => ({ ...r, id: 100 + i })));
    bypassThrottle(host);
    host.update();
    // sig excludes id — identical shape dedupes; .sel survived via selKey.
    const ops = fake.mutateOps();
    expect(ops.some((o) => o.sel?.includes('data-node="') && o.value === "trow sel")).toBe(false);
  });

  test("el.fold collapses a subtree in the next render", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    const root = panelRows(host).find((r) => r.label === "root");
    fake.fire({ t: "click", d: { action: "el.fold", node: String(root.id) } });
    bypassThrottle(host);
    host.update();
    const body = fake.inner("#dt-body");
    expect(body).toContain("root");
    expect(body).not.toContain("child-a");
    expect(body).not.toContain("child-b");
  });

  test("identical scene pushes do not re-render the body", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    fake.mutations.length = 0;
    (host as any).backend.emit("scene", panelRows(host).map((r) => ({ ...r })));
    bypassThrottle(host);
    host.update();
    const bodyWrites = fake.mutations.filter((m) => m.kind === "innerHtml" && m.target === "#dt-body");
    expect(bodyWrites.length).toBe(0);
  });

  test("changed scene pushes re-render exactly once", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    fake.mutations.length = 0;
    (host as any).backend.emit("scene", [
      ...panelRows(host),
      { id: 4, parentId: 1, depth: 1, childCount: 0, kind: 0, label: "child-c", detail: "Object", nodeId: "model-3" },
    ]);
    bypassThrottle(host);
    host.update();
    const bodyWrites = fake.mutations.filter((m) => m.kind === "innerHtml" && m.target === "#dt-body");
    expect(bodyWrites.length).toBe(1);
    expect(fake.inner("#dt-body")).toContain("child-c");
  });

  test("scroll offset is restored after a body re-render", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    fake.fire({ t: "scroll", id: "dt-body", st: 240 });
    (host as any).backend.emit("scene", [
      ...panelRows(host),
      { id: 9, parentId: -1, depth: 0, childCount: 0, kind: 0, label: "newroot", detail: "Object", nodeId: "r2" },
    ]);
    bypassThrottle(host);
    host.update();
    const scrolls = fake.mutations.filter((m) => m.kind === "scrollTo" && m.target === "#dt-body");
    expect(scrolls.at(-1)?.value).toBe("0,240");
  });

  test("mode switch to ecs doesn't crash when the world is absent", async () => {
    const { host, fake } = makeSceneHost();
    await openElements(host, fake);
    fake.fire({ t: "click", d: { action: "el.mode", mode: "ecs" } });
    await tick();
    bypassThrottle(host);
    expect(() => host.update()).not.toThrow();
  });
});

describe("devtools adversarial — console", () => {
  test("ArrowDown past the newest history entry clears the input", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "input", d: { dt: "repl" }, v: "one" });
    fake.fire({ t: "keydown", d: { dt: "repl" }, k: "Enter" });
    fake.fire({ t: "input", d: { dt: "repl" }, v: "two" });
    fake.fire({ t: "keydown", d: { dt: "repl" }, k: "Enter" });
    fake.mutations.length = 0;
    fake.fire({ t: "keydown", d: { dt: "repl" }, k: "ArrowUp" });
    fake.fire({ t: "keydown", d: { dt: "repl" }, k: "ArrowDown" });
    const sets = fake.attrWrites().filter((m) => m.name === "value");
    expect(sets.at(-1)?.value).toBe("");
  });

  test("a threads push updates the REPL thread chips", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    (host as any).backend.emit("threads", [{ id: "sim", name: "sim", kind: 1 }]);
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-bottom")).toContain("sim");
  });

  test("log text with markup is escaped", () => {
    const { host, fake } = makeHost();
    host.show();
    (host as any).backend.emit("console", { text: '<img src=x onerror="alert(1)">', severity: 1, thread: "main", ts: 0 });
    host.update();
    const body = fake.inner("#dt-body");
    const saw = body.includes('<img src=x onerror') || fake.mutations.some((m) => m.value?.includes("<img src=x onerror"));
    expect(saw).toBe(false);
    const escd = body.includes("&lt;img") || fake.mutations.some((m) => m.value?.includes("&lt;img"));
    expect(escd).toBe(true);
  });

  test("a burst over MAX_ROWS trims the buffer", () => {
    const { host } = makeHost();
    host.show();
    for (let i = 0; i < 2100; i++) {
      (host as any).backend.emit("console", { text: `row ${i}`, severity: 1, thread: "main", ts: 0 });
    }
    const panel = (host as any).panels.get("console");
    expect(panel.rows.length).toBeLessThanOrEqual(2000);
  });

  test("malformed console events render without crashing", () => {
    const { host, fake } = makeHost();
    host.show();
    (host as any).backend.emit("console", undefined);
    (host as any).backend.emit("console", { text: null });
    (host as any).backend.emit("console", "a string, not an object");
    expect(() => host.update()).not.toThrow();
  });
});

describe("devtools adversarial — snapshot & perf", () => {
  test("provider errors surface as an error banner, not silence", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("explode", () => { throw new Error("kaboom"); });
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-explode" } });
    await tick();
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-body")).toContain("kaboom");
  });

  test("dispatch() failure surfaces as refresh-failed banner", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({ sections: [] }));
    host.update();
    const orig = (host as any).backend.dispatch.bind((host as any).backend);
    (host as any).backend.dispatch = async (m: string) => {
      if (m === "snapshot") throw new Error("dispatch dead");
      return orig(m, {});
    };
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-game" } });
    await tick();
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-body")).toContain("refresh failed");
  });

  test("performance panel shows the empty-state hint when no metrics exist", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "performance" } });
    expect(fake.inner("#dt-body")).toContain("no metrics");
  });

  test("snapshot section with an unknown kind renders a note, not a crash", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({
      sections: [{ kind: "hypercube" as any, name: "x", rows: [] } as any],
    }));
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-game" } });
    await tick();
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-body")).toContain("unknown section");
  });

  test("a slow stale refresh cannot clobber a newer snapshot", async () => {
    const deferred: ((v: any) => void)[] = [];
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => new Promise((r) => deferred.push(r)));
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-game" } });
    // refresh #1 (activate) in flight; issue refresh #2, resolve newer first.
    fake.fire({ t: "click", d: { action: "snap.refresh" } });
    deferred[1]?.({ sections: [{ kind: "kv", name: "new", rows: [{ key: "v", value: "newer" }] }] });
    await tick();
    deferred[0]?.({ sections: [{ kind: "kv", name: "stale", rows: [{ key: "v", value: "stale" }] }] });
    await tick();
    bypassThrottle(host);
    host.update();
    const body = fake.inner("#dt-body");
    expect(body).toContain("newer");
    expect(body).not.toContain("stale");
  });

  test("a snapshot pushed for a foreign slot doesn't bleed into the active tab", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("aaa", () => ({ sections: [] }));
    host.devtoolsMirror.registerProvider("bbb", () => ({ sections: [] }));
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-aaa" } });
    await tick();
    const bSlot = (host as any).backend.providerSlots().find((s: any) => s.name === "bbb").slot;
    (host as any).backend.emit("snapshot", {
      panel: "bbb", slot: bSlot,
      snap: { sections: [{ kind: "kv", name: "x", rows: [{ key: "k", value: "b-only" }] }] },
    });
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-body")).not.toContain("b-only");
  });

  test("slider control without min/max renders sane payloads, not NaN", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({
      sections: [{ kind: "controls", name: "c", controls: [{ type: "slider", id: "s", label: "s" }] as any }],
    }));
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-game" } });
    await tick();
    bypassThrottle(host);
    host.update();
    const body = fake.inner("#dt-body");
    expect(body).not.toContain("NaN");
    expect(body).toContain('data-payload="0.00"');
  });

  test("a provider returning a malformed section kind renders a banner, not a blank", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({
      sections: [{ kind: "kv", name: "bad", rows: "not-an-array" } as any],
    }));
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-game" } });
    await tick();
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-body")).toContain("panel render error");
  });

  test("snap.cmd routes payload to the provider's command handler", async () => {
    let got: any = null;
    const { host, fake } = makeHost();
    host.show();
    host.devtoolsMirror.registerProvider("game", () => ({
      sections: [{ kind: "controls", name: "c", controls: [{ type: "button", id: "reset", label: "Reset", payload: "all" }] as any }],
    }));
    host.devtoolsMirror.registerCommandHandler("game" as any, async (cmd: any) => { got = { a: cmd.action, payload: cmd.payload }; });
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "snap-game" } });
    await tick();
    bypassThrottle(host);
    host.update();
    fake.fire({ t: "click", d: { action: "snap.cmd", cmd: "reset", payload: "all" } });
    await tick();
    expect(got).toEqual({ a: "reset", payload: "all" });
  });
});

describe("devtools adversarial — round 2", () => {
  test("dt.tab with an unknown panel id is a no-op", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "nope" } });
    expect(host.getActivePanel()).toBe("console");
  });

  test("REPL Enter on whitespace does not dispatch eval", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    let evals = 0;
    const orig = (host as any).backend.dispatch.bind((host as any).backend);
    (host as any).backend.dispatch = async (m: string, p?: any) => {
      if (m === "eval") evals++;
      return orig(m, p ?? {});
    };
    fake.fire({ t: "input", d: { dt: "repl" }, v: "   " });
    fake.fire({ t: "keydown", d: { dt: "repl" }, k: "Enter" });
    await tick();
    expect(evals).toBe(0);
  });

  test("REPL eval error surfaces as an error row", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    (host as any).backend.dispatch = async (m: string) =>
      m === "eval" ? { error: "ReferenceError: nope" } : undefined;
    fake.fire({ t: "input", d: { dt: "repl" }, v: "nope()" });
    fake.fire({ t: "keydown", d: { dt: "repl" }, k: "Enter" });
    await tick();
    bypassThrottle(host);
    host.update();
    const body = fake.inner("#dt-body");
    const err = body.includes("ReferenceError: nope")
      || fake.mutations.some((m) => m.value?.includes("ReferenceError: nope") || m.html?.includes("ReferenceError: nope"));
    expect(err).toBe(true);
  });

  test("console survives a numeric (non-string) text field", () => {
    const { host, fake } = makeHost();
    host.show();
    (host as any).backend.emit("console", { text: 42, severity: 1, thread: "main", ts: 0 });
    expect(() => host.update()).not.toThrow();
    const saw = fake.inner("#dt-body").includes("42")
      || fake.mutations.some((m) => m.value?.includes("42") || m.html?.includes("42"));
    expect(saw).toBe(true);
  });

  test("rapid alternating tab clicks leave a coherent active panel", async () => {
    const { host, fake } = makeHost();
    host.devtoolsMirror.registerProvider("game", () => ({ sections: [] }));
    host.show();
    host.update();
    for (const tab of ["elements", "gpu", "performance", "snap-game", "console", "elements", "gpu"]) {
      fake.fire({ t: "click", d: { action: "dt.tab", tab } });
    }
    await tick();
    bypassThrottle(host);
    expect(() => host.update()).not.toThrow();
    expect(host.getActivePanel()).toBe("gpu");
    // The active tab class in the strip agrees with the host's activeId.
    const tabs = fake.inner("#dt-tabs");
    expect(tabs).toContain('class="tab active" data-action="dt.tab" data-tab="gpu"');
  });

  test("a second pick while details are in flight wins the strip", async () => {
    (globalThis as any).__sceneInspector = {
      getNodeJSON: (id: string) => new Promise((r) => setTimeout(() => r(JSON.stringify({ id })), id === "model-1" ? 30 : 0)),
      selectNode: () => {},
    };
    const { surface, panel: fake } = fakeSurface();
    const host = new BlitzDevtoolsHost({
      ui: surface, renderer: {},
      surface: { clientWidth: 1280, clientHeight: 720 },
      gameScene: { stage: { label: "root", id: "root", children: [
        { label: "child-a", id: "model-1", children: [] },
        { label: "child-b", id: "model-2", children: [] },
      ] } },
    });
    host.start();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "elements" } });
    await tick();
    bypassThrottle(host);
    host.update();
    const rows = (host as any).panels.get("elements").rows;
    const a = rows.find((r: any) => r.label === "child-a");
    const b = rows.find((r: any) => r.label === "child-b");
    fake.fire({ t: "click", d: { action: "el.pick", node: String(a.id) } });
    fake.fire({ t: "click", d: { action: "el.pick", node: String(b.id) } });
    await new Promise((r) => setTimeout(r, 60));
    bypassThrottle(host);
    host.update();
    const bottom = fake.inner("#dt-bottom");
    expect(bottom).toContain("child-b");
    expect(bottom).toContain("model-2");
    expect(bottom).not.toContain("model-1");
  });

  test("mouse spam without a prior grip-down doesn't drag", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    const h0 = fake.rect.h;
    fake.fire({ t: "mouseup" });
    fake.fire({ t: "pointermove", y: 999 });
    expect(fake.rect.h).toBe(h0);
  });

  test("keydown/up on the doc without a dt tag doesn't reach REPL logic", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "keydown", k: "Enter" });
    fake.fire({ t: "keydown", k: "ArrowUp" });
    expect(() => host.update()).not.toThrow();
  });

  test("hide → show remounts and replays panel state", () => {
    const { host, fake } = makeHost();
    host.show();
    (host as any).backend.emit("console", { text: "before-hide", severity: 1, thread: "main", ts: 0 });
    host.update();
    host.hide();
    (host as any).backend.emit("console", { text: "while-hidden", severity: 1, thread: "main", ts: 0 });
    host.show();
    host.update();
    const body = fake.inner("#dt-body");
    const all = body + fake.mutations.map((m) => m.html ?? m.value ?? "").join("|");
    expect(all).toContain("before-hide");
    expect(all).toContain("while-hidden");
  });

  test("update() before start() is a no-op", () => {
    const { surface } = fakeSurface();
    const host = new BlitzDevtoolsHost({ ui: surface, renderer: {}, surface: { clientWidth: 800, clientHeight: 600 } });
    expect(() => { host.update(); host.show(); host.hide(); }).not.toThrow();
    expect(host.visible).toBe(false);
  });

  test("metrics push with malformed payload keeps the perf panel alive", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "performance" } });
    (host as any).backend.emit("metrics", "not-an-array");
    (host as any).backend.emit("metrics", [{ slotIndex: 0, name: "main", history: [{}] }]);
    (host as any).backend.emit("metrics", [{ slotIndex: 0, name: "main" }]);
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-body")).toContain("main");
    expect(fake.inner("#dt-body")).not.toContain("NaN");
  });

  test("a malformed profile payload renders a banner instead of crashing", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "performance" } });
    (host as any).backend.emit("profile", { nodes: "corrupted", startUs: 0, endUs: 5 });
    bypassThrottle(host);
    host.update();
    expect(fake.inner("#dt-body")).toContain("malformed profile");
  });

  test("gpu panel survives a malformed gpu push", () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "gpu" } });
    (host as any).backend.emit("gpu", { frameTimes: "oops", entries: { not: "array" } });
    (host as any).backend.emit("gpu", { frameTimes: [[4.2]], entries: [null, { key: "k", value: "v" }] });
    bypassThrottle(host);
    host.update();
    const body = fake.inner("#dt-body");
    expect(body).not.toContain("NaN");
    expect(body).toContain("v");
  });

  test("console falls back to full renders when incrementalDom is absent", () => {
    const { host, fake } = makeHost({ incrementalDom: false });
    host.show();
    host.update();
    fake.mutations.length = 0;
    for (let i = 0; i < 5; i++) {
      (host as any).backend.emit("console", { text: `r${i}`, severity: 1, thread: "main", ts: 0 });
    }
    bypassThrottle(host);
    host.update();
    expect(fake.mutations.some((m) => m.kind === "appendHtml")).toBe(false);
    expect(fake.inner("#dt-body")).toContain("r4");
  });

  test("perf.record without a CDP session fails soft and clears recording", async () => {
    const { host, fake } = makeHost();
    host.show();
    host.update();
    fake.fire({ t: "click", d: { action: "dt.tab", tab: "performance" } });
    (host as any).backend.dispatch = async (m: string) => {
      if (m === "profile.start") throw new Error("no cdp");
      return undefined;
    };
    fake.fire({ t: "click", d: { action: "perf.record" } });
    await tick();
    bypassThrottle(host);
    host.update();
    // Recording flag must roll back — the button shouldn't stick "recording".
    const panel = (host as any).panels.get("performance");
    expect(panel.recording).toBe(false);
  });
});
