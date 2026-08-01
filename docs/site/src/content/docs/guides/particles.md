---
title: Particles
description: GPU compute particle system with emitters
---

DownDraft includes a GPU compute particle system with configurable emitters.

## Basic Usage

```typescript
import { ParticleSystem, createFireEmitter } from "@downdraft/core";

const particles = new ParticleSystem({
  maxParticlesPerEmitter: 5000,
  useGPUCompute: true,
  surfaceFormat: "rgba16float",
});
particles.prepare(device);

const emitterId = particles.registerEmitter(
  createFireEmitter({ position: [0, 1, 0] })
);

// In update loop:
particles.update(dt);

// In render pass:
particles.render(ctx, viewProj, cameraPos);
```

## Smoke Emitter

```typescript
import { ParticleSystem, createSmokeEmitter } from "@downdraft/core";

const particles = new ParticleSystem({
  maxParticlesPerEmitter: 10000,
  useGPUCompute: true,
  surfaceFormat: "rgba16float",
});
particles.prepare(device);

const smokeId = particles.registerEmitter(
  createSmokeEmitter({ position: [0, 2, 0] })
);

// Update each frame
particles.update(dt);
particles.render(renderCtx, camera.viewProj, camera.position);
```

## GPU Compute

When `useGPUCompute` is true, particle simulation (position integration, lifetime, spawning) runs on the GPU via compute shaders. This enables tens of thousands of particles with minimal CPU overhead.

## Built-in Emitters

| Emitter | Description |
|---|---|
| `createFireEmitter` | Fire effect with upward velocity, color fade, and size shrink |
| `createSmokeEmitter` | Smoke effect with slow upward drift and expansion |

Custom emitters can be created by implementing the emitter interface.
