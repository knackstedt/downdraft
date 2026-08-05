import type { BodyDesc, Entity, IslandInfo, PhysicsBackend, PhysicsBody, PhysicsRealmConfig, RealmTierConfig } from "./interface";
import { RealmTier } from "./interface";
import { RealmManager } from "./realm-manager";

function makeMockBackend(): PhysicsBackend {
  const realms = new Map<number, PhysicsRealmConfig>();
  let nextRealmId = 0;
  let nextBodyId = 0;
  const bodyStates = new Map<string, { pos: [number, number, number]; rot: [number, number, number, number]; linVel: [number, number, number]; angVel: [number, number, number]; type: string }>();

  function key(body: PhysicsBody): string { return `${body.realmId}:${body.id}`; }

  return {
    name: "mock", version: "1.0.0", init: async () => {},
    createRealm(config: PhysicsRealmConfig): number {
      const id = config.id ?? ++nextRealmId;
      realms.set(id, config);
      return id;
    },
    destroyRealm(realmId: number): void { realms.delete(realmId); },
    getRealmIds(): number[] { return [...realms.keys()]; },
    createBody(realmId: number, desc: BodyDesc, entity: Entity): PhysicsBody {
      const bodyId = ++nextBodyId;
      const body: PhysicsBody = { id: bodyId, realmId, entity };
      bodyStates.set(key(body), {
        pos: [...desc.position] as [number, number, number],
        rot: [...desc.rotation] as [number, number, number, number],
        linVel: [...(desc.linearVelocity ?? [0, 0, 0])] as [number, number, number],
        angVel: [...(desc.angularVelocity ?? [0, 0, 0])] as [number, number, number],
        type: desc.type,
      });
      return body;
    },
    destroyBody(body: PhysicsBody): void { bodyStates.delete(key(body)); },
    setBodyType(body: PhysicsBody, type: string): void {
      const s = bodyStates.get(key(body)); if (s) s.type = type;
    },
    addCollider(): number { return 0; },
    removeCollider(): void {},
    applyForce(): void {}, applyImpulse(): void {}, applyTorque(): void {},
    applyTorqueImpulse(): void {}, applyImpulseAtPoint(): void {},
    setLinearVelocity(body: PhysicsBody, vel: [number, number, number]): void {
      const s = bodyStates.get(key(body)); if (s) s.linVel = [...vel] as [number, number, number];
    },
    getLinearVelocity(body: PhysicsBody): [number, number, number] {
      return bodyStates.get(key(body))?.linVel ?? [0, 0, 0];
    },
    setAngularVelocity(body: PhysicsBody, vel: [number, number, number]): void {
      const s = bodyStates.get(key(body)); if (s) s.angVel = [...vel] as [number, number, number];
    },
    getAngularVelocity(body: PhysicsBody): [number, number, number] {
      return bodyStates.get(key(body))?.angVel ?? [0, 0, 0];
    },
    setPosition(body: PhysicsBody, pos: [number, number, number]): void {
      const s = bodyStates.get(key(body)); if (s) s.pos = [...pos] as [number, number, number];
    },
    getPosition(body: PhysicsBody): [number, number, number] {
      return bodyStates.get(key(body))?.pos ?? [0, 0, 0];
    },
    setRotation(body: PhysicsBody, rot: [number, number, number, number]): void {
      const s = bodyStates.get(key(body)); if (s) s.rot = [...rot] as [number, number, number, number];
    },
    getRotation(body: PhysicsBody): [number, number, number, number] {
      return bodyStates.get(key(body))?.rot ?? [0, 0, 0, 1];
    },
    wakeUp(): void {}, isSleeping(): boolean { return false; },
    setSleepThresholds(): void {}, setSolverIterations(): void {}, setCCDEnabled(): void {},
    getIslands(): IslandInfo[] { return []; },
    raycast(): any { return null; }, raycastMulti(): any[] { return []; }, shapeCast(): any { return null; },
    step(): void {}, stepAll(): void {}, getContacts(): any[] { return []; },
    createCharacterController(): any { return {}; }, destroyCharacterController(): void {},
    characterMove(): any { return {}; }, createJoint(): number { return 0; }, destroyJoint(): void {},
    syncTransforms(): void {}, readTransforms(): void {},
    serializeRealm(): Uint8Array { return new Uint8Array(0); }, deserializeRealm(): void {},
    destroy(): void {},
  };
}

const TIER_CONFIG: RealmTierConfig = {
  tickFrequency: 1, solverIterations: 4,
  promoteThreshold: 50, demoteThreshold: 60, demoteDwellTime: 1,
};

function makeEntity(i: number): Entity { return { index: i, generation: 0 }; }

