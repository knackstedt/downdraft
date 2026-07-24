import {
  World, Camera, MeshBuilder,
  Component, system,
  RigidBody, Velocity, PhysicsTransform, Collider,
  createBoxCollider, createSphereCollider,
  type Entity,
} from "@downdraft/core";

interface PhysicsBodyData {
  [key: string]: unknown;
  bodyType: "dynamic" | "static" | "kinematic";
  mass: number;
  restitution: number;
  friction: number;
}

const PhysicsBody = Component.register<PhysicsBodyData>("PhysicsBody", {
  bodyType: "dynamic",
  mass: 1,
  restitution: 0.4,
  friction: 0.5,
});

interface FallingShapeData {
  [key: string]: unknown;
  shape: "box" | "sphere";
  size: number;
  color: [number, number, number];
}

const FallingShape = Component.register<FallingShapeData>("FallingShape", {
  shape: "box",
  size: 1,
  color: [1, 1, 1],
});

let world: World;
let camera: Camera;
let spawnTimer = 0;
let frameCount = 0;
let fps = 0;
let fpsAccum = 0;

export function init(ctx: any) {
  world = new World();
  camera = new Camera();
  camera.setAspect(16, 9);
  camera.distance = 20;
  camera.orbit(0, 0.5);
  world.setResource("camera", camera);

  const groundMesh = MeshBuilder.cube(20);
  world.setResource("groundMesh", groundMesh);

  const cubeMesh = MeshBuilder.cube(1);
  world.setResource("cubeMesh", cubeMesh);

  const sphereMesh = MeshBuilder.sphere(0.5, 16, 16);
  world.setResource("sphereMesh", sphereMesh);

  const groundEntity = world.spawn();
  world.addComponent(groundEntity, PhysicsBody.create({
    bodyType: "static",
    mass: 0,
    restitution: 0.3,
    friction: 0.8,
  }));
  world.addComponent(groundEntity, Collider.create(createBoxCollider(20, 1, 20)));
  world.addComponent(groundEntity, PhysicsTransform.create({
    position: [0, -1, 0],
  }));
  world.addComponent(groundEntity, FallingShape.create({
    shape: "box",
    size: 20,
    color: [0.3, 0.5, 0.3],
  }));

  console.log("[physics-demo] initialized — shapes will fall and bounce on the ground");
}

export function tick(ctx: any, dt: number) {
  frameCount++;
  fpsAccum += dt;
  if (fpsAccum >= 1) {
    fps = frameCount;
    frameCount = 0;
    fpsAccum = 0;
  }

  spawnTimer += dt;
  if (spawnTimer > 0.5) {
    spawnTimer = 0;
    spawnFallingShape();
  }

  system("physics-gravity", (w: World, _dt: number) => {
    const view = w.view([RigidBody, Velocity, PhysicsTransform]);
    for (const ent of view) {
      const body = w.getComponent(ent, RigidBody);
      const vel = w.getComponent(ent, Velocity);
      if (body && vel && body.data.bodyType === "dynamic") {
        vel.data.linear[1] -= 9.81 * _dt * (body.data.gravityScale as number);
      }
    }
  })(world, dt);

  system("physics-integrate", (w: World, _dt: number) => {
    const view = w.view([RigidBody, Velocity, PhysicsTransform]);
    for (const ent of view) {
      const body = w.getComponent(ent, RigidBody);
      const vel = w.getComponent(ent, Velocity);
      const transform = w.getComponent(ent, PhysicsTransform);
      if (body && vel && transform && body.data.bodyType === "dynamic") {
        const [vx, vy, vz] = vel.data.linear as [number, number, number];
        const [px, py, pz] = transform.data.position as [number, number, number];
        const newPy = py + vy * _dt;
        transform.data.position = [px + vx * _dt, newPy, pz + vz * _dt];

        if (newPy < -10) {
          w.despawn(ent);
        }
      }
    }
  })(world, dt);
}

function spawnFallingShape(): void {
  const isBox = Math.random() > 0.5;
  const size = 0.5 + Math.random() * 1.5;
  const x = (Math.random() - 0.5) * 10;
  const z = (Math.random() - 0.5) * 10;

  const ent = world.spawn();
  world.addComponent(ent, PhysicsBody.create({
    bodyType: "dynamic",
    mass: size * size * size,
    restitution: 0.3 + Math.random() * 0.4,
    friction: 0.3 + Math.random() * 0.4,
  }));

  world.addComponent(ent, RigidBody.create({
    bodyType: "dynamic",
    mass: size * size * size,
    gravityScale: 1,
  }));

  world.addComponent(ent, Velocity.create({
    linear: [(Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2],
    angular: [0, 0, 0],
  }));

  world.addComponent(ent, PhysicsTransform.create({
    position: [x, 15, z],
  }));

  if (isBox) {
    world.addComponent(ent, Collider.create(createBoxCollider(size, size, size)));
    world.addComponent(ent, FallingShape.create({
      shape: "box",
      size,
      color: [Math.random(), Math.random(), Math.random()],
    }));
  } else {
    world.addComponent(ent, Collider.create(createSphereCollider(size * 0.5)));
    world.addComponent(ent, FallingShape.create({
      shape: "sphere",
      size: size * 0.5,
      color: [Math.random(), Math.random(), Math.random()],
    }));
  }
}

export function dispose(ctx: any) {
  console.log("[physics-demo] disposed");
}
