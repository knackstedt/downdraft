// ============================================================================
// host.ts — HtmlUiHost: main-thread owner of the html-ui system.
//
// Owns the doc backend (worker or local fallback), per-panel GPU textures,
// dirty-rect uploads, event dispatch, and input routing. Compositing itself is
// done by PanelBlitPass via the compositor object exposed by `compositor`.
// ============================================================================

import type { OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import type { InputEventControl, RendererInputBus } from "@downdraft/engine/module/renderer-module";
import { getHostCapabilities, getNativeHost } from "@downdraft/engine/platform/runtime";
import { createLogger } from "@downdraft/engine/util/logger";
import { PanelBlitPass } from "./composite";
import { createLocalBackend, createWorkerBackend, type DocBackend } from "./doc-backend";
import type { DocInputMsg, DocMutation, NavNodeInfo, UiPointerMsg, WorkerToUi } from "./protocol";

const log = createLogger("info");

export interface PanelRect { x: number; y: number; w: number; h: number }

export interface PanelSpec {
  /** Stable id — defaults to `panel-N`. */
  id?: string;
  /** Screen-space rect in CSS px. */
  rect: PanelRect;
  /** Doc layout height when it differs from `rect.h` — the panel then
   *  displays a `src` sub-region of a taller texture (scrollable views that
   *  scroll via `setSrcRect` without any doc repaint). */
  docH?: number;
  /** Paint order — higher draws later (on top). Default: insertion order. */
  z?: number;
  /** Supersample factor (raster size = rect * scale). Default 2 — crisper text. */
  scale?: number;
  /** UI zoom — the doc is laid out at `rect/zoom` CSS px so everything renders
   *  `zoom`× larger on screen. `scale` stays relative to display px: pair
   *  `zoom` with `scale:1` for a native-res raster (hardest edges) or the
   *  default `scale:2` for supersampled text. Doc-space coords (events,
   *  getRect, navSnapshot) stay in layout CSS px — multiply by `zoom` for
   *  display px. Pointer input is converted automatically. Default 1. */
  zoom?: number;
  /** Raster-rate cap for animating docs (0 = uncapped). Static docs repaint on demand regardless. */
  maxFps?: number;
  /** Initial markup (or `vdom` rendered beforehand by the caller). */
  html: string;
  /** When false the panel never receives pointer input and `panelAt` skips
   *  it — overlay/cursor/HUD layers that must not eat clicks. Default true. */
  interactive?: boolean;
  /** Per-panel DOM event hook — receives events whose target is in this doc. */
  onEvent?: (ev: OsrDomEvent) => void;
}

export type PanelEventHandler = (ev: OsrDomEvent) => void;
export type PanelActionHandler = (data: Record<string, string>, ev: OsrDomEvent) => void;

interface Panel {
  id: string;
  spec: PanelSpec;
  rect: PanelRect;
  z: number;
  /** Raster px per display px (PanelSpec.scale). */
  scale: number;
  /** Display px per CSS px (PanelSpec.zoom). */
  zoom: number;
  /** Doc layout height when it differs from rect.h (scrollable texture). */
  docH: number | null;
  /** Texture sub-region in texel px — displayed at `rect` (GPU scroll). */
  src: { x: number; y: number; w: number; h: number } | null;
  texture: GPUTexture | null;
  texW: number;
  texH: number;
  ubo: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  handlers: Set<PanelEventHandler>;
  /** True while an editable element (<input>/<textarea>) holds DOM focus. */
  editing: boolean;
  /** Bound SAB frame channel — frames arrive as headers, pixels stay shared. */
  sab: SharedArrayBuffer | null;
  sabI32: Int32Array | null;
  /** Seq of the buffer state at the last SAB upload + the rect it covered.
   *  Dedupes poll uploads and stale "frame" messages: a message is a no-op
   *  when a newer-or-equal upload already covered its rect. */
  lastSeq: number;
  lastRect: { x: number; y: number; w: number; h: number } | null;
  /** True once the worker has demonstrably written the CURRENT texture —
   *  set when a gpu:true frame's texPtr matches the displayed texture, and
   *  cleared on SAB fallback (gpuFallback bind) or a stale-target frame.
   *  While false the host uploads SAB frames itself — the doc's raster
   *  scratch SAB is always current, so fallback needs no negotiation. */
  gpuBound: boolean;
  /** The texPtr the worker is confirmed to be writing — keeps retired
   *  textures alive until the worker drops its borrow (texAck). */
  boundPtr: bigint | null;
  /** The texPtr of the last texBind posted — suppresses duplicate posts
   *  and keeps the target alive while the bind may still be in flight. */
  postedBindPtr: bigint | null;
}

const UI_TRACE = typeof process !== "undefined" && !!process.env?.DD_UI_TRACE;

/** Per-doc raster/upload stats — surfaced on globalThis.__ddUiStats. */
export interface UiDocStats {
  frames: number;
  resolveMs: number;
  paintMs: number;
  diffMs: number;
  bytes: number;
  at: number;
}

export interface UiPanelHandle {
  readonly id: string;
  /** Current screen-space rect (CSS px) — a snapshot copy. */
  readonly rect: PanelRect;
  setHtml(html: string): void;
  setText(target: number | string, text: string): void;
  setAttr(target: number | string, name: string, value: string): void;
  removeAttr(target: number | string, name: string): void;
  setStyle(target: number | string, prop: string, value: string): void;
  setInnerHtml(target: number | string, html: string): void;
  /** Append parsed HTML as the node's last children (`innerHTML +=`) —
   *  existing children survive. No-op when the cdylib predates
   *  dd_osr_append_html — check `HtmlUiHost.docCaps.incrementalDom`. */
  appendHtml(target: number | string, html: string): void;
  /** Drop all but the last `keep` children of `target`. */
  trimChildren(target: number | string, keep: number): void;
  /** Apply multiple DOM mutations in one backend pass — a single relayout. */
  mutate(ops: DocMutation[]): void;
  focus(target?: number | string): void;
  setMaxFps(maxFps: number): void;
  setRect(rect: PanelRect): void;
  /** Resize the doc's layout height without moving the display rect —
   *  pair with `setSrcRect` for scroll views rasterized at full content
   *  height. */
  setDocHeight(h: number): void;
  /** Set the texture sub-region (texel px) drawn at `rect`, or null for the
   *  full texture. Pure compositor state — no doc repaint, so this is the
   *  cheap per-frame scroll path. */
  setSrcRect(src: { x: number; y: number; w: number; h: number } | null): void;
  setZ(z: number): void;
  /** Toggle pointer-input eligibility at runtime — `panelAt` skips
   *  non-interactive panels. HUD strips use this to stop eating clicks
   *  while the game holds pointer lock. */
  setInteractive(on: boolean): void;
  onEvent(fn: PanelEventHandler): () => void;
  getAttr(target: number | string, name: string): Promise<string | null>;
  /** Border-box rect in panel-local CSS px (same space as event x/y). */
  getRect(target: number | string): Promise<{ x: number; y: number; w: number; h: number } | null>;
  /** CSS selector → all matching node handles (re-query after structural edits). */
  queryAll(selector: string): Promise<number[]>;
  /** Batched rect lookup for a node set — one backend roundtrip. */
  getRects(nodes: number[]): Promise<({ x: number; y: number; w: number; h: number } | null)[]>;
  /** Currently-focused node handle (0 = none). */
  focusedNode(): Promise<number>;
  /** Scroll the doc so `target` is visible. */
  scrollIntoView(target: number | string, opts?: { smooth?: boolean; vertical?: "start" | "center" | "end" | "nearest"; horizontal?: "start" | "center" | "end" | "nearest" }): void;
  /** Scroll a scroll-container node to absolute offsets — reaches nested
   *  scrollports (scrollIntoView only moves the root viewport). */
  scrollTo(target: number | string, x: number, y: number, smooth?: boolean): void;
  /** Snapshot every node matching `sel` with rect/zone/disabled/editable —
   *  the nav engine's focusable enumeration. */
  navSnapshot(selector: string): Promise<NavNodeInfo[]>;
  /** Synthetic click on a node (real pointer down/up at its rect center). */
  click(target: number | string): void;
  /** Inject a key event into the doc (OSK/virtual-keyboard path).
   *  `key`/`code` are W3C UI-Events strings; `text` inserts into inputs. */
  sendKey(down: boolean, key: string, opts?: { code?: string; text?: string; mods?: string[] }): void;
  /** Inject a pointer event in panel-local CSS px (virtual-cursor path).
   *  Move messages are coalesced like real pointer input. */
  sendPointer(msg: UiPointerMsg): void;
  dispose(): void;
}

export class HtmlUiHost {
  private backend: DocBackend;
  private panels = new Map<string, Panel>();
  private order: string[] = []; // insertion order, stable tiebreaker
  private nextId = 0;
  private nextReqId = 1;
  private attrReqs = new Map<number, (v: string | null) => void>();
  private rectReqs = new Map<number, (v: { x: number; y: number; w: number; h: number } | null) => void>();
  private nodesReqs = new Map<number, (v: number[]) => void>();
  private rectsReqs = new Map<number, (v: ({ x: number; y: number; w: number; h: number } | null)[]) => void>();
  private focusedReqs = new Map<number, (v: number) => void>();
  private navReqs = new Map<number, (v: NavNodeInfo[]) => void>();
  private actionHandlers = new Map<string, Set<PanelActionHandler>>();
  private unsubInput: Array<() => void> = [];
  private focusedPanel: string | null = null;
  private pointerPos = { x: -1, y: -1 };
  /** Doc-backend capabilities from the `ready` handshake — e.g. whether the
   *  loaded cdylib supports appendHtml/trimChildren. */
  private caps = { incrementalDom: false };

  readonly blit: PanelBlitPass;

  constructor(
    private device: GPUDevice,
    format: GPUTextureFormat,
    backend?: DocBackend,
    opts?: {
      /** ProfilingSAB slot tag for this host's ui worker. */
      profilingTag?: string;
      /** Upload panels via the worker's shared-device view (native only).
       *  Default true; false forces the SAB upload path. */
      gpuUpload?: boolean;
    },
  ) {
    this.blit = new PanelBlitPass(device, format);
    this.backend = backend ?? HtmlUiHost.spawnWorker() ?? createLocalBackend();
    this.backend.onMessage((m) => this.handleMessage(m));
    this.profilingTag = opts?.profilingTag ?? "ui";
    this.gpuUpload = opts?.gpuUpload !== false
      && !(typeof process !== "undefined" && process.env?.DOWNDRAFT_NO_UI_GPU === "1");
    // The doc-backend story isn't settled while a gpu-direct upgrade is
    // still possible — the gpuReady ack logs the final form at info.
    const gpuDirectPossible = this.gpuUpload
      && this.backend.kind === "worker"
      && getHostCapabilities().supportsMultiWorkerGpu;
    log[gpuDirectPossible ? "debug" : "info"]("html-ui", `doc backend: ${this.backend.kind}`);
    this.attachProfiling();
    this.attachGpu();
  }

  private profilingTag = "ui";
  private profilingSent = false;

  // ── GPU-direct upload ──
  // The ui worker attaches to the host's shared wgpu device (one attach per
  // worker, all docs share it) and borrows each panel's texture by ptr —
  // uploads become the worker's queue.writeTexture calls instead of ours.
  private gpuUpload = true;
  private gpuAttachSent = false;
  private gpuReady = false;
  private gpuDetachAcked = false;
  private terminating = false;
  /** Textures retired while still possibly borrowed by the worker —
   *  destroyed on texAck or a fallback timer (whichever lands first). */
  private retiredTex = new Map<bigint, { tex: GPUTexture; timer: ReturnType<typeof setTimeout> }>();

  /** Hand the worker the shared-device attach payload. Retried from mount()
   *  — like the profiling bridge, the native host may postdate the ctor. */
  private attachGpu(): void {
    if (this.gpuAttachSent || !this.gpuUpload || this.backend.kind !== "worker") return;
    if (!getHostCapabilities().supportsMultiWorkerGpu) return;
    const payload = getNativeHost()?.gpuShare?.payload?.();
    if (!payload) return;
    this.gpuAttachSent = true;
    this.send({
      type: "gpuAttach",
      gpu: payload.gpu as { devicePtr: number | bigint; instancePtr: number | bigint; queuePtr: number | bigint; generation: number },
      cells: payload.cells,
    });
  }

  /** Hand the engine ProfilingSAB to the ui worker so the devtools perf tab
   *  can see it. Retried from mount() — the profiling bridge is created by
   *  initDevTools, which may run after this host exists. */
  private attachProfiling(): void {
    if (this.profilingSent || this.backend.kind !== "worker") return;
    const g = globalThis as Record<string, any>;
    const bridge = g.window?.__sceneInspector?.__getProfilingBridge?.()
      ?? g.__sceneInspector?.__getProfilingBridge?.();
    const sab = bridge?.getProfilingSAB?.();
    if (!sab) return;
    this.profilingSent = true;
    this.send({ type: "profilingAttach", sab, workerTag: this.profilingTag, layout: bridge.getLayoutParams?.() });
  }

  private static spawnWorker(): DocBackend | null {
    try {
      const w = new Worker(new URL("./ui-worker.ts", import.meta.url));
      // Don't let a leaked doc worker pin the runtime after the window closes.
      (w as any).unref?.();
      w.addEventListener("error", (e) => {
        // Expected terminate() during teardown fires a contentless error
        // event — not a fault (see doc-backend.ts dispose).
        if ((w as any).__ddExpectTerminate && !(e as ErrorEvent).message) return;
        const ee = e as ErrorEvent;
        const detail = ee.message ?? (ee.filename ? `${ee.filename}:${ee.lineno ?? "?"}` : `type=${e.type}`);
        log.error("html-ui", `ui-worker error: ${detail}`);
      });
      w.addEventListener("messageerror", (e) => log.error("html-ui", `ui-worker messageerror: ${e.data}`));
      return createWorkerBackend(w);
    } catch (err) {
      log.warn("html-ui", `worker unavailable, falling back to in-process docs: ${err}`);
      return null;
    }
  }

  // ── Panels ──

  mount(spec: PanelSpec): UiPanelHandle {
    this.attachProfiling(); // retry — the profiling bridge may postdate ctor
    this.attachGpu(); // retry — the native host may postdate the ctor
    const id = spec.id ?? `panel-${this.nextId++}`;
    const scale = spec.scale ?? 2;
    const zoom = spec.zoom && spec.zoom > 0 ? spec.zoom : 1;
    const panel: Panel = {
      id, spec, rect: { ...spec.rect }, z: spec.z ?? 0, scale, zoom,
      docH: spec.docH ?? null, src: null,
      texture: null, texW: 0, texH: 0, ubo: null, bindGroup: null,
      handlers: new Set(spec.onEvent ? [spec.onEvent] : []),
      editing: false, sab: null, sabI32: null, lastSeq: 0, lastRect: null,
      gpuBound: false, boundPtr: null, postedBindPtr: null,
    };
    this.panels.set(id, panel);
    this.order.push(id);
    // Doc viewport scale = raster px per CSS px = scale * zoom; layout size
    // is rect/zoom CSS px so the raster still covers rect*scale texture px.
    this.send({ type: "create", id, cssW: spec.rect.w / zoom, cssH: spec.docH ?? spec.rect.h / zoom, scale: scale * zoom, html: spec.html, maxFps: spec.maxFps });
    // GPU-direct: create the panel texture eagerly so the worker's texBind
    // lands before its first upload — the host knows raster dims at mount.
    if (this.gpuReady) this.bindPanelTex(panel);
    return this.handleFor(panel);
  }

  private handleFor(p: Panel): UiPanelHandle {
    // Mutation dedupe — every op posted marks Blitz dirty and triggers a
    // full resolve+repaint+diff in the worker, so a per-frame writer that
    // re-sends unchanged values (fps text, static styles) pays a full doc
    // repaint for nothing. Cache last-sent values per (op, target, field);
    // ops that can invalidate tracked state (html rebuilds, attr removal)
    // flush their entries.
    const sent = new Map<string, string>();
    const mkey = (op: DocMutation, field: string) =>
      `${op.op}|${op.node ?? ""}|${op.sel ?? ""}|${field}`;
    const filterOps = (ops: DocMutation[]): DocMutation[] =>
      ops.filter((op) => {
        switch (op.op) {
          case "text": case "attr": case "style": {
            const field = op.op === "text" ? "" : op.op === "attr" ? op.name : op.prop;
            const value = op.op === "text" ? op.text : op.value;
            const k = mkey(op, field);
            if (sent.get(k) === value) return false;
            sent.set(k, value);
            return true;
          }
          case "rattr": sent.delete(mkey(op, op.name)); return true;
          case "innerHtml": sent.clear(); return true;
          default: return true;
        }
      });
    const mutate = (op: DocMutation) => {
      const ops = filterOps([op]);
      if (ops.length) this.send({ type: "mutate", id: p.id, ops });
    };
    const tgt = (t: number | string) =>
      typeof t === "number" ? { node: t } : { sel: t };
    return {
      id: p.id,
      get rect() { return { ...p.rect }; },
      setHtml: (html) => { sent.clear(); this.send({ type: "setHtml", id: p.id, html }); },
      setText: (t, text) => mutate({ op: "text", ...tgt(t), text }),
      setAttr: (t, name, value) => mutate({ op: "attr", ...tgt(t), name, value }),
      removeAttr: (t, name) => mutate({ op: "rattr", ...tgt(t), name }),
      setStyle: (t, prop, value) => mutate({ op: "style", ...tgt(t), prop, value }),
      setInnerHtml: (t, html) => mutate({ op: "innerHtml", ...tgt(t), html }),
      appendHtml: (t, html) => mutate({ op: "appendHtml", ...tgt(t), html }),
      trimChildren: (t, keep) => mutate({ op: "trimChildren", ...tgt(t), keep }),
      mutate: (ops) => {
        const out = filterOps(ops);
        if (out.length) this.send({ type: "mutate", id: p.id, ops: out });
      },
      focus: (t) => {
        // Claim key routing host-side too — a panel that asks for DOM focus
        // wants the keys (modal overlays rely on this for Escape etc.).
        this.focusedPanel = p.id;
        mutate({ op: "focus", ...(t === undefined ? {} : tgt(t)) });
      },
      setMaxFps: (maxFps) => this.send({ type: "fps", id: p.id, maxFps }),
      setRect: (rect) => {
        const r = p.rect;
        if (r.x === rect.x && r.y === rect.y && r.w === rect.w && r.h === rect.h) return;
        p.rect = { ...rect };
        this.send({ type: "resize", id: p.id, cssW: rect.w / p.zoom, cssH: p.docH ?? rect.h / p.zoom, scale: p.scale * p.zoom });
        this.bindPanelTex(p); // rebind the worker to the resized texture
      },
      setDocHeight: (h) => {
        if (p.docH === h) return;
        p.docH = h;
        this.send({ type: "resize", id: p.id, cssW: p.rect.w / p.zoom, cssH: h, scale: p.scale * p.zoom });
        this.bindPanelTex(p);
      },
      setSrcRect: (src) => { p.src = src ? { ...src } : null; },
      setZ: (z) => { p.z = z; },
      setInteractive: (on) => { p.spec.interactive = on; },
      onEvent: (fn) => { p.handlers.add(fn); return () => { p.handlers.delete(fn); }; },
      getAttr: (t, name) => new Promise((resolve) => {
        const reqId = this.nextReqId++;
        this.attrReqs.set(reqId, resolve);
        this.send({ type: "getAttr", reqId, id: p.id, name, ...tgt(t) });
      }),
      getRect: (t) => new Promise((resolve) => {
        const reqId = this.nextReqId++;
        this.rectReqs.set(reqId, resolve);
        this.send({ type: "getRect", reqId, id: p.id, ...tgt(t) });
      }),
      queryAll: (selector) => new Promise((resolve) => {
        const reqId = this.nextReqId++;
        this.nodesReqs.set(reqId, resolve);
        this.send({ type: "queryAll", reqId, id: p.id, sel: selector });
      }),
      getRects: (nodes) => new Promise((resolve) => {
        const reqId = this.nextReqId++;
        this.rectsReqs.set(reqId, resolve);
        this.send({ type: "getRects", reqId, id: p.id, nodes });
      }),
      focusedNode: () => new Promise((resolve) => {
        const reqId = this.nextReqId++;
        this.focusedReqs.set(reqId, resolve);
        this.send({ type: "getFocused", reqId, id: p.id });
      }),
      scrollIntoView: (t, opts) =>
        mutate({ op: "scrollIntoView", ...tgt(t), smooth: opts?.smooth, vertical: opts?.vertical, horizontal: opts?.horizontal }),
      scrollTo: (t, x, y, smooth) =>
        mutate({ op: "scrollTo", ...tgt(t), x, y, smooth }),
      click: (t) => mutate({ op: "click", ...tgt(t) }),
      sendKey: (down, key, opts) =>
        this.send({ type: "input", id: p.id, msg: { kind: "key", down, key, code: opts?.code, text: opts?.text, mods: opts?.mods } }),
      // Callers pass panel-local display px (like real pointer events) —
      // convert to doc CSS px here the same way local() does.
      sendPointer: (msg) => this.input(p.id,
        msg.kind === "wheel"
          ? { ...msg, x: msg.x / p.zoom, y: msg.y / p.zoom, deltaX: msg.deltaX / p.zoom, deltaY: msg.deltaY / p.zoom }
          : { ...msg, x: msg.x / p.zoom, y: msg.y / p.zoom }),
      navSnapshot: (sel) => new Promise((resolve) => {
        const reqId = this.nextReqId++;
        this.navReqs.set(reqId, resolve);
        this.send({ type: "navSnapshot", reqId, id: p.id, sel });
      }),
      dispose: () => this.unmount(p.id),
    };
  }

  unmount(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    this.panels.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.retireTexture(p);
    p.ubo?.destroy();
    p.sab = null;
    p.sabI32 = null;
    if (this.focusedPanel === id) this.focusedPanel = null;
    this.send({ type: "destroy", id });
  }

  /** Register a `ui://` resource (fonts/images/css) served to every doc. */
  registerResource(url: string, bytes: Uint8Array | ArrayBuffer): void {
    const b = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    this.send({ type: "resource", url, bytes: b as ArrayBuffer }, [b as ArrayBuffer]);
  }

  /** Subscribe to `data-action` clicks across all panels. */
  onAction(action: string, fn: PanelActionHandler): () => void {
    let set = this.actionHandlers.get(action);
    if (!set) this.actionHandlers.set(action, set = new Set());
    set.add(fn);
    return () => { set.delete(fn); };
  }

  /** True when the pointer is inside any panel rect (UI owns the cursor).
   *  Optional coords hit-test a specific point instead of the last seen
   *  pointer position — the right check inside pointer-event handlers, where
   *  pointerPos may lag the event. */
  isPointerOverUI(x?: number, y?: number): boolean {
    return this.panelAt(x ?? this.pointerPos.x, y ?? this.pointerPos.y) !== null;
  }

  /** Doc-backend capabilities (populated by the `ready` handshake —
   *  `incrementalDom` is false until then, and forever on old cdylibs). */
  get docCaps(): { incrementalDom: boolean } { return this.caps; }

  /** Compositor surface for GameRenderer's end-of-frame UI pass. */
  get compositor(): { hasContent(): boolean; render(pass: GPURenderPassEncoder, w: number, h: number): void } {
    return {
      // Polling here (not only in render) means a freshly-bound panel's
      // first SAB frame lands the same frame — hasContent is what gates the
      // compositor into the UI pass.
      hasContent: () => {
        this.pollSabFrames();
        return [...this.panels.values()].some((p) => p.bindGroup !== null);
      },
      render: (pass, w, h) => {
        this.pollSabFrames();
        const draw = this.sortedPanels()
          .filter((p) => p.bindGroup && p.ubo)
          .map((p) => ({
            bindGroup: p.bindGroup!, ubo: p.ubo!, rect: p.rect,
            src: p.src
              ? [p.src.x / p.texW, p.src.y / p.texH,
                 (p.src.x + p.src.w) / p.texW, (p.src.y + p.src.h) / p.texH] as [number, number, number, number]
              : undefined,
          }));
        this.blit.render(pass, draw, w, h);
      },
    };
  }

  dispose(): void {
    this.unsubInput.forEach((u) => u());
    this.unsubInput = [];
    if (this.moveTimer) { clearTimeout(this.moveTimer); this.moveTimer = null; }
    for (const p of this.panels.values()) { this.retireTexture(p); p.ubo?.destroy(); p.sab = null; p.sabI32 = null; }
    this.panels.clear();
    this.order = [];
    if (this.gpuAttachSent && this.backend.kind === "worker" && !this.gpuDetachAcked) {
      // Graceful detach: let the worker drop its shared-device view before
      // terminate() kills it — an un-detached view stalls the broker's
      // retire() until timeout, and retired textures must outlive the
      // worker's last writeTexture. Both settle on gpuDetached or 150ms.
      this.terminating = true;
      this.send({ type: "gpuDetach" });
      const backend = this.backend;
      setTimeout(() => {
        if (!this.gpuDetachAcked) backend.dispose();
        this.destroyRetired();
      }, 150);
      return;
    }
    this.backend.dispose();
    this.destroyRetired();
  }

  private destroyRetired(): void {
    for (const r of this.retiredTex.values()) { clearTimeout(r.timer); r.tex.destroy(); }
    this.retiredTex.clear();
  }

  // ── Input coalescing ──
  // Pointermove dominates UI input traffic; at 120Hz+ input rates each move
  // used to become its own worker message + DOM dispatch. Keep only the
  // latest move per panel and flush at ~8ms — ordering vs. down/up/wheel/key
  // is preserved by flushing pending moves before any other input send.
  private pendingMoves = new Map<string, DocInputMsg>();
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  private queueMove(id: string, msg: DocInputMsg): void {
    this.pendingMoves.set(id, msg);
    if (!this.moveTimer) {
      this.moveTimer = setTimeout(() => this.flushMoves(), 8);
    }
  }

  private flushMoves(): void {
    if (this.moveTimer) { clearTimeout(this.moveTimer); this.moveTimer = null; }
    if (!this.pendingMoves.size) return;
    this.pendingMoves.forEach((msg, id) => this.send({ type: "input", id, msg }));
    this.pendingMoves.clear();
  }

  private input(id: string, msg: DocInputMsg): void {
    if (msg.kind === "move") { this.queueMove(id, msg); return; }
    this.flushMoves();
    this.send({ type: "input", id, msg });
  }

  // ── Input ──

  /** Attach to the renderer input bus at UI priority (before game handlers). */
  bindInput(bus: RendererInputBus): void {
    const modsOf = (e: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) => {
      const m: string[] = [];
      if (e.shiftKey) m.push("shift");
      if (e.ctrlKey) m.push("ctrl");
      if (e.altKey) m.push("alt");
      if (e.metaKey) m.push("meta");
      return m;
    };
    const input = (id: string, msg: DocInputMsg) => this.input(id, msg);
    const local = (p: Panel, e: { clientX: number; clientY: number }) => ({
      x: (e.clientX - p.rect.x) / p.zoom, y: (e.clientY - p.rect.y) / p.zoom,
    });

    this.unsubInput.push(
      bus.onPointerMove((e: PointerEvent, _ctrl: InputEventControl) => {
        this.pointerPos = { x: e.clientX, y: e.clientY };
        // Hover + drag continuity: moves go to the captured/hovered panel.
        const target = this.panels.get(this.pointerDownOn ?? "") ?? this.panelAt(e.clientX, e.clientY);
        if (target) input(target.id, { kind: "move", ...local(target, e), mods: modsOf(e) });
      }, -10),
      bus.onPointerDown((e: PointerEvent, ctrl: InputEventControl) => {
        const p = this.panelAt(e.clientX, e.clientY);
        if (!p) {
          // Click into the world: release DOM focus (blurs an active input).
          if (this.focusedPanel) {
            this.send({ type: "mutate", id: this.focusedPanel, ops: [{ op: "focus" }] });
            this.focusedPanel = null;
          }
          return;
        }
        ctrl.stopPropagation();
        this.pointerDownOn = p.id;
        this.focusedPanel = p.id;
        const c = local(p, e);
        input(p.id, { kind: "down", ...c, button: btn(e.button), mods: modsOf(e) });
      }, -10),
      bus.onPointerUp((e: PointerEvent, ctrl: InputEventControl) => {
        const downOn = this.pointerDownOn ? this.panels.get(this.pointerDownOn) : null;
        this.pointerDownOn = null;
        const p = downOn ?? this.panelAt(e.clientX, e.clientY);
        if (!p) return;
        ctrl.stopPropagation();
        input(p.id, { kind: "up", ...local(p, e), button: btn(e.button), mods: modsOf(e) });
      }, -10),
      bus.onWheel((e: WheelEvent, ctrl: InputEventControl) => {
        const p = this.panelAt(e.clientX, e.clientY);
        if (!p) return;
        ctrl.stopPropagation();
        input(p.id, { kind: "wheel", ...local(p, e), deltaX: e.deltaX / p.zoom, deltaY: e.deltaY / p.zoom, mods: modsOf(e) });
      }, -10),
      bus.onKeyDown((e: KeyboardEvent, ctrl: InputEventControl) => {
        const p = this.focusedPanel ? this.panels.get(this.focusedPanel) : null;
        if (!p) return;
        // Only eat keys while a text-editable element holds focus — otherwise
        // game hotkeys stay live even when a panel is focused.
        if (p.editing) ctrl.stopPropagation();
        input(p.id, { kind: "key", down: true, key: e.key, code: e.code, text: e.key.length === 1 ? e.key : undefined, mods: modsOf(e) });
      }, -10),
      bus.onKeyUp((e: KeyboardEvent, ctrl: InputEventControl) => {
        const p = this.focusedPanel ? this.panels.get(this.focusedPanel) : null;
        if (!p) return;
        if (p.editing) ctrl.stopPropagation();
        input(p.id, { kind: "key", down: false, key: e.key, code: e.code, mods: modsOf(e) });
      }, -10),
    );
  }

  private pointerDownOn: string | null = null;

  /** Topmost interactive panel whose rect contains (x, y) — rect-based
   *  capture gating. Non-interactive overlays (`interactive:false`) are
   *  skipped so pointer events fall through to panels beneath them. */
  private panelAt(x: number, y: number): Panel | null {
    const sorted = this.sortedPanels();
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i]!;
      if (p.spec.interactive === false) continue;
      const r = p.rect;
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return p;
    }
    return null;
  }

  /** Handle for the topmost interactive panel at screen (x, y), or null.
   *  Public sibling of `panelAt` for virtual-pointer routing. */
  panelAtHandle(x: number, y: number): UiPanelHandle | null {
    const p = this.panelAt(x, y);
    return p ? this.handleFor(p) : null;
  }

  private sortedPanels(): Panel[] {
    return this.order
      .map((id) => this.panels.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.z - b.z);
  }

  // ── Backend messages ──

  private handleMessage(m: WorkerToUi): void {
    switch (m.type) {
      case "bind": {
        const p = this.panels.get(m.id);
        if (!p) return;
        p.sab = m.buf;
        p.sabI32 = new Int32Array(m.buf);
        // Fresh buffer — its seqlock restarts at 0, so reset the dedupe
        // state or the stale lastSeq could suppress real uploads.
        p.lastSeq = 0;
        p.lastRect = null;
        // gpuFallback binds mean the worker dropped GPU-direct delivery —
        // resume host-side uploads. Plain binds just keep p.sab current so
        // fallback is instant when needed.
        if (m.gpuFallback === true) {
          p.gpuBound = false;
          p.boundPtr = null;
        }
        break;
      }
      case "gpuReady": {
        this.gpuReady = m.ok;
        log.info("html-ui", `doc backend: ${this.backend.kind}${m.ok ? " (gpu-direct)" : ""}`);
        if (m.ok) {
          this.panels.forEach((p) => this.bindPanelTex(p));
        }
        break;
      }
      case "gpuDetached": {
        this.gpuDetachAcked = true;
        if (this.terminating) {
          this.backend.dispose();
          this.destroyRetired();
        }
        break;
      }
      case "texAck": {
        // The worker dropped its borrow of this ptr — safe to destroy the
        // retired texture now (no worker FFI call can still be in flight).
        const ptr = BigInt(m.texPtr);
        const r = this.retiredTex.get(ptr);
        if (r) {
          this.retiredTex.delete(ptr);
          clearTimeout(r.timer);
          r.tex.destroy();
        }
        // Release bookkeeping — a bind for the same ptr may be reposted.
        const p = this.panels.get(m.id);
        if (p) {
          if (p.postedBindPtr === ptr) p.postedBindPtr = null;
          if (p.boundPtr === ptr) { p.boundPtr = null; p.gpuBound = false; }
        }
        break;
      }
      case "frame": {
        const p = this.panels.get(m.id);
        if (process.env.DD_UI_TRACE_FRAMES === "1") {
          log.info("html-ui", `frame ${m.id} x=${m.x} y=${m.y} w=${m.w} h=${m.h} pw=${m.pw} ph=${m.ph} seq=${m.seq ?? "-"} gpu=${m.gpu === true}${m.texPtr !== undefined ? ` tex=${m.texPtr}` : ""}`);
        }
        if (!p) return;
        if (m.gpu === true) {
          // GPU-direct: the worker already wrote the dirty rect into a
          // texture — nothing to upload when it's the displayed one. A
          // mismatched texPtr means the worker is writing a stale target
          // (a bind it ignored, or a texture retired underneath it): fall
          // back to SAB and repost the live texture's bind to reconverge.
          const cur = p.texture ? BigInt((p.texture as unknown as { ptr: number | bigint }).ptr) : null;
          const fp = m.texPtr !== undefined ? BigInt(m.texPtr) : null;
          if (fp === null || fp !== cur) {
            if (p.gpuBound) { p.gpuBound = false; p.boundPtr = null; }
            if (cur !== null && p.postedBindPtr !== cur) this.bindPanelTex(p);
            break;
          }
          // Confirmed: the worker uploads the displayed texture itself —
          // host-side SAB uploads stay skipped until the next fallback.
          p.gpuBound = true;
          p.boundPtr = fp;
          if (p.texW !== m.pw || p.texH !== m.ph) this.bindPanelTex(p);
          break;
        }
        if (m.seq !== undefined && m.stride !== undefined && p.sab && p.sabI32) {
          if (p.gpuBound) break; // stale seq frame — worker owns uploads now
          // Zero-copy path: the backend wrote the dirty rect into the shared
          // buffer. Skip when a poll already uploaded this emit (or a newer
          // frame covering its rect) — otherwise upload the message's
          // captured rect: superseded header entries still carry regions the
          // newest frame's rect may not cover.
          const r = p.lastRect;
          if (p.lastSeq >= m.seq && r &&
              m.x >= r.x && m.y >= r.y && m.x + m.w <= r.x + r.w && m.y + m.h <= r.y + r.h) break;
          this.uploadSabFrame(p, m.x, m.y, m.w, m.h, m.pw, m.ph, m.stride);
          break;
        }
        if (!m.pixels) break;
        this.ensureTexture(p, m.pw, m.ph);
        if (!p.texture) return;
        this.device.queue.copyExternalImageToTexture(
          { source: { data: new Uint8Array(m.pixels), width: m.w, height: m.h } } as unknown as GPUCopyExternalImageSourceInfo,
          { texture: p.texture, origin: [m.x, m.y, 0] } as unknown as GPUCopyExternalImageDestInfo,
          { width: m.w, height: m.h },
        );
        break;
      }
      case "stats": {
        const stats = (globalThis as Record<string, unknown>).__ddUiStats ??= {};
        (stats as Record<string, UiDocStats>)[m.id] = {
          frames: m.frames, resolveMs: m.resolveMs, paintMs: m.paintMs,
          diffMs: m.diffMs, bytes: m.bytes, at: performance.now(),
        };
        if (UI_TRACE) {
          const mb = (m.bytes / 1048576).toFixed(1);
          log.info("html-ui", `doc ${m.id}: ${m.frames}f res=${m.resolveMs.toFixed(1)}ms paint=${m.paintMs.toFixed(1)}ms diff=${m.diffMs.toFixed(1)}ms up=${mb}MB`);
        }
        break;
      }
      case "events": {
        const p = this.panels.get(m.id);
        if (!p) return;
        m.events.forEach((ev) => {
          if (ev.t === "focus") p.editing = ev.g === "input" || ev.g === "textarea";
          else if (ev.t === "blur") p.editing = false;
          p.handlers.forEach((fn) => fn(ev));
          if ((ev.t === "click" || ev.t === "dblclick" || ev.t === "contextmenu") && ev.d?.action) {
            const d = ev.d;
            (this.actionHandlers.get(d.action) ?? []).forEach((fn) => fn(d, ev));
          }
        });
        break;
      }
      case "attr": {
        const fn = this.attrReqs.get(m.reqId);
        this.attrReqs.delete(m.reqId);
        fn?.(m.value);
        break;
      }
      case "rect": {
        const fn = this.rectReqs.get(m.reqId);
        this.rectReqs.delete(m.reqId);
        fn?.(m.rect);
        break;
      }
      case "nodes": {
        const fn = this.nodesReqs.get(m.reqId);
        this.nodesReqs.delete(m.reqId);
        fn?.(m.nodes);
        break;
      }
      case "rects": {
        const fn = this.rectsReqs.get(m.reqId);
        this.rectsReqs.delete(m.reqId);
        fn?.(m.rects);
        break;
      }
      case "focused": {
        const fn = this.focusedReqs.get(m.reqId);
        this.focusedReqs.delete(m.reqId);
        fn?.(m.node);
        break;
      }
      case "navNodes": {
        const fn = this.navReqs.get(m.reqId);
        this.navReqs.delete(m.reqId);
        fn?.(m.nodes);
        break;
      }
      case "error": log.error("html-ui", `doc ${m.id} backend error: ${m.message}`); break;
      case "ready": {
        this.caps.incrementalDom = m.caps?.incrementalDom === true;
        break;
      }
    }
  }

  /** Upload one dirty rect straight out of the panel's bound SAB, seqlock
   *  verified. Records lastSeq/lastRect so the poll path and late "frame"
   *  messages don't re-upload the same content. */
  private uploadSabFrame(p: Panel, x: number, y: number, w: number, h: number, pw: number, ph: number, stride: number): void {
    if (p.gpuBound) return; // the worker uploads directly — don't race it
    const i32 = p.sabI32!;
    const seq0 = Atomics.load(i32, 0);
    // seq0 === 0 → bound but nothing emitted yet; odd → write in progress.
    // A frame message implies a write, so ask for a re-emit; the poll path
    // skips both cases itself and just retries next frame.
    if (seq0 === 0 || (seq0 & 1) !== 0) { this.send({ type: "refresh", id: p.id }); return; }
    if (w <= 0 || h <= 0) return;
    this.ensureTexture(p, pw, ph);
    if (!p.texture) return;
    this.device.queue.writeTexture(
      { texture: p.texture, origin: [x, y, 0] },
      p.sab as unknown as GPUAllowSharedBufferSource,
      { offset: 64 + y * stride + x * 4, bytesPerRow: stride, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    // Torn read (a newer write started mid-upload) — ask for a re-emit.
    if (Atomics.load(i32, 0) !== seq0) { this.send({ type: "refresh", id: p.id }); return; }
    p.lastSeq = seq0;
    p.lastRect = { x, y, w, h };
  }

  /** Poll bound SAB frame channels once per render frame and upload pending
   *  dirty rects directly — the worker's "frame" postMessage is delivered on
   *  a macrotask boundary, so waiting for it can cost a whole frame of lag
   *  when it lands behind a long renderFrame. The header only describes the
   *  newest emit; superseded dirty rects still arrive via their messages. */
  private pollSabFrames(): void {
    for (const p of this.panels.values()) {
      const i32 = p.sabI32;
      if (!i32 || !p.sab || p.gpuBound) continue;
      const seq0 = Atomics.load(i32, 0);
      if (seq0 === 0 || (seq0 & 1) !== 0 || seq0 === p.lastSeq) continue;
      const x = i32[1], y = i32[2], w = i32[3], h = i32[4];
      const pw = i32[5], ph = i32[6], stride = i32[8];
      this.uploadSabFrame(p, x, y, w, h, pw, ph, stride);
    }
  }

  /**
   * Create (or recreate) the panel texture and post it to the worker as a
   * borrowed upload target. No-op when the worker's attach hasn't resolved
   * or a bind for the same texture is already in flight/confirmed. Host
   * uploads keep flowing until a gpu:true frame proves the worker is
   * writing the displayed texture — an ignored bind is a no-op, never a
   * deadlock. Raster dims are always rect*scale — the doc's layout height
   * may exceed the display rect for scrollable views (docH).
   */
  private bindPanelTex(p: Panel): void {
    if (!this.gpuReady || this.backend.kind !== "worker") return;
    const pw = Math.max(1, Math.round(p.rect.w * p.scale));
    // docH is a layout-px override: it scales by zoom like the doc does.
    const ph = Math.max(1, Math.round((p.docH !== null ? p.docH * p.zoom : p.rect.h) * p.scale));
    this.ensureTexture(p, pw, ph);
    if (!p.texture) return;
    const ptr = BigInt((p.texture as unknown as { ptr: number | bigint }).ptr);
    if (p.postedBindPtr === ptr || (p.gpuBound && p.boundPtr === ptr)) return;
    this.send({ type: "texBind", id: p.id, texPtr: ptr, w: pw, h: ph, format: "rgba8unorm" });
    p.postedBindPtr = ptr;
  }

  /**
   * Release a panel's texture — deferred when the worker may still be
   * writing through it. A bound texture's ptr could be mid-writeTexture on
   * the worker right now; destroying the handle while an FFI call derefs it
   * is a use-after-free inside the shim. Bound textures go to retiredTex
   * and die on texAck (worker swapped) or a 1s fallback timer (worker gone).
   */
  private retireTexture(p: Panel): void {
    const t = p.texture;
    p.texture = null;
    if (!t) return;
    const ptr = (t as unknown as { ptr?: number | bigint }).ptr;
    const borrowed = ptr !== undefined
      && ((p.boundPtr !== null && BigInt(ptr) === p.boundPtr)
        || (p.postedBindPtr !== null && BigInt(ptr) === p.postedBindPtr));
    if (borrowed) {
      const key = BigInt(ptr);
      const timer = setTimeout(() => {
        if (this.retiredTex.delete(key)) t.destroy();
      }, 1000);
      this.retiredTex.set(key, { tex: t, timer });
      return;
    }
    t.destroy();
  }

  private ensureTexture(p: Panel, w: number, h: number): void {
    if (p.texture && p.texW === w && p.texH === h) return;
    this.retireTexture(p);
    const tw = Math.max(1, w), th = Math.max(1, h);
    p.texture = this.device.createTexture({
      size: { width: tw, height: th },
      format: "rgba8unorm",
      viewFormats: ["rgba8unorm-srgb"],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    } as GPUTextureDescriptor);
    // Zero-fill — dirty-rect uploads only cover painted regions, so
    // un-painted texels (e.g. transparent spacers in overlay docs) would
    // otherwise composite uninitialized garbage over panels beneath.
    this.device.queue.writeTexture(
      { texture: p.texture },
      new Uint8Array(tw * th * 4),
      { bytesPerRow: tw * 4, rowsPerImage: th },
      { width: tw, height: th, depthOrArrayLayers: 1 },
    );
    p.texW = w;
    p.texH = h;
    if (!p.ubo) p.ubo = this.blit.createUbo();
    p.bindGroup = this.blit.createBindGroup(p.texture, p.ubo);
  }

  private send(msg: Parameters<DocBackend["post"]>[0], transfer?: Transferable[]): void {
    try {
      this.backend.post(msg, transfer);
    } catch (err) {
      log.error("html-ui", `backend.post threw for ${msg.type}: ${err}`);
    }
  }
}

function btn(b?: number): "left" | "middle" | "right" {
  return b === 2 ? "right" : b === 1 ? "middle" : "left";
}
