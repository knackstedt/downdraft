import type { Plugin } from "@downdraft/core";

export const PhysicsRapierPlugin: Plugin = {
  name: "physics-rapier",
  version: "0.1.0",
  register(ctx) {
    ctx.registerResource("physicsConfig", {
      gravity: [0, -9.81, 0],
      realmCount: 1,
    });
    ctx.onDispose(() => {
      console.log("[physics-rapier] disposed");
    });
  },
};
