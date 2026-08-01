---
title: SAB Communication
description: SharedArrayBuffer channels and zero-copy communication
---

DownDraft uses multiple SharedArrayBuffer (SAB) channels with a `SeqlockBuffer` primitive for zero-copy, high-frequency communication between the sim worker and renderer.

## Communication Tiers

| Boundary | Mechanism | Use case |
|---|---|---|
| Sim → Render | Multiple SharedArrayBuffers + Atomics | Transforms, water, terrain, physics, audio positions (60fps, zero-copy) |
| UI ↔ Main | Electrobun RPC | Commands, queries, UI state updates |
| Main ↔ Sim | postMessage + multiple SABs | Commands/events (postMessage), state (SABs via SeqlockBuffer) |
| Main ↔ DB | postMessage | Save/load, asset queries, schema migrations |
| Main ↔ Render | Direct function calls (same process) | Camera, viewport, debug overlays, HiDPI scale, HDR mode |
| Cross-thread sync | Atomics on SAB headers | Frame synchronization, seqlock read/write coordination |

## SeqlockBuffer

Each SAB channel uses the `SeqlockBuffer` primitive — a single reusable seqlock with:

- **Odd/even counter** — Writer increments before and after write
- **Reader retries** — If counter is odd (write in progress) or changed during read, reader retries
- **Lock-free** — No mutexes, no blocking, no allocation

## SAB Channels

Each channel has its own independent sequence counter, enabling fine-grained frame synchronization:

| Channel | Data |
|---|---|
| Transform | Entity positions, rotations, scales |
| Input | Keyboard, mouse, gamepad state (webview → sim) |
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
