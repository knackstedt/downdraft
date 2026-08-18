# undertow — SHELVED

**Status:** Shelved as of 2026-08-17. Not in use by any game.

`to-the-ocean` was the only consumer. It now renders React on the main thread
directly (see `games/to-the-ocean/src/main.tsx`). The plugin package is kept
here for reference and potential future revival, but it is **not** wired into
any game's runtime.

The Vite aliases (`undertow`, `undertow/*`) and tsconfig path mappings are
intentionally left in place so the package still type-checks and can be
un-shelved without re-plumbing the build config.

## Why it was shelved — known flaws not yet solved

The worker-DOM approach is appealing on paper (move React off the main thread
so the render loop is never interrupted by reconciliation), but in practice it
traded one set of problems for a worse set. The blocking issues fall into two
camps:

### Latency

- **Every DOM op is a blocking round-trip.** Each `callSync` from the worker
  blocks the worker thread on `Atomics.wait` until the main thread drains the
  request ring. A single React reconcile of a moderately complex tree
  (hundreds of elements) serializes into hundreds of sequential round-trips.
  The inventory grid had to special-case empty cells because rendering a 20×15
  grid naively caused **multi-second** hangs — one `callSync` per DOM element.
- **Main-thread busy → worker stalls.** The worker's `requestAnimationFrame`
  is itself proxied to the main thread, so when the main thread is busy with
  WebGPU/physics/OSR init the worker's rAF is delayed. A 4ms `setInterval`
  fallback was bolted on to drain replies, but sync calls still block until
  the main thread services them. First render had to be deferred to the next
  rAF to avoid a 1–2s block during startup.
- **Store sync is throttled and async.** State forwarded main→worker is
  coalesced to ~16ms, so latency-sensitive transitions needed a
  `flushImmediate()` escape hatch, and even then the worker's view of state
  lags the main thread's.

### Stability

- **Stale-state races between the two threads.** Because store syncs are
  async, the worker frequently acted on stale state. A 1000ms
  "optimistic-update skip window" was added so the main thread's late syncs
  wouldn't clobber the worker's more recent optimistic toggles — a fragile
  band-aid over an inherent race.
- **User-gesture context is lost across the boundary.** `requestPointerLock()`
  must run inside a user gesture. The worker→main round-trip loses that
  context, so pointer lock had to be re-implemented as a main-thread
  `onUserGesture` callback that inspects click targets and store flags. The
  worker itself can't lock the pointer.
- **Split-brain input/state machine.** Pointer lock, menu toggles, Tab/Escape
  handling, and `suppressPauseMenu` all had to be duplicated across the main
  thread and the worker with SAB flags + `postMessage` signaling to keep them
  roughly in sync. The two sides routinely disagreed about which menu was
  open.
- **Renderer is unreachable in the worker.** The real `WebGPURenderer` lives
  on the main thread and can't be cloned, so the worker got a `Proxy` stub
  that no-ops almost every method and forwards only `lockPointer`/
  `exitPointerLock`. Any game code that reads from the renderer (FPS, sim
  buffer, camera) silently breaks in the worker and has to be re-driven from
  the main thread via polling.
- **No real HMR in the worker.** React Fast Refresh globals don't exist in a
  hand-rolled worker entry, so `$RefreshReg$`/`$RefreshSig$` stubs had to be
  injected before any React module evaluated.

## What would need to change to un-shelve

These are open problems, not config tweaks:

1. A non-blocking (or batched/amortized) call path so a React reconcile
   doesn't serialize into N sequential `Atomics.wait` round-trips.
2. A coherent single-source-of-truth state model that doesn't require
   optimistic-update skip windows or split-brain flag syncing.
3. A first-class story for user-gesture-gated APIs (pointer lock, fullscreen,
   clipboard) that doesn't require reimplementing the gesture on the main
   thread.
4. A way to expose main-thread-only objects (renderer, sim buffer) to worker
   UI code without a no-op Proxy stub.

Until those are addressed, rendering React on the main thread is both simpler
and lower-latency for this engine's workload.
