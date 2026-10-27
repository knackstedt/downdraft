// ============================================================================
// @downdraft/engine/app/shared/types — host ↔ engine contract types
// ============================================================================
//
// These interfaces describe the `HostAPI` contract: the object the host
// installs on `globalThis.downdraft` (native bridge — see
// @downdraft/platform-native) and that renderer/bootstrap code consumes
// through the typed `downdraft` accessor. There is no process boundary on
// native — every method is a direct in-process call.
//
// These are type-only — no runtime code — so importing them from any
// context (host / renderer / worker) is safe.

import type { FeatureLogData, HostCapabilities, ISaveStore } from "@downdraft/engine";
import type {
    WebUiEvent,
    WebUiHostBridge,
    WebUiInputEvent,
    WebUiViewConfig,
    WebUiViewStatus,
} from "@downdraft/engine/libraries/webui/types";
import type {
    AtlasLayout,
    AtlasPanelRect,
    OSRInputEvent,
    OSRPanelConfig,
    OSRRendererConfig,
    OSRRendererEvent,
} from "@downdraft/engine/modules/native-osr";
export type { FeatureLogData };

// ---------------------------------------------------------------------------
// OSR (Offscreen Rendering) — re-exported from the plugin for convenience
// ---------------------------------------------------------------------------

    export type {
        AtlasLayout,
        AtlasPanelRect,
        OSRInputEvent,
        OSRPanelConfig,
        OSRRendererConfig,
        OSRRendererEvent
    };

/** Layout data delivered by `HostOsrAPI.onPanelLayout`. */
export type OSRPanelLayout = AtlasLayout;

// ---------------------------------------------------------------------------
// GPU Info
// ---------------------------------------------------------------------------

/** Response from `nvidia-smi` query (host system probe — runtime-agnostic). */
export interface GPUSystemInfo {
  gpus: Array<Record<string, string | number>>;
  processes: Array<{
    pid: number;
    processName: string;
    usedMemoryMB: number;
  }>;
  source: "nvidia-smi";
  timestamp: number;
}

/** Host GPU adapter identity + negotiated device features.
 *  On native this is the wgpu adapter info + the feature set the single
 *  host-owned device was created with. */
export interface HostGpuInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /** GPU backend label — e.g. "wgpu/vulkan", "wgpu/metal", "webgpu". */
  backend: string;
  /** Feature names enabled on the device (e.g. "timestamp-query"). */
  features: string[];
}

/** Response from the Vulkan validation status query (env-var probe —
 *  meaningful only on hosts where validation is switchable). */
export interface VulkanValidationStatus {
  enabled: boolean;
  envVar: string | null;
}

// ---------------------------------------------------------------------------
// Event Payloads (host -> engine)
// ---------------------------------------------------------------------------

/** Payload for the `sim-ready` event. */
export interface SimReadyData {
  isDev: boolean;
  deterministic: boolean;
}

/** Payload for the `display-info` event and `getDisplayInfo()` response. */
export interface DisplayInfoData {
  refreshRate: number;
}

/** Payload for the `display-metrics-changed` event. */
export interface DisplayMetricsChangedData {
  scaleFactor: number;
}

/** Payload for the `perf-stats` event (single-process host). */
export interface PerfStatsData {
  cpuPercent: number;
  memUsedMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  timestamp: number;
}

/** Typed host event names + payloads — the union behind the `on*` event
 *  methods. There is no free-form channel registry on the live contract. */
export interface HostEventMap {
  "sim-ready": SimReadyData;
  "display-info": DisplayInfoData;
  "display-metrics-changed": DisplayMetricsChangedData;
  "perf-stats": PerfStatsData;
  "debug-mode": boolean;
  "devtools-toggle": undefined;
  "theme-changed": HostTheme;
  /** A menu item was activated — payload is the item id. */
  "menu-action": string;
}

// ---------------------------------------------------------------------------
// Dialogs, notifications, theme (native host — optional on the contract)
// ---------------------------------------------------------------------------

export interface HostFileDialogOptions {
  title?: string;
  /** Starting directory. */
  directory?: string;
  /** Suggested filename (save dialog). */
  defaultName?: string;
  filters?: { name: string; extensions: string[] }[];
  /** Allow multiple selection (open/folder pickers). */
  multi?: boolean;
  /** Owning native-window handle for parenting — defaults to the primary. */
  window?: number;
}

export interface HostMessageBoxOptions {
  title?: string;
  message: string;
  level?: "info" | "warning" | "error";
  buttons?: "ok" | "okcancel" | "yesno" | "yesnocancel";
  window?: number;
}

