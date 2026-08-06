// ============================================================================
// TerrainMeshTypes — shared types for terrain mesh worker pool communication
// All result buffers are Transferable TypedArrays for zero-copy transfer.
// ============================================================================

// --- Job requests ---

export interface CreateIslandFieldRequest {
  key: string;
  chunkX: number;
  chunkZ: number;
  radius: number;
  biome: number;
  islandSize: number;
}

export interface GenerateChunkMeshRequest {
  key: string;
  cx: number;
  cy: number;
  cz: number;
}

export interface GenerateDecorationMeshRequest {
  chunkX: number;
  chunkZ: number;
  biome: number;
  islandSize: number;
  islandRadius: number;
}

export interface GeneratePortTerrainMeshRequest {
  chunkX: number;
  chunkZ: number;
  radius: number;
  biome: number;
}

export interface GeneratePortStructureMeshRequest {
  chunkX: number;
  chunkZ: number;
  radius: number;
  biome: number;
}

// --- Job results ---

export interface PendingChunkInfo {
  cx: number;
  cy: number;
  cz: number;
  chunkKey: string;
  distSq: number;
}

export interface CreateIslandFieldResult {
  pendingChunks: PendingChunkInfo[];
  totalChunks: number;
  isEmpty: boolean;
  fieldMeta: {
    dimX: number;
    dimY: number;
    dimZ: number;
    voxelSize: number;
    originX: number;
    originY: number;
    originZ: number;
    radius: number;
    chunkSize: number;
    chunkDimX: number;
    chunkDimY: number;
    chunkDimZ: number;
  };
}

export interface GenerateChunkMeshResult {
  verts: Float32Array;
  indices: Uint16Array | Uint32Array;
  useUint32: boolean;
  worldCenterX: number;
  worldCenterY: number;
  worldCenterZ: number;
  boundingRadius: number;
  hasMesh: boolean;
}

export interface GenerateDecorationMeshResult {
  verts: Float32Array;
  indices: Uint16Array;
  hasMesh: boolean;
}

export interface GeneratePortTerrainMeshResult {
  verts: Float32Array;
  indices: Uint16Array | Uint32Array;
  useUint32: boolean;
  hasMesh: boolean;
}

export interface GeneratePortStructureMeshResult {
  verts: Float32Array;
  indices: Uint16Array | Uint32Array;
  useUint32: boolean;
  hasMesh: boolean;
}

// --- Job message protocol (matches task-worker.ts __job pattern) ---

export interface JobMessage {
  __job: true;
  id: number;
  fn: string;
  args: unknown[];
}

export interface JobResultMessage {
  __jobResult: true;
  id: number;
  result?: unknown;
  error?: string;
}
