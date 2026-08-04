import type {
    BodyDesc,
    BodyType,
    CharacterControllerDesc,
    CharacterControllerHandle,
    CharacterMoveResult,
    ColliderDesc,
    ColliderShape,
    ContactManifold,
    Entity,
    JointDesc,
    PhysicsBackend,
    PhysicsRealmConfig,
    RaycastResult,
    RigidBodyHandle,
    ShapeCastResult,
} from "@downdraft/core";
import { loadPhysicsLib, type PhysicsLib } from "./ffi";

interface RealmState {
  id: number;
  config: PhysicsRealmConfig;
  bodies: Map<number, BodyState>;
  nextBodyId: number;
  contacts: ContactManifold[];
  nextControllerId: number;
  nextJointId: number;
}

interface BodyState {
  handle: RigidBodyHandle;
  desc: BodyDesc;
  colliders: Map<number, ColliderDesc>;
  nextColliderId: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  sleeping: boolean;
}

export class RapierPhysicsBackend implements PhysicsBackend {
  readonly name = "rapier";
  readonly version = "0.1.0";

  private lib: PhysicsLib | null = null;
  private realms: Map<number, RealmState> = new Map();
  private realmIds: number[] = [];
  private nextRealmId = 1;
  private destroyed = false;

  async init(): Promise<void> {
    if (this.lib) return;
    this.lib = await loadPhysicsLib();
  }

  private ensureLib(): PhysicsLib {
    if (!this.lib) {
      throw new Error("RapierPhysicsBackend not initialized. Call init() first.");
    }
    return this.lib;
  }

  createRealm(config: PhysicsRealmConfig): number {
    const id = config.id ?? this.nextRealmId++;
    const realm: RealmState = {
      id,
      config,
      bodies: new Map(),
      nextBodyId: 1,
      contacts: [],
      nextControllerId: 1,
      nextJointId: 1,
 };
    this.realms.set(id, realm);
    this.realmIds.push(id);

    if (this.lib) {
      this.lib.createRealm(id, config.gravity);
    }
    return id;
  }

  destroyRealm(realmId: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    if (this.lib) {
      this.lib.destroyRealm(realmId);
    }
    realm.bodies.clear();
    this.realms.delete(realmId);
    this.realmIds = this.realmIds.filter((id) => id !== realmId);
  }

  getRealmIds(): number[] {
    return [...this.realmIds];
  }

  createBody(realmId: number, desc: BodyDesc, entity: Entity): RigidBodyHandle {
    const realm = this.realms.get(realmId);
    if (!realm) throw new Error(`Realm ${realmId} not found`);

    const bodyId = realm.nextBodyId++;
    const handle: RigidBodyHandle = { realmId, bodyId, entity };

    const state: BodyState = {
      handle,
      desc,
      colliders: new Map(),
      nextColliderId: 1,
      position: [...desc.position] as [number, number, number],
      rotation: [...desc.rotation] as [number, number, number, number],
      linearVelocity: [...(desc.linearVelocity ?? [0, 0, 0])] as [number, number, number],
      angularVelocity: [...(desc.angularVelocity ?? [0, 0, 0])] as [number, number, number],
      sleeping: desc.sleeping ?? false,
    };

    realm.bodies.set(bodyId, state);

    if (this.lib) {
      this.lib.createBody(realmId, bodyId, desc);
    }

    return handle;
  }

  destroyBody(handle: RigidBodyHandle): void {
    const realm = this.realms.get(handle.realmId);
    if (!realm) return;
    if (this.lib) {
      this.lib.destroyBody(handle.realmId, handle.bodyId);
    }
    realm.bodies.delete(handle.bodyId);
  }

  setBodyType(handle: RigidBodyHandle, type: BodyType): void {
    const state = this.getBodyState(handle);
    if (!state) return;
    state.desc.type = type;
    if (this.lib) {
      this.lib.setBodyType(handle.realmId, handle.bodyId, type);
    }
  }

  addCollider(handle: RigidBodyHandle, desc: ColliderDesc): number {
    const state = this.getBodyState(handle);
    if (!state) return -1;
    const id = state.nextColliderId++;
    state.colliders.set(id, desc);
    if (this.lib) {
      this.lib.addCollider(handle.realmId, handle.bodyId, id, desc);
    }
    return id;
  }

  removeCollider(handle: RigidBodyHandle, colliderId: number): void {
    const state = this.getBodyState(handle);
    if (!state) return;
    state.colliders.delete(colliderId);
    if (this.lib) {
      this.lib.removeCollider(handle.realmId, handle.bodyId, colliderId);
    }
  }

