# Downdraft Engine — Agent Notes

## Repository layout: games are separate repos

Games are **not part of this repository** — each game is a standalone repo that consumes engine packages via `@downdraft/*` semver deps (`^0.1.0`), resolving to npm in a standalone checkout. For local development, clone game repos anywhere; by convention they live under `games/` inside this repo (the whole `games/` dir is gitignored — it exists only as a local workspace). The `draft` CLI resolves `games/<name>` when present and otherwise walks up from cwd for `downdraft.config.json` / `src/native-entry.ts`. After `bun install`, run `bun run link:games` to symlink `@downdraft/*` packages into each game's `node_modules` (it also adds a `node_modules/.bin/draft` shim per game) — this replaces what workspace membership used to provide. Each game runs its own `bun install` for non-engine deps. CI never touches games — engine CI is self-contained.

References to `games/<name>/...` throughout this document refer to those local clones; nothing under `games/` is tracked here.

`apps/` holds in-repo applications that are not games — currently `apps/devtools` (a private shim launching `@downdraft/platinum-devtools`; the publishable surface package lives at `packages/platinum-devtools` — `draft devtools` launches the standalone multi-target viewer, `mountPlatinumDevtools(ctx, { overlay: true })` embeds it as an F12-toggled in-game overlay). `packages/platform-native/src/dev/devtools-agent.mjs` is the devtools agent asset injected by `draft dev --devtools-agent`; see `docs/site/src/content/docs/architecture/devtools.md`.

`@downdraft/*` packages are published to npm (`node scripts/publish-packages.mjs` / the `publish.yml` workflow). First-time setup (clone → `bun install` → prebuilt native fetch → `link:games`) is documented for humans in `development.md`.

## Releasing: root package.json is the version source of truth

All publishable `@downdraft/*` packages share one version, driven by the **root `package.json`**. `scripts/bump-version.mjs` (`bun run bump:version`, supports `--to=X.Y.Z` / `--dry-run`) syncs every `packages/*/package.json` version and rewrites inter-package `@downdraft/*` dep ranges to `^<version>` — always run `bun install` afterwards to refresh `bun.lock` (publish installs with `--frozen-lockfile`). `standard-version` (e.g. the `bunminor` shell alias) only bumps the root; `.versionrc`'s `postcommit` hook runs the sync + amend automatically, so the tag lands on a lockstep tree. `publish.yml` verifies `v<tag>` == root version and fails the release on drift — if it fails, run the bump, commit, and move the tag. Pushing the tag drives the whole pipeline: `plan` checks the `native-v<version>` / `node-mobile-v<node>-<rev>` artifact releases, calls the build workflows if incomplete, then publishes (prerelease versions publish under the `next` dist-tag).


## Runtime status: native is the active runtime

DownDraft runs on a **native runtime** — winit + wgpu via `@downdraft/platform-native` (a single Rust cdylib, `libdowndraft_platform`). **The JS runtime is interchangeable: Bun (default), Node+tsx, and Deno are all supported hosts** (`draft dev --runtime bun|node|deno`, default auto-detect; FFI adapts via `ffi-adapter.ts`, capabilities via `platform/runtime.ts`). Bun is only the repo's package manager / test runner / packaging compiler — never assume `Bun.*`, `bun:ffi`, or `bun:test` in game/engine runtime code.

A game boots from `src/native-entry.ts` → `runNativeGameModule(...)`. There is no Electron, no Chromium, no browser-facing Vite dev server (the dev shell embeds Vite only as a transform/HMR engine — see `docs/adr/0002-vite-dev-shell.md`). The simulation runs in a dedicated worker thread over SharedArrayBuffer — that isolation is deliberate and preserved on native.

**Removed stacks — do not resurrect:** Electron (`core/ipc.ts`, `electron-osr`, `raw-input`), Capacitor (`mobile-shell`), the pixi/imui UI stacks. See `docs/adr/0001-native-runtime.md` and `CHANGELOG.md`.

