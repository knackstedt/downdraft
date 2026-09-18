// ============================================================================
// GPU system info IPC handlers (nvidia-smi + app.getGPUInfo + Vulkan status)
// ============================================================================

import { app, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IPC } from "../../shared/messages";
import type { ElectronGPUInfo, GPUSystemInfo, VulkanValidationStatus } from "../../shared/types";

const execFileAsync = promisify(execFile);

let cachedGpuInfo: { data: GPUSystemInfo | null; ts: number } | null = null;
const GPU_INFO_CACHE_MS = 1000;

/** Minimal shape of Electron's `app.getGPUInfo("complete")` result. */
interface ElectronGPUInfoRaw {
  auxAttributes?: unknown;
  featureStatus?: unknown;
  gpuDevice?: Array<{ device?: string; description?: string; vendor?: string }>;
  gpuDriver?: string;
  gpuDriverVersion?: string;
  gpuActive?: unknown;
  gpuVendor?: string;
}

export function registerGpuInfoHandlers(): void {
  ipcMain.handle(IPC.GPU_SYSTEM_INFO, async (): Promise<GPUSystemInfo | null> => {
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
        const obj: Record<string, string | number> = {};
        for (let i = 0; i < labels.length && i < vals.length; i++) {
          const num = parseFloat(vals[i]);
          obj[labels[i]] = isNaN(num) ? vals[i] : num;
        }
        return obj;
      });

      let processes: Array<{ pid: number; processName: string; usedMemoryMB: number }> = [];
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

      const data: GPUSystemInfo = { gpus, processes, source: "nvidia-smi", timestamp: Date.now() };
      cachedGpuInfo = { data, ts: Date.now() };
      return data;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.ELECTRON_GPU_INFO, async (): Promise<ElectronGPUInfo | null> => {
    try {
      const info = await app.getGPUInfo("complete");
      if (info && typeof info === "object") {
        const g = info as ElectronGPUInfoRaw;
        const devices = Array.isArray(g.gpuDevice) ? g.gpuDevice : [];
        const primary = devices[0] ?? {};
        return {
          gpuVendor: g.gpuVendor || primary.vendor || "",
          gpuDevice: primary.device || (devices.length > 0 ? devices.map((d) => d.device || d.description || "").join(", ") : ""),
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

  ipcMain.handle(IPC.VULKAN_VALIDATION_STATUS, async (): Promise<VulkanValidationStatus> => {
    const enabled = process.env.VK_LAYER_KHRONOS_validation === "1" ||
      process.env.VK_LAYER_KHRONOS_validation === "true" ||
      process.env.ENABLE_VULKAN_VALIDATION === "1";
    return { enabled, envVar: process.env.VK_LAYER_KHRONOS_VALIDATION ?? null };
  });
}
