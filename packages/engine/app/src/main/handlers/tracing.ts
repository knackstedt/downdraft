// ============================================================================
// Tracing + memory-dump toolkit — main-process debugging tools
//
// Exposes Chrome/Perfetto trace recording (contentTracing), memory dumps
// (disabled-by-default-memory-infra + heap profiling), V8 heap snapshots
// (main process via v8.writeHeapSnapshot, renderer via CDP), and a process
// snapshot. Designed for debugging fully built games that may not have
// DevTools access.
//
// Two trigger surfaces:
//   - MCP tools (returned by createTracingTools) — handled locally in the
//     MCP proxy (no renderer round-trip).
//   - IPC handlers (registerTracingHandlers) — exposed on the preload bridge
//     so the devtools panel / renderer can add a "Record trace" button.
//
// Generated files are written to ${userData}/debug-artifacts/{traces,heaps}/
// and are downloadable via the MCP transport's GET /mcp/artifact/<path>
// endpoint.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { errorResult, jsonResult, type ToolRegistration } from "@downdraft/engine/mcp";
import { contentTracing, ipcMain } from "electron";
import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as v8 from "node:v8";
import { IPC } from "../../shared/messages";
import type {
    HeapSnapshotResult,
    ProcessSnapshotResult,
    TracePreset,
    TraceStartOptions,
    TraceStartResult,
    TraceStatusResult,
    TraceStopResult,
} from "../../shared/electron-bridge-types";
import type { MainContext } from "../types";

// Re-export the result types for convenience (e.g. game main.ts imports).
export type {
    HeapSnapshotResult,
    ProcessSnapshotResult,
    TracePreset,
    TraceStartOptions,
    TraceStartResult,
    TraceStatusResult,
    TraceStopResult
};

const log = createLogger("info");

// --- Recording state (process-wide; contentTracing allows one recording) ---

interface RecordingMeta {
  startedAt: number;
  preset: TracePreset;
  categories: string[];
  recordingMode: string;
}

let recording = false;
let recordingMeta: RecordingMeta | null = null;

// --- Artifact directory ---

let artifactDir: string | null = null;

async function getArtifactDir(ctx: MainContext): Promise<string> {
  if (artifactDir) return artifactDir;
  const userData = ctx.app.getPath("userData");
  artifactDir = join(userData, "debug-artifacts");
  await mkdir(join(artifactDir, "traces"), { recursive: true });
  await mkdir(join(artifactDir, "heaps"), { recursive: true });
  return artifactDir;
}

// --- Trace presets ---
// `TracePreset` (from shared/types) includes "custom"; the preset lookup
// table only covers the built-in presets.

type BuiltinPreset = Exclude<TracePreset, "custom">;

const PRESET_CATEGORIES: Record<BuiltinPreset, string[]> = {
  perf: [
    "toplevel",
    "v8",
    "disabled-by-default-v8.runtime_stats",
    "gpu",
    "viz",
    "netlog",
    "electron",
    "blink",
    "cc",
    "disabled-by-default-devtools.timeline",
  ],
  memory: [
    "disabled-by-default-memory-infra",
    "gpu",
    "viz",
    "electron",
  ],
  gpu: [
    "gpu",
    "viz",
    "disabled-by-default-gpu.debug",
    "disabled-by-default-gpu.service",
    "gl",
    "angle",
  ],
  v8: [
    "v8",
    "disabled-by-default-v8.runtime_stats",
    "disabled-by-default-v8.gc",
    "v8.execute",
  ],
};

// --- Helpers ---

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function fileStats(p: string): Promise<number> {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Cross-device-safe file move. `fs.rename` fails with EXDEV when the source
 * and destination are on different filesystems (e.g. Chromium's temp trace
 * file in /tmp vs the artifact dir in ~/.config). Fall back to copy + unlink.
 */
async function safeMove(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EXDEV") {
      await copyFile(src, dest);
      await unlink(src).catch(() => {});
    } else {
      throw err;
    }
  }
}

// --- Core operations (shared by MCP tools + IPC handlers) ---

