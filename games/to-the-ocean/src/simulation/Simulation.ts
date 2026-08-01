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

import type { ISimulation } from "@downdraft/core";
import type { JobScheduler } from "@downdraft/core/ecs/job-system";
import type { BuoyancyConfig, BuoyancyDeps } from "@downdraft/plugin-buoyancy";
import type { CollisionConfig, CollisionDeps } from "@downdraft/plugin-collision";
import type { WildlifeConfig, WildlifeDeps } from "@downdraft/plugin-wildlife";
import { BoatBufferWriter } from "../shared/boat-buffer";
import { validateBoatDesign } from "../shared/boat-design/validators";
import {
  BOAT_CELL_WORLD_SIZE,
  BOAT_HOLD_INV_HEIGHT, BOAT_HOLD_INV_WIDTH,
  BOAT_LAYER_HEIGHT,
  DEVIL_SHRIP_ATTACK_DAMAGE, EEL_SHOCK_DAMAGE,
  ENTITY_MASS,
  JELLYFISH_DOT_DAMAGE, PLAYER_HEIGHT, PLAYER_INV_HEIGHT, PLAYER_INV_WIDTH,
  PORT_DATA,
  SHARK_ATTACK_DAMAGE, SHARK_DETECT_BOAT_SPEED,
  SHIP_COLLISION_RESTITUTION,
  SHIP_DATA, SHIP_DATA_SLOTS,
  WILDLIFE_DENSITY,
  WILDLIFE_DESPAWN_RADIUS, WILDLIFE_MAX_PER_BIOME, WILDLIFE_SPAWN_RADIUS,
  getPortColliderDims,
  isHullShellCell,
} from "../shared/constants";
import {
  collectShoreSources,
  shoreDamping,
  shoreDisplacement,
  waterCutout,
  type ShoreSource,
} from "../shared/shore-damping";
import { sampleTerrainHeight } from "../shared/terrain";
import { EntityFlags } from "../shared/types";
import { WATER_GRID } from "../shared/water-buffer";
import { WorldGenerator } from "../shared/world/WorldGenerator";
import { AnchorSystem } from "./boat/AnchorSystem";
import { BoatCellSystem } from "./boat/BoatCellSystem";
import { BoatDesignSystem } from "./boat/BoatDesignSystem";
import type { BoatPresetName } from "./boat/BoatPresets";
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

import { spawnEntity, removeEntity, getEntity, getEntitySlot, addPlayer, removePlayer, determineCauseOfDeath, respawnPlayer, checkNightSkip, getPlayerCenterX, getPlayerCenterZ } from "./SimulationEntityManager";
import { writeToBuffer, updateWaterBuffer, broadcastShipHoldUpdate, sampleWaterForBuoyancy } from "./SimulationBufferWriter";
import { handleCommand, handleWorldCommand, setSetting, setWeather, setTimeOfDay, setGamemode } from "./SimulationCommands";
import { tick as simTick } from "./SimulationTick";

export class Simulation implements ISimulation {
  public simWriter: SimBufferWriter;
  public inputReader: InputBufferReader;
  public waterWriter: WaterBufferWriter;
  public boatWriter: BoatBufferWriter;
  public boatBuffer: SharedArrayBuffer;
  public config: { seed: number; gamemode: number; rules: Record<string, number | boolean>; isDev?: boolean };
  public _onEvent: (msg: SimToMainMessage) => void;

  // Entity management — generational indices prevent stale-handle corruption
  public entities: SimEntity[] = [];
  public entityCount = 0;
  public nextEntityId = 1;
  public freeSlots: number[] = [];
  public generations = new Uint32Array(MAX_ENTITIES);
  public entityIndex = new Map<EntityId, { slot: number; gen: number }>();

  // Players
  public players: SimPlayer[] = [];
  public playerCount = 0;

  // Time
  public timeOfDay = 0.3; // start at morning
  public totalTicks = 0;
  public simTime = 0; // accumulated sim time (seconds) — handles variable dt

