# Monolithic File Decomposition Plan

## Status

Splitting large monolithic files into focused modules. Original plan covered 9 files
totaling ~16,000 lines. 5 of 9 are now complete; 4 remain.

## Completed

### 1. constants.ts → constants/ (DONE)
Split into `games/to-the-ocean/src/shared/constants/` with `biome.ts`, `boat.ts`,
`buffer.ts`, `economy.ts`, `fishing.ts`, `game.ts`, `index.ts`, `pirates.ts`,
`player.ts`, `ship.ts`, `weather.ts`, `wildlife.ts`, `world.ts`. Re-exported from
`index.ts` for backward compat.

### 2. EntityRenderer.ts (DONE)
Split into `games/to-the-ocean/src/engine/entity/` with `anchor-renderer.ts`,
`boat-mesh-builder.ts`, `hitbox-renderer.ts`, `holo-preview-renderer.ts`,
`instanced-renderer.ts`, `island-terrain-renderer.ts`, `player-mesh-renderer.ts`,
`render-context.ts`. Shaders moved to `engine/shaders/entity-shaders.ts`. The
`entity-renderer.ts` facade remains in `engine/`.

### 3. Simulation.ts (DONE)
Split into `games/to-the-ocean/src/simulation/` with `sim-trig.ts`,
`simulation-buffer-writer.ts`, `simulation-commands.ts`,
`simulation-entity-manager.ts`, `simulation-tick.ts`, and a slim `simulation.ts`
core. Subsystem logic also moved into dedicated subdirectories (`boat/`,
`building/`, `camera/`, `economy/`, `fishing/`, `inventory/`, `physics/`,
`player/`, `progression/`, `survival/`, `terrain/`, `tools/`, `world/`).

### 4. TerrainGenerator.ts (DONE)
Split into `games/to-the-ocean/src/shared/terrain/` with `terrain-chunked.ts`,
`terrain-lod.ts`, `terrain-mesh.ts`, `terrain-voxel-field.ts`, `index.ts`.
Engine-side mesh pool/worker at `engine/terrain-mesh-pool.ts` and
`engine/terrain-mesh-worker.ts`.

### 5. WebGPURenderer.ts (PARTIALLY DONE)
`renderer-accessors.ts` and `renderer-input-handler.ts` extracted. The core
`webgpu-renderer.ts` (1656 lines) still contains the render frame pipeline and
scene sync logic inline.

## Remaining

### 5. WebGPURenderer.ts (1656 lines → ~3 files)
**Current:** `games/to-the-ocean/src/engine/webgpu-renderer.ts`
`renderer-accessors.ts` and `renderer-input-handler.ts` already extracted.
**Still to extract:**
- `RenderFramePipeline.ts` — `renderFrame()` with all pass orchestration
- `RendererSceneSync.ts` — `syncSceneEntities()`, entity/ship sync logic

### 6. BoatCellSystem.ts (1326 lines → ~4 files)
**Current:** `games/to-the-ocean/src/simulation/boat/boat-cell-system.ts`
Grid management, spatial queries, collision, mass, raycasting in one file.
**Split into:**
- `boat-cell-spatial.ts` — `getSpatialGrid`, `querySpatialGrid`, `hasAdjacent`, `canRemoveWithoutDisconnect`
- `boat-cell-collision.ts` — `resolveCellCollision`, `raycastCells`, `isOverShipCells`
- `boat-cell-mass.ts` — `getMassProperties`, `getShipCollisionRadius`, `invalidateMassCache`

### 7. BoatSystem.ts (1282 lines → ~4 files)
**Current:** `games/to-the-ocean/src/simulation/boat/boat-system.ts`
Player-on-ship, ship control, boarding, climbing, build mode in one file.
**Split into:**
- `boat-boarding.ts` — `tryAutoBoard`, `autoDisembark`, `disembark`, `tryStartClimb`, `updateClimb`
- `boat-control.ts` — `controlShip`, `updatePlayerOnShip`, `composeShipQuaternion`
- `boat-build-mode.ts` — `handleBuildMode`, `repairShip`

### 8. RapierPhysicsSystem.ts (871 lines → ~4 files)
**Current:** `games/to-the-ocean/src/simulation/physics/rapier-physics-system.ts`
World management, entity bodies, characters, island/ship colliders, tick in one file.
**Split into:**
- `rapier-entity-bodies.ts` — `createEntityBody`, `removeEntityBody`, `remapEntityBody`, `syncEntities`, `readBackShipPositions`
- `rapier-characters.ts` — `createCharacter`, `removeCharacter`, `remapCharacter`, `tickPlayers`
- `rapier-colliders.ts` — `rebuildShipShape`, `buildAllBoatColliders`, `rebuildIslandCollider`, `buildIslandTrimeshColliders`, `doRebuildIslandChunks`

### 9. SceneInspector.ts (445 lines)
**Current:** `games/to-the-ocean/src/engine/scene-inspector.ts`
Now extends `BaseSceneInspector` from `@downdraft/plugin-devtools`. At 445 lines it
is below the original threshold for splitting. GPU info and profiling logic largely
moved to the plugin. **No further split needed** unless it grows again.

## Execution Strategy
1. Extract modules with clean import boundaries first
2. Original files become thin facades that re-export
3. No behavior changes — pure structural refactoring
4. Verify build after each file decomposition (`bun run tsc`)
