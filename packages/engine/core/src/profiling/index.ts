// ============================================================================
// @downdraft/engine/profiling — public API barrel
//
// Re-exports all profiling types + functions for use by workers, the
// devtools module, the profiler library, and games.
// ============================================================================

// SAB layout + reader/writer
export {
    allocateProfilingSAB,
    claimSlot, computeProfilingSABLayout, fnv1a32, METRIC_CPU_PERCENT, METRIC_CUSTOM, METRIC_GC_PAUSE, METRIC_GPU_TIME, METRIC_HEAP_PERCENT, METRIC_HEAP_USAGE, METRIC_IOPS_LATENCY, METRIC_LONGTASK, METRIC_RAF_JITTER, METRIC_TASK_LATENCY, METRIC_TICK_LATENCY, PROFILING_IOPS_RING_CAP, PROFILING_MAGIC, PROFILING_MAX_SLOTS, PROFILING_STRING_MAX_LEN, PROFILING_STRING_TABLE_CAP, PROFILING_VERSION, PROFILING_WARNING_RING_CAP, ProfilingSABReader, ProfilingSABWriter, releaseSlot, RUNTIME_JS,
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

// IOPS patches
export {
    OPFS_OP_CREATE_SYNC_ACCESS_HANDLE,
    OPFS_OP_CREATE_WRITABLE, OPFS_OP_GET_DIR_HANDLE, OPFS_OP_GET_FILE, OPFS_OP_GET_FILE_HANDLE, OPFS_OP_STREAM_CLOSE, OPFS_OP_STREAM_WRITE, OPFS_OP_SYNC_CLOSE, OPFS_OP_SYNC_FLUSH, OPFS_OP_SYNC_READ, OPFS_OP_SYNC_WRITE, patchOpfsPrototypes, unpatchOpfsPrototypes
} from "./iops/opfs-patch";
export type { IopsPatchOptions } from "./iops/opfs-patch";

export {
    IDB_OP_ADD, IDB_OP_CLEAR, IDB_OP_CLOSE, IDB_OP_COUNT, IDB_OP_DATABASES, IDB_OP_DELETE, IDB_OP_GET, IDB_OP_GET_ALL,
    IDB_OP_GET_ALL_KEYS, IDB_OP_OBJECT_STORE, IDB_OP_OPEN, IDB_OP_OPEN_CURSOR,
    IDB_OP_OPEN_KEY_CURSOR, IDB_OP_PUT, IDB_OP_TRANSACTION, patchIndexedDbPrototypes, unpatchIndexedDbPrototypes
} from "./iops/idb-patch";
export type { IdbPatchOptions } from "./iops/idb-patch";

// Renderer IDB disable
export {
    disableRendererIndexedDb, enableAllRendererIndexedDb, enableRendererIndexedDb, isRendererIndexedDbDisabled
} from "./iops/renderer-idb-disable";

// Worker prelude
export {
    addWarningRule, attachProfilingSAB, detachProfilingSAB, flushProfilingTick, getEventLoopMonitor, getProfilingWriter, getSlotIndex, getTaskLatencyHistogram, getWarningEngine, isProfilingAttached, onWarning, recordTaskLatency, setHeapProvider, setWorkerTag
} from "./worker-prelude";
export type { ProfilingAttachConfig } from "./worker-prelude";

