// ============================================================================
// GCController — intelligent proactive garbage collection controller.
//
// Measures task-interval headroom and triggers minor/major GCs during idle
// windows. Records invocation durations, warns on slow GCs, and tracks V8's
// own automatic GCs for comparison.
//
// Requires --expose-gc to be active (set via js-flags in the Electron main
// process). When globalThis.gc is unavailable, the controller still tracks
// V8 auto-GCs and headroom but does not trigger proactive collections.
//
// Usage:
//   const ctrl = new GCController("renderer");
//   // In an idle window:
//   ctrl.maybeCollect(headroomMs, taskIntervalMs);
//   // On a transition (pause/load/save):
//   ctrl.collectMajor();
//   // Read stats:
//   const stats = ctrl.getStats();
// ============================================================================

export interface GCControllerConfig {
  /** Whether proactive GC is enabled. Default: false (opt-in). */
  enabled: boolean;
  /** Minimum ms between proactive minor GCs. Default: 16 (once per 60fps frame). */
  minorIntervalMs: number;
  /** Headroom fraction (0-1) required to trigger GC. GC fires only if
   *  headroomMs / taskIntervalMs >= this. Default: 0.3 (30% idle). */
  headroomThreshold: number;
  /** Heap growth (bytes) required since last GC to bother collecting.
   *  Skips GC if no meaningful allocation. Default: 256KB. */
  pressureThresholdBytes: number;
  /** Trigger major GC on transition events (pause/load/save). Default: true. */
  majorOnTransitions: boolean;
  /** Warn if an auto-triggered GC exceeds this duration (ms). Default: 5. */
  gcDurationWarnMs: number;
  /** Max headroom samples to retain for stats. Default: 120. */
  maxHeadroomSamples: number;
  /** Max invocation records to retain. Default: 64. */
  maxInvocationRecords: number;
}

export const DEFAULT_GC_CONTROLLER_CONFIG: GCControllerConfig = {
  enabled: false,
  minorIntervalMs: 16,
  headroomThreshold: 0.3,
  pressureThresholdBytes: 256 * 1024,
  majorOnTransitions: true,
  gcDurationWarnMs: 5,
  maxHeadroomSamples: 120,
  maxInvocationRecords: 64,
};

export interface GCInvocationRecord {
  type: "minor" | "major";
  triggeredAt: number;
  durationMs: number;
  headroomMs: number;
  taskIntervalMs: number;
  slow: boolean;
}

export interface GCIntervalStats {
  autoMinorCount: number;
  autoMajorCount: number;
  autoGcTotalMs: number;
  autoGcMaxMs: number;
  slowGcCount: number;
  skippedNoHeadroom: number;
  skippedNoPressure: number;
  failedCount: number;
  v8AutoGcCount: number;
  v8AutoGcTotalMs: number;
}

export interface GCOverallStats {
  autoMinorCount: number;
  autoMajorCount: number;
  autoGcTotalMs: number;
  autoGcMaxMs: number;
  slowGcCount: number;
  wallMs: number;
}

export interface GCControllerStats {
  label: string;
  enabled: boolean;
  gcAvailable: boolean;
  config: GCControllerConfig;
  interval: GCIntervalStats;
  overall: GCOverallStats;
  headroomSamples: number[];
  recentInvocations: GCInvocationRecord[];
  heapUsedBytes: number;
  heapTotalBytes: number;
}

// Type for the exposed gc function. V8 supports gc({type:"minor"|"major"}) or
// gc(execution) in older builds. We detect the signature at construction.
type GcFn = (() => void) & {
  (opts: { type: "minor" | "major" }): void;
  (execution: "major" | "minor"): void;
};

function getGcFn(): GcFn | null {
  const g = (globalThis as any).gc;
  return typeof g === "function" ? (g as GcFn) : null;
}

function getHeapUsed(): number {
  const mem = (performance as any).memory;
  return mem ? mem.usedJSHeapSize : 0;
}

function getHeapTotal(): number {
  const mem = (performance as any).memory;
  return mem ? mem.totalJSHeapSize : 0;
}

export class GCController {
  private label: string;
  private config: GCControllerConfig;
  private gcFn: GcFn | null;
  private readonly gcAvailable: boolean;

