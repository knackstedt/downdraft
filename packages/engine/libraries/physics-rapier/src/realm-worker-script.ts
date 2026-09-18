/// <reference lib="webworker" />
/**
 * Realm worker script — runs inside a Web Worker (nested within the sim
 * worker or the main thread). Owns one or more Rapier `World` instances
 * for mid/far realm simulation.
 *
 * Messages follow the `RealmWorkerRequest`/`RealmWorkerResponse` protocol.
 */
import type * as Rapier from "@dimforge/rapier3d-compat";
import type { ColliderDesc } from "@downdraft/engine";
import { RealmTier } from "@downdraft/engine";
import type { RealmWorkerMessage, RealmWorkerRequest, RealmWorkerResponse } from "@downdraft/engine/physics/worker-protocol";

let rapier: typeof import("@dimforge/rapier3d-compat") | null = null;

interface WorkerRealm {
  id: number;
  tier: RealmTier;
  world: Rapier.World;
  bodies: Map<number, Rapier.RigidBody>;
  colliders: Map<number, Rapier.Collider>;
  nextColliderId: number;
}

const realms = new Map<number, WorkerRealm>();

async function ensureRapier(): Promise<typeof import("@dimforge/rapier3d-compat")> {
  if (rapier) return rapier;
  rapier = await import("@dimforge/rapier3d-compat");
  await rapier.init();
  return rapier;
}

