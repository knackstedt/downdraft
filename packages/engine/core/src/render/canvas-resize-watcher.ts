import type { RenderSurface } from "../platform/render-surface";

export interface CanvasResizeHandler {
  onResize(cssWidth: number, cssHeight: number, dpr: number): void;
}

export class CanvasResizeWatcher {
  private dpr = 1;
  /** Explicit override via setDpr — 0 means "track the host's live ratio". */
  private dprOverride = 0;
  /** Dims/dpr handed to the handler on the last dispatch — poll() converges
   *  against these so a dropped "resize" event can't pin a stale aspect. */
  private lastW = -1;
  private lastH = -1;
  private lastDpr = -1;
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

  private effectiveDpr(): number {
    if (this.dprOverride > 0) return this.dprOverride;
    const live = (typeof window !== "undefined" ? window.devicePixelRatio : 0) || 0;
    return live > 0 ? live : this.dpr;
  }

  private resize(): void {
    // Re-read devicePixelRatio on every resize — on the native host it's a
    // live query (the current monitor's scale factor), so this self-heals
    // when the window crosses between differently-scaled monitors. A cached
    // ratio silently diverges from the surface's clientWidth (which divides
    // the physical extent by the live factor), sizing the swapchain to the
    // wrong extent — wgpu then reports Outdated on every acquire forever.
    this.dpr = this.effectiveDpr();
    this.lastW = this.canvas.clientWidth;
    this.lastH = this.canvas.clientHeight;
    this.lastDpr = this.dpr;
    this.handler.onResize(this.lastW, this.lastH, this.dpr);
  }

  /** Re-read the surface's CSS dims + live DPR and fire onResize only when
   *  they drifted from the last dispatch. Call once per frame (or per render
   *  tick) — native resize events are coalesced/re-emitted through several
   *  layers and a lost one otherwise leaves the camera aspect + viewports
   *  pinned at stale dims forever (e.g. maximize during a surface
   *  recreation, or an event eaten while the loop was wedged). */
  poll(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = this.effectiveDpr();
    if (w === this.lastW && h === this.lastH && dpr === this.lastDpr) return;
    this.dpr = dpr;
    this.lastW = w;
    this.lastH = h;
    this.lastDpr = dpr;
    this.handler.onResize(w, h, dpr);
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
