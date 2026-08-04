// ============================================================================
// Preload — context bridge between renderer and main process
// ============================================================================

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/messages";

// --- Shared Texture Receiver ---
// Electron's sharedTexture API is only available in the preload's isolated world.
// We register the receiver here and forward VideoFrames to the renderer's main
// world via postMessage (VideoFrame is transferable).
const electron = require("electron") as any;
const sharedTextureApi = (globalThis as any).sharedTexture ?? electron?.sharedTexture;
console.log(`[preload] sharedTexture API check: globalThis.sharedTexture=${!!(globalThis as any).sharedTexture}, electron.sharedTexture=${!!electron?.sharedTexture}, resolved=${!!sharedTextureApi}`);
if (sharedTextureApi) {
  console.log(`[preload] sharedTexture API methods:`, Object.keys(sharedTextureApi));
}

const api = {
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
      let logDone = false;
      let previousImported: any = null;
      ipcRenderer.on("__osr_shared_texture_transfer", (_e: any, rendererId: string, transfer: any) => {
        try {
          // Release the PREVIOUS frame's imported texture — by now the
          // renderer has finished its WebGPU copy (at least one frame ago)
          if (previousImported) {
            try { previousImported.release(() => {}); } catch {}
          }
          // Reconstruct the imported shared texture in this process
          const imported = subtle.finishTransferSharedTexture(transfer);
          previousImported = imported;
          if (!logDone) {
            console.log(`[preload] finishTransferSharedTexture succeeded, imported methods:`, Object.keys(imported));
            logDone = true;
          }
          // Extract VideoFrame — this is the GPU texture wrapped as a VideoFrame
          const videoFrame = imported.getVideoFrame();
          if (!videoFrame) {
            console.error("[preload] getVideoFrame returned null");
            return;
          }
          // Transfer VideoFrame to main world via postMessage
          // The transfer list detaches the VideoFrame from this context
          window.postMessage({ type: "__osr_video_frame", rendererId, videoFrame }, "*", [videoFrame]);
          // Don't release imported yet — the renderer needs time to do the
          // WebGPU copy. It will be released when the next frame arrives.
        } catch (err) {
          console.error("[preload] sharedTexture transfer failed:", err);
        }
      });
      return true;
    },
    // Register a NativeImage paint receiver (CPU fallback when shared textures aren't available)
    onPaintImage: (cb: (rendererId: string, image: any) => void) =>
      ipcRenderer.on("__osr_paint_image", (_e, rendererId, image) => cb(rendererId, image)),
  },

  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),

  log: (level: string, message: string) => ipcRenderer.send(IPC.RENDERER_LOG, { level, message }),

  onMcpRequest: (cb: (request: { id: number; method: string; params?: Record<string, unknown> }) => Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }>) => {
    ipcRenderer.on(IPC.MCP_REQUEST, async (_e, request) => {
      const result = await cb(request);
      ipcRenderer.send("mcp-response", result);
    });
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("downdraft", api);
} else {
  (globalThis as any).downdraft = api;
}