  // Throttle state
  private lastCollectMs: number = 0;
  private lastHeapAfterGc: number = 0;

  // Interval counters (reset on getStats)
  private interval: GCIntervalStats = this.emptyInterval();

  // Overall counters (cumulative)
  private overallAutoMinor: number = 0;
  private overallAutoMajor: number = 0;
  private overallAutoGcTotalMs: number = 0;
  private overallAutoGcMaxMs: number = 0;
  private overallSlowGcCount: number = 0;
  private readonly startTime: number;

  // Ring buffers
  private headroomBuf: Float64Array;
  private headroomHead: number = 0;
  private headroomCount: number = 0;
  private invocationBuf: GCInvocationRecord[];
  private invocationHead: number = 0;
  private invocationCount: number = 0;

  // V8 auto-GC tracking via PerformanceObserver
  private perfObserver: any = null;
  private v8AutoGcCount: number = 0;
  private v8AutoGcTotalMs: number = 0;

  constructor(label: string, config?: Partial<GCControllerConfig>) {
    this.label = label;
    this.config = { ...DEFAULT_GC_CONTROLLER_CONFIG, ...config };
    this.gcFn = getGcFn();
    this.gcAvailable = this.gcFn !== null;
    this.startTime = performance.now();
    this.headroomBuf = new Float64Array(this.config.maxHeadroomSamples);
    this.invocationBuf = new Array(this.config.maxInvocationRecords);
    for (let i = 0; i < this.config.maxInvocationRecords; i++) {
      this.invocationBuf[i] = { type: "minor", triggeredAt: 0, durationMs: 0, headroomMs: 0, taskIntervalMs: 0, slow: false };
    }
    this.initPerfObserver();
  }

  private initPerfObserver(): void {
    const PO = globalThis.PerformanceObserver;
    if (!PO) return;
    try {
      this.perfObserver = new PO((list: any) => {
        for (const entry of list.getEntries()) {
          this.v8AutoGcCount++;
          this.v8AutoGcTotalMs += entry.duration;
        }
      });
      this.perfObserver.observe({ entryTypes: ["gc"], buffered: true });
    } catch {
      // PerformanceObserver for gc not supported — skip V8 auto-GC tracking
    }
  }

  private emptyInterval(): GCIntervalStats {
    return {
      autoMinorCount: 0,
      autoMajorCount: 0,
      autoGcTotalMs: 0,
      autoGcMaxMs: 0,
      slowGcCount: 0,
      skippedNoHeadroom: 0,
      skippedNoPressure: 0,
      failedCount: 0,
      v8AutoGcCount: 0,
      v8AutoGcTotalMs: 0,
    };
  }

  /** The controller's label (e.g. "renderer", "sim-worker"). */
  getLabel(): string { return this.label; }

  /** Whether globalThis.gc is available (requires --expose-gc). */
  isGcAvailable(): boolean { return this.gcAvailable; }

  /** Current configuration. */
  getConfig(): GCControllerConfig { return { ...this.config }; }

  /** Update configuration (partial merge). */
  setConfig(partial: Partial<GCControllerConfig>): void {
    const oldMaxHeadroom = this.config.maxHeadroomSamples;
    const oldMaxInvocations = this.config.maxInvocationRecords;
    this.config = { ...this.config, ...partial };
    // Resize ring buffers if config changed
    if (this.config.maxHeadroomSamples !== oldMaxHeadroom) {
      const newBuf = new Float64Array(this.config.maxHeadroomSamples);
      const copyCount = Math.min(this.headroomCount, this.config.maxHeadroomSamples);
      const start = (this.headroomHead - this.headroomCount + this.headroomBuf.length) % this.headroomBuf.length;
      for (let i = 0; i < copyCount; i++) {
        newBuf[i] = this.headroomBuf[(start + i) % this.headroomBuf.length];
      }
      this.headroomBuf = newBuf;
      this.headroomHead = copyCount % newBuf.length;
      this.headroomCount = copyCount;
    }
    if (this.config.maxInvocationRecords !== oldMaxInvocations) {
      const newBuf = new Array(this.config.maxInvocationRecords);
      for (let i = 0; i < this.config.maxInvocationRecords; i++) {
        newBuf[i] = i < this.invocationBuf.length ? this.invocationBuf[i] : { type: "minor", triggeredAt: 0, durationMs: 0, headroomMs: 0, taskIntervalMs: 0, slow: false };
      }
      this.invocationBuf = newBuf;
      if (this.invocationCount > this.config.maxInvocationRecords) this.invocationCount = this.config.maxInvocationRecords;
      if (this.invocationHead >= this.config.maxInvocationRecords) this.invocationHead = 0;
    }
  }

