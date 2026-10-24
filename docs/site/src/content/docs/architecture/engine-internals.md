---
title: Engine Internals
description: Rendering/save/material/compute/bindless internals — subsystem notes for engine contributors
---

## Engine dist packaging (npm) — source vs dist resolution

Published `@downdraft/*` packages ship a **per-file transpiled ESM `dist/`** alongside source. `node scripts/build-dist.mjs` (plain Node, `ts.transpileModule`) mirrors every source file into `dist/`, baking out Vite-isms: `?raw`/`.wgsl` → inlined strings, `?url` → `import.meta.resolve`, `?json` → inline, relative `.ts` specifiers → `.js`, `new URL("./x.ts", import.meta.url)` worker refs → `.js`, `import.meta.dir`/`.dirname`/`.filename` → `import.meta.url`-derived locals. Output is incremental (`.dd-manifest.json` hashes) and stays native-importable — deep imports preserve 1:1 module identity, so Vite's server-consumer env externalizes it entirely (near-zero runner transform cost).

Every export entry carries three conditions:

```json
".": { "types": "./core/src/index.ts", "downdraft-source": "./core/src/index.ts", "default": "./dist/core/src/index.js" }
```

- **`draft dev` (monorepo) defaults to engine=source**: the CLI spawns the dev shell with `--conditions=downdraft-source` (Bun/Node flag; `DENO_CONDITIONS` env for Deno) and `DD_ENGINE_SOURCE=1`; worker threads propagate the same condition via `execArgv` (see `dom-polyfills.ts`/`worker-bootstrap.mjs`). Full engine module graph → granular tiered HMR.
- **`draft dev --engine-dist`** omits the condition → all `@downdraft/*` imports resolve `dist/` — faster cold start, but engine source edits require re-running `node scripts/build-dist.mjs` and engine HMR is coarse.
- **`vite-config.mjs`** sets `resolve.conditions` for the `native` env from `DD_ENGINE_SOURCE` and resolves `wgslRegistryPath` against whichever universe is active — keep the two in sync when touching it.

**Rules for engine/platform-native code that resolves filesystem paths relative to itself** (crate dirs, staged assets, package metadata): never hardcode `".."` segment counts off `import.meta.url`/`import.meta.dir` — dist nests modules one level deeper than src and the math escapes into `dist/`. Anchor at the package root instead: `findPackageRoot(dir)` walks up to the nearest `package.json` (`@downdraft/engine/platform/pkg-root` for engine code; `packageRoot`/`findPackageRoot` exported from `platform-native/src/ffi/lib-paths.ts`), then append the package-relative path explicitly.

Publishing (`scripts/publish-packages.mjs`, `publish.yml`) runs the dist build before `npm publish`; `files` includes `dist`. `link:games` links dist targets when present.


## RenderSurface and overlay layering

On the native runtime there is no DOM or HTML document. The single render target is the `RenderSurface` contract (`core/src/platform/render-surface.ts`), implemented by `NativeSurface` (a wgpu-backed native window surface). UI overlays render into the same surface via offscreen wgpu textures (`modules/native-osr`) and are composited as final-present quads.

### How it works

- `GameModule.renderer: (surface: RenderSurface) => IRenderer` — the surface is injected by `bootstrapGame()`; never query `document` for a canvas.
- `ctx.surface` / `GameRenderer.getSurface()` are the canonical accessors. There is no DOM compositor on native (`hasDom()` is `false`) — never query `document` for the render target.
- Game UI uses `modules/html-ui` (Blitz — see the shared-APIs table above); there is no DOM-overlay mount hook.
- Multiple render areas (minimap, picture-in-picture) are implemented as additional OSR surfaces or viewport regions, not stacked canvases.

## Per-game storage isolation

Each game MUST pass a unique `appId` (`downdraft-<game>`) so the native host resolves a per-game `userData` directory (e.g. `~/.config/downdraft-my-game/`). Save files, SQLite import cache, debug artifacts, and the singleton lock all live under it — sharing one between games would corrupt save state and collide on the lock.

