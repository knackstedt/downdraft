// ============================================================================
// Bindless WGSL chunks — shared shader declarations for the bindless model
//
// The bindless material bind group is @group(3). Pipelines that opt into
// bindless materials include BINDLESS_MATERIAL_CHUNK and use `sampleMaterial()`.
// The per-draw `materialIndex` is provided as a vertex/instance attribute by
// the renderer (see @location(K) materialIndex in the renderer's vertex shader).
// ============================================================================

import { BindlessMaterialStruct } from "./bindless-struct";

/**
 * WGSL struct + bind group declarations for bindless materials.
 *
 * The `struct BindlessMaterial` declaration is emitted from
 * `BindlessMaterialStruct` (bindless-struct.ts) — the single source of truth
 * shared with `BindlessMaterialManager.writeMaterial()`. Texture handles are
 * u32 packed as (arrayIndex << 16) | layerIndex.
 *
 * `MAX_ARRAYS_PER_SLOT` must match `BindlessTextureRegistry.maxArrayBindingsPerFormat`.
 * The default is 8; override by string-replacing before injection if needed.
 */
export const BINDLESS_MATERIAL_CHUNK = /* wgsl */ `
${BindlessMaterialStruct.wgsl}

@group(3) @binding(0) var<storage, read> bindlessMaterials: array<BindlessMaterial>;

// WGSL does not allow array<texture_2d_array<f32>, N>. Each texture array page
// must be a separate @binding. The bind group layout creates 8 bindings (1..8)
// + 2 samplers (9, 10). The handle's arrayIndex selects which binding to use
// via the sampleBindlessArray switch function.
@group(3) @binding(1) var albedoArray0: texture_2d_array<f32>;
@group(3) @binding(2) var albedoArray1: texture_2d_array<f32>;
@group(3) @binding(3) var albedoArray2: texture_2d_array<f32>;
@group(3) @binding(4) var albedoArray3: texture_2d_array<f32>;
@group(3) @binding(5) var albedoArray4: texture_2d_array<f32>;
@group(3) @binding(6) var albedoArray5: texture_2d_array<f32>;
@group(3) @binding(7) var albedoArray6: texture_2d_array<f32>;
@group(3) @binding(8) var albedoArray7: texture_2d_array<f32>;
@group(3) @binding(9) var bindlessSamplerRepeat: sampler;
@group(3) @binding(10) var bindlessSamplerClamp: sampler;

fn unpackArrayIndex(handle: u32) -> u32 { return (handle >> 16u) & 0xFFFFu; }
fn unpackLayerIndex(handle: u32) -> u32 { return handle & 0xFFFFu; }

/// Sample a texture_2d_array by global array index (0..7). WGSL can't index
/// into an array of textures, so we use a switch.
fn sampleBindlessArray(arr: u32, uv: vec2<f32>, layer: u32) -> vec4<f32> {
  switch (arr) {
    case 0u: { return textureSample(albedoArray0, bindlessSamplerRepeat, uv, layer); }
    case 1u: { return textureSample(albedoArray1, bindlessSamplerRepeat, uv, layer); }
    case 2u: { return textureSample(albedoArray2, bindlessSamplerRepeat, uv, layer); }
    case 3u: { return textureSample(albedoArray3, bindlessSamplerRepeat, uv, layer); }
    case 4u: { return textureSample(albedoArray4, bindlessSamplerRepeat, uv, layer); }
    case 5u: { return textureSample(albedoArray5, bindlessSamplerRepeat, uv, layer); }
    case 6u: { return textureSample(albedoArray6, bindlessSamplerRepeat, uv, layer); }
    case 7u: { return textureSample(albedoArray7, bindlessSamplerRepeat, uv, layer); }
    default: { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
  }
}

/// Sample the albedo texture of a material at the given UV.
fn sampleAlbedo(materialIndex: u32, uv: vec2<f32>) -> vec4<f32> {
  let m = bindlessMaterials[materialIndex];
  let arr = unpackArrayIndex(m.albedoTex);
  let layer = unpackLayerIndex(m.albedoTex);
  return sampleBindlessArray(arr, uv, layer);
}

/// Sample the normal texture of a material at the given UV.
fn sampleNormal(materialIndex: u32, uv: vec2<f32>) -> vec4<f32> {
  let m = bindlessMaterials[materialIndex];
  let arr = unpackArrayIndex(m.normalTex);
  let layer = unpackLayerIndex(m.normalTex);
  return sampleBindlessArray(arr, uv, layer);
}

/// Sample the metallic-roughness texture of a material at the given UV.
fn sampleMetallicRoughness(materialIndex: u32, uv: vec2<f32>) -> vec4<f32> {
  let m = bindlessMaterials[materialIndex];
  let arr = unpackArrayIndex(m.metallicRoughnessTex);
  let layer = unpackLayerIndex(m.metallicRoughnessTex);
  return sampleBindlessArray(arr, uv, layer);
}

/// Sample the AO texture of a material at the given UV. AO and emissive share
/// a packed u32 (low 16 = ao, high 16 = emissive).
fn sampleAO(materialIndex: u32, uv: vec2<f32>) -> vec4<f32> {
  let m = bindlessMaterials[materialIndex];
  let aoHandle = m.aoEmissiveTex & 0xFFFFu;
  let arr = unpackArrayIndex(aoHandle);
  let layer = unpackLayerIndex(aoHandle);
  return sampleBindlessArray(arr, uv, layer);
}

/// Sample the emissive texture of a material at the given UV.
fn sampleEmissive(materialIndex: u32, uv: vec2<f32>) -> vec4<f32> {
  let m = bindlessMaterials[materialIndex];
  let emHandle = (m.aoEmissiveTex >> 16u) & 0xFFFFu;
  let arr = unpackArrayIndex(emHandle);
  let layer = unpackLayerIndex(emHandle);
  return sampleBindlessArray(arr, uv, layer);
}

/// Get the material struct for a draw.
fn getMaterial(materialIndex: u32) -> BindlessMaterial {
  return bindlessMaterials[materialIndex];
}

/// Apply KHR_texture_transform to a UV coordinate. Returns the original UV
/// if the material has no texture transform (hasTexTransform <= 0.5).
fn applyTexTransform(m: BindlessMaterial, uv: vec2<f32>) -> vec2<f32> {
  if (m.hasTexTransform <= 0.5) {
    return uv;
  }
  let cosR = cos(m.texRotation);
  let sinR = sin(m.texRotation);
  let scaled = uv * m.texScale;
  return vec2<f32>(
    cosR * scaled.x - sinR * scaled.y + m.texOffset.x,
    sinR * scaled.x + cosR * scaled.y + m.texOffset.y,
  );
}
`;

