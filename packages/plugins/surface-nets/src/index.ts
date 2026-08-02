import type { Plugin, PluginContext } from "@downdraft/core";
import { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod.ts";
import { TerrainSABChannel } from "./sab.ts";

// Core algorithm
export { extractMeshFromField } from "./surface-nets.ts";
export type { ExtractMeshOptions, MeshColorFn, DensityField } from "./types.ts";

// Shared types (re-exported from MC plugin)
export type { ExtractedMesh, VoxelField } from "./types.ts";

// Chunked voxel field storage (re-exported from MC plugin)
export {
  allocateChunk, createChunkedVoxelField,
  getChunkedVoxel, isChunkEmpty,
  isChunkGenerated, markChunkGenerated, setChunkedVoxel,
} from "./chunked-field.ts";
export type { ChunkedVoxelField } from "./chunked-field.ts";

// Deformation
export { applyDeformation, applyMultipleDeformations, deformChunk } from "./deformation.ts";
export type { DeformationConfig } from "./deformation.ts";

// LOD (re-exported from MC plugin)
export { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod.ts";
export type { ChunkLODEntry, LODLevel } from "./lod.ts";

// Streaming config (re-exported from MC plugin)
export { DEFAULT_STREAMING_CONFIG, getLODVoxelSize } from "./streaming-config.ts";
export type { LODLevelConfig, TerrainStreamingConfig } from "./streaming-config.ts";

// Streaming manager (re-exported from MC plugin)
export { TerrainStreamingManager } from "./streaming-manager.ts";
export type {
  ChunkEmptyChecker, ChunkFieldFactory, ChunkGenerator,
  DirtyTerrain, PhysicsFieldFactory,
  Deformation as TerrainDeformation, EntityPosition as TerrainEntityPosition,
  TerrainEntry, LODChange as TerrainLODChange,
} from "./streaming-manager.ts";

// SAB channel (re-exported from MC plugin)
export { TerrainChannel, TerrainSABChannel } from "./sab.ts";

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