When `appId` is set, `createNativeHost()` (via `runNativeGameModule`) also:
1. Acquires a singleton lock (`<userData>/singleton.lock`, PID-owned) — prevents two instances of the same game from running concurrently (which would corrupt storage). **Skipped in deterministic/test mode** (`DOWNDRAFT_DETERMINISTIC=1`): the test harness controls process lifecycle itself (dynamic MCP ports + process-group kills). `DOWNDRAFT_MULTI_INSTANCE=1` opts out of the lock in any mode.
2. Cleans up stale lock artifacts from a previous run that crashed or was killed. In non-deterministic mode this is safe because the single-instance lock guarantees no live process is using the directory; in deterministic mode the test harness guarantees no concurrent instance.
3. Sets the window's desktop identity — `appId` is forwarded into `NativeWindowConfig.appId`, which becomes the Wayland `app_id` and both X11 `WM_CLASS` parts (via `dd_window_set_app_name` before window create). Without it every dev-run window maps with no identity and the WM groups all games under one taskbar entry. The dev shell's early boot (`early-host.ts`) applies `native.appId` from `downdraft.config.json` the same way — keep the config's `appId` in sync with the entry's, since the identity is baked at window create and an adopted early window can't be re-identified.

### Files

- `packages/platform-native/src/bridge/user-data-dir.ts` — `resolveNativeUserDataDir()` (builds the per-game path).
- `packages/platform-native/src/host-lifecycle.ts` — singleton lock acquisition + stale-lock cleanup in `createNativeHost()`.

### Adding a new game

`draft new <dir> --template <minimal|physics|full> --name <name>` scaffolds a game project (a separate repo, per the layout above). Always set `appId` in the game's `src/native-entry.ts`:
```ts
await runNativeGameModule(gameModule, {
  appId: "downdraft-my-game",  // → ~/.config/downdraft-my-game/
  title: "My Game",
});
```


## Unified DevTools API

The DevTools system has a single registration surface (`devtools` singleton from `@downdraft/engine/modules/debug`) that auto-detects whether it's running in the main realm or a worker realm and chooses the appropriate transport:

- **Main realm**: feeds/commands registered directly on `window.__downdraftDevtools` via `DevToolsDataBridge`.
- **Worker realm**: data feeds written to a devtools SharedArrayBuffer (zero-copy, synchronous reads); commands forwarded via IPC RPC.

### Architecture

- **`devtools` singleton** (`packages/engine/modules/debug/src/api.ts`) — the unified API. Auto-detects realm. Modules import `devtools` and call `registerDataFeed()`, `registerCommand()`, `registerSABStat()`. Same code works in both realms.
- **`DevToolsSABLayout`** — dedicated SAB region for JSON-serialized data feed results + direct numeric stats. Worker writes via `flushDataFeeds()` (called from sim loop); renderer reads synchronously. No IPC polling.
- **`exposeDevToolsApi()`** (`packages/engine/modules/debug/src/worker-expose.ts`) — wraps a worker's `expose()` API with `__devtoolsGetManifest`, `__devtoolsCallCommand`, `__devtoolsGetSAB` RPC methods.
- **`syncWorkerManifests()`** (`packages/engine/modules/debug/src/worker-sync.ts`) — renderer-side: fetches manifest from workers, wires SAB data feed readers, wires command forwarders.
- **`createDevToolsRendererAdapter()`** (`packages/engine/modules/debug/src/renderer-adapter.ts`) — feature-detects renderer capabilities (gpuProfiler, telemetryCollector, gpuResourceTracker, gcController) and builds an `IDevToolsDataRenderer`.
- **`createSimStatsProvider()`** (`packages/engine/modules/debug/src/sim-stats-provider.ts`) — reusable `ISimStatsProvider` factory with 10Hz polling + pause/resume/step/speed/clear delegation. Eliminates duplicated boilerplate across sim games.
- **`initDevTools()`** (`packages/engine/modules/debug/src/init.ts`) — one-line wiring per game. Creates bridge, wires providers, merges global feed/command registrations, syncs worker manifests, exposes on `window.__downdraftDevtools`.

