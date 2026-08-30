# DownDraft Engine

An AI-Driven Game Engine built on **Electron + electron-vite + WebGPU** (TypeScript-first, optional Rust native modules for audio), with a built-in MCP server enabling AI agents to design, build, debug, and manage assets for games via natural language prompts.

## Quick Start

```bash
# Install dependencies
bun install

# Run a game from its own directory (each game owns its electron.vite.config.ts)
cd games/<your-game>
draft dev

# Build + package for distribution (desktop + mobile)
draft release

# Build only (Vite bundle, no packaging)
draft release --stage=build
```

## Game-Bootstrapped Host Layer

Games bootstrap by calling engine-exported host methods from their own `src/main.ts` and `src/preload.ts`. The engine obscures Electron's main/preload/renderer machinery behind a config-driven surface — devs set config, rarely touch raw Electron APIs.

```ts
// games/my-game/src/main.ts
import { createDowndraftApp, webGpuSwitches } from "@downdraft/app/main";

createDowndraftApp({
  window: { title: "My Game", width: 1920, height: 1080 },
  switches: webGpuSwitches(),
  features: { saves: { engineVersion: "0.1.0" }, osr: true, mcp: { port: 9876 } },
});
```

See `AGENTS.md` for the full host SDK reference (subpath exports, config-driven features, `extend` escape hatch).

## Architecture

```
┌─────────────────────────────────────────────┐
  Electron Main Process (game-owned src/main.ts)
    • Calls createDowndraftApp() from @downdraft/app/main
    • Window lifecycle, display info, IPC (config-driven)
    • GC profiling, performance stats
├─────────────────────────────────────────────┤
  Renderer Process (BrowserWindow)
    ┌───────────────────┐  ┌───────────────────┐
    │  WebGPU Canvas    │  │  React UI Overlay │
    │  (RenderLoop)     │  │  (DevTools, HUD)  │
    └────────┬──────────┘  └───────────────────┘
             │ SharedArrayBuffer (zero-copy)
    ┌────────┴───────────┐
    │  Sim Web Worker    │
    │  (ECS World,       │
    │   game systems,    │
    │   physics, plugins)│
    └────────────────────┘
└─────────────────────────────────────────────┘
```

- **Electron Main Process** — Window/lifecycle management, IPC handlers, GC/perf profiling, save/load (filesystem-based `FileSaveStore`). No render loop here. No IPC bottlenecks, no complexity.
- **Renderer Process** — React UI overlay + WebGPU `<canvas>` rendering. The `RenderLoop` runs here via `requestAnimationFrame`. Persistence uses an OPFS Web Worker for renderer-side saves.
- **Sim Web Worker** — Spawned from the renderer. Runs the ECS `World`, game systems, physics, and plugins. Communicates with the renderer via `SharedArrayBuffer` (zero-copy) and postMessage events.

## Packages

### Engine core

| Package | Description |
|---|---|
| `@downdraft/core` | Engine core: ECS, render passes, render graph, SAB, input, telemetry, plugins, particles, animation, physics, audio, assets, save system |
| `@downdraft/app` | Electron app shell: main process, preload, renderer entry |
| `@downdraft/ui` | React UI: devtools panel, profiler, material graph editor, animation state machine editor, asset browser |
| `@downdraft/mcp` | MCP server for AI agent interaction (JSON-RPC over stdio) |
| `@downdraft/shader-graph` | Material/shader graph compiler and validator |
| `@downdraft/cli` | CLI tool (`draft new/dev/debug/release/assets/test`) |

### Engine libraries (`packages/libraries/`)

Engine libraries export `EngineLibrary` descriptors (e.g. `WaterLib`, `PhysicsRapierLib`) for declarative wiring in `GameModule.libraries[]`, plus bare class exports as an escape hatch.

