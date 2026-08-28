// ============================================================================
// Sim SAB Channel — SharedArrayBuffer for zero-copy sim→renderer state transfer
// Entity and player slot-based data channel with weather, physics, and world state.
// ============================================================================

import { defineChannel } from "./define";
import { InputChannel } from "./game-input";

// SAB protocol constants — buffer layout sizes
export interface PhysicsTimingData {
  step: number;
  collisionDetection: number;
  broadPhase: number;
  narrowPhase: number;
  solver: number;
  velocityAssembly: number;
  velocityResolution: number;
  velocityUpdate: number;
  velocityWriteback: number;
  ccd: number;
  ccdToiComputation: number;
  ccdBroadPhase: number;
  ccdNarrowPhase: number;
  ccdSolver: number;
  islandConstruction: number;
  userChanges: number;
}

export const MAX_ENTITIES = 8192;
export const MAX_PLAYERS = 8;
export const SIM_ENTITY_SLOT_SIZE = 128;
export const SIM_PLAYER_SLOT_SIZE = 256;

export const SimChannel = defineChannel({
  name: "game-sim",
  magic: 0x53494d42,
  version: 1,
  mode: "slots",
  header: {
    size: 256,
    fields: {
      entityCount: { type: "u32" },
      maxEntities: { type: "u32" },
      playerCount: { type: "u32" },
      maxPlayers: { type: "u32" },
      tick: { type: "u32", atomic: true },
      timeOfDay: { type: "f32" },
      weatherType: { type: "u32" },
      weatherIntensity: { type: "f32" },
      windSpeed: { type: "f32" },
      windDirX: { type: "f32" },
      windDirZ: { type: "f32" },
      visibility: { type: "f32" },
      ambientTemp: { type: "f32" },
      activePlayers: { type: "u32" },
      gamemode: { type: "u32" },
      physicsInitialized: { type: "u32" },
      physicsFailed: { type: "u32" },
      physicsBodyCount: { type: "u32" },
      physicsTickCount: { type: "u32" },
      chunkCount: { type: "u32" },
      physicsProfilerEnabled: { type: "u32" },
      physTimingStep: { type: "f32" },
      physTimingCollisionDetection: { type: "f32" },
      physTimingBroadPhase: { type: "f32" },
      physTimingNarrowPhase: { type: "f32" },
      physTimingSolver: { type: "f32" },
      physTimingVelocityAssembly: { type: "f32" },
      physTimingVelocityResolution: { type: "f32" },
      physTimingVelocityUpdate: { type: "f32" },
      physTimingVelocityWriteback: { type: "f32" },
      physTimingCcd: { type: "f32" },
      physTimingCcdToiComputation: { type: "f32" },
      physTimingCcdBroadPhase: { type: "f32" },
      physTimingCcdNarrowPhase: { type: "f32" },
      physTimingCcdSolver: { type: "f32" },
      physTimingIslandConstruction: { type: "f32" },
      physTimingUserChanges: { type: "f32" },
    },
  },
  sections: [
    {
      name: "entities",
      maxSlots: MAX_ENTITIES,
      slotSize: SIM_ENTITY_SLOT_SIZE,
      fields: {
        pos: { type: "f32", count: 4 },
        rot: { type: "f32", count: 4 },
        vel: { type: "f32", count: 3 },
        angVel: { type: "f32", count: 3 },
        health: { type: "f32" },
        maxHealth: { type: "f32" },
        type: { type: "u32" },
        flags: { type: "u32" },
        id: { type: "u32" },
        parentId: { type: "u32" },
        chunkX: { type: "i32" },
        chunkZ: { type: "i32" },
        data: { type: "f32", count: 8 },
        anchorX: { type: "f32" },
        anchorZ: { type: "f32" },
      },
    },
    {
      name: "players",
      maxSlots: MAX_PLAYERS,
      slotSize: SIM_PLAYER_SLOT_SIZE,
      fields: {
        pos: { type: "f32", count: 4 },
        rot: { type: "f32", count: 4 },
        health: { type: "f32" },
        maxHealth: { type: "f32" },
        hunger: { type: "f32" },
        thirst: { type: "f32" },
        oxygen: { type: "f32" },
        maxOxygen: { type: "f32" },
        temperature: { type: "f32" },
        cameraMode: { type: "u32" },
        activeSlot: { type: "u32" },
        flags: { type: "u32" },
        entityId: { type: "u32" },
        playerId: { type: "u32" },
        viewport: { type: "f32", count: 4 },
        pitch: { type: "f32" },
        freecam: { type: "f32", count: 5 },
        thirdPersonDistance: { type: "f32" },
        // NOTE: The player slot is 256 bytes (64 f32s). Core fields use
        // indices 0–30. Indices 31–63 are reserved padding — games can
        // define their own extension constants (e.g. GAME_PLR.GOLD = 31)
        // to store game-specific player state in this padding area without
        // modifying the core SAB schema.
      },
    },
  ],
});

