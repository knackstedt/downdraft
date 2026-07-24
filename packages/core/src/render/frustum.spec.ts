import { Frustum, computeAABB, transformAABB, cullItems, type AABB } from "./frustum.ts";
import { mat4, vec3 } from "wgpu-matrix";

describe("Frustum", () => {
  it("should extract planes from identity view-projection", () => {
    const f = new Frustum();
    const vp = mat4.identity();
    f.extractFromViewProj(vp);
    const planes = f.getPlanes();
    expect(planes.length).toBe(6);
  });

  it("should extract planes from perspective projection", () => {
    const f = new Frustum();
    const view = mat4.lookAt(vec3.create(0, 0, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
    const proj = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    const vp = mat4.multiply(proj, view);
    f.extractFromViewProj(vp);
    expect(f.getPlanes().length).toBe(6);
  });

  it("should contain the origin for a camera looking at it", () => {
    const f = new Frustum();
    const view = mat4.lookAt(vec3.create(0, 0, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
    const proj = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    f.extractFromViewProj(mat4.multiply(proj, view));
    expect(f.intersectsPoint(vec3.create(0, 0, 0))).toBe(true);
  });

  it("should not contain a point behind the camera", () => {
    const f = new Frustum();
    const view = mat4.lookAt(vec3.create(0, 0, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
    const proj = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    f.extractFromViewProj(mat4.multiply(proj, view));
    expect(f.intersectsPoint(vec3.create(0, 0, 20))).toBe(false);
  });

  it("should intersect an AABB within the frustum", () => {
    const f = new Frustum();
    const view = mat4.lookAt(vec3.create(0, 0, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
    const proj = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    f.extractFromViewProj(mat4.multiply(proj, view));
    const aabb: AABB = { min: vec3.create(-1, -1, -1), max: vec3.create(1, 1, 1) };
    expect(f.intersectsAABB(aabb)).toBe(true);
  });

  it("should not intersect an AABB outside the frustum", () => {
    const f = new Frustum();
    const view = mat4.lookAt(vec3.create(0, 0, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
    const proj = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    f.extractFromViewProj(mat4.multiply(proj, view));
    const aabb: AABB = { min: vec3.create(100, 100, 100), max: vec3.create(101, 101, 101) };
    expect(f.intersectsAABB(aabb)).toBe(false);
  });

  it("should intersect a sphere within the frustum", () => {
    const f = new Frustum();
    const view = mat4.lookAt(vec3.create(0, 0, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
    const proj = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    f.extractFromViewProj(mat4.multiply(proj, view));
    expect(f.intersectsSphere(vec3.create(0, 0, 0), 1)).toBe(true);
  });
});

describe("computeAABB", () => {
  it("should compute AABB from position data", () => {
    const positions = new Float32Array([
      -1, -1, -1,
      1, -1, -1,
      1, 1, -1,
      -1, 1, -1,
    ]);
    const aabb = computeAABB(positions, 12, 0);
    expect(aabb.min[0]).toBe(-1);
    expect(aabb.max[0]).toBe(1);
    expect(aabb.min[1]).toBe(-1);
    expect(aabb.max[1]).toBe(1);
  });
});

describe("transformAABB", () => {
  it("should transform AABB by a translation matrix", () => {
    const aabb: AABB = { min: vec3.create(-1, -1, -1), max: vec3.create(1, 1, 1) };
    const model = mat4.translation(vec3.create(10, 0, 0));
    const result = transformAABB(aabb, model);
    expect(result.min[0]).toBe(9);
    expect(result.max[0]).toBe(11);
  });
});

describe("cullItems", () => {
  it("should cull items outside the frustum", () => {
    const f = new Frustum();
    const view = mat4.lookAt(vec3.create(0, 0, 10), vec3.create(0, 0, 0), vec3.create(0, 1, 0));
    const proj = mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    f.extractFromViewProj(mat4.multiply(proj, view));

    const items = [
      { aabb: { min: vec3.create(-1, -1, -1), max: vec3.create(1, 1, 1) }, modelMatrix: mat4.identity(), visible: false },
      { aabb: { min: vec3.create(100, 100, 100), max: vec3.create(101, 101, 101) }, modelMatrix: mat4.identity(), visible: false },
    ];

    const result = cullItems(items, f);
    expect(result.length).toBe(1);
    expect(result[0].visible).toBe(true);
  });
});
