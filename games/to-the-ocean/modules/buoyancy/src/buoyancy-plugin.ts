import type { Module, ModuleContext, Query } from "@downdraft/core";
import { createBuoyancySystem } from "./buoyancy-system";
import type { BuoyancyConfig, BuoyancyDeps } from "./types";

export interface BuoyancyModuleOptions {
  shipsQuery: Query;
  allEntitiesQuery: Query;
  deps: BuoyancyDeps;
  config: BuoyancyConfig;
}

export function createBuoyancyModule(opts: BuoyancyModuleOptions): Module {
  return {
    name: "buoyancy",
    version: "1.0.0",
    register(ctx: ModuleContext) {
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