  applyForce(handle: RigidBodyHandle, force: [number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state || state.desc.type !== "dynamic") return;
    if (this.lib) {
      this.lib.applyForce(handle.realmId, handle.bodyId, force);
    }
  }

  applyImpulse(handle: RigidBodyHandle, impulse: [number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state || state.desc.type !== "dynamic") return;
    state.linearVelocity[0] += impulse[0] / (state.desc.mass ?? 1);
    state.linearVelocity[1] += impulse[1] / (state.desc.mass ?? 1);
    state.linearVelocity[2] += impulse[2] / (state.desc.mass ?? 1);
    if (this.lib) {
      this.lib.applyImpulse(handle.realmId, handle.bodyId, impulse);
    }
  }

  applyTorque(handle: RigidBodyHandle, torque: [number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state || state.desc.type !== "dynamic") return;
    if (this.lib) {
      this.lib.applyTorque(handle.realmId, handle.bodyId, torque);
    }
  }

  applyTorqueImpulse(handle: RigidBodyHandle, impulse: [number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state || state.desc.type !== "dynamic") return;
    state.angularVelocity[0] += impulse[0];
    state.angularVelocity[1] += impulse[1];
    state.angularVelocity[2] += impulse[2];
    if (this.lib) {
      this.lib.applyTorqueImpulse(handle.realmId, handle.bodyId, impulse);
    }
  }

  applyImpulseAtPoint(
    handle: RigidBodyHandle,
    impulse: [number, number, number],
    point: [number, number, number],
  ): void {
    const state = this.getBodyState(handle);
    if (!state || state.desc.type !== "dynamic") return;
    state.linearVelocity[0] += impulse[0] / (state.desc.mass ?? 1);
    state.linearVelocity[1] += impulse[1] / (state.desc.mass ?? 1);
    state.linearVelocity[2] += impulse[2] / (state.desc.mass ?? 1);
    if (this.lib) {
      this.lib.applyImpulseAtPoint(handle.realmId, handle.bodyId, impulse, point);
    }
  }

  setLinearVelocity(handle: RigidBodyHandle, vel: [number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state) return;
    state.linearVelocity = [...vel] as [number, number, number];
    if (this.lib) {
      this.lib.setLinearVelocity(handle.realmId, handle.bodyId, vel);
    }
  }

  getLinearVelocity(handle: RigidBodyHandle): [number, number, number] {
    const state = this.getBodyState(handle);
    return state ? [...state.linearVelocity] as [number, number, number] : [0, 0, 0];
  }

  setAngularVelocity(handle: RigidBodyHandle, vel: [number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state) return;
    state.angularVelocity = [...vel] as [number, number, number];
    if (this.lib) {
      this.lib.setAngularVelocity(handle.realmId, handle.bodyId, vel);
    }
  }

  getAngularVelocity(handle: RigidBodyHandle): [number, number, number] {
    const state = this.getBodyState(handle);
    return state ? [...state.angularVelocity] as [number, number, number] : [0, 0, 0];
  }

  setPosition(handle: RigidBodyHandle, pos: [number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state) return;
    state.position = [...pos] as [number, number, number];
    if (this.lib) {
      this.lib.setPosition(handle.realmId, handle.bodyId, pos);
    }
  }

  getPosition(handle: RigidBodyHandle): [number, number, number] {
    const state = this.getBodyState(handle);
    return state ? [...state.position] as [number, number, number] : [0, 0, 0];
  }

  setRotation(handle: RigidBodyHandle, rot: [number, number, number, number]): void {
    const state = this.getBodyState(handle);
    if (!state) return;
    state.rotation = [...rot] as [number, number, number, number];
    if (this.lib) {
      this.lib.setRotation(handle.realmId, handle.bodyId, rot);
    }
  }

  getRotation(handle: RigidBodyHandle): [number, number, number, number] {
    const state = this.getBodyState(handle);
    return state ? [...state.rotation] as [number, number, number, number] : [0, 0, 0, 1];
  }

  wakeUp(handle: RigidBodyHandle): void {
    const state = this.getBodyState(handle);
    if (!state) return;
    state.sleeping = false;
    if (this.lib) {
      this.lib.wakeUp(handle.realmId, handle.bodyId);
    }
  }

