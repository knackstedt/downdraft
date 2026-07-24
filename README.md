# DownDraft Engine

An AI-Driven Game Engine built on Electrobun + Bun + WGPU (TypeScript-first, Rust FFI for hotspots), with a built-in MCP server enabling AI agents to design, build, debug, and manage assets for games via natural language prompts.

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Scaffold a new game
bun run packages/cli/src/index.ts init my-game

# Start dev server
cd my-game
draft dev

# Debug mode with profiling
draft debug --verbose

# Build for production
draft build --mode=prod --out=dist

# Export for distribution
draft export --target=all --out=export
```

## Architecture

- **Bun Main Process** — Engine orchestrator, render loop (GpuWindow + WGPU), MCP server
- **Sim Worker** — ECS world, game systems, physics, AI, plugins
- **DB Worker** — Persistence layer with schema versioning
- **BrowserWindow** — React UI overlay (transparent, composites over GpuWindow)

## Packages

| Package | Description |
|---|---|
| `@downdraft/core` | Engine core: ECS, render, SAB, input, telemetry, plugins, particles, debug viz |
| `@downdraft/ui` | React UI: editor panels, devtools, material graph, animation editor, asset browser, profiler |
| `@downdraft/mcp` | MCP server for AI agent interaction |
| `@downdraft/shader-graph` | Material/shader graph compiler |
| `@downdraft/cli` | CLI tool (`draft init/dev/debug/build/export`) |
| `@downdraft/plugin-water` | Gerstner wave water rendering |
| `@downdraft/plugin-marching-cubes` | Voxel terrain with LOD |
| `@downdraft/plugin-physics-rapier` | Rapier3D physics backend |
| `@downdraft/plugin-audio-kira` | Kira audio backend |
| `@downdraft/plugin-networking` | WebSocket transport, state replication, RPCs |

## CLI Commands

### `draft init [path]`
Scaffolds a new game project with directory structure, `main.ts` entry point, and `downdraft.config.json`.

### `draft dev [options]`
Starts the dev server with hot module replacement, devtools overlay, and telemetry.
- `--port=<n>` — Dev server port (default: 3000)
- `--verbose, -v` — Verbose logging

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
import { Component, World, System } from "@downdraft/core";

// Define a component
const Health = Component.register("Health", {
  current: 100,
  max: 100,
  [key: string]: unknown,
});

// Create a world
const world = new World();
const entity = world.spawn(Health.create({ max: 200 }));

// Register a system
class DamageSystem extends System {
  update(world: World, dt: number) {
    for (const [entity, health] of world.query(Health)) {
      health.current = Math.max(0, health.current - dt * 10);
    }
  }
}
```

### Rendering

```typescript
import { RenderLoop, MaterialLibrary } from "@downdraft/core";

const renderLoop = new RenderLoop(device, surfaceFormat);
renderLoop.addPass("opaque", opaquePass);

const materials = new MaterialLibrary();
const pbr = materials.createPBR("my-pbr", {
  baseColor: [0.8, 0.2, 0.2, 1.0],
  metallic: 0.5,
  roughness: 0.3,
});
```

### Particle System

```typescript
import { ParticleSystem, createFireEmitter } from "@downdraft/core";

const particles = new ParticleSystem({ maxParticlesPerEmitter: 5000 });
particles.prepare(device);

const emitterId = particles.registerEmitter(
  createFireEmitter({ position: [0, 1, 0] })
);

// In update loop:
particles.update(dt);

// In render loop:
particles.render(ctx, viewProj, cameraPos);
```

### Physics

```typescript
import { PhysicsRealm, RigidBody, Collider } from "@downdraft/core";
import { PhysicsRapierPlugin } from "@downdraft/plugin-physics-rapier";

const realm = new PhysicsRealm({ gravity: [0, -9.81, 0] });
// Or use the plugin: world.loadPlugin(PhysicsRapierPlugin);
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

### Audio

```typescript
import { AudioEngine, createAudioSource } from "@downdraft/core";
import { AudioKiraPlugin } from "@downdraft/plugin-audio-kira";

world.loadPlugin(AudioKiraPlugin);
const source = createAudioSource({ buffer: "explosion.wav", volume: 0.8 });
```

### Networking

```typescript
import { NetworkingPlugin, ReplicationManager } from "@downdraft/plugin-networking";

world.loadPlugin(NetworkingPlugin);
// Server: replication.update(dt) sends snapshots
// Client: snapshots auto-applied to entity components
```

## Editor UI

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

## Vision Test Suite

```typescript
import { runExampleSceneTests, printTestSummary } from "./tests/example-scenes.ts";

const results = await runExampleSceneTests(device, canvas, 800, 600);
printTestSummary(results.summary);
```

Supports pixel-level assertions, region color checks, and LLM-based visual verification.

## Tutorials

### Creating Your First Scene

```typescript
import { GameWorld, createTransform, createMesh } from "@downdraft/core";

const world = new GameWorld();

// Spawn a cube
const cube = world.spawn(
  createTransform({ position: [0, 0, 0] }),
  createMesh({ geometry: "cube", material: "my-pbr" }),
);

// Add a light
world.spawn(
  createTransform({ position: [5, 10, 5] }),
  createLight({ type: "directional", intensity: 1.0 }),
);
```

### Adding Particles

```typescript
import { ParticleSystem, createSmokeEmitter } from "@downdraft/core";

const particles = new ParticleSystem();
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
world.loadPlugin(PhysicsRapierPlugin);
world.loadPlugin(AudioKiraPlugin);
world.loadPlugin(WaterPlugin);
world.loadPlugin(MarchingCubesPlugin);
world.loadPlugin(NetworkingPlugin);
```

## License

MIT
