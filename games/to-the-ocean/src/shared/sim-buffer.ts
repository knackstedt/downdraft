// ============================================================================
// SharedArrayBuffer Layouts — zero-copy state transfer between threads
// ============================================================================

import { MAX_ENTITIES, MAX_PLAYERS, SIM_HEADER_SIZE, SIM_ENTITY_SLOT_SIZE, SIM_PLAYER_SLOT_SIZE } from "./constants";

// --- Sim Buffer Magic & Version ---

export const SIM_MAGIC = 0x53494d42; // 'SIMB'
export const SIM_VERSION = 1;

// --- Sim Buffer Header Layout (256 bytes) ---
// [0x00:0x04] u32 magic
// [0x04:0x08] u32 version
// [0x08:0x0C] u32 entityCount
// [0x0C:0x10] u32 maxEntities
// [0x10:0x14] u32 playerCount
// [0x14:0x18] u32 maxPlayers
// [0x18:0x1C] u32 tick (atomic, incremented each sim step)
// [0x1C:0x20] u32 sequence (atomic, incremented on state writes)
// [0x20:0x24] f32 timeOfDay (0-1)
// [0x24:0x28] u32 weatherType
// [0x28:0x2C] f32 weatherIntensity
// [0x2C:0x30] f32 windSpeed
// [0x30:0x34] f32 windDirX
// [0x34:0x38] f32 windDirZ
// [0x38:0x3C] f32 visibility
// [0x3C:0x40] f32 ambientTemp
// [0x40:0x44] u32 activePlayers (bitmask)
// [0x44:0x48] u32 gamemode
// [0x48:0x100] reserved

export const SIM_HDR = {
  MAGIC: 0,
  VERSION: 1,
  ENTITY_COUNT: 2,
  MAX_ENTITIES: 3,
  PLAYER_COUNT: 4,
  MAX_PLAYERS: 5,
  TICK: 6,
  SEQUENCE: 7,
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
  // Physics stats (in reserved area)
  PHYSICS_INITIALIZED: 18,
  PHYSICS_FAILED: 19,
  PHYSICS_BODY_COUNT: 20,
  PHYSICS_TICK_COUNT: 21,
  // Chunk stats
  CHUNK_COUNT: 22,
} as const;

// --- Entity Slot Layout (128 bytes per entity) ---
// [0x00:0x10] f32x4 position (x, y, z, scale)
// [0x10:0x20] f32x4 rotation (qx, qy, qz, qw)
// [0x20:0x2C] f32x3 velocity
// [0x2C:0x38] f32x3 angularVelocity
// [0x38:0x3C] f32 health
// [0x3C:0x40] f32 maxHealth
// [0x40:0x44] u32 type (EntityType)
// [0x44:0x48] u32 flags (EntityFlags)
// [0x48:0x4C] u32 id (EntityId)
// [0x4C:0x50] u32 parentId
// [0x50:0x54] i32 chunkX
// [0x54:0x58] i32 chunkZ
// [0x58:0x5C] f32 data[0]  (type-specific, e.g. speed, fuel, hunger)
// [0x5C:0x60] f32 data[1]
// [0x60:0x64] f32 data[2]
// [0x64:0x68] f32 data[3]
// [0x68:0x6C] f32 data[4]
// [0x6C:0x70] f32 data[5]
// [0x70:0x74] f32 data[6]  (ship pitch)
// [0x74:0x78] f32 data[7]  (ship roll)
// [0x78:0x80] reserved

export const ENT = {
  POS_X: 0, POS_Y: 1, POS_Z: 2, SCALE: 3,
  ROT_X: 4, ROT_Y: 5, ROT_Z: 6, ROT_W: 7,
  VEL_X: 8, VEL_Y: 9, VEL_Z: 10,
  ANGVEL_X: 11, ANGVEL_Y: 12, ANGVEL_Z: 13,
  HEALTH: 14, MAX_HEALTH: 15,
  TYPE: 16, FLAGS: 17, ID: 18, PARENT_ID: 19,
  CHUNK_X: 20, CHUNK_Z: 21,
  DATA: 22, // data[0..7] at indices 22-29
  ANCHOR_X: 30, // f32 — anchor world X (NaN = no anchor). Uses reserved space.
  ANCHOR_Z: 31, // f32 — anchor world Z (NaN = no anchor). Uses reserved space.
} as const;

// --- Player Slot Layout (256 bytes per player) ---
// [0x00:0x10] f32x4 position (x, y, z, heading)
// [0x10:0x20] f32x4 rotation (qx, qy, qz, qw)
// [0x20:0x24] f32 health
// [0x24:0x28] f32 maxHealth
// [0x28:0x2C] f32 hunger
// [0x2C:0x30] f32 thirst
// [0x30:0x34] f32 oxygen
// [0x34:0x38] f32 maxOxygen
// [0x38:0x3C] f32 temperature
// [0x3C:0x40] u32 cameraMode
// [0x40:0x44] u32 activeSlot
// [0x44:0x48] u32 flags
// [0x48:0x4C] u32 entityId
// [0x4C:0x50] u32 playerId
// [0x50:0x54] f32 viewportX
// [0x54:0x58] f32 viewportY
// [0x58:0x5C] f32 viewportW
// [0x5C:0x60] f32 viewportH
// [0x60:0x100] reserved

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
  GOLD: 31,
  FISHING_TENSION: 32,
  FISHING_PROGRESS: 33,
} as const;