export interface HostNotifyOptions {
  title: string;
  body?: string;
  /** Icon name or absolute path (platform-resolved). */
  icon?: string;
  appName?: string;
  /** Auto-dismiss timeout; platform-honored where supported. */
  timeoutMs?: number;
}

/** Effective system/window theme — "unknown" where the platform doesn't
 *  report it (e.g. X11 without a portal). */
export type HostTheme = "light" | "dark" | "unknown";

// ---------------------------------------------------------------------------
// Application menus (native where supported, html-ui in-window elsewhere)
// ---------------------------------------------------------------------------

/** Platform-predefined menu items — the OS supplies icon/label/behavior
 *  (e.g. macOS services, Win32 edit commands). */
export type AppMenuPredefinedKind =
  | "separator"
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "undo"
  | "redo"
  | "quit"
  | "about"
  | "minimize"
  | "maximize"
  | "closeWindow"
  | "fullscreen"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "services"
  | "bringAllToFront";

/** A single menu entry. `id` is required on "item"/"check" — it is what
 *  arrives back through onMenuAction. `accelerator` uses muda/electron
 *  syntax: "CmdOrCtrl+O", "Shift+Alt+F12", "CmdOrCtrl+Shift+Z". */
export type AppMenuItem =
  | {
      type?: "item";
      id: string;
      label: string;
      accelerator?: string;
      enabled?: boolean;
    }
  | {
      type: "check";
      id: string;
      label: string;
      checked?: boolean;
      accelerator?: string;
      enabled?: boolean;
    }
  | { type: "separator" }
  | { type: "predefined"; kind: AppMenuPredefinedKind; label?: string; id?: string }
  | {
      type: "submenu";
      id?: string;
      label: string;
      enabled?: boolean;
      items: AppMenuItem[];
    };

/** Top-level menu model — each item is typically a submenu (File/Edit/…).
 *  The same shape drives the native menu and the in-window fallback. */
export interface AppMenuModel {
  items: AppMenuItem[];
}

/** Where the menu actually rendered: "native" = OS menu (Windows HMENU,
 *  macOS NSMenu), "inwindow" = the app should render the html-ui kit
 *  MenuBar (Linux/Android, or DD_MENU=inwindow), "unavailable" = neither
 *  (no native lib, no symbols). */
export type AppMenuBackend = "native" | "inwindow" | "unavailable";

// ---------------------------------------------------------------------------
// System tray (optional — tray-icon backend: Windows/macOS native, Linux
// via StatusNotifierItem over DBus; absent on Android)
// ---------------------------------------------------------------------------

export interface AppTrayOptions {
    /** Icon file path (decoded to RGBA — PNG recommended). */
    icon?: string;
    /** macOS status-item title (shown beside the icon). */
    title?: string;
    tooltip?: string;
    /** Tray menu — the same AppMenuModel as setMenu; item ids surface on
     *  onMenuAction namespaced "tray:<id>" (and stripped via
     *  tray.onAction). */
    menu?: AppMenuModel;
    /** Show the menu on left click instead of right. */
    menuOnLeftClick?: boolean;
}

export interface AppTrayPointerEvent {
    kind: "click" | "doubleClick" | "enter" | "move" | "leave";
    button: "none" | "left" | "right" | "middle";
    /** Button down — meaningful for "click" events. */
    pressed: boolean;
    /** Screen coordinates. */
    x: number;
    y: number;
}

/** Process-wide system-tray icon (at most one — `create` replaces).
 *  Undefined on the bridge when the host has no tray backend. */
export interface AppTray {
    /** Create (or replace) the tray icon. False when no backend is
     *  available — Android, or a Linux session with no SNI watcher. */
    create(opts: AppTrayOptions): boolean;
    /** Swap the icon — empty path clears it. */
    setIcon(path: string): boolean;
    setTooltip(text: string): boolean;
    setMenu(model: AppMenuModel): boolean;
    destroy(): boolean;
    /** Pointer events on the icon — returns an unsubscribe fn. */
    onEvent(cb: (ev: AppTrayPointerEvent) => void): () => void;
    /** Tray menu activations — the item id with the "tray:" prefix
     *  stripped (the raw namespaced id also arrives via onMenuAction). */
    onAction(cb: (id: string) => void): () => void;
}

/** Payload delivered to the primary instance when a second process was
 *  refused the singleton lock — its arguments and working directory. */
export interface AppSecondInstanceData {
    argv: string[];
    cwd: string;
}

// ---------------------------------------------------------------------------
// App paths + settings (native host)
// ---------------------------------------------------------------------------

