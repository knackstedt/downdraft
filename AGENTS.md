# Downdraft Engine — Agent Notes

## Module architecture: engine vs game boundary

> **Terminology note:** The compile-time DI units that were previously called "plugins" are now called **modules** to disambiguate. The term **"plugin" is now reserved for the upcoming user-authored plugin system** (runtime-loadable extensions authored by end users / modders). Throughout this document, "module" refers to the engine's compile-time DI units (`Module`, `RendererModule`, `ModuleHost`, etc.).

The engine is split into **core + libraries** (standard engine building blocks, used directly by games) vs **modules** (opt-in game features with lifecycle + typed DI + diagnostics). The `@downdraft/core` package also includes animation, particles, and imui subsystems directly (these were previously separate `@downdraft/library-*` packages but have been folded into core).

- **Engine libraries** (namespace `@downdraft/library-*`, located in `packages/libraries/`): packages that export classes/functions without a module lifecycle. Games can either import and wire these directly, or declare them via `EngineLibrary` descriptors in `GameModule.libraries[]` for auto-wiring (SAB allocation, sim system creation, renderer pass creation, typed DI tokens). Engine libraries: water, physics-rapier, physics-native, marching-cubes, surface-nets, audio-kira, models, networking, weatherfx, pixi-ui, entities, lighting, weather, navmesh, recast, persistence, gaussian-splats, sand, stickman, profiler.
- **Engine modules** (namespace `@downdraft/module-*`, located in `packages/modules/`): packages that implement the `Module` or `RendererModule` interface with a `register()` lifecycle + typed DI. Engine modules: camera-controls, devtools, electron-osr, mcp, xr, terrain, movement-3d, movement-2d, sailing.
- **Game modules** (namespace `@to-the-ocean/module-*`, located in `games/<game>/modules/`): game-specific features with a module lifecycle. Game modules: crafting, inventory, buoyancy, collision, wildlife.
- **Game libraries** (namespace `@to-the-ocean/library-*`, located in `games/<game>/libraries/`): game-specific pure libraries without a module lifecycle. Game libraries: boats, economy, fishing, items, survival.

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

### Feature modules

Feature modules (`@downdraft/module-terrain`, `@downdraft/module-movement-3d`, `@downdraft/module-movement-2d`, `@downdraft/module-sailing`) use the factory pattern (`createXxxModule(config)`) and provide typed DI tokens. Games register them via `moduleHost.useModules([...])` for batch activation in dependency-resolved order.

### Cross-thread module contract

`CrossThreadToken<T>` tags resources with a thread ("sim" | "renderer" | "shared"). `buildCrossThreadReport()` detects unresolved requires, shared resources, and version conflicts across sim + renderer module hosts. The `downdraft doctor` devtools panel displays this report.

### Migration guide (from old API)

1. **String-based resources → typed tokens**: Replace `world.setResource("name", value)` / `world.getResource("name")` with `resourceToken<T>("name")` + `ctx.provide(token, value)` / `ctx.inject(token)`.
2. **bootstrapGame() callbacks → startGame() module**: Replace the callback-soup `main.tsx` with a declarative `GameModule`. Move sim event handling into `events: {}`, game-specific wiring into `onReady`, cleanup into `onDispose`.
3. **Manual library wiring → EngineLibrary descriptors**: Replace manual SAB allocation + system instantiation with `libraries: [WaterLib, ...]` in the GameModule. Use typed tokens to inject library-provided resources.
4. **registerModuleDeferred + activateAll → useModules**: Replace the two-step batch registration with `moduleHost.useModules([...])`.

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

No engine package depends on any game package (verified). The `entities` library is an engine library (generic `ModelRenderer` used by multiple games). When adding a new game, create `games/<game>/modules/` for its game-specific modules and `games/<game>/libraries/` for its game-specific pure libraries.

### Visual Test Bench (`games/visual-test-bench`)

A graphical test program (modeled on `games/model-viewer`) for visually verifying engine effects and functional systems. Provides a React DOM menu of minimal tests, each with its own renderer factory. Extensible via a `TestRegistry` API — game authors add tests by creating `*.test.ts` files in `src/tests/` that call `registerTest()`. Vite glob import auto-discovers them.

- **Run**: `cd games/visual-test-bench && ../../node_modules/.bin/electron-vite dev --config electron.vite.config.ts` (or `draft dev` from the game directory via cwd inference).
- **Not in root workspaces** (follows model-viewer pattern: `@downdraft/*` resolved via vite aliases, not type-checked by root tsconfig).
- **Test interface**: `VisualTest { id, name, category, description, createRenderer(canvas): ITestRenderer, getControls?(): TestControl[] }`. Each test owns its own GPU resources; the bench disposes + recreates the renderer when switching tests.
- **Built-in tests**: navmesh (recast + legacy, with mesh wireframe + path debug viz), postfx (the PostProcessStack with 21 chainable effects — TAA, SSAO, SSR, DOF, Motion Blur, Bloom, Bloom-Soft, Tonemap, FXAA, Sharpen, Grain, Sobel, Edges, Lens Flare, Pixelation, Gaussian Blur, Afterimage, Outline, Highlight, Glow, ASCII — on a 3D scene).
- **Adding a test**: create `games/visual-test-bench/src/tests/<category>/<name>.test.ts`, call `registerTest({ ... })` at module load. The Vite glob in `src/tests/index.ts` picks it up automatically.

### Typed DI (provide/inject + provides/requires)

Modules use typed `ResourceToken<T>`-based dependency injection instead of stringly-typed resource names:

