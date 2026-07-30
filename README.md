# DownDraft Engine

An AI-Driven Game Engine built on **Electron + electron-vite + WebGPU** (TypeScript-first, optional Rust native modules for audio), with a built-in MCP server enabling AI agents to design, build, debug, and manage assets for games via natural language prompts.

## Quick Start

```bash
# Install dependencies
bun install

# Run the engine shell (default renderer from packages/app)
bun run dev

# Run a specific game
DOWNDRAFT_GAME=to-the-ocean bun run dev

# Build for production
draft build --mode=prod --out=dist

# Package for distribution
draft export --target=all --out=export
```

## Architecture

```
┌─────────────────────────────────────────────┐
  Electron Main Process (packages/app/src/main)
    • Window lifecycle, display info, IPC
    • SurrealDB worker thread (persistence)
    • GC profiling, performance stats
├─────────────────────────────────────────────┤
  Renderer Process (BrowserWindow)
    ┌───────────────────┐  ┌──────────────────┐
    │  WebGPU Canvas    │  │  React UI Overlay │
    │  (RenderLoop)     │  │  (DevTools, HUD)  │
    └────────┬──────────┘  └──────────────────┘
             │ SharedArrayBuffer (zero-copy)
    ┌────────┴──────────┐
    │  Sim Web Worker   │
    │  (ECS World,      │
    │   game systems,   │
    │   physics, plugins)│
    └───────────────────┘
└─────────────────────────────────────────────┘
```

- **Electron Main Process** — Window/lifecycle management, SurrealDB worker thread, IPC handlers, GC/perf profiling. No render loop here.
- **Renderer Process** — React UI overlay + WebGPU `<canvas>` rendering. The `RenderLoop` runs here via `requestAnimationFrame`.
- **Sim Web Worker** — Spawned from the renderer. Runs the ECS `World`, game systems, physics, and plugins. Communicates with the renderer via `SharedArrayBuffer` (zero-copy) and postMessage events.
- **DB Worker Thread** — SurrealDB (SurrealKV) embedded in a Node.js worker thread in the main process. Handles save/load and game state queries.

## Packages

| Package | Description |
|---|---|
| `@downdraft/core` | Engine core: ECS, render passes, render graph, SAB, input, telemetry, plugins, particles, animation, physics, audio, assets, save system |
| `@downdraft/app` | Electron app shell: main process, preload, renderer entry |
| `@downdraft/ui` | React UI: devtools panel, profiler, material graph editor, animation state machine editor, asset browser |
| `@downdraft/mcp` | MCP server for AI agent interaction (JSON-RPC over stdio) |
| `@downdraft/shader-graph` | Material/shader graph compiler and validator |
| `@downdraft/cli` | CLI tool (`draft init/dev/debug/build/export`) |
| `@downdraft/plugin-water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
| `@downdraft/plugin-marching-cubes` | Voxel terrain with LOD and deformation |
| `@downdraft/plugin-physics-rapier` | Rapier3D physics backend |
| `@downdraft/plugin-audio-kira` | Kira audio backend (Rust FFI via `packages/audio-native`) |
| `@downdraft/plugin-networking` | WebSocket transport, state replication, RPCs |
| `@downdraft/plugin-boats` | Boat design system and boat data buffer |
| `@downdraft/plugin-items` | Item definitions and registry |
| `@downdraft/plugin-inventory` | Inventory management |
| `@downdraft/plugin-crafting` | Crafting recipes and system |
| `@downdraft/plugin-economy` | Market system and price history |
| `@downdraft/plugin-fishing` | Fishing mechanics |
| `@downdraft/plugin-weather` | Weather system |
| `@downdraft/plugin-survival` | Survival mechanics |

## CLI Commands

The CLI is available via `bun run packages/cli/src/index.ts <command>` or as `draft` if installed globally.

### `draft init [path]`
Scaffolds a new game project with directory structure, `main.ts` entry point, and `downdraft.config.json`.

### `draft dev [options]`
Starts the engine in dev mode via `electron-vite dev`.
- `--watch` — Enable hot reload

> **Note:** The primary dev workflow is `bun run dev` (which runs `electron-vite dev`). To run a specific game, set `DOWNDRAFT_GAME=<game-name>`.

### `draft debug [options]`
Runs the engine in debug mode with profiling, debug draw, and visualization tools.
- `--verbose, -v` — Verbose logging
- `--no-devtools` — Disable devtools overlay
- `--inspector` — Enable Node inspector

### `draft build [options]`
Builds the game for the target platform.
- `--target=<platform>` — Target: current/windows/macos/linux
- `--mode=<mode>` — Build mode: dev/debug/prod
- `--out=<dir>` — Output directory (default: dist)
- `--no-minify` — Disable minification
- `--sourcemap` — Generate source maps

### `draft export [options]`
Packages the built game for distribution.
- `--target=<platform>` — Target: all/windows/macos/linux
- `--out=<dir>` — Output directory (default: export)
- `--no-compress` — Disable compression

## Core API Reference

### ECS

```typescript
import { Component, World, Stage, system } from "@downdraft/core";

// Define a component
const Health = Component.register("Health", {
  current: 100,
  max: 100,
});

// Create a world
const world = new World();

// Spawn an entity and add components
const entity = world.spawn(new Map());
world.addComponent(entity, Health.id, Health.create({ max: 200 }));

// Define and register a system
const damageSystem = system("damage", Stage.Update, (ctx) => {
  const { world, dt } = ctx;
  // Iterate entities with Health component via query
  // (see Query class for advanced iteration)
});
world.schedule.addSystem(damageSystem);