Native ABI is versioned: every cdylib exports `dd_abi_version`, checked at load — bump it on incompatible FFI changes. Native FFI exports use the `dd_*` prefix (`dd_window_*` windowing, `dd_hotkey_*` input, `wgpu_shim_*` GPU).

Game detection: a directory is a game when it has `downdraft.config.json` or `src/native-entry.ts`.

## GPU adapter policy — auto hardware/software selection

The host's adapter/device acquisition goes through `packages/platform-native/src/gpu/adapter-policy.ts` + `adapter-boot.ts` — never call raw `gpu.requestAdapter()` for an app boot (specs may; the raw path is unguarded). Policy precedence: `downdraft.config.json` `"gpu"` block < env (`DOWNDRAFT_GPU` = `swiftshader`|`hardware`|`auto`, `DOWNDRAFT_GPU_MODE` = `performance`|`stability`, `DOWNDRAFT_GPU_BACKEND`, `DOWNDRAFT_GPU_FALLBACK`, `DOWNDRAFT_GPU_DENY`) < persisted crash latch. The app's coarse knob is `"gpu": { "mode": … }`: `"performance"` (games) = hardware-only, fails rather than degrading; `"stability"` (desktop apps) = the graceful chain vulkan → gl/virgl (`glFallback` — a second wgpu instance on the GLES backend; the winner repoints `navigator.gpu`/`__wgpuInstancePtr` and `window.recreateGpuSurface` rebinds the instance-scoped surface) → software. Defaults are `adapter:auto` + `softwareFallback:true` — apps get reliable software rendering for free; games set `"gpu": { "mode": "performance" }` (or granular fields — they override the preset they sit beside) in `downdraft.config.json`. A built-in denylist (`venus`, `gfxstream` — drivers that `abort()` inside `requestDevice`) rejects adapters after info query but before device creation. Boot deaths are tracked by a `<userData>/gpu/hardware-boot.pending` sentinel: armed before the hardware attempt, disarmed on first presented frame or clean exit; a stale sentinel next boot counts a crash, and `CRASH_LATCH_THRESHOLD` consecutive deaths latch `latchedAdapter:"software"` in `gpu-state.json` until an explicit hardware choice or a proven-healthy hardware boot clears it. `DOWNDRAFT_GPU_BACKEND=gl` (virgl/GLES) presents on Wayland but is experimental — the event loop's display handle is bound for EGL, surface usages clamp to caps, `viewFormats` are dropped (gamma shift), `captureScreenshot` is unavailable (no `COPY_SRC`), and feature coverage is narrower than Vulkan.

## Where the docs live

This file is agent rules + commands only. Architecture and design decisions moved to the docs:

- `docs/site/src/content/docs/architecture/` — process model, SAB, render pipeline, module system, native platform, android port, engine internals, plugins, profiling, devtools, gaussian splats
- `docs/site/src/content/docs/reference/testing.md` — MCP automation harness, e2e specs, env vars, gotchas
- `docs/adr/` — architecture decision records (native runtime, Vite dev shell, tri-runtime host)
- `CHANGELOG.md` — removals/renames history

## Per-game storage isolation (rule)

Each game MUST pass a unique `appId` (`downdraft-<game>`) — it resolves the per-game `userData` dir (saves, import cache, singleton lock, window identity). Details: `docs/site/src/content/docs/architecture/engine-internals.md`.

## Shared engine APIs — use these, don't hand-roll

Before writing per-game infrastructure, check whether the engine already provides it. The canonical APIs:

