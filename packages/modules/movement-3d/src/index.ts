// ============================================================================
// @downdraft/module-movement-3d — 3D first-person/third-person movement
//
// Provides CharacterMotor3D: a configurable character movement kernel that
// computes desired per-tick deltas (heading-relative WASD, walk/run, jump +
// gravity, swimming, free-fly, turn-to-face). Collision resolution stays with
// the game's physics backend (Rapier character controller, terrain query…).
//
// The module wraps the factory in a DI token for module-host games; games
// with hand-rolled sims can import createCharacterMotor3D directly.
// ============================================================================

import { resourceToken, type Module, type ModuleContext } from "@downdraft/core";
import { createCharacterMotor3D, type CharacterMotor3D, type CharacterMotor3DConfig } from "./character-motor";

export {
    angleDelta,
    createCharacterMotor3D,
    headingBasis
} from "./character-motor";
export type {
    CharacterMotor3D,
    CharacterMotor3DConfig,
    Motor3DDelta,
    Motor3DEnv,
    Motor3DInput,
    Motor3DState
} from "./character-motor";

export interface Movement3DConfig extends CharacterMotor3DConfig {}

export const CharacterMotor3DTok = resourceToken<CharacterMotor3D>("movement-3d:motor");

/** @deprecated Use CharacterMotor3DTok. */
export const Movement3DStateTok = resourceToken<unknown>("movement-3d:state");

export function createMovement3DModule(config: Movement3DConfig): Module {
  return {
    name: "movement-3d",
    version: "1.0.0",
    provides: [CharacterMotor3DTok],
    register(ctx: ModuleContext) {
      ctx.provide(CharacterMotor3DTok, createCharacterMotor3D(config));
    },
  };
}
