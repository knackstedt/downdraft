export type GizmoMode = "translate" | "rotate" | "scale";
export { TransformGizmo } from "./transform-gizmo.ts";
export type { GizmoHitPart } from "./transform-gizmo.ts";

// Scene & debug stores
export { useDebugStore } from "./debug-store.ts";
export type { CollisionLogEntry } from "./debug-store.ts";
export { useSceneStore } from "./scene-store.ts";
export type { SceneNode, SceneTreeSnapshot, SimEntitySnapshot } from "./scene-store.ts";

// Base inspector & interfaces
export { BaseSceneInspector } from "./scene-inspector.ts";
export type {
    GameDevToolsTab, IAssetResolver, IDebugModeProvider, IDebugOverlayProvider, IDevToolsRenderer, IGameDevToolsExtension, IGameDevToolsProvider, IPerformanceMetricsProvider
} from "./types.ts";

