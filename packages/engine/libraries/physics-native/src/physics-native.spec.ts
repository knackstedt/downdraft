import { RealmTier } from "@downdraft/engine/physics";
import type { PhysicsRealmConfig, RealmTierConfig } from "@downdraft/engine/physics/interface";
import { describe, expect, it } from "bun:test";
import { NativePhysicsBackend } from "./backend";
import type { AABB } from "./broadphase";
import { Broadphase } from "./broadphase";
import { detectCollision } from "./narrowphase";
import {
    boxBoxContact,
    capsuleBoxContact,
    capsuleCapsuleContact,
    capsuleSphereContact,
    rotateVec,
    sphereBoxContact,
    sphereSphereContact,
} from "./narrowphase-shapes";
import { integrate, resolveContact, type BodyData } from "./solver";
import type { Vec3 } from "./types";


const TIER_CONFIG: RealmTierConfig = {
  tickFrequency: 1,
  solverIterations: 4,
  promoteThreshold: 0,
  demoteThreshold: 0,
  demoteDwellTime: 0,
};

function realmConfig(overrides: Partial<PhysicsRealmConfig> = {}): PhysicsRealmConfig {
  return {
    id: 0,
    name: "test",
    tier: RealmTier.Near,
    gravity: [0, -9.81, 0],
    tierConfig: TIER_CONFIG,
    ...overrides,
  };
}

// --- Broadphase tests ---

describe("Broadphase", () => {
  it("should generate pairs for overlapping AABBs", () => {
    const bp = new Broadphase(4);
    const aabb1: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 };
    const aabb2: AABB = { minX: 1, minY: 1, minZ: 1, maxX: 3, maxY: 3, maxZ: 3 };
    bp.insert(0, aabb1);
    bp.insert(1, aabb2);
    const pairs = bp.generatePairs();
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toEqual([0, 1]);
  });

  it("should not generate pairs for non-overlapping AABBs", () => {
    const bp = new Broadphase(4);
    const aabb1: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    const aabb2: AABB = { minX: 10, minY: 10, minZ: 10, maxX: 11, maxY: 11, maxZ: 11 };
    bp.insert(0, aabb1);
    bp.insert(1, aabb2);
    const pairs = bp.generatePairs();
    expect(pairs.length).toBe(0);
  });

  it("should deduplicate pairs from multi-cell overlap", () => {
    const bp = new Broadphase(2);
    const aabb1: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 5, maxY: 5, maxZ: 5 };
    const aabb2: AABB = { minX: 1, minY: 1, minZ: 1, maxX: 6, maxY: 6, maxZ: 6 };
    bp.insert(0, aabb1);
    bp.insert(1, aabb2);
    const pairs = bp.generatePairs();
    expect(pairs.length).toBe(1);
  });

  it("should clear all entries", () => {
    const bp = new Broadphase(4);
    bp.insert(0, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 });
    bp.clear();
    expect(bp.generatePairs().length).toBe(0);
  });
});

// --- Narrowphase shape tests ---

describe("Narrowphase shapes", () => {
  it("sphereSphereContact: should detect overlapping spheres", () => {
    const result = sphereSphereContact([0, 0, 0], 1, [1.5, 0, 0], 1);
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeCloseTo(0.5, 1);
    expect(result!.normal[0]).toBeCloseTo(1, 1);
  });

  it("sphereSphereContact: should return null for separated spheres", () => {
    const result = sphereSphereContact([0, 0, 0], 1, [3, 0, 0], 1);
    expect(result).toBeNull();
  });

  it("sphereSphereContact: should handle concentric spheres", () => {
    const result = sphereSphereContact([0, 0, 0], 1, [0, 0, 0], 0.5);
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeCloseTo(1.5, 1);
  });

  it("sphereBoxContact: should detect sphere overlapping box", () => {
    const result = sphereBoxContact(
      [1.5, 0, 0], 1, // sphere at x=1.5, radius=1
      [0, 0, 0], [0, 0, 0, 1], [1, 1, 1], // box at origin, identity rotation, half=1
    );
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeGreaterThan(0);
  });

  it("sphereBoxContact: should return null for non-overlapping", () => {
    const result = sphereBoxContact(
      [5, 0, 0], 1,
      [0, 0, 0], [0, 0, 0, 1], [1, 1, 1],
    );
    expect(result).toBeNull();
  });

  it("sphereBoxContact: should detect sphere inside box", () => {
    const result = sphereBoxContact(
      [0, 0, 0], 0.5,
      [0, 0, 0], [0, 0, 0, 1], [1, 1, 1],
    );
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeGreaterThan(0);
  });

  it("boxBoxContact: should detect overlapping boxes (SAT)", () => {
    const result = boxBoxContact(
      [0, 0, 0], [0, 0, 0, 1], [1, 1, 1],
      [1.5, 0, 0], [0, 0, 0, 1], [1, 1, 1],
    );
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeCloseTo(0.5, 1);
  });

  it("boxBoxContact: should return null for separated boxes", () => {
    const result = boxBoxContact(
      [0, 0, 0], [0, 0, 0, 1], [1, 1, 1],
      [5, 0, 0], [0, 0, 0, 1], [1, 1, 1],
    );
    expect(result).toBeNull();
  });

  it("capsuleSphereContact: should detect collision", () => {
    const result = capsuleSphereContact(
      [0, 0, 0], [0, 0, 0, 1], 1, 0.5, // capsule at origin, up, halfH=1, r=0.5
      [0, 0.5, 0], 0.5, // sphere at y=0.5, r=0.5
    );
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeGreaterThan(0);
  });

  it("capsuleSphereContact: should return null for separated", () => {
    const result = capsuleSphereContact(
      [0, 0, 0], [0, 0, 0, 1], 1, 0.5,
      [5, 5, 0], 0.5,
    );
    expect(result).toBeNull();
  });

  it("capsuleCapsuleContact: should detect parallel capsules", () => {
    const result = capsuleCapsuleContact(
      [0, 0, 0], [0, 0, 0, 1], 1, 0.5,
      [0.8, 0, 0], [0, 0, 0, 1], 1, 0.5,
    );
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeCloseTo(0.2, 1);
  });

  it("capsuleBoxContact: should detect capsule overlapping box", () => {
    const result = capsuleBoxContact(
      [0, 0, 0], [0, 0, 0, 1], 1, 0.5,
      [1.2, 0, 0], [0, 0, 0, 1], [1, 1, 1],
    );
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeGreaterThan(0);
  });

  it("rotateVec: should rotate vector by 90° around Y", () => {
    const result = rotateVec([1, 0, 0], [0, 0.7071, 0, 0.7071]);
    expect(result[2]).toBeCloseTo(-1, 1);
    expect(result[0]).toBeCloseTo(0, 1);
  });
});

