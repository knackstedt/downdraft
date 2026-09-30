// ============================================================================
// GPU system info helpers for the native (Bun/Node) host bridge.
//
// nvidia-smi is queried via child_process; Vulkan validation
// status reads environment variables. Importable from any process — the only
// hard requirement is that `nvidia-smi` exists on PATH (returns null when it
// does not, e.g. non-NVIDIA systems).
// ============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GPUSystemInfo, VulkanValidationStatus } from "./types";

const execFileAsync = promisify(execFile);

let cachedGpuInfo: { data: GPUSystemInfo | null; ts: number } | null = null;
const GPU_INFO_CACHE_MS = 1000;

/**
 * Query GPU utilization/memory/temperature via `nvidia-smi`. Cached for 1s.
 * Returns null when nvidia-smi is absent or errors (AMD/Intel GPUs, CI).
 */
export async function queryNvidiaSmi(): Promise<GPUSystemInfo | null> {
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
}

/** Whether Vulkan validation layers were requested via env. */
export function getVulkanValidationStatus(): VulkanValidationStatus {
  const enabled = process.env.VK_LAYER_KHRONOS_validation === "1" ||
    process.env.VK_LAYER_KHRONOS_validation === "true" ||
    process.env.ENABLE_VULKAN_VALIDATION === "1";
  return { enabled, envVar: process.env.VK_LAYER_KHRONOS_VALIDATION ?? null };
}