export const SIM_MAGIC = 0x53494d42;
export const SIM_VERSION = 1;

export const SIM_HDR = {
  MAGIC: 0,
  VERSION: 1,
  ENTITY_COUNT: 3,
  MAX_ENTITIES: 4,
  PLAYER_COUNT: 5,
  MAX_PLAYERS: 6,
  TICK: 7,
  SEQUENCE: 2,
  TIME_OF_DAY: 8,
  WEATHER_TYPE: 9,
  WEATHER_INTENSITY: 10,
  WIND_SPEED: 11,
  WIND_DIR_X: 12,
  WIND_DIR_Z: 13,
  VISIBILITY: 14,
  AMBIENT_TEMP: 15,
  ACTIVE_PLAYERS: 16,
  GAMEMODE: 17,
  PHYSICS_INITIALIZED: 18,
  PHYSICS_FAILED: 19,
  PHYSICS_BODY_COUNT: 20,
  PHYSICS_TICK_COUNT: 21,
  CHUNK_COUNT: 22,
  PHYSICS_PROFILER_ENABLED: 23,
  PHYS_TIMING_STEP: 24,
  PHYS_TIMING_COLLISION_DETECTION: 25,
  PHYS_TIMING_BROAD_PHASE: 26,
  PHYS_TIMING_NARROW_PHASE: 27,
  PHYS_TIMING_SOLVER: 28,
  PHYS_TIMING_VELOCITY_ASSEMBLY: 29,
  PHYS_TIMING_VELOCITY_RESOLUTION: 30,
  PHYS_TIMING_VELOCITY_UPDATE: 31,
  PHYS_TIMING_VELOCITY_WRITEBACK: 32,
  PHYS_TIMING_CCD: 33,
  PHYS_TIMING_CCD_TOI_COMPUTATION: 34,
  PHYS_TIMING_CCD_BROAD_PHASE: 35,
  PHYS_TIMING_CCD_NARROW_PHASE: 36,
  PHYS_TIMING_CCD_SOLVER: 37,
  PHYS_TIMING_ISLAND_CONSTRUCTION: 38,
  PHYS_TIMING_USER_CHANGES: 39,
} as const;

export const ENT = {
  POS_X: 0, POS_Y: 1, POS_Z: 2, SCALE: 3,
  ROT_X: 4, ROT_Y: 5, ROT_Z: 6, ROT_W: 7,
  VEL_X: 8, VEL_Y: 9, VEL_Z: 10,
  ANGVEL_X: 11, ANGVEL_Y: 12, ANGVEL_Z: 13,
  HEALTH: 14, MAX_HEALTH: 15,
  TYPE: 16, FLAGS: 17, ID: 18, PARENT_ID: 19,
  CHUNK_X: 20, CHUNK_Z: 21,
  DATA: 22,
  ANCHOR_X: 30, ANCHOR_Z: 31,
} as const;

