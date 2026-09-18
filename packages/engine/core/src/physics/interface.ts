import type { Entity } from "../ecs/entity";
export type { Entity };

export type BodyType = "static" | "dynamic" | "kinematic";

export type ColliderShape =
  | { type: "box"; halfExtents: [number, number, number] }
  | { type: "sphere"; radius: number }
  | { type: "capsule"; halfHeight: number; radius: number }
  | { type: "mesh"; vertices: Float32Array; indices: Uint32Array }
  | { type: "convex"; vertices: Float32Array }
  | { type: "heightfield"; nrows: number; ncols: number; heights: Float32Array; scale: [number, number, number] };

/**
 * Opaque public handle for a physics body. Games never see raw backend/Rapier
 * handles — all state access goes through validated `PhysicsBackend`/API methods
 * keyed by this handle. `id` is unique within the owning `realmId`.
 */
export interface PhysicsBody {
  readonly id: number;
  readonly realmId: number;
  readonly entity: Entity;
}

export interface RaycastResult {
  entity: Entity;
  point: [number, number, number];
  normal: [number, number, number];
  distance: number;
}

export interface ShapeCastResult extends RaycastResult {
  hitFraction: number;
}

export interface BodyDesc {
  type: BodyType;
  position: [number, number, number];
  rotation: [number, number, number, number];
  linearVelocity?: [number, number, number];
  angularVelocity?: [number, number, number];
  gravityScale?: number;
  mass?: number;
  linearDamping?: number;
  angularDamping?: number;
  ccdEnabled?: boolean;
  canSleep?: boolean;
  sleeping?: boolean;
  lockedAxes?: {
    translation?: [boolean, boolean, boolean];
    rotation?: [boolean, boolean, boolean];
  };
}

export interface ColliderDesc {
  shape: ColliderShape;
  friction?: number;
  restitution?: number;
  density?: number;
  sensor?: boolean;
  collisionGroups?: number;
  solverGroups?: number;
  /** Local translation of the collider relative to the parent body. */
  translation?: [number, number, number];
  /** Local rotation of the collider relative to the parent body (quaternion). */
  rotation?: [number, number, number, number];
}

export interface ContactManifold {
  entityA: Entity;
  entityB: Entity;
  normal: [number, number, number];
  points: Array<[number, number, number]>;
  penetrationDepth: number;
}

/** Sensor intersection pair (no contact manifold — sensors report overlap only). */
export interface IntersectionPair {
  entityA: Entity;
  entityB: Entity;
}

// ---------------------------------------------------------------------------
// Realm tiers
// ---------------------------------------------------------------------------

/**
 * Realm tier enum. Lower numeric value = higher fidelity (more frequent ticks,
 * more solver iterations). Realm separation is the only mechanism for differing
 * per-body update frequencies within Rapier (a single `World` has one tick rate).
 */
export enum RealmTier {
  Near = 0,
  Mid = 1,
  Far = 2,
}

/**
 * Per-tier quality + LOD transfer configuration. Orthogonal LOD axes:
 *  - `tickFrequency`: how often the realm steps (1 = every frame).
 *  - `solverIterations`: Rapier `IntegrationParameters.numSolverIterations`.
 *  - `promoteThreshold`/`demoteThreshold`: hysteresis band for tier transfers.
 *    `demoteThreshold` must be >= `promoteThreshold` to prevent boundary thrash.
 */
export interface RealmTierConfig {
  tickFrequency: number;
  solverIterations: number;
  /** Distance below which a body promotes to the next-higher tier (immediate). */
  promoteThreshold: number;
  /** Distance above which a body is eligible to demote (must be >= promoteThreshold). */
  demoteThreshold: number;
  /** Seconds continuously outside the demote threshold before demotion fires. */
  demoteDwellTime: number;
}

export interface PhysicsRealmConfig {
  id: number;
  name: string;
  tier: RealmTier;
  gravity: [number, number, number];
  /** Per-tier LOD config (tick frequency, solver iterations, transfer thresholds). */
  tierConfig: RealmTierConfig;
  integrationParams?: {
    dt?: number;
    maxSubSteps?: number;
    erp?: number;
    cfm?: number;
    numSolverIterations?: number;
  };
  broadphase?: "sap" | "grid";
  broadphaseSize?: [number, number, number];
}

