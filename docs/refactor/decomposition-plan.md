# Monolithic File Decomposition Plan

## Overview
9 files >40KB totaling ~16,000 lines need decomposition. Strategy: extract cohesive
concerns into separate modules, re-export from original location for backward compat.

## Priority Order (easiest → hardest)

### 1. constants.ts (914 lines → ~10 files)
**Current:** Single file with all game constants, enums, helper functions
**Split into:**
- `constants/buffer.ts` — Sim/input/water/boat buffer sizes
- `constants/player.ts` — Player health, movement, physics, inventory
- `constants/boat.ts` — BoatCellType, cell geometry, wall collision, ship physics
- `constants/fishing.ts` — Fishing minigame params
- `constants/economy.ts` — Market pricing, barge multiplier
- `constants/weather.ts` — Weather chances, rain collector
- `constants/wildlife.ts` — Spawn radius, wildlife damage
- `constants/pirates.ts` — Pirate spawn rates, treasure
- `constants/world.ts` — World seed, ocean level, island/port spacing, port data
- `constants/biome.ts` — Biome temps, names, island resources
- `constants/game.ts` — Day duration, game rules, gamemode rules, bones
- `constants/index.ts` — Re-export everything for backward compat

### 2. EntityRenderer.ts (5950 lines → ~12 files)
**Current:** 1374 lines of WGSL shaders + 4576 lines of class with 40+ methods
**Split into:**
- `shaders/entity-shaders.ts` — ENTITY_WGSL, INSTANCED_ENTITY_WGSL, LIGHT_STRUCTS, PBR_*
- `shaders/player-shaders.ts` — PLAYER_WGSL, SKINNING_COMPUTE_WGSL, SKINNED_PLAYER_WGSL
- `shaders/boat-shaders.ts` — BOAT_WGSL
- `shaders/island-shaders.ts` — ISLAND_WGSL, ISLAND_WIREFRAME_WGSL
- `shaders/effect-shaders.ts` — ROPE_WGSL, HOLO_WGSL, HITBOX_WGSL
- `shaders/noise-shaders.ts` — hash23, hash33, valueNoise3D, fbm3D, fbm3DWarp
- `EntityRenderer.ts` (core) — Class skeleton, init, pipeline creation, beginFrame, render
- `EntityMeshBuilder.ts` — rebuildBoatMesh, generateDesignMesh, getCellShape, generateCellMesh, generateFBXCellMesh, addQuad, addTri, genDeleteXCell
- `IslandMeshManager.ts` — ensureIslandMesh, ensurePortMesh, ensureDecorationMesh, rebuildIslandMesh, rebuildPortMesh, rebuildChunkedIsland, chunk streaming, cleanup
- `PlayerMeshManager.ts` — setPlayerMesh, setSkinnedPlayerMesh, addClothingPiece, setBedMesh, setPlayerTexture, dispatchSkinningCompute
- `InstancedEntityManager.ts` — writeInstanceData, uploadInstanceData, renderInstanced
- `HitboxRenderer.ts` — writeHitboxEntry, renderHitboxes, writeInstancedHitbox
- `HoloPreviewRenderer.ts` — renderHoloPreview, ensureHoloCapacity
- `AnchorRenderer.ts` — renderAnchors, writeAnchorUniform, anchor mesh generation

### 3. WebGPURenderer.ts (2232 lines → ~5 files)
**Current:** God class managing init, render loop, input, scene sync, gizmos, UI
**Split into:**
- `WebGPURenderer.ts` (core) — Class skeleton, init, render loop orchestration, destroy
- `RenderFramePipeline.ts` — renderFrame() extracted with all pass orchestration
- `RendererInputHandler.ts` — processInput, pointer lock, mouse state, builder wheel
- `RendererSceneSync.ts` — syncSceneEntities, entity/ship sync logic
- `RendererAccessors.ts` — All getters/setters (FPS, debug, hitbox, gizmo, post-process, etc.)

