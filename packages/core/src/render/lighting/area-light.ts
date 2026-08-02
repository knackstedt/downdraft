import type { Vec3 } from "wgpu-matrix";

export type AreaLightShape = "rect" | "disk" | "line";

export interface AreaLightData {
  position: Vec3;
  direction: Vec3;
  up: Vec3;
  width: number;
  height: number;
  color: Vec3;
  intensity: number;
  shape: AreaLightShape;
  range: number;
}

export interface LTCTextureSet {
  texture0: GPUTexture | null;
  texture1: GPUTexture | null;
  view0: GPUTextureView | null;
  view1: GPUTextureView | null;
  sampler: GPUSampler | null;
}

export const LTC_LUT_SIZE = 64;

export function generateLTCLUTData(size: number = LTC_LUT_SIZE): {
  lut0: Float32Array;
  lut1: Float32Array;
} {
  const lut0 = new Float32Array(size * size * 4);
  const lut1 = new Float32Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const roughness = (x + 0.5) / size;
      const NdotV = (y + 0.5) / size;

      const theta = Math.acos(Math.max(NdotV, 0.001));
      const a = roughness * roughness;

      // Simplified LTC approximation
      // M0 (scale), M1 (bias), M2 (a), M3 (b) for the BRDF
      const m11 = 1.0 / (1.0 + a);
      const m22 = 1.0 / (1.0 + a * Math.cos(theta) * Math.cos(theta));
      const m13 = a * Math.sin(theta) * Math.cos(theta) * m11;
      const m31 = -a * Math.sin(theta) * Math.cos(theta) * m22;

      const det = m11 * m22 - m13 * m31;

      const idx = (y * size + x) * 4;
      lut0[idx] = m22 / det;
      lut0[idx + 1] = -m13 / det;
      lut0[idx + 2] = m31 / det;
      lut0[idx + 3] = m11 / det;

      // Amplitude (normalization factor)
      lut1[idx] = m11 * m22 - m13 * m31;
      lut1[idx + 1] = 0;
      lut1[idx + 2] = 0;
      lut1[idx + 3] = 0;
    }
  }

  return { lut0, lut1 };
}

export function createLTCTextures(
  device: GPUDevice,
  size: number = LTC_LUT_SIZE,
): LTCTextureSet {
  const { lut0, lut1 } = generateLTCLUTData(size);

  const tex0 = device.createTexture({
    label: "ltc-lut0",
    size: [size, size],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const tex1 = device.createTexture({
    label: "ltc-lut1",
    size: [size, size],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture: tex0 },
    lut0 as unknown as BufferSource,
    { bytesPerRow: size * 8, rowsPerImage: size },
    [size, size],
  );
  device.queue.writeTexture(
    { texture: tex1 },
    lut1 as unknown as BufferSource,
    { bytesPerRow: size * 8, rowsPerImage: size },
    [size, size],
  );

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  return {
    texture0: tex0,
    texture1: tex1,
    view0: tex0.createView(),
    view1: tex1.createView(),
    sampler,
  };
}

export const LTC_SHADER_CHUNK = /* wgsl */ `
struct LTCUniforms {
  ltcLut0: texture_2d<f32>,
  ltcLut1: texture_2d<f32>,
  ltcSampler: sampler,
};

fn ltcEvaluateRect(
  N: vec3<f32>,
  V: vec3<f32>,
  P: vec3<f32>,
  lightPos: vec3<f32>,
  lightRight: vec3<f32>,
  lightUp: vec3<f32>,
  lightForward: vec3<f32>,
  width: f32,
  height: f32,
  ltcMat: texture_2d<f32>,
  ltcAmp: texture_2d<f32>,
  ltcSampler: sampler,
) -> vec3<f32> {
  let NdotV = max(dot(N, V), 0.001);
  let theta = acos(NdotV);

  // Sample LTC LUT
  let uv = vec2<f32>(0.5, theta / 3.14159265 * 0.5);
  let M = textureSample(ltcMat, ltcSampler, uv);
  let amp = textureSample(ltcAmp, ltcSampler, uv);

  // LTC matrix (3x3 stored as vec4 + 2 extra)
  let mInv = mat3x3<f32>(
    vec3<f32>(M.x, 0.0, M.z),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(M.w, 0.0, M.y),
  );

  // Transform the rect vertices into LTC space
  let halfW = width * 0.5;
  let halfH = height * 0.5;
  let center = lightPos + lightForward * 0.01;

  let points = array<vec3<f32>, 4>(
    center - lightRight * halfW - lightUp * halfH,
    center + lightRight * halfW - lightUp * halfH,
    center + lightRight * halfW + lightUp * halfH,
    center - lightRight * halfW + lightUp * halfH,
  );

  // Transform points to LTC space (relative to fragment)
  var ltcPoints = array<vec3<f32>, 4>();
  for (var i = 0u; i < 4u; i = i + 1u) {
    ltcPoints[i] = mInv * (points[i] - P);
  }

  // Clip behind the tangent plane
  let ltcNormal = normalize(mInv * N);
  for (var i = 0u; i < 4u; i = i + 1u) {
    ltcPoints[i] = ltcPoints[i] - ltcNormal * min(0.0, dot(ltcPoints[i], ltcNormal)) * 1.01;
  }

  // Compute solid angle using the formula for polygon irradiance
  // Sum of edges
  var sum = vec3<f32>(0.0);
  for (var i = 0u; i < 4u; i = i + 1u) {
    let v1 = ltcPoints[i];
    let v2 = ltcPoints[(i + 1u) % 4u];
    let dist1 = length(v1);
    let dist2 = length(v2);
    let n1 = v1 / dist1;
    let n2 = v2 / dist2;
    let cosAlpha = dot(n1, n2);
    let alpha = acos(clamp(cosAlpha, -1.0, 1.0));
    let cross = cross(n1, n2);
    let cosBeta = dot(normalize(cross), ltcNormal);
    sum = sum + cross * alpha * cosBeta / max(dist1 * dist2, 0.001);
  }

  let irradiance = abs(sum) * amp.x;
  return irradiance;
}
`;
