// ============================================================================
// StickmanLib — declarative engine library descriptor for @downdraft/library-stickman
//
// Games declare `libraries: [StickmanLib]` in their GameModule. The host
// provides the stickman skeleton computation function (sim-side) via a typed
// token.
//
// Games that need full control can still import computeSkeleton, the
// thick-line geometry builders, and STICKMAN_WGSL directly (escape hatch).
//
// NOTE: This package does not declare a dependency on @downdraft/core in its
// package.json. We use a type-only import for EngineLibrary (erased at compile
// time) and a relative import for the resourceToken runtime function.
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { computeSkeleton } from "./skeleton";

// ── Config ──

export interface StickmanLibConfig {
  // Stickman is a pure computation utility — no runtime config needed.
  // Config slot reserved for future options (e.g. custom proportions).
}

// ── Typed tokens (DI) ──

/** Token for the sim-side stickman skeleton computation function. */
export const StickmanTok = resourceToken<typeof computeSkeleton>("stickman:skeleton");

// ── Descriptor ──

export const StickmanLib: EngineLibrary<StickmanLibConfig> = {
  name: "stickman",
  version: "1.0.0",

  provides: [StickmanTok],

  sim: {
    create(_config, ctx) {
      // The stickman library is a pure computation utility — no stateful
      // system to instantiate. We provide the computeSkeleton function so
      // sim systems can inject it and call it per-entity per-tick.
      ctx.provide(StickmanTok, computeSkeleton);
      return computeSkeleton;
    },
    dispose(_system) {
      // Pure function — no resources to free.
    },
    // tick is game-specific (calls computeSkeleton per player entity with
    // the entity's pose, uploads the result to a thick-line vertex buffer)
    // — games wire this via onReady.
  },

  tickPhase: "post-physics",

  // No renderer setup — stickman rendering is game-specific (the game
  // creates a render pass using STICKMAN_WGSL + thick-line geometry).

  defaultConfig: {},
};
