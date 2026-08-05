import type { Plugin, PluginContext } from "@downdraft/core";
import { physicsBackendRegistry } from "@downdraft/core";
import { UniversalPhysicsAPI } from "./api";
import { RapierPhysicsBackend } from "./backend";

export { UniversalPhysicsAPI } from "./api";
export { RapierPhysicsBackend } from "./backend";
export { bulkReadMultiRealm, bulkReadTransforms, bulkWriteTransforms } from "./bulk-ops";

export const PhysicsRapierPlugin: Plugin = {
  name: "physics-rapier",
  version: "0.2.0",
  register(ctx: PluginContext) {
    const backend = new RapierPhysicsBackend();
    physicsBackendRegistry.register("rapier", backend);

    const api = new UniversalPhysicsAPI(backend, {
      gravity: [0, -9.81, 0],
      fixedDt: 1 / 60,
      maxCatchUpSteps: 5,
      stepBudgetMs: 12,
      maxEntities: 10000,
      realmConfigs: {
        near: { tickFrequency: 1, solverIterations: 4, promoteThreshold: 50, demoteThreshold: 60, demoteDwellTime: 1 },
        mid: { tickFrequency: 2, solverIterations: 2, promoteThreshold: 120, demoteThreshold: 150, demoteDwellTime: 2 },
        far: { tickFrequency: 6, solverIterations: 1, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 5 },
      },
      nanSweepInterval: 10,
      nanSweepVelocityThreshold: 0.1,
      ccdTunnelingRatio: 0.5,
      snapshotInterval: 30,
      predictionMode: "server-authoritative",
      workerCount: 0,
      devMode: false,
      duplicateStatics: true,
    });

    ctx.registerResource("physicsConfig", {
      gravity: [0, -9.81, 0],
      realmCount: 3,
      backend: "rapier",
    });

    ctx.registerResource("physicsBackend", backend);
    ctx.registerResource("physicsAPI", api);

    ctx.onDispose(() => {
      api.destroy();
      physicsBackendRegistry.unregister("rapier");
    });
  },
};