| Package | Description |
|---|---|
| `@downdraft/library-water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
| `@downdraft/library-marching-cubes` | Voxel terrain with LOD and deformation |
| `@downdraft/library-surface-nets` | Surface-nets mesh extraction from voxel fields |
| `@downdraft/library-physics-rapier` | Rapier3D physics backend |
| `@downdraft/library-physics-native` | Native physics backend |
| `@downdraft/library-audio-kira` | Kira audio backend (Rust FFI via `packages/libraries/audio-kira/native`) |
| `@downdraft/library-networking` | WebSocket transport, state replication, RPCs |
| `@downdraft/library-weather` | Weather system |
| `@downdraft/library-weatherfx` | Weather visual effects |
| `@downdraft/library-lighting` | Lighting system |
| `@downdraft/library-postfx` | Post-processing effects |
| `@downdraft/library-entities` | Generic model renderer used by multiple games |
| `@downdraft/library-models` | Model loading and management |
| `@downdraft/library-animation` | Animation system |
| `@downdraft/library-particles` | Particle system and emitters |
| `@downdraft/library-navmesh` | Navigation mesh generation and pathfinding |
| `@downdraft/library-persistence` | Save/load (filesystem + OPFS worker) |
| `@downdraft/library-gaussian-splats` | Gaussian splat rendering |
| `@downdraft/library-sand` | Falling-sand simulation |
| `@downdraft/library-stickman` | Stickman character system |
| `@downdraft/library-undertow` | Worker-side UI (Solid-in-worker DOM sync) |
| `@downdraft/library-imui` | Immediate-mode UI |

### Engine plugins (`packages/plugins/`)

Feature plugins use the factory pattern (`createXxxPlugin(config)`) and provide typed DI tokens. Games register them via `pluginHost.usePlugins([...])`.

| Package | Description |
|---|---|
| `@downdraft/plugin-camera-controls` | Camera input and control modes |
| `@downdraft/plugin-devtools` | DevTools overlay panel + Chromium DevTools extension (3D Scene Inspector) |
| `@downdraft/plugin-electron-osr` | Electron offscreen rendering |
| `@downdraft/plugin-mcp` | In-game MCP automation harness |
| `@downdraft/plugin-xr` | WebXR / VR support |
| `@downdraft/plugin-terrain` | Terrain system |
| `@downdraft/plugin-movement-3d` | 3D movement system |
| `@downdraft/plugin-movement-2d` | 2D movement system |
| `@downdraft/plugin-sailing` | Sailing mechanics |

### Game plugins / libraries (`games/<game>/plugins/`)

Game-specific features live under each game's `plugins/` directory. No engine package depends on any game package. Games organize their features as `@<game-scope>/plugin-*` (lifecycle + typed DI) or `@<game-scope>/library-*` (bare classes) packages, following the same engine library/plugin split described above.

## CLI Commands

The CLI is available via `bun run packages/cli/src/index.ts <command>` or as `draft` if installed globally. Run `draft --help` for the full command list, or `draft <command> --help` for command-specific flags. See the [CLI reference](https://downdraft.dev/reference/cli) for complete documentation.

### `draft new [path] [options]`
Scaffolds a new game project.
- `--template=<name>` — `minimal` / `physics` / `full` / `gamemodule` (default: `minimal`)
- `--name=<n>` — Project name
- `--ai-companion` — Scaffold `.devin/` config + `engine-prompt.md`
- `--force` — Scaffold into a non-empty directory
- `--list-templates` — List available templates

### `draft dev [options]`
Starts the engine in dev mode via `electron-vite dev` with HMR, loading the game's own `games/<game>/electron.vite.config.ts` entrypoint.
- `--game <name>`, `-g` — Game to run (resolves `games/<game>/electron.vite.config.ts` from the engine root). If omitted, `draft dev` walks up from the current directory looking for `electron.vite.config.ts` — so you can run `draft dev` from inside a game directory.
- `--port <n>` — MCP HTTP port (default: `9876`)
- `--no-hmr` — Disable hot-module replacement

> **Note:** Each game owns its own `electron.vite.config.ts` entrypoint. Run `draft dev` from the game directory (the scaffolded `package.json` sets `"dev": "draft dev"`), or use `--game <name>` from the engine root. You can also run `npx electron-vite dev --config games/<game>/electron.vite.config.ts` directly.

### `draft debug [path] [options]`
Runs the engine in debug mode with profiling, debug draw, and visualization tools. `path` defaults to `.`.
- `--verbose, -v` — Verbose logging
- `--no-devtools` — Disable devtools overlay
- `--inspector` — Enable Node inspector

### `draft build [path] [options]`
Builds the game for the target platform. `path` defaults to `.` (use `--game` to target `games/<game>` instead).
- `--game <name>`, `-g` — Game to build (resolves `games/<game>`)
- `--target=<t>` — Target: `current` / `win` / `linux` / `mac` (default: `current`)
- `--mode=<m>` — Build mode: `dev` / `debug` / `prod` (default: `prod`)
- `--out=<dir>` — Output directory (default: `dist`)
- `--no-minify` — Disable minification
- `--sourcemap` — Generate source maps

### `draft build-games [options]`
Builds + packages multiple games for desktop/mobile (VSCode task).
- `--games=<csv>` — Comma-separated game names (required)
- `--platforms=<csv>` — Comma-separated platform specs (required, e.g. `win:portable,android:all`)

### `draft dist [options]`
Packages a game for distribution via `electron-builder`.
- `--game <name>`, `-g` — Game to package
- `--target <t>`, `-t` — `win` / `linux` / `mac` / `all` (default: `all`)
- `--config <path>`, `-c` — Explicit config file path

### `draft export [path] [options]`
Packages a built game for distribution with per-platform launchers. `path` defaults to `.`.
- `--target=<t>` — Target: `win` / `linux` / `mac` / `all` (default: `all`)
- `--out=<dir>` — Output directory (default: `export`)
- `--no-compress` — Disable compression

### `draft mobile [options]`
Builds + scaffolds a Capacitor mobile target (Android / iOS).
- `--game <name>`, `-g` — Game to build
- `--target <t>`, `-t` — `android` / `ios` / `all` (default: `all`)
- `--port <n>` — Embedded HTTP server port (default: `8765`)
- `--skip-build` — Skip the web bundle build
- `--skip-gradle` — Skip the Gradle APK build
- `--no-icons` — Skip icon generation
- `--no-overrides` — Skip `mobile-overrides/` merge layer

### `draft assets <command> [project] [options]`
Manages remote asset packs.
- Subcommands: `init`, `add-store`, `add`, `pull`, `push`, `list`
- Run `draft assets <subcommand> --help` for subcommand flags.

### `draft test [options]`
Runs e2e tests via `bun:test` (SwiftShader + deterministic by default). The default smoke specs drive the game through the in-game MCP RPC harness, but `--spec` can point at any `bun:test` file.
- `--game <name>`, `-g` — Game to test
- `--renderer <r>`, `-r` — `cpu` (SwiftShader) / `gpu` (hardware) (default: `cpu`)
- `--headed` — Show the window instead of running headless
- `--build` — Build the game before testing
- `--build-only` — Only test the built app (skip dev server)

## Editor UI

### DevTools Panel
Overlay panel with debug toggles, telemetry graphs, entity inspector, and asset loader. Conditionally rendered by the host (toggle via the host's show/hide control).

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

### Chrome DevTools Extension
A custom DevTools extension (`packages/plugins/devtools/extension/`) provides a 3D Scene Inspector when loaded into Chromium DevTools.

## Tutorials

### Creating Your First Scene

```typescript
import { Camera, Component, MeshBuilder, resourceToken, World } from "@downdraft/core";

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
particles.render(renderCtx, camera.getViewProjectionMatrix(), camera.position);
```

### Using Plugins

Engine libraries expose `EngineLibrary` descriptors and are wired declaratively via `startGame()`:

```typescript
import { startGame } from "@downdraft/app/renderer";
import { PhysicsRapierLib } from "@downdraft/library-physics-rapier";
import { AudioKiraLib } from "@downdraft/library-audio-kira";
import { WaterLib } from "@downdraft/library-water";
import { MarchingCubesLib } from "@downdraft/library-marching-cubes";
import { NetworkingLib } from "@downdraft/library-networking";

