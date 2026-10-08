// ============================================================================
// native-bridge.ts — HostAPI implementation for the native host
//
// Single-process architecture: every method is a direct local call — saves
// hit FileSaveStore in-process, screenshots are GPU readbacks, MCP requests
// are plain function calls.
//
// The bridge is assigned to `globalThis.downdraft` by createNativeHost()
// BEFORE game modules evaluate their `downdraft` accessor (the accessor is a
// lazy Proxy, so install order only needs to precede first use).
// ============================================================================

import { NATIVE_HOST_CAPABILITIES } from "@downdraft/engine/platform/runtime";
import type { FeatureLogData } from "@downdraft/engine/util/feature-log";
import { collectHostFeatureLog } from "@downdraft/engine/app/shared/feature-log";
import { queryNvidiaSmi } from "@downdraft/engine/app/shared/gpu-info";
import type {
    DisplayInfoData,
    DisplayMetricsChangedData,
    HostAPI,
    HostGpuInfo,
    HostOsrAPI,
    ImportCacheEntry,
    McpRequest,
    McpResponse,
    PerfStatsData,
    ProcessStatsData,
    SimReadyData
} from "@downdraft/engine/app/shared/types";
import { createLogger } from "@downdraft/engine/util/logger";
import { spawn } from "node:child_process";
import { WgpuDevice } from "../gpu/wgpu-wrapper";
import { addCrashFeatureLog } from "../host-lifecycle";
import { requestGameRestart } from "../native-restart";
import { createNativeOsrHost } from "../osr/native-osr-host";
import { isPackaged } from "../packaged";
import { encodePNG } from "../screenshot/screenshot";
import { HostSaveStore } from "../services/host-save-store";
import type { HostServices } from "../services/host-services";
import type { NativeSurface } from "../window/native-surface";
import type { NativeWindow } from "../window/native-window";

const log = createLogger("info");

export interface NativeBridgeOptions {
  /** Per-game application identifier — scopes saves/cache/state dirs. */
  appId: string;
  window: NativeWindow;
  surface: NativeSurface;
  device: WgpuDevice;
  adapter: { info?: { vendor?: string; architecture?: string; device?: string; description?: string } };
  isDev?: boolean;
  /** Extra host flag names recorded in the feature log (e.g. shim options). */
  hostFlags?: string[];
  /** Host services handle (save store + import cache). Created by
   *  createNativeHost — worker-backed by default so blocking I/O stays
   *  off the frame thread. */
  services: HostServices;
}

type Emitter = Map<string, Set<(data: unknown) => void>>;

/**
 * Create the native `downdraft` bridge. Returns the API object plus a
 * `dispose()` that tears down intervals and the import cache.
 */
