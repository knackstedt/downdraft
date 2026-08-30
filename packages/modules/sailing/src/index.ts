// ============================================================================
// @downdraft/module-sailing — sailing mechanics (wind + buoyancy + steering)
//
// Composes water physics (wave sampling, buoyancy) with sailing mechanics
// (wind force, sail trim, rudder steering, hull drag). Requires the water
// library's WaterWriterTok to sample wave heights for buoyancy.
// ============================================================================

import { resourceToken, type Module, type ModuleContext } from "@downdraft/core";
import { WaterWriterTok } from "@downdraft/library-water";

export interface SailingConfig {
  baseWindSpeed?: number;
  baseWindDirection?: number;
  sailArea?: number;
  rudderArea?: number;
  hullDragCoeff?: number;
  maxTurnRate?: number;
}

export const SailingStateTok = resourceToken<unknown>("sailing:state");
export const WindStateTok = resourceToken<{ speed: number; direction: number }>("sailing:wind");

export function createSailingModule(config: SailingConfig = {}): Module {
  const cfg = {
    baseWindSpeed: config.baseWindSpeed ?? 8.0,
    baseWindDirection: config.baseWindDirection ?? 0,
    sailArea: config.sailArea ?? 50,
    rudderArea: config.rudderArea ?? 10,
    hullDragCoeff: config.hullDragCoeff ?? 0.3,
    maxTurnRate: config.maxTurnRate ?? 0.5,
  };
  return {
    name: "sailing",
    version: "1.0.0",
    requires: [WaterWriterTok],
    provides: [SailingStateTok, WindStateTok],
    register(ctx: ModuleContext) {
      // Inject the water writer (validated by `requires`).
      // The water writer is used by the game's sailing system to sample
      // wave heights for buoyancy. The plugin validates the dependency
      // exists; the game's system reads it from the DI graph.
      ctx.injectOptional(WaterWriterTok);
      ctx.provide(SailingStateTok, cfg);
      ctx.provide(WindStateTok, { speed: cfg.baseWindSpeed, direction: cfg.baseWindDirection });
      // The actual sailing system (force calculation, rudder integration,
      // hull drag) is game-specific and registered as an ECS system by
      // the game. This plugin provides config + wind state via DI.
    },
  };
}