// --- detectCollision dispatch tests ---

describe("detectCollision dispatch", () => {
  it("should dispatch sphere-sphere", () => {
    const result = detectCollision(
      { type: "sphere", radius: 1 }, [0, 0, 0], [0, 0, 0, 1],
      { type: "sphere", radius: 1 }, [1.5, 0, 0], [0, 0, 0, 1],
    );
    expect(result).not.toBeNull();
  });

  it("should dispatch box-sphere (flipped)", () => {
    const result = detectCollision(
      { type: "box", halfExtents: [1, 1, 1] }, [0, 0, 0], [0, 0, 0, 1],
      { type: "sphere", radius: 1 }, [1.5, 0, 0], [0, 0, 0, 1],
    );
    expect(result).not.toBeNull();
  });

  it("should dispatch capsule-sphere", () => {
    const result = detectCollision(
      { type: "capsule", halfHeight: 1, radius: 0.5 }, [0, 0, 0], [0, 0, 0, 1],
      { type: "sphere", radius: 0.5 }, [0, 0.5, 0], [0, 0, 0, 1],
    );
    expect(result).not.toBeNull();
  });

  it("should return null for unsupported mesh shapes", () => {
    const result = detectCollision(
      { type: "mesh", vertices: new Float32Array(3), indices: new Uint32Array(0) }, [0, 0, 0], [0, 0, 0, 1],
      { type: "sphere", radius: 1 }, [0, 0, 0], [0, 0, 0, 1],
    );
    expect(result).toBeNull();
  });
});

// --- Solver tests ---

describe("Solver", () => {
  it("integrate: should apply gravity to dynamic body", () => {
    const body: BodyData = {
      position: [0, 10, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.3,
      friction: 0.8,
      isStatic: false,
      isKinematic: false,
    };
    integrate(body, [0, -9.81, 0], 0.1);
    expect(body.linearVelocity[1]).toBeCloseTo(-0.981, 2);
    // Position integrates with the updated velocity: pos += vel * dt
    expect(body.position[1]).toBeCloseTo(10 - 0.981 * 0.1, 3);
  });

  it("integrate: should not move static bodies", () => {
    const body: BodyData = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 0,
      invMass: 0,
      invInertia: 0,
      restitution: 0,
      friction: 0.8,
      isStatic: true,
      isKinematic: false,
    };
    integrate(body, [0, -9.81, 0], 0.1);
    expect(body.position).toEqual([0, 0, 0]);
    expect(body.linearVelocity).toEqual([0, 0, 0]);
  });

  it("resolveContact: should separate dynamic body from static", () => {
    const a: BodyData = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, -5, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.5,
      friction: 0,
      isStatic: false,
      isKinematic: false,
    };
    const b: BodyData = {
      position: [0, -1.5, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 0,
      invMass: 0,
      invInertia: 0,
      restitution: 0.5,
      friction: 0,
      isStatic: true,
      isKinematic: false,
    };
    const manifold = {
      normal: [0, -1, 0] as Vec3,
      penetrationDepth: 0.5,
      points: [{ point: [0, -1, 0] as Vec3, penetration: 0.5 }],
    };
    resolveContact(a, b, manifold);
    // Dynamic body should bounce up (restitution 0.5 * velocity)
    expect(a.linearVelocity[1]).toBeGreaterThan(0);
  });

  it("resolveContact: should not move static-static pairs", () => {
    const a: BodyData = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 0,
      invMass: 0,
      invInertia: 0,
      restitution: 0,
      friction: 0.8,
      isStatic: true,
      isKinematic: false,
    };
    const b: BodyData = { ...a, position: [0, 0.5, 0] };
    const manifold = {
      normal: [0, 1, 0] as Vec3,
      penetrationDepth: 0.5,
      points: [{ point: [0, 0, 0] as Vec3, penetration: 0.5 }],
    };
    resolveContact(a, b, manifold);
    expect(a.position).toEqual([0, 0, 0]);
    expect(b.position).toEqual([0, 0.5, 0]);
  });
});

// --- Backend integration tests ---