### Module integration

Both `ModuleContext` (sim) and `RendererModuleContext` (renderer) have a `devtools` property. Modules self-register during `register()`:

```ts
// In a renderer module
register(ctx: RendererModuleContext) {
  ctx.devtools.registerDataFeed("getPhysicsStats", () => ({ bodyCount: ... }));
}

// In a sim module (worker realm)
register(ctx: ModuleContext) {
  ctx.devtools.registerDataFeed("getWildlifeStats", () => ({ count: ... }));
  ctx.devtools.registerCommand("cullWildlife", (max: number) => { ... });
}
```

The host injects the `devtools` singleton via `ModuleHost.setDevToolsAPI()` / `RendererModuleHost.setDevToolsAPI()`. If not set, a no-op stub is used (modules that call `ctx.devtools.register*()` silently no-op).

### Deterministic mode

`DOWNDRAFT_DETERMINISTIC=1` exposes `downdraft.deterministic` on the bridge; bootstrap reads it for autosave/render-loop behavior. Devtools is unaffected by default — `autoShow` is already opt-in (default false) and F12 still toggles. Games that want the dock fully off in tests can set `devtools.ui: "none"` or `toggleKey: null` when `ctx.deterministic` is true.

## Unified Material System

The material system is unified around the **shader graph as the single source of truth**. The 8 hand-written `material-types/*.wgsl` files serve as fallbacks (loaded via Vite `?raw` as `inlineShaderSource`). The graph compiler generates WGSL from `MaterialGraph` nodes; the `Material` class compiles the graph at construction time and caches the result in `inlineShaderSource`.

### Architecture

- **`MaterialDefinition`** (`packages/engine/core/src/material/material.ts`) — the material definition. Key fields: `graph?: MaterialGraph` (primary), `inlineShaderSource?: string` (compiled graph or fallback .wgsl), `variantFlags?: MaterialVariantFlags`, `profile?: string`.
- **`MaterialLibrary`** (`packages/engine/core/src/material/library.ts`) — creates and registers materials. The 8 `create*` methods (Physical, Toon, Matcap, SSS, Sprite, Normal, Line, Depth) load their `.wgsl` fallbacks via `?raw` imports. Graph preset methods (`createPBRGraph`, `createGBufferGraph`) build `MaterialGraph` instances.
- **`GraphCompiler`** (`packages/engine/shader-graph/src/compiler.ts`) — compiles a `MaterialGraph` to WGSL. Supports multi-render-target (GBuffer) profiles via `outputFormats`/`outputNames`, and variant-aware compilation via `variantFlags` in `CompileOptions`.
- **`MaterialVariantFlags`** (`packages/engine/core/src/material/variants.ts`) — hybrid variant strategy: compile-time permutations for `shadowCaster`/`skinning`/`alphaMode`/`morph`/`instanced`; `fog` stays a dynamic branch (NOT part of the variant key). `variantKey()` produces a deterministic string key; `permutationCount()` = 48.
- **`graph-bridge.ts`** (`packages/engine/core/src/material/graph-bridge.ts`) — `compileGraphToMaterialVariants` compiles all variants for a material; `compileVariant` compiles a single variant.
- **`OpaquePass`** (`packages/engine/core/src/render/passes/opaque.ts`) — `setMaterial()` sets a graph-compiled material; `setMaterialVariant()` compiles + caches a per-variant pipeline (bounded LRU, max 24). `getProfileTargets()` emits multi-target `GPUColorTargetState[]` for GBuffer profiles.

### Profiles

