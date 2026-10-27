export type GizmoMode = "translate" | "rotate" | "scale";
export { createTransformGizmoModule } from "./gizmo-module";
export type { TransformGizmoModuleOptions } from "./gizmo-module";
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

// Debug overlays (generic rendering, app provides data via interfaces)
export { DebugRaycast } from "./debug-raycast";
export { SceneSync } from "./scene-sync";

// Asset utilities
export { asyncFetchArrayBuffer, bufferCache, evictThumbnailCache, findBinForGLTF, findMTLForOBJ, syncFetchArrayBuffer, thumbnailCache } from "./asset-utils";

// Data bridge (non-abstract, data-feeds only) & base inspector & interfaces
export { DevToolsDataBridge } from "./data-bridge";
export { BaseSceneInspector } from "./scene-inspector";
export type {
    IAssetResolver, IAssetUrlMaps, IDebugModeProvider, IDebugOverlayProvider, IDevToolsDataRenderer, IDevToolsRenderer, IAppDevToolsExtension, IPerformanceMetricsProvider, IRaycastProvider, IRaycastResult, ISceneEntitySnapshot, ISceneSyncProvider, ISimStats, ISimStatsProvider
} from "./types";

// Unified DevTools API — single registration surface for plugins, apps, and
// engine systems. Auto-detects realm (main vs worker) and chooses transport.
export { allocateDevToolsSAB, computeDevToolsSABLayout, devtools, DEVTOOLS_REALM, DEVTOOLS_SAB_MAX_FEEDS } from "./api";
export type { DevToolsAPI, DevToolsManifest, DevToolsSABLayout, DevToolsSABStat } from "./api";

// Worker-side helpers for exposing devtools RPC methods
export { attachDevToolsSAB, exposeDevToolsApi } from "./worker-expose";

// Renderer-side worker manifest sync
export { syncWorkerManifests } from "./worker-sync";
export type { DevToolsWorkerProxy, WorkerSyncEntry } from "./worker-sync";

// Renderer adapter — auto-discovers renderer capabilities
export { createDevToolsRendererAdapter } from "./renderer-adapter";

// Sim stats provider factory — eliminates duplicated polling/control boilerplate
export { createSimStatsProvider } from "./sim-stats-provider";

// initDevTools helper — one-line wiring per app
export { initDevTools } from "./init";
export type { InitDevToolsOptions } from "./init";

// Profiling bridge — wires the ProfilingSAB + renderer-side warning engine +
// event-loop monitor + trace event writer + auto-trace + built-in view descriptors
export { bindDebugStore } from "./bind-debug-store";
export type { DebugStoreBindings } from "./bind-debug-store";
export { ProfilingBridge } from "./profiling-bridge";
export type { ProfilingBridgeOptions, ProfilingBridgeSnapshot } from "./profiling-bridge";
export { wireProfilingBridge } from "./profiling-hooks";
export type {
    ProfilingLoopCallbacks,
    ProfilingWireHost,
    ProfilingWireRenderer,
    WireProfilingBridgeOptions
} from "./profiling-hooks";

// Debug view descriptors — declarative registration of profiler overlay views
export { BUILTIN_VIEW_DESCRIPTORS } from "./debug-view-descriptors";
export type { BuiltinViewKind, DebugViewDescriptor } from "./debug-view-descriptors";

