// ============================================================================
// @downdraft/app/renderer — typed accessor for window.downdraft
// ============================================================================
//
// Import `downdraft` from this module in renderer code instead of casting
// `(window as any).downdraft`. The default bridge is still exposed on
// `window.downdraft` by the preload; this module provides a typed view.
//
// In browser-only mode (no Electron preload), `window.downdraft` is absent
// and this accessor returns a stub that no-ops / returns null. Callers that
// need real values should guard with `downdraft?.isAvailable`.

import { OpfsSaveStore } from "@downdraft/library-persistence/browser";
import type {
    DowndraftBridgeAPI,
    DowndraftOsrBridgeAPI
} from "../shared/types";
import { createSaveStore as _createSaveStore } from "./save-store-factory";

export type DowndraftOsrBridge = DowndraftOsrBridgeAPI;

export interface DowndraftBridge extends Omit<DowndraftBridgeAPI, "osr"> {
  isAvailable: boolean;
  isDev?: boolean;
  osr?: DowndraftOsrBridge;
}

function noop(): void {}

const stubBridge: DowndraftBridge = {
  isAvailable: false,
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
  quit: () => Promise.resolve(),
  setDebugMode: noop,
  toggleDevtools: noop,
  toggleFullscreen: noop,
  getDisplayInfo: () => Promise.resolve({ refreshRate: 0 }),
  openExternal: noop,
  getGPUSystemInfo: () => Promise.resolve(null),
  getElectronGPUInfo: () => Promise.resolve(null),
  getVulkanValidationStatus: () => Promise.resolve({ enabled: false, envVar: null }),
  getFeatureLog: () => Promise.resolve(null),
  openChromeUrl: noop,
  capturePage: () => Promise.resolve(null),
  startTrace: () => Promise.reject(new Error("Tracing not available in browser mode")),
  stopTrace: () => Promise.reject(new Error("Tracing not available in browser mode")),
  traceStatus: () => Promise.resolve({ recording: false }),
  traceCategories: () => Promise.resolve({ categories: [] }),
  captureHeapSnapshot: () => Promise.reject(new Error("Heap snapshot not available in browser mode")),
  processSnapshot: () => Promise.reject(new Error("Process snapshot not available in browser mode")),
  importCacheGet: () => Promise.resolve(null),
  importCacheSet: () => Promise.resolve(),
  importCacheInvalidate: () => Promise.resolve(),
  onSimReady: noop,
  onDisplayInfo: noop,
  onDisplayMetricsChanged: noop,
  onGCStats: noop,
  onPerfStats: noop,
  removeAllListeners: noop,
  log: noop,
  deterministic: false,
  onMcpRequest: noop,
};

/**
 * Typed accessor for the `window.downdraft` bridge exposed by the preload.
 *
 * In Electron mode, this is the real bridge. In browser-only mode (e.g.
 * model-viewer running standalone), it returns a stub with `isAvailable: false`.
 */
export const downdraft: DowndraftBridge = (() => {
  const raw = (globalThis as unknown as { downdraft?: DowndraftBridgeAPI }).downdraft;
  if (raw) {
    return { ...raw, isAvailable: true } as DowndraftBridge;
  }
  return stubBridge;
})();

// Import cache adapter — Electron IPC-backed with memory fallback
export { createElectronImportCache } from "./import-cache";

// Bootstrap orchestrator + composable hooks
export { bootstrapGame } from "./bootstrap";
export type { BootstrapAutosaveOptions, BootstrapDevToolsOptions, BootstrapGameOptions } from "./bootstrap";
export { startGame } from "./game-module";
export type {
    GameContext,
    GameModule,
    GameSaveConfig,
    GameSaveSource,
    GameSimWorker,
    PluginRuntimeConfig,
    RendererFactory,
    SimEventMap,
    SimWorkerFactory,
    SimWorkerSeed
} from "./game-module";
export { useDeterministicRenderPause, useDisplayInfo, useFpsPolling, useHotReloadDispose } from "./hooks";

// Save store factory + IPC fallback
export { IpcSaveStore, type SaveBridge } from "./ipc-save-store";
export { createInlineSaveStore, createSaveStore, type CreateSaveStoreOptions, type SaveStoreMode } from "./save-store-factory";

/**
 * Create the default ISaveStore for a game: tries createSaveStore in "auto"
 * mode (OPFS worker → IPC fallback), then falls back to an inline OpfsSaveStore
 * if createSaveStore returns null (inline mode). This is the standard store
 * creation pattern shared by all grid games.
 */
