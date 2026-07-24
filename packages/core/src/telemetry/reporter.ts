import type { TelemetryCollector, ThreadMetrics, SystemTiming } from "./collector.ts";

export class TelemetryReporter {
  private collector: TelemetryCollector;

  constructor(collector: TelemetryCollector) {
    this.collector = collector;
  }

  getSnapshot() {
    return {
      threads: this.collector.getThreadMetrics(),
      systemTimings: this.collector.getSystemTimings(),
      frameTimes: this.collector.getFrameTimes(),
      averageFrameTime: this.collector.getAverageFrameTime(),
      p99FrameTime: this.collector.getFrameTimePercentile(0.99),
      p95FrameTime: this.collector.getFrameTimePercentile(0.95),
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
        history: snap.frameTimes,
      },
      systems: snap.systemTimings.map((s: SystemTiming) => ({
        name: s.name,
        durationMs: s.durationMs,
      })),
    };
  }
}