export interface CharacterControllerDesc {
  offset: [number, number, number];
  radius: number;
  halfHeight: number;
  slide: boolean;
  autostep: {
    enabled: boolean;
    minWidth: number;
    maxHeight: number;
  };
  maxSlope: number;
  minSlopeSlide: number;
  snapToGround: number;
  /** If false, the character controller won't apply impulses to dynamic bodies (default: false). */
  applyImpulsesToDynamicBodies: boolean;
  /** Collision groups for the character's collider. */
  collisionGroups?: number;
  /**
   * If set, create a parentless collider (no rigid body) at this position
   * and use it for the character controller. If unset, the controller uses
   * the first collider of the entity's body.
   */
  parentless?: {
    position: [number, number, number];
    collisionGroups?: number;
  };
}

export interface CharacterControllerHandle {
  realmId: number;
  controllerId: number;
  entity: Entity;
}

export interface CharacterCollisionInfo {
  /** Entity of the body the character collided with (if resolvable). */
  entity: Entity | null;
  /** Entity type (for debug labeling). */
  entityType?: number;
  /** Entity ID (for debug labeling). */
  entityId?: number;
}

export interface CharacterMoveResult {
  grounded: boolean;
  groundNormal: [number, number, number];
  groundEntity: Entity | null;
  slid: boolean;
  stepped: boolean;
  effectiveMovement: [number, number, number];
  /** Collision details for debug/logging (empty if no collisions). */
  collisions: CharacterCollisionInfo[];
}

export type JointType = "cone-twist" | "fixed" | "revolute" | "prismatic";

export interface JointDesc {
  type: JointType;
  anchorA: [number, number, number];
  anchorB: [number, number, number];
  coneAngle?: number;
  twistAngle?: number;
  axis?: [number, number, number];
  limits?: { min: number; max: number };
}

// ---------------------------------------------------------------------------
// Islands (load shedding)
// ---------------------------------------------------------------------------

/**
 * A connected contact island. Rapier sleeps/freezes touching bodies as a group,
 * so load shedding must freeze whole islands, not individual bodies.
 */
export interface IslandInfo {
  bodyIds: number[];
  maxImportance: number;
  avgVelocity: number;
}

// ---------------------------------------------------------------------------
// Hooks (multiplayer / snapshots)
// ---------------------------------------------------------------------------

/**
 * Per-body importance weight used to decide freeze order under load (lower =
 * frozen first). `flags` is a game-defined bitmask for custom prioritization.
 */
export interface ImportanceWeight {
  weight: number;
  flags?: number;
}

/**
 * Hook for customizing realm-transfer logic. Lets multiplayer/authoritative
 * games override the default single-machine distance-based tier model.
 */
export interface RealmTransferHook {
  onPromote?(bodyId: number, fromTier: RealmTier, toTier: RealmTier): void;
  onDemote?(bodyId: number, fromTier: RealmTier, toTier: RealmTier): void;
  /** Override the default tier decision. Return null to keep the default. */
  shouldTransfer?(bodyId: number, currentTier: RealmTier, distances: number[]): RealmTier | null;
}

/**
 * Snapshot hooks for reconnect/late-join. The plugin provides serialization;
 * games provide the networking transport and trigger these hooks.
 */
export interface SnapshotHooks {
  onSnapshot?(tier: RealmTier, data: Uint8Array, tick: number): void;
  onRestore?(tier: RealmTier, tick: number): void;
  onLateJoin?(playerId: string, snapshots: Map<RealmTier, Uint8Array>, tick: number): void;
  onReconnect?(playerId: string, lastSeenTick: number, snapshots: Map<RealmTier, Uint8Array>, tick: number): void;
}

// ---------------------------------------------------------------------------
// Module config
// ---------------------------------------------------------------------------

export type PredictionMode = "server-authoritative" | "client-prediction";

