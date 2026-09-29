// DORMANT (Electron): the old IPC-shaped preload-bridge contract.
//
// This file preserves the Electron `DowndraftBridgeAPI` surface purely so the
// dormant preload/main/mobile trees keep typechecking until the dormant-tree
// deletion lands. Live code must use `HostAPI` from ./types.ts instead — do
// not import from this file outside the dormant Electron paths.

import type { FeatureLogData, HostCapabilities, ISaveStore } from "@downdraft/engine";
import type {
    AtlasLayout,
    AtlasPanelRect,
    OSRInputEvent,
    OSRPanelConfig,
    OSRRendererConfig,
    OSRRendererEvent,
} from "@downdraft/engine/modules/native-osr";
import type {
    DisplayInfoData,
    DisplayMetricsChangedData,
    GPUSystemInfo,
    HostRawInputAPI,
    ImportCacheEntry,
    LoadOptions,
    McpRequest,
    McpResponse,
    OSRPanelLayout,
    PerfStatsData,
    SaveGenerationInfo,
    SaveOptions,
    SaveSlotInfo,
    SimReadyData,
    VulkanValidationStatus
} from "./types";

export * from "./types";

// ---------------------------------------------------------------------------
// GPU Info (Electron shapes)
// ---------------------------------------------------------------------------

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

/** Union of all GPU info response shapes. */
export type GPUInfoResponse = GPUSystemInfo | ElectronGPUInfo | VulkanValidationStatus;

/** Payload for the `GC_STATS` event (V8 heap counters — Chromium only). */
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
// OSR Bridge API (Electron shape — shared texture + paint machinery)
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

  // Native in-process members (present on the Blitz backend).
  __nativeIsBlitz?: boolean;
  pullFrame?(rendererId: string): Uint8Array | null;
  frameRect?(rendererId: string): { x: number; y: number; w: number; h: number } | null;
  getDimensions?(rendererId: string): { width: number; height: number } | null;
  hitTest?(rendererId: string, x: number, y: number): boolean;
}

// ---------------------------------------------------------------------------
// Full Electron bridge contract — the shape the dormant preload returned
// ---------------------------------------------------------------------------

export interface DowndraftBridgeAPI {
  readonly capabilities?: HostCapabilities;
  readonly saveStore?: ISaveStore;
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
  getFeatureLog(): Promise<FeatureLogData | null>;
  openChromeUrl(url: string): void;
  capturePage(): Promise<ArrayBuffer | null>;

  startTrace(opts?: TraceStartOptions): Promise<TraceStartResult>;
  stopTrace(): Promise<TraceStopResult>;
  traceStatus(): Promise<TraceStatusResult>;
  traceCategories(): Promise<{ categories: string[] }>;
  captureHeapSnapshot(opts?: { target?: "main" | "renderer" }): Promise<HeapSnapshotResult>;
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
  rawInput?: DowndraftRawInputBridgeAPI;
  removeAllListeners(channel: string): void;
  log(level: string, message: string): void;
  deterministic: boolean;
  onMcpRequest(cb: (request: McpRequest) => Promise<McpResponse>): void;
}

export type DowndraftRawInputBridgeAPI = HostRawInputAPI;
