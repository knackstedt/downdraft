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

export interface DrawStats {
  drawCalls: number;
  triangles: number;
}

export interface PassTiming {
  name: string;
  cpuMs: number;
  gpuMs: number;
  drawCalls: number;
  triangles: number;
  pipelineSwitches: number;
  bindGroupChanges: number;
  bufferRebinds: number;
}

export interface ResourceStats {
  textureCount: number;
  bufferCount: number;
  totalBytes: number;
  textureBytes: number;
  bufferBytes: number;
  resources: ResourceEntry[];
}

export interface ResourceEntry {
  id: number;
  type: "texture" | "buffer";
  label: string;
  size: number;
  callsite?: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface TelemetrySnapshot {
  timestamp: number;
  label: string;
  frameTimes: number[];
  avgFrame: number;
  p95: number;
  p99: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  gpuTimeMs: number;
  heapUsed: number;
  heapTotal: number;
  passTimings: PassTiming[];
  resourceStats: ResourceStats | null;
}

export interface SnapshotDiff {
  metric: string;
  a: number;
  b: number;
  delta: number;
  deltaPct: number;
}

export interface FrameTelemetry {
  frameTimes: number[];
  avgFrameTime: number;
  p95: number;
  p99: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  gpuTimeMs: number;
}

export class TelemetryCollector {
  private enabled: boolean;
  private threadMetrics: Map<string, ThreadMetrics> = new Map();
  private systemTimings: SystemTiming[] = [];
  // Circular buffer for system timings — avoids O(n) array.shift().
  private sysTimingsBuf: SystemTiming[] = [];
  private sysTimingsHead: number = 0;
  private sysTimingsCount: number = 0;
  private readonly sysTimingsCap: number = 1000;
  // Circular buffer for frame times — avoids O(n) array.shift() on every frame.
  private frameTimesBuf: Float64Array;
  private frameTimesHead: number = 0; // next write position
  private frameTimesCount: number = 0; // number of valid entries (<= buf.length)
  // Reusable sorted copy for percentile calculations — avoids per-call allocation.
  private frameTimesSorted: Float64Array | null = null;
  private graphHistory: number[] = [];
  private maxGraphHistory: number = 120;
  private maxFrameHistory: number = 300;
  private drawStats: DrawStats = { drawCalls: 0, triangles: 0 };
  private lastDrawStats: DrawStats = { drawCalls: 0, triangles: 0 };
  private gpuTimeMs: number = 0;
  private passTimings: Map<string, PassTiming> = new Map();
  private maxPassTimings: number = 64;
  private resourceStats: ResourceStats | null = null;
  private snapshots: TelemetrySnapshot[] = [];
  private maxSnapshots: number = 10;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
    this.frameTimesBuf = new Float64Array(this.maxFrameHistory);
    for (let i = 0; i < this.sysTimingsCap; i++) {
      this.sysTimingsBuf.push({ name: "", durationMs: 0 });
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordFrame(frameTimeMs: number): void {
    if (!this.enabled) return;
    this.frameTimesBuf[this.frameTimesHead] = frameTimeMs;
    this.frameTimesHead = (this.frameTimesHead + 1) % this.frameTimesBuf.length;
    if (this.frameTimesCount < this.frameTimesBuf.length) this.frameTimesCount++;
  }

  recordSystemTiming(name: string, durationMs: number): void {
    if (!this.enabled) return;
    const slot = this.sysTimingsBuf[this.sysTimingsHead]!;
    slot.name = name;
    slot.durationMs = durationMs;
    this.sysTimingsHead = (this.sysTimingsHead + 1) % this.sysTimingsCap;
    if (this.sysTimingsCount < this.sysTimingsCap) this.sysTimingsCount++;
  }

  // Convenience wrapper: times fn() and records the result. Zero overhead when disabled.
  profile<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const start = performance.now();
    const result = fn();
    this.recordSystemTiming(name, performance.now() - start);
    return result;
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
    const result: SystemTiming[] = [];
    const start = (this.sysTimingsHead - this.sysTimingsCount + this.sysTimingsCap) % this.sysTimingsCap;
    for (let i = 0; i < this.sysTimingsCount; i++) {
      const slot = this.sysTimingsBuf[(start + i) % this.sysTimingsCap]!;
      result.push({ name: slot.name, durationMs: slot.durationMs });
    }
    return result;
  }

