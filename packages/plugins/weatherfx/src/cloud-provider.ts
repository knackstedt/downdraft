// ============================================================================
// Cloud Mesh Provider — interface for game-specific cloud field generation
// Games implement this to supply voxel fields and mesh extraction for clouds.
// ============================================================================

import type { ExtractedMesh, VoxelField } from "@downdraft/plugin-marching-cubes";
import type { WeatherType } from "@downdraft/library-weather";

export type CloudVoxelField = VoxelField;
export type CloudExtractedMesh = ExtractedMesh;

export interface CloudLayerConfig {
  altitude: number;
}

export interface CloudMeshProvider {
  getLayerTypes(): string[];
  getLayerConfig(layerType: string): CloudLayerConfig;
  getRegenDistance(): number;
  getMaxLayerGenPerFrame(): number;
  getLayerGenTimeBudgetMs(): number;
  generateLayerField(
    layerType: string,
    centerX: number,
    centerZ: number,
    weatherType: WeatherType,
    windOffsetX: number,
    windOffsetZ: number,
  ): CloudVoxelField;
  extractMesh(field: CloudVoxelField): CloudExtractedMesh;
}
