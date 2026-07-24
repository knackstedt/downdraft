import { Camera } from "./camera.ts";

describe("Camera", () => {
  it("should construct with default values", () => {
    const cam = new Camera();
    expect(cam.fov).toBe(60);
    expect(cam.aspect).toBe(1);
    expect(cam.near).toBe(0.1);
    expect(cam.far).toBe(1000);
  });

  it("should set position", () => {
    const cam = new Camera();
    cam.setPosition(10, 20, 30);
    expect(cam.position).toEqual([10, 20, 30]);
  });

  it("should set target", () => {
    const cam = new Camera();
    cam.setTarget(1, 2, 3);
    expect(cam.target).toEqual([1, 2, 3]);
  });

  it("should set aspect ratio", () => {
    const cam = new Camera();
    cam.setAspect(16, 9);
    expect(cam.aspect).toBeCloseTo(16 / 9);
  });

  it("should set fov", () => {
    const cam = new Camera();
    cam.setFov(90);
    expect(cam.fov).toBe(90);
  });

  it("should orbit around target", () => {
    const cam = new Camera();
    cam.setTarget(0, 0, 0);
    const initialYaw = cam.yaw;
    cam.orbit(0.5, 0.1);
    expect(cam.yaw).not.toBe(initialYaw);
  });

  it("should zoom in/out", () => {
    const cam = new Camera();
    const initialDist = cam.distance;
    cam.zoom(5);
    expect(cam.distance).toBe(initialDist - 5);
  });

  it("should not zoom past minimum distance", () => {
    const cam = new Camera();
    cam.zoom(10000);
    expect(cam.distance).toBeGreaterThan(0);
  });

  it("should pan", () => {
    const cam = new Camera();
    const initialPos = [...cam.position] as number[];
    const initialTarget = [...cam.target] as number[];
    cam.pan(1, 0);
    expect(cam.position).not.toEqual(initialPos);
    expect(cam.target).not.toEqual(initialTarget);
  });

  it("should mark view matrix dirty on position change", () => {
    const cam = new Camera();
    cam.getViewMatrix();
    expect(cam.isViewDirty()).toBe(false);
    cam.setPosition(5, 5, 5);
    expect(cam.isViewDirty()).toBe(true);
  });

  it("should mark projection matrix dirty on fov change", () => {
    const cam = new Camera();
    cam.getProjectionMatrix();
    expect(cam.isProjDirty()).toBe(false);
    cam.setFov(90);
    expect(cam.isProjDirty()).toBe(true);
  });

  it("should compute view-projection matrix", () => {
    const cam = new Camera();
    const vp = cam.getViewProjectionMatrix();
    expect(vp).toBeDefined();
    expect(vp.length).toBe(16);
  });

  it("should cache view matrix", () => {
    const cam = new Camera();
    const v1 = cam.getViewMatrix();
    const v2 = cam.getViewMatrix();
    expect(v1).toBe(v2);
  });

  it("should cache projection matrix", () => {
    const cam = new Camera();
    const p1 = cam.getProjectionMatrix();
    const p2 = cam.getProjectionMatrix();
    expect(p1).toBe(p2);
  });

  it("should recompute view matrix after position change", () => {
    const cam = new Camera();
    const v1 = cam.getViewMatrix();
    cam.setPosition(100, 100, 100);
    const v2 = cam.getViewMatrix();
    expect(v1).not.toBe(v2);
  });
});
