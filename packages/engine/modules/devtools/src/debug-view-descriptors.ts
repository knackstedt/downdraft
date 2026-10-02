// ============================================================================
// Debug View Descriptors — declarative registration of in-game profiler views.
//
// Profiling surfaces read these descriptors to know which views to render.
// The devtools module registers the 10 built-in views; games can register
// custom views via devtools.registerView().
//
// View kinds:
//   memory, cpu, task-latency, iops-opfs, iops-idb, event-loop,
//   gc-heap, flame-graph, gpu-passes, warnings
// ============================================================================

/** The 10 built-in view kinds. */
export type BuiltinViewKind =
  | "memory"
  | "cpu"
  | "task-latency"
  | "iops-opfs"
  | "iops-idb"
  | "event-loop"
  | "gc-heap"
  | "flame-graph"
  | "gpu-passes"
  | "warnings";

/** A view descriptor — describes a panel in the profiler overlay. */
export interface DebugViewDescriptor {
  /** Unique id for this view (e.g. "memory", "cpu", "custom:foo"). */
  id: string;
  /** Display label shown in the view selector. */
  label: string;
  /** The view kind — determines which data source the ProfilerScene reads. */
  kind: BuiltinViewKind | "custom";
  /** Icon name (rendered by the ProfilerScene). */
  icon?: string;
  /** Order/priority for view placement. Built-in views: 0-100. Default: 100. */
  order?: number;
  /** Whether this view is visible by default. Default: true. */
  visible?: boolean;
  /** Optional tooltip describing the view. */
  tooltip?: string;
  /** For custom views: the scene module URL that renders this view.
   *  The ProfilerScene dynamically imports it and calls its factory. */
  customSceneUrl?: string;
}

/** The 10 built-in view descriptors. */
export const BUILTIN_VIEW_DESCRIPTORS: DebugViewDescriptor[] = [
  { id: "memory", label: "Memory", kind: "memory", icon: "memory", order: 0, tooltip: "Heap usage per worker" },
  { id: "cpu", label: "CPU", kind: "cpu", icon: "cpu", order: 1, tooltip: "CPU time + frame time per worker" },
  { id: "task-latency", label: "Task Latency", kind: "task-latency", icon: "latency", order: 2, tooltip: "Task/tick latency percentiles" },
  { id: "iops-opfs", label: "IOPS: OPFS", kind: "iops-opfs", icon: "disk", order: 3, tooltip: "OPFS I/O operations" },
  { id: "iops-idb", label: "IOPS: IDB", kind: "iops-idb", icon: "database", order: 4, tooltip: "IndexedDB I/O operations" },
  { id: "event-loop", label: "Event Loop", kind: "event-loop", icon: "loop", order: 5, tooltip: "rAF jitter, long tasks, idle headroom" },
  { id: "gc-heap", label: "GC & Heap", kind: "gc-heap", icon: "gc", order: 6, tooltip: "GC pauses, heap over time, snapshot + force-GC" },
  { id: "flame-graph", label: "Flame Graph", kind: "flame-graph", icon: "flame", order: 7, tooltip: "Puffin-style task latency flame graph" },
  { id: "gpu-passes", label: "GPU Passes", kind: "gpu-passes", icon: "gpu", order: 8, tooltip: "WebGPU pass timings (render/compute/blit)" },
  { id: "warnings", label: "Warnings", kind: "warnings", icon: "warning", order: 9, tooltip: "Profiling warnings + auto-trace log" },
];
