import type { Plugin, PluginContext, Query } from "@downdraft/core";
import { createCollisionSystem } from "./collision-system";
import type { CollisionConfig, CollisionDeps } from "./types";

export interface CollisionPluginOptions {
  allEntitiesQuery: Query;
  playersQuery: Query;
  deps: CollisionDeps;
  config: CollisionConfig;
}

export function createCollisionPlugin(opts: CollisionPluginOptions): Plugin {
  return {
    name: "collision",
    version: "1.0.0",
    register(ctx: PluginContext) {
      const sys = createCollisionSystem(
        opts.allEntitiesQuery,
        opts.playersQuery,
        opts.deps,
        opts.config,
      );
      ctx.registerSystemObject(sys);
    },
  };
}
