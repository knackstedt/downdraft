// ============================================================================
// IPC Channels — shared channel names for the engine shell (main <-> renderer)
//
// Single source of truth for both @downdraft/app (handlers/preload) and
// @downdraft/module-* packages that emit channels (raw-input, electron-osr).
// ============================================================================

export const IPC = {
  // Renderer -> Main
  SAVE_GAME_STATE: "save-game-state",
  LOAD_GAME_STATE: "load-game-state",
  DELETE_GAME_STATE: "delete-game-state",
  LIST_SAVE_SLOTS: "list-save-slots",
  LIST_SAVE_GENERATIONS: "list-save-generations",
  DELETE_SAVE_GENERATION: "delete-save-generation",
  SET_THUMBNAIL: "set-thumbnail",
  GET_THUMBNAIL: "get-thumbnail",
  SET_SAVE_PROPERTIES: "set-save-properties",
  GET_SAVE_PROPERTIES: "get-save-properties",
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
  FEATURE_LOG: "feature-log",
  OPEN_CHROME_URL: "open-chrome-url",

  // Screenshot — Renderer -> Main (captures full page: canvas + DOM overlay)
  CAPTURE_PAGE: "capture-page",

  // Tracing & memory-dump toolkit — Renderer -> Main (invoke)
  TRACE_START: "trace-start",
  TRACE_STOP: "trace-stop",
  TRACE_STATUS: "trace-status",
  TRACE_CATEGORIES: "trace-categories",
  HEAP_SNAPSHOT: "heap-snapshot",
  PROCESS_SNAPSHOT: "process-snapshot",

  // MCP proxy (Main <-> Renderer)
  MCP_REQUEST: "mcp-request",

  // OSR (Offscreen Rendering) — Renderer -> Main
  OSR_CREATE_RENDERER: "osr-create-renderer",
  OSR_DESTROY_RENDERER: "osr-destroy-renderer",
  OSR_ADD_PANEL: "osr-add-panel",
  OSR_REMOVE_PANEL: "osr-remove-panel",
  OSR_UPDATE_PANEL: "osr-update-panel",
  OSR_UPDATE_DATA: "osr-update-data",
  OSR_SET_CONTENT: "osr-set-content",
  OSR_LOAD_URL: "osr-load-url",
  OSR_INPUT_EVENT: "osr-input-event",
  OSR_SET_SOFTWARE_CURSOR: "osr-set-software-cursor",

  // OSR — Main -> Renderer
  OSR_PANEL_LAYOUT: "osr-panel-layout",
  OSR_RENDERER_EVENT: "osr-renderer-event",
  OSR_CURSOR_STYLE: "osr-cursor-style",

  // Import cache (Main <-> Renderer) — caches resolved model import settings
  IMPORT_CACHE_GET: "import-cache-get",
  IMPORT_CACHE_SET: "import-cache-set",
  IMPORT_CACHE_INVALIDATE: "import-cache-invalidate",

  // Raw Input (native raw mouse capture) — Renderer -> Main
  RAW_INPUT_START: "raw-input-start",
  RAW_INPUT_STOP: "raw-input-stop",
  RAW_INPUT_CURSOR_VISIBLE: "raw-input-cursor-visible",

  // Raw Input — Main -> Renderer (sent directly via webContents.send)
  RAW_INPUT_DELTA: "raw-input:delta",
  RAW_INPUT_STOPPED: "raw-input:stopped",

  // Main -> Renderer
  SIM_READY: "sim-ready",
  DISPLAY_INFO: "display-info",
  DISPLAY_METRICS_CHANGED: "display-metrics-changed",
  GC_STATS: "gc-stats",
  PERF_STATS: "perf-stats",
} as const;
