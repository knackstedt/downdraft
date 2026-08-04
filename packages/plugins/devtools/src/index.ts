export type GizmoMode = "translate" | "rotate" | "scale";
export { TransformGizmo } from "./transform-gizmo";
export type { GizmoHitPart } from "./transform-gizmo";

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

// Base inspector & interfaces
export { BaseSceneInspector } from "./scene-inspector";
export type {
    GameDevToolsTab, IAssetResolver, IAssetUrlMaps, IDebugModeProvider, IDebugOverlayData, IDebugOverlayProvider, IDevToolsOverlayToggle, IDevToolsPanelExtension, IDevToolsRenderer, IGameDevToolsExtension, IGameDevToolsProvider, ILabelEntry, ILabelProvider, IPerformanceMetricsProvider, IRaycastProvider, IRaycastResult, ISceneEntitySnapshot, ISceneSyncProvider
} from "./types";

