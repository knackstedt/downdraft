// ============================================================================
// Worker Message Protocol — generic IPC channels for engine shell
// ============================================================================

// --- IPC Channels (main <-> renderer) ---

export const IPC = {
  // Renderer -> Main
  SAVE_GAME_STATE: "save-game-state",
  LOAD_GAME_STATE: "load-game-state",
  RENDERER_LOG: "renderer-log",
  QUIT: "quit",
  DEBUG_MODE: "debug-mode",
  TOGGLE_DEVTOOLS: "toggle-devtools",
  TOGGLE_FULLSCREEN: "toggle-fullscreen",
  GET_DISPLAY_INFO: "get-display-info",
  OPEN_EXTERNAL: "open-external",
  GPU_SYSTEM_INFO: "gpu-system-info",
  ELECTRON_GPU_INFO: "electron-gpu-info",
  VULKAN_VALIDATION_STATUS: "vulkan-validation-status",
  OPEN_CHROME_URL: "open-chrome-url",

  // Main -> Renderer
  SIM_READY: "sim-ready",
  DISPLAY_INFO: "display-info",
  DISPLAY_METRICS_CHANGED: "display-metrics-changed",
  GC_STATS: "gc-stats",
  PERF_STATS: "perf-stats",
} as const;

// --- DB Helper ---

export interface DbRequest {
  id: number;
  type: string;
  [key: string]: unknown;
}

export interface DbResponse {
  id: number;
  type: string;
  result?: unknown;
  error?: string;
}

export function dbRequest(type: DbRequest["type"], payload: Partial<DbRequest> = {}): DbRequest {
  return {
    id: 0,
    type,
    ...payload,
  };
}

export function dbResponse(id: number, type: string, result?: unknown, error?: string): DbResponse {
  return { id, type, result, error };
}
