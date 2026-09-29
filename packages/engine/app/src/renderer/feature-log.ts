// ============================================================================
// Renderer feature log — collects WebGPU/adapter/display/module data
// ============================================================================
//
// Synchronous collector for the render-side fields of the feature log, plus
// a combined accessor that fetches the host log via `downdraft.getFeatureLog`
// for the DevTools copy button and the MCP `get_features` tool. On the
// single-process native runtime the two halves merge into one `dd-host|...`
// line; multi-process hosts keep `dd-main|...` + `dd-render|...`.

import { ENGINE_VERSION, condenseText, encodeFeatureLogJSON, encodeFeatureLogLine, encodeFeatureLogLines, encodeFeatures, getHostCapabilities, type FeatureLogData } from "@downdraft/engine";
import { downdraft } from "./index";
import type { McpToolRegistration } from "./mcp-harness";

export interface RendererFeatureLogOptions {
  /** Renderer with getGPUInfo() / getAdapterInfo() (GameRenderer or similar). */
  renderer: any;
  /** Engine version (defaults to ENGINE_VERSION from @downdraft/engine). */
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

  // --- SharedArrayBuffer + crossOriginIsolated (browser isolation only —
  // there is no origin model on the native host) ---
  try {
    data.sab = typeof SharedArrayBuffer !== "undefined" ? 1 : 0;
  } catch {
    data.sab = 0;
  }
  if (getHostCapabilities().hasDom) {
    try {
      data.coi = (self as any).crossOriginIsolated ? 1 : 0;
    } catch {
      data.coi = 0;
    }
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

/** Combined feature log result: merged host line + structured payload. */
export interface CombinedFeatureLog {
  /** Single-process merged log (native). Null on multi-process hosts. */
  host: FeatureLogData | null;
  main: FeatureLogData | null;
  render: FeatureLogData | null;
  /** Pasteable string — `dd-host|...` on native, `dd-main|...` + `dd-render|...` elsewhere. */
  line: string;
  /** Minified JSON of `{ host }` or `{ main, render }` for tooling. */
  json: string;
}

/**
 * Fetch the host's feature log and merge with the cached render-side log.
 * Used by the DevTools copy button and the MCP `get_features` tool.
 * On the native host both halves describe the same process — the result is
 * a single `dd-host` scope. Browser/multi-process hosts keep the split.
 */
export async function getCombinedFeatureLog(): Promise<CombinedFeatureLog> {
  let hostLog: FeatureLogData | null = null;
  try {
    hostLog = downdraft?.isAvailable ? await downdraft.getFeatureLog() : null;
  } catch { /* host log unavailable */ }
  const render = cachedRendererFeatureLog;
  if (hostLog?.scope === "host" || getHostCapabilities().runtime === "native") {
    // Single process — merge render fields (wgpu/disp/sab/wk/plug) into the
    // host line. Host fields win on overlap (v, mode, cpuCores).
    const host: FeatureLogData | null = hostLog || render
      ? { ...(render ?? {}), ...(hostLog ?? {}), scope: "host" } as FeatureLogData
      : null;
    return {
      host,
      main: null,
      render: null,
      line: host ? encodeFeatureLogLine(host) : "",
      json: JSON.stringify({ host }),
    };
  }
  return {
    host: null,
    main: hostLog,
    render,
    line: encodeFeatureLogLines(hostLog, render),
    json: JSON.stringify({ main: hostLog, render }),
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
        "(dd-host|... on the single-process native host) plus the structured { host } payload. " +
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
