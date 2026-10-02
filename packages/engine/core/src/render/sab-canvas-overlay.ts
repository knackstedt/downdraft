// ============================================================================
// SabCanvasOverlay — DOM <canvas> overlay backed by a SharedArrayBuffer bitmap
//
// Generalized from overburden's MapCanvas. Provides the generic shell:
//   - A visible <canvas> fixed-positioned over the game canvas
//     (pointer-events: none, configurable z-index, hidden while opacity <= 0).
//   - An offscreen "bitmap" canvas at a fixed data resolution that is repainted
//     only when a SAB sequence counter changes (via getSeq + redrawBitmap).
//   - Per-frame window resize tracking and opacity control.
//
// The game supplies the compositing + drawing logic via callbacks; the overlay
// owns all DOM plumbing.
// ============================================================================

export interface SabCanvasOverlayOptions {
  /** DOM id for the visible canvas. Default: "sab-canvas-overlay" */
  id?: string;
  /** CSS z-index. Default: 55 (above the game surface, below DOM overlays) */
  zIndex?: number;
  /** Offscreen bitmap resolution. If omitted, no bitmap canvas is created. */
  bitmapWidth?: number;
  bitmapHeight?: number;
  /** CSS image-rendering for the visible canvas. Default: "pixelated" */
  imageRendering?: "pixelated" | "auto";
  /**
   * Monotonic sequence number for the backing data (e.g. a SAB seq counter).
   * The bitmap is repainted only when this value changes. Omit to repaint
   * every visible frame.
   */
  getSeq?: () => number;
  /**
   * Repaint the offscreen bitmap canvas. Called only when getSeq() reports
   * a new value (requires bitmapWidth/bitmapHeight).
   */
  redrawBitmap?: (ctx: CanvasRenderingContext2D, bitmapW: number, bitmapH: number) => void;
  /**
   * Draw the visible canvas each visible frame, after the bitmap has been
   * refreshed. `bitmap` is the offscreen bitmap canvas (or null when no
   * bitmap was configured).
   */
  draw: (ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement | null, w: number, h: number) => void;
}

export class SabCanvasOverlay {
  readonly canvas: HTMLCanvasElement;
  protected ctx: CanvasRenderingContext2D;
  /** Offscreen bitmap canvas (fixed data resolution). Null when unconfigured. */
  readonly bitmapCanvas: HTMLCanvasElement | null = null;
  protected bitmapCtx: CanvasRenderingContext2D | null = null;
  private opts: SabCanvasOverlayOptions;
  private lastSeq = -1;

  constructor(opts: SabCanvasOverlayOptions) {
    this.opts = opts;

    this.canvas = document.createElement("canvas");
    this.canvas.id = opts.id ?? "sab-canvas-overlay";
    this.canvas.style.position = "fixed";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.zIndex = String(opts.zIndex ?? 55);
    this.canvas.style.display = "none"; // hidden until opacity > 0
    this.canvas.style.imageRendering = opts.imageRendering ?? "pixelated";
    this.ctx = this.canvas.getContext("2d")!;

    if (opts.bitmapWidth !== undefined && opts.bitmapHeight !== undefined) {
      this.bitmapCanvas = document.createElement("canvas");
      this.bitmapCanvas.width = opts.bitmapWidth;
      this.bitmapCanvas.height = opts.bitmapHeight;
      this.bitmapCtx = this.bitmapCanvas.getContext("2d")!;
    }
  }

  /** Attach the canvas to the DOM (call once during init). */
  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.canvas);
  }

  /**
   * Per-frame update. Call from the render loop.
   * Hides the canvas while `opacity <= 0`; otherwise resizes the canvas to the
   * window, repaints the bitmap when the seq counter advanced, and invokes
   * the draw callback.
   */
  update(opacity: number): void {
    if (opacity <= 0) {
      this.canvas.style.display = "none";
      return;
    }
    this.canvas.style.display = "block";
    this.canvas.style.opacity = String(opacity);

    // Resize the visible canvas to match the window if needed.
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    // Repaint the bitmap if the backing data has a new seq value.
    const seq = this.opts.getSeq?.();
    if (this.bitmapCtx && (seq === undefined || seq !== this.lastSeq)) {
      if (seq !== undefined) this.lastSeq = seq;
      this.opts.redrawBitmap?.(this.bitmapCtx, this.bitmapCanvas!.width, this.bitmapCanvas!.height);
    }

    this.opts.draw(this.ctx, this.bitmapCanvas, w, h);
  }

  /** Mark the bitmap stale so it repaints on the next visible frame. */
  invalidate(): void {
    this.lastSeq = -1;
  }

  dispose(): void {
    this.canvas.remove();
  }
}