async function startTrace(opts: TraceStartOptions): Promise<TraceStartResult> {
  if (recording) {
    throw new Error("A trace recording is already in progress. Call trace_stop first.");
  }
  const preset: TracePreset = opts.preset ?? "perf";
  const recordingMode = opts.recordingMode ?? "record-until-full";
  let categories: string[];
  let memoryDumpConfig: Record<string, unknown> | undefined;

  if (preset === "custom") {
    categories = opts.categories ?? [];
    if (categories.length === 0) {
      throw new Error("preset='custom' requires a non-empty 'categories' array.");
    }
  } else {
    categories = PRESET_CATEGORIES[preset];
  }

  if (preset === "memory" || categories.includes("disabled-by-default-memory-infra")) {
    // Heap profiling must be enabled before startRecording for memory-infra.
    // mode='all' profiles all processes (main + renderer + GPU + utility).
    await contentTracing.enableHeapProfiling({ mode: "all" });
    if (opts.memoryDumpIntervalMs && opts.memoryDumpIntervalMs > 0) {
      memoryDumpConfig = { periodic_interval_ms: opts.memoryDumpIntervalMs };
    } else if (preset === "memory") {
      memoryDumpConfig = { periodic_interval_ms: 1000 };
    }
  }

  const config: Record<string, unknown> = {
    included_categories: categories,
    excluded_categories: [],
    recording_mode: recordingMode,
  };
  if (opts.bufferSizeKB && opts.bufferSizeKB > 0) {
    config.trace_buffer_size_in_kb = opts.bufferSizeKB;
  }
  if (memoryDumpConfig) {
    config.memory_dump_config = memoryDumpConfig;
  }

  await contentTracing.startRecording(config as any);
  recording = true;
  recordingMeta = {
    startedAt: Date.now(),
    preset,
    categories,
    recordingMode,
  };
  log.info("trace", `Started recording (preset=${preset}, mode=${recordingMode}, ${categories.length} categories)`);
  return { started: true, preset, categories, recordingMode };
}

async function stopTrace(ctx: MainContext, port: number): Promise<TraceStopResult> {
  if (!recording || !recordingMeta) {
    throw new Error("No trace recording in progress.");
  }
  const meta = recordingMeta;
  const tempPath = await contentTracing.stopRecording();
  const dir = await getArtifactDir(ctx);
  const filename = `${timestampSlug()}-${meta.preset}.json`;
  const finalPath = join(dir, "traces", filename);
  await safeMove(tempPath, finalPath);
  const sizeBytes = await fileStats(finalPath);
  const durationMs = Date.now() - meta.startedAt;
  const relativePath = `traces/${filename}`;
  const downloadUrl = `http://localhost:${port}/mcp/artifact/${relativePath}`;
  recording = false;
  recordingMeta = null;
  log.info("trace", `Stopped recording → ${finalPath} (${sizeBytes} bytes, ${durationMs}ms)`);
  return {
    stopped: true,
    path: finalPath,
    relativePath,
    downloadUrl,
    sizeBytes,
    durationMs,
    categories: meta.categories,
    preset: meta.preset,
  };
}

async function traceStatus(): Promise<TraceStatusResult> {
  let bufferUsage: { value: number; percentage: number } | undefined;
  if (recording) {
    try {
      const usage = await contentTracing.getTraceBufferUsage();
      bufferUsage = { value: usage.value, percentage: usage.percentage };
    } catch {
      // best-effort
    }
  }
  return {
    recording,
    startedAt: recordingMeta?.startedAt,
    preset: recordingMeta?.preset,
    categories: recordingMeta?.categories,
    recordingMode: recordingMeta?.recordingMode,
    bufferUsage,
  };
}

async function traceCategories(): Promise<{ categories: string[] }> {
  const categories = await contentTracing.getCategories();
  return { categories };
}

async function memoryDump(ctx: MainContext, port: number, durationMs = 2000): Promise<TraceStopResult> {
  if (recording) {
    throw new Error("A trace recording is already in progress. Call trace_stop first.");
  }
  // Start a memory-infra recording with periodic dumps, wait, then stop.
  await startTrace({
    preset: "memory",
    recordingMode: "record-until-full",
    memoryDumpIntervalMs: Math.min(500, durationMs / 2),
  });
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  return stopTrace(ctx, port);
}

