// ============================================================================
// Simulation — main orchestrator for all game systems
// ============================================================================

import {
    MAX_ENTITIES, MAX_PLAYERS,
    NIGHT_END_FRAC,
    NIGHT_START_FRAC,
    PLAYER_MAX_HEALTH, PLAYER_MAX_HUNGER,
    PLAYER_MAX_OXYGEN, PLAYER_MAX_TEMPERATURE,
    PLAYER_MAX_THIRST,
    SIM_TICK_DT
} from "../shared/constants";
import { InputBufferReader } from "../shared/input-buffer";
import { ENT, PLR, PLR_FLAG, SimBufferWriter } from "../shared/sim-buffer";
import {
    BiomeType,
    CameraMode,
    EntityId,
    EntityType,
    GameMode,
    PlayerId,
    SimCommand,
    SimToMainMessage,
    WeatherType,
    WorldCommand
} from "../shared/types";
import { WaterBufferWriter } from "../shared/water-buffer";

import type { JobScheduler } from "@downdraft/core/ecs/job-system";
import { BoatBufferWriter } from "../shared/boat-buffer";
import { validateBoatDesign } from "../shared/boat-design/validators";
import { BOAT_HOLD_INV_HEIGHT, BOAT_HOLD_INV_WIDTH, PLAYER_HEIGHT, PLAYER_INV_HEIGHT, PLAYER_INV_WIDTH, SHIP_DATA, SHIP_DATA_SLOTS } from "../shared/constants";
import { WorldGenerator } from "../shared/world/WorldGenerator";
import { AnchorSystem } from "./boat/AnchorSystem";
import { BoatCellSystem } from "./boat/BoatCellSystem";
import { BoatDesignSystem } from "./boat/BoatDesignSystem";
import { BoatSystem } from "./boat/BoatSystem";
import { DockingSystem } from "./building/DockingSystem";
import { PlaceableSystem } from "./building/PlaceableSystem";
import { CameraController } from "./camera/CameraController";
import { MarketSystem } from "./economy/MarketSystem";
import { SimEcsWorld } from "./ecs/SimEcsWorld";
import { AnimalSystem } from "./farming/AnimalSystem";
import { PetSystem } from "./farming/PetSystem";
import { PlantSystem } from "./farming/PlantSystem";
import { FishingSystem } from "./fishing/FishingSystem";
import { GameModeManager } from "./gamemode/GameModeManager";
import { InventoryGrid, addItem, createGrid, deserializeGrid, getGridStateForUI, moveItem, processSpoilage, removeItem, serializeGrid } from "./inventory/InventorySystem";
import { BuoyancySystem } from "./physics/BuoyancySystem";
import { CollisionSystem } from "./physics/CollisionSystem";
import { PlayerMoveRequest, RapierPhysicsSystem } from "./physics/RapierPhysicsSystem";
import { StructureIntegrity } from "./physics/StructureIntegrity";
import { PirateSystem } from "./pirates/PirateSystem";
import { LicenseSystem } from "./player/LicenseSystem";
import { PlayerManager } from "./player/PlayerManager";
import { ProgressionTree } from "./progression/ProgressionTree";
import { SurvivalBiomeAdapter, SurvivalSystem } from "./survival/SurvivalSystem";
import { TerrainSystem } from "./terrain/TerrainSystem";
import { ToolSystem } from "./tools/ToolSystem";
import { WeatherSystem } from "./weather/WeatherSystem";
import { WildlifeManager } from "./wildlife/WildlifeManager";
import { BiomeSystem } from "./world/BiomeSystem";
import { ChunkManager } from "./world/ChunkManager";
import { IslandManager } from "./world/IslandManager";
import { PortSystem } from "./world/PortSystem";

export class Simulation {
  private simWriter: SimBufferWriter;
  private inputReader: InputBufferReader;
  private waterWriter: WaterBufferWriter;
  private boatWriter: BoatBufferWriter;
  private boatBuffer: SharedArrayBuffer;
  private config: { seed: number; gamemode: number; rules: Record<string, number | boolean>; isDev?: boolean };
  private _onEvent: (msg: SimToMainMessage) => void;

  // Entity management — generational indices prevent stale-handle corruption
  private entities: SimEntity[] = [];
  private entityCount = 0;
  private nextEntityId = 1;
  private freeSlots: number[] = [];
  private generations = new Uint32Array(MAX_ENTITIES);
  private entityIndex = new Map<EntityId, { slot: number; gen: number }>();

  // Players
  private players: SimPlayer[] = [];
  private playerCount = 0;

  // Time
  private timeOfDay = 0.3; // start at morning
  private totalTicks = 0;

  // Systems
  private worldGen: WorldGenerator;
  private chunkManager: ChunkManager;
  private biomeSystem: BiomeSystem;
  private weatherSystem: WeatherSystem;
  private buoyancySystem: BuoyancySystem;
  private structureIntegrity: StructureIntegrity;
  private collisionSystem: CollisionSystem;
  private physics: RapierPhysicsSystem | null = null;
  private wildlifeManager: WildlifeManager;
  private marketSystem: MarketSystem;
  private animalSystem: AnimalSystem;
  private plantSystem: PlantSystem;
  private petSystem: PetSystem;
  private survivalSystem: SurvivalSystem;
  private survivalBiomeAdapter: SurvivalBiomeAdapter;
  private pirateSystem: PirateSystem;
  private dockingSystem: DockingSystem;
  private placeableSystem: PlaceableSystem;
  private fishingSystem: FishingSystem;
  private playerManager: PlayerManager;
  private licenseSystem: LicenseSystem;
  private cameraController: CameraController;
  private gameModeManager: GameModeManager;
  private progressionTree: ProgressionTree;
  private boatSystem: BoatSystem;
  private boatCellSystem: BoatCellSystem;
  private boatDesignSystem: BoatDesignSystem;
  private anchorSystem: AnchorSystem;
  onDesignChanged: ((entityId: number, designJson: string) => void) | null = null;
  onDesignRemoved: ((entityId: number) => void) | null = null;
  private portSystem: PortSystem;
  private islandManager: IslandManager;
  private terrainSystem: TerrainSystem;
  private toolSystem: ToolSystem;
  private shipInventories = new Map<number, InventoryGrid>();
  private jobScheduler: JobScheduler | null = null;
  private ecs: SimEcsWorld | null = null;

  // State
  private gamemode = GameMode.Survival;
  private rules: Record<string, number | boolean>;
  private seed: number;
  private reportedDead = new Set<number>();
  private seaState = 0.5; // smoothed wind-driven wave amplitude factor (0..1)

  // --- Trig lookup table for water wave computation ---
  // 4096 entries over 2π — linear interpolation, ~16-bit precision.
  // Replaces ~458K Math.sin/Math.cos calls per tick with array lookups.
  private static readonly SIN_TABLE_SIZE = 4096;
  private static readonly SIN_TABLE: Float32Array = (() => {
    const t = new Float32Array(Simulation.SIN_TABLE_SIZE);
    for (let i = 0; i < Simulation.SIN_TABLE_SIZE; i++) {
      t[i] = Math.sin((i / Simulation.SIN_TABLE_SIZE) * Math.PI * 2);
    }
    return t;
  })();
  private static readonly COS_TABLE: Float32Array = (() => {
    const t = new Float32Array(Simulation.SIN_TABLE_SIZE);
    for (let i = 0; i < Simulation.SIN_TABLE_SIZE; i++) {
      t[i] = Math.cos((i / Simulation.SIN_TABLE_SIZE) * Math.PI * 2);
    }
    return t;
  })();
  private static readonly SIN_SCALE = Simulation.SIN_TABLE_SIZE / (Math.PI * 2);
  private static readonly SIN_MASK = Simulation.SIN_TABLE_SIZE - 1;

  private static fastSin(x: number): number {
    const idx = ((x * Simulation.SIN_SCALE) | 0) & Simulation.SIN_MASK;
    const frac = x * Simulation.SIN_SCALE - (x * Simulation.SIN_SCALE | 0);
    const a = Simulation.SIN_TABLE[idx];
    const b = Simulation.SIN_TABLE[(idx + 1) & Simulation.SIN_MASK];
    return a + (b - a) * frac;
  }

  private static fastCos(x: number): number {
    const idx = ((x * Simulation.SIN_SCALE) | 0) & Simulation.SIN_MASK;
    const frac = x * Simulation.SIN_SCALE - (x * Simulation.SIN_SCALE | 0);
    const a = Simulation.COS_TABLE[idx];
    const b = Simulation.COS_TABLE[(idx + 1) & Simulation.SIN_MASK];
    return a + (b - a) * frac;
  }