/** Per-app platform directories, split by artifact kind. Write settings/
 *  small state to configDir, saves + substantial app data to dataDir,
 *  disposable artifacts to cacheDir. */
export interface AppPaths {
    /** User config — Linux $XDG_CONFIG_HOME/<appId>, Windows %APPDATA%,
     *  macOS ~/Library/Application Support. Alias of the legacy userData
     *  dir. */
    configDir: string;
    /** App data (saves, databases) — Linux $XDG_DATA_HOME/<appId>. */
    dataDir: string;
    /** Disposable caches — Linux $XDG_CACHE_HOME/<appId>, Windows
     *  %LOCALAPPDATA%, macOS ~/Library/Caches. */
    cacheDir: string;
}

/** Typed key/value settings persisted to <configDir>/settings.json.
 *  Values are JSON-serializable; set(key, undefined) removes the key.
 *  watch() observes same-process set() calls only. */
export interface AppSettings {
    get<T = unknown>(key: string, fallback?: T): T;
    set(key: string, value: unknown): void;
    getAll(): Record<string, unknown>;
    /** Subscribe to same-process changes on `key` — the callback receives
     *  the new value (undefined after removal). Returns unsubscribe. */
    watch(key: string, cb: (value: unknown) => void): () => void;
    /** Force the debounced write to disk now. */
    flush(): void;
}

// ---------------------------------------------------------------------------
// MCP Proxy
// ---------------------------------------------------------------------------

export interface McpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Import Cache
// ---------------------------------------------------------------------------

