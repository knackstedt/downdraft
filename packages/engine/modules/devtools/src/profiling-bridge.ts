// ============================================================================
// ProfilingBridge — renderer-side bridge that wires the profiling system into
// the devtools host.
//
// Responsibilities:
//   1. Allocate the global ProfilingSAB (shared with all workers + the
//      devtools host).
//   2. Create a renderer-side WarningEngine + EventLoopMonitor + TraceEventWriter.
//   3. Drain the warning ring from the ProfilingSAB each frame + merge with
//      renderer-side warnings → emit toasts + forward to onWarning callbacks.
//   4. Wire auto-trace: when a warning with autoTrace config fires, start
//      recording with the in-engine TraceEventWriter (auto-stopping after
//      the rule's configured duration).
//   5. Wire the TelemetryCollector (pass timings, system timings) into the
//      ProfilingSAB so the devtools profiling views can read them.
//   6. Register the 10 built-in view descriptors with the devtools API.
//
// Created by initDevTools() when profiling is enabled.
// ============================================================================

import {
    allocateProfilingSAB,
    claimSlot,
    computeProfilingSABLayout,
    DEFAULT_RENDERER_WARNING_RULES,
    EventLoopMonitor,
    fnv1a32,
    PROFILING_IOPS_RING_CAP,
    PROFILING_MAX_SLOTS,
    PROFILING_STRING_TABLE_CAP,
    PROFILING_WARNING_RING_CAP,
    ProfilingSABReader,
    ProfilingSABWriter,
    TraceEventWriter,
    WarningEngine,
    type ProfilingSABLayout,
    type ProfilingSnapshot,
    type SeverityLevel,
    type TraceSource,
    type WarningContext,
    type WarningRecordData
} from "@downdraft/engine/profiling";
import { createLogger } from "@downdraft/engine/util/logger";
import { devtools } from "./api";
import { BUILTIN_VIEW_DESCRIPTORS } from "./debug-view-descriptors";

const log = createLogger("info");

/** Only the in-engine TraceEventWriter exists on the native host.
 *  Normalize instead of failing so untyped callers (MCP tool args, saved
 *  configs) degrade gracefully. */
function normalizeTraceSource(source: TraceSource): TraceSource {
  if (source !== "in-engine") {
    log.warn("ProfilingBridge", `traceSource "${source}" is unsupported — using the in-engine trace writer`);
    return "in-engine";
  }
  return source;
}

export interface ProfilingBridgeOptions {
  /** Trace source for auto-trace. Only "in-engine" exists; unknown values
   *  fall back to the in-engine writer with a warning. */
  traceSource?: TraceSource;
  /** Whether to enable the EventLoopMonitor on the renderer. Default: true. */
  enableEventLoopMonitor?: boolean;
  /** Expected frame time in ms (for rAF jitter). Default: 16.67. */
  expectedFrameMs?: number;
  /** Max slots in the ProfilingSAB. Default: PROFILING_MAX_SLOTS (32). */
  maxSlots?: number;
  /** IOPS ring capacity per slot. Default: PROFILING_IOPS_RING_CAP (256). */
  iopsRingCap?: number;
  /** Warning ring capacity (global). Default: PROFILING_WARNING_RING_CAP (128). */
  warningRingCap?: number;
  /** String table capacity per slot. Default: PROFILING_STRING_TABLE_CAP (64). */
  stringTableCap?: number;
  /**
   * Reuse an externally-allocated ProfilingSAB instead of allocating a new
   * one. Needed when another subsystem already handed a SAB to the workers
   * (e.g. the native debugger overlay) — two SABs would split the metrics.
   */
  sharedSAB?: { sab: SharedArrayBuffer; layout: ProfilingSABLayout };
}

export interface ProfilingBridgeSnapshot {
  profilingSnapshot: ProfilingSnapshot;
  traceRecording: boolean;
  traceSource: TraceSource;
}