  constructor(
    simWriter: SimBufferWriter,
    inputReader: InputBufferReader,
    waterWriter: WaterBufferWriter,
    config: { seed: number; gamemode: number; rules: Record<string, number | boolean>; isDev?: boolean },
    onEvent: (msg: SimToMainMessage) => void,
    boatWriter?: BoatBufferWriter,
    boatBuffer?: SharedArrayBuffer,
  ) {
    this.simWriter = simWriter;
    this.inputReader = inputReader;
    this.waterWriter = waterWriter;
    this.config = config;
    this.seed = config.seed;
    this.rules = config.rules;
    this.gamemode = config.gamemode as unknown as GameMode;
    this._onEvent = onEvent;

    if (boatWriter && boatBuffer) {
      this.boatWriter = boatWriter;
      this.boatBuffer = boatBuffer;
    } else {
      this.boatBuffer = new SharedArrayBuffer(0);
      this.boatWriter = new BoatBufferWriter(this.boatBuffer);
    }

    // Initialize systems
    this.worldGen = new WorldGenerator(this.seed);
    this.worldGen.setGenerationRates(
      (this.rules.portGenerationRate as number) ?? 0.015,
      (this.rules.islandGenerationRate as number) ?? 0.00000025,
    );
    this.chunkManager = new ChunkManager(this.worldGen);
    this.biomeSystem = new BiomeSystem();
    this.weatherSystem = new WeatherSystem(this.biomeSystem, (config.rules.weatherIntensity as number) ?? 1.0);
    this.buoyancySystem = new BuoyancySystem(this.waterWriter);
    this.structureIntegrity = new StructureIntegrity();
    this.collisionSystem = new CollisionSystem();
    this.boatCellSystem = new BoatCellSystem();
    this.boatDesignSystem = new BoatDesignSystem();
    this.physics = new RapierPhysicsSystem(this.boatCellSystem);
    this.physics.setBoatDesignSystem(this.boatDesignSystem);
    this.buoyancySystem.setBoatCellSystem(this.boatCellSystem);
    this.buoyancySystem.setBoatDesignSystem(this.boatDesignSystem);
    this.boatSystem = new BoatSystem();
    this.boatSystem.setBoatDesignSystem(this.boatDesignSystem);
    this.anchorSystem = new AnchorSystem();
    this.boatSystem.setAnchorSystem(this.anchorSystem);
    this.wildlifeManager = new WildlifeManager(this.chunkManager, this.biomeSystem, this.boatSystem);
    this.marketSystem = new MarketSystem();
    this.animalSystem = new AnimalSystem();
    this.plantSystem = new PlantSystem();
    this.petSystem = new PetSystem();
    this.survivalBiomeAdapter = new SurvivalBiomeAdapter(this.chunkManager, this.biomeSystem);
    this.survivalSystem = new SurvivalSystem(this.rules);
    this.pirateSystem = new PirateSystem(this.chunkManager);
    this.dockingSystem = new DockingSystem();
    this.placeableSystem = new PlaceableSystem();
    this.fishingSystem = new FishingSystem(this.biomeSystem, this.weatherSystem, this.waterWriter, onEvent);
    this.playerManager = new PlayerManager(this.waterWriter, config.isDev ?? false);
    this.licenseSystem = new LicenseSystem();
    this.cameraController = new CameraController();
    this.gameModeManager = new GameModeManager(this.gamemode, this.rules);
    this.progressionTree = new ProgressionTree();
    this.portSystem = new PortSystem();
    this.islandManager = new IslandManager(this.chunkManager);
    this.terrainSystem = new TerrainSystem();
    this.physics.setTerrainSystem(this.terrainSystem);
    this.collisionSystem.setTerrainSystem(this.terrainSystem);
    this.toolSystem = new ToolSystem(this.terrainSystem);
    this.boatWriter.init();
    this.boatCellSystem.setBufferWriter(this.boatWriter);

    // Wire PortSystem callbacks
    this.portSystem.onSpawnPortEntity = (port, scale, data, flags) => {
      return this.spawnEntity(EntityType.Port, {
        position: port.position,
        scale,
        health: 100,
        maxHealth: 100,
        flags,
        data,
      });
    };
    this.portSystem.onRemovePortEntity = (entityId) => {
      this.removeEntity(entityId);
    };
    this.portSystem.onInitPortMarket = (portId, size) => {
      this.marketSystem.initPortMarket(portId, size);
    };
    this.portSystem.setBoatCellSystem(this.boatCellSystem);

    // Initialize ECS bridge (parallel to legacy arrays, enables incremental migration)
    this.ecs = new SimEcsWorld();
  }

  async init(): Promise<void> {
    // Generate initial world around origin
    this.chunkManager.updateChunks(0, 0);

    // Spawn initial player ship
    const shipId = this.spawnEntity(EntityType.Ship, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: 1,
      health: 100,
      maxHealth: 100,
      data: new Float32Array(SHIP_DATA_SLOTS), // throttle, steering, speed, heading, hullPct, repairing, pitch, roll, anchorX, anchorZ
    });

    // Initialize boat cell grid for the ship
    this.boatCellSystem.createBoat(shipId, "pontoon");
    this.shipInventories.set(shipId, createGrid(BOAT_HOLD_INV_WIDTH, BOAT_HOLD_INV_HEIGHT));

    // Spawn port entities for nearby ports and init their markets
    const nearbyPorts = this.chunkManager.getNearbyPorts(0, 0, 5000);
    this.portSystem.updatePorts(nearbyPorts);

    // Spawn island entities for nearby islands
    this.islandManager.tick(
      this.spawnEntity.bind(this), this.removeEntity.bind(this),
      0, 0,
    );

    // Wire boat cell/design changes to rebuild ship physics shapes
    this.boatCellSystem.setOnCellsChanged((entityId) => {
      if (!this.physics?.isInitialized()) return;
      const idx = this.getEntitySlot(entityId);
      if (idx >= 0) {
        const ent = this.entities[idx];
        if (ent) this.physics.rebuildShipShape(ent, idx);
      }
    });
    this.boatDesignSystem.setOnDesignChanged((entityId, design) => {
      if (this.physics?.isInitialized()) {
        const idx = this.getEntitySlot(entityId);
        if (idx >= 0) {
          const ent = this.entities[idx];
          if (ent) this.physics.rebuildShipShape(ent, idx);
        }
      }
      this.onDesignChanged?.(entityId, JSON.stringify(design));
    });

    // Initialize Rapier physics (async — loads WASM)
    if (this.physics) {
      await this.physics.init();
    }

