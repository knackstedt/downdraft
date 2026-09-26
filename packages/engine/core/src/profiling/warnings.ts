// ============================================================================
// WarningEngine — multi-level warning-rules engine for the profiling system.
//
// Rules fire in two modes:
//   - Instantaneous (worker-side): checkInstant() is called right after a
//     metric is recorded (e.g. an IOPS op completes, a tick finishes). Fires
//     immediately if the threshold is crossed.
//   - Windowed (renderer-side): checkWindow() is called each frame with the
//     latest ProfilingSnapshot. Maintains per-rule rolling windows; fires
//     when the threshold holds for the configured windowMs.
//
// Both modes share the same WarningRule descriptor + WarningCallback shape.
// Cooldown prevents a rule from re-firing within cooldownMs.
// ============================================================================

import { createLogger } from "../util/logger";
import {
    fnv1a32,
    METRIC_CPU_PERCENT,
    METRIC_CUSTOM,
    METRIC_GC_PAUSE,
    METRIC_GPU_TIME,
    METRIC_HEAP_PERCENT,
    METRIC_HEAP_USAGE,
    METRIC_IOPS_LATENCY,
    METRIC_LONGTASK,
    METRIC_RAF_JITTER,
    METRIC_TASK_LATENCY,
    METRIC_TICK_LATENCY,
    SEVERITY_CRITICAL,
    SEVERITY_ERROR,
    SEVERITY_INFO,
    SEVERITY_WARN,
    type ProfilingSABWriter,
} from "./profiling-sab";

const log = createLogger();

export { SEVERITY_CRITICAL, SEVERITY_ERROR, SEVERITY_INFO, SEVERITY_WARN };
export type SeverityLevel = typeof SEVERITY_INFO | typeof SEVERITY_WARN | typeof SEVERITY_ERROR | typeof SEVERITY_CRITICAL;

export { METRIC_CPU_PERCENT, METRIC_CUSTOM, METRIC_GC_PAUSE, METRIC_GPU_TIME, METRIC_HEAP_PERCENT, METRIC_HEAP_USAGE, METRIC_IOPS_LATENCY, METRIC_LONGTASK, METRIC_RAF_JITTER, METRIC_TASK_LATENCY, METRIC_TICK_LATENCY };
export type MetricKind = number;

/** Trace preset for auto-trace rules. */
export type TracePreset = "perf" | "memory" | "detailed";

/** Source for auto-trace recording. */
export type TraceSource = "contentTracing" | "in-engine";

export interface AutoTraceConfig {
  preset: TracePreset;
  durationMs: number;
  source?: TraceSource; // default "contentTracing"
}

export interface WarningRule {
  /** Unique rule id (used for dedup + cooldown tracking). */
  id: string;
  /** Severity level. */
  severity: SeverityLevel;
  /** Metric to evaluate. */
  metric: MetricKind;
  /** Comparison operator. */
  compare: ">" | ">=" | "<";
  /** Threshold value (in the metric's native unit — usually microseconds or percent). */
  threshold: number;
  /** For windowed rules: the window size in ms. If set with sustained=true,
   *  the rule fires only when the threshold holds for the entire window. */
  windowMs?: number;
  /** If true (with windowMs), the rule is windowed (must hold for windowMs).
   *  If false/absent, the rule is instantaneous. */
  sustained?: boolean;
  /** Auto-trace configuration. When set, firing this rule triggers a trace recording. */
  autoTrace?: AutoTraceConfig;
  /** Minimum ms between firings of this rule. Default: 5000. */
  cooldownMs?: number;
  /** Human-readable description. */
  description?: string;
  /** Target thread for worker-side rules (e.g. "sim", "save"). Used by the
   *  bridge to forward the rule to the right worker. */
  thread?: string;
}

export interface WarningContext {
  /** The worker tag (hash) that produced the warning. */
  workerTag: number;
  /** The runtime kind (0=JS, 1=QuickJS, 2=WASM). */
  runtime: number;
  /** The rule that fired. */
  rule: WarningRule;
  /** Whether auto-trace is available (Electron contentTracing or in-engine writer). */
  autoTraceAvailable: boolean;
  /** If auto-trace fired, the artifact URL (set by the bridge, not the engine). */
  traceUrl?: string;
  /** If auto-trace was suppressed (a trace was already recording). */
  traceSuppressed?: boolean;
  /** If auto-trace was unavailable (non-Electron). */
  traceUnavailable?: boolean;
  /** Extra tag info (e.g. file path for IOPS warnings). */
  tag?: string;
}

export type WarningCallback = (record: WarningRecordData, ctx: WarningContext) => void;

