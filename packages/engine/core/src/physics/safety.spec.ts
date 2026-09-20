import type { PhysicsBackend, PhysicsBody } from "./interface";
import { SafetyLayer } from "./safety";

function makeMockBackend(overrides: Partial<PhysicsBackend> = {}): PhysicsBackend {
  const states = new Map<number, { pos: [number, number, number]; rot: [number, number, number, number]; linVel: [number, number, number]; angVel: [number, number, number]; type: string }>();
  return {
    name: "mock", version: "1.0.0", init: async () => {},
    createRealm: () => 0, destroyRealm: () => {}, getRealmIds: () => [0],
    createBody: (_r: number, desc: { position: [number, number, number]; rotation: [number, number, number, number]; type: string }, entity: import("./interface").Entity) => {
      const id = Math.floor(Math.random() * 0x7fffffff);
      const body: PhysicsBody = { id, realmId: 0, entity };
      states.set(id, {
        pos: [...desc.position] as [number, number, number],
        rot: [...desc.rotation] as [number, number, number, number],
        linVel: [0, 0, 0], angVel: [0, 0, 0], type: desc.type,
      });
      return body;
    },
    destroyBody: (b: PhysicsBody) => { states.delete(b.id); },
    setBodyType: (b: PhysicsBody, t: string) => { const s = states.get(b.id); if (s) s.type = t; },
    addCollider: () => 0, removeCollider: () => {},
    applyForce: () => {}, applyImpulse: () => {}, applyTorque: () => {},
    applyTorqueImpulse: () => {}, applyImpulseAtPoint: () => {},
    setLinearVelocity: (b: PhysicsBody, v: [number, number, number]) => { const s = states.get(b.id); if (s) s.linVel = [...v]; },
    getLinearVelocity: (b: PhysicsBody) => states.get(b.id)?.linVel ?? [0, 0, 0],
    setAngularVelocity: (b: PhysicsBody, v: [number, number, number]) => { const s = states.get(b.id); if (s) s.angVel = [...v]; },
    getAngularVelocity: (b: PhysicsBody) => states.get(b.id)?.angVel ?? [0, 0, 0],
    setPosition: (b: PhysicsBody, p: [number, number, number]) => { const s = states.get(b.id); if (s) s.pos = [...p]; },
    getPosition: (b: PhysicsBody) => states.get(b.id)?.pos ?? [0, 0, 0],
    setRotation: (b: PhysicsBody, r: [number, number, number, number]) => { const s = states.get(b.id); if (s) s.rot = [...r]; },
    getRotation: (b: PhysicsBody) => states.get(b.id)?.rot ?? [0, 0, 0, 1],
    wakeUp: () => {}, isSleeping: () => false,
    setSleepThresholds: () => {}, setSolverIterations: () => {}, setCCDEnabled: () => {},
    getIslands: () => [], raycast: () => null, raycastMulti: () => [], shapeCast: () => null,
    step: () => {}, stepAll: () => {}, getContacts: () => [],
    createCharacterController: () => ({}), destroyCharacterController: () => {}, characterMove: () => ({}),
    createJoint: () => 0, destroyJoint: () => {}, syncTransforms: () => {}, readTransforms: () => {},
    serializeRealm: () => new Uint8Array(0), deserializeRealm: () => {}, destroy: () => {},
    ...overrides,
  } as unknown as PhysicsBackend;
}

