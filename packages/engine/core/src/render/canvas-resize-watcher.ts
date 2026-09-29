import type { RenderSurface } from "../platform/render-surface";

export interface CanvasResizeHandler {
  onResize(cssWidth: number, cssHeight: number, dpr: number): void;
}

export class CanvasResizeWatcher {
  private observer: ResizeObserver | null = null;
  private dpr = 1;
  private onSurfaceResize = () => this.resize();

  constructor(
    private canvas: RenderSurface,
    private handler: CanvasResizeHandler,
  ) {
    this.dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 0) || 1;
    // DOM hosts: element box changes fire ResizeObserver. Native surfaces
    // aren't Elements — they push a "resize" event instead. Both paths feed
    // the same resize() so either host drives layout updates.
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(canvas as unknown as Element);
    }
    canvas.addEventListener("resize", this.onSurfaceResize);
    this.resize();
  }

  private resize(): void {
    this.handler.onResize(this.canvas.clientWidth, this.canvas.clientHeight, this.dpr);
  }

  setDpr(dpr: number): void {
    this.dpr = dpr;
    this.resize();
  }

  getDpr(): number {
    return this.dpr;
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.canvas.removeEventListener("resize", this.onSurfaceResize);
  }
}
