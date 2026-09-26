// ============================================================================
// native-surface.ts — HTMLCanvasElement-compatible surface backed by SDL2 + wgpu
//
// Implements the subset of HTMLCanvasElement that the engine's SurfaceManager
// and CanvasResizeWatcher need:
//   - width / height properties
//   - getContext("webgpu") → returns a NativeCanvasContext
//   - addEventListener / removeEventListener
//   - clientWidth / clientHeight
//
// The NativeCanvasContext implements GPUCanvasContext:
//   - configure({ device, format, ... })
//   - getCurrentTexture() → returns the swapchain texture
//   - unconfigure()
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { MiniEventTarget } from "../dom/mini-event-target";
import { parseFormat } from "../gpu/enums";
import { wgpu } from "../gpu/wgpu-ffi";
import { WgpuDevice, WgpuTexture } from "../gpu/wgpu-wrapper";
import { encodePNG } from "../screenshot/screenshot";

const log = createLogger("info");

// Note: no `implements GPUCanvasContext` — @webgpu/types brands the interface
// (declare const __brand), so structural conformance is impossible. Conformance
// is enforced at the boundary instead.
export class NativeCanvasContext {
  private surfacePtr: number = 0;
  private device: WgpuDevice | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private usage: number = 0x0010 | 0x0001; // RENDER_ATTACHMENT | COPY_SRC (for screenshots)
  private width: number = 0;
  private height: number = 0;
  private configured: boolean = false;
  private currentTexture: WgpuTexture | null = null;

  constructor(surfacePtr: number) {
    this.surfacePtr = surfacePtr;
  }

  configure(config: GPUCanvasConfiguration): void {
    this.device = config.device as unknown as WgpuDevice;
    this.format = config.format;
    this.usage = config.usage ?? (0x0010 | 0x0001); // RENDER_ATTACHMENT | COPY_SRC

    const formatNum = parseFormat(this.format);
    const presentMode = 0; // FIFO (vsync)
    wgpu.wgpu_shim_surface_configure(
      this.surfacePtr,
      this.device.ptr,
      formatNum,
      this.usage,
      this.width,
      this.height,
      presentMode,
    );
    this.configured = true;
  }

  /** The format passed to the most recent configure() call. */
  getFormat(): GPUTextureFormat | null {
    return this.configured ? this.format : null;
  }

  /**
   * The device from the most recent configure() call. Renderers may create
   * their own device (GameRenderer.init does) and reconfigure the surface —
   * readback/copy machinery MUST use this device, not the host's, or the
   * copy validates as cross-device usage and panics wgpu-native.
   */
  getDevice(): WgpuDevice | null {
    return this.device;
  }

  unconfigure(): void {
    // Destroy any acquired-but-unpresented surface texture first — releasing
    // the surface while a SurfaceTexture is alive panics in wgpu-hal
    // ("destroy a SwapchainAcquireSemaphore that is still in use").
    try { (this.currentTexture as any)?.destroy?.(); } catch { /* best-effort */ }
    this.currentTexture = null;
    if (this.configured && this.surfacePtr) {
      try { wgpu.wgpu_shim_surface_unconfigure(this.surfacePtr); } catch { /* best-effort */ }
    }
    this.configured = false;
    this.device = null;
  }

  getCurrentTexture(): WgpuTexture | null {
    if (!this.configured || !this.surfacePtr) return null;

    // Return cached texture if we already acquired one this frame.
    // wgpu-native only allows one outstanding surface texture at a time;
    // calling getCurrentTexture again before present() is a validation error.
    if (this.currentTexture) return this.currentTexture;

    // Use a pointer to receive the texture handle
    const outPtr = new BigUint64Array(1);
    const status = wgpu.wgpu_shim_surface_get_current_texture(this.surfacePtr, outPtr as any);
    const texPtr = Number(outPtr[0]);

    // Status 0 = success, other statuses may still have a valid texture
    if (texPtr === 0) return null;

    this.currentTexture = new WgpuTexture(texPtr, {
      size: { width: this.width, height: this.height },
      format: this.format,
      usage: this.usage,
    });
    this.currentTexture.__ddWritten = false;
    return this.currentTexture;
  }

