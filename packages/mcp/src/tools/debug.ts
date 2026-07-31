import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { errorResult, jsonResult } from "../types.ts";
import type { UndoRedoManager } from "../undo-redo.ts";

export function createDebugTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "profile_frame",
        description: "Get per-system timings, GPU timings, and draw call count for the current frame.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const snap = ctx.telemetryReporter.getSnapshot();
        return jsonResult({
          tick: ctx.ecsWorld.tick,
          frameTime: snap.averageFrameTime,
          p95FrameTime: snap.p95FrameTime,
          p99FrameTime: snap.p99FrameTime,
          fps: snap.fps,
          systemTimings: snap.systemTimings,
          entityCount: ctx.ecsWorld.entityCount(),
          drawCalls: snap.drawCalls,
          triangles: snap.triangles,
          gpuTimeMs: snap.gpuTimeMs,
          memory: snap.memory,
        });
      },
    },

    {
      def: {
        name: "visualize_debug",
        description: "Toggle debug visualization modes (wireframe, AABBs, normals, raycasts, hitboxes, velocity).",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["none", "wireframe", "aabb", "normals", "raycasts", "hitboxes", "velocity", "overdraw", "lod"],
              description: "Debug visualization mode",
            },
            enabled: { type: "boolean", description: "Enable or disable (default: true)" },
          },
          required: ["mode"],
        },
      },
      handler: (params) => {
        const mode = params.mode as string;
        const enabled = (params.enabled as boolean) ?? true;

        ctx.debugVisualizeMode = enabled ? mode : "none";

        return jsonResult({ mode, enabled, previousMode: ctx.debugVisualizeMode });
      },
    },

    {
      def: {
        name: "screenshot",
        description: "Capture the current frame as a screenshot (returns base64 PNG).",
        inputSchema: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["png", "jpeg"],
              description: "Image format (default: png)",
            },
          },
        },
      },
      handler: (params) => {
        const format = (params.format as string) ?? "png";
        return jsonResult({
          note: "Screenshot capture requires a running render loop. No render loop active.",
          format,
        });
      },
    },

    {
      def: {
        name: "inspect_gpu",
        description: "Get GPU adapter info, buffer sizes, and texture memory usage.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        return jsonResult({
          adapter: "WGPU adapter info requires running render loop",
          buffers: { totalSize: 0, count: 0 },
          textures: { totalSize: 0, count: 0 },
          meshes: ctx.meshes.size,
          materials: ctx.materialLibrary.list().length,
        });
      },
    },

    {
      def: {
        name: "get_performance_history",
        description: "Get frame time history for graphing.",
        inputSchema: {
          type: "object",
          properties: {
            seconds: { type: "number", description: "Number of seconds of history (default: 5)" },
          },
        },
      },
      handler: (params) => {
        const seconds = (params.seconds as number) ?? 5;
        const frameTimes = ctx.telemetryCollector.getFrameTimes();
        const samples = frameTimes.slice(-Math.floor(seconds * 60));

        return jsonResult({
          seconds,
          sampleCount: samples.length,
          frameTimes: samples,
          avgMs: samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0,
          minMs: samples.length > 0 ? Math.min(...samples) : 0,
          maxMs: samples.length > 0 ? Math.max(...samples) : 0,
        });
      },
    },

    {
      def: {
        name: "get_telemetry",
        description: "Get per-thread GC, memory, and CPU metrics over a time window.",
        inputSchema: {
          type: "object",
          properties: {
            duration: { type: "number", description: "Duration in seconds (default: 1)" },
          },
        },
      },
      handler: (params) => {
        const report = ctx.telemetryReporter.getMCPFormat();
        return jsonResult(report);
      },
    },

    {
      def: {
        name: "undo",
        description: "Reverse the last MCP operation.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        if (!undoRedo.canUndo()) return errorResult("Nothing to undo");
        const success = undoRedo.undo();
        return jsonResult({ undone: success, history: undoRedo.getHistory() });
      },
    },

    {
      def: {
        name: "redo",
        description: "Re-apply the last undone MCP operation.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        if (!undoRedo.canRedo()) return errorResult("Nothing to redo");
        const success = undoRedo.redo();
        return jsonResult({ redone: success, history: undoRedo.getHistory() });
      },
    },

    {
      def: {
        name: "get_undo_history",
        description: "Get the undo/redo history.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        return jsonResult(undoRedo.getHistory());
      },
    },

  ];

  return tools;
}
