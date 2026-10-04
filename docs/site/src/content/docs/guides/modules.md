---
title: Modules
description: Module system architecture, typed DI, declarative GameModule, and first-party modules
---

DownDraft has a tiered extension system with three layers:

1. **Engine libraries** (`@downdraft/engine/libraries/*`) — standard building blocks (water, physics, terrain, audio, etc.). Used directly or via declarative `EngineLibrary` descriptors.
2. **Engine modules** (`@downdraft/engine/modules/*`) — opt-in features with lifecycle + typed DI (devtools, camera-controls, terrain, movement, sailing, OSR, MCP, XR).
3. **Game modules** (`@<game>/module-*`) — game-specific systems (fishing, inventory, crafting, wildlife, etc.) using the same `Module` interface.

> **Note on terminology:** "module" refers to the engine's compile-time DI units (documented on this page). "plugin" refers to the user-authored runtime plugin/modding system — sandboxed extensions discovered under `<game>/plugins/` (`plugin.json`/`mod.json`), loaded by a per-thread `PluginHost` (`core/src/plugin`) in `worker-js`, `wasm`, `quickjs`, or `asset` formats behind tiered permissions. Scaffold them with `draft plugin new` / `draft mod new` (see [CLI reference](/reference/cli/)).

## Declarative GameModule

Games declare their renderer-side bootstrap as a `GameModule` and call `startGame()`:

```typescript
import { startGame } from "@downdraft/engine/app/renderer";
import { WaterLib } from "@downdraft/engine/libraries/water";
import { createTerrainModule } from "@downdraft/engine/modules/terrain";

startGame({
  // Engine libraries (declarative SAB allocation + DI tokens)
  libraries: [WaterLib],

  // Renderer + Sim
  renderer: (surface) => new GameRenderer(surface),
  sim: (seed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345, gamemode: 0, rules: {} },

  // Sim→Renderer event routing (declarative)
  events: {
    weather_changed: (data, ctx) => store.setWeather(data),
    player_died: (data) => store.setPlayerDied(data),
  },

  // Save
  save: { mode: "auto", engineVersion: "0.1.0" },

  // Game-specific wiring
  onReady: (ctx) => {
    ctx.renderer.setBuffers(ctx.simSAB, ctx.extraBuffers.water, ctx.inputSAB);
    // ...
  },
  onDispose: () => { /* cleanup */ },
});
```

`startGame()` wraps `bootstrapGame()` and handles: sim worker spawn + SAB capture, library SAB allocation, declarative event routing, save store init, renderer create+init, render loop, FPS polling, display info, hot-reload dispose, and deterministic mode. Games that need full control can call `bootstrapGame()` directly.

## Typed DI (provide/inject)

Modules use typed `ResourceToken<T>`-based dependency injection:

```typescript
import { resourceToken, type Module } from "@downdraft/engine";

export const WeatherState = resourceToken<{ windSpeed: number }>("weatherState");

export const SailingModule: Module = {
  name: "sailing",
  version: "1.0.0",
  requires: [WeatherState],   // validated before register()
  provides: [SailingState],   // declared, checked for duplicates
  register(ctx) {
    const weather = ctx.inject(WeatherState);  // typed; throws if absent
    ctx.provide(SailingState, { speed: weather.windSpeed });
    ctx.onDispose(() => console.log("sailing unloaded"));
  },
};
```

- `ctx.provide(token, value)` — typed write; in `DOWNDRAFT_STRICT` mode throws on duplicate.
- `ctx.inject(token)` — typed read; throws if the token has no provider.
- `ctx.injectOptional(token)` — safe read; returns `undefined` if not provided.
- `provides`/`requires` arrays — the host validates the dependency graph at activation.

### Batch registration

```typescript
// Register multiple modules in dependency-resolved order
moduleHost.useModules([WeatherModule, SailingModule, NavigationModule]);
```

`useModules()` registers all modules deferred, then activates them in topological order with full graph validation.

## Engine Library Descriptors

Engine libraries can expose an `EngineLibrary` descriptor for declarative wiring:

```typescript
import { WaterLib, PhysicsRapierLib } from "@downdraft/engine/libraries/water";

startGame({
  libraries: [
    WaterLib,
    [PhysicsRapierLib, { maxEntities: 8192 }],  // override config
  ],
  // ...
});
```

The `LibraryHost` auto-wires each library:
- Allocates SAB channels
- Creates sim-side systems (at the declared `tickPhase`)
- Creates renderer-side passes
- Registers provided resources in the DI graph via typed tokens

Games inject library-provided tokens from `GameContext`:

