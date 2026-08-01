// ============================================================================
// Game-specific CloudMeshProvider — bridges @shared cloud generation to plugin
// ============================================================================

import type { CloudExtractedMesh, CloudLayerConfig, CloudMeshProvider, CloudVoxelField } from "@downdraft/plugin-weatherfx";
import {
    CLOUD_CONFIG,
    CloudLayerType,
    generateCloudLayerField,
} from "@shared/CloudGenerator";
import { extractCloudMesh } from "@shared/MarchingCubes";
import { WeatherType } from "@shared/types";

const LAYER_ORDER: CloudLayerType[] = ["stratus"];

export class GameCloudMeshProvider implements CloudMeshProvider {
  getLayerTypes(): string[] {
    return LAYER_ORDER;
  }

  getLayerConfig(layerType: string): CloudLayerConfig {
    const cfg = CLOUD_CONFIG.layers[layerType as CloudLayerType];
    return { altitude: cfg.altitude };
  }

  getRegenDistance(): number {
    return CLOUD_CONFIG.regenDistance;
  }

  getMaxLayerGenPerFrame(): number {
    return CLOUD_CONFIG.maxLayerGenPerFrame;
  }

  getLayerGenTimeBudgetMs(): number {
    return CLOUD_CONFIG.layerGenTimeBudgetMs;
  }

  generateLayerField(
    layerType: string,
    centerX: number,
    centerZ: number,
    weatherType: WeatherType,
    windOffsetX: number,
    windOffsetZ: number,
  ): CloudVoxelField {
    return generateCloudLayerField(
      layerType as CloudLayerType,
      centerX,
      centerZ,
      weatherType,
      windOffsetX,
      windOffsetZ,
    );
  }

  extractMesh(field: CloudVoxelField): CloudExtractedMesh {
    return extractCloudMesh(field);
  }
}
