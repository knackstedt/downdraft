// ============================================================================
// GPU system info IPC handlers (nvidia-smi + app.getGPUInfo + Vulkan status)
// ============================================================================

import { app, ipcMain } from "electron";
import type { ElectronGPUInfo, GPUSystemInfo, VulkanValidationStatus } from "../../shared/electron-bridge-types";
import { getVulkanValidationStatus, queryNvidiaSmi } from "../../shared/gpu-info";
import { IPC } from "../../shared/messages";

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
    return queryNvidiaSmi();
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
    return getVulkanValidationStatus();
  });
}
