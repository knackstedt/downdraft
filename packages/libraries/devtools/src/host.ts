// ============================================================================
// host.ts — NativeDebuggerHost: the native egui debugger overlay.
//
// Owns the Rust egui crate handle (via egui-ffi.ts) + an EguiRenderer that
// renders the serialized PaintJobs into a GPUTexture on the shared wgpu-native
// device. The existing UiBlitPass composites that texture above the game UI.
// Toggled by F12. When visible, SDL pointer/keyboard/text events route to the
// egui crate; the renderer blits the UI texture over the frame.
//
// Created by native-entry.ts after the game's NativePixiUiHost is ready.
//
// This replaces the previous PixiJS-based DebuggerScene implementation. The
// public surface is preserved so native-entry.ts needs minimal changes.
// ============================================================================

import { CdpBridge } from "./cdp-bridge";
import {
    devtoolsDestroy,
    type DevtoolsHandle,
    devtoolsInit,
    devtoolsKeyDown,
    devtoolsMouseButton,
    devtoolsResize,
    devtoolsSetActivePanel,
    devtoolsSetModifiers,
    devtoolsSetMousePos,
    devtoolsSetWheel,
    devtoolsTextInput,
    devtoolsUpdate,
    devtoolsWantsTextInput
} from "./egui-ffi";
import { EguiRenderer } from "./egui-renderer";
import { DevtoolsMirror } from "./mirror";

export interface NativeDebuggerOptions {
  /** The shared wgpu-native GPUDevice (same as the game renderer's). */
  device: GPUDevice;
  /** The shared GPUAdapter. */
  adapter: GPUAdapter;
  /** Swapchain texture format (the blit pass writes here). */
  targetFormat: GPUTextureFormat;
  /** Overlay width (CSS pixels). */
  width: number;
  /** Overlay height (CSS pixels). */
  height: number;
  /** The game renderer (WebGPURenderer) — for GPU/scene data. */
  renderer: any;
  /** The game's NativePixiUiHost — for the PIXI scene graph tree. */
  gamePixiUi: any;
  /** Optional ProfilingSAB for per-worker performance metrics. */
  profilingSAB?: SharedArrayBuffer | null;
}

// Lazy import of UiBlitPass (peer dependency, may not be available in non-
// native environments). We use dynamic import() so the package typechecks
// without the native host installed.
let UiBlitPassCtor: any = null;
let nativeHostLoading: Promise<void> | null = null;
function loadUiBlitPass(): Promise<void> {
  if (UiBlitPassCtor) return Promise.resolve();
  if (nativeHostLoading) return nativeHostLoading;
  nativeHostLoading = (async () => {
    try {
      const modulePath = "@downdraft/library-pixi-ui-native";
      const mod: any = await import(/* @vite-ignore */ modulePath);
      UiBlitPassCtor = mod.UiBlitPass;
    } catch {
      UiBlitPassCtor = null;
    }
  })();
  return nativeHostLoading;
}

/**
 * A thin shim that exposes the `debuggerScene` surface used by native-entry.ts
 * (registerThreadEval, setActivePanel). It delegates to the egui crate.
 * Also includes stubs for the old DebuggerScene API used by DEBUGGER_TEST.
 */
export class DebuggerSceneShim {
  private host: NativeDebuggerHost;
  constructor(host: NativeDebuggerHost) { this.host = host; }
  registerThreadEval(threadName: string, evalFn: (expr: string) => Promise<{ result?: any; error?: string }>): void {
    this.host.registerThreadEval(threadName, evalFn);
  }
  setActivePanel(panel: string): void {
    this.host.setActivePanel(panel);
  }
  // ── Stubs for old DebuggerScene API (used by DEBUGGER_TEST) ──
  handlePointerDown(x: number, y: number): boolean { return this.host.handlePointerDown(x, y, 0, 0); }
  handlePointerUp(x: number, y: number): boolean { return this.host.handlePointerUp(x, y, 0, 0); }
  handlePointerMove(x: number, y: number): boolean { return this.host.handlePointerMove(x, y, 0, 0); }
  handleTextInput(text: string): boolean { return this.host.handleTextInput(text); }
  isTextInputActive(): boolean { return this.host.isTextInputActive(); }
  getActivePanel(): string { return ""; }
  getFocusedWidget(): string | null { return null; }
  getConsoleReplInput(): string { return ""; }
  getDockX(): number { return 1280 - 560; }
  get dockWidth(): number { return 560; }
  getHits(): { regions: any[] } { return { regions: [] }; }
}

