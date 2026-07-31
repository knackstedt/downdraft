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
  private frameTimes: number[] = [];
  private graphHistory: number[] = [];
  private maxGraphHistory: number = 120;
  private maxFrameHistory: number = 300;
  private drawStats: DrawStats = { drawCalls: 0, triangles: 0 };
  private lastDrawStats: DrawStats = { drawCalls: 0, triangles: 0 };
  private gpuTimeMs: number = 0;
  private passTimings: PassTiming[] = [];
  private resourceStats: ResourceStats | null = null;
  private snapshots: TelemetrySnapshot[] = [];
  private maxSnapshots: number = 10;

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
    const existing = this.passTimings.find((p) => p.name === timing.name);
    if (existing) {
      Object.assign(existing, timing);
    } else {
      this.passTimings.push({ ...timing });
    }
  }

  getPassTimings(): PassTiming[] {
    return this.passTimings.map((p) => ({ ...p }));
  }

  clearPassTimings(): void {
    this.passTimings.length = 0;
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
      frameTimes: [...this.frameTimes],
      avgFrame: this.getAverageFrameTime(),
      p95: this.getFrameTimePercentile(0.95),
      p99: this.getFrameTimePercentile(0.99),
      fps: this.getFPS(),
      drawCalls: this.drawStats.drawCalls,
      triangles: this.drawStats.triangles,
      gpuTimeMs: this.gpuTimeMs,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      passTimings: this.passTimings.map((p) => ({ ...p })),
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
    this.frameTimes.length = 0;
    this.graphHistory.length = 0;
    this.systemTimings.length = 0;
    this.threadMetrics.clear();
    this.drawStats = { drawCalls: 0, triangles: 0 };
    this.lastDrawStats = { drawCalls: 0, triangles: 0 };
    this.gpuTimeMs = 0;
    this.passTimings.length = 0;
    this.resourceStats = null;
    this.snapshots.length = 0;
  }
}
