import type { Plugin, PluginContext } from "@downdraft/core";
import { physicsBackendRegistry } from "@downdraft/core";
import { NativePhysicsBackend } from "./backend";

export const PhysicsNativePlugin: Plugin = {
  name: "physics-native",
  version: "0.1.0",
  register(ctx: PluginContext) {
    const backend = new NativePhysicsBackend();
    physicsBackendRegistry.register("native", backend);

    ctx.registerResource("physicsConfig", {
      gravity: [0, -9.81, 0],
      realmCount: 1,
      backend: "native",
    });

    ctx.registerResource("physicsBackend", backend);

    ctx.onDispose(() => {
      physicsBackendRegistry.unregister("native");
    });
  },
};

export { NativePhysicsBackend } from "./backend";
export { Broadphase } from "./broadphase";
export type { AABB } from "./broadphase";
export { detectCollision } from "./narrowphase";
export type { ContactManifoldLocal, ContactPoint } from "./narrowphase";
export { resolveContact, integrate } from "./solver";
export type { BodyData } from "./solver";
export * from "./types";