| Concern | Engine API | Location |
|---|---|---|
| Renderer-owned sim worker | `GameModule.simFromRenderer: (r) => r.getWorkerHost()` — never write a no-op `GameSimWorker` adapter | `@downdraft/engine/app/main` |
| Game store base | `createBaseGameStoreState(set, get)` — spread into the game's zustand store (fps, paused, panels, notifications, title screen). **Import `createStore` from `zustand/vanilla`** — the `"zustand"` entry eagerly imports `react`, which is not installed | `@downdraft/engine` |
| Sim worker entry | `createSimWorker({ fixedDt, onInit, onTick, ... })` — tick loop, speed, step, stats, SAB-polyfill sync | `@downdraft/engine` |
| Deterministic RNG in sim | `ctx.rng` in `onTick(dt, ctx)` (mulberry32, seeded via `createSimWorker({ seed })` / `control.setSeed()`). In deterministic mode `Math.random` is trapped to the same seeded stream — sim code should use `ctx.rng`, never `Math.random`/`Date.now` IDs | `@downdraft/engine` |
| Worker host (main side) | `SimWorkerHost<TApi>` / `BaseWorkerHost<TApi>` — pause/resume/step/setSpeed/getStats + input writing | `@downdraft/engine` |
| GPU in a worker | `nativeHost.gpuShare.payload()` (one broker cells set per device — never call `shareDevice` per consumer) + worker-side `attachSharedDevice` / `borrowGpuTexture` / `borrowGpuBuffer` (non-owning) / `createGpuWorkerContext` (conventional attach/detach prelude). Ordered worker passes: `postPass` → `GpuPassMailbox` → drained by `GameRenderer` into `"preSubmit"`/`"preUi"` submit batches. Never call `installGPU`/`requestDevice` on a worker | `@downdraft/platform-native` |
| DOM input | `createDomInputHandler({ canvas, preset, ... })` — keyMap, mouse buttons, canvas coords, MCP `injectInput` | `@downdraft/engine` |
| Save system | `createGameSaveSystem` / `createGridSaveSystem` + `createDefaultSaveStore` | `@downdraft/engine`, `@downdraft/engine/app/main` |
| Autosave interval | `AutosaveManager({ save, shouldSave, intervalMs, deterministic })` | `@downdraft/engine/libraries/persistence` |
| MCP automation tools | `createStandardAutomationTools(ctx)` + `createMcpHarness` — the standard tool set (see `docs/site/src/content/docs/reference/testing.md`); game tools via `extraTools`; semantic state read/write via `inspectables: InspectableRegistry` (enables `inspectable_list/get/set` — nodes' `set()` must route through the game's apply pipeline, never raw field writes). `characterCustomizationNodes()` emits `player.customization.*` nodes | `@downdraft/engine/app/main`, `@downdraft/engine/libraries/inspectable` |
| DevTools | `initDevTools(renderer, {...})` + `createSimStatsProvider`/`createSimStatsPanelExtension` | `@downdraft/engine/modules/devtools` |
| Sand simulation | `SandWorld`, `SandStepPool`, `SandLib`, palette/materials | `@downdraft/engine/libraries/sand` |
| Game UI | `createHtmlUi({ build })` renderer module over `modules/html-ui` (Blitz HTML/CSS docs rasterized in a UI worker, composited as panel quads) — **canonical game-UI system**. On native the ui worker uploads frames GPU-direct through the shared device (SAB path is the automatic fallback); `gpuUpload: false`/`DOWNDRAFT_NO_UI_GPU=1` forces SAB | `@downdraft/engine/modules/html-ui` |

**UI direction:** the framework bakeoff (`test-beds/ui-bakeoff` — Blitz vs Canvas2D stacks) settled on **Blitz** for game UI. `modules/html-ui` (worker-backed Blitz HTML/CSS documents with a JSX authoring layer) is the canonical game-UI system; native devtools/OSR panels are already Blitz-backed. All games render their game UI through html-ui. The pixi stack (`libraries/pixi-ui`, `libraries/pixi-ui-native`, `libraries/profiler`, the pixi asset-browser scene, `examples/pixi-ui-demo`) has been **deleted** — `UiBlitPass` (the generic UI-texture compositor) moved to `libraries/blitz-ui`. `core/imui` and the imui-based telemetry overlays have been **deleted**; the generic `UIInputRouter` input-gating contract lives on as `core/input/ui-router.ts`. New games and all new UI work target html-ui.