export async function createDefaultSaveStore(engineVersion: string): Promise<import("@downdraft/core").ISaveStore> {
  const store = await _createSaveStore({
    mode: "auto",
    opfsOptions: { engineVersion },
    bridge: downdraft,
  });
  if (!store) {
    const fallback = new OpfsSaveStore({ engineVersion });
    await fallback.init();
    return fallback;
  }
  return store;
}

// AutosaveManager (re-exported from @downdraft/library-persistence)
export { AutosaveManager, type AutosaveManagerOptions } from "@downdraft/library-persistence/browser";

// MCP automation harness factory + shared tool helpers
export { blobToBase64, compositeScreenshot, createMcpHarness, errorResult, jsonResult } from "./mcp-harness";
export type { McpHarnessOptions, McpRequest, McpResponse, McpToolDef, McpToolRegistration } from "./mcp-harness";

// Feature log (renderer collector + combined accessor + MCP tool factory)
export {
    collectRendererFeatureLog,
    createFeatureLogMcpTool,
    getCombinedFeatureLog,
    getRendererFeatureLog
} from "./feature-log";
export type { CombinedFeatureLog, RendererFeatureLogOptions } from "./feature-log";

// --- Canvas / overlay layer helpers ---

/**
 * Get the canvas element for a given layer index.
 * Layer 0 is the primary game canvas (id="game-canvas" by default).
 * Higher indices are additional canvases (e.g. minimap, debug overlay).
 */
export function getCanvas(layer: number = 0): HTMLCanvasElement {
  const el = document.querySelector(`canvas[data-dd-layer="${layer}"]`) as HTMLCanvasElement | null;
  if (el) return el;
  // Fallback to legacy id-based lookup for backward compatibility
  if (layer === 0) {
    const legacy = document.getElementById("game-canvas") as HTMLCanvasElement | null;
    if (legacy) return legacy;
  }
  throw new Error(`No canvas found for layer ${layer}. Ensure the HTML has <canvas data-dd-layer="${layer}">.`);
}

/**
 * Get the DOM overlay element for a given overlay index.
 * Overlay 0 is the primary React root (id="root" by default).
 */
export function getOverlay(overlay: number = 0): HTMLElement {
  const el = document.querySelector(`div[data-dd-overlay="${overlay}"]`) as HTMLElement | null;
  if (el) return el;
  if (overlay === 0) {
    const legacy = document.getElementById("root") as HTMLElement | null;
    if (legacy) return legacy;
  }
  throw new Error(`No overlay found for index ${overlay}. Ensure the HTML has <div data-dd-overlay="${overlay}">.`);
}

/**
 * Get all canvas layers in order (layer 0 first).
 */
export function getAllCanvases(): HTMLCanvasElement[] {
  return Array.from(document.querySelectorAll("canvas[data-dd-layer]")) as HTMLCanvasElement[];
}

// --- Thumbnail capture ---

/**
 * Capture a downscaled JPEG thumbnail of a canvas as an ArrayBuffer.
 *
 * Downscaled to a max width of 320px (preserving aspect ratio). Falls back to
 * a placeholder image if canvas capture fails. The returned ArrayBuffer is
 * suitable for `ISaveStore.setThumbnail()` / `SaveOptions.thumbnail`.
 */
export async function captureCanvasThumbnail(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const maxW = 320;
  const scale = Math.min(1, maxW / canvas.width);
  const thumbW = Math.floor(canvas.width * scale);
  const thumbH = Math.floor(canvas.height * scale);

  const fullBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8);
  });

  if (fullBlob) {
    const img = new Image();
    const url = URL.createObjectURL(fullBlob);
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("img load"));
        img.src = url;
      });
      const off = document.createElement("canvas");
      off.width = thumbW;
      off.height = thumbH;
      const ctx = off.getContext("2d")!;
      ctx.drawImage(img, 0, 0, thumbW, thumbH);
      const thumbBlob = await new Promise<Blob | null>((resolve) => {
        off.toBlob((b) => resolve(b), "image/jpeg", 0.8);
      });
      if (thumbBlob) return await thumbBlob.arrayBuffer();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Placeholder if capture fails
  const placeholder = document.createElement("canvas");
  placeholder.width = 320;
  placeholder.height = 180;
  const pctx = placeholder.getContext("2d")!;
  pctx.fillStyle = "#0a0a12";
  pctx.fillRect(0, 0, 320, 180);
  pctx.fillStyle = "rgba(255,255,255,0.5)";
  pctx.font = "14px monospace";
  pctx.textAlign = "center";
  pctx.fillText("No preview", 160, 90);
  const phBlob = await new Promise<Blob | null>((resolve) => {
    placeholder.toBlob((b) => resolve(b), "image/jpeg", 0.8);
  });
  if (phBlob) return await phBlob.arrayBuffer();
  throw new Error("Thumbnail capture failed");
}
