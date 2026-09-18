# Batteries-Included Engine — Cross-Game Abstraction Tracker

**Created:** 2026-09-15

Tracks work to eliminate cross-game duplication: adopt existing-but-unadopted
engine APIs, extract near-verbatim duplicates into engine packages, flesh out
stub modules, and build `core/imui` into the canonical game-UI system that
replaces the per-game PixiJS stacks.

## Status legend

- `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` skipped/won't-do

---

## Phase 1 — Adopt existing engine APIs (non-UI)

| # | Item | Status |
|---|---|---|
| 1.1 | `simFromRenderer` for mining-rpg / overburden / sandjongg; delete `MiningGameSim`, `BlockheadsGameSim`, `SandjonggGameSim` | [x] |
| 1.2 | `createBaseGameStoreState` in mining-rpg / overburden / sandjongg / andrews-sandbox stores | [x] |
| 1.3 | `createStandardAutomationTools` in overburden / sandjongg / to-the-ocean MCP setups (factory extended: async `getWorldState`, `playerIndex: undefined`, `fullPageDefault`; overburden keeps custom inject_input/dispatch_click — plain-state input model) | [x] |
| 1.4 | `SimWorkerHost` adoption for the 2D worker hosts (mining, backdrop, blockheads, grid-builder, sandjongg); evaluate falling-sand multi-worker | [x] — backdrop + grid-builder stay on `BaseWorkerHost` (task workers, no control api) |
| 1.5 | `createDomInputHandler` for mining-rpg / overburden input handlers (shared handler also gained `onMouseUp` hook + injected-frame release-on-expiry). Sandjongg skipped — pointer-event pan/capture semantics the mouse-event handler doesn't cover | [x] |
| 1.6 | `AutosaveManager` `shouldSave` + in-flight guard; migrate sandjongg autosave interval | [x] |
| 1.7 | mat4 audit — `perspectiveMat4Into`/`lookAtMat4Into`/`invertMat4Into`/`transformMat4Vec4` added to core; overburden `matrix.ts` keeps only picking helpers; electron-osr input-router dup deleted | [x] |

Deliberately skipped (superseded by Phase 5 — code gets deleted, not migrated):

- `createPixiUiBridge` adoption in mining-rpg / overburden / sandjongg / tto / andrews-sandbox
- `createWorkerStore` adoption (game `worker-store.ts` copies are deleted by the imui port)
- `react-font-scale` adoption (font-scale-context.ts copies deleted by the imui port)

## Phase 2 — Shared sim/worker harness

| # | Item | Status |
|---|---|---|
| 2.1 | `createSimBridge` generalized into `@downdraft/engine/app/renderer` (from tto `sim-bridge.ts`); tto keeps a thin game-verb facade | [x] |
| 2.2 | Entity-sim worker host base for tto + andrews-sandbox (`sim-web-worker.ts` shared skeleton) — `EntitySimWorkerHost` in `core/worker`; `SimWorkerHost` constraint loosened to `WorkerApi` | [x] |
| 2.3 | `installSimHotReload` + `restoreHotReloadState` in `@downdraft/engine/app/renderer` (tto HMR block: sim/renderer reload + preserve-state save + sessionStorage restore) | [x] |
| 2.4 | `wireProfilingBridge` + `attachProfilerOverlay` in module-devtools (tto + sandjongg) | [x] |
| 2.5 | `bindDebugStore(renderer, bindings)` in module-devtools for tto debug-store subscriptions | [x] |
| 2.6 | `TaskPool` + `createTaskWorker` (transferables) + `PortChannel` in `core/worker`; terrain-mesh-pool + pathfinding-broker migrated (grid-builder/backdrop already on BaseWorkerHost) | [x] |
| 2.7 | `collectPluginManifests`/`discoverPlugins`/`pluginBaseUrlLookup` + `createAssetRegistryBridge` + noop registries in `core/plugin`; andrews-sandbox migrated | [x] |

## Phase 3 — Shared render passes + 2D kit

