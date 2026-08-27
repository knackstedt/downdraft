// ============================================================================
// @downdraft/plugin-movement-3d — 3D first-person/third-person movement
//
// Provides a movement system that reads input from the InputBuffer and writes
// velocity/position to the SimBuffer. Supports walk, run, swim, fly modes.
// Games configure speed, gravity, jump height, etc. via the plugin config.
// ============================================================================

import { resourceToken, type Plugin, type PluginContext } from "@downdraft/core";

export interface Movement3DConfig {
  walkSpeed?: number;
  runSpeed?: number;
  jumpHeight?: number;
  gravity?: number;
  swimSpeed?: number;
  flyMode?: boolean;
}

export const Movement3DStateTok = resourceToken<unknown>("movement-3d:state");

export function createMovement3DPlugin(config: Movement3DConfig = {}): Plugin {
  const cfg = {
    walkSpeed: config.walkSpeed ?? 4.0,
    runSpeed: config.runSpeed ?? 8.0,
    jumpHeight: config.jumpHeight ?? 1.5,
    gravity: config.gravity ?? 9.8,
    swimSpeed: config.swimSpeed ?? 3.0,
    flyMode: config.flyMode ?? false,
  };
  return {
    name: "movement-3d",
    version: "1.0.0",
    provides: [Movement3DStateTok],
    register(ctx: PluginContext) {
      ctx.provide(Movement3DStateTok, cfg);
      // The actual system registration is game-specific (depends on the
      // sim's entity model + component layout). Games register a system
      // that reads cfg from Movement3DStateTok and applies movement.
    },
  };
}
