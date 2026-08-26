import type {
    BodyDesc,
    ColliderDesc,
    Entity,
    PhysicsBackend,
    PhysicsBody,
    PhysicsPluginConfig,
    PhysicsStats,
    RaycastResult,
    RealmTransferHook,
    SnapshotHooks,
} from "@downdraft/core";
import {
    CCDHeuristic,
    InterpolationBuffer,
    LoadShedder,
    PhysicsAccumulator,
    RealmManager,
    RealmTier,
    SafetyLayer,
    SnapshotManager,
} from "@downdraft/core";

/**
 * Universal Physics API — the single public interface games use.
 *
 * All inputs are validated (NaN/Inf, physical validity) via the SafetyLayer
 * before reaching the backend. All body references are opaque `PhysicsBody`
 * — raw Rapier handles never leak.
 */
export class UniversalPhysicsAPI {
  private backend: PhysicsBackend;
  private realmManager: RealmManager;
  private accumulator: PhysicsAccumulator;
  private interpolationBuffer: InterpolationBuffer;
  private loadShedder: LoadShedder;
  private safety: SafetyLayer;
  private ccdHeuristic: CCDHeuristic;
  private snapshotManager: SnapshotManager;
  private config: PhysicsPluginConfig;

  constructor(backend: PhysicsBackend, config: PhysicsPluginConfig) {
    this.backend = backend;
    this.config = config;

    this.safety = new SafetyLayer({ devMode: config.devMode ?? false });
    this.accumulator = new PhysicsAccumulator({
      fixedDt: config.fixedDt,
      maxCatchUpSteps: config.maxCatchUpSteps,
      stepBudgetMs: config.stepBudgetMs,
    });
    this.interpolationBuffer = new InterpolationBuffer(config.maxEntities);
    this.loadShedder = new LoadShedder();
    this.ccdHeuristic = new CCDHeuristic({ ccdTunnelingRatio: config.ccdTunnelingRatio });

    this.realmManager = new RealmManager({
      backend,
      nearConfig: {
        name: "near",
        gravity: config.gravity,
        tierConfig: config.realmConfigs.near,
      },
      midConfig: {
        name: "mid",
        gravity: config.gravity,
        tierConfig: config.realmConfigs.mid,
      },
      farConfig: {
        name: "far",
        gravity: config.gravity,
        tierConfig: config.realmConfigs.far,
      },
    });

    this.snapshotManager = new SnapshotManager({
      realmManager: this.realmManager,
      backend,
      snapshotInterval: config.snapshotInterval,
      predictionMode: config.predictionMode,
    });
  }

  // --- Body lifecycle ---

  createBody(entity: Entity, desc: BodyDesc, importance: number = 0): PhysicsBody {
    this.safety.assertBodyDescValid(desc);
    return this.realmManager.registerBody(entity, desc, importance);
  }

  destroyBody(body: PhysicsBody): void {
    this.realmManager.unregisterBody(body);
  }

  addCollider(body: PhysicsBody, desc: ColliderDesc): number {
    return this.realmManager.addCollider(body, desc);
  }

  removeCollider(body: PhysicsBody, colliderId: number): void {
    this.realmManager.removeCollider(body, colliderId);
  }

  // --- Character controller ---

  createCharacterController(desc: import("@downdraft/core").CharacterControllerDesc, entity: import("@downdraft/core").Entity): import("@downdraft/core").CharacterControllerHandle {
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    return this.backend.createCharacterController(nearRealm.id, desc, entity);
  }

  destroyCharacterController(handle: import("@downdraft/core").CharacterControllerHandle): void {
    this.backend.destroyCharacterController(handle);
  }

  characterMove(handle: import("@downdraft/core").CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): import("@downdraft/core").CharacterMoveResult {
    this.safety.assertFiniteVec3(desiredMovement, "characterMove.desiredMovement");
    this.safety.assertFinite(dt, "characterMove.dt");
    return this.backend.characterMove(handle, desiredMovement, dt);
  }

  setCharacterColliderPosition(handle: import("@downdraft/core").CharacterControllerHandle, pos: [number, number, number]): void {
    this.safety.assertFiniteVec3(pos, "setCharacterColliderPosition.pos");
    this.backend.setCharacterColliderPosition(handle, pos);
  }

  // --- Joints ---

  createJoint(parentBody: PhysicsBody, childBody: PhysicsBody, desc: import("@downdraft/core").JointDesc): number {
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    return this.backend.createJoint(nearRealm.id, parentBody, childBody, desc);
  }

  destroyJoint(jointId: number): void {
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    this.backend.destroyJoint(nearRealm.id, jointId);
  }

  // --- Body type ---

  setBodyType(body: PhysicsBody, type: import("@downdraft/core").BodyType): void {
    this.backend.setBodyType(body, type);
  }

