// ============================================================================
// createDowndraftBridge() — preload context bridge with default API + extend hook
// ============================================================================

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/messages";
import type {
    AtlasPanelRect,
    DisplayInfoData,
    DisplayMetricsChangedData,
    DowndraftBridgeAPI,
    ElectronGPUInfo,
    GCStatsData,
    GPUSystemInfo,
    ImportCacheEntry,
    ImportedSharedTexture,
    McpRequest,
    McpResponse,
    OSRInputEvent,
    OSRPanelConfig,
    OSRPanelLayout,
    OSRRendererConfig,
    OSRRendererEvent,
    PaintRegionData,
    PerfStatsData,
    SaveSlotInfo,
    SharedTextureApi,
    SimReadyData,
    VulkanValidationStatus
} from "../shared/types";

// --- Shared Texture Receiver ---
// Electron's sharedTexture API is only available in the preload's isolated world.
// We register the receiver here and forward VideoFrames to the renderer's main
// world via postMessage (VideoFrame is transferable).
const electron = require("electron") as { sharedTexture?: SharedTextureApi };
const sharedTextureApi: SharedTextureApi | undefined =
  (globalThis as unknown as { sharedTexture?: SharedTextureApi }).sharedTexture ?? electron?.sharedTexture;

/** Type guard: checks whether a value is an imported shared texture. */
function isImportedSharedTexture(obj: unknown): obj is ImportedSharedTexture {
  return typeof obj === "object" && obj !== null &&
    typeof (obj as ImportedSharedTexture).getVideoFrame === "function";
}

/** Extracts the imported shared texture from a received callback payload. */
function extractImported(received: unknown): ImportedSharedTexture | null {
  if (isImportedSharedTexture(received)) return received;
  if (received && typeof received === "object" && "importedSharedTexture" in received) {
    const inner = (received as Record<string, unknown>).importedSharedTexture;
    if (isImportedSharedTexture(inner)) return inner;
  }
  return null;
}

/**
 * The default `window.downdraft` API surface. Games get this for free;
 * use the `extend` hook to add game-specific channels.
 */