  isSleeping(handle: RigidBodyHandle): boolean {
    const state = this.getBodyState(handle);
    return state ? state.sleeping : false;
  }

  raycast(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null {
    if (this.lib) {
      return this.lib.raycast(realmId, origin, direction, maxDistance, filter);
    }

    const realm = this.realms.get(realmId);
    if (!realm) return null;

    let closest: RaycastResult | null = null;
    let closestDist = maxDistance;

    for (const [bodyId, body] of realm.bodies) {
      if (filter?.excludeEntity && body.handle.entity.index === filter.excludeEntity.index) continue;

      for (const collider of body.colliders.values()) {
        const hit = raycastCollider(
          origin,
          direction,
          maxDistance,
          body.position,
          collider.shape,
        );
        if (hit && hit.distance < closestDist) {
          closestDist = hit.distance;
          closest = {
            entity: body.handle.entity,
            point: hit.point,
            normal: hit.normal,
            distance: hit.distance,
          };
        }
      }
    }

    return closest;
  }

  raycastMulti(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[] {
    const results: RaycastResult[] = [];
    if (this.lib) {
      return this.lib.raycastMulti(realmId, origin, direction, maxDistance, filter);
    }

    const realm = this.realms.get(realmId);
    if (!realm) return [];

    for (const [, body] of realm.bodies) {
      if (filter?.excludeEntity && body.handle.entity.index === filter.excludeEntity.index) continue;

      for (const collider of body.colliders.values()) {
        const hit = raycastCollider(origin, direction, maxDistance, body.position, collider.shape);
        if (hit) {
          results.push({
            entity: body.handle.entity,
            point: hit.point,
            normal: hit.normal,
            distance: hit.distance,
          });
        }
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }

  shapeCast(
    realmId: number,
    shape: ColliderShape,
    origin: [number, number, number],
    rotation: [number, number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): ShapeCastResult | null {
    if (this.lib) {
      return this.lib.shapeCast(realmId, shape, origin, rotation, direction, maxDistance, filter);
    }
    return null;
  }

  step(realmId: number, dt: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;

    if (this.lib) {
      this.lib.step(realmId, dt);
      this.readBackTransforms(realm);
      return;
    }

    this.stepFallback(realm, dt);
  }

  stepAll(dt: number): void {
    for (const realmId of this.realmIds) {
      this.step(realmId, dt);
    }
  }

  getContacts(realmId: number): ContactManifold[] {
    const realm = this.realms.get(realmId);
    return realm ? realm.contacts : [];
  }

  createCharacterController(realmId: number, desc: CharacterControllerDesc, entity: Entity): CharacterControllerHandle {
    const realm = this.realms.get(realmId);
    if (!realm) throw new Error(`Realm ${realmId} not found`);
    const controllerId = realm.nextControllerId++;
    const handle: CharacterControllerHandle = { realmId, controllerId, entity };
    if (this.lib) {
      this.lib.createCharacterController(realmId, desc, handle);
    }
    return handle;
  }

  destroyCharacterController(handle: CharacterControllerHandle): void {
    if (this.lib) {
      this.lib.destroyCharacterController(handle.realmId, handle.controllerId);
    }
  }

  characterMove(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult {
    if (this.lib) {
      return this.lib.characterMove(handle.realmId, handle.controllerId, desiredMovement, dt);
    }
    return this.characterMoveFallback(handle, desiredMovement, dt);
  }

  createJoint(realmId: number, parentHandle: RigidBodyHandle, childHandle: RigidBodyHandle, desc: JointDesc): number {
    const realm = this.realms.get(realmId);
    if (!realm) throw new Error(`Realm ${realmId} not found`);
    const jointId = realm.nextJointId++;
    if (this.lib) {
      this.lib.createJoint(realmId, parentHandle.bodyId, childHandle.bodyId, jointId, desc);
    }
    return jointId;
  }

  destroyJoint(realmId: number, jointId: number): void {
    if (this.lib) {
      this.lib.destroyJoint(realmId, jointId);
    }
  }

  syncTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    for (const [, body] of realm.bodies) {
      const idx = body.handle.entity.index;
      if (idx < entityCount) {
        const offset = idx * 8;
        body.position[0] = transformBuffer[offset];
        body.position[1] = transformBuffer[offset + 1];
        body.position[2] = transformBuffer[offset + 2];
        body.rotation[0] = transformBuffer[offset + 3];
        body.rotation[1] = transformBuffer[offset + 4];
        body.rotation[2] = transformBuffer[offset + 5];
        body.rotation[3] = transformBuffer[offset + 6];
      }
    }
  }

  readTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    for (const [, body] of realm.bodies) {
      const idx = body.handle.entity.index;
      if (idx < entityCount) {
        const offset = idx * 8;
        transformBuffer[offset] = body.position[0];
        transformBuffer[offset + 1] = body.position[1];
        transformBuffer[offset + 2] = body.position[2];
        transformBuffer[offset + 3] = body.rotation[0];
        transformBuffer[offset + 4] = body.rotation[1];
        transformBuffer[offset + 5] = body.rotation[2];
        transformBuffer[offset + 6] = body.rotation[3];
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.lib) {
      for (const realmId of this.realmIds) {
        this.lib.destroyRealm(realmId);
      }
      this.lib.destroy();
    }
    this.realms.clear();
    this.realmIds = [];
  }

  private getBodyState(handle: RigidBodyHandle): BodyState | undefined {
    const realm = this.realms.get(handle.realmId);
    return realm?.bodies.get(handle.bodyId);
  }

  private characterMoveFallback(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult {
    const realm = this.realms.get(handle.realmId);
    if (!realm) {
      return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0] };
    }

    const body = realm.bodies.get(handle.entity.index);
    if (!body) {
      return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0] };
    }

    const desired = [...desiredMovement] as [number, number, number];
    let effective = [...desired] as [number, number, number];
    let slid = false;
    let stepped = false;

    const groundRay = this.raycast(handle.realmId, body.position, [0, -1, 0], 1.2);
    const grounded = groundRay !== null && groundRay.distance <= 1.0;
    const groundNormal = groundRay ? groundRay.normal : [0, 1, 0] as [number, number, number];
    const groundEntity = groundRay ? groundRay.entity : null;

    if (grounded) {
      const slopeDot = groundNormal[1];
      const maxSlopeCos = Math.cos(Math.PI / 3);
      if (slopeDot < maxSlopeCos) {
        const slideDir: [number, number, number] = [
          groundNormal[0] * (1 - slopeDot),
          groundNormal[1] * (1 - slopeDot) - 1,
          groundNormal[2] * (1 - slopeDot),
        ];
        const slideLen = Math.sqrt(slideDir[0] ** 2 + slideDir[1] ** 2 + slideDir[2] ** 2);
        if (slideLen > 1e-6) {
          effective[0] = slideDir[0] / slideLen * Math.abs(desired[1]) * 0.5;
          effective[1] = slideDir[1] / slideLen * Math.abs(desired[1]) * 0.5;
          effective[2] = slideDir[2] / slideLen * Math.abs(desired[1]) * 0.5;
          slid = true;
        }
      }
    }

    const wallRay = this.raycast(handle.realmId, body.position, [desired[0], 0, desired[2]], 0.6);
    if (wallRay && wallRay.distance < 0.5) {
      const wallNormal = wallRay.normal;
      const dot = effective[0] * wallNormal[0] + effective[2] * wallNormal[2];
      if (dot < 0) {
        effective[0] -= dot * wallNormal[0];
        effective[2] -= dot * wallNormal[2];
        slid = true;
      }
    }

    body.position[0] += effective[0] * dt;
    body.position[1] += effective[1] * dt;
    body.position[2] += effective[2] * dt;

    return { grounded, groundNormal, groundEntity, slid, stepped, effectiveMovement: effective };
  }

  private readBackTransforms(realm: RealmState): void {
    if (!this.lib) return;
    for (const [bodyId, body] of realm.bodies) {
      const transform = this.lib.getBodyTransform(realm.id, bodyId);
      if (transform) {
        body.position = transform.position;
        body.rotation = transform.rotation;
      }
    }
  }

  private stepFallback(realm: RealmState, dt: number): void {
    const gravity = realm.config.gravity;

    for (const [, body] of realm.bodies) {
      if (body.desc.type !== "dynamic" || body.sleeping) continue;

      body.linearVelocity[0] += gravity[0] * (body.desc.gravityScale ?? 1) * dt;
      body.linearVelocity[1] += gravity[1] * (body.desc.gravityScale ?? 1) * dt;
      body.linearVelocity[2] += gravity[2] * (body.desc.gravityScale ?? 1) * dt;

      const damping = body.desc.linearDamping ?? 0;
      const dampFactor = Math.max(0, 1 - damping * dt);
      body.linearVelocity[0] *= dampFactor;
      body.linearVelocity[1] *= dampFactor;
      body.linearVelocity[2] *= dampFactor;

      const angDamping = body.desc.angularDamping ?? 0;
      const angDampFactor = Math.max(0, 1 - angDamping * dt);
      body.angularVelocity[0] *= angDampFactor;
      body.angularVelocity[1] *= angDampFactor;
      body.angularVelocity[2] *= angDampFactor;

      body.position[0] += body.linearVelocity[0] * dt;
      body.position[1] += body.linearVelocity[1] * dt;
      body.position[2] += body.linearVelocity[2] * dt;

      integrateRotation(body.rotation, body.angularVelocity, dt);
    }

    realm.contacts = this.detectContacts(realm);
  }

  private detectContacts(realm: RealmState): ContactManifold[] {
    const contacts: ContactManifold[] = [];
    const bodies = [...realm.bodies.values()];

    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];

        for (const colA of a.colliders.values()) {
          for (const colB of b.colliders.values()) {
            const contact = checkColliderCollision(
              a.position,
              colA.shape,
              b.position,
              colB.shape,
            );
            if (contact) {
              contacts.push({
                entityA: a.handle.entity,
                entityB: b.handle.entity,
                normal: contact.normal,
                points: [contact.point],
                penetrationDepth: contact.penetration,
              });
            }
          }
        }
      }
    }

