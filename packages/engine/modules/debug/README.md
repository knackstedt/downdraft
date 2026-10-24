# `@downdraft/engine/modules/debug`

In-engine debug tooling — scene inspector, profiling wiring, transform/grid/skeleton debug renderers, and the worker-side devtools API (`exposeDevToolsApi`, `devtools` singleton) that feeds the `@downdraft/devtools` surface.

## Install

```sh
bun add @downdraft/engine/modules/debug
```

## Key exports

- `initDevTools` / `wireProfilingBridge` / `ProfilingBridge`
- `exposeDevToolsApi` / `attachDevToolsSAB` / `devtools` / `syncWorkerManifests`
- `BaseSceneInspector` / `DevToolsDataBridge` / `useSceneStore` / `useDebugStore`
- `TransformGizmo` / `createTransformGizmoModule` / `GridRenderer` / `HeightRulerRenderer` / `SkeletonRenderer` / `DebugRaycast`
- `createSimStatsProvider` / `createDevToolsRendererAdapter` / `bindDebugStore`
- `BUILTIN_VIEW_DESCRIPTORS`

The devtools UI itself lives in `@downdraft/devtools` (in-window overlay via `mountDevtools`, or the standalone `draft devtools` viewer) — this module is the backend/data side it consumes.

See the [Downdraft engine repository](https://github.com/knackstedt/downdraft) for architecture docs and examples.