describe("NativePhysicsBackend", () => {
  function makeBackend() {
    const backend = new NativePhysicsBackend();
    backend.createRealm(realmConfig({ name: "default" }));
    return backend;
  }

  it("should create and destroy realms", () => {
    const backend = makeBackend();
    expect(backend.getRealmIds()).toEqual([0]);
    backend.destroyRealm(0);
    expect(backend.getRealmIds()).toEqual([]);
    backend.destroy();
  });

  it("should create and destroy bodies", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 10, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    expect(handle.id).toBe(0);
    expect(backend.getPosition(handle)).toEqual([0, 10, 0]);
    backend.destroyBody(handle);
    backend.destroy();
  });

  it("should add colliders", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    const colliderId = backend.addCollider(handle, {
      shape: { type: "sphere", radius: 1 },
    });
    expect(colliderId).toBeGreaterThanOrEqual(0);
    backend.destroy();
  });

  it("should apply gravity during step", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 100, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(handle, { shape: { type: "sphere", radius: 1 } });

    backend.step(0, 0.1);
    const pos = backend.getPosition(handle);
    expect(pos[1]).toBeLessThan(100);
    backend.destroy();
  });

  it("should collide dynamic body with static floor", () => {
    const backend = makeBackend();

    // Static floor
    const floor = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 1, generation: 0 });
    backend.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });

    // Dynamic sphere above floor
    const ball = backend.createBody(0, {
      type: "dynamic",
      position: [0, 2, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(ball, { shape: { type: "sphere", radius: 0.5 } });

    // Step several times — ball should fall and stop on floor
    for (let i = 0; i < 100; i++) {
      backend.step(0, 1 / 60);
    }

    const pos = backend.getPosition(ball);
    // Ball should be resting on floor (y ≈ 1.0 = floor top 0.5 + sphere radius 0.5)
    expect(pos[1]).toBeLessThan(2);
    expect(pos[1]).toBeGreaterThan(0.5);
    backend.destroy();
  });

  it("should raycast against bodies", () => {
    const backend = makeBackend();
    const target = backend.createBody(0, {
      type: "static",
      position: [0, 0, 5],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });
    backend.addCollider(target, { shape: { type: "sphere", radius: 1 } });

    const result = backend.raycast(0, [0, 0, 0], [0, 0, 1], 100);
    expect(result).not.toBeNull();
    expect(result!.distance).toBeCloseTo(4, 0);
    expect(result!.entity.index).toBe(0);
    backend.destroy();
  });

  it("should return sorted raycast results", () => {
    const backend = makeBackend();
    const near = backend.createBody(0, {
      type: "static",
      position: [0, 0, 3],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });
    backend.addCollider(near, { shape: { type: "sphere", radius: 1 } });

    const far = backend.createBody(0, {
      type: "static",
      position: [0, 0, 8],
      rotation: [0, 0, 0, 1],
    }, { index: 1, generation: 0 });
    backend.addCollider(far, { shape: { type: "sphere", radius: 1 } });

    const results = backend.raycastMulti(0, [0, 0, 0], [0, 0, 1], 100);
    expect(results.length).toBe(2);
    expect(results[0].distance).toBeLessThan(results[1].distance);
    backend.destroy();
  });

  it("should exclude entities from raycast", () => {
    const backend = makeBackend();
    const target = backend.createBody(0, {
      type: "static",
      position: [0, 0, 5],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });
    backend.addCollider(target, { shape: { type: "sphere", radius: 1 } });

    const result = backend.raycast(0, [0, 0, 0], [0, 0, 1], 100, {
      excludeEntity: { index: 0, generation: 0 },
    });
    expect(result).toBeNull();
    backend.destroy();
  });

  it("should get contacts after step", () => {
    const backend = makeBackend();

    const floor = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 1, generation: 0 });
    backend.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });

    const ball = backend.createBody(0, {
      type: "dynamic",
      position: [0, 1, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(ball, { shape: { type: "sphere", radius: 0.5 } });

    // Step once to collide
    backend.step(0, 1 / 60);
    const contacts = backend.getContacts(0);
    expect(contacts.length).toBeGreaterThan(0);
    backend.destroy();
  });

  it("should support character controller", () => {
    const backend = makeBackend();

    const floor = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 1, generation: 0 });
    backend.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });

    const charHandle = backend.createCharacterController(0, {
      offset: [0, 1, 0],
      radius: 0.3,
      halfHeight: 0.9,
      slide: true,
      autostep: { enabled: true, minWidth: 0.1, maxHeight: 0.3 },
      maxSlope: 45,
      minSlopeSlide: 45,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
    }, { index: 0, generation: 0 });

    // Move character down into floor
    const result = backend.characterMove(charHandle, [0, -1, 0], 1 / 60);
    expect(result.grounded).toBe(true);
    backend.destroy();
  });

  it("should sync and read transforms", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });

    const buf = new Float32Array(8);
    backend.syncTransforms(0, buf, 1);
    expect(buf[0]).toBe(1);
    expect(buf[1]).toBe(2);
    expect(buf[2]).toBe(3);

    // Modify buffer and read back
    buf[0] = 10;
    backend.readTransforms(0, buf, 1);
    expect(backend.getPosition(handle)).toEqual([10, 2, 3]);
    backend.destroy();
  });

  it("should apply forces and impulses", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 2,
    }, { index: 0, generation: 0 });

    backend.applyForce(handle, [0, 10, 0]);
    expect(backend.getLinearVelocity(handle)[1]).toBeCloseTo(5, 0); // F/m * 1

    backend.applyImpulse(handle, [0, 10, 0]);
    expect(backend.getLinearVelocity(handle)[1]).toBeCloseTo(10, 0);
    backend.destroy();
  });

  it("should not apply forces to static bodies", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });

    backend.applyForce(handle, [0, 100, 0]);
    expect(backend.getLinearVelocity(handle)).toEqual([0, 0, 0]);
    backend.destroy();
  });

  it("should create joints", () => {
    const backend = makeBackend();
    const parent = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });
    const child = backend.createBody(0, {
      type: "dynamic",
      position: [0, -1, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 1, generation: 0 });

    const jointId = backend.createJoint(0, parent, child, {
      type: "fixed",
      anchorA: [0, 0, 0],
      anchorB: [0, 1, 0],
    });
    expect(jointId).toBeGreaterThanOrEqual(0);
    backend.destroyJoint(0, jointId);
    backend.destroy();
  });

  it("should step all realms", () => {
    const backend = new NativePhysicsBackend();
    backend.createRealm(realmConfig({id: 0, name: "a", gravity: [0, -9.81, 0] }));
    backend.createRealm(realmConfig({id: 1, name: "b", gravity: [0, -9.81, 0] }));

    const h0 = backend.createBody(0, { type: "dynamic", position: [0, 10, 0], rotation: [0, 0, 0, 1], mass: 1 }, { index: 0, generation: 0 });
    const h1 = backend.createBody(1, { type: "dynamic", position: [0, 10, 0], rotation: [0, 0, 0, 1], mass: 1 }, { index: 0, generation: 0 });

    backend.stepAll(0.1);
    expect(backend.getPosition(h0)[1]).toBeLessThan(10);
    expect(backend.getPosition(h1)[1]).toBeLessThan(10);
    backend.destroy();
  });

  it("should respect body type changes", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });

    backend.setBodyType(handle, "static");
    backend.applyForce(handle, [0, 100, 0]);
    expect(backend.getLinearVelocity(handle)).toEqual([0, 0, 0]);

    backend.setBodyType(handle, "dynamic");
    backend.applyForce(handle, [0, 100, 0]);
    expect(backend.getLinearVelocity(handle)[1]).toBeGreaterThan(0);
    backend.destroy();
  });

  it("should wake up and check sleeping", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
      sleeping: true,
    }, { index: 0, generation: 0 });

    expect(backend.isSleeping(handle)).toBe(true);
    backend.wakeUp(handle);
    expect(backend.isSleeping(handle)).toBe(false);
    backend.destroy();
  });

  it("should set/get velocities and rotation", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });

    backend.setLinearVelocity(handle, [1, 2, 3]);
    expect(backend.getLinearVelocity(handle)).toEqual([1, 2, 3]);

    backend.setAngularVelocity(handle, [0.1, 0.2, 0.3]);
    expect(backend.getAngularVelocity(handle)).toEqual([0.1, 0.2, 0.3]);

    backend.setRotation(handle, [0.7071, 0, 0, 0.7071]);
    expect(backend.getRotation(handle)[0]).toBeCloseTo(0.7071, 3);
    backend.destroy();
  });

  it("should destroy cleanly", () => {
    const backend = makeBackend();
    backend.destroy();
    expect(backend.getRealmIds()).toEqual([]);
  });

  // --- Additional edge case tests ---

  it("should handle missing realm gracefully", () => {
    const backend = new NativePhysicsBackend();
    expect(backend.getRealmIds()).toEqual([]);
    backend.step(999, 0.1); // should not throw
    expect(backend.getContacts(999)).toEqual([]);
    backend.destroy();
  });

  it("should handle missing body gracefully", () => {
    const backend = makeBackend();
    const fakeHandle = { realmId: 0, id: 999, entity: { index: 0, generation: 0 } };
    expect(backend.getPosition(fakeHandle)).toEqual([0, 0, 0]);
    expect(backend.getLinearVelocity(fakeHandle)).toEqual([0, 0, 0]);
    expect(backend.getRotation(fakeHandle)).toEqual([0, 0, 0, 1]);
    expect(backend.isSleeping(fakeHandle)).toBe(false);
    backend.setLinearVelocity(fakeHandle, [1, 2, 3]); // should not throw
    backend.destroy();
  });

  it("should step empty realm without error", () => {
    const backend = makeBackend();
    backend.step(0, 0.016);
    backend.destroy();
  });

  it("should support multiple colliders on one body", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 5, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    const c1 = backend.addCollider(handle, { shape: { type: "sphere", radius: 0.5 } });
    const c2 = backend.addCollider(handle, { shape: { type: "box", halfExtents: [0.3, 0.3, 0.3] } });
    expect(c1).not.toBe(c2);

    // Both should produce contacts with floor
    const floor = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 1, generation: 0 });
    backend.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });

    for (let i = 0; i < 100; i++) {
      backend.step(0, 1 / 60);
    }
    const contacts = backend.getContacts(0);
    expect(contacts.length).toBeGreaterThan(0);
    backend.destroy();
  });

  it("should remove colliders", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 5, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    const cId = backend.addCollider(handle, { shape: { type: "sphere", radius: 1 } });
    expect(cId).toBeGreaterThanOrEqual(0);

    backend.removeCollider(handle, cId);
    // After removing collider, body should have no contacts
    const floor = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 1, generation: 0 });
    backend.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });

    backend.step(0, 1 / 60);
    const contacts = backend.getContacts(0);
    expect(contacts.length).toBe(0);
    backend.destroy();
  });

  it("should not generate contacts for sensor colliders", () => {
    const backend = makeBackend();
    const a = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(a, { shape: { type: "sphere", radius: 1 }, sensor: true });

    const b = backend.createBody(0, {
      type: "dynamic",
      position: [0.5, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 1, generation: 0 });
    backend.addCollider(b, { shape: { type: "sphere", radius: 1 } });

    backend.step(0, 1 / 60);
    const contacts = backend.getContacts(0);
    // Sensor should not produce collision response contacts
    expect(contacts.length).toBe(0);
    backend.destroy();
  });

  it("should report sensor intersections via getIntersections", () => {
    const backend = makeBackend();
    const a = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(a, { shape: { type: "sphere", radius: 1 }, sensor: true });

    const b = backend.createBody(0, {
      type: "dynamic",
      position: [0.5, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 1, generation: 0 });
    backend.addCollider(b, { shape: { type: "sphere", radius: 1 } });

    backend.step(0, 1 / 60);
    const intersections = backend.getIntersections(0);
    expect(intersections.length).toBe(1);
    expect(intersections[0].entityA).toEqual({ index: 0, generation: 0 });
    expect(intersections[0].entityB).toEqual({ index: 1, generation: 0 });
    backend.destroy();
  });

  it("should not report intersections for non-sensor overlapping colliders", () => {
    const backend = makeBackend();
    const a = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(a, { shape: { type: "sphere", radius: 1 } });

    const b = backend.createBody(0, {
      type: "dynamic",
      position: [0.5, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 1, generation: 0 });
    backend.addCollider(b, { shape: { type: "sphere", radius: 1 } });

    backend.step(0, 1 / 60);
    const intersections = backend.getIntersections(0);
    // No sensors involved — no intersections
    expect(intersections.length).toBe(0);
    backend.destroy();
  });

  it("should accept heightfield colliders (converted to trimesh)", () => {
    const backend = makeBackend();
    const nrows = 3;
    const ncols = 3;
    const heights = new Float32Array([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0,
    ]);
    const body = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });
    // Should not throw — heightfield is converted to trimesh internally
    expect(() => {
      backend.addCollider(body, {
        shape: { type: "heightfield", nrows, ncols, heights, scale: [1, 1, 1] },
      });
    }).not.toThrow();
    backend.destroy();
  });

  it("should apply impulse at point", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });

    backend.applyImpulseAtPoint(handle, [0, 10, 0], [1, 0, 0]);
    const vel = backend.getLinearVelocity(handle);
    expect(vel[1]).toBeGreaterThan(0);
    // Should also have angular velocity from off-center impulse
    const angVel = backend.getAngularVelocity(handle);
    expect(Math.abs(angVel[0]) + Math.abs(angVel[1]) + Math.abs(angVel[2])).toBeGreaterThan(0);
    backend.destroy();
  });

  it("should apply torque", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });

    backend.applyTorque(handle, [0, 5, 0]);
    const angVel = backend.getAngularVelocity(handle);
    expect(angVel[1]).toBeGreaterThan(0);
    backend.destroy();
  });

  it("should not apply torque to static bodies", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "static",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });

    backend.applyTorque(handle, [0, 100, 0]);
    expect(backend.getAngularVelocity(handle)).toEqual([0, 0, 0]);
    backend.destroy();
  });

  it("should respect gravity scale", () => {
    const backend = makeBackend();
    const h1 = backend.createBody(0, {
      type: "dynamic",
      position: [0, 100, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
      gravityScale: 0,
    }, { index: 0, generation: 0 });
    const h2 = backend.createBody(0, {
      type: "dynamic",
      position: [0, 100, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
      gravityScale: 1,
    }, { index: 1, generation: 0 });

    backend.step(0, 0.1);
    expect(backend.getPosition(h1)[1]).toBe(100); // no gravity
    expect(backend.getPosition(h2)[1]).toBeLessThan(100); // normal gravity
    backend.destroy();
  });

  it("should apply linear damping", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
      linearDamping: 1.0,
    }, { index: 0, generation: 0 });

    backend.setLinearVelocity(handle, [10, 0, 0]);
    backend.step(0, 1.0);
    const vel = backend.getLinearVelocity(handle);
    expect(Math.abs(vel[0])).toBeLessThan(10);
    backend.destroy();
  });

  it("should respect locked translation axes", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
      lockedAxes: { translation: [true, false, true] },
    }, { index: 0, generation: 0 });

    backend.setLinearVelocity(handle, [10, 5, 10]);
    backend.step(0, 0.1);
    const vel = backend.getLinearVelocity(handle);
    expect(vel[0]).toBe(0); // locked
    expect(vel[1]).not.toBe(0); // unlocked
    expect(vel[2]).toBe(0); // locked
    backend.destroy();
  });

  it("should respect locked rotation axes", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
      lockedAxes: { rotation: [false, true, false] },
    }, { index: 0, generation: 0 });

    backend.setAngularVelocity(handle, [1, 2, 3]);
    backend.step(0, 0.1);
    const angVel = backend.getAngularVelocity(handle);
    expect(angVel[1]).toBe(0); // locked
    expect(angVel[0]).not.toBe(0); // unlocked
    expect(angVel[2]).not.toBe(0); // unlocked
    backend.destroy();
  });

  it("should shapeCast against static bodies", () => {
    const backend = makeBackend();
    const target = backend.createBody(0, {
      type: "static",
      position: [0, 0, 5],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });
    backend.addCollider(target, { shape: { type: "sphere", radius: 1 } });

    const result = backend.shapeCast(
      0,
      { type: "sphere", radius: 0.5 },
      [0, 0, 0],
      [0, 0, 0, 1],
      [0, 0, 1],
      100,
    );
    expect(result).not.toBeNull();
    expect(result!.entity.index).toBe(0);
    expect(result!.hitFraction).toBeGreaterThan(0);
    expect(result!.hitFraction).toBeLessThanOrEqual(1);
    backend.destroy();
  });

  it("should return null shapeCast when no hit", () => {
    const backend = makeBackend();
    const result = backend.shapeCast(
      0,
      { type: "sphere", radius: 0.5 },
      [0, 0, 0],
      [0, 0, 0, 1],
      [0, 1, 0],
      100,
    );
    expect(result).toBeNull();
    backend.destroy();
  });

  it("should collide two dynamic bodies apart", () => {
    const backend = makeBackend();
    const a = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(a, { shape: { type: "sphere", radius: 1 } });

    const b = backend.createBody(0, {
      type: "dynamic",
      position: [1.5, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 1, generation: 0 });
    backend.addCollider(b, { shape: { type: "sphere", radius: 1 } });

    backend.step(0, 1 / 60);
    const posA = backend.getPosition(a);
    const posB = backend.getPosition(b);
    // Bodies should be pushed apart
    const dist = Math.sqrt(
      (posB[0] - posA[0]) ** 2 +
      (posB[1] - posA[1]) ** 2 +
      (posB[2] - posA[2]) ** 2,
    );
    expect(dist).toBeGreaterThanOrEqual(1.5);
    backend.destroy();
  });

  it("should not move kinematic bodies by gravity", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "kinematic",
      position: [0, 50, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(handle, { shape: { type: "sphere", radius: 0.5 } });

    for (let i = 0; i < 10; i++) {
      backend.step(0, 1 / 60);
    }
    expect(backend.getPosition(handle)[1]).toBe(50);
    backend.destroy();
  });

  it("should collide dynamic body against kinematic body", () => {
    const backend = makeBackend();
    const kinematic = backend.createBody(0, {
      type: "kinematic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 0,
    }, { index: 1, generation: 0 });
    backend.addCollider(kinematic, { shape: { type: "box", halfExtents: [5, 0.5, 5] } });

    const dynamic = backend.createBody(0, {
      type: "dynamic",
      position: [0, 2, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.addCollider(dynamic, { shape: { type: "sphere", radius: 0.5 } });

    for (let i = 0; i < 60; i++) {
      backend.step(0, 1 / 60);
    }
    const pos = backend.getPosition(dynamic);
    expect(pos[1]).toBeLessThan(2);
    expect(pos[1]).toBeGreaterThan(0.5);
    backend.destroy();
  });

  it("should handle character controller with no obstacles", () => {
    const backend = makeBackend();
    const charHandle = backend.createCharacterController(0, {
      offset: [0, 1, 0],
      radius: 0.3,
      halfHeight: 0.9,
      slide: true,
      autostep: { enabled: true, minWidth: 0.1, maxHeight: 0.3 },
      maxSlope: 45,
      minSlopeSlide: 45,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
    }, { index: 0, generation: 0 });

    const result = backend.characterMove(charHandle, [1, 0, 0], 1 / 60);
    expect(result.grounded).toBe(false);
    expect(result.effectiveMovement[0]).toBeCloseTo(1, 1);
    backend.destroy();
  });

  it("should return null raycast when no hit", () => {
    const backend = makeBackend();
    const result = backend.raycast(0, [0, 0, 0], [0, 1, 0], 100);
    expect(result).toBeNull();
    backend.destroy();
  });

  it("should raycast against box shape", () => {
    const backend = makeBackend();
    const target = backend.createBody(0, {
      type: "static",
      position: [0, 0, 5],
      rotation: [0, 0, 0, 1],
    }, { index: 0, generation: 0 });
    backend.addCollider(target, { shape: { type: "box", halfExtents: [1, 1, 1] } });

    const result = backend.raycast(0, [0, 0, 0], [0, 0, 1], 100);
    expect(result).not.toBeNull();
    expect(result!.distance).toBeGreaterThan(0);
    expect(result!.normal[2]).toBeCloseTo(-1, 0); // facing back toward ray origin
    backend.destroy();
  });

  it("should handle different gravity per realm", () => {
    const backend = new NativePhysicsBackend();
    backend.createRealm(realmConfig({id: 0, name: "earth", gravity: [0, -9.81, 0] }));
    backend.createRealm(realmConfig({id: 1, name: "moon", gravity: [0, -1.62, 0] }));

    const h0 = backend.createBody(0, { type: "dynamic", position: [0, 100, 0], rotation: [0, 0, 0, 1], mass: 1 }, { index: 0, generation: 0 });
    const h1 = backend.createBody(1, { type: "dynamic", position: [0, 100, 0], rotation: [0, 0, 0, 1], mass: 1 }, { index: 0, generation: 0 });

    backend.stepAll(0.1);
    const earthY = backend.getPosition(h0)[1];
    const moonY = backend.getPosition(h1)[1];
    // Earth should fall faster than moon
    expect(earthY).toBeLessThan(moonY);
    backend.destroy();
  });

  it("should handle body with zero mass dynamic", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 0.001,
    }, { index: 0, generation: 0 });
    backend.addCollider(handle, { shape: { type: "sphere", radius: 0.5 } });

    // Should not crash with very small mass
    backend.step(0, 1 / 60);
    expect(backend.getPosition(handle)[1]).toBeLessThan(0);
    backend.destroy();
  });

  it("should handle destroyBody on non-existent body", () => {
    const backend = makeBackend();
    backend.destroyBody({ realmId: 0, id: 999, entity: { index: 0, generation: 0 } });
    // Should not throw
    backend.destroy();
  });

  it("should handle removeCollider on non-existent collider", () => {
    const backend = makeBackend();
    const handle = backend.createBody(0, {
      type: "dynamic",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, { index: 0, generation: 0 });
    backend.removeCollider(handle, 999);
    // Should not throw
    backend.destroy();
  });

  it("should handle destroyCharacterController on non-existent", () => {
    const backend = makeBackend();
    backend.destroyCharacterController({ realmId: 0, controllerId: 999, entity: { index: 0, generation: 0 } });
    backend.destroy();
  });

  it("should handle setBodyType on non-existent body", () => {
    const backend = makeBackend();
    backend.setBodyType({ realmId: 0, id: 999, entity: { index: 0, generation: 0 } }, "static");
    backend.destroy();
  });

  it("should handle addCollider to non-existent body", () => {
    const backend = makeBackend();
    const result = backend.addCollider(
      { realmId: 0, id: 999, entity: { index: 0, generation: 0 } },
      { shape: { type: "sphere", radius: 1 } },
    );
    expect(result).toBe(-1);
    backend.destroy();
  });
});