    return contacts;
  }
}

function integrateRotation(
  rot: [number, number, number, number],
  angularVel: [number, number, number],
  dt: number,
): void {
  const ax = angularVel[0] * dt * 0.5;
  const ay = angularVel[1] * dt * 0.5;
  const az = angularVel[2] * dt * 0.5;
  const dq: [number, number, number, number] = [ax, ay, az, 1];
  const len = Math.sqrt(dq[0] ** 2 + dq[1] ** 2 + dq[2] ** 2 + dq[3] ** 2);
  if (len > 1e-9) {
    dq[0] /= len; dq[1] /= len; dq[2] /= len; dq[3] /= len;
  }
  const result = multiplyQuat(rot, dq);
  rot[0] = result[0]; rot[1] = result[1]; rot[2] = result[2]; rot[3] = result[3];
}

function multiplyQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function raycastCollider(
  origin: [number, number, number],
  direction: [number, number, number],
  maxDistance: number,
  bodyPos: [number, number, number],
  shape: ColliderShape,
): { point: [number, number, number]; normal: [number, number, number]; distance: number } | null {
  if (shape.type === "sphere") {
    return raycastSphere(origin, direction, maxDistance, bodyPos, shape.radius);
  }
  if (shape.type === "box") {
    return raycastBox(origin, direction, maxDistance, bodyPos, shape.halfExtents);
  }
  return null;
}