export interface PhysicsModuleConfig {
  gravity: [number, number, number];
  fixedDt: number;
  maxCatchUpSteps: number;
  stepBudgetMs: number;
  realmConfigs: {
    near: RealmTierConfig;
    mid: RealmTierConfig;
    far: RealmTierConfig;
  };
  maxEntities: number;
  /** Ticks between periodic internal finite-check sweeps (§6 backstop). */
  nanSweepInterval: number;
  /** Only sweep bodies whose speed exceeds this (skip stationary bulk). */
  nanSweepVelocityThreshold: number;
  /** Tunneling risk = speed*dt/colliderSize; enable CCD when above this. */
  ccdTunnelingRatio: number;
  /** Ticks between near-realm snapshots. */
  snapshotInterval: number;
  predictionMode: PredictionMode;
  /** 0 = single-threaded (all realms on sim thread); N = worker pool size. */
  workerCount: number;
  /** If true, assert/throw on invalid input (dev builds). Shipped builds clamp+log. */
  devMode: boolean;
  /**
   * If true, static bodies are duplicated into all three realms (default).
   * If false, far-tier dynamic bodies are force-promoted on static contact.
   */
  duplicateStatics: boolean;
  /**
   * If true (default), `step()` extracts contact manifolds + intersection
   * pairs after each physics step. Games that never read contacts/intersections
   * (e.g. prop sandboxes) can set this to false to skip the expensive
   * WASM↔JS callback traversal — ~43% of step time in such games.
   */
  extractContacts?: boolean;
  /**
   * If true (default), `step()` reads back all body transforms from WASM into
   * the backend's cached body state after each step. Games that read transforms
   * via the Raw scalar API (`getTranslationRaw`/`getLinearVelocityRaw`) or the
   * bulk `readTransforms` buffer can set this to false to avoid redundant
   * high-level API calls (each allocates wrapped RawVector/RawRotation objects).
   */
  readBackTransformsOnStep?: boolean;
}

export interface PhysicsStats {
  bodyCount: number;
  realmCounts: { near: number; mid: number; far: number };
  frozenCount: number;
  sleepingCount: number;
  transfersThisFrame: number;
  slipAmount: number;
  overBudget: boolean;
  tickCount: number;
}

// ---------------------------------------------------------------------------
// Backend interface (PhysicsBody-keyed; no raw handles leak)
// ---------------------------------------------------------------------------

export interface PhysicsBackend {
  readonly name: string;
  readonly version: string;

  init?(): Promise<void>;

  createRealm(config: PhysicsRealmConfig): number;
  destroyRealm(realmId: number): void;
  getRealmIds(): number[];

  createBody(realmId: number, desc: BodyDesc, entity: Entity): PhysicsBody;
  destroyBody(body: PhysicsBody): void;
  setBodyType(body: PhysicsBody, type: BodyType): void;

  addCollider(body: PhysicsBody, desc: ColliderDesc): number;
  removeCollider(body: PhysicsBody, colliderId: number): void;
  /** Set the world-space position of a collider (used for parentless character capsules). */
  setColliderPosition(realmId: number, colliderId: number, pos: [number, number, number]): void;
  /** Get the world-space position of a collider. */
  getColliderPosition(realmId: number, colliderId: number): [number, number, number];

  applyForce(body: PhysicsBody, force: [number, number, number]): void;
  applyImpulse(body: PhysicsBody, impulse: [number, number, number]): void;
  applyTorque(body: PhysicsBody, torque: [number, number, number]): void;
  applyTorqueImpulse(body: PhysicsBody, impulse: [number, number, number]): void;
  applyImpulseAtPoint(body: PhysicsBody, impulse: [number, number, number], point: [number, number, number]): void;

  setLinearVelocity(body: PhysicsBody, vel: [number, number, number]): void;
  getLinearVelocity(body: PhysicsBody): [number, number, number];
  setAngularVelocity(body: PhysicsBody, vel: [number, number, number]): void;
  getAngularVelocity(body: PhysicsBody): [number, number, number];

  setPosition(body: PhysicsBody, pos: [number, number, number]): void;
  getPosition(body: PhysicsBody): [number, number, number];
  setRotation(body: PhysicsBody, rot: [number, number, number, number]): void;
  getRotation(body: PhysicsBody): [number, number, number, number];

  wakeUp(body: PhysicsBody): void;
  isSleeping(body: PhysicsBody): boolean;

  // -------------------------------------------------------------------------
  // Raw fast paths — bypass safety validation, avoid JS object allocation.
  // Callers MUST validate inputs themselves (finiteness, quaternion normalize).
  // PhysicsBody-keyed — no raw Rapier handles leak. Use these in hot loops.
  // -------------------------------------------------------------------------

