// Re-export streaming config from the marching cubes plugin.
// These configs are purely about voxel resolution and chunk sizes —
// algorithm-agnostic.
export { DEFAULT_STREAMING_CONFIG, getLODVoxelSize } from "@downdraft/library-marching-cubes";
export type { LODLevelConfig, TerrainStreamingConfig } from "@downdraft/library-marching-cubes";
