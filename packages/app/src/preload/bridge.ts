// ============================================================================
// createDowndraftBridge() — preload context bridge with default API + extend hook
// ============================================================================

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/messages";

// --- Shared Texture Receiver ---
// Electron's sharedTexture API is only available in the preload's isolated world.
// We register the receiver here and forward VideoFrames to the renderer's main
// world via postMessage (VideoFrame is transferable).
const electron = require("electron") as any;
const sharedTextureApi = (globalThis as any).sharedTexture ?? electron?.sharedTexture;

/**
 * The default `window.downdraft` API surface. Games get this for free;
 * use the `extend` hook to add game-specific channels.
 */
export function createDefaultBridge(): Record<string, any> {
  return {
    saveGameState: (slotName: string, stateJson: string): Promise<boolean> => ipcRenderer.invoke(IPC.SAVE_GAME_STATE, slotName, stateJson),
    loadGameState: (slotName: string): Promise<string | null> => ipcRenderer.invoke(IPC.LOAD_GAME_STATE, slotName),
    deleteGameState: (slotName: string): Promise<boolean> => ipcRenderer.invoke(IPC.DELETE_GAME_STATE, slotName),
    listSaveSlots: (): Promise<Array<{ slot: string; timestamp: number; entityCount: number; playerCount: number; engineVersion: string; fileSize: number }>> => ipcRenderer.invoke(IPC.LIST_SAVE_SLOTS),

    quit: (): Promise<void> => ipcRenderer.invoke(IPC.QUIT),

    setDebugMode: (enabled: boolean): void => ipcRenderer.send(IPC.DEBUG_MODE, enabled),

    toggleDevtools: (): void => ipcRenderer.send(IPC.TOGGLE_DEVTOOLS),

    toggleFullscreen: (): void => ipcRenderer.send(IPC.TOGGLE_FULLSCREEN),

    getDisplayInfo: (): Promise<{ refreshRate: number }> => ipcRenderer.invoke(IPC.GET_DISPLAY_INFO),

    openExternal: (url: string): void => { ipcRenderer.send(IPC.OPEN_EXTERNAL, url); },

    getGPUSystemInfo: (): Promise<any> => ipcRenderer.invoke(IPC.GPU_SYSTEM_INFO),
    getElectronGPUInfo: (): Promise<any> => ipcRenderer.invoke(IPC.ELECTRON_GPU_INFO),
    getVulkanValidationStatus: (): Promise<any> => ipcRenderer.invoke(IPC.VULKAN_VALIDATION_STATUS),
    openChromeUrl: (url: string): void => { ipcRenderer.send(IPC.OPEN_CHROME_URL, url); },

    // Import cache — caches resolved model import settings (SQLite-backed in main process)
    importCacheGet: (modelPath: string): Promise<{ settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number } | null> =>
      ipcRenderer.invoke(IPC.IMPORT_CACHE_GET, modelPath),
    importCacheSet: (modelPath: string, entry: { settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.IMPORT_CACHE_SET, modelPath, entry),
    importCacheInvalidate: (modelPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.IMPORT_CACHE_INVALIDATE, modelPath),

    onSimReady: (cb: (data: any) => void) => ipcRenderer.on(IPC.SIM_READY, (_e, data) => cb(data)),

    onDisplayInfo: (cb: (data: { refreshRate: number }) => void) => ipcRenderer.on(IPC.DISPLAY_INFO, (_e, data) => cb(data)),

    onDisplayMetricsChanged: (cb: (data: { scaleFactor: number }) => void) => ipcRenderer.on(IPC.DISPLAY_METRICS_CHANGED, (_e, data) => cb(data)),

    onGCStats: (cb: (data: any) => void) => ipcRenderer.on(IPC.GC_STATS, (_e, data) => cb(data)),

    onPerfStats: (cb: (data: any) => void) => ipcRenderer.on(IPC.PERF_STATS, (_e, data) => cb(data)),

    // --- OSR (Offscreen Rendering) ---
    osr: {
      createRenderer: (config: any): Promise<void> => ipcRenderer.invoke(IPC.OSR_CREATE_RENDERER, config),
      destroyRenderer: (id: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_DESTROY_RENDERER, id),
      addPanel: (config: any): Promise<any> => ipcRenderer.invoke(IPC.OSR_ADD_PANEL, config),
      removePanel: (rendererId: string, panelId: string): Promise<any> => ipcRenderer.invoke(IPC.OSR_REMOVE_PANEL, rendererId, panelId),
      updatePanel: (rendererId: string, panelId: string, html: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_UPDATE_PANEL, rendererId, panelId, html),
      updateData: (rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void =>
        ipcRenderer.send(IPC.OSR_UPDATE_DATA, rendererId, panelId, values),
      setContent: (rendererId: string, html: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_SET_CONTENT, rendererId, html),
      loadURL: (rendererId: string, url: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_LOAD_URL, rendererId, url),
      sendInputEvent: (rendererId: string, event: any): void =>
        ipcRenderer.send(IPC.OSR_INPUT_EVENT, rendererId, event),
      setSoftwareCursor: (rendererId: string, enabled: boolean): void =>
        ipcRenderer.send(IPC.OSR_SET_SOFTWARE_CURSOR, rendererId, enabled),
      onPanelLayout: (cb: (rendererId: string, layout: any) => void) =>
        ipcRenderer.on(IPC.OSR_PANEL_LAYOUT, (_e, rendererId, layout) => cb(rendererId, layout)),
      onRendererEvent: (cb: (event: any) => void) =>
        ipcRenderer.on(IPC.OSR_RENDERER_EVENT, (_e, event) => cb(event)),
      onCursorStyle: (cb: (rendererId: string, cursor: string) => void) =>
        ipcRenderer.on(IPC.OSR_CURSOR_STYLE, (_e, rendererId, cursor) => cb(rendererId, cursor)),
      // Register a shared texture receiver using the subtle API.
      // Main process sends transfer data via IPC; preload reconstructs via
      // finishTransferSharedTexture, extracts VideoFrame, and forwards to
      // renderer's main world via postMessage (VideoFrame is transferable).
      registerSharedTextureReceiver: (): boolean => {
        const subtle = sharedTextureApi?.subtle;
        if (!subtle?.finishTransferSharedTexture) {
          console.error("[preload] sharedTexture.subtle.finishTransferSharedTexture not available");
          return false;
        }
        let transferCount = 0;
        let previousImported: any = null;

        // Helper: process an imported shared texture — extract VideoFrame, forward to main world
        const processImported = (imported: any, rendererId: string, correlationId?: number) => {
          transferCount++;
          if (previousImported) {
            try { previousImported.release(() => {}); } catch {}
          }
          previousImported = imported;

          const videoFrame = imported.getVideoFrame();
          if (!videoFrame) {
            if (transferCount === 1) {
              console.error(`[preload] getVideoFrame returned null for '${rendererId}'`);
            }
            return;
          }
          if (transferCount === 1) {
            console.log(`[preload] First VideoFrame for '${rendererId}': ${videoFrame.displayWidth}x${videoFrame.displayHeight}, format=${videoFrame.format}`);
          }

          // Transfer VideoFrame to main world via postMessage
          window.postMessage({ type: "__osr_video_frame", rendererId, videoFrame }, "*", [videoFrame]);

          // Send sync token back to main process for proper GPU synchronization
          try {
            const syncToken = imported.getFrameCreationSyncToken?.();
            if (syncToken) {
              ipcRenderer.send("__osr_sync_token", rendererId, correlationId, syncToken);
            }
          } catch {}
        };

        // High-level API: setSharedTextureReceiver (handles GPU sync automatically)
        if (sharedTextureApi?.setSharedTextureReceiver) {
          console.log(`[preload] Registering setSharedTextureReceiver`);
          sharedTextureApi.setSharedTextureReceiver((received: any, ...args: any[]) => {
            try {
              const rendererId = args[0] || "unknown";
              const correlationId = args[1];
              const imported = received.importedSharedTexture || received;
              processImported(imported, rendererId, correlationId);
            } catch (err) {
              console.error(`[preload] setSharedTextureReceiver callback failed:`, err);
            }
          });
        }

        // Low-level API: subtle.finishTransferSharedTexture (fallback)
        ipcRenderer.on("__osr_shared_texture_transfer", (_e: any, rendererId: string, correlationId: number, transfer: any) => {
          try {
            const imported = subtle.finishTransferSharedTexture(transfer);
            processImported(imported, rendererId, correlationId);
          } catch (err) {
            if (transferCount === 0) {
              console.error(`[preload] sharedTexture transfer failed for '${rendererId}':`, err);
            }
          }
        });
        console.log(`[preload] Shared texture receiver registered`);
        return true;
      },
      // Register a NativeImage paint receiver (CPU fallback when shared textures aren't available)
      onPaintImage: (cb: (rendererId: string, image: any) => void) =>
        ipcRenderer.on("__osr_paint_image", (_e, rendererId, image) => cb(rendererId, image)),
      // Register a region-based paint receiver (dirty rect + compressed data)
      onPaintRegion: (cb: (rendererId: string, region: { x: number; y: number; width: number; height: number; fullWidth: number; fullHeight: number; data: ArrayBuffer; compressed: boolean }) => void) =>
        ipcRenderer.on("__osr_paint_region", (_e, rendererId, region) => cb(rendererId, region)),
      // Create a direct MessagePort from main process → worker (bypasses renderer main thread)
      // Port1 goes to main process, port2 is transferred to renderer via window.postMessage
      createPaintPort: (rendererId: string): void => {
        const { port1, port2 } = new MessageChannel();
        ipcRenderer.postMessage("__osr_paint_port", { rendererId }, [port1]);
        window.postMessage({ type: "__osr_paint_port", rendererId, port: port2 }, "*", [port2]);
      },
    },

    removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),

    log: (level: string, message: string) => ipcRenderer.send(IPC.RENDERER_LOG, { level, message }),

    onMcpRequest: (cb: (request: { id: number; method: string; params?: Record<string, unknown> }) => Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }>) => {
      ipcRenderer.on(IPC.MCP_REQUEST, async (_e, request) => {
        const result = await cb(request);
        ipcRenderer.send(`mcp-response-${result.id}`, result);
      });
    },
  };
}

export interface DowndraftBridgeConfig {
  /**
   * Deliberate escape hatch: extend the default `window.downdraft` API with
   * game-specific channels. Receives the default API object and raw Electron
   * preload modules.
   */
  extend?: (
    api: Record<string, any>,
    electron: { ipcRenderer: typeof ipcRenderer; contextBridge: typeof contextBridge },
  ) => void;
}

/**
 * Create and expose the `window.downdraft` bridge in the preload script.
 *
 * Call this from your game's `src/preload.ts`:
 *
 * ```ts
 * import { createDowndraftBridge } from "@downdraft/app/preload";
 * createDowndraftBridge();
 * ```
 */
export function createDowndraftBridge(config: DowndraftBridgeConfig = {}): void {
  const api = createDefaultBridge();

  if (config.extend) {
    config.extend(api, { ipcRenderer, contextBridge });
  }

  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("downdraft", api);
  } else {
    (globalThis as any).downdraft = api;
  }
}
