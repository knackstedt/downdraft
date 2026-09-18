import { describe, expect, it } from "bun:test";
import {
    applyRootRotation,
    applyRootScale,
    applyUnitScale,
    applyUpAxisConversion,
    autoFit,
    centerToOrigin,
    computeBounds,
    isExtremeScale,
    maxDimension,
    type Bounds,
} from "./model-normalizer";

function makeMesh(vertices: number[], vertexCount: number): { vertices: Float32Array; vertexCount: number } {
  return { vertices: new Float32Array(vertices), vertexCount };
}

describe("applyUpAxisConversion", () => {
  it("is a no-op for Y-up", () => {
    const mesh = makeMesh([1, 2, 3, 0, 1, 0], 1);
    applyUpAxisConversion([mesh], "y");
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1]).toBe(2);
    expect(mesh.vertices[2]).toBe(3);
  });

  it("converts Z-up to Y-up: (x,y,z) → (x,z,-y)", () => {
    const mesh = makeMesh([1, 2, 3, 0, 1, 0], 1);
    applyUpAxisConversion([mesh], "z");
    // Position: (1, 2, 3) → (1, 3, -2)
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1]).toBe(3);
    expect(mesh.vertices[2]).toBe(-2);
    // Normal: (0, 1, 0) → (0, 0, -1)
    expect(mesh.vertices[3]).toBe(0);
    expect(mesh.vertices[4]).toBe(0);
    expect(mesh.vertices[5]).toBe(-1);
  });

  it("handles multiple vertices", () => {
    const mesh = makeMesh([
      1, 0, 0, 0, 0, 1,
      0, 1, 0, 1, 0, 0,
      0, 0, 1, 0, 1, 0,
    ], 3);
    applyUpAxisConversion([mesh], "z");
    // v0: (1,0,0) → (1,0,0), normal (0,0,1) → (0,1,0)
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1] + 0).toBe(0);
    expect(mesh.vertices[2] + 0).toBe(0);
    expect(mesh.vertices[4]).toBe(1);
    expect(mesh.vertices[5] + 0).toBe(0);
    // v1: (0,1,0) → (0,0,-1), normal (1,0,0) → (1,0,0)
    expect(mesh.vertices[6] + 0).toBe(0);
    expect(mesh.vertices[7] + 0).toBe(0);
    expect(mesh.vertices[8]).toBe(-1);
    // v2: (0,0,1) → (0,1,0), normal (0,1,0) → (0,0,-1)
    expect(mesh.vertices[12] + 0).toBe(0);
    expect(mesh.vertices[13]).toBe(1);
    expect(mesh.vertices[14] + 0).toBe(0);
    expect(mesh.vertices[16] + 0).toBe(0);
    expect(mesh.vertices[17]).toBe(-1);
  });
});

describe("applyUnitScale", () => {
  it("is a no-op for meters", () => {
    const mesh = makeMesh([1, 2, 3, 0, 1, 0], 1);
    applyUnitScale([mesh], "meters");
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1]).toBe(2);
    expect(mesh.vertices[2]).toBe(3);
  });

  it("converts centimeters to meters (×0.01)", () => {
    const mesh = makeMesh([100, 200, 300, 0, 1, 0], 1);
    applyUnitScale([mesh], "centimeters");
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1]).toBe(2);
    expect(mesh.vertices[2]).toBe(3);
    // Normals unchanged
    expect(mesh.vertices[3]).toBe(0);
    expect(mesh.vertices[4]).toBe(1);
    expect(mesh.vertices[5]).toBe(0);
  });

  it("converts inches to meters (×0.0254)", () => {
    const mesh = makeMesh([1, 0, 0, 0, 1, 0], 1);
    applyUnitScale([mesh], "inches");
    expect(mesh.vertices[0]).toBeCloseTo(0.0254, 5);
  });

  it("converts millimeters to meters (×0.001)", () => {
    const mesh = makeMesh([1000, 0, 0, 0, 1, 0], 1);
    applyUnitScale([mesh], "millimeters");
    expect(mesh.vertices[0]).toBe(1);
  });

  it("is a no-op for unknown units", () => {
    const mesh = makeMesh([5, 5, 5, 0, 1, 0], 1);
    applyUnitScale([mesh], "units");
    expect(mesh.vertices[0]).toBe(5);
  });
});

describe("applyRootScale", () => {
  it("is a no-op for scale 1.0", () => {
    const mesh = makeMesh([1, 2, 3, 0, 1, 0], 1);
    applyRootScale([mesh], 1.0);
    expect(mesh.vertices[0]).toBe(1);
  });

  it("scales positions uniformly", () => {
    const mesh = makeMesh([2, 4, 6, 0, 1, 0], 1);
    applyRootScale([mesh], 0.5);
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1]).toBe(2);
    expect(mesh.vertices[2]).toBe(3);
    // Normals unchanged
    expect(mesh.vertices[3]).toBe(0);
    expect(mesh.vertices[4]).toBe(1);
  });
});