describe("RealmManager", () => {
  it("should create three realm tiers", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, tickFrequency: 2 } },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, tickFrequency: 6 } },
    });
    expect(rm.getRealm(RealmTier.Near).name).toBe("near");
    expect(rm.getRealm(RealmTier.Mid).name).toBe("mid");
    expect(rm.getRealm(RealmTier.Far).name).toBe("far");
    rm.destroy();
  });

  it("should register a dynamic body in the near realm", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    });
    const body = rm.registerBody(makeEntity(1), { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(rm.getRealmForBody(body)).toBe(RealmTier.Near);
    expect(rm.getBodyCount()).toBe(1);
    rm.destroy();
  });

  it("should duplicate static bodies into all realms", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    });
    const body = rm.registerBody(makeEntity(1), { type: "static", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    // Static body should have copies in all 3 realms
    expect(rm.getRealm(RealmTier.Near).getBodyCount()).toBe(1);
    expect(rm.getRealm(RealmTier.Mid).getBodyCount()).toBe(1);
    expect(rm.getRealm(RealmTier.Far).getBodyCount()).toBe(1);
    rm.destroy();
  });

  it("should promote a body immediately when within promote threshold", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, promoteThreshold: 50 } },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, promoteThreshold: 50, demoteThreshold: 60, demoteDwellTime: 1 } },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, promoteThreshold: 50, demoteThreshold: 100, demoteDwellTime: 1 } },
    });
    // Body starts in near (default), move it far away to get it demoted
    const body = rm.registerBody(makeEntity(1), { type: "dynamic", position: [200, 0, 0], rotation: [0, 0, 0, 1] });
    // Demote: body is at 200, near demote threshold is 60, dwell 1 → demote to mid
    rm.updateRealmMembership([[0, 0, 0]], 2.0);
    // After transfer, body ref changes — get updated ref from metadata
    const meta = rm.getBodyMetadata(body);
    const currentBody = meta?.body ?? body;
    expect(rm.getRealmForBody(currentBody)).toBe(RealmTier.Mid);

    // Demote again: mid → far (still at 200, mid demote threshold 60)
    rm.updateRealmMembership([[0, 0, 0]], 2.0);
    const meta2 = rm.getBodyMetadata(currentBody);
    const currentBody2 = meta2?.body ?? currentBody;
    expect(rm.getRealmForBody(currentBody2)).toBe(RealmTier.Far);

    // Now move it close to promote back
    rm.getRealm(RealmTier.Far).setPosition(currentBody2, [10, 0, 0]);
    rm.updateRealmMembership([[0, 0, 0]], 0.016);
    const meta3 = rm.getBodyMetadata(currentBody2);
    const currentBody3 = meta3?.body ?? currentBody2;
    expect(rm.getRealmForBody(currentBody3)).toBe(RealmTier.Mid); // 10 < mid promoteThreshold(50) → promote to mid

    rm.destroy();
  });

  it("should demote a body after dwell time (hysteresis)", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, demoteThreshold: 60, demoteDwellTime: 2 } },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    });
    const body = rm.registerBody(makeEntity(1), { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    // Move body beyond demote threshold
    rm.getRealm(RealmTier.Near).setPosition(body, [100, 0, 0]);

    // First update: should NOT demote yet (dwell timer starts)
    rm.updateRealmMembership([[0, 0, 0]], 1.0);
    expect(rm.getRealmForBody(body)).toBe(RealmTier.Near);

    // Second update: dwell time exceeded → demote
    rm.updateRealmMembership([[0, 0, 0]], 1.0);
    expect(rm.getRealmForBody(body)).toBe(RealmTier.Mid);

    rm.destroy();
  });

  it("should not demote if body returns within threshold before dwell expires", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, demoteThreshold: 60, demoteDwellTime: 5 } },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    });
    const body = rm.registerBody(makeEntity(1), { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    rm.getRealm(RealmTier.Near).setPosition(body, [100, 0, 0]);
    rm.updateRealmMembership([[0, 0, 0]], 1.0); // dwell starts
    // Move back within threshold
    rm.getRealm(RealmTier.Near).setPosition(body, [10, 0, 0]);
    rm.updateRealmMembership([[0, 0, 0]], 1.0); // dwell resets
    expect(rm.getRealmForBody(body)).toBe(RealmTier.Near);
    rm.destroy();
  });

  it("should step all realms at their tick frequencies", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, tickFrequency: 1 } },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, tickFrequency: 2 } },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, tickFrequency: 6 } },
    });
    // Step 6 times; tickCount should be 6
    for (let i = 0; i < 6; i++) rm.step(0.016);
    expect(rm.getTickCount()).toBe(6);
    rm.destroy();
  });

  it("should unregister a body", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    });
    const body = rm.registerBody(makeEntity(1), { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(rm.getBodyCount()).toBe(1);
    rm.unregisterBody(body);
    expect(rm.getBodyCount()).toBe(0);
    rm.destroy();
  });

  it("should add colliders to static copies in all realms", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    });
    const body = rm.registerBody(makeEntity(1), { type: "static", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    const colliderId = rm.addCollider(body, { shape: { type: "box", halfExtents: [1, 1, 1] } });
    expect(colliderId).toBeGreaterThanOrEqual(0);
    rm.destroy();
  });

  it("should invoke transfer hooks on promote/demote", () => {
    const backend = makeMockBackend();
    const rm = new RealmManager({
      backend,
      nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, demoteThreshold: 60, demoteDwellTime: 1 } },
      midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, promoteThreshold: 50, demoteThreshold: 100, demoteDwellTime: 1 } },
      farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: { ...TIER_CONFIG, promoteThreshold: 50 } },
    });
    let promoted = 0, demoted = 0;
    rm.setTransferHook({
      onPromote: () => { promoted++; },
      onDemote: () => { demoted++; },
    });
    const body = rm.registerBody(makeEntity(1), { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    // Demote near → mid
    rm.getRealm(RealmTier.Near).setPosition(body, [100, 0, 0]);
    rm.updateRealmMembership([[0, 0, 0]], 2.0);
    expect(demoted).toBe(1);
    // After transfer, get updated body ref
    const meta = rm.getBodyMetadata(body);
    const currentBody = meta?.body ?? body;
    // Promote mid → near
    rm.getRealm(RealmTier.Mid).setPosition(currentBody, [10, 0, 0]);
    rm.updateRealmMembership([[0, 0, 0]], 0.016);
    expect(promoted).toBe(1);
    rm.destroy();
  });
});
