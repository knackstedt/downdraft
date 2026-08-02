import type { BodyDesc, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ColliderDesc, ContactManifold, Entity, PhysicsBackend, PhysicsRealmConfig, RaycastResult, RigidBodyHandle, ShapeCastResult } from "./interface.ts";
import { PhysicsLifecycle } from "./lifecycle.ts";
import { RaycastQuery } from "./raycast.ts";
import { PhysicsRealm } from "./realm.ts";

function makeMockBackend(): PhysicsBackend {
  const realms = new Map<number, PhysicsRealmConfig>();
  let nextRealmId = 0;
  let nextBodyId = 0;

  return {
    name: "mock",
    version: "1.0.0",
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
    createBody(realmId: number, desc: BodyDesc, entity: Entity): RigidBodyHandle {
      return { realmId, bodyId: ++nextBodyId, entity };
    },
    destroyBody(_handle: RigidBodyHandle): void {},
    setBodyType(_handle: RigidBodyHandle, _type: string): void {},
    addCollider(_handle: RigidBodyHandle, _desc: ColliderDesc): number { return 0; },
    removeCollider(_handle: RigidBodyHandle, _colliderId: number): void {},
    applyForce(): void {},
    applyImpulse(): void {},
    applyTorque(): void {},
    applyTorqueImpulse(): void {},
    applyImpulseAtPoint(): void {},
    setLinearVelocity(): void {},
    getLinearVelocity(): [number, number, number] { return [0, 0, 0]; },
    setAngularVelocity(): void {},
    getAngularVelocity(): [number, number, number] { return [0, 0, 0]; },
    setPosition(): void {},
    getPosition(): [number, number, number] { return [0, 0, 0]; },
    setRotation(): void {},
    getRotation(): [number, number, number, number] { return [0, 0, 0, 1]; },
    wakeUp(): void {},
    isSleeping(): boolean { return false; },
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
    destroy(): void {},
  };
}

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

describe("PhysicsRealm", () => {
  it("should create a realm with a backend", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    expect(realm.name).toBe("main");
    expect(realm.id).toBeGreaterThan(0);
  });

  it("should create and destroy bodies", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const handle = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    expect(handle.bodyId).toBeGreaterThan(0);
    expect(handle.entity.index).toBe(1);

    realm.destroyBody(handle);
  });

  it("should add and remove colliders", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const handle = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    const colliderId = realm.addCollider(handle, { shape: { type: "box", halfExtents: [1, 1, 1] } });
    expect(colliderId).toBe(0);
    realm.removeCollider(handle, colliderId);
  });

  it("should apply forces and impulses", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const handle = realm.createBody(
      { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      makeEntity(1),
    );
    expect(() => realm.applyForce(handle, [0, 10, 0])).not.toThrow();
    expect(() => realm.applyImpulse(handle, [0, 5, 0])).not.toThrow();
  });

  it("should perform raycasts", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const result = realm.raycast([0, 0, 0], [0, 1, 0], 100);
    expect(result).toBeNull();
  });

  it("should step the simulation", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    expect(() => realm.step(0.016)).not.toThrow();
  });

  it("should get contacts", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    expect(realm.getContacts()).toEqual([]);
  });

  it("should destroy the realm", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    expect(() => realm.destroy()).not.toThrow();
  });

  it("should return the backend", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    expect(realm.getBackend()).toBe(backend);
  });
});

describe("RaycastQuery", () => {
  it("should perform a ray query", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const rq = new RaycastQuery(realm);
    const result = rq.ray([0, 0, 0], [0, 1, 0], 100);
    expect(result).toBeNull();
  });

  it("should return null for zero-length direction", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const rq = new RaycastQuery(realm);
    const result = rq.ray([0, 0, 0], [0, 0, 0], 100);
    expect(result).toBeNull();
  });

  it("should normalize direction vector", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const rq = new RaycastQuery(realm);
    const result = rq.ray([0, 0, 0], [0, 100, 0], 100);
    expect(result).toBeNull();
  });

  it("should perform rayMulti query", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const rq = new RaycastQuery(realm);
    const results = rq.rayMulti([0, 0, 0], [0, 1, 0], 100);
    expect(results).toEqual([]);
  });

  it("should return empty for zero-length rayMulti direction", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const rq = new RaycastQuery(realm);
    const results = rq.rayMulti([0, 0, 0], [0, 0, 0], 100);
    expect(results).toEqual([]);
  });

  it("should perform shapeCast", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
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

  it("should perform screenPicking", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const rq = new RaycastQuery(realm);
    const result = rq.screenPicking([0, 0, 0], [0, 1, 0], 1000);
    expect(result).toBeNull();
  });

  it("should set debug queue without error", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const rq = new RaycastQuery(realm);
    expect(() => rq.setDebugQueue(null)).not.toThrow();
  });
});

describe("PhysicsLifecycle", () => {
  it("should register realm configs", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", { name: "main", gravity: [0, -9.81, 0] }, "app-start");
    expect(lifecycle.getRealmCount()).toBe(0);
  });

  it("should bootstrap realms", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", { name: "main", gravity: [0, -9.81, 0] }, "app-start");
    lifecycle.bootstrap("app-start");
    expect(lifecycle.getRealmCount()).toBe(1);
  });

  it("should get realm by name", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", { name: "main", gravity: [0, -9.81, 0] }, "app-start");
    lifecycle.bootstrap("app-start");
    const realm = lifecycle.getRealmByName("main");
    expect(realm).toBeDefined();
    expect(realm!.name).toBe("main");
  });

  it("should destroy all realms", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", { name: "main", gravity: [0, -9.81, 0] }, "app-start");
    lifecycle.bootstrap("app-start");
    lifecycle.destroyAll();
    expect(lifecycle.getRealmCount()).toBe(0);
  });

  it("should step all realms", () => {
    const backend = makeMockBackend();
    const lifecycle = new PhysicsLifecycle(backend);
    lifecycle.registerRealm("app", { name: "main", gravity: [0, -9.81, 0] }, "app-start");
    lifecycle.bootstrap("app-start");
    expect(() => lifecycle.stepAll(0.016)).not.toThrow();
  });
});
