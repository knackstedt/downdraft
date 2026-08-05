import type * as Rapier from "@dimforge/rapier3d-compat";
import type { CharacterCollisionInfo, ColliderDesc, Entity, IslandInfo } from "@downdraft/core";
import { createLogger } from "@downdraft/core";
import type { PhysicsLib } from "./ffi";

const log = createLogger();

export async function loadWasmRapier(): Promise<PhysicsLib | null> {
  try {
    const rapier = await import("@dimforge/rapier3d-compat");

    await rapier.init();

    const realms = new Map<number, Rapier.World>();
    const bodyMaps = new Map<number, Map<number, Rapier.RigidBody>>();
    const colliderMaps = new Map<number, Map<number, Rapier.Collider>>();
    const controllerMaps = new Map<number, Map<number, { controller: Rapier.KinematicCharacterController; body: Rapier.RigidBody | null; collider: Rapier.Collider | null; entity: Entity }>>();
    const jointMaps = new Map<number, Map<number, Rapier.ImpulseJoint>>();
    // Reverse map: Rapier rigid-body handle -> Entity, for collision reporting.
    // Populated in createBody, cleared in destroyBody/destroyRealm.
    const entityByBodyHandle = new Map<number, Map<number, Entity>>();

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
      } else if ((shape as any).type === "heightfield") {
        const sh = shape as any;
        const heights = new Float32Array(sh.heights);
        const scale = { x: sh.scale[0], y: sh.scale[1], z: sh.scale[2] };
        cd = rapier.ColliderDesc.heightfield(sh.nrows, sh.ncols, heights, scale);
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

    return {
      createRealm(id, gravity) {
        const world = new rapier.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
        realms.set(id, world);
        bodyMaps.set(id, new Map());
        colliderMaps.set(id, new Map());
        controllerMaps.set(id, new Map());
        jointMaps.set(id, new Map());
        entityByBodyHandle.set(id, new Map());
      },
      destroyRealm(id) {
        realms.delete(id);
        bodyMaps.delete(id);
        colliderMaps.delete(id);
        controllerMaps.delete(id);
        jointMaps.delete(id);
        entityByBodyHandle.delete(id);
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
      },
      destroyBody(realmId, bodyId) {
        const world = realms.get(realmId);
        const map = bodyMaps.get(realmId);
        if (!world || !map) return;
        const body = map.get(bodyId);
        if (body) {
          entityByBodyHandle.get(realmId)?.delete(body.handle);
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
        return {
          entity: entity ?? { index: 0, generation: 0 },
          point: [point.x, point.y, point.z],
          normal: [0, 1, 0],
          distance: hit.timeOfImpact,
        };
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
        return [{
          entity: entity ?? { index: 0, generation: 0 },
          point: [point.x, point.y, point.z],
          normal: [hit.normal?.x ?? 0, hit.normal?.y ?? 1, hit.normal?.z ?? 0],
          distance: hit.timeOfImpact,
        }];
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
        const controller = world.createCharacterController(desc.offset[1] + desc.halfHeight);
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
      setSleepThresholds(realmId, linearThreshold, angularThreshold) {
        const world = realms.get(realmId);
        if (!world) return;
        // Rapier 0.19.x sleep thresholds via integration parameters
        try {
          (world.integrationParameters as any).normalizedLinearThreshold = linearThreshold;
          (world.integrationParameters as any).normalizedAngularThreshold = angularThreshold;
        } catch {
          // Some Rapier versions may not expose these — silently skip
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
          // Free the RawVector to prevent WASM borrow aliasing
          try { (t as any).free?.(); } catch {}
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
          // Free the RawVector to prevent WASM borrow aliasing
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
      },
    };
  } catch (err) {
    log.warn("physics-rapier", `WASM Rapier not available: ${err}`);
    return null;
  }
}