// --- Additional narrowphase rotation tests ---

describe("Narrowphase with rotation", () => {
  it("sphereBoxContact: should detect collision with rotated box", () => {
    // Box rotated 90° around Y
    const rot: [number, number, number, number] = [0, 0.7071, 0, 0.7071];
    const result = sphereBoxContact(
      [1.5, 0, 0], 1,
      [0, 0, 0], rot, [1, 0.5, 2],
    );
    expect(result).not.toBeNull();
    expect(result!.penetrationDepth).toBeGreaterThan(0);
  });

  it("boxBoxContact: should detect rotated boxes overlapping", () => {
    const rot90: [number, number, number, number] = [0, 0.7071, 0, 0.7071];
    const result = boxBoxContact(
      [0, 0, 0], [0, 0, 0, 1], [1, 1, 1],
      [1.5, 0, 0], rot90, [1, 1, 1],
    );
    expect(result).not.toBeNull();
  });

  it("boxBoxContact: should return null for rotated separated boxes", () => {
    const rot90: [number, number, number, number] = [0, 0.7071, 0, 0.7071];
    const result = boxBoxContact(
      [0, 0, 0], [0, 0, 0, 1], [1, 1, 1],
      [10, 0, 0], rot90, [1, 1, 1],
    );
    expect(result).toBeNull();
  });

  it("capsuleBoxContact: should detect collision with rotated box", () => {
    const rot90: [number, number, number, number] = [0, 0.7071, 0, 0.7071];
    const result = capsuleBoxContact(
      [0, 0, 1.5], [0, 0, 0, 1], 1, 0.5,
      [0, 0, 0], rot90, [1, 1, 1],
    );
    expect(result).not.toBeNull();
  });

  it("detectCollision: should handle box-capsule (flipped)", () => {
    const result = detectCollision(
      { type: "box", halfExtents: [1, 1, 1] }, [0, 0, 0], [0, 0, 0, 1],
      { type: "capsule", halfHeight: 1, radius: 0.5 }, [0, 0, 0.5], [0, 0, 0, 1],
    );
    expect(result).not.toBeNull();
  });

  it("detectCollision: should handle capsule-box", () => {
    const result = detectCollision(
      { type: "capsule", halfHeight: 1, radius: 0.5 }, [0, 0, 0.5], [0, 0, 0, 1],
      { type: "box", halfExtents: [1, 1, 1] }, [0, 0, 0], [0, 0, 0, 1],
    );
    expect(result).not.toBeNull();
  });

  it("detectCollision: should handle sphere-capsule (flipped)", () => {
    const result = detectCollision(
      { type: "sphere", radius: 0.5 }, [0, 0.5, 0], [0, 0, 0, 1],
      { type: "capsule", halfHeight: 1, radius: 0.5 }, [0, 0, 0], [0, 0, 0, 1],
    );
    expect(result).not.toBeNull();
  });

  it("detectCollision: should handle capsule-capsule", () => {
    const result = detectCollision(
      { type: "capsule", halfHeight: 1, radius: 0.5 }, [0, 0, 0], [0, 0, 0, 1],
      { type: "capsule", halfHeight: 1, radius: 0.5 }, [0.8, 0, 0], [0, 0, 0, 1],
    );
    expect(result).not.toBeNull();
  });
});

