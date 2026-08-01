// ============================================================================
// Buoyancy Plugin — Types and Interfaces
//
// ECS-native plugin for hull-based boat buoyancy, gravity, and integration.
// All game-specific values and dependencies provided via config/deps.
// ============================================================================

import type { Query } from "@downdraft/core";

// --- Component data interfaces ---

export interface BuoyancyTransform {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number; rotW: number;
  scale: number;
}

export interface BuoyancyVelocity {
  vx: number; vy: number; vz: number;
  angVx: number; angVy: number; angVz: number;
}

export interface BuoyancyEntityMeta {
  id: number;
  type: number;
  flags: number;
  parentId: number;
  chunkX: number;
  chunkZ: number;
}

export interface BuoyancyEntityData {
  data: Float32Array;
}

// --- Boat cell data (provided by game) ---

export interface BoatCell {
  type: number;
  gridX: number;
  gridY: number;
  gridZ: number;
}

export interface BoatMassProperties {
  mass: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  Ixx: number;
  Izz: number;
}

// --- Dependencies (provided by the game) ---

export interface BuoyancyDeps {
  sampleWaterAt(x: number, z: number): number;
  getBoatCells(entityId: number): BoatCell[] | null;
  getMassProperties(entityId: number): BoatMassProperties;
}

// --- Configuration ---

export interface BuoyancyConfig {
  entityTypes: {
    player: number;
    ship: number;
    smallCraft: number;
  };
  entityFlags: {
    static: number;
  };
  shipData: {
    heading: number;
    pitch: number;
    roll: number;
  };
  physics: {
    gravity: number;
    waterDensity: number;
    maxTilt: number;
    restoringStiffness: number;
    verticalDamping: number;
    angularDamping: number;
  };
  boatCellWorldSize: number;
  boatLayerHeight: number;
  seabedHeight: number;
  isHullShellCell(cellType: number): boolean;
}

// --- System factory deps ---

export interface BuoyancySystemDeps {
  shipsQuery: Query;
  allEntitiesQuery: Query;
  deps: BuoyancyDeps;
  config: BuoyancyConfig;
}
