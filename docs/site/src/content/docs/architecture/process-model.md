---
title: Process Model
description: Single-process native runtime and its execution contexts
---

DownDraft Engine runs as a **single native process** — winit + wgpu, hosted under Bun (default), Node+tsx, or Deno; no browser, no renderer process, no IPC boundary. Isolation is achieved with worker threads and SharedArrayBuffer rather than OS processes.

## Architecture

```
┌─────────────────────────────────────────────┐
  Game Process (src/native-entry.ts — Bun/Node/Deno)
    • createNativeHost() / runNativeGameModule()
    • Window lifecycle (winit), GPU device (wgpu)
    • HostAPI bridge — direct in-process calls
    • Saves, import cache, MCP server, tracing
    ┌───────────────────┐  ┌──────────────────┐
    │  RenderSurface    │  │  imui / PixiJS   │
    │  (RenderLoop)     │  │  UI + devtools   │
    └────────┬──────────┘  └──────────────────┘
             │ SharedArrayBuffer (zero-copy)
    ┌────────┴──────────┐
    │  Sim Worker       │
    │  (ECS World,      │
    │   game systems,   │
    │   physics, plugins)│
    └───────────────────┘
```

## Execution Contexts

### 1. Host (main thread)

- Game-owned `src/native-entry.ts` calls `runNativeGameModule()` / `createNativeHost()` from `@downdraft/platform-native`
- Owns the winit window, the single wgpu device, and the `RenderSurface`
- Exposes the `HostAPI` (`downdraft.*`) as direct in-process calls — saves, screenshots, import cache, window state, dialogs, restart routing
- MCP server (in-process, PID-file discovery), telemetry, native tracing
- The `RenderLoop` runs here, driven by the window's redraw events

### 2. Sim Worker

- Spawned from the host; runs the ECS `World`, game systems, physics, and plugins
- Communicates with the host via `SharedArrayBuffer` (zero-copy) and `postMessage` events
- WASM plugins run in an isolated runtime within the sim worker
- Workers can attach a non-owning view of the shared GPU device to encode command buffers in parallel

### 3. DB / Service Workers

- Background workers host services like the SurrealDB (SurrealKV) embedded store
- Handle save/load and game state queries, schema versioning and migrations

## Build Modes

| Mode | Use case |
|---|---|
| **dev** | Development with devtools overlay, HMR dev shell, telemetry |
| **debug** | Local verification with debug draw and profiling enabled |
| **prod** | Optimized production build, no debug overhead |

## Crash Recovery

The sim worker supervisor handles crashes:

1. **First crash** — Restart once from checkpoint, surface a non-blocking error banner
2. **Second crash in short window** — Halt render loop, show fatal error
3. **Philosophy** — Fail loud, don't retry forever

Host-level recovery goes through `downdraft.requestRestart(reason)` — the native host owns restart routing rather than page reloads.
