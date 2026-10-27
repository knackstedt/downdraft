---
title: Native DevTools
description: In-window devtools overlay + standalone viewer — wiring, architecture, panels, protocol
---

## DevTools (`@downdraft/devtools` + `@downdraft/engine/libraries/devtools`)

A Chrome-DevTools-style surface rendered **inside the app window** as a GPU overlay, or attached to running targets from a standalone viewer. The old Blitz dock (`modules/devtools/blitz`) and the `devtools-web` browser SPA are deleted — do not resurrect them. Toggled with F12 by default (`devtools.ui` object form accepts `toggleKey`, `autoShow`).

### Wiring

Apps don't construct hosts by hand — `bootstrapApp`/`startApp` handle it. Set `devtools: { ui: "devtools" | "none" | {...} }` on `AppModule`/`BootstrapDevToolsOptions` (default `"devtools"`). `DOWNDRAFT_DISABLE_DEVTOOLS=1` forces `"none"`. The legacy `"blitz"`/`"web"` kinds are accepted for compatibility and treated as `"devtools"` with a warning.

- **`"devtools"`** (default): bootstrap creates a headless **`EmbeddedDevtoolsHost`** (`libraries/devtools/src/embedded-host.ts` — owns `CdpBridge` + `DevtoolsBackend` + engine providers, lands in `renderer.nativeDebugger`, pumped via `beforeFrame`), then mounts the **`@downdraft/devtools` overlay** on F12 when the package is installed (optional peer — engine can't hard-depend on it; the specifier is dynamic-imported so apps without it still get the backend for remote viewers).
- **`"none"`**: wires nothing — no backend, no mirror, no overlay.

### The `@downdraft/devtools` package

The devtools surface lives in the publishable package **`packages/devtools`** and runs in two modes that share one mount (`mountDevtools` in `src/mount.ts`):

- **Standalone viewer** — `draft devtools` (works from any directory; also `draft dev` inside `apps/devtools`, a thin private shim). A separate native app that attaches to **multiple** running targets from outside the app window. It installs a non-fatal `unhandledRejection` guard so a dying target's channel rejections can't take the viewer down.
- **Embedded overlay** — mounted automatically by bootstrap on F12 (or `mountDevtools(ctx, { overlay: true })` by hand). The surface starts hidden; while hidden it owns no visible panels, swallows no input, and the lazy shell mount runs once on first show. It reuses the app's `HtmlUiTok` context when one is registered (only one `createHtmlUi` provider may exist per renderer); otherwise it mounts a private html-ui instance with `provideToken: false`. Under `draft dev` (`DOWNDRAFT_DEV=1`) it also self-injects `devtools-agent.mjs` — idempotent with `--devtools-agent` — so the app appears in its own target list alongside remote targets.

  **Self-targeting.** Embedded mounts opt the host pid into the target registry (`sessions.setSelfTarget`) — discovery normally skips `process.pid` since a standalone viewer inspecting itself is meaningless. The self session is preferred as the active target and gets a `self` badge in the sidebar. The mount additionally attaches a `DevToolsServer` to the host's `DevtoolsBackend` via `backend.attachRemote()` (`selfMirror`, default on) — the remote fan-out gives the overlay — and any external viewer — the full provider channel (gpu/sim/memory/render-graph pushes + `snapshot` pulls) over `~/.downdraft/devtools/<pid>.json`.

  **Input claim order.** Devtools surface handlers subscribe at input-bus priority −20 — ahead of html-ui's panel routing (−10) — so clicks/keys/scrolls on a devtools panel can't be claimed by an interactive app doc underneath it. Showing the overlay also exits pointer lock and suppresses `surface.requestPointerLock` while visible. App-side DOM listeners don't see bus-level `stopPropagation` — gates that act on raw DOM events (click→pointer-lock, wheel→zoom, keydown→hotkeys) should consult `inputBus.wasPointerDownConsumed()` / `wasWheelConsumed()` / `wasKeyDownConsumed()`.

Each target gets a `TargetSession` (`src/targets/session.ts`) that multiplexes channels discovered via `~/.downdraft/devtools-agent/<pid>.json` (legacy `platinum-agent/` still read) + `~/.downdraft/devtools/<pid>.json` + procfs scan, with a reconnect pass for flaky targets and lost/reattach affordances in the sidebar:

- **Mirror WS** — a target's `DevToolsServer`-fronted `DevtoolsBackend` (self-mirror or an external attach point), consumed headlessly: full provider/command surface, no browser needed.
- **CDP** — `node:inspector` WebSocket for eval/console/CPU profiles on any runtime that exposes it.
- **MCP HTTP** — the app's automation server (screenshots, input, inspectables).
- **Feed** — loopback HTTP ingest (`/feed`, bearer-token'd); the target-side agent posts console/network/metric/heap events keyed by `feedKey`.

### Text pipeline

Devtools surfaces rasterize through `ft_shim_*` (cosmic-text in `native-rs/src/text.rs`) — the same FFI `NativeCanvas2D.fillText` uses, so the bitmap contract below applies to **both** consumers:

- **Bitmap bounds**: `[0, ceil(advance)]` of the rasterized string, ink clipped to it. Overhangs (italic f, quotes) survive only because every raster is `" text "` — the space margin gives out-of-advance ink somewhere to land. The bitmap's left edge is `penX - padX` (`padX` = one space advance): **blit at `pen - padX`, never `pen`** — `ChunkBitmap.padX` / `RenderedRun.padX` carry it.
- **Baseline**: the shim doesn't export line metrics; the baseline row sits at ~0.87×size (measured, varies). Both consumers calibrate with an "H" bottom-ink probe (`RunCache.calibrate`, `ftBaseline`) — never assume `size * 1.0`.
- **Pixel snapping**: glyphs are already integer-placed inside the bitmap, so quad/blit origins must be whole pixels — fractional origins resample and smear every glyph. Pen advances stay fractional.
- **Atlas bleed**: `TextAtlas` packs each bitmap into a 1px zeroed gutter; linear sampling at quad edges pulls transparent pad texels, not neighbor ink.
- **Cold render**: a fresh `FontSystem` handle can return a 0-width first raster — `ft.face()` warms it and `calibrate` retries once. Don't remove the warmup.

Face keys are `family:weight:style` and must exist in `FACE_FILES` (`text/fonts.ts`) — `resolveWeight` constrains to weights that ship the requested style (only `jetbrains:400` has italic). The bundled TTFs live in `packages/devtools/src/assets/fonts/` (Inter + JetBrains Mono, SIL OFL).

### Agent injection

The target-side instrumentation lives in **`packages/platform-native/src/dev/devtools-agent.mjs`** — a plain `.mjs` asset (loadable untransformed by bun/node/deno) that opens the inspector, wraps `fetch`/`WebSocket`/`console`, samples heap stats, and serves jsc commands (`/snapshot`, `/profile/*`, `/gc`) on a loopback port. `draft dev --devtools-agent` sets `DD_DEVTOOLS_AGENT=1`; `dev-shell.mjs` imports it before the runner evaluates app code (the ModuleRunner shares the shell's `globalThis`, so wraps cover app modules). `DD_DEVTOOLS_AGENT=<path>` injects a custom module instead; `--no-hmr` falls back to `bun --preload`. Opt-in only — never injected into `draft release` output. Targets launched outside `draft` can `import "@downdraft/platform-native/dev/devtools-agent.mjs"` directly.

Key paths: `packages/devtools/src/mount.ts` (shared mount — embedded overlay + standalone), `src/standalone.ts` (viewer `AppModule`: 2d renderer, `devtools.ui:"none"`, rejection guard, viewer MCP), `src/targets/` (registry/discovery, session channels, feed-server, procfs, artifacts), `src/mcp/tools.ts` (viewer-side MCP: `target_*`, `console_eval`, `profile_*`, `heap_*`, `network_events`, `feed_info`), `packages/cli/src/devtools.ts` (`draft devtools`), `apps/devtools/` (private shim) + `apps/devtools/test-beds/dd-target` (embedded-overlay fixture).

### Architecture

- **`DevtoolsBackend`** (`libraries/devtools/src/backend.ts`): transport-neutral core — provider registry (`registerProvider(panel, collect)`), command dispatch, collectors, eval routing (`registerThreadEval`), event pushes. `WebDevtoolsMirror` (`web/mirror.ts`) is the JSON-RPC transport subclass; `DevToolsServer` (`web/server.ts`) fronts it over loopback HTTP+WS for remote viewers.
- **`EmbeddedDevtoolsHost`** (`libraries/devtools/src/embedded-host.ts`): headless host owning `DevtoolsBackend` + `CdpBridge` per app — created by bootstrap for every devtools-enabled app so providers/evals exist regardless of which frontend (overlay, remote viewer, or none) is attached.
- **`CdpBridge`** (`libraries/devtools/src/cdp-bridge.ts`): `node:inspector` Session for console capture, exception events, and CPU profiling; degrades cleanly when no inspector exists.
- **Overlay UI** (`packages/devtools/src/`): GPU-rendered chrome (html-ui docs) + surfaces (console, profiler, targets sidebar). The profiler consumes the same ProfilingSAB/CDP data the engine publishes.

### The `modules/debug` engine module

`@downdraft/engine/modules/debug` is the **data/backend side** the devtools consume — scene inspector, `initDevTools`, `ProfilingBridge`/`wireProfilingBridge`, worker-side `exposeDevToolsApi`/`attachDevToolsSAB`/`devtools` singleton, transform/grid/skeleton debug renderers, `useDebugStore`/`useSceneStore`. It renders no UI of its own.

### Generic snapshot + command protocol

`registerProvider(panel, collect)` returns a `PanelSnapshot` (status + sections of key/value rows, tables, f32 series, lines, and controls — buttons/checkboxes/sliders). The backend pushes snapshots to the frontend; control clicks dispatch `{panel, action, payload}` commands back through `backend.dispatch` → `handleEngineCommand` (fx.* → `PostProcessStack.setEnabled`, param.* → effect params, gc → force GC, sim.* → sim worker commands). Sync providers push immediately; async collectors never block the UI frame.

Key paths: `libraries/devtools/src/` (`backend.ts` = `DevtoolsBackend`, `embedded-host.ts` = `EmbeddedDevtoolsHost`, `web/` = `WebDevtoolsMirror`/`DevToolsServer` transport, `native-providers.ts` = `registerEngineProviders`, `snapshot.ts` = wire types, `cdp-bridge.ts`) and `modules/debug/src/` (data bridge, profiling bridge/hooks, worker expose, debug renderers).
