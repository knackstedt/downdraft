import type { Plugin, PluginContext, Query } from "@downdraft/core";
import type { WildlifeConfig, WildlifeDeps } from "./types";
import { createWildlifeSystem, shutdownWildlife } from "./wildlife-system";

export interface WildlifePluginOptions {
  wildlifeQuery: Query;
  playersQuery: Query;
  shipsQuery: Query;
  allEntitiesQuery: Query;
  deps: WildlifeDeps;
  config: WildlifeConfig;
}

export function createWildlifePlugin(opts: WildlifePluginOptions): Plugin {
  return {
    name: "wildlife",
    version: "1.0.0",
    register(ctx: PluginContext) {
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