type HeapProfilingMode =
  | "all"
  | "browser"
  | "gpu"
  | "minimal"
  | "renderer-sampling"
  | "all-renderers"
  | "utility-sampling"
  | "all-utilities"
  | "utility-and-browser";

async function enableHeapProfiling(
  mode: HeapProfilingMode = "all",
  samplingRate?: number,
  stackMode?: "native" | "native-with-thread-names",
): Promise<{ enabled: boolean; mode: string }> {
  const opts: Record<string, unknown> = { mode };
  if (samplingRate && samplingRate > 0) opts.samplingRate = samplingRate;
  if (stackMode) opts.stackMode = stackMode;
  await contentTracing.enableHeapProfiling(opts as any);
  return { enabled: true, mode };
}

async function heapSnapshot(ctx: MainContext, port: number, target: "main" | "renderer" = "renderer"): Promise<HeapSnapshotResult> {
  const dir = await getArtifactDir(ctx);
  const filename = `${timestampSlug()}-${target}.heapsnapshot`;
  const finalPath = join(dir, "heaps", filename);

  if (target === "main") {
    v8.writeHeapSnapshot(finalPath);
    const sizeBytes = await fileStats(finalPath);
    const relativePath = `heaps/${filename}`;
    const downloadUrl = `http://localhost:${port}/mcp/artifact/${relativePath}`;
    log.info("trace", `Main-process heap snapshot → ${finalPath} (${sizeBytes} bytes)`);
    return { path: finalPath, relativePath, downloadUrl, sizeBytes, target: "main" };
  }

  // Renderer: use CDP HeapProfiler via webContents.debugger.
  if (!ctx.window || ctx.window.isDestroyed()) {
    throw new Error("No renderer window available for heap snapshot.");
  }
  const wc = ctx.window.webContents;
  const dbg = wc.debugger;
  if (dbg.isAttached()) {
    throw new Error("DevTools debugger is already attached to the renderer. Close DevTools before capturing a renderer heap snapshot via CDP.");
  }
  const chunks: string[] = [];
  const chunkListener = (_event: unknown, method: string, params: any) => {
    if (method === "HeapProfiler.addHeapSnapshotChunk" && params?.chunk) {
      chunks.push(params.chunk);
    }
  };
  try {
    dbg.attach();
    dbg.on("message", chunkListener as any);
    await dbg.sendCommand("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(finalPath, chunks.join(""));
    const sizeBytes = await fileStats(finalPath);
    const relativePath = `heaps/${filename}`;
    const downloadUrl = `http://localhost:${port}/mcp/artifact/${relativePath}`;
    log.info("trace", `Renderer heap snapshot → ${finalPath} (${sizeBytes} bytes, ${chunks.length} chunks)`);
    return { path: finalPath, relativePath, downloadUrl, sizeBytes, target: "renderer", chunks: chunks.length };
  } catch (e) {
    throw new Error(`Renderer heap snapshot failed: ${(e as Error).message}`);
  } finally {
    try {
      dbg.off("message", chunkListener as any);
      if (dbg.isAttached()) dbg.detach();
    } catch {
      // ignore
    }
  }
}

async function processSnapshot(ctx: MainContext, target: "main" | "renderer" = "main"): Promise<ProcessSnapshotResult> {
  const timestamp = Date.now();
  if (target === "main") {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      target: "main",
      timestamp,
      main: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        cpuUser: cpu.user,
        cpuSystem: cpu.system,
        uptimeSec: process.uptime(),
      },
    };
  }
  // Renderer: CDP Performance.getMetrics + Memory.getDOMCounters
  if (!ctx.window || ctx.window.isDestroyed()) {
    throw new Error("No renderer window available for process snapshot.");
  }
  const wc = ctx.window.webContents;
  const dbg = wc.debugger;
  if (dbg.isAttached()) {
    throw new Error("DevTools debugger is already attached to the renderer. Close DevTools before capturing a renderer process snapshot via CDP.");
  }
  try {
    dbg.attach();
    const metricsRes = await dbg.sendCommand("Performance.getMetrics");
    const metrics: Record<string, number> = {};
    if (Array.isArray(metricsRes?.metrics)) {
      metricsRes.metrics.forEach((m: any) => {
        metrics[m.name] = m.value;
      });
    }
    let domCounters: Record<string, number> | undefined;
    try {
      const domRes = await dbg.sendCommand("Memory.getDOMCounters");
      if (domRes) {
        domCounters = {
          documents: domRes.documents ?? 0,
          nodes: domRes.nodes ?? 0,
          jsEventListeners: domRes.jsEventListeners ?? 0,
        };
      }
    } catch {
      // getDOMCounters not available in all Chromium versions
    }
    return { target: "renderer", timestamp, renderer: { metrics, domCounters } };
  } catch (e) {
    throw new Error(`Renderer process snapshot failed: ${(e as Error).message}`);
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      // ignore
    }
  }
}

