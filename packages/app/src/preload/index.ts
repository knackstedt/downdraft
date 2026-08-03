// ============================================================================
// Preload — context bridge between renderer and main process
// ============================================================================

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/messages";

const api = {
  saveGameState: (slotName: string, stateJson: string): Promise<boolean> => ipcRenderer.invoke(IPC.SAVE_GAME_STATE, slotName, stateJson),
  loadGameState: (slotName: string): Promise<string | null> => ipcRenderer.invoke(IPC.LOAD_GAME_STATE, slotName),

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
    sendInputEvent: (rendererId: string, event: any): void =>
      ipcRenderer.send(IPC.OSR_INPUT_EVENT, rendererId, event),
    onPanelLayout: (cb: (rendererId: string, layout: any) => void) =>
      ipcRenderer.on(IPC.OSR_PANEL_LAYOUT, (_e, rendererId, layout) => cb(rendererId, layout)),
    onRendererEvent: (cb: (event: any) => void) =>
      ipcRenderer.on(IPC.OSR_RENDERER_EVENT, (_e, event) => cb(event)),
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

contextBridge.exposeInMainWorld("downdraft", api);
