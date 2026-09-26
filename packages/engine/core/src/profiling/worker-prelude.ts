// ============================================================================
// Worker prelude — imported at the top of every instrumented worker.
//
// On load (worker realm only):
//   1. Detects worker tag (from __ddThreadTag if set, else assigns auto-<n>).
//   2. If a ProfilingSAB has been attached (via attachProfilingSAB called from
//      the host's init RPC), claims a slot, initializes ThreadMetricsWriter +
//      IopsRingWriter + worker-side WarningEngine + EventLoopMonitor.
//   3. Calls patchOpfsPrototypes() + patchIndexedDbPrototypes().
//   4. Installs a tick/interval hook to flush ThreadMetrics + EventLoop block.
//   5. Registers default warning rules.
//
// Exports: attachProfilingSAB, setWorkerTag, recordTaskLatency, getProfilingWriter,
//   getWarningEngine, getEventLoopMonitor, addWarningRule, onWarning.
//
// No-ops in the main realm (renderer) — only activates in a Web Worker.
//
// IMPORTANT: All module-level state is mirrored onto `self.__ddProfiling` so
// that multiple module instances (the Vite-injected side-effect import vs the
// dynamic import from exposeProfilingApi) share the same state. Without this,
// attachProfilingSAB runs in one instance and flushProfilingTick/recordTaskLatency
// run in another, resulting in metrics never being written.
// ============================================================================

import { GCTracker } from "../telemetry/gc-tracker";
import { createLogger } from "../util/logger";
import { EventLoopMonitor } from "./event-loop";
import { patchIndexedDbPrototypes, unpatchIndexedDbPrototypes } from "./iops/idb-patch";
import { patchOpfsPrototypes, unpatchOpfsPrototypes } from "./iops/opfs-patch";
import {
    claimSlot,
    computeProfilingSABLayout,
    fnv1a32,
    ProfilingSABWriter,
    RUNTIME_JS,
    type ProfilingSABLayout,
    type RuntimeKind
} from "./profiling-sab";
import { TaskLatencyHistogram } from "./task-latency";
import { ThreadMetricsWriter } from "./thread-metrics";
import {
    DEFAULT_WORKER_WARNING_RULES,
    METRIC_GC_PAUSE,
    METRIC_HEAP_PERCENT,
    METRIC_HEAP_USAGE,
    WarningEngine,
    type WarningRule
} from "./warnings";

const log = createLogger();

export interface ProfilingAttachConfig {
  workerTag: string;
  runtime?: RuntimeKind;
  opfs?: boolean;
  idb?: boolean;
  defaultWarningRules?: boolean;
  getHeap?: () => { heapUsed: number; heapTotal: number; rss: number };
  /** ProfilingSAB layout params. MUST match the params used to allocate the
   *  SAB on the renderer (see ProfilingBridge.getLayoutParams()). If omitted,
   *  the defaults (maxSlots=32) are used — which must match the allocator or
   *  atomic accesses will be out-of-bounds. A mismatch is detected and
   *  profiling is disabled for this worker rather than crashing. */
  layout?: {
    maxSlots: number;
    iopsRingCap: number;
    warningRingCap: number;
    stringTableCap: number;
  };
}

// ─── Shared state ───────────────────────────────────────────────────────────
// All state is stored on self.__ddProfiling so multiple module instances
// (from different import paths that Vite may not deduplicate) share it.

interface ProfilingState {
  isWorkerRealm: boolean;
  sab: SharedArrayBuffer | null;
  layout: ProfilingSABLayout | null;
  writer: ProfilingSABWriter | null;
  slotIndex: number;
  workerTag: string;
  workerTagHash: number;
  runtime: RuntimeKind;
  gcTracker: GCTracker | null;
  taskLatency: TaskLatencyHistogram | null;
  threadMetricsWriter: ThreadMetricsWriter | null;
  warningEngine: WarningEngine | null;
  eventLoopMonitor: EventLoopMonitor | null;
  flushInterval: ReturnType<typeof setInterval> | null;
  attached: boolean;
}

// Use globalThis which exists in workers, browsers, and Node.js (Electron main).
// `self` only exists in workers/browsers, not in Node, so we must not reference it
// at module top level in code that may be bundled into the Electron main process.
const GLOBAL = globalThis as any;

function getState(): ProfilingState {
  if (!GLOBAL.__ddProfiling) {
    GLOBAL.__ddProfiling = {
      isWorkerRealm: (typeof self !== "undefined" && typeof window === "undefined"),
      sab: null,
      layout: null,
      writer: null,
      slotIndex: -1,
      workerTag: "auto-0",
      workerTagHash: 0,
      runtime: RUNTIME_JS,
      gcTracker: null,
      taskLatency: null,
      threadMetricsWriter: null,
      warningEngine: null,
      eventLoopMonitor: null,
      flushInterval: null,
      attached: false,
    } as ProfilingState;
  }
  return GLOBAL.__ddProfiling as ProfilingState;
}