export class ProfilingBridge {
  private profilingSAB: SharedArrayBuffer;
  private layout: ProfilingSABLayout;
  private reader: ProfilingSABReader;
  private writer: ProfilingSABWriter | null = null;
  private rendererSlot: number = -1;
  private tickCount: number = 0;
  private cpuTimeStart: number = 0;
  private lastFrameMs: number = 0;
  private warningEngine: WarningEngine;
  private eventLoopMonitor: EventLoopMonitor | null;
  private traceEventWriter: TraceEventWriter;
  private traceSource: TraceSource;
  private autoTraceActive: boolean = false;
  private autoTraceWarningId: string | null = null;
  /** Result of the most recent auto-trace recording (for tooling/MCP). */
  private lastAutoTrace: { json: string; bytes: number; source: TraceSource } | null = null;
  private lastSnapshot: ProfilingSnapshot | null = null;
  private warningCallbacks: Set<(record: WarningRecordData, ctx: WarningContext) => void> = new Set();
  private seenWarningIds: Set<string> = new Set(); // dedup across workers

  constructor(opts: ProfilingBridgeOptions = {}) {
    this.layout = opts.sharedSAB?.layout ?? computeProfilingSABLayout(
      opts.maxSlots ?? PROFILING_MAX_SLOTS,
      opts.iopsRingCap ?? PROFILING_IOPS_RING_CAP,
      opts.warningRingCap ?? PROFILING_WARNING_RING_CAP,
      opts.stringTableCap ?? PROFILING_STRING_TABLE_CAP,
    );
    const allocated = opts.sharedSAB ?? allocateProfilingSAB(
      this.layout.maxSlots,
      this.layout.iopsRingCap,
      this.layout.warningRingCap,
      this.layout.stringTableCap,
    );
    this.profilingSAB = allocated.sab;
    this.reader = new ProfilingSABReader(this.profilingSAB, this.layout);
    this.warningEngine = new WarningEngine(null); // renderer writes warnings directly
    this.warningEngine.setWorkerTag(0); // renderer tag = 0
    this.warningEngine.setAutoTraceAvailable(true); // in-engine writer is always available

    // Register default renderer warning rules
    DEFAULT_RENDERER_WARNING_RULES.forEach((rule) => {
      this.warningEngine.addRule(rule);
    });

    // Event loop monitor (renderer) — writer is set after slot claim below
    if (opts.enableEventLoopMonitor !== false) {
      this.eventLoopMonitor = new EventLoopMonitor({
        warningEngine: this.warningEngine,
        expectedFrameMs: opts.expectedFrameMs ?? 16.67,
      });
      this.eventLoopMonitor.start();
    } else {
      this.eventLoopMonitor = null;
    }

    this.traceEventWriter = new TraceEventWriter();
    this.traceSource = normalizeTraceSource(opts.traceSource ?? "in-engine");

    // Attach the ProfilingSAB to the devtools API
    devtools.attachProfilingSAB(this.profilingSAB);

    // Register built-in view descriptors
    BUILTIN_VIEW_DESCRIPTORS.forEach((view) => {
      devtools.registerView(view);
    });

    // Claim a renderer slot so the profiler overlay always has at least one
    // slot to display (renderer heap/CPU/GC metrics).
    const rendererTag = fnv1a32("renderer");
    this.rendererSlot = claimSlot(
      this.profilingSAB, this.layout, rendererTag, 0 /* RUNTIME_JS */, "renderer",
    );
    if (this.rendererSlot >= 0) {
      this.writer = new ProfilingSABWriter(this.profilingSAB, this.layout, this.rendererSlot);
      // Attach the writer to the event loop monitor so it writes event loop data
      if (this.eventLoopMonitor) {
        (this.eventLoopMonitor as any).writer = this.writer;
      }
    }
    this.cpuTimeStart = performance.now();
    this.lastFrameMs = performance.now();
  }

  /** The global ProfilingSAB — share this with all workers + the devtools host. */
  getProfilingSAB(): SharedArrayBuffer {
    return this.profilingSAB;
  }

