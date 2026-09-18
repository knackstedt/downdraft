// ============================================================================
// @downdraft/module-terrain — composable terrain plugin
//
// Composes @downdraft/library-marching-cubes (mesh extraction + chunked voxel
// fields) with LOD management, streaming, and deformation broadcasting into a
// single Module with typed DI. Games register this plugin instead of manually
// wiring TerrainSystem + TerrainLODManager + mesh worker pools.
//
// Provides:
//   - TerrainStreamingTok — the terrain streaming config (LOD levels, voxel sizes)
//
// The actual TerrainSystem and TerrainLODManager are game-specific (they need
// a game-provided DensityField), so games create them in onReady and inject
// TerrainStreamingTok for the config.
//
// Requires:
//   - (none — terrain is self-contained; physics integration is optional)
// ============================================================================

import {
    resourceToken,
    type Module,
    type ModuleContext,
} from "@downdraft/core";
import {
    DEFAULT_STREAMING_CONFIG,
    type TerrainStreamingConfig,
} from "@downdraft/library-marching-cubes";

// ── Config ──

export interface TerrainModuleConfig {
  /** Streaming config (LOD levels, voxel sizes, time budgets). */
  streaming?: Partial<TerrainStreamingConfig>;
  /** Max physics field generations per tick. Default: 1. */
  physFieldGenMaxPerTick?: number;
  /** Time budget for physics field generation (ms). Default: 8. */
  physFieldGenTimeBudgetMs?: number;
  /** Voxel size multiplier for physics field generation. Default: 1. */
  physVoxelSizeMultiplier?: number;
  /** Worker count for mesh generation pool. Default: 4. */
  meshWorkerCount?: number;
}

// ── Typed tokens (DI) ──

/** Token for the terrain streaming config. Inject to read LOD/streaming config. */
export const TerrainStreamingTok = resourceToken<TerrainStreamingConfig>("terrain:streaming");

// ── Module factory ──

export function createTerrainModule(config: TerrainModuleConfig = {}): Module {
  const streamingConfig: TerrainStreamingConfig = {
    ...DEFAULT_STREAMING_CONFIG,
    ...config.streaming,
  };

  return {
    name: "terrain",
    version: "1.0.0",

    provides: [TerrainStreamingTok],

    register(ctx: ModuleContext) {
      // Provide the streaming config so other systems/plugins can read it.
      ctx.provide(TerrainStreamingTok, streamingConfig);

      // The actual terrain system (chunk gen, LOD, deform) and LOD manager
      // are game-specific — they need a game-provided DensityField. Games
      // create them in onReady and inject TerrainStreamingTok for the config.
    },
  };
}

// Re-export library types for convenience
export { DEFAULT_STREAMING_CONFIG } from "@downdraft/library-marching-cubes";
export type { TerrainStreamingConfig } from "@downdraft/library-marching-cubes";

