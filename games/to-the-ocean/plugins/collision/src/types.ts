// ============================================================================
// Collision Plugin — Types and Interfaces
//
// ECS-native plugin for entity-vs-entity collision detection and response.
// Handles non-ship, non-player entities only. Ship collision is handled by
// Rapier physics. Player collision is handled by KinematicCharacterController.
// ============================================================================


// --- Component data interfaces ---
// SoA components are accessed as TypedArray records indexed by row.
// AoS components (EntityData, PlayerState) are accessed as regular objects.

export interface CollisionTransform {
  x: Float32Array; y: Float32Array; z: Float32Array;
  rotX: Float32Array; rotY: Float32Array; rotZ: Float32Array; rotW: Float32Array;
  scale: Float32Array;
}

export interface CollisionVelocity {
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  angVx: Float32Array; angVy: Float32Array; angVz: Float32Array;
}

export interface CollisionEntityMeta {
  id: Uint32Array; type: Uint32Array; flags: Uint32Array;
  parentId: Uint32Array; chunkX: Int32Array; chunkZ: Int32Array;
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
