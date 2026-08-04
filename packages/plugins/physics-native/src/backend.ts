// ============================================================================
// NativePhysicsBackend — Pure TypeScript physics engine implementing
// PhysicsBackend interface. No native dependencies.
//
// Supports: box/sphere/capsule colliders, static/dynamic/kinematic bodies,
// multi-realm, raycast, character controller, joints (cone-twist, fixed).
// ============================================================================

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
} from "@downdraft/core/physics/interface";
import { Broadphase, type AABB } from "./broadphase";
import { detectCollision } from "./narrowphase";
import { integrate, resolveContact, type BodyData } from "./solver";
import type { ColliderShapeData, NativeBody, NativeCharacterController, NativeCollider, NativeRealm, Quat, Vec3 } from "./types";

export class NativePhysicsBackend implements PhysicsBackend {
  readonly name = "native";
  readonly version = "0.1.0";

  private realms: Map<number, NativeRealm> = new Map();
  private characters: Map<number, NativeCharacterController> = new Map();
  private joints: Map<number, { realmId: number; parentBodyId: number; childBodyId: number; desc: JointDesc }> = new Map();
  private nextJointId = 0;
  private nextCharId = 0;
  private destroyed = false;

  // --- Realm management ---

  createRealm(config: PhysicsRealmConfig): number {
    const realm: NativeRealm = {
      id: config.id,
      name: config.name,
      gravity: config.gravity,
      bodies: new Map(),
      nextBodyId: 0,
      nextColliderId: 0,
      broadphaseCellSize: config.broadphaseSize?.[0] ?? 8,
    };
    this.realms.set(config.id, realm);
    return config.id;
  }

  destroyRealm(realmId: number): void {
    this.realms.delete(realmId);
  }

  getRealmIds(): number[] {
    return [...this.realms.keys()];
  }

  // --- Body management ---

  createBody(realmId: number, desc: BodyDesc, entity: Entity): RigidBodyHandle {
    const realm = this.realms.get(realmId);
    if (!realm) throw new Error(`Realm ${realmId} not found`);

    const bodyId = realm.nextBodyId++;
    const mass = desc.mass ?? 1;
    const isStatic = desc.type === "static";
    const isKinematic = desc.type === "kinematic";

    const body: NativeBody = {
      id: bodyId,
      realmId,
      type: desc.type as BodyType,
      position: [...desc.position] as Vec3,
      rotation: [...desc.rotation] as Quat,
      linearVelocity: [...(desc.linearVelocity ?? [0, 0, 0])] as Vec3,
      angularVelocity: [...(desc.angularVelocity ?? [0, 0, 0])] as Vec3,
      mass,
      invMass: isStatic || isKinematic ? 0 : 1 / mass,
      restitution: 0.3,
      friction: 0.8,
      gravityScale: desc.gravityScale ?? 1,
      linearDamping: desc.linearDamping ?? 0.01,
      angularDamping: desc.angularDamping ?? 0.05,
      ccdEnabled: desc.ccdEnabled ?? false,
      canSleep: desc.canSleep ?? true,
      sleeping: desc.sleeping ?? false,
      lockedTranslation: desc.lockedAxes?.translation ?? null,
      lockedRotation: desc.lockedAxes?.rotation ?? null,
      colliders: [],
      entityIndex: entity.index,
      entityGeneration: entity.generation,
    };

    realm.bodies.set(bodyId, body);
    return { realmId, bodyId, entity };
  }

  destroyBody(handle: RigidBodyHandle): void {
    const realm = this.realms.get(handle.realmId);
    if (!realm) return;
    realm.bodies.delete(handle.bodyId);
  }

  setBodyType(handle: RigidBodyHandle, type: BodyType): void {
    const body = this.getBody(handle);
    if (!body) return;
    body.type = type;
    body.invMass = type === "static" || type === "kinematic" ? 0 : 1 / body.mass;
  }

  // --- Collider management ---