  // Systems
  public worldGen: WorldGenerator;
  public chunkManager: ChunkManager;
  public biomeSystem: BiomeSystem;
  public weatherSystem: WeatherSystem;
  public buoyancySystem: BuoyancySystem;
  public structureIntegrity: StructureIntegrity;
  public collisionSystem: CollisionSystem;
  public physics: RapierPhysicsSystem | null = null;
  public wildlifeManager: WildlifeManager;
  public marketSystem: MarketSystem;
  public animalSystem: AnimalSystem;
  public plantSystem: PlantSystem;
  public petSystem: PetSystem;
  public survivalSystem: SurvivalSystem;
  public survivalBiomeAdapter: SurvivalBiomeAdapter;
  public pirateSystem: PirateSystem;
  public dockingSystem: DockingSystem;
  public placeableSystem: PlaceableSystem;
  public fishingSystem: FishingSystem;
  public playerManager: PlayerManager;
  public licenseSystem: LicenseSystem;
  public cameraController: CameraController;
  public gameModeManager: GameModeManager;
  public progressionTree: ProgressionTree;
  public boatSystem: BoatSystem;
  public boatCellSystem: BoatCellSystem;
  public boatDesignSystem: BoatDesignSystem;
  public anchorSystem: AnchorSystem;
  onDesignChanged: ((entityId: number, designJson: string) => void) | null = null;
  onDesignRemoved: ((entityId: number) => void) | null = null;
  public portSystem: PortSystem;
  public islandManager: IslandManager;
  public terrainSystem: TerrainSystem;
  public toolSystem: ToolSystem;
  public shipInventories = new Map<number, InventoryGrid>();
  public jobScheduler: JobScheduler | null = null;
  public ecs: SimEcsWorld | null = null;
  public buoyancyShoreSources: ShoreSource[] = [];
  public buoyancyShoreCount = 0;
  public buoyancySimTime = 0;

  // State
  public gamemode = GameMode.Survival;
  public rules: Record<string, number | boolean>;
  public seed: number;
  public reportedDead = new Set<number>();
  public seaState = 0.5; // smoothed wind-driven wave amplitude factor (0..1)

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
    this.ecs.registerPirateSystem(
      (x, z) => this.chunkManager.getSecurityLevelAt(x, z),
      (type, opts) => this.spawnEntity(type, opts),
      (id) => this.removeEntity(id),
    );
    this.ecs.registerCameraSystem(() => this.inputReader);
    this.ecs.registerStructureIntegritySystem(() => this.boatCellSystem);

    // Register ECS wildlife system (replaces legacy WildlifeManager.tick)
    const wildlifeConfig: WildlifeConfig = {
      entityTypes: {
        fish: EntityType.Fish, shark: EntityType.Shark, eel: EntityType.Eel,
        jellyfish: EntityType.Jellyfish, devilShrimp: EntityType.DevilShrimp,
        whale: EntityType.Whale, dolphin: EntityType.Dolphin, turtle: EntityType.Turtle,
        crustacean: EntityType.Crustacean, coral: EntityType.Coral, moose: EntityType.Moose,
        ship: EntityType.Ship, pirateShip: EntityType.PirateShip,
        port: EntityType.Port, island: EntityType.Island, player: EntityType.Player,
      },
      entityFlags: {
        static: EntityFlags.Static,
        bioluminescent: EntityFlags.Bioluminescent,
      },
      playerFlags: {
        swimming: PLR_FLAG.SWIMMING,
        onboard: PLR_FLAG.ONBOARD,
      },
      biomes: {
        ocean: BiomeType.Ocean, tropical: BiomeType.Tropical, subTropical: BiomeType.SubTropical,
        deepOcean: BiomeType.DeepOcean, coralReef: BiomeType.CoralReef,
        kelpForest: BiomeType.KelpForest, volcanic: BiomeType.Volcanic,
        hell: BiomeType.Hell, arctic: BiomeType.Arctic, garbagePatch: BiomeType.GarbagePatch,
      },
      spawnRadius: WILDLIFE_SPAWN_RADIUS,
      maxPerBiome: WILDLIFE_MAX_PER_BIOME,
      despawnRadius: WILDLIFE_DESPAWN_RADIUS,
      shipClearance: 32,
      pirateShipClearance: 25,
      portClearanceMargin: 10,
      islandClearanceMargin: 15,
      maxSpawnAttempts: 5,
      sharkAttackDamage: SHARK_ATTACK_DAMAGE,
      eelShockDamage: EEL_SHOCK_DAMAGE,
      jellyfishDotDamage: JELLYFISH_DOT_DAMAGE,
      devilShrimpAttackDamage: DEVIL_SHRIP_ATTACK_DAMAGE,
      sharkDetectBoatSpeed: SHARK_DETECT_BOAT_SPEED,
      shipDataSpeedIndex: SHIP_DATA.SPEED,
    };
    const wildlifeDeps: WildlifeDeps = {
      getBiomeAt: (x, z) => this.chunkManager.getBiomeAt(x, z),
      getOnboardShipId: (playerId) => this.boatSystem.getOnboardShipId(playerId),
      spawnEntity: (type, opts) => this.spawnEntity(type, opts),
      removeEntity: (id) => this.removeEntity(id),
    };
    this.ecs.registerWildlifeSystem(wildlifeDeps, wildlifeConfig);

