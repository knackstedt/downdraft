// ============================================================================
// MarchingCubesLib — declarative engine library descriptor for @downdraft/engine/libraries/marching-cubes
//
// Apps declare `libraries: [MarchingCubesLib]` (or with config override)
// in their AppModule. The host allocates the terrain SAB (if used —
// an app may use RPC events instead), and provides the
// TerrainLODManager + streaming config via typed tokens.
//
// Apps that need full control can still import the mesh extraction
// functions and ChunkedVoxelField directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { TerrainChannel } from "./sab";
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

  // SAB channel for zero-copy terrain deformation broadcast.
  // Allocated using TerrainChannel's layout. Apps that prefer RPC events
  // can ignore this channel (it's allocated but not required to be used).
  sabChannels: [
    { name: "terrain", size: TerrainChannel.byteLength },
  ],

  provides: [TerrainStreamingConfigTok],

  sim: {
    create(config, ctx) {
      const streamingConfig = { ...DEFAULT_STREAMING_CONFIG, ...config.streaming };
      ctx.provide(TerrainStreamingConfigTok, streamingConfig);
      // TerrainLODManager needs a DensityField (app-specific), so we just
      // provide the streaming config here. Apps create the LOD manager
      // in onReady with their density field and inject TerrainStreamingConfigTok.
      return { streamingConfig };
    },
    dispose(_system) {
      // The system is a plain config object — no resources to free.
    },
    // tick is app-specific (calls lodManager.updateLOD(), processDeformations(),
    // queueNearbyChunksForGeneration(), etc.) — apps wire this via onReady.
  },

  tickPhase: "terrain",

  // No renderer setup — terrain mesh generation is handled by the app's
  // TerrainMeshPool worker pool, not by the library descriptor. The library
  // provides the mesh extraction functions; the app orchestrates the workers.

  defaultConfig: {
    useSAB: false,
    physVoxelSizeMultiplier: 1,
    physFieldGenMaxPerTick: 1,
    physFieldGenTimeBudgetMs: 8,
  },
};