- `SIMPLE_PROFILE`, `PBR_PROFILE`, `PBR_TEXTURED_PROFILE`, `PBR_SKINNED_PROFILE`, `PBR_INSTANCED_PROFILE`, `PBR_COLOR_VERTEX_PROFILE` — single-target.
- `GBUFFER_PROFILE` — multi-render-target deferred surface shader. 4 targets: albedo+AO, normal+roughness, metallic+emissive, velocity. Graph output nodes use names: `"albedo"`, `"normal"`, `"metallicEmissive"`, `"velocity"`.

### Material adapter (`libraries/models`)

`materialDataToMaterial()` (`packages/engine/libraries/models/src/material-adapter.ts`) bridges serialized `MaterialData` (glTF/obj format) to the core `Material` surface. Maps baseColor/metallic/roughness/emissive to uniforms, sets `inlineShaderSource` from the physical fallback .wgsl. `materialDataArrayToMaterials()` batch-converts. The game's `RendererAccessors.uploadModel()` calls this to register materials in a `MaterialLibrary`.

## Model Import Normalization Pipeline

The engine has a unified model import normalization pipeline that corrects common anomalies (incorrect scaling, rotation, up-axis) at load time. This replaces ad-hoc hardcoded fixes in individual games.

### Architecture

- **`ImportSettings`** (`packages/engine/core/src/assets/import-settings.ts`) — per-model normalization config: `upAxis`, `units`, `scale`, `rotation`, `centerToOrigin`, `autoFit`, `nodeTransforms`. Resolved from sidecar files or parser-detected defaults.
- **`model-normalizer.ts`** (`packages/engine/core/src/assets/model-normalizer.ts`) — pure transform math: `applyUpAxisConversion` (Z-up→Y-up), `applyUnitScale` (source units→meters), `applyRootScale`, `applyRootRotation` (quaternion), `computeBounds`, `centerToOrigin`, `autoFit`, `isExtremeScale`. Operates on interleaved [pos(3)+normal(3)] mesh vertices (6 floats/vertex).
- **`bake-node-transforms.ts`** (`packages/engine/libraries/models/src/bake-node-transforms.ts`) — bakes glTF/FBX node hierarchy transforms (translation, rotation, scale) into mesh vertices. Promoted from downdraft-model-viewer to the engine so all games benefit.
- **`normalize.ts`** (`packages/engine/libraries/models/src/normalize.ts`) — orchestrates the full pipeline: up-axis → unit scale → node-transform baking → root rotation → user scale → bounds → center → auto-fit. `normalizeModel()` applies settings; `normalizeModelWithResolution()` resolves sidecars then normalizes.
- **`loadModel()`** (`packages/engine/libraries/models/src/loader.ts`) — now normalizes by default after parsing. Pass `normalize: false` to skip (e.g. for games that handle their own transforms). Pass `sidecarResolver` for custom sidecar resolution.

### Sidecar System

Per-model import settings are stored in sidecar files, tried in priority order:
1. `.ddmeta.json` (our format, JSON-with-comments via `comment-json`)
2. Unity `.meta` (YAML, `scaleFactor` field)
3. Godot `.import` (INI, `scale`/`rotation` params)
4. Blender extras (glTF `asset.extras.glTF2ExportSettings.YUP`)

Sidecar parsers: `packages/engine/libraries/models/src/sidecar/` — `ddmeta.ts`, `unity-meta.ts`, `godot-import.ts`, `blender-extras.ts`, `resolver.ts`.

### Parser Detection

FBX parser reads `GlobalSettings` for `UpAxis` (0/1=Y-up, 2=Z-up) and `UnitScaleFactor` (units per cm). glTF parser checks `asset.extras.glTF2ExportSettings.YUP`. DAE parser reads `<asset><up_axis>` and `<unit meter="...">`. Stored on `ModelData.sourceUpAxis` and `ModelData.sourceUnits`.

### Import Cache

