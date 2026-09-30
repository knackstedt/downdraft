# Downdraft Engine — Agent Notes

## Repository layout: games are git submodules

Every directory under `games/` is a **git submodule** pointing at its own repository (`github.com/knackstedt/<game>`). Each game is a standalone-installable repo — it consumes engine packages via `@downdraft/*` semver deps (`^0.1.0`), which resolve to workspace links inside the monorepo and to npm in a standalone checkout. When changing a game's code, commit inside the submodule repo first, then bump the gitlink in this repo. `git submodule update --init --recursive` is required after clone (CI does **not** fetch submodules — engine CI is self-contained and never builds games). After `bun install`, run `bun run link:games` to symlink `@downdraft/*` packages into every game's `node_modules` — workspace-member games are linked automatically, but `downdraft-model-viewer` and `downdraft-gpu-bench` are not workspace members and need the script (it also adds a `node_modules/.bin/draft` shim per game).

`@downdraft/*` packages are published to npm (`node scripts/publish-packages.mjs` / the `publish.yml` workflow).

## Runtime status: native is the active runtime

DownDraft runs on a **native runtime** — Bun + winit + wgpu via `@downdraft/platform-native` (a single Rust cdylib, `libdowndraft_platform`). A game boots from `src/native-entry.ts`, which calls `runNativeGameModule(...)`; there is no Electron, no Chromium, no browser-facing Vite dev server (the dev shell embeds Vite only as a transform/HMR engine), and no renderer/preload process split. The simulation still runs in a dedicated worker thread with SharedArrayBuffer protocols — that isolation is deliberate and is preserved on native.

**Electron is removed.** `draft dev`/`draft test`/`draft release` run native only — there are no Electron flags or compatibility paths. The Electron/Capacitor trees (main/preload/vite/mobile shells, `core/ipc.ts`, `electron-osr`, `raw-input`, devtools extension, per-game `electron.vite.config.ts`/`index.html`/`src/main.ts`/`src/preload.ts`, `mobile-shell`, electron-builder config) have been deleted — do not resurrect them; a future mobile port would be native (winit+wgpu), not a WebView shell. `app/src/renderer` is runtime-agnostic and remains live — `startGame()`/`bootstrapGame()` run on the native main thread.

Native dev has tiered HMR: `dev-shell.mjs` + `native-dev-runtime.ts` run an embedded Vite `RunnableDevEnvironment` (module-level invalidation through full session/host restart tiers) — it is not restart-only. Game-facing `import.meta.hot` semantics work through the dev runtime, not `vite dev`. Native packaging is `scripts/package-native.mjs` (a game `bun build --compile` plus asset staging); `draft release --target=win|linux|mac` invokes it.

Game detection: a directory is a game when it has `downdraft.config.json` or `src/native-entry.ts`.

## Module architecture: engine vs game boundary

> **Terminology note:** The compile-time DI units that were previously called "plugins" are now called **modules** to disambiguate. The term **"plugin" is now reserved for the upcoming user-authored plugin system** (runtime-loadable extensions authored by end users / modders). Throughout this document, "module" refers to the engine's compile-time DI units (`Module`, `RendererModule`, `ModuleHost`, etc.).

The engine is a **single npm package**, `@downdraft/engine` (manifest at `packages/engine/package.json`), which exposes everything through subpath exports: `@downdraft/engine` (core index), `@downdraft/engine/core/<path>` (deep core imports), `@downdraft/engine/app/<renderer|shared>`, `@downdraft/engine/libraries/<name>`, `@downdraft/engine/modules/<name>`, plus `ui`, `shader-graph`, `mcp`, `test`, and `asset-bake` subpaths. The only other published packages are `@downdraft/cli` (the `draft` binary) and `@downdraft/platform-native` (native binaries). The exports map is generated — run `node scripts/gen-engine-exports.mjs` after adding/removing a library or module directory.

Architecturally the engine is split into **core + libraries** (standard engine building blocks, used directly by games) vs **modules** (opt-in game features with lifecycle + typed DI + diagnostics). Core also includes animation, particles, and imui subsystems directly.

- **Engine libraries** (imported as `@downdraft/engine/libraries/<name>`, located in `packages/engine/libraries/`): directories that export classes/functions without a module lifecycle. Games can either import and wire these directly, or declare them via `EngineLibrary` descriptors in `GameModule.libraries[]` for auto-wiring (SAB allocation, sim system creation, renderer pass creation, typed DI tokens). Engine libraries: water, physics-rapier, physics-native, marching-cubes, surface-nets, audio-kira, models, networking, weatherfx, pixi-ui, entities, lighting, weather, navmesh, recast, persistence, gaussian-splats, sand, stickman, profiler, pathfinding-2d, character.
- **Engine modules** (imported as `@downdraft/engine/modules/<name>`, located in `packages/engine/modules/`): directories that implement the `Module` or `RendererModule` interface with a `register()` lifecycle + typed DI. Engine modules: camera-controls, devtools, native-osr, mcp, xr, terrain, movement-3d, movement-2d, vitals, sailing.
- **Game modules** (namespace `@to-the-ocean/module-*`, located in `games/<game>/modules/`): game-specific features with a module lifecycle. Game modules: crafting, inventory, buoyancy, collision, wildlife.
- **Game libraries** (namespace `@to-the-ocean/library-*`, located in `games/<game>/libraries/`): game-specific pure libraries without a module lifecycle. Game libraries: boats, economy, fishing, items, survival.

### Declarative GameModule + startGame()

Games declare their renderer-side bootstrap as a `GameModule` and call `startGame()` from `@downdraft/engine/app/renderer`. This replaces the old `bootstrapGame()` callback-soup with a declarative module:

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

Feature modules (`@downdraft/engine/modules/terrain`, `@downdraft/engine/modules/movement-3d`, `@downdraft/engine/modules/movement-2d`, `@downdraft/engine/modules/sailing`) use the factory pattern (`createXxxModule(config)`) and provide typed DI tokens. Games register them via `moduleHost.useModules([...])` for batch activation in dependency-resolved order.

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
import { WaterLib, PhysicsRapierLib } from "@downdraft/engine/libraries/water";