export const PLR = {
  POS_X: 0, POS_Y: 1, POS_Z: 2, HEADING: 3,
  ROT_X: 4, ROT_Y: 5, ROT_Z: 6, ROT_W: 7,
  HEALTH: 8, MAX_HEALTH: 9,
  HUNGER: 10, THIRST: 11,
  OXYGEN: 12, MAX_OXYGEN: 13,
  TEMPERATURE: 14,
  CAMERA_MODE: 15,
  ACTIVE_SLOT: 16,
  FLAGS: 17,
  ENTITY_ID: 18,
  PLAYER_ID: 19,
  VIEWPORT_X: 20, VIEWPORT_Y: 21,
  VIEWPORT_W: 22, VIEWPORT_H: 23,
  PITCH: 24,
  FREECAM_X: 25, FREECAM_Y: 26, FREECAM_Z: 27,
  FREECAM_PITCH: 28, FREECAM_YAW: 29,
  THIRD_PERSON_DISTANCE: 30,
  // Indices 31–63 are reserved for game-specific player state.
  // Games define their own extension constants (e.g. GAME_PLR.GOLD = 31).
} as const;

export const PLR_FLAG = {
  SLEEPING: 1 << 0,
  DEAD: 1 << 1,
  UNDERWATER: 1 << 2,
  ONBOARD: 1 << 3,
  SWIMMING: 1 << 4,
  FISHING: 1 << 5,
  PILOTING: 1 << 6,
  CLIMBING: 1 << 7,
  NOCLIP: 1 << 8,
  GROUNDED: 1 << 9,
} as const;

export function allocateSimBuffer(): SharedArrayBuffer {
  return SimChannel.allocate();
}

export function allocateInputBuffer(): SharedArrayBuffer {
  return InputChannel.allocate();
}

// --- Sim Buffer Reader (renderer side) ---

export class SimBufferReader {
  private reader: ReturnType<typeof SimChannel.reader>;
  private entitySlots: ReturnType<typeof SimChannel.reader>["sections"]["entities"];
  private playerSlots: ReturnType<typeof SimChannel.reader>["sections"]["players"];

  constructor(sab: SharedArrayBuffer) {
    this.reader = SimChannel.reader(sab);
    this.entitySlots = this.reader.sections.entities;
    this.playerSlots = this.reader.sections.players;
  }

  isValid(): boolean {
    return this.reader.isValid();
  }

  getTick(): number { return this.reader.header.u32[SimChannel.offsets.header.tick]; }
  getSequence(): number { return this.reader.getSequence(); }
  getEntityCount(): number { return this.reader.header.u32[SimChannel.offsets.header.entityCount]; }
  getPlayerCount(): number { return this.reader.header.u32[SimChannel.offsets.header.playerCount]; }
  getTimeOfDay(): number { return this.reader.header.f32[SimChannel.offsets.header.timeOfDay]; }
  getWeatherType(): number { return this.reader.header.u32[SimChannel.offsets.header.weatherType]; }
  getWeatherIntensity(): number { return this.reader.header.f32[SimChannel.offsets.header.weatherIntensity]; }
  getWindSpeed(): number { return this.reader.header.f32[SimChannel.offsets.header.windSpeed]; }
  private pooledWindDir = { x: 0, z: 0 };

