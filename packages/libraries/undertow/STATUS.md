# undertow — Status

**Status:** Active as of 2026-08-21. Revived for a game's Solid-in-worker
UI. The plugin was previously shelved (see git history for the original
`SHELVED.md`) after a game's React-in-worker experiment exposed
stability and latency flaws. A game's integration addresses flaws #1
and #2 by using Solid's fine-grained reactivity and a worker-owned store.

## Original flaws and current status

### Flaw #1: Every DOM op is a blocking round-trip — ADDRESSED

Solid's fine-grained reactivity means steady-state updates touch only the DOM
nodes bound to changed signals, not the entire component tree. Initial mount
is still N `createElement`/`appendChild` fire-and-forget ops (one-time,
non-blocking), but steady-state updates are O(changed) not O(tree). The
`sync-dom.ts` fire-and-forget path for tree mutations/attributes/styles means
Solid's commit phase never blocks on `callSync`.

### Flaw #2: Stale-state races between threads — ADDRESSED (at the game level)

A game's integration uses a **worker-owned Solid store** as the single
source of truth for UI state. Main→worker communication is one-way push
(SAB stats feed + event postMessage); the worker never receives clobbering
syncs of state it owns. This eliminates the optimistic-update skip window
and split-brain flag syncing that plagued a game's integration.

### Flaw #3: User-gesture context is lost — N/A for a game

A game has no pointer lock, fullscreen, or clipboard usage. If a game
needs user-gesture-gated APIs, the `host.eventDispatcher.onUserGesture`
callback (already in undertow) runs in the main-thread gesture context.

### Flaw #4: Renderer is unreachable in the worker — ADDRESSED (at the game level)

A game's integration uses a dedicated **UiStatsSAB** — a small
SharedArrayBuffer where the main thread writes UI-relevant scalars (FPS,
health, oxygen, depth, player position, etc.) each frame. The worker reads
them synchronously with zero round-trips. Event-driven data (collected items,
save events) flows via postMessage.

## What changed in the un-shelve

- `sync-dom.ts`: Removed React-fiber-specific handle-cache property copying
  (`__reactFiber`/`__reactProps`/`__eventTag`). The identity-stable handle
  cache itself is kept (Solid also benefits from stable node identity for
  event-target resolution). The upgrade path now copies all internal
  properties generically (anything starting with `__`).
- `polyfill.ts`: Updated comments from React-specific to generic DOM library
  language. The HTML element constructor stubs and `instanceof` globals work
  for Solid (which does `instanceof HTMLInputElement` etc. checks).
- All sync DOM methods (`createElement`, `createElementNS`, `createTextNode`,
  `createComment`, `createDocumentFragment`, `getElementById`, etc.) were
  already present and work for Solid's synchronous renderer.
- The `EventDispatcher` is demand-driven and already supports all event types
  a game uses (click, mouse, pointer, key, wheel, input, change, submit,
  focus, blur). High-frequency events are coalesced to one per rAF.