  /**
   * Attempt a proactive minor GC if headroom and pressure gates pass.
   * Called during idle windows (e.g. renderer frame-limiter early-return,
   * or SimWorkerLoop post-tick sleep).
   *
   * @param headroomMs Available idle time in ms.
   * @param taskIntervalMs The task's nominal interval (e.g. 16.67ms for 60fps,
   *   or tickMs for the sim worker).
   */
  maybeCollect(headroomMs: number, taskIntervalMs: number): void {
    // Always record headroom sample (even when disabled) for monitoring
    this.pushHeadroomSample(headroomMs);

    if (!this.config.enabled) return;
    if (!this.gcFn) return;

    // Headroom gate
    const headroomFraction = taskIntervalMs > 0 ? headroomMs / taskIntervalMs : 0;
    if (headroomFraction < this.config.headroomThreshold) {
      this.interval.skippedNoHeadroom++;
      return;
    }

    // Throttle gate — lastCollectMs === 0 means "never collected", allow first call
    const now = performance.now();
    if (this.lastCollectMs > 0 && now - this.lastCollectMs < this.config.minorIntervalMs) return;

    // Pressure gate — skip if heap hasn't grown meaningfully
    const heapUsed = getHeapUsed();
    if (heapUsed > 0 && this.lastHeapAfterGc > 0) {
      const growth = heapUsed - this.lastHeapAfterGc;
      if (growth < this.config.pressureThresholdBytes) {
        this.interval.skippedNoPressure++;
        return;
      }
    }

    this.doCollect("minor", headroomMs, taskIntervalMs);
  }

  /**
   * Trigger a major GC. Intended for transition events (pause/load/save/hot-reload).
   * Only fires if majorOnTransitions is enabled.
   */
  collectMajor(): void {
    if (!this.config.majorOnTransitions) return;
    if (!this.gcFn) return;
    this.doCollect("major", 0, 0);
  }

  /** Force a major GC regardless of majorOnTransitions setting. */
  forceMajor(): void {
    if (!this.gcFn) return;
    this.doCollect("major", 0, 0);
  }

  private doCollect(type: "minor" | "major", headroomMs: number, taskIntervalMs: number): void {
    const start = performance.now();
    try {
      this.callGc(type);
    } catch {
      this.interval.failedCount++;
      return;
    }
    const duration = performance.now() - start;
    const slow = duration > this.config.gcDurationWarnMs;

    // Update interval counters
    if (type === "minor") this.interval.autoMinorCount++;
    else this.interval.autoMajorCount++;
    this.interval.autoGcTotalMs += duration;
    if (duration > this.interval.autoGcMaxMs) this.interval.autoGcMaxMs = duration;
    if (slow) this.interval.slowGcCount++;

    // Update overall counters
    if (type === "minor") this.overallAutoMinor++;
    else this.overallAutoMajor++;
    this.overallAutoGcTotalMs += duration;
    if (duration > this.overallAutoGcMaxMs) this.overallAutoGcMaxMs = duration;
    if (slow) this.overallSlowGcCount++;

    // Record invocation
    this.pushInvocation(type, start, duration, headroomMs, taskIntervalMs, slow);

    // Update throttle + pressure state
    this.lastCollectMs = performance.now();
    this.lastHeapAfterGc = getHeapUsed();
  }

  private callGc(type: "minor" | "major"): void {
    if (!this.gcFn) return;
    // Try modern object form first: gc({type:"minor"})
    try {
      (this.gcFn as any)({ type });
      return;
    } catch {
      // Fall through to legacy forms
    }
    // Try legacy string form: gc("major") or gc(true) for minor
    try {
      if (type === "major") (this.gcFn as any)("major");
      else (this.gcFn as any)(true);
      return;
    } catch {
      // Fall through to plain gc()
    }
    // Last resort: plain gc() — does a full major GC
    this.gcFn();
  }

