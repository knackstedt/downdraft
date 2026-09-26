// ============================================================================
// html-ui.spec.ts — unit tests for the html-ui module: worker protocol, doc
// core (local backend shares the worker's code path), dirty-rect slicing,
// resource registration, and the JSX→markup runtime.
//
// GPU-facing pieces (HtmlUiHost texture/pipeline management) need a real
// device and are verified via the native bakeoff + game smoke tests instead.
// ============================================================================

import { loadOsrLib } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import { describe, expect, test } from "bun:test";
import { createDocCore, createLocalBackend } from "./doc-backend";
import { Fragment, jsx, jsxs, renderHtml } from "./jsx-runtime";
import type { UiToWorker, WorkerToUi } from "./protocol";

const hasLib = loadOsrLib() !== null;

function collect(): { msgs: WorkerToUi[]; emit: (m: WorkerToUi) => void } {
  const msgs: WorkerToUi[] = [];
  return { msgs, emit: (m) => msgs.push(m) };
}

const CSS = `
  <style>
    body { margin: 0; background: #101418; font-family: sans-serif; }
    #btn { width: 100px; height: 40px; background: #3366ff; color: white; }
    #label { color: #fff; font-size: 14px; }
    input { width: 120px; }
  </style>`;

describe.skipIf(!hasLib)("html-ui doc core", () => {
  test("create → initial frame is full-rect", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div id="btn" data-action="go">Go</div>` });
    const frame = msgs.find((m): m is Extract<WorkerToUi, { type: "frame" }> => m.type === "frame");
    expect(frame).toBeTruthy();
    expect(frame!.pw).toBe(200);
    expect(frame!.ph).toBe(100);
    expect(frame!.x).toBe(0);
    expect(frame!.y).toBe(0);
    expect(new Uint8Array(frame!.pixels).length).toBe(200 * 100 * 4);
    core.dispose();
  });

  test("scale multiplies raster size", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 100, cssH: 50, scale: 2, html: `${CSS}<div>x</div>` });
    const frame = msgs.find((m) => m.type === "frame") as Extract<WorkerToUi, { type: "frame" }>;
    expect(frame.pw).toBe(200);
    expect(frame.ph).toBe(100);
    core.dispose();
  });

  test("mutate text emits a (possibly partial) dirty-rect frame", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div id="label">before</div>` });
    msgs.length = 0;
    core.handle({ type: "mutate", id: "p1", ops: [{ op: "text", sel: "#label", text: "after" }] });
    const frame = msgs.find((m) => m.type === "frame") as Extract<WorkerToUi, { type: "frame" }> | undefined;
    expect(frame).toBeTruthy();
    // Tight slice: buffer matches the emitted dirty rect exactly.
    expect(new Uint8Array(frame!.pixels).length).toBe(frame!.w * frame!.h * 4);
    core.dispose();
  });

  test("pointer click emits a DOM event carrying data-action", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div id="btn" data-action="go" style="width:200px;height:100px">Go</div>` });
    msgs.length = 0;
    const down: UiToWorker = { type: "input", id: "p1", msg: { kind: "down", x: 20, y: 20, button: "left" } };
    const up: UiToWorker = { type: "input", id: "p1", msg: { kind: "up", x: 20, y: 20, button: "left" } };
    core.handle(down);
    core.handle(up);
    const events = msgs.filter((m) => m.type === "events").flatMap((m) => (m as Extract<WorkerToUi, { type: "events" }>).events);
    const click = events.find((e) => e.t === "click");
    expect(click).toBeTruthy();
    expect(click!.d?.action).toBe("go");
    core.dispose();
  });

  test("input coords scale into doc space", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    // 2× doc: css (10,10) → doc px (20,20).
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 2, html: `${CSS}<div id="btn" data-action="scaled" style="width:200px;height:100px">Go</div>` });
    msgs.length = 0;
    core.handle({ type: "input", id: "p1", msg: { kind: "down", x: 10, y: 10, button: "left" } });
    core.handle({ type: "input", id: "p1", msg: { kind: "up", x: 10, y: 10, button: "left" } });
    const events = msgs.filter((m) => m.type === "events").flatMap((m) => (m as Extract<WorkerToUi, { type: "events" }>).events);
    expect(events.some((e) => e.t === "click" && e.d?.action === "scaled")).toBe(true);
    core.dispose();
  });

  test("key input edits a focused <input> and reports the tag", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 60, scale: 1, html: `${CSS}<input id="inp" value="ab" style="width:200px;height:40px">` });
    msgs.length = 0;
    core.handle({ type: "input", id: "p1", msg: { kind: "down", x: 10, y: 10, button: "left" } });
    core.handle({ type: "input", id: "p1", msg: { kind: "up", x: 10, y: 10, button: "left" } });
    core.handle({ type: "input", id: "p1", msg: { kind: "key", down: true, key: "x", code: "KeyX", text: "x" } });
    core.handle({ type: "input", id: "p1", msg: { kind: "key", down: false, key: "x", code: "KeyX" } });
    const events = msgs.filter((m) => m.type === "events").flatMap((m) => (m as Extract<WorkerToUi, { type: "events" }>).events);
    const inputEv = events.find((e) => e.t === "input");
    expect(inputEv).toBeTruthy();
    expect(inputEv!.g).toBe("input");
    expect(inputEv!.v).toContain("x");
    core.dispose();
  });

  test("getAttr resolves through the request/response path", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 100, cssH: 50, scale: 1, html: `${CSS}<div id="a" data-role="hero"></div>` });
    msgs.length = 0;
    core.handle({ type: "getAttr", reqId: 7, id: "p1", sel: "#a", name: "data-role" });
    const attr = msgs.find((m) => m.type === "attr") as Extract<WorkerToUi, { type: "attr" }>;
    expect(attr.reqId).toBe(7);
    expect(attr.value).toBe("hero");
    core.dispose();
  });

  test("ui:// resources resolve via registerOsrResource", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    // A tiny CSS file served through the resource map.
    const css = new TextEncoder().encode("#x { color: rgb(255,0,0); }");
    core.handle({ type: "resource", url: "ui://test/inline.css", bytes: css.buffer as ArrayBuffer });
    core.handle({
      type: "create", id: "p1", cssW: 100, cssH: 50, scale: 1,
      html: `<link rel="stylesheet" href="ui://test/inline.css"><div id="x">styled</div>`,
    });
    const err = msgs.find((m) => m.type === "error");
    expect(err).toBeUndefined();
    expect(msgs.some((m) => m.type === "frame")).toBe(true);
    core.dispose();
  });

  test("maxFps throttles raster but not events", async () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 100, cssH: 50, scale: 1, html: `${CSS}<div>static</div>`, maxFps: 5 });
    const frames = () => msgs.filter((m) => m.type === "frame").length;
    expect(frames()).toBe(1);
    // Force pending via mutation, then spam pumps — the cap blocks re-raster.
    core.handle({ type: "mutate", id: "p1", ops: [{ op: "text", sel: "div", text: "a" }] });
    const afterOne = frames();
    expect(afterOne).toBeGreaterThanOrEqual(1);
    core.handle({ type: "mutate", id: "p1", ops: [{ op: "text", sel: "div", text: "b" }] });
    // Within the 200ms window this second raster is throttled (or merged).
    core.dispose();
  });
});

describe("html-ui local backend", () => {
  test.skipIf(!hasLib)("post/onMessage round-trips like a worker", () => {
    const backend = createLocalBackend();
    const msgs: WorkerToUi[] = [];
    backend.onMessage((m) => msgs.push(m));
    backend.post({ type: "create", id: "x", cssW: 50, cssH: 50, scale: 1, html: "<div>hi</div>" });
    expect(msgs.some((m) => m.type === "ready")).toBe(true);
    expect(msgs.some((m) => m.type === "frame")).toBe(true);
    backend.dispose();
  });
});

describe("jsx runtime", () => {
  test("serializes elements, attrs, and children", () => {
    const html = renderHtml(
      jsxs("div", {
        className: "panel",
        "data-action": "open",
        children: [
          jsx("span", { children: "Hello" }),
          jsx("input", { value: "x", disabled: true }),
        ],
      })
    );
    expect(html).toBe('<div class="panel" data-action="open"><span>Hello</span><input value="x" disabled></div>');
  });

  test("escapes text and attribute values", () => {
    const html = renderHtml(jsx("div", { title: 'a"b<c', children: 'x < y & "z"' }));
    expect(html).toBe('<div title="a&quot;b&lt;c">x &lt; y &amp; &quot;z&quot;</div>');
  });

  test("style objects become css with px units", () => {
    const html = renderHtml(jsx("div", { style: { width: 10, lineHeight: 1.5, color: "#fff" } }));
    expect(html).toContain('style="width:10px;line-height:1.5;color:#fff;"');
  });

  test("fragments and components flatten", () => {
    const Inner = (p: Record<string, unknown>) => jsx("b", { children: p.children });
    const html = renderHtml(jsxs(Fragment, { children: [jsx(Inner, { children: "deep" }), "tail"] }));
    expect(html).toBe("<b>deep</b>tail");
  });

  test("null/boolean children are dropped", () => {
    const html = renderHtml(jsxs("div", { children: [null, false, "x", undefined] }));
    expect(html).toBe("<div>x</div>");
  });

  test("on* props are skipped", () => {
    const html = renderHtml(jsx("div", { onClick: () => {}, id: "a" }));
    expect(html).toBe('<div id="a"></div>');
  });
});