  // ── Pre-present hooks ──
  // One-shot callbacks fired inside present(), while the surface texture is
  // still acquired-and-unpresented — the ONLY point where reading the
  // swapchain texture is guaranteed valid. Screenshot/readback consumers
  // (canvas.toBlob, downdraft.capturePage, MCP capture_screenshot) defer
  // their copy here instead of racing the render loop.
  private prePresentHooks: Array<() => void> = [];

  /** Register a one-shot callback fired just before the next present().
   *  Returns an unsubscribe function. */
  onBeforePresent(cb: () => void): () => void {
    this.prePresentHooks.push(cb);
    return () => {
      const i = this.prePresentHooks.indexOf(cb);
      if (i >= 0) this.prePresentHooks.splice(i, 1);
    };
  }

  present(): void {
    // Nothing acquired this frame → nothing to present. Games with
    // dirty-tracking (e.g. mining-rpg) skip all render work on idle frames
    // and rely on the canvas retaining the last presented frame. Calling
    // wgpuSurfacePresent without an outstanding surface texture presents
    // an empty swapchain image (black), so skip it — and keep pre-present
    // hooks queued for the next frame that actually draws.
    if (!this.currentTexture) return;
    // Acquired but never written (e.g. GameRenderer acquired the texture
    // for a viewport, then the game's dirty-tracking skipped all draws).
    // Presenting it would show a blank frame — skip the present so the
    // swapchain retains the last real frame. Keep the texture outstanding:
    // the next getCurrentTexture() returns it, a later frame can still
    // draw into it, and pre-present hooks stay queued for a real frame.
    if (!this.currentTexture.__ddWritten) return;
    // Run pending pre-present work (e.g. screenshot copies) while the
    // texture is still valid — submissions queued here precede the present.
    if (this.prePresentHooks.length > 0) {
      const hooks = this.prePresentHooks.splice(0);
      for (const cb of hooks) {
        try { cb(); } catch (e) { log.error("surface", `pre-present hook error: ${e}`); }
      }
    }
    if (this.surfacePtr) {
      wgpu.wgpu_shim_surface_present(this.surfacePtr);
    }
    // Clear the cached texture — the next getCurrentTexture() will acquire a new one
    this.currentTexture = null;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    // The previously acquired surface texture is stale after a resize —
    // destroy it so getCurrentTexture() re-acquires at the new size.
    try { (this.currentTexture as any)?.destroy?.(); } catch { /* best-effort */ }
    this.currentTexture = null;
    if (this.configured && this.device) {
      const formatNum = parseFormat(this.format);
      wgpu.wgpu_shim_surface_configure(
        this.surfacePtr,
        this.device.ptr,
        formatNum,
        this.usage,
        width,
        height,
        0, // FIFO
      );
    }

  }
}

export class NativeSurface extends MiniEventTarget {
  private _width: number;
  private _height: number;
  private context: NativeCanvasContext | null = null;
  private surfacePtr: number;
  private _pointerLocked = false;
  /** CSSStyleDeclaration stand-in — renderers set style props (opacity,
   *  cursor, imageRendering); all writes are no-ops under SDL. */
  readonly style: Record<string, any> = {};
  /** Canvas id (renderers query element ids for multi-canvas setups). */
  id = "game-canvas";

  constructor(width: number, height: number, surfacePtr: number) {
    super();
    this._width = width;
    this._height = height;
    this.surfacePtr = surfacePtr;
    this.context = new NativeCanvasContext(surfacePtr);
    this.context["resize"](width, height);
  }

