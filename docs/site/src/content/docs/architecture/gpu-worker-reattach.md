---
title: GPU Worker Reattach (future work)
description: Design notes for surviving device loss without restarting workers
---

Current device-loss semantics are **restart**: when the wgpu device dies,
`WgpuDevice.pollLost`/`destroy` writes the shared liveness cells dead, every
attached worker view goes invalid, and the app reloads
(`__ddRequestRestart`). Workers come up fresh on the next boot — simple,
correct, and consistent with how the rest of the engine treats device loss.

This note documents what an **in-place worker reattachment** would take when
device recreation without a full restart becomes desirable (long-lived sim
state, expensive worker startup, multi-consumer graphs where a restart is
disproportionate to the failure).

## What already exists

The plumbing is designed for this — nothing here changes:

- `DeviceStateCells` outlives devices. `generation` bumps on each
  `shareDevice()`; `attachSharedDevice` rejects stale generations, so a
  worker can never silently wrap a dead handle.
- `GpuShareBroker` owns one cells set per device. On recreation, the broker
  re-shares the new device into the *same* cells — every consumer sees the
  generation bump through memory it already holds.
- Worker FFI is liveness-gated: a dead view throws instead of issuing into a
  freed device, and `isValid()` is a cheap pre-check.
- `createGpuWorkerContext` centralizes attach/detach in the worker — adding
  a "reattach on generation change" path is a localized change, not a
  per-consumer one.

## What a reattach protocol needs

1. **Broker-side regeneration.** On device recreate, `GpuShareBroker`
   re-`shareDevice`s the new `WgpuDevice` into the existing cells and
   exposes the new `payload()`. (Today the broker binds one device at
   construction — the cells indirection already permits rebinding.)

2. **Worker-side re-attach.** Workers poll `generation` cheaply — either
   once per frame/build (`gpu.view` becomes invalid AND the cell generation
   moved past the handle's) or on a watch tick. On detecting a newer
   generation they `attachSharedDevice` the *new* payload and re-borrow
   their targets. The attach payload itself must be re-delivered — the new
   `GpuDeviceHandle` is a postMessage payload, not derivable from the cells.
   That means a `gpuAttach` re-send from the owner, or the owner embedding a
   "handle request" convention (worker posts `gpuNeeded`, owner replies).

3. **Resource re-binding.** Everything the worker borrowed (`borrowGpuTexture`
   / `borrowGpuBuffer`) died with the device. The owner must re-create its
   GPU targets *first* (or recreate-with-same-ptr is impossible — new device,
   new handles), then re-post fresh ptrs. For html-ui this is the existing
   `texBind` handshake replayed; for pass producers it's whatever target-
   binding message they already use. The rule stays the same: **borrowed
   wrappers are dropped, never re-wrapped** — stale ptrs are dead memory.

4. **In-flight frame semantics.** A device loss mid-frame invalidates the
   whole frame's queue work. Consumers that publish "data is ready" markers
   (atomics, sequence numbers) must *re-publish* after reattach — the
   overburden-style "publish after FFI calls" convention already covers
   correctness, but the first post-reattach build must be a full upload, not
   an incremental one, since the new textures are empty. html-ui handles
   this today via `refreshInto` on `texBind`.

5. **Why `pollLost` alone isn't enough.** Cell `alive` going 0→1 doesn't
   happen today (markLost is terminal) — the generation bump is the actual
   "new device exists" signal. Workers must compare `cell.generation`
   against `handle.generation`, not just `alive`.

## Deliberate non-goals

- **Same-ptr rebinding.** New device, new handles — there is no way to
  resurrect a dead resource by pointer. Any design that depends on it is
  wrong by construction.
- **Transparent reattach.** Workers must know a loss happened — buffered
  state tied to the old device (mapped buffers, half-encoded command
  buffers, per-slot scratch) is invalid. The contract is "reattach +
  rebind", not "pretend nothing happened".
- **Renderer-thread reattach without restart.** The owner side (surface
  reconfiguration, pipelines, bind groups, the renderer's own device
  wrapper) is a separate, larger problem. Worker reattach only becomes
  fully useful when that exists; until then it's preparation, not a
  feature.

## When to build it

The trigger is when device loss becomes survivable at the owner level —
i.e. after the renderer can recreate its device + surface + pipelines
without `__ddRequestRestart`. Until that lands, the restart path is the
correct behavior and this document exists so the shared-GPU API shape
doesn't foreclose it.
