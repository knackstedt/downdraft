import { query } from "../ecs/query";
import { World } from "../ecs/world";
import type { CharacterControllerData } from "./character";
import { CharacterController, CharacterControllerSystem } from "./character";
import type { BodyDesc, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ContactManifold, Entity, JointDesc, PhysicsBackend, PhysicsRealmConfig, RaycastResult, RigidBodyHandle, ShapeCastResult } from "./interface";
import { PhysicsRealm } from "./realm";

function makeMockBackend(): PhysicsBackend {
  const realms = new Map<number, PhysicsRealmConfig>();
  let nextRealmId = 0;
  let nextBodyId = 0;
  let nextControllerId = 0;
  let nextJointId = 0;

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
    createBody(realmId: number, _desc: BodyDesc, entity: Entity): RigidBodyHandle {
      return { realmId, bodyId: ++nextBodyId, entity };
    },
    destroyBody(): void {},
    setBodyType(): void {},
    addCollider(): number { return 0; },
    removeCollider(): void {},
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
      return { realmId, controllerId: ++nextControllerId, entity };
    },
    destroyCharacterController(): void {},
    characterMove(_handle: CharacterControllerHandle, _desired: [number, number, number], _dt: number): CharacterMoveResult {
      return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0] };
    },
    createJoint(): number { return ++nextJointId; },
    destroyJoint(): void {},
    syncTransforms(): void {},
    readTransforms(): void {},
    destroy(): void {},
  };
}

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

describe("CharacterController component", () => {
  it("should have default values", () => {
    const data: CharacterControllerData = {
      handleRealmId: -1,
      handleBodyId: -1,
      controllerHandle: null,
      radius: 0.4,
      halfHeight: 0.9,
      slopeLimit: 0.7,
      stepHeight: 0.3,
      maxGroundSpeed: 8,
      jumpForce: 9.8,
      airControl: 0.5,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
      slide: true,
      grounded: false,
      groundNormal: [0, 1, 0],
      groundEntity: -1,
      velocity: [0, 0, 0],
    };
    expect(data.radius).toBe(0.4);
    expect(data.halfHeight).toBe(0.9);
    expect(data.autostep.enabled).toBe(true);
    expect(data.maxSlope).toBeCloseTo(Math.PI / 3);
    expect(data.slide).toBe(true);
    expect(data.controllerHandle).toBeNull();
  });
});

