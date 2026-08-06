// ============================================================================
// GPU system info IPC handlers (nvidia-smi + app.getGPUInfo + Vulkan status)
// ============================================================================

import { app, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IPC } from "../../shared/messages";

const execFileAsync = promisify(execFile);

let cachedGpuInfo: { data: unknown; ts: number } | null = null;
const GPU_INFO_CACHE_MS = 1000;

export function registerGpuInfoHandlers(): void {
  ipcMain.handle(IPC.GPU_SYSTEM_INFO, async () => {
    const now = Date.now();
    if (cachedGpuInfo && now - cachedGpuInfo.ts < GPU_INFO_CACHE_MS) {
      return cachedGpuInfo.data;
    }

    try {
      const gpuQuery = "utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,clocks.mem,name,driver_version";
      const { stdout: output } = await execFileAsync("nvidia-smi", [
        "--query-gpu", gpuQuery,
        "--format", "csv,noheader,nounits",
      ], { timeout: 3000, encoding: "utf-8" });

      const labels = gpuQuery.split(",").map(l => l.replace(/\./g, "_"));
      const gpus = (output as string).trim().split("\n").map((line: string) => {
        const vals = line.trim().split(",").map((v: string) => v.trim());
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < labels.length && i < vals.length; i++) {
          const num = parseFloat(vals[i]);
          obj[labels[i]] = isNaN(num) ? vals[i] : num;
        }
        return obj;
      });

      let processes: Array<Record<string, unknown>> = [];
      try {
        const { stdout: procOutput } = await execFileAsync("nvidia-smi", [
          "--query-compute-apps", "pid,process_name,used_memory",
          "--format", "csv,noheader,nounits",
        ], { timeout: 3000, encoding: "utf-8" });
        const procStr = (procOutput as string).trim();
        if (procStr) {
          processes = procStr.split("\n").map((line: string) => {
            const vals = line.trim().split(",").map((v: string) => v.trim());
            return {
              pid: parseInt(vals[0]) || 0,
              processName: vals[1] || "",
              usedMemoryMB: parseFloat(vals[2]) || 0,
            };
          });
        }
      } catch {
        // nvidia-smi process query not available
      }

      const data = { gpus, processes, source: "nvidia-smi", timestamp: Date.now() };
      cachedGpuInfo = { data, ts: Date.now() };
      return data;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.ELECTRON_GPU_INFO, async () => {
    try {
      const info = await app.getGPUInfo("complete");
      if (info && typeof info === "object") {
        const g = info as any;
        const devices = Array.isArray(g.gpuDevice) ? g.gpuDevice : [];
        const primary = devices[0] ?? {};
        return {
          gpuVendor: g.gpuVendor || primary.vendor || "",
          gpuDevice: primary.device || (devices.length > 0 ? devices.map((d: any) => d.device || d.description || "").join(", ") : ""),
          gpuDriver: g.gpuDriver || "",
          gpuDriverVersion: g.gpuDriverVersion || "",
          gpuActive: g.gpuActive,
          auxAttributes: g.auxAttributes,
          featureStatus: g.featureStatus,
          source: "electron app.getGPUInfo",
        };
      }
      return null;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.VULKAN_VALIDATION_STATUS, async () => {
    const enabled = process.env.VK_LAYER_KHRONOS_validation === "1" ||
      process.env.VK_LAYER_KHRONOS_validation === "true" ||
      process.env.ENABLE_VULKAN_VALIDATION === "1";
    return { enabled, envVar: process.env.VK_LAYER_KHRONOS_VALIDATION ?? null };
  });
}
