// ============================================================================
// TerrainTypes — shared types for volumetric island terrain
// ============================================================================
// Re-exports generic types from @downdraft/plugin-marching-cubes and adds
// game-specific terrain types and SAB header layout.
//

// Terrain material type at a surface point (determines vertex color)
export enum TerrainType {
  DeepUnderwater = 0,
  ShallowUnderwater = 1,
  Shoreline = 2,
  Sand = 3,
  Grass = 4,
  Forest = 5,
  Stone = 6,
  Rock = 7,
}

// Re-export generic chunked voxel field types from the plugin
export {
    CHUNK_EMPTY, CHUNK_FULL, CHUNK_SOLID, getChunkedVoxel,
    promoteChunk,
    setChunkedVoxel
} from "@downdraft/plugin-marching-cubes";
export type { ChunkedVoxelField } from "@downdraft/plugin-marching-cubes";

// Re-export VoxelField and ExtractedMesh from the marching cubes plugin
export type { ExtractedMesh, VoxelField } from "@downdraft/plugin-marching-cubes";

// A deformation request to modify terrain
export interface TerrainDeformation {
  islandEntityId: number;   // which island to deform
  worldX: number;           // center of deformation in world space
  worldY: number;
  worldZ: number;
  radius: number;           // sphere radius in world units
  strength: number;         // density change (negative = remove terrain, positive = add)
}

// Terrain SAB header layout (first few floats of the SAB)
export const TERRAIN_SAB_HEADER = {
  ISLAND_ENTITY_ID: 0,   // u32 — entity ID this terrain belongs to
  DIM_X: 1,              // u32 — grid size X
  DIM_Y: 2,              // u32 — grid size Y
  DIM_Z: 3,              // u32 — grid size Z
  VOXEL_SIZE: 4,         // f32 — world units per voxel
  ORIGIN_X: 5,           // f32 — world-space origin X
  ORIGIN_Y: 6,           // f32 — world-space origin Y
  ORIGIN_Z: 7,           // f32 — world-space origin Z
  ISO_LEVEL: 8,          // f32 — surface threshold
  DIRTY: 9,              // u32 — dirty flag (1 = needs mesh rebuild)
  DEFORM_COUNT: 10,      // u32 — number of deformations since last rebuild
  DATA_OFFSET: 11,       // u32 — offset in floats where voxel data starts
} as const;

// Size of the header in floats (11 fields + 1 padding = 12 floats = 48 bytes)
export const TERRAIN_SAB_HEADER_SIZE = 12;
