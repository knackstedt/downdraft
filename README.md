# DownDraft Engine

An AI-Driven Game Engine built on **Electron + electron-vite + WebGPU** (TypeScript-first, optional Rust native modules for audio), with a built-in MCP server enabling AI agents to design, build, debug, and manage assets for games via natural language prompts.

## Quick Start

```bash
# Install dependencies
bun install

# Run a specific game (each game owns its own electron.vite.config.ts entrypoint)
draft dev --game=to-the-ocean
draft dev --game=model-viewer

# Build for production
draft build --mode=prod --out=dist

# Package for distribution
draft export --target=all --out=export
```

## Game-Bootstrapped Host Layer

Games bootstrap themselves by calling engine-exported host methods from their own `src/main.ts` and `src/preload.ts`. The engine obscures Electron's main/preload/renderer machinery behind a config-driven surface — devs set config, rarely touch raw Electron APIs.

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
| `@downdraft/cli` | CLI tool (`draft new/dev/debug/build/build-games/dist/export/mobile/assets/test`) |
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
- `--game <name>`, `-g` — Game to run (required; loads `games/<game>/electron.vite.config.ts`)
- `--port <n>` — MCP HTTP port (default: `9876`)
- `--no-hmr` — Disable hot-module replacement

> **Note:** Each game owns its own `electron.vite.config.ts` entrypoint. `draft dev --game=<name>` loads it directly — there is no root dispatcher or `DOWNDRAFT_GAME` env var. You can also run `npx electron-vite dev --config games/<game>/electron.vite.config.ts` directly.

### `draft debug [options]`
Runs the engine in debug mode with profiling, debug draw, and visualization tools.
- `--verbose, -v` — Verbose logging
- `--no-devtools` — Disable devtools overlay
- `--inspector` — Enable Node inspector

### `draft build [options]`
Builds the game for the target platform.
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

### `draft export [options]`
Packages a built game for distribution with per-platform launchers.
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
- Run `draft assets --help` for subcommand flags.

### `draft test [options]`
Runs e2e tests via MCP automation (SwiftShader + deterministic by default).
- `--game <name>`, `-g` — Game to test
- `--renderer <r>`, `-r` — `cpu` (SwiftShader) / `gpu` (hardware) (default: `cpu`)
- `--headed` — Show the window instead of running headless
- `--build` — Build the game before testing
- `--build-only` — Only test the built app (skip dev server)

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

### Build + run sandjongg on Android

1. **Build + run on device/emulator** — use the VSCode task `Android: Sandjongg (build + run on device/emulator)`, or run manually:

   ```bash
   # Build web bundle + scaffold Android project
   bun run packages/cli/src/index.ts mobile --game=sandjongg --target=android

   # Assemble debug APK
   cd games/sandjongg/android
   echo "sdk.dir=$ANDROID_HOME" > local.properties
   ./gradlew assembleDebug

   # Install + launch (starts emulator if none connected)
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb shell "echo 'webview --enable-features=SharedArrayBuffer' > /data/local/tmp/webview-command-line"
   adb shell am start -n com.downdraft.sandjongg/com.downdraft.shell.MainActivity
   ```

   The VSCode task automates all of this — including starting an emulator if no device is connected and enabling the SharedArrayBuffer flag. The app starts an embedded HTTP server (COOP/COEP headers for SharedArrayBuffer) and loads the WebView from `http://127.0.0.1:8765`.

2. **Open in Android Studio** (optional, for debugging native code):

   ```bash
   cd games/sandjongg && bunx cap open android
   ```

### SharedArrayBuffer on Android WebView

Android WebView does not support cross-origin isolation (`self.crossOriginIsolated` is always `false` even with COOP/COEP headers). The engine's boot guard checks for `SharedArrayBuffer` directly instead of relying on `crossOriginIsolated`.

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
| Build fails: `sdk.dir` not found | `echo "sdk.dir=$ANDROID_HOME" > games/sandjongg/android/local.properties` |

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
