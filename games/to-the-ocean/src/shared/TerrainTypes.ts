// ============================================================================
// TerrainTypes — shared types for volumetric island terrain
// ============================================================================

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

// A 3D voxel density field for one island
export type { VoxelField } from "@downdraft/core";

// Chunked voxel field — stores voxel data in fixed-size chunks for on-demand generation.
// Provides getVoxel() for point queries and materializeRegion() for mesh extraction.
// The buffer only stores non-empty chunks, indexed via chunkOffsets.
export interface ChunkedVoxelField {
  // Grid layout (same as VoxelField for coordinate conversion)
  dimX: number;
  dimY: number;
  dimZ: number;
  voxelSize: number;
  originX: number;
  originY: number;
  originZ: number;
  isoLevel: number;
  radius: number;

  // Chunk layout
  chunkSize: number;        // voxels per chunk edge (power of 2)
  chunkBits: number;        // log2(chunkSize) for fast bit-shift
  chunkMask: number;        // chunkSize - 1 for fast modulo
  chunkDimX: number;        // ceil(dimX / chunkSize)
  chunkDimY: number;        // ceil(dimY / chunkSize)
  chunkDimZ: number;        // ceil(dimZ / chunkSize)
  voxelsPerChunk: number;   // chunkSize³

  // Chunk storage
  buffer: ArrayBuffer;      // ArrayBuffer (Phase 1) or SharedArrayBuffer (Phase 2)
  view: Float32Array;       // Float32Array view over buffer
  chunkOffsets: Int32Array; // [chunkDimX*chunkDimY*chunkDimZ] — float offset per chunk, -1 = empty
  chunkGenerated: Uint8Array; // 1 = chunk data has been written into buffer
  totalChunkSlots: number;  // number of non-empty chunk slots allocated in buffer
  nextChunkOffset: number;  // next free float offset in buffer (for dynamic allocation)

  // Identity (for IPC and re-generation)
  chunkX: number;
  chunkZ: number;
  isPort: boolean;
}

// Get a voxel value from a ChunkedVoxelField by global voxel coordinates.
// Returns -1.0 for out-of-bounds or ungenerated/empty chunks.
export function getChunkedVoxel(field: ChunkedVoxelField, x: number, y: number, z: number): number {
  if (x < 0 || x >= field.dimX || y < 0 || y >= field.dimY || z < 0 || z >= field.dimZ) return -1.0;
  const cx = x >>> field.chunkBits;
  const cy = y >>> field.chunkBits;
  const cz = z >>> field.chunkBits;
  const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
  const offset = field.chunkOffsets[chunkIdx];
  if (offset < 0) return -1.0;
  const lx = x & field.chunkMask;
  const ly = y & field.chunkMask;
  const lz = z & field.chunkMask;
  const cs = field.chunkSize;
  return field.view[offset + lx * cs * cs + ly * cs + lz];
}

// Set a voxel value in a ChunkedVoxelField by global voxel coordinates.
// The chunk must already be generated (offset >= 0).
export function setChunkedVoxel(field: ChunkedVoxelField, x: number, y: number, z: number, value: number): void {
  if (x < 0 || x >= field.dimX || y < 0 || y >= field.dimY || z < 0 || z >= field.dimZ) return;
  const cx = x >>> field.chunkBits;
  const cy = y >>> field.chunkBits;
  const cz = z >>> field.chunkBits;
  const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
  const offset = field.chunkOffsets[chunkIdx];
  if (offset < 0) return;
  const lx = x & field.chunkMask;
  const ly = y & field.chunkMask;
  const lz = z & field.chunkMask;
  const cs = field.chunkSize;
  field.view[offset + lx * cs * cs + ly * cs + lz] = value;
}

// A deformation request to modify terrain
export interface TerrainDeformation {
  islandEntityId: number;   // which island to deform
  worldX: number;           // center of deformation in world space
  worldY: number;
  worldZ: number;
  radius: number;           // sphere radius in world units
  strength: number;         // density change (negative = remove terrain, positive = add)
}

// Extracted mesh from marching cubes
export type { ExtractedMesh } from "@downdraft/core";

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