    // Write initial state to SAB
    this.writeToBuffer();
    this.boatCellSystem.markBufferDirty();
    this.boatCellSystem.writeToBuffer();
  }

  setJobScheduler(scheduler: JobScheduler): void {
    this.jobScheduler = scheduler;
    this.buoyancySystem.setJobScheduler(scheduler);
  }

  async tick(): Promise<void> {
    const tickStart = performance.now();
    const dt = SIM_TICK_DT;
    this.totalTicks++;

    // Update time of day
    this.timeOfDay += dt / (this.gameModeManager.rules.dayDuration as number);
    if (this.timeOfDay >= 1) this.timeOfDay -= 1;

    // Check for night skip (all sleeping players)
    this.checkNightSkip();

    // Sync legacy arrays → ECS components (enables query-based system migration)
    this.ecs?.syncEntities(this.entities, this.entityCount);
    this.ecs?.syncPlayers(this.players, this.playerCount);

    // Update systems in order
    const sysTimes: { name: string; ms: number }[] = [];
    const t0 = performance.now();
    this.weatherSystem.tick(dt, this.timeOfDay);
    this.chunkManager.updateChunks(this.getPlayerCenterX(), this.getPlayerCenterZ());
    const t1 = performance.now();
    sysTimes.push({ name: "weather+chunks", ms: t1 - t0 });

    // Update port entities based on newly loaded/unloaded chunks
    const nearbyPorts = this.chunkManager.getNearbyPorts(
      this.getPlayerCenterX(), this.getPlayerCenterZ(), 5000,
    );
    this.portSystem.updatePorts(nearbyPorts);

    // Spawn/despawn island entities based on loaded chunks
    this.islandManager.tick(
      this.spawnEntity.bind(this), this.removeEntity.bind(this),
      this.getPlayerCenterX(), this.getPlayerCenterZ(),
    );
    const t2 = performance.now();
    sysTimes.push({ name: "ports+islands", ms: t2 - t1 });

    // Process pending physics field generation (time-budgeted, avoids sim stalls)
    this.terrainSystem.processPendingPhysicsFieldGen();

    this.structureIntegrity.tick(dt, this.entities, this.entityCount, this.boatCellSystem);
    const t3 = performance.now();
    sysTimes.push({ name: "structureIntegrity", ms: t3 - t2 });

    // Phase 1: Ship controls (before buoyancy/collision so velocity is authoritative)
    this.boatSystem.controlTick(dt, this.inputReader, this.players, this.playerCount, this.entities, this.entityCount, this.boatCellSystem);
    const t4 = performance.now();
    sysTimes.push({ name: "boatControl", ms: t4 - t3 });

    // BuoyancySystem: use parallel path when scheduler is available, else inline
    if (this.jobScheduler) {
      await this.buoyancySystem.tickParallel(dt, this.entities, this.entityCount);
    } else {
      this.buoyancySystem.tick(dt, this.entities, this.entityCount);
    }
    const t5 = performance.now();
    sysTimes.push({ name: "buoyancy", ms: t5 - t4 });

    // AnchorSystem applies spring-force constraint to anchored ships
    this.anchorSystem.tick(dt, this.entities, this.entityCount);
    const t5a = performance.now();
    sysTimes.push({ name: "anchor", ms: t5a - t5 });

    // Compute player desired movement (WASD, gravity, swimming) before Rapier
    let playerMoveRequests: PlayerMoveRequest[] = [];
    if (this.inputReader) {
      playerMoveRequests = this.playerManager.computeMovement(dt, this.inputReader, this.players, this.playerCount, this.entities, this.entityCount);
    }

    // Rapier physics: entity-vs-entity collision (ships, wildlife, etc.)
    if (this.physics?.isInitialized()) {
      const physT0 = performance.now();
      this.physics.tick(dt, this.entities, this.entityCount, this.players, this.playerCount);
      const physT1 = performance.now();
      // Resolve player movement against world colliders (ports, ships, islands)
      this.physics.tickPlayers(this.players, this.playerCount, playerMoveRequests);
      const physT2 = performance.now();
      if (physT2 - physT0 > 20) {
        console.error(`[SIM] Slow physics at tick ${this.totalTicks}: tick=${(physT1-physT0).toFixed(1)}ms tickPlayers=${(physT2-physT1).toFixed(1)}ms`);
      }
    }

    // Apply movement for skipCollision requests (onboard/piloting players) —
    // they bypass Rapier but still need WASD/gravity deltas applied.
    // postPhysicsTick will handle ship tracking on top of this.
    for (let i = 0; i < playerMoveRequests.length; i++) {
      const req = playerMoveRequests[i];
      if (!req.skipCollision) continue; // already handled by Rapier
      const p = this.players[req.playerIdx];
      if (!p || !p.active) continue;
      // Noclip/freecam already applied movement in computeMovement (deltas are 0 here)
      if (req.desiredDeltaX === 0 && req.desiredDeltaY === 0 && req.desiredDeltaZ === 0) continue;
      p.position.x += req.desiredDeltaX;
      p.position.y += req.desiredDeltaY;
      p.position.z += req.desiredDeltaZ;
    }

    // Sync player entity positions after Rapier resolved collisions
    this.playerManager.syncEntities(this.players, this.playerCount, this.entities, this.entityCount);
    const t5b = performance.now();
    sysTimes.push({ name: "playerMove+physics+sync", ms: t5b - t5 });

    // CollisionSystem: non-ship, non-player entity collisions only
    this.collisionSystem.tick(dt, this.entities, this.entityCount, this.players, this.playerCount, this.boatDesignSystem, this.boatSystem.getPilotedShipIds(), this.boatCellSystem, (this.rules.collisionLodDistance as number) ?? 250);
    const t6 = performance.now();
    sysTimes.push({ name: "collision", ms: t6 - t5b });

    // Process tool actions (gun/shovel) — may queue terrain deformations
    if (this.inputReader) {
      this.toolSystem.tick(dt, this.inputReader, this.players, this.playerCount, this.entities, this.entityCount);
    }

    // Process terrain deformations (from damage sources + tools)
    this.terrainSystem.updateIslandPositions(this.entities, this.entityCount);
    this.terrainSystem.processDeformations();

    // Phase 3: Update LOD based on player distance (regenerate chunked render field at new resolution)
    // Physics field is NOT regenerated — it uses a fixed resolution set at island registration time.
    this.terrainSystem.updateLOD(
      this.entities, this.entityCount,
      this.getPlayerCenterX(), this.getPlayerCenterZ(),
    );
    // Drain LOD changes (forwarded to renderer via sim worker broadcast)
    this.terrainSystem.drainLODChanges();

    // Phase 4: Queue nearby chunks for proactive generation and process with time budget
    this.terrainSystem.queueNearbyChunksForGeneration(
      this.entities, this.entityCount,
      this.getPlayerCenterX(), this.getPlayerCenterZ(),
    );
    this.terrainSystem.processPendingChunkGen();

    // Rebuild Rapier colliders for deformed islands
    if (this.physics?.isInitialized()) {
      const dirtyTerrains = this.terrainSystem.drainDirtyTerrains();
      if (dirtyTerrains.length > 0) {
        console.log(`[SIM] Found ${dirtyTerrains.length} dirty terrains, queueing physics rebuilds`);
      }
      for (let i = 0; i < dirtyTerrains.length; i++) {
        const dt = dirtyTerrains[i];
        const idx = this.getEntitySlot(dt.entityId);
        if (idx >= 0) {
          const ent = this.entities[idx];
          if (ent) {
            this.physics.rebuildIslandCollider(ent, idx, dt.field, dt.dirtyMinX, dt.dirtyMaxX, dt.dirtyMinZ, dt.dirtyMaxZ);
          }
        }
      }
    }

    const t7 = performance.now();
    sysTimes.push({ name: "terrain", ms: t7 - t6 });

    // Phase 2: Update all ships (drag, heading, quaternion) after collision
    this.boatSystem.updateAllShips(dt, this.entities, this.entityCount, this.boatSystem.getPilotedShipIds());
    const t8 = performance.now();
    sysTimes.push({ name: "boatUpdate", ms: t8 - t7 });

    this.wildlifeManager.tick(dt, this.entities, this.entityCount, this.players, this.playerCount, this.spawnEntity.bind(this), this.removeEntity.bind(this));
    const t9 = performance.now();
    sysTimes.push({ name: "wildlife", ms: t9 - t8 });
    this.marketSystem.tick(dt);
    // AnimalSystem now runs as ECS system (EcsAnimalSystem) during ecs.step()
    // this.animalSystem.tick(dt, this.entities, this.entityCount);
    this.plantSystem.tick(dt, this.entities, this.entityCount);
    this.petSystem.tick(dt, this.entities, this.entityCount, this.players, this.playerCount);
    this.survivalSystem.tick(dt, this.players, this.playerCount, this.timeOfDay, this.weatherSystem, this.survivalBiomeAdapter);
    const t10 = performance.now();
    sysTimes.push({ name: "market+animals+plants+pets+survival", ms: t10 - t9 });

    // Process inventory spoilage
    const gameHoursPerSecond = 24 / (this.gameModeManager.rules.dayDuration as number);
    for (let i = 0; i < this.playerCount; i++) {
      const p = this.players[i];
      if (!p?.active) continue;
      processSpoilage(p.inventory, dt, gameHoursPerSecond);
    }
    // Process ship hold spoilage
    this.shipInventories.forEach((grid) => {
      processSpoilage(grid, dt, gameHoursPerSecond);
    });
    this.pirateSystem.tick(dt, this.entities, this.entityCount, this.players, this.playerCount, this.chunkManager);
    this.dockingSystem.tick(dt, this.entities, this.entityCount);

    this.portSystem.tick(dt, this.inputReader, this.entities, this.entityCount, this.players, this.playerCount, this.boatSystem.getPilotedShipIds());
    this.fishingSystem.tick(dt, this.inputReader, this.players, this.playerCount);
    this.cameraController.tick(dt, this.inputReader, this.players, this.playerCount, this.entities, this.entityCount);
    // Phase 3: Player tracking on ships (after final ship motion)
    this.boatSystem.postPhysicsTick(dt, this.inputReader, this.players, this.playerCount, this.entities, this.entityCount, this.boatCellSystem);
    this.progressionTree.tick(dt, this.players, this.playerCount);
    const t11 = performance.now();
    sysTimes.push({ name: "pirates+docking+ports+fishing+camera+boatPost+progression", ms: t11 - t10 });

    // Detect newly dead players and emit event
    for (let i = 0; i < this.playerCount; i++) {
      const p = this.players[i];
      if (!p?.active) continue;
      if ((p.flags & PLR_FLAG.DEAD) && !this.reportedDead.has(p.playerId)) {
        this.reportedDead.add(p.playerId);
        const cause = this.determineCauseOfDeath(p);
        this._onEvent({
          kind: "player_died",
          data: { playerId: p.playerId, cause },
        });
      }
    }

    // Write state to SharedArrayBuffer
    this.writeToBuffer();
    this.boatCellSystem.writeToBuffer();

    // Broadcast ship hold + player inventory to renderer every 30 ticks (~0.5s)
    if (this.totalTicks % 30 === 0) {
      this.broadcastShipHoldUpdate();
    }

    // Update water heightfield (throttled by waterUpdateInterval rule)
    const waterInterval = (this.rules.waterUpdateInterval as number) ?? 1;
    if (waterInterval <= 1 || this.totalTicks % waterInterval === 0) {
      this.updateWaterBuffer();
    }

    // Step ECS world (flushes commands, runs any ECS-registered systems)
    this.ecs?.step(dt);
    // Write back ECS component changes to legacy arrays
    this.ecs?.writeBackEntities(this.entities, this.entityCount);
    this.ecs?.writeBackPlayers(this.players, this.playerCount);

    const tickEnd = performance.now();
    if (tickEnd - tickStart > 50) {
      const slowSys = sysTimes.filter(s => s.ms > 5).map(s => `${s.name}=${s.ms.toFixed(1)}ms`).join(" ");
      console.error(`[SIM] Slow tick ${this.totalTicks}: ${(tickEnd - tickStart).toFixed(1)}ms total, entities=${this.entityCount} | ${slowSys}`);
    }
  }

  private writeToBuffer(): void {
    // Write header
    this.simWriter.setTimeOfDay(this.timeOfDay);
    const weather = this.weatherSystem.getState();
    this.simWriter.setWeather(weather.type, weather.intensity);
    this.simWriter.setWind(weather.windSpeed, weather.windDirection.x, weather.windDirection.z);
    this.simWriter.setVisibility(weather.visibility);
    this.simWriter.setAmbientTemp(weather.temperature);
    this.simWriter.setEntityCount(this.entityCount);
    this.simWriter.setPlayerCount(this.playerCount);
    this.simWriter.setGamemode(Object.values(GameMode).indexOf(this.gamemode));

    // Physics stats
    const physStats = this.physics?.getStats();
    this.simWriter.setPhysicsInitialized(physStats?.initialized ? 1 : 0);
    this.simWriter.setPhysicsFailed(physStats?.failed ? 1 : 0);
    this.simWriter.setPhysicsBodyCount(physStats?.bodyCount ?? 0);
    this.simWriter.setPhysicsTickCount(physStats?.tickCount ?? 0);

    // Chunk stats
    this.simWriter.setChunkCount(this.chunkManager.getLoadedChunkCount());

    // Write player active bitmask
    let activeMask = 0;
    for (let i = 0; i < this.playerCount; i++) {
      if (this.players[i].active) activeMask |= (1 << i);
    }
    this.simWriter.setActivePlayers(activeMask);

    // Sync player entities with player positions
    for (let i = 0; i < this.playerCount; i++) {
      const p = this.players[i];
      if (!p) continue;
      const entIdx = this.getEntitySlot(p.entityId);
      if (entIdx >= 0) {
        const ent = this.entities[entIdx];
        if (ent) {
          ent.position.x = p.position.x;
          ent.position.y = p.position.y;
          ent.position.z = p.position.z;
          ent.rotation.x = 0;
          ent.rotation.y = Math.sin((-p.bodyHeading + Math.PI) / 2);
          ent.rotation.z = 0;
          ent.rotation.w = Math.cos((-p.bodyHeading + Math.PI) / 2);
        }
      }
    }

    // Write entity data
    for (let i = 0; i < this.entityCount; i++) {
      const ent = this.entities[i];
      if (!ent) continue;
      const f32 = this.simWriter.getEntityF32(i);
      const u32 = this.simWriter.getEntityU32(i);

      f32[ENT.POS_X] = Number.isFinite(ent.position.x) ? ent.position.x : 0;
      f32[ENT.POS_Y] = Number.isFinite(ent.position.y) ? ent.position.y : 0;
      f32[ENT.POS_Z] = Number.isFinite(ent.position.z) ? ent.position.z : 0;
      f32[ENT.SCALE] = Number.isFinite(ent.scale) ? ent.scale : 1;
      f32[ENT.ROT_X] = Number.isFinite(ent.rotation.x) ? ent.rotation.x : 0;
      f32[ENT.ROT_Y] = Number.isFinite(ent.rotation.y) ? ent.rotation.y : 0;
      f32[ENT.ROT_Z] = Number.isFinite(ent.rotation.z) ? ent.rotation.z : 0;
      f32[ENT.ROT_W] = Number.isFinite(ent.rotation.w) ? ent.rotation.w : 1;
      f32[ENT.VEL_X] = Number.isFinite(ent.velocity.x) ? ent.velocity.x : 0;
      f32[ENT.VEL_Y] = Number.isFinite(ent.velocity.y) ? ent.velocity.y : 0;
      f32[ENT.VEL_Z] = Number.isFinite(ent.velocity.z) ? ent.velocity.z : 0;
      f32[ENT.HEALTH] = Number.isFinite(ent.health) ? ent.health : 0;
      f32[ENT.MAX_HEALTH] = Number.isFinite(ent.maxHealth) ? ent.maxHealth : 0;
      u32[ENT.TYPE] = ent.type;
      u32[ENT.FLAGS] = ent.flags;
      u32[ENT.ID] = ent.id;
      u32[ENT.PARENT_ID] = ent.parentId;
      u32[ENT.CHUNK_X] = ent.chunkX;
      u32[ENT.CHUNK_Z] = ent.chunkZ;

      // Type-specific data (data[0..9] — slots 8-9 use reserved space for anchor XZ)
      if (ent.data) {
        for (let j = 0; j < Math.min(10, ent.data.length); j++) {
          f32[ENT.DATA + j] = ent.data[j];
        }
      }
    }

    // Write player data
    for (let i = 0; i < this.playerCount; i++) {
      const p = this.players[i];
      if (!p) continue;
      const f32 = this.simWriter.getPlayerF32(i);
      const u32 = this.simWriter.getPlayerU32(i);

      f32[PLR.POS_X] = Number.isFinite(p.position.x) ? p.position.x : 0;
      f32[PLR.POS_Y] = Number.isFinite(p.position.y) ? p.position.y : 0;
      f32[PLR.POS_Z] = Number.isFinite(p.position.z) ? p.position.z : 0;
      f32[PLR.HEADING] = Number.isFinite(p.heading) ? p.heading : 0;
      f32[PLR.PITCH] = Number.isFinite(p.pitch) ? p.pitch : 0;
      f32[PLR.HEALTH] = Number.isFinite(p.health) ? p.health : 0;
      f32[PLR.MAX_HEALTH] = Number.isFinite(p.maxHealth) ? p.maxHealth : 0;
      f32[PLR.HUNGER] = Number.isFinite(p.hunger) ? p.hunger : 0;
      f32[PLR.THIRST] = Number.isFinite(p.thirst) ? p.thirst : 0;
      f32[PLR.OXYGEN] = Number.isFinite(p.oxygen) ? p.oxygen : 0;
      f32[PLR.MAX_OXYGEN] = Number.isFinite(p.maxOxygen) ? p.maxOxygen : 0;
      f32[PLR.TEMPERATURE] = Number.isFinite(p.temperature) ? p.temperature : 0;
      u32[PLR.CAMERA_MODE] = p.cameraMode;
      u32[PLR.ACTIVE_SLOT] = p.activeSlot;
      u32[PLR.FLAGS] = p.flags;
      u32[PLR.ENTITY_ID] = p.entityId;
      u32[PLR.PLAYER_ID] = p.playerId;
      f32[PLR.VIEWPORT_X] = p.viewport.x;
      f32[PLR.VIEWPORT_Y] = p.viewport.y;
      f32[PLR.VIEWPORT_W] = p.viewport.w;
      f32[PLR.VIEWPORT_H] = p.viewport.h;
      f32[PLR.THIRD_PERSON_DISTANCE] = p.thirdPersonDistance;
      f32[PLR.GOLD] = p.gold;

      // Write fishing state
      const fishState = this.fishingSystem.getMinigameState(i);
      f32[PLR.FISHING_TENSION] = fishState ? fishState.tension : 0;
      f32[PLR.FISHING_PROGRESS] = fishState ? fishState.progress : 0;

      // Write freecam data
      const freecamPos = this.cameraController.getFreecamPosition(p.playerId);
      const freecamAngles = this.cameraController.getFreecamAngles(p.playerId);
      if (freecamPos) {
        f32[PLR.FREECAM_X] = freecamPos.x;
        f32[PLR.FREECAM_Y] = freecamPos.y;
        f32[PLR.FREECAM_Z] = freecamPos.z;
      } else {
        f32[PLR.FREECAM_X] = p.position.x;
        f32[PLR.FREECAM_Y] = p.position.y + 5;
        f32[PLR.FREECAM_Z] = p.position.z;
      }
      if (freecamAngles) {
        f32[PLR.FREECAM_PITCH] = freecamAngles.pitch;
        f32[PLR.FREECAM_YAW] = freecamAngles.yaw;
      } else {
        f32[PLR.FREECAM_PITCH] = 0;
        f32[PLR.FREECAM_YAW] = p.heading;
      }
    }

    this.simWriter.incrementTick();
  }

  private updateWaterBuffer(): void {
    const gridSize = 256;
    const time = this.totalTicks * SIM_TICK_DT;

    // --- Wind-driven sea state ---
    // Map wind speed (2 m/s calm → 25 m/s hellstorm) to a 0..1 factor,
    // smoothed over ~20-30 seconds so waves ramp up/down gradually.
    const windSpeed = this.weatherSystem.getWindSpeed();
    const targetSeaState = Math.min(1.0, Math.max(0.0, (windSpeed - 2.0) / 23.0));
    // Exponential smoothing: at 60 ticks/s, 0.00083 lerp ≈ 20s time constant
    this.seaState += (targetSeaState - this.seaState) * 0.00083;
    const ss = this.seaState;

    // Amplitude scale: 0.5× at calm → 2.5× at storm
    const ampScale = 0.5 + ss * 2.0;
    // Phase speedup in high wind (waves roll faster)
    const speedScale = 1.0 + ss * 0.5;

    // Directional swell aligned with wind (long wavelength, safe for 4m grid)
    const windDir = this.weatherSystem.getWindDirection();
    const swellK = 3.0; // low frequency for long wavelength
    const swellAmp = 0.4 * ss; // only present when wind is strong

    // Hoist loop-invariant phase terms
    const TWO_PI = 2 * Math.PI;
    const invGrid = TWO_PI / gridSize;
    const p0 = time * 0.8 * speedScale;
    const p1 = time * 1.0 * speedScale;
    const p2 = time * 0.5 * speedScale;
    const p3 = time * 1.5 * speedScale;
    const p4 = time * 1.2 * speedScale;
    const p5 = time * 0.9 * speedScale;
    const p6 = time * 0.6 * speedScale;

    // Precompute per-column wx values
    const wxArr = new Float64Array(gridSize);
    for (let x = 0; x < gridSize; x++) wxArr[x] = x * invGrid;

    const heights = this.waterWriter.heights;
    const windDirX = windDir.x;
    const windDirZ = windDir.z;

    const fastSin = Simulation.fastSin;
    const fastCos = Simulation.fastCos;

    for (let z = 0; z < gridSize; z++) {
      const wz = z * invGrid;
      const rowBase = z * gridSize;
      for (let x = 0; x < gridSize; x++) {
        const wx = wxArr[x];
        const h =
          (fastSin(wx * 8 + p0) * 0.6 +
           fastSin(wz * 10 + p1) * 0.4 +
           fastSin((wx + wz) * 6 + p2) * 0.3 +
           fastSin(wx * 20 - p3) * 0.15 +
           fastCos(wz * 18 + p4) * 0.12 +
           fastSin((wx * 3 + wz * 4) * 5 + p5) * 0.2) * ampScale +
          fastSin((wx * windDirX + wz * windDirZ) * swellK + p6) * swellAmp;
        heights[rowBase + x] = h;
      }
    }

    this.waterWriter.incrementSequence();
  }

  private checkNightSkip(): void {
    const isNight = this.timeOfDay > NIGHT_START_FRAC || this.timeOfDay < NIGHT_END_FRAC;
    if (!isNight || this.playerCount === 0) return;

    const sleepingCount = this.players.filter(p => p.active && (p.flags & PLR_FLAG.SLEEPING)).length;
    const threshold = this.gameModeManager.rules.nightSkipThreshold as number;
    if (sleepingCount / this.playerCount >= threshold) {
      // Skip to morning
      this.timeOfDay = NIGHT_END_FRAC;
    }
  }

  private getPlayerCenterX(): number {
    if (this.playerCount === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.playerCount; i++) sum += this.players[i].position.x;
    return sum / this.playerCount;
  }

  private getPlayerCenterZ(): number {
    if (this.playerCount === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.playerCount; i++) sum += this.players[i].position.z;
    return sum / this.playerCount;
  }

  // --- Entity Management ---

  spawnEntity(type: EntityType, opts: {
    position: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number; w: number };
    scale?: number;
    health?: number;
    maxHealth?: number;
    parentId?: number;
    flags?: number;
    data?: Float32Array;
  }): EntityId {
    const slot = this.freeSlots.pop() ?? this.entityCount;
    if (slot >= MAX_ENTITIES) {
      console.error("[Sim] Max entities reached");
      return 0;
    }

    if (this.entities[slot]) {
      console.error(`[Sim] spawnEntity: slot ${slot} still has entity ${this.entities[slot].id} (type ${this.entities[slot].type}) — freeSlots corruption!`);
    }

    const id = this.nextEntityId++;
    const gen = this.generations[slot];
    this.entities[slot] = {
      id,
      type,
      flags: opts.flags ?? 0,
      position: opts.position,
      rotation: opts.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
      scale: opts.scale ?? 1,
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      health: opts.health ?? 100,
      maxHealth: opts.maxHealth ?? 100,
      parentId: opts.parentId ?? 0,
      chunkX: Math.floor(opts.position.x / 256),
      chunkZ: Math.floor(opts.position.z / 256),
      data: opts.data ?? new Float32Array(SHIP_DATA_SLOTS),
    };

    // Initialize anchor slots to NaN (no anchor deployed) for ship-type entities
    if (type === EntityType.Ship || type === EntityType.SmallCraft) {
      this.entities[slot]!.data[SHIP_DATA.ANCHOR_X] = NaN;
      this.entities[slot]!.data[SHIP_DATA.ANCHOR_Z] = NaN;
    }

    if (slot === this.entityCount) this.entityCount++;
    this.entityIndex.set(id, { slot, gen });

    // Sync to ECS bridge
    this.ecs?.onSpawn(slot, this.entities[slot]!);

    // Register island terrain for volumetric deformation
    if (type === EntityType.Island) {
      this.terrainSystem.registerIsland(this.entities[slot]!);
    }
    // Register port terrain for volumetric deformation + caves
    if (type === EntityType.Port) {
      this.terrainSystem.registerPort(this.entities[slot]!);
    }

    return id;
  }

  removeEntity(id: EntityId): void {
    const idx = this.getEntitySlot(id);
    if (idx < 0) return;
    const ent = this.entities[idx];
    if (!ent) return;
    if (ent.type === EntityType.Ship) {
      this.boatCellSystem.removeBoat(id);
      this.boatDesignSystem.removeBoat(id);
      this.shipInventories.delete(id);
      this.onDesignRemoved?.(id);
    }
    if (ent.type === EntityType.Island || ent.type === EntityType.Port) {
      this.terrainSystem.unregisterIsland(id);
    }
    // Remove physics body
    this.physics?.removeEntityBody(idx);
    // Increment generation at idx — invalidates any stale handles pointing here
    this.generations[idx]++;
    // If the last entity is different from the one being removed, swap and remap
    const lastIdx = this.entityCount - 1;
    if (lastIdx !== idx) {
      const lastEnt = this.entities[lastIdx]!;
      this.entities[idx] = lastEnt;
      this.entityIndex.set(lastEnt.id, { slot: idx, gen: this.generations[idx] });
      this.physics?.remapEntityBody(lastIdx, idx);
      // Increment generation at lastIdx (the now-freed slot)
      this.generations[lastIdx]++;
    }
    this.entities[lastIdx] = undefined as any;
    this.entityIndex.delete(id);
    this.entityCount--;
    this.freeSlots.push(lastIdx);

    // Sync to ECS bridge
    this.ecs?.onRemove(idx, id);
    if (lastIdx !== idx) {
      this.ecs?.onRemap(lastIdx, idx);
    }
  }

  getBoatBuffer(): SharedArrayBuffer { return this.boatBuffer; }
  getBoatCellSystem(): BoatCellSystem { return this.boatCellSystem; }
  getBoatDesignSystem(): BoatDesignSystem { return this.boatDesignSystem; }
  getPhysics(): RapierPhysicsSystem | null { return this.physics; }
  getTerrainSystem(): TerrainSystem { return this.terrainSystem; }
  getPortSystem(): PortSystem { return this.portSystem; }
  getCollisionLog() { return this.physics?.getCollisionLog() ?? []; }
  getShipInventory(shipId: number): InventoryGrid | undefined { return this.shipInventories.get(shipId); }

  private broadcastShipHoldUpdate(): void {
    for (let i = 0; i < this.playerCount; i++) {
      const p = this.players[i];
      if (!p?.active) continue;
      const isOnboard = (p.flags & PLR_FLAG.ONBOARD) !== 0;
      if (!isOnboard) {
        this._onEvent({
          kind: "ship_hold_update",
          data: { playerId: p.playerId, isOnboard: false, shipEntityId: 0, shipName: "", holdItems: [], playerItems: getGridStateForUI(p.inventory) },
        } as SimToMainMessage);
        continue;
      }
      const shipEntityId = this.boatSystem.getOnboardShipId(p.playerId);
      if (!shipEntityId) {
        this._onEvent({
          kind: "ship_hold_update",
          data: { playerId: p.playerId, isOnboard: false, shipEntityId: 0, shipName: "", holdItems: [], playerItems: getGridStateForUI(p.inventory) },
        } as SimToMainMessage);
        continue;
      }
      const holdGrid = this.shipInventories.get(shipEntityId);
      const design = this.boatDesignSystem.getDesign(shipEntityId);
      const shipName = design?.metadata?.name ?? "Ship";
      this._onEvent({
        kind: "ship_hold_update",
        data: {
          playerId: p.playerId,
          isOnboard: true,
          shipEntityId,
          shipName,
          holdItems: holdGrid ? getGridStateForUI(holdGrid) : [],
          playerItems: getGridStateForUI(p.inventory),
        },
      } as SimToMainMessage);
    }
  }

  getEntity(id: EntityId): SimEntity | undefined {
    const idx = this.getEntitySlot(id);
    if (idx < 0) return undefined;
    return this.entities[idx];
  }

  private getEntitySlot(id: EntityId): number {
    const entry = this.entityIndex.get(id);
    if (entry === undefined) return -1;
    if (this.generations[entry.slot] !== entry.gen) return -1;
    return entry.slot;
  }

  // --- Player Management ---

  addPlayer(playerId: number, name: string): void {
    if (this.playerCount >= MAX_PLAYERS) {
      console.error("[Sim] Max players reached");
      return;
    }

    // Spawn player entity (beside the ship at origin)
    const entityId = this.spawnEntity(EntityType.Player, {
      position: { x: 3, y: 2, z: 5 },
      scale: PLAYER_HEIGHT,
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
    });

    const idx = this.playerCount++;
    this.players[idx] = {
      playerId,
      entityId,
      name,
      active: true,
      position: { x: 3, y: 2, z: 5 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      bodyHeading: 0,
      pitch: 0,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
      hunger: PLAYER_MAX_HUNGER,
      thirst: PLAYER_MAX_THIRST,
      oxygen: PLAYER_MAX_OXYGEN,
      maxOxygen: PLAYER_MAX_OXYGEN,
      temperature: PLAYER_MAX_TEMPERATURE,
      cameraMode: CameraMode.FirstPerson,
      activeSlot: 0,
      flags: 0,
      viewport: { x: 0, y: 0, w: 1, h: 1 },
      inventory: createGrid(PLAYER_INV_WIDTH, PLAYER_INV_HEIGHT),
      licenses: [],
      bedEntityId: 0,
      thirdPersonDistance: 12,
      gold: 100,
    };

    this.inputReader && this.simWriter.setPlayerCount(this.playerCount);

    // Sync to ECS bridge
    this.ecs?.onAddPlayer(idx, this.players[idx]!);
  }

  removePlayer(playerId: number): void {
    for (let i = 0; i < this.playerCount; i++) {
      if (this.players[i]?.playerId === playerId) {
        this.removeEntity(this.players[i].entityId);
        this.physics?.removeCharacter(i);
        const lastIdx = this.playerCount - 1;
        if (lastIdx !== i) {
          this.players[i] = this.players[lastIdx]!;
          this.physics?.remapCharacter(lastIdx, i);
        }
        this.players[lastIdx] = undefined as any;
        this.playerCount--;
        this.simWriter.setPlayerCount(this.playerCount);

        // Sync to ECS bridge
        this.ecs?.onRemovePlayer(i);
        if (lastIdx !== i) {
          this.ecs?.onRemapPlayer(lastIdx, i);
        }
        return;
      }
    }
  }

  setGamemode(mode: number): void {
    this.gamemode = Object.values(GameMode)[mode] as GameMode;
    this.gameModeManager.setGamemode(this.gamemode);
  }

  private determineCauseOfDeath(p: SimPlayer): string {
    if (p.oxygen <= 0) return "drowning";
    if (p.hunger <= 0) return "starvation";
    if (p.thirst <= 0) return "dehydration";
    if (p.temperature <= 0 || p.temperature >= 100) return "exposure";
    return "unknown";
  }

  respawnPlayer(playerId: number): void {
    const p = this.players.find(pl => pl?.playerId === playerId);
    if (!p) return;
    const bedPos = { x: 0, y: 5, z: 0 };
    this.survivalSystem.respawn(p, bedPos);
    this.reportedDead.delete(playerId);
  }

  setSetting(key: string, value: number | boolean): void {
    this.rules[key] = value;
    this.gameModeManager.updateRules(this.rules);
    this.survivalSystem.updateRules(this.rules);
    if (key === "portGenerationRate" || key === "islandGenerationRate") {
      this.worldGen.setGenerationRates(
        (this.rules.portGenerationRate as number) ?? 0.015,
        (this.rules.islandGenerationRate as number) ?? 0.00000025,
      );
    }
  }

  setWeather(weatherType: number): void {
    this.weatherSystem.setWeatherType(weatherType as WeatherType);
  }

  setTimeOfDay(time: number): void {
    this.timeOfDay = time;
  }

  handleWorldCommand(cmd: WorldCommand): { success: boolean; message?: string; data?: any } {
    const { type, payload } = cmd;
    const cx = payload.chunkX ?? 0;
    const cz = payload.chunkZ ?? 0;

    switch (type) {
      case "override_biome": {
        if (payload.biome === undefined) return { success: false, message: "Missing biome" };
        this.worldGen.setBiomeOverride(cx, cz, payload.biome as BiomeType);
        this.chunkManager.reloadChunk(cx, cz);
        return { success: true };
      }
      case "force_port": {
        this.worldGen.forcePort(cx, cz);
        this.chunkManager.reloadChunk(cx, cz);
        const nearbyPorts = this.chunkManager.getNearbyPorts(
          this.getPlayerCenterX(), this.getPlayerCenterZ(), 5000,
        );
        this.portSystem.updatePorts(nearbyPorts);
        return { success: true };
      }
      case "force_island": {
        this.worldGen.forceIsland(cx, cz);
        this.chunkManager.reloadChunk(cx, cz);
        this.islandManager.tick(
          this.spawnEntity.bind(this), this.removeEntity.bind(this),
          this.getPlayerCenterX(), this.getPlayerCenterZ(),
        );
        return { success: true };
      }
      case "remove_port": {
        this.worldGen.removePort(cx, cz);
        this.chunkManager.reloadChunk(cx, cz);
        const nearbyPorts = this.chunkManager.getNearbyPorts(
          this.getPlayerCenterX(), this.getPlayerCenterZ(), 5000,
        );
        this.portSystem.updatePorts(nearbyPorts);
        return { success: true };
      }
      case "remove_island": {
        this.worldGen.removeIsland(cx, cz);
        this.chunkManager.reloadChunk(cx, cz);
        this.islandManager.tick(
          this.spawnEntity.bind(this), this.removeEntity.bind(this),
          this.getPlayerCenterX(), this.getPlayerCenterZ(),
        );
        return { success: true };
      }
      case "clear_overrides": {
        this.worldGen.clearOverrides();
        this.chunkManager.reloadAll();
        const nearbyPorts = this.chunkManager.getNearbyPorts(
          this.getPlayerCenterX(), this.getPlayerCenterZ(), 5000,
        );
        this.portSystem.updatePorts(nearbyPorts);
        this.islandManager.tick(
          this.spawnEntity.bind(this), this.removeEntity.bind(this),
          this.getPlayerCenterX(), this.getPlayerCenterZ(),
        );
        return { success: true };
      }
      case "set_seed": {
        if (payload.seed === undefined) return { success: false, message: "Missing seed" };
        this.worldGen.setSeed(payload.seed);
        this.chunkManager.reloadAll();
        const nearbyPorts = this.chunkManager.getNearbyPorts(
          this.getPlayerCenterX(), this.getPlayerCenterZ(), 5000,
        );
        this.portSystem.updatePorts(nearbyPorts);
        this.islandManager.tick(
          this.spawnEntity.bind(this), this.removeEntity.bind(this),
          this.getPlayerCenterX(), this.getPlayerCenterZ(),
        );
        return { success: true };
      }
      case "toggle_event": {
        // Stub: events not yet implemented
        return { success: true, message: `Event '${payload.event}' ${payload.action} (stub)` };
      }
      default:
        return { success: false, message: `Unknown world command: ${type}` };
    }
  }

  handleCommand(cmd: SimCommand): { success: boolean; message?: string; data?: any } {
    const player = this.players.find(p => p?.playerId === cmd.playerId);
    if (!player || !player.active) {
      return { success: false, message: "Player not found or inactive" };
    }

    switch (cmd.type) {
      case "sleep": {
        this.survivalSystem.sleep(player);
        return { success: true };
      }
      case "wake": {
        this.survivalSystem.wake(player);
        return { success: true };
      }
      case "eat": {
        const amount = (cmd.payload.amount as number) ?? 10;
        this.survivalSystem.eat(player, amount);
        return { success: true };
      }
      case "drink": {
        const amount = (cmd.payload.amount as number) ?? 20;
        this.survivalSystem.drink(player, amount);
        return { success: true };
      }
      case "trade": {
        const portId = String(cmd.payload.portId);
        const itemId = cmd.payload.itemId as string;
        const quantity = (cmd.payload.quantity as number) ?? 1;
        const isBuying = (cmd.payload.isBuying as boolean) ?? true;
        const baseValue = (cmd.payload.baseValue as number) ?? 0;
        if (baseValue <= 0) return { success: false, message: "Invalid base value" };
        const listing = this.marketSystem.getListing(portId, itemId);
        if (!listing && isBuying) return { success: false, message: "Item not available at this port" };
        if (isBuying) {
          const totalPrice = this.marketSystem.buyFromPort(portId, itemId, baseValue, quantity);
          if (player.gold < totalPrice) return { success: false, message: "Not enough gold" };
          player.gold -= totalPrice;
        } else {
          const totalPrice = this.marketSystem.sellToPort(portId, itemId, baseValue, quantity, false);
          player.gold += totalPrice;
        }
        return { success: true, data: { gold: player.gold } };
      }
      case "license": {
        const craftType = cmd.payload.craftType as number;
        if (this.licenseSystem.hasLicense(player.playerId, craftType)) {
          return { success: false, message: "Already has this license" };
        }
        this.licenseSystem.grantLicense(player.playerId, craftType);
        player.licenses.push(craftType);
        return { success: true };
      }
      case "dock": {
        const shipId = cmd.payload.shipId as number;
        const dockIndex = (cmd.payload.dockIndex as number) ?? 0;
        const success = this.dockingSystem.release(shipId, dockIndex, this.entities, this.entityCount);
        if (!success) return { success: false, message: "Cannot release dock at that index" };
        return { success: true };
      }
      case "place_item": {
        const itemId = cmd.payload.itemId as string;
        const parentId = (cmd.payload.parentId as number) ?? 0;
        const instanceId = this.placeableSystem.place(itemId, parentId);
        if (!instanceId) return { success: false, message: "Unknown placeable item" };
        return { success: true, data: { instanceId } };
      }
      case "pickup_item": {
        const itemId = cmd.payload.itemId as string;
        const quantity = (cmd.payload.quantity as number) ?? 1;
        const remaining = addItem(player.inventory, itemId, quantity);
        if (remaining > 0) {
          return { success: false, message: `Inventory full, ${remaining} items not picked up` };
        }
        // If a placeable instance was specified, remove it
        const instanceId = cmd.payload.instanceId as number | undefined;
        if (instanceId !== undefined) {
          this.placeableSystem.remove(instanceId);
        }
        return { success: true };
      }
      case "drop_item": {
        const x = cmd.payload.x as number;
        const y = cmd.payload.y as number;
        const quantity = (cmd.payload.quantity as number) ?? 1;
        const removed = removeItem(player.inventory, x, y, quantity);
        if (!removed) return { success: false, message: "No item at that slot" };
        return { success: true, data: removed };
      }
      case "inventory_move": {
        const fromX = cmd.payload.fromX as number;
        const fromY = cmd.payload.fromY as number;
        const toX = cmd.payload.toX as number;
        const toY = cmd.payload.toY as number;
        const success = moveItem(player.inventory, fromX, fromY, toX, toY);
        if (!success) return { success: false, message: "Cannot move item to that position" };
        return { success: true };
      }
      case "craft": {
        // Crafting — to be wired with crafting recipes
        return { success: false, message: "Crafting not yet implemented" };
      }
      case "ship_hold_move": {
        const shipId = cmd.payload.shipId as number;
        const fromX = cmd.payload.fromX as number;
        const fromY = cmd.payload.fromY as number;
        const toX = cmd.payload.toX as number;
        const toY = cmd.payload.toY as number;
        const holdGrid = this.shipInventories.get(shipId);
        if (!holdGrid) return { success: false, message: "Ship hold not found" };
        const success = moveItem(holdGrid, fromX, fromY, toX, toY);
        if (!success) return { success: false, message: "Cannot move item to that position" };
        return { success: true };
      }
      case "transfer_to_ship": {
        const shipId = cmd.payload.shipId as number;
        const fromX = cmd.payload.fromX as number;
        const fromY = cmd.payload.fromY as number;
        const quantity = (cmd.payload.quantity as number) ?? 1;
        const holdGrid = this.shipInventories.get(shipId);
        if (!holdGrid) return { success: false, message: "Ship hold not found" };
        const removed = removeItem(player.inventory, fromX, fromY, quantity);
        if (!removed) return { success: false, message: "No item at that slot" };
        const remaining = addItem(holdGrid, removed.itemId, removed.quantity);
        if (remaining > 0) {
          addItem(player.inventory, removed.itemId, remaining);
          return { success: false, message: `Ship hold full, ${remaining} items returned` };
        }
        return { success: true };
      }
      case "transfer_from_ship": {
        const shipId = cmd.payload.shipId as number;
        const fromX = cmd.payload.fromX as number;
        const fromY = cmd.payload.fromY as number;
        const quantity = (cmd.payload.quantity as number) ?? 1;
        const holdGrid = this.shipInventories.get(shipId);
        if (!holdGrid) return { success: false, message: "Ship hold not found" };
        const removed = removeItem(holdGrid, fromX, fromY, quantity);
        if (!removed) return { success: false, message: "No item at that slot" };
        const remaining = addItem(player.inventory, removed.itemId, removed.quantity);
        if (remaining > 0) {
          addItem(holdGrid, removed.itemId, remaining);
          return { success: false, message: `Player inventory full, ${remaining} items returned` };
        }
        return { success: true };
      }
      default:
        return { success: false, message: `Unknown command type: ${cmd.type}` };
    }
  }

  serializeState(): string {
    const freecamData: Record<number, { pos: { x: number; y: number; z: number }; angles: { pitch: number; yaw: number } }> = {};
    for (let i = 0; i < this.playerCount; i++) {
      const p = this.players[i];
      if (!p?.active) continue;
      const pos = this.cameraController.getFreecamPosition(p.playerId);
      const angles = this.cameraController.getFreecamAngles(p.playerId);
      if (pos && angles) {
        freecamData[p.playerId] = { pos, angles };
      }
    }

    const state = {
      timeOfDay: this.timeOfDay,
      totalTicks: this.totalTicks,
      gamemode: this.gamemode,
      rules: this.rules,
      seed: this.seed,
      entities: this.entities.slice(0, this.entityCount).map(e => ({
        id: e.id, type: e.type, flags: e.flags,
        position: e.position, rotation: e.rotation, scale: e.scale,
        velocity: e.velocity, health: e.health, maxHealth: e.maxHealth,
        parentId: e.parentId, data: Array.from(e.data ?? []),
      })),
      players: this.players.slice(0, this.playerCount).map(p => ({
        playerId: p.playerId, entityId: p.entityId, name: p.name,
        position: p.position, velocity: p.velocity, heading: p.heading,
        bodyHeading: p.bodyHeading, pitch: p.pitch, health: p.health, maxHealth: p.maxHealth,
        hunger: p.hunger, thirst: p.thirst, oxygen: p.oxygen,
        maxOxygen: p.maxOxygen, temperature: p.temperature,
        cameraMode: p.cameraMode, thirdPersonDistance: p.thirdPersonDistance,
        activeSlot: p.activeSlot, flags: p.flags, licenses: p.licenses,
        bedEntityId: p.bedEntityId, gold: p.gold,
        inventory: serializeGrid(p.inventory),
      })),
      boatDesigns: this.boatDesignSystem.getDesigns(),
      shipInventories: Array.from(this.shipInventories.entries()).map(([id, grid]) => ({
        shipId: id,
        items: serializeGrid(grid),
      })),
      freecamData,
    };

    return JSON.stringify(state);
  }

  async save(slotName: string): Promise<void> {
    const stateJson = this.serializeState();
    this._onEvent({
      kind: "saved",
      data: { slotName, stateJson },
    });
  }

  async load(slotName: string): Promise<void> {
    this._onEvent({
      kind: "loaded",
      data: { slotName },
    });
  }

  restoreState(stateJson: string): void {
    const state = JSON.parse(stateJson);

    this.timeOfDay = state.timeOfDay ?? 0.3;
    this.totalTicks = state.totalTicks ?? 0;
    this.gamemode = state.gamemode ?? GameMode.Survival;
    this.rules = state.rules ?? this.rules;
    this.seed = state.seed ?? this.seed;
    this.worldGen.setGenerationRates(
      (this.rules.portGenerationRate as number) ?? 0.015,
      (this.rules.islandGenerationRate as number) ?? 0.00000025,
    );
    this.nextEntityId = 1;
    this.freeSlots = [];
    this.entityCount = 0;
    this.playerCount = 0;
    this.entities = [];
    this.players = [];
    this.entityIndex.clear();
    this.generations.fill(0);
    this.reportedDead.clear();

    // Restore entities
    if (state.entities) {
      for (const e of state.entities) {
        const slot = this.freeSlots.pop() ?? this.entityCount;
        this.entities[slot] = {
          id: e.id,
          type: e.type,
          flags: e.flags,
          position: e.position,
          rotation: e.rotation,
          scale: e.scale,
          velocity: e.velocity,
          angularVelocity: { x: 0, y: 0, z: 0 },
          health: e.health,
          maxHealth: e.maxHealth,
          parentId: e.parentId,
          chunkX: Math.floor(e.position.x / 256),
          chunkZ: Math.floor(e.position.z / 256),
          data: new Float32Array(e.data ?? []),
        };
        // Ensure ship-type entities have anchor slots initialized to NaN
        if (e.type === EntityType.Ship || e.type === EntityType.SmallCraft) {
          if (this.entities[slot]!.data.length < SHIP_DATA_SLOTS) {
            const expanded = new Float32Array(SHIP_DATA_SLOTS);
            expanded.set(this.entities[slot]!.data);
            this.entities[slot]!.data = expanded;
          }
          if (!Number.isFinite(this.entities[slot]!.data[SHIP_DATA.ANCHOR_X])) {
            this.entities[slot]!.data[SHIP_DATA.ANCHOR_X] = NaN;
            this.entities[slot]!.data[SHIP_DATA.ANCHOR_Z] = NaN;
          }
        }
        if (slot === this.entityCount) this.entityCount++;
        this.entityIndex.set(e.id, { slot, gen: this.generations[slot] });
        if (e.id >= this.nextEntityId) this.nextEntityId = e.id + 1;

        // Register island terrain for volumetric deformation
        if (e.type === EntityType.Island) {
          this.terrainSystem.registerIsland(this.entities[slot]!);
        }
        // Register port terrain for volumetric deformation + caves
        if (e.type === EntityType.Port) {
          this.terrainSystem.registerPort(this.entities[slot]!);
        }
      }
    }

    // Restore boat designs and rebuild runtime geometry.
    this.boatDesignSystem.clear();
    if (Array.isArray(state.boatDesigns)) {
      for (const entry of state.boatDesigns) {
        const entityId = entry?.entityId ?? 0;
        const design = entry?.design;
        const validation = validateBoatDesign(design);
        if (validation.valid && entityId > 0) {
          this.boatDesignSystem.setDesign(entityId, design);
        }
      }
    }

    // Restore ship inventories
    this.shipInventories.clear();
    if (Array.isArray(state.shipInventories)) {
      for (const entry of state.shipInventories) {
        const shipId = entry?.shipId ?? 0;
        if (shipId > 0 && Array.isArray(entry?.items)) {
          this.shipInventories.set(shipId, deserializeGrid(entry.items, BOAT_HOLD_INV_WIDTH, BOAT_HOLD_INV_HEIGHT));
        }
      }
    }

    // Restore players
    if (state.players) {
      for (const p of state.players) {
        const idx = this.playerCount++;
        this.players[idx] = {
          playerId: p.playerId,
          entityId: p.entityId,
          name: p.name,
          active: true,
          position: p.position,
          velocity: p.velocity ?? { x: 0, y: 0, z: 0 },
          heading: p.heading ?? 0,
          bodyHeading: p.bodyHeading ?? p.heading ?? 0,
          pitch: p.pitch ?? 0,
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          health: p.health,
          maxHealth: p.maxHealth ?? 100,
          hunger: p.hunger,
          thirst: p.thirst,
          oxygen: p.oxygen,
          maxOxygen: p.maxOxygen ?? 100,
          temperature: p.temperature,
          cameraMode: p.cameraMode ?? CameraMode.FirstPerson,
          activeSlot: p.activeSlot ?? 0,
          flags: p.flags ?? 0,
          viewport: { x: 0, y: 0, w: 1, h: 1 },
          inventory: p.inventory ? deserializeGrid(p.inventory, PLAYER_INV_WIDTH, PLAYER_INV_HEIGHT) : createGrid(PLAYER_INV_WIDTH, PLAYER_INV_HEIGHT),
          licenses: p.licenses ?? [],
          bedEntityId: p.bedEntityId ?? 0,
          thirdPersonDistance: p.thirdPersonDistance ?? 12,
          gold: p.gold ?? 100,
        };
      }
    }

    // Restore freecam data
    if (state.freecamData) {
      for (const [playerIdStr, fc] of Object.entries(state.freecamData)) {
        const playerId = Number(playerIdStr);
        const fcTyped = fc as { pos: { x: number; y: number; z: number }; angles: { pitch: number; yaw: number } };
        this.cameraController.setFreecamData(playerId, fcTyped.pos, fcTyped.angles);
      }
    }

    // Rebuild chunk manager around new player positions
    this.chunkManager.updateChunks(this.getPlayerCenterX(), this.getPlayerCenterZ());

    // Write restored state to SAB
    this.writeToBuffer();
    this.boatCellSystem.markBufferDirty();
    this.boatCellSystem.writeToBuffer();
  }

  shutdown(): void {
    // Cleanup systems
    this.physics?.shutdown();
    this.wildlifeManager.shutdown();
    this.pirateSystem.shutdown();
    this.portSystem.shutdown();
  }
}

// --- Internal Types ---

export interface SimEntity {
  id: EntityId;
  type: EntityType;
  flags: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scale: number;
  velocity: { x: number; y: number; z: number };
  angularVelocity: { x: number; y: number; z: number };
  health: number;
  maxHealth: number;
  parentId: number;
  chunkX: number;
  chunkZ: number;
  data: Float32Array;
}

export interface SimPlayer {
  playerId: PlayerId;
  entityId: EntityId;
  name: string;
  active: boolean;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  heading: number;
  bodyHeading: number;
  pitch: number;
  rotation: { x: number; y: number; z: number; w: number };
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  oxygen: number;
  maxOxygen: number;
  temperature: number;
  cameraMode: CameraMode;
  activeSlot: number;
  flags: number;
  viewport: { x: number; y: number; w: number; h: number };
  inventory: InventoryGrid;
  licenses: number[];
  bedEntityId: EntityId;
  thirdPersonDistance: number;
  gold: number;
}

