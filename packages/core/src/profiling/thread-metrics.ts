// ============================================================================
// ThreadMetricsWriter — writes the ThreadMetrics block to a ProfilingSAB slot
// each tick. Reads memory from performance.memory / process.memoryUsage /
// quickjs.memoryUsage / WebAssembly.Memory depending on runtime. CPU time via
// performance.now() deltas. GC via the existing GCTracker.
// ============================================================================

import { GCTracker } from "../telemetry/gc-tracker";
import type { ProfilingSABWriter } from "./profiling-sab";
import type { TaskLatencyHistogram } from "./task-latency";

export interface ThreadMetricsWriterOptions {
  /** Runtime kind: 0=JS, 1=QuickJS, 2=WASM. */
  runtime: number;
  /** Optional GCTracker to read GC stats from. */
  gcTracker?: GCTracker;
  /** Optional TaskLatencyHistogram to read task latency percentiles from. */
  taskLatency?: TaskLatencyHistogram;
  /** Optional function to get heap usage (for QuickJS/WASM custom memory). */
  getHeap?: () => { heapUsed: number; heapTotal: number; rss: number };
}

export class ThreadMetricsWriter {
  private writer: ProfilingSABWriter;
  private opts: ThreadMetricsWriterOptions;
  private tick: number = 0;
  private lastCpuTimeMs: number = 0;
  private cpuTimeMs: number = 0;
  private lastFlushMs: number = 0;
  private activeWorkMs: number = 0;
  private frameDurations: number[] = [];
  private readonly maxFrameHistory = 60;

  constructor(writer: ProfilingSABWriter, opts: ThreadMetricsWriterOptions) {
    this.writer = writer;
    this.opts = opts;
    this.lastFlushMs = performance.now();
  }

  /**
   * Record active work time (e.g. time spent processing a task/message).
   * This is accumulated between flushes and used to compute true CPU
   * utilization = workTime / wallClockTime.
   */
  recordWork(ms: number): void {
    if (ms > 0) this.activeWorkMs += ms;
  }

  /**
   * Flush the ThreadMetrics block to the SAB.
   * Call this each tick (sim workers) or on an interval (non-sim workers).
   */
  flush(): void {
    this.tick++;
    const now = performance.now();
    const wallMs = now - this.lastFlushMs;
    this.lastFlushMs = now;
    this.cpuTimeMs += this.activeWorkMs;
    this.frameDurations.push(wallMs);
    if (this.frameDurations.length > this.maxFrameHistory) this.frameDurations.shift();

    // CPU percent = active work time / wall clock time since last flush.
    // This is true CPU utilization (0% when idle, 100% when fully busy),
    // not "frame time as % of 60fps budget" which was always ~100% for
    // interval-based flushes.
    const cpuPercent = wallMs > 0
      ? Math.min(100, (this.activeWorkMs / wallMs) * 100)
      : 0;
    this.activeWorkMs = 0;

    // Memory
    const mem = this.getMemory();

    // GC stats
    let gcPauseTotalUs = 0, gcPauseCount = 0, gcPauseMaxUs = 0;
    if (this.opts.gcTracker && this.opts.gcTracker.isEnabled()) {
      const gcStats = this.opts.gcTracker.getStats();
      gcPauseTotalUs = Math.round(gcStats.pauseTotal * 1000); // ms → us
      gcPauseCount = gcStats.pauseCount;
      gcPauseMaxUs = Math.round(gcStats.pauseMax * 1000);
    }

    // Task latency percentiles
    let taskLatencyP50Us = 0, taskLatencyP95Us = 0, taskLatencyP99Us = 0, taskLatencyMaxUs = 0;
    let taskCount = 0;
    if (this.opts.taskLatency) {
      const p = this.opts.taskLatency.getPercentiles();
      taskLatencyP50Us = p.p50;
      taskLatencyP95Us = p.p95;
      taskLatencyP99Us = p.p99;
      taskLatencyMaxUs = p.max;
      taskCount = this.opts.taskLatency.getCount();
    }

    this.writer.writeThreadMetrics({
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      cpuTimeMs: this.cpuTimeMs,
      cpuPercent,
      gcPauseTotalUs,
      gcPauseCount,
      gcPauseMaxUs,
      tick: this.tick,
      taskCount,
      taskLatencyP50Us,
      taskLatencyP95Us,
      taskLatencyP99Us,
      taskLatencyMaxUs,
    });
  }

  getTick(): number {
    return this.tick;
  }

  private getMemory(): { heapUsed: number; heapTotal: number; rss: number } {
    if (this.opts.getHeap) {
      return this.opts.getHeap();
    }
    // Reuse GCTracker.getCurrentMemory() which handles process.memoryUsage
    // and performance.memory fallbacks.
    const mem = GCTracker.getCurrentMemory();
    return { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss };
  }
}
