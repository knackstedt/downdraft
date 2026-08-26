// ============================================================================
// @downdraft/plugin-movement-2d — 2D top-down/side-scrolling movement
//
// Provides a 2D movement system for grid-based or continuous 2D games.
// Reads input from the InputBuffer and writes velocity/position.
// ============================================================================

import { resourceToken, type Plugin, type PluginContext } from "@downdraft/core";

export interface Movement2DConfig {
  speed?: number;
  diagonalNormalization?: boolean;
  gridSnap?: boolean;
  gridSize?: number;
}

export const Movement2DStateTok = resourceToken<unknown>("movement-2d:state");

export function createMovement2DPlugin(config: Movement2DConfig = {}): Plugin {
  const cfg = {
    speed: config.speed ?? 5.0,
    diagonalNormalization: config.diagonalNormalization ?? true,
    gridSnap: config.gridSnap ?? false,
    gridSize: config.gridSize ?? 32,
  };
  return {
    name: "movement-2d",
    version: "1.0.0",
    provides: [Movement2DStateTok],
    register(ctx: PluginContext) {
      ctx.provide(Movement2DStateTok, cfg);
      ctx.onDispose(() => {});
    },
  };
}