/**
 * Just the texture bindings + switch sampler (no material struct or sampling
 * helpers). Use this in shaders that declare their own BindlessMaterial struct
 * and sampling logic but need the texture_2d_array bindings + sampleBindlessArray.
 */
export const BINDLESS_TEXTURE_BINDINGS_CHUNK = /* wgsl */ `
@group(3) @binding(1) var albedoArray0: texture_2d_array<f32>;
@group(3) @binding(2) var albedoArray1: texture_2d_array<f32>;
@group(3) @binding(3) var albedoArray2: texture_2d_array<f32>;
@group(3) @binding(4) var albedoArray3: texture_2d_array<f32>;
@group(3) @binding(5) var albedoArray4: texture_2d_array<f32>;
@group(3) @binding(6) var albedoArray5: texture_2d_array<f32>;
@group(3) @binding(7) var albedoArray6: texture_2d_array<f32>;
@group(3) @binding(8) var albedoArray7: texture_2d_array<f32>;
@group(3) @binding(9) var bindlessSamplerRepeat: sampler;
@group(3) @binding(10) var bindlessSamplerClamp: sampler;

fn unpackArrayIndex(handle: u32) -> u32 { return (handle >> 16u) & 0xFFFFu; }
fn unpackLayerIndex(handle: u32) -> u32 { return handle & 0xFFFFu; }

fn sampleBindlessArray(arr: u32, uv: vec2<f32>, layer: u32) -> vec4<f32> {
  switch (arr) {
    case 0u: { return textureSample(albedoArray0, bindlessSamplerRepeat, uv, layer); }
    case 1u: { return textureSample(albedoArray1, bindlessSamplerRepeat, uv, layer); }
    case 2u: { return textureSample(albedoArray2, bindlessSamplerRepeat, uv, layer); }
    case 3u: { return textureSample(albedoArray3, bindlessSamplerRepeat, uv, layer); }
    case 4u: { return textureSample(albedoArray4, bindlessSamplerRepeat, uv, layer); }
    case 5u: { return textureSample(albedoArray5, bindlessSamplerRepeat, uv, layer); }
    case 6u: { return textureSample(albedoArray6, bindlessSamplerRepeat, uv, layer); }
    case 7u: { return textureSample(albedoArray7, bindlessSamplerRepeat, uv, layer); }
    default: { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
  }
}
`;

/**
 * Vertex attribute declaration for the per-draw materialIndex. Renderers add
 * this to their vertex buffer layout at the given location.
 */
export function materialIndexAttribute(location: number): string {
  return `@location(${location}) materialIndex: u32,`;
}
