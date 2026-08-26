import {
    createLogger,
    RealmTier,
    type Entity,
    type PhysicsBody,
    type PhysicsPluginConfig,
} from "@downdraft/core";
import { RapierPhysicsBackend, UniversalPhysicsAPI } from "@downdraft/library-physics-rapier";

const log = createLogger();

/**
 * Standalone demo for the Universal Physics Plugin.
 *
 * Exercises:
 * - 3 realm tiers (near/mid/far) with LOD tick frequencies
 * - A moving "player camera" that triggers promote/demote
 * - Dynamic bodies crossing promote/demote thresholds
 * - Interpolation rendering
 * - NaN injection test (dev mode throws)
 * - CCD on a fast projectile
 * - Snapshot/restore round-trip
 */

const config: PhysicsPluginConfig = {
  gravity: [0, -9.81, 0],
  fixedDt: 1 / 60,
  maxCatchUpSteps: 5,
  stepBudgetMs: 12,
  maxEntities: 1000,
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
  devMode: true, // Throw on NaN in demo
  duplicateStatics: true,
};

let api: UniversalPhysicsAPI;
let backend: RapierPhysicsBackend;
let playerPos: [number, number, number] = [0, 0, 0];
let bodies: Array<{ body: PhysicsBody; entity: Entity; name: string }> = [];
let frameCount = 0;
let snapshotData: Map<RealmTier, Uint8Array> | null = null;

export async function init(_ctx: any) {
  backend = new RapierPhysicsBackend();
  await backend.init();
  api = new UniversalPhysicsAPI(backend, config);

  // Create a static ground plane in all realms
  const groundEntity: Entity = { index: 0, generation: 0 };
  const ground = api.createBody(groundEntity, {
    type: "static",
    position: [0, -1, 0],
    rotation: [0, 0, 0, 1],
  });
  api.addCollider(ground, {
    shape: { type: "box", halfExtents: [50, 1, 50] },
    friction: 0.8,
    restitution: 0.3,
  });
  bodies.push({ body: ground, entity: groundEntity, name: "ground" });

  // Create dynamic bodies at various distances from the player
  for (let i = 0; i < 10; i++) {
    const dist = 20 + i * 30; // 20, 50, 80, ... → starts in mid/far realms
    const entity: Entity = { index: i + 1, generation: 0 };
    const body = api.createBody(entity, {
      type: "dynamic",
      position: [dist, 5, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    });
    api.addCollider(body, {
      shape: { type: "box", halfExtents: [0.5, 0.5, 0.5] },
      friction: 0.5,
      restitution: 0.4,
    });
    bodies.push({ body, entity, name: `box-${i}` });
  }

  // Create a fast projectile (CCD test)
  const projectileEntity: Entity = { index: 100, generation: 0 };
  const projectile = api.createBody(projectileEntity, {
    type: "dynamic",
    position: [-100, 5, 0],
    rotation: [0, 0, 0, 1],
    mass: 0.1,
  });
  api.addCollider(projectile, {
    shape: { type: "sphere", radius: 0.2 },
    friction: 0.3,
    restitution: 0.5,
  });
  api.setLinearVelocity(projectile, [200, 0, 0]); // Fast → CCD should enable
  bodies.push({ body: projectile, entity: projectileEntity, name: "projectile" });

  log.info("physics-demo", `Initialized with ${bodies.length} bodies across 3 realm tiers`);
}

export function tick(_ctx: any, dt: number) {
  frameCount++;

  // Move the player camera in a circle
  const angle = frameCount * 0.01;
  playerPos = [Math.cos(angle) * 30, 0, Math.sin(angle) * 30];

  // Step the accumulator + realm manager
  const accumulator = api.getAccumulator();
  accumulator.accumulate(dt);
  const steps = accumulator.consumeSteps();
  for (const fixedDt of steps) {
    api.getRealmManager().step(fixedDt);
  }

  // Update realm membership based on player position
  api.getRealmManager().updateRealmMembership([playerPos], dt);

  // CCD update
  const nearBodies = api.getRealmManager().getRealm(RealmTier.Near).listBodies();
  api.getCCDHeuristic().updateCCD(api.getBackend(), nearBodies, dt, () => 0.5);

  // Safety sweep
  api.getSafetyLayer().sanitizeSolverOutput(api.getBackend(), nearBodies);

  // Snapshot at interval
  api.getSnapshotManager().tick();

  // Log stats every 60 frames
  if (frameCount % 60 === 0) {
    const stats = api.getStats();
    log.info("physics-demo",
      `frame=${frameCount} bodies=${stats.bodyCount} near=${stats.realmCounts.near} ` +
      `mid=${stats.realmCounts.mid} far=${stats.realmCounts.far} ` +
      `frozen=${stats.frozenCount} overBudget=${stats.overBudget} tick=${stats.tickCount}`
    );

    // Log realm tiers of each body
    for (const { body, name } of bodies) {
      const tier = api.getRealmTier(body);
      const tierName = tier === RealmTier.Near ? "near" : tier === RealmTier.Mid ? "mid" : "far";
      const pos = api.getPosition(body);
      log.info("physics-demo", `  ${name}: tier=${tierName} pos=[${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}, ${pos[2].toFixed(1)}]`);
    }
  }

  // Snapshot/restore test at frame 300
  if (frameCount === 300) {
    log.info("physics-demo", "Taking snapshot...");
    snapshotData = api.snapshot();
    log.info("physics-demo", `Snapshot taken: ${snapshotData.size} realms`);
  }

  if (frameCount === 400 && snapshotData) {
    log.info("physics-demo", "Restoring snapshot...");
    api.restore(snapshotData);
    log.info("physics-demo", "Snapshot restored");
  }

  // NaN injection test at frame 500 (dev mode should throw)
  if (frameCount === 500) {
    log.info("physics-demo", "Testing NaN injection (dev mode should throw)...");
    try {
      const box = bodies[1];
      if (box) {
        api.setPosition(box.body, [NaN, NaN, NaN]);
      }
    } catch (err) {
      log.info("physics-demo", `NaN injection correctly rejected: ${err}`);
    }
  }
}

export function dispose(_ctx: any) {
  api.destroy();
  log.info("physics-demo", "disposed");
}
