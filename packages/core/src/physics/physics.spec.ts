import type { BodyDesc, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ContactManifold, Entity, IslandInfo, PhysicsBackend, PhysicsBody, PhysicsRealmConfig, RaycastResult, RealmTierConfig, ShapeCastResult } from "./interface";
import { RealmTier } from "./interface";
import { PhysicsLifecycle } from "./lifecycle";
import { RaycastQuery } from "./raycast";
import { PhysicsRealm } from "./realm";

const DEFAULT_TIER_CONFIG: RealmTierConfig = {
  tickFrequency: 1,
  solverIterations: 4,
  promoteThreshold: 50,
  demoteThreshold: 60,
  demoteDwellTime: 1,
};

function makeMockBackend(): PhysicsBackend {
  const realms = new Map<number, PhysicsRealmConfig>();
  let nextRealmId = 0;
  let nextBodyId = 0;
  const bodyStates = new Map<string, { pos: [number, number, number]; rot: [number, number, number, number]; linVel: [number, number, number]; angVel: [number, number, number]; sleeping: boolean }>();

  function key(body: PhysicsBody): string {
    return `${body.realmId}:${body.id}`;
  }

  return {
    name: "mock",
    version: "1.0.0",
    init: async () => {},
    createRealm(config: PhysicsRealmConfig): number {
      const id = config.id ?? ++nextRealmId;
      realms.set(id, config);
      return id;
    },
    destroyRealm(realmId: number): void {
      realms.delete(realmId);
    },
    getRealmIds(): number[] {
      return [...realms.keys()];
    },
    createBody(_realmId: number, desc: BodyDesc, entity: Entity): PhysicsBody {
      const bodyId = ++nextBodyId;
      const body: PhysicsBody = { id: bodyId, realmId: _realmId, entity };
      bodyStates.set(key(body), {
        pos: [...desc.position] as [number, number, number],
        rot: [...desc.rotation] as [number, number, number, number],
        linVel: [...(desc.linearVelocity ?? [0, 0, 0])] as [number, number, number],
        angVel: [...(desc.angularVelocity ?? [0, 0, 0])] as [number, number, number],
        sleeping: desc.sleeping ?? false,
      });
      return body;
    },
    destroyBody(body: PhysicsBody): void {
      bodyStates.delete(key(body));
    },
    setBodyType(): void {},
    addCollider(): number { return 0; },
    removeCollider(): void {},
    applyForce(): void {},
    applyImpulse(): void {},
    applyTorque(): void {},
    applyTorqueImpulse(): void {},
    applyImpulseAtPoint(): void {},
    setLinearVelocity(body: PhysicsBody, vel: [number, number, number]): void {
      const s = bodyStates.get(key(body));
      if (s) s.linVel = [...vel] as [number, number, number];
    },
    getLinearVelocity(body: PhysicsBody): [number, number, number] {
      return bodyStates.get(key(body))?.linVel ?? [0, 0, 0];
    },
    setAngularVelocity(body: PhysicsBody, vel: [number, number, number]): void {
      const s = bodyStates.get(key(body));
      if (s) s.angVel = [...vel] as [number, number, number];
    },
    getAngularVelocity(body: PhysicsBody): [number, number, number] {
      return bodyStates.get(key(body))?.angVel ?? [0, 0, 0];
    },
    setPosition(body: PhysicsBody, pos: [number, number, number]): void {
      const s = bodyStates.get(key(body));
      if (s) s.pos = [...pos] as [number, number, number];
    },
    getPosition(body: PhysicsBody): [number, number, number] {
      return bodyStates.get(key(body))?.pos ?? [0, 0, 0];
    },
    setRotation(body: PhysicsBody, rot: [number, number, number, number]): void {
      const s = bodyStates.get(key(body));
      if (s) s.rot = [...rot] as [number, number, number, number];
    },
    getRotation(body: PhysicsBody): [number, number, number, number] {
      return bodyStates.get(key(body))?.rot ?? [0, 0, 0, 1];
    },
    wakeUp(body: PhysicsBody): void {
      const s = bodyStates.get(key(body));
      if (s) s.sleeping = false;
    },
    isSleeping(body: PhysicsBody): boolean {
      return bodyStates.get(key(body))?.sleeping ?? false;
    },
    setSleepThresholds(): void {},
    setSolverIterations(): void {},
    setCCDEnabled(): void {},
    getIslands(): IslandInfo[] { return []; },
    raycast(): RaycastResult | null { return null; },
    raycastMulti(): RaycastResult[] { return []; },
    shapeCast(): ShapeCastResult | null { return null; },
    step(): void {},
    stepAll(): void {},
    getContacts(): ContactManifold[] { return []; },
    createCharacterController(realmId: number, _desc: CharacterControllerDesc, entity: Entity): CharacterControllerHandle {
      return { realmId, controllerId: ++nextBodyId, entity };
    },
    destroyCharacterController(): void {},
    characterMove(): CharacterMoveResult {
      return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0] };
    },
    createJoint(): number { return ++nextBodyId; },
    destroyJoint(): void {},
    syncTransforms(): void {},
    readTransforms(): void {},
    serializeRealm(): Uint8Array { return new Uint8Array(0); },
    deserializeRealm(): void {},
    destroy(): void {},
  };
}

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

