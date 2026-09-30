---
title: Development
description: Dev workflow, build modes, and project structure
---

## Dev Shell

The primary development workflow runs a game on the native runtime:

```bash
cd games/<game-name>
draft dev
```

This boots the game's `src/native-entry.ts` entrypoint inside the native dev shell — a JS-runtime process (Bun by default; `--runtime=node|deno` selects Node+tsx or Deno) hosting a winit window and the wgpu device, with an embedded Vite module runner providing tiered HMR (module-level invalidation through full session/host restart). Telemetry, devtools, and the MCP endpoint are enabled in dev mode.

Use `--no-hmr` to spawn the entry directly without the dev shell, or `--no-bake` to skip the asset bake step.

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
│   │   ├── ui/         # Devtools/editor UI sources
│   │   ├── libraries/  # Engine libraries (water, physics, audio, models, ...)
│   │   └── modules/    # Engine modules (devtools, mcp, terrain, camera-controls, ...)
│   ├── cli/            # CLI tool (draft new/dev/debug/release/assets/test)
│   ├── platform-native/# Native runtime host (FFI → Rust cdylib; Bun/Node/Deno)
│   ├── devtools-web/   # Web devtools UI served by the native OSR shell
│   └── native-*/       # Prebuilt platform binaries per target
├── examples/           # Example projects
├── games/              # Game projects (git submodules)
├── tests/              # Test infrastructure (e2e specs, fixtures)
└── docs/               # Documentation
```

## Building for Production

```bash
# Build for current platform
draft release --game=my-game --target=linux --out=release

# Build for all desktop targets
draft release --game=my-game --target=all --out=release
```

`draft release` compiles the game's native entry into a standalone Bun binary via `scripts/package-native.mjs`, staging the platform cdylib and `dd-assets/` beside it.

## DevTools

In dev mode, the native devtools overlay is available with:

- **Debug toggles** — Wireframe, hitboxes, normals, velocity, shadows, bloom, AABBs, overdraw, LOD visualization, depth buffer, tangents
- **Entity inspector** — Component dump, hierarchy tree
- **Asset browser** — Grid/list view with type filtering, search, and import
- **Telemetry graphs** — GC/memory/CPU per thread, frame time graphs, p50/p95/p99 statistics
- **Material graph editor** — Node-based shader editor with real-time WGSL compilation
- **Animation state machine editor** — Visual state machine with drag-and-drop states and transitions

The devtools render through the native OSR path (`modules/native-osr` + `devtools-web`) — in-process WebGPU surfaces, no webviews.
