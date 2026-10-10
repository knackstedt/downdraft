// ============================================================================
// blitz/host.ts — BlitzDevtoolsHost: the docked, in-window devtools frontend.
//
// Renders a Chrome-DevTools-style dock (tab bar + panel + status bar) as a
// Blitz html-ui document composited over the game frame. All data flows
// through the shared DevtoolsBackend — the same providers, collectors, and
// RPC methods that feed the browser-served WebDevtoolsHost.
//
// The doc is mounted only while visible: hiding unmounts it (state lives in
// the panel objects, remount is one create+paint). Dock height drags via
// the grip strip (pointermove events arrive while a button is held).
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine";
import { CdpBridge, DevtoolsBackend } from "@downdraft/engine/libraries/devtools";
import { HtmlUiHost, type OsrDomEvent, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";

import { registerDevtoolsFonts } from "./fonts";
import { ConsolePanel } from "./panels/console";
import { ElementsPanel } from "./panels/elements";
import { GpuPanel } from "./panels/gpu";
import { PerformancePanel } from "./panels/performance";
import { SnapshotPanel } from "./panels/snapshot";
import { esc, type DtPanel, type DtPanelCtx } from "./panels/types";
import { DEVTOOLS_CSS } from "./theme";

const log = createLogger("info");

/** Minimal mounting surface — satisfied by HtmlUiContext and the
 *  self-hosted wrapper below. */
export interface DevtoolsUiSurface {
  mount(markup: string, spec: {
    id?: string;
    rect: { x: number; y: number; w: number; h: number };
    z?: number;
    scale?: number;
    maxFps?: number;
    /** Ease wheel deltas at pump cadence (html-ui PanelSpec.smoothWheel). */
    smoothWheel?: boolean;
    interactive?: boolean;
    onEvent?: (ev: OsrDomEvent) => void;
  }): UiPanelHandle;
  /** Doc-backend capabilities — panels use incremental DOM ops only when
   *  the underlying cdylib provides them. */
  docCaps?(): { incrementalDom?: boolean };
  /** Register a `ui://` resource (fonts) served to the dock doc — must run
   *  before mount. Absent on surfaces that don't own a resource table. */
  registerResource?(url: string, bytes: Uint8Array | ArrayBuffer): void;
}

export interface BlitzDevtoolsOptions {
  /** html-ui mounting surface (game's HtmlUiTok or a self-hosted host). */
  ui: DevtoolsUiSurface;
  /** The game renderer (WebGPURenderer) — feeds GPU/scene/metrics collectors. */
  renderer: unknown;
  /** Optional scene-graph host — feeds the scene tree panel. */
  gameScene?: unknown;
  /** Optional ProfilingSAB for per-worker performance metrics. */
  profilingSAB?: SharedArrayBuffer | null;
  /** Viewport size provider — used for dock layout. */
  surface: { clientWidth: number; clientHeight: number };
  /** Dock height as a fraction of the surface (default 0.42). */
  dockFraction?: number;
  /** Open the dock on start. Default false. */
  autoShow?: boolean;
}

const MIN_DOCK = 120;

export class BlitzDevtoolsHost {
  private opts: BlitzDevtoolsOptions;
  private cdp: CdpBridge;
  private backend: DevtoolsBackend;
  private panel: UiPanelHandle | null = null;
  private panels = new Map<string, DtPanel>();
  private snapshotPanels = new Map<number, SnapshotPanel>();
  private activeId = "console";
  private dockH = 0;
  private surfaceW: number;
  private surfaceH: number;
  private _ready = false;
  private disposed = false;
  private tabsDirty = true;
  private statusText = "";
  private dragging = false;
  private dragStartY = 0;
  private dragStartH = 0;
  private panelCtx: DtPanelCtx;
  private lastPanelRender = -1e9;
  private lastSlowLog = 0;
  /** @font-face css from registerDevtoolsFonts — "" means "embedded font
   *  fallback", null means "not yet attempted". */
  private fontCss: string | null = null;

  constructor(opts: BlitzDevtoolsOptions) {
    this.opts = opts;
    this.surfaceW = opts.surface.clientWidth;
    this.surfaceH = opts.surface.clientHeight;
    this.dockH = Math.round(this.surfaceH * (opts.dockFraction ?? 0.42));
    this.cdp = new CdpBridge();
    const ctx: DtPanelCtx = {
      call: (method, params) => this.backend.dispatch(method, params ?? {}),
      setValue: (t, v) => this.panel?.setAttr(t, "value", v),
      scrollIntoView: (t) => this.panel?.scrollIntoView(t, { vertical: "end" }),
      scrollTo: (t, x, y) => this.panel?.scrollTo(t, x, y),
      getRect: (t) => this.panel?.getRect(t) ?? Promise.resolve(null),
      mutate: (ops) => this.panel?.mutate(ops),
      // Lazy — the caps handshake lands after ctor on the worker backend.
      get incrementalDom() {
        return opts.ui.docCaps?.()?.incrementalDom === true
          || (opts.ui as { host?: HtmlUiHost }).host?.docCaps.incrementalDom === true;
      },
    };
    this.panelCtx = ctx;
    this.backend = new DevtoolsBackend({
      emit: (event, data) => this.routeEvent(event, data),
      hasClient: () => this.visible,
      cdp: this.cdp,
      renderer: opts.renderer,
      gameScene: opts.gameScene,
      profilingSAB: opts.profilingSAB ?? null,
    });

    // Fixed tabs — same data contract as the web frontend.
    for (const p of [
      new ConsolePanel(ctx),
      new ElementsPanel(ctx),
      new PerformancePanel(ctx),
      new GpuPanel(ctx),
    ].values()) this.panels.set(p.id, p);
  }

  get visible(): boolean { return this.panel !== null; }
  get ready(): boolean { return this._ready; }
  get cdpBridge(): CdpBridge { return this.cdp; }
  /** Provider/command registration surface — satisfies DevtoolsProviderTarget. */
  get devtoolsMirror(): DevtoolsBackend { return this.backend; }
  get debuggerScene(): { registerThreadEval: (n: string, fn: (e: string) => Promise<{ result?: unknown; error?: string }>) => void; setActivePanel: (p: string) => void; getActivePanel: () => string; setPerfRecording: (s: boolean) => void } {
    return {
      registerThreadEval: (n, fn) => this.registerThreadEval(n, fn),
      setActivePanel: (p) => this.activate(p),
      getActivePanel: () => this.activeId,
      setPerfRecording: (s) => this.backend.setPerfRecording(s),
    };
  }

  /** Start the backend + CDP session. Mounts the dock when autoShow. */
  start(): void {
    if (this._ready || this.disposed) return;
    this.backend.start();
    this.backend.attachLoggerBridge();
    this.cdp.start();
    this._ready = true;
    if (this.opts.autoShow) this.show();
    log.info("blitz-devtools-host", "Blitz devtools ready (F12 toggles the dock)");
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    if (!this._ready || this.visible || this.disposed) return;
    // Register real system fonts once per host — ui:// resources persist on
    // the surface across dock remounts, and must land before the doc mounts
    // so the first resolve sees them (embedded DejaVu fallback otherwise).
    if (this.fontCss === null) {
      const ui = this.opts.ui as DevtoolsUiSurface & { host?: HtmlUiHost };
      const rr = ui.registerResource?.bind(ui)
        ?? (ui.host ? ui.host.registerResource.bind(ui.host) : undefined);
      this.fontCss = rr ? registerDevtoolsFonts({ registerResource: rr }) : "";
    }
    try {
      this.panel = this.opts.ui.mount(this.shellHtml(), {
        id: "devtools",
        rect: this.dockRect(),
        // Above game overlays — menus/loading screens shouldn't bury the dock.
        z: 1000,
        // Native-res raster: the vendored glifo/FreeType path grid-fits hinted
        // glyph stems to whole pixels — supersample factors >1 just blur that
        // back out on downscale (and cost 2.25x the texture memory).
        scale: 1,
        // Ease wheel detents at pump cadence instead of jumping per event.
        smoothWheel: true,
        interactive: true,
        // Devtools UI doesn't need vsync-rate raster — cap it so mutation
        // bursts (console streams, snapshot refreshes) coalesce into ~66ms
        // rasters instead of one raster per message.
        maxFps: 15,
        onEvent: (ev) => this.handleDocEvent(ev),
      });
    } catch (err) {
      // Mount fails when the ui worker is dead — stay hidden so the next F12
      // retries cleanly instead of wedging on a half-mounted doc.
      this.panel = null;
      log.error("blitz-devtools-host", `dock mount failed: ${err}`);
      return;
    }
    this.syncProviders();
    this.renderTabs();
    this.activate(this.activeId);
    this.backend.resetFirstUpdate();
  }

  hide(): void {
    this.panel?.dispose();
    this.panel = null;
    this.dragging = false;
  }

  /** Per-frame pump — call from a frame hook. */
  update(): void {
    if (!this._ready || this.disposed) return;
    const t0 = performance.now();
    try {
      this.backend.update();
    } catch (err) {
      log.error("blitz-devtools-host", `backend update error: ${err}`);
    }
    const t1 = performance.now();
    if (!this.visible) return;
    // Guarded like backend.update() above — a throwing panel render can't be
    // allowed to kill the game frame hook that drives this pump.
    try {
      this.syncProviders();
      this.flush();
    } catch (err) {
      const tn = performance.now();
      if (tn - this.lastSlowLog > 1000) {
        this.lastSlowLog = tn;
        log.warn("blitz-devtools-host", `panel render error: ${err}`);
      }
    }
    const t2 = performance.now();
    // ≤1/sec — these diagnostics used to feed the console panel's logger
    // sink, and each row forced another dock re-render: a self-feeding
    // lag loop while the dock is open.
    if (t2 - t0 > 6 && t2 - this.lastSlowLog > 1000) {
      this.lastSlowLog = t2;
      log.info("blitz-devtools-host", `slow update: backend=${(t1 - t0).toFixed(1)}ms sync+flush=${(t2 - t1).toFixed(1)}ms`);
    }
  }

  registerThreadEval(name: string, evalFn: (expr: string) => Promise<{ result?: unknown; error?: string }>): void {
    this.backend.registerThreadEval(name, evalFn);
  }

  setPerfRecording(start: boolean): void {
    this.backend.setPerfRecording(start);
  }

  setActivePanel(id: string): void { this.activate(id); }
  getActivePanel(): string { return this.activeId; }

  // ── nativeDebugger interface parity (the dock composites through the
  //    html-ui compositor instead of a debug blit) ──
  getUiTextureView(): GPUTextureView | null { return null; }
  blit(_encoder: GPUCommandEncoder, _targetView: GPUTextureView): void { /* composited by the UI pass */ }
  handlePointerDown(_x: number, _y: number, _button: number, _mods: number): boolean { return false; }
  handlePointerMove(_x: number, _y: number, _button: number, _mods: number): boolean { return false; }
  handlePointerUp(_x: number, _y: number, _button: number, _mods: number): boolean { return false; }
  handleWheel(_x: number, _y: number, _deltaY: number): boolean { return false; }
  handleTextInput(_text: string): boolean { return false; }
  handleKeyDown(_key: string, _keyCode: number): boolean { return false; }
  isTextInputActive(): boolean { return false; }
  setModifiers(_alt: boolean, _ctrl: boolean, _shift: boolean): void { /* noop */ }

  resize(w: number, h: number): void {
    this.surfaceW = w;
    this.surfaceH = h;
    if (this.visible) this.panel?.setRect(this.dockRect());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    try { this.backend.dispose(); } catch { /* ignore */ }
    try { this.cdp.dispose(); } catch { /* ignore */ }
    this._ready = false;
  }

  // ── Dock layout ──

  private dockRect() {
    // A tiny surface (or a pathological resize event) must not produce a
    // negative height — keep at least enough room for the tab strip.
    const h = Math.max(48, Math.min(this.dockH, this.surfaceH - 60));
    return { x: 0, y: Math.max(0, this.surfaceH - h), w: this.surfaceW, h };
  }

  private shellHtml(): string {
    return `<html><head><style>${this.fontCss ?? ""}${DEVTOOLS_CSS}</style></head><body>
      <div id="dt-root">
        <div id="dt-grip" title="drag to resize"></div>
        <div id="dt-chrome">
          <div id="dt-body"></div>
          <div id="dt-status"><span id="dt-status-l"></span><span id="dt-status-r"></span></div>
          <div id="dt-bottom"></div>
          <div id="dt-top"></div>
          <div id="dt-tabs"></div>
        </div>
      </div></body></html>`;
  }

  // ── Tabs ──

  private renderTabs(): void {
    if (!this.panel) return;
    // esc() both interpolations — provider names feed panel ids/titles and
    // arrive as raw strings (a game registering "x\"><img" would otherwise
    // inject markup into the tab strip).
    const tabs = [...this.panels.values()].map((p) =>
      `<span class="tab${p.id === this.activeId ? " active" : ""}" data-action="dt.tab" data-tab="${esc(p.id)}">${esc(p.title)}</span>`
    ).join("");
    this.panel.setInnerHtml("#dt-tabs",
      `<span class="brand">downdraft</span>${tabs}<span class="spacer"></span>
       <span class="hint">docked · F12</span><span id="dt-close" data-action="dt.close">✕</span>`);
    this.tabsDirty = false;
  }

  private activate(id: string): void {
    if (!this.panel || !this.panels.has(id)) return;
    this.activeId = id;
    const p = this.panels.get(id)!;
    this.renderTabs();
    try {
      this.panel.setInnerHtml("#dt-top", p.renderTop?.() ?? "");
      this.panel.setInnerHtml("#dt-bottom", p.renderBottom?.() ?? "");
    } catch (err) {
      log.warn("blitz-devtools-host", `panel ${id} chrome render error: ${err}`);
    }
    p.dirty = true;
    p.shellDirty = false;
    this.panel.setInnerHtml("#dt-body", this.safeBody(p));
    try { p.afterRender?.(); } catch (err) {
      log.warn("blitz-devtools-host", `panel ${id} afterRender error: ${err}`);
    }
    try { p.activate?.(); } catch (err) {
      log.warn("blitz-devtools-host", `panel ${id} activate error: ${err}`);
    }
    // Only the snapshot tab being viewed gets periodic provider refreshes;
    // fixed panels suspend auto-refresh entirely (manual Refresh still works).
    this.backend.providerWatch = p.providerSlot ?? -1;
    this.setStatus(`${p.title}`);
  }

  /** Keep snapshot tabs in sync with the backend's provider registry. */
  private syncProviders(): void {
    const slots = this.backend.providerSlots();
    let changed = false;
    const seen = new Set<number>();
    for (const { slot, name } of slots.values()) {
      seen.add(slot);
      if (!this.snapshotPanels.has(slot)) {
        const p = new SnapshotPanel(this.panelCtx, slot, name);
        this.snapshotPanels.set(slot, p);
        this.panels.set(p.id, p);
        changed = true;
      }
    }
    for (const [slot, p] of this.snapshotPanels.entries()) {
      if (!seen.has(slot)) {
        this.snapshotPanels.delete(slot);
        this.panels.delete(p.id);
        if (this.activeId === p.id) this.activeId = "console";
        changed = true;
      }
    }
    if (changed) this.tabsDirty = true;
  }

  private routeEvent(event: string, data: unknown): void {
    for (const p of this.panels.values()) {
      try { p.onBackendEvent?.(event, data); } catch (err) {
        log.warn("blitz-devtools-host", `panel ${p.id} event error: ${err}`);
      }
    }
  }

  private flush(): void {
    if (!this.panel) return;
    if (this.tabsDirty) this.renderTabs();
    const p = this.panels.get(this.activeId);
    if (!p || (!p.dirty && !p.shellDirty)) return;
    // A dirty panel re-render ships a whole rebuilt #dt-body to the doc
    // worker for reparse — cap the rate (~15Hz, the doc's own raster cap)
    // so a chatty panel (console streams, metric pushes) can't rebuild
    // every frame. Panels with a flushDom path do cheap incremental
    // mutations within the same budget.
    const now = performance.now();
    if (now - this.lastPanelRender < 60) return;
    this.lastPanelRender = now;
    if (p.shellDirty) {
      p.shellDirty = false;
      this.panel.setInnerHtml("#dt-top", p.renderTop?.() ?? "");
      this.panel.setInnerHtml("#dt-bottom", p.renderBottom?.() ?? "");
    }
    if (p.dirty) {
      p.dirty = false;
      let handled = false;
      try { handled = p.flushDom?.() === true; } catch (err) {
        log.warn("blitz-devtools-host", `panel ${p.id} flushDom error: ${err}`);
      }
      if (!handled) this.panel.setInnerHtml("#dt-body", this.safeBody(p));
      try { p.afterRender?.(); } catch (err) {
        log.warn("blitz-devtools-host", `panel ${p.id} afterRender error: ${err}`);
      }
    }
  }

  /** renderBody that can't take the dock down — the error surfaces in-panel
   *  (and the next push retries since dirty just flips back on). */
  private safeBody(p: DtPanel): string {
    try {
      return p.renderBody();
    } catch (err) {
      log.warn("blitz-devtools-host", `panel ${p.id} renderBody error: ${err}`);
      return `<div class="status-banner error">panel render error: ${esc(String(err))}</div>`;
    }
  }

  private setStatus(text: string): void {
    if (text === this.statusText) return;
    this.statusText = text;
    this.panel?.setText("#dt-status-l", text);
  }

  // ── Doc events ──

  private handleDocEvent(ev: OsrDomEvent): void {
    // Grip drag — pointermove only arrives while a button is held.
    if (ev.id === "dt-grip" || this.dragging) {
      if (ev.t === "mousedown") {
        this.dragging = true;
        this.dragStartY = ev.y ?? 0;
        this.dragStartH = this.dockH;
        this.panel?.setAttr("#dt-grip", "class", "drag");
        return;
      }
      if (ev.t === "pointermove" && this.dragging) {
        const nh = this.dragStartH - ((ev.y ?? 0) - this.dragStartY);
        const clamped = Math.max(MIN_DOCK, Math.min(this.surfaceH - 60, Math.round(nh)));
        if (clamped !== this.dockH) {
          this.dockH = clamped;
          this.panel?.setRect(this.dockRect());
        }
        return;
      }
      if (ev.t === "mouseup" && this.dragging) {
        this.dragging = false;
        this.panel?.setAttr("#dt-grip", "class", "");
        return;
      }
    }

    // Left-click only — routing actions on contextmenu meant a right-click
    // on a tab/button fired it instead of just focusing.
    const action = ev.d?.action;
    if (ev.t === "click" && action) {
      if (action === "dt.tab") {
        const id = ev.d!.tab;
        if (id) this.activate(id);
        return;
      }
      if (action === "dt.close") { this.hide(); return; }
      try { this.panels.get(this.activeId)?.onAction?.(ev.d!, ev); } catch (err) {
        log.warn("blitz-devtools-host", `panel action error: ${err}`);
      }
      return;
    }

    // Everything else (input, keydown/up, scroll, focus…) → active panel.
    try { this.panels.get(this.activeId)?.onEvent?.(ev); } catch (err) {
      log.warn("blitz-devtools-host", `panel event error: ${err}`);
    }
  }
}

/**
 * Self-hosted mounting surface for games that don't already run html-ui —
 * same pattern as the editor module's createSelfHostedUi.
 */
export function createSelfHostedDevtoolsUi(ctx: RendererModuleContext): DevtoolsUiSurface & { host: HtmlUiHost } {
  const host = new HtmlUiHost(ctx.getDevice(), ctx.getFormat(), undefined, { profilingTag: "devtools-ui" });
  host.bindInput(ctx.getInputBus());
  ctx.onDispose(() => host.dispose());
  // order=1000 — the dock draws above every game-registered UI compositor
  // (fullscreen loading/menus would otherwise cover it).
  const comp = host.compositor;
  const unreg = ctx.registerUiCompositor?.({
    order: 1000,
    hasContent: () => comp.hasContent(),
    render: (pass, w, h) => comp.render(pass, w, h),
  });
  log.info("blitz-devtools-host", `self-hosted ui: device=${!!ctx.getDevice()} fmt=${ctx.getFormat()} compositorRegistered=${!!unreg}`);
  if (unreg) ctx.onDispose(unreg);
  return {
    host,
    mount: (markup, spec) => host.mount({ ...spec, html: markup }),
    docCaps: () => host.docCaps,
    registerResource: (url, bytes) => host.registerResource(url, bytes),
  };
}
