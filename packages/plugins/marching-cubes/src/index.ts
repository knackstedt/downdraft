import type { Plugin, PluginContext } from "@downdraft/core";
import { DEFAULT_MC_CONFIG, type MCChunkConfig } from "./generator.ts";
import { defaultDensityField, generateChunk, type DensityField, type MCMesh } from "./generator.ts";
import { TerrainLODManager, DEFAULT_LOD_LEVELS, type LODLevel } from "./lod.ts";
import { TerrainSABChannel, TERRAIN_SAB_LAYOUT } from "./sab.ts";

export { DEFAULT_MC_CONFIG, generateChunk, defaultDensityField } from "./generator.ts";
export type { MCChunkConfig, MCMesh, DensityField, MCVertex } from "./generator.ts";
export { TerrainLODManager, DEFAULT_LOD_LEVELS } from "./lod.ts";
export type { LODLevel, ChunkLODEntry } from "./lod.ts";
export { applyDeformation, applyMultipleDeformations, deformChunk } from "./deformation.ts";
export type { DeformationConfig } from "./deformation.ts";
export { TerrainSABChannel, TERRAIN_SAB_LAYOUT } from "./sab.ts";

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