// --- MCP tools ---

/**
 * Create the tracing/heap-snapshot/process-snapshot MCP tools.
 * These are handled locally in the main-process MCP proxy (no renderer round-trip).
 *
 * @param portRef A mutable holder for the MCP HTTP port. The port is read
 *   lazily at tool-call time (not capture time) because the transport may
 *   bind to an ephemeral OS-assigned port after these tools are created.
 */
export function createTracingTools(ctx: MainContext, portRef: { current: number }): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "trace_start",
        description:
          "Start a Chrome/Perfetto trace recording (contentTracing). The trace is captured across all Electron processes (main, renderer, GPU, utility). Stop it with trace_stop. The result file is loadable in chrome://tracing and the Perfetto UI (perfetto.dev). Use preset='memory' for memory dumps (viewable in chrome://tracing only — Perfetto UI does not support memory dumps yet).",
        inputSchema: {
          type: "object",
          properties: {
            preset: {
              type: "string",
              enum: ["perf", "memory", "gpu", "v8", "custom"],
              description: "Category preset. 'perf' (default): general performance. 'memory': memory-infra + heap profiling + periodic dumps. 'gpu': GPU/GPU service/debug. 'v8': V8 runtime stats + GC. 'custom': use the 'categories' array.",
              default: "perf",
            },
            categories: {
              type: "array",
              items: { type: "string" },
              description: "Tracing categories (used when preset='custom'). See trace_categories for the full list. Supports glob patterns with trailing '*'.",
            },
            recordingMode: {
              type: "string",
              enum: ["record-until-full", "record-continuously", "record-as-much-as-possible", "trace-to-console"],
              description: "Recording mode (default: record-until-full).",
              default: "record-until-full",
            },
            bufferSizeKB: {
              type: "number",
              description: "Maximum trace buffer size in KB (default: 100MB / 102400 KB).",
            },
            memoryDumpIntervalMs: {
              type: "number",
              description: "Periodic memory dump interval in ms (only for memory-infra). Default: 1000 for preset='memory'.",
            },
          },
        },
      },
      handler: async (params) => {
        try {
          const result = await startTrace({
            preset: params.preset as TracePreset | undefined,
            categories: params.categories as string[] | undefined,
            recordingMode: params.recordingMode as TraceStartOptions["recordingMode"] | undefined,
            bufferSizeKB: params.bufferSizeKB as number | undefined,
            memoryDumpIntervalMs: params.memoryDumpIntervalMs as number | undefined,
          });
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      def: {
        name: "trace_stop",
        description:
          "Stop the current trace recording and write the trace to disk. Returns the file path, a download URL, size, and duration. Open the file in chrome://tracing or perfetto.dev.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        try {
          const result = await stopTrace(ctx, portRef.current);
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      def: {
        name: "trace_status",
        description: "Get the current trace recording status: whether a recording is in progress, its preset/categories/mode, and current trace buffer usage.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        try {
          const result = await traceStatus();
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      def: {
        name: "trace_categories",
        description: "List all available tracing category groups. Use these with trace_start (preset='custom').",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        try {
          const result = await traceCategories();
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      def: {
        name: "memory_dump",
        description:
          "Convenience one-shot memory dump: enables heap profiling, starts a memory-infra trace with periodic dumps, waits for the given duration, then stops and writes the trace. The resulting trace contains 'M' (memory dump) events viewable in chrome://tracing (NOT the Perfetto UI). Returns the same shape as trace_stop.",
        inputSchema: {
          type: "object",
          properties: {
            durationMs: {
              type: "number",
              description: "How long to record before stopping (default: 2000ms).",
              default: 2000,
            },
          },
        },
      },
      handler: async (params) => {
        try {
          const durationMs = (params.durationMs as number) ?? 2000;
          const result = await memoryDump(ctx, portRef.current, durationMs);
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      def: {
        name: "trace_enable_heap_profiling",
        description:
          "Enable V8/Chromium heap profiling for memory-infra traces. Must be called before trace_start when you want heap profiling with a custom category set (the 'memory' preset and memory_dump tool do this automatically). Controls which processes are profiled and the sampling rate.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: [
                "all",
                "browser",
                "gpu",
                "minimal",
                "renderer-sampling",
                "all-renderers",
                "utility-sampling",
                "all-utilities",
                "utility-and-browser",
              ],
              description: "Which processes to profile (default: all). 'all' = main + renderer + GPU + utility. 'minimal' = main only. 'renderer-sampling'/'all-renderers' = renderer process(es).",
              default: "all",
            },
            samplingRate: {
              type: "number",
              description: "Sampling interval in bytes (lower = more precise, higher overhead). Must be 1000-10000000. Default: 100000 (100KB).",
            },
            stackMode: {
              type: "string",
              enum: ["native", "native-with-thread-names"],
              description: "Type of metadata recorded for each allocation (default: native).",
            },
          },
        },
      },
      handler: async (params) => {
        try {
          const mode = (params.mode as HeapProfilingMode) ?? "all";
          const samplingRate = params.samplingRate as number | undefined;
          const stackMode = params.stackMode as "native" | "native-with-thread-names" | undefined;
          const result = await enableHeapProfiling(mode, samplingRate, stackMode);
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      def: {
        name: "heap_snapshot",
        description:
          "Capture a V8 heap snapshot (.heapsnapshot) loadable in the DevTools Memory tab. target='main' captures the Electron main process (v8.writeHeapSnapshot). target='renderer' captures the renderer via CDP HeapProfiler (requires DevTools to be CLOSED for that window — the CDP debugger cannot attach while DevTools is open).",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["main", "renderer"],
              description: "Which process to snapshot (default: renderer).",
              default: "renderer",
            },
          },
        },
      },
      handler: async (params) => {
        try {
          const target = (params.target as "main" | "renderer") ?? "renderer";
          const result = await heapSnapshot(ctx, portRef.current, target);
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      def: {
        name: "process_snapshot",
        description:
          "Capture a quick process memory/CPU snapshot (no trace recording). target='main' returns Node process.memoryUsage/cpuUsage/uptime. target='renderer' returns CDP Performance.getMetrics + Memory.getDOMCounters (requires DevTools to be CLOSED).",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["main", "renderer"],
              description: "Which process to snapshot (default: main).",
              default: "main",
            },
          },
        },
      },
      handler: async (params) => {
        try {
          const target = (params.target as "main" | "renderer") ?? "main";
          const result = await processSnapshot(ctx, target);
          return jsonResult(result);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

  ];

  return tools;
}

// --- IPC handlers (preload bridge) ---

export function registerTracingHandlers(ctx: MainContext, portRef: { current: number }): void {
  ipcMain.handle(IPC.TRACE_START, async (_event, opts: TraceStartOptions = {}) => {
    return startTrace(opts);
  });

  ipcMain.handle(IPC.TRACE_STOP, async () => stopTrace(ctx, portRef.current));

  ipcMain.handle(IPC.TRACE_STATUS, async () => traceStatus());

  ipcMain.handle(IPC.TRACE_CATEGORIES, async () => traceCategories());

  ipcMain.handle(IPC.HEAP_SNAPSHOT, async (_event, opts: { target?: "main" | "renderer" } = {}) =>
    heapSnapshot(ctx, portRef.current, opts.target ?? "renderer"),
  );

  ipcMain.handle(IPC.PROCESS_SNAPSHOT, async (_event, opts: { target?: "main" | "renderer" } = {}) =>
    processSnapshot(ctx, opts.target ?? "main"),
  );
}

// --- Test helpers (reset module state between tests) ---

/** @internal */
export function __resetTracingState(): void {
  recording = false;
  recordingMeta = null;
  artifactDir = null;
}

/** @internal */
export function __isRecording(): boolean {
  return recording;
}
