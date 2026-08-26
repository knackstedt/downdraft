// ============================================================================
// MarchingCubesLib — declarative engine library descriptor for @downdraft/library-marching-cubes
//
// Games declare `libraries: [MarchingCubesLib]` (or with config override)
// in their GameModule. The host allocates the terrain SAB (if used —
// to-the-ocean currently uses RPC events instead), and provides the
// TerrainLODManager + streaming config via typed tokens.
//
// Games that need full control can still import the mesh extraction
// functions and ChunkedVoxelField directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { DEFAULT_STREAMING_CONFIG, type TerrainStreamingConfig } from "./streaming-config";

// ── Config ──

export interface MarchingCubesLibConfig {
  /** Terrain streaming config (LOD levels, voxel sizes, etc.). */
  streaming?: Partial<TerrainStreamingConfig>;
  /** Whether to allocate a terrain SAB channel. Default: false (use RPC events). */
  useSAB?: boolean;
  /** Voxel size multiplier for physics field generation. Default: 1. */
  physVoxelSizeMultiplier?: number;
  /** Max physics field generations per tick. Default: 1. */
  physFieldGenMaxPerTick?: number;
  /** Time budget for physics field generation (ms). Default: 8. */
  physFieldGenTimeBudgetMs?: number;
}

// ── Typed tokens (DI) ──

/** Token for the terrain streaming config. */
export const TerrainStreamingConfigTok = resourceToken<TerrainStreamingConfig>("terrain:streaming-config");

// ── Descriptor ──

export const MarchingCubesLib: EngineLibrary<MarchingCubesLibConfig> = {
  name: "marching-cubes",
  version: "1.0.0",

  // SAB is optional — to-the-ocean uses RPC events for terrain deformation
  // broadcast instead of a shared SAB. Games that want zero-copy terrain
  // can set useSAB: true.
  sabChannels: [],

  provides: [TerrainStreamingConfigTok],

  sim: {
    create(config, _ctx) {
      const streamingConfig = { ...DEFAULT_STREAMING_CONFIG, ...config.streaming };
      // TerrainLODManager needs a DensityField (game-specific), so we just
      // provide the streaming config here. Games create the LOD manager
      // in onReady with their density field and inject TerrainStreamingConfigTok.
      return { streamingConfig };
    },
    // tick is game-specific (calls lodManager.updateLOD(), processDeformations(),
    // queueNearbyChunksForGeneration(), etc.) — games wire this via onReady.
  },

  tickPhase: "terrain",

  // No renderer setup — terrain mesh generation is handled by the game's
  // TerrainMeshPool worker pool, not by the library descriptor. The library
  // provides the mesh extraction functions; the game orchestrates the workers.

  defaultConfig: {
    useSAB: false,
    physVoxelSizeMultiplier: 1,
    physFieldGenMaxPerTick: 1,
    physFieldGenTimeBudgetMs: 8,
  },
};
