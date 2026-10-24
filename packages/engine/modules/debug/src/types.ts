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

/** Optional debug draw toggles — games with GPU-side debug overlays
 *  (chunk grid, velocity arrows) implement this. Drives the game's own
 *  debug rendering, not a DOM overlay. */
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

// --- Debug Raycast Providers ---

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
}

// --- Sim Stats & Controls ---

/** Snapshot of simulation state for the DevTools "Sim" tab. */
export interface ISimStats {
  /** Sim ticks per second (worker-side, may differ from render FPS). */
  fps: number;
  /** Total tick count since sim start. */
  tick: number;
  /** Total frame count since sim start. */
  frame: number;
  /** Whether the sim is currently paused. */
  paused: boolean;
  /** Current speed multiplier (1.0 = normal). */
  speed: number;
  /** Game-specific extra rows (grid dims, entity count, player pos, etc.). */
  extra?: Record<string, any>;
}

/**
 * Provides sim stats and control methods for the DevTools "Sim" tab.
 * Any sim-driven game (2D or 3D) can implement this.
 */
export interface ISimStatsProvider {
  getSimStats(): ISimStats;
  pauseSim(): void;
  resumeSim(): void;
  /** Advance exactly one tick while paused. Optional. */
  stepSim?(): void;
  /** Set the sim speed multiplier (0 = paused-equivalent, 1 = normal). Optional. */
  setSimSpeed?(speed: number): void;
  /** Clear/reset the simulation state. Optional. */
  clearSim?(): void;
}
