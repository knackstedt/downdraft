# Downdraft Engine — Agent Notes

## Plugin architecture: engine vs game boundary

The engine is split into **core + libraries** (standard engine building blocks, used directly by games) vs **plugins** (opt-in game features with lifecycle + typed DI + diagnostics).

- **Engine libraries** (namespace `@downdraft/library-*`, located in `packages/libraries/`): packages that export classes/functions without a plugin lifecycle. Games can either import and wire these directly, or declare them via `EngineLibrary` descriptors in `GameModule.libraries[]` for auto-wiring (SAB allocation, sim system creation, renderer pass creation, typed DI tokens). Engine libraries: water, physics-rapier, physics-native, marching-cubes, surface-nets, audio-kira, models, networking, weatherfx, undertow, entities, lighting, weather, postfx, navmesh, persistence, gaussian-splats, sand, stickman.
- **Engine plugins** (namespace `@downdraft/plugin-*`, located in `packages/plugins/`): packages that implement the `Plugin` or `RendererPlugin` interface with a `register()` lifecycle + typed DI. Engine plugins: camera-controls, devtools, electron-osr, mcp, xr, terrain, movement-3d, movement-2d, sailing.
- **Game plugins** (namespace `@to-the-ocean/plugin-*` / `@to-the-ocean/library-*`, located in `games/<game>/plugins/`): game-specific features. Game plugins: crafting, inventory. Game libraries: boats, fishing, economy, survival, wildlife, items, buoyancy, collision.

### Declarative GameModule + startGame()

Games declare their renderer-side bootstrap as a `GameModule` and call `startGame()` from `@downdraft/app/renderer`. This replaces the old `bootstrapGame()` callback-soup with a declarative module:

```ts
startGame({
  libraries: [WaterLib],                    // engine library descriptors
  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: (seed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345, gamemode: 0, rules: {} },
  mountUI: (overlay) => { /* React/Solid mount */ },
  events: { weather_changed: (data, ctx) => store.setWeather(data) },
  save: { mode: "auto", engineVersion: "0.1.0" },
  onReady: (ctx) => { /* game-specific wiring */ },
  onDispose: (ctx) => { /* cleanup */ },
});
```

`startGame()` handles: library SAB allocation, sim worker spawn, event routing, save store init, renderer create+init, render loop, FPS polling, display info, hot-reload dispose, deterministic mode. `bootstrapGame()` remains available for games that need full control.

### Engine library descriptors

Engine libraries expose `EngineLibrary` descriptors (e.g. `WaterLib`, `PhysicsRapierLib`, `MarchingCubesLib`) for declarative wiring in `GameModule.libraries[]`. The `LibraryHost` auto-wires SAB allocation, sim systems, renderer passes, and typed DI tokens. Bare class exports remain as an escape hatch.

### Feature plugins

Feature plugins (`@downdraft/plugin-terrain`, `@downdraft/plugin-movement-3d`, `@downdraft/plugin-movement-2d`, `@downdraft/plugin-sailing`) use the factory pattern (`createXxxPlugin(config)`) and provide typed DI tokens. Games register them via `pluginHost.usePlugins([...])` for batch activation in dependency-resolved order.

### Cross-thread plugin contract

`CrossThreadToken<T>` tags resources with a thread ("sim" | "renderer" | "shared"). `buildCrossThreadReport()` detects unresolved requires, shared resources, and version conflicts across sim + renderer plugin hosts. The `downdraft doctor` devtools panel displays this report.

### Migration guide (from old API)

1. **String-based resources → typed tokens**: Replace `world.setResource("name", value)` / `world.getResource("name")` with `resourceToken<T>("name")` + `ctx.provide(token, value)` / `ctx.inject(token)`.
2. **bootstrapGame() callbacks → startGame() module**: Replace the callback-soup `main.tsx` with a declarative `GameModule`. Move sim event handling into `events: {}`, game-specific wiring into `onReady`, cleanup into `onDispose`.
3. **Manual library wiring → EngineLibrary descriptors**: Replace manual SAB allocation + system instantiation with `libraries: [WaterLib, ...]` in the GameModule. Use typed tokens to inject library-provided resources.
4. **registerPluginDeferred + activateAll → usePlugins**: Replace the two-step batch registration with `pluginHost.usePlugins([...])`.

### Engine library descriptors (Phase 3)

Engine libraries can expose an `EngineLibrary` descriptor (e.g. `WaterLib`, `PhysicsRapierLib`, `MarchingCubesLib`) that lets games declare them declaratively in `GameModule.libraries[]`:

```ts
import { WaterLib, PhysicsRapierLib } from "@downdraft/library-water";

startGame({
  libraries: [WaterLib, [PhysicsRapierLib, { maxEntities: 8192 }]],
  // ...
});
```

The `LibraryHost` auto-wires each library: allocates SAB channels, creates sim-side systems, creates renderer-side passes, and registers provided resources in the DI graph via typed tokens (e.g. `WaterWriterTok`, `WaterReaderTok`, `PhysicsAPITok`). Games inject these tokens from `GameContext` in their `onReady` hook.

Bare class exports remain as an escape hatch — games that need full control can still import and wire `WaterBufferWriter`, `RapierPhysicsBackend`, etc. directly.

No engine package depends on any game package (verified). The `entities` library is an engine library (generic `ModelRenderer` used by multiple games). When adding a new game, create `games/<game>/plugins/` for its game-specific systems.

### Typed DI (provide/inject + provides/requires)

Plugins use typed `ResourceToken<T>`-based dependency injection instead of stringly-typed resource names:

```ts
import { resourceToken, type Plugin } from "@downdraft/core";

export const WeatherState = resourceToken<WeatherStateData>("weatherState");

export const SailingPlugin: Plugin = {
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

- `ctx.provide(token, value)` — typed write; in `DOWNDRAFT_STRICT` mode throws on duplicate key.
- `ctx.inject(token)` — typed read; throws if the token has no provider (use `injectOptional` for safe reads).
- `provides`/`requires` arrays — the host validates the dependency graph at activation, before any `register()` runs. Missing provider → hard error naming both plugins.
- The stringly-typed `registerResource(name, value)` / `getResource(name)` API has been **removed**. Use `resourceToken<T>(key)` + `provide`/`inject` instead.

### DOWNDRAFT_STRICT diagnostics

When `DOWNDRAFT_STRICT=1` (or in Vite dev mode), the plugin hosts validate the dependency graph and catch common footguns:
- Duplicate `provide` → hard error.
- Missing `requires` provider at activation → hard error.
- Leak detection: plugin provides resources / allocates SAB channels but registers no `onDispose()` cleanup → warning on unload.

Set `DOWNDRAFT_STRICT=0` to force-disable in dev, `DOWNDRAFT_STRICT=1` to force-enable in prod.

Config that must be updated when moving/adding packages: `package.json` (root workspaces), `tsconfig.web.json` + `tsconfig.node.json` (path mappings + include globs), `packages/app/src/vite/index.ts` (renderer aliases + hot-reload simPaths/excludePaths). Engine libraries live in `packages/libraries/`; engine plugins live in `packages/plugins/`.

## HTML generation and canvas/DOM layer stacking

The framework generates `index.html` from a layer spec, so games don't need to maintain their own HTML or CSS stacking rules.

### How it works

- `createDowndraftViteConfig()` accepts an `html` option (or `layers` shorthand). When provided, the `downdraftHtmlPlugin` generates `index.html` at build/dev time with the correct canvas + DOM overlay structure.
- Default: one canvas (`<canvas data-dd-layer="0" id="game-canvas">`) + one DOM root (`<div data-dd-overlay="0" id="root">`).
- Games with multiple canvases (e.g. minimap + main) can specify multiple `layers`.
- The framework provides `@downdraft/app/renderer/downdraft-base.css` with the stacking rules (canvases at `z-index: 0`, overlays at `z-index: 100`, `pointer-events: none` on overlays). Games import it and add theme overrides.
- Renderer code uses `getCanvas(layer)` and `getOverlay(index)` from `@downdraft/app/renderer` instead of `document.getElementById`.
- Games that want to keep their own `index.html` can set `html: false` to opt out.

### Files

- `packages/app/src/vite/downdraft-html-plugin.ts` — Vite plugin that generates HTML from `LayerSpec[]`.
- `packages/app/src/renderer/downdraft-base.css` — framework base CSS with canvas/overlay stacking.
- `packages/app/src/renderer/index.ts` — exports `getCanvas()`, `getOverlay()`, `getAllCanvases()`.
- `packages/app/src/vite/index.ts` — `DowndraftViteConfigOptions.html` and `.layers` options.

## Per-game storage isolation

Each game MUST pass a unique `appId` to `createDowndraftApp()`. This sets a per-game Electron `userData` directory (e.g. `~/.config/downdraft-mining-rpg/`) so that Chromium storage subsystems (OPFS, IndexedDB, Service Worker DB, cookies, cache) are fully isolated per game. Without this, all games share the same `--user-data-dir` and concurrent instances corrupt each other's LevelDB locks (`File System/Origins/LOCK`, `Service Worker/LOCK`), causing OPFS init failures and games not loading.

When `appId` is set, `createDowndraftApp()` also:
1. Calls `app.requestSingleInstanceLock()` — prevents two instances of the same game from running concurrently (which would corrupt storage). A second launch focuses the existing window and quits.
2. Calls `cleanupStaleStorage()` — removes stale LevelDB `LOCK` files and `.org.chromium.Chromium.*` temp artifacts from a previous run that crashed or was killed. Safe because the single-instance lock guarantees no live process is using the directory.

### Files

- `packages/app/src/main/storage.ts` — `resolveUserDataDir()` (builds the per-game path) and `cleanupStaleStorage()` (stale lock + temp file cleanup).
- `packages/app/src/main/app.ts` — wires `app.setPath("userData", ...)` + `requestSingleInstanceLock()` + `cleanupStaleStorage()` early in `createDowndraftApp()`, before `app.whenReady()`.

### Adding a new game

Always set `appId` in the game's `src/main.ts`:
```ts
createDowndraftApp({
  appId: "downdraft-my-game",  // → ~/.config/downdraft-my-game/
  window: { title: "My Game" },
  // ...
});
```

## Cross-origin isolation: COEP and file:// worker loading

The engine sets `Cross-Origin-Opener-Policy: same-origin` (COOP) and `Cross-Origin-Embedder-Policy: require-corp` (COEP) on all responses to enable `SharedArrayBuffer` via cross-origin isolation. **However, COEP is only set for non-`file://` responses.**