/** Full warning record (richer than the SAB record — used for callbacks). */
export interface WarningRecordData {
  ruleId: string;
  ruleIdHash: number;
  severity: SeverityLevel;
  metricKind: MetricKind;
  value: number;
  threshold: number;
  workerTag: number;
  ts: number;
  autoTraceFired: boolean;
}

interface RuleState {
  lastFiredMs: number;
  /** For windowed rules: timestamps when the condition was true. */
  windowStartMs: number | null;
}

/**
 * Warning-rules engine. Constructed per-realm (one in each worker via the
 * prelude, one on the renderer via the ProfilingBridge).
 */
export class WarningEngine {
  private rules = new Map<string, WarningRule>();
  private states = new Map<string, RuleState>();
  private callbacks: WarningCallback[] = [];
  private writer: ProfilingSABWriter | null = null;
  private workerTag: number = 0;
  private runtime: number = 0;
  private autoTraceAvailable: boolean = false;

  /**
   * @param writer Optional ProfilingSABWriter for pushing WarningRecords to
   *   the SAB warning ring. If null, warnings are only delivered via callbacks
   *   (useful for the renderer-side engine where the bridge handles SAB writing).
   */
  constructor(writer?: ProfilingSABWriter | null) {
    this.writer = writer ?? null;
  }

  setWriter(writer: ProfilingSABWriter | null): void {
    this.writer = writer;
  }

  setWorkerTag(tag: number): void {
    this.workerTag = tag;
  }

  setRuntime(runtime: number): void {
    this.runtime = runtime;
  }

  setAutoTraceAvailable(available: boolean): void {
    this.autoTraceAvailable = available;
  }

  addRule(rule: WarningRule): void {
    this.rules.set(rule.id, rule);
    if (!this.states.has(rule.id)) {
      this.states.set(rule.id, { lastFiredMs: -Infinity, windowStartMs: null });
    }
  }

  removeRule(id: string): void {
    this.rules.delete(id);
    this.states.delete(id);
  }

  clearRules(): void {
    this.rules.clear();
    this.states.clear();
  }

  getRules(): WarningRule[] {
    return Array.from(this.rules.values());
  }

