# DownDraft Engine

A game engine built on a **native runtime — winit + wgpu, hosted by Bun, Node, or Deno** (TypeScript-first, Rust native modules for platform and audio). Games run as a single JS-runtime process driving a native window and the GPU directly — no browser, no renderer process, no IPC boundary. Bun is the default JS runtime (and the repo's package manager / test runner / packaging compiler), but Node+tsx and Deno are fully supported via `draft dev --runtime=node|deno`. It ships with a built-in MCP server so AI agents can help build your game — designing, building, debugging, and managing assets via natural language prompts — but AI is one workflow among many: the engine is fully usable by hand, end to end, without any AI tooling.

## Quick Start

```bash
# Install dependencies
bun install

# Scaffold a game (each game owns src/native-entry.ts), or clone an
# existing game repo and cd into it
draft new my-game
cd my-game
draft dev

# Build + package for distribution (desktop)
draft release

# Build only (compile the native binary, skip packaging extras)
draft release --stage=build
```

## Game Entrypoint

Games bootstrap through `src/native-entry.ts`, which runs a shared `GameModule` on the native host:

```ts
// my-game/src/native-entry.ts
import { runNativeGameModule } from "@downdraft/platform-native";
import { gameModule } from "./game-module";

await runNativeGameModule(gameModule, {
  title: "My Game",
  appId: "downdraft-my-game",
});
```

The host API (`downdraft.*`) exposes saves, screenshots, window state, import cache, dialogs, and restart routing as direct in-process calls — no preload bridge, no IPC.

See `AGENTS.md` for the full architecture reference (module system, HostAPI surface, packaging pipeline).

## Architecture

```
┌─────────────────────────────────────────────┐
  Game Process (src/native-entry.ts)
  runtime: Bun (default) / Node / Deno
    • createNativeHost() — window lifecycle, display info
    • Owns the wgpu device + RenderSurface
    • HostAPI bridge, MCP server, saves, import cache
    ┌───────────────────┐  ┌───────────────────┐
    │  RenderSurface    │  │  imui / PixiJS    │
    │  (RenderLoop)     │  │  UI + devtools    │
    └────────┬──────────┘  └───────────────────┘
             │ SharedArrayBuffer (zero-copy)
    ┌────────┴───────────┐
    │  Sim Worker        │
    │  (ECS World,       │
    │   game systems,    │
    │   physics, modules)│
    └────────────────────┘
└─────────────────────────────────────────────┘
```

- **Host (main thread)** — Window/lifecycle (winit), GPU device (wgpu), `HostAPI` bridge (saves via `FileSaveStore`, screenshots, MCP, telemetry), restart routing. The `RenderLoop` runs here, driven by window redraw events.
- **Sim Worker** — Runs the ECS `World`, game systems, physics, and modules. Communicates with the host via `SharedArrayBuffer` (zero-copy) and postMessage events. Workers can attach a non-owning view of the shared GPU device for parallel command encoding.
- **Service workers** — Background workers host services like the embedded DB (SurrealKV) for save/load and game-state queries.

## Packages

### Engine core

| Package | Description |
|---|---|
| `@downdraft/engine` | Engine core: ECS, render passes, render graph, SAB, input, telemetry, modules, particles, animation, physics, audio, assets, save system |
| `@downdraft/engine/app` | Runtime-agnostic game bootstrap (`startGame`/`bootstrapGame`) + HostAPI types |
| `@downdraft/engine/mcp` | MCP server for AI agent interaction (JSON-RPC) |
| `@downdraft/engine/shader-graph` | Material/shader graph compiler and validator |
| `@downdraft/cli` | CLI tool (`draft new/dev/debug/release/assets/test`) |
| `@downdraft/platform-native` | Native runtime host: winit windowing, wgpu device, HostAPI bridge, MCP server (Rust cdylib via FFI — `bun:ffi`/`koffi`/`Deno.dlopen`) |

### Engine libraries (`packages/engine/libraries/`)

Engine libraries export `EngineLibrary` descriptors (e.g. `WaterLib`, `PhysicsRapierLib`) for declarative wiring in `GameModule.libraries[]`, plus bare class exports as an escape hatch.

| Package | Description |
|---|---|
| `@downdraft/engine/libraries/water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
| `@downdraft/engine/libraries/marching-cubes` | Voxel terrain with LOD and deformation |
| `@downdraft/engine/libraries/surface-nets` | Surface-nets mesh extraction from voxel fields |
| `@downdraft/engine/libraries/physics-rapier` | Rapier3D physics backend |
| `@downdraft/engine/libraries/physics-native` | Native physics backend |
| `@downdraft/engine/libraries/audio-kira` | Kira audio backend (Rust FFI) |
| `@downdraft/engine/libraries/networking` | WebSocket transport, state replication, RPCs |
| `@downdraft/engine/libraries/weather` | Weather system |
| `@downdraft/engine/libraries/weatherfx` | Weather visual effects |
| `@downdraft/engine/libraries/lighting` | Lighting system |
| `@downdraft/engine/libraries/entities` | Generic model renderer used by multiple games |
| `@downdraft/engine/libraries/models` | Model loading and management |
| `@downdraft/engine/libraries/navmesh` | Navigation mesh generation and pathfinding |
| `@downdraft/engine/libraries/persistence` | Save/load (filesystem store) |
| `@downdraft/engine/libraries/gaussian-splats` | Gaussian splat rendering |
| `@downdraft/engine/libraries/sand` | Falling-sand simulation |
| `@downdraft/engine/libraries/stickman` | Stickman character system |

### Engine modules (`packages/engine/modules/`)

Feature modules use the factory pattern (`createXxxModule(config)`) and provide typed DI tokens. Games register them via `moduleHost.useModules([...])`.

| Package | Description |
|---|---|
| `@downdraft/engine/modules/camera-controls` | Camera input and control modes |
| `@downdraft/engine/modules/devtools` | DevTools overlay panel (native OSR) |
| `@downdraft/engine/modules/native-osr` | Offscreen rendering (native WebGPU surfaces) |
| `@downdraft/engine/modules/mcp` | In-game MCP automation harness |
| `@downdraft/engine/modules/xr` | WebXR / VR support |
| `@downdraft/engine/modules/terrain` | Terrain system |
| `@downdraft/engine/modules/movement-3d` | 3D movement system |
| `@downdraft/engine/modules/movement-2d` | 2D movement system |
| `@downdraft/engine/modules/sailing` | Sailing mechanics |

### Game modules / libraries (`<game>/modules/` + `<game>/libraries/`)

Game-specific features live under each game's `modules/` and `libraries/` directories. No engine package depends on any game package. Games organize their features as `@<game-scope>/module-*` (lifecycle + typed DI) or `@<game-scope>/library-*` (bare classes) packages, following the same engine library/module split described above.

## CLI Commands

The CLI is available via `bun run packages/cli/src/index.ts <command>` or as `draft` if installed globally. Run `draft --help` for the full command list, or `draft <command> --help` for command-specific flags. See the [CLI reference](https://downdraft.dev/reference/cli) for complete documentation.

### `draft new [path] [options]`
Scaffolds a new game project (native-only: `src/native-entry.ts` + `downdraft.config.json`).
- `--template=<name>` — `minimal` / `physics` / `full` / `gamemodule` (default: `minimal`)
- `--name=<n>` — Project name
- `--ai-companion` — Scaffold `.devin/` config + `engine-prompt.md`
- `--force` — Scaffold into a non-empty directory
- `--list-templates` — List available templates

### `draft dev [options]`
Starts the game on the native runtime — a JS-runtime process hosting a winit window and the wgpu device, with an embedded Vite dev shell providing tiered HMR. Run from a game directory.
- `--game <name>`, `-g` — Game to run (resolves `games/<game>` from the engine root). If omitted, `draft dev` walks up from cwd looking for `downdraft.config.json`/`src/native-entry.ts`.
- `--runtime <r>` — JS runtime hosting the game: `bun` / `node` / `deno` (default: auto-detect, preferring bun)
- `--port <n>` — MCP HTTP port (default: auto-assign)
- `--no-hmr` — Disable HMR — spawn the entry directly, no dev shell
- `--native` — Back-compat no-op (native is the only runtime)

### `draft debug [path] [options]`
Runs the engine in debug mode with profiling, debug draw, and visualization tools. `path` defaults to `.`.
- `--verbose, -v` — Verbose logging
- `--no-devtools` — Disable devtools overlay
- `--inspector` — Enable Node inspector

### `draft release [options]`
Unified build + package pipeline for desktop targets. Compiles the game's `src/native-entry.ts` into a standalone Bun binary plus a staged `native/` + `dd-assets/` runtime tree via the packaging script shipped in `@downdraft/cli`.
- `--game <name>`, `-g` — Game to release
- `--games=<csv>` — Comma-separated game names
- `--target <t>`, `-t` — `win` / `linux` / `mac` / `all` (default: `all`); cross-compiles via Bun compile targets and stages the target platform's native libs
- `--stage=<s>` — `build` / `package` / `release` (default: `release`; all compile the same binary)
- `--mode=<m>` — Build mode: `dev` / `debug` / `prod` (default: `prod`; prod minifies)
- `--out=<dir>` — Output directory (default: `release`)
- `--mcp` — Retain the MCP endpoint in the packaged binary (stripped by default)

Deprecated aliases `build`, `dist`, `export`, `build-games` delegate to `release`; `mobile` is removed (the Capacitor shell was deleted).

### `draft assets <command> [project] [options]`
Manages remote asset packs.
- Subcommands: `init`, `add-store`, `add`, `pull`, `push`, `list`
- Run `draft assets <subcommand> --help` for subcommand flags.

### `draft test [options]`
Runs e2e tests via `bun:test` (SwiftShader + deterministic by default). The default smoke specs drive the game through the in-game MCP RPC harness, but `--spec` can point at any `bun:test` file.
- `--game <name>`, `-g` — Game to test
- `--renderer <r>`, `-r` — `cpu` (SwiftShader) / `gpu` (hardware) (default: `cpu`)
- `--headed` — Show the window instead of running headless

## Editor UI

### DevTools Overlay
Native devtools overlay with debug toggles, telemetry graphs, entity inspector, and asset loader (rendered through `modules/native-osr`, no webviews).

### Material Graph Editor
Node-based shader editor with drag-and-drop connections, WGSL compilation, and validation (triggered via Compile/Validate buttons).

### Animation State Machine Editor
Visual state machine editor with drag-and-drop states, transition arrows, and parameter management. Blend tree data types are exported for programmatic use.

### Asset Browser
Grid/list view of project assets with type filtering, search, and import functionality.

### Performance Profiler
Real-time frame time graph with CPU/GPU timing, p50/p95/p99 statistics, and per-system timing table.

### Debug Toggles
Wireframe, hitboxes, normals, velocity, shadows, bloom, AABBs, overdraw, LOD visualization, depth buffer, and tangents.

## Tutorials

### Creating Your First Scene

```typescript
import { Camera, Component, MeshBuilder, resourceToken, World } from "@downdraft/engine";

const world = new World();
const camera = new Camera();
camera.setAspect(16, 9);
camera.distance = 5;
const CameraRes = resourceToken<Camera>("camera");
world.setResourceTyped(CameraRes, camera);

const mesh = MeshBuilder.cube(1);
const CubeMeshRes = resourceToken<typeof mesh>("cubeMesh");
world.setResourceTyped(CubeMeshRes, mesh);
```

### Adding Particles

```typescript
import { ParticleSystem, createSmokeEmitter } from "@downdraft/engine";

const particles = new ParticleSystem({
  maxParticlesPerEmitter: 10000,
  useGPUCompute: true,
  surfaceFormat: "rgba16float",
});
particles.prepare(device);

const smokeId = particles.registerEmitter(
  createSmokeEmitter({ position: [0, 2, 0] })
);

// Update each frame
particles.update(dt);
particles.render(renderCtx, camera.getViewProjectionMatrix(), camera.position);
```

### Using Modules

Engine libraries expose `EngineLibrary` descriptors and are wired declaratively via `startGame()`:

```typescript
import { startGame } from "@downdraft/engine/app/renderer";
import { PhysicsRapierLib } from "@downdraft/engine/libraries/physics-rapier";
import { AudioKiraLib } from "@downdraft/engine/libraries/audio-kira";
import { WaterLib } from "@downdraft/engine/libraries/water";
import { MarchingCubesLib } from "@downdraft/engine/libraries/marching-cubes";
import { NetworkingLib } from "@downdraft/engine/libraries/networking";

startGame({
  libraries: [PhysicsRapierLib, AudioKiraLib, WaterLib, MarchingCubesLib, NetworkingLib],
  renderer: (surface) => new WebGPURenderer(surface),
  sim: (seed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345, gamemode: 0, rules: {} },
});
```

Feature modules (e.g. `@downdraft/engine/modules/terrain`, `@downdraft/engine/modules/movement-3d`) use the factory pattern and are activated via `moduleHost.useModules([...])`. See `AGENTS.md` for the full module/library contract.

## Mobile

The Capacitor/WebView mobile path was removed — it was dormant and unmaintained. A future mobile port would target the native runtime (winit/SDL + wgpu), not a WebView shell.

## License

MIT