  // --- Validated state access (all PhysicsBody-keyed) ---

  setLinearVelocity(body: PhysicsBody, vel: [number, number, number]): void {
    this.safety.assertFiniteVec3(vel, "linearVelocity");
    this.backend.setLinearVelocity(body, vel);
  }

  getLinearVelocity(body: PhysicsBody): [number, number, number] {
    return this.backend.getLinearVelocity(body);
  }

  setAngularVelocity(body: PhysicsBody, vel: [number, number, number]): void {
    this.safety.assertFiniteVec3(vel, "angularVelocity");
    this.backend.setAngularVelocity(body, vel);
  }

  getAngularVelocity(body: PhysicsBody): [number, number, number] {
    return this.backend.getAngularVelocity(body);
  }

  setPosition(body: PhysicsBody, pos: [number, number, number]): void {
    this.safety.assertFiniteVec3(pos, "position");
    this.backend.setPosition(body, pos);
  }

  getPosition(body: PhysicsBody): [number, number, number] {
    return this.backend.getPosition(body);
  }

  setRotation(body: PhysicsBody, rot: [number, number, number, number]): void {
    this.safety.assertFiniteQuat(rot, "rotation");
    this.backend.setRotation(body, rot);
  }

  getRotation(body: PhysicsBody): [number, number, number, number] {
    return this.backend.getRotation(body);
  }

  applyForce(body: PhysicsBody, force: [number, number, number]): void {
    this.safety.assertFiniteVec3(force, "force");
    this.backend.applyForce(body, force);
  }

  applyImpulse(body: PhysicsBody, impulse: [number, number, number]): void {
    this.safety.assertFiniteVec3(impulse, "impulse");
    this.backend.applyImpulse(body, impulse);
  }

  applyImpulseAtPoint(body: PhysicsBody, impulse: [number, number, number], point: [number, number, number]): void {
    this.safety.assertFiniteVec3(impulse, "impulse");
    this.safety.assertFiniteVec3(point, "point");
    this.backend.applyImpulseAtPoint(body, impulse, point);
  }

  applyTorque(body: PhysicsBody, torque: [number, number, number]): void {
    this.safety.assertFiniteVec3(torque, "torque");
    this.backend.applyTorque(body, torque);
  }

  applyTorqueImpulse(body: PhysicsBody, impulse: [number, number, number]): void {
    this.safety.assertFiniteVec3(impulse, "torqueImpulse");
    this.backend.applyTorqueImpulse(body, impulse);
  }

  wakeUp(body: PhysicsBody): void {
    this.backend.wakeUp(body);
  }

  isSleeping(body: PhysicsBody): boolean {
    return this.backend.isSleeping(body);
  }

  // --- Raw fast paths (opt-in, bypass safety validation) ---
  // Callers MUST validate inputs (finiteness, quaternion normalization).
  // Use these in hot loops where per-call safety overhead matters.

  setTranslationRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean = true): void {
    this.backend.setTranslationRaw(body, x, y, z, wakeUp);
  }
  setRotationRaw(body: PhysicsBody, x: number, y: number, z: number, w: number, wakeUp: boolean = true): void {
    this.backend.setRotationRaw(body, x, y, z, w, wakeUp);
  }
  getTranslationRaw(body: PhysicsBody, out: [number, number, number]): void {
    this.backend.getTranslationRaw(body, out);
  }
  getLinearVelocityRaw(body: PhysicsBody, out: [number, number, number]): void {
    this.backend.getLinearVelocityRaw(body, out);
  }
  setLinearVelocityRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean = true): void {
    this.backend.setLinearVelocityRaw(body, x, y, z, wakeUp);
  }
  setAngularVelocityRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean = true): void {
    this.backend.setAngularVelocityRaw(body, x, y, z, wakeUp);
  }
  isSleepingRaw(body: PhysicsBody): boolean {
    return this.backend.isSleepingRaw(body);
  }
  swapColliderShapeRaw(realmId: number, colliderId: number, vertices: Float32Array, indices: Uint32Array): boolean {
    return this.backend.swapColliderShapeRaw(realmId, colliderId, vertices, indices);
  }
  reserveMemory(bytes: number): void {
    this.backend.reserveMemory(bytes);
  }
  setIntegrationDt(realmId: number, dt: number): void {
    this.backend.setIntegrationDt(realmId, dt);
  }

  // --- Realm ---

  getRealmTier(body: PhysicsBody): RealmTier {
    return this.realmManager.getRealmForBody(body);
  }

  setImportance(body: PhysicsBody, weight: number): void {
    this.safety.assertFinite(weight, "importance");
    this.realmManager.setImportance(body, weight);
    this.loadShedder.setImportance(body.id, weight);
  }

  // --- Interpolation ---

  getInterpolatedTransforms(alpha: number, outBuffer: Float32Array, entityCount: number): void {
    this.interpolationBuffer.readInterpolated(alpha, outBuffer, entityCount);
  }

  // --- Raycast (realm-aware: queries the near realm by default) ---

  raycast(
    origin: [number, number, number],
    dir: [number, number, number],
    maxDist: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null {
    this.safety.assertFiniteVec3(origin, "raycast.origin");
    this.safety.assertFiniteVec3(dir, "raycast.dir");
    this.safety.assertFinite(maxDist, "raycast.maxDist");
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    return nearRealm.raycast(origin, dir, maxDist, filter);
  }

  raycastMulti(
    origin: [number, number, number],
    dir: [number, number, number],
    maxDist: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[] {
    this.safety.assertFiniteVec3(origin, "raycastMulti.origin");
    this.safety.assertFiniteVec3(dir, "raycastMulti.dir");
    this.safety.assertFinite(maxDist, "raycastMulti.maxDist");
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    return nearRealm.raycastMulti(origin, dir, maxDist, filter);
  }

  // --- Direct stepping (for games that manage their own tick loop) ---

  /**
   * Step the near realm directly. Games that manage their own tick loop
   * (e.g. to-the-ocean) can call this instead of using the accumulator +
   * realm manager step. This bypasses LOD/realm membership updates.
   */
  stepNearRealm(dt: number): void {
    this.safety.assertFinite(dt, "stepNearRealm.dt");
    this.realmManager.getRealm(RealmTier.Near).step(dt);
  }

  /**
   * Sync transforms from ECS into the near realm's transform buffer.
   * Games that use the bulk transform sync can call this before stepping.
   */
  syncTransforms(buffer: Float32Array, entityCount: number): void {
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    this.backend.syncTransforms(nearRealm.id, buffer, entityCount);
  }

  readTransforms(buffer: Float32Array, entityCount: number): void {
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    this.backend.readTransforms(nearRealm.id, buffer, entityCount);
  }

  // --- Contacts ---

  getContacts(): import("@downdraft/core").ContactManifold[] {
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    return nearRealm.getContacts();
  }

  getIntersections(): import("@downdraft/core").IntersectionPair[] {
    const nearRealm = this.realmManager.getRealm(RealmTier.Near);
    return nearRealm.getIntersections();
  }

  // --- Snapshots ---

  snapshot(): Map<RealmTier, Uint8Array> {
    return this.snapshotManager.snapshotAll();
  }

  restore(data: Map<RealmTier, Uint8Array>): void {
    for (const [tier, tierData] of data) {
      this.snapshotManager.restoreRealm(tier, tierData);
    }
  }

  // --- Hooks ---

  setTransferHook(hook: RealmTransferHook): void {
    this.realmManager.setTransferHook(hook);
  }

  setSnapshotHooks(hooks: SnapshotHooks): void {
    this.snapshotManager.setSnapshotHooks(hooks);
  }

  // --- Config ---

  configure(config: Partial<PhysicsPluginConfig>): void {
    // Partial reconfiguration; for now, only update simple fields
    if (config.ccdTunnelingRatio !== undefined) {
      (this.ccdHeuristic as any).ccdTunnelingRatio = config.ccdTunnelingRatio;
    }
  }

  // --- Telemetry ---

  getStats(): PhysicsStats {
    return {
      bodyCount: this.realmManager.getBodyCount(),
      realmCounts: {
        near: this.realmManager.getRealm(RealmTier.Near).getBodyCount(),
        mid: this.realmManager.getRealm(RealmTier.Mid).getBodyCount(),
        far: this.realmManager.getRealm(RealmTier.Far).getBodyCount(),
      },
      frozenCount: this.loadShedder.getFrozenCount(),
      sleepingCount: 0, // Tracked by backend; not exposed in stats yet
      transfersThisFrame: 0, // Tracked by RealmManager; not exposed yet
      slipAmount: this.accumulator.getSlipAmount(),
      overBudget: this.accumulator.isOverBudget(),
      tickCount: this.realmManager.getTickCount(),
    };
  }

  // --- Subsystem access (for PhysicsSystem integration) ---

  getRealmManager(): RealmManager { return this.realmManager; }
  getAccumulator(): PhysicsAccumulator { return this.accumulator; }
  getInterpolationBuffer(): InterpolationBuffer { return this.interpolationBuffer; }
  getLoadShedder(): LoadShedder { return this.loadShedder; }
  getSafetyLayer(): SafetyLayer { return this.safety; }
  getCCDHeuristic(): CCDHeuristic { return this.ccdHeuristic; }
  getSnapshotManager(): SnapshotManager { return this.snapshotManager; }
  getBackend(): PhysicsBackend { return this.backend; }

  destroy(): void {
    this.realmManager.destroy();
    this.snapshotManager.reset();
    this.safety.reset();
    this.backend.destroy();
  }
}
