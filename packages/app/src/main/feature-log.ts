// ============================================================================
// Main-process feature log — collects OS/CPU/RAM/runtime/switches/GPU identity
// ============================================================================
//
// Synchronous collector for the `dd-main|...` startup line. GPU name/driver
// are read from a cached Electron GPU info result if warm (the async
// app.getGPUInfo is fetched separately by the GPU info IPC handler); otherwise
// the fields are omitted and the renderer's WebGPU adapter line carries GPU
// identity. This keeps the startup emit path non-blocking.

import { ENGINE_VERSION, condenseText, formatBytesShort, type FeatureLogData } from "@downdraft/core";
import type { app as AppType } from "electron";
import { ipcMain } from "electron";
import os from "node:os";
import { IPC } from "../shared/messages";
import type { ElectronGPUInfo } from "../shared/types";

export interface CollectMainFeatureLogOptions {
  app: typeof AppType;
  isDev: boolean;
  deterministic: boolean;
  /** Applied chrome switch names (e.g. ["enable-unsafe-webgpu","use-vulkan"]). */
  switches: string[];
  /**
   * Optional cached Electron GPU info (from the ELECTRON_GPU_INFO handler).
   * If absent, gpu/drv fields are omitted — the renderer line carries WebGPU
   * adapter identity in that case.
   */
  electronGpuInfo?: ElectronGPUInfo | null;
}

let cachedMainFeatureLog: FeatureLogData | null = null;

/**
 * Collect the main-process feature log data. Synchronous; safe to call at
 * startup. The result is cached in a module-level variable for reuse by the
 * crash dialog and the FEATURE_LOG IPC handler.
 */
export function collectMainFeatureLog(opts: CollectMainFeatureLogOptions): FeatureLogData {
  const { isDev, deterministic, switches } = opts;
  const versions = process.versions;
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0]!.model : "";

  const data: FeatureLogData = {
    sv: 1,
    scope: "main",
    v: ENGINE_VERSION,
    mode: deterministic ? "deterministic" : isDev ? "dev" : "packaged",
    os: process.platform,
    osRel: os.release(),
    arch: process.arch,
    cpu: condenseText(cpuModel, 48),
    cpuCores: cpus.length,
    mem: formatBytesShort(os.totalmem()),
    el: versions.electron,
    chr: versions.chrome,
    node: versions.node,
    v8: versions.v8,
    sw: switches.length > 0 ? switches.join(",") : undefined,
  };

  // GPU identity from cached Electron GPU info (best-effort, sync).
  const gpuInfo = opts.electronGpuInfo ?? null;
  if (gpuInfo) {
    if (gpuInfo.gpuDevice) data.gpu = condenseText(gpuInfo.gpuDevice, 48);
    if (gpuInfo.gpuDriverVersion) data.drv = condenseText(gpuInfo.gpuDriverVersion, 32);
  }

  cachedMainFeatureLog = data;
  return data;
}

/** Return the most recently collected main feature log, or null. */
export function getCachedMainFeatureLog(): FeatureLogData | null {
  return cachedMainFeatureLog;
}

/**
 * Register the FEATURE_LOG IPC handler, returning the cached main feature log.
 * Renderer calls this to merge main + render data for the combined view
 * (DevTools copy button + MCP get_features tool).
 */
export function registerFeatureLogHandlers(): void {
  ipcMain.handle(IPC.FEATURE_LOG, async (): Promise<FeatureLogData | null> => {
    return cachedMainFeatureLog;
  });
}