| # | Item | Status |
|---|---|---|
| 3.1 | Configurable `SandGridPass` → `@downdraft/engine/libraries/sand/render` (layers/reflections, camera, light inputs); migrate falling-sand, mining-rpg, sandjongg | [x] |
| 3.2 | `StickmanPass` → `@downdraft/engine/libraries/stickman`; migrate falling-sand + mining-rpg (overburden's is a different 3D-box pass — renamed `BlockheadBoxPass`) | [x] |
| 3.3 | `PanZoomCamera2D` (overburden `camera.ts` generalized onto `core/render/camera-2d.ts`; mining-rpg already on shared `Camera2D`) | [x] |
| 3.4 | `SabCanvasOverlay` → `core/render` (DOM canvas + seq-gated bitmap repaint); overburden `MapCanvas` migrated | [x] |

## Phase 4 — Gameplay modules

| # | Item | Status |
|---|---|---|
| 4.1 | `module-movement-3d` real impl — `CharacterMotor3D` (heading-relative WASD, run/fly, swim, jump+gravity, turn-to-face); tto + andrews-sandbox migrated. Pose table stays game-side | [x] |
| 4.2 | `module-movement-2d` real impl — `createGridCharacterController` (AABB-vs-grid, sub-steps, step-up, swim, climb, noclip, fall damage, bury/crush, hazards); falling-sand + mining-rpg migrated. overburden blockhead keeps extended monkey-movement (wall-climb/mantle/crawl) — follow-up | [x] |
| 4.3 | `module-vitals` — `Vitals` class (damage clamp+overkill, delayed regen, death/respawn, condition-gated meters with depletion damage, event callbacks, serialize/restore) bound to a plain host state field. andrews-sandbox + mining-rpg migrated (movement-2d gained an `applyDamage` sink so controller damage routes through it). overburden/tto candidates noted | [x] |
| 4.4 | `library-pathfinding-2d` — `createAStarGrid` generic weighted multi-goal A* (heap, visited arrays, per-call wrap, `gradeMove` + `expandExtra` hooks, `findPathToAdjacent`); overburden grid-movement is now a thin adapter (blockhead predicates + move grading stay game-side) | [x] |
| 4.5 | `library-character` — `createCharacterModelLoader` (external textures, accessory-mesh filter, animation merging), `LocomotionAnimator` (Idle/Walk/Run hysteresis + air/override states), `CharacterAnimator` (skin-matrix pipeline), `CharacterPreview`; andrews-sandbox files are now shims; tto `SkeletonAnimator` migrated (Run→Walk hysteresis tightened to runExit) | [x] |

## Phase 5 — imui as the game-UI system

Direction: **no React UI kits.** Game UI targets `core/imui` (WebGPU retained
UI — UIRoot/UIRenderer/LayoutEngine/UIInputRouter + widgets). Escalation path
if imui is incapable: the egui snapshot protocol used by native devtools.

| # | Item | Status |
|---|---|---|
| 5.1 | Gap audit complete (see below). Key finding: `GameRenderer` already mounts the full imui stack (UIRenderer+UIRoot+LayoutEngine+UIInputRouter) for all 6 games — the missing layer is a mount/binding API, not a renderer. Game pixi UIs use only `Container`/`Graphics`/`Text`/`Sprite`, so they map onto existing imui primitives | [x] |
| 5.2 | Build out imui — done: `pointerThrough` hit-transparent containers, `UIInputRouter.isPointerOverUI`/`getPointerPos`, char-input routing (`handleCharInput` plumbed InputManager→router→focused element; `UITextInput` keydown wiring), `UIToastStack`, `setUIFontScale`, `controls.ts` composite kit (`uiButton`/`uiButtonActive`/`uiPanel`/`uiText`/`uiSliderRow`/`uiSegmented`/`uiCheckbox`/`uiSetEnabled`), window-level UI event routing (stacked sibling canvases), `UIText` `maxWidth` wrapping, `wrapText` `\n` support. Still open (needed during ports, add as encountered): tooltips, dropdowns, drag-drop inventory grid, minimap blit (UIImage covers static textures) | [x] |
| 5.3 | `createGameUi(opts): RendererModule` — mounts a full-screen pointerThrough container under `ctx.getUIRoot()`, `build(ui)` once, `onUpdate` per-frame sync at `afterViewports`, `ui.bind(store, selector, apply)` zustand-style bindings, `find(name)`, resize tracking, dispose cleanup; `GameUiTok` DI token. `RendererModuleContext` gained `getUIRoot`/`getUIInputRouter`/`invalidateUILayout` | [x] |
| 5.4 | Port game UIs ascending complexity — **falling-sand done** (`src/ui/game-ui.ts` `createGameUi` module; `pixi-scene.ts`/`bridge-protocol.ts` deleted; `library-pixi-ui`+`pixi.js` deps + `pixi-ui-canvas` layer removed; painting gated on `isPointerOverUI`). **sandjongg done** (`src/ui/game-ui.ts` — HUD/pause/toolbar/toast/level-cleared/main-menu/pause/help/settings/debug panel; store gained `showSettings`/`toggleSettings`; `game-module.tsx` pixi host + stats loop + action bridge deleted; tile canvas hidden while modals open since it stacks above imui). Engine fixes landed during the port: UI input routing moved to window/document level (stacked sibling canvases), `UIText` now emits `maxWidth` for wrapping, `wrapText` honors `\n`, `GameUiContext.onDispose` added. Remaining: overburden → mining-rpg → andrews-sandbox → to-the-ocean | [~] |
| 5.5 | Sunset game-facing pixi-ui (library stays for plugins/compat + pixi-ui-native) | [ ] |

### P5.1 audit findings

- **All 6 game renderers extend `GameRenderer`**, which already creates `UIRenderer`/`UIRoot`/`LayoutEngine`/`UIInputRouter` and draws UI over the final viewport each frame. Games mount UI by registering `createGameUi({ build })` as a renderer module — no per-game render/UI plumbing needed.
- **Game pixi UIs use only `Container`, `Graphics`, `Text`, `Sprite`** — maps to `UIPanel`/`UILine`/`UIText`/`UIImage`. Widget coverage: buttons/toggles/sliders/tabs/modals/scroll/text-input/progress already exist; `UIToastStack` covers the 3 notification-stack copies; `pointerThrough` + `isPointerOverUI()` replace pixi-ui's interactive-region reporting.
- **Store model**: pixi scenes consumed `UiStatsSAB` scalars + postMessage events via `worker-store`. In imui the game reads its store directly — `ui.bind(store, sel, apply)` for push, `ui.onUpdate` for per-frame poll (covers SAB-backed scalars).
- **Action model**: pixi scenes called `postAction` to reach the sim. In imui, `onClick` handlers call `ctx.sim`/`simSAB` directly — no bridge protocol needed.
- **Remaining per-port gaps** (add to imui as encountered): tooltips, dropdowns/select, drag-drop inventory grid, minimap texture blit (UIImage with a sim-updated GPUTexture), vignette/screen effects (full-screen `UIPanel` with opacity), screen shake (container offset in `onUpdate`).
- **Not carried over**: font-scale plumbing is `setUIFontScale(root, scale)`; pixi worker-side document stubs / EventSystem patches / bridge protocols get deleted wholesale.

## Phase 6 — Templates, docs, guardrails

| # | Item | Status |
|---|---|---|
| 6.1 | Update `packages/cli/templates/{minimal,physics,full}` to canonical wiring | [ ] |
| 6.2 | AGENTS.md "Shared APIs" section + pixi-ui legacy-for-games note | [ ] |

## Launch sweep — all games × {chrome, native} (2025-XX)

Every game now starts in both Electron (`draft dev`) and Bun-native
(`draft dev --native`) mode. Fixes landed during the sweep:

**Chrome mode**
- WGSL validator gained `// wgsl-validate: prelude <path>` + `// wgsl-validate: skip`
  pragmas for shaders composed at runtime (andrews-sandbox postfx, to-the-ocean
  entity/pbr/lighting pipelines). to-the-ocean's generated IBL chunk was baked to
  `ibl-bindings.wgsl` so leaf shaders validate against the runtime composition.
- `packages/engine/app/src/vite/index.ts` now auto-includes worker-side dependency
  subpaths (`pixi.js/events`) in the initial optimizeDeps pass — fixes stale
  `webworkerAll-*` chunk fetches after mid-run re-optimization.

**Native mode**
- Generic `startNativeGame()` helper in `@downdraft/platform-native` — covers
  GameRenderer-based games (falling-sand, sandjongg, overburden, mining-rpg,
  andrews-sandbox use thin `src/native-entry.ts` shims). Bespoke loops
  (downdraft-model-viewer, downdraft-gpu-bench) call `createNativeHost()` then import their
  `main.tsx`, which skips the React mount and reuses `__nativeHost.device`.
- DOM polyfills: `body.removeChild`, `style` stub on NativeSurface, `fetch()`
  handles `file://`, bare absolute paths, and `/@fs/` dev-server URLs.
- `NativeSurface.unconfigure()`/`resize()` destroy the outstanding surface
  texture before releasing — fixes the SwapchainAcquireSemaphore teardown panic.
- `wgpu-device` auto-layout parser handles `texture_depth_2d`,
  `texture_multisampled_2d`, depth sample types (was defaulting depth textures
  to uniform buffers → pipeline layout mismatch in andrews-sandbox).
- `bun-preload` CSS plugin short-circuits `.css` resolution (package-rooted css
  imports aren't in exports maps).
- `import.meta.glob` fallbacks: VTB tests/index.ts scans `*.test.ts` on the
  filesystem under Bun; andrews-sandbox player-models uses createGlob.
- `@sandbox/shared/*` alias added to root tsconfig for native resolution.

Nonfatal diagnostics kept (not startup failures): to-the-ocean first-tick
physics panic-recovery + slow-tick warmup, missing bed FBX warning.
