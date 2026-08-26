---
title: Plugins
description: Plugin system architecture, typed DI, declarative GameModule, and first-party plugins
---

DownDraft has a tiered extension system with three layers:

1. **Engine libraries** (`@downdraft/library-*`) — standard building blocks (water, physics, terrain, audio, etc.). Used directly or via declarative `EngineLibrary` descriptors.
2. **Engine plugins** (`@downdraft/plugin-*`) — opt-in features with lifecycle + typed DI (devtools, camera-controls, terrain, movement, sailing, OSR, MCP, XR).
3. **Game plugins** (`@<game>/plugin-*`) — game-specific systems (fishing, inventory, crafting, wildlife, etc.) using the same `Plugin` interface.

## Declarative GameModule

Games declare their renderer-side bootstrap as a `GameModule` and call `startGame()`:

```typescript
import { startGame } from "@downdraft/app/renderer";
import { WaterLib } from "@downdraft/library-water";
import { createTerrainPlugin } from "@downdraft/plugin-terrain";

startGame({
  // Engine libraries (declarative SAB allocation + DI tokens)
  libraries: [WaterLib],

  // Renderer + Sim
  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: (seed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345, gamemode: 0, rules: {} },

  // UI
  mountUI: (overlay) => {
    createRoot(overlay).render(<App />);
  },

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

Plugins use typed `ResourceToken<T>`-based dependency injection:

```typescript
import { resourceToken, type Plugin } from "@downdraft/core";

export const WeatherState = resourceToken<{ windSpeed: number }>("weatherState");

export const SailingPlugin: Plugin = {
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
// Register multiple plugins in dependency-resolved order
pluginHost.usePlugins([WeatherPlugin, SailingPlugin, NavigationPlugin]);
```

`usePlugins()` registers all plugins deferred, then activates them in topological order with full graph validation.

## Engine Library Descriptors

Engine libraries can expose an `EngineLibrary` descriptor for declarative wiring:

```typescript
import { WaterLib, PhysicsRapierLib } from "@downdraft/library-water";

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

## Feature Plugins

Feature plugins are opt-in game features with the `Plugin` interface:

| Plugin | Package | Description |
|--------|---------|-------------|
| terrain | `@downdraft/plugin-terrain` | Composes marching-cubes + LOD + streaming + deformation |
| movement-3d | `@downdraft/plugin-movement-3d` | 3D first/third-person movement (walk, run, swim, fly) |
| movement-2d | `@downdraft/plugin-movement-2d` | 2D top-down/side-scroll movement |
| sailing | `@downdraft/plugin-sailing` | Sailing mechanics (wind, buoyancy, rudder, hull drag) |
| devtools | `@downdraft/plugin-devtools` | Debug overlays, scene inspector, gizmos |
| camera-controls | `@downdraft/plugin-camera-controls` | Camera modes (free, follow, orbit) |
| electron-osr | `@downdraft/plugin-electron-osr` | Offscreen rendering for in-game web surfaces |
| mcp | `@downdraft/plugin-mcp` | MCP automation harness for testing |
| xr | `@downdraft/plugin-xr` | WebXR VR/AR support |

### Plugin factory pattern

Plugins use a factory pattern so games can pass config at registration time:

```typescript
import { createTerrainPlugin } from "@downdraft/plugin-terrain";

const terrainPlugin = createTerrainPlugin({
  streaming: { baseVoxelSize: 0.5 },
  meshWorkerCount: 4,
});

gameWorld.pluginHost.registerPlugin(terrainPlugin);
```

## Cross-Thread Plugin Contract

In multi-threaded games, the sim worker and renderer each have their own `PluginHost`. Cross-thread tokens declare shared resources:

```typescript
import { crossThreadToken } from "@downdraft/core";

// SAB written by sim, read by renderer — tag as "shared"
export const WaterSABTok = crossThreadToken<SharedArrayBuffer>("water:sab", "shared");
```

The `buildCrossThreadReport()` function builds a dependency report from sim + renderer plugin snapshots, detecting:
- Unresolved requires (token required by one thread, provided by neither)
- Shared resources (provided by both threads)
- Version conflicts (same plugin name, different version across threads)

## downdraft doctor

The `downdraft doctor` devtools panel displays plugin graph diagnostics:

- **Plugin table**: name, version, thread (sim/renderer/shared), provides, requires, status
- **Summary**: sim/renderer plugin counts, shared resources, unresolved requires, version conflicts
- **Diagnostics**: errors (unresolved, conflicts), warnings, OK status
- Auto-refreshes every 2s when active

Register it via:

```typescript
import { createDoctorPanelExtension } from "@downdraft/plugin-devtools";

devtools.registerPanel(createDoctorPanelExtension({
  getSimPlugins: () => simPluginHost.snapshot(),
  getRendererPlugins: () => rendererPluginHost.snapshot(),
}));
```

## DOWNDRAFT_STRICT Diagnostics

When `DOWNDRAFT_STRICT=1` (or in Vite dev mode), the plugin hosts validate:
- Duplicate `provide` → hard error
- Missing `requires` provider at activation → hard error
- Leak detection: plugin provides resources / allocates SAB channels but registers no `onDispose()` → warning

## Plugin Registration Patterns

1. **Direct registration** — `pluginHost.registerPlugin(plugin)` — registers and immediately activates a single plugin.

2. **Batch registration** — `pluginHost.usePlugins(plugins[])` — registers multiple plugins, then activates them in dependency-resolved topological order.

3. **Factory pattern** — `createXxxPlugin(config): Plugin` — plugins that accept config use a factory function. The config encapsulates all options and dependencies.
