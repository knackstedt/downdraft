import type * as Rapier from "@dimforge/rapier3d-compat";
import type { BodyDesc, BodyType, CharacterCollisionInfo, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ColliderDesc, ColliderShape, ContactManifold, Entity, IntersectionPair, IslandInfo, JointDesc, RaycastResult, ShapeCastResult } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine";

const log = createLogger();

export interface PhysicsLib {
  createRealm(id: number, gravity: [number, number, number]): void;
  destroyRealm(id: number): void;
  createBody(realmId: number, bodyId: number, desc: BodyDesc, entity: Entity): void;
  destroyBody(realmId: number, bodyId: number): void;
  setBodyType(realmId: number, bodyId: number, type: BodyType): void;
  addCollider(realmId: number, bodyId: number, colliderId: number, desc: ColliderDesc): void;
  removeCollider(realmId: number, bodyId: number, colliderId: number): void;
  setColliderPosition?(realmId: number, colliderId: number, pos: [number, number, number]): void;
  getColliderPosition?(realmId: number, colliderId: number): [number, number, number];
  applyForce(realmId: number, bodyId: number, force: [number, number, number]): void;
  applyImpulse(realmId: number, bodyId: number, impulse: [number, number, number]): void;
  applyTorque(realmId: number, bodyId: number, torque: [number, number, number]): void;
  applyTorqueImpulse(realmId: number, bodyId: number, impulse: [number, number, number]): void;
  applyImpulseAtPoint(realmId: number, bodyId: number, impulse: [number, number, number], point: [number, number, number]): void;
  setLinearVelocity(realmId: number, bodyId: number, vel: [number, number, number]): void;
  setAngularVelocity(realmId: number, bodyId: number, vel: [number, number, number]): void;
  setPosition(realmId: number, bodyId: number, pos: [number, number, number]): void;
  setRotation(realmId: number, bodyId: number, rot: [number, number, number, number]): void;
  wakeUp(realmId: number, bodyId: number): void;
  // Raw fast paths (optional — implemented by the WASM Rapier backend)
  setTranslationRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, wakeUp: boolean): void;
  setRotationRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, w: number, wakeUp: boolean): void;
  getTranslationRaw?(realmId: number, bodyId: number, out: [number, number, number]): void;
  getRotationRaw?(realmId: number, bodyId: number, out: [number, number, number, number]): void;
  getLinearVelocityRaw?(realmId: number, bodyId: number, out: [number, number, number]): void;
  setLinearVelocityRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, wakeUp: boolean): void;
  setAngularVelocityRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, wakeUp: boolean): void;
  isSleepingRaw?(realmId: number, bodyId: number): boolean;
  /**
   * Bulk readback of AWAKE bodies: enumerates the island manager's active set
   * in one WASM→JS pass, then reads each body's transform via the raw scalar
   * API. Writes idsOut[i] = bodyId and out[i*10 .. +9] =
   * [pos.x, pos.y, pos.z, rot.x, rot.y, rot.z, rot.w, linvel.x, linvel.y, linvel.z].
   * Returns the number of bodies written (≤ maxCount). Sleeping bodies are
   * excluded — they cannot move, so callers keep their last-synced values.
   */
  readAwakeBodyStates?(realmId: number, idsOut: Uint32Array, out: Float32Array, maxCount: number): number;
  /**
   * Fused step + awake-body readback (native FFI fast path — one call per
   * tick). Same output layout as readAwakeBodyStates; dt follows step()
   * semantics (dt <= 0 uses the stored integration dt).
   */
  stepAndReadAwake?(realmId: number, dt: number, idsOut: Uint32Array, out: Float32Array, maxCount: number): number;
  swapColliderShapeRaw?(realmId: number, colliderId: number, vertices: Float32Array, indices: Uint32Array): boolean;
  testConvexHull?(vertices: Float32Array): boolean;
  /** Returns the Rapier ShapeType enum value of the live collider (0=Ball,1=Cuboid,9=ConvexPolyhedron,...). -1 if not found. */
  getColliderShapeType?(realmId: number, colliderId: number): number;
  /** Returns the number of live Rapier colliders currently attached to the body. */
  getColliderCount?(realmId: number, bodyId: number): number;
  reserveMemory?(bytes: number): void;
  setIntegrationDt?(realmId: number, dt: number): void;
  step(realmId: number, dt: number): void;
  getContacts(realmId: number): ContactManifold[];
  getIntersections(realmId: number): IntersectionPair[];
  getBodyTransform(realmId: number, bodyId: number): { position: [number, number, number]; rotation: [number, number, number, number] } | null;
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
  createCharacterController(
    realmId: number,
    desc: CharacterControllerDesc,
    handle: CharacterControllerHandle,
  ): void;
  destroyCharacterController(realmId: number, controllerId: number): void;
  characterMove(
    realmId: number,
    controllerId: number,
    desiredMovement: [number, number, number],
    dt: number,
  ): CharacterMoveResult;
  setCharacterColliderPosition?(realmId: number, controllerId: number, pos: [number, number, number]): void;
  createJoint(
    realmId: number,
    parentBodyId: number,
    childBodyId: number,
    jointId: number,
    desc: JointDesc,
  ): void;
  destroyJoint(realmId: number, jointId: number): void;
  setSolverIterations(realmId: number, iterations: number): void;
  setSleepThresholds(realmId: number, linearThreshold: number, angularThreshold: number): void;
  setMinIslandSize?(realmId: number, size: number): void;
  setCCDEnabled(realmId: number, bodyId: number, enabled: boolean): void;
  getIslands(realmId: number): IslandInfo[];
  serializeRealm(realmId: number): Uint8Array;
  deserializeRealm(realmId: number, data: Uint8Array): void;
  destroy(): void;
}