function makeRealmConfig(name: string = "main", tier: RealmTier = RealmTier.Near) {
  return { name, tier, gravity: [0, -9.81, 0] as [number, number, number], tierConfig: DEFAULT_TIER_CONFIG };
}

describe("PhysicsRealm", () => {
  it("should create a realm with a backend", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    expect(realm.name).toBe("main");
    expect(realm.id).toBeGreaterThan(0);
    expect(realm.tier).toBe(RealmTier.Near);
  });

  it("should create and destroy bodies", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const body = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    expect(body.id).toBeGreaterThan(0);
    expect(body.entity.index).toBe(1);
    expect(body.realmId).toBe(realm.id);

    realm.destroyBody(body);
  });

  it("should add and remove colliders", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const body = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    const colliderId = realm.addCollider(body, { shape: { type: "box", halfExtents: [1, 1, 1] } });
    expect(colliderId).toBe(0);
    realm.removeCollider(body, colliderId);
  });

  it("should apply forces and impulses", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const body = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    expect(() => realm.applyForce(body, [0, 10, 0])).not.toThrow();
    expect(() => realm.applyImpulse(body, [0, 5, 0])).not.toThrow();
  });

  it("should set and get position", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const body = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    realm.setPosition(body, [1, 2, 3]);
    expect(realm.getPosition(body)).toEqual([1, 2, 3]);
  });

  it("should set and get linear velocity", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const body = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    realm.setLinearVelocity(body, [1, 2, 3]);
    expect(realm.getLinearVelocity(body)).toEqual([1, 2, 3]);
  });

  it("should perform raycasts", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const result = realm.raycast([0, 0, 0], [0, 1, 0], 100);
    expect(result).toBeNull();
  });

  it("should step the simulation", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    expect(() => realm.step(0.016)).not.toThrow();
  });

  it("should get contacts", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    expect(realm.getContacts()).toEqual([]);
  });

  it("should serialize and deserialize", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const data = realm.serialize();
    expect(data).toBeInstanceOf(Uint8Array);
    expect(() => realm.deserialize(data)).not.toThrow();
  });

  it("should get islands", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    expect(realm.getIslands()).toEqual([]);
  });

  it("should destroy the realm", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    expect(() => realm.destroy()).not.toThrow();
  });

  it("should return the backend and tier", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    expect(realm.getBackend()).toBe(backend);
    expect(realm.getTier()).toBe(RealmTier.Near);
  });

  it("should list bodies and get body count", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    expect(realm.getBodyCount()).toBe(0);
    const body = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    expect(realm.getBodyCount()).toBe(1);
    expect(realm.listBodies()).toHaveLength(1);
    expect(realm.getBody(body.id)).toBe(body);
  });
});

describe("RaycastQuery", () => {
  it("should perform a ray query", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const rq = new RaycastQuery(realm);
    const result = rq.ray([0, 0, 0], [0, 1, 0], 100);
    expect(result).toBeNull();
  });

  it("should return null for zero-length direction", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const rq = new RaycastQuery(realm);
    const result = rq.ray([0, 0, 0], [0, 0, 0], 100);
    expect(result).toBeNull();
  });

  it("should normalize direction vector", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const rq = new RaycastQuery(realm);
    const result = rq.ray([0, 0, 0], [0, 100, 0], 100);
    expect(result).toBeNull();
  });

  it("should perform rayMulti query", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const rq = new RaycastQuery(realm);
    const results = rq.rayMulti([0, 0, 0], [0, 1, 0], 100);
    expect(results).toEqual([]);
  });

  it("should perform shapeCast", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const rq = new RaycastQuery(realm);
    const result = rq.shapeCast(
      { type: "sphere", radius: 1 },
      [0, 0, 0],
      [0, 0, 0, 1],
      [0, 1, 0],
      100,
    );
    expect(result).toBeNull();
  });

  it("should set debug queue without error", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, makeRealmConfig());
    const rq = new RaycastQuery(realm);
    expect(() => rq.setDebugQueue(null)).not.toThrow();
  });
});

describe("PhysicsLifecycle", () => {
  it("should register realm configs", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", makeRealmConfig(), "app-start");
    expect(lifecycle.getRealmCount()).toBe(0);
  });

  it("should bootstrap realms", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", makeRealmConfig(), "app-start");
    lifecycle.bootstrap("app-start");
    expect(lifecycle.getRealmCount()).toBe(1);
  });

  it("should get realm by name", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", makeRealmConfig(), "app-start");
    lifecycle.bootstrap("app-start");
    const realm = lifecycle.getRealmByName("main");
    expect(realm).toBeDefined();
    expect(realm!.name).toBe("main");
  });

  it("should destroy all realms", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", makeRealmConfig(), "app-start");
    lifecycle.bootstrap("app-start");
    lifecycle.destroyAll();
    expect(lifecycle.getRealmCount()).toBe(0);
  });

  it("should step all realms", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", makeRealmConfig(), "app-start");
    lifecycle.bootstrap("app-start");
    expect(() => lifecycle.stepAll(0.016)).not.toThrow();
  });
});
