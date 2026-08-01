# ECS State Validation & Rollback

## Problem

`crash-recovery.ts` handles worker-level crashes via checkpoint snapshots, but there is no lightweight ECS state validation or rollback for command-level errors. If a command in `World.flushCommands()` throws (now caught and logged), the world may be left in a partially mutated state with no way to detect or recover from the inconsistency.

## Current State

- `flushCommands()` catches per-command errors and logs them, but remaining commands still execute against potentially corrupted state.
- `CrashRecoveryManager` creates periodic checkpoints (default 5s interval) and can restore from them, but this is coarse-grained and designed for worker crashes, not command-level corruption.
- No mechanism exists to validate ECS invariants (e.g., entity-alive consistency, archetype-row integrity, free-list correctness) between ticks.

## Proposed Work

### Phase 1: Invariant Checks

Add a `validate()` method to `World` that checks:

- Every alive entity has a valid `archetypeId` that exists in `archetypeById`.
- Every archetype's entity rows match `entities[entity.index]` metadata (generation + archetypeId).
- `entityFreeList` contains only dead entities (no duplicates, no alive entries).
- No entity appears in multiple archetypes.

Gate behind an env flag (`EMBER_ECS_VALIDATE=1`) so it can run in dev/test without production overhead.

### Phase 2: Command-Level Snapshot/Restore

Before `flushCommands()`, snapshot the minimal mutable state:

- `entities` array (shallow copy)
- `entityFreeList` (shallow copy)
- Affected archetype columns (or full archetype map if memory budget allows)

If any command throws, log the error and **optionally** restore the snapshot so the world is not left in a partial state. This makes command execution transactional.

### Phase 3: Tick-Level Validation Hook

Call `validate()` at the end of `World.step()` when `EMBER_ECS_VALIDATE=1`. On failure, emit an event on `EventBus` (`ecs:validation-failed`) so game code can decide whether to pause, restore a checkpoint, or crash.

### Phase 4: Integration with CrashRecoveryManager

Wire validation failures into `CrashRecoveryManager` so that a validation failure triggers an automatic checkpoint restore (if `autoRestore` is enabled), rather than waiting for the next periodic checkpoint.

## Key Files

- `packages/core/src/ecs/world.ts` — `World` class, `flushCommands()`, `step()`
- `packages/core/src/ecs/archetype.ts` — archetype storage, entity row management
- `packages/core/src/worker/crash-recovery.ts` — `CrashRecoveryManager`, checkpoint restore
- `packages/core/src/ecs/events.ts` — `EventBus` for validation-failed events

## Priority

Medium — prevents silent state corruption but not currently causing visible bugs. Worth doing before multiplayer or save-heavy features land.
