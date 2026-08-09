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
