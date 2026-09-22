// ============================================================================
// native-bridge.ts — DowndraftBridgeAPI implementation for the native host
//
// Single-process architecture: every method the Electron preload routes over
// IPC is a direct local call here — saves hit FileSaveStore in-process,
// screenshots are GPU readbacks, MCP requests are plain function calls.
//
// The bridge is assigned to `globalThis.downdraft` by createNativeHost()
// BEFORE game modules evaluate their `downdraft` accessor (the accessor is a
// lazy Proxy, so install order only needs to precede first use).
// ============================================================================

import { ENGINE_VERSION, type FeatureLogData } from "@downdraft/engine";
import { collectHostFeatureLog } from "@downdraft/engine/app/shared/feature-log";
import { getVulkanValidationStatus, queryNvidiaSmi } from "@downdraft/engine/app/shared/gpu-info";
import { createImportCacheStore, type ImportCacheStore } from "@downdraft/engine/app/shared/import-cache-store";
import type {
    DisplayInfoData,
    DisplayMetricsChangedData,
    DowndraftBridgeAPI,
    DowndraftOsrBridgeAPI,
    ElectronGPUInfo,
    GCStatsData,
    HeapSnapshotResult,
    ImportCacheEntry,
    LoadOptions,
    McpRequest,
    McpResponse,
    PerfStatsData,
    ProcessSnapshotResult,
    SaveGenerationInfo,
    SaveOptions,
    SaveSlotInfo,
    SimReadyData,
    TraceStartOptions,
    TraceStartResult,
    TraceStatusResult,
    TraceStopResult,
    VulkanValidationStatus,
} from "@downdraft/engine/app/shared/types";
import { FileSaveStore } from "@downdraft/engine/libraries/persistence";
import { createLogger } from "@downdraft/engine/util/logger";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { WgpuDevice } from "../gpu/wgpu-wrapper";
import { encodePNG } from "../screenshot/screenshot";
import type { NativeSurface } from "../window/native-surface";
import type { NativeWindow } from "../window/native-window";
import { resolveNativeUserDataDir } from "./user-data-dir";

const log = createLogger("info");

export interface NativeBridgeOptions {
  /** Per-game application identifier — scopes saves/cache/state dirs. */
  appId: string;
  window: NativeWindow;
  surface: NativeSurface;
  device: WgpuDevice;
  adapter: { info?: { vendor?: string; architecture?: string; device?: string; description?: string } };
  /** Engine version stamped into save files. Default: ENGINE_VERSION. */
  engineVersion?: string;
  isDev?: boolean;
  /** Extra host flag names recorded in the feature log (e.g. shim options). */
  hostFlags?: string[];
}

type Emitter = Map<string, Set<(data: unknown) => void>>;

/**
 * Create the native `downdraft` bridge. Returns the API object plus a
 * `dispose()` that tears down intervals and the import cache.
 */
