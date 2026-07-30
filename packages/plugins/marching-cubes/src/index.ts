import type { Plugin, PluginContext } from "@downdraft/core";
import { DEFAULT_MC_CONFIG, defaultDensityField, type DensityField, type MCChunkConfig } from "./generator.ts";
import { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod.ts";
import { TerrainSABChannel } from "./sab.ts";

export { applyDeformation, applyMultipleDeformations, deformChunk } from "./deformation.ts";
export type { DeformationConfig } from "./deformation.ts";
export { DEFAULT_MC_CONFIG, defaultDensityField, generateChunk } from "./generator.ts";
export type { DensityField, MCChunkConfig, MCMesh, MCVertex } from "./generator.ts";
export { DEFAULT_LOD_LEVELS, TerrainLODManager } from "./lod.ts";
export type { ChunkLODEntry, LODLevel } from "./lod.ts";
export { TerrainChannel, TerrainSABChannel } from "./sab.ts";

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
