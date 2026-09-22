// ============================================================================
// virtual-canvas-context.ts — texture-backed GPUCanvasContext for PixiJS
//
// PixiJS v8's WebGPU render target calls `canvas.getContext("webgpu")` and
// expects a GPUCanvasContext with `configure()`, `getCurrentTexture()`, and
// `unconfigure()`. In the browser the context is backed by the swapchain.
// In native mode the game already owns the one swapchain (NativeSurface), so
// a second renderer (PixiJS) must render into a *dedicated* GPUTexture that
// the game then samples in a compositing blit pass.
//
// VirtualCanvasContext owns that dedicated texture on the shared wgpu-native
// device. `getCurrentTexture()` returns the same persistent texture each
// frame (recreated only on resize); PixiJS clears it via loadOp:"clear" every
// frame, so there is no accumulation. Because the texture lives on the same
// device/queue as the game, the game can sample it directly — zero copy.
//
// VirtualCanvas is the HTMLCanvasElement-shaped object PixiJS holds: it has
// width/height/style, getContext("webgpu") → VirtualCanvasContext, and
// getContext("2d") → a FreeType-backed NativeCanvas2D (for PixiJS text
// rasterization via DOMAdapter.get().createCanvas()).
// ============================================================================

import { MiniEventTarget } from "../dom/mini-event-target";
import { NativeCanvas2D, NativeImageBitmap } from "../image/native-image";
import { captureScreenshotPixels, encodePNG } from "../screenshot/screenshot";
import type { WgpuDevice, WgpuTexture, WgpuTextureView } from "./wgpu-wrapper";

export interface VirtualCanvasConfig {
  format: GPUTextureFormat;
  usage: number;
  alphaMode: GPUCanvasAlphaMode;
}

/**
 * A GPUCanvasContext backed by a persistent GPUTexture (not a swapchain).
 * Used by PixiJS to render the UI into a texture the game composites.
 */
export class VirtualCanvasContext {
  private device: WgpuDevice | null = null;
  private config: VirtualCanvasConfig | null = null;
  private texture: WgpuTexture | null = null;
  private textureView: WgpuTextureView | null = null;
  private textureWidth = 0;
  private textureHeight = 0;
  // The canvas dimensions are pushed in via resize() / configure().
  private canvasWidth: number;
  private canvasHeight: number;

  constructor(canvasWidth: number, canvasHeight: number) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
  }

  configure(config: GPUCanvasConfiguration): void {
    this.device = config.device as unknown as WgpuDevice;
    this.config = {
      format: config.format,
      // PixiJS requests TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT | COPY_SRC.
      usage: config.usage ?? (
        0x0004 | // TEXTURE_BINDING
        0x0008 | // COPY_DST  (GPUTextureUsage — matches install.ts constants)
        0x0010 | // RENDER_ATTACHMENT
        0x0001   // COPY_SRC
      ),
      alphaMode: (config.alphaMode ?? "opaque") as GPUCanvasAlphaMode,
    };
    // (Re)create the texture immediately so the first getCurrentTexture() is
    // ready and sized correctly.
    this.ensureTexture();
  }

  unconfigure(): void {
    this.releaseView();
    if (this.texture) {
      try { this.texture.destroy(); } catch { /* ignore */ }
      this.texture = null;
    }
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.device = null;
    this.config = null;
  }

  private releaseView(): void {
    if (this.textureView) {
      try { this.textureView.release(); } catch { /* ignore */ }
      this.textureView = null;
    }
  }

  getCurrentTexture(): WgpuTexture | null {
    if (!this.device || !this.config) return null;
    return this.ensureTexture();
  }

  /** The texture the game samples in its compositing blit pass. */
  getUiTexture(): WgpuTexture | null {
    return this.texture;
  }

  /**
   * A view of the UI texture for the blit pass's sampler binding.
   * Cached — the previous implementation created a new native texture view
   * every frame and leaked each one.
   */
  getUiTextureView(): WgpuTextureView | null {
    const tex = this.ensureTexture();
    if (!tex) return null;
    if (this.textureView) return this.textureView;
    try {
      this.textureView = tex.createView({ dimension: "2d", format: this.config!.format });
      return this.textureView;
    } catch {
      return null;
    }
  }

  getFormat(): GPUTextureFormat | null {
    return this.config?.format ?? null;
  }

  /**
   * Read back the UI texture as tightly-packed RGBA8. Powers
   * VirtualCanvas.toBlob/getPixelData for screenshots and thumbnails.
   * Returns null before configure() or while no texture exists.
   */
  getPixelData(): Uint8Array | null {
    if (!this.device || !this.texture) return null;
    return captureScreenshotPixels(this.device, this.texture, this.textureWidth, this.textureHeight, this.config?.format);
  }

  /** Called by VirtualCanvas when width/height change. */
  resize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    // ensureTexture() will recreate on next access if dimensions changed.
  }

  destroy(): void {
    this.unconfigure();
  }

  private ensureTexture(): WgpuTexture | null {
    if (!this.device || !this.config) return null;
    const w = Math.max(1, Math.floor(this.canvasWidth));
    const h = Math.max(1, Math.floor(this.canvasHeight));
    // Recreate if missing or size changed.
    if (this.texture && this.textureWidth === w && this.textureHeight === h) {
      return this.texture;
    }
    if (this.texture) {
      this.releaseView();
      try { this.texture.destroy(); } catch { /* ignore */ }
      this.texture = null;
    }
    try {
      this.texture = this.device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: this.config.format,
        usage: this.config.usage,
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: "2d",
      });
      this.textureWidth = w;
      this.textureHeight = h;
    } catch (err) {
      console.error("[VirtualCanvasContext] Failed to create UI texture:", err);
      this.texture = null;
    }
    return this.texture;
  }
}

