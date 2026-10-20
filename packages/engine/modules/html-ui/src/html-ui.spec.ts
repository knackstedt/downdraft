// ============================================================================
// html-ui.spec.ts — unit tests for the html-ui module: worker protocol, doc
// core (local backend shares the worker's code path), dirty-rect slicing,
// resource registration, and the JSX→markup runtime.
//
// GPU-facing pieces (HtmlUiHost texture/pipeline management) need a real
// device and are verified via the native bakeoff + game smoke tests instead.
// ============================================================================

import { loadOsrLib } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import type { RendererInputBus } from "@downdraft/engine/module/renderer-module";
import { describe, expect, test } from "bun:test";
import { createDocCore, createLocalBackend, type DocBackend, type DocGpuView } from "./doc-backend";
import { HtmlUiHost, type UiZoomKeysOptions } from "./host";
import { Fragment, jsx, jsxs, renderHtml } from "./jsx-runtime";
import type { UiToWorker, WorkerToUi } from "./protocol";

const hasLib = loadOsrLib() !== null;

function collect(): {
  msgs: WorkerToUi[];
  binds: Map<string, SharedArrayBuffer>;
  emit: (m: WorkerToUi) => void;
} {
  const msgs: WorkerToUi[] = [];
  // Tests wipe `msgs` between steps — bound buffers are tracked separately.
  const binds = new Map<string, SharedArrayBuffer>();
  return {
    msgs,
    binds,
    emit: (m) => {
      msgs.push(m);
      if (m.type === "bind") binds.set(m.id, m.buf);
    },
  };
}

type FrameMsg = Extract<WorkerToUi, { type: "frame" }>;

/** Resolve a frame's dirty-rect pixels — message payload (legacy path) or
 *  the bound SAB's aligned-stride rows (zero-copy path). */
