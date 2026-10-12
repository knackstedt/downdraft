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
| `wpe` | WebKit (embedded) | linux, android | `wpe-fdo` SHM exportable backend; the only real-browser option on Android |
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
- **WPE (linux)**: `scripts/fetch-wpe.mjs` downloads the Debian trixie
  package closure (`libwpewebkit-2.0`, `libwpe`, `wpebackend-fdo`,
  GLib/soup/GStreamer + transitive deps, the WPEWebProcess/WPENetworkProcess
  libexec set, headers) into `vendor/wpe-linux-x64/` — minutes, not a
  WebKit source build. The trixie libs need only GLIBC ≤ 2.38 (noble has
  2.39), so they run natively on the dev host.
- **WPE (android)**: wpe-android Maven artifacts — Phase 5
  (`scripts/fetch-wpe-android.mjs`) plus dex/service manifest glue in
  `package-mobile.mjs`.

### Running WPE locally — `scripts/run-wpe.sh`

Debian's `libWPEWebKit` spawns `WPEWebProcess` / `WPENetworkProcess` /
`WPEGPUProcess` from a path baked in at build time
(`/usr/lib/x86_64-linux-gnu/wpe-webkit-2.0`), and no
`WEBKIT_EXEC_PATH`-style override exists. `scripts/run-wpe.sh` wraps any
command in a user+mount namespace (`unshare -rm --propagation private`)
with read-only **overlay** mounts merging the staged `libexec/` and
`share/` trees over the system dirs — nothing is created on the host:

```sh
scripts/run-wpe.sh <wpe-dist-dir> <command...>
# e.g.
packages/engine/libraries/webui/scripts/run-wpe.sh \
  packages/engine/libraries/webui/native-wpe/dist/linux-x64 \
  bun packages/engine/libraries/webui/webui-spike.ts wpe
```

Two env knobs matter (both set by the launcher / `global_init`):
`WPE_BACKEND_LIBRARY` names the wpe-loader impl lib
(`libWPEBackend-fdo-1.0.so` — the default `libWPEBackend-default.so`
doesn't exist), and `LD_LIBRARY_PATH` must cover the vendored `lib/` for
the spawned subprocesses (our cdylib itself resolves via an
old-style `DT_RPATH` `$ORIGIN/lib`, which the loader applies
transitively — that's why no patchelf pass is needed).

Rendering is `wpe_view_backend_exportable_fdo` in SHM mode
(`wpe_fdo_initialize_shm`): the WebProcess hands out `wl_shm_buffer`s
which we copy into the shared frame buffer, release, and frame-complete.
Frames arrive whole-surface (WPE does no partial damage at this layer),
so `frameRect()` reports full-view rects.

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
  scripts/         fetch-cef.mjs, fetch-wpe.mjs, run-wpe.sh
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
--target=android --webui=wpe` + adb. `test-android/` packages a
NativeActivity harness running the same 18-check battery
(`WEBUI-TEST ALL PASS — 18/18` in logcat).

Android frame delivery has two paths, selected automatically: when the
host app's winit window is up, each committed `AHardwareBuffer` is posted
into an `ASurfaceControl` layer via `ASurfaceTransaction` with real
SurfaceFlinger acquire/release fences (the same pacing contract the
vendor's `WKWebView` uses — `frameComplete` on transaction completion,
`releaseBuffer` on release-fence signal); the activity's `ANativeWindow`
is reached through `dd_android_activity_window` in
`libdowndraft_android.so`. Without a window (headless harness), frames
fall back to a direct `AHardwareBuffer_lock` + `pullFrame` copy, which is
fully reliable for offscreen use. A per-view ~60 Hz GLib tick also
dispatches `frame_displayed` so the WebProcess's display-refresh monitor
keeps scheduling repaints in unfocused/offscreen views.
