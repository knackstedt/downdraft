---
title: ECS
description: Entity Component System architecture and usage
---

DownDraft uses an archetype-based Entity Component System inspired by Bevy and Unity DOTS, with generational indices proven in production.

## Core Concepts

### Entity

An entity is a lightweight handle: `{ index: u32, generation: u32 }` — 8 bytes. Generational indices prevent stale-handle corruption.

### Component

Components are plain data classes implementing the `Component` interface. Each component slot includes a `lastChanged: u32` tick counter for change detection.

### Archetype

An archetype is a set of component types. All entities with the same archetype share a table with SoA (Structure of Arrays) column storage. Iterating "all entities with Transform + Velocity" walks two contiguous arrays — cache-friendly.

### Query

Queries declare read/write access to component types and return matching archetypes. Queries can filter by change detection: `query(Transform, Changed(Velocity))` only iterates entities where Velocity was written this tick.

### System

Systems are functions `(query, resources, commands) => void` that declare their access via query types.

### Schedule

The schedule is **single-threaded by default**. Systems run in dependency order on one thread. Multi-threading is available via plugin/SAB work distribution — the schedule API is designed so multi-threading is a plugin, not a core concern.

### Events

Events use double-buffered channels. Events written this tick are readable next tick, preventing mutation-during-iteration bugs.

### Commands

Deferred operations (spawn/despawn entity, add/remove component) are queued during system execution and applied at stage boundaries.

## Usage

```typescript
import { Component, World, Stage, system } from "@downdraft/engine";

// Define a component
const Health = Component.register("Health", {
  current: 100,
  max: 100,
});

// Create a world
const world = new World();

// Spawn an entity and add components
const entity = world.spawn(new Map());
world.addComponent(entity, Health.id, Health.create({ max: 200 }));

// Define and register a system
const damageSystem = system("damage", Stage.Update, (ctx) => {
  const { world, dt } = ctx;
  // Iterate entities with Health component via query
});

world.schedule.addSystem(damageSystem);

// Step the simulation
world.step(dt);
```

## Hierarchy

Entities can be parented in a DOM-shaped tree:

- **Implicit root** — Every entity is parented at minimum to the World root. No orphan entities.
- **Structural components** — Parent/child stored in a side table, not in archetype columns. This avoids archetype moves on reparenting.
- **Dirty-flag propagation** — When a parent's Transform changes, a `dirty` boolean on each child is set. This is a derived-data invalidation flag, distinct from `lastChanged`.
- **Lazy world matrix** — `worldTransform = parent.worldTransform * localTransform`. Computed on read when `dirty` is set, then cleared.
- **Reparenting** — `setParent(entity, newParent)` updates the side table, adjusts Children arrays, marks entity + descendants dirty. No recursion for transform — propagation is lazy.

## Change Detection

Every component instance has a `lastChanged: u32` tick counter. When a system writes to a component, the write wrapper increments `lastChanged` to the current tick. Consumers poll `lastChanged >= lastReadTick` — a single integer comparison, O(1) per entity.

For SAB-backed data, `Atomics.store` / `Atomics.load` on the SAB header's sequence counter serves as the cross-thread change signal. Each SAB channel has its own independent sequence counter, enabling fine-grained frame synchronization.