`ImportCache` (`packages/engine/core/src/assets/import-cache.ts`) caches resolved `ImportSettings` keyed by model path. `MemoryImportCache` is the in-memory fallback. On native, `createHostImportCache()` wraps `downdraft.importCache*` — the host keeps a SQLite-backed cache beside saves/ in the game's userData dir, and the wrapper warms an in-memory mirror asynchronously so `get()` stays synchronous.

## Save system / storage backends

`ISaveStore` (`packages/engine/core/src/save/persist-types.ts`) is the storage interface for versioned game saves: `save`/`load` (blobs, thumbnails, properties, generation control via `SaveOptions`/`LoadOptions`), `listSaves`/`listGenerations`/`deleteSave`/`deleteGeneration`, `setThumbnail`/`getThumbnail`, `setProperties`/`getProperties`, `onWarning`. Saves are a zstd-compressed JSON body of per-component sections (each with its own schema version) plus a header (engine version, timestamp, entity/player counts, XXH128 hash). `MigrationRegistry` runs per-component `fromVersion→toVersion` migrations on load; forward-incompatible saves are refused. Implementations live in `packages/engine/libraries/persistence/`:

- **`FileSaveStore`** (`file-save-store.ts`) — filesystem backend, **the store that runs on the native host** (host mode). One `.ddsave` file per slot (header + zstd body), rotated to `.bak` each save (load fallback on corruption); blobs in `<slot>.blobs/`, thumbnail in `<slot>.thumb`, properties in `<slot>.props.json`. Node-only (`node:fs`).
- **`DirectorySaveStore`** (`directory-save-store.ts`) — directory-handle store: `navigator.storage.getDirectory()` (OPFS) in browsers, a `node:fs`-backed File System Access handle on native (Bun/Node/Deno). Generation history, blobs, thumbnails, properties; `meta.json` written last as the commit point.
- **`HostSaveStore`/`BridgeJsonSaveStore`** — plumbing for the `"host"`/`"auto"` modes (typed bridge store, or legacy JSON-serialized bridge fallback).