    // Register ECS buoyancy system (replaces legacy BuoyancySystem.tick inline path)
    // Parallel path (tickParallel) is not used — jobScheduler is never set externally.
    const buoyancyConfig: BuoyancyConfig = {
      entityTypes: {
        player: EntityType.Player,
        ship: EntityType.Ship,
        smallCraft: EntityType.SmallCraft,
      },
      entityFlags: {
        static: EntityFlags.Static,
      },
      shipData: {
        heading: SHIP_DATA.HEADING,
        pitch: SHIP_DATA.PITCH,
        roll: SHIP_DATA.ROLL,
      },
      physics: {
        gravity: 9.8,
        waterDensity: 1000,
        maxTilt: Math.PI / 6,
        restoringStiffness: 20.0,
        verticalDamping: 5.0,
        angularDamping: 4.0,
      },
      boatCellWorldSize: BOAT_CELL_WORLD_SIZE,
      boatLayerHeight: BOAT_LAYER_HEIGHT,
      seabedHeight: -50,
      isHullShellCell,
    };
    const buoyancyDeps: BuoyancyDeps = {
      sampleWaterAt: (x: number, z: number) => this.sampleWaterForBuoyancy(x, z),
      getBoatCells: (entityId: number) => this.boatCellSystem.getCells(entityId),
      getMassProperties: (entityId: number) => this.boatCellSystem.getMassProperties(entityId),
    };
    this.ecs.registerBuoyancySystem(buoyancyDeps, buoyancyConfig);

    // Register ECS collision system (replaces legacy CollisionSystem.tick)
    const collisionConfig: CollisionConfig = {
      entityTypes: {
        player: EntityType.Player,
        ship: EntityType.Ship,
        smallCraft: EntityType.SmallCraft,
        pirateShip: EntityType.PirateShip,
        port: EntityType.Port,
        island: EntityType.Island,
      },
      entityFlags: {
        static: EntityFlags.Static,
      },
      portDataIndex: PORT_DATA.SIZE,
      shipCollisionRestitution: SHIP_COLLISION_RESTITUTION,
      entityMass: ENTITY_MASS,
      wildlifeDensity: WILDLIFE_DENSITY,
      defaultLodDistance: (this.rules.collisionLodDistance as number) ?? 250,
    };
    const collisionDeps: CollisionDeps = {
      getVoxelField: (entityId: number) => this.terrainSystem.getVoxelField(entityId) as any,
      sampleTerrainHeight: (field, ux, uz) => sampleTerrainHeight(field as any, ux, uz),
      getPortColliderDims: (size: number, scale: number) => getPortColliderDims(size, scale) as any,
    };
    this.ecs.registerCollisionSystem(collisionDeps, collisionConfig);
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

  // --- Tick (delegated to SimulationTick.ts) ---

  async tick(dt: number = SIM_TICK_DT): Promise<void> {
    return simTick(this, dt);
  }

