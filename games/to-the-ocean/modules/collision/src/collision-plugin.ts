import type { Module, ModuleContext, Query } from "@downdraft/core";
import { createCollisionSystem } from "./collision-system";
import type { CollisionConfig, CollisionDeps } from "./types";

export interface CollisionModuleOptions {
  allEntitiesQuery: Query;
  playersQuery: Query;
  deps: CollisionDeps;
  config: CollisionConfig;
}

export function createCollisionModule(opts: CollisionModuleOptions): Module {
  return {
    name: "collision",
    version: "1.0.0",
    register(ctx: ModuleContext) {
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
