export { applyDeformation, applyMultipleDeformations, deformChunk } from "./deformation";
export type { DeformationConfig } from "./deformation";
export { DEFAULT_MC_CONFIG, defaultDensityField, extractMeshFromField, generateChunk } from "./generator";
export type { DensityField, ExtractMeshOptions, MCChunkConfig, MCMesh, MCVertex, MeshColorFn } from "./generator";
export { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod";
export type { ChunkLODEntry, LODLevel } from "./lod";
export { extractMeshFromFieldTetra } from "./marching-tetrahedra";
export { TerrainChannel, TerrainSABChannel } from "./sab";

// Chunked voxel field storage
export {
    allocateChunk, CHUNK_EMPTY, CHUNK_FULL, CHUNK_SOLID, createChunkedVoxelField, getChunkedVoxel, isChunkEmpty,
    isChunkGenerated, markChunkGenerated, promoteChunk, setChunkedVoxel
} from "./chunked-field";
export type { ChunkedVoxelField } from "./chunked-field";

// Terrain streaming config
export { DEFAULT_STREAMING_CONFIG, getLODVoxelSize } from "./streaming-config";
export type { LODLevelConfig, TerrainStreamingConfig } from "./streaming-config";

// Terrain streaming manager
export { TerrainStreamingManager } from "./streaming-manager";
export type {
    ChunkEmptyChecker, ChunkFieldFactory, ChunkGenerator, DirtyTerrain, PhysicsFieldFactory, Deformation as TerrainDeformation, EntityPosition as TerrainEntityPosition, TerrainEntry, LODChange as TerrainLODChange
} from "./streaming-manager";

// Shared types
export type { ExtractedMesh, VoxelField } from "./generator";
