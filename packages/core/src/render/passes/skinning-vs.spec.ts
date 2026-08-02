import { describe, it, expect } from "bun:test";
import {
  VertexSkinningPass,
  packBoneTransformsVec4,
  packBoneTransforms,
} from "./skinning.ts";
import {
  SKINNING_VS_GLSL,
  SKINNING_VS_WGSL,
  createSkinningPass,
  MAX_BONES_VS,
  MAX_BONE_INFLUENCES,
} from "./skinning-vs.ts";

describe("VertexSkinningPass", () => {
  it("should have correct constants", () => {
    expect(MAX_BONES_VS).toBe(256);
    expect(MAX_BONE_INFLUENCES).toBe(8);
  });

  it("should create vertex skinning pass with null device", () => {
    const pass = new VertexSkinningPass(null, 128);
    expect(pass.name).toBe("skinning-vertex");
    expect(pass.getBoneTransformBuffer()).toBeNull();
    pass.destroy();
  });

  it("should return correct skinning mode", () => {
    expect(createSkinningPass(true)).toBe("compute");
    expect(createSkinningPass(false)).toBe("vertex");
  });

  it("should contain GLSL shader chunk", () => {
    expect(SKINNING_VS_GLSL).toContain("computeSkinMatrixVS");
    expect(SKINNING_VS_GLSL).toContain("composeMat4");
    expect(SKINNING_VS_GLSL).toContain("uBoneTransforms");
    expect(SKINNING_VS_GLSL).toContain("uInverseBindMatrices");
  });

  it("should contain WGSL shader chunk", () => {
    expect(SKINNING_VS_WGSL).toContain("computeSkinMatrixVS");
    expect(SKINNING_VS_WGSL).toContain("composeMat4VS");
    expect(SKINNING_VS_WGSL).toContain("boneTransforms");
    expect(SKINNING_VS_WGSL).toContain("inverseBindMatrices");
  });

  it("should pack bone transforms into vec4 layout", () => {
    const positions: Array<[number, number, number]> = [[1, 2, 3]];
    const rotations: Array<[number, number, number, number]> = [[0, 0, 0, 1]];
    const scales: Array<[number, number, number]> = [[1, 1, 1]];

    const packed = packBoneTransformsVec4(positions, rotations, scales);
    expect(packed.length).toBe(12);
    expect(packed[0]).toBe(1);
    expect(packed[1]).toBe(2);
    expect(packed[2]).toBe(3);
    expect(packed[3]).toBe(0);
    expect(packed[4]).toBe(0);
    expect(packed[5]).toBe(0);
    expect(packed[6]).toBe(1);
    expect(packed[7]).toBe(1);
    expect(packed[8]).toBe(1);
    expect(packed[9]).toBe(1);
  });

  it("should pack bone transforms in original format too", () => {
    const positions: Array<[number, number, number]> = [[1, 2, 3]];
    const rotations: Array<[number, number, number, number]> = [[0, 0, 0, 1]];
    const scales: Array<[number, number, number]> = [[1, 1, 1]];

    const packed = packBoneTransforms(positions, rotations, scales);
    expect(packed.length).toBe(12);
    expect(packed[0]).toBe(1);
    expect(packed[1]).toBe(2);
    expect(packed[2]).toBe(3);
    expect(packed[3]).toBe(0);
    expect(packed[4]).toBe(0);
    expect(packed[5]).toBe(0);
    expect(packed[6]).toBe(0);
    expect(packed[7]).toBe(1);
    expect(packed[8]).toBe(1);
    expect(packed[9]).toBe(1);
    expect(packed[10]).toBe(1);
  });
});