function raycastSphere(
  origin: [number, number, number],
  dir: [number, number, number],
  maxDist: number,
  center: [number, number, number],
  radius: number,
): { point: [number, number, number]; normal: [number, number, number]; distance: number } | null {
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxDist) return null;
  const point: [number, number, number] = [
    origin[0] + dir[0] * t,
    origin[1] + dir[1] * t,
    origin[2] + dir[2] * t,
  ];
  const normal: [number, number, number] = [
    (point[0] - center[0]) / radius,
    (point[1] - center[1]) / radius,
    (point[2] - center[2]) / radius,
  ];
  return { point, normal, distance: t };
}

function raycastBox(
  origin: [number, number, number],
  dir: [number, number, number],
  maxDist: number,
  center: [number, number, number],
  halfExtents: [number, number, number],
): { point: [number, number, number]; normal: [number, number, number]; distance: number } | null {
  let tmin = 0;
  let tmax = maxDist;

  for (let i = 0; i < 3; i++) {
    const o = origin[i] - center[i];
    const d = dir[i];
    const half = halfExtents[i];

    if (Math.abs(d) < 1e-9) {
      if (Math.abs(o) > half) return null;
    } else {
      let t1 = (-half - o) / d;
      let t2 = (half - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }

  const t = tmin;
  const point: [number, number, number] = [
    origin[0] + dir[0] * t,
    origin[1] + dir[1] * t,
    origin[2] + dir[2] * t,
  ];

  const rel: [number, number, number] = [
    point[0] - center[0],
    point[1] - center[1],
    point[2] - center[2],
  ];
  const nx = rel[0] / halfExtents[0];
  const ny = rel[1] / halfExtents[1];
  const nz = rel[2] / halfExtents[2];
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let normal: [number, number, number];
  if (ax >= ay && ax >= az) normal = [Math.sign(nx), 0, 0];
  else if (ay >= ax && ay >= az) normal = [0, Math.sign(ny), 0];
  else normal = [0, 0, Math.sign(nz)];

  return { point, normal, distance: t };
}

function checkColliderCollision(
  posA: [number, number, number],
  shapeA: ColliderShape,
  posB: [number, number, number],
  shapeB: ColliderShape,
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  if (shapeA.type === "sphere" && shapeB.type === "sphere") {
    return sphereSphere(posA, shapeA.radius, posB, shapeB.radius);
  }
  if (shapeA.type === "box" && shapeB.type === "box") {
    return aabbAabb(posA, shapeA.halfExtents, posB, shapeB.halfExtents);
  }
  if (shapeA.type === "sphere" && shapeB.type === "box") {
    return sphereAabb(posA, shapeA.radius, posB, shapeB.halfExtents);
  }
  if (shapeA.type === "box" && shapeB.type === "sphere") {
    const result = sphereAabb(posB, shapeB.radius, posA, shapeA.halfExtents);
    if (result) {
      result.normal = [-result.normal[0], -result.normal[1], -result.normal[2]] as [number, number, number];
    }
    return result;
  }
  return null;
}

function sphereSphere(
  posA: [number, number, number],
  rA: number,
  posB: [number, number, number],
  rB: number,
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  const dx = posB[0] - posA[0];
  const dy = posB[1] - posA[1];
  const dz = posB[2] - posA[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const sumR = rA + rB;
  if (dist >= sumR) return null;
  const penetration = sumR - dist;
  const normal: [number, number, number] = dist > 1e-9
    ? [dx / dist, dy / dist, dz / dist]
    : [0, 1, 0];
  const point: [number, number, number] = [
    posA[0] + normal[0] * rA,
    posA[1] + normal[1] * rA,
    posA[2] + normal[2] * rA,
  ];
  return { normal, point, penetration };
}

function aabbAabb(
  posA: [number, number, number],
  halfA: [number, number, number],
  posB: [number, number, number],
  halfB: [number, number, number],
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  const dx = posB[0] - posA[0];
  const px = halfA[0] + halfB[0] - Math.abs(dx);
  if (px <= 0) return null;

  const dy = posB[1] - posA[1];
  const py = halfA[1] + halfB[1] - Math.abs(dy);
  if (py <= 0) return null;

  const dz = posB[2] - posA[2];
  const pz = halfA[2] + halfB[2] - Math.abs(dz);
  if (pz <= 0) return null;

  if (px < py && px < pz) {
    const nx = dx < 0 ? -1 : 1;
    return {
      normal: [nx, 0, 0],
      point: [posA[0] + nx * halfA[0], posA[1], posA[2]],
      penetration: px,
    };
  } else if (py < pz) {
    const ny = dy < 0 ? -1 : 1;
    return {
      normal: [0, ny, 0],
      point: [posA[0], posA[1] + ny * halfA[1], posA[2]],
      penetration: py,
    };
  } else {
    const nz = dz < 0 ? -1 : 1;
    return {
      normal: [0, 0, nz],
      point: [posA[0], posA[1], posA[2] + nz * halfA[2]],
      penetration: pz,
    };
  }
}

function sphereAabb(
  spherePos: [number, number, number],
  radius: number,
  boxPos: [number, number, number],
  halfExtents: [number, number, number],
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  const dx = Math.max(boxPos[0] - halfExtents[0] - spherePos[0], 0, spherePos[0] - (boxPos[0] + halfExtents[0]));
  const dy = Math.max(boxPos[1] - halfExtents[1] - spherePos[1], 0, spherePos[1] - (boxPos[1] + halfExtents[1]));
  const dz = Math.max(boxPos[2] - halfExtents[2] - spherePos[2], 0, spherePos[2] - (boxPos[2] + halfExtents[2]));
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= radius * radius) return null;

  const dist = Math.sqrt(distSq);
  const penetration = radius - dist;
  let normal: [number, number, number];
  if (dist > 1e-9) {
    normal = [-dx / dist, -dy / dist, -dz / dist];
  } else {
    normal = [0, 1, 0];
  }
  const point: [number, number, number] = [
    spherePos[0] + normal[0] * radius,
    spherePos[1] + normal[1] * radius,
    spherePos[2] + normal[2] * radius,
  ];
  return { normal, point, penetration };
}