let cachedLib: PhysicsLib | null = null;
let loadingPromise: Promise<PhysicsLib> | null = null;

export function loadPhysicsLib(): Promise<PhysicsLib> {
  if (cachedLib) return Promise.resolve(cachedLib);
  // Coalesce concurrent calls onto the same in-flight load; but do NOT
  // permanently prevent retries after a failure — a panic + re-init cycle
  // (common during dev / first tick) must be able to load the WASM lib on
  // the second attempt.
  if (loadingPromise) return loadingPromise;

  const p = doLoadPhysicsLib();
  loadingPromise = p;
  // Clear the loading promise once settled so a failed load can be retried
  // on the next call (cachedLib is set on success, so successful loads
  // short-circuit at the top).
  p.then(() => { if (loadingPromise === p) loadingPromise = null; })
   .catch(() => { if (loadingPromise === p) loadingPromise = null; });
  return p;
}

async function doLoadPhysicsLib(): Promise<PhysicsLib> {
  try {
    const rapier = await import("@dimforge/rapier3d-compat");

    // Suppress the spurious "deprecated parameters" warning from Rapier's
    // __wbg_init — it fires because rapier.init() passes an ArrayBuffer
    // directly, and the init function's deprecation check treats any
    // non-plain-object argument as "deprecated" (an upstream Rapier bug).
    // oxlint-disable-next-line no-console -- intentional interception, not logging
    const origWarn = console.warn;
    // oxlint-disable-next-line no-console -- intentional interception, not logging
    console.warn = (...args: any[]) => {
      if (typeof args[0] === "string" && args[0].includes("deprecated parameters for the initialization function")) return;
      origWarn.apply(console, args as any);
    };
    try {
      await rapier.init();
    } finally {
      // oxlint-disable-next-line no-console -- restore the intercepted binding
      console.warn = origWarn;
    }

    const realms = new Map<number, Rapier.World>();
    const bodyMaps = new Map<number, Map<number, Rapier.RigidBody>>();
    const colliderMaps = new Map<number, Map<number, Rapier.Collider>>();
    const controllerMaps = new Map<number, Map<number, { controller: Rapier.KinematicCharacterController; body: Rapier.RigidBody | null; collider: Rapier.Collider | null; entity: Entity }>>();
    const jointMaps = new Map<number, Map<number, Rapier.ImpulseJoint>>();
    // Reverse map: Rapier rigid-body handle -> Entity, for collision reporting.
    // Populated in createBody, cleared in destroyBody/destroyRealm.
    const entityByBodyHandle = new Map<number, Map<number, Entity>>();
    // Reverse map: Rapier rigid-body handle -> game bodyId, for the bulk
    // awake-body readback (forEachActiveRigidBodyHandle yields raw handles).
    const bodyIdByHandle = new Map<number, Map<number, number>>();
    // Scratch for the awake-handle enumeration (grown on demand). Rapier
    // handles are u64s passed through JS as f64 bit patterns (e.g. handle 1
    // reads as 5e-324) — MUST be Float64Array, a Uint32Array truncates to 0.
    let awakeHandleScratch = new Float64Array(1024);

    function makeColliderDesc(desc: ColliderDesc): Rapier.ColliderDesc {
      const shape = desc.shape;
      let cd: Rapier.ColliderDesc;
      if (shape.type === "box") {
        cd = rapier.ColliderDesc.cuboid(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]);
      } else if (shape.type === "sphere") {
        cd = rapier.ColliderDesc.ball(shape.radius);
      } else if (shape.type === "capsule") {
        cd = rapier.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      } else if (shape.type === "convex") {
        const verts = new Float32Array(shape.vertices);
        cd = rapier.ColliderDesc.convexHull(verts) ?? rapier.ColliderDesc.ball(0.5);
      } else if (shape.type === "mesh") {
        const verts = new Float32Array(shape.vertices);
        const indices = new Uint32Array(shape.indices);
        cd = rapier.ColliderDesc.trimesh(verts, indices);
      } else if (shape.type === "heightfield") {
        // Rapier 0.19.3's WASM heightfield panics with "unreachable" in
        // rawshape_heightfield for any input. Convert to trimesh as a fallback.
        // When Rapier is upgraded to a version that fixes this, switch to:
        //   rapier.ColliderDesc.heightfield(nrows, ncols, heights, scale, 0)
        const { nrows, ncols, heights, scale } = shape;
        const verts = new Float32Array(nrows * ncols * 3);
        for (let r = 0; r < nrows; r++) {
          for (let c = 0; c < ncols; c++) {
            const idx = (r * ncols + c) * 3;
            verts[idx] = (c / (ncols - 1) - 0.5) * scale[0] * 2;
            verts[idx + 1] = heights[r * ncols + c] * scale[1];
            verts[idx + 2] = (r / (nrows - 1) - 0.5) * scale[2] * 2;
          }
        }
        const indices = new Uint32Array((nrows - 1) * (ncols - 1) * 6);
        let ii = 0;
        for (let r = 0; r < nrows - 1; r++) {
          for (let c = 0; c < ncols - 1; c++) {
            const v0 = r * ncols + c;
            const v1 = r * ncols + c + 1;
            const v2 = (r + 1) * ncols + c;
            const v3 = (r + 1) * ncols + c + 1;
            indices[ii++] = v0; indices[ii++] = v2; indices[ii++] = v1;
            indices[ii++] = v1; indices[ii++] = v2; indices[ii++] = v3;
          }
        }
        cd = rapier.ColliderDesc.trimesh(verts, indices);
      } else {
        cd = rapier.ColliderDesc.ball(0.5);
      }
      if (desc.friction !== undefined) cd.setFriction(desc.friction);
      if (desc.restitution !== undefined) cd.setRestitution(desc.restitution);
      if (desc.density !== undefined) cd.setDensity(desc.density);
      if (desc.sensor) cd.setSensor(true);
      if (desc.collisionGroups !== undefined) cd.setCollisionGroups(desc.collisionGroups);
      if (desc.solverGroups !== undefined) cd.setSolverGroups(desc.solverGroups);
      if (desc.translation) cd.setTranslation(desc.translation[0], desc.translation[1], desc.translation[2]);
      if (desc.rotation) cd.setRotation({ x: desc.rotation[0], y: desc.rotation[1], z: desc.rotation[2], w: desc.rotation[3] });
      return cd;
    }

    const lib: PhysicsLib = {
      createRealm(id, gravity) {
        const world = new rapier.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
        realms.set(id, world);
        bodyMaps.set(id, new Map());
        colliderMaps.set(id, new Map());
        controllerMaps.set(id, new Map());
        jointMaps.set(id, new Map());
        entityByBodyHandle.set(id, new Map());
        bodyIdByHandle.set(id, new Map());
      },
      destroyRealm(id) {
        realms.delete(id);
        bodyMaps.delete(id);
        colliderMaps.delete(id);
        controllerMaps.delete(id);
        jointMaps.delete(id);
        entityByBodyHandle.delete(id);
        bodyIdByHandle.delete(id);
      },
      createBody(realmId, bodyId, desc, entity) {
        const world = realms.get(realmId);
        if (!world) return;

        let rbDesc: Rapier.RigidBodyDesc;
        if (desc.type === "static") {
          rbDesc = rapier.RigidBodyDesc.fixed();
        } else if (desc.type === "kinematic") {
          rbDesc = rapier.RigidBodyDesc.kinematicPositionBased();
        } else {
          rbDesc = rapier.RigidBodyDesc.dynamic();
        }

        rbDesc.setTranslation(desc.position[0], desc.position[1], desc.position[2]);
        rbDesc.setRotation({
          x: desc.rotation[0],
          y: desc.rotation[1],
          z: desc.rotation[2],
          w: desc.rotation[3],
        });

        if (desc.mass) rbDesc.setAdditionalMass(desc.mass);
        if (desc.linearDamping) rbDesc.setLinearDamping(desc.linearDamping);
        if (desc.angularDamping) rbDesc.setAngularDamping(desc.angularDamping);
        if (desc.ccdEnabled) rbDesc.setCcdEnabled(true);
        if (desc.canSleep === false) rbDesc.setCanSleep(false);
        if (desc.gravityScale !== undefined) rbDesc.setGravityScale(desc.gravityScale);
        if (desc.lockedAxes?.rotation) {
          const [rx, ry, rz] = desc.lockedAxes.rotation;
          if (rx && ry && rz) {
            rbDesc.lockRotations();
          } else {
            rbDesc.enabledRotations(!rx, !ry, !rz);
          }
        }
        if (desc.lockedAxes?.translation) {
          const [tx, ty, tz] = desc.lockedAxes.translation;
          rbDesc.enabledTranslations(!tx, !ty, !tz);
        }

        const body = world.createRigidBody(rbDesc);
        bodyMaps.get(realmId)?.set(bodyId, body);
        entityByBodyHandle.get(realmId)?.set(body.handle, entity);
        bodyIdByHandle.get(realmId)?.set(body.handle, bodyId);
      },
      destroyBody(realmId, bodyId) {
        const world = realms.get(realmId);
        const map = bodyMaps.get(realmId);
        if (!world || !map) return;
        const body = map.get(bodyId);
        if (body) {
          entityByBodyHandle.get(realmId)?.delete(body.handle);
          bodyIdByHandle.get(realmId)?.delete(body.handle);
          world.removeRigidBody(body);
          map.delete(bodyId);
        }
      },
      setBodyType(realmId, bodyId, type) {
        const map = bodyMaps.get(realmId);
        const body = map?.get(bodyId);
        if (!body) return;
        if (type === "static") body.setBodyType(rapier.RigidBodyType.Fixed, true);
        else if (type === "kinematic") body.setBodyType(rapier.RigidBodyType.KinematicPositionBased, true);
        else body.setBodyType(rapier.RigidBodyType.Dynamic, true);
      },
      addCollider(realmId, bodyId, colliderId, desc) {
        const world = realms.get(realmId);
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!world || !body) return;
        const cd = makeColliderDesc(desc);
        const collider = world.createCollider(cd, body);
        colliderMaps.get(realmId)?.set(colliderId, collider);
        // cd.shape is a SharedShape (no .free() method); world.createCollider
        // internally calls shape.intoRaw() and frees the resulting RawColliderShape.
        // This no-op try/catch is kept as a safety net for future shape types.
        try { (cd as any).shape?.free?.(); } catch {}
      },
      removeCollider(realmId, bodyId, colliderId) {
        const world = realms.get(realmId);
        const collider = colliderMaps.get(realmId)?.get(colliderId);
        if (!world || !collider) return;
        world.removeCollider(collider, false);
        colliderMaps.get(realmId)?.delete(colliderId);
      },
      setColliderPosition(realmId, colliderId, pos) {
        const collider = colliderMaps.get(realmId)?.get(colliderId);
        if (collider) collider.setTranslation({ x: pos[0], y: pos[1], z: pos[2] });
      },
      getColliderPosition(realmId, colliderId) {
        const collider = colliderMaps.get(realmId)?.get(colliderId);
        if (!collider) return [0, 0, 0];
        const t = collider.translation();
        const result = [t.x, t.y, t.z] as [number, number, number];
        // Free the RawVector to prevent WASM borrow aliasing
        try { (t as any).free?.(); } catch {}
        return result;
      },
      applyForce(realmId, bodyId, force) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.addForce({ x: force[0], y: force[1], z: force[2] }, true);
      },
      applyImpulse(realmId, bodyId, impulse) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
      },
      applyTorque(realmId, bodyId, torque) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.addTorque({ x: torque[0], y: torque[1], z: torque[2] }, true);
      },
      applyTorqueImpulse(realmId, bodyId, impulse) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.applyTorqueImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
      },
      applyImpulseAtPoint(realmId, bodyId, impulse, point) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.applyImpulseAtPoint(
          { x: impulse[0], y: impulse[1], z: impulse[2] },
          { x: point[0], y: point[1], z: point[2] },
          true,
        );
      },
      setLinearVelocity(realmId, bodyId, vel) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
      },
      setAngularVelocity(realmId, bodyId, vel) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.setAngvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
      },
      setPosition(realmId, bodyId, pos) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, true);
      },
      setRotation(realmId, bodyId, rot) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.setRotation({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] }, true);
      },
      wakeUp(realmId, bodyId) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.wakeUp();
      },
      step(realmId, dt) {
        const world = realms.get(realmId);
        if (world) world.step();
      },
      getContacts(realmId) {
        const world = realms.get(realmId);
        if (!world) return [];
        const entityMap = entityByBodyHandle.get(realmId);
        if (!entityMap) return [];

        const contacts: ContactManifold[] = [];
        const seen = new Set<string>(); // dedup pairs (c1,c2) and (c2,c1)

        // Enumerate only colliders owned by ACTIVE bodies. Contacts between
        // sleeping bodies are static and produce no new impulses — matching
        // Rapier's own EventQueue semantics, which only reports activity for
        // bodies in active islands. Enumerating every collider in the world
        // (forEachCollider + contactPairsWith per collider + parent() per
        // pair) costs ~15ms per call on a ~1.8k-collider resting scene even
        // when everything is asleep.
        world.islands.raw.forEachActiveRigidBodyHandle((handle: number) => {
          const rb = world.getRigidBody(handle);
          if (!rb) return;
          const numColliders = rb.numColliders();
          for (let i = 0; i < numColliders; i++) {
            const c1 = rb.collider(i);
            if (c1.isSensor()) continue; // sensors don't produce contact manifolds
            world.contactPairsWith(c1, (c2) => {
              if (c2.isSensor()) return;
              const key = c1.handle < c2.handle
                ? `${c1.handle}:${c2.handle}`
                : `${c2.handle}:${c1.handle}`;
              if (seen.has(key)) return;
              seen.add(key);

              const bodyA = c1.parent();
              const bodyB = c2.parent();
              if (!bodyA || !bodyB) return;
              const entityA = entityMap.get(bodyA.handle);
              const entityB = entityMap.get(bodyB.handle);
              if (!entityA || !entityB) return;

              world.contactPair(c1, c2, (manifold, flipped) => {
                const normal = manifold.normal();
                const numContacts = manifold.numContacts();
                const points: Array<[number, number, number]> = [];
                for (let i = 0; i < numContacts; i++) {
                  const pt = manifold.localContactPoint1(i);
                  if (pt) {
                    points.push([pt.x, pt.y, pt.z]);
                    try { (pt as any).free?.(); } catch {}
                  }
                }
                // Contact distance — use first contact's distance as penetration depth
                let penetration = 0;
                if (numContacts > 0) {
                  penetration = Math.max(0, -manifold.contactDist(0));
                }
                const nx = flipped ? -normal.x : normal.x;
                const ny = flipped ? -normal.y : normal.y;
                const nz = flipped ? -normal.z : normal.z;
                try { (normal as any).free?.(); } catch {}
                try { (manifold as any).free?.(); } catch {}

                contacts.push({
                  entityA,
                  entityB,
                  normal: [nx, ny, nz],
                  points,
                  penetrationDepth: penetration,
                });
              });
            });
          }
        });

        return contacts;
      },
      getIntersections(realmId) {
        const world = realms.get(realmId);
        if (!world) return [];
        const entityMap = entityByBodyHandle.get(realmId);
        if (!entityMap) return [];

        const intersections: IntersectionPair[] = [];
        const seen = new Set<string>();

        // Active-body-only enumeration — same rationale as getContacts.
        world.islands.raw.forEachActiveRigidBodyHandle((handle: number) => {
          const rb = world.getRigidBody(handle);
          if (!rb) return;
          const numColliders = rb.numColliders();
          for (let i = 0; i < numColliders; i++) {
            const c1 = rb.collider(i);
            world.intersectionPairsWith(c1, (c2) => {
              const key = c1.handle < c2.handle
                ? `${c1.handle}:${c2.handle}`
                : `${c2.handle}:${c1.handle}`;
              if (seen.has(key)) return;
              seen.add(key);

              const bodyA = c1.parent();
              const bodyB = c2.parent();
              if (!bodyA || !bodyB) return;
              const entityA = entityMap.get(bodyA.handle);
              const entityB = entityMap.get(bodyB.handle);
              if (!entityA || !entityB) return;

              intersections.push({ entityA, entityB });
            });
          }
        });

        return intersections;
      },
      getBodyTransform(realmId, bodyId) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) return null;
        const pos = body.translation();
        const rot = body.rotation();
        const result = {
          position: [pos.x, pos.y, pos.z] as [number, number, number],
          rotation: [rot.x, rot.y, rot.z, rot.w] as [number, number, number, number],
        };
        // Free RawVector/RawRotation to prevent WASM borrow aliasing
        try { (pos as any).free?.(); } catch {}
        try { (rot as any).free?.(); } catch {}
        return result;
      },
      raycast(realmId, origin, direction, maxDistance, filter) {
        const world = realms.get(realmId);
        if (!world) return null;
        const ray = new rapier.Ray(
          { x: origin[0], y: origin[1], z: origin[2] },
          { x: direction[0], y: direction[1], z: direction[2] },
        );
        const hit = world.castRay(ray, maxDistance, true, undefined, undefined, undefined, undefined);
        if (!hit || !hit.collider) return null;
        const collider = hit.collider;
        const body = collider.parent();
        if (!body) return null;
        const entity = (body as any).__entity as Entity | undefined;
        const point = ray.pointAt(hit.timeOfImpact);
        const result = {
          entity: entity ?? { index: 0, generation: 0 },
          point: [point.x, point.y, point.z] as [number, number, number],
          normal: [0, 1, 0] as [number, number, number],
          distance: hit.timeOfImpact,
        };
        try { (point as any).free?.(); } catch {}
        return result;
      },
      raycastMulti(realmId, origin, direction, maxDistance, filter) {
        const world = realms.get(realmId);
        if (!world) return [];
        const ray = new rapier.Ray(
          { x: origin[0], y: origin[1], z: origin[2] },
          { x: direction[0], y: direction[1], z: direction[2] },
        );
        const hit = world.castRayAndGetNormal(ray, maxDistance, true);
        if (!hit) return [];
        const body = hit.collider.parent();
        if (!body) return [];
        const entity = (body as any).__entity as Entity | undefined;
        const point = ray.pointAt(hit.timeOfImpact);
        const result = [{
          entity: entity ?? { index: 0, generation: 0 },
          point: [point.x, point.y, point.z] as [number, number, number],
          normal: [hit.normal?.x ?? 0, hit.normal?.y ?? 1, hit.normal?.z ?? 0] as [number, number, number],
          distance: hit.timeOfImpact,
        }];
        try { (point as any).free?.(); } catch {}
        return result;
      },
      shapeCast(realmId, shape, origin, rotation, direction, maxDistance, filter) {
        const world = realms.get(realmId);
        if (!world) return null;
        let rapierShape: Rapier.Shape;
        if (shape.type === "sphere") {
          rapierShape = new rapier.Ball(shape.radius);
        } else if (shape.type === "box") {
          rapierShape = new rapier.Cuboid(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]);
        } else if (shape.type === "capsule") {
          rapierShape = new rapier.Capsule(shape.halfHeight, shape.radius);
        } else {
          rapierShape = new rapier.Ball(0.5);
        }
        const rot = { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] };
        const pos = { x: origin[0], y: origin[1], z: origin[2] };
        const dir = { x: direction[0], y: direction[1], z: direction[2] };
        const hit = world.castShape(pos, rot, { x: 0, y: 0, z: 0 }, rapierShape, maxDistance, maxDistance, true);
        if (!hit || !hit.collider) return null;
        const body = hit.collider.parent();
        if (!body) return null;
        const entity = (body as any).__entity as Entity | undefined;
        const toi = hit.time_of_impact;
        return {
          entity: entity ?? { index: 0, generation: 0 },
          point: [pos.x + dir.x * toi, pos.y + dir.y * toi, pos.z + dir.z * toi],
          normal: [0, 1, 0],
          distance: toi,
          hitFraction: toi,
        };
      },
      createCharacterController(realmId, desc, handle) {
        const world = realms.get(realmId);
        if (!world) return;
        // Rapier's controller offset is the artificial gap (padding) between the
        // character's collider and its environment — a small value (e.g. 0.01),
        // NOT the capsule half-height. Adding halfHeight here inflated the
        // collision shape by ~0.5m, freezing the player against nearby colliders
        // (e.g. the ship deck the moment they disembarked).
        const controller = world.createCharacterController(desc.offset[1]);
        controller.setSlideEnabled(desc.slide);
        if (desc.autostep.enabled) {
          controller.enableAutostep(desc.autostep.maxHeight, desc.autostep.minWidth, true);
        } else {
          controller.disableAutostep();
        }
        controller.setMaxSlopeClimbAngle(desc.maxSlope);
        controller.setMinSlopeSlideAngle(desc.minSlopeSlide);
        controller.setApplyImpulsesToDynamicBodies(desc.applyImpulsesToDynamicBodies);
        if (desc.snapToGround > 0) {
          controller.enableSnapToGround(desc.snapToGround);
        } else {
          controller.disableSnapToGround();
        }

        const controllerId = handle.controllerId;

        if (desc.parentless) {
          // Create a parentless capsule collider (no rigid body)
          const capsuleCd = rapier.ColliderDesc.capsule(desc.halfHeight, desc.radius);
          capsuleCd.setTranslation(
            desc.parentless.position[0],
            desc.parentless.position[1],
            desc.parentless.position[2],
          );
          if (desc.parentless.collisionGroups !== undefined) {
            capsuleCd.setCollisionGroups(desc.parentless.collisionGroups);
          } else if (desc.collisionGroups !== undefined) {
            capsuleCd.setCollisionGroups(desc.collisionGroups);
          }
          const collider = world.createCollider(capsuleCd);
          // Free the RawColliderShape (createCollider clones the SharedShape)
          try { (capsuleCd as any).shape?.free?.(); } catch {}
          controllerMaps.get(realmId)?.set(controllerId, { controller, body: null, collider, entity: handle.entity });
        } else {
          const bodyMap = bodyMaps.get(realmId);
          const body = bodyMap?.get(handle.entity.index);
          if (!body) return;
          controllerMaps.get(realmId)?.set(controllerId, { controller, body, collider: null, entity: handle.entity });
        }
      },
      destroyCharacterController(realmId, controllerId) {
        const world = realms.get(realmId);
        const entry = controllerMaps.get(realmId)?.get(controllerId);
        if (!world || !entry) return;
        if (entry.collider) {
          try { world.removeCollider(entry.collider, true); } catch {}
        }
        world.removeCharacterController(entry.controller);
        controllerMaps.get(realmId)?.delete(controllerId);
      },
      setCharacterColliderPosition(realmId, controllerId, pos) {
        const entry = controllerMaps.get(realmId)?.get(controllerId);
        if (entry && entry.collider) {
          entry.collider.setTranslation({ x: pos[0], y: pos[1], z: pos[2] });
        }
      },
      characterMove(realmId, controllerId, desiredMovement, dt) {
        const world = realms.get(realmId);
        const entry = controllerMaps.get(realmId)?.get(controllerId);
        if (!world || !entry) {
          return {
            grounded: false,
            groundNormal: [0, 1, 0],
            groundEntity: null,
            slid: false,
            stepped: false,
            effectiveMovement: [0, 0, 0], collisions: [],
          };
        }
        const { controller, body, collider: parentlessCollider, entity } = entry;
        const desiredDelta = { x: desiredMovement[0], y: desiredMovement[1], z: desiredMovement[2] };
        const collider = parentlessCollider ?? (body ? body.collider(0) : null);
        if (!collider) {
          return {
            grounded: false,
            groundNormal: [0, 1, 0],
            groundEntity: null,
            slid: false,
            stepped: false,
            effectiveMovement: [0, 0, 0],
            collisions: [],
          };
        }
        controller.computeColliderMovement(collider, desiredDelta);

        const grounded = controller.computedGrounded();
        const effective = controller.computedMovement();
        const slid = false;
        const stepped = false;

        // Harvest collision details for debug/logging. Resolve each hit
        // collider's parent rigid body back to its Entity via the reverse
        // handle map populated in createBody.
        const collisions: CharacterCollisionInfo[] = [];
        let groundEntity: Entity | null = null;
        const handleMap = entityByBodyHandle.get(realmId);
        const numCollisions = controller.numComputedCollisions();
        for (let i = 0; i < numCollisions; i++) {
          const collision = controller.computedCollision(i);
          if (!collision) continue;
          const hitCollider = collision.collider;
          if (!hitCollider) continue;
          const parentRb = hitCollider.parent();
          let hitEntity: Entity | null = null;
          if (parentRb) {
            hitEntity = handleMap?.get(parentRb.handle) ?? null;
          }
          collisions.push({ entity: hitEntity });
          // First resolved entity becomes the ground entity when grounded
          if (grounded && !groundEntity && hitEntity) {
            groundEntity = hitEntity;
          }
        }

        const result = {
          grounded,
          groundNormal: [0, 1, 0] as [number, number, number],
          groundEntity,
          slid,
          stepped,
          effectiveMovement: [effective.x, effective.y, effective.z] as [number, number, number],
          collisions,
        };
        // Free the RawVector from computedMovement to prevent WASM borrow aliasing
        try { (effective as any).free?.(); } catch {}
        return result;
      },
      createJoint(realmId, parentBodyId, childBodyId, jointId, desc) {
        const world = realms.get(realmId);
        const parentBody = bodyMaps.get(realmId)?.get(parentBodyId);
        const childBody = bodyMaps.get(realmId)?.get(childBodyId);
        if (!world || !parentBody || !childBody) return;

        let jointData: Rapier.JointData;
        const anchorA = { x: desc.anchorA[0], y: desc.anchorA[1], z: desc.anchorA[2] };
        const anchorB = { x: desc.anchorB[0], y: desc.anchorB[1], z: desc.anchorB[2] };

        if (desc.type === "cone-twist") {
          const axis = desc.axis ?? [0, 1, 0];
          jointData = rapier.JointData.spherical(anchorA, anchorB);
        } else if (desc.type === "fixed") {
          jointData = rapier.JointData.fixed(anchorA, { x: 0, y: 0, z: 0, w: 1 }, anchorB, { x: 0, y: 0, z: 0, w: 1 });
        } else if (desc.type === "revolute") {
          const axis = desc.axis ?? [0, 1, 0];
          jointData = rapier.JointData.revolute(anchorA, anchorB, { x: axis[0], y: axis[1], z: axis[2] });
        } else {
          const axis = desc.axis ?? [0, 1, 0];
          const limits = desc.limits ?? { min: 0, max: 1 };
          jointData = rapier.JointData.prismatic(anchorA, anchorB, { x: axis[0], y: axis[1], z: axis[2] });
        }

        const joint = world.createImpulseJoint(jointData, parentBody, childBody, true);
        jointMaps.get(realmId)?.set(jointId, joint);
      },
      destroyJoint(realmId, jointId) {
        const world = realms.get(realmId);
        const joint = jointMaps.get(realmId)?.get(jointId);
        if (!world || !joint) return;
        world.removeImpulseJoint(joint, true);
        jointMaps.get(realmId)?.delete(jointId);
      },
      setSolverIterations(realmId, iterations) {
        const world = realms.get(realmId);
        if (world) world.integrationParameters.numSolverIterations = iterations;
      },
      setMinIslandSize(realmId, size) {
        const world = realms.get(realmId);
        if (world) world.integrationParameters.minIslandSize = size;
      },
      setSleepThresholds(realmId, linearThreshold, angularThreshold) {
        const world = realms.get(realmId);
        if (!world) return;
        // Rapier 0.19.x doesn't expose normalizedLinearThreshold/normalizedAngularThreshold.
        // Sleep is automatic based on internal velocity thresholds + the canSleep flag.
        // We set the available integration parameters that affect settling behavior.
        try {
          const ip = world.integrationParameters;
          // These don't exist in 0.19.3 but may in future versions — try first.
          (ip as any).normalizedLinearThreshold = linearThreshold;
          (ip as any).normalizedAngularThreshold = angularThreshold;
        } catch {
          // Silently skip — sleep is controlled by canSleep + damping in 0.19.x
        }
      },
      setCCDEnabled(realmId, bodyId, enabled) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.enableCcd(enabled);
      },
      getIslands(realmId) {
        const world = realms.get(realmId);
        const map = bodyMaps.get(realmId);
        if (!world || !map) return [];
        // Rapier 0.19.x doesn't expose a direct island API from JS.
        // Group bodies by their island: use the body's island number if available,
        // otherwise each body is its own island. Sleeping bodies form one island.
        const islands = new Map<number, number[]>();
        for (const [bodyId, body] of map) {
          let islandId: number;
          try {
            islandId = (body as any).island ?? bodyId;
          } catch {
            islandId = bodyId;
          }
          let arr = islands.get(islandId);
          if (!arr) { arr = []; islands.set(islandId, arr); }
          arr.push(bodyId);
        }
        const result: IslandInfo[] = [];
        for (const bodyIds of islands.values()) {
          let totalSpeed = 0;
          for (const bid of bodyIds) {
            const b = map.get(bid);
            if (b) {
              const lv = b.linvel();
              totalSpeed += Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z);
            }
          }
          result.push({
            bodyIds,
            maxImportance: 0,
            avgVelocity: bodyIds.length > 0 ? totalSpeed / bodyIds.length : 0,
          });
        }
        return result;
      },
      serializeRealm(realmId) {
        const world = realms.get(realmId);
        if (!world) return new Uint8Array(0);
        try {
          return world.takeSnapshot();
        } catch {
          return new Uint8Array(0);
        }
      },
      deserializeRealm(realmId, data) {
        // Rapier 0.19.x: create a world from snapshot. The world must be re-created.
        try {
          const world = rapier.World.restoreSnapshot(data);
          realms.set(realmId, world);
        } catch {
          // Snapshot restore may fail on incompatible versions — skip silently
        }
      },

      // --- Raw fast paths (scalar methods, zero JS object alloc) ---
      // NOTE: bodyId here is the game's PhysicsBody.id, NOT the Rapier handle.
      // We must look up the Rapier RigidBody from bodyMaps to get body.handle.

      setTranslationRaw(realmId, bodyId, x, y, z, wakeUp) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) return;
        const rawBodies = realms.get(realmId)?.bodies.raw;
        if (rawBodies) {
          rawBodies.rbSetTranslation(body.handle, x, y, z, wakeUp);
        } else {
          body.setTranslation({ x, y, z }, wakeUp);
        }
      },
      setRotationRaw(realmId, bodyId, x, y, z, w, wakeUp) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) return;
        const rawBodies = realms.get(realmId)?.bodies.raw;
        if (rawBodies) {
          rawBodies.rbSetRotation(body.handle, x, y, z, w, wakeUp);
        } else {
          body.setRotation({ x, y, z, w }, wakeUp);
        }
      },
      getTranslationRaw(realmId, bodyId, out) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
        const rawBodies = realms.get(realmId)?.bodies.raw;
        if (rawBodies) {
          const v = rawBodies.rbTranslation(body.handle);
          out[0] = v.x; out[1] = v.y; out[2] = v.z;
          v.free();
        } else {
          const t = body.translation();
          out[0] = t.x; out[1] = t.y; out[2] = t.z;
          try { (t as any).free?.(); } catch {}
        }
      },
      getRotationRaw(realmId, bodyId, out) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return; }
        const rawBodies = realms.get(realmId)?.bodies.raw;
        if (rawBodies) {
          const r = rawBodies.rbRotation(body.handle);
          out[0] = r.x; out[1] = r.y; out[2] = r.z; out[3] = r.w;
          r.free();
        } else {
          const r = body.rotation();
          out[0] = r.x; out[1] = r.y; out[2] = r.z; out[3] = r.w;
          try { (r as any).free?.(); } catch {}
        }
      },
      getLinearVelocityRaw(realmId, bodyId, out) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
        const rawBodies = realms.get(realmId)?.bodies.raw;
        if (rawBodies) {
          const v = rawBodies.rbLinvel(body.handle);
          out[0] = v.x; out[1] = v.y; out[2] = v.z;
          v.free();
        } else {
          const v = body.linvel();
          out[0] = v.x; out[1] = v.y; out[2] = v.z;
          try { (v as any).free?.(); } catch {}
        }
      },
      setLinearVelocityRaw(realmId, bodyId, x, y, z, wakeUp) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.setLinvel({ x, y, z }, wakeUp);
      },
      setAngularVelocityRaw(realmId, bodyId, x, y, z, wakeUp) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (body) body.setAngvel({ x, y, z }, wakeUp);
      },
      isSleepingRaw(realmId, bodyId) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) return false;
        const rawBodies = realms.get(realmId)?.bodies.raw;
        if (rawBodies) {
          return rawBodies.rbIsSleeping(body.handle);
        }
        return body.isSleeping();
      },
      readAwakeBodyStates(realmId, idsOut, out, maxCount) {
        const world = realms.get(realmId);
        const handleMap = bodyIdByHandle.get(realmId);
        const rawBodies = world?.bodies.raw;
        if (!world || !handleMap || !rawBodies) return 0;

        // Phase 1: enumerate awake handles in ONE wasm call. The JS callback
        // only stores integers — no reentrant wasm calls inside the iteration.
        let count = 0;
        world.islands.raw.forEachActiveRigidBodyHandle((handle: number) => {
          if (count < awakeHandleScratch.length) {
            awakeHandleScratch[count] = handle;
          }
          count++;
        });
        if (count > awakeHandleScratch.length) {
          awakeHandleScratch = new Float64Array(count * 2);
          count = 0;
          world.islands.raw.forEachActiveRigidBodyHandle((handle: number) => {
            awakeHandleScratch[count++] = handle;
          });
        }

        // Phase 2: raw scalar reads per awake body. Each rb* call allocates a
        // RawVector/RawRotation in the wasm heap — free() it immediately.
        let written = 0;
        for (let i = 0; i < count && written < maxCount; i++) {
          const handle = awakeHandleScratch[i];
          const bodyId = handleMap.get(handle);
          if (bodyId === undefined) continue;
          const o = written * 10;
          const v = rawBodies.rbTranslation(handle);
          out[o] = v.x; out[o + 1] = v.y; out[o + 2] = v.z;
          v.free();
          const r = rawBodies.rbRotation(handle);
          out[o + 3] = r.x; out[o + 4] = r.y; out[o + 5] = r.z; out[o + 6] = r.w;
          r.free();
          const l = rawBodies.rbLinvel(handle);
          out[o + 7] = l.x; out[o + 8] = l.y; out[o + 9] = l.z;
          l.free();
          idsOut[written] = bodyId;
          written++;
        }
        return written;
      },
      swapColliderShapeRaw(realmId, colliderId, vertices, indices) {
        const world = realms.get(realmId);
        const rawColliders = world?.colliders.raw;
        if (!world || !rawColliders) return false;
        // colliderId is the game's sequential id — look up the Rapier collider
        // to get its handle. Passing colliderId directly to coSetShape causes
        // out-of-bounds WASM access (corrupts internal state, aliasing panic).
        const collider = colliderMaps.get(realmId)?.get(colliderId);
        if (!collider) return false;
        try {
          const cd = rapier.ColliderDesc.trimesh(vertices, indices);
          // cd.shape is a SharedShape (Eg); coSetShape expects a RawShape (OA).
          // Call intoRaw() to get the RawColliderShape, then free it after.
          const rawShape = (cd as any).shape.intoRaw();
          rawColliders.coSetShape(collider.handle, rawShape);
          rawShape.free();
          return true;
        } catch {
          return false;
        }
      },
      reserveMemory(bytes) {
        try { (rapier as any).reserveMemory(bytes); } catch {}
      },
      testConvexHull(vertices) {
        try {
          return rapier.ColliderDesc.convexHull(vertices) != null;
        } catch {
          return false;
        }
      },
      getColliderShapeType(realmId, colliderId) {
        const collider = colliderMaps.get(realmId)?.get(colliderId);
        if (!collider) return -1;
        return collider.shapeType();
      },
      getColliderCount(realmId, bodyId) {
        const body = bodyMaps.get(realmId)?.get(bodyId);
        if (!body) return -1;
        let count = 0;
        const map = colliderMaps.get(realmId);
        if (map) {
          for (const collider of map.values()) {
            if (collider.parent() === body) count++;
          }
        }
        return count;
      },
      setIntegrationDt(realmId, dt) {
        const world = realms.get(realmId);
        if (world) world.integrationParameters.dt = dt;
      },

      destroy() {
        realms.clear();
        bodyMaps.clear();
        colliderMaps.clear();
        controllerMaps.clear();
        jointMaps.clear();
        entityByBodyHandle.clear();
        bodyIdByHandle.clear();
      },
    };

    cachedLib = lib;
    return lib;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("physics-rapier", `Failed to load WASM Rapier: ${msg}`);
    throw new Error(`Rapier WASM initialization failed: ${msg}`);
  }
}
