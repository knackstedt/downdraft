import type { Plugin, PluginContext, Query } from "@downdraft/core";
import { createBuoyancySystem } from "./buoyancy-system";
import type { BuoyancyConfig, BuoyancyDeps } from "./types";

export interface BuoyancyPluginOptions {
  shipsQuery: Query;
  allEntitiesQuery: Query;
  deps: BuoyancyDeps;
  config: BuoyancyConfig;
}

export function createBuoyancyPlugin(opts: BuoyancyPluginOptions): Plugin {
  return {
    name: "buoyancy",
    version: "1.0.0",
    register(ctx: PluginContext) {
      const sys = createBuoyancySystem(
        opts.shipsQuery,
        opts.allEntitiesQuery,
        opts.deps,
        opts.config,
      );
      ctx.registerSystemObject(sys);
    },
  };
}