  /** The SAB layout (needed by workers to claim slots). */
  getProfilingLayout(): ProfilingSABLayout {
    return this.layout;
  }

  /** Serializable layout params (safe to pass via postMessage / structured clone).
   *  The worker reconstructs the full layout via computeProfilingSABLayout(...). */
  getLayoutParams(): { maxSlots: number; iopsRingCap: number; warningRingCap: number; stringTableCap: number } {
    return {
      maxSlots: this.layout.maxSlots,
      iopsRingCap: this.layout.iopsRingCap,
      warningRingCap: this.layout.warningRingCap,
      stringTableCap: this.layout.stringTableCap,
    };
  }

  /** The renderer-side warning engine. Add custom rules via this. */
  getWarningEngine(): WarningEngine {
    return this.warningEngine;
  }

  /** The renderer-side event-loop monitor. */
  getEventLoopMonitor(): EventLoopMonitor | null {
    return this.eventLoopMonitor;
  }

  /** The trace event writer (for in-engine trace export). */
  getTraceEventWriter(): TraceEventWriter {
    return this.traceEventWriter;
  }

  /** Subscribe to warnings (merged from all workers + renderer). */
  onWarning(cb: (record: WarningRecordData, ctx: WarningContext) => void): () => void {
    this.warningCallbacks.add(cb);
    return () => { this.warningCallbacks.delete(cb); };
  }

  /** Set the trace source for auto-trace. */
  setTraceSource(source: TraceSource): void {
    this.traceSource = normalizeTraceSource(source);
  }

  /** Start a manual trace recording. */
  startRecording(): void {
    this.traceEventWriter.startRecording();
  }

  /** Stop recording and return the trace data. */
  async stopRecording(): Promise<{ json: string; bytes: number; source: TraceSource }> {
    const result = this.traceEventWriter.stopRecording();
    return { ...result, source: this.traceSource };
  }

  /** The last completed auto-trace payload, if any. */
  getLastAutoTrace(): { json: string; bytes: number; source: TraceSource } | null {
    return this.lastAutoTrace;
  }

  /** Check if currently recording. */
  isRecording(): boolean {
    return this.traceEventWriter.isRecording();
  }

