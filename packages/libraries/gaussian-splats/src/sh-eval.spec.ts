import { describe, expect, it } from "bun:test";
import type { GaussianSplatData } from "./parser";
import {
    evalSHChannelCPU,
    packShCoeffs,
    SH_COEFFS_PER_CHANNEL,
    SH_COEFFS_TOTAL,
    SH_EVAL_WGSL,
} from "./sh-eval";

function makeData(count: number, shDegree: number, coeffs?: Float32Array): GaussianSplatData {
  const coeffsPerSplat = SH_COEFFS_TOTAL[shDegree];
  return {
    count,
    shDegree,
    version: 1,
    position: new Float32Array(count * 3),
    scale: new Float32Array(count * 3),
    rotation: new Float32Array(count * 4),
    color: new Float32Array(count * 4),
    shCoeffs: coeffs ?? new Float32Array(count * coeffsPerSplat),
  };
}

describe("sh-eval constants", () => {
  it("SH_COEFFS_PER_CHANNEL should be [0, 3, 8, 15]", () => {
    expect(SH_COEFFS_PER_CHANNEL).toEqual([0, 3, 8, 15]);
  });

  it("SH_COEFFS_TOTAL should be [0, 9, 24, 45]", () => {
    expect(SH_COEFFS_TOTAL).toEqual([0, 9, 24, 45]);
  });
});

describe("packShCoeffs", () => {
  it("should return empty array for degree 0", () => {
    const data = makeData(3, 0);
    const result = packShCoeffs(data, 0);
    expect(result.length).toBe(0);
  });

  it("should return empty array when data has no SH (shDegree 0)", () => {
    const data = makeData(3, 0);
    const result = packShCoeffs(data, 3);
    expect(result.length).toBe(0);
  });

  it("should pack degree 1 coefficients (9 per splat)", () => {
    // 2 splats, degree 1 → 9 coeffs/splat
    const coeffs = new Float32Array(2 * 9);
    for (let i = 0; i < coeffs.length; i++) coeffs[i] = i + 1;
    const data = makeData(2, 1, coeffs);
    const result = packShCoeffs(data, 1);
    expect(result.length).toBe(2 * 9);
    // Should be a direct copy for matching degree
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(coeffs[i]);
    }
  });

  it("should pack degree 3 coefficients (45 per splat)", () => {
    const coeffs = new Float32Array(45);
    for (let i = 0; i < 45; i++) coeffs[i] = i * 0.1;
    const data = makeData(1, 3, coeffs);
    const result = packShCoeffs(data, 3);
    expect(result.length).toBe(45);
    for (let i = 0; i < 45; i++) {
      expect(result[i]).toBeCloseTo(coeffs[i], 5);
    }
  });

  it("should truncate degree 3 data to degree 1 (9 per splat)", () => {
    // Source has 45 coeffs/splat, we want only 9 (degree 1)
    const coeffs = new Float32Array(45);
    for (let i = 0; i < 45; i++) coeffs[i] = i + 1;
    const data = makeData(1, 3, coeffs);
    const result = packShCoeffs(data, 1);
    expect(result.length).toBe(9);
    // First 3 = R channel degree-1 coeffs
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(3);
    // Next 3 = G channel degree-1 coeffs (offset 15 in source)
    expect(result[3]).toBe(16);
    expect(result[4]).toBe(17);
    expect(result[5]).toBe(18);
    // Next 3 = B channel degree-1 coeffs (offset 30 in source)
    expect(result[6]).toBe(31);
    expect(result[7]).toBe(32);
    expect(result[8]).toBe(33);
  });

  it("should handle multiple splats with truncation", () => {
    const coeffs = new Float32Array(2 * 45);
    for (let i = 0; i < coeffs.length; i++) coeffs[i] = i;
    const data = makeData(2, 3, coeffs);
    const result = packShCoeffs(data, 2);
    // 2 splats × 24 coeffs (degree 2) = 48
    expect(result.length).toBe(48);
    // Splat 0, R channel: first 8 coeffs
    expect(result[0]).toBe(0);
    expect(result[7]).toBe(7);
    // Splat 0, G channel: source offset 15, first 8
    expect(result[8]).toBe(15);
    expect(result[15]).toBe(22);
    // Splat 1, R channel: source offset 45, first 8
    expect(result[24]).toBe(45);
    expect(result[31]).toBe(52);
  });

  it("should not exceed data degree", () => {
    // Data is degree 1, request degree 3 → effective degree 1
    const coeffs = new Float32Array(9);
    for (let i = 0; i < 9; i++) coeffs[i] = i;
    const data = makeData(1, 1, coeffs);
    const result = packShCoeffs(data, 3);
    expect(result.length).toBe(9);
  });
});