startGame({
  libraries: [WaterLib, [PhysicsRapierLib, { maxEntities: 8192 }]],
  // ...
});
```

The `LibraryHost` auto-wires each library: allocates SAB channels, creates sim-side systems, creates renderer-side passes, and registers provided resources in the DI graph via typed tokens (e.g. `WaterWriterTok`, `WaterReaderTok`, `PhysicsAPITok`). Games inject these tokens from `GameContext` in their `onReady` hook.

Bare class exports remain as an escape hatch — games that need full control can still import and wire `WaterBufferWriter`, `RapierPhysicsBackend`, etc. directly.

No engine package depends on any game package (verified). The `entities` library is an engine library (generic `ModelRenderer` used by multiple games). When adding a new game, create `games/<game>/modules/` for its game-specific modules and `games/<game>/libraries/` for its game-specific pure libraries.

### Visual Test Bench (`games/downdraft-gpu-bench`)

A graphical test program (modeled on `games/downdraft-model-viewer`) for visually verifying engine effects and functional systems. Provides a React DOM menu of minimal tests, each with its own renderer factory. Extensible via a `TestRegistry` API — game authors add tests by creating `*.test.ts` files in `src/tests/` that call `registerTest()`. Vite glob import auto-discovers them.

- **Run**: `cd games/downdraft-gpu-bench && draft dev` (native — the only runtime).
- **Not in root workspaces** (follows downdraft-model-viewer pattern: `@downdraft/*` resolved via vite aliases, not type-checked by root tsconfig).
- **Test interface**: `VisualTest { id, name, category, description, createRenderer(canvas): ITestRenderer, getControls?(): TestControl[] }`. Each test owns its own GPU resources; the bench disposes + recreates the renderer when switching tests.
- **Built-in tests**: navmesh (recast + legacy, with mesh wireframe + path debug viz), postfx (the PostProcessStack with 21 chainable effects — TAA, SSAO, SSR, DOF, Motion Blur, Bloom, Bloom-Soft, Tonemap, FXAA, Sharpen, Grain, Sobel, Edges, Lens Flare, Pixelation, Gaussian Blur, Afterimage, Outline, Highlight, Glow, ASCII — on a 3D scene).
- **Adding a test**: create `games/downdraft-gpu-bench/src/tests/<category>/<name>.test.ts`, call `registerTest({ ... })` at module load. The Vite glob in `src/tests/index.ts` picks it up automatically.

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

Config when adding/removing an engine library or module: create/remove the directory under `packages/engine/libraries/` or `packages/engine/modules/` with a `src/index.ts`, then run `node scripts/gen-engine-exports.mjs` (regenerates the `exports` map in `packages/engine/package.json`) and `node scripts/gen-deno-import-map.mjs` (regenerates `deno.json`). No tsconfig paths, Vite aliases, or workspace entries are needed — subpath resolution flows through the single `@downdraft/engine` package.

## Shared engine APIs — use these, don't hand-roll

Before writing per-game infrastructure, check whether the engine already provides it. The canonical APIs (tracked in `docs/refactor/batteries-included.md`):

| Concern | Engine API | Location |
|---|---|---|
| Renderer-owned sim worker | `GameModule.simFromRenderer: (r) => r.getWorkerHost()` — never write a no-op `GameSimWorker` adapter | `@downdraft/engine/app/renderer` |
| Game store base | `createBaseGameStoreState(set, get)` — spread into the game's zustand store (fps, paused, panels, notifications, title screen) | `@downdraft/engine` |
| Sim worker entry | `createSimWorker({ fixedDt, onInit, onTick, ... })` — tick loop, speed, step, stats, SAB-polyfill sync | `@downdraft/engine` |
| Deterministic RNG in sim | `ctx.rng` in `onTick(dt, ctx)` (mulberry32, seeded via `createSimWorker({ seed })` / `control.setSeed()`). In deterministic mode `Math.random` is trapped to the same seeded stream — sim code should use `ctx.rng`, never `Math.random`/`Date.now` IDs | `@downdraft/engine` |
| Worker host (main side) | `SimWorkerHost<TApi>` / `BaseWorkerHost<TApi>` — pause/resume/step/setSpeed/getStats + input writing | `@downdraft/engine` |
| DOM input | `createDomInputHandler({ canvas, preset, ... })` — keyMap, mouse buttons, canvas coords, MCP `injectInput` | `@downdraft/engine` |
| Save system | `createGameSaveSystem` / `createGridSaveSystem` + `createDefaultSaveStore` | `@downdraft/engine`, `@downdraft/engine/app/renderer` |
| Autosave interval | `AutosaveManager({ save, shouldSave, intervalMs, deterministic })` | `@downdraft/engine/libraries/persistence/browser` |
| MCP automation tools | `createStandardAutomationTools(ctx)` + `createMcpHarness` — the ~13 standard tools; game tools via `extraTools` | `@downdraft/engine/app/renderer` |
| DevTools | `initDevTools(renderer, {...})` + `createSimStatsProvider`/`createSimStatsPanelExtension` | `@downdraft/engine/modules/devtools` |
| Sand simulation | `SandWorld`, `SandStepPool`, `SandLib`, palette/materials | `@downdraft/engine/libraries/sand` |
| Game UI | `createGameUi({ build })` renderer module over `core/imui` (UIRoot/UIRenderer/widgets) — **canonical game-UI system**; pixi-ui is legacy for games | `@downdraft/engine` |

**UI direction:** game UI is migrating from PixiJS-in-worker (`library-pixi-ui`) to `core/imui` (the same WebGPU UI system family the native devtools use). New games must target imui; do not add new pixi-ui scenes to games. `library-pixi-ui` remains for plugin/compat surfaces.

**Game UI pattern:** `GameRenderer` already owns the imui lifecycle. A game mounts its UI as a renderer module:

```ts
renderer.useRendererModule(createGameUi({
  build(ui) {
    const hud = new UIPanel(220, 60);
    hud.name = "hud";
    const hp = new UIText("HP");
    hp.name = "hp";
    hud.addChild(hp);
    ui.root.addChild(hud);

    // Push-style: store subscription → element mutation
    ui.bind(store, (s) => s.health, (v) => hp.setText(`HP ${v}`));
    // Poll-style: per-frame sync (SAB scalars, positions, visibility)
    ui.onUpdate(() => { menuPanel.visible = store.getState().menuOpen; });
    // Actions: onClick calls sim directly — no bridge protocol
    btn.callbacks.onClick = () => sim.setSpeed(2);
  },
}));
```

Conventions: `ui.root` is a full-screen `pointerThrough` container — size interactive children tightly so non-UI canvas clicks fall through to game input (`ui.isPointerOverUI()` for paint-style games). Widgets: `UIButton`/`UIToggle`/`UISlider`/`UITabBar`/`UIModal`/`UIScrollPanel`/`UITextInput`/`UIProgressBar`/`UIToastStack` + `UIPanel`/`UIText`/`UIImage`/`UILine`. `setUIFontScale(ui.root, scale)` for font scaling.

## RenderSurface and overlay layering

On the native runtime there is no DOM or HTML document. The single render target is the `RenderSurface` contract (`core/src/platform/render-surface.ts`), implemented by `NativeSurface` (a wgpu-backed native window surface). UI overlays render into the same surface via offscreen wgpu textures (`modules/native-osr`) and are composited as final-present quads.

### How it works

- `GameModule.renderer: (surface: RenderSurface) => IRenderer` — the surface is injected by `bootstrapGame()`; never query `document` for a canvas.
- `ctx.surface` / `GameRenderer.getSurface()` are the canonical accessors. `getCanvas()` / `getOverlay()` / `elementFromPoint` live in `renderer/compat/dom.ts` as deprecated DOM-host compatibility shims — they hard-fail on native (`hasDom()` is `false`).
- The DOM-overlay `mountUI` hook is skipped on native; game UI uses `core/imui` (see the shared-APIs table above).
- Multiple render areas (minimap, picture-in-picture) are implemented as additional OSR surfaces or viewport regions, not stacked canvases.

## PixiJS UI overlay library (`@downdraft/engine/libraries/pixi-ui`)

A worker-hosted PixiJS UI overlay: the library spawns a Web Worker that renders a GUI onto an `OffscreenCanvas` (via `transferControlToOffscreen`) stacked above the main game canvas. Games feed per-frame scalars via a `SharedArrayBuffer` (UiStatsSAB) and event-driven data via `postMessage`. The overlay canvas is `pointer-events: none` by default (game keeps all input); when the worker signals interactive/modal UI, the host flips the canvas to `pointer-events: auto` and forwards pointer events to the worker for PixiJS hit-testing.

> **DOM-only library:** this section describes the browser/DOM host path. On the native runtime, `libraries/pixi-ui` resolves its target via `getSurface()` and the DOM queries below are skipped (`hasDom()` is false). The native equivalent is `libraries/pixi-ui-native` (see below); new game UI should target `core/imui` instead.

### Architecture

- **Canvas layering (DOM hosts)**: the overlay canvas is `data-dd-layer="1"` (z-index 50, above the game canvas at z 0, below the DOM overlay at z 100). The host acquires an existing canvas with `data-dd-layer="1"` or creates one if absent. `PixiUiHost.start()` sets inline styles (`position: fixed; z-index: 50`) on the overlay canvas AND `position: fixed; z-index: 0` on the game canvas (layer 0) to ensure correct stacking even if the game doesn't import `downdraft-base.css`. DOM-hosted games must `@import "@downdraft/engine/app/renderer/downdraft-base.css"` in their globals.css for the full stacking rules (pointer-events, image-rendering, DOM overlay z-index 100). The `#root` div MUST have `background: transparent` so it doesn't cover the pixi-ui canvas. On native the game canvas resolves through `getSurface()` instead of the `data-dd-layer` query.
- **Worker lifecycle**: `PixiUiHost.start()` → `transferControlToOffscreen()` → spawn worker → send init message (OffscreenCanvas + UiStatsSAB + config, all transferable). Worker creates `PIXI.Application` on the OffscreenCanvas, dynamically imports the game's scene module, and runs a ticker loop.
- **Worker message handler**: The worker uses `self.addEventListener("message", ...)` instead of `self.onmessage = ...` because PixiJS's internal worker code (e.g. `loadImageBitmap` worker) overwrites `self.onmessage` during `Application.init()`. `addEventListener` handlers cannot be overwritten by assignment, so the message handler survives PixiJS init. The worker also removes the Application's auto-render callback from the ticker and handles `app.render()` in its own `tick()` function with try/catch — if `app.render()` throws (e.g. WebGL context issues on OffscreenCanvas), the uncaught error would stop the PixiJS ticker and make the worker unresponsive.
- **Worker EventSystem + document stub**: PixiJS v8's EventSystem is not loaded by default in the worker because `pixi.js/events` (the side-effect import that registers it as a renderer extension) is not imported. The worker explicitly imports `pixi.js/events` to register the EventSystem so `app.renderer.events` is available for pointer hit-testing. However, the EventSystem's `_addEvents()` method registers DOM event listeners on `globalThis.document` and `globalThis` — neither exists in a Web Worker. The worker stubs `globalThis.document` with no-op `addEventListener`/`removeEventListener`/`dispatchEvent`, `createElement('canvas')` returning an `OffscreenCanvas` (for PixiJS text rasterization), and `body.contains()` returning `true` (for `isRenderingToScreen()`). Pointer events are dispatched manually via `eventSystem._onPointerDown(syntheticEvent)` etc. (underscore-prefixed methods, not `onPointerDown`). The synthetic event must include `type`, `target`, `composedPath`, `cancelable`, `isPrimary`, `width`, `height`, `tiltX`, `tiltY`, `pressure`, `twist`, `tangentialPressure` — `_bootstrapEvent` reads these and `_onPointerUp` checks `target === domElement` to determine if the pointerup is "inside" (enabling click).
- **Data model**: `UiStatsSAB` (fixed-layout `SharedArrayBuffer` with a 16-byte header + float32 slots) for high-frequency per-frame scalars (health, fps, positions). `postMessage` for event-driven/structured data (inventory, menu toggles, notifications). Games call `host.writeStats({...})` from their game loop and `host.postEvent({...})` for events.
- **Input model**: worker calls `ctx.setInteractive(true/false)` → host toggles `canvas.style.pointerEvents` + forwards pointer events to worker for PixiJS `eventMode` hit-testing. Modal UI (menus, buttons) flips interactive on; display-only HUDs keep it off.
- **Renderer backend**: WebGL2 by default. Games override via `backend: "webgl2" | "webgpu" | "auto"`. WebGL2 is most reliable for a 2D UI overlay (avoids dual-WebGPU-device concerns with the main game canvas).
- **`@pixi/react` adapter**: optional `@downdraft/engine/libraries/pixi-ui/react` module for declarative React components rendering to PixiJS. Games add `@pixi/react` + `react` to their deps and `@vitejs/plugin-react` to `workerPlugins` in their vite config. The core library does NOT depend on React. The adapter calls `extend()` to register PIXI components (Container, Graphics, Text, Sprite, etc.) in the `@pixi/react` catalogue (v8 requires explicit registration). It also patches the React fiber's `containerInfo` to point to the worker's existing PIXI.Application stage (createRoot creates a throwaway Application internally; without patching, React renders into the wrong stage and nothing appears). Components use the lowercase `<pixiContainer>`, `<pixiText>`, `<pixiGraphics>` convention (v8's `parseComponentType` converts `pixiX` → `X`). Event props use React naming: `onPointerDown`, `onPointerUp`, etc. (the adapter maps them to PixiJS event names).

### Declarative usage (via `GameModule.libraries[]`)

```ts
import { PixiUiLib, PixiUiHostTok } from "@downdraft/engine/libraries/pixi-ui";

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
import { PixiUiHost } from "@downdraft/engine/libraries/pixi-ui";
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
4. **Overlay surface**: the pixi scene renders through `libraries/pixi-ui-native` (`NativePixiUiHost`/`NativePixiUiSceneHandle`) onto the native RenderSurface — there is no HTML layer spec on native.
5. **Dependencies**: add `@downdraft/engine/libraries/pixi-ui` + `pixi.js` to game deps. For `@pixi/react` games, also add `@pixi/react`, `react`, `react-dom`, and `@vitejs/plugin-react` to `workerPlugins` in the vite config.
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

- `packages/engine/libraries/pixi-ui/src/library.ts` — `PixiUiLib` descriptor + `PixiUiHostTok` token + config types.
- `packages/engine/libraries/pixi-ui/src/host.ts` — `PixiUiHost` (main thread): canvas acquire, `transferControlToOffscreen`, SAB alloc, worker spawn, pointer-events toggle, MCP query/capture.
- `packages/engine/libraries/pixi-ui/src/pixi-ui-worker.ts` — worker entry: PIXI.Application init on OffscreenCanvas, scene mounting, ticker loop, pointer hit-testing, scene-state query, capture.
- `packages/engine/libraries/pixi-ui/src/ui-stats-sab.ts` — UiStatsSAB layout + read/write helpers.
- `packages/engine/libraries/pixi-ui/src/bridge-protocol.ts` — typed main↔worker message protocol.
- `packages/engine/libraries/pixi-ui/src/scene.ts` — `PixiUiScene` interface + `PixiUiSceneContext`.
- `packages/engine/libraries/pixi-ui/src/react.ts` — optional `@pixi/react` adapter.
- `packages/engine/libraries/pixi-ui/src/mcp-tools.ts` — MCP automation tool registrations.
- `examples/pixi-ui-demo/` — standalone example (health bar + FPS + pause button).
- `tests/e2e/pixi-ui-demo.spec.ts` — e2e smoke test via MCP harness.

## Per-game storage isolation

Each game MUST pass a unique `appId` (`downdraft-<game>`) so the native host resolves a per-game `userData` directory (e.g. `~/.config/downdraft-mining-rpg/`). Save files, SQLite import cache, debug artifacts, and the singleton lock all live under it — sharing one between games would corrupt save state and collide on the lock.

When `appId` is set, `createNativeHost()` (via `runNativeGameModule`) also:
1. Acquires a singleton lock (`<userData>/singleton.lock`, PID-owned) — prevents two instances of the same game from running concurrently (which would corrupt storage). **Skipped in deterministic/test mode** (`DOWNDRAFT_DETERMINISTIC=1`): the test harness controls process lifecycle itself (dynamic MCP ports + process-group kills).
2. Cleans up stale lock artifacts from a previous run that crashed or was killed. In non-deterministic mode this is safe because the single-instance lock guarantees no live process is using the directory; in deterministic mode the test harness guarantees no concurrent instance.

### Files

- `packages/platform-native/src/bridge/user-data-dir.ts` — `resolveNativeUserDataDir()` (builds the per-game path).
- `packages/platform-native/src/host-lifecycle.ts` — singleton lock acquisition + stale-lock cleanup in `createNativeHost()`.

### Adding a new game

Always set `appId` in the game's `src/native-entry.ts`:
```ts
await runNativeGameModule(gameModule, {
  appId: "downdraft-my-game",  // → ~/.config/downdraft-my-game/
  title: "My Game",
});
```

## Process management & debugging games

### Killing game processes — never use generic `pkill bun`/`pkill electron`

**NEVER run `pkill -9 bun`, `pkill -f bun`, `killall bun`, or any other generic runtime-killing command.** The user's machine may run other Bun processes (and other Electron apps: VS Code, Slack, the Devin desktop app itself). A generic pkill will terminate all of them, destroying the user's work and your own session.

**`draft dev` runs only the native runtime** (Bun + winit + wgpu via `src/native-entry.ts`) — the Electron path is removed entirely. The native runtime uses a single-instance lock (`singleton.lock` in the game's userData dir); re-running `draft dev` handles stale instances. Each game runs as a **single Bun process** (plus worker threads). To kill a specific game instance, target **that game only**:

- **Let `draft dev` handle it** — re-running `draft dev` from the game directory tears down the previous instance automatically. This is the preferred path.
- **Match the per-game `--user-data-dir`** (each game sets a unique `downdraft-<game>` userData dir, visible in the process args) only if you need to kill a process you did not launch via `draft dev`:
  ```bash
  # Kill only the to-the-ocean game process and its children
  for pid in $(pgrep -f "user-data-dir=[^ ]*downdraft-to-the-ocean" 2>/dev/null); do
    kill -TERM "$pid" 2>/dev/null
  done
  ```
- **Match the MCP port** if you know which port the game's MCP HTTP transport is bound to (ephemeral by default; 9976 for `draft test`):
  ```bash
  # Read the port from the PID file: ~/.downdraft/port/<pid>
  ls ~/.downdraft/port/ && cat ~/.downdraft/port/*  # shows PID(s) → port(s)
  fuser -k <port>/tcp   # kills whatever is bound to that port
  ```

Prefer `kill -TERM` first (lets the game release the singleton lock and flush saves); only escalate to `kill -9` if the process doesn't exit within a few seconds. If you launched the game yourself (via `draft dev`, `draft test`, or the e2e harness), prefer terminating the parent shell/process you spawned rather than hunting for the `bun` child.

### Debugging games — do NOT use a browser / Playwright

**Do NOT use a browser (Chrome, Playwright, `browser_preview`, the `devin/mcp-playwright` MCP server, or any other web browser tool) to debug or drive Downdraft games.** The games are native Bun + winit + wgpu apps — there is no browser or DOM to attach to. They rely on:

- The winit window/input path and wgpu device — there is no DOM, no DevTools protocol, and no remote-debugging port.
- `window.downdraft` bridge APIs installed by the native bridge, which only exist inside the game process.
- Worker threads + SharedArrayBuffer sim isolation.

A plain browser cannot reproduce any of this, and Playwright driving a browser will not exercise the real game code paths. The `devin/mcp-playwright` MCP server is for general web pages, **not** for Downdraft games.

**Instead, use the in-game MCP automation harness and `draft test`:**

1. **`bun run draft:test-cpu`** (or `bun run draft:test`) — the canonical way to launch and exercise a game headlessly. `draft test` sets `DOWNDRAFT_DETERMINISTIC=1` and spawns `bun test <spec>`; the default smoke specs use the in-game MCP RPC harness to boot the real game and drive it. The only runtime is **native**. See "Running the smoke test" below for the full CLI flag reference.
2. **The `game` MCP server** (configured in `.devin/mcp_config.json` as `bun packages/cli/src/index.ts mcp stdio` — a stdio→HTTP bridge inside `draft mcp`) — once a game is running, this exposes the game's automation tools directly to your MCP client. The bridge auto-discovers the running instance via PID files in `~/.downdraft/port/<pid>` (content = the bound port). **List the tools first with `mcp_list_tools` before calling any of them** — never guess tool names or argument schemas. The currently registered tools (see `games/to-the-ocean/src/mcp/automation-tools.ts`) include:
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
# 1. Launch the game with deterministic mode (MCP port is auto-assigned)
cd games/to-the-ocean && DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 draft dev &
# 2. Call game MCP tools (inject_input, get_player_state, capture_screenshot, ...)
#    to drive the game and inspect state. The bridge auto-discovers the port.
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
- House rule `downdraft/no-for-of` (error): `for..of` is banned except where it's the required iteration structure — a call result (`Object.entries()`, `map.entries()`, generators, ...) or `for await..of`. Use `.forEach()` or an indexed `for` loop otherwise. The rule lives in `packages/engine/lint-plugin.mjs` (oxlint JS plugin, resolved as `@downdraft/engine/lint-plugin` from every `.oxlintrc.json` — root + each game).
- `bun test packages/engine/core/src/ecs/world.spec.ts packages/engine/core/src/render/frustum.spec.ts packages/engine/core/src/telemetry/collector.spec.ts`
- `bun test packages/engine/core/src/physics/*.spec.ts` — all physics specs (121 tests).
- `bun test packages/engine/modules/physics-rapier/src/*.spec.ts` — rapier module specs (16 tests).
- `bun test packages/engine/core/src/render/bindless/bindless.spec.ts` — bindless texture registry + material manager specs.
- `bun test packages/engine/core/src/material/material.spec.ts packages/engine/core/src/material/variants.spec.ts` — material + variant specs.
- `bun test packages/engine/shader-graph/src/graph.spec.ts` — shader graph compiler specs (includes GBuffer multi-target + variant tests).
- `bun test packages/engine/modules/models/src/material-adapter.spec.ts` — MaterialData→Material adapter specs.
- `bun test packages/engine/core/src/assets/model-normalizer.spec.ts` — model normalizer math (up-axis, units, bounds, auto-fit).
- `bun test packages/engine/modules/models/src/bake-node-transforms.spec.ts` — node hierarchy transform baking specs.
- `bun test packages/engine/modules/models/src/sidecar/sidecar.spec.ts` — sidecar parsers (.ddmeta.json, Unity .meta, Godot .import, Blender extras).
- `bun test packages/engine/modules/models/src/normalize.spec.ts` — full normalization pipeline specs.
- `bun test packages/engine/core/src/module/host.spec.ts` — ModuleHost activation order, deferred registration, dispose order (12 tests).
- `bun test packages/engine/modules/devtools/src/api.spec.ts` — Unified DevTools API: realm detection, SAB data feeds, manifest, panel/command registration (17 tests).
- `bun test packages/engine/core/src/render/gpu-utils.spec.ts` — GPU resource creation utilities (8 tests, uses mock GPUDevice).
- `bun test games/to-the-ocean/modules/wildlife/src/wildlife-module.spec.ts` — game module wrappers (wildlife, buoyancy, collision) (9 tests).
- `bun test packages/engine/modules/persistence/src/file-save-store.spec.ts` — FileSaveStore (filesystem ISaveStore) specs (9 tests).
- `bun test packages/engine/modules/persistence/src/opfs-save-store.spec.ts` — OpfsSaveStore (OPFS ISaveStore) specs (22 tests). Uses mock OPFS — no browser/worker environment needed.
- `bun run draft:test` — e2e smoke test with hardware GPU (headless, deterministic). Equivalent to `draft test --renderer=gpu`.
- `bun run draft:test-cpu` — e2e smoke test with SwiftShader software rendering (headless, deterministic). Equivalent to `draft test --renderer=cpu`. Use this for CI.
- `bun run draft:test -- --headed` — same but shows the native winit window (useful for debugging).
- `bun run draft:test -- --game blockheads` — run the blockheads e2e smoke test.
- `bun run draft:test -- --game sandjongg` — run the sandjongg e2e smoke test.
- `bun run test:e2e` — legacy: runs the spec directly via `bun test` (bypasses the CLI).
- `bun run tsc:e2e` — type-checks e2e test files against `tsconfig.e2e.json`.
- `bun test examples/plugin-tester/src/*.spec.ts` — run all plugin-tester specs (488 tests across 11 files: audio-kira, lighting, marching-cubes, navmesh, networking, physics-rapier, water, weather, mcp, engine, test-scene).
- `bun test examples/plugin-tester/src/audio-kira-test.spec.ts` — KiraAudioBackend specs (47 tests).
- `bun test examples/plugin-tester/src/lighting-test.spec.ts` — LightingSystem + LightSystem specs (73 tests, uses mock GPUDevice).
- `bun test examples/plugin-tester/src/marching-cubes-test.spec.ts` — Marching cubes mesh extraction specs (51 tests).
- `bun test examples/plugin-tester/src/physics-rapier-test.spec.ts` — RapierPhysicsBackend specs (JS fallback mode).

### E2E test environment variables

These are set automatically by `draft test`. See the "Running the smoke test" section below for the full CLI flag reference.

- `DOWNDRAFT_GPU=swiftshader|hardware` — selects the wgpu adapter. `swiftshader` = software Vulkan (CI), `hardware` = NVIDIA Vulkan (local).
- `DOWNDRAFT_DETERMINISTIC=1` — fixed seed (99999), skip autosave loading, disable devtools auto-open and error dialogs, pause the render loop (on-demand rendering only via `set_test_state` or `capture_screenshot`). The flag reaches the game via the `downdraft.deterministic` bridge property (set by the native bridge).
- `DOWNDRAFT_HEADED=1` — show the native winit window even in deterministic mode.
- `MCP_PORT=<port>` — MCP HTTP transport port. Unset = ephemeral OS-assigned port (default; advertised via `~/.downdraft/port/<pid>` for auto-discovery). Set explicitly for the e2e test harness (9976).
- `MCP_TIMEOUT_MS=120000` — MCP proxy IPC round-trip timeout in ms (must be longer than the longest `wait_for_condition` call).

## Unified DevTools API

The DevTools system has a single registration surface (`devtools` singleton from `@downdraft/engine/modules/devtools`) that auto-detects whether it's running in the main realm or a worker realm and chooses the appropriate transport:

- **Main realm**: panels/feeds/commands registered directly on `window.__sceneInspector` via `DevToolsDataBridge`.
- **Worker realm**: data feeds written to a devtools SharedArrayBuffer (zero-copy, synchronous reads); commands forwarded via IPC RPC; panel declarations synced to renderer via one-time manifest RPC.

### Architecture

- **`devtools` singleton** (`packages/engine/modules/devtools/src/api.ts`) — the unified API. Auto-detects realm. Modules import `devtools` and call `registerPanel()`, `registerDataFeed()`, `registerCommand()`, `registerSABStat()`. Same code works in both realms.
- **`DevToolsSABLayout`** — dedicated SAB region for JSON-serialized data feed results + direct numeric stats. Worker writes via `flushDataFeeds()` (called from sim loop); renderer reads synchronously. No IPC polling.
- **`exposeDevToolsApi()`** (`packages/engine/modules/devtools/src/worker-expose.ts`) — wraps a worker's `expose()` API with `__devtoolsGetManifest`, `__devtoolsCallCommand`, `__devtoolsGetSAB` RPC methods.
- **`syncWorkerManifests()`** (`packages/engine/modules/devtools/src/worker-sync.ts`) — renderer-side: fetches manifest from workers, merges panels, wires SAB data feed readers, wires command forwarders.
- **`createDevToolsRendererAdapter()`** (`packages/engine/modules/devtools/src/renderer-adapter.ts`) — feature-detects renderer capabilities (gpuProfiler, telemetryCollector, gpuResourceTracker, gcController) and builds an `IDevToolsDataRenderer`.
- **`createSimStatsProvider()`** (`packages/engine/modules/devtools/src/sim-stats-provider.ts`) — reusable `ISimStatsProvider` factory with 10Hz polling + pause/resume/step/speed/clear delegation. Eliminates duplicated boilerplate across sim games.
- **`initDevTools()`** (`packages/engine/modules/devtools/src/init.ts`) — one-line wiring per game. Creates bridge, wires providers, merges global registry panels, syncs worker manifests, exposes on `window.__sceneInspector`.
- **`createMaterialStatsPanelExtension()`** (`packages/engine/modules/devtools/src/material-stats-panel.ts`) — reusable "Materials" tab for any game using the unified material system.

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

`resolveDevtoolsConfig()` in `packages/platform-native/src/host-lifecycle.ts` is deterministic-aware: when `DOWNDRAFT_DETERMINISTIC=1`, autoOpen defaults to `false` and keybind defaults to `""` (disabled). Games no longer need to plumb `devtools: { autoOpen: !deterministic, keybind: deterministic ? "" : "F12" }` — just use `devtools: true`.

### Panel order convention

- `0–19`: core devtools tabs (Scene, Import, Perf, GC, Material, Render Graph)
- `20–50`: renderer-module tabs (Physics, Water, Audio, Particles)
- `50–80`: sim-module/worker tabs (Wildlife, Buoyancy, Collision, Sim Stats)
- `100+`: game-declared tabs (Debug Info, Boat Layout, World)

## Unified Material System

The material system is unified around the **shader graph as the single source of truth**. The 8 hand-written `material-types/*.wgsl` files serve as fallbacks (loaded via Vite `?raw` as `inlineShaderSource`). The graph compiler generates WGSL from `MaterialGraph` nodes; the `Material` class compiles the graph at construction time and caches the result in `inlineShaderSource`.

### Architecture

- **`MaterialDefinition`** (`packages/engine/core/src/material/material.ts`) — the material definition. Key fields: `graph?: MaterialGraph` (primary), `inlineShaderSource?: string` (compiled graph or fallback .wgsl), `variantFlags?: MaterialVariantFlags`, `profile?: string`.
- **`MaterialLibrary`** (`packages/engine/core/src/material/library.ts`) — creates and registers materials. The 8 `create*` methods (Physical, Toon, Matcap, SSS, Sprite, Normal, Line, Depth) load their `.wgsl` fallbacks via `?raw` imports. Graph preset methods (`createPBRGraph`, `createGBufferGraph`) build `MaterialGraph` instances.
- **`GraphCompiler`** (`packages/engine/shader-graph/src/compiler.ts`) — compiles a `MaterialGraph` to WGSL. Supports multi-render-target (GBuffer) profiles via `outputFormats`/`outputNames`, and variant-aware compilation via `variantFlags` in `CompileOptions`.
- **`MaterialVariantFlags`** (`packages/engine/core/src/material/variants.ts`) — hybrid variant strategy: compile-time permutations for `shadowCaster`/`skinning`/`alphaMode`/`morph`/`instanced`; `fog` stays a dynamic branch (NOT part of the variant key). `variantKey()` produces a deterministic string key; `permutationCount()` = 48.
- **`graph-bridge.ts`** (`packages/engine/core/src/material/graph-bridge.ts`) — `compileGraphToMaterialVariants` compiles all variants for a material; `compileVariant` compiles a single variant.
- **`OpaquePass`** (`packages/engine/core/src/render/passes/opaque.ts`) — `setMaterial()` sets a graph-compiled material; `setMaterialVariant()` compiles + caches a per-variant pipeline (bounded LRU, max 24). `getProfileTargets()` emits multi-target `GPUColorTargetState[]` for GBuffer profiles.

### Profiles

- `SIMPLE_PROFILE`, `PBR_PROFILE`, `PBR_TEXTURED_PROFILE`, `PBR_SKINNED_PROFILE`, `PBR_INSTANCED_PROFILE`, `PBR_COLOR_VERTEX_PROFILE` — single-target.
- `GBUFFER_PROFILE` — multi-render-target deferred surface shader. 4 targets: albedo+AO, normal+roughness, metallic+emissive, velocity. Graph output nodes use names: `"albedo"`, `"normal"`, `"metallicEmissive"`, `"velocity"`.

### Material adapter (module-models)

`materialDataToMaterial()` (`packages/engine/modules/models/src/material-adapter.ts`) bridges serialized `MaterialData` (glTF/obj format) to the core `Material` surface. Maps baseColor/metallic/roughness/emissive to uniforms, sets `inlineShaderSource` from the physical fallback .wgsl. `materialDataArrayToMaterials()` batch-converts. The game's `RendererAccessors.uploadModel()` calls this to register materials in a `MaterialLibrary`.

## Model Import Normalization Pipeline

The engine has a unified model import normalization pipeline that corrects common anomalies (incorrect scaling, rotation, up-axis) at load time. This replaces ad-hoc hardcoded fixes in individual games.

### Architecture

- **`ImportSettings`** (`packages/engine/core/src/assets/import-settings.ts`) — per-model normalization config: `upAxis`, `units`, `scale`, `rotation`, `centerToOrigin`, `autoFit`, `nodeTransforms`. Resolved from sidecar files or parser-detected defaults.
- **`model-normalizer.ts`** (`packages/engine/core/src/assets/model-normalizer.ts`) — pure transform math: `applyUpAxisConversion` (Z-up→Y-up), `applyUnitScale` (source units→meters), `applyRootScale`, `applyRootRotation` (quaternion), `computeBounds`, `centerToOrigin`, `autoFit`, `isExtremeScale`. Operates on interleaved [pos(3)+normal(3)] mesh vertices (6 floats/vertex).
- **`bake-node-transforms.ts`** (`packages/engine/modules/models/src/bake-node-transforms.ts`) — bakes glTF/FBX node hierarchy transforms (translation, rotation, scale) into mesh vertices. Promoted from downdraft-model-viewer to the engine so all games benefit.
- **`normalize.ts`** (`packages/engine/modules/models/src/normalize.ts`) — orchestrates the full pipeline: up-axis → unit scale → node-transform baking → root rotation → user scale → bounds → center → auto-fit. `normalizeModel()` applies settings; `normalizeModelWithResolution()` resolves sidecars then normalizes.
- **`loadModel()`** (`packages/engine/modules/models/src/loader.ts`) — now normalizes by default after parsing. Pass `normalize: false` to skip (e.g. for games that handle their own transforms). Pass `sidecarResolver` for custom sidecar resolution.

### Sidecar System

Per-model import settings are stored in sidecar files, tried in priority order:
1. `.ddmeta.json` (our format, JSON-with-comments via `comment-json`)
2. Unity `.meta` (YAML, `scaleFactor` field)
3. Godot `.import` (INI, `scale`/`rotation` params)
4. Blender extras (glTF `asset.extras.glTF2ExportSettings.YUP`)

Sidecar parsers: `packages/engine/modules/models/src/sidecar/` — `ddmeta.ts`, `unity-meta.ts`, `godot-import.ts`, `blender-extras.ts`, `resolver.ts`.

### Parser Detection

FBX parser reads `GlobalSettings` for `UpAxis` (0/1=Y-up, 2=Z-up) and `UnitScaleFactor` (units per cm). glTF parser checks `asset.extras.glTF2ExportSettings.YUP`. DAE parser reads `<asset><up_axis>` and `<unit meter="...">`. Stored on `ModelData.sourceUpAxis` and `ModelData.sourceUnits`.

### Import Cache

`ImportCache` (`packages/engine/core/src/assets/import-cache.ts`) caches resolved `ImportSettings` keyed by model path. `MemoryImportCache` is the in-memory fallback. On native, `createHostImportCache()` wraps `downdraft.importCache*` — the host keeps a SQLite-backed cache beside saves/ in the game's userData dir, and the wrapper warms an in-memory mirror asynchronously so `get()` stays synchronous.

## Save system / storage backends

`ISaveStore` (`packages/engine/core/src/save/persist-types.ts`) is the storage interface for versioned game saves. The extended interface supports: `save`/`load` (with `SaveOptions`/`LoadOptions` for blobs, thumbnails, properties, generation control), `listSaves`/`listGenerations`/`deleteSave`/`deleteGeneration`, `setThumbnail`/`getThumbnail`, `setProperties`/`getProperties`, and `onWarning`. Saves are a zstd-compressed JSON body of per-component sections (each with its own schema version) plus a header (engine version, timestamp, entity/player counts, XXH128 hash). The `MigrationRegistry` runs per-component `fromVersion→toVersion` migrations on load; forward-incompatible saves (newer engine than current) are refused. Implementations live in `@downdraft/engine/libraries/persistence` (`packages/engine/modules/persistence/`):

- **`OpfsSaveStore`** (`opfs-save-store.ts`) — **default** OPFS-backed store for Web Workers and renderer. Writes directly to OPFS (no IPC, no main process). Supports generation history (N snapshots per slot, previous gen is backup on corruption), binary blobs (stored as separate files per blob key), thumbnails (PNG/WebP bytes), and arbitrary properties (game mode, playtime, etc.). Uses `createSyncAccessHandle()` in workers (sync I/O) or `createWritable()` on main thread. Directory layout: `downdraft/saves/<slot>/meta.json` + `thumbnail.png` + `gen/<NNNN>/body.zst` + `body.hash` + `blobs/<key>`. The `meta.json` file is the commit point — written last after body + blobs. 22 tests in `opfs-save-store.spec.ts` (uses mock OPFS via `mock-opfs.ts`).

  **Three save modes** (game selects via `DowndraftSavesConfig.mode`):
  - `"inline"` — `OpfsSaveStore` runs inside the sim worker. Sim loop pauses during save (sync OPFS handles). Zero-copy: no data crosses worker boundaries. The sim worker calls `initSaveStore()` to create the store, then `save()`/`load()` use it directly.
  - `"worker"` — Renderer spawns a dedicated `save-worker.ts` Web Worker. Sim worker sends serialized state as transferable `ArrayBuffer` via `MessageChannel`. Sim loop continues running during save. The `SaveWorkerProxy` (`save-worker-proxy.ts`) implements `ISaveStore` by delegating to the worker via the RPC layer.
  - `"auto"` (default) — Picks `"worker"` if OPFS is available (`navigator.storage.getDirectory`), else falls back to the filesystem store.

  The `createSaveStore()` factory (`packages/engine/app/src/renderer/save-store-factory.ts`) handles mode selection and OPFS detection. The `SimBridgeDeps.saveMode` field tells the sim bridge which path to use.

- **`FileSaveStore`** (`file-save-store.ts`) — filesystem backend, used on native where OPFS does not exist. One `.ddsave` file per slot (header + zstd body), rotated to `.bak` on each save; `.bak` is the load fallback on corruption/hash-mismatch. Node-only (`node:fs`). Now supports the extended `ISaveStore` interface: blobs stored in `<slot>.blobs/` directory, thumbnails in `<slot>.thumb`, properties in `<slot>.props.json` sidecar. `listGenerations()` returns a single synthetic generation; `deleteGeneration()` delegates to `deleteSave()`.

### Devtools Auto-Fit

`BaseSceneInspector.importModel()` returns `needsAutoFit` and `warnings` when a model has extreme scale (< 0.01m or > 100m). The DevTools panel UI (`extension/panel.js`) shows an auto-fit prompt with a button that calls `autoFitModel(nodeId, targetMaxDim)`, which re-normalizes and generates a `.ddmeta.json` sidecar for persistence. `generateSidecar(nodeId)` creates a starter sidecar with commented-out fields.

### Devtools material editor

`BaseSceneInspector` (`packages/engine/modules/devtools/src/scene-inspector.ts`) exposes a functional material editor API: `compileMaterialGraph`, `createMaterialFromGraph`, `saveMaterialToLibrary`, `listMaterials`, `exportMaterialAsJSON`, `importMaterialFromJSON`, `previewMaterialGraph` (live preview via `setPreviewMeshRenderer`). The editor UI (`packages/engine/ui/src/editor/material-graph/material-graph-editor.tsx`) has a synced node palette (all compiler node types) and a Preview button.

### Hot reload

`HotReloader` (`packages/engine/core/src/render/hot-reload.ts`) writes reloaded shader source into `material.inlineShaderSource` (not the dead `shader` string field) and calls `material.invalidateVariants()` to flush the variant cache.

## Compute Graph System

The engine has a node-based compute shader authoring system that parallels the material graph. It provides a higher-level alternative to hand-writing WGSL compute shaders (the "gpu.js replacement" for WebGPU).

### Architecture

- **`ComputeGraph`** (`packages/engine/shader-graph/src/compute-graph.ts`) — the compute graph data structure. Separate from `MaterialGraph` (which is vertex/fragment only). Contains nodes + connections + `StorageBufferDecl`/`UniformBufferDecl` declarations + `ComputeDispatchConfig` (workgroup size + dispatch count).
- **`ComputeGraphCompiler`** (`packages/engine/shader-graph/src/compute-compiler.ts`) — compiles a `ComputeGraph` to WGSL `@compute @workgroup_size(...)` shader. Emits struct declarations from buffer decls, `@group/@binding` var declarations, and a `cs_main` entry point with `global_invocation_id`/`local_invocation_id`/`workgroup_id`/`num_workgroups` builtins. Compute-specific nodes: `global_id`, `buffer_load`, `buffer_store`, `atomic_add/sub/min/max/exchange`, `workgroup_barrier`, `storage_barrier`. Math nodes (multiply, add, sin, etc.) are shared with the material compiler.
- **`ComputeProfile`** (`packages/engine/shader-graph/src/compute-profiles.ts`) — simpler than `ShaderGraphProfile`: just `name`, `chunks`, `workgroupSize`. Built-in profiles: `SIMPLE_COMPUTE_PROFILE` (64x1x1), `PARTICLE_COMPUTE_PROFILE` (64x1x1), `TEXTURE_COMPUTE_PROFILE` (8x8x1), `VOLUMETRIC_COMPUTE_PROFILE` (4x4x4).
- **`GraphComputePass`** (`packages/engine/core/src/render/passes/graph-compute.ts`) — `RenderPass` subclass with `PassType.Custom`. Integrates with the frame graph (dispatches on the shared encoder). Supports both auto-allocated buffers (from `StorageBufferDecl`/`UniformBufferDecl`) and externally-provided buffers (`setExternalBuffer()`). `recompile()` supports hot-reload. Uses local `BUFFER_USAGE`/`SHADER_STAGE_COMPUTE` constants instead of WebGPU globals for testability.
- **`runComputeKernel()`** (`packages/engine/core/src/render/compute-kernel.ts`) — thin imperative helper for quick one-off GPGPU. Takes WGSL + typed inputs, dispatches once, returns a `readBuffer()` function for CPU readback. No graph, no frame graph needed.
- **`ComputeGraphEditor`** (`packages/engine/ui/src/editor/compute-graph/compute-graph-editor.tsx`) — React component for visual compute graph authoring. Compute-specific node palette + buffer declaration panel (add/edit storage & uniform buffers) + dispatch config (workgroup size, dispatch count).

### Buffer management

`GraphComputePass` supports two modes:
1. **Auto-allocated** (default): creates `GPUBuffer`s from `StorageBufferDecl`/`UniformBufferDecl` declarations. Storage buffers use `STORAGE | COPY_DST | COPY_SRC`; uniform buffers use `UNIFORM | COPY_DST`. Runtime-sized arrays default to 1 MB.
2. **Externally provided**: `setExternalBuffer(name, buffer)` skips auto-allocation for that buffer. Used for interop with existing systems (e.g. particle buffers from `ParticleComputePass`).

Data is written via `writeUniform(name, data)` (queued, flushed before dispatch) and `writeStorage(name, data)` (immediate `queue.writeBuffer`).

### Verification commands

- `bun test packages/engine/shader-graph/src/compute-compiler.spec.ts` — compute graph + compiler specs (17 tests).
- `bun test packages/engine/core/src/render/passes/graph-compute.spec.ts` — compute pass specs (7 tests).
- `bun test packages/engine/core/src/render/compute-kernel.spec.ts` — kernel helper specs (5 tests).

## Bindless rendering model

The engine uses a bindless material binding model to eliminate per-draw bind-group churn. Material parameters (baseColor, roughness, texture indices) live in a single SSBO; textures are registered into global `texture_2d_array` buckets keyed by format/dimensions/mips. A single bind group (`@group(3)`) is set once per frame and shared by all draw calls.

### Core infrastructure (`packages/engine/core/src/render/bindless/`)

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

- `tsconfig.web.json` and `tsconfig.node.json` are composite projects with `outDir: "dist"`.
- `@dimforge/rapier3d-compat` is at `0.19.3`. The internal `RawRigidBodySet`/`RawColliderSet` types are not exported in that version, so `rapier-physics-system.ts` uses `any` for the raw body/collider references.
- **WASM borrow aliasing:** Rapier 0.19.x returns `RawVector`/`RawRotation`/`RawColliderShape` objects from methods like `body.translation()`, `controller.computedMovement()`, and `ColliderDesc.trimesh()`. These hold WASM borrows that must be explicitly `.free()`d before `world.step()`. The `rapier-backend.ts` `addCollider` frees `cd.shape` after `world.createCollider()` (the collider set clones the `SharedShape` Arc). Same for `getColliderPosition`, `getBodyTransform`, `characterMove`, and the raw fast-path fallbacks. Failure to free causes "recursive use of an object detected which would lead to unsafe aliasing in rust" panics during `world.step()`.
- **Raw fast-path handle mapping:** The `*Raw` methods in `rapier-backend.ts` receive `bodyId` (the game's `PhysicsBody.id`, sequential: 1, 2, 3...) but must pass the **Rapier rigid-body handle** (`body.handle`, starts at 0) to WASM functions like `rbSetTranslation`. The raw fast paths look up the `RigidBody` from `bodyMaps` to get `body.handle`. Passing `bodyId` directly causes out-of-bounds WASM access that corrupts internal state and triggers the aliasing panic.
- **`swapColliderShapeRaw` shape type:** `ColliderDesc.trimesh()` returns a `SharedShape` (Eg) which stores vertices/indices but does NOT hold a `RawColliderShape`. `coSetShape` expects a `RawShape` (OA). Call `shape.intoRaw()` to get the `RawColliderShape`, pass it to `coSetShape`, then `.free()` it.

## Universal Physics Module (physics-rapier 0.2.0)

- The `PhysicsBackend` interface is now `PhysicsBody`-keyed (opaque body refs). Raw Rapier `RigidBodyHandle` is no longer exported from `@downdraft/engine`.
- Multi-realm LOD: `RealmManager` drives near/mid/far tiers with promote/demote + dwell hysteresis. Static bodies are duplicated into all realms by default.
- `UniversalPhysicsAPI` (`@downdraft/engine/libraries/physics-rapier`) is the single public surface: body lifecycle, validated state access, realm queries, interpolation, raycast, snapshots, hooks.
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

## Host SDK (`@downdraft/engine/app` — runtime-agnostic host layer)

The native host (`packages/platform-native`) owns the process: it creates the winit window, the wgpu device/surface, installs the `window.downdraft` `HostAPI` bridge in-process (no IPC, no preload), and runs the MCP server. A game boots from `src/native-entry.ts` → `runNativeGameModule()` / `startNativeGame()` / `createNativeHost()`.

### Subpath exports

- `@downdraft/engine/app/renderer` — `startGame()`/`bootstrapGame()` (run on the native main thread), typed `downdraft` HostAPI accessor (stubs to no-op when absent), save-store factory, standard MCP automation tools.
- `@downdraft/engine/app/shared` — the `HostAPI` contract types (`packages/engine/app/src/shared/types.ts`).

### Process model

Single process: the game module, renderer, host services, sim-worker host, and MCP server all live in the one Bun process; the simulation runs in a dedicated Bun worker (SAB channels, unchanged). Recovery is restart-based — `downdraft.requestRestart(reason)` respawns the process (see `packages/platform-native/src/native-restart.ts`); `window.location.reload()` is not a recovery path on native. Devtools + OSR are in-process WebGPU overlays (`modules/native-osr`), not embedded web panels.

## Game automation & headless testing

### GPU mode environment variable

Set `DOWNDRAFT_GPU=swiftshader` to force the SwiftShader software Vulkan backend for headless CI / testing without a GPU. Without this env var, the engine uses the hardware GPU (NVIDIA Vulkan on Linux, D3D12 on Windows).

### MCP automation harness (`to-the-ocean`)

`to-the-ocean` registers a renderer-side MCP automation harness (`games/to-the-ocean/src/mcp/setup.ts`) wired to the existing main-process MCP HTTP proxy. It exposes game-specific tools without importing the Node-only `@downdraft/engine/mcp` server bundle into the renderer:

- `inject_input` — hold keys/mouse/wheel for a number of frames via `RendererInputHandler.injectInput()`.
- `clear_injected_input` — cancel pending injected input.
- `get_player_state` — read player slot from the simulation SharedArrayBuffer.
- `get_world_state` — read global simulation state (tick, entity count, weather, etc.).
- `wait_for_condition` — poll a JS predicate against player/world state with timeout.
- `capture_screenshot` — return the WebGPU canvas as a base64 PNG.
- `set_test_state` — set weather, time of day, sim speed, or respawn the player.

Input injection is merged with real DOM input in `processInput()` so the game loop does not need to know whether the input came from a human or a test.

### Connecting Devin's MCP client to the game

The game's MCP HTTP transport (`packages/engine/mcp/src/http-transport.ts`) supports both Streamable HTTP and HTTP+SSE transports. By default it binds to an **ephemeral OS-assigned port** (port 0) so multiple game instances never collide. **The endpoint is dev/test infrastructure only — `scripts/package-native.mjs` (`draft release`) defines `__DD_MCP_STRIP__` so it's compiled out of distributed binaries; `--mcp` retains it (still runtime-gated by `DOWNDRAFT_MCP=1`).** Devin's MCP client uses stdio for local servers, so `draft mcp stdio` forwards JSON-RPC messages from stdin/stdout to the game's HTTP endpoint.

**Instance discovery:** Each running game writes `~/.downdraft/port/<pid>` (content = the bound port number; `<pid>.token` holds the bearer token when auth is required). `GameClient.connect()` / `draft mcp` / the stdio bridge all read this directory, prune dead-PID files, and connect to the newest live instance. Optional env vars:
- `MCP_APP_ID=<appId>` — narrow to instances of a specific game (matches `--user-data-dir=<path>` basename on Linux; e.g. `downdraft-to-the-ocean`).
- `MCP_PID=<pid>` — connect to a specific PID.
- `DOWNDRAFT_MCP_URL` / `MCP_HTTP_URL=<url>` — explicit URL override (skips discovery; used by the e2e test harness and `draft mcp run`).

To connect:
1. Start the game: `cd games/to-the-ocean && DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 draft dev`
2. The MCP config (`.devin/mcp_config.json`) runs `bun packages/cli/src/index.ts mcp stdio`.
3. The bridge discovers the port from `~/.downdraft/port/<pid>` and forwards `initialize`, `tools/list`, `tools/call` to `http://localhost:<port>/mcp`.
4. Notifications (messages without an `id` field, like `notifications/initialized`) are silently ignored by the bridge.
5. `resources/list` and `prompts/list` return empty lists (the game doesn't expose resources or prompts).

**Multiple instances:** Launch as many games as you like — each gets its own ephemeral port and PID file. Clients connect to the newest by default; use `--app`/`--pid` (or `MCP_APP_ID`/`MCP_PID`) to target a specific game.

**Programmatic client (`@downdraft/engine/mcp/client`):** the single implementation of discovery + handshake + envelope unwrapping — used by `draft mcp`, the stdio bridge, and the e2e harness. Node- and Bun-compatible.

```ts
import { GameClient, launchGame } from "@downdraft/engine/mcp/client";

const client = await GameClient.connect();          // PID-file discovery
const tools = await client.listTools();
const state = await client.callJson("get_world_state");
await client.screenshot("shot.png");

const game = await launchGame({ game: "to-the-ocean", deterministic: true });
await game.client.callText("get_player_state");
await game.kill();                                   // process-tree kill
```

**One-shot shell access:** `draft mcp` calls game MCP tools directly from bash (replaces the old `scripts/mcp-call.mjs`). Output contract: payload on stdout, diagnostics on stderr, text capped at `--max-bytes` (256 KiB), image blocks never inline — `--out <file>` writes them to disk, `--json` prints the raw envelope with `data` elided to `{bytes}`.

```bash
draft mcp instances                              # live instances (pid, port, appId)
draft mcp tools                                  # tools/list (name + description)
draft mcp tools --schema get_world_state         # one tool's inputSchema
draft mcp call get_world_state                   # tools/call, no args
draft mcp call set_test_state '{"weather":1}'    # tools/call with JSON args
draft mcp screenshot shot.png                    # capture_screenshot → file
draft mcp run script.ts --game to-the-ocean      # launch game → run script (gets DOWNDRAFT_MCP_URL) → kill
```

Key bridge fixes:
- Notifications (no `id`) must not receive a response — the bridge silently drops them.
- The proxy handler wraps errors in the `result` field; the bridge detects `result.error` and converts it to a proper MCP `error` response.

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
- `--headed` — Show the native winit window instead of running headless. Sets `DOWNDRAFT_HEADED=1`.
- `--game <name>` — Game to test (default: `to-the-ocean`). Resolves spec to `tests/e2e/<game>-smoke.spec.ts`.
- `--spec <path>` — Override the spec file path.
- `--port <n>` — MCP port (default: 9976). If omitted, the harness auto-allocates a free port.
- `--no-deterministic` — Disable fixed seed / render loop pause / window hiding.
- `--build` / `--build-only` — on `draft release` these are aliases for `--stage=build`. Native packaging is `scripts/package-native.mjs`.

**Environment variables (set automatically by `draft test`):**
- `DOWNDRAFT_GPU=swiftshader|hardware` — selects the WebGPU backend via `webGpuSwitches()`.
- `DOWNDRAFT_DETERMINISTIC=1` — fixed seed (99999), skip autosave, disable devtools auto-open, pause render loop (on-demand rendering only). Exposed via `downdraft.deterministic` on the HostAPI bridge.
- `DOWNDRAFT_HEADED=1` — show the window even in deterministic mode. Without this, `window.ts` suppresses `win.show()` when `DOWNDRAFT_DETERMINISTIC=1`.
- `MCP_PORT=9976` — MCP HTTP transport port (explicit; unset = ephemeral for dev).
- `MCP_TIMEOUT_MS=120000` — MCP proxy IPC round-trip timeout.

**Headless / CI without a display:** The CLI auto-detects missing `DISPLAY` and wraps in `xvfb-run` if available. Install it with `sudo apt install xvfb`. winit still needs an X server even when the window is hidden — wgpu renders to the window surface via SwiftShader when `DOWNDRAFT_GPU=swiftshader`.

**Legacy scripts** (still available, bypass the CLI):
- `bun run test:e2e` — runs the spec directly via `bun test` (uses whatever env vars are set).
- `bun run test:e2e:headless` — same, but forces `DOWNDRAFT_GPU=swiftshader`.
- `bun run test:e2e:local` — same, no env override (uses hardware GPU by default).

`tests/e2e/harness.ts` launches `bun games/<game>/src/native-entry.ts`, waits for the native MCP HTTP health endpoint, and drives the game through MCP tool calls. The smoke test (`tests/e2e/to-the-ocean-smoke.spec.ts`) verifies that the tool surface exists, the simulation ticks, injected input advances the world, and a screenshot can be captured.

**Build mode:** `draft release --stage=build` (or `--build-only`) compiles the native binary without packaging. Production-build e2e uses `draft release`.

**Dynamic ports:** The harness auto-allocates a free MCP port starting from 9976, enabling parallel spec execution. Specs read the port from `process.env.MCP_PORT` (set by `draft test --port`). To run multiple specs simultaneously, omit `--port` and let each spec pick its own.

**Process cleanup:** The harness kills the entire process group (the `bun` game process and its worker threads) on test completion. It uses `process.kill(-pid, SIGTERM)` with a SIGKILL fallback after 5s.

**Retry logic:** The harness `callToolWithRetry()` method retries MCP operations on transport errors (connection refused, timeouts) with exponential backoff. Tool-level errors (isError: true) are not retried.

### CLI environment variables — consolidated reference

The CLI reads and sets a number of environment variables. This is the complete list; see `docs/site/src/content/docs/reference/cli.md` for the full CLI flag reference.

**Set by the CLI (`draft test`):**

| Variable | Value | Purpose |
|---|---|---|
| `MCP_PORT` | `<port>` | MCP HTTP transport port (unset = ephemeral, auto-discovered via `~/.downdraft/port/<pid>`) |
| `MCP_TIMEOUT_MS` | `120000` | MCP proxy IPC round-trip timeout (ms) |
| `DOWNDRAFT_GPU` | `swiftshader` \| `hardware` | WebGPU backend selection |
| `DOWNDRAFT_DETERMINISTIC` | `1` | Fixed seed, paused render loop, no autosave |
| `DOWNDRAFT_HEADED` | `1` | Show the window in deterministic mode |
| `DOWNDRAFT_TEST_BUILT` | `1` | Launch the built app instead of the dev server |

**Read by the CLI:**

| Variable | Used by | Purpose |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | `assets` | S3 credentials fallback (manifest config wins) |
| `AWS_SECRET_ACCESS_KEY` | `assets` | S3 credentials fallback |
| `DISPLAY` | `test` | When absent, wraps in `xvfb-run` |
| `DOWNDRAFT_STRICT` | all commands | `1` → hard-error on unknown CLI flags (warns otherwise) |

**Read by the runtime (set by CLI or user):**

| Variable | Used by | Purpose |
|---|---|---|
| `DOWNDRAFT_STRICT` | `packages/engine/core/src/module/diagnostics.ts` | `0`/`1` force-disable/enable module DI validation (else = Vite dev mode) |
| `DOWNDRAFT_MCP` | `packages/engine/core/src/util/logger.ts` | `1` routes logs to stderr (keeps stdout clean for MCP JSON-RPC) |
| `DOWNDRAFT_DISABLE_DEVTOOLS` | `packages/cli/src/debug.ts` | `1` suppresses devtools auto-open (set by `draft debug --no-devtools`) |

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

Common false positives to filter out: GTK module warnings, WebSocket connection failures during teardown, Vulkan/ICD loader chatter.

### E2E test gotchas

- **MCP port conflicts**: If a previous test run didn't clean up, port 9977 may still be in use. Free it with `fuser -k 9977/tcp`, then kill **only the specific game instance** as described in "Killing game processes" above — do NOT use a generic `pkill -9 bun` (it will kill unrelated Bun processes).
- **Save store hangs in test environments**: `createSaveStore()` can hang when OPFS is not available (SwiftShader/headless). The MCP harness must be registered BEFORE the save store init so e2e tests can connect.
- **`requestPointerLock()` returns a Promise in newer Chrome**: The Promise can reject with `WrongDocumentError` if the canvas was detached or during ESC cooldown. Always `.catch()` the return value to avoid uncaught rejections.

### Why not a WebGL2 fallback?

The engine relies on WebGPU-specific features (bindless `texture_2d_array`, storage buffers, compute passes, GBuffer MRT). A WebGL2 renderer would be a second, incompatible implementation. For testing, we instead use SwiftShader's Vulkan backend to run the unmodified WebGPU pipeline in software, and we inject input through the renderer so Playwright does not need to manipulate pointer lock or raw GPU output.

## UI typography: minimum font size

All UI text rendered by the engine and games MUST use a font size of **at least 12px**. This applies to in-game HUDs, menus, tooltips, DevTools panels, and any DOM overlay content generated by the framework.

- Do not set `font-size` below `12px` (e.g. no `10px`, `11px`, or `0.7rem`-style values that resolve below 12px) in CSS, inline styles, or stylesheet theme overrides.
- When adapting third-party component styles or copying reference markup, bump any sub-12px font sizes up to 12px.
- The base stylesheet (`packages/engine/app/src/renderer/downdraft-base.css`) should not introduce a root font size below 12px; game theme overrides layered on top of it must also respect this floor.
- This is a readability/accessibility floor, not a target — larger sizes are fine where appropriate.

## Native packaging (`draft release`)

`draft release` is the unified build + package pipeline that replaced the separate `build`, `dist`, `export`, `mobile`, and `build-games` commands. The old commands remain as deprecated backward-compat aliases that delegate to `release`.

```
draft release [--game=<name>] [--games=<csv>] [--target=<win|linux|mac|all>]
              [--stage=<build|package|release>] [--mode=<dev|debug|prod>]
              [--out=<dir>] [--mcp] [--verbose]
```

All stages compile the same artifact via `scripts/package-native.mjs`: a standalone Bun binary (`<out>/<game>-<target>`) plus a sibling `native/` cdylib and `dd-assets/` staging tree. `--mcp` retains the MCP endpoint in the packaged binary (stripped by default via `__DD_MCP_STRIP__`). Mobile targets are removed — a future mobile port would be native, not WebView.

Windows binaries are stamped with version info and icons by `package-native.mjs` via `resedit` (in-place `.rsrc` regeneration — the `.bun` trailer is preserved).

## Mobile targets — removed

The Capacitor/WebView mobile path (`draft mobile`, `release --target=android,ios`, `packages/mobile-shell`, per-game `android/`/`ios/` dirs) is **deleted** — it was dormant and unmaintained. A future mobile port would target the native runtime (winit/SDL + wgpu), not a WebView shell.

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

- `packages/engine/core/src/plugin/manifest.ts` — `PluginManifest` type + `validatePluginManifest`.
- `packages/engine/core/src/plugin/permissions.ts` — permission resolution + tier allowed sets + global allowlist.
- `packages/engine/core/src/plugin/context.ts` — `ScriptPluginContext` + `NativePluginContext` tiered facades.
- `packages/engine/core/src/plugin/registry.ts` — `PluginRegistry` (topological sort by dependencies).
- `packages/engine/core/src/plugin/host.ts` — `PluginHost` (discover/validate/load/unload/dispose/snapshot).
- `packages/engine/core/src/plugin/sandbox-shim.ts` — worker-side global restriction.
- `packages/engine/core/src/plugin/sandbox-worker.ts` — sandbox worker entry for worker-js plugins.
- `packages/engine/core/src/plugin/loader-worker.ts` — `WorkerPluginLoader` + `InlinePluginLoader`.
- `packages/engine/core/src/plugin/loader-asset.ts` — `AssetPluginLoader`.
- `packages/engine/core/src/plugin/loader-quickjs.ts` — `QuickjsPluginLoader`.
- `packages/engine/core/src/plugin/quickjs-bridge.ts` — QuickJS host↔VM bridge (handle tracking, marshaling, interrupt handler).
- `packages/engine/core/src/plugin/loader-wasm.ts` — `WasmPluginLoader` + `InlineWasmPluginLoader`.
- `packages/engine/core/src/plugin/wasm-abi.ts` — WASM ABI v2 types + memory marshaling helpers.
- `packages/engine/core/src/plugin/wasm-worker.ts` — WASM worker entry.
- `packages/engine/core/src/plugin/workshop.ts` — `WorkshopFetcher` (remote pack fetch + cache).
- `packages/engine/core/src/plugin/diagnostics.ts` — `PluginInfo` snapshot for the doctor panel.
- `packages/engine/core/src/plugin/mcp-tools.ts` — MCP automation tools.
- `packages/cli/src/scaffold-plugin.ts` — CLI plugin scaffold.
- `packages/cli/src/plugin-command.ts` — `dd plugin` CLI subcommand.
- `packages/engine/modules/devtools/src/doctor-panel.ts` — doctor panel with plugin table.
- `packages/engine/app/src/renderer/game-module.ts` — `PluginRuntimeConfig` + `GameModule.plugins` wiring.

### Sample plugins

- `games/overburden/plugins/bronze-blocks/` — worker-js native tier (ECS + typed DI).
- `games/overburden/plugins/crop-sprites-pack/` — asset data tier (texture + JSON).
- `games/sandjongg/plugins/speed-mode/` — quickjs script tier (events + state + tick).
- `games/sandjongg/plugins/custom-scorer/` — wasm native tier (ABI v2, Fibonacci scorer).

## Profiling system (`@downdraft/engine/profiling` + `@downdraft/engine/libraries/profiler`)

A comprehensive cross-thread profiling + tracing system with an in-game overlay (Puffin-style flame graph, memory/CPU/IOPS/event-loop/GC views, warning toasts, trace recording + export).

### Architecture

- **`@downdraft/engine/profiling`** — the core profiling primitives:
  - `ProfilingSAB` — a `SharedArrayBuffer` with a fixed layout: slot table (per-worker), per-slot metrics (ThreadMetrics), IOPS ring, event-loop block, warning ring, string table. Workers claim slots; the renderer reads all slots + drains the warning ring each frame.
  - `ProfilingSABWriter` / `ProfilingSABReader` — writer (worker-side) + reader (renderer-side) for the SAB.
  - `ThreadMetricsWriter` — writes heap/CPU/GC/task-latency metrics to the SAB each tick.
  - `TaskLatencyHistogram` — fixed-bucket histogram for task/tick latency (p50/p95/p99/max) + a sample ring for the flame graph.
  - `WarningEngine` — multi-level warning-rules engine. Rules fire in two modes: instantaneous (worker-side, `checkInstant()`) and windowed (renderer-side, `checkWindow()`). Supports auto-trace (starts recording on warning).
  - `EventLoopMonitor` — rAF jitter, long-task detection, idle headroom measurement.
  - `TraceEventWriter` — Chrome Trace Event / Perfetto / Spall format export.
  - IOPS patches: `patchOpfsPrototypes()` + `patchIndexedDbPrototypes()` — wrap OPFS/IDB methods to record IOPS to the ring. `disableRendererIndexedDb()` — patches the renderer's `indexedDB.open` to throw (renderer should not do I/O).
  - `worker-prelude.ts` — imported at the top of every instrumented worker. On load, detects worker realm, and if a ProfilingSAB is attached, claims a slot + initializes all writers + the warning engine + event-loop monitor + patches prototypes.
- **`@downdraft/engine/worker/instrumented-worker-host`** — `InstrumentedWorkerHost` (extends `BaseWorkerHost`) auto-attaches the ProfilingSAB before `onInit()`. `exposeProfilingApi()` merges `__profilingAttach` / `__profilingAddRule` / `__profilingOnWarning` RPC methods into a worker's `expose()` API.
- **Vite plugin** — `profilingPreludePlugin` injects the worker prelude import at the top of worker files (configured via `DowndraftViteConfigOptions.profiling`).
- **`@downdraft/engine/modules/devtools`** — extended with:
  - `DebugViewDescriptor` + `registerView()` — declarative registration of profiler overlay views.
  - `attachProfilingSAB()` / `getProfilingSAB()` — SAB management on the devtools API.
  - `ProfilingBridge` — renderer-side bridge that creates the ProfilingSAB, runs the WarningEngine + EventLoopMonitor + TraceEventWriter, drains the warning ring each frame, fires auto-trace, and registers the 10 built-in view descriptors.
  - `initDevTools({ profiling: true })` — creates the ProfilingBridge + exposes the ProfilingSAB on `__sceneInspector`.
  - `exposeDevToolsApi()` — now merges `exposeProfilingApi()` so workers get both devtools + profiling RPC methods.
- **`@downdraft/engine/libraries/pixi-ui`** — extended with `extraSharedBuffers` in the scene context (for passing the ProfilingSAB to the pixi-ui overlay worker).
- **`@downdraft/engine/libraries/profiler`** — the profiler overlay library:
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
- **Inside-pass timestamps** (render/compute passes) — requires `timestamp-query` + `timestamp-query-inside-passes` (wgpu extension).
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

- `packages/engine/core/src/profiling/profiling-sab.ts` — SAB layout + writer + reader.
- `packages/engine/core/src/profiling/warnings.ts` — WarningEngine + rules + auto-trace.
- `packages/engine/core/src/profiling/task-latency.ts` — TaskLatencyHistogram.
- `packages/engine/core/src/profiling/event-loop.ts` — EventLoopMonitor.
- `packages/engine/core/src/profiling/trace-event-writer.ts` — Chrome Trace Event export.
- `packages/engine/core/src/profiling/worker-prelude.ts` — worker prelude (auto-runs on import).
- `packages/engine/core/src/profiling/iops/opfs-patch.ts` — OPFS prototype patching.
- `packages/engine/core/src/profiling/iops/idb-patch.ts` — IndexedDB prototype patching.
- `packages/engine/core/src/profiling/iops/renderer-idb-disable.ts` — renderer IDB disabling.
- `packages/engine/core/src/worker/instrumented-worker-host.ts` — InstrumentedWorkerHost + exposeProfilingApi.
- `packages/engine/modules/devtools/src/profiling-bridge.ts` — ProfilingBridge.
- `packages/engine/modules/devtools/src/debug-view-descriptors.ts` — DebugViewDescriptor + 10 built-in views.
- `packages/engine/libraries/profiler/src/profiler-scene.ts` — ProfilerScene (pixi-ui overlay).
- `packages/engine/libraries/profiler/src/library.ts` — ProfilerLib descriptor.
- `packages/engine/core/src/telemetry/gpu-timer-pool.ts` — GPUTimerPool (encoder-level timestamps).
- `packages/engine/core/src/telemetry/gpu-profiler.ts` — GPUProfiler (compute/blit pass timing).

## Gaussian Splatting library (`@downdraft/engine/libraries/gaussian-splats`)

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
import { GaussianSplatsLib } from "@downdraft/engine/libraries/gaussian-splats";

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

- `packages/engine/libraries/gaussian-splats/src/parser.ts` — PLY/SPLAT parser, SoA layout.
- `packages/engine/libraries/gaussian-splats/src/gpu-sort.ts` — GpuSplatSorter (radix sort + compact).
- `packages/engine/libraries/gaussian-splats/src/sh-eval.ts` — SH packing + WGSL eval chunk.
- `packages/engine/libraries/gaussian-splats/src/tile-raster.ts` — TileRasterPipeline (bin + raster).
- `packages/engine/libraries/gaussian-splats/src/renderer.ts` — GaussianSplatRenderer (orchestrator).
- `packages/engine/libraries/gaussian-splats/src/library.ts` — GaussianSplatsLib descriptor.
- `packages/engine/libraries/gaussian-splats/src/sorter.ts` — CPU sort fallback (sortSplats, filterByDistance).


## Modding system (PluginHost + mod.json)

The engine has a runtime modding system built on `PluginHost` (`packages/engine/core/src/plugin/`). This is the first real production use of the engine plugin system. Andrew's Sandbox is the first game migrated to it.

### Architecture

- **PluginHost** (`packages/engine/core/src/plugin/host.ts`) — the canonical runtime mod loader. Discovers, validates, normalizes, and loads mod manifests. Dispatches logic extensions (worker-js/wasm) and declarative extensions (assets/maps/physics/shaders).
- **Manifest** (`packages/engine/core/src/plugin/manifest.ts`) — `mod.json` is the canonical format. Legacy `plugin.json` is auto-normalized. A mod uses "one manifest, many extensions": one id, one version, one target game, one permission set, optional logic, and multiple declarative extension buckets.
- **Permissions** (`packages/engine/core/src/plugin/permissions.ts`) — resolved as `requested ∩ tier-allowed ∩ game-allowlist`. New permissions: `assets`, `physics`. Logic plugins must NOT receive raw GPU APIs. Native tier does not implicitly grant permissions.
- **Host-call bridge** (`packages/engine/core/src/plugin/context.ts`, `wasm-abi.ts`, `loader-wasm.ts`) — logic plugins mutate game state through mediated host calls (spawn_prop, set_physics, apply_torque, get_asset_ref, publish_event). WASM ABI v3 adds host-call imports + `on_host_call_result` export. Worker-js contexts expose host calls via `ctx.hostCalls`.
- **Extension loaders** (`packages/engine/core/src/plugin/extension-loaders.ts`) — registry of `ExtensionLoader` instances keyed by extension bucket. Factory functions: `createAssetLoader`, `createMapLoader`, `createPhysicsLoader`, `createPostfxShaderLoader`, `createMaterialShaderLoader`. `registerAllExtensionLoaders` wires all five.
- **MaterialRegistry** (`packages/engine/core/src/plugin/material-registry.ts`) — tracks mod-defined material shaders for spawned props.
- **PostProcessStack custom effects** (`packages/engine/libraries/postfx/src/post-process-stack.ts`) — `registerCustomEffect`/`unregisterCustomEffect`/`setCustomEffectEnabled` for mod-defined postfx shaders. Custom effects interleave with built-in effects at order-group boundaries (hdr/color-grading/camera/stylized).

### Mod manifest format (mod.json)

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "engineVersion": "^0.1.0",
  "game": "andrews-sandbox",
  "format": "asset",
  "tier": "data",
  "thread": "renderer",
  "logic": {
    "format": "worker-js",
    "thread": "own-worker",
    "entry": "./src/index.ts",
    "permissions": ["ecs", "events", "physics"]
  },
  "extensions": {
    "assets": [
      { "kind": "mesh", "id": "my-mod:crate", "path": "./assets/crate.glb" },
      { "kind": "texture", "id": "my-mod:paint", "path": "./assets/paint.png" }
    ],
    "maps": [
      { "kind": "map", "id": "my-mod:arena", "path": "./maps/arena.json" }
    ],
    "physics": [
      { "kind": "physics", "id": "my-mod:bouncy", "path": "./physics/bouncy.json" }
    ],
    "shaders": {
      "postfx": [
        { "id": "my-mod:acid", "name": "Acid", "wgsl": "./shaders/acid.wgsl", "layout": "cc", "order": "stylized", "uniforms": 16 }
      ],
      "materials": [
        { "id": "my-mod:iridescent", "wgsl": "./shaders/iridescent.wgsl", "uniforms": 32 }
      ]
    }
  }
}
```

### Game migration (Andrew's Sandbox)

Andrew's Sandbox migrated from direct `PluginScanner → ContentRegistry` wiring to `PluginHost` with bridged extension loaders. See `games/andrews-sandbox/src/plugin-host-bridge.ts` and the plugin discovery section in `games/andrews-sandbox/src/game-module.tsx`.

The bridge adapts:
- `ContentRegistry` → `AssetRegistry` (meshes/textures/pbr-materials/texture-pipelines)
- `PostProcessStack` + `MaterialRegistry` → `ShaderRegistry` (postfx + material shaders)
- Noop registries for maps + physics (not yet wired in the sandbox)

Legacy `plugin.json` manifests continue to load via auto-normalization. Plugins with custom `props` sections (e.g. bouncy-ball) also get scanned by `PluginScanner` for backward compat.

### Sample mods

- `games/andrews-sandbox/plugins/acid-postfx/` — stylized postfx shader (wavy chromatic distortion + hue cycling).
- `games/andrews-sandbox/plugins/iridescent-material/` — material shader (Fresnel + hue cycling).

### CLI scaffolding

```bash
# Scaffold a new mod (generates mod.json + extension buckets)
dd mod new my-mod --game andrews-sandbox --with shader-postfx --with assets

# Scaffold a legacy plugin (generates plugin.json)
dd plugin new my-plugin --format worker-js --game andrews-sandbox

# List all discovered plugins + mods
dd plugin list [--game <game>]
```

### Key files

- `packages/engine/core/src/plugin/host.ts` — PluginHost (canonical mod loader).
- `packages/engine/core/src/plugin/manifest.ts` — mod.json types, validation, normalization.
- `packages/engine/core/src/plugin/permissions.ts` — permission resolution.
- `packages/engine/core/src/plugin/context.ts` — plugin context + host-call API.
- `packages/engine/core/src/plugin/wasm-abi.ts` — WASM ABI v3 (host-call imports).
- `packages/engine/core/src/plugin/loader-wasm.ts` — WASM loader (buildImports exported for testing).
- `packages/engine/core/src/plugin/extension-loaders.ts` — extension loader registry + factories.
- `packages/engine/core/src/plugin/material-registry.ts` — mod-defined material shader registry.
- `packages/engine/libraries/postfx/src/post-process-stack.ts` — custom effect registration.
- `games/andrews-sandbox/src/plugin-host-bridge.ts` — sandbox bridge adapters.
- `games/andrews-sandbox/src/game-module.tsx` — PluginHost wiring in sandbox.
- `packages/cli/src/scaffold-plugin.ts` — mod/plugin scaffold.
- `packages/cli/src/plugin-command.ts` — `dd plugin` / `dd mod` CLI commands.

### Testing

```bash
# Plugin suite (manifest, permissions, host, host-calls, wasm-abi, extension-loaders, material-registry)
bun test packages/engine/core/src/plugin

# Postfx suite (including custom effect tests)
bun test packages/engine/libraries/postfx
```
## Native platform (`@downdraft/platform-native`)

A Bun-native platform layer providing direct native GPU rendering via a single Rust cdylib (`libdowndraft_platform`, crate at `native-rs/`) and `bun:ffi`. Located in `packages/platform-native/`.

### Architecture

- **GPU**: the `wgpu` crate accessed through `wgpu_shim_*` exports (`native-rs/src/gpu/`) that flatten complex WebGPU descriptors into FFI-friendly functions — same ABI the old C shim exposed. The TypeScript wrapper (`src/gpu/wgpu-wrapper.ts`) implements the standard WebGPU JS API (`GPU`, `GPUAdapter`, `GPUDevice`, `GPUQueue`, etc.) on top of the FFI calls. `installGPU()` sets `globalThis.navigator.gpu` so the engine's `GPUDeviceManager` works unchanged.
- **Window**: `winit` for window creation, input polling, and surface handles (`native-rs/src/window/`, exported as `sdl_shim_*` for ABI compat). The `NativeWindow` class runs the event loop, translates events to DOM-compatible events, and provides `requestAnimationFrame`. `NativeSurface` implements the `HTMLCanvasElement` / `GPUCanvasContext` interface. After each rAF dispatch the window auto-presents via `queueMicrotask` (DOM end-of-frame semantics), so bespoke render loops that never call `context.present()` still present — `present()` itself skips frames that acquired nothing or acquired-but-never-wrote (`__ddWritten`).
- **Image decoding**: the `image` crate (`native-rs/src/image.rs`, `image_shim_*` exports) replaces `createImageBitmap`. `installImagePolyfills()` sets `globalThis.createImageBitmap`, `ImageBitmap`, `OffscreenCanvas`, and `ImageData`.
- **WGSL validation**: `dd_wgsl_validate` runs naga (wgpu's own frontend + validator) in-process for build-time shader checks — used by `wgslValidatePlugin` and `bun-preload.ts`. No external tint binary.
- **Asset discovery**: `nativeGlob()` replaces `import.meta.glob` with filesystem-based globbing.
- **Screenshot**: `captureScreenshot()` copies a render target to a buffer, reads back pixels, and encodes a PNG (acceptance mechanism for native rendering).
- **Native host**: `createNativeHost()` ties everything together — installs all polyfills, creates the window, gets the GPU device, configures the surface, starts the event loop, and provides DOM polyfills (`document`, `window`).

### Key files

- `packages/platform-native/native-rs/` — the unified `downdraft_platform` cdylib: `src/gpu/` (wgpu), `src/window/` (winit), `src/image.rs` (image), `src/text.rs` (cosmic-text), `src/gpu/validate.rs` (naga WGSL validation)
- `packages/platform-native/src/ffi/ffi-adapter.ts` — cross-runtime FFI (Bun `bun:ffi`, Node `koffi`, Deno `Deno.dlopen`)
- `packages/platform-native/src/ffi/lib-paths.ts` — unified native library resolution (env override → native/ → native/lib/ → native/<platform>-<arch>/ → /usr/local/lib)
- `packages/platform-native/src/gpu/wgpu-ffi.ts` — FFI bindings to the wgpu_shim_* exports (lazy dlopen)
- `packages/platform-native/src/gpu/native-wgsl.ts` — `validateWgslNative()` — in-process naga WGSL validation
- `packages/platform-native/src/gpu/wgpu-wrapper.ts` — re-export barrel for the wrapper modules
- `packages/platform-native/src/gpu/enums.ts` — WebGPU enum/string mappings (single source of truth)
- `packages/platform-native/src/gpu/limits.ts` — WGPULimits/features query + serialization
- `packages/platform-native/src/gpu/registry.ts` — FinalizationRegistry-based native handle cleanup
- `packages/platform-native/src/gpu/wgpu-device.ts` — WgpuGPU / WgpuAdapter / WgpuDevice / WgpuQueue
- `packages/platform-native/src/gpu/wgpu-resources.ts` — buffers, textures, views, samplers, shaders, layouts, bind groups, pipelines, query sets
- `packages/platform-native/src/gpu/wgpu-encoder.ts` — command encoder + render/compute pass encoders
- `packages/platform-native/src/gpu/install.ts` — installs navigator.gpu
- `packages/platform-native/src/dom/mini-event-target.ts` — shared EventTarget-compatible listener store
- `packages/platform-native/src/dom/dom-polyfills.ts` — document/window/Worker/storage polyfills
- `packages/platform-native/src/window/sdl-ffi.ts` — FFI bindings to the sdl_shim_* exports (lazy dlopen)
- `packages/platform-native/src/window/native-window.ts` — NativeWindow + event loop + rAF
- `packages/platform-native/src/window/native-surface.ts` — NativeSurface (HTMLCanvasElement)
- `packages/platform-native/src/image/native-image.ts` — createImageBitmap polyfill + Image polyfill
- `packages/platform-native/src/image/native-canvas2d.ts` — NativeCanvas2D (glyph atlas + parseColor)
- `packages/platform-native/src/image/native-freetype.ts` — text rasterizer bindings (cosmic-text in the Rust lib)
- `packages/platform-native/src/assets/native-assets.ts` — import.meta.glob replacement
- `packages/platform-native/src/screenshot/screenshot.ts` — PNG screenshot capture + `paddedReadbackToRGBA`
- `packages/platform-native/src/native-host.ts` — createNativeHost (main entry point)

### Native binaries (prebuilt, no consumer-side toolchain)

Native binaries are **not committed** and consumers never compile them:

- **npm channel**: `@downdraft/native-<platform>-<arch>` optional dependencies of `@downdraft/platform-native` carry the prebuilt cdylibs under `lib/`.
- **GitHub-release channel**: `bun run fetch:native` (postinstall fallback) downloads `downdraft-native-<platform>-<arch>.tar.gz` from the `native-v<version>` release and unpacks into each crate's staging dir.
- **Local dev**: `bun run build:native` (root) builds the Cargo workspace via `scripts/build-native.mjs` — the only native toolchain needed is `cargo` (pinned by `rust-toolchain.toml`).
- CI: `.github/workflows/native.yml` builds the per-platform matrix and uploads bundles to the release; `publish.yml` repacks them into the npm platform packages via `scripts/stage-native-packages.mjs`.

`lib-paths.ts` resolves libraries via env override → crate `dist/` → `native/` → `native/<platform>-<arch>/` → workspace `target/` → `@downdraft/native-*` package → `<exe>/native/` → `/usr/local/lib`.

### Runtime detection

`packages/engine/core/src/platform/runtime.ts` provides `isBun`, `isBrowser`, `isDevMode`, `getHostCapabilities()`, and `getNativeHost()` for feature-detecting the runtime. Engine code should use these instead of `import.meta.env.DEV` or `typeof navigator !== "undefined"`.

`packages/engine/core/src/platform/render-surface.ts` defines `RenderSurface` — the host-neutral render target (WebGPU context, dims, event target, pointer-lock). `GameRenderer`/`GameContext`/`startGame` use it; `NativeSurface` and `HTMLCanvasElement` both satisfy it. DOM helpers (`getCanvas`/`getOverlay`/`captureCanvasThumbnail`/`compositeScreenshot`) live in `app/src/renderer/compat/dom.ts` and are deprecated.

**Shared GPU device across workers** (`@downdraft/platform-native` `gpu/shared-device.ts`): wgpu handles are process-global — a worker can attach to the host device via `shareDevice(device, cells)` + `attachSharedDevice(handle, cells)` (non-owning view; worker `destroy()` never releases the native device). Liveness propagates through a SAB cell — owner `pollLost`/`destroy()`/`markDeviceLost` all write it dead; workers must check `isValid()` before FFI calls (calling into a freed device is a UAF). Hand resources/command buffers to the owner by ptr (`submitCommandPtrs`, `importCommandBuffer`; `{ptr, invalid}` refs keep validation errors out of submission) — once posted, the worker must not dispose or drop the wrapper (GC would free the shared handle). Use for coarse subsystems (terrain bake, UI raster) — fine-grained per-pass splits lose to submission overhead.

### Bun preload

`packages/engine/core/src/platform/bun-preload.ts` registers Bun plugin loaders for `?raw` and `?url` import suffixes, plus CSS imports. Configured in root `bunfig.toml`.

### Current status — native is the only runtime; Electron is deleted

`draft dev`/`draft test`/`draft release` run native only — all Electron-era flags and entrypoints are removed. Games boot from `src/native-entry.ts` (`runNativeGameModule`/`startNativeGame`/`createNativeHost`); the Electron main/preload/vite/mobile trees, `electron-osr`, `raw-input`, `core/ipc.ts`, and the electron-builder pipeline are deleted. OSR (devtools/web overlays) is `modules/native-osr` — in-process WebGPU, no webviews.

Native runs on three JS runtimes — **Bun** (default, `bun:ffi`), **Node+tsx** (`koffi`, `wgsl-loader.mjs`), **Deno** (`Deno.dlopen`, root `deno.json` + `--allow-all --unstable-sloppy-imports`). Steady-state perf is identical across runtimes (GPU + fixed-dt sim don't depend on the JS runtime); differences are boot time (~0.5–1.0s Bun, ~1.0s Node/Deno) and footprint (~520MB Bun / ~1.05GB Node / ~690MB Deno RSS on mining-rpg). Packaging spike: `scripts/package-native.mjs` compiles a game's native entry into a standalone Bun binary (verified end-to-end on mining-rpg — workers, saves, MCP, screenshots all work in the packaged binary).

Cross-runtime gotchas: tsconfig `paths` and `deno.json` alias `xxh3-ts` → a `.d.ts`, and tsx/Deno honor it at runtime — `hash-utils.ts` requires `xxh3-ts/index.js` (deep path) in its fallback to bypass the alias. Shared `game-module.ts` files must not import `.css` (Deno has no loader hooks) — keep CSS in the browser-only `main.tsx`. `node:module` imports must be lazy dynamic imports in shared code (browser bundles).

## Native PixiUI (`@downdraft/engine/libraries/pixi-ui-native`)

In-process PixiJS v8 WebGPU UI renderer for native (Bun + winit + wgpu) mode. Reuses the browser `@pixi/react` scene (e.g. `OceanApp`) in-process on native. PixiJS runs on the main thread on the **same `GPUDevice`** as the game, rendering into a texture-backed virtual canvas; the game composites that texture over the 3D frame each render pass via a fullscreen blit. No CPU readback in the compositing path.

### Architecture

- **`NativePixiUiHost`** (`packages/engine/libraries/pixi-ui-native/src/host.ts`): creates a `PIXI.Application` against a `VirtualCanvas` (not the swapchain) with `gpu: { adapter, device }` so PixiJS reuses the game's device. `autoStart: false` — the game drives `host.render()` each frame before encoding its blit pass. `backgroundAlpha: 0` so the 3D scene shows through transparent UI areas.
- **Virtual canvas + WebGPU context** (`packages/platform-native/src/gpu/virtual-canvas-context.ts`): a `VirtualCanvas` backs a `GPUTexture` (not the swapchain). `getUiTextureView()` returns the texture view the game samples in its compositing blit pass.
- **UI blit pass** (`packages/engine/libraries/pixi-ui-native/src/ui-blit-pass.ts`): a fullscreen triangle shader that samples the UI texture and blends it over the frame's color attachment with `loadOp: "load"` (preserves the 3D frame).
- **Compositing hook** (`WebGPURenderer.renderOneFrame`): after the 3D scene + postfx, calls `nativePixiUi.render()` (submits PixiJS's encoder to the shared queue), then `blitPass.execute(encoder, frameView, uiView)`. The write is ordered before the read on the shared queue.
- **Native data bridge** (`games/<game>/src/pixi/native-data-bridge.ts`): reads `SimBufferReader` + `useGameStore` each frame and calls `setWorkerState()` directly (the same reactive store `@pixi/react` components consume via `useWorkerState`). Routes UI actions back to the game store / `simBridge`. Replaces the browser worker/SAB/postMessage path with in-process store updates.
- **Native scene factory** (`games/<game>/src/pixi/native-scene.tsx`): `createNativeOceanScene(ctx)` calls `createPixiReactRoot(ctx)` (the same adapter the browser worker uses) and renders the real `OceanApp` React tree. `update()` is a no-op — React re-renders automatically via `useWorkerState` when the bridge calls `setWorkerState`. `getOpaqueRegions()` mirrors the browser scene's logic so the 3D renderer can skip work behind opaque panels.
- **Native input router** (`games/<game>/src/pixi/native-input-router.ts`): intercepts native mouse events on the canvas in **capture phase** (before the game's input handler). When a menu/overlay is open, hit-tests against PixiJS's `rootBoundary.hitTest(x, y)`; if the hit succeeds, dispatches a synthetic pointer event to `EventSystem._onPointerDown/Move/Up` (same approach as the browser pixi-ui worker) and stops propagation. Misses pass through to the game.

### Critical native WebGPU fixes (required for PixiJS)

- **`WgpuBuffer` write-mapped semantics** (`packages/platform-native/src/gpu/wgpu-resources.ts`): `getMappedRange()` returns a persistent JS backing store for `mappedAtCreation` write maps; `unmap()` flushes it to the native buffer via `queue.writeBuffer` (after unmap, since wgpu rejects writes while mapped). Without this, PixiJS's `fastCopy(data, getMappedRange())` + `unmap()` pattern wrote into a throwaway `ArrayBuffer` and all geometry drew nothing.
- **`copyExternalImageToTexture`** (`packages/platform-native/src/gpu/wgpu-device.ts`): reads canvas RGBA pixels via `getContext("2d").getImageData()` and uploads with `queue.writeTexture` (256-byte row alignment for WebGPU's `bytesPerRow`). Handles `bgra8unorm` textures. Without this, text/image textures never uploaded.
- **`parseColor`** (`packages/platform-native/src/image/native-canvas2d.ts`): handles named colors (`"white"`, `"black"`, etc.), 8-digit hex (`#rrggbbaa`), and 3-digit hex. Without this, PixiJS's `fillStyle: "white"` fell through to the black fallback and text rendered black.

### Key files

- `packages/engine/libraries/pixi-ui-native/src/host.ts` — `NativePixiUiHost`
- `packages/engine/libraries/pixi-ui-native/src/ui-blit-pass.ts` — fullscreen blit pass
- `packages/engine/libraries/pixi-ui-native/src/shaders/ui-blit.wgsl.ts` — blit shader
- `packages/platform-native/src/gpu/virtual-canvas-context.ts` — texture-backed canvas
- `packages/platform-native/src/gpu/wgpu-resources.ts` — `WgpuBuffer` mapped-write semantics
- `packages/platform-native/src/gpu/wgpu-device.ts` — `copyExternalImageToTexture`
- `packages/platform-native/src/image/native-canvas2d.ts` — `NativeCanvas2D` (FreeType text + `parseColor`)
- `games/to-the-ocean/src/native-entry.ts` — native wiring (host + scene + bridge + input router)
- `games/to-the-ocean/src/pixi/native-data-bridge.ts` — `NativeOceanDataBridge`
- `games/to-the-ocean/src/pixi/native-scene.tsx` — `createNativeOceanScene` (reuses `OceanApp`)
- `games/to-the-ocean/src/pixi/native-input-router.ts` — `NativeInputRouter`

## Native DevTools (`@downdraft/engine/libraries/devtools`)

A native in-game debugger overlay that replaces Chrome DevTools for the native build. The UI is a **Rust egui crate** (`packages/engine/libraries/devtools/native/`) driven over FFI by a TypeScript mirror — egui does layout + tessellation on CPU, serializes PaintJobs into a flat buffer, `EguiRenderer` uploads it to a wgpu texture, and `UiBlitPass` composites it over the game frame. Toggled with F12; F11 captures a screenshot.

### Architecture

- **`NativeDebuggerHost`** (`src/host.ts`): owns the egui state handle + `EguiRenderer`, routes native pointer/key/text input into egui via FFI, and composites the overlay after the game UI blit.
- **`DevtoolsMirror`** (`src/mirror.ts`): pushes engine data into Rust (console entries, scene tree, GPU info, metrics, threads, generic snapshots), polls Rust for eval requests / UI commands / refresh flags each frame, and dispatches them to registered handlers.
- **`egui-ffi.ts`**: FFI symbol declarations + buffer encoders (scene tree, DOM tree, GPU info, metrics, threads, generic `encodeSnapshot`, eval request decode).
- **Rust side** (`native/src/`): `state.rs` (PanelId, console/metrics/scene state, `GenericSnapshot`), `lib.rs` (FFI surface, input → `egui::RawInput`, dock UI + nav rail + status bar, snapshot/command decoders), `panels/` (one module per panel; `generic.rs` renders provider-fed snapshots; `input.rs` is a bespoke panel mixing the egui input mirror with provider data).
- **`CdpBridge`** (`src/cdp-bridge.ts`): `node:inspector` Session for console capture, exception events, and CPU profiling (the Recorder panel's flame chart).

### Panels (16)

Console, Scene (PIXI tree), GPU, Recorder (CDP profile + flame chart), Metrics (per-thread ProfilingSAB), ECS/DOM tree, Sim, Memory (RSS/VRAM + force-GC), Render Graph (frame-graph slots + pass timings, shows "timestamps unsupported" when the GPU timer pool is unavailable), Materials (MaterialLibrary or ModelRenderer bindless occupancy), Doctor (cross-thread module report), Workers (SAB slots + eval targets + cached sim manifest), Input (live egui input mirror), PostFX (28 effect toggles + params via the command channel), Assets (models/textures/buffers + missing-asset warnings), Game (provider-fed KV: vitals, world state, boats, weather).

### Generic snapshot + command protocol

Provider panels share one binary format: `registerProvider(panel, collect)` returns a `PanelSnapshot` (status byte + sections of key/value rows, tables, f32 series, lines, and controls — buttons/checkboxes/sliders). `encodeSnapshot()` serializes it; `dd_devtools_set_snapshot` pushes it per panel slot. Rust renders controls and queues `{panel, action, payload}` commands; the mirror polls `dd_devtools_take_command` each frame and dispatches to `handleEngineCommand` in `native-entry.ts` (fx.* → `PostProcessStack.setEnabled`, param.* → effect params, gc → force GC, sim.* → sim worker commands). Sync providers push snapshots immediately; async collectors never block the UI frame.

Game-specific data uses the `game` panel slot — register via `registerEngineProviders(ctx)` in `src/native-providers.ts` plus a game provider in `native-entry.ts`.

### Running the native entry (tri-runtime)

```bash
# Bun (primary)
bun run src/native-entry.ts

# Node (tsx + wgsl/?raw loader)
NODE_OPTIONS="--import ../../packages/platform-native/src/ffi/wgsl-loader.mjs" \
  ../../node_modules/.bin/tsx src/native-entry.ts

# Deno (root deno.json import map mirrors tsconfig paths; sloppy imports for
# extensionless/dir imports; requires --allow-all for FFI+workers+fs)
deno run --config ../../deno.json --allow-all --unstable-sloppy-imports src/native-entry.ts
```

`deno.json` at the repo root is a generated import map mirroring `tsconfig.web.json` `paths` (`foo/*` → `dir/*` trailing-slash form, required for `@`-scoped aliases). Regenerate with `bun run gen:deno-import-map` whenever tsconfig paths change (CI checks it stays in sync). Known Deno limitations: `@pixi/react` scene setup fails (npm `react-reconciler/constants` subpath), and basis-universal `?url` wasm imports are resolved lazily with a disk fallback.

Verified tri-runtime (mining-rpg native, ~20s steady state): all three boot the full stack — GPU via FFI (bun:ffi/koffi/Deno.dlopen), nested workers, MCP, saves, screenshots. Bench: bun boot ~0.5–1.0s RSS ~520MB; node+tsx boot ~1.0s RSS ~1.05GB; deno boot ~1.0s RSS ~690MB; sim runs at its fixed 60t/s on all three (runtime choice doesn't move steady-state perf — work is GPU/native + fixed-dt sim).

Cross-runtime landmines to keep in mind:
- **tsconfig `paths` are type-only, but tsx and Deno honor them at runtime.** The `"xxh3-ts"` alias maps to a `.d.ts` — under tsx/Deno `import "xxh3-ts"` loads the declaration file as an empty module. Runtime workarounds must use a subpath the alias doesn't cover (e.g. `require("xxh3-ts/index.js")`), never a bare specifier.
- **CSS imports must stay out of shared modules** — `game-module.ts` runs on native where `.css` can't load (Deno has no loader hooks at all). Keep `import "./x.css"` in browser-only `main.tsx` entries.
- **JSON imports need `with { type: "json" }`** for Deno (supported by Node ≥20, Vite, Bun, browsers).
- **Node has no global `Worker`** — dom-polyfills wraps worker_threads on the main thread and `ffi/worker-bootstrap.mjs` re-installs the same wrapper inside workers for nested spawns.
- **`__ddRequestFrame` prefers a renderer's own `renderOneFrame()`** over the inherited `GameRenderer.renderOnce()` — renderers that draw outside the GameRenderer frame graph (tto) would otherwise acquire-but-not-write the surface texture and starve the capture hook via the write-tracking present-skip.

### wgpu validation notes

The Rust shim validates every `WGPUTextureFormat`/`WGPURenderPipelineDescriptor` enum value before calling into wgpu and returns NULL with an error log instead of aborting; remaining hardening: (2) `wgpu-device.ts` counts only non-null vertex-buffer slots (sparse `buffers` arrays desynced the flat-descriptor walk); (3) bind groups created with `hasDynamicOffset` layouts must be bound with a dynamic-offsets array (`setBindGroup(i, bg, [0])` — the shim plumbs them; the old "no dynamic offsets" comment was stale); (4) `PostProcessStack` takes a `sceneFormat` option — games whose scene pipelines target the surface format pass it (the default `rgba16float` requires HDR scene pipelines).

### Environment variables for verification

- `SCREENSHOT_FRAME=N`: auto-capture a screenshot at frame N (default 600).
- `AUTO_EXIT=1`: exit after the auto-screenshot.
- `DEBUGGER_AUTO_SHOW=1`: auto-show the debugger for the verification screenshot.
- `DEBUGGER_PANEL=<name>`: select a panel for the screenshot (`console scene gpu perf-recorder perf-metrics dom-tree sim memory render-graph materials doctor workers input postfx assets game`).
- `DEBUGGER_TEST=1`: run the interaction suite (nav-rail clicks on all 16 panels, postfx command round-trip, wheel scroll, REPL eval) at the screenshot frame.
- `SKIP_OCEAN_SCENE=1`: skip the real OceanApp scene (for isolated blit testing).

### Key files

- `packages/engine/libraries/devtools/src/host.ts` — `NativeDebuggerHost` + `DebuggerSceneShim`
- `packages/engine/libraries/devtools/src/mirror.ts` — `DevtoolsMirror` (data push, eval/command dispatch, provider registry)
- `packages/engine/libraries/devtools/src/egui-ffi.ts` — FFI decls + encoders
- `packages/engine/libraries/devtools/src/native-providers.ts` — engine-generic panel providers
- `packages/engine/libraries/devtools/src/cdp-bridge.ts` — `CdpBridge`
- `packages/engine/libraries/devtools/native/src/` — Rust egui crate (`cargo build --release`, output `dist/libdowndraft_devtools.so`)