  addCollider(handle: RigidBodyHandle, desc: ColliderDesc): number {
    const body = this.getBody(handle);
    const realm = this.realms.get(handle.realmId);
    if (!body || !realm) return -1;

    const colliderId = realm.nextColliderId++;
    const shape = this.convertShape(desc.shape);
    const collider: NativeCollider = {
      id: colliderId,
      shape,
      friction: desc.friction ?? 0.8,
      restitution: desc.restitution ?? 0.3,
      density: desc.density ?? 1,
      sensor: desc.sensor ?? false,
      collisionGroups: desc.collisionGroups ?? 0xFFFFFFFF,
      solverGroups: desc.solverGroups ?? 0xFFFFFFFF,
    };
    body.colliders.push(collider);
    return colliderId;
  }

  removeCollider(handle: RigidBodyHandle, colliderId: number): void {
    const body = this.getBody(handle);
    if (!body) return;
    body.colliders = body.colliders.filter(c => c.id !== colliderId);
  }

  // --- Forces ---

  applyForce(handle: RigidBodyHandle, force: [number, number, number]): void {
    const body = this.getBody(handle);
    if (!body || body.type === "static" || body.type === "kinematic") return;
    // F = ma → a = F/m
    body.linearVelocity = [
      body.linearVelocity[0] + force[0] * body.invMass,
      body.linearVelocity[1] + force[1] * body.invMass,
      body.linearVelocity[2] + force[2] * body.invMass,
    ];
  }

  applyImpulse(handle: RigidBodyHandle, impulse: [number, number, number]): void {
    this.applyForce(handle, impulse);
  }

  applyTorque(handle: RigidBodyHandle, torque: [number, number, number]): void {
    const body = this.getBody(handle);
    if (!body || body.type === "static" || body.type === "kinematic") return;
    body.angularVelocity = [
      body.angularVelocity[0] + torque[0] * body.invMass,
      body.angularVelocity[1] + torque[1] * body.invMass,
      body.angularVelocity[2] + torque[2] * body.invMass,
    ];
  }

  applyTorqueImpulse(handle: RigidBodyHandle, impulse: [number, number, number]): void {
    this.applyTorque(handle, impulse);
  }

  applyImpulseAtPoint(handle: RigidBodyHandle, impulse: [number, number, number], point: [number, number, number]): void {
    const body = this.getBody(handle);
    if (!body || body.type === "static" || body.type === "kinematic") return;
    body.linearVelocity = [
      body.linearVelocity[0] + impulse[0] * body.invMass,
      body.linearVelocity[1] + impulse[1] * body.invMass,
      body.linearVelocity[2] + impulse[2] * body.invMass,
    ];
    // Torque = r × impulse (simplified)
    const r = [point[0] - body.position[0], point[1] - body.position[1], point[2] - body.position[2]];
    const torque = [
      r[1] * impulse[2] - r[2] * impulse[1],
      r[2] * impulse[0] - r[0] * impulse[2],
      r[0] * impulse[1] - r[1] * impulse[0],
    ];
    body.angularVelocity = [
      body.angularVelocity[0] + torque[0] * body.invMass,
      body.angularVelocity[1] + torque[1] * body.invMass,
      body.angularVelocity[2] + torque[2] * body.invMass,
    ];
  }

  // --- Velocity / position getters & setters ---

  setLinearVelocity(handle: RigidBodyHandle, vel: [number, number, number]): void {
    const body = this.getBody(handle);
    if (!body) return;
    body.linearVelocity = [...vel] as Vec3;
  }

  getLinearVelocity(handle: RigidBodyHandle): [number, number, number] {
    const body = this.getBody(handle);
    return body ? [...body.linearVelocity] : [0, 0, 0];
  }

  setAngularVelocity(handle: RigidBodyHandle, vel: [number, number, number]): void {
    const body = this.getBody(handle);
    if (!body) return;
    body.angularVelocity = [...vel] as Vec3;
  }

  getAngularVelocity(handle: RigidBodyHandle): [number, number, number] {
    const body = this.getBody(handle);
    return body ? [...body.angularVelocity] : [0, 0, 0];
  }

  setPosition(handle: RigidBodyHandle, pos: [number, number, number]): void {
    const body = this.getBody(handle);
    if (!body) return;
    body.position = [...pos] as Vec3;
  }