  get width(): number { return this._width; }
  get height(): number { return this._height; }
  // HTMLCanvasElement semantics: assigning width/height resizes the backing
  // store. Without these setters `canvas.width = w` (GameRenderer.onResize)
  // silently no-ops and the UI/render layout stays at the stale size while
  // the swapchain tracks the real window size — the frame ends up uniformly
  // stretched, which reads as blurry text and edges.
  set width(w: number) { this.setSize(w, this._height); }
  set height(h: number) { this.setSize(this._width, h); }
  get clientWidth(): number { return this._width; }
  get clientHeight(): number { return this._height; }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this._width, height: this._height };
  }

  get pointerLocked(): boolean { return this._pointerLocked; }

  requestPointerLock(): Promise<void> | void {
    this._pointerLocked = true;
    // Grab mouse + keyboard via SDL
    const win = (globalThis as any).__nativeWindow;
    if (win?.grabInput) win.grabInput(true);
    // Update document.pointerLockElement to point to this canvas
    const doc = (globalThis as any).document;
    if (doc) doc.pointerLockElement = this;
    // Dispatch pointerlockchange on document
    (doc as any)?.__events?.dispatchEvent({ type: "pointerlockchange" });
    this.dispatchEvent({ type: "pointerlockchange" });
  }

  exitPointerLock(): void {
    this._pointerLocked = false;
    // Release grab
    const win = (globalThis as any).__nativeWindow;
    if (win?.grabInput) win.grabInput(false);
    const doc = (globalThis as any).document;
    if (doc) doc.pointerLockElement = null;
    (doc as any)?.__events?.dispatchEvent({ type: "pointerlockchange" });
    this.dispatchEvent({ type: "pointerlockchange" });
  }

  // The engine's SurfaceManager calls canvas.getContext("webgpu")
  getContext(contextId: string): NativeCanvasContext | null {
    if (contextId === "webgpu") return this.context;
    return null;
  }

  resize(width: number, height: number): void {
    this.setSize(width, height);
    this.dispatchEvent({ type: "resize", width, height });
  }

  /** Update backing dims + reconfigure the wgpu surface (no event). */
  private setSize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;
    this.context?.resize(width, height);
  }

  getSurfacePtr(): number { return this.surfacePtr; }

  // ── Pixel readback (canvas.toBlob / drawImage sources) ──
  //
  // Reading the swapchain texture is only valid inside a frame, before
  // present(). The host injects `readbackHook` (the GPU copy machinery);
  // `captureNextFrame()` defers the copy into the next pre-present hook and
  // caches the result. `getPixelData()`/`drawImage` consumers get the cache;
  // async consumers (toBlob, capturePage) await the next frame.
  private readbackHook: (() => Uint8Array | null) | null = null;
  private lastPixels: Uint8Array | null = null;
  private captureInFlight: Promise<Uint8Array | null> | null = null;

  /** Called by createNativeHost after the device + context are configured. */
  setReadbackHook(hook: () => Uint8Array | null): void {
    this.readbackHook = hook;
  }

  /**
   * Capture the next presented frame as tightly-packed RGBA8. The copy runs
   * inside the context's pre-present hook — the only point where the surface
   * texture is valid. Resolves with the last captured frame on timeout
   * (paused render loop) or null if no capture has ever succeeded.
   */
  captureNextFrame(timeoutMs = 3000): Promise<Uint8Array | null> {
    if (this.captureInFlight) return this.captureInFlight;
    const hook = this.readbackHook;
    if (!hook) return Promise.resolve(this.lastPixels);
    this.captureInFlight = new Promise<Uint8Array | null>((resolve) => {
      const ctx = this.context;
      if (!ctx) { this.captureInFlight = null; resolve(this.lastPixels); return; }
      let done = false;
      const finish = (v: Uint8Array | null) => {
        if (done) return;
        done = true;
        this.captureInFlight = null;
        resolve(v);
      };
      const unsub = ctx.onBeforePresent(() => {
        unsub();
        let pixels: Uint8Array | null = null;
        try { pixels = hook(); } catch { /* readback failed */ }
        if (pixels) this.lastPixels = pixels;
        finish(pixels ?? this.lastPixels);
      });
      setTimeout(() => { unsub(); finish(this.lastPixels); }, timeoutMs).unref?.();
    });
    return this.captureInFlight;
  }

  /** Pixels of the most recent captured frame (drawImage-compatible), or null
   *  before the first async capture completes. */
  getPixelData(): Uint8Array | null {
    return this.lastPixels;
  }

  toBlob(callback: (blob: Blob | null) => void, _type?: string, _quality?: number): void {
    void this.captureNextFrame().then((pixels) => {
      if (!pixels) { callback(null); return; }
      callback(new Blob([new Uint8Array(encodePNG(this._width, this._height, pixels))], { type: "image/png" }));
    });
  }

  toDataURL(_type?: string, _quality?: number): string {
    const pixels = this.lastPixels;
    if (!pixels) return "data:,";
    const png = encodePNG(this._width, this._height, pixels);
    return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  }
}
