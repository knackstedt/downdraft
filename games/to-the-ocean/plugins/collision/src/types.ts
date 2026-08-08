// ============================================================================
// Collision Plugin — Types and Interfaces
//
// ECS-native plugin for entity-vs-entity collision detection and response.
// Handles non-ship, non-player entities only. Ship collision is handled by
// Rapier physics. Player collision is handled by KinematicCharacterController.
// ============================================================================


// --- Component data interfaces ---

export interface CollisionTransform {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number; rotW: number;
  scale: number;
}

export interface CollisionVelocity {
  vx: number; vy: number; vz: number;
  angVx: number; angVy: number; angVz: number;
}

export interface CollisionEntityMeta {
  id: number;
  type: number;
  flags: number;
  parentId: number;
  chunkX: number;
  chunkZ: number;
}

export interface CollisionEntityData {
  data: Float32Array;
}

// --- Player data (for LOD culling) ---

export interface CollisionPlayerState {
  playerId: number;
  entityId: number;
  active: boolean;
  x: number; y: number; z: number;
  flags: number;
}

// --- Voxel field (for island terrain collision) ---

export interface VoxelFieldLike {
  voxelSize: number;
  radius: number;
  data: Float32Array;
}

// --- Port collider dimensions (provided by game) ---

export interface PortColliderDims {
  dock: { halfW: number; halfD: number };
  pier: { halfW: number; halfL: number; centerZ: number };
}

// --- Dependencies (provided by the game) ---

export interface CollisionDeps {
  getVoxelField(entityId: number): VoxelFieldLike | null;
  sampleTerrainHeight(field: VoxelFieldLike, ux: number, uz: number): number;
  getPortColliderDims(size: number, scale: number): PortColliderDims | null;
}

// --- Configuration ---

export interface CollisionConfig {
  entityTypes: {
    player: number;
    ship: number;
    smallCraft: number;
    pirateShip: number;
    port: number;
    island: number;
  };
  entityFlags: {
    static: number;
  };
  portDataIndex: number;
  shipCollisionRestitution: number;
  entityMass: Record<number, number>;
  wildlifeDensity: Record<number, number>;
  defaultLodDistance: number;
  spatialGridCellSize?: number;
}