  getFrameTimes(): number[] {
    // Return a contiguous copy of the circular buffer contents
    const result: number[] = [];
    result.length = this.frameTimesCount;
    const start = (this.frameTimesHead - this.frameTimesCount + this.frameTimesBuf.length) % this.frameTimesBuf.length;
    for (let i = 0; i < this.frameTimesCount; i++) {
      result[i] = this.frameTimesBuf[(start + i) % this.frameTimesBuf.length];
    }
    return result;
  }

  getAverageFrameTime(): number {
    if (this.frameTimesCount === 0) return 0;
    let sum = 0;
    const start = (this.frameTimesHead - this.frameTimesCount + this.frameTimesBuf.length) % this.frameTimesBuf.length;
    for (let i = 0; i < this.frameTimesCount; i++) {
      sum += this.frameTimesBuf[(start + i) % this.frameTimesBuf.length];
    }
    return sum / this.frameTimesCount;
  }

  getFrameTimePercentile(p: number): number {
    if (this.frameTimesCount === 0) return 0;
    // Reuse a sorted copy buffer to avoid per-call allocation
    const count = this.frameTimesCount;
    if (!this.frameTimesSorted || this.frameTimesSorted.length < count) {
      this.frameTimesSorted = new Float64Array(count);
    }
    const sorted = this.frameTimesSorted;
    const start = (this.frameTimesHead - count + this.frameTimesBuf.length) % this.frameTimesBuf.length;
    for (let i = 0; i < count; i++) {
      sorted[i] = this.frameTimesBuf[(start + i) % this.frameTimesBuf.length];
    }
    // Sort only the valid portion in-place
    sorted.subarray(0, count).sort();
    const idx = Math.floor(count * p);
    return sorted[Math.min(idx, count - 1)];
  }

  recordDrawStats(drawCalls: number, triangles: number): void {
    if (!this.enabled) return;
    this.lastDrawStats = this.drawStats;
    this.drawStats = { drawCalls, triangles };
  }

  getDrawStats(): DrawStats {
    return { ...this.drawStats };
  }

  recordGpuTime(gpuTimeMs: number): void {
    if (!this.enabled) return;
    this.gpuTimeMs = gpuTimeMs;
  }

  getGpuTime(): number {
    return this.gpuTimeMs;
  }

  getMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number } {
    const main = this.threadMetrics.get("main");
    if (main) {
      return { heapUsed: main.heapUsed, heapTotal: main.heapTotal, rss: main.rss };
    }
    if (typeof performance !== "undefined" && (performance as any).memory) {
      const mem = (performance as any).memory;
      return { heapUsed: mem.usedJSHeapSize, heapTotal: mem.totalJSHeapSize, rss: 0 };
    }
    return { heapUsed: 0, heapTotal: 0, rss: 0 };
  }

  getFPS(): number {
    const avg = this.getAverageFrameTime();
    return avg > 0 ? Math.round(1000 / avg) : 0;
  }

  getFrameTelemetry(): FrameTelemetry | null {
    if (!this.enabled) return null;
    return {
      frameTimes: this.getFrameTimes(),
      avgFrameTime: this.getAverageFrameTime(),
      p95: this.getFrameTimePercentile(0.95),
      p99: this.getFrameTimePercentile(0.99),
      fps: this.getFPS(),
      drawCalls: this.drawStats.drawCalls,
      triangles: this.drawStats.triangles,
      gpuTimeMs: this.gpuTimeMs,
    };
  }

  recordPassTiming(timing: PassTiming): void {
    if (!this.enabled) return;
    const existing = this.passTimings.get(timing.name);
    if (existing) {
      Object.assign(existing, timing);
    } else {
      if (this.passTimings.size >= this.maxPassTimings) {
        const first = this.passTimings.keys().next().value ?? "";
        this.passTimings.delete(first);
      }
      this.passTimings.set(timing.name, { ...timing });
    }
  }