export class NativeDebuggerHost {
  private opts: NativeDebuggerOptions;
  private cdp: CdpBridge;
  private mirror: DevtoolsMirror | null = null;
  private renderer: EguiRenderer | null = null;
  private blitPass: any = null;
  private handle: DevtoolsHandle | null = null;
  private scratch: { buf: Uint8Array } = { buf: new Uint8Array(1 << 22) }; // 4MB initial
  private sceneShim: DebuggerSceneShim;
  private _visible = false;
  private _ready = false;
  private disposed = false;
  private width: number;
  private height: number;

  constructor(opts: NativeDebuggerOptions) {
    this.opts = opts;
    this.width = opts.width;
    this.height = opts.height;
    this.cdp = new CdpBridge();
    this.sceneShim = new DebuggerSceneShim(this);
  }

  /** Whether the debugger overlay is currently visible. */
  get visible(): boolean { return this._visible; }

  /** Whether the debugger host has finished initializing. */
  get ready(): boolean { return this._ready; }

  /** The CdpBridge (console + profiling). */
  get cdpBridge(): CdpBridge { return this.cdp; }

  /** The DebuggerScene shim (for native-entry.ts compatibility). */
  get debuggerScene(): DebuggerSceneShim { return this.sceneShim; }

  /** The debug overlay's PIXI Application (null — egui has no PIXI app). */
  get app(): any { return null; }

  /** Start the debugger: init the egui crate + renderer + CDP session. */
  async start(): Promise<void> {
    if (this._ready || this.disposed) return;
    await loadUiBlitPass();

    // Init the Rust egui crate.
    const dpr = 1.0; // native mode uses physical pixels directly
    this.handle = devtoolsInit(this.width, this.height, dpr);

    // Create the EguiRenderer (renders PaintJobs to a GPUTexture).
    this.renderer = new EguiRenderer(this.opts.device, this.width, this.height);

    // Create the blit pass for compositing the egui UI texture above the game.
    if (UiBlitPassCtor) {
      this.blitPass = new UiBlitPassCtor(this.opts.device, this.opts.targetFormat);
    }

    // Create the data mirror + start CDP.
    this.mirror = new DevtoolsMirror({
      handle: this.handle,
      cdp: this.cdp,
      renderer: this.opts.renderer,
      gamePixiUi: this.opts.gamePixiUi,
      profilingSAB: this.opts.profilingSAB ?? null,
    });
    this.mirror.start();
    this.mirror.attachLoggerBridge();
    this.cdp.start();

    this._ready = true;
    console.log("[NativeDebuggerHost] Ready (egui) (F12 to toggle)");
  }

  /** Register a thread eval function (delegates to the mirror). */
  registerThreadEval(threadName: string, evalFn: (expr: string) => Promise<{ result?: any; error?: string }>): void {
    this.mirror?.registerThreadEval(threadName, evalFn);
  }

  /** Set the active panel (delegates to the egui crate). */
  setActivePanel(panel: string): void {
    if (!this.handle) return;
    const id = panel === "console" ? 0
      : panel === "scene" ? 1
      : panel === "gpu" ? 2
      : panel === "perf-recorder" ? 3
      : panel === "perf-metrics" ? 4
      : panel === "dom-tree" ? 5
      : 0;
    devtoolsSetActivePanel(this.handle, id);
  }

  /** Toggle visibility. */
  toggle(): void {
    this._visible = !this._visible;
    if (this._visible) {
      this.mirror?.resetFirstUpdate();
      console.log("[NativeDebuggerHost] Debugger visible");
    } else {
      console.log("[NativeDebuggerHost] Debugger hidden");
    }
  }

  /** Show the debugger. */
  show(): void {
    if (!this._visible) {
      this._visible = true;
      this.mirror?.resetFirstUpdate();
    }
  }

  /** Hide the debugger. */
  hide(): void { this._visible = false; }