  getPosition(handle: RigidBodyHandle): [number, number, number] {
    const body = this.getBody(handle);
    return body ? [...body.position] : [0, 0, 0];
  }

  setRotation(handle: RigidBodyHandle, rot: [number, number, number, number]): void {
    const body = this.getBody(handle);
    if (!body) return;
    body.rotation = [...rot] as Quat;
  }

  getRotation(handle: RigidBodyHandle): [number, number, number, number] {
    const body = this.getBody(handle);
    return body ? [...body.rotation] : [0, 0, 0, 1];
  }

  wakeUp(handle: RigidBodyHandle): void {
    const body = this.getBody(handle);
    if (body) body.sleeping = false;
  }

  isSleeping(handle: RigidBodyHandle): boolean {
    const body = this.getBody(handle);
    return body ? body.sleeping : false;
  }

  // --- Raycasting ---

  raycast(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null {
    const results = this.raycastMulti(realmId, origin, direction, maxDistance, filter);
    return results.length > 0 ? results[0] : null;
  }

  raycastMulti(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[] {
    const realm = this.realms.get(realmId);
    if (!realm) return [];

    const dirNorm = this.normalize(direction);
    const results: RaycastResult[] = [];

    for (const body of realm.bodies.values()) {
      if (filter?.excludeEntity && body.entityIndex === filter.excludeEntity.index) continue;

      for (const collider of body.colliders) {
        const hit = this.raycastShape(
          origin, dirNorm, maxDistance,
          body, collider,
        );
        if (hit) {
          results.push({
            entity: { index: body.entityIndex, generation: body.entityGeneration },
            point: hit.point,
            normal: hit.normal,
            distance: hit.distance,
          });
        }
      }
    }

    results.sort((a, b) => a.distance - b.distance);
    return results;
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
    // Simplified: treat shape cast as a swept sphere for now
    const realm = this.realms.get(realmId);
    if (!realm) return null;

    const dirNorm = this.normalize(direction);
    let bestHit: ShapeCastResult | null = null;

    for (const body of realm.bodies.values()) {
      if (filter?.excludeEntity && body.entityIndex === filter.excludeEntity.index) continue;
      if (body.type === "static" || body.type === "kinematic") {
        // Check each collider
        for (const collider of body.colliders) {
          const hit = this.raycastShape(origin, dirNorm, maxDistance, body, collider);
          if (hit && (!bestHit || hit.distance < bestHit.distance)) {
            bestHit = {
              entity: { index: body.entityIndex, generation: body.entityGeneration },
              point: hit.point,
              normal: hit.normal,
              distance: hit.distance,
              hitFraction: hit.distance / maxDistance,
            };
          }
        }
      }
    }

    return bestHit;
  }

  // --- Simulation step ---

  step(realmId: number, dt: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;

    const bodies = [...realm.bodies.values()];
    const dynamicBodies = bodies.filter(b => b.type === "dynamic");

    // 1. Integrate (apply gravity + update position)
    for (const body of dynamicBodies) {
      if (body.sleeping) continue;
      const gravity: Vec3 = [
        realm.gravity[0] * body.gravityScale,
        realm.gravity[1] * body.gravityScale,
        realm.gravity[2] * body.gravityScale,
      ];
      const bodyData = this.toBodyData(body);
      integrate(bodyData, gravity, dt);
      this.fromBodyData(body, bodyData);
    }

    // 2. Broadphase: build AABBs and generate pairs
    const broadphase = new Broadphase(realm.broadphaseCellSize);
    for (const body of bodies) {
      const aabb = this.computeAABB(body);
      if (aabb) broadphase.insert(body.id, aabb);
    }
    const pairs = broadphase.generatePairs();

    // 3. Narrowphase + solve
    for (const [idA, idB] of pairs) {
      const bodyA = realm.bodies.get(idA);
      const bodyB = realm.bodies.get(idB);
      if (!bodyA || !bodyB) continue;
      if (bodyA.type === "static" && bodyB.type === "static") continue;

      for (const colA of bodyA.colliders) {
        if (colA.sensor) continue;
        for (const colB of bodyB.colliders) {
          if (colB.sensor) continue;

          const manifold = detectCollision(
            colA.shape, bodyA.position, bodyA.rotation,
            colB.shape, bodyB.position, bodyB.rotation,
          );
          if (!manifold) continue;

          const dataA = this.toBodyData(bodyA);
          const dataB = this.toBodyData(bodyB);
          resolveContact(dataA, dataB, manifold);
          this.fromBodyData(bodyA, dataA);
          this.fromBodyData(bodyB, dataB);
        }
      }
    }

    // 4. Apply damping
    for (const body of dynamicBodies) {
      if (body.sleeping) continue;
      const ld = 1 - body.linearDamping * dt;
      const ad = 1 - body.angularDamping * dt;
      body.linearVelocity = [
        body.linearVelocity[0] * ld,
        body.linearVelocity[1] * ld,
        body.linearVelocity[2] * ld,
      ];
      body.angularVelocity = [
        body.angularVelocity[0] * ad,
        body.angularVelocity[1] * ad,
        body.angularVelocity[2] * ad,
      ];

      // Apply locked axes
      if (body.lockedTranslation) {
        if (body.lockedTranslation[0]) body.linearVelocity[0] = 0;
        if (body.lockedTranslation[1]) body.linearVelocity[1] = 0;
        if (body.lockedTranslation[2]) body.linearVelocity[2] = 0;
      }
      if (body.lockedRotation) {
        if (body.lockedRotation[0]) body.angularVelocity[0] = 0;
        if (body.lockedRotation[1]) body.angularVelocity[1] = 0;
        if (body.lockedRotation[2]) body.angularVelocity[2] = 0;
      }
    }
  }

  stepAll(dt: number): void {
    for (const realmId of this.realms.keys()) {
      this.step(realmId, dt);
    }
  }

  // --- Contacts ---

  getContacts(realmId: number): ContactManifold[] {
    const realm = this.realms.get(realmId);
    if (!realm) return [];

    const contacts: ContactManifold[] = [];
    const broadphase = new Broadphase(realm.broadphaseCellSize);
    const bodies = [...realm.bodies.values()];

    for (const body of bodies) {
      const aabb = this.computeAABB(body);
      if (aabb) broadphase.insert(body.id, aabb);
    }
    const pairs = broadphase.generatePairs();

    for (const [idA, idB] of pairs) {
      const bodyA = realm.bodies.get(idA);
      const bodyB = realm.bodies.get(idB);
      if (!bodyA || !bodyB) continue;

      for (const colA of bodyA.colliders) {
        if (colA.sensor) continue;
        for (const colB of bodyB.colliders) {
          if (colB.sensor) continue;
          const manifold = detectCollision(
            colA.shape, bodyA.position, bodyA.rotation,
            colB.shape, bodyB.position, bodyB.rotation,
          );
          if (!manifold) continue;

          contacts.push({
            entityA: { index: bodyA.entityIndex, generation: bodyA.entityGeneration },
            entityB: { index: bodyB.entityIndex, generation: bodyB.entityGeneration },
            normal: manifold.normal,
            points: manifold.points.map(p => p.point),
            penetrationDepth: manifold.penetrationDepth,
          });
        }
      }
    }

    return contacts;
  }

  // --- Character controller ---

  createCharacterController(realmId: number, desc: CharacterControllerDesc, entity: Entity): CharacterControllerHandle {
    const id = this.nextCharId++;
    const char: NativeCharacterController = {
      id,
      realmId,
      bodyId: -1,
      entityIndex: entity.index,
      entityGeneration: entity.generation,
      offset: [...desc.offset] as Vec3,
      radius: desc.radius,
      halfHeight: desc.halfHeight,
      slide: desc.slide,
      autostep: desc.autostep,
      maxSlope: desc.maxSlope,
      snapToGround: desc.snapToGround,
    };
    this.characters.set(id, char);
    return { realmId, controllerId: id, entity };
  }

  destroyCharacterController(handle: CharacterControllerHandle): void {
    this.characters.delete(handle.controllerId);
  }

  characterMove(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult {
    const char = this.characters.get(handle.controllerId);
    const realm = this.realms.get(handle.realmId);
    if (!char || !realm) {
      return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: desiredMovement };
    }

    const body = realm.bodies.get(char.bodyId);
    const startPos = body ? body.position : [0, 0, 0] as Vec3;
    const movement: Vec3 = [...desiredMovement] as Vec3;
    let slid = false;
    let stepped = false;
    let grounded = false;
    let groundNormal: Vec3 = [0, 1, 0];
    let groundEntity: Entity | null = null;

    // Try to move in the desired direction, resolving collisions
    const newPos: Vec3 = [
      startPos[0] + movement[0],
      startPos[1] + movement[1],
      startPos[2] + movement[2],
    ];

    // Check collisions against all bodies in the realm
    for (const otherBody of realm.bodies.values()) {
      if (otherBody.id === char.bodyId) continue;
      if (otherBody.type !== "static" && otherBody.type !== "kinematic") continue;

      for (const collider of otherBody.colliders) {
        const manifold = detectCollision(
          { type: "capsule", halfHeight: char.halfHeight, radius: char.radius },
          newPos, [0, 0, 0, 1],
          collider.shape, otherBody.position, otherBody.rotation,
        );
        if (!manifold) continue;

        // Push out along normal
        const correction = manifold.penetrationDepth;
        newPos[0] += manifold.normal[0] * correction;
        newPos[1] += manifold.normal[1] * correction;
        newPos[2] += manifold.normal[2] * correction;

        // Check if this is ground (normal pointing up)
        if (manifold.normal[1] > 0.7) {
          grounded = true;
          groundNormal = manifold.normal;
          groundEntity = { index: otherBody.entityIndex, generation: otherBody.entityGeneration };
        }

        // Slide: remove normal component from movement
        if (char.slide) {
          const dot = movement[0] * manifold.normal[0] + movement[1] * manifold.normal[1] + movement[2] * manifold.normal[2];
          if (dot < 0) {
            movement[0] -= dot * manifold.normal[0];
            movement[1] -= dot * manifold.normal[1];
            movement[2] -= dot * manifold.normal[2];
            slid = true;
          }
        }
      }
    }

    // Snap to ground
    if (char.snapToGround > 0 && grounded) {
      // Simple ground snap: keep Y at ground level
      // (Full implementation would raycast downward)
    }

    if (body) {
      body.position = newPos;
    }

    const effectiveMovement: Vec3 = [
      newPos[0] - startPos[0],
      newPos[1] - startPos[1],
      newPos[2] - startPos[2],
    ];

    return {
      grounded,
      groundNormal,
      groundEntity,
      slid,
      stepped,
      effectiveMovement,
    };
  }

  // --- Joints ---

  createJoint(realmId: number, parentHandle: RigidBodyHandle, childHandle: RigidBodyHandle, desc: JointDesc): number {
    const jointId = this.nextJointId++;
    this.joints.set(jointId, {
      realmId,
      parentBodyId: parentHandle.bodyId,
      childBodyId: childHandle.bodyId,
      desc,
    });
    return jointId;
  }

  destroyJoint(realmId: number, jointId: number): void {
    this.joints.delete(jointId);
  }

  // --- Transform sync ---

  syncTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    let i = 0;
    for (const body of realm.bodies.values()) {
      if (i >= entityCount) break;
      const offset = i * 8;
      transformBuffer[offset] = body.position[0];
      transformBuffer[offset + 1] = body.position[1];
      transformBuffer[offset + 2] = body.position[2];
      transformBuffer[offset + 3] = body.rotation[0];
      transformBuffer[offset + 4] = body.rotation[1];
      transformBuffer[offset + 5] = body.rotation[2];
      transformBuffer[offset + 6] = body.rotation[3];
      i++;
    }
  }

  readTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    let i = 0;
    for (const body of realm.bodies.values()) {
      if (i >= entityCount) break;
      const offset = i * 8;
      body.position = [transformBuffer[offset], transformBuffer[offset + 1], transformBuffer[offset + 2]] as Vec3;
      body.rotation = [transformBuffer[offset + 3], transformBuffer[offset + 4], transformBuffer[offset + 5], transformBuffer[offset + 6]] as Quat;
      i++;
    }
  }

