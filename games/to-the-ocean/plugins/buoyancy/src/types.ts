// ============================================================================
// Buoyancy Plugin — Types and Interfaces
//
// ECS-native plugin for hull-based boat buoyancy, gravity, and integration.
// All game-specific values and dependencies provided via config/deps.
// ============================================================================

import type { Query } from "@downdraft/core";

// --- Component data interfaces ---
// SoA components are accessed as TypedArray records indexed by row.
// AoS components (EntityData) are accessed as regular objects.

export interface BuoyancyTransform {
  x: Float32Array; y: Float32Array; z: Float32Array;
  rotX: Float32Array; rotY: Float32Array; rotZ: Float32Array; rotW: Float32Array;
  scale: Float32Array;
}

export interface BuoyancyVelocity {
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  angVx: Float32Array; angVy: Float32Array; angVz: Float32Array;
}

export interface BuoyancyEntityMeta {
  id: Uint32Array; type: Uint32Array; flags: Uint32Array;
  parentId: Uint32Array; chunkX: Int32Array; chunkZ: Int32Array;
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
  getCellVerticalExtent(cellType: number): { y0: number; y1: number };
}

// --- System factory deps ---

export interface BuoyancySystemDeps {
  shipsQuery: Query;
  allEntitiesQuery: Query;
  deps: BuoyancyDeps;
  config: BuoyancyConfig;
}