In packaged builds, the renderer loads via `win.loadFile()` → `file://` protocol. Chromium blocks Web Worker creation from `file://` when the parent page has `COEP: require-corp` — the worker script is **never fetched** and `Worker.onerror` fires with `message: undefined`, `filename: undefined`, `lineno: undefined`. This silently breaks ALL game workers (mining-worker, sand-step-worker, save-worker, solid-worker, etc.) in production builds. In dev mode the renderer loads from `http://localhost:5173` (Vite dev server), where COEP works fine — which is why this bug only appears in packaged builds.

`SharedArrayBuffer` still works in packaged builds without COEP because `webPreferences.enableBlinkFeatures: "SharedArrayBuffer"` is set on the BrowserWindow, which enables SAB regardless of cross-origin isolation.

**Never add `Cross-Origin-Embedder-Policy: require-corp` unconditionally to all responses.** Always check `details.url.startsWith("file:")` and skip COEP for file:// URLs. The header logic is extracted into `buildCrossOriginIsolationHeaders()` in `packages/app/src/main/window.ts` and covered by `packages/app/src/main/window.spec.ts`.

### Files

- `packages/app/src/main/window.ts` — `buildCrossOriginIsolationHeaders()` (the header logic) + `createWindow()` (wires it into `session.defaultSession.webRequest.onHeadersReceived`).
- `packages/app/src/main/window.spec.ts` — unit tests for the COEP/file:// logic (7 tests).
- `tests/e2e/harness.ts` — `DEFAULT_ERROR_PATTERNS` includes `Worker error:` patterns so e2e tests catch worker load failures.

## Process management & debugging games

### Killing game processes — never use generic `pkill electron`

**NEVER run `pkill -9 electron`, `pkill -f electron`, `killall electron`, or any other generic Electron-killing command.** The user's machine may have other Electron apps running (VS Code, Slack, Discord, other games, the Devin desktop app itself). A generic pkill will terminate all of them, destroying the user's work and your own session.

Each game runs as an Electron process launched with `DOWNDRAFT_GAME=<game>` in its environment (dev mode: `bun run dev` from the repo root; built mode: `npx electron .` from `games/<game>`). To kill a specific game instance, target **that game only**:

- **Match the `DOWNDRAFT_GAME` env var** (visible in `/proc/<pid>/environ` on Linux):
  ```bash
  # Kill only the to-the-ocean game process and its children
  for pid in $(grep -l 'DOWNDRAFT_GAME=to-the-ocean' /proc/*/environ 2>/dev/null | cut -d/ -f3); do
    kill -TERM "$pid" 2>/dev/null
  done
  ```
- **Match the specific game path / cwd** if you launched it from a known directory:
  ```bash
  pkill -9 -f 'games/to-the-ocean'
  # or, for a dev run from the repo root:
  pkill -9 -f 'DOWNDRAFT_GAME=to-the-ocean'
  ```
- **Match the MCP port** if you know which port the game's MCP HTTP transport is bound to (default 9876 for dev, 9976 for `draft test`):
  ```bash
  fuser -k 9876/tcp   # kills whatever is bound to the game's MCP port
  ```

Prefer `kill -TERM` first (lets the game clean up storage locks via `cleanupStaleStorage()` and `requestSingleInstanceLock()`); only escalate to `kill -9` if the process doesn't exit within a few seconds. If you launched the game yourself (via `bun run dev`, `draft test`, or the e2e harness), prefer terminating the parent shell/process you spawned rather than hunting for the Electron child.

### Debugging games — do NOT use a browser / Playwright

**Do NOT use a browser (Chrome, Playwright, `browser_preview`, the `devin/mcp-playwright` MCP server, or any other web browser tool) to debug or drive Downdraft games.** The games are Electron + WebGPU apps that rely on:

- Pointer lock and raw input events (browsers block or interfere with these).
- Offscreen rendering (OSR) and Chromium-specific GPU switches (`webGpuSwitches()`).
- Per-game `--user-data-dir` isolation (see "Per-game storage isolation" above).
- Worker threads, SharedArrayBuffer, COOP/COEP headers set in `window.ts`.
- `window.downdraft` preload bridge APIs that only exist inside the Electron preload context.

A plain browser cannot reproduce any of this, and Playwright driving a browser will not exercise the real game code paths. The `devin/mcp-playwright` MCP server is for general web pages, **not** for Downdraft games.

**Instead, use the in-game MCP automation harness and `draft test`:**

1. **`bun run draft:test-cpu`** (or `bun run draft:test`) — the canonical way to launch and exercise a game headlessly. It boots the real Electron app with `DOWNDRAFT_DETERMINISTIC=1`, waits for the MCP HTTP endpoint, and runs the e2e spec. See "Running the smoke test" below for the full CLI flag reference.
2. **The `ocean` MCP server** (configured in `.devin/mcp_config.json` via the stdio→HTTP bridge at `.devin/mcp-stdio-bridge.mjs`) — once a game is running with `MCP_PORT=<port>`, this exposes the game's automation tools directly to your MCP client. **List the tools first with `mcp_list_tools` before calling any of them** — never guess tool names or argument schemas. The currently registered tools (see `games/to-the-ocean/src/mcp/automation-tools.ts`) include:
   - `inject_input` / `clear_injected_input` — hold keys/mouse/wheel for N frames.
   - `dispatch_key` / `dispatch_click` — fire real DOM events on the main thread (full input pipeline).
   - `get_player_state` / `get_world_state` / `get_ui_state` — read simulation/UI state.
   - `wait_for_condition` — poll a JS predicate against player/world state with timeout.
   - `capture_screenshot` — return the WebGPU canvas (+ DOM overlay) as base64 PNG.
   - `set_test_state` — set weather, time of day, sim speed, respawn, render-loop control.
   - `get_element_bounds` / `get_element_style` / `inspect_dom` — inspect main-thread DOM for CSS/layout debugging.
3. **Console error capture** — the e2e harness (`tests/e2e/harness.ts`) captures the game process's stdout/stderr and exposes `game.getConsoleErrors()`. When debugging, grep the captured log for `Uncaught|TypeError|ReferenceError|WrongDocumentError|is not a function|is not defined` (see "E2E test verification — checking for JS errors" below).

The typical debug loop is:
```bash
# 1. Launch the game with deterministic mode + a known MCP port
DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 MCP_PORT=9876 bun run dev &
# 2. Call ocean MCP tools (inject_input, get_player_state, capture_screenshot, ...)
#    to drive the game and inspect state.
# 3. When done, kill ONLY this game instance (see "Killing game processes" above).
```

## Plugin registration patterns

The engine supports two registration patterns:

1. **Direct registration** (`pluginHost.registerPlugin(plugin)`) — registers and immediately activates a single plugin. Use for standalone plugins with no interdependencies.

2. **Batch registration** (`pluginHost.registerPluginDeferred(plugin)` + `pluginHost.activateAll()`) — registers multiple plugins, then activates them in dependency-resolved topological order. Use when multiple plugins have `dependencies` arrays. `GameWorld.usePlugins(plugins[])` wraps this pattern.

Libraries that export factory functions (e.g., `createWildlifeSystem`) can be wrapped as plugins using a factory pattern:
```ts
export function createWildlifePlugin(opts: WildlifePluginOptions): Plugin {
  return { name: "wildlife", version: "1.0.0", register(ctx) { ... } };
}
```
The `opts` object encapsulates all config and dependencies. This is the standard pattern for migrating library packages to the plugin system.

## Verification commands

