import type { RenderSurface } from "../platform/render-surface";

export interface CanvasResizeHandler {
  onResize(cssWidth: number, cssHeight: number, dpr: number): void;
}

export class CanvasResizeWatcher {
  private dpr = 1;
  private onSurfaceResize = () => this.resize();

  constructor(
    private canvas: RenderSurface,
    private handler: CanvasResizeHandler,
  ) {
    this.dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 0) || 1;
    // Native surfaces push a "resize" event when the backing store changes.
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
    this.canvas.removeEventListener("resize", this.onSurfaceResize);
  }
}