export function createNativeBridge(opts: NativeBridgeOptions): DowndraftBridgeAPI & { dispose(): void } {
  const userData = resolveNativeUserDataDir(opts.appId);
  const engineVersion = opts.engineVersion ?? ENGINE_VERSION;
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  const isDev = opts.isDev ?? !isPackaged();

  // ── Event emitter registry (main→renderer events become direct emits) ──
  const emitters: Emitter = new Map();
  const on = (channel: string, cb: (data: never) => void) => {
    let set = emitters.get(channel);
    if (!set) { set = new Set(); emitters.set(channel, set); }
    set.add(cb as (data: unknown) => void);
  };
  const emit = (channel: string, data: unknown) => {
    for (const cb of emitters.get(channel) ?? []) {
      try { cb(data); } catch (e) { log.error("bridge", `listener error on ${channel}: ${e}`); }
    }
  };

  // Display-info emission on window move (may have crossed displays).
  opts.window.addEventListener("moved", () => {
    emit("display-info", { refreshRate: opts.window.getDisplayInfo().refreshRate } satisfies DisplayInfoData);
  });

  // ── Save store (FileSaveStore, in-process — the IPC-free path) ──
  let saveStore: FileSaveStore | null = null;
  const getStore = (): FileSaveStore => {
    if (!saveStore) {
      saveStore = new FileSaveStore({
        saveDir: join(userData, "saves"),
        engineVersion,
        skipMigrations: true,
      });
      saveStore.onWarning((w) => log.warn("save", `[${w.kind}] slot='${w.slot}': ${w.message}`));
    }
    return saveStore;
  };

  // ── Import cache ──
  let importCache: ImportCacheStore | null = null;
  const getImportCache = (): ImportCacheStore => {
    if (!importCache) {
      importCache = createImportCacheStore(join(userData, "downdraft-import-cache.db"));
    }
    return importCache;
  };

  // ── Feature log (collected once, served forever) ──
  const adapterInfo = opts.adapter?.info;
  const featureLog: FeatureLogData = collectHostFeatureLog({
    isDev,
    deterministic,
    flags: opts.hostFlags ?? [],
    gpuDevice: adapterInfo?.device ?? adapterInfo?.description ?? null,
    gpuDriverVersion: null,
  });

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
        process: "native",
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

  // ── OSR: stub until the Blitz-based native OSR module lands (Phase I) ──
  const osrStub: DowndraftOsrBridgeAPI = {
    createRenderer: () => Promise.resolve(),
    destroyRenderer: () => Promise.resolve(),
    addPanel: () => Promise.resolve(null),
    removePanel: () => Promise.resolve(null),
    updatePanel: () => Promise.resolve(),
    updateData: () => {},
    setContent: () => Promise.resolve(),
    loadURL: () => Promise.resolve(),
    sendInputEvent: () => {},
    setSoftwareCursor: () => {},
    onPanelLayout: () => {},
    onRendererEvent: () => {},
    onCursorStyle: () => {},
    registerSharedTextureReceiver: () => false,
    onPaintImage: () => {},
    onPaintRegion: () => {},
    createPaintPort: () => {},
  };

  let fullscreen = false;
  const simReadyData: SimReadyData = { isDev, deterministic };

  const bridge: DowndraftBridgeAPI & { dispose(): void } = {
    // ── Saves: FileSaveStore, same semantics as handlers/saves.ts ──
    async saveGameState(slotName: string, stateJson: string, saveOpts?: SaveOptions): Promise<boolean> {
      try {
        const components = JSON.parse(stateJson);
        const result = await getStore().save(slotName, {
          components,
          meta: { engineVersion, timestamp: Date.now() / 1000, entityCount: 0, playerCount: 0 },
        }, saveOpts);
        if (!result.success) log.error("bridge", `Save to slot '${slotName}' failed`);
        return result.success;
      } catch (err) {
        log.error("bridge", `Save failed: ${err}`);
        return false;
      }
    },
    async loadGameState(slotName: string, loadOpts?: LoadOptions): Promise<string | null> {
      try {
        const result = await getStore().load(slotName, loadOpts);
        return result.state ? JSON.stringify(result.state.components) : null;
      } catch (err) {
        log.error("bridge", `Load failed: ${err}`);
        return null;
      }
    },
    deleteGameState: (slotName) => getStore().deleteSave(slotName),
    listSaveSlots: (): Promise<SaveSlotInfo[]> => getStore().listSaves() as Promise<SaveSlotInfo[]>,
    listSaveGenerations: (slotName): Promise<SaveGenerationInfo[]> =>
      getStore().listGenerations(slotName) as Promise<SaveGenerationInfo[]>,
    deleteSaveGeneration: (slotName, gen) => getStore().deleteGeneration(slotName, gen),
    setThumbnail: (slotName, data) => getStore().setThumbnail(slotName, data),
    getThumbnail: (slotName) => getStore().getThumbnail(slotName),
    setSaveProperties: (slotName, props) => getStore().setProperties(slotName, props),
    getSaveProperties: (slotName) => getStore().getProperties(slotName),

    // ── App lifecycle ──
    quit: async () => {
      opts.window.requestQuit();
    },
    setDebugMode: (enabled: boolean) => {
      emit("debug-mode", enabled);
      (globalThis as Record<string, unknown>).__nativeDebugMode = enabled;
    },
    toggleDevtools: () => {
      emit("devtools-toggle", undefined);
      const fn = (globalThis as Record<string, unknown>).__nativeDevtoolsToggle;
      if (typeof fn === "function") fn();
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
    openChromeUrl: (url: string) => {
      openExternal(url);
    },

    // ── GPU info ──
    getGPUSystemInfo: () => queryNvidiaSmi(),
    getElectronGPUInfo: async (): Promise<ElectronGPUInfo | null> => {
      const info = adapterInfo;
      if (!info) return null;
      return {
        gpuVendor: info.vendor ?? "",
        gpuDevice: info.device ?? info.description ?? "",
        gpuDriver: "",
        gpuDriverVersion: "",
        gpuActive: true,
        auxAttributes: { architecture: info.architecture },
        featureStatus: null,
        source: "electron app.getGPUInfo", // shape compatibility — wgpu adapter.info in practice
      } as ElectronGPUInfo;
    },
    getVulkanValidationStatus: async (): Promise<VulkanValidationStatus> => getVulkanValidationStatus(),

    // ── Feature log ──
    getFeatureLog: async () => featureLog,

    // ── Page capture: deferred GPU readback of the next presented frame.
    // Copying the swapchain texture is only valid inside a frame before
    // present() — captureNextFrame() schedules the copy there. ──
    capturePage: async (): Promise<ArrayBuffer | null> => {
      try {
        const rgba = await opts.surface.captureNextFrame();
        if (!rgba) return null;
        const png = encodePNG(opts.surface.width, opts.surface.height, rgba);
        return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      } catch (e) {
        log.warn("bridge", `capturePage failed: ${(e as Error).message}`);
        return null;
      }
    },

    // ── Tracing & memory-dump toolkit ──
    // Chrome contentTracing and V8 heap snapshots have no native equivalent;
    // processSnapshot is real (process.memoryUsage/cpuUsage).
    startTrace: (_opts?: TraceStartOptions): Promise<TraceStartResult> =>
      Promise.reject(new Error("startTrace is not available on the native host")),
    stopTrace: (): Promise<TraceStopResult> =>
      Promise.reject(new Error("stopTrace is not available on the native host")),
    traceStatus: (): Promise<TraceStatusResult> => Promise.resolve({ recording: false }),
    traceCategories: () => Promise.resolve({ categories: [] }),
    captureHeapSnapshot: (_opts?: { target?: "main" | "renderer" }): Promise<HeapSnapshotResult> =>
      Promise.reject(new Error("Heap snapshots are not available on the native host")),
    processSnapshot: async (snapOpts?: { target?: "main" | "renderer" }): Promise<ProcessSnapshotResult> => {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        target: snapOpts?.target ?? "main",
        timestamp: Date.now(),
        main: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers ?? 0,
          cpuUser: cpu.user,
          cpuSystem: cpu.system,
          uptimeSec: process.uptime(),
        },
      };
    },

    // ── Import cache ──
    importCacheGet: (modelPath: string): Promise<ImportCacheEntry | null> =>
      Promise.resolve(getImportCache().get(modelPath)),
    importCacheSet: (modelPath: string, entry: ImportCacheEntry): Promise<void> =>
      Promise.resolve(getImportCache().set(modelPath, entry)),
    importCacheInvalidate: (modelPath: string): Promise<void> =>
      Promise.resolve(getImportCache().invalidate(modelPath)),

    // ── Event listeners ──
    onSimReady: (cb: (data: SimReadyData) => void) => {
      // Single process: sim-ready data is known at bridge creation — the
      // game's startGame() calls this after boot, so defer to a microtask
      // to preserve Electron's post-load timing semantics.
      queueMicrotask(() => cb(simReadyData));
    },
    onDisplayInfo: (cb: (data: DisplayInfoData) => void) => on("display-info", cb),
    onDisplayMetricsChanged: (cb: (data: DisplayMetricsChangedData) => void) => on("display-metrics-changed", cb),
    onGCStats: (cb: (data: GCStatsData) => void) => { void cb; /* no V8 GC events on native */ },
    onPerfStats: (cb: (data: PerfStatsData) => void) => { on("perf-stats", cb); ensurePerfStats(); },

    osr: osrStub,
    // rawInput is intentionally absent: SDL relative-mouse grab covers
    // pointer-lock semantics without a native addon.
    removeAllListeners: (channel: string) => { emitters.delete(channel); },
    log: (level: string, message: string) => {
      if (level === "error") log.error("bridge", message);
      else if (level === "warn") log.warn("bridge", message);
      else log.info("bridge", message);
    },
    deterministic,

    // ── MCP: register the renderer-side harness handler in a slot the
    // native MCP transport (mcp/native-mcp.ts) calls directly. ──
    onMcpRequest: (cb: (request: McpRequest) => Promise<McpResponse>) => {
      (globalThis as Record<string, unknown>).__ddMcpHandler = cb;
    },

    dispose(): void {
      if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
      importCache?.close();
      importCache = null;
      emitters.clear();
      delete (globalThis as Record<string, unknown>).__ddMcpHandler;
    },
  };

  return bridge;
}

function isPackaged(): boolean {
  // Bun-compiled executables expose Bun.embeddedFiles / execPath inside the
  // binary; env override wins for tests and packaging dry-runs.
  if (process.env.DOWNDRAFT_PACKAGED === "1") return true;
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Bun === "object" && g.Bun && Array.isArray((g.Bun as { embeddedFiles?: unknown[] }).embeddedFiles)) {
    return ((g.Bun as { embeddedFiles: unknown[] }).embeddedFiles?.length ?? 0) > 0;
  }
  return false;
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
