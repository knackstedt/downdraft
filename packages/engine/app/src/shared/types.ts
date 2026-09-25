// ============================================================================
// @downdraft/engine/app/shared/types — IPC payload interfaces shared across processes
// ============================================================================
//
// These interfaces describe the shape of data that flows through the preload
// bridge, IPC handlers, and renderer accessor.  They are type-only — no runtime
// code — so importing them from any process (main / preload / renderer) is safe.

import type { FeatureLogData } from "@downdraft/engine";
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
// Tracing & memory-dump toolkit (main process)
// ---------------------------------------------------------------------------

export type TracePreset = "perf" | "memory" | "gpu" | "v8" | "custom";

export interface TraceStartOptions {
  preset?: TracePreset;
  categories?: string[];
  recordingMode?: "record-until-full" | "record-continuously" | "record-as-much-as-possible" | "trace-to-console";
  bufferSizeKB?: number;
  memoryDumpIntervalMs?: number;
}

export interface TraceStartResult {
  started: boolean;
  preset: TracePreset;
  categories: string[];
  recordingMode: string;
}

export interface TraceStopResult {
  stopped: boolean;
  path: string;
  relativePath: string;
  downloadUrl: string;
  sizeBytes: number;
  durationMs: number;
  categories: string[];
  preset: TracePreset;
}

export interface TraceStatusResult {
  recording: boolean;
  startedAt?: number;
  preset?: TracePreset;
  categories?: string[];
  recordingMode?: string;
  bufferUsage?: { value: number; percentage: number };
}

export interface HeapSnapshotResult {
  path: string;
  relativePath: string;
  downloadUrl: string;
  sizeBytes: number;
  target: "main" | "renderer";
  chunks?: number;
}

export interface ProcessSnapshotResult {
  target: "main" | "renderer";
  timestamp: number;
  main?: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
    cpuUser: number;
    cpuSystem: number;
    uptimeSec: number;
  };
  renderer?: {
    metrics: Record<string, number>;
    domCounters?: Record<string, number>;
  };
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

  // ── Native-only in-process frame pull (Blitz backend) ──
  // Present only on the native host; absent under Electron. The renderer-side
  // NativeOSRManager uses these instead of the shared-texture/paint machinery.
  /** Marks the Blitz-backed native OSR implementation. */
  __nativeIsBlitz?: boolean;
  /** Pull the renderer's dirty RGBA8 frame; null when clean or unknown. */
  pullFrame?(rendererId: string): Uint8Array | null;
  /** Renderer texture dimensions in physical px. */
  getDimensions?(rendererId: string): { width: number; height: number } | null;
  /** Hit-test against `data-ui` elements in the Blitz document. */
  hitTest?(rendererId: string, x: number, y: number): boolean;
}

// ---------------------------------------------------------------------------
// Full Bridge API — the shape returned by `createDefaultBridge()`
// ---------------------------------------------------------------------------

export interface DowndraftBridgeAPI {
  saveGameState(slotName: string, stateJson: string, opts?: SaveOptions): Promise<boolean>;
  loadGameState(slotName: string, opts?: LoadOptions): Promise<string | null>;
  deleteGameState(slotName: string): Promise<boolean>;
  listSaveSlots(): Promise<SaveSlotInfo[]>;
  listSaveGenerations(slotName: string): Promise<SaveGenerationInfo[]>;
  deleteSaveGeneration(slotName: string, gen: number): Promise<boolean>;
  setThumbnail(slotName: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  getThumbnail(slotName: string): Promise<ArrayBuffer | null>;
  setSaveProperties(slotName: string, props: Record<string, unknown>): Promise<void>;
  getSaveProperties(slotName: string): Promise<Record<string, unknown>>;
  quit(): Promise<void>;
  setDebugMode(enabled: boolean): void;
  toggleDevtools(): void;
  toggleFullscreen(): void;
  getDisplayInfo(): Promise<DisplayInfoData>;
  openExternal(url: string): void;
  getGPUSystemInfo(): Promise<GPUSystemInfo | null>;
  getElectronGPUInfo(): Promise<ElectronGPUInfo | null>;
  getVulkanValidationStatus(): Promise<VulkanValidationStatus>;
  /** Fetch the cached main-process feature log (for the combined DevTools/MCP view). */
  getFeatureLog(): Promise<FeatureLogData | null>;
  openChromeUrl(url: string): void;
  /** Capture the full page (WebGPU canvas + DOM overlay) as a PNG buffer.
   *  Returns null if the window is gone or the capture is empty. */
  capturePage(): Promise<ArrayBuffer | null>;

  // --- Tracing & memory-dump toolkit (main process) ---
  /** Start a Chrome/Perfetto trace recording. */
  startTrace(opts?: TraceStartOptions): Promise<TraceStartResult>;
  /** Stop the current trace recording and write it to disk. */
  stopTrace(): Promise<TraceStopResult>;
  /** Get the current trace recording status. */
  traceStatus(): Promise<TraceStatusResult>;
  /** List available tracing category groups. */
  traceCategories(): Promise<{ categories: string[] }>;
  /** Capture a V8 heap snapshot (.heapsnapshot). */
  captureHeapSnapshot(opts?: { target?: "main" | "renderer" }): Promise<HeapSnapshotResult>;
  /** Capture a quick process memory/CPU snapshot. */
  processSnapshot(opts?: { target?: "main" | "renderer" }): Promise<ProcessSnapshotResult>;

  importCacheGet(modelPath: string): Promise<ImportCacheEntry | null>;
  importCacheSet(modelPath: string, entry: ImportCacheEntry): Promise<void>;
  importCacheInvalidate(modelPath: string): Promise<void>;
  onSimReady(cb: (data: SimReadyData) => void): void;
  onDisplayInfo(cb: (data: DisplayInfoData) => void): void;
  onDisplayMetricsChanged(cb: (data: DisplayMetricsChangedData) => void): void;
  onGCStats(cb: (data: GCStatsData) => void): void;
  onPerfStats(cb: (data: PerfStatsData) => void): void;
  osr: DowndraftOsrBridgeAPI;
  /** Native raw mouse capture (pointer lock polyfill). Undefined when the feature is disabled. */
  rawInput?: DowndraftRawInputBridgeAPI;
  removeAllListeners(channel: string): void;
  log(level: string, message: string): void;
  deterministic: boolean;
  onMcpRequest(cb: (request: McpRequest) => Promise<McpResponse>): void;
}

// ---------------------------------------------------------------------------
// Raw Input Bridge API (sub-object of DowndraftBridgeAPI)
// ---------------------------------------------------------------------------

/** Status returned by the native raw input addon. */
export interface RawInputStatus {
  platform: "x11" | "wayland" | "win32" | "macos" | "unsupported";
  capturing: boolean;
  detail: string;
}

export interface DowndraftRawInputBridgeAPI {
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