// --- Player flags ---
export const PLR_FLAG = {
  SLEEPING: 1 << 0,
  DEAD: 1 << 1,
  UNDERWATER: 1 << 2,
  ONBOARD: 1 << 3,
  SWIMMING: 1 << 4,
  FISHING: 1 << 5,
  PILOTING: 1 << 6,    // player is actively controlling a ship
  CLIMBING: 1 << 7,    // player is climbing onto a boat
  NOCLIP: 1 << 8,      // dev vclip — no gravity, no collision, free flight
  GROUNDED: 1 << 9,    // player is standing on a surface (port, terrain, etc.)
} as const;

// --- Allocation ---

export function allocateSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(
    SIM_HEADER_SIZE + MAX_ENTITIES * SIM_ENTITY_SLOT_SIZE + MAX_PLAYERS * SIM_PLAYER_SLOT_SIZE
  );
}

export function allocateInputBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(
    64 + MAX_PLAYERS * 128
  );
}

export function allocateWaterBuffer(): SharedArrayBuffer {
  const gridSize = 256;
  return new SharedArrayBuffer(
    64 + gridSize * gridSize * 4 + gridSize * gridSize * 12 + gridSize * gridSize * 8
  );
}

// --- Sim Buffer Reader (renderer side) ---

export class SimBufferReader {
  private sab: SharedArrayBuffer;
  private u32: Uint32Array;
  private f32: Float32Array;
  private entityOffset: number;
  private playerOffset: number;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
    this.entityOffset = SIM_HEADER_SIZE / 4;
    this.playerOffset = this.entityOffset + MAX_ENTITIES * (SIM_ENTITY_SLOT_SIZE / 4);
  }

  isValid(): boolean {
    return this.u32[SIM_HDR.MAGIC] === SIM_MAGIC && this.u32[SIM_HDR.VERSION] === SIM_VERSION;
  }

  getTick(): number { return Atomics.load(this.u32, SIM_HDR.TICK); }
  getSequence(): number { return Atomics.load(this.u32, SIM_HDR.SEQUENCE); }
  getEntityCount(): number { return this.u32[SIM_HDR.ENTITY_COUNT]; }
  getPlayerCount(): number { return this.u32[SIM_HDR.PLAYER_COUNT]; }
  getTimeOfDay(): number { return this.f32[SIM_HDR.TIME_OF_DAY]; }
  getWeatherType(): number { return this.u32[SIM_HDR.WEATHER_TYPE]; }
  getWeatherIntensity(): number { return this.f32[SIM_HDR.WEATHER_INTENSITY]; }
  getWindSpeed(): number { return this.f32[SIM_HDR.WIND_SPEED]; }
  getWindDir(): { x: number; z: number } {
    return { x: this.f32[SIM_HDR.WIND_DIR_X], z: this.f32[SIM_HDR.WIND_DIR_Z] };
  }
  getVisibility(): number { return this.f32[SIM_HDR.VISIBILITY]; }
  getAmbientTemp(): number { return this.f32[SIM_HDR.AMBIENT_TEMP]; }
  getActivePlayers(): number { return this.u32[SIM_HDR.ACTIVE_PLAYERS]; }
  getGamemode(): number { return this.u32[SIM_HDR.GAMEMODE]; }
  getPhysicsInitialized(): number { return this.u32[SIM_HDR.PHYSICS_INITIALIZED]; }
  getPhysicsFailed(): number { return this.u32[SIM_HDR.PHYSICS_FAILED]; }
  getPhysicsBodyCount(): number { return this.u32[SIM_HDR.PHYSICS_BODY_COUNT]; }
  getPhysicsTickCount(): number { return this.u32[SIM_HDR.PHYSICS_TICK_COUNT]; }
  getChunkCount(): number { return this.u32[SIM_HDR.CHUNK_COUNT]; }

  getEntitySlot(idx: number): { f32: Float32Array; u32: Uint32Array } {
    const base = this.entityOffset + idx * (SIM_ENTITY_SLOT_SIZE / 4);
    return {
      f32: new Float32Array(this.sab, base * 4, SIM_ENTITY_SLOT_SIZE / 4),
      u32: new Uint32Array(this.sab, base * 4, SIM_ENTITY_SLOT_SIZE / 4),
    };
  }

  getPlayerSlot(idx: number): { f32: Float32Array; u32: Uint32Array } {
    const base = this.playerOffset + idx * (SIM_PLAYER_SLOT_SIZE / 4);
    return {
      f32: new Float32Array(this.sab, base * 4, SIM_PLAYER_SLOT_SIZE / 4),
      u32: new Uint32Array(this.sab, base * 4, SIM_PLAYER_SLOT_SIZE / 4),
    };
  }

  *iterEntities(): Generator<{ idx: number; f32: Float32Array; u32: Uint32Array }> {
    const count = this.getEntityCount();
    for (let i = 0; i < count; i++) {
      const base = this.entityOffset + i * (SIM_ENTITY_SLOT_SIZE / 4);
      yield {
        idx: i,
        f32: new Float32Array(this.sab, base * 4, SIM_ENTITY_SLOT_SIZE / 4),
        u32: new Uint32Array(this.sab, base * 4, SIM_ENTITY_SLOT_SIZE / 4),
      };
    }
  }
}

