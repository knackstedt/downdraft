# ADR 0001: Native winit + wgpu runtime (no Electron, no Capacitor)

Status: Accepted

## Context

Early DownDraft builds shipped games inside an Electron shell and explored a
Capacitor `mobile-shell` for Android. Both meant a bundled browser: a second
process tree, an IPC boundary for every platform call, hundreds of megabytes
of runtime, and a rendering stack (WebGL/compositing) that doesn't match what
wgpu provides directly.

## Decision

The runtime is native: `libdowndraft_platform` (a Rust cdylib — winit for
windows/input, wgpu for GPU) loaded over FFI by the JS host. The game process
drives a real OS window and the GPU directly; there is no embedded browser,
no renderer/preload split, and no IPC layer. Android uses the same stack plus
embedded libnode via `packages/android-shell` — not a WebView.

Simulation runs in a dedicated worker thread with SharedArrayBuffer
protocols — isolation is deliberate and preserved on native.

## Consequences

- `draft dev` / `draft test` / `draft release` run native only. The Electron
  shells (`core/ipc.ts`, `electron-osr`, `raw-input`, electron-builder config)
  and the Capacitor path (`mobile-shell`, `draft mobile`) are deleted and must
  not be resurrected — mobile is the native port.
- No DOM/DevTools-protocol debugging: game automation goes through the
  in-process MCP harness (see `reference/testing.md`), not a browser.
- UI is rasterized to textures (Blitz HTML/CSS or OSR backends) — no DOM
  accessibility tree; that's a documented known gap.
- Native ABI is versioned (`dd_abi_version`) — stale cdylibs fail loudly at
  load instead of producing blank windows.