startGame({
  libraries: [PhysicsRapierLib, AudioKiraLib, WaterLib, MarchingCubesLib, NetworkingLib],
  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: (seed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345, gamemode: 0, rules: {} },
  mountUI: (overlay) => { /* React/Solid mount */ },
});
```

Feature plugins (e.g. `@downdraft/plugin-terrain`, `@downdraft/plugin-movement-3d`) use the factory pattern and are activated via `pluginHost.usePlugins([...])`. See `AGENTS.md` for the full plugin/library contract.

## Mobile Development (Android)

DownDraft games can be built for Android via Capacitor (system WebView). The engine owns a pre-wired native shell at `packages/mobile-shell/` — games commit zero native files. See `docs/site/src/content/docs/guides/mobile.md` for the full guide.

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Android Studio** | Any recent | Includes SDK + emulator. Download from https://developer.android.com/studio |
| **Android SDK** | API 36+ | Install via Android Studio's SDK Manager |
| **JDK** | 21+ | `sudo apt install openjdk-21-jdk` (set `JAVA_HOME` to the JDK home) |
| **Capacitor deps** | — | `bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios` |
| **Android WebView** | 121+ | Required for WebGPU. Emulators with Google Play services include a compatible WebView. |

### Environment variables

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
```

### Build + run a game on Android

