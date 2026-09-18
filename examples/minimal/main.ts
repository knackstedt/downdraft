import { Camera, createLogger, MeshBuilder, resourceToken, World } from "@downdraft/engine";

const log = createLogger();

const CameraResource = resourceToken<Camera>("camera");
const CubeMeshResource = resourceToken<unknown>("cubeMesh");

export function init(ctx: any) {
  const world = new World();
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.distance = 5;
  camera.orbit(0, 0.3);

  world.setResourceTyped(CameraResource, camera);

  const mesh = MeshBuilder.cube(1);
  world.setResourceTyped(CubeMeshResource, mesh);

  log.info("minimal", "initialized");
}

export function tick(ctx: any, dt: number) {
  // Rotate cube
}

export function dispose(ctx: any) {
  log.info("minimal", "disposed");
}
