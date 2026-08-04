import type { Entity } from "../ecs/entity";
export type { Entity };

export type BodyType = "static" | "dynamic" | "kinematic";

export type ColliderShape =
  | { type: "box"; halfExtents: [number, number, number] }
  | { type: "sphere"; radius: number }
  | { type: "capsule"; halfHeight: number; radius: number }
  | { type: "mesh"; vertices: Float32Array; indices: Uint32Array }
  | { type: "convex"; vertices: Float32Array };

export interface RigidBodyHandle {
  realmId: number;
  bodyId: number;
  entity: Entity;
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
}

export interface ContactManifold {
  entityA: Entity;
  entityB: Entity;
  normal: [number, number, number];
  points: Array<[number, number, number]>;
  penetrationDepth: number;
}

export interface PhysicsRealmConfig {
  id: number;
  name: string;
  gravity: [number, number, number];
  integrationParams?: {
    dt?: number;
    maxSubSteps?: number;
    erp?: number;
    cfm?: number;
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
  snapToGround: number;
}

export interface CharacterControllerHandle {
  realmId: number;
  controllerId: number;
  entity: Entity;
}

export interface CharacterMoveResult {
  grounded: boolean;
  groundNormal: [number, number, number];
  groundEntity: Entity | null;
  slid: boolean;
  stepped: boolean;
  effectiveMovement: [number, number, number];
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

export interface PhysicsBackend {
  readonly name: string;
  readonly version: string;

  createRealm(config: PhysicsRealmConfig): number;
  destroyRealm(realmId: number): void;
  getRealmIds(): number[];

  createBody(realmId: number, desc: BodyDesc, entity: Entity): RigidBodyHandle;
  destroyBody(handle: RigidBodyHandle): void;
  setBodyType(handle: RigidBodyHandle, type: BodyType): void;

  addCollider(handle: RigidBodyHandle, desc: ColliderDesc): number;
  removeCollider(handle: RigidBodyHandle, colliderId: number): void;

  applyForce(handle: RigidBodyHandle, force: [number, number, number]): void;
  applyImpulse(handle: RigidBodyHandle, impulse: [number, number, number]): void;
  applyTorque(handle: RigidBodyHandle, torque: [number, number, number]): void;
  applyTorqueImpulse(handle: RigidBodyHandle, impulse: [number, number, number]): void;
  applyImpulseAtPoint(handle: RigidBodyHandle, impulse: [number, number, number], point: [number, number, number]): void;

  setLinearVelocity(handle: RigidBodyHandle, vel: [number, number, number]): void;
  getLinearVelocity(handle: RigidBodyHandle): [number, number, number];
  setAngularVelocity(handle: RigidBodyHandle, vel: [number, number, number]): void;
  getAngularVelocity(handle: RigidBodyHandle): [number, number, number];

  setPosition(handle: RigidBodyHandle, pos: [number, number, number]): void;
  getPosition(handle: RigidBodyHandle): [number, number, number];
  setRotation(handle: RigidBodyHandle, rot: [number, number, number, number]): void;
  getRotation(handle: RigidBodyHandle): [number, number, number, number];

  wakeUp(handle: RigidBodyHandle): void;
  isSleeping(handle: RigidBodyHandle): boolean;

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

  createCharacterController(realmId: number, desc: CharacterControllerDesc, entity: Entity): CharacterControllerHandle;
  destroyCharacterController(handle: CharacterControllerHandle): void;
  characterMove(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult;

  createJoint(realmId: number, parentHandle: RigidBodyHandle, childHandle: RigidBodyHandle, desc: JointDesc): number;
  destroyJoint(realmId: number, jointId: number): void;

  syncTransforms(
    realmId: number,
    transformBuffer: Float32Array,
    entityCount: number,
  ): void;

  readTransforms(
    realmId: number,
    transformBuffer: Float32Array,
    entityCount: number,
  ): void;

  destroy(): void;
}
