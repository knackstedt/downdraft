// ============================================================================
// RecastLib — declarative engine library descriptor for @downdraft/library-recast
//
// Games declare `libraries: [RecastLib]` (or with config override) in their
// GameModule. The host creates the RecastBackend + RecastCrowdSystem
// (sim-side only — recast has no renderer component) and exposes them via
// typed tokens.
//
// Games that need full control can still import RecastBackend,
// RecastCrowdSystem, and RecastAgent directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { RecastBackend } from "./backend";
import { RecastCrowdSystem } from "./crowd-system";

// ── Config ──

export interface RecastLibConfig {
  /** Default agent radius. Default: 0.5. */
  agentRadius?: number;
  /** Default agent height. Default: 1.8. */
  agentHeight?: number;
  /** Max crowd agents. Default: 512. */
  maxAgents?: number;
  /** Max agent radius for the recast Crowd ctor. Default: 0.6. */
  maxAgentRadius?: number;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side recast backend (navmesh + query). Inject in sim systems that need pathfinding. */
export const RecastNavMeshTok = resourceToken<RecastBackend>("recast:navmesh");
/** Token for the sim-side recast crowd system. Inject in sim systems that drive agents. */
export const RecastCrowdTok = resourceToken<RecastCrowdSystem>("recast:crowd");

// ── Descriptor ──

export const RecastLib: EngineLibrary<RecastLibConfig> = {
  name: "recast",
  version: "1.0.0",

  // No SAB channels — recast is sim-only, results synced via main SimBuffer.
  sabChannels: [],

  provides: [RecastNavMeshTok, RecastCrowdTok],

  sim: {
    async create(config, ctx) {
      const backend = new RecastBackend();
      await backend.init();
      const crowd = new RecastCrowdSystem(backend, {
        maxAgents: config.maxAgents ?? 512,
        maxAgentRadius: config.maxAgentRadius ?? 0.6,
      });
      ctx.provide(RecastNavMeshTok, backend);
      ctx.provide(RecastCrowdTok, crowd);
      return { backend, crowd };
    },
    dispose(system) {
      const { backend, crowd } = system as { backend: RecastBackend; crowd: RecastCrowdSystem };
      crowd.destroy();
      backend.destroy();
    },
    // tick is game-specific (calls crowd.update via the registered ECS system,
    // setTarget per agent, repathing, etc.) — games wire this via onReady.
  },

  tickPhase: "post-physics",

  // No renderer setup — recast is entirely sim-side.

  defaultConfig: {
    agentRadius: 0.5,
    agentHeight: 1.8,
    maxAgents: 512,
    maxAgentRadius: 0.6,
  },
};
