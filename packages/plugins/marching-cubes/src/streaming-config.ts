// ============================================================================
// TerrainLODConfig — distance-based LOD configuration with hysteresis
// ============================================================================

export interface LODLevelConfig {
  maxDistance: number;
  voxelSize: number;
}

export function getLODVoxelSize(distance: number, levels: readonly LODLevelConfig[]): number {
  for (let i = 0; i < levels.length; i++) {
    if (distance <= levels[i].maxDistance) {
      return levels[i].voxelSize;
    }
  }
  return levels[levels.length - 1].voxelSize;
}

export interface TerrainStreamingConfig {
  lodLevels: readonly LODLevelConfig[];
  baseVoxelSize: number;
  lodHysteresisTicks: number;
  chunkGenTimeBudgetMs: number;
  chunkGenMaxPerTick: number;
  physFieldGenTimeBudgetMs: number;
  physFieldGenMaxPerTick: number;
  maxChunksToScan: number;
  generationRange: number;
  lodCheckRange: number;
}

export const DEFAULT_STREAMING_CONFIG: TerrainStreamingConfig = {
  lodLevels: [
    { maxDistance: 150, voxelSize: 0 },
    { maxDistance: 350, voxelSize: 5.0 },
    { maxDistance: 700, voxelSize: 10.0 },
    { maxDistance: 1500, voxelSize: 20.0 },
  ],
  baseVoxelSize: 2.5,
  lodHysteresisTicks: 60,
  chunkGenTimeBudgetMs: 8,
  chunkGenMaxPerTick: 4,
  physFieldGenTimeBudgetMs: 8,
  physFieldGenMaxPerTick: 1,
  maxChunksToScan: 256,
  generationRange: 200,
  lodCheckRange: 250,
};
