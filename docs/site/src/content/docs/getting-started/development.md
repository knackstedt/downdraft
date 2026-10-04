---
title: Development
description: Dev workflow, build modes, and project structure
---

## Dev Shell

The primary development workflow runs a game on the native runtime:

```bash
cd <game-directory>
draft dev
```

This boots the game's `src/native-entry.ts` entrypoint inside the native dev shell — a JS-runtime process (Bun by default; `--runtime=node|deno` selects Node+tsx or Deno) hosting a winit window and the wgpu device, with an embedded Vite module runner providing tiered HMR (module-level invalidation through full session/host restart). Telemetry, devtools, and the MCP endpoint are enabled in dev mode.

Use `--no-hmr` to spawn the entry directly without the dev shell.

## Build Modes

DownDraft supports three build modes:

| Mode | Use case |
|---|---|
| `dev` | Development with devtools overlay, HMR, and telemetry. Fastest iteration. |
| `debug` | Local verification with debug draw and profiling enabled. |
| `prod` | Optimized production build. No devtools, no debug overhead. |

## Project Structure

```
downdraft-engine/
├── packages/
│   ├── engine/         # The @downdraft/engine package
│   │   ├── core/       # ECS, render, SAB, input, modules, particles, animation, physics, audio
│   │   ├── app/        # Runtime-agnostic game bootstrap (startGame/bootstrapGame)
│   │   ├── mcp/        # Engine-side MCP server (tools, resources, prompts)
│   │   ├── shader-graph/# Material/shader graph compiler
│   │   ├── asset-bake/ # Offline asset baking
│   │   ├── libraries/  # Engine libraries (water, physics, audio, models, ...)
│   │   └── modules/    # Engine modules (devtools, mcp, terrain, camera-controls, ...)
│   ├── cli/            # CLI tool (draft new/dev/debug/release/assets/test)
│   ├── platform-native/# Native runtime host (FFI → Rust cdylib; Bun/Node/Deno)
│   ├── android-shell/  # Android NativeActivity shell (winit loop + embedded libnode)
│   ├── node-mobile/    # libnode build recipe for mobile (patches + overlay)
│   ├── devtools-web/   # Web devtools UI (optional browser backend over loopback HTTP+WS)
│   └── native-*/       # Prebuilt platform binaries per target
├── examples/           # Example projects
├── games/              # Optional local clones of game repos (gitignored)
├── tests/              # Test infrastructure (e2e specs, fixtures)
└── docs/               # Documentation
```

## Building for Production

```bash
# Build for current platform
draft release --game=my-game --target=linux --out=release

# Build for all desktop targets
draft release --game=my-game --target=all --out=release

# Linux .deb + AppImage + Flatpak, node runtime
draft release --game=my-game --target=linux --runtime=node --format=deb,appimage,flatpak
```

`draft release` compiles the game's native entry via `scripts/package-native.mjs` (win/mac: standalone Bun binary) or `scripts/package-desktop.mjs` (linux: `--runtime=bun|node|deno`, `--format=dir|deb|appimage|flatpak`), staging the platform cdylibs, game-native artifacts, and `dd-assets/` beside it. See [Packaging & Distribution](/guides/packaging/).

## DevTools

In dev mode, the native devtools overlay (egui, toggled with F12) is available with:

- **Scene / SimWorld** — Entity hierarchy tree and component dump
- **Console** — Log stream + CDP `Runtime.consoleAPICalled`/`exceptionThrown`
- **GPU** — Adapter info, buffer sizes, per-pass draw calls and timings
- **Perf Metrics / Perf Recorder** — GC/memory/CPU per thread, frame-time graphs, p50/p95/p99 statistics
- **Provider panels** — Materials, Assets, RenderGraph, Workers, Memory, PostFx, Input, and the `downdraft doctor` module-graph panel
- **Debug draw** — Wireframe, AABBs, gizmos, and scene overlays via `modules/devtools`

The overlay runs as a Rust egui crate (`libdowndraft_devtools`) that serializes PaintJobs into the frame via `UiBlitPass` — in-process, no webviews. An alternative `WebDevtoolsHost` backend can instead serve `packages/devtools-web` over loopback HTTP+WS and open it in a browser.