// Initialize immediately so isWorkerRealm is set at module load time
const state = getState();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Attach a ProfilingSAB to this worker. Called by the host's init RPC
 * (before user onInit). Claims a slot, initializes all writers + the
 * warning engine + event-loop monitor, and patches prototypes.
 */
export function attachProfilingSAB(
  sharedBuffer: SharedArrayBuffer,
  config: ProfilingAttachConfig,
): { slotIndex: number; success: boolean } {
  const s = getState();
  if (s.attached) return { slotIndex: s.slotIndex, success: true };
  if (!s.isWorkerRealm) return { slotIndex: -1, success: false };

  s.workerTag = config.workerTag;
  s.workerTagHash = fnv1a32(config.workerTag);
  s.runtime = config.runtime ?? RUNTIME_JS;
  s.sab = sharedBuffer;
  s.layout = config.layout
    ? computeProfilingSABLayout(
        config.layout.maxSlots,
        config.layout.iopsRingCap,
        config.layout.warningRingCap,
        config.layout.stringTableCap,
      )
    : computeProfilingSABLayout();

  // Defensive: if the computed layout doesn't match the actual buffer size,
  // the renderer allocated the SAB with different caps than we're assuming.
  // Proceeding would cause out-of-bounds Atomics access ("Invalid atomic
  // access index"). Disable profiling for this worker instead of crashing.
  if (s.layout.byteLength !== sharedBuffer.byteLength) {
    log.warn(
      "profiling",
      `SAB layout mismatch for worker "${s.workerTag}": ` +
        `computed ${s.layout.byteLength} bytes but buffer is ${sharedBuffer.byteLength} bytes ` +
        `(pass layout params matching ProfilingBridge.getLayoutParams()) — profiling disabled`,
    );
    s.sab = null;
    s.layout = null;
    return { slotIndex: -1, success: false };
  }

  // Claim a slot
  s.slotIndex = claimSlot(s.sab, s.layout, s.workerTagHash, s.runtime, s.workerTag);
  if (s.slotIndex < 0) {
    log.warn("profiling", `No free slots for worker "${s.workerTag}" — profiling disabled`);
    return { slotIndex: -1, success: false };
  }

  s.writer = new ProfilingSABWriter(s.sab, s.layout, s.slotIndex);

  // Initialize GC tracker
  s.gcTracker = new GCTracker(true);

  // Initialize task latency histogram
  s.taskLatency = new TaskLatencyHistogram();

  // Initialize warning engine
  s.warningEngine = new WarningEngine(s.writer);
  s.warningEngine.setWorkerTag(s.workerTagHash);
  s.warningEngine.setRuntime(s.runtime);
  s.warningEngine.setAutoTraceAvailable(false);

  // Register default warning rules
  if (config.defaultWarningRules !== false) {
    for (const rule of DEFAULT_WORKER_WARNING_RULES) {
      s.warningEngine.addRule(rule);
    }
  }

  // Initialize thread metrics writer with a heap estimator.
  // config.getHeap is passed via RPC (postMessage) so functions are stripped.
  // We use performance.memory if available, else estimate from the SAB + baseline.
  const sabByteLen = sharedBuffer.byteLength;
  s.threadMetricsWriter = new ThreadMetricsWriter(s.writer, {
    runtime: s.runtime,
    gcTracker: s.gcTracker,
    taskLatency: s.taskLatency,
    getHeap: () => {
      const perfMem = (performance as any).memory;
      if (perfMem) {
        return {
          heapUsed: perfMem.usedJSHeapSize ?? 0,
          heapTotal: perfMem.totalJSHeapSize ?? 0,
          rss: perfMem.jsHeapSizeLimit ?? 0,
        };
      }
      // Worker fallback: estimate from SAB + baseline runtime overhead
      const baseline = 2 * 1024 * 1024; // 2MB for worker runtime + code
      return { heapUsed: sabByteLen + baseline, heapTotal: sabByteLen + baseline, rss: sabByteLen + baseline };
    },
  });

  // Initialize event-loop monitor — use startLoop() for workers (no rAF)
  s.eventLoopMonitor = new EventLoopMonitor({
    writer: s.writer,
    warningEngine: s.warningEngine,
    expectedFrameMs: 16.67,
  });
  s.eventLoopMonitor.startLoop(250);

  // Patch prototypes
  if (config.opfs !== false) {
    patchOpfsPrototypes({ writer: s.writer, warningEngine: s.warningEngine, workerTag: s.workerTagHash });
  }
  if (config.idb !== false) {
    patchIndexedDbPrototypes({ writer: s.writer, warningEngine: s.warningEngine, workerTag: s.workerTagHash });
  }

  // Start a flush interval (fallback for non-sim workers; sim workers
  // call flushProfilingTick() from their tick loop)
  s.flushInterval = setInterval(() => {
    flushProfilingTick();
  }, 250);

  s.attached = true;
  return { slotIndex: s.slotIndex, success: true };
}

