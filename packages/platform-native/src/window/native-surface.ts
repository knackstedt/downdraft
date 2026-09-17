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

import { MiniEventTarget } from "../dom/mini-event-target";
import { parseFormat } from "../gpu/enums";
import { wgpu } from "../gpu/wgpu-ffi";
import { WgpuDevice, WgpuTexture } from "../gpu/wgpu-wrapper";

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
    return this.currentTexture;
  }

  present(): void {
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
    this._width = width;
    this._height = height;
    this.context?.resize(width, height);
    this.dispatchEvent({ type: "resize", width, height });
  }

  getSurfacePtr(): number { return this.surfacePtr; }
}
