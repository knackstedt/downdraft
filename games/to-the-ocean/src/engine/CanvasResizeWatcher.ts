export interface CanvasResizeHandler {
  onResize(cssWidth: number, cssHeight: number, dpr: number): void;
}

export class CanvasResizeWatcher {
  private observer: ResizeObserver | null = null;
  private dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private handler: CanvasResizeHandler,
  ) {
    this.dpr = window.devicePixelRatio || 1;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
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
  }
}
