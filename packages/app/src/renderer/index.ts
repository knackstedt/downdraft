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

export interface DowndraftOsrBridge {
  createRenderer(config: any): Promise<void>;
  destroyRenderer(id: string): Promise<void>;
  addPanel(config: any): Promise<any>;
  removePanel(rendererId: string, panelId: string): Promise<any>;
  updatePanel(rendererId: string, panelId: string, html: string): Promise<void>;
  updateData(rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void;
  setContent(rendererId: string, html: string): Promise<void>;
  loadURL(rendererId: string, url: string): Promise<void>;
  sendInputEvent(rendererId: string, event: any): void;
  setSoftwareCursor(rendererId: string, enabled: boolean): void;
  onPanelLayout(cb: (rendererId: string, layout: any) => void): void;
  onRendererEvent(cb: (event: any) => void): void;
  onCursorStyle(cb: (rendererId: string, cursor: string) => void): void;
  registerSharedTextureReceiver(): boolean;
  onPaintImage(cb: (rendererId: string, image: any) => void): void;
  onPaintRegion(cb: (rendererId: string, region: { x: number; y: number; width: number; height: number; fullWidth: number; fullHeight: number; data: ArrayBuffer; compressed: boolean }) => void): void;
  createPaintPort(rendererId: string): void;
}

export interface DowndraftBridge {
  isAvailable: boolean;
  isDev?: boolean;
  saveGameState(slotName: string, stateJson: string): Promise<boolean>;
  loadGameState(slotName: string): Promise<string | null>;
  deleteGameState(slotName: string): Promise<boolean>;
  listSaveSlots(): Promise<Array<{ slot: string; timestamp: number; entityCount: number; playerCount: number; engineVersion: string; fileSize: number }>>;
  quit(): Promise<void>;
  setDebugMode(enabled: boolean): void;
  toggleDevtools(): void;
  toggleFullscreen(): void;
  getDisplayInfo(): Promise<{ refreshRate: number }>;
  openExternal(url: string): void;
  getGPUSystemInfo(): Promise<any>;
  getElectronGPUInfo(): Promise<any>;
  getVulkanValidationStatus(): Promise<any>;
  openChromeUrl(url: string): void;
  // Import cache — caches resolved model import settings (SQLite-backed in main process)
  importCacheGet(modelPath: string): Promise<{ settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number } | null>;
  importCacheSet(modelPath: string, entry: { settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number }): Promise<void>;
  importCacheInvalidate(modelPath: string): Promise<void>;
  onSimReady(cb: (data: any) => void): void;
  onDisplayInfo(cb: (data: { refreshRate: number }) => void): void;
  onDisplayMetricsChanged(cb: (data: { scaleFactor: number }) => void): void;
  onGCStats(cb: (data: any) => void): void;
  onPerfStats(cb: (data: any) => void): void;
  osr?: DowndraftOsrBridge;
  removeAllListeners(channel: string): void;
  log(level: string, message: string): void;
  onMcpRequest(cb: (request: { id: number; method: string; params?: Record<string, unknown> }) => Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }>): void;
  [key: string]: any; // allow game-specific extensions
}

function noop(): void {}
function noopAsync(): Promise<any> { return Promise.resolve(null as any); }
function noopBool(): boolean { return false; }

const stubBridge: DowndraftBridge = {
  isAvailable: false,
  saveGameState: noopAsync as any,
  loadGameState: noopAsync as any,
  deleteGameState: noopAsync as any,
  listSaveSlots: noopAsync as any,
  quit: noopAsync as any,
  setDebugMode: noop,
  toggleDevtools: noop,
  toggleFullscreen: noop,
  getDisplayInfo: noopAsync as any,
  openExternal: noop,
  getGPUSystemInfo: noopAsync,
  getElectronGPUInfo: noopAsync,
  getVulkanValidationStatus: noopAsync,
  openChromeUrl: noop,
  importCacheGet: noopAsync as any,
  importCacheSet: noopAsync as any,
  importCacheInvalidate: noopAsync as any,
  onSimReady: noop,
  onDisplayInfo: noop,
  onDisplayMetricsChanged: noop,
  onGCStats: noop,
  onPerfStats: noop,
  removeAllListeners: noop,
  log: noop,
  onMcpRequest: noop,
};

/**
 * Typed accessor for the `window.downdraft` bridge exposed by the preload.
 *
 * In Electron mode, this is the real bridge. In browser-only mode (e.g.
 * model-viewer running standalone), it returns a stub with `isAvailable: false`.
 */
export const downdraft: DowndraftBridge = (() => {
  const raw = (globalThis as any).downdraft;
  if (raw) {
    return { ...raw, isAvailable: true } as DowndraftBridge;
  }
  return stubBridge;
})();

// Import cache adapter — Electron IPC-backed with memory fallback
export { createElectronImportCache } from "./import-cache";