**Game UI pattern:** a game mounts its UI as a renderer module. Each panel is a Blitz HTML/CSS document rasterized in a dedicated UI worker (layout + vello raster off the main thread); the host owns per-panel WebGPU textures with dirty-rect partial uploads, composited at the end of `GameRenderer`'s frame. Input routes through the input bus — rect/z-ordered panels, `:hover`/`:active`/DOM focus inside the doc, keyboard claimed only while an editable element holds focus. Controller/keyboard spatial navigation (focus zones, on-screen keyboard, virtual cursor) is auto-wired from `html-ui-kit` + `GamepadLib` unless `nav: false`.

```tsx
/** @jsxImportSource @downdraft/engine/modules/html-ui */

renderer.useRendererModule(createHtmlUi({
  build(ui) {
    const hud = ui.mount(
      <div class="hud"><span id="hp">HP</span><button data-action="pause">Pause</button></div>,
      { id: "hud", rect: { x: 8, y: 8, w: 220, h: 60 } },
    );

    // Push-style: store subscription → selector-scoped doc mutations
    ui.bind(store, (s) => s.health, (v) => hud.setText("#hp", `HP ${v}`));
    // Actions: data-action attributes → host-side handlers (no bridge protocol)
    ui.onAction("pause", () => sim.setSpeed(0));
    // Poll-style: per-frame sync (SAB scalars, positions, visibility)
    ui.onUpdate(() => { hud.setStyle("#boss", "display", bossVisible ? "flex" : "none"); });
  },
}));
```

`UiPanelHandle` mutations are selector-scoped (`setText`/`setAttr`/`setStyle`/`setInnerHtml`/`setHtml`/`setRect`/`focus`/`click`/`scrollIntoView`/`mutate(ops)`) so HUD ticks don't reparse the document. Fullscreen panels should mount with `fit` (`fit: true` or `fit: { debounceMs }`) — the host tracks the surface rect (buffer px) + live zoom itself; hand-rolled `onResize → setRect(cssDims)` breaks on display-scale crossings (the quad stops covering the surface — black border bottom/right). Browser-style app zoom is opt-in via `createHtmlUi({ zoomKeys: true | { step, min, max, initial } })` — Ctrl+= / Ctrl+- / Ctrl+0 drive a shared UI-zoom multiplier (`ui.uiZoom`/`ui.setUiZoom` for programmatic control). `ui.isPointerOverUI()` gates canvas input for paint-style games; `ui.loadResource`/`fontFaceCss` register fonts/images for `ui://` URLs. Widget/theme/nav helpers live in `@downdraft/engine/libraries/html-ui-kit` (components like `button`/`slider`/`dropdown`/`tabs`/`toast`, `kitStyleTag()`/`KIT_CSS`, `UiNavRouter`/`NavController`/`openOsk`/`VirtualCursor`, ten-foot widgets); the low-level FFI surface is `@downdraft/engine/libraries/blitz-ui` (`native-osr-ffi`).

html-ui code: `packages/engine/modules/html-ui/src/` (`create-html-ui.ts` = `createHtmlUi`/`HtmlUiTok`; `host.ts` = `HtmlUiHost`/`UiPanelHandle`/input routing; `ui-worker.ts`+`doc-backend.ts`+`protocol.ts` = worker doc host; `jsx-runtime.ts` = `jsxImportSource`), `packages/engine/libraries/html-ui-kit/` (widgets/theme/nav), `packages/engine/libraries/blitz-ui/` (Blitz/vello cdylib FFI, `native-osr-ffi`).

The legacy imui UI stack (`core/imui`, `createGameUi`, the imui telemetry overlays, `UICompositePass`) has been deleted — in-game profiling/debug views are served by the devtools host (F12) and html-ui panels instead.

