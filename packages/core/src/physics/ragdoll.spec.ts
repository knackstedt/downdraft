import { PhysicsRealm } from "./realm";
import { createRagdoll, destroyRagdoll, Ragdoll } from "./ragdoll";
import type { RagdollConfig, RagdollData } from "./ragdoll";
import { humanoidRagdoll } from "./ragdoll-presets";
import { RagdollSystem } from "./ragdoll-system";
import { Skeleton } from "../animation/skeleton";
import type { SkeletonData, Bone } from "../animation/skeleton";
import type { PhysicsBackend, PhysicsRealmConfig, RigidBodyHandle, BodyDesc, ColliderDesc, RaycastResult, ShapeCastResult, ContactManifold, Entity, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, JointDesc } from "./interface";
import { World } from "../ecs/world";
import { query } from "../ecs/query";

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
    characterMove(): CharacterMoveResult {
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

function makeTestSkeleton(): Skeleton {
  const bones: Bone[] = [
    {
      name: "Hips",
      parentIndex: -1,
      childrenIndices: [1, 5, 7],
      bindPosition: [0, 1.0, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "Spine",
      parentIndex: 0,
      childrenIndices: [2],
      bindPosition: [0, 0.2, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "Head",
      parentIndex: 1,
      childrenIndices: [],
      bindPosition: [0, 0.2, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "UpperArm_Left",
      parentIndex: 1,
      childrenIndices: [4],
      bindPosition: [0.2, 0, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "LowerArm_Left",
      parentIndex: 3,
      childrenIndices: [],
      bindPosition: [0, -0.25, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "UpperLeg_Left",
      parentIndex: 0,
      childrenIndices: [6],
      bindPosition: [0.1, -0.1, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "LowerLeg_Left",
      parentIndex: 5,
      childrenIndices: [],
      bindPosition: [0, -0.4, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "UpperLeg_Right",
      parentIndex: 0,
      childrenIndices: [8],
      bindPosition: [-0.1, -0.1, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
    {
      name: "LowerLeg_Right",
      parentIndex: 7,
      childrenIndices: [],
      bindPosition: [0, -0.4, 0],
      bindRotation: [0, 0, 0, 1],
      bindScale: [1, 1, 1],
      inverseBindMatrix: new Float32Array(16),
    },
  ];

  for (let i = 0; i < bones.length; i++) {
    const ibm = new Float32Array(16);
    ibm[0] = 1; ibm[5] = 1; ibm[10] = 1; ibm[15] = 1;
    bones[i].inverseBindMatrix = ibm;
  }

  const data: SkeletonData = { bones, name: "test", rootBoneIndex: 0 };
  return new Skeleton(data);
}

describe("Ragdoll component", () => {
  it("should have default values", () => {
    const data = Ragdoll.create();
    expect(data.config).toBeNull();
    expect(data.bodyHandles).toEqual([]);
    expect(data.jointIds).toEqual([]);
    expect(data.blendWeight).toBe(0);
    expect(data.targetBlendWeight).toBe(0);
    expect(data.active).toBe(false);
    expect(data.realmId).toBe(-1);
  });
});

describe("createRagdoll", () => {
  it("should create ragdoll bodies and joints from config", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const skeleton = makeTestSkeleton();
    const entity = makeEntity(1);

    const config: RagdollConfig = {
      bones: [
        {
          boneName: "Hips",
          shape: { type: "box", halfExtents: [0.18, 0.12, 0.12] },
          boneToColliderOffset: [0, 0, 0],
          mass: 8,
          linearDamping: 0.5,
          angularDamping: 0.5,
        },
        {
          boneName: "Head",
          shape: { type: "sphere", radius: 0.12 },
          boneToColliderOffset: [0, 0.1, 0],
          mass: 3,
          linearDamping: 0.3,
          angularDamping: 0.3,
        },
      ],
      joints: [
        {
          parentBone: "Hips",
          childBone: "Head",
          anchor: [0, 0.2, 0],
          coneAngle: Math.PI / 4,
          twistAngle: Math.PI / 6,
        },
      ],
    };

    const ragdoll = createRagdoll(realm, skeleton, config, entity);
    expect(ragdoll.bodyHandles.length).toBe(2);
    expect(ragdoll.bodyHandles[0].bodyId).toBeGreaterThan(0);
    expect(ragdoll.bodyHandles[1].bodyId).toBeGreaterThan(0);
    expect(ragdoll.jointIds.length).toBe(1);
    expect(ragdoll.jointIds[0]).toBeGreaterThan(0);
    expect(ragdoll.boneNames).toEqual(["Hips", "Head"]);
    expect(ragdoll.config).toBe(config);
    expect(ragdoll.blendWeight).toBe(0);
    expect(ragdoll.active).toBe(false);
  });

  it("should handle missing bones gracefully", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const skeleton = makeTestSkeleton();
    const entity = makeEntity(1);

    const config: RagdollConfig = {
      bones: [
        {
          boneName: "NonexistentBone",
          shape: { type: "sphere", radius: 0.1 },
          boneToColliderOffset: [0, 0, 0],
          mass: 1,
          linearDamping: 0.1,
          angularDamping: 0.1,
        },
      ],
      joints: [],
    };

    const ragdoll = createRagdoll(realm, skeleton, config, entity);
    expect(ragdoll.bodyHandles.length).toBe(1);
    expect(ragdoll.bodyHandles[0].bodyId).toBe(-1);
    expect(ragdoll.jointIds.length).toBe(0);
  });
});

describe("destroyRagdoll", () => {
  it("should destroy all joints and bodies", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const skeleton = makeTestSkeleton();
    const entity = makeEntity(1);

    const config: RagdollConfig = {
      bones: [
        {
          boneName: "Hips",
          shape: { type: "box", halfExtents: [0.18, 0.12, 0.12] },
          boneToColliderOffset: [0, 0, 0],
          mass: 8,
          linearDamping: 0.5,
          angularDamping: 0.5,
        },
        {
          boneName: "Head",
          shape: { type: "sphere", radius: 0.12 },
          boneToColliderOffset: [0, 0.1, 0],
          mass: 3,
          linearDamping: 0.3,
          angularDamping: 0.3,
        },
      ],
      joints: [
        {
          parentBone: "Hips",
          childBone: "Head",
          anchor: [0, 0.2, 0],
          coneAngle: Math.PI / 4,
          twistAngle: Math.PI / 6,
        },
      ],
    };

    const ragdoll = createRagdoll(realm, skeleton, config, entity);
    expect(() => destroyRagdoll(realm, ragdoll)).not.toThrow();
    expect(ragdoll.bodyHandles).toEqual([]);
    expect(ragdoll.jointIds).toEqual([]);
    expect(ragdoll.active).toBe(false);
  });
});

describe("humanoidRagdoll preset", () => {
  it("should generate config from a humanoid skeleton", () => {
    const skeleton = makeTestSkeleton();
    const config = humanoidRagdoll(skeleton);
    expect(config.bones.length).toBeGreaterThan(0);
    expect(config.joints.length).toBeGreaterThan(0);

    const hipBone = config.bones.find((b) => b.boneName === "Hips");
    expect(hipBone).toBeDefined();
    expect(hipBone!.shape.type).toBe("box");

    const headBone = config.bones.find((b) => b.boneName === "Head");
    expect(headBone).toBeDefined();
    expect(headBone!.shape.type).toBe("sphere");

    const armBone = config.bones.find((b) => b.boneName === "UpperArm_Left");
    expect(armBone).toBeDefined();
    expect(armBone!.shape.type).toBe("capsule");
  });

  it("should generate joints connecting parent to child bones", () => {
    const skeleton = makeTestSkeleton();
    const config = humanoidRagdoll(skeleton);

    const spineToHead = config.joints.find(
      (j) => j.parentBone === "Spine" && j.childBone === "Head",
    );
    expect(spineToHead).toBeDefined();
    expect(spineToHead!.coneAngle).toBeGreaterThan(0);

    const hipToLeg = config.joints.find(
      (j) => j.parentBone === "Hips" && j.childBone === "UpperLeg_Left",
    );
    expect(hipToLeg).toBeDefined();
  });

  it("should produce empty config for skeleton with no matching bones", () => {
    const bones: Bone[] = [
      {
        name: "root",
        parentIndex: -1,
        childrenIndices: [],
        bindPosition: [0, 0, 0],
        bindRotation: [0, 0, 0, 1],
        bindScale: [1, 1, 1],
        inverseBindMatrix: new Float32Array(16),
      },
    ];
    const ibm = new Float32Array(16);
    ibm[0] = 1; ibm[5] = 1; ibm[10] = 1; ibm[15] = 1;
    bones[0].inverseBindMatrix = ibm;
    const data: SkeletonData = { bones, name: "empty", rootBoneIndex: 0 };
    const skeleton = new Skeleton(data);

    const config = humanoidRagdoll(skeleton);
    expect(config.bones.length).toBe(0);
    expect(config.joints.length).toBe(0);
  });
});

describe("RagdollSystem", () => {
  it("should construct with a realm", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new RagdollSystem(realm);
    expect(sys).toBeDefined();
  });

  it("should register as ECS system", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new RagdollSystem(realm);
    const world = new World();
    const q = query(Ragdoll);
    expect(() => sys.register(world, q)).not.toThrow();
  });

  it("should activate and deactivate ragdoll", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const sys = new RagdollSystem(realm);
    const entity = makeEntity(1);
    sys.activateRagdoll(entity, 3);
    sys.deactivateRagdoll(entity);
  });

  it("should blend weight toward target over time", () => {
    const backend = makeMockBackend();
    const realm = new PhysicsRealm(backend, { name: "main", gravity: [0, -9.81, 0] });
    const skeleton = makeTestSkeleton();
    const entity = makeEntity(1);

    const config: RagdollConfig = {
      bones: [
        {
          boneName: "Hips",
          shape: { type: "box", halfExtents: [0.18, 0.12, 0.12] },
          boneToColliderOffset: [0, 0, 0],
          mass: 8,
          linearDamping: 0.5,
          angularDamping: 0.5,
        },
      ],
      joints: [],
    };

    const ragdoll = createRagdoll(realm, skeleton, config, entity);
    ragdoll.targetBlendWeight = 1.0;
    ragdoll.blendSpeed = 2.0;

    const sys = new RagdollSystem(realm);
    sys.activateRagdoll(entity, 2.0);

    expect(ragdoll.blendWeight).toBe(0);
  });
});