export interface ImportCacheEntry {
  settings: unknown;
  sourceMtime: number;
  sidecarMtime: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Save Slots
// ---------------------------------------------------------------------------

export interface SaveSlotInfo {
  slot: string;
  timestamp: number;
  entityCount: number;
  playerCount: number;
  engineVersion: string;
  fileSize: number;
  currentGen: number;
  generationCount: number;
  hasThumbnail: boolean;
  properties?: Record<string, unknown>;
}

export interface SaveGenerationInfo {
  gen: number;
  timestamp: number;
  engineVersion: string;
  entityCount: number;
  playerCount: number;
  bodySize: number;
  blobCount: number;
}

export interface SaveOptions {
  maxGenerations?: number;
  thumbnail?: ArrayBuffer | Uint8Array;
  properties?: Record<string, unknown>;
  blobs?: Record<string, ArrayBuffer>;
}

export interface LoadOptions {
  gen?: number;
  includeBlobs?: boolean;
}

// ---------------------------------------------------------------------------
// Process stats (single native process)
// ---------------------------------------------------------------------------

export interface ProcessStatsData {
  timestamp: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  cpuUser: number;
  cpuSystem: number;
  uptimeSec: number;
}

// ---------------------------------------------------------------------------
// OSR host API (sub-object of HostAPI)
// ---------------------------------------------------------------------------

/** Host-side OSR surface — Blitz-backed native implementation. Panels render
 *  offscreen on the host; the engine pulls dirty RGBA frames + hit-tests
 *  directly (no shared-texture or paint-region machinery). */
export interface HostOsrAPI {
  createRenderer(config: OSRRendererConfig): Promise<void>;
  destroyRenderer(id: string): Promise<void>;
  addPanel(config: OSRPanelConfig): Promise<AtlasPanelRect | null>;
  removePanel(rendererId: string, panelId: string): Promise<AtlasLayout | null>;
  updatePanel(rendererId: string, panelId: string, html: string): Promise<void>;
  updateData(rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void;
  setContent(rendererId: string, html: string): Promise<void>;
  loadURL(rendererId: string, url: string): Promise<void>;
  sendInputEvent(rendererId: string, event: Omit<OSRInputEvent, "rendererId">): void;
  setSoftwareCursor(rendererId: string, enabled: boolean): void;
  onPanelLayout(cb: (rendererId: string, layout: OSRPanelLayout) => void): void;
  onRendererEvent(cb: (event: OSRRendererEvent) => void): void;
  onCursorStyle(cb: (rendererId: string, cursor: string) => void): void;

  // ── In-process frame pull (Blitz backend) ──
  /** Pull the renderer's dirty RGBA8 frame; null when clean or unknown. */
  pullFrame(rendererId: string): Uint8Array | null;
  /** Pixel-space dirty rect of the frame pullFrame just produced. */
  frameRect(rendererId: string): { x: number; y: number; w: number; h: number } | null;
  /** Renderer texture dimensions in physical px. */
  getDimensions(rendererId: string): { width: number; height: number } | null;
  /** Hit-test against `data-ui` elements in the Blitz document. */
  hitTest(rendererId: string, x: number, y: number): boolean;
}

// ---------------------------------------------------------------------------
// WebUI host API (sub-object of HostAPI)
// ---------------------------------------------------------------------------

export type {
    WebUiEvent,
    WebUiInputEvent,
    WebUiViewConfig,
    WebUiViewStatus
};

/** Host-side heavyweight-browser surface — one `dd_webui_*` backend bound
 *  per HostAPI (resolved via createWebUi opts > DD_WEBUI_BACKEND > config >
 *  CLI flag > platform default). CEF on desktop, WPE on android; linux can
 *  host either. Absent the cdylib, `downdraft.webui` is simply undefined —
 *  apps gate on its presence. Shape lives in
 *  libraries/webui/src/types.ts (WebUiHostBridge). */
export type HostWebUIAPI = WebUiHostBridge;

// ---------------------------------------------------------------------------
// HostAPI — the object installed on `globalThis.downdraft`
// ---------------------------------------------------------------------------

export interface HostAPI {
  /** Host feature descriptor — what this host can actually do. Apps should
   *  gate on `getHostCapabilities()` (which prefers this field and falls
   *  back to runtime detection) rather than probing globals. */
  readonly capabilities?: HostCapabilities;
  /** Typed host save store — present on the native host. Carries real
   *  SaveState/LoadResult with no JSON boundary; the saveAppState/
   *  loadAppState methods below are the JSON-string compatibility surface
   *  for hosts without a typed store. */
  readonly saveStore?: ISaveStore;
  saveAppState(slotName: string, stateJson: string, opts?: SaveOptions): Promise<boolean>;
  loadAppState(slotName: string, opts?: LoadOptions): Promise<string | null>;
  deleteAppState(slotName: string): Promise<boolean>;
  listSaveSlots(): Promise<SaveSlotInfo[]>;
  listSaveGenerations(slotName: string): Promise<SaveGenerationInfo[]>;
  deleteSaveGeneration(slotName: string, gen: number): Promise<boolean>;
  setThumbnail(slotName: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  getThumbnail(slotName: string): Promise<ArrayBuffer | null>;
  setSaveProperties(slotName: string, props: Record<string, unknown>): Promise<void>;
  getSaveProperties(slotName: string): Promise<Record<string, unknown>>;
  quit(): Promise<void>;
  /** Request a full host restart for unrecoverable failures (device loss,
   *  resetSim, HMR fallback). Native: detached self-respawn with a restart
   *  budget; DOM hosts may leave this unimplemented — callers fall back to
   *  `window.location.reload()`. Returns false when refused. */
  requestRestart?(reason: string): boolean;
  setDebugMode(enabled: boolean): void;
  toggleDevtools(): void;
  toggleFullscreen(): void;
  getDisplayInfo(): Promise<DisplayInfoData>;
  openExternal(url: string): void;

  // ── Dialogs, notifications, theme (optional — native host provides them;
  //  other hosts omit the methods; callers gate on presence or null). ──
  /** File-open picker — selected paths, or null on cancel/error. */
  showOpenDialog?(opts?: HostFileDialogOptions): Promise<string[] | null>;
  /** Save picker — the chosen path, or null on cancel/error. */
  showSaveDialog?(opts?: HostFileDialogOptions): Promise<string | null>;
  /** Directory picker — selected paths, or null on cancel/error. */
  pickFolder?(opts?: HostFileDialogOptions): Promise<string[] | null>;
  /** Modal message box — resolves to the pressed-button index
   *  (0 = Ok/Yes, 1 = No/Cancel, 2 = Cancel for yes-no-cancel). */
  showMessageBox?(opts: HostMessageBoxOptions): Promise<number>;
  /** OS notification — resolves false when the host can't post one. */
  notify?(opts: HostNotifyOptions): Promise<boolean>;
  /** Effective system/window theme. */
  getTheme?(): HostTheme;
  /** Theme-change subscription — returns an unsubscribe fn. */
  onThemeChanged?(cb: (theme: HostTheme) => void): () => void;

  // ── Application menu (optional — native where supported; the return
  //  tells the caller which backend is in effect). ──
  /** Install/replace the app menu — null removes it. Returns the backend
   *  in effect; "inwindow" means render the html-ui kit MenuBar yourself. */
  setMenu?(model: AppMenuModel | null): AppMenuBackend;
  /** Toggle an item's enabled state (native menus; in-window the app
   *  re-renders). No-op when the id/menu is unknown. */
  setMenuItemEnabled?(id: string, enabled: boolean): void;
  /** Toggle a check item's state — same contract as setMenuItemEnabled. */
  setMenuItemChecked?(id: string, checked: boolean): void;
  /** Context menu at physical client coords on the primary window.
   *  Returns false when the platform lacks native popups (render the
   *  html-ui PopupMenu fallback instead). */
  showContextMenu?(x: number, y: number, model: AppMenuModel): boolean;
  /** Menu activation — the activated item's id, native or fallback. Tray
   *  item ids arrive namespaced "tray:<id>". */
  onMenuAction?(cb: (id: string) => void): () => void;

  /** System-tray icon API — undefined where the host has no tray backend
   *  (non-native hosts, Android). `tray.create` may still return false on
   *  desktops without an SNI watcher. */
  tray?: AppTray;

  /** A second instance was refused the singleton lock and forwarded its
   *  launch context — default host behavior focuses the primary window
   *  first unless `runNativeAppModule({ focusOnSecondInstance: false })`
   *  opted out. */
  onSecondInstance?(cb: (data: AppSecondInstanceData) => void): () => void;

  /** Per-app platform directories — settings go in configDir, saves in
   *  dataDir, disposable artifacts in cacheDir. */
  paths?: AppPaths;
  /** Typed key/value settings persisted to <configDir>/settings.json —
   *  same-process watch(), atomic writes. */
  settings?: AppSettings;

  /** Host system GPU probe (nvidia-smi); null when unavailable. */
  getGPUSystemInfo(): Promise<GPUSystemInfo | null>;
  /** GPU adapter identity + negotiated features (wgpu on native). */
  getGpuInfo(): Promise<HostGpuInfo | null>;
  /** Fetch the host's feature log (for the combined DevTools/MCP view). */
  getFeatureLog(): Promise<FeatureLogData | null>;
  /** Capture the composited frame (swapchain + overlay layers) as a PNG
   *  buffer. Returns null if the window is gone or the capture is empty. */
  captureFrame(): Promise<ArrayBuffer | null>;
  /** Single-process memory/CPU snapshot. */
  getProcessStats(): Promise<ProcessStatsData>;

  importCacheGet(modelPath: string): Promise<ImportCacheEntry | null>;
  importCacheSet(modelPath: string, entry: ImportCacheEntry): Promise<void>;
  importCacheInvalidate(modelPath: string): Promise<void>;

  // ── Typed events (see HostEventMap). Each returns an unsubscribe fn. ──
  onSimReady(cb: (data: SimReadyData) => void): () => void;
  onDisplayInfo(cb: (data: DisplayInfoData) => void): () => void;
  onDisplayMetricsChanged(cb: (data: DisplayMetricsChangedData) => void): () => void;
  onPerfStats(cb: (data: PerfStatsData) => void): () => void;
  /** Debug-mode intent relayed by `setDebugMode` — subscribe to react. */
  onDebugMode(cb: (enabled: boolean) => void): () => void;
  /** DevTools-toggle intent relayed by `toggleDevtools`. */
  onDevtoolsToggle(cb: () => void): () => void;

  osr: HostOsrAPI;
  /** Heavyweight real-browser UI (CEF/WPE). Undefined when no backend
   *  cdylib is staged or DD_WEBUI_BACKEND=none — gate on presence. */
  webui?: HostWebUIAPI;
  /** Native raw mouse capture (pointer lock polyfill). Undefined when the feature is disabled. */
  rawInput?: HostRawInputAPI;
  deterministic: boolean;
  onMcpRequest(cb: (request: McpRequest) => Promise<McpResponse>): void;
}

// ---------------------------------------------------------------------------
// Raw Input host API (sub-object of HostAPI)
// ---------------------------------------------------------------------------

/** Status returned by the native raw input addon. */
export interface RawInputStatus {
  platform: "x11" | "wayland" | "win32" | "macos" | "unsupported";
  capturing: boolean;
  detail: string;
}

export interface HostRawInputAPI {
  /** Begin raw mouse capture (called by the polyfill on requestPointerLock). */
  start(): Promise<RawInputStatus>;
  /** Stop raw mouse capture (called by the polyfill on exitPointerLock). */
  stop(): Promise<void>;
  /** Set the OS cursor visibility. */
  setCursorVisible(visible: boolean): Promise<void>;
  /** Register a callback for raw mouse deltas (dx, dy in pixels). */
  onDelta(cb: (dx: number, dy: number) => void): void;
  /** Register a callback for when capture stops unexpectedly (e.g. window lost focus). */
  onStopped(cb: () => void): void;
}
