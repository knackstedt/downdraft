// ============================================================================
// model.ts — normalized target data model. CDP-domain-shaped internally so a
// real CDP transport, the downdraft mirror, the MCP channel, and external
// feeds all normalize into the same records.
// ============================================================================

import type { PanelSnapshot, ThreadInfo } from "@downdraft/engine/libraries/devtools";

export type { PanelSnapshot, ThreadInfo };
export type { MetricsSlot, ProfileJson, TreeRow, GpuInfoJson, SnapshotSection } from "@downdraft/engine/libraries/devtools";

// ── Console ──

export type ConsoleSource =
  | "console-api"     // Runtime.consoleAPICalled (log/info/warn/error/debug/trace/dir/assert/table)
  | "exception"       // Runtime.exceptionThrown
  | "log"             // Log.entryAdded / downdraft logger sink
  | "repl-echo"       // user expression echo
  | "repl-result"     // eval result
  | "system";         // viewer-side notices (attach, feed, hmr)

export type Severity = 0 | 1 | 2 | 3 | 4 | 5; // log, info, warn, error, debug, trace

/** CDP RemoteObject subset — kept live for lazy property expansion. */
export interface RemoteObjectRef {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  /** True when objectId is present and getProperties can lazily expand. */
  expandable?: boolean;
  /** CDP RemoteObject.preview.properties — cheap inline rendering. */
  previewProps?: { name: string; type?: string; value?: unknown }[];
}

export interface ConsoleEntry {
  seq: number;
  ts: number;                    // ms, performance.now-ish (normalized)
  source: ConsoleSource;
  consoleType?: string;          // raw console API type (log,table,group…)
  severity: Severity;
  thread: string;                // thread id/name it originated on
  text: string;                  // pre-serialized text (fast path)
  args?: RemoteObjectRef[];      // structured args when available
  url?: string; line?: number; col?: number;
  stack?: { functionName: string; url: string; line: number; col: number }[];
  /** Repl: seq of the echo row this result belongs to. */
  forSeq?: number;
  /** Async pending → resolved: "pending" | "resolved" | "rejected". */
  asyncState?: "pending" | "resolved" | "rejected";
  group?: string;                // console.group label (nesting)
  count?: { label: string; n: number }; // console.count aggregation
}

// ── Metrics ──

export interface MetricSeries {
  id: string;                    // e.g. "cpu.main", "heap.slot-1", "proc.rss", "feed.*"
  label: string;
  unit: "%" | "B" | "ms" | "us" | "ops" | "count";
  /** Lane group: thread id, "proc", "feed:x", "gpu". */
  group: string;
  color?: string;
  /** Ring buffer of [tsSec, value] pairs, newest last. */
  t: number[];                   // seconds
  v: number[];
  cap: number;
  min: number; max: number;
}

export function pushPoint(s: MetricSeries, t: number, v: number): void {
  s.t.push(t); s.v.push(v);
  if (s.t.length > s.cap) { s.t.splice(0, s.t.length - s.cap); s.v.splice(0, s.v.length - s.cap); }
  if (v < s.min) s.min = v;
  if (v > s.max) s.max = v;
}

// ── Threads ──

export interface ThreadRec {
  id: string;
  name: string;
  /** 0=main, 1=worker, 2=plugin, 3=task/procfs. */
  kind: number;
  runtime?: string;              // "bun"|"node"|"quickjs"|"wasm"
  /** Live metric lane ids for this thread. */
  series: string[];
  /** Eval-capable thread id — profiling slots map onto the registered eval
   *  thread of the same name; null when the thread can't evaluate. */
  evalId?: string | null;
}

// ── Events / markers (HMR, GC, lifecycle) ──

export interface EventMarker {
  seq: number;
  ts: number;
  kind: "attach" | "detach" | "hmr" | "gc" | "snapshot" | "profile" | "feed" | "error" | "lifecycle";
  label: string;
  detail?: string;
}

// ── Network ──

export interface NetworkEvent {
  id: string;
  ts: number;                    // request start (s)
  method: string;
  url: string;
  status?: number;
  mime?: string;
  /** Timeline segments in ms relative to ts. */
  timing?: { blocked?: number; connect?: number; tls?: number; send?: number; wait?: number; receive?: number };
  durationMs?: number;
  reqBytes?: number;
  resBytes?: number;
  protocol?: string;             // http1|http2|ws|fetch|data
  finished?: boolean;
  error?: string;
}

// ── Profiles ──

export interface ProfileNode {
  id: number;
  functionName: string;
  url: string;
  line: number;
  hitCount: number;
  children: number[];
  selfUs?: number;
  totalUs?: number;
}

export interface CpuProfile {
  nodes: ProfileNode[];
  startUs: number;
  endUs: number;
  samples: number[];
  timeDeltasUs: number[];
  thread?: string;
  source: "cdp" | "mirror" | "jsc" | "perf" | "artifact";
}

// ── Heap ──

export interface HeapClassRow {
  name: string;                  // constructor/type name
  count: number;
  shallow: number;               // bytes
  retained?: number;
}

export interface HeapSnapshotInfo {
  format: "v8" | "jsc";
  totalBytes: number;
  objectCount: number;
  takenAt: number;
  classes: HeapClassRow[];       // top-N constructor summary
  rawPath?: string;              // where the raw artifact was written
}

// ── Plugins / custom panels ──

export interface PluginRec {
  id: string;
  name: string;
  version?: string;
  format?: string;               // worker-js|quickjs|wasm|asset
  tier?: string;
  state?: string;                // loaded|error|unloaded
  error?: string;
}

export interface ProviderPanel {
  slot: number;
  name: string;
  lastSnapshot?: PanelSnapshot;
  lastPush?: number;
}