function framePixels(
  binds: Map<string, SharedArrayBuffer>,
  frame: FrameMsg,
): Uint8Array {
  if (frame.pixels) return new Uint8Array(frame.pixels);
  const buf = binds.get(frame.id);
  if (!buf) throw new Error("frame carried neither pixels nor a bound SAB");
  const u8 = new Uint8Array(buf);
  const stride = frame.stride ?? frame.w * 4;
  const out = new Uint8Array(frame.w * frame.h * 4);
  for (let r = 0; r < frame.h; r++) {
    const src = 64 + (frame.y + r) * stride + frame.x * 4;
    out.set(u8.subarray(src, src + frame.w * 4), r * frame.w * 4);
  }
  return out;
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
    const { msgs, binds, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div id="btn" data-action="go">Go</div>` });
    const frame = msgs.find((m): m is Extract<WorkerToUi, { type: "frame" }> => m.type === "frame");
    expect(frame).toBeTruthy();
    expect(frame!.pw).toBe(200);
    expect(frame!.ph).toBe(100);
    expect(frame!.x).toBe(0);
    expect(frame!.y).toBe(0);
    expect(framePixels(binds, frame!).length).toBe(200 * 100 * 4);
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
    const { msgs, binds, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div id="label">before</div>` });
    msgs.length = 0;
    core.handle({ type: "mutate", id: "p1", ops: [{ op: "text", sel: "#label", text: "after" }] });
    const frame = msgs.find((m) => m.type === "frame") as Extract<WorkerToUi, { type: "frame" }> | undefined;
    expect(frame).toBeTruthy();
    // Tight slice: buffer matches the emitted dirty rect exactly.
    expect(framePixels(binds, frame!).length).toBe(frame!.w * frame!.h * 4);
    core.dispose();
  });

  test("SAB channel: bind message precedes seq-stamped frames", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div>x</div>` });
    const bind = msgs.find((m) => m.type === "bind");
    const frame = msgs.find((m): m is FrameMsg => m.type === "frame");
    expect(bind).toBeTruthy();
    // Zero-copy frames carry a seqlock sequence, not a pixel payload.
    expect(frame!.seq).toBeTruthy();
    expect(frame!.pixels).toBeUndefined();
    expect(frame!.stride! % 64).toBe(0);
    core.dispose();
  });

  test("pointer move over a style-free region emits no frame", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div>plain</div>` });
    msgs.length = 0;
    // No :hover rules anywhere — the doc requests no repaint for this move.
    for (let i = 0; i < 5; i++) {
      core.handle({ type: "input", id: "p1", msg: { kind: "move", x: 10 + i, y: 10 } });
    }
    expect(msgs.some((m) => m.type === "frame")).toBe(false);
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

  test("mouse events carry pointer coords (scrollbar drags depend on them)", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 100, scale: 1, html: `${CSS}<div id="thumb" style="position:absolute;left:180px;top:0;width:20px;height:40px"></div>` });
    msgs.length = 0;
    core.handle({ type: "input", id: "p1", msg: { kind: "down", x: 190, y: 10, button: "left" } });
    core.handle({ type: "input", id: "p1", msg: { kind: "move", x: 190, y: 30 } });
    core.handle({ type: "input", id: "p1", msg: { kind: "up", x: 190, y: 30, button: "left" } });
    const events = msgs.filter((m) => m.type === "events").flatMap((m) => (m as Extract<WorkerToUi, { type: "events" }>).events);
    const down = events.find((e) => e.t === "mousedown");
    const move = events.find((e) => e.t === "pointermove");
    const up = events.find((e) => e.t === "mouseup");
    expect(down).toBeTruthy();
    expect(down!.id).toBe("thumb");
    expect(down!.x).toBe(190);
    expect(down!.y).toBe(10);
    expect(move).toBeTruthy();
    expect(move!.y).toBe(30);
    expect(up!.x).toBe(190);
    expect(up!.y).toBe(30);
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

  const TALL = `<div class="s" style="width:200px;height:200px;overflow-y:scroll">${'<div style="height:40px"></div>'.repeat(50)}</div>`;
  const scrollTops = (msgs: WorkerToUi[]) =>
    msgs.filter((m) => m.type === "events")
      .flatMap((m) => (m as Extract<WorkerToUi, { type: "events" }>).events)
      .filter((e) => e.t === "scroll")
      .map((e) => e.st ?? 0);

  test("wheel scrolls the hovered scrollport and emits scroll events", () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 200, scale: 1, html: `${CSS}${TALL}` });
    core.handle({ type: "input", id: "p1", msg: { kind: "move", x: 100, y: 100 } });
    msgs.length = 0;
    core.handle({ type: "input", id: "p1", msg: { kind: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 100 } });
    const sts = scrollTops(msgs);
    // Instant path: the full detent lands in one step.
    expect(sts).toEqual([100]);
    core.dispose();
  });

  test("smoothWheel eases wheel deltas out across pump ticks", async () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit);
    core.handle({ type: "create", id: "p1", cssW: 200, cssH: 200, scale: 1, html: `${CSS}${TALL}`, smoothWheel: true });
    core.handle({ type: "input", id: "p1", msg: { kind: "move", x: 100, y: 100 } });
    msgs.length = 0;
    core.handle({ type: "input", id: "p1", msg: { kind: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 100 } });
    // The first tick applies an eased fraction, not the full 100px jump.
    const first = scrollTops(msgs);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0]!).toBeGreaterThan(0);
    expect(first[0]!).toBeLessThan(50);
    // The remainder drains on the pump timer and converges on the full delta.
    await new Promise((r) => setTimeout(r, 400));
    const all = scrollTops(msgs);
    expect(all.length).toBeGreaterThan(3);
    expect(Math.abs(all.at(-1)! - 100)).toBeLessThan(1);
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

