// ============================================================================
// DevTools type interfaces — contracts between the base inspector, games,
// and the DevTools extension panels.
// ============================================================================

import type { GizmoMode } from "./index";

/** Minimal renderer interface for data feeds (perf, GC, GPU, telemetry).
 *  Used by DevToolsDataBridge — games that don't need the full scene inspector
 *  can pass an adapter implementing only these methods. Only getFPS() is
 *  required; all other methods are optional and accessed via optional chaining. */
export interface IDevToolsDataRenderer {
  getFPS(): number;
  // All optional — null/undefined = "not available" in the panel
  getGPUInfo?(): any;
  getGPUErrors?(): any[];
  clearGPUErrors?(): void;
  getFrameTelemetry?(): any;
  getGPUResourceTracker?(): { getStats(): any } | null;
  getTelemetryCollector?(): { getPassTimings(): any[]; saveSnapshot(label: string): any; getSnapshots(): any[]; clearSnapshots(): void } | null;
  getGPUProfiler?(): { getPassTimings(): any[] } | null;
  getFrameGraph?(): any | null;
  setDebugMode?(enabled: boolean): void;
  getGCStats?(): any;
  setGCConfig?(config: any): void;
  forceMajorGC?(): void;
}

/** Full renderer interface for the scene inspector (extends data renderer).
 *  Used by BaseSceneInspector — games that want the full 3D scene inspector
 *  pass a renderer implementing all of these methods. */
export interface IDevToolsRenderer extends IDevToolsDataRenderer {
  // Gizmo
  setGizmoPosition(pos: [number, number, number]): void;
  setGizmoMode(mode: GizmoMode): void;
  setGizmoVisible(visible: boolean): void;

  // Models
  uploadModel(nodeId: string, meshes: any[], materials?: any[]): void;
  removeModel(nodeId: string): void;

  // Player
  getPlayerWorldPos(viewportIdx: number): { x: number; y: number; z: number } | null;

  // Debug overlays (hitboxes are generic)
  setShowHitboxes(show: boolean): void;
  getShowHitboxes(): boolean;
  setHitboxLineWidth(width: number): void;
  getHitboxLineWidth(): number;
  setDebugMode(enabled: boolean): void;

  // GPU / telemetry (required for full inspector; optional on IDevToolsDataRenderer)
  getGPUInfo(): any;
  getGPUErrors(): any[];
  clearGPUErrors(): void;
  getFrameTelemetry(): any;
  getGPUResourceTracker(): { getStats(): any } | null;
  getTelemetryCollector(): { getPassTimings(): any[]; saveSnapshot(label: string): any; getSnapshots(): any[]; clearSnapshots(): void } | null;
  getGPUProfiler(): { getPassTimings(): any[] } | null;
  getFrameGraph(): any | null;
}

/** Asset resolution — games provide this to support model import/thumbnails. */
export interface IAssetResolver {
  getAvailableModels(): { path: string; name: string; format: string; url: string }[];
  syncFetchArrayBuffer(url: string): ArrayBuffer | null;
  findMTLForOBJ(filename: string, buffer: ArrayBuffer): ArrayBuffer | null;
  findBinForGLTF(filename: string, buffer: ArrayBuffer): ArrayBuffer | null;
  getTextureUrl(uri: string): string | null;
}

/** Optional debug overlay toggles — games that support chunk grid / velocity arrows implement this. */
export interface IDebugOverlayProvider {
  setShowChunkGrid(show: boolean): void;
  getShowChunkGrid(): boolean;
  setShowVelocityArrows(show: boolean): void;
  getShowVelocityArrows(): boolean;
}

/** Optional sim/worker debug mode hook — games with a sim worker implement this. */
export interface IDebugModeProvider {
  setDebugMode(enabled: boolean): void;
  /** Forward GC controller config to the sim worker. Optional. */
  setGCConfig?(config: any): void;
  /** Trigger a major GC on the sim worker. Optional. */
  forceMajorGC?(): void;
}

/** Optional performance metrics provider — games with multi-process architectures implement this. */
export interface IPerformanceMetricsProvider {
  getPerformanceMetrics(): any;
}

/** Game-specific tab provider — games register custom DevTools tabs via this interface. */
export interface IGameDevToolsProvider {
  getTabs(): GameDevToolsTab[];
}

