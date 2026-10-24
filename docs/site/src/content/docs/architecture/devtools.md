---
title: Native DevTools
description: Blitz-rendered in-process devtools overlay — wiring, architecture, panels, protocol
---

## Native DevTools (`@downdraft/engine/libraries/devtools` + `modules/devtools/blitz`)

A Chrome-DevTools-style dock that renders **inside the game window** via Blitz/html-ui — a `UiPanelHandle` doc mounted at high z-order over the game UI. The old Rust egui overlay is deleted; do not resurrect it. Toggled with F12 by default (`devtools.ui` object form accepts `toggleKey`, `dockFraction`, `autoShow`).

### Wiring

Games don't construct hosts by hand — `bootstrapGame`/`startGame` handle it. Set `devtools: { ui: "blitz" | "web" | "none" | {...} }` on `GameModule`/`BootstrapDevToolsOptions` (default `"blitz"`). `DOWNDRAFT_DISABLE_DEVTOOLS=1` forces `"none"`.

- **`"blitz"`** (default): `createDevtoolsUiModule()` mounts a `BlitzDevtoolsHost` as a renderer module. It reuses the game's `HtmlUiTok` host when present, else self-hosts an `HtmlUiHost` with a `ScreenUiCompositor` at `order: 1000` (compositors render ascending by `order`, so it draws above game overlays). The host lands in `renderer.nativeDebugger` and is provided via `BlitzDevtoolsTok`.
- **`"web"`**: `WebDevtoolsHost` serves the `devtools-web` SPA over loopback HTTP+WS (Bun-only transport, `Bun.serve`) and opens it in a system browser.
- **`"none"`**: data bridge only (`initDevTools` still exposes `window.__downdraftDevtools`).

## Platinum DevTools (`@downdraft/platinum-devtools`)

The platinum-devtools surface lives in the publishable package **`packages/platinum-devtools`** and runs in two modes that share one mount (`mountPlatinumDevtools` in `src/mount.ts`):

- **Standalone viewer** — `draft devtools` (works from any directory; also `draft dev` inside `apps/devtools`, now a thin private shim). A separate native app that attaches to **multiple** running targets from outside the game window. It installs a non-fatal `unhandledRejection` guard so a dying target's channel rejections can't take the viewer down.
- **Embedded overlay** — a game calls `mountPlatinumDevtools(ctx, { overlay: true })` from its `ui(ctx)` hook. The surface starts hidden; F12 (or `toggleKey`) toggles it. While hidden it owns no visible panels, swallows no input, and the lazy shell mount runs once on first show. It reuses the game's `HtmlUiTok` context when one is registered (only one `createHtmlUi` provider may exist per renderer); otherwise it mounts a private html-ui instance with `provideToken: false`. Under `draft dev` (`DOWNDRAFT_DEV=1`) it also self-injects `devtools-agent.mjs` — idempotent with `--devtools-agent` — so the game appears in its own target list alongside remote targets.

Each target gets a `TargetSession` (`src/targets/session.ts`) that multiplexes channels discovered via `~/.downdraft/platinum-agent/<pid>.json` + `~/.downdraft/devtools/<pid>.json` + procfs scan, with a reconnect pass for flaky targets and lost/reattach affordances in the sidebar:

