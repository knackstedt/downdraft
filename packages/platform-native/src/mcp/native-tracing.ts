// ============================================================================
// native-tracing.ts — tracing + heap-snapshot MCP tools for the native host.
//
// Tracing + heap-snapshot MCP tools for the single-process Bun runtime:
//
//   - trace_start/stop/status drive the in-engine TraceEventWriter fed by the
//     ProfilingSAB (engine instrumentation: task latency, GC pauses, event-loop
//     jitter, IOPS, warnings). The resulting
//     file is Chrome Trace Event JSON — loadable in chrome://tracing, Perfetto.
//   - trace_categories returns the engine's own category list.
//   - heap_snapshot uses Bun.generateHeapSnapshot("v8") — a real DevTools-
//     compatible .heapsnapshot of the calling thread's JSC heap. "main" and
//     "renderer" are the same process on native; both capture this heap.
//   - memory_dump writes a trace containing periodic memory instant events
//     (process.memoryUsage + JSC heapStats).
//   - trace_enable_heap_profiling is a documented no-op: JSC sampling isn't
//     configurable from JS; heap_snapshot always captures the full heap.
//
// The ProfilingBridge is resolved lazily per call (it doesn't exist until the
// game's initDevTools runs). Games without devtools.profiling get an honest
// error instead of an empty trace.
// ============================================================================

import { errorResult, jsonResult, type ToolRegistration } from "@downdraft/engine/mcp";
import {
    computeProfilingSABLayout,
    ProfilingSABReader,
    type ProfilingSABLayout,
} from "@downdraft/engine/profiling";
import { createLogger } from "@downdraft/engine/util/logger";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const log = createLogger("info");

/** Engine trace categories emitted by TraceEventWriter + instrumentation. */
const NATIVE_TRACE_CATEGORIES = [
  "task",          // per-slot task latency (p50/p95/p99/max)
  "gc",            // GC pause events
  "event-loop",    // rAF jitter / longtask / idle headroom
  "iops",          // storage IOPS records
  "iops.opfs",     // OPFS-backed store ops
  "iops.idb",      // IndexedDB-backed store ops
  "warning",       // warning-engine rule hits (instant events)
  "memory",        // memory_dump instant events
];

type TracePreset = "perf" | "memory" | "gpu" | "v8" | "custom";

const PRESET_CATEGORIES: Record<Exclude<TracePreset, "custom">, string[]> = {
  perf: ["task", "gc", "event-loop", "warning"],
  memory: ["memory", "gc", "warning"],
  gpu: ["task", "warning"],
  v8: ["gc", "task"],
};

interface RecordingMeta {
  startedAt: number;
  preset: TracePreset;
  categories: string[];
  recordingMode: string;
}