describe.skipIf(!hasLib)("html-ui gpu-direct", () => {
  const GPU_HANDLE = { devicePtr: 1n, instancePtr: 1n, queuePtr: 1n, generation: 1 };

  function fakeView(writes: unknown[][]): { view: DocGpuView; alive: { v: boolean } } {
    const alive = { v: true };
    return {
      alive,
      view: {
        queue: { writeTexture: (...args: unknown[]) => { writes.push(args); } },
        isValid: () => alive.v,
        detach: () => { alive.v = false; },
      },
    };
  }

  // gpuAttach resolves through a promise chain — flush it before asserting.
  const flush = () => Promise.resolve().then(() => Promise.resolve());

  test("gpuAttach + texBind routes frames through the view's writeTexture", async () => {
    const { msgs, emit } = collect();
    const writes: unknown[][] = [];
    const { view } = fakeView(writes);
    const fakeTex = { tag: "borrowed" };
    const borrows: { ptr: unknown; meta: unknown }[] = [];
    const core = createDocCore(emit, {
      attach: async () => ({
        view,
        borrowTexture: (ptr, meta) => { borrows.push({ ptr, meta }); return fakeTex; },
      }),
    });
    core.handle({ type: "gpuAttach", gpu: GPU_HANDLE, cells: new SharedArrayBuffer(32) });
    await flush();
    expect(msgs.some((m) => m.type === "gpuReady" && m.ok)).toBe(true);

    msgs.length = 0;
    core.handle({ type: "create", id: "p1", cssW: 100, cssH: 50, scale: 1, html: `${CSS}<div>x</div>` });
    // The SAB is the raster scratch AND the host's instant fallback — the
    // bind always goes out (informational: no gpuFallback flag).
    expect(msgs.some((m) => m.type === "bind" && m.gpuFallback !== true)).toBe(true);

    core.handle({ type: "texBind", id: "p1", texPtr: 7n, w: 100, h: 50, format: "rgba8unorm" });
    expect(borrows.length).toBe(1);
    expect(borrows[0]!.ptr).toBe(7n);
    // texBind refreshInto() pushes retained pixels into the new texture.
    expect(writes.length).toBe(1);
    const [dest, data, layout, size] = writes[0]! as [
      { texture: unknown; origin: number[] },
      unknown,
      { offset: number; bytesPerRow: number },
      { width: number; height: number },
    ];
    expect(dest.texture).toBe(fakeTex);
    expect(dest.origin).toEqual([0, 0, 0]);
    expect(data).toBeInstanceOf(SharedArrayBuffer);
    expect(layout.offset).toBe(64); // 64-byte header, full-frame rect at (0,0)
    expect(size.width).toBe(100);
    expect(size.height).toBe(50);
    expect(msgs.some((m) => m.type === "frame" && m.gpu === true && m.texPtr === 7n)).toBe(true);

    // A repaint writes through the view again — no pixels/SAB on the message.
    msgs.length = 0;
    core.handle({ type: "mutate", id: "p1", ops: [{ op: "text", sel: "div", text: "y" }] });
    const frame = msgs.find((m): m is FrameMsg => m.type === "frame");
    expect(frame).toBeTruthy();
    expect(frame!.gpu).toBe(true);
    expect(frame!.texPtr).toBe(7n);
    expect(frame!.pixels).toBeUndefined();
    expect(frame!.seq).toBeUndefined();
    expect(writes.length).toBe(2);
    core.dispose();
  });

  test("raster-dims mismatch drops the borrow and re-arms SAB (resize race)", async () => {
    const { msgs, emit } = collect();
    const writes: unknown[][] = [];
    const { view } = fakeView(writes);
    const core = createDocCore(emit, {
      attach: async () => ({ view, borrowTexture: () => ({}) }),
    });
    core.handle({ type: "gpuAttach", gpu: GPU_HANDLE, cells: new SharedArrayBuffer(32) });
    await flush();
    core.handle({ type: "create", id: "p1", cssW: 100, cssH: 50, scale: 1, html: `${CSS}<div>x</div>` });
    core.handle({ type: "texBind", id: "p1", texPtr: 5n, w: 100, h: 50, format: "rgba8unorm" });
    expect(writes.length).toBe(1);

    // The doc resizes before the new texBind lands — writing the bigger
    // raster into the 100×50 bound texture would overrun (wgpu drops it
    // silently), so emitFrame must fall back instead.
    msgs.length = 0;
    core.handle({ type: "resize", id: "p1", cssW: 200, cssH: 100, scale: 1 });
    expect(msgs.some((m) => m.type === "texAck" && m.texPtr === 5n)).toBe(true);
    expect(msgs.some((m) => m.type === "bind" && m.gpuFallback === true)).toBe(true);
    expect(msgs.some((m) => m.type === "frame" && m.seq !== undefined && !m.gpu)).toBe(true);
    expect(writes.length).toBe(1); // no write into the mismatched texture

    // The new-dims texBind reconverges: the borrow was already dropped (no
    // texAck this time), and frames go GPU-direct again.
    msgs.length = 0;
    core.handle({ type: "texBind", id: "p1", texPtr: 6n, w: 200, h: 100, format: "rgba8unorm" });
    expect(msgs.some((m) => m.type === "texAck")).toBe(false);
    expect(msgs.some((m) => m.type === "frame" && m.gpu === true && m.texPtr === 6n)).toBe(true);
    core.dispose();
  });

  test("gpuAttach failure reports gpuReady:false and keeps SAB delivery", async () => {
    const { msgs, emit } = collect();
    const core = createDocCore(emit, { attach: async () => null });
    core.handle({ type: "gpuAttach", gpu: GPU_HANDLE, cells: new SharedArrayBuffer(32) });
    await flush();
    expect(msgs.some((m) => m.type === "gpuReady" && !m.ok)).toBe(true);
    msgs.length = 0;
    core.handle({ type: "create", id: "p1", cssW: 50, cssH: 50, scale: 1, html: "<div>x</div>" });
    expect(msgs.some((m) => m.type === "bind")).toBe(true);
    expect(msgs.some((m) => m.type === "frame" && m.seq !== undefined)).toBe(true);
    core.dispose();
  });

  test("a dead view drops the borrow and re-arms SAB delivery", async () => {
    const { msgs, emit } = collect();
    const writes: unknown[][] = [];
    const { view, alive } = fakeView(writes);
    const core = createDocCore(emit, {
      attach: async () => ({ view, borrowTexture: () => ({}) }),
    });
    core.handle({ type: "gpuAttach", gpu: GPU_HANDLE, cells: new SharedArrayBuffer(32) });
    await flush();
    core.handle({ type: "create", id: "p1", cssW: 100, cssH: 50, scale: 1, html: `${CSS}<div>x</div>` });
    core.handle({ type: "texBind", id: "p1", texPtr: 9n, w: 100, h: 50, format: "rgba8unorm" });

    alive.v = false; // device lost / view invalidated
    msgs.length = 0;
    core.handle({ type: "mutate", id: "p1", ops: [{ op: "text", sel: "div", text: "z" }] });
    // The dropped borrow is acked, the host's SAB channel re-arms, and the
    // frame goes out as a seq-stamped SAB header.
    expect(msgs.some((m) => m.type === "texAck" && m.texPtr === 9n)).toBe(true);
    expect(msgs.some((m) => m.type === "bind" && m.gpuFallback === true)).toBe(true);
    expect(msgs.some((m) => m.type === "frame" && m.seq !== undefined && !m.gpu)).toBe(true);
    core.dispose();
  });

  test("texBind rebind acks the previous texture", async () => {
    const { msgs, emit } = collect();
    const writes: unknown[][] = [];
    const { view } = fakeView(writes);
    const core = createDocCore(emit, {
      attach: async () => ({ view, borrowTexture: () => ({}) }),
    });
    core.handle({ type: "gpuAttach", gpu: GPU_HANDLE, cells: new SharedArrayBuffer(32) });
    await flush();
    core.handle({ type: "create", id: "p1", cssW: 100, cssH: 50, scale: 1, html: "<div>x</div>" });
    core.handle({ type: "texBind", id: "p1", texPtr: 1n, w: 100, h: 50, format: "rgba8unorm" });
    msgs.length = 0;
    core.handle({ type: "texBind", id: "p1", texPtr: 2n, w: 200, h: 100, format: "rgba8unorm" });
    expect(msgs.some((m) => m.type === "texAck" && m.texPtr === 1n)).toBe(true);
    core.dispose();
  });

  test("gpuDetach drops the view and acks", async () => {
    const { msgs, emit } = collect();
    const { view, alive } = fakeView([]);
    const core = createDocCore(emit, {
      attach: async () => ({ view, borrowTexture: () => ({}) }),
    });
    core.handle({ type: "gpuAttach", gpu: GPU_HANDLE, cells: new SharedArrayBuffer(32) });
    await flush();
    core.handle({ type: "gpuDetach" });
    expect(msgs.some((m) => m.type === "gpuDetached")).toBe(true);
    expect(alive.v).toBe(false);
    core.dispose();
  });
});

