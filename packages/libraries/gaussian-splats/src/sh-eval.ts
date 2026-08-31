// ============================================================================
// Spherical harmonics evaluation for Gaussian splatting
//
// INRIA-format PLY stores SH coefficients as:
//   f_dc_0..2  — degree-0 DC (3 coeffs, one per RGB channel)
//   f_rest_0..44 — degrees 1-3 (45 coeffs = 15 per channel × 3 channels)
//
// The f_rest layout per splat is: [R0..R14, G0..G14, B0..B14]
// where each channel has 15 coeffs: 3 (deg 1) + 5 (deg 2) + 7 (deg 3).
//
// The DC color is already baked into `GaussianSplatData.color` by the parser.
// This module handles the "rest" coefficients (degrees 1-3) for view-dependent
// color: the final color = DC_color + evalSH(coeffs, viewDir).
// ============================================================================

import type { GaussianSplatData } from "./parser";

// ── Coefficient counts ──

/** SH "rest" coefficients per channel for each degree (degrees 1..N). */
export const SH_COEFFS_PER_CHANNEL: readonly number[] = [0, 3, 8, 15];
/** Total SH "rest" coefficients per splat (3 channels) for each degree. */
export const SH_COEFFS_TOTAL: readonly number[] = [0, 9, 24, 45];

// ── SH basis constants (real spherical harmonics) ──

const SH_C1 = 0.48860251190292;
const SH_C2: readonly number[] = [
  1.09256843064181, // Y_2^{-2} = xy
  1.09256843064181, // Y_2^{-1} = yz
  0.31539156525252, // Y_2^0 = 3zz - 1
  1.09256843064181, // Y_2^1 = xz
  0.546274215320904, // Y_2^2 = xx - yy
];
const SH_C3: readonly number[] = [
  0.59004364580555, // Y_3^{-3} = y(3xx - yy)
  2.89061144264055,  // Y_3^{-2} = xyz
  0.457045799464466, // Y_3^{-1} = y(5zz - 1)
  0.373176332573636, // Y_3^0 = z(5zz - 3)
  0.457045799464466, // Y_3^1 = x(5zz - 1)
  1.44530572132028,  // Y_3^2 = z(xx - yy)
  0.59004364580555, // Y_3^3 = x(xx - 3yy)
];

// ── Packing ──

/**
 * Pack SH "rest" coefficients from parsed data, truncated to `maxDegree`.
 * If the parsed data has degree 3 but the game configures `maxDegree: 1`,
 * only 9 coeffs/splat (3 per channel) are packed — saving GPU memory.
 *
 * Returns an empty Float32Array if `maxDegree === 0` or the data has no SH.
 */
export function packShCoeffs(data: GaussianSplatData, maxDegree: number): Float32Array {
  if (maxDegree <= 0 || data.shDegree <= 0 || data.shCoeffs.length === 0) {
    return new Float32Array(0);
  }

  const effectiveDegree = Math.min(maxDegree, data.shDegree);
  const dstPerChannel = SH_COEFFS_PER_CHANNEL[effectiveDegree];
  const dstTotal = dstPerChannel * 3;
  const srcPerChannel = SH_COEFFS_PER_CHANNEL[data.shDegree];
  const result = new Float32Array(data.count * dstTotal);

  for (let i = 0; i < data.count; i++) {
    const srcBase = i * (srcPerChannel * 3);
    const dstBase = i * dstTotal;
    for (let ch = 0; ch < 3; ch++) {
      const srcCh = srcBase + ch * srcPerChannel;
      const dstCh = dstBase + ch * dstPerChannel;
      for (let c = 0; c < dstPerChannel; c++) {
        result[dstCh + c] = data.shCoeffs[srcCh + c];
      }
    }
  }

  return result;
}

// ── WGSL evaluation chunk ──