```ts
import { resourceToken, type Module } from "@downdraft/core";

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

- `ctx.provide(token, value)` — typed write; in `DOWNDRAFT_STRICT` mode throws on duplicate key.
- `ctx.inject(token)` — typed read; throws if the token has no provider (use `injectOptional` for safe reads).
- `provides`/`requires` arrays — the host validates the dependency graph at activation, before any `register()` runs. Missing provider → hard error naming both modules.
- The stringly-typed `registerResource(name, value)` / `getResource(name)` API has been **removed**. Use `resourceToken<T>(key)` + `provide`/`inject` instead.

### DOWNDRAFT_STRICT diagnostics

When `DOWNDRAFT_STRICT=1` (or in Vite dev mode), the module hosts validate the dependency graph and catch common footguns:
- Duplicate `provide` → hard error.
- Missing `requires` provider at activation → hard error.
- Leak detection: module provides resources / allocates SAB channels but registers no `onDispose()` cleanup → warning on unload.

Set `DOWNDRAFT_STRICT=0` to force-disable in dev, `DOWNDRAFT_STRICT=1` to force-enable in prod.

Config that must be updated when moving/adding packages: `package.json` (root workspaces), `tsconfig.web.json` + `tsconfig.node.json` (path mappings + include globs), `packages/app/src/vite/index.ts` (renderer aliases + hot-reload simPaths/excludePaths). Engine libraries live in `packages/libraries/`; engine modules live in `packages/modules/`.

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

## PixiJS UI overlay library (`@downdraft/library-pixi-ui`)

A worker-hosted PixiJS UI overlay: the library spawns a Web Worker that renders a GUI onto an `OffscreenCanvas` (via `transferControlToOffscreen`) stacked above the main game canvas. Games feed per-frame scalars via a `SharedArrayBuffer` (UiStatsSAB) and event-driven data via `postMessage`. The overlay canvas is `pointer-events: none` by default (game keeps all input); when the worker signals interactive/modal UI, the host flips the canvas to `pointer-events: auto` and forwards pointer events to the worker for PixiJS hit-testing.

### Architecture

- **Canvas layering**: the overlay canvas is `data-dd-layer="1"` (z-index 50, above the game canvas at z 0, below the DOM overlay at z 100). The host acquires an existing canvas with `data-dd-layer="1"` or creates one if absent. `PixiUiHost.start()` sets inline styles (`position: fixed; z-index: 50`) on the overlay canvas AND `position: fixed; z-index: 0` on the game canvas (layer 0) to ensure correct stacking even if the game doesn't import `downdraft-base.css`. Games MUST still `@import "@downdraft/app/renderer/downdraft-base.css"` in their globals.css for the full stacking rules (pointer-events, image-rendering, DOM overlay z-index 100). The `#root` div MUST have `background: transparent` so it doesn't cover the pixi-ui canvas.
- **Worker lifecycle**: `PixiUiHost.start()` → `transferControlToOffscreen()` → spawn worker → send init message (OffscreenCanvas + UiStatsSAB + config, all transferable). Worker creates `PIXI.Application` on the OffscreenCanvas, dynamically imports the game's scene module, and runs a ticker loop.
- **Worker message handler**: The worker uses `self.addEventListener("message", ...)` instead of `self.onmessage = ...` because PixiJS's internal worker code (e.g. `loadImageBitmap` worker) overwrites `self.onmessage` during `Application.init()`. `addEventListener` handlers cannot be overwritten by assignment, so the message handler survives PixiJS init. The worker also removes the Application's auto-render callback from the ticker and handles `app.render()` in its own `tick()` function with try/catch — if `app.render()` throws (e.g. WebGL context issues on OffscreenCanvas), the uncaught error would stop the PixiJS ticker and make the worker unresponsive.
- **Worker EventSystem + document stub**: PixiJS v8's EventSystem is not loaded by default in the worker because `pixi.js/events` (the side-effect import that registers it as a renderer extension) is not imported. The worker explicitly imports `pixi.js/events` to register the EventSystem so `app.renderer.events` is available for pointer hit-testing. However, the EventSystem's `_addEvents()` method registers DOM event listeners on `globalThis.document` and `globalThis` — neither exists in a Web Worker. The worker stubs `globalThis.document` with no-op `addEventListener`/`removeEventListener`/`dispatchEvent`, `createElement('canvas')` returning an `OffscreenCanvas` (for PixiJS text rasterization), and `body.contains()` returning `true` (for `isRenderingToScreen()`). Pointer events are dispatched manually via `eventSystem._onPointerDown(syntheticEvent)` etc. (underscore-prefixed methods, not `onPointerDown`). The synthetic event must include `type`, `target`, `composedPath`, `cancelable`, `isPrimary`, `width`, `height`, `tiltX`, `tiltY`, `pressure`, `twist`, `tangentialPressure` — `_bootstrapEvent` reads these and `_onPointerUp` checks `target === domElement` to determine if the pointerup is "inside" (enabling click).
- **Data model**: `UiStatsSAB` (fixed-layout `SharedArrayBuffer` with a 16-byte header + float32 slots) for high-frequency per-frame scalars (health, fps, positions). `postMessage` for event-driven/structured data (inventory, menu toggles, notifications). Games call `host.writeStats({...})` from their game loop and `host.postEvent({...})` for events.
- **Input model**: worker calls `ctx.setInteractive(true/false)` → host toggles `canvas.style.pointerEvents` + forwards pointer events to worker for PixiJS `eventMode` hit-testing. Modal UI (menus, buttons) flips interactive on; display-only HUDs keep it off.
- **Renderer backend**: WebGL2 by default. Games override via `backend: "webgl2" | "webgpu" | "auto"`. WebGL2 is most reliable for a 2D UI overlay (avoids dual-WebGPU-device concerns with the main game canvas).
- **`@pixi/react` adapter**: optional `@downdraft/library-pixi-ui/react` module for declarative React components rendering to PixiJS. Games add `@pixi/react` + `react` to their deps and `@vitejs/plugin-react` to `workerPlugins` in their vite config. The core library does NOT depend on React. The adapter calls `extend()` to register PIXI components (Container, Graphics, Text, Sprite, etc.) in the `@pixi/react` catalogue (v8 requires explicit registration). It also patches the React fiber's `containerInfo` to point to the worker's existing PIXI.Application stage (createRoot creates a throwaway Application internally; without patching, React renders into the wrong stage and nothing appears). Components use the lowercase `<pixiContainer>`, `<pixiText>`, `<pixiGraphics>` convention (v8's `parseComponentType` converts `pixiX` → `X`). Event props use React naming: `onPointerDown`, `onPointerUp`, etc. (the adapter maps them to PixiJS event names).

### Declarative usage (via `GameModule.libraries[]`)

```ts
import { PixiUiLib, PixiUiHostTok } from "@downdraft/library-pixi-ui";

startGame({
  libraries: [[PixiUiLib, {
    backend: "webgl2",
    sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
  }]],
  // ...
  onReady: async (ctx) => {
    const host = ctx.libraryHost!.injectResource(PixiUiHostTok);
    await host.start(); // transfer canvas + spawn worker
    host.onAction = (action) => { /* handle pause/resume/save */ };
    // In game loop: host.writeStats({ fps, health, ... });
  },
});
```

### Escape hatch (manual wiring)

```ts
import { PixiUiHost } from "@downdraft/library-pixi-ui";
const host = new PixiUiHost({ sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href });
await host.start();
```

### Scene module

Games implement a `PixiUiScene` factory (default export of the scene module). The worker dynamically imports it and calls it with a `PixiUiSceneContext` (PIXI.Application, width/height, setInteractive, postAction). The scene's `update()` is called each frame with the latest SAB stats + drained events.

### Pass-through mode (interactive UI + game-canvas input)

For games where interactive UI elements (toolbars, buttons, sliders) coexist with game-canvas mouse input (e.g. painting on a canvas), set `passThrough: true` in the `PixiUiLibConfig` / `PixiUiHostOptions`. In this mode:

- The overlay canvas is always `pointer-events: auto` (it captures all pointer events).
- The scene implements `getInteractiveRegions(): Rect[]` — bounding boxes of clickable/draggable UI elements in canvas pixel coordinates.
- The host synchronously hit-tests each pointer event against the cached regions:
  - **Inside a region** → forwarded to the worker for PixiJS `eventMode` hit-testing (normal interactive path).
  - **Outside all regions** → dispatched as a synthetic `PointerEvent` on the game canvas (`data-dd-layer="0"`), so the game keeps receiving mouse input with zero postMessage latency.
- The worker calls `scene.getInteractiveRegions()` after each `update()` and posts the regions to the host (only when changed, to avoid flooding the message channel).
- The scene should return `[]` when no interactive elements are visible (display-only HUD).

This replaces the original modal-UI model (`setInteractive(true/false)` toggling the whole canvas). Games that only have modal UIs (menus that capture all input) can still use the non-pass-through mode + `setInteractive`.

### Data bridge convention (migrating from React/Solid DOM overlays)

The pixi-ui worker **cannot read the main-thread zustand store directly**. State flows through three channels:

1. **`UiStatsSAB`** (per-frame scalars, host→worker, zero-copy): the host calls `host.writeStats({ fps, health, ... })` each frame from a rAF loop or the game's `onFpsUpdate` hook. Each game declares its own `statsLayout` (slot name list) in `PixiUiLibConfig`. Slot names map to float32 offsets in the SAB. Booleans are encoded as 0/1.
2. **`postMessage` events** (structured data, host→worker): `host.postEvent({ kind: "setInventory", items: [...] })` for non-scalar/event-driven data (inventory, saves, notifications, menu toggles). The host subscribes to zustand store changes and forwards them. Each game defines its own event `kind` strings in a `src/pixi/bridge-protocol.ts`.
3. **`onAction`** (side-effect requests, worker→host): the scene calls `ctx.postAction({ kind: "pause" })` for main-thread side effects (pause, save, teleport, select material). The host's `onAction` handler dispatches into the zustand store / renderer / sim bridge.
4. **Renderer snapshots** (optional, ~30fps): for overlays that need camera-transform positioning (signposts, minimap, reticule), the host posts a `PixiUiEvent` with kind `"snapshot"` carrying compact camera + entity arrays.

A per-game **worker-side store mirror** (`src/pixi/store.ts`) holds the worker's copy of state, updated from SAB ticks + events. For `@pixi/react` games, this is a minimal reactive store (e.g. `useSyncExternalStore`) so React re-renders on event arrival. For raw PixiJS scenes, the scene reads directly from the `stats` object passed to `update()` and maintains its own state from events.

### Migrating a React overlay to pixi-ui

1. **Create `src/pixi/bridge-protocol.ts`** — define event kinds (main→worker) and action kinds (worker→main) by auditing every zustand store field the React components read (→ event or SAB slot) and every store mutation they trigger (→ action kind).
2. **Create the scene module** (`src/pixi-scene.ts` for raw PixiJS, or `src/pixi/scene.tsx` + `src/pixi/components/*` for `@pixi/react`). Port each React component's visual structure to PIXI display objects (`Container`, `Graphics`, `Text`, `Sprite`). Replace `useGameStore` reads with SAB stats / worker store mirror reads. Replace `useGameStore` mutations with `ctx.postAction(...)`.
3. **Rewire `main.tsx`**: replace `mountUI: (overlay) => createRoot(overlay).render(<App/>)` with the pixi-ui escape hatch (`new PixiUiHost(...)`) or declarative `libraries: [[PixiUiLib, config]]`. In `onReady`: get the host, set `onAction` to dispatch into the store/renderer, start a per-frame `host.writeStats(...)` loop (rAF or `onFpsUpdate`), subscribe to store changes → `host.postEvent(...)`. In `onDispose`: `host.dispose()`.
4. **HTML layer spec** (`electron.vite.config.ts`): add the pixi overlay canvas layer (`{ type: "canvas", id: "pixi-ui-canvas" }`) above the game canvas. Import `@downdraft/app/renderer/downdraft-base.css`.
5. **Dependencies**: add `@downdraft/library-pixi-ui` + `pixi.js` to game deps. For `@pixi/react` games, also add `@pixi/react`, `react`, `react-dom`, and `@vitejs/plugin-react` to `workerPlugins` in the vite config.
6. **Delete** the old `src/app.tsx`, `src/components/*`, and UI-only CSS.
7. **Interactive UI + game input**: if the game has clickable UI elements that coexist with game-canvas mouse input, set `passThrough: true` and implement `getInteractiveRegions()` in the scene. If the game only has modal menus (full-screen overlays that capture all input), use the default non-pass-through mode + `setInteractive(true)`.

### Migration status (all games migrated to pixi-ui)

All five games have been migrated from React/Solid DOM overlays to the worker-hosted PixiJS overlay:

| Game | Renderer | Components | E2E tests | Notes |
|---|---|---|---|---|
| `falling-sand` | raw PixiJS | 1 scene | passing | Pilot migration; simplest game |
| `sandjongg` | raw PixiJS | 1 scene | 6/6 pass | Raw PixiJS scene with tile sprites |
| `overburden` | `@pixi/react` | 11 components | 15/15 pass | `passThrough: true` for hotbar + menus |
| `to-the-ocean` | `@pixi/react` | 17 components | 6/6 pass | `passThrough: true`; renderer snapshots at ~30fps |
| `mining-rpg` | `@pixi/react` | 24 components | no e2e test | Reused Solid bridge protocol types; `passThrough: true` |

Dead code removed during migration:
- `src/app.tsx` — deleted from all 5 games (was the React DOM root).
- `src/components/` — deleted from all 5 games (old React DOM components).
- `src/solid/` — deleted from mining-rpg (old Solid-in-worker path; bridge types moved to `src/pixi/bridge-protocol.ts`).
- `solid-js` + `vite-plugin-solid` deps removed from mining-rpg `package.json`.
- `@floating-ui/react`, `lucide-react`, `framer-motion` deps removed from to-the-ocean `package.json`.

### MCP automation tools

`createPixiUiMcpTools(host)` returns MCP tool registrations for e2e testing:
- `pixi_capture_overlay` — capture the overlay canvas alone as PNG base64.
- `pixi_get_scene_state` — query the PixiJS scene-graph summary (named nodes, visibility, positions, text labels).
- `pixi_dispatch_pointer` — send a synthetic pointer event to the worker for hit-testing.
- `pixi_set_interactive` — force-toggle interactive mode.

### `renderer.create` hook

The library uses the `renderer.create` hook on `EngineLibrary` (the early renderer-side hook that runs before the WebGPU device is acquired). This is the clean fit for renderer-only libraries that need to construct a host + provide a DI token without GPU access. Other renderer-only libraries (audio, input routers) can use the same hook.

### Files

- `packages/libraries/pixi-ui/src/library.ts` — `PixiUiLib` descriptor + `PixiUiHostTok` token + config types.
- `packages/libraries/pixi-ui/src/host.ts` — `PixiUiHost` (main thread): canvas acquire, `transferControlToOffscreen`, SAB alloc, worker spawn, pointer-events toggle, MCP query/capture.
- `packages/libraries/pixi-ui/src/pixi-ui-worker.ts` — worker entry: PIXI.Application init on OffscreenCanvas, scene mounting, ticker loop, pointer hit-testing, scene-state query, capture.
- `packages/libraries/pixi-ui/src/ui-stats-sab.ts` — UiStatsSAB layout + read/write helpers.
- `packages/libraries/pixi-ui/src/bridge-protocol.ts` — typed main↔worker message protocol.
- `packages/libraries/pixi-ui/src/scene.ts` — `PixiUiScene` interface + `PixiUiSceneContext`.
- `packages/libraries/pixi-ui/src/react.ts` — optional `@pixi/react` adapter.
- `packages/libraries/pixi-ui/src/mcp-tools.ts` — MCP automation tool registrations.
- `examples/pixi-ui-demo/` — standalone example (health bar + FPS + pause button).
- `tests/e2e/pixi-ui-demo.spec.ts` — e2e smoke test via MCP harness.

## Per-game storage isolation

Each game MUST pass a unique `appId` to `createDowndraftApp()`. This sets a per-game Electron `userData` directory (e.g. `~/.config/downdraft-mining-rpg/`) so that Chromium storage subsystems (OPFS, IndexedDB, Service Worker DB, cookies, cache) are fully isolated per game. Without this, all games share the same `--user-data-dir` and concurrent instances corrupt each other's LevelDB locks (`File System/Origins/LOCK`, `Service Worker/LOCK`), causing OPFS init failures and games not loading.

When `appId` is set, `createDowndraftApp()` also:
1. Calls `app.requestSingleInstanceLock()` — prevents two instances of the same game from running concurrently (which would corrupt storage). A second launch focuses the existing window and quits. **Skipped in deterministic/test mode** (`DOWNDRAFT_DETERMINISTIC=1`): the test harness controls process lifecycle itself (dynamic MCP ports + process-group kills), and the singleton lock mechanism (Unix socket + `SingletonLock` file in userData) can fail to initialize in sandboxed CI environments, causing the game to quit immediately and fail every E2E smoke test.
2. Calls `cleanupStaleStorage()` — removes stale LevelDB `LOCK` files, Electron `SingletonLock`/`SingletonSocket` artifacts, and `.org.chromium.Chromium.*` temp files from a previous run that crashed or was killed. In non-deterministic mode this is safe because the single-instance lock guarantees no live process is using the directory; in deterministic mode the test harness guarantees no concurrent instance.

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

Each game runs as an Electron process launched against its own `games/<game>/electron.vite.config.ts` entrypoint (dev mode: `draft dev` from inside `games/<game>/`, or `npx electron-vite dev --config games/<game>/electron.vite.config.ts` from the repo root; built mode: `npx electron .` from `games/<game>`). `draft dev` automatically kills any stale Electron instance from a previous run of the same game before spawning (cross-platform: Linux `/proc`, macOS/`ps`, Windows PowerShell) — you do not need to do this manually. To kill a specific game instance yourself, target **that game only**:

- **Let `draft dev` handle it** — re-running `draft dev` from the game directory tears down the previous instance automatically. This is the preferred path.
- **Match the per-game `--user-data-dir`** (each game sets a unique `downdraft-<game>` userData dir, visible in the process args) only if you need to kill a process you did not launch via `draft dev`:
  ```bash
  # Kill only the to-the-ocean game process and its children
  for pid in $(pgrep -f "user-data-dir=[^ ]*downdraft-to-the-ocean" 2>/dev/null); do
    kill -TERM "$pid" 2>/dev/null
  done
  ```
- **Match the MCP port** if you know which port the game's MCP HTTP transport is bound to (default 9876 for dev, 9976 for `draft test`):
  ```bash
  fuser -k 9876/tcp   # kills whatever is bound to the game's MCP port
  ```

Prefer `kill -TERM` first (lets the game clean up storage locks via `cleanupStaleStorage()` and `requestSingleInstanceLock()`); only escalate to `kill -9` if the process doesn't exit within a few seconds. If you launched the game yourself (via `draft dev`, `draft test`, or the e2e harness), prefer terminating the parent shell/process you spawned rather than hunting for the Electron child.

### Debugging games — do NOT use a browser / Playwright

**Do NOT use a browser (Chrome, Playwright, `browser_preview`, the `devin/mcp-playwright` MCP server, or any other web browser tool) to debug or drive Downdraft games.** The games are Electron + WebGPU apps that rely on:

- Pointer lock and raw input events (browsers block or interfere with these).
- Offscreen rendering (OSR) and Chromium-specific GPU switches (`webGpuSwitches()`).
- Per-game `--user-data-dir` isolation (see "Per-game storage isolation" above).
- Worker threads, SharedArrayBuffer, COOP/COEP headers set in `window.ts`.
- `window.downdraft` preload bridge APIs that only exist inside the Electron preload context.

A plain browser cannot reproduce any of this, and Playwright driving a browser will not exercise the real game code paths. The `devin/mcp-playwright` MCP server is for general web pages, **not** for Downdraft games.

**Instead, use the in-game MCP automation harness and `draft test`:**

1. **`bun run draft:test-cpu`** (or `bun run draft:test`) — the canonical way to launch and exercise a game headlessly. `draft test` sets `DOWNDRAFT_DETERMINISTIC=1` and spawns `bun test <spec>`; the default smoke specs use the in-game MCP RPC harness to boot the real Electron app and drive it. See "Running the smoke test" below for the full CLI flag reference.
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
cd games/to-the-ocean && DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 MCP_PORT=9876 draft dev &
# 2. Call ocean MCP tools (inject_input, get_player_state, capture_screenshot, ...)
#    to drive the game and inspect state.
# 3. When done, kill ONLY this game instance (see "Killing game processes" above).
```

## Module registration patterns

The engine supports two registration patterns:

1. **Direct registration** (`moduleHost.registerModule(module)`) — registers and immediately activates a single module. Use for standalone modules with no interdependencies.

2. **Batch registration** (`moduleHost.registerModuleDeferred(module)` + `moduleHost.activateAll()`) — registers multiple modules, then activates them in dependency-resolved topological order. Use when multiple modules have `dependencies` arrays. `GameWorld.useModules(modules[])` wraps this pattern.

Libraries that export factory functions (e.g., `createWildlifeSystem`) can be wrapped as modules using a factory pattern:
```ts
export function createWildlifeModule(opts: WildlifeModuleOptions): Module {
  return { name: "wildlife", version: "1.0.0", register(ctx) { ... } };
}
```
The `opts` object encapsulates all config and dependencies. This is the standard pattern for migrating library packages to the module system.

## Verification commands

- `bun run tsc` — now runs `tsc -p tsconfig.web.json --noEmit && tsc -p tsconfig.node.json --noEmit`.
- `bun run lint` — runs `oxlint` on the whole repo. Currently reports many pre-existing `no-console`/`no-unused-vars` warnings/errors.
- `bun test packages/core/src/ecs/world.spec.ts packages/core/src/render/frustum.spec.ts packages/core/src/telemetry/collector.spec.ts`
- `bun test packages/core/src/physics/*.spec.ts` — all physics specs (121 tests).
- `bun test packages/modules/physics-rapier/src/*.spec.ts` — rapier module specs (16 tests).
- `bun test packages/core/src/render/bindless/bindless.spec.ts` — bindless texture registry + material manager specs.
- `bun test packages/core/src/material/material.spec.ts packages/core/src/material/variants.spec.ts` — material + variant specs.
- `bun test packages/shader-graph/src/graph.spec.ts` — shader graph compiler specs (includes GBuffer multi-target + variant tests).
- `bun test packages/modules/models/src/material-adapter.spec.ts` — MaterialData→Material adapter specs.
- `bun test packages/core/src/assets/model-normalizer.spec.ts` — model normalizer math (up-axis, units, bounds, auto-fit).
- `bun test packages/modules/models/src/bake-node-transforms.spec.ts` — node hierarchy transform baking specs.
- `bun test packages/modules/models/src/sidecar/sidecar.spec.ts` — sidecar parsers (.ddmeta.json, Unity .meta, Godot .import, Blender extras).
- `bun test packages/modules/models/src/normalize.spec.ts` — full normalization pipeline specs.
- `bun test packages/core/src/module/host.spec.ts` — ModuleHost activation order, deferred registration, dispose order (12 tests).
- `bun test packages/modules/devtools/src/api.spec.ts` — Unified DevTools API: realm detection, SAB data feeds, manifest, panel/command registration (17 tests).
- `bun test packages/app/src/main/window.spec.ts` — cross-origin isolation header logic (COEP/file:// worker loading, 7 tests).
- `bun test packages/core/src/render/gpu-utils.spec.ts` — GPU resource creation utilities (8 tests, uses mock GPUDevice).
- `bun test games/to-the-ocean/modules/wildlife/src/wildlife-module.spec.ts` — game module wrappers (wildlife, buoyancy, collision) (9 tests).
- `bun test packages/modules/persistence/src/file-save-store.spec.ts` — FileSaveStore (filesystem ISaveStore) specs (9 tests).
- `bun test packages/modules/persistence/src/opfs-save-store.spec.ts` — OpfsSaveStore (OPFS ISaveStore) specs (22 tests). Uses mock OPFS — no browser/worker environment needed.
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

The DevTools system has a single registration surface (`devtools` singleton from `@downdraft/module-devtools`) that auto-detects whether it's running in the main realm or a worker realm and chooses the appropriate transport:

- **Main realm**: panels/feeds/commands registered directly on `window.__sceneInspector` via `DevToolsDataBridge`.
- **Worker realm**: data feeds written to a devtools SharedArrayBuffer (zero-copy, synchronous reads); commands forwarded via IPC RPC; panel declarations synced to renderer via one-time manifest RPC.

### Architecture

- **`devtools` singleton** (`packages/modules/devtools/src/api.ts`) — the unified API. Auto-detects realm. Modules import `devtools` and call `registerPanel()`, `registerDataFeed()`, `registerCommand()`, `registerSABStat()`. Same code works in both realms.
- **`DevToolsSABLayout`** — dedicated SAB region for JSON-serialized data feed results + direct numeric stats. Worker writes via `flushDataFeeds()` (called from sim loop); renderer reads synchronously. No IPC polling.
- **`exposeDevToolsApi()`** (`packages/modules/devtools/src/worker-expose.ts`) — wraps a worker's `expose()` API with `__devtoolsGetManifest`, `__devtoolsCallCommand`, `__devtoolsGetSAB` RPC methods.
- **`syncWorkerManifests()`** (`packages/modules/devtools/src/worker-sync.ts`) — renderer-side: fetches manifest from workers, merges panels, wires SAB data feed readers, wires command forwarders.
- **`createDevToolsRendererAdapter()`** (`packages/modules/devtools/src/renderer-adapter.ts`) — feature-detects renderer capabilities (gpuProfiler, telemetryCollector, gpuResourceTracker, gcController) and builds an `IDevToolsDataRenderer`.
- **`createSimStatsProvider()`** (`packages/modules/devtools/src/sim-stats-provider.ts`) — reusable `ISimStatsProvider` factory with 10Hz polling + pause/resume/step/speed/clear delegation. Eliminates duplicated boilerplate across sim games.
- **`initDevTools()`** (`packages/modules/devtools/src/init.ts`) — one-line wiring per game. Creates bridge, wires providers, merges global registry panels, syncs worker manifests, exposes on `window.__sceneInspector`.
- **`createMaterialStatsPanelExtension()`** (`packages/modules/devtools/src/material-stats-panel.ts`) — reusable "Materials" tab for any game using the unified material system.

### Module integration

Both `ModuleContext` (sim) and `RendererModuleContext` (renderer) have a `devtools` property. Modules self-register during `register()`:

```ts
// In a renderer module
register(ctx: RendererModuleContext) {
  ctx.devtools.registerPanel({ id: "physics", tabLabel: "Physics", ... });
  ctx.devtools.registerDataFeed("getPhysicsStats", () => ({ bodyCount: ... }));
}

// In a sim module (worker realm)
register(ctx: ModuleContext) {
  ctx.devtools.registerPanel({ id: "wildlife", tabLabel: "Wildlife", ... });
  ctx.devtools.registerDataFeed("getWildlifeStats", () => ({ count: ... }));
  ctx.devtools.registerCommand("cullWildlife", (max: number) => { ... });
}
```

The host injects the `devtools` singleton via `ModuleHost.setDevToolsAPI()` / `RendererModuleHost.setDevToolsAPI()`. If not set, a no-op stub is used (modules that call `ctx.devtools.registerPanel()` silently no-op).

### Deterministic mode

`resolveDevtoolsConfig()` in `packages/app/src/main/handlers/devtools.ts` is now deterministic-aware: when `DOWNDRAFT_DETERMINISTIC=1`, autoOpen defaults to `false` and keybind defaults to `""` (disabled). Games no longer need to plumb `devtools: { autoOpen: !deterministic, keybind: deterministic ? "" : "F12" }` — just use `devtools: true`.

### Panel order convention

- `0–19`: core devtools tabs (Scene, Import, Perf, GC, Material, Render Graph)
- `20–50`: renderer-module tabs (Physics, Water, Audio, Particles)
- `50–80`: sim-module/worker tabs (Wildlife, Buoyancy, Collision, Sim Stats)
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

### Material adapter (module-models)

`materialDataToMaterial()` (`packages/modules/models/src/material-adapter.ts`) bridges serialized `MaterialData` (glTF/obj format) to the core `Material` surface. Maps baseColor/metallic/roughness/emissive to uniforms, sets `inlineShaderSource` from the physical fallback .wgsl. `materialDataArrayToMaterials()` batch-converts. The game's `RendererAccessors.uploadModel()` calls this to register materials in a `MaterialLibrary`.

## Model Import Normalization Pipeline

The engine has a unified model import normalization pipeline that corrects common anomalies (incorrect scaling, rotation, up-axis) at load time. This replaces ad-hoc hardcoded fixes in individual games.

### Architecture

- **`ImportSettings`** (`packages/core/src/assets/import-settings.ts`) — per-model normalization config: `upAxis`, `units`, `scale`, `rotation`, `centerToOrigin`, `autoFit`, `nodeTransforms`. Resolved from sidecar files or parser-detected defaults.
- **`model-normalizer.ts`** (`packages/core/src/assets/model-normalizer.ts`) — pure transform math: `applyUpAxisConversion` (Z-up→Y-up), `applyUnitScale` (source units→meters), `applyRootScale`, `applyRootRotation` (quaternion), `computeBounds`, `centerToOrigin`, `autoFit`, `isExtremeScale`. Operates on interleaved [pos(3)+normal(3)] mesh vertices (6 floats/vertex).
- **`bake-node-transforms.ts`** (`packages/modules/models/src/bake-node-transforms.ts`) — bakes glTF/FBX node hierarchy transforms (translation, rotation, scale) into mesh vertices. Promoted from model-viewer to the engine so all games benefit.
- **`normalize.ts`** (`packages/modules/models/src/normalize.ts`) — orchestrates the full pipeline: up-axis → unit scale → node-transform baking → root rotation → user scale → bounds → center → auto-fit. `normalizeModel()` applies settings; `normalizeModelWithResolution()` resolves sidecars then normalizes.
- **`loadModel()`** (`packages/modules/models/src/loader.ts`) — now normalizes by default after parsing. Pass `normalize: false` to skip (e.g. for games that handle their own transforms). Pass `sidecarResolver` for custom sidecar resolution.

### Sidecar System

Per-model import settings are stored in sidecar files, tried in priority order:
1. `.ddmeta.json` (our format, JSON-with-comments via `comment-json`)
2. Unity `.meta` (YAML, `scaleFactor` field)
3. Godot `.import` (INI, `scale`/`rotation` params)
4. Blender extras (glTF `asset.extras.glTF2ExportSettings.YUP`)

Sidecar parsers: `packages/modules/models/src/sidecar/` — `ddmeta.ts`, `unity-meta.ts`, `godot-import.ts`, `blender-extras.ts`, `resolver.ts`.

### Parser Detection

FBX parser reads `GlobalSettings` for `UpAxis` (0/1=Y-up, 2=Z-up) and `UnitScaleFactor` (units per cm). glTF parser checks `asset.extras.glTF2ExportSettings.YUP`. DAE parser reads `<asset><up_axis>` and `<unit meter="...">`. Stored on `ModelData.sourceUpAxis` and `ModelData.sourceUnits`.

### Import Cache

`ImportCache` (`packages/core/src/assets/import-cache.ts`) caches resolved `ImportSettings` keyed by model path. `MemoryImportCache` is the in-memory fallback. In Electron, `registerImportCacheHandlers()` (`packages/app/src/main/handlers/import-cache.ts`) provides a SQLite-backed cache via `node:sqlite` (stable in Node 24+ / Electron 43+, no flag required), accessed through IPC (`IMPORT_CACHE_GET/SET/INVALIDATE`). The renderer-side adapter (`packages/app/src/renderer/import-cache.ts`) bridges to the IPC with a memory fallback for browser-only mode.

## Save system / storage backends

`ISaveStore` (`packages/core/src/save/persist-types.ts`) is the storage interface for versioned game saves. The extended interface supports: `save`/`load` (with `SaveOptions`/`LoadOptions` for blobs, thumbnails, properties, generation control), `listSaves`/`listGenerations`/`deleteSave`/`deleteGeneration`, `setThumbnail`/`getThumbnail`, `setProperties`/`getProperties`, and `onWarning`. Saves are a zstd-compressed JSON body of per-component sections (each with its own schema version) plus a header (engine version, timestamp, entity/player counts, XXH128 hash). The `MigrationRegistry` runs per-component `fromVersion→toVersion` migrations on load; forward-incompatible saves (newer engine than current) are refused. Implementations live in `@downdraft/library-persistence` (`packages/modules/persistence/`):

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

`BaseSceneInspector` (`packages/modules/devtools/src/scene-inspector.ts`) exposes a functional material editor API: `compileMaterialGraph`, `createMaterialFromGraph`, `saveMaterialToLibrary`, `listMaterials`, `exportMaterialAsJSON`, `importMaterialFromJSON`, `previewMaterialGraph` (live preview via `setPreviewMeshRenderer`). The editor UI (`packages/ui/src/editor/material-graph/material-graph-editor.tsx`) has a synced node palette (all compiler node types) and a Preview button.

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

- `ModelRenderer` (module-entities) — fully bindless. `setBindlessDeps()` + `setBindlessBindGroup()` wire the registry/material manager. The model shader samples albedo from `albedoArrays[arr]` using the material's `albedoTex` handle.
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

## Universal Physics Module (physics-rapier 0.2.0)

- The `PhysicsBackend` interface is now `PhysicsBody`-keyed (opaque body refs). Raw Rapier `RigidBodyHandle` is no longer exported from `@downdraft/core`.
- Multi-realm LOD: `RealmManager` drives near/mid/far tiers with promote/demote + dwell hysteresis. Static bodies are duplicated into all realms by default.
- `UniversalPhysicsAPI` (`@downdraft/module-physics-rapier`) is the single public surface: body lifecycle, validated state access, realm queries, interpolation, raycast, snapshots, hooks.
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

Each game owns its own `games/<game>/electron.vite.config.ts` entrypoint, loaded directly by `draft dev` (run from inside `games/<game>/`) or `npx electron-vite dev --config games/<game>/electron.vite.config.ts` (from the repo root). There is no root dispatcher or `DOWNDRAFT_GAME` env var.

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
1. Start the game: `cd games/to-the-ocean && DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 MCP_PORT=9876 draft dev`
2. The MCP config (`.devin/mcp_config.json`) defines the `ocean` server using the bridge script.
3. The bridge forwards `initialize`, `tools/list`, `tools/call` to `http://localhost:9876/mcp`.
4. Notifications (messages without an `id` field, like `notifications/initialized`) are silently ignored by the bridge.
5. `resources/list` and `prompts/list` return empty lists (the game doesn't expose resources or prompts).

Key bridge fixes:
- Notifications (no `id`) must not receive a response — the bridge silently drops them.
- The proxy handler wraps errors in the `result` field; the bridge detects `result.error` and converts it to a proper MCP `error` response.
- `ELECTRON_RUN_AS_NODE` must be unset in the game's env or Electron's `app` object is undefined.

### Running the smoke test

The `draft test` CLI command (`packages/cli/src/test.ts`) sets `DOWNDRAFT_DETERMINISTIC=1` (fixed seed, paused render loop, no autosave, no window) and `DOWNDRAFT_GPU=swiftshader` by default, then spawns `bun test <spec>`. It does **not** launch the game or wait for the MCP endpoint itself — that is the spec's job (via the harness). The default smoke specs (`tests/e2e/<game>-smoke.spec.ts`) use the in-game MCP RPC harness to launch and drive the game, but `--spec` can point at any `bun:test` file; the MCP harness is not required.

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

`tests/e2e/harness.ts` launches `npx electron-vite dev --config games/<game>/electron.vite.config.ts`, waits for the MCP HTTP health endpoint, and drives the game through MCP tool calls. The smoke test (`tests/e2e/to-the-ocean-smoke.spec.ts`) verifies that the tool surface exists, the simulation ticks, injected input advances the world, and a screenshot can be captured.

**Build mode:** Pass `--build` to `draft test` to build the game with `electron-vite build` first, then test the packaged app from `dist/main/index.cjs` instead of the dev server. This catches production-only bugs (e.g. minification issues, missing assets, tree-shaking problems). Use `--build-only` to skip the dev server entirely (requires a prior build). The harness detects built mode via the `DOWNDRAFT_TEST_BUILT=1` env var.

**Dynamic ports:** The harness auto-allocates a free MCP port starting from 9976, enabling parallel spec execution. Specs read the port from `process.env.MCP_PORT` (set by `draft test --port`). To run multiple specs simultaneously, omit `--port` and let each spec pick its own.

**Process cleanup:** The harness kills the entire process group (bun + Electron + Vite) on test completion, preventing orphaned Electron processes. It uses `process.kill(-pid, SIGTERM)` with a SIGKILL fallback after 5s.

**Retry logic:** The harness `callToolWithRetry()` method retries MCP operations on transport errors (connection refused, timeouts) with exponential backoff. Tool-level errors (isError: true) are not retried.

### CLI environment variables — consolidated reference

The CLI reads and sets a number of environment variables. This is the complete list; see `docs/site/src/content/docs/reference/cli.md` for the full CLI flag reference.

**Set by the CLI (`draft test`):**

| Variable | Value | Purpose |
|---|---|---|
| `MCP_PORT` | `<port>` | MCP HTTP transport port |
| `MCP_TIMEOUT_MS` | `120000` | MCP proxy IPC round-trip timeout (ms) |
| `DOWNDRAFT_GPU` | `swiftshader` \| `hardware` | WebGPU backend selection |
| `DOWNDRAFT_DETERMINISTIC` | `1` | Fixed seed, paused render loop, no autosave |
| `DOWNDRAFT_HEADED` | `1` | Show the window in deterministic mode |
| `DOWNDRAFT_TEST_BUILT` | `1` | Launch the built app instead of the dev server |

**Read by the CLI:**

| Variable | Used by | Purpose |
|---|---|---|
| `DD_RELEASE_KEYSTORE` | `mobile` | Release keystore path |
| `DD_RELEASE_KEYSTORE_PASS` | `mobile` | Keystore password |
| `DD_RELEASE_KEY_ALIAS` | `mobile` | Key alias |
| `DD_RELEASE_KEY_PASS` | `mobile` | Key password (falls back to store pass) |
| `AWS_ACCESS_KEY_ID` | `assets` | S3 credentials fallback (manifest config wins) |
| `AWS_SECRET_ACCESS_KEY` | `assets` | S3 credentials fallback |
| `ANDROID_HOME` | `mobile` | Android SDK path (build-tools + `local.properties`) |
| `ANDROID_SDK_ROOT` | `mobile` | Android SDK path (fallback) |
| `HOME` | `mobile` | `~/Android/Sdk`, `~/.android/debug.keystore`, `~/.downdraft/keystore.properties` |
| `DISPLAY` | `test` | When absent, wraps in `xvfb-run` |
| `ELECTRON_RUN_AS_NODE` | `test` | **Deleted** before spawning Electron |
| `DOWNDRAFT_STRICT` | all commands | `1` → hard-error on unknown CLI flags (warns otherwise) |

**Read by the runtime (set by CLI or user):**

| Variable | Used by | Purpose |
|---|---|---|
| `DOWNDRAFT_STRICT` | `packages/core/src/module/diagnostics.ts` | `0`/`1` force-disable/enable module DI validation (else = Vite dev mode) |
| `DOWNDRAFT_OSR_DISABLE_SHARED_TEXTURE` | `packages/modules/electron-osr/.../osr-renderer.ts` | `1`/`true` disables OSR shared-texture path |
| `DOWNDRAFT_MCP` | `packages/core/src/util/logger.ts` | `1` routes logs to stderr (keeps stdout clean for MCP JSON-RPC) |
| `DOWNDRAFT_DISABLE_DEVTOOLS` | `packages/app/src/main/handlers/devtools.ts` | `1` disables devtools auto-open (set by `draft debug --no-devtools`) |

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
3. Grep the full test output for error patterns: `grep -E "Uncaught|TypeError|ReferenceError|WrongDocumentError|is not a function|is not defined" /tmp/downdraft-test-*.log`
4. Do NOT ignore errors that appear "during teardown" — they may indicate real bugs (e.g. uncaught Promise rejections from `requestPointerLock()`)

Common false positives to filter out: Chromium storage errors (`ERROR:components/services/storage`, `ERROR:storage/browser`), GTK module warnings, WebSocket connection failures during teardown, `session.loadExtension` deprecation warnings.

### E2E test gotchas

- **MCP port conflicts**: If a previous test run didn't clean up, port 9977 may still be in use. Free it with `fuser -k 9977/tcp`, then kill **only the specific game instance** as described in "Killing game processes" above — do NOT use a generic `pkill -9 -f electron` (it will kill unrelated Electron apps).
- **Save store hangs in test environments**: `createSaveStore()` can hang when OPFS is not available (SwiftShader/headless). The MCP harness must be registered BEFORE the save store init so e2e tests can connect.
- **`requestPointerLock()` returns a Promise in newer Chrome**: The Promise can reject with `WrongDocumentError` if the canvas was detached or during ESC cooldown. Always `.catch()` the return value to avoid uncaught rejections.

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

### `draft release` CLI command (unified pipeline)

`draft release` is the unified build + package + sign pipeline that replaces the separate `build`, `dist`, `export`, `mobile`, and `build-games` commands. The old commands remain as deprecated backward-compat aliases that delegate to `release`.

```
draft release [--game=<name>] [--games=<csv>] [--target=<win|linux|mac|android|ios|all>]
              [--format=<csv>] [--stage=<build|package|release>] [--mode=<dev|debug|prod>]
              [--out=<dir>] [--config=<path>] [--port=<n>] [--skip-build] [--build-only]
              [--skip-gradle] [--no-icons] [--no-overrides] [--no-minify] [--sourcemap] [--verbose]
```

Stages:
- `build` = Vite-bundle only (desktop electron-vite + mobile web bundle)
- `package` = package an existing build (electron-builder / Capacitor+Gradle)
- `release` = build + package + sign + collect to `release/` (default)

The desktop packaging step loads the game's `build.config.ts` (or falls back to the `build` block in `package.json`) and invokes electron-builder's programmatic `build()` API. Config resolution order:

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
- `packages/cli/src/dist.ts` — `draft dist` command (deprecated alias for `draft release --stage=package`) + `packageDesktop()` export.
- `packages/cli/src/release.ts` — `draft release` unified pipeline (build + package + sign).
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

## Mobile targets (Android + iOS via Capacitor) — Experimental

> **⚠️ Experimental:** Mobile builds are under active development. The build pipeline, native shell, and WebGPU-on-WebView path have known limitations (e.g. the Android emulator does not expose a WebGPU-compatible backend — see "WebGPU on the Android emulator" below). Desktop builds are the stable, recommended target.

The engine supports Android and iOS build targets by wrapping the existing web-portable renderer/sim/worker stack in Capacitor (system WebView). The renderer, sim workers, SAB layout, and libraries are **unchanged** from desktop — they run in the system WebView with the exact same WebGPU + Worker + SharedArrayBuffer code path.

### Engine-owned native shell (zero native files per game)

The engine owns a **canonical, pre-wired native shell** at `packages/mobile-shell/` containing complete Android + iOS projects with the embedded HTTP server (COOP/COEP for SharedArrayBuffer) already wired in. `draft mobile` copies this shell into a per-game **gitignored** `android/` + `ios/` directory and patches in game-specific values (appId, appName, port, icons).

**Games commit zero native files.** The `android/` and `ios/` directories in each game are gitignored (via `games/*/android/` + `games/*/ios/` in root `.gitignore`) — regenerated from the shell on each `draft mobile` run. Games only commit:
- `capacitor.config.ts`, `src/mobile.ts` (or `.tsx`), `mobile.vite.config.ts`
- Optionally `icon.png` (1024×1024, auto-generates all icon sizes via jimp)
- Optionally `mobile-overrides/` (game-specific native permissions, deps, resources)

The shell's `MainActivity.java` / `AppDelegate.swift` / `SceneDelegate.swift` already start the embedded server and override the WebView URL. **No manual native code editing is required.**

### Architecture: what is portable vs Electron-only

- **Already web-portable (runs unchanged in a WebView):** `packages/core/src/render/*`, `packages/core/src/worker/*`, `packages/core/src/sab/*`, `packages/core/src/input/*`, `packages/core/src/ecs/*`, all `packages/libraries/*`, all `packages/modules/*` (except `electron-osr`), `packages/shader-graph`, `packages/ui`, `packages/mcp`, and `packages/app/src/renderer/*` (the `downdraft` bridge accessor already returns a stub when `window.downdraft` is absent).
- **Electron-only (replaced/skipped on mobile):** `packages/app/src/main/*` (Electron main process), `packages/app/src/preload/*` (IPC bridge), `packages/modules/electron-osr/*` (Offscreen Rendering), `electron.vite.config.ts` / `createDowndraftViteConfig()` (electron-vite build), `draft release --target=win,linux,mac` (electron-builder desktop packaging).

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
- `packages/cli/src/mobile.ts` — `draft mobile` CLI command (deprecated alias for `draft release --target=android,ios`) + `packageMobile()` / `buildMobileWeb()` exports.
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

**Zero-config path:** Just run `draft release --game=<name> --target=android,ios` (or the deprecated `draft mobile --game=<name>`). The command auto-generates everything:
- `capacitor.config.ts` — written if missing (correct appId, appName, webDir, server URL)
- `mobile.vite.config.ts` — defaulted at build time (no file needed unless customizing)
- `src/mobile.tsx` — auto-generated stub if missing (wire up renderer/sim/UI, then commit)

The only prerequisite is installing Capacitor deps: `bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios`

**Full setup:**

1. Run `draft release --game=<name> --target=android,ios`. This will:
   - Auto-generate `src/mobile.tsx` (stub with placeholder GameModule)
   - Auto-generate `capacitor.config.ts` (if missing)
   - Copy the engine shell → gitignored `android/` + `ios/`
   - Generate icons + splash screens (from `icon.png` or solid-color placeholders)
   - Run `cap sync`
   - Build the release APK via the Gradle wrapper (Android target) and collect it into `release/android/` (+ unpacked to `release/android-unpacked/`)

2. Wire up the generated `src/mobile.tsx` stub — copy your renderer factory, sim adapter, and UI mount from `main.tsx`. Replace `startGame()` with `createDowndraftMobileApp()`.

3. (Optional) Add a 1024×1024 `icon.png` to the game directory for custom app icons.

4. (Optional) Create a `mobile-overrides/` directory for game-specific native customization (extra permissions, deps, resources).

5. Re-run `draft release --target=android,ios` to regenerate native projects with your wired-up entry. The release APK lands at `release/<appName>-<version>-android.apk` (signed in place — release keystore → debug fallback).

6. To run on a device/emulator (rather than just producing the APK): `npx cap open android` (or `ios`) and Run in Android Studio / Xcode.

**TODO (revisit later):** Extract a shared `game-module.ts` from each game's `main.tsx` so the auto-generated `mobile.tsx` stub can import and reuse it directly, eliminating the manual wiring step. Currently the stub has placeholder TODOs because games inline their `GameModule` into `startGame()` rather than exporting it.

### `draft release --target=android,ios` (mobile) / `draft mobile` (deprecated alias)

```
draft release [--game=<name>] [--target=<android|ios|all>] [--port=<n>] [--skip-build] [--no-icons] [--no-overrides]
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

## User-authored plugin (modding) system

The engine supports a **plugin system** (distinct from the compile-time **module** system). Plugins are runtime-loadable extensions authored by end users / modders. They are discovered from local directories + remote workshop stores, validated against a permission manifest, and loaded into a sandboxed execution environment.

### Terminology

- **Modules** = compile-time DI units (`Module`, `ModuleHost`, typed tokens). Engine/game internals.
- **Plugins** = runtime-loadable user-authored extensions (`PluginHost`, `PluginManifest`). Modding surface.

### Plugin formats

| Format | Tier | Thread | Description |
|--------|------|--------|-------------|
| `worker-js` | `native` | `sim` or `own-worker` | TypeScript/JavaScript in a Web Worker. Full ECS + typed-DI access (native tier) or limited API (script tier). |
| `quickjs` | `script` | `renderer` | JavaScript in a QuickJS WASM VM. Hard isolation — only the `ddPlugin` bridged global exists. Instruction-budget limited. |
| `wasm` | `native` | `own-worker` (always) | WebAssembly module with ABI v2. Host provides `env` imports; plugin exports `register`/`tick`/`dispose`/`on_event`. |
| `asset` | `data` | `renderer` | Data-only: textures, audio, meshes, JSON. No code entry. Registered into the `AssetManager`. |

### Capability tiers

- **`data`** — no permissions, no runtime API. Asset plugins only.
- **`script`** — limited API: events, state (KV), tick, log. QuickJS plugins.
- **`native`** — full ECS + typed-DI access via `NativePluginContext`. Worker-js + WASM plugins.

The modder declares the tier in `plugin.json`; the host enforces it via `resolvePermissions()` which checks the tier's allowed permission set.

### Plugin manifest (`plugin.json`)

```json
{
  "id": "my-cool-plugin",
  "name": "My Cool Plugin",
  "version": "1.0.0",
  "engineVersion": "^0.1.0",
  "game": "downdraft-overburden",
  "format": "worker-js",
  "tier": "native",
  "thread": "sim",
  "entry": "./src/index.ts",
  "permissions": ["ecs", "events", "state", "tick", "log"],
  "provides": ["mygame:resource/cool"],
  "requires": [],
  "dependencies": []
}
```

### Game integration (`GameModule.plugins`)

Games opt into the plugin system by declaring a `plugins` field on their `GameModule`:

```ts
startGame({
  plugins: {
    workerJs: "own-worker",  // or "sim"
    sources: [...],          // discovery sources
    permissions: new Set(["ecs", "events"]),  // game allowlist
    manifests: [...],        // pre-resolved manifests (tests / first-party)
  },
  // ...
});
```

`startGame()` constructs a renderer-side `PluginHost`, registers the `WorkerPluginLoader`, discovers plugins, and loads them after renderer init. The host is exposed on `GameContext.pluginHost` for diagnostics + reloads.

### Plugin discovery

- **Local**: `games/<game>/plugins/<plugin-id>/plugin.json` — discovered by the CLI (`dd plugin list`) and by the game's vite config.
- **Remote workshop**: `WorkshopFetcher` downloads plugin packs from a `BlobStore`, caches them under `<cacheDir>/<id>@<version>/`, and returns validated manifests for the `PluginHost` to discover.

### CLI

```bash
dd plugin new <name> --format <format> --game <game> [options]
dd plugin list [--game <game>]
```

Scaffolds a new plugin directory with `plugin.json`, `package.json`, entry file, and README.

### MCP automation tools

`createPluginMcpTools(pluginHost)` returns MCP tool registrations for e2e testing:
- `plugin_list` — list all plugins with status.
- `plugin_get_info` — get detailed info for a single plugin.
- `plugin_reload` — reload a plugin by id.
- `plugin_unload` — unload a plugin by id.
- `plugin_get_state` — get a plugin's KV state keys.

### Doctor panel

The `downdraft doctor` devtools panel displays a plugins table (id, version, format, tier, thread, permissions, status) when `getPlugins` is wired in the `DoctorPanelOptions`.

### Key files

- `packages/core/src/plugin/manifest.ts` — `PluginManifest` type + `validatePluginManifest`.
- `packages/core/src/plugin/permissions.ts` — permission resolution + tier allowed sets + global allowlist.
- `packages/core/src/plugin/context.ts` — `ScriptPluginContext` + `NativePluginContext` tiered facades.
- `packages/core/src/plugin/registry.ts` — `PluginRegistry` (topological sort by dependencies).
- `packages/core/src/plugin/host.ts` — `PluginHost` (discover/validate/load/unload/dispose/snapshot).
- `packages/core/src/plugin/sandbox-shim.ts` — worker-side global restriction.
- `packages/core/src/plugin/sandbox-worker.ts` — sandbox worker entry for worker-js plugins.
- `packages/core/src/plugin/loader-worker.ts` — `WorkerPluginLoader` + `InlinePluginLoader`.
- `packages/core/src/plugin/loader-asset.ts` — `AssetPluginLoader`.
- `packages/core/src/plugin/loader-quickjs.ts` — `QuickjsPluginLoader`.
- `packages/core/src/plugin/quickjs-bridge.ts` — QuickJS host↔VM bridge (handle tracking, marshaling, interrupt handler).
- `packages/core/src/plugin/loader-wasm.ts` — `WasmPluginLoader` + `InlineWasmPluginLoader`.
- `packages/core/src/plugin/wasm-abi.ts` — WASM ABI v2 types + memory marshaling helpers.
- `packages/core/src/plugin/wasm-worker.ts` — WASM worker entry.
- `packages/core/src/plugin/workshop.ts` — `WorkshopFetcher` (remote pack fetch + cache).
- `packages/core/src/plugin/diagnostics.ts` — `PluginInfo` snapshot for the doctor panel.
- `packages/core/src/plugin/mcp-tools.ts` — MCP automation tools.
- `packages/cli/src/scaffold-plugin.ts` — CLI plugin scaffold.
- `packages/cli/src/plugin-command.ts` — `dd plugin` CLI subcommand.
- `packages/modules/devtools/src/doctor-panel.ts` — doctor panel with plugin table.
- `packages/app/src/renderer/game-module.ts` — `PluginRuntimeConfig` + `GameModule.plugins` wiring.

### Sample plugins

- `games/overburden/plugins/bronze-blocks/` — worker-js native tier (ECS + typed DI).
- `games/overburden/plugins/crop-sprites-pack/` — asset data tier (texture + JSON).
- `games/sandjongg/plugins/speed-mode/` — quickjs script tier (events + state + tick).
- `games/sandjongg/plugins/custom-scorer/` — wasm native tier (ABI v2, Fibonacci scorer).

## Profiling system (`@downdraft/core/profiling` + `@downdraft/library-profiler`)

A comprehensive cross-thread profiling + tracing system with an in-game overlay (Puffin-style flame graph, memory/CPU/IOPS/event-loop/GC views, warning toasts, trace recording + export).

### Architecture

- **`@downdraft/core/profiling`** — the core profiling primitives:
  - `ProfilingSAB` — a `SharedArrayBuffer` with a fixed layout: slot table (per-worker), per-slot metrics (ThreadMetrics), IOPS ring, event-loop block, warning ring, string table. Workers claim slots; the renderer reads all slots + drains the warning ring each frame.
  - `ProfilingSABWriter` / `ProfilingSABReader` — writer (worker-side) + reader (renderer-side) for the SAB.
  - `ThreadMetricsWriter` — writes heap/CPU/GC/task-latency metrics to the SAB each tick.
  - `TaskLatencyHistogram` — fixed-bucket histogram for task/tick latency (p50/p95/p99/max) + a sample ring for the flame graph.
  - `WarningEngine` — multi-level warning-rules engine. Rules fire in two modes: instantaneous (worker-side, `checkInstant()`) and windowed (renderer-side, `checkWindow()`). Supports auto-trace (starts recording on warning).
  - `EventLoopMonitor` — rAF jitter, long-task detection, idle headroom measurement.
  - `TraceEventWriter` — Chrome Trace Event / Perfetto / Spall format export.
  - IOPS patches: `patchOpfsPrototypes()` + `patchIndexedDbPrototypes()` — wrap OPFS/IDB methods to record IOPS to the ring. `disableRendererIndexedDb()` — patches the renderer's `indexedDB.open` to throw (renderer should not do I/O).
  - `worker-prelude.ts` — imported at the top of every instrumented worker. On load, detects worker realm, and if a ProfilingSAB is attached, claims a slot + initializes all writers + the warning engine + event-loop monitor + patches prototypes.
- **`@downdraft/core/worker/instrumented-worker-host`** — `InstrumentedWorkerHost` (extends `BaseWorkerHost`) auto-attaches the ProfilingSAB before `onInit()`. `exposeProfilingApi()` merges `__profilingAttach` / `__profilingAddRule` / `__profilingOnWarning` RPC methods into a worker's `expose()` API.
- **Vite plugin** — `profilingPreludePlugin` injects the worker prelude import at the top of worker files (configured via `DowndraftViteConfigOptions.profiling`).
- **`@downdraft/module-devtools`** — extended with:
  - `DebugViewDescriptor` + `registerView()` — declarative registration of profiler overlay views.
  - `attachProfilingSAB()` / `getProfilingSAB()` — SAB management on the devtools API.
  - `ProfilingBridge` — renderer-side bridge that creates the ProfilingSAB, runs the WarningEngine + EventLoopMonitor + TraceEventWriter, drains the warning ring each frame, fires auto-trace, and registers the 10 built-in view descriptors.
  - `initDevTools({ profiling: true })` — creates the ProfilingBridge + exposes the ProfilingSAB on `__sceneInspector`.
  - `exposeDevToolsApi()` — now merges `exposeProfilingApi()` so workers get both devtools + profiling RPC methods.
- **`@downdraft/library-pixi-ui`** — extended with `extraSharedBuffers` in the scene context (for passing the ProfilingSAB to the pixi-ui overlay worker).
- **`@downdraft/library-profiler`** — the profiler overlay library:
  - `ProfilerLib` — `EngineLibrary` descriptor for declarative wiring via `GameModule.libraries[]`.
  - `ProfilerOverlay` — main-thread host that wraps `PixiUiHost` with profiling-specific config.
  - `ProfilerScene` — pixi-ui scene that renders the 10 built-in views (memory, CPU, task-latency, IOPS-OPFS, IOPS-IDB, event-loop, GC-heap, flame-graph, GPU-passes, warnings) + toast stack + record/export bar.

### Built-in views (10)

| View | Kind | Description |
|------|------|-------------|
| Memory | `memory` | Heap used / total per worker |
| CPU | `cpu` | CPU percent + frame time per worker |
| Task Latency | `task-latency` | p50/p95/p99/max task latency |
| IOPS: OPFS | `iops-opfs` | OPFS I/O operations (op, tag, bytes, latency) |
| IOPS: IDB | `iops-idb` | IndexedDB I/O operations |
| Event Loop | `event-loop` | rAF jitter, long tasks, idle headroom |
| GC & Heap | `gc-heap` | GC pauses, heap over time, snapshot + force-GC |
| Flame Graph | `flame-graph` | Puffin-style task latency flame graph |
| GPU Passes | `gpu-passes` | WebGPU pass timings (render/compute/blit) |
| Warnings | `warnings` | Profiling warnings + auto-trace log |

### WebGPU timestamp queries

`GPUTimerPool` supports two levels of timestamp queries:
- **Inside-pass timestamps** (render/compute passes) — requires `timestamp-query` + `chromium-experimental-timestamp-query-inside-passes`.
- **Encoder-level timestamps** (blit/copy passes) — requires only `timestamp-query` (base feature). Uses `commandEncoder.writeTimestamp()`.

`GPUProfiler` exposes `beginComputePass()` / `endComputePass()` / `beginBlitPass()` / `endBlitPass()` for compute + blit pass timing. `PassTiming.category` is `"render" | "compute" | "blit"`.

### Task latency instrumentation

The following execution paths are instrumented with `recordTaskLatency()` + `checkInstant(METRIC_TASK_LATENCY)`:
- **Sim worker tick loop** (`sim-worker-base.ts`) — each `onTick()` call is timed.
- **Task worker** (`task-worker.ts`) — each registered function call is timed.
- **QuickJS bridge** (`quickjs-bridge.ts`) — `eval()`, `callGlobal()`, and tick callbacks are timed.
- **WASM worker** (`wasm-worker.ts`) — `tick()` and `on_event()` calls are timed.

### Renderer IndexedDB disabling

`GameRenderer.init()` calls `disableRendererIndexedDb()` by default (patches `window.indexedDB.open` to throw for non-allowlisted databases). Games can opt out via `GameRendererConfig.disableRendererIndexedDb = false`.

### Enabling profiling in a game

1. **Vite config**: set `profiling: true` in `createDowndraftViteConfig()` to inject the worker prelude.
2. **`initDevTools`**: pass `profiling: true` to create the `ProfilingBridge` + `ProfilingSAB`.
3. **Render loop**: call `profilingBridge.tick()` in `beforeFrame` and `profilingBridge.endFrame()` in `afterFrame`.
4. **Sim worker**: call `simWorker.attachProfilingSAB(bridge.getProfilingSAB())` to share the SAB with the sim worker.
5. **Profiler overlay** (optional): declare `ProfilerLib` in `GameModule.libraries[]` for the in-game overlay.

### Key files

- `packages/core/src/profiling/profiling-sab.ts` — SAB layout + writer + reader.
- `packages/core/src/profiling/warnings.ts` — WarningEngine + rules + auto-trace.
- `packages/core/src/profiling/task-latency.ts` — TaskLatencyHistogram.
- `packages/core/src/profiling/event-loop.ts` — EventLoopMonitor.
- `packages/core/src/profiling/trace-event-writer.ts` — Chrome Trace Event export.
- `packages/core/src/profiling/worker-prelude.ts` — worker prelude (auto-runs on import).
- `packages/core/src/profiling/iops/opfs-patch.ts` — OPFS prototype patching.
- `packages/core/src/profiling/iops/idb-patch.ts` — IndexedDB prototype patching.
- `packages/core/src/profiling/iops/renderer-idb-disable.ts` — renderer IDB disabling.
- `packages/core/src/worker/instrumented-worker-host.ts` — InstrumentedWorkerHost + exposeProfilingApi.
- `packages/app/src/vite/profiling-prelude-plugin.ts` — Vite plugin.
- `packages/modules/devtools/src/profiling-bridge.ts` — ProfilingBridge.
- `packages/modules/devtools/src/debug-view-descriptors.ts` — DebugViewDescriptor + 10 built-in views.
- `packages/libraries/profiler/src/profiler-scene.ts` — ProfilerScene (pixi-ui overlay).
- `packages/libraries/profiler/src/library.ts` — ProfilerLib descriptor.
- `packages/core/src/telemetry/gpu-timer-pool.ts` — GPUTimerPool (encoder-level timestamps).
- `packages/core/src/telemetry/gpu-profiler.ts` — GPUProfiler (compute/blit pass timing).

## Gaussian Splatting library (`@downdraft/library-gaussian-splats`)

A renderer-only engine library for rendering 3D Gaussian Splat scenes (INRIA `.ply` and `.splat` formats). Uses a Structure-of-Arrays (SoA) data layout for GPU-friendly uploads.

### Architecture

The library is split into four modules, each implementing a phase of the splat rendering pipeline:

1. **Parser** (`parser.ts`) — Parses INRIA PLY and `.splat` files into a `GaussianSplatData` SoA structure: `position`, `scale`, `rotation`, `color` (with opacity sigmoid baked into alpha), and `shCoeffs` (f_rest SH coefficients). Supports SH degrees 0-3.

2. **GPU radix sort** (`gpu-sort.ts`) — `GpuSplatSorter` sorts splats back-to-front by camera distance using a GPU radix sort (4-bit radix, 8 passes for u32 keys). Below `sortThreshold` (default 8192), falls back to CPU merge sort. After sorting, compacts the splat buffer into sorted order via a compute pass.

3. **Spherical harmonics** (`sh-eval.ts`) — `packShCoeffs()` packs SH "rest" coefficients (degrees 1-3) from parsed data, truncated to the configured `shDegree`. `SH_EVAL_WGSL` is a WGSL chunk inserted into the fragment shader that evaluates real spherical harmonics for view-dependent color. The DC color is already baked into `GaussianSplatData.color` by the parser; SH adds the view-dependent contribution.

4. **Tile-based rasterization** (`tile-raster.ts`) — `TileRasterPipeline` implements an alternative render path: a compute pass bins splats into 16×16 screen-space tiles, then a full-screen-triangle fragment shader iterates over per-tile splat lists and alpha-blends back-to-front. This replaces the default instanced-quad approach. The global sort ensures per-tile splat order is correct without a separate per-tile sort.

### Renderer integration

`GaussianSplatRenderer` orchestrates all four modules. The render path:
1. Write camera uniforms (viewProj, cameraPos, resolution).
2. Sort + compact splats (GPU radix sort or CPU fallback, every `sortFrequency` frames).
3. If `tileRaster` is enabled: bin splats into tiles (compute) → draw full-screen triangle (per-pixel splat iteration).
4. Else: draw instanced quads (4 verts × N instances, with SH eval in fragment shader).

### Config (`GaussianSplatsLibConfig`)

| Field | Default | Description |
|-------|---------|-------------|
| `surfaceFormat` | `"bgra8unorm"` | Surface texture format |
| `maxSplats` | `1_000_000` | GPU sort buffer pre-allocation |
| `sortThreshold` | `8192` | Below this count, use CPU sort |
| `sortFrequency` | `1` | Sort every N frames |
| `shDegree` | `0` | Max SH degree (0=DC only, 1-3=view-dependent) |
| `tileRaster` | `false` | Use tile-based rasterization |
| `tileRasterOptions` | `{}` | Tile size + max splats per tile |

### Declarative usage

```ts
import { GaussianSplatsLib } from "@downdraft/library-gaussian-splats";

startGame({
  libraries: [[GaussianSplatsLib, {
    shDegree: 2,
    sortThreshold: 4096,
    tileRaster: true,
  }]],
  // ...
});
```

### Key files

- `packages/libraries/gaussian-splats/src/parser.ts` — PLY/SPLAT parser, SoA layout.
- `packages/libraries/gaussian-splats/src/gpu-sort.ts` — GpuSplatSorter (radix sort + compact).
- `packages/libraries/gaussian-splats/src/sh-eval.ts` — SH packing + WGSL eval chunk.
- `packages/libraries/gaussian-splats/src/tile-raster.ts` — TileRasterPipeline (bin + raster).
- `packages/libraries/gaussian-splats/src/renderer.ts` — GaussianSplatRenderer (orchestrator).
- `packages/libraries/gaussian-splats/src/library.ts` — GaussianSplatsLib descriptor.
- `packages/libraries/gaussian-splats/src/sorter.ts` — CPU sort fallback (sortSplats, filterByDistance).

