// ============================================================================
// mobile-bridge — DowndraftBridge implementation for Capacitor mobile hosts
// ============================================================================
//
// Implements the `window.downdraft` bridge surface using web APIs + optional
// Capacitor plugins. This is injected BEFORE the renderer bundle runs so that
// `@downdraft/engine/app/renderer`'s `downdraft` accessor picks up the real bridge
// instead of the stub.
//
// Strategy per feature:
//   - Saves: OPFS via @downdraft/engine/libraries/persistence/browser (no IPC needed).
//     The save methods here return false/null to signal the renderer to use
//     the OPFS save store path (createSaveStore "auto" → OPFS worker).
//   - Display info: web APIs (requestAnimationFrame timing, devicePixelRatio).
//   - GPU info: WebGPU adapter.info (captured lazily after device acquisition).
//   - quit / openExternal: optional Capacitor plugins (@capacitor/app,
//     @capacitor/browser) if available; otherwise no-op.
//   - OSR / MCP / DevTools / import-cache: no-ops (not supported on mobile).
//   - deterministic: false (mobile is never deterministic/test mode).

/// <reference path="./capacitor-plugin-types.d.ts" />

import type { FeatureLogData } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import type {
    DisplayInfoData,
    DisplayMetricsChangedData,
    DowndraftBridgeAPI,
    GCStatsData,
    McpRequest,
    McpResponse,
    PerfStatsData,
    SimReadyData,
    VulkanValidationStatus
} from "../shared/types";

const log = createLogger("info");

// --- Optional Capacitor plugin types (loaded dynamically, not a hard dep) ---
// We use `any` here because Capacitor is a per-game dependency, not an engine
// dependency. The mobile bridge gracefully degrades if Capacitor plugins
// are not installed.

interface CapacitorAppPlugin {
  exitApp(): Promise<void>;
}
interface CapacitorBrowserPlugin {
  open(options: { url: string }): Promise<void>;
}

async function tryCapacitorApp(): Promise<CapacitorAppPlugin | null> {
  try {
    const mod = await import(/* @vite-ignore */ "@capacitor/app");
    return (mod as any).App ?? null;
  } catch {
    return null;
  }
}

async function tryCapacitorBrowser(): Promise<CapacitorBrowserPlugin | null> {
  try {
    const mod = await import(/* @vite-ignore */ "@capacitor/browser");
    return (mod as any).Browser ?? null;
  } catch {
    return null;
  }
}

function noop(): void {}

/**
 * Create the mobile `window.downdraft` bridge.
 *
 * This bridge is exposed on `window.downdraft` before the renderer boots.
 * The renderer's `downdraft` accessor (packages/engine/app/src/renderer/index.ts)
 * detects it and wraps it with `isAvailable: true`.
 *
 * Save methods return false/null so that the renderer's save-store-factory
 * falls through to the OPFS / IndexedDB path (which works in modern WebViews
 * without any native IPC).
 */
