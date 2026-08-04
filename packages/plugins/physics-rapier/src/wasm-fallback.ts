import type * as Rapier from "@dimforge/rapier3d-compat";
import type { ColliderDesc, Entity } from "@downdraft/core";
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
    const controllerMaps = new Map<number, Map<number, { controller: Rapier.KinematicCharacterController; body: Rapier.RigidBody; entity: Entity }>>();
    const jointMaps = new Map<number, Map<number, Rapier.ImpulseJoint>>();

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
      } else {
        cd = rapier.ColliderDesc.ball(0.5);
      }
      if (desc.friction !== undefined) cd.setFriction(desc.friction);
      if (desc.restitution !== undefined) cd.setRestitution(desc.restitution);
      if (desc.density !== undefined) cd.setDensity(desc.density);
      if (desc.sensor) cd.setSensor(true);
      if (desc.collisionGroups !== undefined) cd.setCollisionGroups(desc.collisionGroups);
      if (desc.solverGroups !== undefined) cd.setSolverGroups(desc.solverGroups);
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
      },
      destroyRealm(id) {
        realms.delete(id);
        bodyMaps.delete(id);
        colliderMaps.delete(id);
        controllerMaps.delete(id);
        jointMaps.delete(id);
      },
      createBody(realmId, bodyId, desc) {
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

        const body = world.createRigidBody(rbDesc);
        bodyMaps.get(realmId)?.set(bodyId, body);
      },
      destroyBody(realmId, bodyId) {
        const world = realms.get(realmId);
        const map = bodyMaps.get(realmId);
        if (!world || !map) return;
        const body = map.get(bodyId);
        if (body) {
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
      },
      removeCollider(realmId, bodyId, colliderId) {
        const world = realms.get(realmId);
        const collider = colliderMaps.get(realmId)?.get(colliderId);
        if (!world || !collider) return;
        world.removeCollider(collider, false);
        colliderMaps.get(realmId)?.delete(colliderId);
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
        return {
          position: [pos.x, pos.y, pos.z],
          rotation: [rot.x, rot.y, rot.z, rot.w],
        };
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
        if (desc.snapToGround > 0) {
          controller.enableSnapToGround(desc.snapToGround);
        } else {
          controller.disableSnapToGround();
        }

        const controllerId = handle.controllerId;
        const bodyMap = bodyMaps.get(realmId);
        const body = bodyMap?.get(handle.entity.index);
        if (!body) return;

        controllerMaps.get(realmId)?.set(controllerId, { controller, body, entity: handle.entity });
      },
      destroyCharacterController(realmId, controllerId) {
        const world = realms.get(realmId);
        const entry = controllerMaps.get(realmId)?.get(controllerId);
        if (!world || !entry) return;
        world.removeCharacterController(entry.controller);
        controllerMaps.get(realmId)?.delete(controllerId);
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
            effectiveMovement: [0, 0, 0],
          };
        }
        const { controller, body, entity } = entry;
        const desiredDelta = { x: desiredMovement[0], y: desiredMovement[1], z: desiredMovement[2] };
        const collider = body.collider(0);
        controller.computeColliderMovement(collider, desiredDelta);

        const grounded = controller.computedGrounded();
        const effective = controller.computedMovement();
        const slid = false;
        const stepped = false;

        let groundEntity: Entity | null = null;
        if (grounded) {
          const numCollisions = controller.numComputedCollisions();
          for (let i = 0; i < numCollisions; i++) {
            const collision = controller.computedCollision(i);
            if (collision) {
              break;
            }
          }
        }

        return {
          grounded,
          groundNormal: [0, 1, 0],
          groundEntity,
          slid,
          stepped,
          effectiveMovement: [effective.x, effective.y, effective.z],
        };
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
