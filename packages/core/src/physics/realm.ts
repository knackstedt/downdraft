import type { PhysicsBackend, PhysicsRealmConfig, RigidBodyHandle, BodyDesc, ColliderDesc, RaycastResult, ContactManifold } from "./interface.ts";
import type { Entity } from "../ecs/entity.ts";

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
