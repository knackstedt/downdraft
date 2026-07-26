import { createLogger } from "@downdraft/core";
import type { PhysicsLib } from "./ffi.ts";

const log = createLogger();

export async function loadWasmRapier(): Promise<PhysicsLib | null> {
  try {
    const rapier = await import("@dimforge/rapier3d-compat");

    await rapier.init();

    const realms = new Map<number, rapier.World>();
    const bodyMaps = new Map<number, Map<number, rapier.RigidBody>>();

    return {
      createRealm(id, gravity) {
        const world = new rapier.World(gravity);
        realms.set(id, world);
        bodyMaps.set(id, new Map());
      },
      destroyRealm(id) {
        realms.delete(id);
        bodyMaps.delete(id);
      },
      createBody(realmId, bodyId, desc) {
        const world = realms.get(realmId);
        if (!world) return;

        let rbDesc: rapier.RigidBodyDesc;
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
        if (type === "static") body.setBodyType(rapier.RigidBodyType.Fixed);
        else if (type === "kinematic") body.setBodyType(rapier.RigidBodyType.KinematicPositionBased);
        else body.setBodyType(rapier.RigidBodyType.Dynamic);
      },
      addCollider() {},
      removeCollider() {},
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
        if (body) body.wakeUp(true);
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
      raycast() { return null; },
      raycastMulti() { return []; },
      shapeCast() { return null; },
      destroy() {
        realms.clear();
        bodyMaps.clear();
      },
    };
  } catch (err) {
    log.warn("physics-rapier", `WASM Rapier not available: ${err}`);
    return null;
  }
}
