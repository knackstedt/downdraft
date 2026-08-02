import type { Entity } from "../ecs/entity.ts";
import type { BodyDesc, ColliderDesc, ContactManifold, PhysicsBackend, PhysicsRealmConfig, RaycastResult, RigidBodyHandle } from "./interface.ts";

export class PhysicsRealm {
  readonly id: number;
  readonly name: string;
  private backend: PhysicsBackend;
  private bodies: Map<number, RigidBodyHandle> = new Map();
  private nextBodyKey = 0;

  constructor(backend: PhysicsBackend, config: Omit<PhysicsRealmConfig, "id"> & { id?: number }) {
    this.backend = backend;
    this.id = config.id ?? Math.floor(Math.random() * 0x7fffffff);
    this.name = config.name;
    this.backend.createRealm({ ...config, id: this.id });
  }

  createBody(desc: BodyDesc, entity: Entity): RigidBodyHandle {
    const handle = this.backend.createBody(this.id, desc, entity);
    const key = this.nextBodyKey++;
    this.bodies.set(key, handle);
    return handle;
  }

  destroyBody(handle: RigidBodyHandle): void {
    this.backend.destroyBody(handle);
    for (const [key, h] of this.bodies) {
      if (h.bodyId === handle.bodyId) {
        this.bodies.delete(key);
        break;
      }
    }
  }

  addCollider(handle: RigidBodyHandle, desc: ColliderDesc): number {
    return this.backend.addCollider(handle, desc);
  }

  removeCollider(handle: RigidBodyHandle, colliderId: number): void {
    this.backend.removeCollider(handle, colliderId);
  }

  setBodyType(handle: RigidBodyHandle, type: BodyType): void {
    this.backend.setBodyType(handle, type);
  }

  setPosition(handle: RigidBodyHandle, pos: [number, number, number]): void {
    this.backend.setPosition(handle, pos);
  }

  getPosition(handle: RigidBodyHandle): [number, number, number] {
    return this.backend.getPosition(handle);
  }

  setRotation(handle: RigidBodyHandle, rot: [number, number, number, number]): void {
    this.backend.setRotation(handle, rot);
  }

  getRotation(handle: RigidBodyHandle): [number, number, number, number] {
    return this.backend.getRotation(handle);
  }

  setLinearVelocity(handle: RigidBodyHandle, vel: [number, number, number]): void {
    this.backend.setLinearVelocity(handle, vel);
  }

  getLinearVelocity(handle: RigidBodyHandle): [number, number, number] {
    return this.backend.getLinearVelocity(handle);
  }

  applyForce(handle: RigidBodyHandle, force: [number, number, number]): void {
    this.backend.applyForce(handle, force);
  }

  applyImpulse(handle: RigidBodyHandle, impulse: [number, number, number]): void {
    this.backend.applyImpulse(handle, impulse);
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

  getContacts(): ContactManifold[] {
    return this.backend.getContacts(this.id);
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

  createJoint(parentHandle: RigidBodyHandle, childHandle: RigidBodyHandle, desc: JointDesc): number {
    return this.backend.createJoint(this.id, parentHandle, childHandle, desc);
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

  getBackend(): PhysicsBackend {
    return this.backend;
  }

  destroy(): void {
    this.bodies.clear();
    this.backend.destroyRealm(this.id);
  }
}