describe("applyRootRotation", () => {
  it("is a no-op for identity quaternion", () => {
    const mesh = makeMesh([1, 2, 3, 0, 1, 0], 1);
    applyRootRotation([mesh], [0, 0, 0, 1]);
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1]).toBe(2);
    expect(mesh.vertices[2]).toBe(3);
  });

  it("rotates 90° around Y axis", () => {
    // 90° around Y: (x,y,z) → (z, y, -x)
    const halfAngle = Math.PI / 4;
    const rot: [number, number, number, number] = [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)];
    const mesh = makeMesh([1, 0, 0, 0, 0, 1], 1);
    applyRootRotation([mesh], rot);
    // (1,0,0) rotated 90° around Y → (0, 0, -1)
    expect(mesh.vertices[0]).toBeCloseTo(0, 6);
    expect(mesh.vertices[1]).toBeCloseTo(0, 6);
    expect(mesh.vertices[2]).toBeCloseTo(-1, 6);
    // Normal (0,0,1) → (1, 0, 0)
    expect(mesh.vertices[3]).toBeCloseTo(1, 6);
    expect(mesh.vertices[4]).toBeCloseTo(0, 6);
    expect(mesh.vertices[5]).toBeCloseTo(0, 6);
  });
});

describe("computeBounds", () => {
  it("returns degenerate bounds for empty meshes", () => {
    const bounds = computeBounds([]);
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([0, 0, 0]);
  });

  it("computes AABB of a single mesh", () => {
    const mesh = makeMesh([
      1, 2, 3, 0, 1, 0,
      -1, 0, 5, 0, 1, 0,
      0, 4, 1, 0, 1, 0,
    ], 3);
    const bounds = computeBounds([mesh]);
    expect(bounds.min).toEqual([-1, 0, 1]);
    expect(bounds.max).toEqual([1, 4, 5]);
  });

  it("computes AABB across multiple meshes", () => {
    const mesh1 = makeMesh([1, 1, 1, 0, 1, 0], 1);
    const mesh2 = makeMesh([-2, -2, -2, 0, 1, 0], 1);
    const bounds = computeBounds([mesh1, mesh2]);
    expect(bounds.min).toEqual([-2, -2, -2]);
    expect(bounds.max).toEqual([1, 1, 1]);
  });
});

describe("maxDimension", () => {
  it("returns the largest axis extent", () => {
    const bounds: Bounds = { min: [0, 0, 0], max: [3, 5, 2] };
    expect(maxDimension(bounds)).toBe(5);
  });

  it("returns 0 for degenerate bounds", () => {
    const bounds: Bounds = { min: [1, 1, 1], max: [1, 1, 1] };
    expect(maxDimension(bounds)).toBe(0);
  });
});

describe("centerToOrigin", () => {
  it("subtracts the bounds center from all vertices", () => {
    const mesh = makeMesh([
      2, 4, 6, 0, 1, 0,
      0, 2, 4, 0, 1, 0,
    ], 2);
    const bounds: Bounds = { min: [0, 2, 4], max: [2, 4, 6] };
    centerToOrigin([mesh], bounds);
    // Center = (1, 3, 5)
    expect(mesh.vertices[0]).toBe(1); // 2-1
    expect(mesh.vertices[1]).toBe(1); // 4-3
    expect(mesh.vertices[2]).toBe(1); // 6-5
    expect(mesh.vertices[6]).toBe(-1); // 0-1
    expect(mesh.vertices[7]).toBe(-1); // 2-3
    expect(mesh.vertices[8]).toBe(-1); // 4-5
  });

  it("is a no-op when already centered", () => {
    const mesh = makeMesh([1, 2, 3, 0, 1, 0], 1);
    const bounds: Bounds = { min: [-1, -2, -3], max: [1, 2, 3] };
    centerToOrigin([mesh], bounds);
    // Center = (0, 0, 0)
    expect(mesh.vertices[0]).toBe(1);
    expect(mesh.vertices[1]).toBe(2);
    expect(mesh.vertices[2]).toBe(3);
  });
});

describe("autoFit", () => {
  it("scales model to target max dimension", () => {
    const mesh = makeMesh([10, 0, 0, 0, 1, 0], 1);
    const bounds: Bounds = { min: [0, 0, 0], max: [10, 0, 0] };
    const factor = autoFit([mesh], bounds, 2.0);
    expect(factor).toBeCloseTo(0.2, 6);
    expect(mesh.vertices[0]).toBeCloseTo(2.0, 6);
  });

  it("returns 1.0 when already at target", () => {
    const mesh = makeMesh([2, 0, 0, 0, 1, 0], 1);
    const bounds: Bounds = { min: [0, 0, 0], max: [2, 0, 0] };
    const factor = autoFit([mesh], bounds, 2.0);
    expect(factor).toBe(1.0);
    expect(mesh.vertices[0]).toBe(2);
  });

  it("returns 1.0 for degenerate bounds", () => {
    const mesh = makeMesh([0, 0, 0, 0, 1, 0], 1);
    const bounds: Bounds = { min: [0, 0, 0], max: [0, 0, 0] };
    const factor = autoFit([mesh], bounds, 2.0);
    expect(factor).toBe(1.0);
  });
});

describe("isExtremeScale", () => {
  it("returns true for microscopic models (< 0.01m)", () => {
    const bounds: Bounds = { min: [0, 0, 0], max: [0.005, 0, 0] };
    expect(isExtremeScale(bounds)).toBe(true);
  });

  it("returns true for massive models (> 100m)", () => {
    const bounds: Bounds = { min: [0, 0, 0], max: [150, 0, 0] };
    expect(isExtremeScale(bounds)).toBe(true);
  });

  it("returns false for normal-scale models", () => {
    const bounds: Bounds = { min: [0, 0, 0], max: [2, 1, 1] };
    expect(isExtremeScale(bounds)).toBe(false);
  });

  it("returns false for degenerate bounds (maxDim=0)", () => {
    const bounds: Bounds = { min: [0, 0, 0], max: [0, 0, 0] };
    expect(isExtremeScale(bounds)).toBe(false);
  });
});