function fakeGpuDevice(): GPUDevice {
  (globalThis as { GPUShaderStage?: unknown }).GPUShaderStage ??=
    { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  return {
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createSampler: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBuffer: () => ({}),
    createBindGroup: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
    queue: { writeTexture() {}, writeBuffer() {}, copyExternalImageToTexture() {} },
  } as unknown as GPUDevice;
}

function fakeHost(opts?: { zoomKeys?: boolean | UiZoomKeysOptions }): { host: HtmlUiHost; msgs: UiToWorker[] } {
  const msgs: UiToWorker[] = [];
  const backend: DocBackend = {
    kind: "local",
    post: (m) => { msgs.push(m); },
    onMessage: () => {},
    dispose: () => {},
  };
  return { host: new HtmlUiHost(fakeGpuDevice(), "rgba8unorm", backend, opts), msgs };
}

/** Input-bus stub: captures onKeyDown/onPointerDown handlers and replays
 *  events in priority order honoring stopPropagation (lower p runs first). */
function fakeInputBus() {
  type KeyFn = (e: KeyboardEvent, c: { stopPropagation(): void }) => void;
  type PtrFn = (e: PointerEvent, c: { stopPropagation(): void }) => void;
  const keys: { fn: KeyFn; p: number }[] = [];
  const ptrDowns: { fn: PtrFn; p: number }[] = [];
  const bus = {
    onPointerMove: () => () => {},
    onPointerDown: (fn: PtrFn, p = 0) => { ptrDowns.push({ fn, p }); return () => {}; },
    onPointerUp: () => () => {},
    onWheel: () => () => {},
    onKeyDown: (fn: KeyFn, p = 0) => { keys.push({ fn, p }); return () => {}; },
    onKeyUp: () => () => {},
    onDrag: () => () => {},
  } as unknown as RendererInputBus;
  const dispatch = <E>(handlers: { fn: (e: E, c: { stopPropagation(): void }) => void; p: number }[], e: E) => {
    let stopped = false, calls = 0;
    const ctrl = { stopPropagation: () => { stopped = true; } };
    [...handlers].sort((a, b) => a.p - b.p).forEach((h) => {
      if (stopped) return;
      calls++;
      h.fn(e, ctrl);
    });
    return { stopped, calls };
  };
  return {
    bus,
    keyDown: (e: Partial<KeyboardEvent>) => dispatch(keys, e as KeyboardEvent),
    pointerDown: (e: Partial<PointerEvent>) => dispatch(ptrDowns, e as PointerEvent),
  };
}

describe("html-ui host surface-fit", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("fit panel: rect tracks immediately, doc relayout is deferred", async () => {
    const { host, msgs } = fakeHost();
    const panel = host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>", fit: { debounceMs: 30 } });
    msgs.length = 0;
    host.setSurfaceSize(200, 100, 2);
    // The quad follows right away — the surface never shows uncovered area.
    expect(panel.rect).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(msgs.some((m) => m.type === "resize")).toBe(false);
    await sleep(60);
    const rs = msgs.find((m) => m.type === "resize") as Extract<UiToWorker, { type: "resize" }> | undefined;
    expect(rs).toBeTruthy();
    // Doc layout stays in CSS px (buffer/zoom); raster scale = scale×zoom.
    expect(rs!.cssW).toBe(100);
    expect(rs!.cssH).toBe(50);
    expect(rs!.scale).toBe(2);
    host.dispose();
  });

  test("debounce coalesces a resize storm into one relayout", async () => {
    const { host, msgs } = fakeHost();
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>", fit: { debounceMs: 30 } });
    msgs.length = 0;
    host.setSurfaceSize(200, 100, 2);
    host.setSurfaceSize(220, 110, 2);
    host.setSurfaceSize(240, 120, 2);
    await sleep(60);
    const resizes = msgs.filter((m) => m.type === "resize") as Extract<UiToWorker, { type: "resize" }>[];
    expect(resizes.length).toBe(1);
    expect(resizes[0]!.cssW).toBe(120);
    host.dispose();
  });

  test("fit:true relayouts immediately (debounceMs 0)", () => {
    const { host, msgs } = fakeHost();
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>", fit: true });
    msgs.length = 0;
    host.setSurfaceSize(200, 100, 2);
    const rs = msgs.find((m) => m.type === "resize") as Extract<UiToWorker, { type: "resize" }> | undefined;
    expect(rs).toBeTruthy();
    expect(rs!.cssW).toBe(100);
    host.dispose();
  });

  test("non-fit panels ignore setSurfaceSize", () => {
    const { host, msgs } = fakeHost();
    const panel = host.mount({ id: "p", rect: { x: 10, y: 10, w: 100, h: 50 }, scale: 1, html: "<div/>" });
    msgs.length = 0;
    host.setSurfaceSize(200, 100, 2);
    expect(panel.rect).toEqual({ x: 10, y: 10, w: 100, h: 50 });
    expect(msgs.some((m) => m.type === "resize")).toBe(false);
    host.dispose();
  });

  test("same dims + same zoom is a no-op (no doc resize)", () => {
    const { host, msgs } = fakeHost();
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 200, h: 100 }, scale: 1, html: "<div/>", fit: true });
    msgs.length = 0;
    host.setSurfaceSize(200, 100, 1); // same rect + same zoom → skip
    expect(msgs.some((m) => m.type === "resize")).toBe(false);
    host.dispose();
  });
});