export function createNativeBridge(opts: NativeBridgeOptions): HostAPI & { dispose(): void } {
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  const isDev = opts.isDev ?? !isPackaged();

  // ── Event emitter registry (host→engine events are direct emits) ──
  const emitters: Emitter = new Map();
  const on = (channel: string, cb: (data: never) => void): (() => void) => {
    let set = emitters.get(channel);
    if (!set) { set = new Set(); emitters.set(channel, set); }
    const fn = cb as (data: unknown) => void;
    set.add(fn);
    return () => set.delete(fn);
  };
  const emit = (channel: string, data: unknown) => {
    (emitters.get(channel) ?? []).forEach((cb) => {
      try { cb(data); } catch (e) { log.error("bridge", `listener error on ${channel}: ${e}`); }
    });
  };

  // Display-metrics emission. winit's ScaleFactorChanged covers OS scale
  // changes and most monitor crossings; the moved-handler re-query is a
  // fallback for backends that don't deliver it. Emitted only on change.
  let lastScaleFactor: number | null = null;
  const checkScaleFactor = (reported?: number) => {
    const scaleFactor = reported ?? opts.window.getDisplayInfo().scaleFactor;
    if (!(scaleFactor > 0)) return;
    if (lastScaleFactor === null) {
      // First observation is the boot baseline, not a change.
      lastScaleFactor = scaleFactor;
      return;
    }
    if (scaleFactor !== lastScaleFactor) {
      lastScaleFactor = scaleFactor;
      emit("display-metrics-changed", { scaleFactor } satisfies DisplayMetricsChangedData);
    }
  };
  opts.window.addEventListener("scale-changed", (e: { scaleFactor?: number }) => {
    checkScaleFactor(e.scaleFactor);
  });
  opts.window.addEventListener("moved", () => {
    emit("display-info", { refreshRate: opts.window.getDisplayInfo().refreshRate } satisfies DisplayInfoData);
    checkScaleFactor();
  });

  // ── Services (save store + import cache) — worker-backed by default ──
  const services = opts.services;
  services.onWarning((w) => log.warn("save", `[${w.kind}] slot='${w.slot}': ${w.message}`));

  // ── Feature log (collected once, served forever) ──
  const adapterInfo = opts.adapter?.info;
  const featureLog: FeatureLogData = collectHostFeatureLog({
    isDev,
    deterministic,
    flags: opts.hostFlags ?? [],
    gpuDevice: adapterInfo?.device ?? adapterInfo?.description ?? null,
    gpuDriverVersion: null,
    scope: "host",
  });
  // Fatal-error dialog includes this line (host-lifecycle.ts) — it replaces
  // the GPU-less baseline the error handlers registered at install time.
  addCrashFeatureLog(() => featureLog);

  // ── Perf stats emitter (lazy — only when a listener registers) ──
  let perfTimer: ReturnType<typeof setInterval> | null = null;
  const ensurePerfStats = () => {
    if (perfTimer) return;
    let lastCpu = process.cpuUsage();
    let lastTime = Date.now();
    perfTimer = setInterval(() => {
      const now = Date.now();
      const cpu = process.cpuUsage(lastCpu);
      const mem = process.memoryUsage();
      lastCpu = process.cpuUsage();
      const wallUs = Math.max(1, (now - lastTime) * 1000);
      lastTime = now;
      emit("perf-stats", {
        cpuPercent: Math.min(100, ((cpu.user + cpu.system) / wallUs) * 100),
        memUsedMB: mem.rss / (1024 * 1024),
        heapUsedMB: mem.heapUsed / (1024 * 1024),
        heapTotalMB: mem.heapTotal / (1024 * 1024),
        externalMB: mem.external / (1024 * 1024),
        timestamp: now,
      } satisfies PerfStatsData);
    }, 2000);
    perfTimer.unref?.();
  };

  // ── OSR: Blitz-backed native panels (see osr/native-osr-host.ts) ──
  const osrHost = createNativeOsrHost();
  const osrApi: HostOsrAPI = osrHost.api;
  if (osrHost.available) {
    (globalThis as Record<string, unknown>).__ddOsrAvailable = true;
  }

  let fullscreen = false;
  const simReadyData: SimReadyData = { isDev, deterministic };

  const bridge: HostAPI & { dispose(): void } = {
    capabilities: NATIVE_HOST_CAPABILITIES,
    // Typed host save store — the native save path. Real SaveState in,
    // real SaveResult/LoadResult out; no JSON boundary.
    saveStore: new HostSaveStore(services.api, (cb) => services.onWarning(cb)),
    // ── Saves: routed through HostServices (services worker by default) ──
    saveGameState: (slotName, stateJson, saveOpts) =>
      services.api.saveGame(slotName, stateJson, saveOpts),
    loadGameState: (slotName, loadOpts) => services.api.loadGame(slotName, loadOpts),
    deleteGameState: (slotName) => services.api.deleteSave(slotName),
    listSaveSlots: () => services.api.listSaves(),
    listSaveGenerations: (slotName) => services.api.listGenerations(slotName),
    deleteSaveGeneration: (slotName, gen) => services.api.deleteGeneration(slotName, gen),
    setThumbnail: (slotName, data) => services.api.setThumbnail(slotName, data),
    getThumbnail: (slotName) => services.api.getThumbnail(slotName),
    setSaveProperties: (slotName, props) => services.api.setProperties(slotName, props),
    getSaveProperties: (slotName) => services.api.getProperties(slotName),

    // ── App lifecycle ──
    quit: async () => {
      opts.window.requestQuit();
    },
    requestRestart: (reason: string) => requestGameRestart(reason),
    // Single process — the caller already applied the flag locally; these
    // exist to relay intent to subscribers (devtools overlay, game UI).
    setDebugMode: (enabled: boolean) => {
      emit("debug-mode", enabled);
    },
    toggleDevtools: () => {
      emit("devtools-toggle", undefined);
    },
    toggleFullscreen: () => {
      fullscreen = !fullscreen;
      opts.window.setFullscreen(fullscreen);
    },

    // ── Display info ──
    getDisplayInfo: async (): Promise<DisplayInfoData> => ({
      refreshRate: opts.window.getDisplayInfo().refreshRate,
    }),

    // ── External URLs ──
    openExternal: (url: string) => {
      openExternal(url);
    },

    // ── GPU info ──
    getGPUSystemInfo: () => queryNvidiaSmi(),
    getGpuInfo: async (): Promise<HostGpuInfo | null> => {
      const info = adapterInfo;
      return {
        vendor: info?.vendor ?? "",
        architecture: info?.architecture ?? "",
        device: info?.device ?? info?.description ?? "",
        description: info?.description ?? "",
        backend: "wgpu",
        features: [...(opts.device.features ?? [])],
      };
    },

    // ── Feature log ──
    getFeatureLog: async () => featureLog,

    // ── Frame capture: deferred GPU readback of the next presented frame.
    // Copying the swapchain texture is only valid inside a frame before
    // present() — captureNextFrame() schedules the copy there. ──
    captureFrame: async (): Promise<ArrayBuffer | null> => {
      try {
        // Subscribe BEFORE requesting a frame — the copy must be registered
        // when present() runs. __ddRequestFrame (installed by
        // runNativeGameModule) forces an on-demand frame when the render
        // loop is stopped (deterministic/test mode); on a live loop it
        // just makes the capture fresh.
        const pending = opts.surface.captureNextFrame();
        try { (globalThis as any).__ddRequestFrame?.(); } catch { /* no-op */ }
        const rgba = await pending;
        if (!rgba) return null;
        const png = encodePNG(opts.surface.width, opts.surface.height, rgba);
        return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      } catch (e) {
        log.warn("bridge", `captureFrame failed: ${(e as Error).message}`);
        return null;
      }
    },

    // ── Process stats — single process, real Bun metrics. ──
    getProcessStats: async (): Promise<ProcessStatsData> => {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        timestamp: Date.now(),
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers ?? 0,
        cpuUser: cpu.user,
        cpuSystem: cpu.system,
        uptimeSec: process.uptime(),
      };
    },

    // ── Import cache (through HostServices — SQLite lives off-thread) ──
    importCacheGet: (modelPath: string): Promise<ImportCacheEntry | null> =>
      services.api.importCacheGet(modelPath),
    importCacheSet: (modelPath: string, entry: ImportCacheEntry): Promise<void> =>
      services.api.importCacheSet(modelPath, entry),
    importCacheInvalidate: (modelPath: string): Promise<void> =>
      services.api.importCacheInvalidate(modelPath),

    // ── Typed event subscriptions (each returns an unsubscribe fn) ──
    onSimReady: (cb: (data: SimReadyData) => void) => {
      // Single process: sim-ready data is known at bridge creation — the
      // game's startGame() calls this after boot, so defer to a microtask
      // to preserve the post-load timing semantics callers expect.
      queueMicrotask(() => cb(simReadyData));
      return () => {};
    },
    onDisplayInfo: (cb: (data: DisplayInfoData) => void) => on("display-info", cb),
    onDisplayMetricsChanged: (cb: (data: DisplayMetricsChangedData) => void) => on("display-metrics-changed", cb),
    onPerfStats: (cb: (data: PerfStatsData) => void) => { const off = on("perf-stats", cb); ensurePerfStats(); return off; },
    onDebugMode: (cb: (enabled: boolean) => void) => on("debug-mode", cb),
    onDevtoolsToggle: (cb: () => void) => on("devtools-toggle", cb),

    osr: osrApi,
    // rawInput is intentionally absent: SDL relative-mouse grab covers
    // pointer-lock semantics without a native addon.
    deterministic,

    // ── MCP: register the renderer-side harness handler in a slot the
    // native MCP transport (mcp/native-mcp.ts) calls directly. ──
    onMcpRequest: (cb: (request: McpRequest) => Promise<McpResponse>) => {
      (globalThis as Record<string, unknown>).__ddMcpHandler = cb;
      return () => {
        // Session teardown unsubscribes dead-generation handlers — clear the
        // slot only if it's still ours (a newer session may have replaced it).
        if ((globalThis as Record<string, unknown>).__ddMcpHandler === cb) {
          delete (globalThis as Record<string, unknown>).__ddMcpHandler;
        }
      };
    },

    dispose(): void {
      if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
      osrHost.dispose();
      void services.dispose();
      emitters.clear();
      delete (globalThis as Record<string, unknown>).__ddMcpHandler;
    },
  };

  return bridge;
}

function openExternal(url: string): void {
  const cmd = process.platform === "win32" ? "cmd"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (e) {
    log.warn("bridge", `openExternal failed for ${url}: ${(e as Error).message}`);
  }
}
