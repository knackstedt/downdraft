// ============================================================================
// host.ts — HtmlUiHost: main-thread owner of the html-ui system.
//
// Owns the doc backend (worker or local fallback), per-panel GPU textures,
// dirty-rect uploads, event dispatch, and input routing. Compositing itself is
// done by PanelBlitPass via the compositor object exposed by `compositor`.
// ============================================================================

import type { InputEventControl, RendererInputBus } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine";
import type { OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import { PanelBlitPass } from "./composite";
import { createLocalBackend, createWorkerBackend, type DocBackend } from "./doc-backend";
import type { DocInputMsg, DocMutation, WorkerToUi } from "./protocol";

const log = createLogger("info");

export interface PanelRect { x: number; y: number; w: number; h: number }

export interface PanelSpec {
  /** Stable id — defaults to `panel-N`. */
  id?: string;
  /** Screen-space rect in CSS px. */
  rect: PanelRect;
  /** Paint order — higher draws later (on top). Default: insertion order. */
  z?: number;
  /** Supersample factor (raster size = rect * scale). Default 2 — crisper text. */
  scale?: number;
  /** Raster-rate cap for animating docs (0 = uncapped). Static docs repaint on demand regardless. */
  maxFps?: number;
  /** Initial markup (or `vdom` rendered beforehand by the caller). */
  html: string;
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
  scale: number;
  texture: GPUTexture | null;
  texW: number;
  texH: number;
  ubo: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  handlers: Set<PanelEventHandler>;
  /** True while an editable element (<input>/<textarea>) holds DOM focus. */
  editing: boolean;
}

export interface UiPanelHandle {
  readonly id: string;
  setHtml(html: string): void;
  setText(target: number | string, text: string): void;
  setAttr(target: number | string, name: string, value: string): void;
  removeAttr(target: number | string, name: string): void;
  setStyle(target: number | string, prop: string, value: string): void;
  setInnerHtml(target: number | string, html: string): void;
  /** Apply multiple DOM mutations in one backend pass — a single relayout. */
  mutate(ops: DocMutation[]): void;
  focus(target?: number | string): void;
  setMaxFps(maxFps: number): void;
  setRect(rect: PanelRect): void;
  setZ(z: number): void;
  onEvent(fn: PanelEventHandler): () => void;
  getAttr(target: number | string, name: string): Promise<string | null>;
  dispose(): void;
}

export class HtmlUiHost {
  private backend: DocBackend;
  private panels = new Map<string, Panel>();
  private order: string[] = []; // insertion order, stable tiebreaker
  private nextId = 0;
  private nextReqId = 1;
  private attrReqs = new Map<number, (v: string | null) => void>();
  private actionHandlers = new Map<string, Set<PanelActionHandler>>();
  private unsubInput: Array<() => void> = [];
  private focusedPanel: string | null = null;
  private pointerPos = { x: -1, y: -1 };

  readonly blit: PanelBlitPass;

  constructor(
    private device: GPUDevice,
    format: GPUTextureFormat,
    backend?: DocBackend,
  ) {
    this.blit = new PanelBlitPass(device, format);
    this.backend = backend ?? HtmlUiHost.spawnWorker() ?? createLocalBackend();
    this.backend.onMessage((m) => this.handleMessage(m));
  }

  private static spawnWorker(): DocBackend | null {
    try {
      const w = new Worker(new URL("./ui-worker.ts", import.meta.url));
      w.addEventListener("error", (e) => log.error("html-ui", `ui-worker error: ${(e as ErrorEvent).message ?? e}`));
      w.addEventListener("messageerror", (e) => log.error("html-ui", `ui-worker messageerror: ${e.data}`));
      return createWorkerBackend(w);
    } catch (err) {
      log.warn("html-ui", `worker unavailable, falling back to in-process docs: ${err}`);
      return null;
    }
  }

  // ── Panels ──

  mount(spec: PanelSpec): UiPanelHandle {
    const id = spec.id ?? `panel-${this.nextId++}`;
    const scale = spec.scale ?? 2;
    const panel: Panel = {
      id, spec, rect: { ...spec.rect }, z: spec.z ?? 0, scale,
      texture: null, texW: 0, texH: 0, ubo: null, bindGroup: null,
      handlers: new Set(spec.onEvent ? [spec.onEvent] : []),
      editing: false,
    };
    this.panels.set(id, panel);
    this.order.push(id);
    this.send({ type: "create", id, cssW: spec.rect.w, cssH: spec.rect.h, scale, html: spec.html, maxFps: spec.maxFps });
    return this.handleFor(panel);
  }

  private handleFor(p: Panel): UiPanelHandle {
    const mutate = (op: DocMutation) => this.send({ type: "mutate", id: p.id, ops: [op] });
    const tgt = (t: number | string) =>
      typeof t === "number" ? { node: t } : { sel: t };
    return {
      id: p.id,
      setHtml: (html) => this.send({ type: "setHtml", id: p.id, html }),
      setText: (t, text) => mutate({ op: "text", ...tgt(t), text }),
      setAttr: (t, name, value) => mutate({ op: "attr", ...tgt(t), name, value }),
      removeAttr: (t, name) => mutate({ op: "rattr", ...tgt(t), name }),
      setStyle: (t, prop, value) => mutate({ op: "style", ...tgt(t), prop, value }),
      setInnerHtml: (t, html) => mutate({ op: "innerHtml", ...tgt(t), html }),
      mutate: (ops) => this.send({ type: "mutate", id: p.id, ops }),
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
        this.send({ type: "resize", id: p.id, cssW: rect.w, cssH: rect.h, scale: p.scale });
      },
      setZ: (z) => { p.z = z; },
      onEvent: (fn) => { p.handlers.add(fn); return () => { p.handlers.delete(fn); }; },
      getAttr: (t, name) => new Promise((resolve) => {
        const reqId = this.nextReqId++;
        this.attrReqs.set(reqId, resolve);
        this.send({ type: "getAttr", reqId, id: p.id, name, ...tgt(t) });
      }),
      dispose: () => this.unmount(p.id),
    };
  }

  unmount(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    this.panels.delete(id);
    this.order = this.order.filter((x) => x !== id);
    p.texture?.destroy();
    p.ubo?.destroy();
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

  /** True when the pointer is inside any panel rect (UI owns the cursor). */
  isPointerOverUI(): boolean {
    return this.panelAt(this.pointerPos.x, this.pointerPos.y) !== null;
  }

  /** Compositor surface for GameRenderer's end-of-frame UI pass. */
  get compositor(): { hasContent(): boolean; render(pass: GPURenderPassEncoder, w: number, h: number): void } {
    return {
      hasContent: () => [...this.panels.values()].some((p) => p.bindGroup !== null),
      render: (pass, w, h) => {
        const draw = this.sortedPanels()
          .filter((p) => p.bindGroup && p.ubo)
          .map((p) => ({ bindGroup: p.bindGroup!, ubo: p.ubo!, rect: p.rect }));
        this.blit.render(pass, draw, w, h);
      },
    };
  }

  dispose(): void {
    this.unsubInput.forEach((u) => u());
    this.unsubInput = [];
    for (const p of this.panels.values()) { p.texture?.destroy(); p.ubo?.destroy(); }
    this.panels.clear();
    this.order = [];
    this.backend.dispose();
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
    const input = (id: string, msg: DocInputMsg) => this.send({ type: "input", id, msg });
    const local = (p: Panel, e: { clientX: number; clientY: number }) => ({
      x: e.clientX - p.rect.x, y: e.clientY - p.rect.y,
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
        input(p.id, { kind: "wheel", ...local(p, e), deltaX: e.deltaX, deltaY: e.deltaY, mods: modsOf(e) });
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

  /** Topmost panel whose rect contains (x, y) — rect-based capture gating. */
  private panelAt(x: number, y: number): Panel | null {
    const sorted = this.sortedPanels();
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i]!;
      const r = p.rect;
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return p;
    }
    return null;
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
      case "frame": {
        const p = this.panels.get(m.id);
        if (!p) return;
        this.ensureTexture(p, m.pw, m.ph);
        if (!p.texture) return;
        this.device.queue.copyExternalImageToTexture(
          { source: { data: new Uint8Array(m.pixels), width: m.w, height: m.h } } as unknown as GPUCopyExternalImageSourceInfo,
          { texture: p.texture, origin: [m.x, m.y, 0] } as unknown as GPUCopyExternalImageDestInfo,
          { width: m.w, height: m.h },
        );
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
      case "error": log.error("html-ui", `doc ${m.id} backend error: ${m.message}`); break;
      case "ready": break;
    }
  }

  private ensureTexture(p: Panel, w: number, h: number): void {
    if (p.texture && p.texW === w && p.texH === h) return;
    p.texture?.destroy();
    p.texture = this.device.createTexture({
      size: { width: Math.max(1, w), height: Math.max(1, h) },
      format: "rgba8unorm",
      viewFormats: ["rgba8unorm-srgb"],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    } as GPUTextureDescriptor);
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