  onWarning(cb: WarningCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      const idx = this.callbacks.indexOf(cb);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  clearCallbacks(): void {
    this.callbacks = [];
  }

  /**
   * Evaluate an instantaneous rule (worker-side).
   * Called right after a metric is recorded.
   */
  checkInstant(metric: MetricKind, value: number, extra?: { tag?: string }): void {
    const now = performance.now();
    for (const rule of this.rules.values()) {
      if (rule.metric !== metric) continue;
      if (rule.sustained && rule.windowMs) continue; // windowed rules are handled by checkWindow
      if (!this.compare(value, rule.compare, rule.threshold)) {
        // Reset window state if the condition is false
        const state = this.states.get(rule.id);
        if (state) state.windowStartMs = null;
        continue;
      }
      this.tryFire(rule, value, now, extra);
    }
  }

  /**
   * Evaluate windowed rules against the latest snapshot (renderer-side).
   * Called each frame by the ProfilingBridge.
   */
  checkWindow(getMetricValue: (metric: MetricKind) => number): void {
    const now = performance.now();
    for (const rule of this.rules.values()) {
      if (!rule.sustained || !rule.windowMs) continue; // only windowed rules
      const value = getMetricValue(rule.metric);
      const state = this.states.get(rule.id)!;
      const conditionMet = this.compare(value, rule.compare, rule.threshold);
      if (conditionMet) {
        if (state.windowStartMs === null) {
          state.windowStartMs = now;
        }
        const elapsed = now - state.windowStartMs;
        if (elapsed >= rule.windowMs) {
          this.tryFire(rule, value, now);
        }
      } else {
        state.windowStartMs = null;
      }
    }
  }

  private tryFire(rule: WarningRule, value: number, now: number, extra?: { tag?: string }): void {
    const state = this.states.get(rule.id)!;
    const cooldown = rule.cooldownMs ?? 5000;
    if (now - state.lastFiredMs < cooldown) return;
    state.lastFiredMs = now;

    const ruleIdHash = fnv1a32(rule.id);
    const record: WarningRecordData = {
      ruleId: rule.id,
      ruleIdHash,
      severity: rule.severity,
      metricKind: rule.metric,
      value,
      threshold: rule.threshold,
      workerTag: this.workerTag,
      ts: now,
      autoTraceFired: false,
    };

    const ctx: WarningContext = {
      workerTag: this.workerTag,
      runtime: this.runtime,
      rule,
      autoTraceAvailable: this.autoTraceAvailable,
      tag: extra?.tag,
    };

    // Push to SAB warning ring (if writer is set)
    if (this.writer) {
      this.writer.pushWarningRecord({
        ruleIdHash,
        severity: rule.severity,
        metricKind: rule.metric,
        value,
        threshold: rule.threshold,
        workerTag: this.workerTag,
        ts: now,
        autoTraceFired: false, // the bridge sets this when auto-trace actually fires
      });
    }

    // Invoke callbacks
    this.callbacks.forEach((cb) => {
      try {
        cb(record, ctx);
      } catch (err) {
        // Don't let a callback error stop other callbacks
        log.error("WarningEngine", `callback error for rule "${rule.id}": ${err}`);
      }
    });
  }

  private compare(value: number, op: WarningRule["compare"], threshold: number): boolean {
    switch (op) {
      case ">": return value > threshold;
      case ">=": return value >= threshold;
      case "<": return value < threshold;
      default: return false;
    }
  }
}

// ─── Default warning rules ──────────────────────────────────────────────────

/**
 * Default warning rules registered by the prelude (workers) and initDevTools
 * (renderer) unless `defaultWarningRules: false`.
 */
export const DEFAULT_WORKER_WARNING_RULES: WarningRule[] = [
  {
    id: "dd:tick-slow",
    severity: SEVERITY_WARN,
    metric: METRIC_TICK_LATENCY,
    compare: ">",
    threshold: 50_000, // 50ms in us
    cooldownMs: 5000,
    description: "A sim tick took >50ms",
  },
  {
    id: "dd:tick-very-slow",
    severity: SEVERITY_ERROR,
    metric: METRIC_TICK_LATENCY,
    compare: ">",
    threshold: 200_000, // 200ms in us
    cooldownMs: 5000,
    autoTrace: { preset: "perf", durationMs: 3000, source: "contentTracing" },
    description: "A sim tick took >200ms — auto-trace fired",
  },
  {
    id: "dd:iops-slow",
    severity: SEVERITY_WARN,
    metric: METRIC_IOPS_LATENCY,
    compare: ">",
    threshold: 500_000, // 500ms in us
    cooldownMs: 5000,
    description: "An IOPS op took >500ms",
  },
  {
    id: "dd:gc-pause-long",
    severity: SEVERITY_WARN,
    metric: METRIC_GC_PAUSE,
    compare: ">",
    threshold: 50_000, // 50ms in us
    cooldownMs: 5000,
    description: "A GC pause >50ms",
  },
  {
    id: "dd:raf-jitter-high",
    severity: SEVERITY_WARN,
    metric: METRIC_RAF_JITTER,
    compare: ">",
    threshold: 5_000, // 5ms in us
    cooldownMs: 10000,
    description: "rAF jitter >5ms",
  },
  {
    id: "dd:longtask",
    severity: SEVERITY_WARN,
    metric: METRIC_LONGTASK,
    compare: ">",
    threshold: 50_000, // 50ms in us
    cooldownMs: 5000,
    description: "A long task >50ms",
  },
];

export const DEFAULT_RENDERER_WARNING_RULES: WarningRule[] = [
  {
    id: "dd:heap-high",
    severity: SEVERITY_WARN,
    metric: METRIC_HEAP_PERCENT,
    compare: ">",
    threshold: 80,
    sustained: true,
    windowMs: 3000,
    cooldownMs: 10000,
    description: "Heap usage >80% sustained for 3s",
  },
  {
    id: "dd:heap-critical",
    severity: SEVERITY_CRITICAL,
    metric: METRIC_HEAP_PERCENT,
    compare: ">",
    threshold: 95,
    sustained: true,
    windowMs: 2000,
    cooldownMs: 10000,
    autoTrace: { preset: "memory", durationMs: 2000, source: "contentTracing" },
    description: "Heap usage >95% sustained for 2s — auto-trace fired",
  },
  {
    id: "dd:task-p95-high",
    severity: SEVERITY_WARN,
    metric: METRIC_TASK_LATENCY,
    compare: ">",
    threshold: 100_000, // 100ms in us
    sustained: true,
    windowMs: 5000,
    cooldownMs: 10000,
    description: "Task p95 latency >100ms sustained for 5s",
  },
  {
    id: "dd:raf-jitter-sustained",
    severity: SEVERITY_WARN,
    metric: METRIC_RAF_JITTER,
    compare: ">",
    threshold: 5_000, // 5ms in us
    sustained: true,
    windowMs: 3000,
    cooldownMs: 10000,
    description: "rAF jitter >5ms sustained for 3s",
  },
  {
    id: "dd:gpu-time-high",
    severity: SEVERITY_WARN,
    metric: METRIC_GPU_TIME,
    compare: ">",
    threshold: 16_000, // 16ms in us
    sustained: true,
    windowMs: 2000,
    cooldownMs: 10000,
    description: "GPU time >16ms sustained for 2s",
  },
];
