// ============================================================================
// SurfaceNetsLib — declarative engine library descriptor for @downdraft/engine/libraries/surface-nets
//
// Surface-nets is an alternative mesh extraction algorithm to marching cubes.
// This library provides the extraction functions + chunked voxel field storage.
// Games declare `libraries: [SurfaceNetsLib]` to get the streaming config and
// mesh extraction utilities wired into the DI graph.
//
// Games that need full control can still import extractMeshFromField and
// createChunkedVoxelField directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { DEFAULT_STREAMING_CONFIG, type TerrainStreamingConfig } from "./streaming-config";

// ── Config ──

export interface SurfaceNetsLibConfig {
  /** Terrain streaming config (LOD levels, voxel sizes, etc.). */
  streaming?: Partial<TerrainStreamingConfig>;
}

// ── Typed tokens (DI) ──

/** Token for the surface-nets streaming config. */
export const SurfaceNetsStreamingConfigTok = resourceToken<TerrainStreamingConfig>("surface-nets:streaming-config");

// ── Descriptor ──

export const SurfaceNetsLib: EngineLibrary<SurfaceNetsLibConfig> = {
  name: "surface-nets",
  version: "1.0.0",

  // No SAB channels — surface-nets uses the same RPC/deformation model as
  // marching-cubes. Games can add a SAB channel if they want zero-copy terrain.
  sabChannels: [],

  provides: [SurfaceNetsStreamingConfigTok],

  sim: {
    create(config, ctx) {
      const streamingConfig = { ...DEFAULT_STREAMING_CONFIG, ...config.streaming };
      ctx.provide(SurfaceNetsStreamingConfigTok, streamingConfig);
      return { streamingConfig };
    },
    dispose(_system) {
      // The system is a plain config object — no resources to free.
    },
    // tick is game-specific (calls lodManager.updateLOD(), mesh extraction, etc.)
    // — games wire this via onReady.
  },

  tickPhase: "terrain",

  // No renderer setup — terrain mesh generation is handled by the game's
  // mesh worker pool, not by the library descriptor.

  defaultConfig: {},
};