/**
 * WGSL chunk for SH evaluation. Insert into the fragment shader.
 *
 * Declares:
 *   @group(0) @binding(2) var<storage, read> shCoeffs: array<f32>;
 *   @group(0) @binding(3) var<uniform> shParams: ShParams;
 *
 * Provides: `fn evalSH(splatIdx: u32, dir: vec3<f32>) -> vec3<f32>`
 *
 * The `dir` should be the normalized view direction (cameraPos - splatPos).
 * Returns the SH color contribution (to be added to the DC color).
 * Returns vec3(0) when shDegree == 0.
 */
export const SH_EVAL_WGSL = /* wgsl */ `
struct ShParams {
  shDegree: u32,
  coeffsPerSplat: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(2) var<storage, read> shCoeffs: array<f32>;
@group(0) @binding(3) var<uniform> shParams: ShParams;

fn evalSH(splatIdx: u32, dir: vec3<f32>) -> vec3<f32> {
  if (shParams.shDegree == 0u) {
    return vec3<f32>(0.0);
  }
  let base = splatIdx * shParams.coeffsPerSplat;
  let cpc = shParams.coeffsPerSplat / 3u;
  let x = dir.x;
  let y = dir.y;
  let z = dir.z;
  var r = 0.0;
  var g = 0.0;
  var b = 0.0;

  if (shParams.shDegree >= 1u) {
    // Degree 1: 3 coeffs per channel
    let o = 0u;
    r += shCoeffs[base + o + 0u] * ${SH_C1} * y;
    r += shCoeffs[base + o + 1u] * ${SH_C1} * z;
    r += shCoeffs[base + o + 2u] * ${SH_C1} * x;
    g += shCoeffs[base + cpc + o + 0u] * ${SH_C1} * y;
    g += shCoeffs[base + cpc + o + 1u] * ${SH_C1} * z;
    g += shCoeffs[base + cpc + o + 2u] * ${SH_C1} * x;
    b += shCoeffs[base + 2u * cpc + o + 0u] * ${SH_C1} * y;
    b += shCoeffs[base + 2u * cpc + o + 1u] * ${SH_C1} * z;
    b += shCoeffs[base + 2u * cpc + o + 2u] * ${SH_C1} * x;
  }

  if (shParams.shDegree >= 2u) {
    // Degree 2: 5 coeffs per channel (offset 3)
    let o = 3u;
    r += shCoeffs[base + o + 0u] * ${SH_C2[0]} * x * y;
    r += shCoeffs[base + o + 1u] * ${SH_C2[1]} * y * z;
    r += shCoeffs[base + o + 2u] * ${SH_C2[2]} * (3.0 * z * z - 1.0);
    r += shCoeffs[base + o + 3u] * ${SH_C2[3]} * x * z;
    r += shCoeffs[base + o + 4u] * ${SH_C2[4]} * (x * x - y * y);
    g += shCoeffs[base + cpc + o + 0u] * ${SH_C2[0]} * x * y;
    g += shCoeffs[base + cpc + o + 1u] * ${SH_C2[1]} * y * z;
    g += shCoeffs[base + cpc + o + 2u] * ${SH_C2[2]} * (3.0 * z * z - 1.0);
    g += shCoeffs[base + cpc + o + 3u] * ${SH_C2[3]} * x * z;
    g += shCoeffs[base + cpc + o + 4u] * ${SH_C2[4]} * (x * x - y * y);
    b += shCoeffs[base + 2u * cpc + o + 0u] * ${SH_C2[0]} * x * y;
    b += shCoeffs[base + 2u * cpc + o + 1u] * ${SH_C2[1]} * y * z;
    b += shCoeffs[base + 2u * cpc + o + 2u] * ${SH_C2[2]} * (3.0 * z * z - 1.0);
    b += shCoeffs[base + 2u * cpc + o + 3u] * ${SH_C2[3]} * x * z;
    b += shCoeffs[base + 2u * cpc + o + 4u] * ${SH_C2[4]} * (x * x - y * y);
  }

  if (shParams.shDegree >= 3u) {
    // Degree 3: 7 coeffs per channel (offset 8)
    let o = 8u;
    r += shCoeffs[base + o + 0u] * ${SH_C3[0]} * y * (3.0 * x * x - y * y);
    r += shCoeffs[base + o + 1u] * ${SH_C3[1]} * x * y * z;
    r += shCoeffs[base + o + 2u] * ${SH_C3[2]} * y * (5.0 * z * z - 1.0);
    r += shCoeffs[base + o + 3u] * ${SH_C3[3]} * z * (5.0 * z * z - 3.0);
    r += shCoeffs[base + o + 4u] * ${SH_C3[4]} * x * (5.0 * z * z - 1.0);
    r += shCoeffs[base + o + 5u] * ${SH_C3[5]} * z * (x * x - y * y);
    r += shCoeffs[base + o + 6u] * ${SH_C3[6]} * x * (x * x - 3.0 * y * y);
    g += shCoeffs[base + cpc + o + 0u] * ${SH_C3[0]} * y * (3.0 * x * x - y * y);
    g += shCoeffs[base + cpc + o + 1u] * ${SH_C3[1]} * x * y * z;
    g += shCoeffs[base + cpc + o + 2u] * ${SH_C3[2]} * y * (5.0 * z * z - 1.0);
    g += shCoeffs[base + cpc + o + 3u] * ${SH_C3[3]} * z * (5.0 * z * z - 3.0);
    g += shCoeffs[base + cpc + o + 4u] * ${SH_C3[4]} * x * (5.0 * z * z - 1.0);
    g += shCoeffs[base + cpc + o + 5u] * ${SH_C3[5]} * z * (x * x - y * y);
    g += shCoeffs[base + cpc + o + 6u] * ${SH_C3[6]} * x * (x * x - 3.0 * y * y);
    b += shCoeffs[base + 2u * cpc + o + 0u] * ${SH_C3[0]} * y * (3.0 * x * x - y * y);
    b += shCoeffs[base + 2u * cpc + o + 1u] * ${SH_C3[1]} * x * y * z;
    b += shCoeffs[base + 2u * cpc + o + 2u] * ${SH_C3[2]} * y * (5.0 * z * z - 1.0);
    b += shCoeffs[base + 2u * cpc + o + 3u] * ${SH_C3[3]} * z * (5.0 * z * z - 3.0);
    b += shCoeffs[base + 2u * cpc + o + 4u] * ${SH_C3[4]} * x * (5.0 * z * z - 1.0);
    b += shCoeffs[base + 2u * cpc + o + 5u] * ${SH_C3[5]} * z * (x * x - y * y);
    b += shCoeffs[base + 2u * cpc + o + 6u] * ${SH_C3[6]} * x * (x * x - 3.0 * y * y);
  }

  return vec3<f32>(r, g, b);
}
`;

