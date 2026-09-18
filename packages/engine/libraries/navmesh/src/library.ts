// ============================================================================
// NavmeshLib — declarative engine library descriptor for @downdraft/engine/libraries/navmesh
//
// Games declare `libraries: [NavmeshLib]` (or with config override) in their
// GameModule. The host creates the NavMesh + Pathfinder (sim-side) and
// exposes them via typed tokens.
//
// Games that need full control can still import NavMesh, Pathfinder, and
// CrowdSystem directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { NavMesh } from "./navmesh";
import { Pathfinder } from "./pathfinder";

// ── Config ──

export interface NavmeshLibConfig {
  /** Spatial grid cell size for polygon queries. Default: 4. */
  spatialCellSize?: number;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side navigation mesh. Inject in sim systems that need pathfinding. */
export const NavmeshTok = resourceToken<NavMesh>("navmesh:mesh");
/** Token for the sim-side pathfinder. Inject in sim systems that need path queries. */
export const PathfinderTok = resourceToken<Pathfinder>("navmesh:pathfinder");

// ── Descriptor ──

export const NavmeshLib: EngineLibrary<NavmeshLibConfig> = {
  name: "navmesh",
  version: "1.0.0",

  provides: [NavmeshTok, PathfinderTok],

  sim: {
    create(config, ctx) {
      const cellSize = config.spatialCellSize ?? 4;
      const navMesh = new NavMesh(cellSize);
      const pathfinder = new Pathfinder(navMesh);
      ctx.provide(NavmeshTok, navMesh);
      ctx.provide(PathfinderTok, pathfinder);
      return { navMesh, pathfinder };
    },
    dispose(system) {
      const { navMesh } = system as { navMesh: NavMesh; pathfinder: Pathfinder };
      // NavMesh holds only JS arrays/typed arrays — clear them to release memory.
      navMesh.clear();
    },
    // tick is game-specific (calls crowdSystem.register() + setTarget() per
    // agent, repathing, etc.) — games wire this via onReady.
  },

  tickPhase: "post-physics",

  // No renderer setup — navmesh debug viz is game-specific (the game creates
  // a NavMeshDebugViz pass if needed).

  defaultConfig: {
    spatialCellSize: 4,
  },
};