## Process management & debugging games

### Killing game processes — never use generic `pkill bun`/`pkill node`/`pkill deno`

**NEVER run `pkill -9 bun`, `pkill -f bun`, `killall bun`, `pkill -f tsx`, `pkill deno`, or any other generic runtime-killing command.** The user's machine runs other Bun/Node/Deno processes; a generic pkill terminates all of them, destroying the user's work and possibly your own session.

Each game runs as a **single JS-runtime process** (Bun by default, or Node+tsx/Deno via `--runtime`; plus worker threads) and holds a single-instance lock (`singleton.lock` in the game's userData dir) — re-running `draft dev` handles stale instances. To kill a specific game instance, target **that game only**:

- **Let `draft dev` handle it** — re-running `draft dev` from the game directory tears down the previous instance automatically. This is the preferred path.
- **Match the per-game `--user-data-dir`** (each game sets a unique `downdraft-<game>` userData dir, visible in the process args) only if you need to kill a process you did not launch via `draft dev`:
  ```bash
  # Kill only the my-game game process and its children
  for pid in $(pgrep -f "user-data-dir=[^ ]*downdraft-my-game" 2>/dev/null); do
    kill -TERM "$pid" 2>/dev/null
  done
  ```
- **Match the MCP port** if you know which port the game's MCP HTTP transport is bound to (ephemeral by default, including under `draft test`):
  ```bash
  # Read the port from the PID file: ~/.downdraft/port/<pid>
  ls ~/.downdraft/port/ && cat ~/.downdraft/port/*  # shows PID(s) → port(s)
  fuser -k <port>/tcp   # kills whatever is bound to that port
  ```

Prefer `kill -TERM` first (lets the game release the singleton lock and flush saves); only escalate to `kill -9` if the process doesn't exit within a few seconds. If you launched the game yourself (via `draft dev`, `draft test`, or the e2e harness), prefer terminating the parent shell/process you spawned rather than hunting for the `bun` child.

### Debugging games — do NOT use a browser / Playwright

**Do NOT use a browser (Chrome, Playwright, `browser_preview`, the `devin/mcp-playwright` MCP server, or any other web browser tool) to debug or drive Downdraft games.** The games are native winit + wgpu apps — there is no browser or DOM to attach to. They rely on:

- The winit window/input path and wgpu device — there is no DOM, no DevTools protocol, and no remote-debugging port.
- `globalThis.downdraft` bridge APIs installed by the native bridge, which only exist inside the game process.
- Worker threads + SharedArrayBuffer sim isolation.

A plain browser cannot reproduce any of this, and Playwright driving a browser will not exercise the real game code paths. The `devin/mcp-playwright` MCP server is for general web pages, **not** for Downdraft games.

**Instead, use the in-game MCP automation harness and `draft test`:**

1. **`bun run draft:test-cpu`** (or `bun run draft:test`) — the canonical way to launch and exercise a game headlessly. `draft test` sets `DOWNDRAFT_DETERMINISTIC=1` and spawns `bun test <spec>`; the default smoke specs use the in-game MCP RPC harness to boot the real game and drive it. The only runtime is **native**. See `docs/site/src/content/docs/reference/testing.md` for the full CLI flag reference.
2. **The `game` MCP server** (register `bun packages/cli/src/index.ts mcp stdio` in an MCP client config — e.g. `.devin/mcp_config.json` — `bun packages/cli/src/index.ts mcp stdio` — a stdio→HTTP bridge inside `draft mcp`) — once a game is running, this exposes the game's automation tools directly to your MCP client. The bridge auto-discovers the running instance via PID files in `~/.downdraft/port/<pid>` (content = the bound port). **List the tools first with `mcp_list_tools` before calling any of them** — never guess tool names or argument schemas. Games build their tool surface on `createStandardAutomationTools()` (`packages/engine/app/src/main/standard-automation-tools.ts`) plus game-specific extras; the standard set is `capture_screenshot`, `inject_input`, `clear_injected_input`, `dispatch_key`, `dispatch_click`, `wait_for_condition`, `set_test_state`, `get_player_state`, `get_world_state`, `get_ui_state`, `inspectable_list`, `inspectable_get`, `inspectable_set`.
3. **Console error capture** — the e2e harness (`tests/e2e/harness.ts`) captures the game process's stdout/stderr and exposes `game.getConsoleErrors()`. When debugging, grep the captured log for `Uncaught|TypeError|ReferenceError|WrongDocumentError|is not a function|is not defined` (see `reference/testing.md`).

The typical debug loop is:
```bash
# 1. Launch the game with deterministic mode (MCP port is auto-assigned)
cd games/my-game && DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 draft dev &
# 2. Call game MCP tools (inject_input, get_player_state, capture_screenshot, ...)
#    to drive the game and inspect state. The bridge auto-discovers the port.
# 3. When done, kill ONLY this game instance (see "Killing game processes" above).
```

## Module registration patterns

`moduleHost.registerModule(m)` registers + activates one module; `moduleHost.useModules([...])` (preferred — wraps `registerModuleDeferred` + `activateAll`) batch-activates in topological order over each module's `dependencies: string[]` (and validates `requires`/`provides`). To wrap a library factory as a module, use `createXxxModule(opts): Module` — `opts` encapsulates all config and dependencies.

## Verification commands

- `bun run tsc` — `tsc -p tsconfig.web.json --noEmit && tsc -p tsconfig.node.json --noEmit`. `bun run tsc:e2e` type-checks e2e specs.
- `bun run lint` — `oxlint` on the whole repo; many pre-existing `no-console`/`no-unused-vars` warnings.
- **Full suite** (what CI runs): `bun test --isolate --conditions=downdraft-source --path-ignore-patterns "**/node-mobile/build/**" packages/`. The flags matter: `--isolate` gives each spec a fresh global (shared module/GC state corrupts the rapier WASM instance — validated-api.spec.ts traps mid-step); `--conditions=downdraft-source` resolves `@downdraft/*` self-imports to `src/` since `dist/` doesn't exist until `build:dist` runs.
- **Unit specs** are colocated `*.spec.ts` next to source (`packages/engine/**`, `examples/plugin-tester/src/`, some `games/*/modules/`). Plain `bun test <file-or-dir>` works for specs that don't self-import the package; add the two flags above when they do.
- **E2E smoke**: `bun run draft:test` (hardware GPU) / `bun run draft:test-cpu` (SwiftShader — CI default), `bun run draft:test -- --headed` (visible window), `bun run draft:test -- --game <name>` (per-game spec under `tests/e2e/`). `bun run test:e2e` bypasses the CLI.
- House rule `downdraft/no-for-of` (error): `for..of` is banned except where it's the required iteration structure — a call result (`Object.entries()`, `map.entries()`, generators, ...) or `for await..of`. Use `.forEach()` or an indexed `for` loop otherwise. The rule lives in `packages/engine/lint-plugin.mjs` (oxlint JS plugin, resolved as `@downdraft/engine/lint-plugin` from every `.oxlintrc.json` — root + each game).

## Docs site (`docs/site`)

Astro Starlight site (`bun run build` / `bun run dev` inside `docs/site`); sidebar entries are hand-listed in `docs/site/astro.config.mjs`. The `guides/visual-debugging` page is a symptom→fix atlas whose screenshots are generated by `examples/artifact-atlas/render.ts` — a standalone `createNativeHost` + raw-wgpu harness (no GameModule) that deliberately induces each artifact and captures it via `captureScreenshot` (synchronous; note `host.captureScreenshot` uses the *requested* window size — read the actual texture extent, the surface can come up smaller). Regenerate with `bun examples/artifact-atlas/render.ts [artifact]`.