**Save modes** (game selects via `GameSaveConfig.mode`): `"host"` (main thread writes through the host's typed `ISaveStore` → `FileSaveStore` — the native default), `"worker"` (the sim worker owns a `DirectorySaveStore`), `"auto"` (default: typed host store if the bridge provides one, else `BridgeJsonSaveStore`). `createSaveStore()` (`app/src/main/save-store-factory.ts`) picks; `SimBridgeDeps.saveMode` tells the sim bridge which path is active.

### Devtools Auto-Fit

`BaseSceneInspector.importModel()` returns `needsAutoFit` and `warnings` when a model has extreme scale (< 0.01m or > 100m). `autoFitModel(nodeId, targetMaxDim)` re-normalizes and generates a `.ddmeta.json` sidecar for persistence; `generateSidecar(nodeId)` creates a starter sidecar with commented-out fields. (These are `__downdraftDevtools` methods — callable from the devtools REPL; no dedicated prompt UI in the Blitz dock yet.)

### Devtools material editor

`BaseSceneInspector` (`packages/engine/modules/debug/src/scene-inspector.ts`) exposes a functional material editor API: `compileMaterialGraph`, `createMaterialFromGraph`, `saveMaterialToLibrary`, `listMaterials`, `exportMaterialAsJSON`, `importMaterialFromJSON`, `previewMaterialGraph` (live preview via `setPreviewMeshRenderer`).

### Hot reload

`HotReloader` (`packages/engine/core/src/render/hot-reload.ts`) writes reloaded shader source into `material.inlineShaderSource` (not the dead `shader` string field) and calls `material.invalidateVariants()` to flush the variant cache.

## Compute Graph System

The engine has a node-based compute shader authoring system that parallels the material graph. It provides a higher-level alternative to hand-writing WGSL compute shaders (the "gpu.js replacement" for WebGPU).

### Architecture

- **`ComputeGraph`** (`packages/engine/shader-graph/src/compute-graph.ts`) — the compute graph data structure. Separate from `MaterialGraph` (which is vertex/fragment only). Contains nodes + connections + `StorageBufferDecl`/`UniformBufferDecl` declarations + `ComputeDispatchConfig` (workgroup size + dispatch count).
- **`ComputeGraphCompiler`** (`packages/engine/shader-graph/src/compute-compiler.ts`) — compiles a `ComputeGraph` to WGSL `@compute @workgroup_size(...)` shader. Emits struct declarations from buffer decls, `@group/@binding` var declarations, and a `cs_main` entry point with `global_invocation_id`/`local_invocation_id`/`workgroup_id`/`num_workgroups` builtins. Compute-specific nodes: `global_id`, `buffer_load`, `buffer_store`, `atomic_add/sub/min/max/exchange`, `workgroup_barrier`, `storage_barrier`. Math nodes (multiply, add, sin, etc.) are shared with the material compiler.
- **`ComputeProfile`** (`packages/engine/shader-graph/src/compute-profiles.ts`) — simpler than `ShaderGraphProfile`: just `name`, `chunks`, `workgroupSize`. Built-in profiles: `SIMPLE_COMPUTE_PROFILE` (64x1x1), `PARTICLE_COMPUTE_PROFILE` (64x1x1), `TEXTURE_COMPUTE_PROFILE` (8x8x1), `VOLUMETRIC_COMPUTE_PROFILE` (4x4x4).
- **`GraphComputePass`** (`packages/engine/core/src/render/passes/graph-compute.ts`) — `RenderPass` subclass with `PassType.Custom`. Integrates with the frame graph (dispatches on the shared encoder). Supports both auto-allocated buffers (from `StorageBufferDecl`/`UniformBufferDecl`) and externally-provided buffers (`setExternalBuffer()`). `recompile()` supports hot-reload. Uses local `BUFFER_USAGE`/`SHADER_STAGE_COMPUTE` constants instead of WebGPU globals for testability.
- **`runComputeKernel()`** (`packages/engine/core/src/render/compute-kernel.ts`) — thin imperative helper for quick one-off GPGPU. Takes WGSL + typed inputs, dispatches once, returns a `readBuffer()` function for CPU readback. No graph, no frame graph needed.

### Buffer management

`GraphComputePass` supports two modes:
1. **Auto-allocated** (default): creates `GPUBuffer`s from `StorageBufferDecl`/`UniformBufferDecl` declarations. Storage buffers use `STORAGE | COPY_DST | COPY_SRC`; uniform buffers use `UNIFORM | COPY_DST`. Runtime-sized arrays default to 1 MB.
2. **Externally provided**: `setExternalBuffer(name, buffer)` skips auto-allocation for that buffer. Used for interop with existing systems (e.g. particle buffers from `ParticleComputePass`).

Data is written via `writeUniform(name, data)` (queued, flushed before dispatch) and `writeStorage(name, data)` (immediate `queue.writeBuffer`).

## Bindless rendering model

The engine uses a bindless material binding model to eliminate per-draw bind-group churn. Material parameters (baseColor, roughness, texture indices) live in a single SSBO; textures are registered into global `texture_2d_array` buckets keyed by format/dimensions/mips. A single bind group (`@group(3)`) is set once per frame and shared by all draw calls.

### Core infrastructure (`packages/engine/core/src/render/bindless/`)

- `BindlessTextureRegistry` — manages `texture_2d_array` buckets. Textures are registered by `sourceId` (stable string key) and packed into array layers. `registerFromTexture(src, GPUTexture, key)` and `registerFromImageBitmap(src, ImageBitmap, format, mipCount)` are the entry points. `getHandle(sourceId)` returns a packed `(pageIndex << 16) | layerIndex` handle. `defaultWhiteHandle` is a 1x1 white fallback.
- `BindlessMaterialManager` — manages the material SSBO. `registerMaterial(MaterialParams)` returns a `materialIndex`; `updateMaterial(index, params)` updates in place; `unregisterMaterial(index)` frees the slot.
- `BindlessFrameBindings` — owns the `@group(3)` bind group layout + bind group. `prepareFrame()` flushes the material SSBO and returns the bind group. `getBindGroup()` returns the cached bind group.
- `bindless.wgsl.ts` — WGSL chunks (`BINDLESS_MATERIAL_CHUNK`) for the `BindlessMaterial` struct + `unpackArrayIndex`/`unpackLayerIndex` helpers.

### WGSL binding convention

- `@group(0)` — per-draw uniform (camera, model matrix, `materialIndex: u32`). The materialIndex selects the material from the SSBO.
- `@group(1)` — lighting data (storage buffer).
- `@group(2)` — IBL bind group (brdfLUT, irradiance, prefilter).
- `@group(3)` — bindless materials: `binding(0)` = material SSBO, `binding(1..8)` = 8 separate `texture_2d_array` bindings (WGSL does NOT allow `array<texture_2d_array<f32>, N>` — each array must be a separate `@binding`), `binding(9)` = repeat sampler, `binding(10)` = clamp sampler.
- Texture handles pack `(globalArrayIndex << 16) | layerIndex`. The `globalArrayIndex` is a monotonic flat index across all buckets/pages — assigned when a page is appended, never reused. Shaders use `sampleBindlessArray(arr, uv, layer)` (a switch over arr 0..7) to sample the correct binding.

### Device limits

`device.ts`, `game-renderer.ts`, and `native-host.ts` request `maxTextureArrayLayers` up to `512` (clamped to what the adapter reports) in `requiredLimits`. `GPUDeviceManager.requestDevice` checks for the limit before requesting.

### Bindless consumers

`ModelRenderer` (`libraries/entities`, via `setBindlessDeps()`/`setBindlessBindGroup()`), `OpaquePass` PBR path (`materialIndex` uniform at `@group(0) binding(3)`), `DecalPass`, `PBR_TEXTURED_PROFILE`/`PBR_SKINNED_PROFILE` shader-graph profiles, and `bridgeMaterial()` (registers textures when given a registry). Games' own renderers (e.g. my-game's `PlayerMeshRenderer`) wire it the same way.

