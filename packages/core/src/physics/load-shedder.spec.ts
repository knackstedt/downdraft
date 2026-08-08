import type { IslandInfo, PhysicsBackend, PhysicsBody } from "./interface";
import { LoadShedder } from "./load-shedder";
import { PhysicsAccumulator } from "./physics-accumulator";

function makeBody(id: number): PhysicsBody {
  return { id, realmId: 0, entity: { index: id, generation: 0 } };
}

function makeBackend(overrides: Partial<PhysicsBackend> = {}): PhysicsBackend {
  const types = new Map<number, string>();
  const velocities = new Map<number, [number, number, number]>();
  return {
    name: "mock", version: "1.0.0", init: async () => {},
    createRealm: () => 0, destroyRealm: () => {}, getRealmIds: () => [0],
    createBody: (_r, desc, entity) => {
      const body = makeBody(Math.floor(Math.random() * 0x7fffffff));
      types.set(body.id, desc.type);
      velocities.set(body.id, [0, 0, 0]);
      return body;
    },
    destroyBody: () => {},
    setBodyType: (b, t) => { types.set(b.id, t); },
    addCollider: () => 0, removeCollider: () => {},
    applyForce: () => {}, applyImpulse: () => {}, applyTorque: () => {},
    applyTorqueImpulse: () => {}, applyImpulseAtPoint: () => {},
    setLinearVelocity: (b, v) => { velocities.set(b.id, [...v] as [number, number, number]); },
    getLinearVelocity: (b) => velocities.get(b.id) ?? [0, 0, 0],
    setAngularVelocity: () => {}, getAngularVelocity: () => [0, 0, 0],
    setPosition: () => {}, getPosition: () => [0, 0, 0],
    setRotation: () => {}, getRotation: () => [0, 0, 0, 1],
    wakeUp: () => {}, isSleeping: () => false,
    setSleepThresholds: () => {}, setSolverIterations: () => {}, setCCDEnabled: () => {},
    getIslands: () => [] as IslandInfo[],
    raycast: () => null, raycastMulti: () => [], shapeCast: () => null,
    step: () => {}, stepAll: () => {}, getContacts: () => [],
    createCharacterController: () => ({}), destroyCharacterController: () => {}, characterMove: () => ({}),
    createJoint: () => 0, destroyJoint: () => {}, syncTransforms: () => {}, readTransforms: () => {},
    serializeRealm: () => new Uint8Array(0), deserializeRealm: () => {}, destroy: () => {},
    ...overrides,
  } as unknown as PhysicsBackend;
}

describe("LoadShedder", () => {
  it("should report budget breach from accumulator", () => {
    const shedder = new LoadShedder();
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60, maxCatchUpSteps: 1 });
    acc.accumulate(10 / 60);
    acc.consumeSteps();
    expect(shedder.checkBudget(acc)).toBe(true);
  });

  it("should freeze a body (set kinematic + zero velocity)", () => {
    const shedder = new LoadShedder();
    const backend = makeBackend();
    const body = makeBody(1);
    backend.setLinearVelocity(body, [10, 0, 0]);
    shedder.freezeBody(body, backend, 0);
    expect(shedder.isFrozen(1)).toBe(true);
    expect(backend.getLinearVelocity(body)).toEqual([0, 0, 0]);
    expect(shedder.getFrozenCount()).toBe(1);
  });

  it("should unfreeze a body (restore dynamic)", () => {
    const shedder = new LoadShedder();
    const backend = makeBackend();
    const body = makeBody(1);
    shedder.freezeBody(body, backend, 0);
    shedder.unfreezeBody(body, backend);
    expect(shedder.isFrozen(1)).toBe(false);
    expect(shedder.getFrozenCount()).toBe(0);
  });

  it("should unfreeze all after headroom frames", () => {
    const shedder = new LoadShedder({ unfreezeHeadroomFrames: 3 });
    const backend = makeBackend();
    const body = makeBody(1);
    shedder.freezeBody(body, backend, 0);
    const acc = new PhysicsAccumulator();

    // 3 frames of headroom → unfreeze
    shedder.tick(acc, backend);
    shedder.tick(acc, backend);
    expect(shedder.getFrozenCount()).toBe(1); // not yet
    shedder.tick(acc, backend);
    expect(shedder.getFrozenCount()).toBe(0); // unfrozen
  });

  it("should reset headroom counter on budget breach", () => {
    const shedder = new LoadShedder({ unfreezeHeadroomFrames: 3 });
    const backend = makeBackend();
    const body = makeBody(1);
    shedder.freezeBody(body, backend, 0);
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60, maxCatchUpSteps: 1 });

    // 2 frames headroom
    shedder.tick(new PhysicsAccumulator(), backend);
    shedder.tick(new PhysicsAccumulator(), backend);
    // Budget breach → reset counter
    acc.accumulate(10 / 60);
    acc.consumeSteps();
    shedder.tick(acc, backend);
    expect(shedder.getFrozenCount()).toBe(1); // still frozen, counter reset
  });

  it("should set importance weights", () => {
    const shedder = new LoadShedder();
    shedder.setImportance(1, 0.5);
    shedder.setImportance(2, 0.1);
    // No direct getter, but aggressiveSleep uses it internally
    expect(() => shedder.aggressiveSleep(0, makeBackend(), [makeBody(1), makeBody(2)])).not.toThrow();
  });

  it("should shed islands by importance (ascending)", () => {
    const shedder = new LoadShedder();
    shedder.setImportance(1, 0.9); // high importance
    shedder.setImportance(2, 0.1); // low importance
    const islands: IslandInfo[] = [
      { id: 0, bodyIds: [1], avgVelocity: 1, sleeping: false },
      { id: 1, bodyIds: [2], avgVelocity: 0.1, sleeping: false },
    ];
    const backend = makeBackend({ getIslands: () => islands });
    const bodyMap = new Map<number, PhysicsBody>();
    bodyMap.set(1, makeBody(1));
    bodyMap.set(2, makeBody(2));
    const frozen = shedder.shed(0, backend, 0, bodyMap);
    expect(frozen).toBe(2); // both islands frozen (no accumulator check in shed)
    expect(shedder.isFrozen(1)).toBe(true);
    expect(shedder.isFrozen(2)).toBe(true);
  });
});
