import type { DrawStats, SystemTiming, TelemetryCollector, ThreadMetrics } from "./collector.ts";

export class TelemetryReporter {
  private collector: TelemetryCollector;

  constructor(collector: TelemetryCollector) {
    this.collector = collector;
  }

  getSnapshot() {
    const mem = this.collector.getMemoryUsage();
    const drawStats = this.collector.getDrawStats();
    return {
      threads: this.collector.getThreadMetrics(),
      systemTimings: this.collector.getSystemTimings(),
      frameTimes: this.collector.getFrameTimes(),
      averageFrameTime: this.collector.getAverageFrameTime(),
      p99FrameTime: this.collector.getFrameTimePercentile(0.99),
      p95FrameTime: this.collector.getFrameTimePercentile(0.95),
      fps: this.collector.getFPS(),
      drawCalls: drawStats.drawCalls,
      triangles: drawStats.triangles,
      gpuTimeMs: this.collector.getGpuTime(),
      memory: mem,
      timestamp: Date.now(),
    };
  }

  toJSON(): string {
    return JSON.stringify(this.getSnapshot());
  }

  getMCPFormat() {
    const snap = this.getSnapshot();
    return {
      threads: snap.threads.map((t: ThreadMetrics) => ({
        thread: t.threadName,
        gc: { totalMs: t.gcPauseTotal, count: t.gcPauseCount, maxMs: t.gcPauseMax },
        memory: { heapUsed: t.heapUsed, heapTotal: t.heapTotal, rss: t.rss },
        cpu: { timeMs: t.cpuTime },
        tick: t.tick,
      })),
      frame: {
        avgMs: snap.averageFrameTime,
        p95Ms: snap.p95FrameTime,
        p99Ms: snap.p99FrameTime,
        fps: snap.fps,
        history: snap.frameTimes,
      },
      draw: {
        calls: snap.drawCalls,
        triangles: snap.triangles,
        gpuTimeMs: snap.gpuTimeMs,
      } as DrawStats & { gpuTimeMs: number },
      memory: snap.memory,
      systems: snap.systemTimings.map((s: SystemTiming) => ({
        name: s.name,
        durationMs: s.durationMs,
      })),
    };
  }
}
