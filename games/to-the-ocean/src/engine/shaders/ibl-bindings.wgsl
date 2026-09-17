// IBL bindings + sampling helpers for entity shaders (group 2, with BRDF LUT).
// This file is the runtime source for PBR_BINDINGS in entity-shaders.ts — keep
// it in sync with createIBLShaderChunk(2, true) in @downdraft/core
// (packages/core/src/render/ibl-bind-group.ts).

struct IBLUniforms {
  maxMipLevel: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(2) @binding(0) var irradianceMap: texture_cube<f32>;
@group(2) @binding(1) var prefilterMap: texture_cube<f32>;
@group(2) @binding(2) var brdfLUT: texture_2d<f32>;
@group(2) @binding(3) var irradianceSampler: sampler;
@group(2) @binding(4) var prefilterSampler: sampler;
@group(2) @binding(5) var brdfSampler: sampler;
@group(2) @binding(6) var<uniform> iblUniforms: IBLUniforms;

fn getIBLDiffuse(N: vec3<f32>) -> vec3<f32> {
  return textureSample(irradianceMap, irradianceSampler, N).rgb;
}

fn getIBLSpecular(N: vec3<f32>, R: vec3<f32>, roughness: f32) -> vec3<f32> {
  let lod = roughness * iblUniforms.maxMipLevel;
  let prefilteredColor = textureSampleLevel(prefilterMap, prefilterSampler, R, lod);
  let brdf = textureSample(brdfLUT, brdfSampler, vec2<f32>(max(dot(N, vec3<f32>(0.0, 0.0, 1.0)), 0.0), roughness)).rg;
  return prefilteredColor.rgb * (brdf.x + brdf.y);
}
