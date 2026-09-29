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
// The Electron-shaped predecessor contract (`DowndraftBridgeAPI` plus the
// tracing/heap-snapshot/shared-texture types) lives in
// ./electron-bridge-types.ts — DORMANT, kept only so the dormant preload
// tree still typechecks until Phase 7 deletes it.
//
// These are type-only — no runtime code — so importing them from any
// context (main / preload / renderer / worker) is safe.

import type { FeatureLogData, HostCapabilities, ISaveStore } from "@downdraft/engine";
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

/** Payload for the `perf-stats` event (single-process — no process field). */
export interface PerfStatsData {
  /** Kept for payload compatibility with dormant emitters; always "native"
   *  on the live host. Ignored by consumers — Phase 6 removes it. */
  process?: string;
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
// Process stats (single process — replaces the Electron main/renderer split)
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
 *  directly (no shared-texture or paint-region machinery — that was the
 *  Electron path, kept on the dormant contract). */
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
// HostAPI — the object installed on `globalThis.downdraft`
// ---------------------------------------------------------------------------

export interface HostAPI {
  /** Host feature descriptor — what this host can actually do. Games should
   *  gate on `getHostCapabilities()` (which prefers this field and falls
   *  back to runtime detection) rather than probing globals. */
  readonly capabilities?: HostCapabilities;
  /** Typed host save store — present on the native host. Carries real
   *  SaveState/LoadResult with no JSON boundary; the saveGameState/
   *  loadGameState methods below are the JSON-string compatibility surface
   *  for hosts without a typed store. */
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