```typescript
onReady: (ctx) => {
  const waterReader = (ctx as any).libraryHost?.libraries
    .find(l => l.lib.name === "water")?.rendererInstance;
  // Or use the typed token:
  // const writer = ctx.inject(WaterWriterTok);
}
```

Bare class exports remain as an escape hatch — games that need full control can still import and wire `WaterBufferWriter`, `RapierPhysicsBackend`, etc. directly.

### Available library descriptors

| Library | Descriptor | Tokens provided |
|---------|-----------|----------------|
| water | `WaterLib` | `WaterWriterTok`, `WaterReaderTok` |
| physics-rapier | `PhysicsRapierLib` | `PhysicsAPITok` |
| marching-cubes | `MarchingCubesLib` | `TerrainStreamingConfigTok` |

## Feature Modules

Feature modules are opt-in game features with the `Module` interface:

| Module | Package | Description |
|--------|---------|-------------|
| terrain | `@downdraft/engine/modules/terrain` | Composes marching-cubes + LOD + streaming + deformation |
| movement-3d | `@downdraft/engine/modules/movement-3d` | 3D first/third-person movement (walk, run, swim, fly) |
| movement-2d | `@downdraft/engine/modules/movement-2d` | 2D top-down/side-scroll movement |
| sailing | `@downdraft/engine/modules/sailing` | Sailing mechanics (wind, buoyancy, rudder, hull drag) |
| devtools | `@downdraft/engine/modules/devtools` | Debug overlays, scene inspector, gizmos |
| camera-controls | `@downdraft/engine/modules/camera-controls` | Camera modes (free, follow, orbit) |
| native-osr | `@downdraft/engine/modules/native-osr` | Offscreen rendering for in-game UI surfaces |
| mcp | `@downdraft/engine/modules/mcp` | MCP automation harness for testing |
| editor | `@downdraft/engine/modules/editor` | Editor shell, viewport, selection, commands |
| html-ui | `@downdraft/engine/modules/html-ui` | Blitz HTML/CSS game UI, rasterized in a worker |
| controller-ui | `@downdraft/engine/modules/controller-ui` | Controller/ten-foot UI support |
| vitals | `@downdraft/engine/modules/vitals` | Vitals (health/stamina/etc.) system |
| xr | `@downdraft/engine/modules/xr` | WebXR VR/AR support |

### Module factory pattern

Modules use a factory pattern so games can pass config at registration time:

```typescript
import { createTerrainModule } from "@downdraft/engine/modules/terrain";

const terrainModule = createTerrainModule({
  streaming: { baseVoxelSize: 0.5 },
  meshWorkerCount: 4,
});

gameWorld.moduleHost.registerModule(terrainModule);
```

## Cross-Thread Module Contract

In multi-threaded games, the sim worker and renderer each have their own `ModuleHost`. Cross-thread tokens declare shared resources:

```typescript
import { crossThreadToken } from "@downdraft/engine";

// SAB written by sim, read by renderer — tag as "shared"
export const WaterSABTok = crossThreadToken<SharedArrayBuffer>("water:sab", "shared");
```

The `buildCrossThreadReport()` function builds a dependency report from sim + renderer module snapshots, detecting:
- Unresolved requires (token required by one thread, provided by neither)
- Shared resources (provided by both threads)
- Version conflicts (same module name, different version across threads)

## downdraft doctor

The `downdraft doctor` devtools panel displays module graph diagnostics:

- **Module table**: name, version, thread (sim/renderer/shared), provides, requires, status
- **Summary**: sim/renderer module counts, shared resources, unresolved requires, version conflicts
- **Diagnostics**: errors (unresolved, conflicts), warnings, OK status
- Auto-refreshes every 2s when active

Register it via:

```typescript
import { createDoctorPanelExtension } from "@downdraft/engine/modules/devtools";

devtools.registerPanel(createDoctorPanelExtension({
  getSimModules: () => simModuleHost.snapshot(),
  getRendererModules: () => rendererModuleHost.snapshot(),
}));
```

## DOWNDRAFT_STRICT Diagnostics

When `DOWNDRAFT_STRICT=1` (or in Vite dev mode), the module hosts validate:
- Duplicate `provide` → hard error
- Missing `requires` provider at activation → hard error
- Leak detection: module provides resources / allocates SAB channels but registers no `onDispose()` → warning

## Module Registration Patterns

1. **Direct registration** — `moduleHost.registerModule(module)` — registers and immediately activates a single module.

2. **Batch registration** — `moduleHost.useModules(modules[])` — registers multiple modules, then activates them in dependency-resolved topological order.

3. **Factory pattern** — `createXxxModule(config): Module` — modules that accept config use a factory function. The config encapsulates all options and dependencies.
