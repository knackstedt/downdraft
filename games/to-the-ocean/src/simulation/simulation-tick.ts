// Tick orchestration — extracted from Simulation.ts

import { InputBufferReader, PLR_FLAG } from "@downdraft/core";
import { WeatherSystem } from "@downdraft/library-weather";
import { processSpoilage } from "@to-the-ocean/plugin-inventory";
import { SIM_TICK_DT } from "../shared/constants";
import {
    collectShoreSources,
    type ShoreSource,
} from "../shared/shore-damping";
import { BiomeType, EntityType, SimToMainMessage } from "../shared/types";
import { BoatCellSystem } from "./boat/boat-cell-system";
import { BoatSystem } from "./boat/boat-system";
import { PlaceableSystem } from "./building/placeable-system";
import { MarketSystem } from "./economy/market-system";
import { SimEcsWorld } from "./ecs/sim-ecs-world";
import { PLANT_DATA_SLOTS, PlantSystem } from "./farming/plant-system";
import { FishingSystem } from "./fishing/fishing-system";
import { GameModeManager } from "./gamemode/game-mode-manager";
import { PlayerMoveRequest, RapierPhysicsSystem } from "./physics/rapier-physics-system";
import { PlayerManager } from "./player/player-manager";
import { ProgressionTree } from "./progression/progression-tree";
import { SeasonSystem } from "./season/season-system";
import type { SimEntity, SimPlayer } from "./simulation";
import {
    broadcastShipHoldUpdate,
    updateWaterBuffer,
    writeToBuffer,
    type SimulationBufferWriterAccess,
} from "./simulation-buffer-writer";
import {
    checkNightSkip,
    determineCauseOfDeath,
    getEntitySlot,
    getPlayerCenterX,
    getPlayerCenterZ,
    type SimulationEntityManagerAccess,
} from "./simulation-entity-manager";
import { SurvivalBiomeAdapter, SurvivalSystem } from "./survival/survival-system";
import { TerrainSystem } from "./terrain/terrain-system";
import { ToolSystem } from "./tools/tool-system";
import { BiomeSystem } from "./world/biome-system";
import { ChunkManager } from "./world/chunk-manager";
import { IslandManager } from "./world/island-manager";
import { PortSystem } from "./world/port-system";

export interface SimulationTickAccess extends SimulationBufferWriterAccess, SimulationEntityManagerAccess {
  inputReader: InputBufferReader;
  weatherSystem: WeatherSystem;
  chunkManager: ChunkManager;
  portSystem: PortSystem;
  islandManager: IslandManager;
  terrainSystem: TerrainSystem;
  boatSystem: BoatSystem;
  boatCellSystem: BoatCellSystem;
  marketSystem: MarketSystem;
  survivalSystem: SurvivalSystem;
  survivalBiomeAdapter: SurvivalBiomeAdapter;
  seasonSystem: SeasonSystem;
  plantSystem: PlantSystem;
  placeableSystem: PlaceableSystem;
  biomeSystem: BiomeSystem;
  fishingSystem: FishingSystem;
  progressionTree: ProgressionTree;
  toolSystem: ToolSystem;
  playerManager: PlayerManager;
  gameModeManager: GameModeManager;
  physics: RapierPhysicsSystem | null;
  ecs: SimEcsWorld | null;
  entities: SimEntity[];
  entityCount: number;
  players: SimPlayer[];
  playerCount: number;
  simTime: number;
  timeOfDay: number;
  totalTicks: number;
  buoyancyShoreSources: ShoreSource[];
  buoyancyShoreCount: number;
  buoyancySimTime: number;
  rules: Record<string, number | boolean>;
  reportedDead: Set<number>;
  profile?: boolean;
  _onEvent: (msg: SimToMainMessage) => void;
  spawnEntity: (type: any, opts: any) => number;
  removeEntity: (id: number) => void;
}

const perfSysTimes: { name: string; ms: number }[] = [];
const perfPlayerMoveRequests: PlayerMoveRequest[] = [];
const perfEventSystems: { name: string; ms: number }[] = [];