  getWindDir(): { x: number; z: number } {
    const dir = this.pooledWindDir;
    dir.x = this.reader.header.f32[SimChannel.offsets.header.windDirX];
    dir.z = this.reader.header.f32[SimChannel.offsets.header.windDirZ];
    return dir;
  }
  getVisibility(): number { return this.reader.header.f32[SimChannel.offsets.header.visibility]; }
  getAmbientTemp(): number { return this.reader.header.f32[SimChannel.offsets.header.ambientTemp]; }
  getActivePlayers(): number { return this.reader.header.u32[SimChannel.offsets.header.activePlayers]; }
  getGamemode(): number { return this.reader.header.u32[SimChannel.offsets.header.gamemode]; }
  getPhysicsInitialized(): number { return this.reader.header.u32[SimChannel.offsets.header.physicsInitialized]; }
  getPhysicsFailed(): number { return this.reader.header.u32[SimChannel.offsets.header.physicsFailed]; }
  getPhysicsBodyCount(): number { return this.reader.header.u32[SimChannel.offsets.header.physicsBodyCount]; }
  getPhysicsTickCount(): number { return this.reader.header.u32[SimChannel.offsets.header.physicsTickCount]; }
  getChunkCount(): number { return this.reader.header.u32[SimChannel.offsets.header.chunkCount]; }
  getPhysicsProfilerEnabled(): boolean { return this.reader.header.u32[SimChannel.offsets.header.physicsProfilerEnabled] === 1; }
  getPhysicsTiming(): PhysicsTimingData | null {
    if (!this.getPhysicsProfilerEnabled()) return null;
    const h = this.reader.header.f32;
    const o = SimChannel.offsets.header;
    return {
      step: h[o.physTimingStep],
      collisionDetection: h[o.physTimingCollisionDetection],
      broadPhase: h[o.physTimingBroadPhase],
      narrowPhase: h[o.physTimingNarrowPhase],
      solver: h[o.physTimingSolver],
      velocityAssembly: h[o.physTimingVelocityAssembly],
      velocityResolution: h[o.physTimingVelocityResolution],
      velocityUpdate: h[o.physTimingVelocityUpdate],
      velocityWriteback: h[o.physTimingVelocityWriteback],
      ccd: h[o.physTimingCcd],
      ccdToiComputation: h[o.physTimingCcdToiComputation],
      ccdBroadPhase: h[o.physTimingCcdBroadPhase],
      ccdNarrowPhase: h[o.physTimingCcdNarrowPhase],
      ccdSolver: h[o.physTimingCcdSolver],
      islandConstruction: h[o.physTimingIslandConstruction],
      userChanges: h[o.physTimingUserChanges],
    };
  }

  getEntitySlot(idx: number): { f32: Float32Array; u32: Uint32Array } {
    const sv = this.entitySlots.slot(idx);
    return { f32: sv.f32, u32: sv.u32 };
  }

  getPlayerSlot(idx: number): { f32: Float32Array; u32: Uint32Array } {
    const sv = this.playerSlots.slot(idx);
    return { f32: sv.f32, u32: sv.u32 };
  }

  *iterEntities(): Generator<{ idx: number; f32: Float32Array; u32: Uint32Array }> {
    const count = this.getEntityCount();
    for (let i = 0; i < count; i++) {
      const sv = this.entitySlots.slot(i);
      yield { idx: i, f32: sv.f32, u32: sv.u32 };
    }
  }
}

// --- Sim Buffer Writer (sim worker side) ---

export class SimBufferWriter {
  private writer: ReturnType<typeof SimChannel.writer>;
  private entitySlots: ReturnType<typeof SimChannel.writer>["sections"]["entities"];
  private playerSlots: ReturnType<typeof SimChannel.writer>["sections"]["players"];
  // Dirty flags: 1 = entity/player slot has changed since last writeToBuffer.
  // writeToBuffer skips slots where the flag is 0. Cleared after each writeToBuffer.
  private dirtyEntities: Uint8Array;
  private dirtyPlayers: Uint8Array;

  constructor(sab: SharedArrayBuffer) {
    this.writer = SimChannel.writer(sab);
    this.entitySlots = this.writer.sections.entities;
    this.playerSlots = this.writer.sections.players;
    this.dirtyEntities = new Uint8Array(MAX_ENTITIES);
    this.dirtyPlayers = new Uint8Array(MAX_PLAYERS);
  }

  init() {
    const w = this.writer;
    const h = SimChannel.offsets.header;
    w.header.u32[h.maxEntities] = MAX_ENTITIES;
    w.header.u32[h.maxPlayers] = MAX_PLAYERS;
    w.header.u32[h.entityCount] = 0;
    w.header.u32[h.playerCount] = 0;
    w.header.u32[h.activePlayers] = 0;
  }

