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

