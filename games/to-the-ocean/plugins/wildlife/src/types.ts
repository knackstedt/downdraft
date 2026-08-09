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

// --- Component data interfaces (structurally compatible with ECS components) ---

export interface WildlifeTransform {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number; rotW: number;
  scale: number;
}

export interface WildlifeVelocity {
  vx: number; vy: number; vz: number;
  angVx: number; angVy: number; angVz: number;
}

export interface WildlifeEntityMeta {
  id: number;
  type: number;
  flags: number;
  parentId: number;
  chunkX: number;
  chunkZ: number;
}

export interface WildlifeEntityData {
  data: Float32Array;
}

export interface WildlifeHealth {
  health: number;
  maxHealth: number;
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
  health: { health: number; maxHealth: number };
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
