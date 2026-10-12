import type { RenderSurface } from "../platform/render-surface";

export interface CanvasResizeHandler {
  onResize(cssWidth: number, cssHeight: number, dpr: number): void;
}

export class CanvasResizeWatcher {
  private dpr = 1;
  /** Explicit override via setDpr — 0 means "track the host's live ratio". */
  private dprOverride = 0;
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
    // Re-read devicePixelRatio on every resize — on the native host it's a
    // live query (the current monitor's scale factor), so this self-heals
    // when the window crosses between differently-scaled monitors. A cached
    // ratio silently diverges from the surface's clientWidth (which divides
    // the physical extent by the live factor), sizing the swapchain to the
    // wrong extent — wgpu then reports Outdated on every acquire forever.
    const live = (typeof window !== "undefined" ? window.devicePixelRatio : 0) || 0;
    this.dpr = this.dprOverride > 0 ? this.dprOverride : (live > 0 ? live : this.dpr);
    this.handler.onResize(this.canvas.clientWidth, this.canvas.clientHeight, this.dpr);
  }

  /** Pin the ratio explicitly (tests, forced-DPR harnesses). 0 resumes
   *  live tracking. */
  setDpr(dpr: number): void {
    this.dprOverride = dpr;
    this.resize();
  }

  getDpr(): number {
    return this.dpr;
  }

  destroy(): void {
    this.canvas.removeEventListener("resize", this.onSurfaceResize);
  }
}