function makeColliderDesc(rapier: typeof import("@dimforge/rapier3d-compat"), desc: ColliderDesc): Rapier.ColliderDesc {
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

async function handleRequest(req: RealmWorkerRequest): Promise<RealmWorkerResponse> {
  const r = await ensureRapier();

  switch (req.type) {
    case "INIT_REALM": {
      const world = new r.World({ x: req.gravity[0], y: req.gravity[1], z: req.gravity[2] });
      const realm: WorkerRealm = {
        id: req.realmId,
        tier: req.tier,
        world,
        bodies: new Map(),
        colliders: new Map(),
        nextColliderId: 1,
      };
      realms.set(req.realmId, realm);
      return { type: "STEP_RESULT", realmId: req.realmId, wallTimeMs: 0 };
    }

    case "DESTROY_REALM": {
      const realm = realms.get(req.realmId);
      if (realm) {
        realm.bodies.clear();
        realm.colliders.clear();
        realms.delete(req.realmId);
      }
      return { type: "DESTROY_BODY_RESULT", realmId: req.realmId, bodyId: -1 };
    }

    case "DESTROY_ALL": {
      realms.clear();
      return { type: "STEP_RESULT", realmId: -1, wallTimeMs: 0 };
    }

    case "STEP_REALM": {
      const realm = realms.get(req.realmId);
      if (!realm) return { type: "ERROR", message: `Realm ${req.realmId} not found`, realmId: req.realmId };
      realm.world.integrationParameters.numSolverIterations = req.solverIterations;
      const start = performance.now();
      realm.world.step();
      const wallMs = performance.now() - start;
      return { type: "STEP_RESULT", realmId: req.realmId, wallTimeMs: wallMs };
    }

    case "CREATE_BODY": {
      const realm = realms.get(req.realmId);
      if (!realm) return { type: "CREATE_BODY_RESULT", realmId: req.realmId, bodyId: req.bodyId, success: false };
      let rbDesc: Rapier.RigidBodyDesc;
      if (req.desc.type === "static") {
        rbDesc = r.RigidBodyDesc.fixed();
      } else if (req.desc.type === "kinematic") {
        rbDesc = r.RigidBodyDesc.kinematicPositionBased();
      } else {
        rbDesc = r.RigidBodyDesc.dynamic();
      }
      rbDesc.setTranslation(req.desc.position[0], req.desc.position[1], req.desc.position[2]);
      rbDesc.setRotation({
        x: req.desc.rotation[0], y: req.desc.rotation[1],
        z: req.desc.rotation[2], w: req.desc.rotation[3],
      });
      if (req.desc.mass) rbDesc.setAdditionalMass(req.desc.mass);
      if (req.desc.linearDamping) rbDesc.setLinearDamping(req.desc.linearDamping);
      if (req.desc.angularDamping) rbDesc.setAngularDamping(req.desc.angularDamping);
      if (req.desc.ccdEnabled) rbDesc.setCcdEnabled(true);
      if (req.desc.canSleep === false) rbDesc.setCanSleep(false);
      if (req.desc.gravityScale !== undefined) rbDesc.setGravityScale(req.desc.gravityScale);
      const body = realm.world.createRigidBody(rbDesc);
      realm.bodies.set(req.bodyId, body);
      return { type: "CREATE_BODY_RESULT", realmId: req.realmId, bodyId: req.bodyId, success: true };
    }

    case "DESTROY_BODY": {
      const realm = realms.get(req.realmId);
      if (!realm) return { type: "DESTROY_BODY_RESULT", realmId: req.realmId, bodyId: req.bodyId };
      const body = realm.bodies.get(req.bodyId);
      if (body) {
        realm.world.removeRigidBody(body);
        realm.bodies.delete(req.bodyId);
      }
      return { type: "DESTROY_BODY_RESULT", realmId: req.realmId, bodyId: req.bodyId };
    }

    case "ADD_COLLIDER": {
      const realm = realms.get(req.realmId);
      if (!realm) return { type: "ADD_COLLIDER_RESULT", realmId: req.realmId, colliderId: req.colliderId, success: false };
      const body = realm.bodies.get(req.bodyId);
      if (!body) return { type: "ADD_COLLIDER_RESULT", realmId: req.realmId, colliderId: req.colliderId, success: false };
      const cd = makeColliderDesc(r, req.desc);
      const collider = realm.world.createCollider(cd, body);
      realm.colliders.set(req.colliderId, collider);
      return { type: "ADD_COLLIDER_RESULT", realmId: req.realmId, colliderId: req.colliderId, success: true };
    }

    case "READ_TRANSFORMS": {
      const realm = realms.get(req.realmId);
      if (!realm) return { type: "READ_TRANSFORMS_RESULT", realmId: req.realmId, buffer: req.buffer };
      const buf = req.buffer;
      // Bulk read: iterate all bodies, write pos+rot into buffer by bodyId slot
      // The buffer is indexed by entity slot (bodyId × 8)
      for (const [bodyId, body] of realm.bodies) {
        const offset = bodyId * 8;
        if (offset + 7 >= buf.length) continue;
        const pos = body.translation();
        const rot = body.rotation();
        buf[offset] = pos.x;
        buf[offset + 1] = pos.y;
        buf[offset + 2] = pos.z;
        buf[offset + 3] = rot.x;
        buf[offset + 4] = rot.y;
        buf[offset + 5] = rot.z;
        buf[offset + 6] = rot.w;
        // Free WASM borrows to avoid aliasing panics during world.step()
        try { (pos as any).free?.(); } catch {}
        try { (rot as any).free?.(); } catch {}
      }
      return { type: "READ_TRANSFORMS_RESULT", realmId: req.realmId, buffer: buf };
    }

    case "SNAPSHOT_REALM": {
      const realm = realms.get(req.realmId);
      if (!realm) return { type: "SNAPSHOT_RESULT", realmId: req.realmId, data: new Uint8Array(0) };
      try {
        const data = realm.world.takeSnapshot();
        return { type: "SNAPSHOT_RESULT", realmId: req.realmId, data };
      } catch {
        return { type: "SNAPSHOT_RESULT", realmId: req.realmId, data: new Uint8Array(0) };
      }
    }

    case "RESTORE_REALM": {
      try {
        const world = r.World.restoreSnapshot(req.data);
        const existing = realms.get(req.realmId);
        if (existing) {
          existing.bodies.clear();
          existing.colliders.clear();
        }
        realms.set(req.realmId, {
          id: req.realmId,
          tier: existing?.tier ?? RealmTier.Mid,
          world,
          bodies: new Map(),
          colliders: new Map(),
          nextColliderId: 1,
        });
        return { type: "RESTORE_REALM_RESULT", realmId: req.realmId, success: true };
      } catch {
        return { type: "RESTORE_REALM_RESULT", realmId: req.realmId, success: false };
      }
    }

    default: {
      return { type: "ERROR", message: `Unknown request type: ${(req as any).type}` };
    }
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as RealmWorkerMessage & { requestId?: number };
  if ("requestId" in msg && msg.requestId !== undefined) {
    try {
      const resp = await handleRequest(msg as RealmWorkerRequest);
      (resp as any).requestId = msg.requestId;
      const transfer: Transferable[] = [];
      if (resp.type === "READ_TRANSFORMS_RESULT" && resp.buffer) {
        transfer.push(resp.buffer.buffer);
      }
      if (resp.type === "SNAPSHOT_RESULT" && resp.data) {
        transfer.push(resp.data.buffer);
      }
      (self as any).postMessage(resp, transfer);
    } catch (err) {
      const errorResp: RealmWorkerResponse = { type: "ERROR", message: String(err) };
      (errorResp as any).requestId = msg.requestId;
      (self as any).postMessage(errorResp);
    }
  }
};

export { };

