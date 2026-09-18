import { SnapshotManager } from "./snapshot-manager";
import { RealmManager } from "./realm-manager";
import { RealmTier } from "./interface";
import type { BodyDesc, ColliderDesc, Entity, IslandInfo, PhysicsBackend, PhysicsBody, PhysicsRealmConfig, RealmTierConfig, RaycastResult, ShapeCastResult, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ContactManifold, JointDesc } from "./interface";

function makeMockBackend(): PhysicsBackend {
  let nextBodyId = 0;
  const bodyStates = new Map<string, { pos: [number, number, number]; rot: [number, number, number, number]; linVel: [number, number, number]; angVel: [number, number, number] }>();
  function key(b: PhysicsBody): string { return `${b.realmId}:${b.id}`; }
  return {
    name: "mock", version: "1.0.0", init: async () => {},
    createRealm: (c: PhysicsRealmConfig) => c.id ?? 1,
    destroyRealm: () => {}, getRealmIds: () => [1],
    createBody: (_r, desc, entity) => {
      const body: PhysicsBody = { id: ++nextBodyId, realmId: _r, entity };
      bodyStates.set(key(body), {
        pos: [...desc.position] as [number, number, number],
        rot: [...desc.rotation] as [number, number, number, number],
        linVel: [0, 0, 0], angVel: [0, 0, 0],
      });
      return body;
    },
    destroyBody: (b) => { bodyStates.delete(key(b)); },
    setBodyType: () => {}, addCollider: () => 0, removeCollider: () => {},
    applyForce: () => {}, applyImpulse: () => {}, applyTorque: () => {},
    applyTorqueImpulse: () => {}, applyImpulseAtPoint: () => {},
    setLinearVelocity: (b, v) => { const s = bodyStates.get(key(b)); if (s) s.linVel = [...v] as [number, number, number]; },
    getLinearVelocity: (b) => bodyStates.get(key(b))?.linVel ?? [0, 0, 0],
    setAngularVelocity: (b, v) => { const s = bodyStates.get(key(b)); if (s) s.angVel = [...v] as [number, number, number]; },
    getAngularVelocity: (b) => bodyStates.get(key(b))?.angVel ?? [0, 0, 0],
    setPosition: (b, p) => { const s = bodyStates.get(key(b)); if (s) s.pos = [...p] as [number, number, number]; },
    getPosition: (b) => bodyStates.get(key(b))?.pos ?? [0, 0, 0],
    setRotation: (b, r) => { const s = bodyStates.get(key(b)); if (s) s.rot = [...r] as [number, number, number, number]; },
    getRotation: (b) => bodyStates.get(key(b))?.rot ?? [0, 0, 0, 1],
    wakeUp: () => {}, isSleeping: () => false,
    setSleepThresholds: () => {}, setSolverIterations: () => {}, setCCDEnabled: () => {},
    getIslands: () => [] as IslandInfo[],
    raycast: () => null as RaycastResult | null, raycastMulti: () => [] as RaycastResult[], shapeCast: () => null as ShapeCastResult | null,
    step: () => {}, stepAll: () => {}, getContacts: () => [] as ContactManifold[],
    createCharacterController: (_r: number, _d: CharacterControllerDesc, e: Entity) => ({ realmId: _r, controllerId: 0, entity: e }) as CharacterControllerHandle,
    destroyCharacterController: () => {}, characterMove: () => ({ grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0] }) as CharacterMoveResult,
    createJoint: () => 0, destroyJoint: () => {}, syncTransforms: () => {}, readTransforms: () => {},
    serializeRealm: () => new Uint8Array([1, 2, 3]), deserializeRealm: () => {}, destroy: () => {},
  } as unknown as PhysicsBackend;
}

const TIER_CONFIG: RealmTierConfig = {
  tickFrequency: 1, solverIterations: 4,
  promoteThreshold: 50, demoteThreshold: 60, demoteDwellTime: 1,
};

function makeRealmManager(backend: PhysicsBackend): RealmManager {
  return new RealmManager({
    backend,
    nearConfig: { name: "near", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    midConfig: { name: "mid", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
    farConfig: { name: "far", gravity: [0, -9.81, 0], tierConfig: TIER_CONFIG },
  });
}

describe("SnapshotManager", () => {
  it("should snapshot a realm", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    const data = sm.snapshotRealm(RealmTier.Near);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);
    rm.destroy();
  });

  it("should snapshot all realms", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    const all = sm.snapshotAll();
    expect(all.size).toBe(3);
    expect(all.get(RealmTier.Near)).toBeInstanceOf(Uint8Array);
    expect(all.get(RealmTier.Mid)).toBeInstanceOf(Uint8Array);
    expect(all.get(RealmTier.Far)).toBeInstanceOf(Uint8Array);
    rm.destroy();
  });

  it("should tick and snapshot at intervals", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    let snapshotCount = 0;
    sm.setSnapshotHooks({ onSnapshot: () => { snapshotCount++; } });
    // Tick 5 times → near snapshot at tick 5
    for (let i = 0; i < 5; i++) sm.tick();
    expect(snapshotCount).toBeGreaterThanOrEqual(1);
    rm.destroy();
  });

  it("should snapshot mid/far less frequently than near", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    const tierSnapshots: string[] = [];
    sm.setSnapshotHooks({ onSnapshot: (tier) => { tierSnapshots.push(tier === RealmTier.Near ? "near" : tier === RealmTier.Mid ? "mid" : "far"); } });
    // Tick 20 times
    for (let i = 0; i < 20; i++) sm.tick();
    const nearCount = tierSnapshots.filter((t) => t === "near").length;
    const midCount = tierSnapshots.filter((t) => t === "mid").length;
    const farCount = tierSnapshots.filter((t) => t === "far").length;
    // Near: every 5 ticks → 4 snapshots; mid: every 10 → 2; far: every 20 → 1
    expect(nearCount).toBeGreaterThan(midCount);
    expect(midCount).toBeGreaterThan(farCount);
    rm.destroy();
  });

  it("should handle late join", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    let lateJoinCalled = false;
    sm.setSnapshotHooks({ onLateJoin: () => { lateJoinCalled = true; } });
    const snapshots = sm.onLateJoin("player1");
    expect(snapshots.size).toBe(3);
    expect(lateJoinCalled).toBe(true);
    rm.destroy();
  });

  it("should handle reconnect", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    let reconnectCalled = false;
    sm.setSnapshotHooks({ onReconnect: () => { reconnectCalled = true; } });
    sm.onReconnect("player1", 10);
    expect(reconnectCalled).toBe(true);
    rm.destroy();
  });

  it("should restore a realm", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    let restoreCalled = false;
    sm.setSnapshotHooks({ onRestore: () => { restoreCalled = true; } });
    sm.restoreRealm(RealmTier.Near, new Uint8Array([1, 2, 3]));
    expect(restoreCalled).toBe(true);
    rm.destroy();
  });

  it("should reset state", () => {
    const backend = makeMockBackend();
    const rm = makeRealmManager(backend);
    const sm = new SnapshotManager({ realmManager: rm, backend, snapshotInterval: 5 });
    sm.tick();
    sm.snapshotRealm(RealmTier.Near);
    expect(sm.getTickCount()).toBe(1);
    expect(sm.getLastSnapshot(RealmTier.Near)).not.toBeNull();
    sm.reset();
    expect(sm.getTickCount()).toBe(0);
    expect(sm.getLastSnapshot(RealmTier.Near)).toBeNull();
    rm.destroy();
  });
});
