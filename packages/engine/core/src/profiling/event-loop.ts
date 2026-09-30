// ============================================================================
// EventLoopMonitor — per-realm event-loop health monitoring.
//
// Tracks:
//   - rAF jitter: scheduling delay between expected frame time and actual
//     rAF callback fire time. Works on the renderer (rAF) and in workers
//     with a setInterval/setTimeout loop (measures jitter vs the configured
//     interval).
//   - longtask: PerformanceObserver for "longtask" entries (renderer + workers
//     where available — a Blink API, no-ops elsewhere).
//   - idle headroom: gap between when a frame's work completes and the next
//     frame deadline.
//
// Writes the EventLoop block to the slot each frame.
// ============================================================================

import { METRIC_LONGTASK, METRIC_RAF_JITTER, type ProfilingSABWriter } from "./profiling-sab";
import type { WarningEngine } from "./warnings";

interface JitterSample {
  jitterUs: number;
  ts: number;
}

export class EventLoopMonitor {
  private writer: ProfilingSABWriter | null;
  private warningEngine: WarningEngine | null;
  private expectedFrameMs: number;
  private lastExpectedTime: number = 0;
  private jitterSamples: JitterSample[] = [];
  private readonly maxJitterSamples = 120;

  // longtask accumulation (reset each flush)
  private longtaskCount: number = 0;
  private longtaskTotalMs: number = 0;
  private longtaskMaxMs: number = 0;
  private longtaskObserver: PerformanceObserver | null = null;

  // idle headroom
  private idleHeadroomMs: number = 0;
  private frameWorkStartMs: number = 0;
  // Last frame's work duration (set by recordFrameEnd)
  private lastWorkMs: number = 0;

  constructor(opts: {
    writer?: ProfilingSABWriter | null;
    warningEngine?: WarningEngine | null;
    expectedFrameMs?: number;
  }) {
    this.writer = opts.writer ?? null;
    this.warningEngine = opts.warningEngine ?? null;
    this.expectedFrameMs = opts.expectedFrameMs ?? 16.67;
  }

  /**
   * Start monitoring. Call once at init.
   * For the renderer, this sets up the longtask PerformanceObserver.
   * For workers, call startLoop() instead to begin the jitter tracking interval.
   */
  start(): void {
    this.tryStartLongtaskObserver();
  }

  /**
   * Start jitter tracking via a setInterval loop (for workers without rAF).
   * The renderer uses recordFrameStart/recordFrameEnd around the rAF callback.
   */
  startLoop(intervalMs?: number): void {
    const interval = intervalMs ?? this.expectedFrameMs;
    this.lastExpectedTime = performance.now();
    const tick = () => {
      const now = performance.now();
      const expected = this.lastExpectedTime + interval;
      const jitterUs = Math.max(0, (now - expected) * 1000);
      this.recordJitter(jitterUs);
      this.lastExpectedTime = now;
      // Flush event-loop block
      this.flush();
    };
    setInterval(tick, interval);
    this.tryStartLongtaskObserver();
  }

  /** Call at the start of each rAF callback (renderer). */
  recordFrameStart(): void {
    this.frameWorkStartMs = performance.now();
    if (this.lastExpectedTime > 0) {
      const expected = this.lastExpectedTime + this.expectedFrameMs;
      const jitterUs = Math.max(0, (this.frameWorkStartMs - expected) * 1000);
      this.recordJitter(jitterUs);
    }
    this.lastExpectedTime = this.frameWorkStartMs;
  }

  /** Call at the end of each rAF callback (renderer). */
  recordFrameEnd(): void {
    const now = performance.now();
    const workMs = now - this.frameWorkStartMs;
    this.lastWorkMs = workMs;
    this.idleHeadroomMs = Math.max(0, this.expectedFrameMs - workMs);
    this.flush();
  }

  /** Returns the last frame's work duration in ms (time spent in the rAF callback). */
  getLastWorkMs(): number {
    return this.lastWorkMs;
  }

  /** Record a jitter sample + fire warning if needed. */
  private recordJitter(jitterUs: number): void {
    this.jitterSamples.push({ jitterUs, ts: performance.now() });
    if (this.jitterSamples.length > this.maxJitterSamples) this.jitterSamples.shift();
    if (this.warningEngine && jitterUs > 0) {
      this.warningEngine.checkInstant(METRIC_RAF_JITTER, jitterUs);
    }
  }

  /** Flush the EventLoop block to the SAB. */
  flush(): void {
    if (!this.writer) return;
    const samples = this.jitterSamples;
    if (samples.length === 0) {
      this.writer.writeEventLoop({
        rafJitterP50Us: 0,
        rafJitterP95Us: 0,
        rafJitterMaxUs: 0,
        longtaskCount: this.longtaskCount,
        longtaskTotalMs: this.longtaskTotalMs,
        longtaskMaxMs: this.longtaskMaxMs,
        idleHeadroomMs: this.idleHeadroomMs,
        expectedFrameMs: this.expectedFrameMs,
      });
      return;
    }
    const sorted = samples.map(s => s.jitterUs).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    this.writer.writeEventLoop({
      rafJitterP50Us: p50,
      rafJitterP95Us: p95,
      rafJitterMaxUs: max,
      longtaskCount: this.longtaskCount,
      longtaskTotalMs: this.longtaskTotalMs,
      longtaskMaxMs: this.longtaskMaxMs,
      idleHeadroomMs: this.idleHeadroomMs,
      expectedFrameMs: this.expectedFrameMs,
    });
  }

  private tryStartLongtaskObserver(): void {
    const PO = globalThis.PerformanceObserver;
    if (!PO) return;
    try {
      // Check if longtask is supported
      const obs = new PO((list) => {
        for (const entry of list.getEntries()) {
          const durationMs = entry.duration;
          this.longtaskCount++;
          this.longtaskTotalMs += durationMs;
          if (durationMs > this.longtaskMaxMs) this.longtaskMaxMs = durationMs;
          if (this.warningEngine) {
            this.warningEngine.checkInstant(METRIC_LONGTASK, durationMs * 1000); // ms → us
          }
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
      this.longtaskObserver = obs;
    } catch {
      // longtask not supported (Safari/Firefox) — no-op
    }
  }

  dispose(): void {
    if (this.longtaskObserver) {
      try { this.longtaskObserver.disconnect(); } catch { /* ignore */ }
      this.longtaskObserver = null;
    }
  }
}
