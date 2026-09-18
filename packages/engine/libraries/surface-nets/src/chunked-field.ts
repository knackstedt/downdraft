// Re-export chunked voxel field utilities from the marching cubes plugin.
// These are algorithm-agnostic — they only manage voxel data storage and
// materialization. The actual mesh extraction is done separately via
// extractMeshFromField from this plugin's surface-nets.ts.
export {
  allocateChunk,
  createChunkedVoxelField,
  getChunkedVoxel,
  isChunkEmpty,
  isChunkGenerated,
  markChunkGenerated,
  setChunkedVoxel,
} from "@downdraft/engine/libraries/marching-cubes";
export type { ChunkedVoxelField } from "@downdraft/engine/libraries/marching-cubes";
