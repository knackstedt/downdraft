// ============================================================================
// Renderer-process feature log — collects WebGPU/navigator/display/plugin data
// ============================================================================
//
// Synchronous collector for the `dd-render|...` startup line, plus a combined
// accessor that fetches the main-process line via IPC for the DevTools copy
// button and the MCP `get_features` tool.

import { ENGINE_VERSION, condenseText, encodeFeatures, encodeFeatureLogJSON, encodeFeatureLogLines, type FeatureLogData } from "@downdraft/core";
import type { McpToolRegistration } from "./mcp-harness";
import { downdraft } from "./index";

export interface RendererFeatureLogOptions {
  /** Renderer with getGPUInfo() / getAdapterInfo() (GameRenderer or similar). */
  renderer: any;
  /** Engine version (defaults to ENGINE_VERSION from @downdraft/core). */
  engineVersion?: string;
  isDev: boolean;
  deterministic: boolean;
  /** Optional getter for active plugin names (e.g. () => gameWorld.moduleHost.listModules()). */
  getActiveModules?: () => string[];
}

let cachedRendererFeatureLog: FeatureLogData | null = null;

/**
 * Collect the renderer-process feature log data. Synchronous; reads WebGPU
 * adapter/features/limits via renderer.getGPUInfo(), navigator props, and
 * crossOriginIsolated. Display refresh rate is best-effort from a cached
 * downdraft.getDisplayInfo() result if already resolved; otherwise `disp` is
 * omitted (additive schema tolerates absence).
 */
export function collectRendererFeatureLog(opts: RendererFeatureLogOptions): FeatureLogData {
  const { renderer, isDev, deterministic, getActiveModules } = opts;
  const v = opts.engineVersion ?? ENGINE_VERSION;

  const data: FeatureLogData = {
    sv: 1,
    scope: "render",
    v,
    mode: deterministic ? "deterministic" : isDev ? "dev" : "packaged",
  };

  // --- WebGPU adapter / features / limits / canvas format ---
  try {
    const gpuInfo = renderer?.getGPUInfo?.() ?? null;
    if (gpuInfo) {
      const adapter = gpuInfo.adapter;
      const fmt = gpuInfo.canvasFormat ?? "";
      // Encode features as short codes if the device exposes them.
      let featCodes = "";
      try {
        const feats = renderer?.getDevice?.()?.features ?? null;
        if (feats && typeof feats[Symbol.iterator] === "function") {
          featCodes = encodeFeatures(Array.from(feats) as string[]);
        }
      } catch { /* features unavailable */ }

      // Key limits as compact k=v pairs.
      const L = gpuInfo.deviceLimits ?? {};
      const limParts: string[] = [];
      if (L.maxTextureDimension2D) limParts.push(`2d=${L.maxTextureDimension2D}`);
      if (L.maxTextureDimension3D) limParts.push(`3d=${L.maxTextureDimension3D}`);
      if (L.maxBufferSize) limParts.push(`buf=${L.maxBufferSize}`);
      if (L.maxBindGroups) limParts.push(`bind=${L.maxBindGroups}`);
      if (L.maxSamplersPerShaderStage) limParts.push(`samp=${L.maxSamplersPerShaderStage}`);

      const wgpuParts: string[] = [];
      if (adapter?.vendor) wgpuParts.push(`vendor=${condenseText(adapter.vendor, 16)}`);
      if (adapter?.architecture) wgpuParts.push(`arch=${condenseText(adapter.architecture, 24)}`);
      if (adapter?.device) wgpuParts.push(`dev=${condenseText(adapter.device, 32)}`);
      if (fmt) wgpuParts.push(`fmt=${fmt}`);
      if (featCodes) wgpuParts.push(`feat=${featCodes}`);
      if (limParts.length > 0) wgpuParts.push(`lim=${limParts.join(",")}`);
      if (wgpuParts.length > 0) data.wgpu = wgpuParts.join(";");
    }
  } catch { /* getGPUInfo unavailable */ }

  // --- navigator CPU / memory ---
  try {
    const nav: any = (globalThis as any).navigator;
    if (nav?.hardwareConcurrency) data.cpuCores = nav.hardwareConcurrency;
    // deviceMemory is non-standard (Chrome only); optional.
    if (nav?.deviceMemory) data.mem = `${nav.deviceMemory}G`;
  } catch { /* navigator unavailable */ }

  // --- SharedArrayBuffer + crossOriginIsolated ---
  try {
    data.sab = typeof SharedArrayBuffer !== "undefined" ? 1 : 0;
  } catch {
    data.sab = 0;
  }
  try {
    data.coi = (self as any).crossOriginIsolated ? 1 : 0;
  } catch {
    data.coi = 0;
  }

  // --- Worker load status (best-effort; na = not checked) ---
  data.wk = "na";

  // --- Active plugins ---
  if (getActiveModules) {
    try {
      const plugins = getActiveModules();
      if (plugins && plugins.length > 0) {
        data.plug = plugins.join(",");
      }
    } catch { /* plugin list unavailable */ }
  }

  cachedRendererFeatureLog = data;
  return data;
}

/** Return the most recently collected renderer feature log, or null. */
export function getRendererFeatureLog(): FeatureLogData | null {
  return cachedRendererFeatureLog;
}

/** Combined feature log result: both lines + structured payload. */
export interface CombinedFeatureLog {
  main: FeatureLogData | null;
  render: FeatureLogData | null;
  /** Two-line pasteable string (`dd-main|...\ndd-render|...`). */
  line: string;
  /** Minified JSON of `{ main, render }` for tooling. */
  json: string;
}

/**
 * Fetch the main-process feature log via IPC and merge with the cached
 * renderer feature log. Used by the DevTools copy button and the MCP
 * `get_features` tool. Returns null halves gracefully if a process hasn't
 * collected yet.
 */
export async function getCombinedFeatureLog(): Promise<CombinedFeatureLog> {
  let main: FeatureLogData | null = null;
  try {
    main = downdraft?.isAvailable ? await downdraft.getFeatureLog() : null;
  } catch { /* IPC unavailable */ }
  const render = cachedRendererFeatureLog;
  return {
    main,
    render,
    line: encodeFeatureLogLines(main, render),
    json: JSON.stringify({ main, render }),
  };
}

/**
 * MCP tool definition for `get_features`. Returns the combined feature log
 * (both lines + structured payload). Add to a game's MCP harness tools array.
 */
export function createFeatureLogMcpTool(): McpToolRegistration {
  return {
    def: {
      name: "get_features",
      description:
        "Return the engine feature log: a terse, versioned, pipe-delimited diagnostic string " +
        "(dd-main|... and dd-render|... lines) plus the structured { main, render } payload. " +
        "Use this to inspect the running environment (OS, CPU, GPU, WebGPU features/limits, " +
        "runtime versions, active plugins, SAB/COOP-COEP status).",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      const combined = await getCombinedFeatureLog();
      // Return the structured payload; the harness wraps it as JSON text.
      return combined;
    },
  };
}

/** Re-export encodeFeatureLogJSON for callers that want the structured form. */
export { encodeFeatureLogJSON };
