import type { Entity } from "../ecs/entity";
import type { Query } from "../ecs/query";
import { Stage, system, type System } from "../ecs/system";
import type { World } from "../ecs/world";
import { PhysicsTransform, RigidBody, Velocity } from "./body";
import type { CCDHeuristic } from "./ccd-heuristic";
import type { PhysicsBackend, PhysicsBody } from "./interface";
import { RealmTier } from "./interface";
import type { InterpolationBuffer } from "./interpolation-buffer";
import type { LoadShedder } from "./load-shedder";
import type { PhysicsAccumulator } from "./physics-accumulator";
import type { RealmManager } from "./realm-manager";
import type { SafetyLayer } from "./safety";
import type { SnapshotManager } from "./snapshot-manager";

/**
 * ECS system that drives the multi-realm physics simulation.
 *
 * Registered in `Stage.Physics`. Per ECS step:
 * 1. Sync ECS transform → physics (kinematic/static bodies).
 * 2. accumulator.consumeSteps() → for each step: realmManager.step(dt).
 * 3. realmManager.updateRealmMembership(playerCameras).
 * 4. interpolationBuffer.writeTick().
 * 5. loadShedder.checkBudget() → aggressive sleep, then hard freeze if needed.
 * 6. ccdHeuristic.updateCCD().
 * 7. safety.sanitizeSolverOutput() every tick; safety.periodicFiniteSweep() on interval.
 * 8. Sync physics → ECS (dynamic bodies).
 * 9. snapshotManager.tick().
 */
export interface PhysicsSystemResources {
  backend: PhysicsBackend;
  realmManager: RealmManager;
  accumulator: PhysicsAccumulator;
  interpolationBuffer: InterpolationBuffer;
  loadShedder: LoadShedder;
  safety: SafetyLayer;
  ccdHeuristic: CCDHeuristic;
  snapshotManager: SnapshotManager;
  /** Player camera positions for realm membership updates. */
  playerCameras: ReadonlyArray<readonly [number, number, number]>;
  /** Max entities for interpolation buffer sizing. */
  maxEntities: number;
  /** Interval for periodic finite sweeps (default 10 ticks). */
  nanSweepInterval?: number;
  /** Velocity threshold for periodic sweeps (default 0.1). */
  nanSweepVelocityThreshold?: number;
}

/**
 * Create the physics system. The resources are attached to the system
 * via closure (the caller provides them when creating the system).
 */
export function createPhysicsSystem(resources: PhysicsSystemResources): System {
  const query: Query = {
    descriptor: {
      required: [RigidBody.id, PhysicsTransform.id],
      excluded: [],
      lastReadTick: 0,
    },
    // Stubs — the actual query is iterated via archetypes in the system fn
  } as unknown as Query;

  return system(
    "PhysicsSystem",
    Stage.Physics,
    (ctx) => {
      const { world, dt } = ctx;
      const {
        backend,
        realmManager,
        accumulator,
        interpolationBuffer,
        loadShedder,
        safety,
        ccdHeuristic,
        snapshotManager,
        playerCameras,
        maxEntities,
        nanSweepInterval = 10,
        nanSweepVelocityThreshold = 0.1,
      } = resources;

      // 1. Sync ECS transform → physics (kinematic/static bodies)
      syncEcsToPhysics(world, realmManager);

      // 2. Accumulate real dt and consume fixed steps
      accumulator.accumulate(dt);
      const steps = accumulator.consumeSteps();

      const stepStart = performance.now();
      for (const fixedDt of steps) {
        realmManager.step(fixedDt);
      }
      const stepWallMs = steps.length > 0 ? (performance.now() - stepStart) / steps.length : 0;
      accumulator.recordStepWallTime(stepWallMs);

      // 3. Update realm membership (promote/demote based on distance)
      realmManager.updateRealmMembership(playerCameras, dt);

      // 4. Write tick to interpolation buffer
      const nearRealm = realmManager.getRealm(RealmTier.Near);
      interpolationBuffer.writeTick(
        nearRealm.id,
        (realmId, buf, count) => backend.readTransforms(realmId, buf, count),
        maxEntities,
      );

      // 5. Load shedding
      if (loadShedder.checkBudget(accumulator)) {
        const nearBodies = nearRealm.listBodies();
        loadShedder.aggressiveSleep(nearRealm.id, backend, nearBodies);
        if (accumulator.isOverBudget()) {
          loadShedder.shed(nearRealm.id, backend, RealmTier.Near);
        }
      }
      loadShedder.tick(accumulator, backend);

      // 6. CCD heuristic update
      const dynamicBodies = nearRealm.listBodies();
      ccdHeuristic.updateCCD(backend, dynamicBodies, dt, (_body) => {
        return 0.5; // Default collider size; caller can override
      });

      // 7. Safety: sanitize solver output every tick; periodic sweep on interval
      safety.sanitizeSolverOutput(backend, dynamicBodies);
      safety.periodicFiniteSweep(backend, dynamicBodies, nanSweepInterval, nanSweepVelocityThreshold);

      // 8. Sync physics → ECS (dynamic bodies)
      syncPhysicsToEcs(world, realmManager);

      // 9. Snapshot tick
      snapshotManager.tick();
    },
    { queries: [query] },
  );
}