describe("evalSHChannelCPU", () => {
  it("should return 0 for degree 0", () => {
    const coeffs = Array.from({ length: 15 }, () => 1);
    expect(evalSHChannelCPU(coeffs, 0, [1, 0, 0])).toBe(0);
  });

  it("should evaluate degree 1 correctly", () => {
    const coeffs = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // Only coeff[0] (Y_1^-1 = y) is nonzero; dir = [0, 1, 0]
    const result = evalSHChannelCPU(coeffs, 1, [0, 1, 0]);
    // SH_C1 * y * coeff[0] = 0.4886... * 1 * 1
    expect(result).toBeCloseTo(0.48860251190292, 5);
  });

  it("should evaluate degree 2 correctly", () => {
    // coeffs[6] = Y_2^1 = xz (offset 3 for deg2 + index 3)
    const coeffs = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const dir: [number, number, number] = [1 / Math.sqrt(2), 0, 1 / Math.sqrt(2)];
    const result = evalSHChannelCPU(coeffs, 2, dir);
    // SH_C2[3] * x * z * coeff[6] = 1.0925... * 0.5 * 1
    expect(result).toBeCloseTo(1.09256843064181 * 0.5, 5);
  });

  it("should evaluate degree 3 correctly", () => {
    const coeffs = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    // coeff[8] = Y_3^-3 = y(3xx - yy); dir = [1, 1, 0]/sqrt(2)
    const dir: [number, number, number] = [1 / Math.sqrt(2), 1 / Math.sqrt(2), 0];
    const result = evalSHChannelCPU(coeffs, 3, dir);
    // SH_C3[0] * y * (3xx - yy) * coeff[8]
    // x = y = 1/sqrt(2), xx = yy = 0.5, 3xx - yy = 1.5 - 0.5 = 1.0
    // = 0.5900... * (1/sqrt(2)) * 1.0 * 1
    expect(result).toBeCloseTo(0.59004364580555 / Math.sqrt(2), 5);
  });

  it("should sum contributions from all degrees", () => {
    const coeffs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const dir: [number, number, number] = [0.5, 0.5, 0.5];
    // Degree 3 evaluation includes degree 1 + 2 + 3 blocks
    const resultDeg3 = evalSHChannelCPU(coeffs, 3, dir);
    // Manually compute: degree 1 only
    const resultDeg1Only = evalSHChannelCPU(coeffs, 1, dir);
    // Degree 2 includes degree 1
    const resultDeg2 = evalSHChannelCPU(coeffs, 2, dir);
    // degree 2 block contribution = deg2 - deg1
    const deg2Block = resultDeg2 - resultDeg1Only;
    // degree 3 block contribution = deg3 - deg2
    const deg3Block = resultDeg3 - resultDeg2;
    // Total should equal deg1 + deg2Block + deg3Block
    expect(resultDeg3).toBeCloseTo(resultDeg1Only + deg2Block + deg3Block, 5);
  });
});

describe("SH_EVAL_WGSL", () => {
  it("should be a non-empty WGSL string", () => {
    expect(SH_EVAL_WGSL.length).toBeGreaterThan(100);
    expect(SH_EVAL_WGSL).toContain("evalSH");
    expect(SH_EVAL_WGSL).toContain("shCoeffs");
    expect(SH_EVAL_WGSL).toContain("shParams");
  });

  it("should declare ShParams struct with shDegree and coeffsPerSplat", () => {
    expect(SH_EVAL_WGSL).toContain("ShParams");
    expect(SH_EVAL_WGSL).toContain("shDegree");
    expect(SH_EVAL_WGSL).toContain("coeffsPerSplat");
  });

  it("should short-circuit to vec3(0) when shDegree == 0", () => {
    expect(SH_EVAL_WGSL).toContain("shParams.shDegree == 0u");
    expect(SH_EVAL_WGSL).toContain("vec3<f32>(0.0)");
  });

  it("should include degree 1, 2, 3 evaluation blocks", () => {
    expect(SH_EVAL_WGSL).toContain("shParams.shDegree >= 1u");
    expect(SH_EVAL_WGSL).toContain("shParams.shDegree >= 2u");
    expect(SH_EVAL_WGSL).toContain("shParams.shDegree >= 3u");
  });
});