// Step the simulation
world.step(dt);
```

### Rendering

```typescript
import { Camera, MeshBuilder, RenderLoop } from "@downdraft/core";

const camera = new Camera();
camera.setAspect(16, 9);
camera.distance = 5;

const mesh = MeshBuilder.cube(1);

const renderLoop = new RenderLoop({
  canvas,        // HTMLCanvasElement or OffscreenCanvas
  mesh,
  camera,
  mode: "gbuffer",  // or "simple" for forward rendering
});

await renderLoop.init();
renderLoop.start();
```

The `RenderLoop` supports a deferred rendering pipeline (depth prepass → G-Buffer → shadow → deferred lighting → skybox → transparent → post-process) or a simple forward path. A `RenderGraph` validates resource dependencies and aliasing.

### Particle System

```typescript
import { ParticleSystem, createFireEmitter } from "@downdraft/core";

const particles = new ParticleSystem({
  maxParticlesPerEmitter: 5000,
  useGPUCompute: true,
  surfaceFormat: "rgba16float",
});
particles.prepare(device);

const emitterId = particles.registerEmitter(
  createFireEmitter({ position: [0, 1, 0] })
);

// In update loop:
particles.update(dt);

// In render pass:
particles.render(ctx, viewProj, cameraPos);
```

### Physics

```typescript
import { Collider, PhysicsRealm, PhysicsTransform, RigidBody, Velocity, createBoxCollider } from "@downdraft/core";
import { PhysicsRapierPlugin } from "@downdraft/plugin-physics-rapier";

// Use the Rapier plugin via GameWorld:
gameWorld.usePlugin(PhysicsRapierPlugin);

// Or use PhysicsRealm directly:
const realm = new PhysicsRealm({ gravity: [0, -9.81, 0] });
```

### Animation

```typescript
import { AnimationPlayer, AnimationStateMachine } from "@downdraft/core";

const player = new AnimationPlayer();
player.play("idle", { weight: 1.0, fadeIn: 0.2 });

const sm = new AnimationStateMachine();
sm.addState("idle", { clip: idleClip });
sm.addState("walk", { clip: walkClip });
sm.addTransition("idle", "walk", { condition: "speed > 0.5" });
```

Supports skeletal animation, GLTF skinning, GPU compute skinning, Mixamo retargeting, and blend trees (1D/2D).

### Audio

```typescript
import { AudioEngine, createAudioSource } from "@downdraft/core";
import { AudioKiraPlugin } from "@downdraft/plugin-audio-kira";

gameWorld.usePlugin(AudioKiraPlugin);
const source = createAudioSource({ buffer: "explosion.wav", volume: 0.8 });
```

### Networking

```typescript
import { NetworkingPlugin, ReplicationManager } from "@downdraft/plugin-networking";

gameWorld.usePlugin(NetworkingPlugin);
// Server: replication.update(dt) sends snapshots
// Client: snapshots auto-applied to entity components
```

## Editor UI

### DevTools Panel
Overlay panel with debug toggles, telemetry graphs, entity inspector, and asset loader. Toggleable at runtime.

### Material Graph Editor
Node-based shader editor with drag-and-drop connections, real-time WGSL compilation, and validation.

### Animation State Machine Editor
Visual state machine editor with drag-and-drop states, transition arrows, parameter management, and blend tree support.

### Asset Browser
Grid/list view of project assets with type filtering, search, and import functionality.

### Performance Profiler
Real-time frame time graph with CPU/GPU timing, p50/p95/p99 statistics, and per-system timing table.

### Debug Toggles
Wireframe, hitboxes, normals, velocity, shadows, bloom, AABBs, overdraw, LOD visualization, depth buffer, and tangents.

### Chrome DevTools Extension
A custom DevTools extension (`devtools-extension/`) provides a 3D Scene Inspector when loaded into Chromium DevTools.

## Vision Test Suite

```typescript
import { VisionTestSuite } from "@downdraft/core";

const suite = new VisionTestSuite(device, canvas, 800, 600);
// Supports pixel-level assertions, region color checks, and LLM-based visual verification
```

See `tests/` for example scene tests and pixel scan utilities.

## Tutorials

### Creating Your First Scene

```typescript
import { Camera, Component, MeshBuilder, World } from "@downdraft/core";

const world = new World();
const camera = new Camera();
camera.setAspect(16, 9);
camera.distance = 5;
world.setResource("camera", camera);

const mesh = MeshBuilder.cube(1);
world.setResource("cubeMesh", mesh);
```

See `examples/minimal/main.ts` for a complete minimal example and `examples/physics-demo/main.ts` for a physics demo with spawning entities and components.

### Adding Particles

```typescript
import { ParticleSystem, createSmokeEmitter } from "@downdraft/core";

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
particles.render(renderCtx, camera.viewProj, camera.position);
```

### Using Plugins

```typescript
import { GameWorld, Scene, World } from "@downdraft/core";
import { PhysicsRapierPlugin } from "@downdraft/plugin-physics-rapier";
import { AudioKiraPlugin } from "@downdraft/plugin-audio-kira";
import { WaterPlugin } from "@downdraft/plugin-water";
import { MarchingCubesPlugin } from "@downdraft/plugin-marching-cubes";
import { NetworkingPlugin } from "@downdraft/plugin-networking";

const gameWorld = new GameWorld(new Scene(new World()));

gameWorld.usePlugin(PhysicsRapierPlugin);
gameWorld.usePlugin(AudioKiraPlugin);
gameWorld.usePlugin(WaterPlugin);
gameWorld.usePlugin(MarchingCubesPlugin);
gameWorld.usePlugin(NetworkingPlugin);
```

## License

MIT