  /**
   * Called each frame from the render loop. Drains the warning ring from the
   * ProfilingSAB, merges with renderer-side warnings, fires auto-trace if
   * needed, and ingests the snapshot into the TraceEventWriter if recording.
   */
  tick(): void {
    // Record frame start for event loop monitoring
    this.eventLoopMonitor?.recordFrameStart();

    // Write renderer metrics to the ProfilingSAB (heap, CPU, GC, tick count)
    this.tickCount++;
    if (this.writer) {
      const mem = (performance as any).memory; // performance.memory is non-standard; undefined outside Blink
      const cpuMs = performance.now() - this.cpuTimeStart;
      const now = performance.now();
      const frameMs = now - this.lastFrameMs;
      this.lastFrameMs = now;
      // CPU% = actual rAF callback work time / wall-clock frame time.
      // This is true utilization (0% when idle, ~4% when the renderer does
      // minimal work), NOT "frame time as % of 60fps budget" which was
      // always ~100% when called every frame.
      const workMs = this.eventLoopMonitor?.getLastWorkMs() ?? 0;
      const cpuPercent = frameMs > 0
        ? Math.min(100, (workMs / frameMs) * 100)
        : 0;
      this.writer.writeThreadMetrics({
        heapUsed: mem?.usedJSHeapSize ?? 0,
        heapTotal: mem?.totalJSHeapSize ?? 0,
        rss: mem?.jsHeapSizeLimit ?? 0,
        cpuTimeMs: cpuMs,
        cpuPercent,
        gcPauseTotalUs: 0,
        gcPauseCount: 0,
        gcPauseMaxUs: 0,
        tick: this.tickCount,
        taskCount: 1,
        taskLatencyP50Us: workMs * 1000,
        taskLatencyP95Us: workMs * 1000,
        taskLatencyP99Us: workMs * 1000,
        taskLatencyMaxUs: workMs * 1000,
      });
    }

    // Read the latest profiling snapshot
    const snapshot = this.reader.readSnapshot();
    this.lastSnapshot = snapshot;

    // Record frame end for event loop monitoring (writes event loop block)
    this.eventLoopMonitor?.recordFrameEnd();

    // Ingest into trace event writer if recording
    if (this.traceEventWriter.isRecording()) {
      this.traceEventWriter.ingestSnapshot(snapshot);
    }

    // Drain warning ring — merge worker warnings into the renderer's callback set
    for (let _i = 0, _it = snapshot.warnings, _n = _it.length; _i < _n; _i++) { const w = _it[_i];
      // Dedup by ruleIdHash + ts (a warning may appear in multiple reads)
      const warningId = `${w.ruleIdHash}:${w.ts}`;
      if (this.seenWarningIds.has(warningId)) continue;
      this.seenWarningIds.add(warningId);
      // Keep the set from growing unbounded
      if (this.seenWarningIds.size > 1000) {
        this.seenWarningIds.clear();
        this.seenWarningIds.add(warningId);
      }

      // Reconstruct the warning record for callbacks
      const record: WarningRecordData = {
        ruleId: "",
        ruleIdHash: w.ruleIdHash,
        severity: w.severity as SeverityLevel,
        metricKind: w.metricKind,
        value: w.value,
        threshold: w.threshold,
        workerTag: w.workerTag,
        ts: w.ts,
        autoTraceFired: w.autoTraceFired,
      };
      const ctx: WarningContext = {
        workerTag: w.workerTag,
        runtime: 0,
        rule: { id: "", severity: w.severity as SeverityLevel, metric: w.metricKind, compare: ">", threshold: w.threshold },
        autoTraceAvailable: false,
      };

      // Fire callbacks
      for (const cb of this.warningCallbacks.values()) {
        try { cb(record, ctx); } catch (err) {
          log.error("ProfilingBridge", `Warning callback error: ${err}`);
        }
      }

      // Auto-trace: if this warning has autoTrace and we're not already tracing,
      // start recording — then auto-stop after the rule's configured duration.
      // Without the stop the writer ingests a snapshot per frame forever and
      // the event array wedges the main thread.
      if (w.autoTraceFired && !this.autoTraceActive) {
        this.autoTraceActive = true;
        this.autoTraceWarningId = warningId;
        this.startRecording();
        log.warn("ProfilingBridge", `Auto-trace started due to warning ${w.ruleIdHash}`);
        const rule = this.warningEngine.getRules().find((r) => fnv1a32(r.id) === w.ruleIdHash);
        const durationMs = rule?.autoTrace?.durationMs ?? 3000;
        const timer = setTimeout(() => {
          this.autoTraceActive = false;
          this.autoTraceWarningId = null;
          void this.stopRecording().then((result) => {
            this.lastAutoTrace = result;
            log.info("ProfilingBridge", `Auto-trace captured ${result.bytes} bytes`);
          }).catch(() => {});
        }, durationMs);
        timer.unref?.();
      }
    }

    // Record frame start/end for the event-loop monitor
    this.eventLoopMonitor?.recordFrameStart();
  }

  /** Called at the end of the render frame (after render work completes). */
  endFrame(): void {
    this.eventLoopMonitor?.recordFrameEnd();
  }

  /** Get the latest profiling snapshot (for the profiler overlay to read). */
  getSnapshot(): ProfilingSnapshot | null {
    return this.lastSnapshot;
  }

  /** Dispose — stop monitors + clear state. */
  dispose(): void {
    this.eventLoopMonitor?.dispose();
    this.warningEngine.clearCallbacks();
    this.warningEngine.clearRules();
    this.warningCallbacks.clear();
    this.seenWarningIds.clear();
    this.lastSnapshot = null;
  }
}
