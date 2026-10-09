import type { BodyDesc, ColliderDesc, Entity, PhysicsRealmConfig, RealmTierConfig } from "@downdraft/engine";
import { RealmTier } from "@downdraft/engine";
import { RapierPhysicsBackend } from "@downdraft/engine/libraries/physics-rapier";
import { beforeEach, describe, expect, it } from "bun:test";


const TIER_CONFIG: RealmTierConfig = {
  tickFrequency: 1,
  solverIterations: 4,
  promoteThreshold: 0,
  demoteThreshold: 0,
  demoteDwellTime: 0,
};

function realmConfig(overrides: Partial<PhysicsRealmConfig> = {}): PhysicsRealmConfig {
  // No `id` default — the backend auto-assigns (starting at 1) when the
  // field is absent. Callers wanting a specific realm pass `id` explicitly.
  return {
    name: "test",
    tier: RealmTier.Near,
    gravity: [0, -9.81, 0],
    tierConfig: TIER_CONFIG,
    ...overrides,
  } as PhysicsRealmConfig;
}

// ============================================================================
// Helper: Create a simple entity
// ============================================================================

function makeEntity(index: number): Entity {
  return { index, generation: 0 };
}

function makeDynamicBody(pos: [number, number, number] = [0, 0, 0]): BodyDesc {
  return {
    type: "dynamic",
    position: pos,
    rotation: [0, 0, 0, 1],
    mass: 1.0,
  };
}

function makeStaticBody(pos: [number, number, number] = [0, 0, 0]): BodyDesc {
  return {
    type: "static",
    position: pos,
    rotation: [0, 0, 0, 1],
  };
}

function makeSphereCollider(radius: number = 0.5): ColliderDesc {
  return { shape: { type: "sphere", radius }, friction: 0.5, restitution: 0.3 };
}

function makeBoxCollider(halfExtents: [number, number, number] = [0.5, 0.5, 0.5]): ColliderDesc {
  return { shape: { type: "box", halfExtents }, friction: 0.5, restitution: 0.3 };
}

// ============================================================================
// RapierPhysicsBackend Tests (JS fallback mode — no native lib loaded)
// ============================================================================