/**
 * Iterate entities that have RigidBody + PhysicsTransform components.
 * Uses the archetype graph directly (no per-frame allocation).
 */
function* iterRigidBodies(world: World): Generator<{ entity: Entity; rb: RigidBodyDataView; transform: PhysicsTransformDataView; velocity?: VelocityDataView }> {
  const rbId = RigidBody.id;
  const transformId = PhysicsTransform.id;
  const velocityId = Velocity.id;

  for (const arch of world.allArchetypes) {
    if (!arch.componentSet.has(rbId) || !arch.componentSet.has(transformId)) continue;

    const rbCol = arch.columns.get(rbId);
    const transformCol = arch.columns.get(transformId);
    const velocityCol = arch.columns.get(velocityId);
    if (!rbCol || !transformCol) continue;

    for (let i = 0; i < arch.entities.length; i++) {
      const entity = arch.entities[i];
      yield {
        entity,
        rb: rbCol[i] as RigidBodyDataView,
        transform: transformCol[i] as PhysicsTransformDataView,
        velocity: velocityCol?.[i] as VelocityDataView | undefined,
      };
    }
  }
}

/**
 * Sync ECS transform data → physics backend for kinematic/static bodies.
 * Dynamic bodies are driven by the physics simulation, not ECS.
 */
function syncEcsToPhysics(world: World, realmManager: RealmManager): void {
  for (const { rb, transform } of iterRigidBodies(world)) {
    if (rb.bodyType === "dynamic") continue;

    const body = findBody(realmManager, rb.bodyId, rb.realmId);
    if (!body) continue;

    const realm = realmManager.getRealm(body.realmId as RealmTier);
    realm.setPosition(body, transform.position);
    realm.setRotation(body, transform.rotation);
  }
}

/**
 * Sync physics backend → ECS transform data for dynamic bodies.
 */
function syncPhysicsToEcs(world: World, realmManager: RealmManager): void {
  for (const { rb, transform, velocity } of iterRigidBodies(world)) {
    if (rb.bodyType !== "dynamic") continue;

    const body = findBody(realmManager, rb.bodyId, rb.realmId);
    if (!body) continue;

    const realm = realmManager.getRealm(body.realmId as RealmTier);
    const pos = realm.getPosition(body);
    const rot = realm.getRotation(body);

    // Store previous for interpolation
    transform.prevPosition = transform.position;
    transform.prevRotation = transform.rotation;
    transform.position = pos;
    transform.rotation = rot;

    // Also sync velocity
    if (velocity) {
      velocity.linear = realm.getLinearVelocity(body);
    }
  }
}

/** Look up a PhysicsBody by bodyId + realmId in the RealmManager. */
function findBody(realmManager: RealmManager, bodyId: number, realmId: number): PhysicsBody | null {
  for (const tier of [RealmTier.Near, RealmTier.Mid, RealmTier.Far]) {
    const realm = realmManager.getRealm(tier);
    if (realm.id !== realmId) continue;
    const body = realm.getBody(bodyId);
    if (body) return body;
  }
  return null;
}

// Type helpers for component data views (the ECS stores mutable refs)
interface RigidBodyDataView {
  bodyType: string;
  bodyId: number;
  realmId: number;
}
interface PhysicsTransformDataView {
  position: [number, number, number];
  rotation: [number, number, number, number];
  prevPosition: [number, number, number];
  prevRotation: [number, number, number, number];
}
interface VelocityDataView {
  linear: [number, number, number];
  angular: [number, number, number];
}