  /** Per-frame update: pump CDP events, mirror data, run egui, render.
   *  If `externalEncoder` is provided, the egui render pass is encoded into
   *  it (no separate submit) to ensure proper ordering with the blit pass. */
  update(externalEncoder?: GPUCommandEncoder): void {
    if (!this._ready || this.disposed) return;
    if (!this._visible) return;
    if (!this.handle || !this.renderer) return;

    // 1. Pump the data mirror (pushes data to Rust, polls eval requests).
    try {
      this.mirror?.update();
    } catch (err) {
      console.error("[NativeDebuggerHost] Mirror update error:", err);
    }

    // 2. Run egui for one frame → get serialized PaintJobs.
    let paintJobs = null;
    try {
      paintJobs = devtoolsUpdate(this.handle, this.scratch);
    } catch (err) {
      console.error("[NativeDebuggerHost] egui update error:", err);
    }

    // 3. Render the PaintJobs into the UI texture.
    if (paintJobs) {
      try {
        this.renderer.render(paintJobs, externalEncoder);
      } catch (err) {
        console.error("[NativeDebuggerHost] egui render error:", err);
      }
    }
  }

  /** The debug overlay's UI texture view (for the renderer's blit pass). */
  getUiTextureView(): GPUTextureView | null {
    return this.renderer?.getUiTextureView() ?? null;
  }

  /** Encode the debug overlay blit into the command encoder. */
  blit(commandEncoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    if (!this._visible || !this.blitPass) return;
    const uiView = this.getUiTextureView();
    if (!uiView) return;
    this.blitPass.execute(commandEncoder, targetView, uiView);
  }

  /** Handle a pointerdown event. Returns true if consumed by the debugger. */
  handlePointerDown(x: number, y: number, button: number, _modifiers: number): boolean {
    if (!this._visible || !this.handle) return false;
    devtoolsSetMousePos(this.handle, x, y);
    devtoolsMouseButton(this.handle, button, true);
    return true; // egui handles hit-testing; consume when visible
  }

  /** Handle a pointermove event. Returns true if consumed. */
  handlePointerMove(x: number, y: number, _button: number, _modifiers: number): boolean {
    if (!this._visible || !this.handle) return false;
    devtoolsSetMousePos(this.handle, x, y);
    return true;
  }

  /** Handle a pointerup event. Returns true if consumed. */
  handlePointerUp(x: number, y: number, button: number, _modifiers: number): boolean {
    if (!this._visible || !this.handle) return false;
    devtoolsSetMousePos(this.handle, x, y);
    devtoolsMouseButton(this.handle, button, false);
    return true;
  }

  /** Handle a mouse wheel event. Returns true if consumed. */
  handleWheel(_x: number, _y: number, deltaY: number): boolean {
    if (!this._visible || !this.handle) return false;
    devtoolsSetWheel(this.handle, deltaY);
    return true;
  }

  /** Handle a text input event (from SDL_TEXTINPUT). Returns true if consumed. */
  handleTextInput(text: string): boolean {
    if (!this._visible || !this.handle) return false;
    if (!this.isTextInputActive()) return false;
    devtoolsTextInput(this.handle, text);
    return true;
  }

  /** Handle a keydown event for the focused widget. Returns true if consumed. */
  handleKeyDown(key: string, _keyCode: number): boolean {
    if (!this._visible || !this.handle) return false;
    if (!this.isTextInputActive()) return false;
    // Only consume keys that are relevant to text input / egui.
    const controlKeys = [
      "Backspace", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      "Delete", "Home", "End", "Escape", "Tab", "PageUp", "PageDown",
      "Insert", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ];
    if (!controlKeys.includes(key)) return false;
    devtoolsKeyDown(this.handle, key);
    return true;
  }

  /** Whether text input is currently active (egui wants keyboard input). */
  isTextInputActive(): boolean {
    if (!this._visible || !this.handle) return false;
    return devtoolsWantsTextInput(this.handle);
  }

  /** Set modifier state (called before pointer/key events). */
  setModifiers(alt: boolean, ctrl: boolean, shift: boolean): void {
    if (!this.handle) return;
    devtoolsSetModifiers(this.handle, alt, ctrl, shift);
  }

  /** Resize the debug overlay. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.handle) devtoolsResize(this.handle, width, height);
    this.renderer?.resize(width, height);
  }

  /** Dispose — close CDP session, destroy egui crate + renderer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.mirror?.dispose(); } catch { /* ignore */ }
    try { this.cdp.dispose(); } catch { /* ignore */ }
    try { this.renderer?.dispose(); } catch { /* ignore */ }
    try { if (this.handle) devtoolsDestroy(this.handle); } catch { /* ignore */ }
    this.mirror = null;
    this.renderer = null;
    this.handle = null;
    this.blitPass = null;
  }
}
