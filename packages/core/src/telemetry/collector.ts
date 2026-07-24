export interface ThreadMetrics {
  threadName: string;
  gcPauseTotal: number;
  gcPauseCount: number;
  gcPauseMax: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  cpuTime: number;
  tick: number;
}

export interface SystemTiming {
  name: string;
  durationMs: number;
}

export class TelemetryCollector {
  private enabled: boolean;
  private threadMetrics: Map<string, ThreadMetrics> = new Map();
  private systemTimings: SystemTiming[] = [];
  private frameTimes: number[] = [];
  private maxFrameHistory: number = 300;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordFrame(frameTimeMs: number): void {
    if (!this.enabled) return;
    this.frameTimes.push(frameTimeMs);
    if (this.frameTimes.length > this.maxFrameHistory) {
      this.frameTimes.shift();
    }
  }

  recordSystemTiming(name: string, durationMs: number): void {
    if (!this.enabled) return;
    this.systemTimings.push({ name, durationMs });
    if (this.systemTimings.length > 1000) {
      this.systemTimings.shift();
    }
  }

  updateThreadMetrics(threadName: string, metrics: Partial<ThreadMetrics>): void {
    if (!this.enabled) return;
    const existing = this.threadMetrics.get(threadName);
    if (existing) {
      Object.assign(existing, metrics);
    } else {
      this.threadMetrics.set(threadName, {
        threadName,
        gcPauseTotal: 0,
        gcPauseCount: 0,
        gcPauseMax: 0,
        heapUsed: 0,
        heapTotal: 0,
        rss: 0,
        cpuTime: 0,
        tick: 0,
        ...metrics,
      });
    }
  }

  getThreadMetrics(): ThreadMetrics[] {
    return [...this.threadMetrics.values()];
  }

  getSystemTimings(): SystemTiming[] {
    return [...this.systemTimings];
  }

  getFrameTimes(): number[] {
    return [...this.frameTimes];
  }

  getAverageFrameTime(): number {
    if (this.frameTimes.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.frameTimes.length; i++) {
      sum += this.frameTimes[i];
    }
    return sum / this.frameTimes.length;
  }

  getFrameTimePercentile(p: number): number {
    if (this.frameTimes.length === 0) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  reset(): void {
    this.frameTimes.length = 0;
    this.systemTimings.length = 0;
    this.threadMetrics.clear();
  }
}