let recording = false;
let recordingMeta: RecordingMeta | null = null;
let recordTimer: ReturnType<typeof setInterval> | null = null;

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function fileSize(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

interface ProfilingBridgeLike {
  getTraceEventWriter(): {
    startRecording(): void;
    stopRecording(): { json: string; bytes: number; eventCount: number };
    isRecording(): boolean;
    ingestSnapshot?(snapshot: unknown): void;
  };
  /** Latest ProfilingSnapshot (null until the first tick). */
  getSnapshot?(): unknown;
  /** The global ProfilingSAB shared with all workers. */
  getProfilingSAB?(): SharedArrayBuffer;
  /** Serializable layout params for ProfilingSABReader construction. */
  getLayoutParams?(): {
    maxSlots: number;
    iopsRingCap: number;
    warningRingCap: number;
    stringTableCap: number;
  };
}

/** Resolve the game's ProfilingBridge (created by initDevTools in onReady). */
function getProfilingBridge(): ProfilingBridgeLike | null {
  const api = ((globalThis as any).window?.__sceneInspector ?? (globalThis as any).__sceneInspector) as
    | { __getProfilingBridge?: () => ProfilingBridgeLike }
    | undefined;
  return api?.__getProfilingBridge?.() ?? null;
}

function requireBridge(): ProfilingBridgeLike {
  const bridge = getProfilingBridge();
  if (!bridge) {
    throw new Error(
      "ProfilingBridge not available — the game must init devtools with profiling enabled (initDevTools({ profiling: true })).",
    );
  }
  return bridge;
}

/** Lazily-built reader over the game's ProfilingSAB (for tick-free reads). */
let liveReader: { reader: ProfilingSABReader; layout: ProfilingSABLayout } | null = null;

/** Read a fresh snapshot straight from the ProfilingSAB (no render tick needed). */
function readLiveSnapshot(bridge: ProfilingBridgeLike): unknown | null {
  const sab = bridge.getProfilingSAB?.();
  const params = bridge.getLayoutParams?.();
  if (!sab || !params) return null;
  if (!liveReader) {
    const layout = computeProfilingSABLayout(
      params.maxSlots, params.iopsRingCap, params.warningRingCap, params.stringTableCap,
    );
    liveReader = { reader: new ProfilingSABReader(sab, layout), layout };
  }
  try {
    return liveReader.reader.readSnapshot();
  } catch {
    return null;
  }
}

export interface NativeTracingOptions {
  /** ${userData}/debug-artifacts — traces/ and heaps/ are created inside. */
  artifactDir: string;
  /** MCP HTTP port, read lazily for artifact download URLs. */
  portRef: { current: number };
}

export function createNativeTracingTools(opts: NativeTracingOptions): ToolRegistration[] {
  const artifactDir = opts.artifactDir;
  const tracesDir = join(artifactDir, "traces");
  const heapsDir = join(artifactDir, "heaps");

  const ensureDirs = () =>
    Promise.all([mkdir(tracesDir, { recursive: true }), mkdir(heapsDir, { recursive: true })]);

  const downloadUrl = (rel: string) => `http://localhost:${opts.portRef.current}/mcp/artifact/${rel}`;

  async function startTrace(params: Record<string, unknown>) {
    const bridge = requireBridge();
    const writer = bridge.getTraceEventWriter();
    if (recording || writer.isRecording()) {
      throw new Error("A trace recording is already in progress. Call trace_stop first.");
    }
    const preset = (params.preset as TracePreset) ?? "perf";
    const recordingMode = (params.recordingMode as string) ?? "record-until-full";
    let categories: string[];
    if (preset === "custom") {
      categories = (params.categories as string[]) ?? [];
      if (categories.length === 0) {
        throw new Error("preset='custom' requires a non-empty 'categories' array.");
      }
    } else {
      categories = PRESET_CATEGORIES[preset];
    }
    writer.startRecording();
    recording = true;
    recordingMeta = { startedAt: Date.now(), preset, categories, recordingMode };
    // Sample the ProfilingSAB on an interval while recording. The render
    // loop's per-frame tick() also ingests when running — this interval
    // covers deterministic mode where frames only render on demand.
    recordTimer = setInterval(() => {
      const snap = readLiveSnapshot(bridge);
      if (snap) writer.ingestSnapshot?.(snap);
    }, 100);
    log.info("trace", `Started in-engine trace (preset=${preset})`);
    return { started: true, preset, categories, recordingMode };
  }

  async function stopTrace() {
    const bridge = requireBridge();
    const writer = bridge.getTraceEventWriter();
    if (!recording || !recordingMeta) {
      throw new Error("No trace recording in progress.");
    }
    if (recordTimer) {
      clearInterval(recordTimer);
      recordTimer = null;
    }
    const meta = recordingMeta;
    // Ingest a live SAB read so the trace always captures current state —
    // under deterministic mode the render loop may not have ticked the
    // bridge's per-frame ingestion during the recording window, but the sim
    // worker keeps writing its ProfilingSAB slot regardless.
    const snap = bridge.getSnapshot?.() ?? readLiveSnapshot(bridge);
    if (snap) writer.ingestSnapshot?.(snap);
    const result = writer.stopRecording();
    await ensureDirs();
    const filename = `${timestampSlug()}-${meta.preset}.json`;
    const finalPath = join(tracesDir, filename);
    await writeFile(finalPath, result.json);
    const sizeBytes = await fileSize(finalPath);
    const durationMs = Date.now() - meta.startedAt;
    recording = false;
    recordingMeta = null;
    const relativePath = `traces/${filename}`;
    log.info("trace", `Stopped in-engine trace → ${finalPath} (${sizeBytes} bytes, ${result.eventCount} events)`);
    return {
      stopped: true,
      path: finalPath,
      relativePath,
      downloadUrl: downloadUrl(relativePath),
      sizeBytes,
      durationMs,
      categories: meta.categories,
      preset: meta.preset,
      source: "in-engine",
      eventCount: result.eventCount,
    };
  }

  async function heapSnapshot(target: "main" | "renderer") {
    const Bun = (globalThis as any).Bun;
    if (typeof Bun?.generateHeapSnapshot !== "function") {
      throw new Error("Bun.generateHeapSnapshot is not available in this runtime.");
    }
    await ensureDirs();
    const filename = `${timestampSlug()}-${target}.heapsnapshot`;
    const finalPath = join(heapsDir, filename);
    // "v8" = DevTools-compatible .heapsnapshot JSON. Captures the calling
    // thread's JSC heap — worker heaps are separate (not yet reachable).
    const snapshot = Bun.generateHeapSnapshot("v8") as string;
    await writeFile(finalPath, snapshot);
    const sizeBytes = await fileSize(finalPath);
    const relativePath = `heaps/${filename}`;
    log.info("trace", `Heap snapshot → ${finalPath} (${sizeBytes} bytes)`);
    return {
      path: finalPath,
      relativePath,
      downloadUrl: downloadUrl(relativePath),
      sizeBytes,
      target,
    };
  }

  async function memoryDump(durationMs: number) {
    // Native memory-infra equivalent: N memory instant events carrying
    // process.memoryUsage + JSC heapStats, wrapped in a trace file.
    await ensureDirs();
    const samples: unknown[] = [];
    const startedAt = performance.now();
    const wallStart = Date.now();
    const sample = () => {
      const mem = process.memoryUsage();
      samples.push({
        name: "memory-dump",
        cat: "memory",
        ph: "i",
        s: "t",
        ts: (performance.now() - startedAt) * 1000,
        pid: 0,
        tid: 0,
        args: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
        },
      });
    };
    sample();
    const interval = setInterval(sample, Math.min(500, Math.max(50, durationMs / 4)));
    await new Promise((r) => setTimeout(r, durationMs));
    clearInterval(interval);
    sample();
    const filename = `${timestampSlug()}-memory.json`;
    const finalPath = join(tracesDir, filename);
    const json = JSON.stringify({ traceEvents: samples });
    await writeFile(finalPath, json);
    const relativePath = `traces/${filename}`;
    return {
      stopped: true,
      path: finalPath,
      relativePath,
      downloadUrl: downloadUrl(relativePath),
      sizeBytes: await fileSize(finalPath),
      durationMs: Date.now() - wallStart,
      preset: "memory",
      source: "in-engine",
      samples: samples.length,
    };
  }

  return [
    {
      def: {
        name: "trace_start",
        description:
          "Start an in-engine Chrome Trace Event recording. Captures the engine's ProfilingSAB instrumentation — task latency, GC pauses, event-loop jitter, IOPS, warnings. Stop with trace_stop; the file loads in chrome://tracing or perfetto.dev.",
        inputSchema: {
          type: "object",
          properties: {
            preset: {
              type: "string",
              enum: ["perf", "memory", "gpu", "v8", "custom"],
              description: "Category preset (default: perf). On native these select which engine categories are reported in the result; 'custom' uses 'categories'.",
              default: "perf",
            },
            categories: {
              type: "array",
              items: { type: "string" },
              description: "Category list for preset='custom'. See trace_categories.",
            },
            recordingMode: { type: "string", description: "Echoed for compatibility; in-engine recording is always record-until-full." },
          },
        },
      },
      handler: async (params) => {
        try {
          return jsonResult(await startTrace(params));
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },
    {
      def: {
        name: "trace_stop",
        description: "Stop the in-engine trace and write Chrome Trace Event JSON to debug-artifacts/traces/. Returns path, download URL, size, event count.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        try {
          return jsonResult(await stopTrace());
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },
    {
      def: {
        name: "trace_status",
        description: "Whether an in-engine trace is recording, plus preset/categories/start time.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        try {
          const writer = getProfilingBridge()?.getTraceEventWriter();
          return jsonResult({
            recording: recording || (writer?.isRecording() ?? false),
            startedAt: recordingMeta?.startedAt,
            preset: recordingMeta?.preset,
            categories: recordingMeta?.categories,
            recordingMode: recordingMeta?.recordingMode,
            source: "in-engine",
          });
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },
    {
      def: {
        name: "trace_categories",
        description: "List the engine's tracing categories.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => jsonResult({ categories: NATIVE_TRACE_CATEGORIES }),
    },
    {
      def: {
        name: "memory_dump",
        description:
          "Write a trace containing periodic memory instant events (process.memoryUsage: rss/heapTotal/heapUsed/external/arrayBuffers) over the given duration.",
        inputSchema: {
          type: "object",
          properties: {
            durationMs: { type: "number", description: "Recording duration (default: 2000ms).", default: 2000 },
          },
        },
      },
      handler: async (params) => {
        try {
          return jsonResult(await memoryDump((params.durationMs as number) ?? 2000));
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },
    {
      def: {
        name: "trace_enable_heap_profiling",
        description:
          "No-op on the native runtime — JSC heap sampling is not configurable from JS. heap_snapshot always captures the full heap via Bun.generateHeapSnapshot. Returns enabled=true for script compatibility.",
        inputSchema: {
          type: "object",
          properties: {
            mode: { type: "string", description: "Ignored on native." },
            samplingRate: { type: "number", description: "Ignored on native." },
            stackMode: { type: "string", description: "Ignored on native." },
          },
        },
      },
      handler: async (params) =>
        jsonResult({
          enabled: true,
          mode: (params.mode as string) ?? "all",
          note: "JSC heap sampling is not configurable; heap_snapshot captures the full heap.",
        }),
    },
    {
      def: {
        name: "heap_snapshot",
        description:
          "Capture a DevTools-compatible .heapsnapshot via Bun.generateHeapSnapshot('v8'). On native, 'main' and 'renderer' are the same process — both capture this thread's heap. Worker heaps are not reachable yet.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["main", "renderer"],
              description: "Kept for API parity — both capture the current thread's heap on native.",
              default: "main",
            },
          },
        },
      },
      handler: async (params) => {
        try {
          return jsonResult(await heapSnapshot((params.target as "main" | "renderer") ?? "main"));
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },
    {
      def: {
        name: "force_gc",
        description:
          "Force a JSC garbage collection via Bun.gc(). Useful before heap_snapshot for clean before/after comparisons. Returns heap stats before/after.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const Bun = (globalThis as any).Bun;
        if (typeof Bun?.gc !== "function") {
          return errorResult("Bun.gc is not available in this runtime.");
        }
        const before = process.memoryUsage();
        Bun.gc(true);
        const after = process.memoryUsage();
        return jsonResult({
          collected: true,
          heapUsedBefore: before.heapUsed,
          heapUsedAfter: after.heapUsed,
          freedBytes: before.heapUsed - after.heapUsed,
        });
      },
    },
  ];
}