// ── CPU SH evaluation (for testing / reference) ──

/** Evaluate SH on CPU for a single channel. coeffs = 15 f_rest values for one channel. */
export function evalSHChannelCPU(coeffs: number[], degree: number, dir: [number, number, number]): number {
  const [x, y, z] = dir;
  let result = 0;
  if (degree >= 1) {
    result += coeffs[0] * SH_C1 * y;
    result += coeffs[1] * SH_C1 * z;
    result += coeffs[2] * SH_C1 * x;
  }
  if (degree >= 2) {
    result += coeffs[3] * SH_C2[0] * x * y;
    result += coeffs[4] * SH_C2[1] * y * z;
    result += coeffs[5] * SH_C2[2] * (3 * z * z - 1);
    result += coeffs[6] * SH_C2[3] * x * z;
    result += coeffs[7] * SH_C2[4] * (x * x - y * y);
  }
  if (degree >= 3) {
    result += coeffs[8] * SH_C3[0] * y * (3 * x * x - y * y);
    result += coeffs[9] * SH_C3[1] * x * y * z;
    result += coeffs[10] * SH_C3[2] * y * (5 * z * z - 1);
    result += coeffs[11] * SH_C3[3] * z * (5 * z * z - 3);
    result += coeffs[12] * SH_C3[4] * x * (5 * z * z - 1);
    result += coeffs[13] * SH_C3[5] * z * (x * x - y * y);
    result += coeffs[14] * SH_C3[6] * x * (x * x - 3 * y * y);
  }
  return result;
}