// --- Sim Buffer Writer (sim worker side) ---

export class SimBufferWriter {
  private sab: SharedArrayBuffer;
  u32: Uint32Array;
  f32: Float32Array;
  private entityOffset: number;
  private playerOffset: number;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
    this.entityOffset = SIM_HEADER_SIZE / 4;
    this.playerOffset = this.entityOffset + MAX_ENTITIES * (SIM_ENTITY_SLOT_SIZE / 4);
  }

  init() {
    this.u32[SIM_HDR.MAGIC] = SIM_MAGIC;
    this.u32[SIM_HDR.VERSION] = SIM_VERSION;
    this.u32[SIM_HDR.MAX_ENTITIES] = MAX_ENTITIES;
    this.u32[SIM_HDR.MAX_PLAYERS] = MAX_PLAYERS;
    this.u32[SIM_HDR.ENTITY_COUNT] = 0;
    this.u32[SIM_HDR.PLAYER_COUNT] = 0;
    this.u32[SIM_HDR.ACTIVE_PLAYERS] = 0;
  }

  setEntityCount(n: number) { this.u32[SIM_HDR.ENTITY_COUNT] = n; }
  setPlayerCount(n: number) { this.u32[SIM_HDR.PLAYER_COUNT] = n; }
  setTimeOfDay(t: number) { this.f32[SIM_HDR.TIME_OF_DAY] = t; }
  setWeather(type: number, intensity: number) {
    this.u32[SIM_HDR.WEATHER_TYPE] = type;
    this.f32[SIM_HDR.WEATHER_INTENSITY] = intensity;
  }
  setWind(speed: number, dirX: number, dirZ: number) {
    this.f32[SIM_HDR.WIND_SPEED] = speed;
    this.f32[SIM_HDR.WIND_DIR_X] = dirX;
    this.f32[SIM_HDR.WIND_DIR_Z] = dirZ;
  }
  setVisibility(v: number) { this.f32[SIM_HDR.VISIBILITY] = v; }
  setAmbientTemp(t: number) { this.f32[SIM_HDR.AMBIENT_TEMP] = t; }
  setActivePlayers(mask: number) { this.u32[SIM_HDR.ACTIVE_PLAYERS] = mask; }
  setGamemode(mode: number) { this.u32[SIM_HDR.GAMEMODE] = mode; }
  setPhysicsInitialized(v: number) { this.u32[SIM_HDR.PHYSICS_INITIALIZED] = v; }
  setPhysicsFailed(v: number) { this.u32[SIM_HDR.PHYSICS_FAILED] = v; }
  setPhysicsBodyCount(v: number) { this.u32[SIM_HDR.PHYSICS_BODY_COUNT] = v; }
  setPhysicsTickCount(v: number) { this.u32[SIM_HDR.PHYSICS_TICK_COUNT] = v; }
  setChunkCount(v: number) { this.u32[SIM_HDR.CHUNK_COUNT] = v; }

  incrementTick() {
    Atomics.add(this.u32, SIM_HDR.TICK, 1);
    Atomics.add(this.u32, SIM_HDR.SEQUENCE, 1);
  }

  getEntityF32(idx: number): Float32Array {
    const base = this.entityOffset + idx * (SIM_ENTITY_SLOT_SIZE / 4);
    return new Float32Array(this.sab, base * 4, SIM_ENTITY_SLOT_SIZE / 4);
  }

  getEntityU32(idx: number): Uint32Array {
    const base = this.entityOffset + idx * (SIM_ENTITY_SLOT_SIZE / 4);
    return new Uint32Array(this.sab, base * 4, SIM_ENTITY_SLOT_SIZE / 4);
  }

  getPlayerF32(idx: number): Float32Array {
    const base = this.playerOffset + idx * (SIM_PLAYER_SLOT_SIZE / 4);
    return new Float32Array(this.sab, base * 4, SIM_PLAYER_SLOT_SIZE / 4);
  }

  getPlayerU32(idx: number): Uint32Array {
    const base = this.playerOffset + idx * (SIM_PLAYER_SLOT_SIZE / 4);
    return new Uint32Array(this.sab, base * 4, SIM_PLAYER_SLOT_SIZE / 4);
  }
}
