// ============================================================================
// @downdraft/engine/modules/movement-2d — 2D side-scrolling grid character movement
//
// Provides a configurable AABB-vs-grid character controller
// (createGridCharacterController): platformer physics with collision,
// step-up, swimming, ladder climbing, noclip, fall damage, bury/crush, and
// contact hazards. The game supplies cell predicates via GridCharacterWorld.
//
// The module wraps the factory in a DI token for module-host games; games
// with hand-rolled sims can import createGridCharacterController directly.
// ============================================================================

import { resourceToken, type Module, type ModuleContext } from "@downdraft/engine";
import { createGridCharacterController, type GridCharacterConfig, type GridCharacterController } from "./grid-character";

export {
    createGridCharacterController
} from "./grid-character";
export type {
    GridCharacterConfig,
    GridCharacterController,
    GridCharacterInput,
    GridCharacterMods,
    GridCharacterState,
    GridCharacterWorld,
    GridDamageKind
} from "./grid-character";

export interface Movement2DConfig extends GridCharacterConfig {}

export const GridCharacterControllerTok = resourceToken<GridCharacterController>("movement-2d:grid-character");

/** @deprecated Use GridCharacterControllerTok. */
export const Movement2DStateTok = resourceToken<unknown>("movement-2d:state");

export function createMovement2DModule(config: Movement2DConfig): Module {
  return {
    name: "movement-2d",
    version: "1.0.0",
    provides: [GridCharacterControllerTok],
    register(ctx: ModuleContext) {
      ctx.provide(GridCharacterControllerTok, createGridCharacterController(config));
    },
  };
}