### WebGPU + Rapier gotchas

- `GPUTexelCopyTextureInfo` and `GPUCopyExternalImageDestInfo` use `origin: [x, y, layer]` (z component = array layer), not a separate `arrayLayer` property.
- `GPUSupportedLimits` → `Record<string, number>` conversion requires `any` cast.
- `@dimforge/rapier3d-compat` does not export `RawRigidBodySet`/`RawColliderSet` — `rapier-physics-system.ts` uses `any` for raw body/collider refs.
- **WASM borrow aliasing:** Rapier returns `RawVector`/`RawRotation`/`RawColliderShape` objects from methods like `body.translation()`, `controller.computedMovement()`, and `ColliderDesc.trimesh()`. These hold WASM borrows that must be explicitly `.free()`d before `world.step()`. The `rapier-backend.ts` `addCollider` frees `cd.shape` after `world.createCollider()` (the collider set clones the `SharedShape` Arc). Same for `getColliderPosition`, `getBodyTransform`, `characterMove`, and the raw fast-path fallbacks. Failure to free causes "recursive use of an object detected which would lead to unsafe aliasing in rust" panics during `world.step()`.
- **Raw fast-path handle mapping:** The `*Raw` methods in `rapier-backend.ts` receive `bodyId` (the game's `PhysicsBody.id`, sequential: 1, 2, 3...) but must pass the **Rapier rigid-body handle** (`body.handle`, starts at 0) to WASM functions like `rbSetTranslation`. The raw fast paths look up the `RigidBody` from `bodyMaps` to get `body.handle`. Passing `bodyId` directly causes out-of-bounds WASM access that corrupts internal state and triggers the aliasing panic.
- **`swapColliderShapeRaw` shape type:** `ColliderDesc.trimesh()` returns a `SharedShape` (Eg) which stores vertices/indices but does NOT hold a `RawColliderShape`. `coSetShape` expects a `RawShape` (OA). Call `shape.intoRaw()` to get the `RawColliderShape`, pass it to `coSetShape`, then `.free()` it.

## Universal Physics Module (physics-rapier 0.2.0)

- The `PhysicsBackend` interface is now `PhysicsBody`-keyed (opaque body refs). Raw Rapier `RigidBodyHandle` is no longer exported from `@downdraft/engine`.
- Multi-realm LOD: `RealmManager` drives near/mid/far tiers with promote/demote + dwell hysteresis. Static bodies are duplicated into all realms by default.
- `UniversalPhysicsAPI` (`@downdraft/engine/libraries/physics-rapier`) is the single public surface: body lifecycle, validated state access, realm queries, interpolation, raycast, snapshots, hooks.
- Subsystems: `PhysicsAccumulator` (fixed timestep), `InterpolationBuffer` (double-buffered), `LoadShedder` (island-aware freeze), `SafetyLayer` (NaN/Inf + hard-lock), `CCDHeuristic` (per-body), `SnapshotManager` (multiplayer), `RealmWorkerPool` (nested-worker parallelism, `workerCount:0` = single-threaded).
- `PhysicsSystem` (ECS, `Stage.Physics`) wires all subsystems together; created via `createPhysicsSystem(resources)`.
- **Raw fast paths** (`*Raw` methods on `UniversalPhysicsAPI`/`PhysicsBackend`): scalar transform sync/readback, `isSleepingRaw`, `swapColliderShapeRaw` (in-place trimesh shape swap, avoids broadphase re-insertion), `reserveMemory`, `setIntegrationDt`. These bypass safety validation and avoid JS object allocation — callers must validate inputs. Use in hot loops (e.g. `my-game`'s per-entity sync runs every tick).

## Host SDK (`@downdraft/engine/app` — runtime-agnostic host layer)

The native host (`packages/platform-native`) owns the process: it creates the winit window, the wgpu device/surface, installs the `globalThis.downdraft` `HostAPI` bridge in-process (no IPC, no preload), and runs the MCP server. A game boots from `src/native-entry.ts` → `runNativeGameModule()` / `startNativeGame()` / `createNativeHost()`.

### Subpath exports

- `@downdraft/engine/app/main` — `startGame()`/`bootstrapGame()` (run on the native main thread), typed `downdraft` HostAPI accessor (stubs to no-op when absent), save-store factory, standard MCP automation tools.
- `@downdraft/engine/app/shared` — the `HostAPI` contract types (`packages/engine/app/src/shared/types.ts`).

### Process model

Single process: the game module, renderer, host services, sim-worker host, and MCP server all live in the one JS-runtime process; the simulation runs in a dedicated worker thread (SAB channels, unchanged). Recovery is restart-based — `downdraft.requestRestart(reason)` respawns the process (see `packages/platform-native/src/native-restart.ts`); `window.location.reload()` is not a recovery path on native. Devtools + OSR are in-process WebGPU overlays (`modules/native-osr`), not embedded web panels.


## UI typography: minimum font size

All UI text rendered by the engine and games MUST use a font size of **at least 12px**. This applies to in-game HUDs, menus, tooltips, DevTools panels, and any UI document content generated by the framework.

- Do not set `font-size` below `12px` (e.g. no `10px`, `11px`, or `0.7rem`-style values that resolve below 12px) in CSS, inline styles, or stylesheet theme overrides.
- When adapting third-party component styles or copying reference markup, bump any sub-12px font sizes up to 12px.
- The base stylesheet (`packages/engine/app/src/main/downdraft-base.css`) should not introduce a root font size below 12px; game theme overrides layered on top of it must also respect this floor.
- This is a readability/accessibility floor, not a target — larger sizes are fine where appropriate.

