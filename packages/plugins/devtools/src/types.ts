// ============================================================================
// DevTools type interfaces — contracts between the base inspector, games,
// and the DevTools extension panels.
// ============================================================================

import type { GizmoMode } from "./index.ts";
import type { ModelData } from "@downdraft/plugin-models";

/** Minimal renderer interface that BaseSceneInspector requires. */
export interface IDevToolsRenderer {
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
  setHitboxLineWidth(width: number): void;
  getHitboxLineWidth(): number;
  setDebugMode(enabled: boolean): void;

  // GPU / telemetry
  getGPUInfo(): any;
  getGPUErrors(): any[];
  clearGPUErrors(): void;
  getFrameTelemetry(): any;
  getGPUResourceTracker(): { getStats(): any } | null;
  getTelemetryCollector(): { getPassTimings(): any[]; saveSnapshot(label: string): any; getSnapshots(): any[]; clearSnapshots(): void } | null;
  getGPUProfiler(): { getPassTimings(): any[] } | null;
  getFrameGraph(): any | null;
  getFPS(): number;
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

/** Combined provider interface that games implement for game-specific devtools features. */
export interface IGameDevToolsExtension {
  assetResolver?: IAssetResolver;
  debugOverlayProvider?: IDebugOverlayProvider;
  debugModeProvider?: IDebugModeProvider;
  performanceMetricsProvider?: IPerformanceMetricsProvider;
  tabProvider?: IGameDevToolsProvider;
}
