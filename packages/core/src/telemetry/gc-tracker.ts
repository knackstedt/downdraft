export class GCTracker {
  private enabled: boolean = false;
  private pauseTotal: number = 0;
  private pauseCount: number = 0;
  private pauseMax: number = 0;
  private lastGcTime: number = 0;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordGcPause(durationMs: number): void {
    if (!this.enabled) return;
    this.pauseTotal += durationMs;
    this.pauseCount++;
    if (durationMs > this.pauseMax) {
      this.pauseMax = durationMs;
    }
    this.lastGcTime = performance.now();
  }

  getStats() {
    return {
      pauseTotal: this.pauseTotal,
      pauseCount: this.pauseCount,
      pauseMax: this.pauseMax,
      pauseAvg: this.pauseCount > 0 ? this.pauseTotal / this.pauseCount : 0,
      lastGcTime: this.lastGcTime,
    };
  }

  reset(): void {
    this.pauseTotal = 0;
    this.pauseCount = 0;
    this.pauseMax = 0;
    this.lastGcTime = 0;
  }

  static getCurrentMemory() {
    if (typeof process !== "undefined" && process.memoryUsage) {
      const mem = process.memoryUsage();
      return {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      };
    }
    // Browser fallback — performance.memory is non-standard but available in Chromium
    const perfMem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    if (perfMem) {
      return {
        heapUsed: perfMem.usedJSHeapSize,
        heapTotal: perfMem.totalJSHeapSize,
        rss: 0,
        external: 0,
      };
    }
    return { heapUsed: 0, heapTotal: 0, rss: 0, external: 0 };
  }
}
