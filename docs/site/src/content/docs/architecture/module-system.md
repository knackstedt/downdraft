---
title: Module System
description: Compile-time DI modules, typed tokens, cross-thread contract, engine libraries
---

## Module architecture: engine vs game boundary

> **Terminology note:** **Modules** are the engine's compile-time DI units (`Module`, `RendererModule`, `ModuleHost`). **Plugins/mods** are the runtime-loadable user-authored extensions (`PluginHost`, `mod.json`) — see [Plugin Internals](/architecture/plugin-internals/). (The DI units were once called "plugins"; don't confuse the two.)

The engine is a **single npm package**, `@downdraft/engine` (manifest at `packages/engine/package.json`), which exposes everything through subpath exports: `@downdraft/engine` (core index), `@downdraft/engine/<area>` for core subtrees (`/ecs`, `/material`, `/module`, `/plugin`, `/profiling`, `/render`, ...) plus a `./* → ./core/src/*.ts` wildcard for deep core imports (e.g. `@downdraft/engine/worker/instrumented-worker-host` — there is **no** `/core/` subpath prefix), `@downdraft/engine/app/<main|shared>`, `@downdraft/engine/libraries/<name>`, `@downdraft/engine/modules/<name>`, plus `shader-graph`, `mcp`, `test`, and `asset-bake` subpaths. The other published packages are `@downdraft/cli` (the `draft` binary), `@downdraft/platform-native` (native binaries + host layer), and the `@downdraft/native-<platform>-<arch>` prebuilt-cdylib packages (optional deps of platform-native). The exports map is generated — run `node scripts/gen-engine-exports.mjs` after adding/removing a library or module directory.

Architecturally the engine is split into **core + libraries** (standard engine building blocks, used directly by games) vs **modules** (opt-in game features with lifecycle + typed DI + diagnostics). Core also includes animation and particles subsystems directly.

