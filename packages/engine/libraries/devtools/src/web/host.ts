// ============================================================================
// web/host.ts — WebDevtoolsHost: the web-based devtools backend.
//
// Drop-in replacement for NativeDebuggerHost (the egui overlay). Instead of
// rendering an egui overlay into the frame, it runs a loopback devtools
// server (Bun.serve: HTTP static + WS JSON-RPC) and opens the browser-based
// devtools UI when toggled (F12).
//
// The host keeps the same public surface as NativeDebuggerHost —
// `visible`, `toggle/show/hide`, `update()`, `devtoolsMirror`,
// `debuggerScene`, `registerThreadEval`, `setPerfRecording`, input handlers
// (all no-ops: a separate browser window receives input, nothing in-game) —
// so native-entry.ts needs only the constructor swap.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { CdpBridge } from "../cdp-bridge";
import { openDevToolsUrl } from "./browser";
import { WebDevtoolsMirror } from "./mirror";
import { DevToolsServer } from "./server";

const log = createLogger("info");

export interface WebDevtoolsOptions {
  /** Shared wgpu-native GPUDevice (unused — kept for constructor parity). */
  device: GPUDevice;
  /** Shared GPUAdapter (unused — parity). */
  adapter: GPUAdapter;
  /** Swapchain format (unused — parity). */
  targetFormat: GPUTextureFormat;
  /** Overlay width (unused — parity). */
  width: number;
  /** Overlay height (unused — parity). */
  height: number;
  /** The game renderer (WebGPURenderer) — for GPU/scene data. */
  renderer: unknown;
  /** Optional scene-graph host (an object exposing `.stage` with
   *  children/label) — feeds the scene tree panel. */
  gameScene?: unknown;
  /** Optional ProfilingSAB for per-worker performance metrics. */
  profilingSAB?: SharedArrayBuffer | null;
  /** Directory containing the devtools-web frontend (default: sibling package). */
  webRoot?: string;
  /** Extra static routes (e.g. "/kit.css" → generated kit stylesheet). */
  extraRoutes?: Record<string, string>;
}

export class WebDevtoolsHost {
  private opts: WebDevtoolsOptions;
  private cdp: CdpBridge;
  private server: DevToolsServer;
  private mirror: WebDevtoolsMirror;
  private sceneShim: WebDebuggerSceneShim;
  private _ready = false;
  private disposed = false;
  private browserOpened = false;

  constructor(opts: WebDevtoolsOptions) {
    this.opts = opts;
    this.cdp = new CdpBridge();
    // The server's RPC dispatcher closes over `this.mirror` — assigned just
    // below, before any client can connect.
    this.server = new DevToolsServer({
      webRoot: opts.webRoot,
      extraRoutes: opts.extraRoutes,
      call: (method, params) => this.mirror.dispatch(method, params),
    });
    this.mirror = new WebDevtoolsMirror({
      server: this.server,
      cdp: this.cdp,
      renderer: opts.renderer,
      gameScene: opts.gameScene,
      profilingSAB: opts.profilingSAB ?? null,
    });
    this.sceneShim = new WebDebuggerSceneShim(this);
  }

  /** Whether the devtools UI is "visible" — i.e. a browser client is attached. */
  get visible(): boolean { return this.server.clientCount > 0; }

  get ready(): boolean { return this._ready; }
  get cdpBridge(): CdpBridge { return this.cdp; }
  get devtoolsMirror(): WebDevtoolsMirror { return this.mirror; }
  get debuggerScene(): WebDebuggerSceneShim { return this.sceneShim; }
  get app(): null { return null; }
  /** The URL a browser would connect to (for tests / manual open). */
  get url(): string { return this.server.url; }

  /** Start the loopback server + mirror + CDP session. */
  async start(): Promise<void> {
    if (this._ready || this.disposed) return;
    try {
      await this.server.start();
    } catch (err) {
      log.warn("WebDevtoolsHost", `devtools server failed to start: ${err}`);
      // Still bring up mirror/cdp so the RPC surface exists for embedded
      // callers (e.g. tests); the browser UI just won't be reachable.
    }
    this.mirror.start();
    this.mirror.attachLoggerBridge();
    this.cdp.start();
    this._ready = true;
    log.info("WebDevtoolsHost", `Web devtools ready (F12 opens ${this.server.url})`);
  }