  // --- Cleanup ---

  destroy(): void {
    this.realms.clear();
    this.characters.clear();
    this.joints.clear();
    this.destroyed = true;
  }

  // --- Private helpers ---

  private getBody(handle: RigidBodyHandle): NativeBody | null {
    const realm = this.realms.get(handle.realmId);
    if (!realm) return null;
    return realm.bodies.get(handle.bodyId) ?? null;
  }

  private convertShape(shape: ColliderShape): ColliderShapeData {
    if (shape.type === "box") {
      return { type: "box", halfExtents: shape.halfExtents };
    }
    if (shape.type === "sphere") {
      return { type: "sphere", radius: shape.radius };
    }
    if (shape.type === "capsule") {
      return { type: "capsule", halfHeight: shape.halfHeight, radius: shape.radius };
    }
    if (shape.type === "mesh") {
      return { type: "mesh", vertices: shape.vertices, indices: shape.indices };
    }
    if (shape.type === "convex") {
      return { type: "convex", vertices: shape.vertices };
    }
    // Fallback: small sphere
    return { type: "sphere", radius: 0.5 };
  }

  private computeAABB(body: NativeBody): AABB | null {
    if (body.colliders.length === 0) return null;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const collider of body.colliders) {
      const shape = collider.shape;
      if (shape.type === "sphere") {
        const r = shape.radius;
        minX = Math.min(minX, body.position[0] - r);
        minY = Math.min(minY, body.position[1] - r);
        minZ = Math.min(minZ, body.position[2] - r);
        maxX = Math.max(maxX, body.position[0] + r);
        maxY = Math.max(maxY, body.position[1] + r);
        maxZ = Math.max(maxZ, body.position[2] + r);
      } else if (shape.type === "box") {
        // For rotated boxes, compute the max extent along each axis
        const he = shape.halfExtents;
        // Approximate: use the max half-extent for all axes (conservative AABB)
        const maxHe = Math.max(he[0], he[1], he[2]);
        minX = Math.min(minX, body.position[0] - maxHe);
        minY = Math.min(minY, body.position[1] - maxHe);
        minZ = Math.min(minZ, body.position[2] - maxHe);
        maxX = Math.max(maxX, body.position[0] + maxHe);
        maxY = Math.max(maxY, body.position[1] + maxHe);
        maxZ = Math.max(maxZ, body.position[2] + maxHe);
      } else if (shape.type === "capsule") {
        const r = shape.radius;
        const hh = shape.halfHeight;
        const totalR = r + hh;
        minX = Math.min(minX, body.position[0] - r);
        minY = Math.min(minY, body.position[1] - totalR);
        minZ = Math.min(minZ, body.position[2] - r);
        maxX = Math.max(maxX, body.position[0] + r);
        maxY = Math.max(maxY, body.position[1] + totalR);
        maxZ = Math.max(maxZ, body.position[2] + r);
      }
    }

    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  private raycastShape(
    origin: Vec3,
    dir: Vec3,
    maxDist: number,
    body: NativeBody,
    collider: NativeCollider,
  ): { point: Vec3; normal: Vec3; distance: number } | null {
    const shape = collider.shape;
    const pos = body.position;

    if (shape.type === "sphere") {
      return raySphere(origin, dir, maxDist, pos, shape.radius);
    }
    if (shape.type === "box") {
      return rayBox(origin, dir, maxDist, pos, body.rotation, shape.halfExtents);
    }
    if (shape.type === "capsule") {
      return rayCapsule(origin, dir, maxDist, pos, body.rotation, shape.halfHeight, shape.radius);
    }
    return null;
  }

