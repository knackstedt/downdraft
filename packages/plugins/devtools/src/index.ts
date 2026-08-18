export type GizmoMode = "translate" | "rotate" | "scale";
export { createTransformGizmoPlugin } from "./gizmo-plugin";
export type { TransformGizmoPluginOptions } from "./gizmo-plugin";
export { TransformGizmo } from "./transform-gizmo";
export type { GizmoHitPart } from "./transform-gizmo";

// Debug renderers (promoted from model-viewer)
export { GridRenderer } from "./grid-renderer";
export { HeightRulerRenderer } from "./height-ruler-renderer";
export { SkeletonRenderer } from "./skeleton-renderer";

// Scene & debug stores
export { useDebugStore } from "./debug-store";
export type { CollisionLogEntry } from "./debug-store";
export { useSceneStore } from "./scene-store";
export type { SceneNode, SceneTreeSnapshot, SimEntitySnapshot } from "./scene-store";

// Debug overlays (generic rendering, game provides data via interfaces)
export { DebugOverlay } from "./debug-overlay";
export { DebugRaycast } from "./debug-raycast";
export { LabelOverlay } from "./label-overlay";
export { SceneSync } from "./scene-sync";

// Asset utilities
export { asyncFetchArrayBuffer, bufferCache, evictThumbnailCache, findBinForGLTF, findMTLForOBJ, syncFetchArrayBuffer, thumbnailCache } from "./asset-utils";

// Data bridge (non-abstract, data-feeds only) & base inspector & interfaces
export { DevToolsDataBridge } from "./data-bridge";
export { BaseSceneInspector } from "./scene-inspector";
export { createSimStatsPanelExtension } from "./sim-stats-panel";
export type { SimStatsPanelOptions } from "./sim-stats-panel";
export type {
    GameDevToolsTab, IAssetResolver, IAssetUrlMaps, IDebugModeProvider, IDebugOverlayData, IDebugOverlayProvider, IDevToolsDataRenderer, IDevToolsOverlayToggle, IDevToolsPanelExtension, IDevToolsRenderer, IGameDevToolsExtension, IGameDevToolsProvider, ILabelEntry, ILabelProvider, IPerformanceMetricsProvider, IRaycastProvider, IRaycastResult, ISceneEntitySnapshot, ISceneSyncProvider, ISimStats, ISimStatsProvider
} from "./types";

