import { World, MeshBuilder, Camera, Stage, system } from "@downdraft/core";

export function init(ctx: any) {
  const world = new World();
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.distance = 5;
  camera.orbit(0, 0.3);

  world.setResource("camera", camera);

  const mesh = MeshBuilder.cube(1);
  world.setResource("cubeMesh", mesh);

  console.log("[minimal] initialized");
}

export function tick(ctx: any, dt: number) {
  // Rotate cube
}

export function dispose(ctx: any) {
  console.log("[minimal] disposed");
}