  getPassTimings(): PassTiming[] {
    const result: PassTiming[] = [];
    for (const p of this.passTimings.values()) {
      result.push({ ...p });
    }
    return result;
  }

  clearPassTimings(): void {
    this.passTimings.clear();
  }

  recordResourceStats(stats: ResourceStats): void {
    if (!this.enabled) return;
    this.resourceStats = { ...stats, resources: stats.resources.map((r) => ({ ...r })) };
  }

  getResourceStats(): ResourceStats | null {
    return this.resourceStats;
  }

  getGraphHistory(): number[] {
    return [...this.graphHistory];
  }

  recordGraphSample(frameTimeMs: number): void {
    this.graphHistory.push(frameTimeMs);
    if (this.graphHistory.length > this.maxGraphHistory) {
      this.graphHistory.shift();
    }
  }

  snapshot(label: string): TelemetrySnapshot {
    const mem = this.getMemoryUsage();
    return {
      timestamp: Date.now(),
      label,
      frameTimes: this.getFrameTimes(),
      avgFrame: this.getAverageFrameTime(),
      p95: this.getFrameTimePercentile(0.95),
      p99: this.getFrameTimePercentile(0.99),
      fps: this.getFPS(),
      drawCalls: this.drawStats.drawCalls,
      triangles: this.drawStats.triangles,
      gpuTimeMs: this.gpuTimeMs,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      passTimings: this.getPassTimings(),
      resourceStats: this.resourceStats ? { ...this.resourceStats, resources: this.resourceStats.resources.map((r) => ({ ...r })) } : null,
    };
  }

  saveSnapshot(label: string): TelemetrySnapshot {
    const snap = this.snapshot(label);
    this.snapshots.push(snap);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
    return snap;
  }

  getSnapshots(): TelemetrySnapshot[] {
    return [...this.snapshots];
  }

  clearSnapshots(): void {
    this.snapshots.length = 0;
  }

  static diffSnapshots(a: TelemetrySnapshot, b: TelemetrySnapshot): SnapshotDiff[] {
    const diffs: SnapshotDiff[] = [];
    const addDiff = (metric: string, av: number, bv: number) => {
      const delta = bv - av;
      const deltaPct = av !== 0 ? (delta / av) * 100 : 0;
      diffs.push({ metric, a: av, b: bv, delta, deltaPct });
    };
    addDiff("FPS", a.fps, b.fps);
    addDiff("Avg Frame (ms)", a.avgFrame, b.avgFrame);
    addDiff("p95 (ms)", a.p95, b.p95);
    addDiff("p99 (ms)", a.p99, b.p99);
    addDiff("Draw Calls", a.drawCalls, b.drawCalls);
    addDiff("Triangles", a.triangles, b.triangles);
    addDiff("GPU Time (ms)", a.gpuTimeMs, b.gpuTimeMs);
    addDiff("Heap Used (MB)", a.heapUsed / 1048576, b.heapUsed / 1048576);
    if (a.resourceStats && b.resourceStats) {
      addDiff("VRAM (MB)", a.resourceStats.totalBytes / 1048576, b.resourceStats.totalBytes / 1048576);
      addDiff("Textures", a.resourceStats.textureCount, b.resourceStats.textureCount);
      addDiff("Buffers", a.resourceStats.bufferCount, b.resourceStats.bufferCount);
    }
    for (const pa of a.passTimings) {
      const pb = b.passTimings.find((p) => p.name === pa.name);
      if (pb) addDiff(`Pass: ${pa.name} (ms)`, pa.cpuMs, pb.cpuMs);
    }
    return diffs;
  }

  reset(): void {
    this.frameTimesHead = 0;
    this.frameTimesCount = 0;
    this.graphHistory.length = 0;
    this.sysTimingsHead = 0;
    this.sysTimingsCount = 0;
    this.threadMetrics.clear();
    this.drawStats = { drawCalls: 0, triangles: 0 };
    this.lastDrawStats = { drawCalls: 0, triangles: 0 };
    this.gpuTimeMs = 0;
    this.passTimings.clear();
    this.resourceStats = null;
    this.snapshots.length = 0;
  }
}