describe("CharacterControllerSystem", () => {
  it("should create a controller handle via realm", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm);
    const entity = makeEntity(1);
    const data: CharacterControllerData = {
      handleRealmId: realm.id,
      handleBodyId: 1,
      controllerHandle: null,
      radius: 0.5,
      halfHeight: 1.0,
      slopeLimit: 0.7,
      stepHeight: 0.3,
      maxGroundSpeed: 8,
      jumpForce: 9.8,
      airControl: 0.5,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
      slide: true,
      grounded: false,
      groundNormal: [0, 1, 0],
      groundEntity: -1,
      velocity: [0, 0, 0],
    };
    const handle = sys.createController(entity, data);
    expect(handle).not.toBeNull();
    expect(handle!.controllerId).toBeGreaterThan(0);
    expect(data.controllerHandle).toBe(handle);
  });

  it("should destroy a controller handle", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm);
    const entity = makeEntity(1);
    const data: CharacterControllerData = {
      handleRealmId: realm.id,
      handleBodyId: 1,
      controllerHandle: null,
      radius: 0.5,
      halfHeight: 1.0,
      slopeLimit: 0.7,
      stepHeight: 0.3,
      maxGroundSpeed: 8,
      jumpForce: 9.8,
      airControl: 0.5,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
      slide: true,
      grounded: false,
      groundNormal: [0, 1, 0],
      groundEntity: -1,
      velocity: [0, 0, 0],
    };
    sys.createController(entity, data);
    sys.destroyController(data);
    expect(data.controllerHandle).toBeNull();
  });

  it("should fall back to raycast mode when no controller handle", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm);
    const data: CharacterControllerData = {
      handleRealmId: realm.id,
      handleBodyId: 1,
      controllerHandle: null,
      radius: 0.5,
      halfHeight: 1.0,
      slopeLimit: 0.7,
      stepHeight: 0.3,
      maxGroundSpeed: 8,
      jumpForce: 9.8,
      airControl: 0.5,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
      slide: true,
      grounded: false,
      groundNormal: [0, 1, 0],
      groundEntity: -1,
      velocity: [0, 0, 0],
    };
    const newPos = sys.update(data, [0, 10, 0], [1, 0, 0], false, 0.016);
    expect(newPos).toBeDefined();
    // airControl = 0.5 since not grounded, so speed = 8 * 0.5 = 4
    expect(newPos[0]).toBeCloseTo(4 * 0.016);
  });

  it("should use backend characterMove when controller handle exists", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm);
    const entity = makeEntity(1);
    const data: CharacterControllerData = {
      handleRealmId: realm.id,
      handleBodyId: 1,
      controllerHandle: null,
      radius: 0.5,
      halfHeight: 1.0,
      slopeLimit: 0.7,
      stepHeight: 0.3,
      maxGroundSpeed: 8,
      jumpForce: 9.8,
      airControl: 0.5,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
      slide: true,
      grounded: false,
      groundNormal: [0, 1, 0],
      groundEntity: -1,
      velocity: [0, 0, 0],
    };
    sys.createController(entity, data);
    const newPos = sys.update(data, [0, 10, 0], [1, 0, 0], false, 0.016);
    expect(newPos).toBeDefined();
    // Mock backend returns effectiveMovement [0,0,0], so position unchanged
    expect(newPos[0]).toBeCloseTo(0);
    expect(newPos[1]).toBeCloseTo(10);
    expect(newPos[2]).toBeCloseTo(0);
  });

  it("should apply gravity in raycast fallback when not grounded", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm, [0, -9.81, 0]);
    const data: CharacterControllerData = {
      handleRealmId: realm.id,
      handleBodyId: 1,
      controllerHandle: null,
      radius: 0.5,
      halfHeight: 1.0,
      slopeLimit: 0.7,
      stepHeight: 0.3,
      maxGroundSpeed: 8,
      jumpForce: 9.8,
      airControl: 0.5,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
      slide: true,
      grounded: false,
      groundNormal: [0, 1, 0],
      groundEntity: -1,
      velocity: [0, 0, 0],
    };
    sys.update(data, [0, 10, 0], [0, 0, 0], false, 0.016);
    expect(data.velocity[1]).toBeCloseTo(-9.81 * 0.016);
  });

  it("should set and clear input", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm);
    const entity = makeEntity(1);
    sys.setInput(entity, [0, 0, 0], [1, 0, 0], false);
    sys.clearInput(entity);
  });

  it("should register as ECS system", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm);
    const world = new World();
    const q = query(CharacterController);
    expect(() => sys.register(world, q)).not.toThrow();
  });

  it("should check wall collision via raycast", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new CharacterControllerSystem(realm);
    const result = sys.checkWallCollision([0, 0, 0], [1, 0, 0], 1.0);
    expect(result).toBeNull();
  });
});

describe("PhysicsRealm character controller delegation", () => {
  it("should create and destroy character controllers", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const entity = makeEntity(1);
    const desc: CharacterControllerDesc = {
      offset: [0, 0.4, 0],
      radius: 0.4,
      halfHeight: 0.9,
      slide: true,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
    };
    const handle = realm.createCharacterController(desc, entity);
    expect(handle.controllerId).toBeGreaterThan(0);
    expect(handle.entity.index).toBe(1);
    expect(() => realm.destroyCharacterController(handle)).not.toThrow();
  });

  it("should delegate characterMove", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const entity = makeEntity(1);
    const desc: CharacterControllerDesc = {
      offset: [0, 0.4, 0],
      radius: 0.4,
      halfHeight: 0.9,
      slide: true,
      autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
      maxSlope: Math.PI / 3,
      minSlopeSlide: Math.PI / 4,
      snapToGround: 0.1,
      applyImpulsesToDynamicBodies: false,
    };
    const handle = realm.createCharacterController(desc, entity);
    const result = realm.characterMove(handle, [1, 0, 0], 0.016);
    expect(result.grounded).toBe(false);
    expect(result.effectiveMovement).toEqual([0, 0, 0]);
  });

  it("should create and destroy joints", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const handle1 = realm.createBody({ type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] }, makeEntity(1));
    const handle2 = realm.createBody({ type: "dynamic", position: [0, 1, 0], rotation: [0, 0, 0, 1] }, makeEntity(2));
    const jointDesc: JointDesc = {
      type: "cone-twist",
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      coneAngle: Math.PI / 4,
    };
    const jointId = realm.createJoint(handle1, handle2, jointDesc);
    expect(jointId).toBeGreaterThan(0);
    expect(() => realm.destroyJoint(jointId)).not.toThrow();
  });
});
