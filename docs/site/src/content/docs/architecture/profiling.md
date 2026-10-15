---
title: Profiling
description: In-process profiling instrumentation — worker prelude, views, timestamps, task latency
---

## Profiling system (`@downdraft/engine/profiling` + `@downdraft/engine/modules/devtools`)

A comprehensive cross-thread profiling + tracing system (Puffin-style flame graph, memory/CPU/IOPS/event-loop/GC views, warning toasts, trace recording + export). The pixi-based in-game overlay (`libraries/profiler`) has been deleted — profiling surfaces now live in the devtools host.

### Architecture

- **`@downdraft/engine/profiling`** — the core profiling primitives:
  - `ProfilingSAB` — a `SharedArrayBuffer` with a fixed layout: slot table (per-worker), per-slot metrics (ThreadMetrics), IOPS ring, event-loop block, warning ring, string table. Workers claim slots; the renderer reads all slots + drains the warning ring each frame.
  - `ProfilingSABWriter` / `ProfilingSABReader` — writer (worker-side) + reader (renderer-side) for the SAB.
  - `ThreadMetricsWriter` — writes heap/CPU/GC/task-latency metrics to the SAB each tick.
  - `TaskLatencyHistogram` — fixed-bucket histogram for task/tick latency (p50/p95/p99/max) + a sample ring for the flame graph.
  - `WarningEngine` — multi-level warning-rules engine. Rules fire in two modes: instantaneous (worker-side, `checkInstant()`) and windowed (renderer-side, `checkWindow()`). Supports auto-trace (starts recording on warning).
  - `EventLoopMonitor` — rAF jitter, long-task detection, idle headroom measurement.
  - `TraceEventWriter` — Chrome Trace Event / Perfetto / Spall format export.
  - IOPS patches: `patchOpfsPrototypes()` + `patchIndexedDbPrototypes()` — wrap OPFS/IDB methods to record IOPS to the ring. `disableRendererIndexedDb()` — patches the renderer's `indexedDB.open` to throw (renderer should not do I/O).
  - `worker-prelude.ts` — imported at the top of every instrumented worker. On load, detects worker realm, and if a ProfilingSAB is attached, claims a slot + initializes all writers + the warning engine + event-loop monitor + patches prototypes.
- **`@downdraft/engine/worker/instrumented-worker-host`** — `InstrumentedWorkerHost` (extends `BaseWorkerHost`) auto-attaches the ProfilingSAB before `onInit()`. `exposeProfilingApi()` merges `__profilingAttach` / `__profilingAddRule` / `__profilingOnWarning` RPC methods into a worker's `expose()` API.
- **Worker prelude wiring** — there is no Vite injection plugin; engine worker entries import `worker-prelude` directly (`sim-worker-base.ts`, `task-worker.ts`, `quickjs-bridge.ts`, `wasm-worker.ts`), so instrumentation is unconditional for engine-owned workers. Game-authored workers that want instrumentation should import `@downdraft/engine/profiling`'s `worker-prelude` at the top of the worker entry.
- **`@downdraft/engine/modules/devtools`** — extended with:
  - `DebugViewDescriptor` + `registerView()` — declarative registration of profiler overlay views.
  - `attachProfilingSAB()` / `getProfilingSAB()` — SAB management on the devtools API.
  - `ProfilingBridge` — renderer-side bridge that creates the ProfilingSAB, runs the WarningEngine + EventLoopMonitor + TraceEventWriter, drains the warning ring each frame, fires auto-trace, and registers the 10 built-in view descriptors.
  - `initDevTools({ profiling: true })` — creates the ProfilingBridge + exposes the ProfilingSAB on `__downdraftDevtools`.
  - `exposeDevToolsApi()` — now merges `exposeProfilingApi()` so workers get both devtools + profiling RPC methods.
- **`@downdraft/engine/core/telemetry`** — the collector/profilers/GC controller that feed the devtools host. The imui-based `DebugOverlay`/`ProfilerOverlay` in-game panels and the pixi-based profiler overlay library have been deleted.

### Built-in views (10)

| View | Kind | Description |
|------|------|-------------|
| Memory | `memory` | Heap used / total per worker |
| CPU | `cpu` | CPU percent + frame time per worker |
| Task Latency | `task-latency` | p50/p95/p99/max task latency |
| IOPS: OPFS | `iops-opfs` | OPFS I/O operations (op, tag, bytes, latency) |
| IOPS: IDB | `iops-idb` | IndexedDB I/O operations |
| Event Loop | `event-loop` | rAF jitter, long tasks, idle headroom |
| GC & Heap | `gc-heap` | GC pauses, heap over time, snapshot + force-GC |
| Flame Graph | `flame-graph` | Puffin-style task latency flame graph |
| GPU Passes | `gpu-passes` | WebGPU pass timings (render/compute/blit) |
| Warnings | `warnings` | Profiling warnings + auto-trace log |

### WebGPU timestamp queries

`GPUTimerPool` supports two levels of timestamp queries:
- **Inside-pass timestamps** (render/compute passes) — requires `timestamp-query` + `timestamp-query-inside-passes` (wgpu extension).
- **Encoder-level timestamps** (blit/copy passes) — requires only `timestamp-query` (base feature). Uses `commandEncoder.writeTimestamp()`.

`GPUProfiler` exposes `beginComputePass()` / `endComputePass()` / `beginBlitPass()` / `endBlitPass()` for compute + blit pass timing. `PassTiming.category` is `"render" | "compute" | "blit"`.

### Task latency instrumentation

The following execution paths are instrumented with `recordTaskLatency()` + `checkInstant(METRIC_TASK_LATENCY)`:
- **Sim worker tick loop** (`sim-worker-base.ts`) — each `onTick()` call is timed.
- **Task worker** (`task-worker.ts`) — each registered function call is timed.
- **QuickJS bridge** (`quickjs-bridge.ts`) — `eval()`, `callGlobal()`, and tick callbacks are timed.
- **WASM worker** (`wasm-worker.ts`) — `tick()` and `on_event()` calls are timed.

### Enabling profiling in a game

1. **`initDevTools`**: pass `profiling: true` to create the `ProfilingBridge` + `ProfilingSAB`.
2. **Render loop**: call `profilingBridge.tick()` in `beforeFrame` and `profilingBridge.endFrame()` in `afterFrame`.
3. **Sim worker**: call `simWorker.attachProfilingSAB(bridge.getProfilingSAB())` to share the SAB with the sim worker. Engine-owned worker entries already import `worker-prelude`; game-authored workers should too.

(The old `profilingPreludePlugin` Vite option and the `enableProfilingOverlay` in-game overlay are gone — profiling surfaces live in the devtools host.)

Code lives under `packages/engine/core/src/profiling/` (one file per primitive above, plus `iops/` patches), `core/src/worker/instrumented-worker-host.ts`, `modules/devtools/src/profiling-bridge.ts` + `debug-view-descriptors.ts`, and `core/src/telemetry/gpu-{timer-pool,profiler}.ts`.

