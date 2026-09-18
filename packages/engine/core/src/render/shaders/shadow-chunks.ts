export const CSM_SHADER_CHUNK = /* wgsl */ `
const MAX_CASCADES = 4u;

struct CSMUniforms {
  cascades: array<mat4x4<f32>, MAX_CASCADES>,
  cascadeSplits: vec4<f32>,
  lightDir: vec4<f32>,
  cascadeCount: vec4<f32>,
};

@group(0) @binding(11) var<uniform> csmUniforms: CSMUniforms;
@group(0) @binding(12) var csmShadowMap: texture_depth_2d_array;
@group(0) @binding(13) var csmSampler: sampler_comparison;

fn selectCascade(viewDepth: f32) -> u32 {
  let count = u32(csmUniforms.cascadeCount.x);
  for (var i = 0u; i < MAX_CASCADES; i++) {
    if (i >= count) { break; }
    if (viewDepth <= csmUniforms.cascadeSplits[i]) {
      return i;
    }
  }
  return count - 1u;
}

fn csmShadowFactor(worldPos: vec3<f32>, viewDepth: f32, N: vec3<f32>) -> f32 {
  let cascadeIdx = selectCascade(viewDepth);
  let lightViewProj = csmUniforms.cascades[cascadeIdx];
  let shadowCoord = lightViewProj * vec4<f32>(worldPos, 1.0);
  let shadowUV = shadowCoord.xy / shadowCoord.w * 0.5 + 0.5;
  let shadowDepth = shadowCoord.z / shadowCoord.w;

  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
    return 1.0;
  }

  let bias = csmUniforms.cascadeCount.y;
  let normalBias = csmUniforms.cascadeCount.z;
  let lightDir = normalize(csmUniforms.lightDir.xyz);
  let slopeScale = clamp(1.0 - dot(N, lightDir), 0.0, 1.0);
  let adjustedBias = bias + normalBias * slopeScale;

  // 3x3 PCF
  var shadow = 0.0;
  let texelSize = 1.0 / f32(textureDimensions(csmShadowMap, 0).x);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
      shadow += textureSampleCompareLevel(
        csmShadowMap, csmSampler,
        shadowUV + offset, cascadeIdx,
        shadowDepth - adjustedBias,
      );
    }
  }
  shadow = shadow / 9.0;

  // Cascade blend
  let blendDist = csmUniforms.cascadeCount.w;
  let cascadeFar = csmUniforms.cascadeSplits[cascadeIdx];
  let distToEdge = cascadeFar - viewDepth;
  if (distToEdge < blendDist && cascadeIdx < count - 1u) {
    let blendFactor = distToEdge / blendDist;
    let nextIdx = cascadeIdx + 1u;
    let nextVP = csmUniforms.cascades[nextIdx];
    let nextCoord = nextVP * vec4<f32>(worldPos, 1.0);
    let nextUV = nextCoord.xy / nextCoord.w * 0.5 + 0.5;
    let nextDepth = nextCoord.z / nextCoord.w;
    if (nextUV.x >= 0.0 && nextUV.x <= 1.0 && nextUV.y >= 0.0 && nextUV.y <= 1.0) {
      var nextShadow = 0.0;
      for (var y2 = -1; y2 <= 1; y2++) {
        for (var x2 = -1; x2 <= 1; x2++) {
          let offset2 = vec2<f32>(f32(x2), f32(y2)) * texelSize;
          nextShadow += textureSampleCompareLevel(
            csmShadowMap, csmSampler,
            nextUV + offset2, nextIdx,
            nextDepth - adjustedBias,
          );
        }
      }
      nextShadow = nextShadow / 9.0;
      shadow = mix(nextShadow, shadow, blendFactor);
    }
  }

  return shadow;
}
`;

export const POINT_SHADOW_SHADER_CHUNK = /* wgsl */ `
const MAX_POINT_LIGHT_SHADOWS = 4u;

@group(0) @binding(14) var pointShadowMaps: array<texture_depth_cube, MAX_POINT_LIGHT_SHADOWS>;
@group(0) @binding(15) var pointShadowSampler: sampler_comparison;

fn pointLightShadow(worldPos: vec3<f32>, lightPos: vec3<f32>, lightIndex: u32, farPlane: f32) -> f32 {
  let toLight = worldPos - lightPos;
  let dist = length(toLight);
  let dir = toLight / max(dist, 0.001);
  let normalizedDepth = dist / farPlane;
  let bias = 0.01;
  return textureSampleCompareLevel(
    pointShadowMaps[lightIndex], pointShadowSampler,
    dir, normalizedDepth - bias,
  );
}
`;

export const SPOT_SHADOW_SHADER_CHUNK = /* wgsl */ `
const MAX_SPOT_LIGHT_SHADOWS = 4u;

struct SpotShadowData {
  viewProjs: array<mat4x4<f32>, MAX_SPOT_LIGHT_SHADOWS>,
};

@group(0) @binding(16) var<uniform> spotShadowData: SpotShadowData;
@group(0) @binding(17) var spotShadowMaps: texture_depth_2d_array;
@group(0) @binding(18) var spotShadowSampler: sampler_comparison;

fn spotLightShadow(worldPos: vec3<f32>, lightIndex: u32) -> f32 {
  let vp = spotShadowData.viewProjs[lightIndex];
  let shadowCoord = vp * vec4<f32>(worldPos, 1.0);
  let shadowUV = shadowCoord.xy / shadowCoord.w * 0.5 + 0.5;
  let shadowDepth = shadowCoord.z / shadowCoord.w;
  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
    return 1.0;
  }
  let bias = 0.001;
  return textureSampleCompareLevel(
    spotShadowMaps, spotShadowSampler,
    shadowUV, lightIndex,
    shadowDepth - bias,
  );
}
`;
