import { describe, expect, it } from "bun:test";
import { NativePhysicsBackend } from "./backend.ts";
import type { AABB } from "./broadphase.ts";
import { Broadphase } from "./broadphase.ts";
import {
    boxBoxContact,
    capsuleBoxContact,
    capsuleCapsuleContact,
    capsuleSphereContact,
    rotateVec,
    sphereBoxContact,
    sphereSphereContact,
} from "./narrowphase-shapes.ts";
import { detectCollision } from "./narrowphase.ts";
import { integrate, resolveContact, type BodyData } from "./solver.ts";
import type { Vec3 } from "./types.ts";

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
    backend.createRealm({
      id: 0,
      name: "default",
      gravity: [0, -9.81, 0],
    });
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
    expect(handle.bodyId).toBe(0);
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
      snapToGround: 0.1,
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
    backend.createRealm({ id: 0, name: "a", gravity: [0, -9.81, 0] });
    backend.createRealm({ id: 1, name: "b", gravity: [0, -9.81, 0] });

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
});
