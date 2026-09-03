/**
 * Get the current device pixel ratio (DPR), safely callable from any context
 * (returns 1 in non-browser environments like Web Workers without `window`).
 *
 * Games use this to scale layout constants (tile sizes, HUD margins, grid cell
 * sizes) so they render correctly on high-DPI mobile displays and Retina
 * desktops. Equivalent to `window.devicePixelRatio || 1` but worker-safe.
 */
export function getDpr(): number {
  if (typeof window !== "undefined" && typeof window.devicePixelRatio === "number") {
    return window.devicePixelRatio;
  }
  return 1;
}

export class HiDPIManager {
  private scaleFactor: number = 1;
  private handlers: Array<(scale: number) => void> = [];

  detectScaleFactor(): number {
    if (typeof window !== "undefined" && typeof window.devicePixelRatio === "number") {
      return window.devicePixelRatio;
    }
    if (typeof process !== "undefined" && process.platform) {
      if (process.platform === "darwin") {
        return 2;
      }
      if (process.platform === "win32") {
        return 1;
      }
      if (process.platform === "linux") {
        return 1;
      }
    }
    return 1;
  }

  getScaleFactor(): number {
    return this.scaleFactor;
  }

  setScaleFactor(scale: number): void {
    if (scale === this.scaleFactor) return;
    this.scaleFactor = scale;
    for (let i = 0; i < this.handlers.length; i++) {
      this.handlers[i](scale);
    }
  }

  onScaleChange(fn: (scale: number) => void): void {
    this.handlers.push(fn);
  }

  init(): void {
    this.scaleFactor = this.detectScaleFactor();
  }
}
