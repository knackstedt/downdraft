---
title: SAB Communication
description: SharedArrayBuffer channels and zero-copy communication
---

DownDraft uses multiple SharedArrayBuffer (SAB) channels — typed `RecordReader`/`RecordWriter`, `SlotBuffer`, and `SimBufferReader`/`SimBufferWriter` pairs (`core/src/sab/`) — for zero-copy, high-frequency communication between the sim worker and renderer.

## Communication Tiers

| Boundary | Mechanism | Use case |
|---|---|---|
| Sim → Render | Multiple SharedArrayBuffers + Atomics | Transforms, water, terrain, physics, audio positions (60fps, zero-copy) |
| Game ↔ Host | Direct function calls (HostAPI) | Saves, screenshots, window state, dialogs, restart |
| Host ↔ Sim | postMessage + multiple SABs | Commands/events (postMessage), state (SAB channels via sequence counters) |
| Host ↔ Service workers | postMessage / MessageChannel | Save worker, task pool, UI raster workers, plugin workers |
| Cross-thread sync | Atomics on SAB headers | Frame synchronization, seqlock read/write coordination |

## Sequence counters

Each SAB channel carries a sequence counter in its header, bumped with `Atomics` when the writer publishes new data:

- **Change detection** — Readers poll `hasChanged(lastSeen)` and skip the channel entirely when the counter is unchanged
- **Lock-free** — No mutexes, no blocking, no allocation
- **Seqlock reads** — Where a reader copies live data (e.g. the html-ui zero-copy pixel path), the counter doubles as a seqlock: an odd value means a write is in flight, and the reader rechecks the counter after copying to detect a torn read

## SAB Channels

Each channel has its own independent sequence counter, enabling fine-grained frame synchronization:

| Channel | Data |
|---|---|
| Transform | Entity positions, rotations, scales |
| Input | Keyboard, mouse, gamepad state (host → sim) |
| Physics | Physics body transforms |
| Audio Position | Spatial audio source positions |
| Water | Water height field, dynamics |
| Terrain | Terrain height field, deformation |

If only transforms changed, water and terrain reads are skipped entirely.

## Cross-Thread Frame Sync

For SAB-backed data, `Atomics.store` / `Atomics.load` on the SAB header's sequence counter serves as the cross-thread change signal. The render thread polls the counter; if unchanged, it skips reading that channel.

Planned: `Atomics.wait` / `Atomics.notify` for blocking sync when low-latency is needed.

## Change Detection Integration

The SAB sequence counter integrates with the ECS change detection system. A system querying `Changed(Transform)` checks `lastChanged >= lastReadTick` — a single integer comparison. For SAB-backed data, the sequence counter serves the same role across threads.