  setEntityCount(n: number) { this.writer.header.u32[SimChannel.offsets.header.entityCount] = n; }
  setPlayerCount(n: number) { this.writer.header.u32[SimChannel.offsets.header.playerCount] = n; }
  setTimeOfDay(t: number) { this.writer.header.f32[SimChannel.offsets.header.timeOfDay] = t; }
  setWeather(type: number, intensity: number) {
    this.writer.header.u32[SimChannel.offsets.header.weatherType] = type;
    this.writer.header.f32[SimChannel.offsets.header.weatherIntensity] = intensity;
  }
  setWind(speed: number, dirX: number, dirZ: number) {
    this.writer.header.f32[SimChannel.offsets.header.windSpeed] = speed;
    this.writer.header.f32[SimChannel.offsets.header.windDirX] = dirX;
    this.writer.header.f32[SimChannel.offsets.header.windDirZ] = dirZ;
  }
  setVisibility(v: number) { this.writer.header.f32[SimChannel.offsets.header.visibility] = v; }
  setAmbientTemp(t: number) { this.writer.header.f32[SimChannel.offsets.header.ambientTemp] = t; }
  setActivePlayers(mask: number) { this.writer.header.u32[SimChannel.offsets.header.activePlayers] = mask; }
  setGamemode(mode: number) { this.writer.header.u32[SimChannel.offsets.header.gamemode] = mode; }
  setPhysicsInitialized(v: number) { this.writer.header.u32[SimChannel.offsets.header.physicsInitialized] = v; }
  setPhysicsFailed(v: number) { this.writer.header.u32[SimChannel.offsets.header.physicsFailed] = v; }
  setPhysicsBodyCount(v: number) { this.writer.header.u32[SimChannel.offsets.header.physicsBodyCount] = v; }
  setPhysicsTickCount(v: number) { this.writer.header.u32[SimChannel.offsets.header.physicsTickCount] = v; }
  setChunkCount(v: number) { this.writer.header.u32[SimChannel.offsets.header.chunkCount] = v; }
  setPhysicsProfilerEnabled(v: number) { this.writer.header.u32[SimChannel.offsets.header.physicsProfilerEnabled] = v; }
  setPhysicsTiming(data: PhysicsTimingData) {
    const h = this.writer.header.f32;
    const o = SimChannel.offsets.header;
    h[o.physTimingStep] = data.step;
    h[o.physTimingCollisionDetection] = data.collisionDetection;
    h[o.physTimingBroadPhase] = data.broadPhase;
    h[o.physTimingNarrowPhase] = data.narrowPhase;
    h[o.physTimingSolver] = data.solver;
    h[o.physTimingVelocityAssembly] = data.velocityAssembly;
    h[o.physTimingVelocityResolution] = data.velocityResolution;
    h[o.physTimingVelocityUpdate] = data.velocityUpdate;
    h[o.physTimingVelocityWriteback] = data.velocityWriteback;
    h[o.physTimingCcd] = data.ccd;
    h[o.physTimingCcdToiComputation] = data.ccdToiComputation;
    h[o.physTimingCcdBroadPhase] = data.ccdBroadPhase;
    h[o.physTimingCcdNarrowPhase] = data.ccdNarrowPhase;
    h[o.physTimingCcdSolver] = data.ccdSolver;
    h[o.physTimingIslandConstruction] = data.islandConstruction;
    h[o.physTimingUserChanges] = data.userChanges;
  }

  incrementTick() {
    const h = SimChannel.offsets.header;
    Atomics.add(this.writer.header.u32, h.tick, 1);
    this.writer.bumpSequence();
  }

  markEntityDirty(slot: number): void {
    this.dirtyEntities[slot] = 1;
  }

  markPlayerDirty(slot: number): void {
    this.dirtyPlayers[slot] = 1;
  }

  isEntityDirty(slot: number): boolean {
    return this.dirtyEntities[slot] !== 0;
  }

  isPlayerDirty(slot: number): boolean {
    return this.dirtyPlayers[slot] !== 0;
  }

  clearDirty(): void {
    this.dirtyEntities.fill(0);
    this.dirtyPlayers.fill(0);
  }

  // Mark all entities and players dirty (used on initial write or full re-sync).
  markAllDirty(): void {
    this.dirtyEntities.fill(1);
    this.dirtyPlayers.fill(1);
  }

  getEntityF32(idx: number): Float32Array {
    return this.entitySlots.slot(idx).f32;
  }

  getEntityU32(idx: number): Uint32Array {
    return this.entitySlots.slot(idx).u32;
  }

  getPlayerF32(idx: number): Float32Array {
    return this.playerSlots.slot(idx).f32;
  }

  getPlayerU32(idx: number): Uint32Array {
    return this.playerSlots.slot(idx).u32;
  }
}
