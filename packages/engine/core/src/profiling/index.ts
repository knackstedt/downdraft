// ============================================================================
// @downdraft/engine/profiling — public API barrel
//
// Re-exports all profiling types + functions for use by workers, the
// devtools module, the profiler library, and games.
// ============================================================================

// SAB layout + reader/writer
export {
    allocateProfilingSAB,
    claimSlot, computeProfilingSABLayout, fnv1a32, METRIC_CPU_PERCENT, METRIC_CUSTOM, METRIC_GC_PAUSE, METRIC_GPU_TIME, METRIC_HEAP_PERCENT, METRIC_HEAP_USAGE, METRIC_IOPS_LATENCY, METRIC_LONGTASK, METRIC_RAF_JITTER, METRIC_TASK_LATENCY, METRIC_TICK_LATENCY, PROFILING_IOPS_RING_CAP, PROFILING_MAGIC, PROFILING_MAX_SLOTS, PROFILING_STRING_MAX_LEN, PROFILING_STRING_TABLE_CAP, PROFILING_VERSION, PROFILING_WARNING_RING_CAP, profilingLayoutFromSab, ProfilingSABReader, ProfilingSABWriter, releaseSlot, RUNTIME_JS,
    RUNTIME_QUICKJS,
    RUNTIME_WASM, SEVERITY_CRITICAL, SEVERITY_ERROR, SEVERITY_INFO,
    SEVERITY_WARN, STORE_IDB, STORE_OPFS
} from "./profiling-sab";
export type {
    EventLoopSnapshot,
    IopsRecordSnapshot, ProfilingSABLayout, ProfilingSnapshot, RuntimeKind,
    SeverityLevel,
    SlotSnapshot,
    ThreadMetricsSnapshot, WarningRecordSnapshot
} from "./profiling-sab";

// Task latency
export { TaskLatencyHistogram } from "./task-latency";
export type { LatencySample } from "./task-latency";

// Thread metrics
export { ThreadMetricsWriter } from "./thread-metrics";
export type { ThreadMetricsWriterOptions } from "./thread-metrics";

// Event loop
export { EventLoopMonitor } from "./event-loop";

// Warnings
export {
    DEFAULT_RENDERER_WARNING_RULES, DEFAULT_WORKER_WARNING_RULES, WarningEngine
} from "./warnings";
export type {
    AutoTraceConfig, MetricKind, TracePreset,
    TraceSource, WarningCallback,
    WarningContext,
    WarningRecordData, WarningRule
} from "./warnings";

// Trace event writer
export { TraceEventWriter } from "./trace-event-writer";
export type { TraceEventWriterOptions } from "./trace-event-writer";

// Worker prelude
export {
    addWarningRule, attachProfilingSAB, detachProfilingSAB, flushProfilingTick, getEventLoopMonitor, getProfilingWriter, getSlotIndex, getTaskLatencyHistogram, getWarningEngine, isProfilingAttached, onWarning, recordTaskLatency, setHeapProvider, setWorkerTag
} from "./worker-prelude";
export type { ProfilingAttachConfig } from "./worker-prelude";

