import type { Plugin, PluginContext } from "@downdraft/core";
import { physicsBackendRegistry } from "@downdraft/core";
import { RapierPhysicsBackend } from "./backend";

export { RapierPhysicsBackend };

export const PhysicsRapierPlugin: Plugin = {
  name: "physics-rapier",
  version: "0.1.0",
  register(ctx: PluginContext) {
    const backend = new RapierPhysicsBackend();
    physicsBackendRegistry.register("rapier", backend);

    ctx.registerResource("physicsConfig", {
      gravity: [0, -9.81, 0],
      realmCount: 1,
      backend: "rapier",
    });

    ctx.registerResource("physicsBackend", backend);

    ctx.onDispose(() => {
      physicsBackendRegistry.unregister("rapier");
    });
  },
};