  private pushHeadroomSample(headroomMs: number): void {
    this.headroomBuf[this.headroomHead] = headroomMs;
    this.headroomHead = (this.headroomHead + 1) % this.headroomBuf.length;
    if (this.headroomCount < this.headroomBuf.length) this.headroomCount++;
  }

  private pushInvocation(
    type: "minor" | "major", triggeredAt: number, durationMs: number,
    headroomMs: number, taskIntervalMs: number, slow: boolean,
  ): void {
    const slot = this.invocationBuf[this.invocationHead];
    slot.type = type;
    slot.triggeredAt = triggeredAt;
    slot.durationMs = durationMs;
    slot.headroomMs = headroomMs;
    slot.taskIntervalMs = taskIntervalMs;
    slot.slow = slow;
    this.invocationHead = (this.invocationHead + 1) % this.invocationBuf.length;
    if (this.invocationCount < this.invocationBuf.length) this.invocationCount++;
  }

  /**
   * Get current stats snapshot. Resets interval counters.
   * V8 auto-GC counts are moved from the internal accumulator to the interval.
   */
  getStats(): GCControllerStats {
    const intervalV8Count = this.v8AutoGcCount;
    const intervalV8Time = this.v8AutoGcTotalMs;
    this.v8AutoGcCount = 0;
    this.v8AutoGcTotalMs = 0;

    const stats: GCControllerStats = {
      label: this.label,
      enabled: this.config.enabled,
      gcAvailable: this.gcAvailable,
      config: { ...this.config },
      interval: {
        ...this.interval,
        v8AutoGcCount: intervalV8Count,
        v8AutoGcTotalMs: intervalV8Time,
      },
      overall: {
        autoMinorCount: this.overallAutoMinor,
        autoMajorCount: this.overallAutoMajor,
        autoGcTotalMs: this.overallAutoGcTotalMs,
        autoGcMaxMs: this.overallAutoGcMaxMs,
        slowGcCount: this.overallSlowGcCount,
        wallMs: performance.now() - this.startTime,
      },
      headroomSamples: this.getHeadroomSamples(),
      recentInvocations: this.getRecentInvocations(),
      heapUsedBytes: getHeapUsed(),
      heapTotalBytes: getHeapTotal(),
    };

    // Reset interval counters
    this.interval = this.emptyInterval();

    return stats;
  }

  private getHeadroomSamples(): number[] {
    const result: number[] = [];
    result.length = this.headroomCount;
    const start = (this.headroomHead - this.headroomCount + this.headroomBuf.length) % this.headroomBuf.length;
    for (let i = 0; i < this.headroomCount; i++) {
      result[i] = this.headroomBuf[(start + i) % this.headroomBuf.length];
    }
    return result;
  }

  private getRecentInvocations(): GCInvocationRecord[] {
    const result: GCInvocationRecord[] = [];
    const start = (this.invocationHead - this.invocationCount + this.invocationBuf.length) % this.invocationBuf.length;
    for (let i = 0; i < this.invocationCount; i++) {
      const slot = this.invocationBuf[(start + i) % this.invocationBuf.length];
      result.push({ ...slot });
    }
    return result;
  }

  /** Reset all counters and buffers. */
  reset(): void {
    this.interval = this.emptyInterval();
    this.overallAutoMinor = 0;
    this.overallAutoMajor = 0;
    this.overallAutoGcTotalMs = 0;
    this.overallAutoGcMaxMs = 0;
    this.overallSlowGcCount = 0;
    this.headroomHead = 0;
    this.headroomCount = 0;
    this.invocationHead = 0;
    this.invocationCount = 0;
    this.lastCollectMs = 0;
    this.lastHeapAfterGc = 0;
    this.v8AutoGcCount = 0;
    this.v8AutoGcTotalMs = 0;
  }

  /** Clean up the PerformanceObserver. */
  dispose(): void {
    if (this.perfObserver) {
      try { this.perfObserver.disconnect(); } catch {}
      this.perfObserver = null;
    }
  }
}