- **Mirror WS** — a game's `WebDevtoolsMirror` (the `"web"` transport) is consumed headlessly: full provider/command surface, no browser needed. Note the mirror is hosted **by the web frontend** — `devtools.ui:"none"` games expose no mirror channel (CDP/feed/MCP still work); the web host binds no hotkey, so `ui:"web"` pairs cleanly with an embedded overlay owning F12.
- **CDP** — `node:inspector` WebSocket for eval/console/CPU profiles on any runtime that exposes it.
- **MCP HTTP** — the game's automation server (screenshots, input, inspectables).
- **Feed** — loopback HTTP ingest (`/feed`, bearer-token'd); the target-side agent posts console/network/metric/heap events keyed by `feedKey`.

### Agent injection

The target-side instrumentation lives in **`packages/platform-native/src/dev/devtools-agent.mjs`** — a plain `.mjs` asset (loadable untransformed by bun/node/deno) that opens the inspector, wraps `fetch`/`WebSocket`/`console`, samples heap stats, and serves jsc commands (`/snapshot`, `/profile/*`, `/gc`) on a loopback port. `draft dev --devtools-agent` sets `DD_DEVTOOLS_AGENT=1`; `dev-shell.mjs` imports it before the runner evaluates game code (the ModuleRunner shares the shell's `globalThis`, so wraps cover game modules). `DD_DEVTOOLS_AGENT=<path>` injects a custom module instead; `--no-hmr` falls back to `bun --preload`. Opt-in only — never injected into `draft release` output. Targets launched outside `draft` can `import "@downdraft/platform-native/dev/devtools-agent.mjs"` directly.

Key paths: `packages/platinum-devtools/src/mount.ts` (shared mount — embedded overlay + standalone), `src/standalone.ts` (viewer `GameModule`: 2d renderer, `devtools.ui:"none"`, rejection guard, viewer MCP), `src/targets/` (registry/discovery, session channels, feed-server, procfs, artifacts), `src/mcp/tools.ts` (viewer-side MCP: `target_*`, `console_eval`, `profile_*`, `heap_*`, `network_events`, `feed_info`), `packages/cli/src/devtools.ts` (`draft devtools`), `apps/devtools/` (private shim) + `apps/devtools/test-beds/dd-target` (embedded-overlay fixture — `ui:"web"` for the mirror + `mountPlatinumDevtools(ctx, { overlay: true })`).

### Architecture

- **`DevtoolsBackend`** (`libraries/devtools/src/backend.ts`): transport-neutral core — provider registry (`registerProvider(panel, collect)`), command dispatch, collectors, eval routing (`registerThreadEval`), event pushes. `WebDevtoolsMirror` (`web/mirror.ts`) is the JSON-RPC transport subclass; the Blitz host embeds a `DevtoolsBackend` directly and routes events to DOM updates.
- **`BlitzDevtoolsHost`** (`modules/devtools/src/blitz/host.ts`): owns the dock doc (tab strip, per-panel toolbar/body/bottom/status regions), tab switching, dock resize grip, F12 keybind (priority −30 on the input bus), and the `DtPanelCtx` panels render through (`call`, `setValue`, `scrollTo`, `getRect`).
- **Panels** (`blitz/panels/`): `console.ts` (log sink + severity/thread filters + REPL with history — main-thread eval goes through a direct `registerThreadEval` evaluator since runtimes may lack `Runtime.evaluate` over CDP), `elements.ts` (scene/DOM/ECS tree), `performance.ts` (per-thread metrics + CPU profile record), `gpu.ts` (frame times + adapter info), `snapshot.ts` (generic renderer for provider-fed snapshots: kv rows, tables, f32 series, lines, controls).
- **`CdpBridge`** (`libraries/devtools/src/cdp-bridge.ts`): `node:inspector` Session for console capture, exception events, and CPU profiling; degrades cleanly when no inspector exists.
- **Input routing**: `HtmlUiHost.bindInput()` routes pointer/key to the mounted doc; editable `<input>` elements receive text input when focused. Note a Blitz limitation — `hit_inner` does not clip scrolled-off children to the scrollport, so overflowing content can intercept clicks over sibling chrome; the dock works around it by DOM-ordering `#dt-body` before the fixed chrome inside a `display:grid` `#dt-chrome`.

### Panels

Fixed: Console, Elements, Performance, GPU. Provider-driven (registered via `registerEngineProviders` in `native-providers.ts`): Game, Sim, Memory, Render Graph, Materials, Doctor, Workers, Input, PostFX, Assets. Game-specific data registers on the `game` provider slot.

### Generic snapshot + command protocol

`registerProvider(panel, collect)` returns a `PanelSnapshot` (status + sections of key/value rows, tables, f32 series, lines, and controls — buttons/checkboxes/sliders). The backend pushes snapshots to the frontend; control clicks dispatch `{panel, action, payload}` commands back through `backend.dispatch` → `handleEngineCommand` (fx.* → `PostProcessStack.setEnabled`, param.* → effect params, gc → force GC, sim.* → sim worker commands). Sync providers push immediately; async collectors never block the UI frame.

Key paths: `modules/devtools/src/blitz/` (`module.ts` = `createDevtoolsUiModule`/`BlitzDevtoolsTok`, `host.ts` = `BlitzDevtoolsHost`, `theme.ts`, `panels/` = console/elements/performance/gpu/snapshot renderers) and `libraries/devtools/src/` (`backend.ts` = `DevtoolsBackend`, `web/` = `WebDevtoolsHost`/`WebDevtoolsMirror`/`DevToolsServer` Bun-only browser frontend, `native-providers.ts` = `registerEngineProviders`, `snapshot.ts` = wire types, `cdp-bridge.ts`).