describe("SafetyLayer", () => {
  it("should throw on NaN in dev mode", () => {
    const safety = new SafetyLayer({ devMode: true });
    expect(() => safety.assertFinite(NaN, "test")).toThrow();
    expect(() => safety.assertFinite(Infinity, "test")).toThrow();
  });

  it("should not throw on NaN in shipped mode (warn only)", () => {
    const safety = new SafetyLayer({ devMode: false });
    expect(() => safety.assertFinite(NaN, "test")).not.toThrow();
    expect(() => safety.assertFinite(Infinity, "test")).not.toThrow();
  });

  it("should validate finite vectors", () => {
    const safety = new SafetyLayer({ devMode: true });
    expect(() => safety.assertFiniteVec3([1, 2, 3], "v")).not.toThrow();
    expect(() => safety.assertFiniteVec3([NaN, 2, 3], "v")).toThrow();
  });

  it("should validate finite quaternions and reject zero-norm", () => {
    const safety = new SafetyLayer({ devMode: true });
    expect(() => safety.assertFiniteQuat([0, 0, 0, 1], "q")).not.toThrow();
    expect(() => safety.assertFiniteQuat([0, 0, 0, 0], "q")).toThrow(); // degenerate
  });

  it("should validate body descriptors", () => {
    const safety = new SafetyLayer({ devMode: true });
    expect(() => safety.assertBodyDescValid({ type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 })).not.toThrow();
    expect(() => safety.assertBodyDescValid({ type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 0 })).toThrow();
    expect(() => safety.assertBodyDescValid({ type: "dynamic", position: [NaN, 0, 0], rotation: [0, 0, 0, 1] })).toThrow();
  });

  it("should sanitize non-finite values to 0 in shipped mode", () => {
    const safety = new SafetyLayer({ devMode: false });
    expect(safety.sanitize(NaN)).toBe(0);
    expect(safety.sanitize(Infinity)).toBe(0);
    expect(safety.sanitize(42)).toBe(42);
  });

  it("should sanitize degenerate quaternions to identity", () => {
    const safety = new SafetyLayer({ devMode: false });
    const q = safety.sanitizeQuat([0, 0, 0, 0]);
    expect(q).toEqual([0, 0, 0, 1]);
  });

  it("should sanitize solver output and revert to lastKnownGood", () => {
    const backend = makeMockBackend();
    const safety = new SafetyLayer({ devMode: false });
    const body: PhysicsBody = backend.createBody(0, { type: "dynamic", position: [1, 2, 3], rotation: [0, 0, 0, 1] }, { index: 0, generation: 0 });

    // First sweep: establishes lastKnownGood
    safety.sanitizeSolverOutput(backend, [body]);
    expect(safety.getHardLockedCount()).toBe(0);

    // Inject NaN position
    backend.setPosition(body, [NaN, NaN, NaN]);
    safety.sanitizeSolverOutput(backend, [body]);
    // Should have reverted to lastKnownGood
    const pos = backend.getPosition(body);
    expect(pos).toEqual([1, 2, 3]);
  });

  it("should hard-lock bodies with persistent NaN (recurrence)", () => {
    const backend = makeMockBackend();
    const safety = new SafetyLayer({ devMode: false, recurrenceThreshold: 3 } as any);
    const body: PhysicsBody = backend.createBody(0, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] }, { index: 0, generation: 0 });

    // Establish lastKnownGood
    safety.sanitizeSolverOutput(backend, [body]);

    // Inject NaN 3 times → should hard-lock
    for (let i = 0; i < 3; i++) {
      backend.setPosition(body, [NaN, NaN, NaN]);
      safety.sanitizeSolverOutput(backend, [body]);
    }
    expect(safety.isHardLocked(body.id)).toBe(true);
    expect(safety.getHardLockedCount()).toBe(1);
  });

  it("isFiniteFast should correctly detect NaN/Inf", () => {
    const safety = new SafetyLayer({ devMode: false });
    expect(safety.isFiniteFast(42)).toBe(true);
    expect(safety.isFiniteFast(NaN)).toBe(false);
    expect(safety.isFiniteFast(Infinity)).toBe(false);
    expect(safety.isFiniteFast(-Infinity)).toBe(false);
  });

  it("should reset state", () => {
    const safety = new SafetyLayer({ devMode: false });
    (safety as any).hardLocked.add(1);
    safety.reset();
    expect(safety.getHardLockedCount()).toBe(0);
  });
});
