# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## Unreleased

### Added

- **GPU adapter policy + automatic software fallback** (`platform-native/src/gpu/adapter-policy.ts`, `adapter-boot.ts`) — the native host's adapter/device acquisition is now policy-driven instead of a raw `requestAdapter` call. Some virtualization drivers (Mesa **Venus** on virtio-gpu, Android-emulator **gfxstream**) `abort()` the process inside `requestDevice` rather than returning an error, so the policy rejects denied adapters after the info query but before device creation, then retries on wgpu's software fallback adapter (llvmpipe/lavapipe). `softwareFallback` defaults to **on** — apps get reliable software rendering for free.
- **`downdraft.config.json` `"gpu"` block** — per-app GPU settings, the settings-file half of the toggle: `{ "gpu": { "mode": "performance"|"stability", "adapter": "auto"|"hardware"|"software", "backend": "auto"|"vulkan"|"gl"|"metal"|"dx12", "softwareFallback": bool, "glFallback": bool, "deny": [substrings] } }`.
- **`gpu.mode` preset — `"performance"` vs `"stability"`** (also `DOWNDRAFT_GPU_MODE`) — the coarse per-app graphics knob. `"performance"` (games) is hardware-only: no software failover, no GL retry — the boot fails rather than silently degrade. `"stability"` (desktop apps) runs the graceful degradation chain — primary backend (vulkan) → GL backend (virgl; a second wgpu instance whose win repoints `navigator.gpu`/`__wgpuInstancePtr` and rebinds the window's instance-scoped surface via `NativeWindow.recreateGpuSurface`) → software adapter. Granular fields set beside a mode override its individual pieces.
- **Env overrides** — `DOWNDRAFT_GPU=swiftshader|hardware|auto` (existing var, now feeds the policy), `DOWNDRAFT_GPU_BACKEND`, `DOWNDRAFT_GPU_FALLBACK=0|1`, `DOWNDRAFT_GPU_DENY=a,b`.
- **Hardware-boot crash sentinel** — `<userData>/gpu/hardware-boot.pending` is armed before every hardware adapter attempt and disarmed on the first presented frame or clean exit; a stale sentinel on the next boot counts a hardware-boot death, and `CRASH_LATCH_THRESHOLD` (2) consecutive deaths write `latchedAdapter: "software"` into `gpu-state.json` so crashy drivers stop being retried. Explicit hardware/software choices override the latch; a proven-healthy hardware boot clears it.
- **New wgpu shim exports** (additive — no ABI bump): `wgpu_shim_create_instance_ex(backend_id)` restricts the instance to one backend (`DOWNDRAFT_GPU_BACKEND`/`gpu.backend`), `wgpu_shim_request_adapter_ex` + `wgpu_shim_request_adapter_async_ex` take a per-request `force_fallback` flag (runtime `process.env` mutation doesn't reach the native library's libc environ, so fallback can't be toggled mid-process via env). `wgpu_shim_surface_pick_format` now falls back to the first requested candidate when a surface reports empty capabilities (GLES probing).

### Changed

- **`DOWNDRAFT_GPU=auto` is the default adapter mode** — hardware-first with automatic software failover; `draft test`'s `--renderer=cpu|gpu` mapping is unchanged.
- **`backend:"gl"` (virgl GLES) presents on Wayland — experimental** — the event loop's `OwnedDisplayHandle` is now bound to `InstanceDescriptor.display` when GL is requested (required for wgpu's EGL/Wayland presentation), the surface configure path clamps requested usages to real caps, and `viewFormats` are dropped with format-mismatched views coerced to the base format (GLES lacks `VIEW_FORMATS` downlevel flags). Caveats: srgb view reinterpretation degrades to a gamma shift, `captureScreenshot` is unavailable (GLES surfaces expose no `COPY_SRC`), and GLES feature coverage is narrower than Vulkan. Opt-in via `gpu.backend:"gl"`/`DOWNDRAFT_GPU_BACKEND=gl`; the auto backend set is unchanged.

## [0.5.0](https://github.com/knackstedt/downdraft/compare/v0.4.9...v0.5.0) (2026-10-15)

### Breaking

- **Native FFI symbols renamed** — the stale `sdl_shim_*` exports (winit-backed, not SDL) are now `dd_window_*`/`dd_hotkey_*`; `sdl-ffi.ts` → `window-ffi.ts`. All native cdylibs export `dd_abi_version`, asserted at library load — a stale `.so` now fails loudly with an ABI-mismatch error instead of blank windows. Prebuilt binaries and the TS FFI layer must be updated together.
- **Global bridge renamed** — `window.downdraft` → `globalThis.downdraft`; `__sceneInspector` → `__downdraftDevtools` (native has no `window`).
- **App entry moved** — `app/src/renderer` → `app/src/main`; published path `@downdraft/engine/app/renderer` → `@downdraft/engine/app/main`.
- **Deprecated CLI commands removed** — `draft build`, `dist`, `export`, `mobile`, `build-games` are gone; use `draft release` (`--stage=build|package|release`, `--target=win|linux|mac|android`).
- **Persistence API renamed** — `OpfsSaveStore` → `DirectorySaveStore` (browser OPFS or native filesystem-backed directory handle); `SaveWorkerProxy`, `persistence/browser` subpath, and the `"inline"` save mode removed. Save modes are now `"host"` (typed `ISaveStore` on the main thread) / `"worker"` (sim-worker-owned store) / `"auto"`.
- **`EMBER_LOG_LEVEL`** → `DOWNDRAFT_LOG_LEVEL`.
- **`DOWNDRAFT_STRICT` split** — CLI unknown-flag strictness is `DOWNDRAFT_CLI_STRICT`; engine diagnostics (module DI + WGSL validation) use `DOWNDRAFT_STRICT_DIAGNOSTICS`.
- **`xxh3-ts` tsconfig/deno `paths` alias removed** — it resolved to a `.d.ts` (empty module under tsx/Deno); hashing now loads the real package via a non-aliased seam.

### Security

- **MCP HTTP transport requires the bearer token by default**, including on loopback (the endpoint exposes input injection, state writes, and a REPL). Opt out explicitly with `mcp.requireAuth: false` or `MCP_AUTH=0`. Clients discover the token via the mode-0600 `~/.downdraft/port/<pid>.token` file.
- **`postinstall` native fetch verifies SHA-256** — `fetch-native.mjs` checks each `downdraft-native-*.tar.gz` against the `.sha256` published by `native.yml`; mismatch aborts the install.
- **Docs no longer call `worker-js` plugins "sandboxed"** — wasm/quickjs are hard-isolated; worker-js runs with host-runtime privileges (capability-restricted, not a security boundary).

### Added

- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `THIRD_PARTY_NOTICES.md`, `deny.toml`.
- `docs/adr/` — ADRs for the native runtime, the Vite dev shell, and the tri-runtime JS host.
- `docs/site` architecture section gains module-system, native-platform, android, engine-internals, plugin-internals, profiling, devtools, and gaussian-splats pages (content moved out of `AGENTS.md`); `reference/testing.md` + `reference/limitations.md` document the automation harness and known gaps.
- `DOWNDRAFT_GPU=swiftshader` now actually forces wgpu's software/fallback adapter at the Rust `request_adapter` boundary (previously documented but unconsumed in-process).
- `draft test --game=packaging-smoke` / `tests/e2e/packaging-smoke-smoke.spec.ts` — a self-contained e2e path that needs no `games/` clone; `resolveGameDir` also resolves `examples/<name>`.
- CI: cross-platform smoke job (Windows/macOS) for the pure-TS surface, `cargo-deny` licenses+advisories gate, npm license check, sha256 checksum publication + verification in `publish.yml`.

## [0.3.0](https://github.com/knackstedt/downdraft/compare/v0.2.0...v0.3.0) (2026-10-10)
