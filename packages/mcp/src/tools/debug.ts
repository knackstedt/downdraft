import { execSync } from "child_process";
import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { errorResult, jsonResult } from "../types.ts";
import type { UndoRedoManager } from "../undo-redo.ts";

function queryNvidiaSmi(): Record<string, unknown> | null {
  try {
    const gpuQuery = "utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,clocks.mem,name,driver_version";
    const output = execSync(
      `nvidia-smi --query-gpu=${gpuQuery} --format=csv,noheader,nounits`,
      { timeout: 3000, encoding: "utf-8" },
    ).trim();

    const labels = gpuQuery.split(",");
    const gpus = output.split("\n").map((line) => {
      const vals = line.trim().split(",").map((v) => v.trim());
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < labels.length && i < vals.length; i++) {
        const num = parseFloat(vals[i]);
        obj[labels[i]] = isNaN(num) ? vals[i] : num;
      }
      return obj;
    });

    return { gpus, source: "nvidia-smi" };
  } catch {
    return null;
  }
}

function queryNvidiaSmiProcesses(): Array<Record<string, unknown>> | null {
  try {
    const output = execSync(
      "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits",
      { timeout: 3000, encoding: "utf-8" },
    ).trim();

    if (!output) return [];
    const procs = output.split("\n").map((line) => {
      const vals = line.trim().split(",").map((v) => v.trim());
      return {
        pid: parseInt(vals[0]) || 0,
        processName: vals[1] || "",
        usedMemoryMB: parseFloat(vals[2]) || 0,
      };
    });
    return procs;
  } catch {
    return null;
  }
}

function queryElectronGPUInfo(): Record<string, unknown> | null {
  try {
    const electron = require("electron");
    if (electron && electron.app && electron.app.getGPUInfo) {
      const info = electron.app.getGPUInfo("full");
      if (info && typeof info === "object") {
        return {
          gpuDevice: info.gpuDevice,
          gpuDriver: info.gpuDriver,
          gpuDriverVersion: info.gpuDriverVersion,
          gpuVendor: info.gpuVendor,
          gpuActive: info.gpuActive,
          auxAttributes: info.auxAttributes,
          featureStatus: info.featureStatus,
          source: "electron app.getGPUInfo",
        };
      }
    }
  } catch {
    // Not running in Electron or app not available
  }
  return null;
}

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
        description: "Get GPU adapter info, buffer sizes, texture memory usage, and engine resource counts.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const nvidia = queryNvidiaSmi();
        const electronGPU = queryElectronGPUInfo();
        return jsonResult({
          meshes: ctx.meshes.size,
          materials: ctx.materialLibrary.list().length,
          systemGPU: nvidia,
          electronGPU: electronGPU,
          note: "For live WebGPU adapter info, device limits, resource tracking, and GPU errors, use the DevTools GPU tab or SceneInspector API (getGPUInfo, getGPUErrors, getFrameTelemetry, getGPUResourceStats).",
        });
      },
    },

    {
      def: {
        name: "gpu_system_info",
        description: "Get real-time GPU system metrics from nvidia-smi: GPU utilization %, VRAM usage, temperature, power draw, clock speeds, and per-process VRAM allocation. Also includes Electron GPU info (driver, vendor, features) when available. This data is NOT available from inside WebGPU — it comes from the NVIDIA driver.",
        inputSchema: {
          type: "object",
          properties: {
            includeProcesses: {
              type: "boolean",
              description: "Include per-process VRAM usage (default: true)",
            },
          },
        },
      },
      handler: (params) => {
        const includeProcesses = (params.includeProcesses as boolean) ?? true;
        const nvidia = queryNvidiaSmi();
        const electronGPU = queryElectronGPUInfo();
        const processes = includeProcesses ? queryNvidiaSmiProcesses() : null;

        if (!nvidia && !electronGPU) {
          return jsonResult({
            error: "No GPU system info available. nvidia-smi not found and Electron GPU info not accessible.",
            nvidiaSmi: null,
            electronGPU: null,
          });
        }

        return jsonResult({
          nvidiaSmi: nvidia,
          electronGPU: electronGPU,
          processes: processes,
          timestamp: Date.now(),
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
