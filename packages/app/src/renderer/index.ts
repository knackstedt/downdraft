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

import type {
    DowndraftBridgeAPI,
    DowndraftOsrBridgeAPI
} from "../shared/types";

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
  openChromeUrl: noop,
  capturePage: () => Promise.resolve(null),
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

// Save store factory + IPC fallback
export { IpcSaveStore, type SaveBridge } from "./ipc-save-store";
export { createInlineSaveStore, createSaveStore, type CreateSaveStoreOptions, type SaveStoreMode } from "./save-store-factory";

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