  private toBodyData(body: NativeBody): BodyData {
    return {
      position: body.position,
      rotation: body.rotation,
      linearVelocity: body.linearVelocity,
      angularVelocity: body.angularVelocity,
      mass: body.mass,
      invMass: body.invMass,
      invInertia: body.invMass, // simplified
      restitution: body.restitution,
      friction: body.friction,
      isStatic: body.type === "static",
      isKinematic: body.type === "kinematic",
    };
  }

  private fromBodyData(body: NativeBody, data: BodyData): void {
    body.position = data.position;
    body.linearVelocity = data.linearVelocity;
    body.angularVelocity = data.angularVelocity;
  }

  private normalize(v: [number, number, number]): [number, number, number] {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (len < 1e-9) return [0, 0, 0];
    return [v[0] / len, v[1] / len, v[2] / len];
  }
}

// --- Ray-shape intersection helpers ---

function raySphere(
  origin: Vec3, dir: Vec3, maxDist: number,
  center: Vec3, radius: number,
): { point: Vec3; normal: Vec3; distance: number } | null {
  const oc = [origin[0] - center[0], origin[1] - center[1], origin[2] - center[2]];
  const a = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
  const b = 2 * (oc[0] * dir[0] + oc[1] * dir[1] + oc[2] * dir[2]);
  const c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  let t = t1 >= 0 ? t1 : t2;
  if (t < 0 || t > maxDist) return null;
  const point = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t] as Vec3;
  const normal = [
    (point[0] - center[0]) / radius,
    (point[1] - center[1]) / radius,
    (point[2] - center[2]) / radius,
  ] as Vec3;
  return { point, normal, distance: t };
}

