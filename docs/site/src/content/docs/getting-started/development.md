---
title: Development
description: Dev workflow, build modes, and project structure
---

## Dev Server

The primary development workflow uses `electron-vite dev`, loading a game's own entrypoint:

```bash
draft dev --game=<game-name>
```

This starts the Electron app with hot reload, full DevTools, and telemetry enabled. Each game owns its own `games/<game>/electron.vite.config.ts` entrypoint — `draft dev` loads it directly. You can also invoke `electron-vite` yourself:

```bash
npx electron-vite dev --config games/<game-name>/electron.vite.config.ts
```

## Build Modes

DownDraft supports three build modes (Angular-like build profiles):

| Mode | WebView | Use case |
|---|---|---|
| `dev` | Chromium (Blink) | Development with full DevTools, custom devtools panel, hot reload. Fastest iteration. |
| `debug` | WebKit | Local verification on the production WebView engine. Catches WebKit-specific issues. |
| `prod` | System WebView | Optimized production build. No devtools, no debug overhead. |

## Project Structure

```
downdraft-engine/
├── packages/
│   ├── core/          # Engine core: ECS, render, SAB, input, plugins, particles, animation, physics, audio
│   ├── app/           # Electron app shell: main process, preload, renderer entry
│   ├── ui/            # React UI: devtools, profiler, material graph editor, asset browser
│   ├── mcp/           # MCP server for AI agent interaction
│   ├── shader-graph/  # Material/shader graph compiler
│   ├── cli/           # CLI tool (draft new/dev/debug/release/dist/export/mobile/assets/test)
│   └── plugins/       # First-party plugins (water, physics, audio, networking, etc.)
├── examples/
│   ├── minimal/       # Minimal spinning cube
│   └── physics-demo/  # Physics playground
├── games/             # Game projects
├── tests/             # Test infrastructure (vision tests, fixtures)
├── devtools-extension/ # Chrome DevTools extension
└── docs/              # Documentation
```

## Building for Production

```bash
# Build for current platform
draft release --stage=build --mode=prod --out=dist

# Build for a specific target
draft release --stage=build --target=win --mode=prod --out=dist
```

## Packaging for Distribution

```bash
draft release --format=launcher --target=all --out=export
```

## DevTools Panel

In dev mode, a custom DevTools panel is available with:

- **Debug toggles** — Wireframe, hitboxes, normals, velocity, shadows, bloom, AABBs, overdraw, LOD visualization, depth buffer, tangents
- **Entity inspector** — Component dump, hierarchy tree
- **Asset browser** — Grid/list view with type filtering, search, and import
- **Telemetry graphs** — GC/memory/CPU per thread, frame time graphs, p50/p95/p99 statistics
- **Material graph editor** — Node-based shader editor with real-time WGSL compilation
- **Animation state machine editor** — Visual state machine with drag-and-drop states and transitions

## Chrome DevTools Extension

A custom DevTools extension (`devtools-extension/`) provides a 3D Scene Inspector when loaded into Chromium DevTools.
