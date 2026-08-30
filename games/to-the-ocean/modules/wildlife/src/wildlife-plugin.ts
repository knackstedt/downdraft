import type { Module, ModuleContext, Query } from "@downdraft/core";
import type { WildlifeConfig, WildlifeDeps } from "./types";
import { createWildlifeSystem, shutdownWildlife } from "./wildlife-system";

export interface WildlifeModuleOptions {
  wildlifeQuery: Query;
  playersQuery: Query;
  shipsQuery: Query;
  allEntitiesQuery: Query;
  deps: WildlifeDeps;
  config: WildlifeConfig;
}

export function createWildlifeModule(opts: WildlifeModuleOptions): Module {
  return {
    name: "wildlife",
    version: "1.0.0",
    register(ctx: ModuleContext) {
      const sys = createWildlifeSystem(
        opts.wildlifeQuery,
        opts.playersQuery,
        opts.shipsQuery,
        opts.allEntitiesQuery,
        opts.deps,
        opts.config,
      );
      ctx.registerSystemObject(sys);
      ctx.onDispose(() => shutdownWildlife());
    },
  };
}
