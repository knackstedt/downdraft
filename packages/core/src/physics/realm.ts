import type { Entity } from "../ecs/entity";
import type { BodyDesc, BodyType, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ColliderDesc, ContactManifold, IntersectionPair, IslandInfo, JointDesc, PhysicsBackend, PhysicsBody, PhysicsRealmConfig, RaycastResult } from "./interface";

export class PhysicsRealm {
  readonly id: number;
  readonly name: string;
  readonly tier: import("./interface").RealmTier;
  private backend: PhysicsBackend;
  private bodies: Map<number, PhysicsBody> = new Map();
  private nextBodyId = 1;

  constructor(backend: PhysicsBackend, config: Omit<PhysicsRealmConfig, "id"> & { id?: number }) {
    this.backend = backend;
    this.id = config.id ?? Math.floor(Math.random() * 0x7fffffff);
    this.name = config.name;
    this.tier = config.tier;
    this.backend.createRealm({ ...config, id: this.id });
  }

  createBody(desc: BodyDesc, entity: Entity): PhysicsBody {
    const body = this.backend.createBody(this.id, desc, entity);
    this.bodies.set(body.id, body);
    return body;
  }

  destroyBody(body: PhysicsBody): void {
    this.backend.destroyBody(body);
    this.bodies.delete(body.id);
  }

  addCollider(body: PhysicsBody, desc: ColliderDesc): number {
    return this.backend.addCollider(body, desc);
  }

  removeCollider(body: PhysicsBody, colliderId: number): void {
    this.backend.removeCollider(body, colliderId);
  }

  setBodyType(body: PhysicsBody, type: BodyType): void {
    this.backend.setBodyType(body, type);
  }

  setPosition(body: PhysicsBody, pos: [number, number, number]): void {
    this.backend.setPosition(body, pos);
  }

  getPosition(body: PhysicsBody): [number, number, number] {
    return this.backend.getPosition(body);
  }

  setRotation(body: PhysicsBody, rot: [number, number, number, number]): void {
    this.backend.setRotation(body, rot);
  }

  getRotation(body: PhysicsBody): [number, number, number, number] {
    return this.backend.getRotation(body);
  }

  setLinearVelocity(body: PhysicsBody, vel: [number, number, number]): void {
    this.backend.setLinearVelocity(body, vel);
  }

  getLinearVelocity(body: PhysicsBody): [number, number, number] {
    return this.backend.getLinearVelocity(body);
  }

  setAngularVelocity(body: PhysicsBody, vel: [number, number, number]): void {
    this.backend.setAngularVelocity(body, vel);
  }

  getAngularVelocity(body: PhysicsBody): [number, number, number] {
    return this.backend.getAngularVelocity(body);
  }

  applyForce(body: PhysicsBody, force: [number, number, number]): void {
    this.backend.applyForce(body, force);
  }

  applyImpulse(body: PhysicsBody, impulse: [number, number, number]): void {
    this.backend.applyImpulse(body, impulse);
  }

  raycast(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null {
    return this.backend.raycast(this.id, origin, direction, maxDistance, filter);
  }

  raycastMulti(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[] {
    return this.backend.raycastMulti(this.id, origin, direction, maxDistance, filter);
  }

  step(dt: number): void {
    this.backend.step(this.id, dt);
  }

  setSolverIterations(iterations: number): void {
    this.backend.setSolverIterations(this.id, iterations);
  }

  setMinIslandSize(size: number): void {
    if (this.backend.setMinIslandSize) this.backend.setMinIslandSize(this.id, size);
  }

  setSleepThresholds(linearThreshold: number, angularThreshold: number): void {
    this.backend.setSleepThresholds(this.id, linearThreshold, angularThreshold);
  }

  getIslands(): IslandInfo[] {
    return this.backend.getIslands(this.id);
  }

  serialize(): Uint8Array {
    return this.backend.serializeRealm(this.id);
  }

  deserialize(data: Uint8Array): void {
    this.backend.deserializeRealm(this.id, data);
  }

  getContacts(): ContactManifold[] {
    return this.backend.getContacts(this.id);
  }

  getIntersections(): IntersectionPair[] {
    return this.backend.getIntersections(this.id);
  }

  createCharacterController(desc: CharacterControllerDesc, entity: Entity): CharacterControllerHandle {
    return this.backend.createCharacterController(this.id, desc, entity);
  }

  destroyCharacterController(handle: CharacterControllerHandle): void {
    this.backend.destroyCharacterController(handle);
  }

  characterMove(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult {
    return this.backend.characterMove(handle, desiredMovement, dt);
  }

  createJoint(parentBody: PhysicsBody, childBody: PhysicsBody, desc: JointDesc): number {
    return this.backend.createJoint(this.id, parentBody, childBody, desc);
  }

  destroyJoint(jointId: number): void {
    this.backend.destroyJoint(this.id, jointId);
  }

  syncTransforms(transformBuffer: Float32Array, entityCount: number): void {
    this.backend.syncTransforms(this.id, transformBuffer, entityCount);
  }

  readTransforms(transformBuffer: Float32Array, entityCount: number): void {
    this.backend.readTransforms(this.id, transformBuffer, entityCount);
  }

  listBodies(): PhysicsBody[] {
    return [...this.bodies.values()];
  }

  getBody(bodyId: number): PhysicsBody | undefined {
    return this.bodies.get(bodyId);
  }

  getBodyCount(): number {
    return this.bodies.size;
  }

  getBackend(): PhysicsBackend {
    return this.backend;
  }

  getTier(): import("./interface").RealmTier {
    return this.tier;
  }

  destroy(): void {
    this.bodies.clear();
    this.backend.destroyRealm(this.id);
  }
}
