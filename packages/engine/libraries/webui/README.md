# `@downdraft/engine/libraries/webui` — heavyweight browser-backed UI tier

A real web engine behind the shared `dd_webui_*` C ABI, for game UI that
needs a full DOM, JavaScript, modern web APIs, and complex pages Blitz
can't render yet. **Blitz (`modules/html-ui`) remains the canonical
lightweight UI** — this tier is opt-in per view and ships as optional
native dependencies so games that don't use it pay nothing.

## Backends

| Backend | Engine | Targets | Notes |
|---|---|---|---|
| `cef` | Chromium (CEF) | linux, win32, darwin | Multiprocess; ships a `downdraft_cef_helper` subprocess binary + a ~300MB runtime tree |
| `wpe` | WebKit (embedded) | linux, android | WPEPlatform `buffer-rendered` path; the only real-browser option on Android |
| — | WKWebView | iOS | **Future target.** Overlay/airspace compositing only (no texture path), jitless-class JS performance — iOS forbids both subprocess renderers and JIT for third-party code |

One ABI, two cdylibs:

- `libdowndraft_webui_cef` — desktop Chromium via CEF windowless/OSR
- `libdowndraft_webui_wpe` — embedded WebKit via WPEPlatform headless

Both produce BGRA8 frames with dirty-rect tracking and expose the same
view lifecycle / input / JS-bridge / crash-status surface.

## Backend selection

Precedence (first match wins):

1. `createWebUi({ backend: "cef" | "wpe" })` — per-module explicit choice
2. `DD_WEBUI_BACKEND` env (`cef` | `wpe` | `none` | `auto`)
3. `webui.backend` in `downdraft.config.json` — `draft dev`/`draft release`
   read it and export `DD_WEBUI_BACKEND` into the spawned shell
4. `--webui=` CLI flag (same mechanism — forwarded into env / packagers)
5. Platform default — `cef` on desktop, `wpe` on android

`none` disables the tier entirely. On Linux both backends can be staged
side by side: `DD_WEBUI_BACKEND=wpe` (or `createWebUi({backend:"wpe"})`)
runs the WPE build against the same assertions as CEF — this is how the
Android path gets exercised on a dev box.

## ABI (`dd_webui_*`)

Implemented identically by both cdylibs; bound once in
`src/webui-ffi.ts` (`WEBUI_SPEC`).

- **Lifecycle**: `global_init(opts_json)` / `global_shutdown` /
  `create(opts_json, w, h, scale)` / `destroy`
- **Content**: `load_url` / `set_content` / `resize` / `navigate`
  (back/forward/reload/stop) / `set_zoom` / `set_focus` / `set_interactive`
- **JS bridge**: `eval(req_id, js)` → `{t:"eval"}` events;
  `post_message(json)` → `window.downdraft`; `poll_events` drains
  message/eval/console/cursor/status/nav events as a JSON array
- **Input**: `input_pointer` / `input_wheel` / `input_key` / `input_touch`
  / `input_ime` — view-local logical px, DOM button numbering
- **Frames**: `take_frame` (dirty-union u64 + pixel pull) / `frame_rect` /
  `pixels` / `dimensions` / `pixel_format` — plus the shared-memory
  channel `buf_needed` / `bind_frame_buf` / `frame_into` /
  `refresh_into` using the same 64-byte seqlock header + 256-aligned
  rows as `dd_osr_*`
- **Status**: `status` / `crash_count` / `recover` / `set_crash_policy`
  — both engines are multiprocess; renderer crashes map to
  crashed/recovering/failed
- **Hit test**: `hit_test(x, y)` — alpha-based inside the view rect

Packed frame rect `u64`: `x<<48 | y<<32 | w<<16 | h` (same encoding as
`dd_osr_frame_rect`).

## Page-side bridge contract

Each backend injects a small `window.downdraft` object into every view:

```ts
window.downdraft.postMessage(payload)     // → {t:"message"} host event
window.downdraft.onMessage((payload))     // ← host postMessage delivery
```

CEF implements it over `CefProcessMessage` (render-process helper +
V8 context bridge); WPE over `WebKitUserContentManager` script messages.
Console output surfaces as `{t:"console"}` events; `console.*` in the
page reaches `onConsole` subscribers on the host.

## Runtime staging

- **CEF**: `scripts/fetch-cef.mjs` downloads the pinned
  `cef_binary_*_minimal` distribution into `vendor/cef-<plat>/`
  (`Release/` + `Resources/` + `include/`). The pin must match the
  `cef` crate's expected version — see `native-cef/Cargo.toml`.
- **WPE (linux)**: `scripts/build-wpe.sh` builds WPEWebKit inside the
  WebKit SDK container (`ghcr.io/webkit/wkdev-sdk`) and stages a
  relocatable prefix into `vendor/wpe-<plat>/` — WPE is not packaged
  on Ubuntu.
- **WPE (android)**: wpe-android Maven artifacts — Phase 5
  (`scripts/fetch-wpe-android.mjs`) plus dex/service manifest glue in
  `package-mobile.mjs`.

`vendor/` is gitignored — runtimes are fetched per machine/CI.

## Crate layout

```
libraries/webui/
  native-common/   shared rlib — frame buf, dirty rect, event queue,
                   view registry, ViewCore, packed-rect encoding
  native-cef/      cdylib (CEF) + [[bin]] downdraft_cef_helper
  native-wpe/      cdylib (WPE) — linux + android targets
  src/             webui-ffi.ts (WebUIView, loadWebUiLib,
                   resolveWebUiBackend) + types.ts (WebUiHostBridge…)
  scripts/         fetch-cef.mjs, build-wpe.sh
  vendor/          fetched runtimes (gitignored)
  webui-spike.ts   identical assertion battery run against any backend
```

## Usage (renderer side)

```ts
import { createWebUi } from "@downdraft/engine/modules/webui";

createWebUi({
  backend: "cef",            // optional override
  build: (ui) => {
    if (!ui.available) return;
    ui.mount({
      rect: { x: 40, y: 40, w: 640, h: 480 },
      url: "https://…",      // or html: "<!doctype html>…"
      onMessage: (payload) => { /* page → host */ },
      onConsole: (lvl, text) => { /* console.* */ },
    }).then((view) => {
      view?.postMessage({ hello: true });
      view?.eval("1 + 1").then(console.log);
    });
  },
});
```

Panels composite screen-space via `PanelBlitPass` (same as Blitz
panels) at UI input priority. `isPointerOverUI()` tells the game when a
pointer is over an interactive view.

## Verification

`webui-spike.ts` runs the same assertion battery against any backend —
frames, dirty-rect cadence, eval round trip, console capture, resize,
hit test, destroy/recreate:

```sh
bun packages/engine/libraries/webui/webui-spike.ts        # cef
bun packages/engine/libraries/webui/webui-spike.ts wpe    # wpe
```

The Android path is validated on-device via `draft release
--target=android --webui=wpe` + adb.
