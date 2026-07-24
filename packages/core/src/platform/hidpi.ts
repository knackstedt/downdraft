export class HiDPIManager {
  private scaleFactor: number = 1;
  private handlers: Array<(scale: number) => void> = [];

  detectScaleFactor(): number {
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