describe("RapierPhysicsBackend", () => {
  let physics: RapierPhysicsBackend;

  beforeEach(() => {
    physics = new RapierPhysicsBackend();
    // Don't call init() so we use the JS fallback path
  });

  describe("Realm Management", () => {
    it("should create a realm and return its ID", () => {
      const config: PhysicsRealmConfig = realmConfig({ id: 1 });
      const id = physics.createRealm(config);
      expect(id).toBe(1);
      expect(physics.getRealmIds()).toContain(1);
    });

    it("should auto-assign realm ID when not provided", () => {
      const id = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
      expect(id).toBe(1);
    });

    it("should create multiple realms with auto-incrementing IDs", () => {
      const id1 = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
      const id2 = physics.createRealm(realmConfig({gravity: [0, -20, 0] }));
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });

    it("should destroy a realm", () => {
      physics.createRealm(realmConfig({id: 5, gravity: [0, -9.81, 0] }));
      physics.destroyRealm(5);
      expect(physics.getRealmIds()).not.toContain(5);
    });

    it("should handle destroying non-existent realm gracefully", () => {
      expect(() => physics.destroyRealm(999)).not.toThrow();
    });
  });

  describe("Body Management", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should create a body and return a handle", () => {
      const handle = physics.createBody(realmId, makeDynamicBody([0, 10, 0]), makeEntity(0));
      expect(handle.realmId).toBe(realmId);
      expect(handle.id).toBe(1);
      expect(handle.entity.index).toBe(0);
    });

    it("should create multiple bodies with incrementing IDs", () => {
      const h1 = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      const h2 = physics.createBody(realmId, makeDynamicBody(), makeEntity(1));
      expect(h1.id).toBe(1);
      expect(h2.id).toBe(2);
    });

    it("should destroy a body", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.destroyBody(handle);
      expect(physics.getPosition(handle)).toEqual([0, 0, 0]);
    });

    it("should set body type", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.setBodyType(handle, "static");
      // No error means success
    });

    it("should throw when creating body in non-existent realm", () => {
      expect(() => physics.createBody(999, makeDynamicBody(), makeEntity(0))).toThrow();
    });
  });

  describe("Position & Rotation", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should return initial position", () => {
      const handle = physics.createBody(realmId, makeDynamicBody([5, 10, 15]), makeEntity(0));
      expect(physics.getPosition(handle)).toEqual([5, 10, 15]);
    });

    it("should set and get position", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.setPosition(handle, [1, 2, 3]);
      expect(physics.getPosition(handle)).toEqual([1, 2, 3]);
    });

    it("should return initial rotation", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      expect(physics.getRotation(handle)).toEqual([0, 0, 0, 1]);
    });

    it("should set and get rotation", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.setRotation(handle, [0, 0, 1, 0]);
      expect(physics.getRotation(handle)).toEqual([0, 0, 1, 0]);
    });

    it("should return [0,0,0] for position of non-existent body", () => {
      expect(physics.getPosition({ realmId, id: 999, entity: makeEntity(0) })).toEqual([0, 0, 0]);
    });

    it("should return [0,0,0,1] for rotation of non-existent body", () => {
      expect(physics.getRotation({ realmId, id: 999, entity: makeEntity(0) })).toEqual([0, 0, 0, 1]);
    });
  });

  describe("Velocity", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should return initial linear velocity as [0,0,0]", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      expect(physics.getLinearVelocity(handle)).toEqual([0, 0, 0]);
    });

    it("should set and get linear velocity", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.setLinearVelocity(handle, [1, 2, 3]);
      expect(physics.getLinearVelocity(handle)).toEqual([1, 2, 3]);
    });

    it("should set and get angular velocity", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.setAngularVelocity(handle, [0.5, 1.0, 1.5]);
      expect(physics.getAngularVelocity(handle)).toEqual([0.5, 1.0, 1.5]);
    });
  });

  describe("Forces & Impulses", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should apply impulse to dynamic body", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.applyImpulse(handle, [10, 0, 0]);
      // impulse / mass = 10 / 1 = 10
      expect(physics.getLinearVelocity(handle)[0]).toBeCloseTo(10, 2);
    });

    it("should not apply impulse to fixed body", () => {
      const handle = physics.createBody(realmId, makeStaticBody(), makeEntity(0));
      physics.applyImpulse(handle, [10, 0, 0]);
      expect(physics.getLinearVelocity(handle)).toEqual([0, 0, 0]);
    });

    it("should apply torque impulse", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.applyTorqueImpulse(handle, [1, 2, 3]);
      expect(physics.getAngularVelocity(handle)).toEqual([1, 2, 3]);
    });

    it("should apply impulse at point", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      physics.applyImpulseAtPoint(handle, [5, 0, 0], [0, 1, 0]);
      expect(physics.getLinearVelocity(handle)[0]).toBeCloseTo(5, 2);
    });
  });

  describe("Colliders", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should add a collider and return its ID", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      const colId = physics.addCollider(handle, makeSphereCollider(0.5));
      expect(colId).toBe(1);
    });

    it("should add multiple colliders with incrementing IDs", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      const id1 = physics.addCollider(handle, makeSphereCollider());
      const id2 = physics.addCollider(handle, makeBoxCollider());
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });

    it("should remove a collider", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      const colId = physics.addCollider(handle, makeSphereCollider());
      physics.removeCollider(handle, colId);
      // No error means success
    });
  });

  describe("Sleep Management", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should start awake by default", () => {
      const handle = physics.createBody(realmId, makeDynamicBody(), makeEntity(0));
      expect(physics.isSleeping(handle)).toBe(false);
    });

    it("should start sleeping when specified", () => {
      const handle = physics.createBody(realmId, { ...makeDynamicBody(), sleeping: true }, makeEntity(0));
      expect(physics.isSleeping(handle)).toBe(true);
    });

    it("should wake up a sleeping body", () => {
      const handle = physics.createBody(realmId, { ...makeDynamicBody(), sleeping: true }, makeEntity(0));
      physics.wakeUp(handle);
      expect(physics.isSleeping(handle)).toBe(false);
    });
  });

  describe("Step (JS Fallback)", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should apply gravity during step", () => {
      const handle = physics.createBody(realmId, makeDynamicBody([0, 100, 0]), makeEntity(0));
      physics.step(realmId, 1.0);
      // After 1 second of gravity: vy = -9.81
      expect(physics.getLinearVelocity(handle)[1]).toBeCloseTo(-9.81, 1);
    });

    it("should update position during step", () => {
      const handle = physics.createBody(realmId, makeDynamicBody([0, 100, 0]), makeEntity(0));
      physics.step(realmId, 1.0);
      // After 1 second: y = 100 + 0*1 + 0.5*(-9.81)*1^2 = 100 - 4.905
      // Actually: v = -9.81 after step, position += v * dt
      // The fallback does: v += g*dt, then pos += v*dt
      // So: v = -9.81, pos = 100 + (-9.81) * 1 = 90.19
      expect(physics.getPosition(handle)[1]).toBeCloseTo(90.19, 1);
    });

    it("should not apply gravity to fixed bodies", () => {
      const handle = physics.createBody(realmId, makeStaticBody([0, 100, 0]), makeEntity(0));
      physics.step(realmId, 1.0);
      expect(physics.getLinearVelocity(handle)).toEqual([0, 0, 0]);
      expect(physics.getPosition(handle)).toEqual([0, 100, 0]);
    });

    it("should not update sleeping bodies", () => {
      const handle = physics.createBody(realmId, { ...makeDynamicBody([0, 100, 0]), sleeping: true }, makeEntity(0));
      physics.step(realmId, 1.0);
      expect(physics.getPosition(handle)).toEqual([0, 100, 0]);
    });

    it("should apply linear damping", () => {
      const handle = physics.createBody(realmId, { ...makeDynamicBody(), linearDamping: 1.0 }, makeEntity(0));
      physics.setLinearVelocity(handle, [10, 0, 0]);
      physics.step(realmId, 1.0);
      // dampFactor = max(0, 1 - 1*1) = 0
      expect(physics.getLinearVelocity(handle)[0]).toBeCloseTo(0, 2);
    });

    it("should step all realms", () => {
      const realm1 = physics.createRealm(realmConfig({gravity: [0, -10, 0] }));
      const realm2 = physics.createRealm(realmConfig({gravity: [0, -20, 0] }));
      const h1 = physics.createBody(realm1, makeDynamicBody([0, 100, 0]), makeEntity(0));
      const h2 = physics.createBody(realm2, makeDynamicBody([0, 100, 0]), makeEntity(1));
      physics.stepAll(1.0);
      expect(physics.getLinearVelocity(h1)[1]).toBeCloseTo(-10, 1);
      expect(physics.getLinearVelocity(h2)[1]).toBeCloseTo(-20, 1);
    });
  });

  describe("Raycasting (JS Fallback)", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, 0, 0] }));
    });

    it("should hit a sphere collider", () => {
      const handle = physics.createBody(realmId, makeStaticBody([0, 0, 5]), makeEntity(0));
      physics.addCollider(handle, makeSphereCollider(1.0));
      const hit = physics.raycast(realmId, [0, 0, 0], [0, 0, 1], 100);
      expect(hit).not.toBeNull();
      expect(hit!.distance).toBeCloseTo(4, 1);
      expect(hit!.entity.index).toBe(0);
    });

    it("should return null when no hit", () => {
      const handle = physics.createBody(realmId, makeStaticBody([100, 0, 0]), makeEntity(0));
      physics.addCollider(handle, makeSphereCollider(1.0));
      const hit = physics.raycast(realmId, [0, 0, 0], [0, 0, 1], 10);
      expect(hit).toBeNull();
    });

    it("should exclude entity when filter is provided", () => {
      const handle = physics.createBody(realmId, makeStaticBody([0, 0, 5]), makeEntity(0));
      physics.addCollider(handle, makeSphereCollider(1.0));
      const hit = physics.raycast(realmId, [0, 0, 0], [0, 0, 1], 100, { excludeEntity: makeEntity(0) });
      expect(hit).toBeNull();
    });

    it("should return multiple hits sorted by distance", () => {
      const h1 = physics.createBody(realmId, makeStaticBody([0, 0, 5]), makeEntity(0));
      physics.addCollider(h1, makeSphereCollider(1.0));
      const h2 = physics.createBody(realmId, makeStaticBody([0, 0, 10]), makeEntity(1));
      physics.addCollider(h2, makeSphereCollider(1.0));
      const hits = physics.raycastMulti(realmId, [0, 0, 0], [0, 0, 1], 100);
      expect(hits.length).toBe(2);
      expect(hits[0].distance).toBeLessThan(hits[1].distance);
    });
  });

  describe("Contacts (JS Fallback)", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, 0, 0] }));
    });

    it("should detect contact between overlapping spheres", () => {
      const h1 = physics.createBody(realmId, makeStaticBody([0, 0, 0]), makeEntity(0));
      physics.addCollider(h1, makeSphereCollider(1.0));
      const h2 = physics.createBody(realmId, makeStaticBody([1, 0, 0]), makeEntity(1));
      physics.addCollider(h2, makeSphereCollider(1.0));
      physics.step(realmId, 0.016);
      const contacts = physics.getContacts(realmId);
      expect(contacts.length).toBeGreaterThan(0);
    });

    it("should not detect contact between distant bodies", () => {
      const h1 = physics.createBody(realmId, makeStaticBody([0, 0, 0]), makeEntity(0));
      physics.addCollider(h1, makeSphereCollider(0.5));
      const h2 = physics.createBody(realmId, makeStaticBody([100, 0, 0]), makeEntity(1));
      physics.addCollider(h2, makeSphereCollider(0.5));
      physics.step(realmId, 0.016);
      const contacts = physics.getContacts(realmId);
      expect(contacts.length).toBe(0);
    });
  });

  describe("Transform Sync", () => {
    let realmId: number;

    beforeEach(() => {
      realmId = physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
    });

    it("should read transforms into buffer", () => {
      const handle = physics.createBody(realmId, makeDynamicBody([1, 2, 3]), makeEntity(0));
      const buffer = new Float32Array(8);
      physics.readTransforms(realmId, buffer, 1);
      expect(buffer[0]).toBe(1);
      expect(buffer[1]).toBe(2);
      expect(buffer[2]).toBe(3);
    });

    it("should sync transforms from buffer", () => {
      const handle = physics.createBody(realmId, makeDynamicBody([0, 0, 0]), makeEntity(0));
      const buffer = new Float32Array(8);
      buffer[0] = 10; buffer[1] = 20; buffer[2] = 30;
      buffer[3] = 0; buffer[4] = 0; buffer[5] = 0; buffer[6] = 1;
      physics.syncTransforms(realmId, buffer, 1);
      expect(physics.getPosition(handle)).toEqual([10, 20, 30]);
    });
  });

  describe("Destroy", () => {
    it("should destroy cleanly", () => {
      physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
      expect(() => physics.destroy()).not.toThrow();
    });

    it("should clear realms on destroy", () => {
      physics.createRealm(realmConfig({gravity: [0, -9.81, 0] }));
      physics.destroy();
      expect(physics.getRealmIds().length).toBe(0);
    });

    it("should not double-destroy", () => {
      physics.destroy();
      expect(() => physics.destroy()).not.toThrow();
    });
  });

  describe("Identity", () => {
    it("should have name 'rapier'", () => {
      expect(physics.name).toBe("rapier");
    });

    it("should have version", () => {
      expect(physics.version).toBe("0.2.0");
    });
  });
});
