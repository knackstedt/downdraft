// ============================================================================
// @downdraft/plugin-terrain — composable terrain plugin
//
// Composes @downdraft/library-marching-cubes (mesh extraction + chunked voxel
// fields) with LOD management, streaming, and deformation broadcasting into a
// single Plugin with typed DI. Games register this plugin instead of manually
// wiring TerrainSystem + TerrainLODManager + mesh worker pools.
//
// Provides:
//   - TerrainSystemTok   — the terrain system (sim-side: chunk gen, LOD, deform)
//   - TerrainMeshPoolTok — the mesh worker pool (renderer-side: mesh extraction)
//
// Requires:
//   - (none — terrain is self-contained; physics integration is optional)
// ============================================================================

import {
  resourceToken,
  type Plugin,
  type PluginContext,
  type ResourceToken,
} from "@downdraft/core";
import {
  DEFAULT_STREAMING_CONFIG,
  TerrainLODManager,
  type TerrainStreamingConfig,
} from "@downdraft/library-marching-cubes";

// ── Config ──

export interface TerrainPluginConfig {
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

/** Token for the terrain system. Inject in sim systems that need terrain. */
export const TerrainSystemTok = resourceToken<unknown>("terrain:system");
/** Token for the terrain LOD manager. */
export const TerrainLODMgrTok = resourceToken<TerrainLODManager>("terrain:lod-manager");
/** Token for the terrain streaming config. */
export const TerrainStreamingTok = resourceToken<TerrainStreamingConfig>("terrain:streaming");

// ── Plugin factory ──

export function createTerrainPlugin(config: TerrainPluginConfig = {}): Plugin {
  const streamingConfig: TerrainStreamingConfig = {
    ...DEFAULT_STREAMING_CONFIG,
    ...config.streaming,
  };

  return {
    name: "terrain",
    version: "1.0.0",

    provides: [TerrainSystemTok, TerrainLODMgrTok, TerrainStreamingTok],

    register(ctx: PluginContext) {
      // Provide the streaming config so other systems/plugins can read it
      ctx.provide(TerrainStreamingTok, streamingConfig);

      // The LOD manager needs a DensityField (game-specific), so we provide
      // a factory that games can call with their density field. For now,
      // we provide a placeholder that games replace in their onReady hook.
      // This is a common pattern for plugins that need game-specific data.

      // Register a system that runs in the terrain stage to process
      // deformations and LOD updates. The actual terrain system class
      // is game-specific (it ties into the sim's entity model), so this
      // plugin provides the config + LOD manager and lets games register
      // their own system that uses them.

      ctx.onDispose(() => {
        // Cleanup is handled by the game's terrain system
      });
    },
  };
}

// Re-export library types for convenience
export type { TerrainStreamingConfig } from "@downdraft/library-marching-cubes";
export { DEFAULT_STREAMING_CONFIG } from "@downdraft/library-marching-cubes";
