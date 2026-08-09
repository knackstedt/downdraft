// ============================================================================
// @downdraft/app/shared/types — IPC payload interfaces shared across processes
// ============================================================================
//
// These interfaces describe the shape of data that flows through the preload
// bridge, IPC handlers, and renderer accessor.  They are type-only — no runtime
// code — so importing them from any process (main / preload / renderer) is safe.

import type {
  AtlasLayout,
  AtlasPanelRect,
  OSRInputEvent,
  OSRPanelConfig,
  OSRRendererConfig,
  OSRRendererEvent,
} from "@downdraft/plugin-electron-osr";

// ---------------------------------------------------------------------------
// OSR (Offscreen Rendering) — re-exported from the plugin for convenience
// ---------------------------------------------------------------------------

export type {
  AtlasLayout,
  AtlasPanelRect,
  OSRInputEvent,
  OSRPanelConfig,
  OSRRendererConfig,
  OSRRendererEvent,
};

/** Layout data sent via the `OSR_PANEL_LAYOUT` IPC event. */
export type OSRPanelLayout = AtlasLayout;

// ---------------------------------------------------------------------------
// GPU Info
// ---------------------------------------------------------------------------

/** Response from `nvidia-smi` query (GPU_SYSTEM_INFO channel). */
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

/** Response from `app.getGPUInfo("complete")` (ELECTRON_GPU_INFO channel). */
export interface ElectronGPUInfo {
  gpuVendor: string;
  gpuDevice: string;
  gpuDriver: string;
  gpuDriverVersion: string;
  gpuActive: unknown;
  auxAttributes: unknown;
  featureStatus: unknown;
  source: "electron app.getGPUInfo";
}

/** Response from the Vulkan validation status query. */
export interface VulkanValidationStatus {
  enabled: boolean;
  envVar: string | null;
}

/** Union of all GPU info response shapes. */
export type GPUInfoResponse = GPUSystemInfo | ElectronGPUInfo | VulkanValidationStatus;

// ---------------------------------------------------------------------------
// Event Payloads (Main -> Renderer)
// ---------------------------------------------------------------------------

/** Payload for the `SIM_READY` event. */
export interface SimReadyData {
  isDev: boolean;
  deterministic: boolean;
}

/** Payload for the `GC_STATS` event. */
export interface GCStatsData {
  label: string;
  interval: {
    count: number;
    totalTime: number;
    scavengeCount: number;
    scavengeTime: number;
    majorCount: number;
    majorTime: number;
    otherCount: number;
    otherTime: number;
  };
  overall: {
    count: number;
    totalTime: number;
    wallMs: number;
  };
}

/** Payload for the `DISPLAY_INFO` event and `getDisplayInfo()` response. */
export interface DisplayInfoData {
  refreshRate: number;
}

/** Payload for the `DISPLAY_METRICS_CHANGED` event. */
export interface DisplayMetricsChangedData {
  scaleFactor: number;
}

/** Payload for the `PERF_STATS` event. */
export interface PerfStatsData {
  process: string;
  cpuPercent: number;
  memUsedMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Paint Region (CPU fallback for OSR)
// ---------------------------------------------------------------------------

/** Region data sent via the `__osr_paint_region` IPC event. */
export interface PaintRegionData {
  x: number;
  y: number;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  data: ArrayBuffer;
  compressed: boolean;
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
}

// ---------------------------------------------------------------------------
// Shared Texture (Electron internal — minimal typing with type guards)
// ---------------------------------------------------------------------------

/** Minimal interface for an imported shared texture (Electron internal). */
export interface ImportedSharedTexture {
  getVideoFrame(): VideoFrameLike | null;
  getFrameCreationSyncToken?(): unknown;
  release(cb: () => void): void;
  setReleaseSyncToken?(syncToken: unknown): void;
}

/** Minimal VideoFrame shape used by the shared texture receiver. */
export interface VideoFrameLike {
  displayWidth: number;
  displayHeight: number;
  format: string;
}

/** Minimal interface for the `electron.sharedTexture` subtle API. */
export interface SharedTextureSubtle {
  finishTransferSharedTexture(transfer: unknown): ImportedSharedTexture;
  importSharedTexture?(texture: unknown): ImportedSharedTexture;
}

/** Minimal interface for the `electron.sharedTexture` API. */
export interface SharedTextureApi {
  subtle?: SharedTextureSubtle;
  setSharedTextureReceiver?(cb: (received: unknown, ...args: unknown[]) => void): void;
}

// ---------------------------------------------------------------------------
// OSR Bridge API (sub-object of DowndraftBridgeAPI)
// ---------------------------------------------------------------------------

export interface DowndraftOsrBridgeAPI {
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
  registerSharedTextureReceiver(): boolean;
  onPaintImage(cb: (rendererId: string, image: unknown) => void): void;
  onPaintRegion(cb: (rendererId: string, region: PaintRegionData) => void): void;
  createPaintPort(rendererId: string): void;
}

// ---------------------------------------------------------------------------
// Full Bridge API — the shape returned by `createDefaultBridge()`
// ---------------------------------------------------------------------------

export interface DowndraftBridgeAPI {
  saveGameState(slotName: string, stateJson: string): Promise<boolean>;
  loadGameState(slotName: string): Promise<string | null>;
  deleteGameState(slotName: string): Promise<boolean>;
  listSaveSlots(): Promise<SaveSlotInfo[]>;
  quit(): Promise<void>;
  setDebugMode(enabled: boolean): void;
  toggleDevtools(): void;
  toggleFullscreen(): void;
  getDisplayInfo(): Promise<DisplayInfoData>;
  openExternal(url: string): void;
  getGPUSystemInfo(): Promise<GPUSystemInfo | null>;
  getElectronGPUInfo(): Promise<ElectronGPUInfo | null>;
  getVulkanValidationStatus(): Promise<VulkanValidationStatus>;
  openChromeUrl(url: string): void;
  importCacheGet(modelPath: string): Promise<ImportCacheEntry | null>;
  importCacheSet(modelPath: string, entry: ImportCacheEntry): Promise<void>;
  importCacheInvalidate(modelPath: string): Promise<void>;
  onSimReady(cb: (data: SimReadyData) => void): void;
  onDisplayInfo(cb: (data: DisplayInfoData) => void): void;
  onDisplayMetricsChanged(cb: (data: DisplayMetricsChangedData) => void): void;
  onGCStats(cb: (data: GCStatsData) => void): void;
  onPerfStats(cb: (data: PerfStatsData) => void): void;
  osr: DowndraftOsrBridgeAPI;
  removeAllListeners(channel: string): void;
  log(level: string, message: string): void;
  deterministic: boolean;
  onMcpRequest(cb: (request: McpRequest) => Promise<McpResponse>): void;
}