export async function tick(sim: SimulationTickAccess, dt: number = SIM_TICK_DT): Promise<void> {
  const tickStart = performance.now();
  sim.simTime += dt;
  sim.totalTicks++;

  // Cache player center for the whole tick — many systems read it.
  const playerX = getPlayerCenterX(sim);
  const playerZ = getPlayerCenterZ(sim);

  // Update time of day
  sim.timeOfDay += dt / (sim.gameModeManager.rules.dayDuration as number);
  if (sim.timeOfDay >= 1) sim.timeOfDay -= 1;

  // Advance season clock from total elapsed sim time
  sim.seasonSystem.tick(sim.simTime);

  // Check for night skip (all sleeping players)
  checkNightSkip(sim);

  // Update systems in order
  const sysTimes: { name: string; ms: number }[] = perfSysTimes;
  sysTimes.length = 0;
  const t0 = performance.now();
  sim.weatherSystem.tick(dt, sim.timeOfDay);
  sim.chunkManager.updateChunks(playerX, playerZ);
  const t1 = performance.now();
  sysTimes.push({ name: "weather+chunks", ms: t1 - t0 });

  // Update port entities based on newly loaded/unloaded chunks
  const nearbyPorts = sim.chunkManager.getNearbyPorts(
    playerX, playerZ, 5000,
  );
  sim.portSystem.updatePorts(nearbyPorts);

  // Spawn/despawn island entities based on loaded chunks (also spawns wild
  // forageable bushes/mushrooms on newly discovered islands).
  sim.islandManager.tick(
    (type: any, opts: any) => sim.spawnEntity(type, opts),
    (id: number) => sim.removeEntity(id),
    playerX, playerZ,
    {
      spawnEntity: (type, opts) => sim.spawnEntity(type, opts),
      registerPlant: (entityId, cropId, biome, isWild, initialStage) => {
        sim.plantSystem.plant(entityId, cropId, { isWild, biome, initialStage });
      },
    },
  );
  const t2 = performance.now();
  sysTimes.push({ name: "ports+islands", ms: t2 - t1 });

  // Process pending physics field generation (time-budgeted, avoids sim stalls)
  sim.terrainSystem.processPendingPhysicsFieldGen();
  const t3 = performance.now();
  sysTimes.push({ name: "physFieldGen", ms: t3 - t2 });

  // Phase 1: Ship controls (before buoyancy/collision so velocity is authoritative)
  sim.boatSystem.controlTick(dt, sim.inputReader, sim.players, sim.playerCount, sim.entities, sim.entityCount, sim.boatCellSystem);
  const t4 = performance.now();
  sysTimes.push({ name: "boatControl", ms: t4 - t3 });

  // Collect shore sources for water sampling before ECS step
  sim.buoyancySimTime += dt;
  if (sim.buoyancyShoreSources.length < 128) sim.buoyancyShoreSources.length = 0;
  while (sim.buoyancyShoreSources.length < 128) sim.buoyancyShoreSources.push({ x: 0, z: 0, radius: 0, cutoutRadius: 0 });
  sim.buoyancyShoreCount = collectShoreSources(sim.entities, sim.entityCount, sim.buoyancyShoreSources);
  const t5 = performance.now();
  sysTimes.push({ name: "buoyancy", ms: t5 - t4 });

  const t5a = performance.now();
  sysTimes.push({ name: "anchor", ms: t5a - t5 });

  // Compute player desired movement (WASD, gravity, swimming) before Rapier
  let playerMoveRequests: PlayerMoveRequest[] = perfPlayerMoveRequests;
  perfPlayerMoveRequests.length = 0;
  if (sim.inputReader) {
    playerMoveRequests = sim.playerManager.computeMovement(dt, sim.inputReader, sim.players, sim.playerCount, sim.entities, sim.entityCount);
  }

  // Rapier physics: entity-vs-entity collision (ships, wildlife, etc.)
  // If physics panicked and tore down its world, re-init (async) before ticking.
  if (sim.physics && !sim.physics.isInitialized()) {
    try {
      await sim.physics.init();
      console.error(`[SIM] Physics re-initialized after panic at tick ${sim.totalTicks}`);
    } catch (err) {
      console.error(`[SIM] Physics re-init failed: ${err}`);
    }
  }
  if (sim.physics?.isInitialized()) {
    const physT0 = performance.now();
    sim.physics.tick(dt, sim.entities, sim.entityCount, sim.players, sim.playerCount);
    const physT1 = performance.now();
    sim.physics.tickPlayers(sim.players, sim.playerCount, playerMoveRequests);
    const physT2 = performance.now();
    if (physT2 - physT0 > 20) {
      console.error(`[SIM] Slow physics at tick ${sim.totalTicks}: tick=${(physT1-physT0).toFixed(1)}ms tickPlayers=${(physT2-physT1).toFixed(1)}ms`);
    }
  }

  // Apply movement for skipCollision requests (onboard/piloting players)
  for (let i = 0; i < playerMoveRequests.length; i++) {
    const req = playerMoveRequests[i];
    if (!req.skipCollision) continue;
    const p = sim.players[req.playerIdx];
    if (!p || !p.active) continue;
    if (req.desiredDeltaX === 0 && req.desiredDeltaY === 0 && req.desiredDeltaZ === 0) continue;
    p.position.x += req.desiredDeltaX;
    p.position.y += req.desiredDeltaY;
    p.position.z += req.desiredDeltaZ;
  }

  // Sync player entity positions after Rapier resolved collisions
  sim.playerManager.syncEntities(sim.players, sim.playerCount, sim.entities, sim.entityCount);

  // Mark all non-static entities and all players dirty — physics moves most
  // dynamic entities every tick. Static entities (islands/ports) are only marked
  // dirty on spawn/despawn (in the entity manager), so they're skipped here.
  // This is the coarse-grained approach; finer-grained per-system dirty marking
  // can be added later for systems that only touch a subset of entities.
  const EntityFlags_Static = 1; // EntityFlags.Static = 1 << 0
  for (let i = 0; i < sim.entityCount; i++) {
    const ent = sim.entities[i];
    if (!ent) continue;
    if ((ent.flags & EntityFlags_Static) !== 0) continue;
    sim.simWriter.markEntityDirty(i);
  }
  for (let i = 0; i < sim.playerCount; i++) {
    if (sim.players[i]) sim.simWriter.markPlayerDirty(i);
  }

  const t5b = performance.now();
  sysTimes.push({ name: "playerMove+physics+sync", ms: t5b - t5 });

  const t6 = performance.now();
  sysTimes.push({ name: "collision", ms: t6 - t5b });

  // Process tool actions (gun/shovel) — may queue terrain deformations
  if (sim.inputReader) {
    sim.toolSystem.tick(dt, sim.inputReader, sim.players, sim.playerCount, sim.entities, sim.entityCount);
  }

  // Process terrain deformations (from damage sources + tools)
  sim.terrainSystem.updateIslandPositions(sim.entities, sim.entityCount);
  sim.terrainSystem.processDeformations();

  // Phase 3: Update LOD based on player distance
  sim.terrainSystem.updateLOD(
    sim.entities, sim.entityCount,
    playerX, playerZ,
  );
  sim.terrainSystem.drainLODChanges();

  // Phase 4: Queue nearby chunks for proactive generation and process with time budget
  sim.terrainSystem.queueNearbyChunksForGeneration(
    sim.entities, sim.entityCount,
    playerX, playerZ,
  );
  sim.terrainSystem.processPendingChunkGen();

  // Rebuild Rapier colliders for deformed islands
  if (sim.physics?.isInitialized()) {
    const dirtyTerrains = sim.terrainSystem.drainDirtyTerrains();
    if (dirtyTerrains.length > 0) {
      console.log(`[SIM] Found ${dirtyTerrains.length} dirty terrains, queueing physics rebuilds`);
    }
    for (let i = 0; i < dirtyTerrains.length; i++) {
      const dt_err = dirtyTerrains[i];
      const idx = getEntitySlot(sim, dt_err.entityId);
      if (idx >= 0) {
        const ent = sim.entities[idx];
        if (ent) {
          sim.physics.rebuildIslandCollider(ent, idx, dt_err.field, dt_err.dirtyMinX, dt_err.dirtyMaxX, dt_err.dirtyMinZ, dt_err.dirtyMaxZ);
        }
      }
    }
  }

  const t7 = performance.now();
  sysTimes.push({ name: "terrain", ms: t7 - t6 });

  // Phase 2: Update all ships (drag, heading, quaternion) after collision
  sim.boatSystem.updateAllShips(dt, sim.entities, sim.entityCount, sim.boatSystem.getPilotedShipIds());
  const t8 = performance.now();
  sysTimes.push({ name: "boatUpdate", ms: t8 - t7 });

  const t9 = performance.now();
  sysTimes.push({ name: "wildlife", ms: t9 - t8 });
  sim.marketSystem.tick(dt);
  sim.survivalSystem.tick(dt, sim.players, sim.playerCount, sim.timeOfDay, sim.weatherSystem, sim.survivalBiomeAdapter);

  // Plants: growth, water, season stress, mushroom spreading, bush regrow.
  sim.plantSystem.tick(
    {
      dt,
      biomeAt: (x, z) => sim.biomeSystem.getBiomeAt(x, z) as BiomeType,
      coldStress: (tol, cold, sheltered) => sim.seasonSystem.getColdStress(tol, cold, sheltered),
      heatStress: (tol, hot, sheltered) => sim.seasonSystem.getHeatStress(tol, hot, sheltered),
      isSheltered: (_planterInstanceId) => false, // TODO: roof/indoors check via boat-cell system
      spawnPlant: (cropId, x, y, z, isWild) => {
        const newId = sim.spawnEntity(EntityType.Plant, {
          position: { x, y, z },
          data: new Float32Array(PLANT_DATA_SLOTS),
        });
        if (!newId) return 0;
        sim.plantSystem.plant(newId, cropId, { isWild });
        return newId;
      },
      removeEntity: (id) => sim.removeEntity(id),
    },
    sim.entities,
    sim.entityCount,
  );
  // Flush dead plants.
  const deadPlants = sim.plantSystem.drainDead();
  for (const deadId of deadPlants) sim.removeEntity(deadId);

  const t10 = performance.now();
  sysTimes.push({ name: "market+animals+plants+pets+survival", ms: t10 - t9 });

  // Process inventory spoilage
  const gameHoursPerSecond = 24 / (sim.gameModeManager.rules.dayDuration as number);
  for (let i = 0; i < sim.playerCount; i++) {
    const p = sim.players[i];
    if (!p?.active) continue;
    processSpoilage(p.inventory, dt, gameHoursPerSecond);
  }
  // Process ship hold spoilage
  sim.shipInventories.forEach((grid) => {
    processSpoilage(grid, dt, gameHoursPerSecond);
  });

  sim.portSystem.tick(dt, sim.inputReader, sim.entities, sim.entityCount, sim.players, sim.playerCount, sim.boatSystem.getPilotedShipIds());
  sim.fishingSystem.tick(dt, sim.inputReader, sim.players, sim.playerCount);
  // Phase 3: Player tracking on ships (after final ship motion)
  sim.boatSystem.postPhysicsTick(dt, sim.inputReader, sim.players, sim.playerCount, sim.entities, sim.entityCount, sim.boatCellSystem);
  sim.progressionTree.tick(dt, sim.players, sim.playerCount);
  const t11 = performance.now();
  sysTimes.push({ name: "pirates+docking+ports+fishing+camera+boatPost+progression", ms: t11 - t10 });

  // Detect newly dead players and emit event
  for (let i = 0; i < sim.playerCount; i++) {
    const p = sim.players[i];
    if (!p?.active) continue;
    if ((p.flags & PLR_FLAG.DEAD) && !sim.reportedDead.has(p.playerId)) {
      sim.reportedDead.add(p.playerId);
      const cause = determineCauseOfDeath(p);
      sim._onEvent({
        kind: "player_died",
        data: { playerId: p.playerId, cause },
      });
    }
  }

  // Sync legacy arrays → ECS components (after legacy systems, so ECS has latest state)
  sim.ecs?.syncEntities(sim.entities, sim.entityCount);
  sim.ecs?.syncPlayers(sim.players, sim.playerCount);

  // Step ECS world (flushes commands, runs any ECS-registered systems)
  sim.ecs?.step(dt);
  // Write back ECS component changes to legacy arrays
  sim.ecs?.writeBackEntities(sim.entities, sim.entityCount);
  sim.ecs?.writeBackPlayers(sim.players, sim.playerCount);

  // Write state to SharedArrayBuffer
  writeToBuffer(sim);
  sim.boatCellSystem.writeToBuffer();

  // Broadcast ship hold + player inventory to renderer every 30 ticks (~0.5s)
  if (sim.totalTicks % 30 === 0) {
    broadcastShipHoldUpdate(sim);
  }

  // Update water heightfield (throttled by waterUpdateInterval rule)
  const waterInterval = (sim.rules.waterUpdateInterval as number) ?? 1;
  if (waterInterval <= 1 || sim.totalTicks % waterInterval === 0) {
    updateWaterBuffer(sim);
  }

  const tickEnd = performance.now();
  if (tickEnd - tickStart > 50) {
    let slowSys = "";
    for (let i = 0; i < sysTimes.length; i++) {
      const s = sysTimes[i];
      if (s.ms > 5) {
        if (slowSys) slowSys += " ";
        slowSys += `${s.name}=${s.ms.toFixed(1)}ms`;
      }
    }
    console.error(`[SIM] Slow tick ${sim.totalTicks}: ${(tickEnd - tickStart).toFixed(1)}ms total, entities=${sim.entityCount} | ${slowSys}`);
  }

  // Forward per-system timings to the main thread.
  // Throttled to every 30 ticks (~twice per second at 60fps) to avoid flooding.
  if (sim.totalTicks % 30 === 0) {
    perfEventSystems.length = 0;
    for (let i = 0; i < sysTimes.length; i++) {
      const s = sysTimes[i];
      let ps = perfEventSystems[i];
      if (!ps) {
        ps = { name: s.name, ms: s.ms };
        perfEventSystems[i] = ps;
      } else {
        ps.name = s.name;
        ps.ms = s.ms;
      }
    }
    sim._onEvent({
      kind: "perf_stats",
      data: {
        process: "sim",
        tick: sim.totalTicks,
        totalMs: tickEnd - tickStart,
        entityCount: sim.entityCount,
        playerCount: sim.playerCount,
        systems: perfEventSystems,
      },
    });
  }
}