  // --- Entity Management (delegated to SimulationEntityManager.ts) ---

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
    return spawnEntity(this, type, opts);
  }

  removeEntity(id: EntityId): void {
    removeEntity(this, id);
  }

  getEntity(id: EntityId): SimEntity | undefined {
    return getEntity(this, id);
  }

  getEntitySlot(id: EntityId): number {
    return getEntitySlot(this, id);
  }

  // --- Player Management (delegated to SimulationEntityManager.ts) ---

  addPlayer(playerId: number, name: string): void {
    addPlayer(this, playerId, name);
  }

  removePlayer(playerId: number): void {
    removePlayer(this, playerId);
  }

  respawnPlayer(playerId: number): void {
    respawnPlayer(this, playerId);
  }

  // --- Helpers (delegated to SimulationEntityManager.ts) ---

  checkNightSkip(): void {
    checkNightSkip(this);
  }

  getPlayerCenterX(): number {
    return getPlayerCenterX(this);
  }

  getPlayerCenterZ(): number {
    return getPlayerCenterZ(this);
  }

  // --- Buffer Writing (delegated to SimulationBufferWriter.ts) ---

  writeToBuffer(): void {
    writeToBuffer(this);
  }

  updateWaterBuffer(): void {
    updateWaterBuffer(this);
  }

  broadcastShipHoldUpdate(): void {
    broadcastShipHoldUpdate(this);
  }

  sampleWaterForBuoyancy(x: number, z: number): number {
    return sampleWaterForBuoyancy(this, x, z);
  }

  // --- Commands (delegated to SimulationCommands.ts) ---

  handleCommand(cmd: SimCommand): { success: boolean; message?: string; data?: any } {
    return handleCommand(this, cmd);
  }

  handleWorldCommand(cmd: WorldCommand): { success: boolean; message?: string; data?: any } {
    return handleWorldCommand(this, cmd);
  }

  setSetting(key: string, value: number | boolean): void {
    setSetting(this, key, value);
  }

  setWeather(weatherType: number): void {
    setWeather(this, weatherType);
  }

  setTimeOfDay(time: number): void {
    setTimeOfDay(this, time);
  }

  setGamemode(mode: number): void {
    setGamemode(this, mode);
  }

  // --- Accessors ---

  getBoatBuffer(): SharedArrayBuffer { return this.boatBuffer; }
  getBoatCellSystem(): BoatCellSystem { return this.boatCellSystem; }
  getBoatDesignSystem(): BoatDesignSystem { return this.boatDesignSystem; }
  getPhysics(): RapierPhysicsSystem | null { return this.physics; }
  getTerrainSystem(): TerrainSystem { return this.terrainSystem; }
  getPortSystem(): PortSystem { return this.portSystem; }
  getCollisionLog() { return this.physics?.getCollisionLog() ?? []; }
  getShipInventory(shipId: number): InventoryGrid | undefined { return this.shipInventories.get(shipId); }

  // --- Serialization ---

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
      simTime: this.simTime,
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
      boatPresets: Object.fromEntries(
        Array.from(this.boatCellSystem.getAllBoats().entries()).map(
          ([id, info]) => [id, info.presetName],
        ),
      ),
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
    this.simTime = state.simTime ?? this.totalTicks * SIM_TICK_DT;
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

    // Clear boat cell system before restoring entities
    this.boatCellSystem.clear();

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

    // Restore boat cell grids from saved presets
    if (state.boatPresets) {
      for (const [entityIdStr, preset] of Object.entries(state.boatPresets)) {
        const entityId = Number(entityIdStr);
        if (this.getEntitySlot(entityId) >= 0) {
          this.boatCellSystem.createBoat(entityId, preset as BoatPresetName);
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

  async rebuildAfterRestore(): Promise<void> {
    // 1. Clear and rebuild ECS world — restoreState() bypasses spawnEntity()/addPlayer(),
    //    so ecs.onSpawn()/ecs.onAddPlayer() were never called. Without this, all migrated
    //    ECS systems silently no-op because slotToEntity map is empty.
    if (this.ecs) {
      this.ecs.clearAll();
      for (let i = 0; i < this.entityCount; i++) {
        if (this.entities[i]) {
          this.ecs.onSpawn(i, this.entities[i]!);
        }
      }
      for (let i = 0; i < this.playerCount; i++) {
        if (this.players[i]) {
          this.ecs.onAddPlayer(i, this.players[i]!);
        }
      }
    }

    // 2. Recreate physics world — WASM stays loaded, only recreateWorld() runs (~1ms)
    if (this.physics) {
      this.physics.shutdown();
      await this.physics.init();
    }

    // 3. Write to buffers
    this.writeToBuffer();
    this.boatCellSystem.markBufferDirty();
    this.boatCellSystem.writeToBuffer();
  }

  shutdown(): void {
    // Cleanup systems
    this.physics?.shutdown();
    this.wildlifeManager.shutdown();
    this.ecs?.shutdownWildlife();
    this.ecs?.shutdownPirates();
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