  /** Scalar setTranslation — avoids Vector3 alloc. */
  setTranslationRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean): void;
  /** Scalar setRotation — avoids Quaternion alloc. */
  setRotationRaw(body: PhysicsBody, x: number, y: number, z: number, w: number, wakeUp: boolean): void;
  /** Scalar getTranslation — writes into out[0..2], avoids alloc. */
  getTranslationRaw(body: PhysicsBody, out: [number, number, number]): void;
  /** Scalar getRotation (quaternion) — writes into out[0..3], avoids alloc. */
  getRotationRaw(body: PhysicsBody, out: [number, number, number, number]): void;
  /** Scalar getLinearVelocity — writes into out[0..2]. */
  getLinearVelocityRaw(body: PhysicsBody, out: [number, number, number]): void;
  /** Scalar setLinearVelocity. */
  setLinearVelocityRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean): void;
  /** Scalar setAngularVelocity. */
  setAngularVelocityRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean): void;
  /** Scalar sleeping check — single boolean, no alloc. */
  isSleepingRaw(body: PhysicsBody): boolean;

  /**
   * Swap a trimesh collider's shape in-place (avoids remove/create + broadphase
   * re-insertion). Returns true if the swap succeeded, false if the backend
   * doesn't support in-place swap (caller should fall back to remove+create).
   */
  swapColliderShapeRaw(realmId: number, colliderId: number, vertices: Float32Array, indices: Uint32Array): boolean;

  /** Pre-allocate WASM heap (bytes). No-op if not supported. */
  reserveMemory(bytes: number): void;

  /** Set integration timestep on a realm. */
  setIntegrationDt(realmId: number, dt: number): void;

  /** Per-realm sleep thresholds for graceful degradation (load shedding first line). */
  setSleepThresholds(realmId: number, linearThreshold: number, angularThreshold: number): void;
  /** Per-realm solver iteration count (Rapier `IntegrationParameters.numSolverIterations`). */
  setSolverIterations(realmId: number, iterations: number): void;
  /** Per-realm minimum island size (smaller = islands sleep independently). */
  setMinIslandSize?(realmId: number, size: number): void;
  /** Per-body CCD (off by default globally; opt in via tunneling heuristic). */
  setCCDEnabled(body: PhysicsBody, enabled: boolean): void;

  raycast(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null;

  raycastMulti(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[];

  shapeCast(
    realmId: number,
    shape: ColliderShape,
    origin: [number, number, number],
    rotation: [number, number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): ShapeCastResult | null;

  step(realmId: number, dt: number): void;
  stepAll(dt: number): void;

  getContacts(realmId: number): ContactManifold[];

  /** Sensor intersection pairs for the given realm (overlap-only, no contact manifold). */
  getIntersections(realmId: number): IntersectionPair[];

  /** Enumerate contact islands for island-aware load shedding. */
  getIslands(realmId: number): IslandInfo[];

  createCharacterController(realmId: number, desc: CharacterControllerDesc, entity: Entity): CharacterControllerHandle;
  destroyCharacterController(handle: CharacterControllerHandle): void;
  characterMove(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult;
  /** Set the world position of a character controller's parentless collider. */
  setCharacterColliderPosition(handle: CharacterControllerHandle, pos: [number, number, number]): void;

  createJoint(realmId: number, parentBody: PhysicsBody, childBody: PhysicsBody, desc: JointDesc): number;
  destroyJoint(realmId: number, jointId: number): void;

  /**
   * Bulk write ECS transforms → physics (kinematic/static bodies). One FFI pass.
   * Buffer layout: [x,y,z, qx,qy,qz,qw, pad] × entityCount (8 floats per entity).
   */
  syncTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void;
  /**
   * Bulk read physics transforms → buffer (one FFI pass, no per-entity allocation).
   * Same layout as `syncTransforms`.
   */
  readTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void;

  /** Rapier `world.takeSnapshot()` — for reconnect/late-join. */
  serializeRealm(realmId: number): Uint8Array;
  deserializeRealm(realmId: number, data: Uint8Array): void;

  destroy(): void;
}
