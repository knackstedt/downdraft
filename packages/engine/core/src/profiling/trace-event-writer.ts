// ============================================================================
// TraceEventWriter — in-engine Chrome Trace Event format export.
//
// Serializes the ProfilingSAB's task/IOPS/GC/event-loop samples to Chrome
// Trace Event JSON. Pure-web/mobile compatible (no Electron dependency).
// The resulting .json is viewable in chrome://tracing, Perfetto UI, and Spall.
//
// Lower fidelity than contentTracing (no V8/GPU/compositor detail) but
// captures the engine's own instrumentation.
// ============================================================================

import type { ProfilingSnapshot, IopsRecordSnapshot, WarningRecordSnapshot } from "./profiling-sab";

interface TraceEvent {
  name: string;
  cat: string;
  ph: "B" | "E" | "X" | "i" | "M";
  ts: number; // microseconds
  pid: number;
  tid: number;
  dur?: number; // for "X" (complete) events
  args?: Record<string, unknown>;
}

export interface TraceEventWriterOptions {
  /** Include IOPS records as trace events. Default: true. */
  includeIops?: boolean;
  /** Include warning records as trace events. Default: true. */
  includeWarnings?: boolean;
  /** Include GC pause events. Default: true. */
  includeGc?: boolean;
}

export class TraceEventWriter {
  private events: TraceEvent[] = [];
  private recording: boolean = false;
  private startTimeMs: number = 0;
  private opts: TraceEventWriterOptions;

  constructor(opts: TraceEventWriterOptions = {}) {
    this.opts = {
      includeIops: true,
      includeWarnings: true,
      includeGc: true,
      ...opts,
    };
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Start recording. Clears any previous events. */
  startRecording(): void {
    this.events = [];
    this.recording = true;
    this.startTimeMs = performance.now();
  }

  /**
   * Ingest a ProfilingSnapshot. Called each frame while recording.
   * Converts the snapshot's data into Chrome Trace Event format.
   */
  ingestSnapshot(snapshot: ProfilingSnapshot): void {
    if (!this.recording) return;
    const tsOffsetUs = (performance.now() - this.startTimeMs) * 1000;

    snapshot.slots.forEach((slot) => {
      const pid = slot.slotIndex;
      const tid = slot.runtime;

      // Task latency as a complete event per slot
      const metrics = slot.metrics;
      if (metrics.taskCount > 0) {
        this.events.push({
          name: "task",
          cat: "task",
          ph: "X",
          ts: tsOffsetUs,
          dur: metrics.taskLatencyP95Us,
          pid,
          tid,
          args: {
            p50: metrics.taskLatencyP50Us,
            p95: metrics.taskLatencyP95Us,
            p99: metrics.taskLatencyP99Us,
            max: metrics.taskLatencyMaxUs,
            count: metrics.taskCount,
          },
        });
      }

      // GC pause events
      if (this.opts.includeGc && metrics.gcPauseCount > 0) {
        this.events.push({
          name: "gc",
          cat: "gc",
          ph: "X",
          ts: tsOffsetUs,
          dur: metrics.gcPauseMaxUs,
          pid,
          tid,
          args: {
            count: metrics.gcPauseCount,
            totalUs: metrics.gcPauseTotalUs,
            maxUs: metrics.gcPauseMaxUs,
          },
        });
      }

      // Event loop jitter
      const el = slot.eventLoop;
      if (el.rafJitterMaxUs > 0) {
        this.events.push({
          name: "raf-jitter",
          cat: "event-loop",
          ph: "X",
          ts: tsOffsetUs,
          dur: el.rafJitterMaxUs,
          pid,
          tid,
          args: {
            p50: el.rafJitterP50Us,
            p95: el.rafJitterP95Us,
            max: el.rafJitterMaxUs,
            longtaskCount: el.longtaskCount,
            longtaskMaxMs: el.longtaskMaxMs,
            idleHeadroomMs: el.idleHeadroomMs,
          },
        });
      }

      // IOPS records
      if (this.opts.includeIops) {
        slot.iopsRecords.forEach((iops) => {
          this.events.push(this.iopsToEvent(iops, pid, tid, slot.tagTable));
        });
      }
    });

    // Warnings as instant events
    if (this.opts.includeWarnings) {
      snapshot.warnings.forEach((w) => {
        this.events.push(this.warningToEvent(w));
      });
    }
  }

  /** Stop recording and return the Chrome Trace Event JSON. */
  stopRecording(): { json: string; bytes: number; eventCount: number } {
    this.recording = false;
    const json = JSON.stringify({ traceEvents: this.events });
    return {
      json,
      bytes: json.length,
      eventCount: this.events.length,
    };
  }

  private iopsToEvent(
    iops: IopsRecordSnapshot,
    pid: number,
    tid: number,
    tagTable: Map<number, string>,
  ): TraceEvent {
    const storeName = iops.store === 0 ? "opfs" : "idb";
    const tag = tagTable.get(iops.tagHash) ?? `hash:${iops.tagHash}`;
    return {
      name: `iops:${storeName}`,
      cat: `iops,${storeName}`,
      ph: "X",
      ts: iops.ts * 1000, // ms → us
      dur: iops.latencyUs,
      pid,
      tid,
      args: {
        op: iops.opKind,
        tag,
        bytes: iops.bytes,
        latencyUs: iops.latencyUs,
      },
    };
  }

  private warningToEvent(w: WarningRecordSnapshot): TraceEvent {
    const severityNames = ["info", "warn", "error", "critical"];
    const sev = severityNames[w.severity] ?? "unknown";
    return {
      name: `warning:${sev}`,
      cat: "warning",
      ph: "i",
      ts: w.ts * 1000,
      pid: 0,
      tid: 0,
      args: {
        ruleIdHash: w.ruleIdHash,
        severity: sev,
        metricKind: w.metricKind,
        value: w.value,
        threshold: w.threshold,
        workerTag: w.workerTag,
        autoTraceFired: w.autoTraceFired,
      },
    };
  }
}
