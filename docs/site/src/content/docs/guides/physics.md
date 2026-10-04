---
title: Physics
description: Physics abstraction layer and Rapier3D backend
---

DownDraft provides a pluggable physics abstraction layer with a Rapier3D backend via Rust FFI.

## PhysicsRealm

A `PhysicsRealm` represents an isolated physics world. Multiple concurrent realms are supported.

```typescript
import { PhysicsRealm, RealmTier } from "@downdraft/engine";
import { createRapierBackend } from "@downdraft/engine/libraries/physics-rapier";

const backend = await createRapierBackend();
const realm = new PhysicsRealm(backend, {
  name: "main",
  tier: RealmTier.Near,
  gravity: [0, -9.81, 0],
  tierConfig: {/* per-tier LOD config */},
});
```

## Using the Rapier Library

```typescript
import { startGame } from "@downdraft/engine/app/renderer";
import { PhysicsRapierLib, PhysicsAPITok } from "@downdraft/engine/libraries/physics-rapier";

startGame({
  libraries: [PhysicsRapierLib],
  // inject the typed token in onReady:
  onReady: (ctx) => {
    const physics = ctx.inject(PhysicsAPITok);
  },
});
```

Bare class exports (`RapierPhysicsBackend`, `createRapierBackend`, `UniversalPhysicsAPI`) remain available for games that wire physics manually.

## Components

Physics-related components include:

- `RigidBody` — Static, dynamic, or kinematic bodies
- `Collider` — Box, sphere, mesh, or convex shapes
- `Velocity` — Linear and angular velocity
- `PhysicsTransform` — Synced transform between physics and ECS

```typescript
import { Collider, RigidBody, Velocity, createBoxCollider } from "@downdraft/engine";
```

## Character Controller

A built-in character controller handles player movement with proper collision response, slope handling, and stepping.

## Raycasting

```typescript
// Ray and shape queries are available through the physics interface
const hit = realm.raycast(origin, direction, maxDistance);
```

## Multi-Realm Support

Multiple physics realms can run concurrently, enabling scenarios like:

- Separate simulation spaces (interior vs exterior)
- Local physics bubbles around players
- Preview physics in the editor without affecting the main simulation

## Backend Interface

The `PhysicsBackend` interface defines the contract for physics implementations. Alternative backends can be registered via the physics registry.