/**
 * HTMLCanvasElement-shaped canvas for PixiJS. `getContext("webgpu")` returns
 * a VirtualCanvasContext (texture-backed); `getContext("2d")` returns a
 * FreeType-backed NativeCanvas2D (for text rasterization).
 */
export class VirtualCanvas extends MiniEventTarget {
  private _width: number;
  private _height: number;
  style: Record<string, string> = {};
  private webgpuContext: VirtualCanvasContext;
  private ctx2d: NativeCanvas2D | null = null;

  constructor(width: number, height: number) {
    super();
    this._width = width;
    this._height = height;
    this.webgpuContext = new VirtualCanvasContext(width, height);
  }

  /** Setting width (like a real canvas) clears the 2D context and
   *  resizes the WebGPU backing texture. */
  get width(): number { return this._width; }
  set width(v: number) {
    if (this._width !== v) {
      this._width = v;
      this.ctx2d = null;
      this.webgpuContext.resize(this._width, this._height);
    }
  }
  get height(): number { return this._height; }
  set height(v: number) {
    if (this._height !== v) {
      this._height = v;
      this.ctx2d = null;
      this.webgpuContext.resize(this._width, this._height);
    }
  }

  get clientWidth(): number { return this.width; }
  get clientHeight(): number { return this.height; }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }

  getContext(contextId: "webgpu" | "2d" | string): any {
    if (contextId === "webgpu") return this.webgpuContext;
    if (contextId === "2d") {
      if (!this.ctx2d || this.ctx2d.width !== this._width || this.ctx2d.height !== this._height) {
        this.ctx2d = new NativeCanvas2D(this._width, this._height);
      }
      return this.ctx2d;
    }
    return null;
  }

  /** Transfer the 2D context's pixels to an ImageBitmap (for PixiJS text textures). */
  transferToImageBitmap(): NativeImageBitmap | null {
    if (this.ctx2d) {
      const pixels = new Uint8Array(this.ctx2d["pixels"].length);
      pixels.set(this.ctx2d["pixels"]);
      return new NativeImageBitmap(this._width, this._height, pixels);
    }
    return null;
  }

  /** PixiJS may call this; we are not offscreen-transferable — return self. */
  transferControlToOffscreen(): VirtualCanvas {
    return this;
  }

  setAttribute(_key: string, _value: string): void {}
  getAttribute(_key: string): string | null { return null; }
  appendChild(_node: any): any { return _node; }
  removeChild(_node: any): any { return _node; }
  contains(_node: any): boolean { return false; }

  // ── Pixel readback (canvas.toBlob / drawImage sources) ──
  // Prefers the 2D context's pixels when one exists (text/shape canvases);
  // otherwise reads back the persistent WebGPU texture. Encoding is always
  // PNG regardless of the requested MIME.
  getPixelData(): Uint8Array | null {
    if (this.ctx2d) {
      return new Uint8Array(this.ctx2d["pixels"].buffer.slice(0));
    }
    return this.webgpuContext.getPixelData();
  }

  toBlob(callback: (blob: Blob | null) => void, _type?: string, _quality?: number): void {
    const pixels = this.getPixelData();
    if (!pixels) { callback(null); return; }
    callback(new Blob([new Uint8Array(encodePNG(this._width, this._height, pixels))], { type: "image/png" }));
  }

  toDataURL(_type?: string, _quality?: number): string {
    const pixels = this.getPixelData();
    if (!pixels) return "data:,";
    const png = encodePNG(this._width, this._height, pixels);
    return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  }
  focus(): void {}
  blur(): void {}
  click(): void {}
  remove(): void {}

  resize(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this.ctx2d = null;
    this.webgpuContext.resize(width, height);
    this.dispatchEvent({ type: "resize", width, height });
  }

  /** Expose the WebGPU context so the host can read the UI texture. */
  getWebgpuContext(): VirtualCanvasContext { return this.webgpuContext; }

  destroy(): void {
    this.webgpuContext.destroy();
    this.clearListeners();
  }
}
