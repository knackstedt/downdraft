// ============================================================================
// DevTools type interfaces — contracts between the base inspector, games,
// and the DevTools extension panels.
// ============================================================================

import type { GizmoMode } from "./index.ts";

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
  getShowHitboxes(): boolean;
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

/** Combined provider interface that games implement for game-specific devtools features. */
export interface IGameDevToolsExtension {
  assetResolver?: IAssetResolver;
  debugOverlayProvider?: IDebugOverlayProvider;
  debugModeProvider?: IDebugModeProvider;
  performanceMetricsProvider?: IPerformanceMetricsProvider;
  tabProvider?: IGameDevToolsProvider;
}