describe("html-ui host zoom keys", () => {
  const resizes = (msgs: UiToWorker[]) =>
    msgs.filter((m): m is Extract<UiToWorker, { type: "resize" }> => m.type === "resize");

  test("off by default — Ctrl+= is not consumed", () => {
    const { host, msgs } = fakeHost();
    const { bus, keyDown } = fakeInputBus();
    host.bindInput(bus);
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>" });
    msgs.length = 0;
    const r = keyDown({ key: "=", code: "Equal", ctrlKey: true });
    expect(r.stopped).toBe(false);
    expect(host.uiZoom).toBe(1);
    expect(resizes(msgs).length).toBe(0);
    host.dispose();
  });

  test("Ctrl+= steps the shared zoom and relayouts every panel", () => {
    const { host, msgs } = fakeHost({ zoomKeys: true });
    const { bus, keyDown } = fakeInputBus();
    host.bindInput(bus);
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>" });
    msgs.length = 0;
    const r = keyDown({ key: "=", code: "Equal", ctrlKey: true });
    expect(r.stopped).toBe(true); // consumed before panels/docs see it
    expect(host.uiZoom).toBeCloseTo(1.25);
    const rs = resizes(msgs);
    expect(rs.length).toBe(1);
    // Doc lays out at rect/zoom CSS px; raster scale = panel scale × eff zoom.
    expect(rs[0]!.cssW).toBeCloseTo(80);
    expect(rs[0]!.cssH).toBeCloseTo(40);
    expect(rs[0]!.scale).toBeCloseTo(1.25);
    host.dispose();
  });

  test("Ctrl+- zooms out, Ctrl+0 resets, keys match key and code", () => {
    const { host, msgs } = fakeHost({ zoomKeys: true });
    const { bus, keyDown } = fakeInputBus();
    host.bindInput(bus);
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>" });
    keyDown({ key: "-", code: "Minus", ctrlKey: true });
    expect(host.uiZoom).toBeCloseTo(1 / 1.25);
    // Numpad variants hit the same paths (code-based match).
    keyDown({ key: "+", code: "NumpadAdd", ctrlKey: true });
    expect(host.uiZoom).toBeCloseTo(1);
    keyDown({ key: "=", code: "Equal", ctrlKey: true });
    keyDown({ key: "=", code: "Equal", ctrlKey: true });
    expect(host.uiZoom).toBeCloseTo(1.25 * 1.25);
    keyDown({ key: "0", code: "Digit0", ctrlKey: true });
    expect(host.uiZoom).toBe(1);
    host.dispose();
  });

  test("bounds clamp and plain keys without ctrl are ignored", () => {
    const { host } = fakeHost({ zoomKeys: { min: 0.5, max: 2 } });
    const { bus, keyDown } = fakeInputBus();
    host.bindInput(bus);
    host.setUiZoom(100);
    expect(host.uiZoom).toBe(2);
    host.setUiZoom(0.01);
    expect(host.uiZoom).toBe(0.5);
    const r = keyDown({ key: "=", code: "Equal" }); // no ctrl — not a zoom key
    expect(r.stopped).toBe(false);
    expect(host.uiZoom).toBe(0.5);
    // Ctrl+Alt is left alone too (AltGr-style chords belong to the doc).
    const r2 = keyDown({ key: "=", code: "Equal", ctrlKey: true, altKey: true });
    expect(r2.stopped).toBe(false);
    host.dispose();
  });

  test("app zoom composes with a fit panel's surface zoom", () => {
    const { host, msgs } = fakeHost({ zoomKeys: true });
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>", fit: true });
    host.setSurfaceSize(200, 100, 2); // surface dpr 2
    msgs.length = 0;
    host.setUiZoom(2);
    const rs = resizes(msgs);
    expect(rs.length).toBe(1);
    // eff zoom = surface 2 × app 2 → doc lays out at 200/4 = 50 CSS px wide.
    expect(rs[0]!.cssW).toBeCloseTo(50);
    expect(rs[0]!.scale).toBeCloseTo(4);
    // A later surface resize keeps the app zoom — setSurfaceSize only
    // rewrites the base zoom, the multiplier survives.
    msgs.length = 0;
    host.setSurfaceSize(300, 150, 2);
    const rs2 = resizes(msgs);
    expect(rs2[0]!.cssW).toBeCloseTo(75);
    host.dispose();
  });

  test("pointer input converts through the effective zoom", () => {
    const { host, msgs } = fakeHost({ zoomKeys: true });
    const { bus, pointerDown } = fakeInputBus();
    host.bindInput(bus);
    host.mount({ id: "p", rect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, html: "<div/>" });
    host.setUiZoom(2);
    msgs.length = 0;
    pointerDown({ clientX: 40, clientY: 20, button: 0 } as Partial<PointerEvent>);
    const down = msgs.find((m) => m.type === "input" && m.msg.kind === "down") as
      Extract<UiToWorker, { type: "input" }> | undefined;
    expect(down).toBeTruthy();
    expect((down!.msg as { x: number }).x).toBeCloseTo(20);
    expect((down!.msg as { y: number }).y).toBeCloseTo(10);
    host.dispose();
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
