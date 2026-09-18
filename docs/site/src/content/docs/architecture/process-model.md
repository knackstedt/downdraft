---
title: Process Model
description: Four isolated execution contexts and their responsibilities
---

DownDraft Engine runs across four isolated execution contexts, each with distinct responsibilities.

## Architecture

```
┌─────────────────────────────────────────────┐
  Electron Main Process (game-owned src/main.ts)
    • Calls createDowndraftApp() from @downdraft/engine/app/main
    • Window lifecycle, display info, IPC (config-driven)
    • GC profiling, performance stats
├─────────────────────────────────────────────┤
  Renderer Process (BrowserWindow)
    ┌───────────────────┐  ┌──────────────────┐
    │  WebGPU Canvas    │  │  React UI Overlay │
    │  (RenderLoop)     │  │  (DevTools, HUD)  │
    └────────┬──────────┘  └──────────────────┘
             │ SharedArrayBuffer (zero-copy)
    ┌────────┴──────────┐
    │  Sim Web Worker   │
    │  (ECS World,      │
    │   game systems,   │
    │   physics, plugins)│
    └───────────────────┘
└─────────────────────────────────────────────┘
```

## Execution Contexts

### 1. Electron Main Process

- Game-owned `src/main.ts` calls `createDowndraftApp()` from `@downdraft/engine/app/main`
- Window/lifecycle management, IPC handlers — all config-driven
- GC/performance profiling
- No render loop here

### 2. Renderer Process (BrowserWindow)

- React UI overlay + WebGPU `<canvas>` rendering
- The `RenderLoop` runs here via `requestAnimationFrame`
- Input capture (keyboard, mouse, gamepad, touch)
- DevTools panel (dev mode only)

### 3. Sim Web Worker

- Spawned from the renderer
- Runs the ECS `World`, game systems, physics, and plugins
- Communicates with the renderer via `SharedArrayBuffer` (zero-copy) and `postMessage` events
- WASM plugins run in an isolated runtime within the sim worker

### 4. DB Worker Thread

- SurrealDB (SurrealKV) embedded in a Node.js worker thread in the main process
- Handles save/load and game state queries
- Schema versioning and migration registry

## Build Modes

| Mode | WebView | Use case |
|---|---|---|
| **dev** | Chromium (Blink) | Development with full DevTools, hot reload, telemetry |
| **debug** | WebKit | Local verification on the production WebView engine |
| **prod** | System WebView | Optimized production build, no debug overhead |

## Crash Recovery

The sim worker supervisor handles crashes:

1. **First crash** — Restart once from DB checkpoint, surface non-blocking error banner
2. **Second crash in short window** — Halt render loop, show fatal error
3. **Philosophy** — Fail loud, don't retry forever
