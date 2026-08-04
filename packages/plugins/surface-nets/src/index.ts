import type { Plugin, PluginContext } from "@downdraft/core";
import { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod";
import { TerrainSABChannel } from "./sab";

// Core algorithm
export { extractMeshFromField } from "./surface-nets";
export type { DensityField, ExtractMeshOptions, MeshColorFn } from "./types";

// Shared types (re-exported from MC plugin)
export type { ExtractedMesh, VoxelField } from "./types";

// Chunked voxel field storage (re-exported from MC plugin)
export {
    allocateChunk, createChunkedVoxelField,
    getChunkedVoxel, isChunkEmpty,
    isChunkGenerated, markChunkGenerated, setChunkedVoxel
} from "./chunked-field";
export type { ChunkedVoxelField } from "./chunked-field";

// Deformation
export { applyDeformation, applyMultipleDeformations, deformChunk } from "./deformation";
export type { DeformationConfig } from "./deformation";

// LOD (re-exported from MC plugin)
export { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod";
export type { ChunkLODEntry, LODLevel } from "./lod";

// Streaming config (re-exported from MC plugin)
export { DEFAULT_STREAMING_CONFIG, getLODVoxelSize } from "./streaming-config";
export type { LODLevelConfig, TerrainStreamingConfig } from "./streaming-config";

// Streaming manager (re-exported from MC plugin)
export { TerrainStreamingManager } from "./streaming-manager";
export type {
    ChunkEmptyChecker, ChunkFieldFactory, ChunkGenerator, TerrainDeformation as Deformation, DirtyTerrain, TerrainEntityPosition as EntityPosition, TerrainLODChange as LODChange, PhysicsFieldFactory, TerrainEntry
} from "./streaming-manager";

// SAB channel (re-exported from MC plugin)
export { TerrainChannel, TerrainSABChannel } from "./sab";

export const SurfaceNetsPlugin: Plugin = {
  name: "surface-nets",
  version: "0.1.0",
  register(ctx: PluginContext) {
    const lodManager = new TerrainLODManager(() => 0, DEFAULT_LOD_LEVELS, 0);

    const sabChannel = ctx.allocateSABChannel("terrain", 1);
    const terrainSAB = new TerrainSABChannel(sabChannel);

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
