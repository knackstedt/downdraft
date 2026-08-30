// ============================================================================
// Wildlife Plugin — Types and Interfaces
//
// ECS-native plugin for wildlife spawning, despawning, and AI behavior.
// All game-specific values (entity type IDs, biome IDs, flags, constants)
// are provided via WildlifeConfig at system creation time.
// ============================================================================

import type { Query } from "@downdraft/core";
import type { BiomeProvider, EntityProvider, SpawnOpts } from "@to-the-ocean/shared/plugin-interfaces";

// Re-export SpawnOpts from the shared module for backward compatibility
export type { SpawnOpts };

// --- Component data interfaces (SoA: TypedArray records indexed by row) ---

export interface WildlifeTransform {
  x: Float32Array; y: Float32Array; z: Float32Array;
  rotX: Float32Array; rotY: Float32Array; rotZ: Float32Array; rotW: Float32Array;
  scale: Float32Array;
}

export interface WildlifeVelocity {
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  angVx: Float32Array; angVy: Float32Array; angVz: Float32Array;
}

export interface WildlifeEntityMeta {
  id: Uint32Array; type: Uint32Array; flags: Uint32Array;
  parentId: Uint32Array; chunkX: Int32Array; chunkZ: Int32Array;
}

export interface WildlifeEntityData {
  data: Float32Array;
}

export interface WildlifeHealth {
  health: Float32Array;
  maxHealth: Float32Array;
}

export interface WildlifePlayerState {
  playerId: number;
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  heading: number;
  bodyHeading: number;
  pitch: number;
  rotX: number; rotY: number; rotZ: number; rotW: number;
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  oxygen: number;
  maxOxygen: number;
  temperature: number;
  cameraMode: number;
  activeSlot: number;
  flags: number;
  viewportX: number; viewportY: number; viewportW: number; viewportH: number;
  bedEntityId: number;
  thirdPersonDistance: number;
  gold: number;
}

// --- Bundled entity data (passed to AI functions) ---

export interface WildlifeEntity {
  transform: WildlifeTransform;
  velocity: WildlifeVelocity;
  meta: WildlifeEntityMeta;
  data: WildlifeEntityData;
  health: WildlifeHealth;
  /** Row index into the SoA TypedArrays. */
  row: number;
}

export interface WildlifePlayer {
  playerId: number;
  active: boolean;
  x: number; y: number; z: number;
  flags: number;
  health: number;
}

// --- Ship data (for shark boat-speed detection) ---

export interface WildlifeShip {
  id: number;
  x: number; y: number; z: number;
  data: Float32Array;
  health: { health: Float32Array; maxHealth: Float32Array };
  row: number;
}

// --- Dependencies (provided by the game) ---

export interface WildlifeDeps extends BiomeProvider, EntityProvider {
  getOnboardShipId(playerId: number): number;
}

// --- Configuration (game-specific values) ---

export interface WildlifeConfig {
  entityTypes: {
    fish: number; shark: number; eel: number; jellyfish: number;
    devilShrimp: number; whale: number; dolphin: number; turtle: number;
    crustacean: number; coral: number; moose: number;
    ship: number; pirateShip: number; port: number; island: number; player: number;
  };
  entityFlags: {
    static: number;
    bioluminescent: number;
  };
  playerFlags: {
    swimming: number;
    onboard: number;
  };
  biomes: {
    ocean: number; tropical: number; subTropical: number; deepOcean: number;
    coralReef: number; kelpForest: number; volcanic: number; hell: number;
    arctic: number; garbagePatch: number;
  };
  spawnRadius: number;
  maxPerBiome: number;
  despawnRadius: number;
  shipClearance: number;
  pirateShipClearance: number;
  portClearanceMargin: number;
  islandClearanceMargin: number;
  maxSpawnAttempts: number;
  sharkAttackDamage: number;
  eelShockDamage: number;
  jellyfishDotDamage: number;
  devilShrimpAttackDamage: number;
  sharkDetectBoatSpeed: number;
  shipDataSpeedIndex: number;
}

// --- System factory deps ---

export interface WildlifeSystemDeps {
  wildlifeQuery: Query;
  playersQuery: Query;
  shipsQuery: Query;
  allEntitiesQuery: Query;
  deps: WildlifeDeps;
  config: WildlifeConfig;
}
