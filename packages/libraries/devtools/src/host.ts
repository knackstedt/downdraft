// ============================================================================
// host.ts — NativeDebuggerHost: the native pixi.js debugger overlay.
//
// Owns a second NativePixiUiHost (debug overlay) on the shared wgpu-native
// device, composited above the game UI via a second UiBlitPass. Toggled by
// F12. When visible, SDL pointer events route to the debugger's PixiJS
// EventSystem first (hit-test against the DebuggerScene's interactive
// regions); misses pass through to the game's input handler.
//
// Created by native-entry.ts after the game's NativePixiUiHost is ready.
// ============================================================================

import { CdpBridge } from "./cdp-bridge";
import { DebuggerScene } from "./debugger-scene";

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

// Lazy import of NativePixiUiHost + UiBlitPass (peer dependency, may not be
// available in non-native environments). We use a dynamic import() so the
// package typechecks without the native host installed and works in Bun's
// ESM context (require() is not available in ESM modules under Bun).
let NativePixiUiHostCtor: any = null;
let UiBlitPassCtor: any = null;
let nativeHostLoading: Promise<void> | null = null;
function loadNativeHost(): Promise<void> {
  if (NativePixiUiHostCtor) return Promise.resolve();
  if (nativeHostLoading) return nativeHostLoading;
  nativeHostLoading = (async () => {
    try {
      // Use a variable so TypeScript doesn't try to resolve the optional peer dep.
      const modulePath = "@downdraft/library-pixi-ui-native";
      const mod: any = await import(/* @vite-ignore */ modulePath);
      NativePixiUiHostCtor = mod.NativePixiUiHost;
      UiBlitPassCtor = mod.UiBlitPass;
    } catch {
      NativePixiUiHostCtor = null;
      UiBlitPassCtor = null;
    }
  })();
  return nativeHostLoading;
}

export class NativeDebuggerHost {
  private opts: NativeDebuggerOptions;
  private debugPixiUi: any = null;
  private blitPass: any = null;
  private scene: DebuggerScene | null = null;
  private cdp: CdpBridge;
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
  }

  /** Whether the debugger overlay is currently visible. */
  get visible(): boolean { return this._visible; }

  /** Whether the debugger host has finished initializing. */
  get ready(): boolean { return this._ready; }

  /** The CdpBridge (console + profiling). */
  get cdpBridge(): CdpBridge { return this.cdp; }

  /** The DebuggerScene (null until start()). */
  get debuggerScene(): DebuggerScene | null { return this.scene; }

  /** The debug overlay's PIXI Application (null until start()). */
  get app(): any { return this.debugPixiUi?.app ?? null; }

  /** Start the debugger: create the debug pixi host + scene + CDP session. */
  async start(): Promise<void> {
    if (this._ready || this.disposed) return;
    await loadNativeHost();
    if (!NativePixiUiHostCtor) {
      console.warn("[NativeDebuggerHost] NativePixiUiHost not available — debugger disabled");
      return;
    }

    // Create the debug overlay NativePixiUiHost (separate VirtualCanvas + GPUTexture).
    this.debugPixiUi = new NativePixiUiHostCtor({
      device: this.opts.device,
      adapter: this.opts.adapter,
      targetFormat: this.opts.targetFormat,
      width: this.width,
      height: this.height,
    });
    try {
      await this.debugPixiUi.ready;
    } catch (err) {
      console.error("[NativeDebuggerHost] Debug PixiJS init failed:", err);
      this.debugPixiUi = null;
      return;
    }
    // Create the blit pass for compositing the debug overlay above the game UI.
    if (UiBlitPassCtor) {
      this.blitPass = new UiBlitPassCtor(this.opts.device, this.opts.targetFormat);
    }

    // Create the DebuggerScene and attach it to the debug overlay's stage.
    this.scene = new DebuggerScene({
      app: this.debugPixiUi.app,
      width: this.width,
      height: this.height,
      renderer: this.opts.renderer,
      gamePixiUi: this.opts.gamePixiUi,
      cdp: this.cdp,
      profilingSAB: this.opts.profilingSAB ?? null,
    });
    this.debugPixiUi.app.stage.addChild(this.scene.root);

    // Start the CDP bridge (console + profiling).
    this.cdp.start();

    this._ready = true;
    console.log("[NativeDebuggerHost] Ready (F12 to toggle)");
  }

  /** Toggle visibility. */
  toggle(): void {
    this._visible = !this._visible;
    if (this._visible) {
      console.log("[NativeDebuggerHost] Debugger visible");
    } else {
      console.log("[NativeDebuggerHost] Debugger hidden");
    }
  }

  /** Show the debugger. */
  show(): void { this._visible = true; }

  /** Hide the debugger. */
  hide(): void { this._visible = false; }

  /** Per-frame update: pump CDP events, refresh the scene, render the debug overlay. */
  update(): void {
    if (!this._ready || this.disposed) return;
    if (!this._visible) return;
    // Update the scene (rebuilds the view + collects hit regions).
    try {
      this.scene?.update();
    } catch (err) {
      console.error("[NativeDebuggerHost] Scene update error:", err);
    }
    // Render the debug overlay into its GPUTexture (must be before the blit).
    try {
      this.debugPixiUi?.render();
    } catch (err) {
      console.error("[NativeDebuggerHost] Debug render error:", err);
    }
  }

  /** The debug overlay's UI texture view (for the renderer's blit pass). */
  getUiTextureView(): GPUTextureView | null {
    if (!this.debugPixiUi) return null;
    return this.debugPixiUi.getUiTextureView();
  }

  /** Encode the debug overlay blit into the command encoder. Called by the renderer. */
  blit(commandEncoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    if (!this._visible || !this.blitPass) return;
    const uiView = this.getUiTextureView();
    if (!uiView) return;
    this.blitPass.execute(commandEncoder, targetView, uiView);
  }

  /** Handle a pointerdown event. Returns true if consumed by the debugger. */
  handlePointerDown(x: number, y: number, _button: number, _modifiers: number): boolean {
    if (!this._visible || !this.scene) return false;
    return this.scene.handlePointerDown(x, y);
  }

  /** Handle a pointermove event. Returns true if consumed. */
  handlePointerMove(x: number, y: number, _button: number, _modifiers: number): boolean {
    if (!this._visible) return false;
    // Forward to the scene for drag handling
    return this.scene?.handlePointerMove(x, y) ?? false;
  }

  /** Handle a pointerup event. Returns true if consumed. */
  handlePointerUp(x: number, y: number, _button: number, _modifiers: number): boolean {
    if (!this._visible) return false;
    // Forward to the scene for drag end handling
    return this.scene?.handlePointerUp(x, y) ?? false;
  }

  /** Resize the debug overlay. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.debugPixiUi?.resize(width, height);
    this.scene?.resize(width, height);
  }

  /** Dispose — close CDP session, destroy debug pixi host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.cdp.dispose(); } catch { /* ignore */ }
    try { this.scene?.dispose(); } catch { /* ignore */ }
    try { this.debugPixiUi?.dispose(); } catch { /* ignore */ }
    this.scene = null;
    this.debugPixiUi = null;
    this.blitPass = null;
  }
}