  /** F12: open (or refocus) the devtools browser window. */
  toggle(): void {
    if (!this._ready) return;
    if (this.visible) {
      // Already open — ask the frontend to close its window (it can only
      // succeed if the window was script-opened, which --app mode satisfies
      // on some browsers; worst case the user closes it normally).
      this.server.emit("devtools.close", {});
      log.info("WebDevtoolsHost", "Devtools close requested");
      return;
    }
    this.open();
  }

  /** Open the devtools browser window (idempotent while a client is up). */
  open(): void {
    if (!this._ready) return;
    if (this.visible) {
      this.server.emit("devtools.focus", {});
      return;
    }
    const url = this.server.url;
    if (!url.includes(":0")) {
      if (openDevToolsUrl(url)) {
        this.browserOpened = true;
        this.mirror.resetFirstUpdate();
      } else {
        log.warn("WebDevtoolsHost", `No browser found — open manually: ${url}`);
      }
    }
  }

  show(): void { this.open(); }
  hide(): void { this.server.emit("devtools.close", {}); }

  /** Per-frame pump (call from the render loop). */
  update(_externalEncoder?: GPUCommandEncoder): void {
    if (!this._ready || this.disposed) return;
    try {
      this.mirror.update();
    } catch (err) {
      log.error("WebDevtoolsHost", `mirror update error: ${err}`);
    }
  }

  registerThreadEval(threadName: string, evalFn: (expr: string) => Promise<{ result?: unknown; error?: string }>): void {
    this.mirror.registerThreadEval(threadName, evalFn);
  }

  /** Track the frontend's active panel (reported via inspector calls; best-effort). */
  private activePanel = "";
  setActivePanel(panel: string): void { this.activePanel = panel; }
  getActivePanel(): string { return this.activePanel; }

  setPerfRecording(start: boolean): void {
    this.mirror.setPerfRecording(start);
  }

  // ── Input handlers: all no-ops (the devtools live in a separate window) ──
  handlePointerDown(_x: number, _y: number, _button: number, _mods: number): boolean { return false; }
  handlePointerMove(_x: number, _y: number, _button: number, _mods: number): boolean { return false; }
  handlePointerUp(_x: number, _y: number, _button: number, _mods: number): boolean { return false; }
  handleWheel(_x: number, _y: number, _deltaY: number): boolean { return false; }
  handleTextInput(_text: string): boolean { return false; }
  handleKeyDown(_key: string, _keyCode: number): boolean { return false; }
  isTextInputActive(): boolean { return false; }
  setModifiers(_alt: boolean, _ctrl: boolean, _shift: boolean): void { /* noop */ }
  resize(_w: number, _h: number): void { /* browser window owns layout */ }

  getUiTextureView(): GPUTextureView | null { return null; }
  blit(_encoder: GPUCommandEncoder, _targetView: GPUTextureView): void { /* no overlay */ }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.mirror.dispose(); } catch { /* ignore */ }
    try { this.cdp.dispose(); } catch { /* ignore */ }
    void this.server.stop().catch(() => { /* ignore */ });
    this._ready = false;
    this.browserOpened = false;
  }
}

/** `debuggerScene` compatibility shim for native-entry.ts call sites. */
export class WebDebuggerSceneShim {
  private host: WebDevtoolsHost;
  constructor(host: WebDevtoolsHost) { this.host = host; }
  registerThreadEval(threadName: string, evalFn: (expr: string) => Promise<{ result?: unknown; error?: string }>): void {
    this.host.registerThreadEval(threadName, evalFn);
  }
  setActivePanel(panel: string): void { this.host.setActivePanel(panel); }
  getActivePanel(): string { return this.host.getActivePanel(); }
  setPerfRecording(start: boolean): void { this.host.setPerfRecording(start); }
  // Legacy DEBUGGER_TEST stubs (the web UI is tested via WS, not clicks).
  handlePointerDown(_x: number, _y: number): boolean { return false; }
  handlePointerUp(_x: number, _y: number): boolean { return false; }
  handlePointerMove(_x: number, _y: number): boolean { return false; }
  handleWheel(_x: number, _y: number, _d: number): boolean { return false; }
  handleKeyDown(_k: string, _kc: number): boolean { return false; }
  handleTextInput(_t: string): boolean { return false; }
  isTextInputActive(): boolean { return false; }
  getFocusedWidget(): string | null { return null; }
  getConsoleReplInput(): string { return ""; }
  getDockX(): number { return 0; }
  get dockWidth(): number { return 0; }
  getHits(): { regions: unknown[] } { return { regions: [] }; }
}