1. **Build + run on device/emulator** — use the VSCode task `Android: <game> (build + run on device/emulator)`, or run manually:

   ```bash
   # Build web bundle + scaffold Android project
   bun run packages/cli/src/index.ts mobile --game=<your-game> --target=android

   # Assemble debug APK
   cd games/<your-game>/android
   echo "sdk.dir=$ANDROID_HOME" > local.properties
   ./gradlew assembleDebug

   # Install + launch (starts emulator if none connected)
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb shell "echo 'webview --enable-features=SharedArrayBuffer' > /data/local/tmp/webview-command-line"
   adb shell am start -n com.downdraft.<your-game>/com.downdraft.shell.MainActivity
   ```

   The VSCode task automates all of this — including starting an emulator if no device is connected and enabling the SharedArrayBuffer flag. The app starts an embedded HTTP server (COOP/COEP headers for SharedArrayBuffer) and loads the WebView from `http://127.0.0.1:8765`.

2. **Open in Android Studio** (optional, for debugging native code):

   ```bash
   cd games/<your-game> && bunx cap open android
   ```

### SharedArrayBuffer on Android WebView

Android WebView does not support cross-origin isolation (`self.crossOriginIsolated` is always `false` even with COOP/COEP headers). The engine's boot guard checks for WebGPU (`navigator.gpu`) directly rather than relying on `crossOriginIsolated`, and transparently polyfills `SharedArrayBuffer` when the native constructor is unavailable — so games run on Android WebView regardless of whether real SAB is enabled.

For **debug builds** on emulators or physical devices, enable SAB via the WebView command-line flag:

```bash
adb shell "echo 'webview --enable-features=SharedArrayBuffer' > /data/local/tmp/webview-command-line"
# Force-stop and relaunch the app for the flag to take effect
```

> **Note:** `/data/local/tmp/webview-command-line` is only writable via `adb` (not from inside the app). Production builds must enable SAB through the WebView provider's configuration or a custom WebView build. See the [Android WebView command-line flags docs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/android_webview/docs/commandline-flags.md) for details.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Blank screen / "Webpage not available" | Add `network_security_config.xml` allowing cleartext to `127.0.0.1` (already in the engine shell) |
| "SharedArrayBuffer is not available" | Set the `--enable-features=SharedArrayBuffer` WebView flag (see above) |
| "WebGPU is not available" | Use an emulator with Google Play services (includes WebView 121+) or a physical device with Chrome 121+ |
| Build fails: `JAVA_HOME` not set | `export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64` |
| Build fails: `sdk.dir` not found | `echo "sdk.dir=$ANDROID_HOME" > games/<your-game>/android/local.properties` |

### WebGPU on the Android emulator — known limitation

The Android emulator's GPU translation layer does **not** expose a WebGPU-compatible backend to Dawn (Chrome's WebGPU implementation). `navigator.gpu` exists and `canvas.getContext('webgpu')` returns an object, but `navigator.gpu.requestAdapter()` returns `null` regardless of:

- GPU mode (`-gpu host`, `-gpu swiftshader_indirect`)
- WebView command-line flags (`--enable-unsafe-webgpu`, `--ignore-gpu-blocklist`, `--use-webgpu-adapter=opengles`)
- Compatibility mode (`requestAdapter({ featureLevel: "compatibility" })`)
- Emulator features (`-feature GLESDynamicVersion`, `VulkanIgnoreGraphicsExtsWSI`)

Forcing Vulkan (`--use-vulkan`) crashes the emulator's GPU process with SIGSEGV.

**Result:** The game UI (React) renders correctly, but the WebGPU canvas stays blank — `renderer.init()` returns `false` because no adapter is available. The sim worker runs but the render loop never starts.

**To test WebGPU on Android, use a physical device** with Chrome 121+ (Mali/Adreno GPUs). The emulator can be used to verify the build pipeline, UI layout, touch input, and sim worker — but not WebGPU rendering.

## License

MIT