export interface GameDevToolsTab {
  id: string;
  label: string;
  onActivate(container: HTMLElement): void;
  onDeactivate(): void;
}

/**
 * Game-specific DevTools panel extension.
 * Games declare tabs with HTML content, CSS, and a JS script that runs
 * in the DevTools panel context. The script receives DevToolsPanel helpers
 * and returns lifecycle callbacks.
 */
export interface IDevToolsPanelExtension {
  /** Unique id for this extension (e.g. "debug-info", "boat-layout"). */
  id: string;
  /** Tab label shown in the tab bar. */
  tabLabel: string;
  /** Tab tooltip. */
  tabTooltip?: string;
  /** Order/priority for tab placement. Core tabs: 0-100, game tabs: 100+. Default: 100. */
  order?: number;
  /** __sceneInspector methods that must exist for this tab to be shown. */
  requiredMethods?: string[];
  /** HTML content for the panel body (inserted into a container div). */
  html: string;
  /** CSS to inject into the panel document. */
  css?: string;
  /**
   * JS to eval in the panel context. Receives a DevToolsPanelHelpers object
   * and returns { onActivate?, onDeactivate?, onRefresh?, onDestroy? }.
   */
  script?: string;
}

/**
 * Game-specific overlay toggle for the overlays dropdown menu.
 */
export interface IDevToolsOverlayToggle {
  /** Unique id (e.g. "chunk-grid", "vel-arrows"). */
  id: string;
  /** Label shown next to the checkbox. */
  label: string;
  /** __sceneInspector methods that must exist for this toggle to be shown. */
  requiredMethods?: string[];
  /**
   * JS to eval in the panel context. Receives DevToolsPanelHelpers.
   * Should set up a checkbox listener on #chk-{id} that calls callInspector.
   */
  script?: string;
}

// --- Debug Overlay Data Providers ---

/** Provides entity data for the 2D debug overlay (chunk grid + velocity arrows). */
export interface IDebugOverlayData {
  getEntityCount(): number;
  getEntityPosition(i: number): { x: number; y: number; z: number } | null;
  getEntityVelocity(i: number): { x: number; y: number; z: number } | null;
  getPlayerPosition(): { x: number; z: number } | null;
  getChunkGridConfig(): { chunkSize: number; chunksVisible: number };
}

/** Provides camera state for debug overlays. */
export interface IDebugCamera {
  position: [number, number, number];
  heading: number;
  pitch: number;
  fov: number;
  aspect: number;
  near: number;
  far: number;
}

// --- Debug Raycast Providers ---

/** Result of a raycast against entities. */
export interface IRaycastResult {
  entityIndex: number;
  entityId: number;
  entityType: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  distance: number;
  posX: number;
  posY: number;
  posZ: number;
  scale: number;
}

/** Provides entity raycast queries for the debug ray visualizer. */
export interface IRaycastProvider {
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): IRaycastResult | null;
}

// --- Label Overlay Providers ---

/** A single label entry for the HTML label overlay. */
export interface ILabelEntry {
  key: string;
  text: string;
  color: string;
  x: number;
  y: number;
  z: number;
}

/** Provides label data for the HTML label overlay. */
export interface ILabelProvider {
  getLabels(): ILabelEntry[];
}

// --- Scene Sync Providers ---

/** Entity snapshot for scene store sync. */
export interface ISceneEntitySnapshot {
  id: number;
  type: number;
  typeName: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: number;
}

/** Provides entity snapshots and player camera for scene sync + gizmo interaction. */
export interface ISceneSyncProvider {
  getEntitySnapshots(): ISceneEntitySnapshot[];
  getPlayerCamera(): {
    position: { x: number; y: number; z: number };
    heading: number;
    pitch: number;
    cameraMode: number;
  } | null;
}

// --- Asset Utility Providers ---

/** Provides model/texture/bin URL maps for asset resolution. */
export interface IAssetUrlMaps {
  textureUrlMap: Map<string, string>;
  mtlUrlMap: Map<string, string>;
  binUrlMap: Map<string, string>;
}

/** Combined provider interface that games implement for game-specific devtools features. */
export interface IGameDevToolsExtension {
  assetResolver?: IAssetResolver;
  debugOverlayProvider?: IDebugOverlayProvider;
  debugModeProvider?: IDebugModeProvider;
  performanceMetricsProvider?: IPerformanceMetricsProvider;
  tabProvider?: IGameDevToolsProvider;
}
