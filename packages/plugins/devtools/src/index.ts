export type GizmoMode = "translate" | "rotate" | "scale";
export { TransformGizmo } from "./transform-gizmo";
export type { GizmoHitPart } from "./transform-gizmo";

// Scene & debug stores
export { useDebugStore } from "./debug-store";
export type { CollisionLogEntry } from "./debug-store";
export { useSceneStore } from "./scene-store";
export type { SceneNode, SceneTreeSnapshot, SimEntitySnapshot } from "./scene-store";

// Base inspector & interfaces
export { BaseSceneInspector } from "./scene-inspector";
export type {
    GameDevToolsTab, IAssetResolver, IDebugModeProvider, IDebugOverlayProvider, IDevToolsOverlayToggle, IDevToolsPanelExtension, IDevToolsRenderer, IGameDevToolsExtension, IGameDevToolsProvider, IPerformanceMetricsProvider
} from "./types";

