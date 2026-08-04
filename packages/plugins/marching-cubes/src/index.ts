import type { Plugin, PluginContext } from "@downdraft/core";
import { DEFAULT_MC_CONFIG, defaultDensityField, type DensityField, type MCChunkConfig } from "./generator";
import { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod";
import { TerrainSABChannel } from "./sab";

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

export const MarchingCubesPlugin: Plugin = {
  name: "marching-cubes",
  version: "0.1.0",
  register(ctx: PluginContext) {
    const config: MCChunkConfig = { ...DEFAULT_MC_CONFIG };
    const field: DensityField = (x, y, z) => defaultDensityField(x, y, z, config.chunkSize, 0.05);
    const lodManager = new TerrainLODManager(field, DEFAULT_LOD_LEVELS, 0);

    const sabChannel = ctx.allocateSABChannel("terrain", 1);
    const terrainSAB = new TerrainSABChannel(sabChannel);

    ctx.registerResource("terrainConfig", config);
    ctx.registerResource("terrainField", field);
    ctx.registerResource("terrainLOD", lodManager);
    ctx.registerResource("terrainSAB", terrainSAB);

    ctx.registerSystem(3, function terrainUpdate() {
      lodManager.updateLOD();
    });

    ctx.onDispose(() => {
      lodManager.clear();
    });
  },
};