/** Set the worker tag (can be called before attachProfilingSAB). */
export function setWorkerTag(tag: string): void {
  const s = getState();
  s.workerTag = tag;
  s.workerTagHash = fnv1a32(tag);
  if (s.warningEngine) s.warningEngine.setWorkerTag(s.workerTagHash);
}

/**
 * Set a custom heap provider for this worker. Call after attachProfilingSAB()
 * if the worker has a way to estimate its own memory usage.
 */
export function setHeapProvider(fn: () => { heapUsed: number; heapTotal: number; rss: number }): void {
  const s = getState();
  if (s.threadMetricsWriter) {
    (s.threadMetricsWriter as any).opts.getHeap = fn;
  }
}

/**
 * Record a task latency sample. Called from wrapped task/tick execution.
 */
export function recordTaskLatency(runtimeStr: string, durationUs: number, name: string = "task"): void {
  const s = getState();
  if (!s.taskLatency || !s.warningEngine) return;
  s.taskLatency.record(durationUs, name);
  // Also accumulate work time for CPU% calculation (us → ms)
  if (s.threadMetricsWriter) s.threadMetricsWriter.recordWork(durationUs / 1000);
}

/**
 * Flush the profiling data for this tick. Called from the sim worker's tick
 * loop (or the interval fallback). Writes ThreadMetrics + EventLoop block
 * and fires instantaneous warnings for heap/cpu/gc.
 */
export function flushProfilingTick(): void {
  const s = getState();
  if (!s.threadMetricsWriter || !s.warningEngine) return;
  s.threadMetricsWriter.flush();
  s.eventLoopMonitor?.flush();

  // Fire instantaneous warnings for the just-written metrics
  const mem = GCTracker.getCurrentMemory();
  const heapPercent = mem.heapTotal > 0 ? (mem.heapUsed / mem.heapTotal) * 100 : 0;
  s.warningEngine.checkInstant(METRIC_HEAP_USAGE, mem.heapUsed);
  s.warningEngine.checkInstant(METRIC_HEAP_PERCENT, heapPercent);
  if (s.gcTracker && s.gcTracker.isEnabled()) {
    const gcStats = s.gcTracker.getStats();
    if (gcStats.pauseMax > 0) {
      s.warningEngine.checkInstant(METRIC_GC_PAUSE, gcStats.pauseMax * 1000);
    }
  }
}

/** Get the profiling writer (for direct IOPS record pushes). */
export function getProfilingWriter(): ProfilingSABWriter | null {
  return getState().writer;
}

/** Get the warning engine (for adding rules + subscribing to warnings). */
export function getWarningEngine(): WarningEngine | null {
  return getState().warningEngine;
}

/** Get the event-loop monitor. */
export function getEventLoopMonitor(): EventLoopMonitor | null {
  return getState().eventLoopMonitor;
}

/** Get the task latency histogram (for reading samples for the flame graph). */
export function getTaskLatencyHistogram(): TaskLatencyHistogram | null {
  return getState().taskLatency;
}

/** Add a warning rule to this worker's engine. */
export function addWarningRule(rule: WarningRule): void {
  getState().warningEngine?.addRule(rule);
}

/** Subscribe to warnings in this worker. Returns an unsubscribe function. */
export function onWarning(cb: (record: any, ctx: any) => void): () => void {
  const s = getState();
  if (!s.warningEngine) return () => {};
  return s.warningEngine.onWarning(cb);
}

/** Detach + clean up (called on worker shutdown / hot-reload). */
export function detachProfilingSAB(): void {
  const s = getState();
  if (s.flushInterval) {
    clearInterval(s.flushInterval);
    s.flushInterval = null;
  }
  unpatchOpfsPrototypes();
  unpatchIndexedDbPrototypes();
  s.eventLoopMonitor?.dispose();
  s.eventLoopMonitor = null;
  s.warningEngine?.clearCallbacks();
  s.warningEngine?.clearRules();
  s.warningEngine = null;
  s.threadMetricsWriter = null;
  s.taskLatency = null;
  s.gcTracker = null;
  s.writer = null;
  if (s.sab && s.layout && s.slotIndex >= 0) {
    const u32 = new Uint32Array(s.sab);
    const base = (s.layout.slotTableOffset / 4) + s.slotIndex * 6;
    Atomics.store(u32, base + 5, 0); // ALIVE = 0
    Atomics.add(u32, 4, 1); // EPOCH
    Atomics.sub(u32, 3, 1); // ACTIVE_SLOTS
  }
  s.sab = null;
  s.layout = null;
  s.slotIndex = -1;
  s.attached = false;
}

/** Check if profiling is attached in this worker. */
export function isProfilingAttached(): boolean {
  return getState().attached;
}

/** Get the current worker's slot index. */
export function getSlotIndex(): number {
  return getState().slotIndex;
}

// Re-export runtime constants for convenience
export { RUNTIME_JS, RUNTIME_QUICKJS, RUNTIME_WASM } from "./profiling-sab";
export { METRIC_TASK_LATENCY, METRIC_TICK_LATENCY } from "./warnings";