### 4. Simulation.ts (1549 lines → ~5 files)
**Current:** God orchestrator with 20+ subsystems, tick logic, buffer writing, commands
**Split into:**
- `Simulation.ts` (core) — Class skeleton, init, subsystem wiring, shutdown
- `SimulationTick.ts` — tick() method extracted
- `SimulationBufferWriter.ts` — writeToBuffer, updateWaterBuffer
- `SimulationCommands.ts` — handleCommand, handleWorldCommand, setSetting, setWeather
- `SimulationEntityManager.ts` — spawnEntity, removeEntity, getEntity, addPlayer, removePlayer, respawnPlayer

### 5. BoatCellSystem.ts (1333 lines → ~4 files)
**Current:** Grid management, spatial queries, collision, mass, raycasting
**Split into:**
- `BoatCellSystem.ts` (core) — Class skeleton, createBoat, removeBoat, addCell, removeCell, rotateCell
- `BoatCellSpatial.ts` — getSpatialGrid, querySpatialGrid, hasAdjacent, canRemoveWithoutDisconnect
- `BoatCellCollision.ts` — resolveCellCollision, raycastCells, isOverShipCells
- `BoatCellMass.ts` — getMassProperties, getShipCollisionRadius, invalidateMassCache

### 6. BoatSystem.ts (1257 lines → ~4 files)
**Current:** Player-on-ship, ship control, boarding, climbing, build mode
**Split into:**
- `BoatSystem.ts` (core) — Class skeleton, controlTick, postPhysicsTick, updateAllShips
- `BoatBoarding.ts` — tryAutoBoard, autoDisembark, disembark, tryStartClimb, updateClimb
- `BoatControl.ts` — controlShip, updatePlayerOnShip, composeShipQuaternion
- `BoatBuildMode.ts` — handleBuildMode, repairShip

### 7. TerrainGenerator.ts (1288 lines → ~4 files)
**Current:** Voxel field gen, chunked field, heightfield, trimesh, port field
**Split into:**
- `TerrainGenerator.ts` (core) — getLODVoxelSize, isChunkEmpty, generateIslandBlobs, re-exports
- `TerrainVoxelField.ts` — generateVoxelField, generateVoxelFieldCore, computeDensityAt
- `TerrainChunked.ts` — createChunkedVoxelField, generateChunkData, ensureChunkGenerated, materializeChunkForMesh, getChunkMeshSubRegion
- `TerrainMesh.ts` — sampleTerrainHeight, sampleTerrainHeightChunked, generateTerrainHeightfield, generateTerrainTrimesh, generateTerrainTrimeshSubRegion, generatePortVoxelField

### 8. SceneInspector.ts (1118 lines → ~3 files)
**Current:** GPU info, IPC fetching, profiling, debug overlays
**Split into:**
- `SceneInspector.ts` (core) — Class skeleton, init, destroy
- `SceneInspectorGPU.ts` — GPU info gathering, adapter info, Vulkan validation
- `SceneInspectorProfiling.ts` — Performance profiling, GC profiling, telemetry

### 9. RapierPhysicsSystem.ts (996 lines → ~4 files)
**Current:** World management, entity bodies, characters, island/ship colliders, tick
**Split into:**
- `RapierPhysicsSystem.ts` (core) — Class skeleton, init, recreateWorld, tick, shutdown
- `RapierEntityBodies.ts` — createEntityBody, removeEntityBody, remapEntityBody, syncEntities, readBackShipPositions
- `RapierCharacters.ts` — createCharacter, removeCharacter, remapCharacter, tickPlayers
- `RapierColliders.ts` — rebuildShipShape, buildAllBoatColliders, rebuildIslandCollider, buildIslandTrimeshColliders, doRebuildIslandChunks

## Execution Strategy
1. Extract modules with clean import boundaries first
2. Original files become thin facades that re-export
3. No behavior changes — pure structural refactoring
4. Verify build after each file decomposition
