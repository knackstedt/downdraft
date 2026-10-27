---
title: Native Platform
description: platform-native package — cdylib layout, prebuilt binaries, runtime detection, tri-runtime notes
---

## Native platform (`@downdraft/platform-native`)

A native platform layer providing direct GPU rendering via a single Rust cdylib (`libdowndraft_platform`, crate at `native-rs/`), accessed over runtime-adapted FFI (`bun:ffi` under Bun, `koffi` under Node, `Deno.dlopen` under Deno — see `ffi/ffi-adapter.ts`). Located in `packages/platform-native/`.

### Architecture

- **GPU**: the `wgpu` crate accessed through `wgpu_shim_*` exports (`native-rs/src/gpu/`) that flatten complex WebGPU descriptors into FFI-friendly functions — same ABI the old C shim exposed. The TypeScript wrapper (`src/gpu/wgpu-wrapper.ts`) implements the standard WebGPU JS API (`GPU`, `GPUAdapter`, `GPUDevice`, `GPUQueue`, etc.) on top of the FFI calls. `installGPU()` sets `globalThis.navigator.gpu` so the engine's `GPUDeviceManager` works unchanged.
- **Window**: `winit` for window creation, input polling, and surface handles (`native-rs/src/window/`, exported as `dd_window_*` for ABI compat). The `NativeWindow` class runs the event loop, translates events to DOM-compatible events, and provides `requestAnimationFrame`. `NativeSurface` implements the `RenderSurface` contract (`core/platform/render-surface.ts`) plus a `GPUCanvasContext`-shaped `getContext("webgpu")`. After each rAF dispatch the window auto-presents via `queueMicrotask` (DOM end-of-frame semantics), so bespoke render loops that never call `context.present()` still present — `present()` itself skips frames that acquired nothing or acquired-but-never-wrote (`__ddWritten` — flipped at `queue.submit()`, not at encode time, via `WgpuCommandBuffer.writeTargets`, so a dropped/invalid/abandoned buffer can't mark a texture written). **Frame retention trap**: dirty-skip renderers (my-app) rely on skipped frames never acquiring the swapchain. Any engine/module code that calls `context.getCurrentTexture()` unconditionally per-frame (an auto-clear, a UI composite/blit) fabricates a frame and presents it over black — use `context.peekCurrentTexture()` instead to join a frame that already exists; viewportCount=0 + dirty-skip apps must pass `clearColor: null` so AppRenderer's auto-clear doesn't acquire either.
- **Image decoding**: the `image` crate (`native-rs/src/image.rs`, `image_shim_*` exports) replaces `createImageBitmap`. `installImagePolyfills()` sets `globalThis.createImageBitmap`, `ImageBitmap`, `OffscreenCanvas`, and `ImageData`.
- **WGSL validation**: `dd_wgsl_validate` runs naga (wgpu's own frontend + validator) in-process for build-time shader checks — used by `wgslValidatePlugin` and `bun-preload.ts`. No external tint binary.
- **Asset discovery**: `nativeGlob()` replaces `import.meta.glob` with filesystem-based globbing.
- **Screenshot**: `captureScreenshot()` copies a render target to a buffer, reads back pixels, and encodes a PNG (acceptance mechanism for native rendering).
- **Native host**: `createNativeHost()` ties everything together — installs all polyfills, creates the window, gets the GPU device, configures the surface, starts the event loop, and installs the browser-global shims (`window`, storage, `Worker`, UI-event constructors, blob/fetch). There is **no** `document` global — `RenderSurface` is the surface abstraction.

Layout: Rust cdylib at `packages/platform-native/native-rs/` (`src/gpu/` wgpu, `src/window/` winit, `src/image.rs`, `src/text.rs` cosmic-text, `src/gpu/validate.rs` naga). TS side at `packages/platform-native/src/` — `ffi/` (ffi-adapter.ts, lib-paths.ts, worker-bootstrap.mjs, wgsl-loader.mjs), `gpu/` (wgpu-ffi/wrapper/device/resources/encoder/install, shared-device.ts, pass-channel.ts, native-wgsl.ts), `dom/` (dom-polyfills.ts, mini-event-target.ts), `window/` (window-ffi.ts, native-window.ts, native-surface.ts), `image/` (createImageBitmap/canvas2d/freetype), `assets/` (nativeGlob), `screenshot/`, `native-host.ts` (createNativeHost), `dev/` (dev-shell.mjs, native-dev-runtime.ts, vite-config.mjs), `bridge/` (user-data-dir.ts).

### Native binaries (prebuilt, no consumer-side toolchain)

Native binaries are **not committed** and consumers never compile them:

- **npm channel**: `@downdraft/native-<platform>-<arch>` optional dependencies of `@downdraft/platform-native` carry the prebuilt cdylibs under `lib/`.
- **GitHub-release channel**: `bun run fetch:native` inside `packages/platform-native` (it's a script on that package, also run by its `postinstall` — not a root script) downloads `downdraft-native-<platform>-<arch>.tar.gz` from the `native-v<version>` release and unpacks into each crate's staging dir.
- **Local dev**: `bun run build:native` (root) builds the Cargo workspace via `scripts/build-native.mjs` — the only native toolchain needed is `cargo` (pinned by `rust-toolchain.toml`).
- **Staging pitfall**: `build-native.mjs` passes `--target <host-triple>`, so artifacts land in `target/<triple>/<profile>/` — a bare `cargo build --release` (no `--target`) writes `target/release/` instead. Copying a `.so` into a crate `dist/` from the wrong dir silently stages a stale build (this once shipped an `libdowndraft_blitz_osr.so` missing `dd_osr_scroll_to` → blank windows). Prefer `bun run build:native`; if hand-staging, copy from `target/<triple>/release/`.
- **Vendored deps**: `vendor/arboard` is a patched arboard 3.6.1 (X11 serve path: replies to UTF-8 MIME-alias targets like `text/plain;charset=utf-8` that TARGETS advertises — upstream only answers the exact stored atom, so Qt/Klipper requesters got NONE and the clipboard stayed stale). Pinned via `[patch.crates-io]` in the root Cargo.toml — it affects every workspace crate that uses arboard (blitz-osr `FlagShell`, `dd_window_*_clipboard`). If bumping arboard later, check whether upstream fixed `handle_selection_request` and drop the vendor dir.
- **Debug native builds**: `build-native.mjs --debug` stages to `<dest>/<platform>-<arch>-debug/` — a sibling of the release dir, never an overwrite. Apps load debug artifacts only when launched with `DD_NATIVE_PROFILE=debug` (or `draft dev --native-debug`); release resolution never searches debug dirs, so a debug build cannot silently downgrade the runtime (a 318MB debug `libdowndraft_platform.so` once shipped to the release staging dir cost ~3× frame time — debug wgpu validates every call unoptimized). The loader warns when `DD_NATIVE_PROFILE=debug` resolves a release artifact.
- CI: `.github/workflows/native.yml` builds the per-platform matrix and uploads bundles to the release; `publish.yml` repacks them into the npm platform packages via `scripts/stage-native-packages.mjs`.

`lib-paths.ts` resolves libraries via env override → crate `dist/` → `native/` → `native/<platform>-<arch>/` → workspace `target/` → `@downdraft/native-*` package → `<exe>/native/` → `/usr/local/lib`. With `DD_NATIVE_PROFILE=debug`, `<platform>-<arch>-debug/` and `target/debug` dirs are prepended; under release they are excluded.

### Runtime detection

`packages/engine/core/src/platform/runtime.ts` provides `isBun`, `isDevMode`, `getHostCapabilities()`, and `getNativeHost()` for feature-detecting the runtime. Engine code should use these instead of `import.meta.env.DEV` or `typeof navigator !== "undefined"`.

`packages/engine/core/src/platform/render-surface.ts` defines `RenderSurface` — the host-neutral render target (WebGPU context, dims, event target, pointer-lock). `AppRenderer`/`AppContext`/`startApp` use it; `NativeSurface` satisfies it.

**Shared GPU device across workers** (`@downdraft/platform-native` `gpu/`): wgpu handles are process-global — a worker can attach to the host device via `attachSharedDevice(handle, cells)` (non-owning view; worker `destroy()` never releases the native device). **Consumers must attach through `nativeHost.gpuShare.payload()`** — the `GpuShareBroker` owns THE cells set per device; calling `shareDevice()` per consumer clobbers `device.sharedState` so only the last consumer's cells get `writeDead()` on loss. Liveness propagates through the shared SAB cells — owner `pollLost`/`destroy()`/`markDeviceLost` all write them dead; workers must check `isValid()` before FFI calls (calling into a freed device is a UAF). Resource direction: worker→owner `exportGpuResource`/`exportCommandBuffer` (owner `importGpu*`/`importCommandBuffer`s into OWNING wrappers); owner→worker `borrowGpuTexture`/`borrowGpuBuffer` (worker wraps non-owningly — deferred-destroy applies, see html-ui's texBind/texAck). Ordered worker passes: `postPass` → `nativeHost.passMailbox` (`GpuPassMailbox`) → `AppRenderer` drains `"preSubmit"` into the frame batch and `"preUi"` ahead of the UI-composite submit — stale-tolerant, next-frame semantics, never rendezvous'd. `createGpuWorkerContext` is the conventional worker-side attach/detach prelude. Use for coarse subsystems (UI raster uploads, terrain bake, worker pass producers) — fine-grained per-pass splits lose to submission overhead, and one queue still serializes GPU work. `createDeviceStateCells` registers every cell set in a process-wide `LIVE_CELLS` set — teardown calls `retireAllSharedDevices()` (bounded detach wait) / `markAllSharedDevicesDead()` (sync kill-switch) against all of them without knowing who shared. Device loss currently means restart (`__ddRequestRestart`) — in-place worker reattachment is documented future work in `docs/site/src/content/docs/architecture/gpu-worker-reattach.md`.

**Shutdown ordering (window close)** — workers must die before GPU handles are freed, or a worker inside a wgpu FFI call wedges teardown behind a synchronous native call (which also defeats the dev shell's force-exit timer — a real soft-lock). Canonical order: `retireAllSharedDevices()` first (raises detach flags → workers stop *starting* FFI calls), then `__ddSession.teardown()`/`sim.stop()` (graceful worker stop), then `host.destroy()`. `host.destroy()` is idempotent and marks all shared cells dead itself. Outside the dev shell nothing stopped sim workers historically — `runNativeAppModule` now stops `ctx.sim`/`createdSim` on close (via `stop()`/`shutdown()`); `SimWorker` declares optional `stop`/`shutdown`; `BaseWorkerHost`/`SandStepPool` workers are `unref()`ed so a leaked worker can't pin process exit.

### Runtime-specific import loaders

`packages/engine/core/src/platform/bun-preload.ts` registers Bun plugin loaders for `?raw` and `?url` import suffixes, plus CSS imports — configured in root `bunfig.toml`, Bun-only. The Node+tsx path gets the same handling from `packages/platform-native/src/ffi/wgsl-loader.mjs` (passed via `NODE_OPTIONS=--import`); Deno has no loader hooks, so shared code must never depend on loader transforms.

### Tri-runtime notes

Native runs on three JS runtimes — **Bun** (default, `bun:ffi`), **Node+tsx** (`koffi`, `wgsl-loader.mjs`), **Deno** (`Deno.dlopen`, root `deno.json` + `--allow-all --unstable-sloppy-imports`). Steady-state perf is identical across runtimes (GPU + fixed-dt sim don't depend on the JS runtime); differences are boot time (~0.5–1.0s Bun, ~1.0s Node/Deno) and footprint (~520MB Bun / ~1.05GB Node / ~690MB Deno RSS on my-app). OSR (devtools/web overlays) is `modules/native-osr` — in-process WebGPU, no webviews.

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

`deno.json` at the repo root is a generated import map mirroring `tsconfig.web.json` `paths` (`foo/*` → `dir/*` trailing-slash form, required for `@`-scoped aliases). Regenerate with `bun run gen:deno-import-map` whenever tsconfig paths change (CI checks it stays in sync). Known Deno limitation: basis-universal `?url` wasm imports resolve lazily with a disk fallback.

Verified on my-app (~20s steady state): all three runtimes boot the full stack — GPU via FFI, nested workers, MCP, saves, screenshots — and the sim holds its fixed 60t/s on each.

Cross-runtime landmines:
- **tsconfig `paths` are type-only, but tsx and Deno honor them at runtime.** The `"xxh3-ts"` alias maps to a `.d.ts` — under tsx/Deno `import "xxh3-ts"` loads the declaration file as an empty module. Runtime workarounds must use a subpath the alias doesn't cover (e.g. `require("xxh3-ts/index.js")`), never a bare specifier.
- **CSS imports must stay out of shared modules** — `app-module.ts` runs on native where `.css` can't load (Deno has no loader hooks at all). There is no browser-only entry where CSS can load — keep `import "./x.css"` out of app code entirely.
- **JSON imports need `with { type: "json" }`** for Deno (supported by Node ≥20, Vite, Bun, browsers).
- **`node:module` imports must be lazy dynamic imports** in shared code (a static specifier resolves before runtime shims install).
- **Node has no global `Worker`** — dom-polyfills wraps worker_threads on the main thread and `ffi/worker-bootstrap.mjs` re-installs the same wrapper inside workers for nested spawns.
- **`__ddRequestFrame` prefers a renderer's own `renderOneFrame()`** over the inherited `AppRenderer.renderOnce()` — renderers that draw outside the AppRenderer frame graph (tto) would otherwise acquire-but-not-write the surface texture and starve the capture hook via the write-tracking present-skip.

### wgpu validation notes

The Rust shim validates every `WGPUTextureFormat`/`WGPURenderPipelineDescriptor` enum value before calling into wgpu and returns NULL with an error log instead of aborting. Hardened call-sites: `wgpu-device.ts` counts only non-null vertex-buffer slots (sparse `buffers` arrays desynced the flat-descriptor walk); bind groups created with `hasDynamicOffset` layouts must be bound with a dynamic-offsets array (`setBindGroup(i, bg, [0])` — the shim plumbs them); `PostProcessStack` takes a `sceneFormat` option — apps whose scene pipelines target the surface format pass it (the default `rgba16float` requires HDR scene pipelines).

### App-side verification env vars

Per-app conventions seen in app repos (not engine-wide): `SCREENSHOT_FRAME=N` (auto-capture at frame N), `AUTO_EXIT=1` (exit after the shot), `DEBUGGER_AUTO_SHOW=1`, `DEBUGGER_PANEL=<id>` (panel ids: `console elements performance gpu` + provider ids `app sim memory render-graph materials doctor workers input postfx assets`).