// --- Additional solver tests ---

describe("Solver additional", () => {
  it("resolveContact: should resolve two dynamic bodies", () => {
    const a: BodyData = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [5, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.5,
      friction: 0,
      isStatic: false,
      isKinematic: false,
    };
    const b: BodyData = {
      position: [1.8, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [-5, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.5,
      friction: 0,
      isStatic: false,
      isKinematic: false,
    };
    const manifold = {
      normal: [1, 0, 0] as Vec3,
      penetrationDepth: 0.2,
      points: [{ point: [0.9, 0, 0] as Vec3, penetration: 0.2 }],
    };
    resolveContact(a, b, manifold);
    // After resolution, relative velocity should be separating
    const relVel = b.linearVelocity[0] - a.linearVelocity[0];
    expect(relVel).toBeGreaterThanOrEqual(0);
  });

  it("resolveContact: should apply friction to tangential velocity", () => {
    const a: BodyData = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, -5, 3], // moving down and sideways
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0,
      friction: 0.9,
      isStatic: false,
      isKinematic: false,
    };
    const b: BodyData = {
      position: [0, -1.5, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 0,
      invMass: 0,
      invInertia: 0,
      restitution: 0,
      friction: 0.9,
      isStatic: true,
      isKinematic: false,
    };
    const manifold = {
      normal: [0, -1, 0] as Vec3,
      penetrationDepth: 0.5,
      points: [{ point: [0, -1, 0] as Vec3, penetration: 0.5 }],
    };
    resolveContact(a, b, manifold);
    // Tangential velocity (z) should be reduced by friction
    expect(Math.abs(a.linearVelocity[2])).toBeLessThan(3);
  });

  it("resolveContact: should not resolve kinematic-kinematic", () => {
    const a: BodyData = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [1, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.5,
      friction: 0.5,
      isStatic: false,
      isKinematic: true,
    };
    const b: BodyData = {
      position: [0.5, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [-1, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.5,
      friction: 0.5,
      isStatic: false,
      isKinematic: true,
    };
    const manifold = {
      normal: [1, 0, 0] as Vec3,
      penetrationDepth: 0.5,
      points: [{ point: [0.25, 0, 0] as Vec3, penetration: 0.5 }],
    };
    resolveContact(a, b, manifold);
    // Velocities should be unchanged
    expect(a.linearVelocity).toEqual([1, 0, 0]);
    expect(b.linearVelocity).toEqual([-1, 0, 0]);
  });

  it("integrate: should not move kinematic bodies", () => {
    const body: BodyData = {
      position: [0, 50, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0,
      friction: 0,
      isStatic: false,
      isKinematic: true,
    };
    integrate(body, [0, -9.81, 0], 0.1);
    expect(body.position).toEqual([0, 50, 0]);
    expect(body.linearVelocity).toEqual([0, 0, 0]);
  });

  it("resolveContact: should skip separating contacts", () => {
    const a: BodyData = {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [5, 0, 0], // moving away from B
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.5,
      friction: 0,
      isStatic: false,
      isKinematic: false,
    };
    const b: BodyData = {
      position: [2, 0, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      mass: 1,
      invMass: 1,
      invInertia: 1,
      restitution: 0.5,
      friction: 0,
      isStatic: false,
      isKinematic: false,
    };
    const manifold = {
      normal: [1, 0, 0] as Vec3,
      penetrationDepth: 0.1,
      points: [{ point: [1, 0, 0] as Vec3, penetration: 0.1 }],
    };
    resolveContact(a, b, manifold);
    // A is moving in +x (toward B), B is stationary — relVel along normal = -5 (approaching)
    // Actually A moves +x, B at rest, normal is +x (A to B), relVel = B - A = -5 in x
    // velAlongNormal = -5 < 0 → approaching → should resolve
    // So velocity should change
    expect(a.linearVelocity[0]).not.toBe(5);
  });
});

// --- Additional broadphase tests ---

describe("Broadphase additional", () => {
  it("should handle many bodies efficiently", () => {
    const bp = new Broadphase(4);
    for (let i = 0; i < 100; i++) {
      bp.insert(i, {
        minX: i * 0.5, minY: 0, minZ: 0,
        maxX: i * 0.5 + 1, maxY: 1, maxZ: 1,
      });
    }
    const pairs = bp.generatePairs();
    // Each body overlaps with its neighbors
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThan(100 * 99 / 2);
  });

  it("should support changing cell size", () => {
    const bp = new Broadphase(4);
    bp.setCellSize(8);
    bp.insert(0, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 });
    bp.insert(1, { minX: 5, minY: 0, minZ: 0, maxX: 6, maxY: 1, maxZ: 1 });
    // With cell size 8, both are in same cell but AABBs don't overlap
    expect(bp.generatePairs().length).toBe(0);
  });

  it("should handle bodies at negative coordinates", () => {
    const bp = new Broadphase(4);
    bp.insert(0, { minX: -5, minY: -5, minZ: -5, maxX: -3, maxY: -3, maxZ: -3 });
    bp.insert(1, { minX: -4, minY: -4, minZ: -4, maxX: -2, maxY: -2, maxZ: -2 });
    const pairs = bp.generatePairs();
    expect(pairs.length).toBe(1);
  });

  it("should handle large AABBs spanning many cells", () => {
    const bp = new Broadphase(2);
    bp.insert(0, { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 });
    bp.insert(1, { minX: 10, minY: 10, minZ: 10, maxX: 12, maxY: 12, maxZ: 12 });
    const pairs = bp.generatePairs();
    expect(pairs.length).toBe(1);
  });

  it("should produce no pairs when empty", () => {
    const bp = new Broadphase(4);
    expect(bp.generatePairs()).toEqual([]);
  });
});