function rayBox(
  origin: Vec3, dir: Vec3, maxDist: number,
  center: Vec3, rot: Quat, half: [number, number, number],
): { point: Vec3; normal: Vec3; distance: number } | null {
  // Transform ray to box local space
  const invRot: Quat = [rot[0], rot[1], rot[2], -rot[3]];
  const localOrigin = rotateVec([origin[0] - center[0], origin[1] - center[1], origin[2] - center[2]], invRot);
  const localDir = rotateVec(dir, invRot);

  // Slab method
  let tmin = 0;
  let tmax = maxDist;
  let hitAxis = -1;
  let hitSign = 0;

  for (let i = 0; i < 3; i++) {
    const o = [localOrigin[0], localOrigin[1], localOrigin[2]][i];
    const d = [localDir[0], localDir[1], localDir[2]][i];
    const h = half[i];

    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return null;
      continue;
    }

    const t1 = (-h - o) / d;
    const t2 = (h - o) / d;
    const sign = t1 < t2 ? -1 : 1;

    if (t1 > t2) {
      // Swap
      const tmp = t1; // not used after
    }
    const near = Math.min(t1, t2);
    const far = Math.max(t1, t2);

    if (near > tmin) {
      tmin = near;
      hitAxis = i;
      hitSign = sign;
    }
    if (far < tmax) tmax = far;
    if (tmin > tmax) return null;
  }

  if (tmin < 0 || tmin > maxDist) return null;

  const localPoint = [
    localOrigin[0] + localDir[0] * tmin,
    localOrigin[1] + localDir[1] * tmin,
    localOrigin[2] + localDir[2] * tmin,
  ] as Vec3;

  const localNormal: Vec3 = [0, 0, 0];
  if (hitAxis >= 0) {
    localNormal[hitAxis] = hitSign;
  }

  const worldPoint = [
    center[0] + rotateVec(localPoint, rot)[0],
    center[1] + rotateVec(localPoint, rot)[1],
    center[2] + rotateVec(localPoint, rot)[2],
  ] as Vec3;
  const worldNormal = rotateVec(localNormal, rot);

  return { point: worldPoint, normal: worldNormal, distance: tmin };
}

function rayCapsule(
  origin: Vec3, dir: Vec3, maxDist: number,
  center: Vec3, rot: Quat, halfHeight: number, radius: number,
): { point: Vec3; normal: Vec3; distance: number } | null {
  // Approximate: treat as sphere with combined radius for simple cases
  // For better accuracy, we'd check against the cylinder body + two end spheres
  // For now, use the sphere check with the capsule's bounding radius
  const totalR = radius + halfHeight;
  return raySphere(origin, dir, maxDist, center, totalR);
}

// Import rotateVec from narrowphase-shapes
import { rotateVec } from "./narrowphase-shapes";