export function createDefaultBridge(): DowndraftBridgeAPI {
  return {
    saveGameState: (slotName: string, stateJson: string, opts?: any): Promise<boolean> => ipcRenderer.invoke(IPC.SAVE_GAME_STATE, slotName, stateJson, opts),
    loadGameState: (slotName: string, opts?: any): Promise<string | null> => ipcRenderer.invoke(IPC.LOAD_GAME_STATE, slotName, opts),
    deleteGameState: (slotName: string): Promise<boolean> => ipcRenderer.invoke(IPC.DELETE_GAME_STATE, slotName),
    listSaveSlots: (): Promise<SaveSlotInfo[]> => ipcRenderer.invoke(IPC.LIST_SAVE_SLOTS),
    listSaveGenerations: (slotName: string): Promise<any[]> => ipcRenderer.invoke(IPC.LIST_SAVE_GENERATIONS, slotName),
    deleteSaveGeneration: (slotName: string, gen: number): Promise<boolean> => ipcRenderer.invoke(IPC.DELETE_SAVE_GENERATION, slotName, gen),
    setThumbnail: (slotName: string, data: ArrayBuffer | Uint8Array): Promise<void> => ipcRenderer.invoke(IPC.SET_THUMBNAIL, slotName, data),
    getThumbnail: (slotName: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke(IPC.GET_THUMBNAIL, slotName),
    setSaveProperties: (slotName: string, props: Record<string, unknown>): Promise<void> => ipcRenderer.invoke(IPC.SET_SAVE_PROPERTIES, slotName, props),
    getSaveProperties: (slotName: string): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.GET_SAVE_PROPERTIES, slotName),

    quit: (): Promise<void> => ipcRenderer.invoke(IPC.QUIT),

    setDebugMode: (enabled: boolean): void => ipcRenderer.send(IPC.DEBUG_MODE, enabled),

    toggleDevtools: (): void => ipcRenderer.send(IPC.TOGGLE_DEVTOOLS),

    toggleFullscreen: (): void => ipcRenderer.send(IPC.TOGGLE_FULLSCREEN),

    getDisplayInfo: (): Promise<DisplayInfoData> => ipcRenderer.invoke(IPC.GET_DISPLAY_INFO),

    openExternal: (url: string): void => { ipcRenderer.send(IPC.OPEN_EXTERNAL, url); },

    getGPUSystemInfo: (): Promise<GPUSystemInfo | null> => ipcRenderer.invoke(IPC.GPU_SYSTEM_INFO),
    getElectronGPUInfo: (): Promise<ElectronGPUInfo | null> => ipcRenderer.invoke(IPC.ELECTRON_GPU_INFO),
    getVulkanValidationStatus: (): Promise<VulkanValidationStatus> => ipcRenderer.invoke(IPC.VULKAN_VALIDATION_STATUS),
    openChromeUrl: (url: string): void => { ipcRenderer.send(IPC.OPEN_CHROME_URL, url); },

    capturePage: (): Promise<ArrayBuffer | null> => ipcRenderer.invoke(IPC.CAPTURE_PAGE),

    // Import cache — caches resolved model import settings (SQLite-backed in main process)
    importCacheGet: (modelPath: string): Promise<ImportCacheEntry | null> =>
      ipcRenderer.invoke(IPC.IMPORT_CACHE_GET, modelPath),
    importCacheSet: (modelPath: string, entry: ImportCacheEntry): Promise<void> =>
      ipcRenderer.invoke(IPC.IMPORT_CACHE_SET, modelPath, entry),
    importCacheInvalidate: (modelPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.IMPORT_CACHE_INVALIDATE, modelPath),

    onSimReady: (cb: (data: SimReadyData) => void) => ipcRenderer.on(IPC.SIM_READY, (_e, data: SimReadyData) => cb(data)),

    onDisplayInfo: (cb: (data: DisplayInfoData) => void) => ipcRenderer.on(IPC.DISPLAY_INFO, (_e, data: DisplayInfoData) => cb(data)),

    onDisplayMetricsChanged: (cb: (data: DisplayMetricsChangedData) => void) => ipcRenderer.on(IPC.DISPLAY_METRICS_CHANGED, (_e, data: DisplayMetricsChangedData) => cb(data)),

    onGCStats: (cb: (data: GCStatsData) => void) => ipcRenderer.on(IPC.GC_STATS, (_e, data: GCStatsData) => cb(data)),

    onPerfStats: (cb: (data: PerfStatsData) => void) => ipcRenderer.on(IPC.PERF_STATS, (_e, data: PerfStatsData) => cb(data)),

    // --- OSR (Offscreen Rendering) ---
    osr: {
      createRenderer: (config: OSRRendererConfig): Promise<void> => ipcRenderer.invoke(IPC.OSR_CREATE_RENDERER, config),
      destroyRenderer: (id: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_DESTROY_RENDERER, id),
      addPanel: (config: OSRPanelConfig): Promise<AtlasPanelRect | null> => ipcRenderer.invoke(IPC.OSR_ADD_PANEL, config),
      removePanel: (rendererId: string, panelId: string): Promise<OSRPanelLayout | null> => ipcRenderer.invoke(IPC.OSR_REMOVE_PANEL, rendererId, panelId),
      updatePanel: (rendererId: string, panelId: string, html: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_UPDATE_PANEL, rendererId, panelId, html),
      updateData: (rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void =>
        ipcRenderer.send(IPC.OSR_UPDATE_DATA, rendererId, panelId, values),
      setContent: (rendererId: string, html: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_SET_CONTENT, rendererId, html),
      loadURL: (rendererId: string, url: string): Promise<void> => ipcRenderer.invoke(IPC.OSR_LOAD_URL, rendererId, url),
      sendInputEvent: (rendererId: string, event: Omit<OSRInputEvent, "rendererId">): void =>
        ipcRenderer.send(IPC.OSR_INPUT_EVENT, rendererId, event),
      setSoftwareCursor: (rendererId: string, enabled: boolean): void =>
        ipcRenderer.send(IPC.OSR_SET_SOFTWARE_CURSOR, rendererId, enabled),
      onPanelLayout: (cb: (rendererId: string, layout: OSRPanelLayout) => void) =>
        ipcRenderer.on(IPC.OSR_PANEL_LAYOUT, (_e, rendererId: string, layout: OSRPanelLayout) => cb(rendererId, layout)),
      onRendererEvent: (cb: (event: OSRRendererEvent) => void) =>
        ipcRenderer.on(IPC.OSR_RENDERER_EVENT, (_e, event: OSRRendererEvent) => cb(event)),
      onCursorStyle: (cb: (rendererId: string, cursor: string) => void) =>
        ipcRenderer.on(IPC.OSR_CURSOR_STYLE, (_e, rendererId: string, cursor: string) => cb(rendererId, cursor)),
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
        let previousImported: ImportedSharedTexture | null = null;

        // Helper: process an imported shared texture — extract VideoFrame, forward to main world
        const processImported = (imported: ImportedSharedTexture, rendererId: string, correlationId?: number) => {
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
          window.postMessage({ type: "__osr_video_frame", rendererId, videoFrame }, "*", [videoFrame as unknown as Transferable]);

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
          sharedTextureApi.setSharedTextureReceiver((received: unknown, ...args: unknown[]) => {
            try {
              const rendererId = typeof args[0] === "string" ? args[0] : "unknown";
              const correlationId = typeof args[1] === "number" ? args[1] : undefined;
              const imported = extractImported(received);
              if (imported) {
                processImported(imported, rendererId, correlationId);
              }
            } catch (err) {
              console.error(`[preload] setSharedTextureReceiver callback failed:`, err);
            }
          });
        }

        // Low-level API: subtle.finishTransferSharedTexture (fallback)
        ipcRenderer.on("__osr_shared_texture_transfer", (_e, rendererId: string, correlationId: number, transfer: unknown) => {
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
      onPaintImage: (cb: (rendererId: string, image: unknown) => void) =>
        ipcRenderer.on("__osr_paint_image", (_e, rendererId: string, image: unknown) => cb(rendererId, image)),
      // Register a region-based paint receiver (dirty rect + compressed data)
      onPaintRegion: (cb: (rendererId: string, region: PaintRegionData) => void) =>
        ipcRenderer.on("__osr_paint_region", (_e, rendererId: string, region: PaintRegionData) => cb(rendererId, region)),
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

    // Exposed from main process env so the renderer can detect test/deterministic mode
    deterministic: process.env.DOWNDRAFT_DETERMINISTIC === "1",

    onMcpRequest: (cb: (request: McpRequest) => Promise<McpResponse>) => {
      ipcRenderer.on(IPC.MCP_REQUEST, async (_e, request: McpRequest) => {
        try {
          const result = await cb(request);
          ipcRenderer.send(`mcp-response-${result.id}`, result);
        } catch (err) {
          ipcRenderer.send(`mcp-response-${request.id}`, {
            id: request.id,
            error: { code: -32603, message: `Renderer callback error: ${(err as Error).message}` },
          });
        }
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
    api: DowndraftBridgeAPI,
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
    (globalThis as unknown as { downdraft: DowndraftBridgeAPI }).downdraft = api;
  }
}
