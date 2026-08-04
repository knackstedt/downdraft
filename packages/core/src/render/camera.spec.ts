import { calculateViewProj, type CameraState } from "./camera";
import { mat4 } from "wgpu-matrix";

describe("calculateViewProj", () => {
  const baseCamera: CameraState = {
    position: [0, 0, 10],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov: 90,
    near: 0.1,
    far: 100,
    aspect: 1,
  };

  it("should compute view-proj from position/target/up (legacy path)", () => {
    const vp = calculateViewProj(baseCamera);
    expect(vp.length).toBe(16);

    // The point at origin should project to roughly center of NDC
    // With camera at z=10 looking at origin, origin maps to z ~ -1 (far plane in NDC)
    // Just verify it's a valid matrix (not all zeros)
    let hasNonZero = false;
    for (let i = 0; i < 16; i++) {
      if (vp[i] !== 0) { hasNonZero = true; break; }
    }
    expect(hasNonZero).toBe(true);
  });

  it("should use explicit projectionMatrix and viewMatrix when provided", () => {
    const projMatrix = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    const viewMatrix = mat4.lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);

    const camera: CameraState = {
      ...baseCamera,
      projectionMatrix: new Float32Array(projMatrix),
      viewMatrix: new Float32Array(viewMatrix),
    };

    const vp = calculateViewProj(camera);
    const expected = mat4.multiply(projMatrix, viewMatrix);

    for (let i = 0; i < 16; i++) {
      expect(Math.abs(vp[i] - expected[i])).toBeLessThan(1e-5);
    }
  });

  it("should use projectionMatrix with computed viewMatrix when only projection is provided", () => {
    const projMatrix = mat4.perspective(Math.PI / 4, 1, 0.1, 100);

    const camera: CameraState = {
      ...baseCamera,
      projectionMatrix: new Float32Array(projMatrix),
    };

    const vp = calculateViewProj(camera);
    const expectedView = mat4.lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    const expected = mat4.multiply(projMatrix, expectedView);

    for (let i = 0; i < 16; i++) {
      expect(Math.abs(vp[i] - expected[i])).toBeLessThan(1e-5);
    }
  });

  it("should use viewMatrix with computed projection when only view is provided", () => {
    const viewMatrix = mat4.lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);

    const camera: CameraState = {
      ...baseCamera,
      viewMatrix: new Float32Array(viewMatrix),
    };

    const vp = calculateViewProj(camera);
    const expectedProj = mat4.perspective((90 * Math.PI) / 180, 1, 0.1, 100);
    const expected = mat4.multiply(expectedProj, viewMatrix);

    for (let i = 0; i < 16; i++) {
      expect(Math.abs(vp[i] - expected[i])).toBeLessThan(1e-5);
    }
  });
});