- **Engine libraries** (imported as `@downdraft/engine/libraries/<name>`, located in `packages/engine/libraries/`): directories that export classes/functions without a module lifecycle. Games can either import and wire these directly, or declare them via `EngineLibrary` descriptors in `GameModule.libraries[]` for auto-wiring (SAB allocation, sim system creation, renderer pass creation, typed DI tokens). Engine libraries: asset-browser, audio-kira, blitz-ui, character, devtools, entities, gamepad, gaussian-splats, gpu-kernels, html-ui-kit, inspectable, lighting, marching-cubes, models, navmesh, networking, pathfinding-2d, persistence, physics-native, physics-rapier, postfx, recast, sand, stickman, surface-nets, water, weather, weatherfx.
- **Engine modules** (imported as `@downdraft/engine/modules/<name>`, located in `packages/engine/modules/`): directories that implement the `Module` or `RendererModule` interface with a `register()` lifecycle + typed DI. Engine modules: camera-controls, controller-ui, devtools, editor, html-ui, mcp, movement-2d, movement-3d, native-osr, sailing, terrain, vitals, xr.
- **Game modules** (e.g. namespace `@my-game/module-*`, located in a game repo's `modules/` dir): game-specific features with a module lifecycle. Examples: crafting, inventory, buoyancy, collision, wildlife.
- **Game libraries** (e.g. namespace `@my-game/library-*`, located in a game repo's `libraries/` dir): game-specific pure libraries without a module lifecycle. Examples: boats, economy, fishing, items, survival.

### Declarative GameModule + startGame()

Games declare their renderer-side bootstrap as a `GameModule` and call `startGame()` from `@downdraft/engine/app/main`. This replaces the old `bootstrapGame()` callback-soup with a declarative module:

```ts
startGame({
  libraries: [WaterLib],                    // engine library descriptors
  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: (seed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345, gamemode: 0, rules: {} },
  events: { weather_changed: (data, ctx) => store.setWeather(data) },
  save: { mode: "auto", engineVersion: "0.1.0" },
  onReady: (ctx) => { /* game-specific wiring */ },
  onDispose: (ctx) => { /* cleanup */ },
});
```

`startGame()` handles: library SAB allocation, sim worker spawn, event routing, save store init, renderer create+init, render loop, FPS polling, display info, hot-reload dispose, deterministic mode. `bootstrapGame()` remains available for games that need full control.

### Feature modules

Feature modules (`@downdraft/engine/modules/terrain`, `@downdraft/engine/modules/movement-3d`, `@downdraft/engine/modules/movement-2d`, `@downdraft/engine/modules/sailing`) use the factory pattern (`createXxxModule(config)`) and provide typed DI tokens. Games register them via `moduleHost.useModules([...])` for batch activation in dependency-resolved order.

### Cross-thread module contract

`CrossThreadToken<T>` tags resources with a thread ("sim" | "renderer" | "shared"). `buildCrossThreadReport()` detects unresolved requires, shared resources, and version conflicts across sim + renderer module hosts. The devtools **Doctor** panel (`doctor` provider in `native-providers.ts`) displays this report.

### Engine library descriptors

Engine libraries can expose an `EngineLibrary` descriptor (e.g. `WaterLib`, `PhysicsRapierLib`, `MarchingCubesLib`) that lets games declare them declaratively in `GameModule.libraries[]`:

```ts
import { WaterLib, PhysicsRapierLib } from "@downdraft/engine/libraries/water";

startGame({
  libraries: [WaterLib, [PhysicsRapierLib, { maxEntities: 8192 }]],
  // ...
});
```

The `LibraryHost` auto-wires each library: allocates SAB channels, creates sim-side systems, creates renderer-side passes, and registers provided resources in the DI graph via typed tokens (e.g. `WaterWriterTok`, `WaterReaderTok`, `PhysicsAPITok`). Games inject these tokens from `GameContext` in their `onReady` hook.

Bare class exports remain as an escape hatch — games that need full control can still import and wire `WaterBufferWriter`, `RapierPhysicsBackend`, etc. directly.

No engine package depends on any game package (verified). The `entities` library is an engine library (generic `ModelRenderer` used by multiple games). When adding a new game, create `modules/` in the game repo for its game-specific modules and `libraries/` for its game-specific pure libraries.

### Visual Test Bench

A graphical test program for visually verifying engine effects and systems: a native html-ui menu of minimal tests, each owning its renderer (disposed + recreated on switch). Add tests as `src/tests/<category>/<name>.test.ts` in a game repo calling `registerTest()` — Vite glob auto-discovers them (`VisualTest { id, name, category, createRenderer(canvas), getControls?() }`). Built-ins cover navmesh debug viz and the full PostProcessStack effect chain.

Related manual test rigs under `test-beds/`: `ui-bakeoff` (the framework comparison that picked Blitz) and `component-kit` (live html-ui-kit widget gallery — `bun run test-beds/component-kit/main.ts`, `KIT_SELFTEST=1` for scripted assertions).

### Typed DI (provide/inject + provides/requires)

Modules use typed `ResourceToken<T>`-based dependency injection instead of stringly-typed resource names:

```ts
import { resourceToken, type Module } from "@downdraft/engine";

export const WeatherState = resourceToken<WeatherStateData>("weatherState");

export const SailingModule: Module = {
  name: "sailing",
  version: "1.0.0",
  requires: [WeatherState, PhysicsAPI],   // validated before register()
  provides: [SailingState, BuoyancyAPI],  // declared, checked for duplicates
  register(ctx) {
    const weather = ctx.inject(WeatherState);  // typed; throws if absent
    ctx.provide(SailingState, sailingState);
    ctx.onDispose(() => sailingState.destroy());
  },
};
```

- `ctx.provide(token, value)` — typed write; in `DOWNDRAFT_STRICT_DIAGNOSTICS` mode throws on duplicate key.
- `ctx.inject(token)` — typed read; throws if the token has no provider (use `injectOptional` for safe reads).
- `provides`/`requires` arrays — the host validates the dependency graph at activation, before any `register()` runs. Missing provider → hard error naming both modules.
- The stringly-typed `registerResource(name, value)` / `getResource(name)` API has been **removed**. Use `resourceToken<T>(key)` + `provide`/`inject` instead.

### DOWNDRAFT_STRICT_DIAGNOSTICS diagnostics

When `DOWNDRAFT_STRICT_DIAGNOSTICS=1` (or in Vite dev mode), the module hosts validate the dependency graph and catch common footguns:
- Duplicate `provide` → hard error.
- Missing `requires` provider at activation → hard error.
- Leak detection: module provides resources / allocates SAB channels but registers no `onDispose()` cleanup → warning on unload.

Set `DOWNDRAFT_STRICT_DIAGNOSTICS=0` to force-disable in dev, `DOWNDRAFT_STRICT_DIAGNOSTICS=1` to force-enable in prod.

### Logging conventions

All logs go through `createLogger()` (`@downdraft/engine/util/logger`) as `log.<level>(module, msg)` — format `HH:MM:SS LEVEL [module] message`. Module tags are **lowercase-kebab** (`game-renderer`, `platform-native`, `import-cache`); single-identifier tags are normalized to kebab at render time, so stay consistent at the call site anyway. Separators carry meaning: `plugin:<id>` for user plugins, `dev/<sub>` for dev-shell submodules. Process-level tags: `draft` = the CLI, `dev` = the HMR dev shell (`dev/hmr` for runtime-side HMR events). There are **no thread prefixes** (R0/S0/SVC were an Electron-era renderer-vs-main distinction — removed); `setThreadTag()` remains for plugin workers that need origin labels. Routine diagnostics belong at `log.debug` — visible via `--verbose` or `DOWNDRAFT_LOG_LEVEL=debug`; INFO should read as a boot/status narrative, not a stream of internals.

Config when adding/removing an engine library or module: create/remove the directory under `packages/engine/libraries/` or `packages/engine/modules/` with a `src/index.ts`, then run `node scripts/gen-engine-exports.mjs` (regenerates the `exports` map in `packages/engine/package.json`) and `node scripts/gen-deno-import-map.mjs` (regenerates `deno.json`). No tsconfig paths, Vite aliases, or workspace entries are needed — subpath resolution flows through the single `@downdraft/engine` package.


## Module registration patterns

`moduleHost.registerModule(m)` registers + activates one module; `moduleHost.useModules([...])` (preferred — wraps `registerModuleDeferred` + `activateAll`) batch-activates in topological order over each module's `dependencies: string[]` (and validates `requires`/`provides`). To wrap a library factory as a module, use `createXxxModule(opts): Module` — `opts` encapsulates all config and dependencies.