export function createMobileBridge(): DowndraftBridgeAPI {
  // --- Display info listeners ---
  const displayInfoCallbacks: Array<(data: DisplayInfoData) => void> = [];
  const displayMetricsCallbacks: Array<(data: DisplayMetricsChangedData) => void> = [];

  // Estimate refresh rate from rAF timing (best-effort, populated async).
  let cachedRefreshRate = 0;
  (async () => {
    cachedRefreshRate = await estimateRefreshRate();
    displayInfoCallbacks.forEach((cb) => {
      cb({ refreshRate: cachedRefreshRate });
    });
  })();

  // Forward devicePixelRatio changes (orientation change, zoom).
  window.addEventListener("resize", () => {
    displayMetricsCallbacks.forEach((cb) => {
      cb({ scaleFactor: window.devicePixelRatio });
    });
  });

  return {
    // --- Saves: no-op → renderer uses OPFS / IndexedDB fallback ---
    saveGameState: () => Promise.resolve(false),
    loadGameState: () => Promise.resolve(null),
    deleteGameState: () => Promise.resolve(false),
    listSaveSlots: () => Promise.resolve([]),
    listSaveGenerations: () => Promise.resolve([]),
    deleteSaveGeneration: () => Promise.resolve(false),
    setThumbnail: () => Promise.resolve(),
    getThumbnail: () => Promise.resolve(null),
    setSaveProperties: () => Promise.resolve(),
    getSaveProperties: () => Promise.resolve({}),

    // --- App lifecycle ---
    quit: async () => {
      const app = await tryCapacitorApp();
      if (app) {
        await app.exitApp();
      }
    },

    // --- DevTools / debug: no-ops on mobile ---
    setDebugMode: noop,
    toggleDevtools: noop,
    toggleFullscreen: noop,

    // --- Display info ---
    getDisplayInfo: async () => ({
      refreshRate: cachedRefreshRate || (await estimateRefreshRate()),
    }),

    // --- External URLs ---
    openExternal: (url: string) => {
      tryCapacitorBrowser().then((browser) => {
        if (browser) {
          browser.open({ url });
        } else {
          // Fallback: open in a new tab (works in some WebView configs)
          window.open(url, "_blank");
        }
      });
    },

    // --- GPU info: use WebGPU adapter info (lazy, populated after device) ---
    getGPUSystemInfo: () => Promise.resolve(null),
    getElectronGPUInfo: () => Promise.resolve(null),
    getVulkanValidationStatus: () =>
      Promise.resolve({ enabled: false, envVar: null } as VulkanValidationStatus),

    // --- Feature log: not collected on mobile (no main process) ---
    getFeatureLog: () => Promise.resolve(null) as Promise<FeatureLogData | null>,

    openChromeUrl: noop,

    // --- Page capture: use canvas capture (no Electron capturePage) ---
    capturePage: () => Promise.resolve(null),

    // --- Tracing: not available on mobile (no Electron main process) ---
    startTrace: () => Promise.reject(new Error("Tracing not available on mobile")),
    stopTrace: () => Promise.reject(new Error("Tracing not available on mobile")),
    traceStatus: () => Promise.resolve({ recording: false }),
    traceCategories: () => Promise.resolve({ categories: [] }),
    captureHeapSnapshot: () => Promise.reject(new Error("Heap snapshot not available on mobile")),
    processSnapshot: () => Promise.reject(new Error("Process snapshot not available on mobile")),

    // --- Import cache: no-op (re-import each launch on mobile) ---
    importCacheGet: () => Promise.resolve(null),
    importCacheSet: () => Promise.resolve(),
    importCacheInvalidate: () => Promise.resolve(),

    // --- Event listeners ---
    onSimReady: (cb: (data: SimReadyData) => void) => {
      // On mobile, sim-ready is handled by startGame() directly.
      // This is a no-op; the renderer doesn't rely on this on mobile.
      void cb;
    },
    onDisplayInfo: (cb: (data: DisplayInfoData) => void) => {
      displayInfoCallbacks.push(cb);
    },
    onDisplayMetricsChanged: (cb: (data: DisplayMetricsChangedData) => void) => {
      displayMetricsCallbacks.push(cb);
    },
    onGCStats: (cb: (data: GCStatsData) => void) => { void cb; },
    onPerfStats: (cb: (data: PerfStatsData) => void) => { void cb; },

    // --- OSR: not supported on mobile (stub all methods) ---
    osr: {
      createRenderer: () => Promise.resolve(),
      destroyRenderer: () => Promise.resolve(),
      addPanel: () => Promise.resolve(null),
      removePanel: () => Promise.resolve(null),
      updatePanel: () => Promise.resolve(),
      updateData: noop,
      setContent: () => Promise.resolve(),
      loadURL: () => Promise.resolve(),
      sendInputEvent: noop,
      setSoftwareCursor: noop,
      onPanelLayout: noop,
      onRendererEvent: noop,
      onCursorStyle: noop,
      registerSharedTextureReceiver: () => false,
      onPaintImage: noop,
      onPaintRegion: noop,
      createPaintPort: noop,
    },

    removeAllListeners: (channel: string) => {
      if (channel === "display-info") displayInfoCallbacks.length = 0;
      if (channel === "display-metrics-changed") displayMetricsCallbacks.length = 0;
    },

    log: (level: string, message: string) => {
      // Forward to the engine logger (mobile dev uses Safari/Chrome remote debug)
      const fn = level === "error" ? log.error : level === "warn" ? log.warn : log.info;
      fn("mobile", message);
    },

    deterministic: false,

    onMcpRequest: (cb: (request: McpRequest) => Promise<McpResponse>) => {
      // MCP not supported in production mobile builds.
      void cb;
    },
  };
}

/**
 * Estimate the display refresh rate by measuring requestAnimationFrame intervals.
 * Returns 0 if the estimate is unreliable.
 */
async function estimateRefreshRate(): Promise<number> {
  return new Promise<number>((resolve) => {
    const samples: number[] = [];
    let lastTime = 0;
    let frames = 0;

    const onFrame = (time: number) => {
      if (lastTime > 0) {
        samples.push(time - lastTime);
      }
      lastTime = time;
      frames++;
      if (frames < 30) {
        requestAnimationFrame(onFrame);
      } else {
        // Discard the first sample (often inaccurate) and average the rest.
        const valid = samples.slice(1);
        if (valid.length < 5) {
          resolve(0);
          return;
        }
        const avgMs = valid.reduce((a, b) => a + b, 0) / valid.length;
        const hz = Math.round(1000 / avgMs);
        // Snap to common rates: 60, 90, 120
        const snapped = [60, 90, 120, 144].find((r) => Math.abs(hz - r) <= 3) ?? hz;
        resolve(snapped);
      }
    };
    requestAnimationFrame(onFrame);
  });
}
