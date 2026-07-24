import { PhysicsTransform, RigidBody, Velocity } from "../physics/body.ts";
import { Collider, createBoxCollider, createCapsuleCollider, createSphereCollider } from "../physics/collider.ts";

describe("RigidBody Component", () => {
  it("should register with name PhysicsRigidBody", () => {
    expect(RigidBody.name).toBe("PhysicsRigidBody");
  });

  it("should have default values", () => {
    const data = RigidBody.create();
    expect(data.bodyType).toBe("dynamic");
    expect(data.mass).toBe(1);
    expect(data.linearDamping).toBe(0.1);
    expect(data.angularDamping).toBe(0.1);
    expect(data.gravityScale).toBe(1);
    expect(data.ccdEnabled).toBe(false);
    expect(data.canSleep).toBe(true);
    expect(data.sleeping).toBe(false);
    expect(data.handleRealmId).toBe(-1);
    expect(data.handleBodyId).toBe(-1);
  });

  it("should allow overriding defaults", () => {
    const data = RigidBody.create({ mass: 10, bodyType: "static", canSleep: false });
    expect(data.mass).toBe(10);
    expect(data.bodyType).toBe("static");
    expect(data.canSleep).toBe(false);
  });
});

describe("Velocity Component", () => {
  it("should register with name PhysicsVelocity", () => {
    expect(Velocity.name).toBe("PhysicsVelocity");
  });

  it("should have default zero velocities", () => {
    const data = Velocity.create();
    expect(data.linear).toEqual([0, 0, 0]);
    expect(data.angular).toEqual([0, 0, 0]);
  });
});

describe("PhysicsTransform Component", () => {
  it("should have default identity transform", () => {
    const data = PhysicsTransform.create();
    expect(data.position).toEqual([0, 0, 0]);
    expect(data.rotation).toEqual([0, 0, 0, 1]);
    expect(data.prevPosition).toEqual([0, 0, 0]);
    expect(data.prevRotation).toEqual([0, 0, 0, 1]);
  });
});

describe("Collider Component", () => {
  it("should have default box collider", () => {
    const data = Collider.create();
    expect((data.shape as { type: string }).type).toBe("box");
    expect(data.friction).toBe(0.5);
    expect(data.restitution).toBe(0);
    expect(data.density).toBe(1);
    expect(data.sensor).toBe(false);
  });

  it("createBoxCollider should create box shape", () => {
    const data = createBoxCollider([1, 2, 3]);
    const shape = data.shape as { type: string; halfExtents: number[] };
    expect(shape.type).toBe("box");
    expect(shape.halfExtents).toEqual([1, 2, 3]);
  });

  it("createSphereCollider should create sphere shape", () => {
    const data = createSphereCollider(2.5);
    const shape = data.shape as { type: string; radius: number };
    expect(shape.type).toBe("sphere");
    expect(shape.radius).toBe(2.5);
  });

  it("createCapsuleCollider should create capsule shape", () => {
    const data = createCapsuleCollider(1, 0.5);
    const shape = data.shape as { type: string; halfHeight: number; radius: number };
    expect(shape.type).toBe("capsule");
    expect(shape.halfHeight).toBe(1);
    expect(shape.radius).toBe(0.5);
  });
});