- `bun run tsc` — now runs `tsc -p tsconfig.web.json --noEmit && tsc -p tsconfig.node.json --noEmit`.
- `bun run lint` — runs `oxlint` on the whole repo. Currently reports many pre-existing `no-console`/`no-unused-vars` warnings/errors.
- `bun test packages/core/src/ecs/world.spec.ts packages/core/src/render/frustum.spec.ts packages/core/src/telemetry/collector.spec.ts`
- `bun test packages/core/src/physics/*.spec.ts` — all physics specs (121 tests).
- `bun test packages/plugins/physics-rapier/src/*.spec.ts` — rapier plugin specs (16 tests).
- `bun test packages/core/src/render/bindless/bindless.spec.ts` — bindless texture registry + material manager specs.
- `bun test packages/core/src/material/material.spec.ts packages/core/src/material/variants.spec.ts` — material + variant specs.
- `bun test packages/shader-graph/src/graph.spec.ts` — shader graph compiler specs (includes GBuffer multi-target + variant tests).
- `bun test packages/plugins/models/src/material-adapter.spec.ts` — MaterialData→Material adapter specs.
- `bun test packages/core/src/assets/model-normalizer.spec.ts` — model normalizer math (up-axis, units, bounds, auto-fit).
- `bun test packages/plugins/models/src/bake-node-transforms.spec.ts` — node hierarchy transform baking specs.
- `bun test packages/plugins/models/src/sidecar/sidecar.spec.ts` — sidecar parsers (.ddmeta.json, Unity .meta, Godot .import, Blender extras).
- `bun test packages/plugins/models/src/normalize.spec.ts` — full normalization pipeline specs.
- `bun test packages/core/src/plugin/host.spec.ts` — PluginHost activation order, deferred registration, dispose order (12 tests).
- `bun test packages/plugins/devtools/src/api.spec.ts` — Unified DevTools API: realm detection, SAB data feeds, manifest, panel/command registration (17 tests).
- `bun test packages/app/src/main/window.spec.ts` — cross-origin isolation header logic (COEP/file:// worker loading, 7 tests).
- `bun test packages/core/src/render/gpu-utils.spec.ts` — GPU resource creation utilities (8 tests, uses mock GPUDevice).
- `bun test games/to-the-ocean/plugins/wildlife/src/wildlife-plugin.spec.ts` — game plugin wrappers (wildlife, buoyancy, collision) (9 tests).
- `bun test packages/plugins/persistence/src/file-save-store.spec.ts` — FileSaveStore (filesystem ISaveStore) specs (9 tests).
- `bun test packages/plugins/persistence/src/opfs-save-store.spec.ts` — OpfsSaveStore (OPFS ISaveStore) specs (22 tests). Uses mock OPFS — no browser/worker environment needed.
- `bun run draft:test` — e2e smoke test with hardware GPU (headless, deterministic). Equivalent to `draft test --renderer=gpu`.
- `bun run draft:test-cpu` — e2e smoke test with SwiftShader software rendering (headless, deterministic). Equivalent to `draft test --renderer=cpu`. Use this for CI.
- `bun run draft:test -- --headed` — same but shows the Electron window (useful for debugging).
- `bun run draft:test -- --game blockheads` — run the blockheads e2e smoke test.
- `bun run draft:test -- --game sandjongg` — run the sandjongg e2e smoke test.
- `bun run draft:test -- --build` — build the game with electron-vite first, then test the packaged app (production-build mode).
- `bun run draft:test -- --build-only` — only test the pre-built app (skip dev server; requires prior `electron-vite build`).
- `bun run test:e2e` — legacy: runs the spec directly via `bun test` (bypasses the CLI).
- `bun run tsc:e2e` — type-checks e2e test files against `tsconfig.e2e.json`.
- `bun test examples/plugin-tester/src/*.spec.ts` — run all plugin-tester specs (488 tests across 11 files: audio-kira, lighting, marching-cubes, navmesh, networking, physics-rapier, water, weather, mcp, engine, test-scene).
- `bun test examples/plugin-tester/src/audio-kira-test.spec.ts` — KiraAudioBackend specs (47 tests).
- `bun test examples/plugin-tester/src/lighting-test.spec.ts` — LightingSystem + LightSystem specs (73 tests, uses mock GPUDevice).
- `bun test examples/plugin-tester/src/marching-cubes-test.spec.ts` — Marching cubes mesh extraction specs (51 tests).
- `bun test examples/plugin-tester/src/physics-rapier-test.spec.ts` — RapierPhysicsBackend specs (JS fallback mode).

### E2E test environment variables

These are set automatically by `draft test`. See the "Running the smoke test" section below for the full CLI flag reference.

- `DOWNDRAFT_GPU=swiftshader|hardware` — selects WebGPU backend via `webGpuSwitches()`. `swiftshader` = software Vulkan (CI), `hardware` = NVIDIA Vulkan (local).
- `DOWNDRAFT_DETERMINISTIC=1` — fixed seed (99999), skip autosave loading, disable devtools auto-open and error dialogs, pause the render loop (on-demand rendering only via `set_test_state` or `capture_screenshot`). The flag is passed from the main process to the renderer via the `downdraft.deterministic` bridge property (set in `packages/app/src/preload/bridge.ts`).
- `DOWNDRAFT_HEADED=1` — show the Electron window even in deterministic mode. Without this, `window.ts` suppresses `win.show()` when `DOWNDRAFT_DETERMINISTIC=1`.
- `MCP_PORT=9976` — MCP HTTP transport port (default 9876 for normal dev, 9976 for e2e tests).
- `MCP_TIMEOUT_MS=120000` — MCP proxy IPC round-trip timeout in ms (must be longer than the longest `wait_for_condition` call).

## Unified DevTools API

The DevTools system has a single registration surface (`devtools` singleton from `@downdraft/plugin-devtools`) that auto-detects whether it's running in the main realm or a worker realm and chooses the appropriate transport:

- **Main realm**: panels/feeds/commands registered directly on `window.__sceneInspector` via `DevToolsDataBridge`.
- **Worker realm**: data feeds written to a devtools SharedArrayBuffer (zero-copy, synchronous reads); commands forwarded via IPC RPC; panel declarations synced to renderer via one-time manifest RPC.

### Architecture

- **`devtools` singleton** (`packages/plugins/devtools/src/api.ts`) — the unified API. Auto-detects realm. Plugins import `devtools` and call `registerPanel()`, `registerDataFeed()`, `registerCommand()`, `registerSABStat()`. Same code works in both realms.
- **`DevToolsSABLayout`** — dedicated SAB region for JSON-serialized data feed results + direct numeric stats. Worker writes via `flushDataFeeds()` (called from sim loop); renderer reads synchronously. No IPC polling.
- **`exposeDevToolsApi()`** (`packages/plugins/devtools/src/worker-expose.ts`) — wraps a worker's `expose()` API with `__devtoolsGetManifest`, `__devtoolsCallCommand`, `__devtoolsGetSAB` RPC methods.
- **`syncWorkerManifests()`** (`packages/plugins/devtools/src/worker-sync.ts`) — renderer-side: fetches manifest from workers, merges panels, wires SAB data feed readers, wires command forwarders.
- **`createDevToolsRendererAdapter()`** (`packages/plugins/devtools/src/renderer-adapter.ts`) — feature-detects renderer capabilities (gpuProfiler, telemetryCollector, gpuResourceTracker, gcController) and builds an `IDevToolsDataRenderer`.
- **`createSimStatsProvider()`** (`packages/plugins/devtools/src/sim-stats-provider.ts`) — reusable `ISimStatsProvider` factory with 10Hz polling + pause/resume/step/speed/clear delegation. Eliminates duplicated boilerplate across sim games.
- **`initDevTools()`** (`packages/plugins/devtools/src/init.ts`) — one-line wiring per game. Creates bridge, wires providers, merges global registry panels, syncs worker manifests, exposes on `window.__sceneInspector`.
- **`createMaterialStatsPanelExtension()`** (`packages/plugins/devtools/src/material-stats-panel.ts`) — reusable "Materials" tab for any game using the unified material system.

### Plugin integration

Both `PluginContext` (sim) and `RendererPluginContext` (renderer) have a `devtools` property. Plugins self-register during `register()`:

```ts
// In a renderer plugin
register(ctx: RendererPluginContext) {
  ctx.devtools.registerPanel({ id: "physics", tabLabel: "Physics", ... });
  ctx.devtools.registerDataFeed("getPhysicsStats", () => ({ bodyCount: ... }));
}

// In a sim plugin (worker realm)
register(ctx: PluginContext) {
  ctx.devtools.registerPanel({ id: "wildlife", tabLabel: "Wildlife", ... });
  ctx.devtools.registerDataFeed("getWildlifeStats", () => ({ count: ... }));
  ctx.devtools.registerCommand("cullWildlife", (max: number) => { ... });
}
```

The host injects the `devtools` singleton via `PluginHost.setDevToolsAPI()` / `RendererPluginHost.setDevToolsAPI()`. If not set, a no-op stub is used (plugins that call `ctx.devtools.registerPanel()` silently no-op).

### Deterministic mode

`resolveDevtoolsConfig()` in `packages/app/src/main/handlers/devtools.ts` is now deterministic-aware: when `DOWNDRAFT_DETERMINISTIC=1`, autoOpen defaults to `false` and keybind defaults to `""` (disabled). Games no longer need to plumb `devtools: { autoOpen: !deterministic, keybind: deterministic ? "" : "F12" }` — just use `devtools: true`.

### Panel order convention

- `0–19`: core devtools tabs (Scene, Import, Perf, GC, Material, Render Graph)
- `20–50`: renderer-plugin tabs (Physics, Water, Audio, Particles)
- `50–80`: sim-plugin/worker tabs (Wildlife, Buoyancy, Collision, Sim Stats)
- `100+`: game-declared tabs (Debug Info, Boat Layout, World)

## Unified Material System

The material system is unified around the **shader graph as the single source of truth**. The 8 hand-written `material-types/*.wgsl` files serve as fallbacks (loaded via Vite `?raw` as `inlineShaderSource`). The graph compiler generates WGSL from `MaterialGraph` nodes; the `Material` class compiles the graph at construction time and caches the result in `inlineShaderSource`.

### Architecture

- **`MaterialDefinition`** (`packages/core/src/material/material.ts`) — the material definition. Key fields: `graph?: MaterialGraph` (primary), `inlineShaderSource?: string` (compiled graph or fallback .wgsl), `variantFlags?: MaterialVariantFlags`, `profile?: string`.
- **`MaterialLibrary`** (`packages/core/src/material/library.ts`) — creates and registers materials. The 8 `create*` methods (Physical, Toon, Matcap, SSS, Sprite, Normal, Line, Depth) load their `.wgsl` fallbacks via `?raw` imports. Graph preset methods (`createPBRGraph`, `createGBufferGraph`) build `MaterialGraph` instances.
- **`GraphCompiler`** (`packages/shader-graph/src/compiler.ts`) — compiles a `MaterialGraph` to WGSL. Supports multi-render-target (GBuffer) profiles via `outputFormats`/`outputNames`, and variant-aware compilation via `variantFlags` in `CompileOptions`.
- **`MaterialVariantFlags`** (`packages/core/src/material/variants.ts`) — hybrid variant strategy: compile-time permutations for `shadowCaster`/`skinning`/`alphaMode`/`morph`/`instanced`; `fog` stays a dynamic branch (NOT part of the variant key). `variantKey()` produces a deterministic string key; `permutationCount()` = 48.
- **`graph-bridge.ts`** (`packages/core/src/material/graph-bridge.ts`) — `compileGraphToMaterialVariants` compiles all variants for a material; `compileVariant` compiles a single variant.
- **`OpaquePass`** (`packages/core/src/render/passes/opaque.ts`) — `setMaterial()` sets a graph-compiled material; `setMaterialVariant()` compiles + caches a per-variant pipeline (bounded LRU, max 24). `getProfileTargets()` emits multi-target `GPUColorTargetState[]` for GBuffer profiles.

### Profiles

- `SIMPLE_PROFILE`, `PBR_PROFILE`, `PBR_TEXTURED_PROFILE`, `PBR_SKINNED_PROFILE`, `PBR_INSTANCED_PROFILE`, `PBR_COLOR_VERTEX_PROFILE` — single-target.
- `GBUFFER_PROFILE` — multi-render-target deferred surface shader. 4 targets: albedo+AO, normal+roughness, metallic+emissive, velocity. Graph output nodes use names: `"albedo"`, `"normal"`, `"metallicEmissive"`, `"velocity"`.

### Material adapter (plugin-models)

`materialDataToMaterial()` (`packages/plugins/models/src/material-adapter.ts`) bridges serialized `MaterialData` (glTF/obj format) to the core `Material` surface. Maps baseColor/metallic/roughness/emissive to uniforms, sets `inlineShaderSource` from the physical fallback .wgsl. `materialDataArrayToMaterials()` batch-converts. The game's `RendererAccessors.uploadModel()` calls this to register materials in a `MaterialLibrary`.

## Model Import Normalization Pipeline

The engine has a unified model import normalization pipeline that corrects common anomalies (incorrect scaling, rotation, up-axis) at load time. This replaces ad-hoc hardcoded fixes in individual games.

### Architecture

- **`ImportSettings`** (`packages/core/src/assets/import-settings.ts`) — per-model normalization config: `upAxis`, `units`, `scale`, `rotation`, `centerToOrigin`, `autoFit`, `nodeTransforms`. Resolved from sidecar files or parser-detected defaults.
- **`model-normalizer.ts`** (`packages/core/src/assets/model-normalizer.ts`) — pure transform math: `applyUpAxisConversion` (Z-up→Y-up), `applyUnitScale` (source units→meters), `applyRootScale`, `applyRootRotation` (quaternion), `computeBounds`, `centerToOrigin`, `autoFit`, `isExtremeScale`. Operates on interleaved [pos(3)+normal(3)] mesh vertices (6 floats/vertex).
- **`bake-node-transforms.ts`** (`packages/plugins/models/src/bake-node-transforms.ts`) — bakes glTF/FBX node hierarchy transforms (translation, rotation, scale) into mesh vertices. Promoted from model-viewer to the engine so all games benefit.
- **`normalize.ts`** (`packages/plugins/models/src/normalize.ts`) — orchestrates the full pipeline: up-axis → unit scale → node-transform baking → root rotation → user scale → bounds → center → auto-fit. `normalizeModel()` applies settings; `normalizeModelWithResolution()` resolves sidecars then normalizes.
- **`loadModel()`** (`packages/plugins/models/src/loader.ts`) — now normalizes by default after parsing. Pass `normalize: false` to skip (e.g. for games that handle their own transforms). Pass `sidecarResolver` for custom sidecar resolution.

### Sidecar System

Per-model import settings are stored in sidecar files, tried in priority order:
1. `.ddmeta.json` (our format, JSON-with-comments via `comment-json`)
2. Unity `.meta` (YAML, `scaleFactor` field)
3. Godot `.import` (INI, `scale`/`rotation` params)
4. Blender extras (glTF `asset.extras.glTF2ExportSettings.YUP`)

Sidecar parsers: `packages/plugins/models/src/sidecar/` — `ddmeta.ts`, `unity-meta.ts`, `godot-import.ts`, `blender-extras.ts`, `resolver.ts`.

### Parser Detection

FBX parser reads `GlobalSettings` for `UpAxis` (0/1=Y-up, 2=Z-up) and `UnitScaleFactor` (units per cm). glTF parser checks `asset.extras.glTF2ExportSettings.YUP`. DAE parser reads `<asset><up_axis>` and `<unit meter="...">`. Stored on `ModelData.sourceUpAxis` and `ModelData.sourceUnits`.

### Import Cache

`ImportCache` (`packages/core/src/assets/import-cache.ts`) caches resolved `ImportSettings` keyed by model path. `MemoryImportCache` is the in-memory fallback. In Electron, `registerImportCacheHandlers()` (`packages/app/src/main/handlers/import-cache.ts`) provides a SQLite-backed cache via `node:sqlite` (stable in Node 24+ / Electron 43+, no flag required), accessed through IPC (`IMPORT_CACHE_GET/SET/INVALIDATE`). The renderer-side adapter (`packages/app/src/renderer/import-cache.ts`) bridges to the IPC with a memory fallback for browser-only mode.

## Save system / storage backends

`ISaveStore` (`packages/core/src/save/persist-types.ts`) is the storage interface for versioned game saves. The extended interface supports: `save`/`load` (with `SaveOptions`/`LoadOptions` for blobs, thumbnails, properties, generation control), `listSaves`/`listGenerations`/`deleteSave`/`deleteGeneration`, `setThumbnail`/`getThumbnail`, `setProperties`/`getProperties`, and `onWarning`. Saves are a zstd-compressed JSON body of per-component sections (each with its own schema version) plus a header (engine version, timestamp, entity/player counts, XXH128 hash). The `MigrationRegistry` runs per-component `fromVersion→toVersion` migrations on load; forward-incompatible saves (newer engine than current) are refused. Implementations live in `@downdraft/library-persistence` (`packages/plugins/persistence/`):

- **`OpfsSaveStore`** (`opfs-save-store.ts`) — **default** OPFS-backed store for Web Workers and renderer. Writes directly to OPFS (no IPC, no main process). Supports generation history (N snapshots per slot, previous gen is backup on corruption), binary blobs (stored as separate files per blob key), thumbnails (PNG/WebP bytes), and arbitrary properties (game mode, playtime, etc.). Uses `createSyncAccessHandle()` in workers (sync I/O) or `createWritable()` on main thread. Directory layout: `downdraft/saves/<slot>/meta.json` + `thumbnail.png` + `gen/<NNNN>/body.zst` + `body.hash` + `blobs/<key>`. The `meta.json` file is the commit point — written last after body + blobs. 22 tests in `opfs-save-store.spec.ts` (uses mock OPFS via `mock-opfs.ts`).

  **Three save modes** (game selects via `DowndraftSavesConfig.mode`):
  - `"inline"` — `OpfsSaveStore` runs inside the sim worker. Sim loop pauses during save (sync OPFS handles). Zero-copy: no data crosses worker boundaries. The sim worker calls `initSaveStore()` to create the store, then `save()`/`load()` use it directly.
  - `"worker"` — Renderer spawns a dedicated `save-worker.ts` Web Worker. Sim worker sends serialized state as transferable `ArrayBuffer` via `MessageChannel`. Sim loop continues running during save. The `SaveWorkerProxy` (`save-worker-proxy.ts`) implements `ISaveStore` by delegating to the worker via the RPC layer.
  - `"auto"` (default) — Picks `"worker"` if OPFS is available (`navigator.storage.getDirectory`), else falls back to IPC.

  The `createSaveStore()` factory (`packages/app/src/renderer/save-store-factory.ts`) handles mode selection and OPFS detection. The `SimBridgeDeps.saveMode` field tells the sim bridge which path to use.

- **`FileSaveStore`** (`file-save-store.ts`) — filesystem backend, used as the IPC fallback. One `.ddsave` file per slot (header + zstd body), rotated to `.bak` on each save; `.bak` is the load fallback on corruption/hash-mismatch. Node-only (`node:fs`). Now supports the extended `ISaveStore` interface: blobs stored in `<slot>.blobs/` directory, thumbnails in `<slot>.thumb`, properties in `<slot>.props.json` sidecar. `listGenerations()` returns a single synthetic generation; `deleteGeneration()` delegates to `deleteSave()`.

### Devtools Auto-Fit

`BaseSceneInspector.importModel()` returns `needsAutoFit` and `warnings` when a model has extreme scale (< 0.01m or > 100m). The DevTools panel UI (`extension/panel.js`) shows an auto-fit prompt with a button that calls `autoFitModel(nodeId, targetMaxDim)`, which re-normalizes and generates a `.ddmeta.json` sidecar for persistence. `generateSidecar(nodeId)` creates a starter sidecar with commented-out fields.

### Devtools material editor

`BaseSceneInspector` (`packages/plugins/devtools/src/scene-inspector.ts`) exposes a functional material editor API: `compileMaterialGraph`, `createMaterialFromGraph`, `saveMaterialToLibrary`, `listMaterials`, `exportMaterialAsJSON`, `importMaterialFromJSON`, `previewMaterialGraph` (live preview via `setPreviewMeshRenderer`). The editor UI (`packages/ui/src/editor/material-graph/material-graph-editor.tsx`) has a synced node palette (all compiler node types) and a Preview button.

### Hot reload

`HotReloader` (`packages/core/src/render/hot-reload.ts`) writes reloaded shader source into `material.inlineShaderSource` (not the dead `shader` string field) and calls `material.invalidateVariants()` to flush the variant cache.

## Compute Graph System

The engine has a node-based compute shader authoring system that parallels the material graph. It provides a higher-level alternative to hand-writing WGSL compute shaders (the "gpu.js replacement" for WebGPU).

### Architecture

- **`ComputeGraph`** (`packages/shader-graph/src/compute-graph.ts`) — the compute graph data structure. Separate from `MaterialGraph` (which is vertex/fragment only). Contains nodes + connections + `StorageBufferDecl`/`UniformBufferDecl` declarations + `ComputeDispatchConfig` (workgroup size + dispatch count).
- **`ComputeGraphCompiler`** (`packages/shader-graph/src/compute-compiler.ts`) — compiles a `ComputeGraph` to WGSL `@compute @workgroup_size(...)` shader. Emits struct declarations from buffer decls, `@group/@binding` var declarations, and a `cs_main` entry point with `global_invocation_id`/`local_invocation_id`/`workgroup_id`/`num_workgroups` builtins. Compute-specific nodes: `global_id`, `buffer_load`, `buffer_store`, `atomic_add/sub/min/max/exchange`, `workgroup_barrier`, `storage_barrier`. Math nodes (multiply, add, sin, etc.) are shared with the material compiler.
- **`ComputeProfile`** (`packages/shader-graph/src/compute-profiles.ts`) — simpler than `ShaderGraphProfile`: just `name`, `chunks`, `workgroupSize`. Built-in profiles: `SIMPLE_COMPUTE_PROFILE` (64x1x1), `PARTICLE_COMPUTE_PROFILE` (64x1x1), `TEXTURE_COMPUTE_PROFILE` (8x8x1), `VOLUMETRIC_COMPUTE_PROFILE` (4x4x4).
- **`GraphComputePass`** (`packages/core/src/render/passes/graph-compute.ts`) — `RenderPass` subclass with `PassType.Custom`. Integrates with the frame graph (dispatches on the shared encoder). Supports both auto-allocated buffers (from `StorageBufferDecl`/`UniformBufferDecl`) and externally-provided buffers (`setExternalBuffer()`). `recompile()` supports hot-reload. Uses local `BUFFER_USAGE`/`SHADER_STAGE_COMPUTE` constants instead of WebGPU globals for testability.
- **`runComputeKernel()`** (`packages/core/src/render/compute-kernel.ts`) — thin imperative helper for quick one-off GPGPU. Takes WGSL + typed inputs, dispatches once, returns a `readBuffer()` function for CPU readback. No graph, no frame graph needed.
- **`ComputeGraphEditor`** (`packages/ui/src/editor/compute-graph/compute-graph-editor.tsx`) — React component for visual compute graph authoring. Compute-specific node palette + buffer declaration panel (add/edit storage & uniform buffers) + dispatch config (workgroup size, dispatch count).

### Buffer management

`GraphComputePass` supports two modes:
1. **Auto-allocated** (default): creates `GPUBuffer`s from `StorageBufferDecl`/`UniformBufferDecl` declarations. Storage buffers use `STORAGE | COPY_DST | COPY_SRC`; uniform buffers use `UNIFORM | COPY_DST`. Runtime-sized arrays default to 1 MB.
2. **Externally provided**: `setExternalBuffer(name, buffer)` skips auto-allocation for that buffer. Used for interop with existing systems (e.g. particle buffers from `ParticleComputePass`).

Data is written via `writeUniform(name, data)` (queued, flushed before dispatch) and `writeStorage(name, data)` (immediate `queue.writeBuffer`).

### Verification commands

- `bun test packages/shader-graph/src/compute-compiler.spec.ts` — compute graph + compiler specs (17 tests).
- `bun test packages/core/src/render/passes/graph-compute.spec.ts` — compute pass specs (7 tests).
- `bun test packages/core/src/render/compute-kernel.spec.ts` — kernel helper specs (5 tests).

## Bindless rendering model

The engine uses a bindless material binding model to eliminate per-draw bind-group churn. Material parameters (baseColor, roughness, texture indices) live in a single SSBO; textures are registered into global `texture_2d_array` buckets keyed by format/dimensions/mips. A single bind group (`@group(3)`) is set once per frame and shared by all draw calls.

### Core infrastructure (`packages/core/src/render/bindless/`)

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

`device.ts` and `game-renderer.ts` request `maxTextureArrayLayers: 256` in `requiredLimits`. `GPUDeviceManager.requestDevice` checks for the limit before requesting.

### Migration status

- `ModelRenderer` (plugin-entities) — fully bindless. `setBindlessDeps()` + `setBindlessBindGroup()` wire the registry/material manager. The model shader samples albedo from `albedoArrays[arr]` using the material's `albedoTex` handle.
- `PlayerMeshRenderer` (to-the-ocean) — fully bindless. Player texture registered via `BindlessTextureRegistry.registerFromImageBitmap`. `materialIndex` written into the entity uniform at float slot 44.
- `OpaquePass` PBR path — fully bindless. `PBRMaterialResources` uses `*TextureSourceId` fields. `setBindlessDeps()` wires the registry. `materialIndex` uniform at `@group(0) binding(3)`.
- `DecalPass` — fully bindless. Per-item bind group creation eliminated; bind group created once per pass. `materialIndex` in the decal uniform.
- `shader-graph` profiles — `PBR_TEXTURED_PROFILE` and `PBR_SKINNED_PROFILE` updated to use `@group(3)` for bindless materials instead of per-material sampler/texture in group 0.
- `material-bridge.ts` — `bridgeMaterial()` accepts an optional `BindlessTextureRegistry` and registers textures into it when provided.

### WebGPU type gotchas

- `GPUTexelCopyTextureInfo` and `GPUCopyExternalImageDestInfo` use `origin: [x, y, layer]` (z component = array layer), not a separate `arrayLayer` property.
- `GPUSupportedLimits` → `Record<string, number>` conversion requires `any` cast.

- `tsconfig.web.json` and `tsconfig.node.json` are composite projects with `outDir: "dist"`. electron-vite also emits its bundles to `dist/main`, `dist/preload`, `dist/renderer` (configured in `electron.vite.config.ts`).
- `@dimforge/rapier3d-compat` is at `0.19.3`. The internal `RawRigidBodySet`/`RawColliderSet` types are not exported in that version, so `rapier-physics-system.ts` uses `any` for the raw body/collider references.
- **WASM borrow aliasing:** Rapier 0.19.x returns `RawVector`/`RawRotation`/`RawColliderShape` objects from methods like `body.translation()`, `controller.computedMovement()`, and `ColliderDesc.trimesh()`. These hold WASM borrows that must be explicitly `.free()`d before `world.step()`. The `rapier-backend.ts` `addCollider` frees `cd.shape` after `world.createCollider()` (the collider set clones the `SharedShape` Arc). Same for `getColliderPosition`, `getBodyTransform`, `characterMove`, and the raw fast-path fallbacks. Failure to free causes "recursive use of an object detected which would lead to unsafe aliasing in rust" panics during `world.step()`.
- **Raw fast-path handle mapping:** The `*Raw` methods in `rapier-backend.ts` receive `bodyId` (the game's `PhysicsBody.id`, sequential: 1, 2, 3...) but must pass the **Rapier rigid-body handle** (`body.handle`, starts at 0) to WASM functions like `rbSetTranslation`. The raw fast paths look up the `RigidBody` from `bodyMaps` to get `body.handle`. Passing `bodyId` directly causes out-of-bounds WASM access that corrupts internal state and triggers the aliasing panic.
- **`swapColliderShapeRaw` shape type:** `ColliderDesc.trimesh()` returns a `SharedShape` (Eg) which stores vertices/indices but does NOT hold a `RawColliderShape`. `coSetShape` expects a `RawShape` (OA). Call `shape.intoRaw()` to get the `RawColliderShape`, pass it to `coSetShape`, then `.free()` it.

## Universal Physics Plugin (physics-rapier 0.2.0)

- The `PhysicsBackend` interface is now `PhysicsBody`-keyed (opaque body refs). Raw Rapier `RigidBodyHandle` is no longer exported from `@downdraft/core`.
- Multi-realm LOD: `RealmManager` drives near/mid/far tiers with promote/demote + dwell hysteresis. Static bodies are duplicated into all realms by default.
- `UniversalPhysicsAPI` (`@downdraft/plugin-physics-rapier`) is the single public surface: body lifecycle, validated state access, realm queries, interpolation, raycast, snapshots, hooks.
- Subsystems: `PhysicsAccumulator` (fixed timestep), `InterpolationBuffer` (double-buffered), `LoadShedder` (island-aware freeze), `SafetyLayer` (NaN/Inf + hard-lock), `CCDHeuristic` (per-body), `SnapshotManager` (multiplayer), `RealmWorkerPool` (nested-worker parallelism, `workerCount:0` = single-threaded).
- `PhysicsSystem` (ECS, `Stage.Physics`) wires all subsystems together; created via `createPhysicsSystem(resources)`.
- Demo: `examples/physics-demo/main.ts` exercises realms, transfers, CCD, NaN injection, snapshot/restore.
- **Raw fast paths** (`*Raw` methods on `UniversalPhysicsAPI`/`PhysicsBackend`): scalar transform sync/readback, `isSleepingRaw`, `swapColliderShapeRaw` (in-place trimesh shape swap, avoids broadphase re-insertion), `reserveMemory`, `setIntegrationDt`. These bypass safety validation and avoid JS object allocation — callers must validate inputs. Use in hot loops (e.g. `to-the-ocean`'s per-entity sync runs every tick).

## Recent performance work

- Simulation tick telemetry now emits `perf_stats` with `process: "sim"` every 30 ticks; `main.tsx` records systems into the `TelemetryCollector` overlay.
- `simulation-tick.ts` caches player center once per tick and builds slow-log/per-event arrays with loops instead of chained filter/map.
- ECS `World` uses numeric archetype keys, avoids `allArchetypes.includes`, removes duplicate `updateQueryArchetypes` call in `step`, and `Schedule` caches the query list.
- `WebGPURenderer` builds a single `GPUCommandEncoder` per frame and submits once; the depth texture cache is cleared on resize.
- Main process `nvidia-smi` queries are async and cached for 1s.
- `TelemetryCollector.passTimings` is now a bounded `Map` instead of an unbounded array.
- `GPUProfiler` supports up to 32 passes (was hardcoded to 16).

## Host SDK (`@downdraft/app` — game-bootstrapped host layer)

Games bootstrap themselves by calling engine-exported host methods, instead of the engine owning a monolithic main/preload process. The engine obscures Electron's main/preload/renderer machinery behind a config-driven surface (Angular-style: devs set config, rarely touch raw Electron APIs). Raw process access is a deliberate `extend(ctx)` escape hatch.

### Subpath exports

- `@downdraft/app/main` — `createDowndraftApp(config)`, `webGpuSwitches()`, composable handlers, `MainContext` types.
- `@downdraft/app/preload` — `createDowndraftBridge(config)` with default `window.downdraft` API + `extend` hook.
- `@downdraft/app/renderer` — typed `downdraft` accessor (coexists with `window.downdraft`; stubs to no-op in browser-only mode).
- `@downdraft/app/shared` — IPC channel constants (safe in all processes).
- `@downdraft/app/vite` — `createDowndraftViteConfig({ root, ...overrides })` build-config factory.

### Per-game files

Each Electron game owns:
- `electron.vite.config.ts` — calls `createDowndraftViteConfig({ root: __dirname })`.
- `src/main.ts` — calls `createDowndraftApp({ window, switches, features, lifecycle, extend })`.
- `src/preload.ts` — calls `createDowndraftBridge({ extend })`.

The root `electron.vite.config.ts` is a `DOWNDRAFT_GAME` dispatcher that uses the factory with the selected game's root. `DOWNDRAFT_GAME=<game> bun run dev` still works.

### Config-driven features

`features` in `createDowndraftApp()` gates which IPC handlers are registered: `saves`, `osr`, `mcp`, `devtools`, `gpuInfo`, `consoleForwarding`, `errorDialog`, `windowStatePersistence`. Set to `false` to disable.

`features.devtools` accepts a `DevtoolsConfig` object (or boolean shorthand): `enabled` (master switch, default true), `keybind` (key that toggles DevTools via main-process `before-input-event`, matched against `KeyboardEvent.key`; default `"F12"`, set to `""` to disable), `autoOpen` (auto-open on window ready-to-show; default true), `debugPort` (optional; sets Chromium's `--remote-debugging-port` switch before app ready). The keybind is handled in the main process, so renderer keydown listeners for the same key are suppressed via `preventDefault()`. `resolveDevtoolsConfig(feature)` returns the resolved `{ enabled, autoOpen, keybind, debugPort }`.

### Deliberate escape hatch

`extend(ctx)` in both `createDowndraftApp()` and `createDowndraftBridge()` provides raw Electron access (`ctx.app`, `ctx.BrowserWindow`, `ctx.ipcMain`, etc.) for game-specific needs. This is the intended way to reach Electron APIs directly — "deliberate" by API design, not by lint/runtime guards.

## Game automation & headless testing

### GPU mode environment variable

Set `DOWNDRAFT_GPU=swiftshader` to force Chromium's software Vulkan backend for headless CI / testing without a GPU. Without this env var, the engine uses the hardware GPU (NVIDIA Vulkan on Linux, D3D12 on Windows).

### MCP automation harness (`to-the-ocean`)

`to-the-ocean` registers a renderer-side MCP automation harness (`games/to-the-ocean/src/mcp/setup.ts`) wired to the existing main-process MCP HTTP proxy. It exposes game-specific tools without importing the Node-only `@downdraft/mcp` server bundle into the renderer:

- `inject_input` — hold keys/mouse/wheel for a number of frames via `RendererInputHandler.injectInput()`.
- `clear_injected_input` — cancel pending injected input.
- `get_player_state` — read player slot from the simulation SharedArrayBuffer.
- `get_world_state` — read global simulation state (tick, entity count, weather, etc.).
- `wait_for_condition` — poll a JS predicate against player/world state with timeout.
- `capture_screenshot` — return the WebGPU canvas as a base64 PNG.
- `set_test_state` — set weather, time of day, sim speed, or respawn the player.

Input injection is merged with real DOM input in `processInput()` so the game loop does not need to know whether the input came from a human or a test.

### Connecting Devin's MCP client to the game

The game's MCP HTTP transport (`packages/mcp/src/http-transport.ts`) supports both Streamable HTTP and HTTP+SSE transports. However, Devin's MCP client uses stdio for local servers. A stdio-to-HTTP bridge (`.devin/mcp-stdio-bridge.mjs`) forwards JSON-RPC messages from stdin/stdout to the game's HTTP endpoint.

To connect:
1. Start the game: `DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 MCP_PORT=9876 bun run dev`
2. The MCP config (`.devin/mcp_config.json`) defines the `ocean` server using the bridge script.
3. The bridge forwards `initialize`, `tools/list`, `tools/call` to `http://localhost:9876/mcp`.
4. Notifications (messages without an `id` field, like `notifications/initialized`) are silently ignored by the bridge.
5. `resources/list` and `prompts/list` return empty lists (the game doesn't expose resources or prompts).

Key bridge fixes:
- Notifications (no `id`) must not receive a response — the bridge silently drops them.
- The proxy handler wraps errors in the `result` field; the bridge detects `result.error` and converts it to a proper MCP `error` response.
- `ELECTRON_RUN_AS_NODE` must be unset in the game's env or Electron's `app` object is undefined.

### Running the smoke test

The `draft test` CLI command (`packages/cli/src/test.ts`) launches the game, waits for the MCP endpoint, and runs the e2e spec via `bun test`. It sets `DOWNDRAFT_DETERMINISTIC=1` (fixed seed, paused render loop, no autosave, no window) by default.

```bash
# CPU rendering (SwiftShader, headless) — default, for CI
bun run draft:test-cpu

# GPU rendering (hardware Vulkan, headless)
bun run draft:test

# Show the window while testing (useful for debugging)
bun run draft:test -- --headed
bun run draft:test-cpu -- --headed

# Direct CLI usage
draft test --renderer=gpu --headed
draft test --renderer=cpu --spec tests/e2e/my-game.spec.ts
```

**CLI flags:**
- `--renderer <gpu|cpu>` — WebGPU backend. `cpu` = SwiftShader software (default), `gpu` = hardware Vulkan.
- `--headed` — Show the Electron window instead of running headless. Sets `DOWNDRAFT_HEADED=1`.
- `--game <name>` — Game to test (default: `to-the-ocean`). Resolves spec to `tests/e2e/<game>-smoke.spec.ts`.
- `--spec <path>` — Override the spec file path.
- `--port <n>` — MCP port (default: 9976). If omitted, the harness auto-allocates a free port.
- `--no-deterministic` — Disable fixed seed / render loop pause / window hiding.
- `--build` — Build the game with `electron-vite build` before testing, then test the packaged app from `dist/main/index.cjs`. Catches production-only bugs.
- `--build-only` — Only test the built app (skip dev server; requires prior `electron-vite build`).

**Environment variables (set automatically by `draft test`):**
- `DOWNDRAFT_GPU=swiftshader|hardware` — selects the WebGPU backend via `webGpuSwitches()`.
- `DOWNDRAFT_DETERMINISTIC=1` — fixed seed (99999), skip autosave, disable devtools auto-open, pause render loop (on-demand rendering only). Passed to the renderer via the `downdraft.deterministic` preload bridge property.
- `DOWNDRAFT_HEADED=1` — show the window even in deterministic mode. Without this, `window.ts` suppresses `win.show()` when `DOWNDRAFT_DETERMINISTIC=1`.
- `MCP_PORT=9976` — MCP HTTP transport port.
- `MCP_TIMEOUT_MS=120000` — MCP proxy IPC round-trip timeout.

**Headless / CI without a display:** The CLI auto-detects missing `DISPLAY` and wraps in `xvfb-run` if available. Install it with `sudo apt install xvfb`. Electron still needs an X server even when the window is hidden — SwiftShader renders to an offscreen surface but Chromium's ozone platform requires a display connection.

**Legacy scripts** (still available, bypass the CLI):
- `bun run test:e2e` — runs the spec directly via `bun test` (uses whatever env vars are set).
- `bun run test:e2e:headless` — same, but forces `DOWNDRAFT_GPU=swiftshader`.
- `bun run test:e2e:local` — same, no env override (uses hardware GPU by default).

`tests/e2e/harness.ts` launches `bun run dev` with `DOWNDRAFT_GAME=to-the-ocean`, waits for the MCP HTTP health endpoint, and drives the game through MCP tool calls. The smoke test (`tests/e2e/to-the-ocean-smoke.spec.ts`) verifies that the tool surface exists, the simulation ticks, injected input advances the world, and a screenshot can be captured.

**Build mode:** Pass `--build` to `draft test` to build the game with `electron-vite build` first, then test the packaged app from `dist/main/index.cjs` instead of the dev server. This catches production-only bugs (e.g. minification issues, missing assets, tree-shaking problems). Use `--build-only` to skip the dev server entirely (requires a prior build). The harness detects built mode via the `DOWNDRAFT_TEST_BUILT=1` env var.

**Dynamic ports:** The harness auto-allocates a free MCP port starting from 9976, enabling parallel spec execution. Specs read the port from `process.env.MCP_PORT` (set by `draft test --port`). To run multiple specs simultaneously, omit `--port` and let each spec pick its own.

**Process cleanup:** The harness kills the entire process group (bun + Electron + Vite) on test completion, preventing orphaned Electron processes. It uses `process.kill(-pid, SIGTERM)` with a SIGKILL fallback after 5s.

**Retry logic:** The harness `callToolWithRetry()` method retries MCP operations on transport errors (connection refused, timeouts) with exponential backoff. Tool-level errors (isError: true) are not retried.

### E2E test verification — checking for JS errors

**Do NOT rely solely on test pass/fail to verify correctness.** The e2e tests drive the game through MCP tool calls and assert on returned state, but uncaught JS errors in the game process (React DOM errors, uncaught Promise rejections, TypeError from polyfill gaps) will NOT cause test failures unless explicitly checked.

The harness (`tests/e2e/harness.ts`) captures console output from the game process and exposes it via `game.getConsoleErrors()`. Tests should include a final assertion that no JS errors occurred:

```ts
it("no uncaught JS errors during the test run", async () => {
  await sleep(500); // wait for pending async errors to surface
  const errors = game!.getConsoleErrors();
  if (errors.length > 0) console.error("Console errors:\n" + errors.join("\n"));
  expect(errors).toEqual([]);
});
```

When verifying changes, always:
1. Run `bun run tsc` — type-check both web and node configs
2. Run the e2e test with `DOWNDRAFT_GPU=swiftshader` (CPU rendering for CI)
3. Grep the full test output for error patterns: `grep -E "Uncaught|TypeError|ReferenceError|WrongDocumentError|is not a function|is not defined" /tmp/undertow-test-*.log`
4. Do NOT ignore errors that appear "during teardown" — they may indicate real bugs (e.g. React trying to render on detached DOM nodes, uncaught Promise rejections from `requestPointerLock()`)

Common false positives to filter out: Chromium storage errors (`ERROR:components/services/storage`, `ERROR:storage/browser`), GTK module warnings, WebSocket connection failures during teardown, `session.loadExtension` deprecation warnings.

### E2E test gotchas

- **MCP port conflicts**: If a previous test run didn't clean up, port 9977 may still be in use. Free it with `fuser -k 9977/tcp`, then kill **only the specific game instance** as described in "Killing game processes" above — do NOT use a generic `pkill -9 -f electron` (it will kill unrelated Electron apps).
- **Save store hangs in test environments**: `createSaveStore()` can hang when OPFS is not available (SwiftShader/headless). The MCP harness (`setupTtolMcp`) must be registered BEFORE the save store init so e2e tests can connect. The harness's `dispatch_key` / `get_ui_state` tools only need the renderer + store, not the sim SAB.
- **Undertow worker event pump**: The worker's `onKey` handler reads `useGameStore.getState()` to decide which action to dispatch. Store-syncs from the main thread are async (throttled to ~16ms), so the worker may read stale state. The store bridge applies optimistic updates for toggle actions and skips syncing toggle state keys for 200ms after an optimistic update to prevent stale overwrites.
- **`requestPointerLock()` returns a Promise in newer Chrome**: The Promise can reject with `WrongDocumentError` if the canvas was detached or during ESC cooldown. Always `.catch()` the return value to avoid uncaught rejections.
- **Undertow DOM polyfill node type caching**: `wrapSyncNode` must NOT do a `callSync` round-trip for every uncached node — this adds seconds of latency when React renders a menu (dozens of elements). Instead, cache the node type in `createElement`/`createTextNode`/`createComment` and default to `SyncElement` for uncached handles (the most common case). `getSyncElement` must also upgrade cached `SyncNode`s to `SyncElement`s when accessed via `getSyncElement` (the cache may have a `SyncNode` from `firstChild`/`childNodes` that needs `setAttribute`).
- **Renderer stub in worker**: The worker's `useGameStore` needs a Proxy-based renderer stub that forwards `lockPointer`/`exitPointerLock` to the main thread via `postMessage` and returns safe defaults for other methods (`getFPS` → 0, settings setters → no-op). Without this, `togglePauseMenu`'s `lockPointer()` call is a no-op in the worker, and `app.tsx`'s FPS polling throws `renderer.getFPS is not a function` every 500ms.
- **Inventory panel height**: The inventory grid is 20×15 cells × 28px = ~8400px tall. The panel needs `max-h-[80vh] overflow-y-auto` to constrain it, otherwise it renders at 8k+ pixels.

### Why not a WebGL2 fallback?

The engine relies on WebGPU-specific features (bindless `texture_2d_array`, storage buffers, compute passes, GBuffer MRT). A WebGL2 renderer would be a second, incompatible implementation. For testing, we instead use SwiftShader's Vulkan backend to run the unmodified WebGPU pipeline in software, and we inject input through the renderer so Playwright does not need to manipulate pointer lock or raw GPU output.

## UI typography: minimum font size

All UI text rendered by the engine and games MUST use a font size of **at least 12px**. This applies to in-game HUDs, menus, tooltips, DevTools panels, and any DOM overlay content generated by the framework.

- Do not set `font-size` below `12px` (e.g. no `10px`, `11px`, or `0.7rem`-style values that resolve below 12px) in CSS, inline styles, or stylesheet theme overrides.
- When adapting third-party component styles or copying reference markup, bump any sub-12px font sizes up to 12px.
- The base stylesheet (`packages/app/src/renderer/downdraft-base.css`) should not introduce a root font size below 12px; game theme overrides layered on top of it must also respect this floor.
- This is a readability/accessibility floor, not a target — larger sizes are fine where appropriate.

## Windows packaging — version info & PE compilation timestamp

### Problem

VirusTotal analysis of Windows `.exe` builds reported two issues:

1. **File Version Information** showed engine branding (`Downdraft Engine`, `com.downdraft.engine`) instead of the game's name/copyright/description. This was because only the root `package.json` had an electron-builder `build` block — no game had its own config, so all games inherited engine metadata.
2. **Compilation Timestamp** showed 2018-12-15 even though the build was done in 2026. electron-builder copies Electron's prebuilt `electron.exe` without recompiling, so the PE COFF `TimeDateStamp` field stays at Electron's fixed build timestamp.

### Solution

**Per-game branding** — `createDowndraftBuilderConfig()` factory (`packages/app/src/build/index.ts`) produces an electron-builder `Configuration` with per-game `appId`, `productName`, `copyright`, `description` (→ Windows `FileDescription`), `author` (→ Windows `CompanyName`), and `version` (→ Windows `FileVersion`). Each game has a `build.config.ts` that calls this factory. electron-builder's `WinPackager.signAndEditResources()` maps these fields to rcedit version-string arguments (`FileDescription`, `ProductName`, `LegalCopyright`, `CompanyName`, `FileVersion`, `ProductVersion`, `InternalName`).

**PE timestamp patching** — `patchPeTimestamps()` (`packages/app/src/build/pe-timestamp.ts`) writes the actual build timestamp into the COFF `TimeDateStamp` field (`e_lfanew + 8`) of every produced `.exe`. The factory wires this into `afterAllArtifactBuild` automatically.

**Timestamp source** — `resolveBuildTimestamp()` uses:
1. `SOURCE_DATE_EPOCH` env var (reproducible builds) — if set & valid.
2. Git HEAD commit date (`git log -1 --format=%ct`) — deterministic per commit.
3. `Date.now() / 1000` — wall-clock fallback when git is unavailable.

### `draft dist` CLI command

`draft dist [--game=<name>] [--target=<win|linux|mac|all>] [--config=<path>]` loads the game's `build.config.ts` (or falls back to the `build` block in `package.json`) and invokes electron-builder's programmatic `build()` API. Config resolution order:

1. `--config=<path>` flag (explicit).
2. `games/<game>/build.config.ts` (monorepo layout).
3. `./build.config.ts` in the current directory (standalone scaffolded project).
4. `build` block in `games/<game>/package.json` (inline, back-compat).
5. `build` block in `./package.json` (standalone inline).
6. Root `package.json` `build` block (engine default — last resort).

### Files

- `packages/app/src/build/index.ts` — `createDowndraftBuilderConfig()` factory + `resolveBuildTimestamp()`.
- `packages/app/src/build/pe-timestamp.ts` — `patchPeTimestamp()` / `patchPeTimestamps()`.
- `packages/app/src/build/pe-timestamp.spec.ts` — PE patcher specs (11 tests).
- `packages/app/package.json` — `./build` subpath export.
- `packages/cli/src/dist.ts` — `draft dist` command.
- `games/<game>/build.config.ts` — per-game builder config (to-the-ocean, mining-rpg, overburden, alchemy, falling-sand, sandjongg).
- `packages/cli/templates/full/build.config.ts.eta` — scaffolded `build.config.ts` for the `full` template.

### Code-signing note

For signed Windows builds, the PE timestamp patch runs in `afterAllArtifactBuild` — **after** electron-builder's signing step. If you need the timestamp patched before signing, set `patchPeTimestamp: false` in `createDowndraftBuilderConfig()` and run `patchPeTimestamps()` manually before signing.

## mining-rpg: Solid-js-in-Worker Vite workaround

**Status:** Known workaround — revisit when `vite-plugin-solid` adds native worker support.

mining-rpg runs its UI (Solid-js components) inside a Web Worker for offscreen rendering. This requires `vite-plugin-solid` to apply its JSX transform to `.tsx` files in worker bundles. The solid-js package has a `"worker"` export condition that maps to `dist/server.js` — a non-reactive SSR build where `createSignal`/`createStore` are no-ops. Vite uses the `"worker"` condition when resolving modules in a Web Worker context, which breaks all reactivity.

### The 4 custom Vite plugins (`games/mining-rpg/vite-options.ts`)

1. **`solidRemoveWorkerConditionPlugin()`** — A `"post"` plugin that removes `"worker"` from `resolve.conditions` so the `"browser"` → `"development"` conditions are used instead (selects `dist/dev.js` with real reactivity).

2. **`solidBrowserResolvePlugin()`** — A `"pre"` plugin that intercepts `resolveId` for `solid-js`, `solid-js/web`, and `solid-js/store` and redirects them to the browser dev build files. Also includes a `configureServer` middleware that intercepts Vite's pre-bundled dep URLs (`.vite/deps/solid-js*.js`) and serves the browser dev build content instead — necessary because Vite's dep optimizer pre-bundles solid-js using the `"worker"` export condition, and no combination of `resolve.alias` / `optimizeDeps.exclude` / `esbuildOptions.conditions` reliably overrides this for the worker context.

3. **`solidWorkerUrlPlugin()`** — A build-only plugin that replaces `__SOLID_WORKER_URL__` in the main bundle with the emitted worker chunk's URL. Uses `generateBundle` to find the worker filename and patch the main bundle's code before it's written to disk.

4. **`solidEsbuildPlugin()`** — An esbuild plugin for Vite's dep pre-bundler that overrides solid-js resolution (forces the browser build instead of the server build).

### Dev-vs-prod variance

- **Dev mode:** Vite's dep pre-bundler uses the `"worker"` export condition → non-reactive server build. The `configureServer` middleware in `solidBrowserResolvePlugin` intercepts pre-bundled dep URLs and serves the browser dev build content instead. This is fragile — it depends on URL pattern matching (`/.vite/deps/solid-js*.js`).

- **Prod build:** Rollup resolves via the `resolveId` hook in `solidBrowserResolvePlugin` (no pre-bundler). The `resolve.alias` entries also force the browser build. More robust than dev mode.

### Future plan

Extract these plugins into `@downdraft/app/vite` as a `solidWorkerPlugin()` factory, so other games that want Solid-js-in-worker can use it without copying the workaround. This should be done after `vite-plugin-solid` adds native worker context support (tracking: https://github.com/solidjs/vite-plugin-solid/issues). Until then, the workaround stays in `games/mining-rpg/vite-options.ts`.

## Mobile targets (Android + iOS via Capacitor)

The engine supports Android and iOS build targets by wrapping the existing web-portable renderer/sim/worker stack in Capacitor (system WebView). The renderer, sim workers, SAB layout, and libraries are **unchanged** from desktop — they run in the system WebView with the exact same WebGPU + Worker + SharedArrayBuffer code path.

### Engine-owned native shell (zero native files per game)

The engine owns a **canonical, pre-wired native shell** at `packages/mobile-shell/` containing complete Android + iOS projects with the embedded HTTP server (COOP/COEP for SharedArrayBuffer) already wired in. `draft mobile` copies this shell into a per-game **gitignored** `android/` + `ios/` directory and patches in game-specific values (appId, appName, port, icons).

**Games commit zero native files.** The `android/` and `ios/` directories in each game are gitignored (via `games/*/android/` + `games/*/ios/` in root `.gitignore`) — regenerated from the shell on each `draft mobile` run. Games only commit:
- `capacitor.config.ts`, `src/mobile.ts` (or `.tsx`), `mobile.vite.config.ts`
- Optionally `icon.png` (1024×1024, auto-generates all icon sizes via jimp)
- Optionally `mobile-overrides/` (game-specific native permissions, deps, resources)

The shell's `MainActivity.java` / `AppDelegate.swift` / `SceneDelegate.swift` already start the embedded server and override the WebView URL. **No manual native code editing is required.**

### Architecture: what is portable vs Electron-only

- **Already web-portable (runs unchanged in a WebView):** `packages/core/src/render/*`, `packages/core/src/worker/*`, `packages/core/src/sab/*`, `packages/core/src/input/*`, `packages/core/src/ecs/*`, all `packages/libraries/*`, all `packages/plugins/*` (except `electron-osr`), `packages/shader-graph`, `packages/ui`, `packages/mcp`, and `packages/app/src/renderer/*` (the `downdraft` bridge accessor already returns a stub when `window.downdraft` is absent).
- **Electron-only (replaced/skipped on mobile):** `packages/app/src/main/*` (Electron main process), `packages/app/src/preload/*` (IPC bridge), `packages/plugins/electron-osr/*` (Offscreen Rendering), `electron.vite.config.ts` / `createDowndraftViteConfig()` (electron-vite build), `draft dist` (electron-builder).

### Gating constraints

- **WebGPU floor:** Android WebView 121+ / iOS WKWebView 26+ (iPadOS 26+). **iOS 26, not iOS 18**, is the real WKWebView WebGPU floor — Safari-the-browser got WebGPU at iOS 18, but the WKWebView component only enabled it at iOS 26 (Tahoe). Older iOS devices cannot run Downdraft games via this path.
- **SharedArrayBuffer:** Requires cross-origin isolation (COOP `same-origin` + COEP `require-corp`). Capacitor's default custom-scheme loading (`capacitor://localhost`) makes header control unreliable. The reliable fix is an **embedded local HTTP server** inside the native app that serves web assets with COOP/COEP headers, pointing the WebView at `http://127.0.0.1:<port>`. This is **pre-wired in the engine-owned shell** — no manual native editing needed.

### Files

- `packages/mobile-shell/` — engine-owned canonical native shell (Android + iOS, pre-wired with embedded server).
- `packages/mobile-shell/android/` — pre-wired Android project (`MainActivity` starts `EmbeddedServer` + overrides WebView URL; `app/build.gradle` has NanoHTTPD dep).
- `packages/mobile-shell/ios/` — pre-wired iOS project (`AppDelegate` starts `EmbeddedServer`; `SceneDelegate` overrides WebView URL; `Info.plist` has ATS exception).
- `packages/app/src/mobile/index.ts` — `createDowndraftMobileApp()` entry point (mobile equivalent of `createDowndraftApp()`).
- `packages/app/src/mobile/mobile-bridge.ts` — `DowndraftBridge` implementation for mobile (OPFS saves, web-API display info, Capacitor plugins for quit/external, no-ops for OSR/MCP/devtools).
- `packages/app/src/mobile/touch-input-adapter.ts` — maps touch events → `InputBufferWriter` (dual-stick, tap-to-move, tap schemes).
- `packages/app/src/mobile/webgpu-guard.ts` — boot-time WebGPU + cross-origin isolation check with user-facing error screen.
- `packages/app/src/mobile/capacitor-plugin-types.d.ts` — ambient type declarations for optional `@capacitor/app` and `@capacitor/browser` plugins.
- `packages/app/src/vite/mobile-vite-config.ts` — `createDowndraftMobileViteConfig()` web-only Vite build config (no main/preload, outputs `dist/mobile/`).
- `packages/cli/src/mobile.ts` — `draft mobile` CLI command (copy-from-shell + patch + icons + overrides + sync + gradle APK build + collect into `release/android/`).
- `packages/cli/src/mobile-icons.ts` — jimp-based icon + splash generation from `icon.png` (Android mipmaps + splash screens + iOS AppIcon + splash set). Generates solid-color placeholders if no `icon.png` is provided. The shell ships NO binary images.

### Per-feature Electron-only strategy

| Electron-only feature | Mobile strategy |
|---|---|
| OSR (Offscreen Rendering) | Skip (`features.osr: false`). Use DOM overlay for UI. |
| MCP automation harness | Skip in production (desktop dev/test only). |
| DevTools extension | Skip (use Safari Web Inspector / Chrome Remote Debug). |
| Pointer lock | Replace with `TouchInputAdapter` (dual-stick / tap-to-move / tap). |
| Save game state via IPC | OPFS / IndexedDB (already supported via `createSaveStore("auto")` fallback). |
| Per-game userData isolation | Handled by OS (each installed app is sandboxed). |
| Chromium GPU switches | N/A (WebGPU enabled by the WebView itself on supported OS versions). |
| Display refresh rate / DPR | Web APIs (`requestAnimationFrame` timing, `window.devicePixelRatio`). |
| GPU info / feature log | WebGPU adapter info (`GPUDeviceManager` already captures `adapter.info`). |
| Import cache | No-op on mobile (re-import each launch, or use IndexedDB adapter). |
| `quit()` / `openExternal()` | Capacitor plugins (`@capacitor/app`, `@capacitor/browser`). |

### Adding mobile support to a game

**Zero-config path:** Just run `draft mobile --game=<name>`. The command auto-generates everything:
- `capacitor.config.ts` — written if missing (correct appId, appName, webDir, server URL)
- `mobile.vite.config.ts` — defaulted at build time (no file needed unless customizing)
- `src/mobile.tsx` — auto-generated stub if missing (wire up renderer/sim/UI, then commit)

The only prerequisite is installing Capacitor deps: `bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios`

**Full setup:**

1. Run `draft mobile --game=<name> --target=all`. This will:
   - Auto-generate `src/mobile.tsx` (stub with placeholder GameModule)
   - Auto-generate `capacitor.config.ts` (if missing)
   - Copy the engine shell → gitignored `android/` + `ios/`
   - Generate icons + splash screens (from `icon.png` or solid-color placeholders)
   - Run `cap sync`
   - Build the release APK via the Gradle wrapper (Android target) and collect it into `release/android/` (+ unpacked to `release/android-unpacked/`)

2. Wire up the generated `src/mobile.tsx` stub — copy your renderer factory, sim adapter, and UI mount from `main.tsx`. Replace `startGame()` with `createDowndraftMobileApp()`.

3. (Optional) Add a 1024×1024 `icon.png` to the game directory for custom app icons.

4. (Optional) Create a `mobile-overrides/` directory for game-specific native customization (extra permissions, deps, resources).

5. Re-run `draft mobile` to regenerate native projects with your wired-up entry. The release APK lands at `release/android/<appName>-<version>-android.apk` (unsigned — sign with `jarsigner` / `apksigner` before distribution).

6. To run on a device/emulator (rather than just producing the APK): `npx cap open android` (or `ios`) and Run in Android Studio / Xcode.

**TODO (revisit later):** Extract a shared `game-module.ts` from each game's `main.tsx` so the auto-generated `mobile.tsx` stub can import and reuse it directly, eliminating the manual wiring step. Currently the stub has placeholder TODOs because games inline their `GameModule` into `startGame()` rather than exporting it.

### `draft mobile` CLI

```
draft mobile [--game=<name>] [--target=<android|ios|all>] [--port=<n>] [--skip-build] [--no-icons] [--no-overrides]
```

- Builds the web bundle via `createDowndraftMobileViteConfig()` → `dist/mobile/`.
- Copies the engine-owned shell (`packages/mobile-shell/`) → gitignored `android/` + `ios/` in the game dir.
- Patches game-specific values (appId, appName, port) into the native projects.
- Generates app icons from `icon.png` (via jimp) if provided.
- Applies `mobile-overrides/` merge layer if present.
- Ensures `capacitor.config.ts` exists (writes if missing).
- Syncs the web bundle to native projects (`npx cap sync`).
- Builds the release APK via the Gradle wrapper (`./gradlew assembleRelease`) and collects it into `release/android/<appName>-<version>-android.apk` (+ unpacked to `release/android-unpacked/`). Mirrors `draft dist` → electron-builder `release/` for desktop. Requires the Android SDK. The APK is unsigned — sign before distribution.
- Prints next steps (APK location + open Android Studio / Xcode to run on device).

### Config that must be updated when adding mobile support

- `packages/app/package.json` — `./mobile` and `./vite/mobile` export mappings (already done).
- `tsconfig.web.json` — `packages/app/src/mobile/**` include + `@downdraft/app/mobile` path mapping (already done).
- Game's `capacitor.config.ts` — `appId`, `webDir: "dist/mobile"`, `server.url: "http://127.0.0.1:<port>/index.html"`, `server.androidScheme: "http"`, `server.iosScheme: "http"`.
- No native project editing required — the shell is pre-wired.

### Android emulator + adb — always use hard timeouts

**ALWAYS pass a hard `timeout` to `exec` when running `adb` or emulator commands.** The `adb` shell, `adb wait-for-device`, and emulator boot sequences can hang indefinitely (emulator fails to start, `adb` daemon dies, device enters an unrecoverable state). Without a hard timeout the exec call blocks forever and the session stalls.

```bash
# GOOD — hard timeout, fails fast if something is wrong
timeout 120 adb wait-for-device
timeout 30 adb shell getprop sys.boot_completed

# BAD — can hang forever if the emulator never boots
adb wait-for-device
```

Recommended timeout values:
- `adb wait-for-device` — 120s (emulator boot can take 60-90s)
- `adb shell <cmd>` — 15-30s (most shell commands return in <5s)
- `adb install` — 60s (large APKs on slow emulators)
- `adb logcat -d` — 10s (dump only, no streaming)
- `emulator` startup — background it, then poll `adb shell getprop sys.boot_completed` with 5s sleeps inside a `timeout 120` loop
- `gradlew assembleDebug` — 180s (cold Gradle daemon + first build can be slow)

If a command times out, kill the emulator (`adb emu kill`) and restart it rather than retrying the same hung command.

### WebGPU on the Android emulator

The Android emulator's WebView often returns `null` from `navigator.gpu.requestAdapter()` even though `navigator.gpu` exists and `canvas.getContext('webgpu')` returns an object. This is because:

1. **WebGPU requires a functional GPU backend** (Vulkan 1.1+ or OpenGL ES 3.1+ via compatibility mode). The emulator's GPU emulation (`-gpu host`, `-gpu swiftshader_indirect`) may not expose a Vulkan backend that Dawn (Chrome's WebGPU implementation) can use.
2. **The GPU blocklist** may disable WebGPU even when a GPU is present. Enable `--ignore-gpu-blocklist` and `--enable-unsafe-webgpu` via the WebView command-line file.
3. **Compatibility mode** (`featureLevel: "compatibility"` or `compatibilityMode: true` in `requestAdapter()`) can use the OpenGL ES backend on Chrome 135+, but the emulator's GLES emulation may still fail.

**Emulator GPU modes to try (in order):**
1. `-gpu host` — uses the host GPU (NVIDIA/AMD). Best chance of WebGPU working, but can crash with SIGSEGV if the Vulkan driver has issues.
2. `-gpu swiftshader_indirect` — software renderer. Slower but more stable. WebGPU may still fail (SwiftShader doesn't always expose a WebGPU-compatible backend).
3. `-gpu host -feature GLESDynamicVersion` — forces GLES version detection, sometimes helps with WebView GPU init.

**WebView command-line flags to try:**
```bash
adb shell "echo 'webview --enable-features=SharedArrayBuffer,UnsafeWebGPU --ignore-gpu-blocklist' > /data/local/tmp/webview-command-line"
```

**If WebGPU cannot be enabled on the emulator**, the game will boot (React UI renders, sim worker runs) but the canvas will be blank — `renderer.init()` returns `false` because `requestAdapter()` returns `null`. This is an emulator limitation, not a code bug. Test on a physical Android device with Chrome 121+ (Mali/Adreno GPUs) for real WebGPU validation.

### Debugging the running app via CDP

The WebView exposes a Chrome DevTools Protocol endpoint that can be used for runtime inspection:

```bash
PID=$(adb shell pidof com.downdraft.sandjongg | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
# Then connect to http://127.0.0.1:9222/json via Python websocket
# or open chrome://inspect in a desktop Chrome browser
```

This allows evaluating JS in the WebView context to check `navigator.gpu`, `requestAdapter()`, DOM state, and console output — useful for diagnosing boot failures without logcat noise.

