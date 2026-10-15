# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## Unreleased

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
