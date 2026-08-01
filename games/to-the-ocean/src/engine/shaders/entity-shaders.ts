// ============================================================================
// Entity Renderer WGSL Shaders
// Extracted from EntityRenderer.ts — all shader constants for entity rendering
// ============================================================================

import { createIBLShaderChunk } from "@downdraft/core";
import { BoatCellType, MAX_BONES } from "@shared/constants";

export const LIGHT_STRUCTS = /* wgsl */ `
const MAX_POINT_LIGHTS = 32u;
const MAX_SPOT_LIGHTS = 8u;

struct PointLight {
  position: vec3<f32>,
  radius: f32,
  color: vec3<f32>,
  intensity: f32,
};

struct SpotLight {
  position: vec3<f32>,
  radius: f32,
  direction: vec3<f32>,
  cosInner: f32,
  color: vec3<f32>,
  cosOuter: f32,
  intensity: f32,
  _pad: f32,
};

struct LightStorage {
  numPointLights: u32,
  numSpotLights: u32,
  _pad0: u32,
  _pad1: u32,
  pointLights: array<PointLight, MAX_POINT_LIGHTS>,
  spotLights: array<SpotLight, MAX_SPOT_LIGHTS>,
};

@group(1) @binding(0) var<storage, read> lightData: LightStorage;

fn applyDynamicLights(N: vec3<f32>, worldPos: vec3<f32>, viewDir: vec3<f32>,
                      specPower: f32, specIntensity: f32) -> vec3<f32> {
  var color = vec3<f32>(0.0);

  let numPoint = lightData.numPointLights;
  for (var i = 0u; i < MAX_POINT_LIGHTS; i++) {
    if (i >= numPoint) { break; }
    let light = lightData.pointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let atten = 1.0 - smoothstep(0.0, light.radius, dist);
    let diff = max(dot(N, L), 0.0);
    color += light.color * diff * light.intensity * atten;

    let halfDir = normalize(L + viewDir);
    let NdotH = max(dot(N, halfDir), 0.0);
    color += light.color * pow(NdotH, specPower) * specIntensity * light.intensity * atten;
  }

  let numSpot = lightData.numSpotLights;
  for (var i = 0u; i < MAX_SPOT_LIGHTS; i++) {
    if (i >= numSpot) { break; }
    let light = lightData.spotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let spotCos = dot(-L, light.direction);
    if (spotCos < light.cosOuter) { continue; }
    let spotAtten = smoothstep(light.cosOuter, light.cosInner, spotCos);
    let atten = (1.0 - smoothstep(0.0, light.radius, dist)) * spotAtten;
    let diff = max(dot(N, L), 0.0);
    color += light.color * diff * light.intensity * atten;

    let halfDir = normalize(L + viewDir);
    let NdotH = max(dot(N, halfDir), 0.0);
    color += light.color * pow(NdotH, specPower) * specIntensity * light.intensity * atten;
  }

  return color;
}
`;

// IBL bind group declarations — bound at group 2 for all lit pipelines.
// Provides irradiance cubemap, prefiltered specular cubemap, BRDF LUT, and samplers.
export const PBR_BINDINGS = createIBLShaderChunk(2, true);

// PBR constant PI
export const PBR_CONST = /* wgsl */ `
const PI: f32 = 3.14159265359;
`;

// PBR Cook-Torrance BRDF functions — shared across all lit entity shaders.
// Replaces the old Blinn-Phong model with physically-based direct + image-based lighting.
export const PBR_FUNCTIONS = /* wgsl */ `
${PBR_CONST}

// Per-entity-type PBR material parameters: (metallic, roughness)
fn getPBRParams(entityType: u32) -> vec2<f32> {
  switch (entityType) {
    case 0u: { return vec2<f32>(0.0, 0.6); }   // Player — skin/cloth, non-metal, medium rough
    case 1u: { return vec2<f32>(0.3, 0.5); }   // Ship — wood with metal fittings
    case 2u: { return vec2<f32>(0.2, 0.6); }   // SmallCraft — wood
    case 3u: { return vec2<f32>(0.0, 0.3); }   // Fish — wet/smooth organic
    case 4u: { return vec2<f32>(0.0, 0.25); }  // Shark — wet/smooth organic
    case 5u: { return vec2<f32>(0.0, 0.35); }  // Eel
    case 6u: { return vec2<f32>(0.0, 0.2); }   // Jellyfish — translucent/glossy
    case 7u: { return vec2<f32>(0.0, 0.4); }   // DevilShrimp
    case 8u: { return vec2<f32>(0.0, 0.3); }   // Whale
    case 9u: { return vec2<f32>(0.0, 0.25); }  // Dolphin
    case 10u: { return vec2<f32>(0.0, 0.5); }  // Turtle
    case 11u: { return vec2<f32>(0.1, 0.45); } // Crustacean — shell, slight metal
    case 12u: { return vec2<f32>(0.0, 0.4); }  // Coral — matte organic
    case 14u: { return vec2<f32>(0.0, 0.6); }  // Pirate
    case 15u: { return vec2<f32>(0.4, 0.55); } // PirateShip — weathered wood/metal
    case 16u: { return vec2<f32>(0.0, 0.8); }  // Island — handled separately in islandLighting
    case 17u: { return vec2<f32>(0.1, 0.5); }  // Port — stone/wood
    default: { return vec2<f32>(0.0, 0.5); }
  }
}

// GGX/Trowbridge-Reitz normal distribution function
fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH = max(dot(N, H), 0.0);
  let NdotH2 = NdotH * NdotH;
  let nom = a2;
  let denom = (NdotH2 * (a2 - 1.0) + 1.0);
  let denom2 = denom * denom;
  return nom / max(denom2, 0.0001);
}

// Schlick-Beckmann geometry function (direct lighting)
fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

// Smith's method for combining geometry functions
fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  let ggx2 = geometrySchlickGGX(NdotV, roughness);
  let ggx1 = geometrySchlickGGX(NdotL, roughness);
  return ggx1 * ggx2;
}

// Schlick Fresnel approximation
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Fresnel with roughness term for IBL (used for environment specular)
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Cook-Torrance specular BRDF for a single light direction
fn cookTorranceSpecular(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>,
                         F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let H = normalize(V + L);
  let NDF = distributionGGX(N, H, roughness);
  let G = geometrySmith(N, V, L, roughness);
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  let F = fresnelSchlick(VdotH, F0);
  let numerator = NDF * G * F;
  let denominator = 4.0 * NdotV * NdotL + 0.0001;
  return numerator / denominator;
}

// PBR dynamic lights using Cook-Torrance for specular and Lambert for diffuse
fn applyPBRDynamicLights(N: vec3<f32>, worldPos: vec3<f32>, V: vec3<f32>,
                          albedo: vec3<f32>, F0: vec3<f32>, roughness: f32, metallic: f32) -> vec3<f32> {
  var color = vec3<f32>(0.0);

  let numPoint = lightData.numPointLights;
  for (var i = 0u; i < MAX_POINT_LIGHTS; i++) {
    if (i >= numPoint) { break; }
    let light = lightData.pointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let atten = 1.0 - smoothstep(0.0, light.radius, dist);
    let NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) { continue; }

    let radiance = light.color * light.intensity * atten;
    let kD = (1.0 - metallic) * (1.0 / PI);
    let diffuse = albedo * kD * NdotL * radiance;
    let spec = cookTorranceSpecular(N, V, L, F0, roughness) * NdotL * radiance;
    color += diffuse + spec;
  }

  let numSpot = lightData.numSpotLights;
  for (var i = 0u; i < MAX_SPOT_LIGHTS; i++) {
    if (i >= numSpot) { break; }
    let light = lightData.spotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let spotCos = dot(-L, light.direction);
    if (spotCos < light.cosOuter) { continue; }
    let spotAtten = smoothstep(light.cosOuter, light.cosInner, spotCos);
    let atten = (1.0 - smoothstep(0.0, light.radius, dist)) * spotAtten;
    let NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) { continue; }

    let radiance = light.color * light.intensity * atten;
    let kD = (1.0 - metallic) * (1.0 / PI);
    let diffuse = albedo * kD * NdotL * radiance;
    let spec = cookTorranceSpecular(N, V, L, F0, roughness) * NdotL * radiance;
    color += diffuse + spec;
  }

  return color;
}
`;

// Shared PBR lighting function — Cook-Torrance direct lighting + IBL (irradiance + prefiltered specular) + fog.
// Uses uniforms struct (sunDirIntensity, ambientParams, fogColor, cameraPos, time, entityFlags).
export const LIGHTING_FN = /* wgsl */ `
${LIGHT_STRUCTS}
${PBR_FUNCTIONS}
${PBR_BINDINGS}
fn entityLighting(N: vec3<f32>, worldPos: vec3<f32>, baseColor: vec3<f32>) -> vec3<f32> {
  let sunDir = normalize(uniforms.sunDirIntensity.xyz);
  let sunIntensity = uniforms.sunDirIntensity.w;
  let ambientLevel = uniforms.ambientParams.x;

  let pbrParams = getPBRParams(uniforms.entityType);
  let metallic = pbrParams.x;
  let roughness = pbrParams.y;

  let albedo = baseColor;
  let V = normalize(uniforms.cameraPos - worldPos);
  let NdotV = max(dot(N, V), 0.0);

  // F0 — dielectric reflectance at normal incidence, metal uses albedo as F0
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);

  // --- Direct lighting (sun) ---
  let L = sunDir;
  let NdotL = max(dot(N, L), 0.0);
  let radiance = vec3<f32>(sunIntensity);

  let kD = (1.0 - metallic) * (1.0 / PI);
  let diffuse = albedo * kD * NdotL * radiance;
  let spec = cookTorranceSpecular(N, V, L, F0, roughness) * NdotL * radiance;
  var color = diffuse + spec;

  // --- Image-based lighting (IBL) from captured environment ---
  let R = reflect(-V, N);
  let irradiance = getIBLDiffuse(N) * ambientLevel;
  let kD_ibl = (1.0 - metallic) * (1.0 / PI);
  color += albedo * kD_ibl * irradiance;

  let F_ibl = fresnelSchlickRoughness(NdotV, F0, roughness);
  let specIBL = getIBLSpecular(N, R, roughness) * F_ibl * ambientLevel;
  color += specIBL;

  // --- Dynamic point/spot lights (PBR) ---
  color += applyPBRDynamicLights(N, worldPos, V, albedo, F0, roughness, metallic);

  // Bioluminescent emissive — self-illumination for glowing entities (jellyfish, etc.)
  if ((uniforms.entityFlags & 512u) != 0u) {
    let pulse = 0.6 + 0.4 * sin(uniforms.time * 2.0);
    color += vec3<f32>(0.2, 0.8, 1.0) * pulse * 0.5;
  }

  // Fog
  let dist = length(uniforms.cameraPos - worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, uniforms.fogColor.xyz, fogFactor);

  return color;
}
`;

// Shared uniform struct extension — appended to each shader's uniform struct
export const LIGHTING_UNIFORMS = /* wgsl */ `
  wetness: f32,
  _pad3: f32,
  sunDirIntensity: vec4<f32>,
  ambientParams: vec4<f32>,
  fogColor: vec4<f32>,
`;

export const ENTITY_WGSL = /* wgsl */ `
${LIGHTING_FN}
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,${LIGHTING_UNIFORMS}
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

fn getTypeColor(entityType: u32) -> vec3<f32> {
  switch (entityType) {
    case 0u: { return vec3<f32>(0.8, 0.6, 0.4); } // Player
    case 1u: { return vec3<f32>(0.45, 0.35, 0.25); } // Ship
    case 2u: { return vec3<f32>(0.6, 0.5, 0.4); } // SmallCraft
    case 3u: { return vec3<f32>(0.8, 0.7, 0.3); } // Fish
    case 4u: { return vec3<f32>(0.3, 0.3, 0.4); } // Shark
    case 5u: { return vec3<f32>(0.2, 0.2, 0.3); } // Eel
    case 6u: { return vec3<f32>(0.9, 0.8, 1.0); } // Jellyfish
    case 7u: { return vec3<f32>(0.5, 0.1, 0.1); } // DevilShrimp
    case 8u: { return vec3<f32>(0.2, 0.3, 0.5); } // Whale
    case 9u: { return vec3<f32>(0.6, 0.7, 0.8); } // Dolphin
    case 10u: { return vec3<f32>(0.4, 0.5, 0.3); } // Turtle
    case 11u: { return vec3<f32>(0.7, 0.6, 0.4); } // Crustacean
    case 12u: { return vec3<f32>(0.9, 0.5, 0.5); } // Coral
    case 14u: { return vec3<f32>(0.3, 0.1, 0.1); } // Pirate
    case 15u: { return vec3<f32>(0.2, 0.1, 0.05); } // PirateShip
    case 16u: { return vec3<f32>(0.3, 0.5, 0.2); } // Island
    case 17u: { return vec3<f32>(0.6, 0.5, 0.3); } // Port
    default: { return vec3<f32>(0.5, 0.5, 0.5); }
  }
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));

  let baseColor = getTypeColor(uniforms.entityType);
  // yFactor gradient is designed for cube entities; skip for player model (type 0)
  var yFactor = 0.6 + 0.4 * smoothstep(-0.3, 0.3, input.position.y);
  if (uniforms.entityType == 0u) {
    yFactor = 0.9;
  }
  output.color = baseColor * yFactor;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  var color = entityLighting(N, input.worldPos, input.color);
  return vec4<f32>(color, 1.0);
}
`;

export const INSTANCED_ENTITY_WGSL = /* wgsl */ `
${LIGHT_STRUCTS}
${PBR_FUNCTIONS}
${PBR_BINDINGS}

struct FrameUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  sunDirIntensity: vec4<f32>,
  ambientParams: vec4<f32>,
  fogColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame: FrameUniforms;

struct InstanceData {
  pos: vec3<f32>,
  scale: f32,
  rot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,
  _pad: vec2<f32>,
};

@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) @interpolate(flat) entityType: u32,
  @location(4) @interpolate(flat) entityFlags: u32,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

fn getTypeColorInstanced(entityType: u32) -> vec3<f32> {
  switch (entityType) {
    case 0u: { return vec3<f32>(0.8, 0.6, 0.4); }
    case 1u: { return vec3<f32>(0.45, 0.35, 0.25); }
    case 2u: { return vec3<f32>(0.6, 0.5, 0.4); }
    case 3u: { return vec3<f32>(0.8, 0.7, 0.3); }
    case 4u: { return vec3<f32>(0.3, 0.3, 0.4); }
    case 5u: { return vec3<f32>(0.2, 0.2, 0.3); }
    case 6u: { return vec3<f32>(0.9, 0.8, 1.0); }
    case 7u: { return vec3<f32>(0.5, 0.1, 0.1); }
    case 8u: { return vec3<f32>(0.2, 0.3, 0.5); }
    case 9u: { return vec3<f32>(0.6, 0.7, 0.8); }
    case 10u: { return vec3<f32>(0.4, 0.5, 0.3); }
    case 11u: { return vec3<f32>(0.7, 0.6, 0.4); }
    case 12u: { return vec3<f32>(0.9, 0.5, 0.5); }
    case 14u: { return vec3<f32>(0.3, 0.1, 0.1); }
    case 15u: { return vec3<f32>(0.2, 0.1, 0.05); }
    case 16u: { return vec3<f32>(0.3, 0.5, 0.2); }
    case 17u: { return vec3<f32>(0.6, 0.5, 0.3); }
    default: { return vec3<f32>(0.5, 0.5, 0.5); }
  }
}

fn instancedEntityLighting(N: vec3<f32>, worldPos: vec3<f32>, baseColor: vec3<f32>,
                            entityType: u32, entityFlags: u32) -> vec3<f32> {
  let sunDir = normalize(frame.sunDirIntensity.xyz);
  let sunIntensity = frame.sunDirIntensity.w;
  let ambientLevel = frame.ambientParams.x;

  let pbrParams = getPBRParams(entityType);
  let metallic = pbrParams.x;
  let roughness = pbrParams.y;

  let albedo = baseColor;
  let V = normalize(frame.cameraPos - worldPos);
  let NdotV = max(dot(N, V), 0.0);

  let F0 = mix(vec3<f32>(0.04), albedo, metallic);

  // Direct lighting (sun)
  let L = sunDir;
  let NdotL = max(dot(N, L), 0.0);
  let radiance = vec3<f32>(sunIntensity);
  let kD = (1.0 - metallic) * (1.0 / PI);
  let diffuse = albedo * kD * NdotL * radiance;
  let spec = cookTorranceSpecular(N, V, L, F0, roughness) * NdotL * radiance;
  var color = diffuse + spec;

  // IBL from captured environment
  let R = reflect(-V, N);
  let irradiance = getIBLDiffuse(N) * ambientLevel;
  let kD_ibl = (1.0 - metallic) * (1.0 / PI);
  color += albedo * kD_ibl * irradiance;

  let F_ibl = fresnelSchlickRoughness(NdotV, F0, roughness);
  let specIBL = getIBLSpecular(N, R, roughness) * F_ibl * ambientLevel;
  color += specIBL;

  // Dynamic lights (PBR)
  color += applyPBRDynamicLights(N, worldPos, V, albedo, F0, roughness, metallic);

  if ((entityFlags & 512u) != 0u) {
    let pulse = 0.6 + 0.4 * sin(frame.time * 2.0);
    color += vec3<f32>(0.2, 0.8, 1.0) * pulse * 0.5;
  }

  let dist = length(frame.cameraPos - worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, frame.fogColor.xyz, fogFactor);

  return color;
}

@vertex
fn vs_main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  var output: VertexOutput;
  let inst = instances[instIdx];
  let scaled = input.position * inst.scale;
  let rotated = qrotate(inst.rot, scaled);
  let worldPos = rotated + inst.pos;
  output.worldPos = worldPos;
  output.clipPos = frame.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(inst.rot, input.normal));

  let baseColor = getTypeColorInstanced(inst.entityType);
  var yFactor = 0.6 + 0.4 * smoothstep(-0.3, 0.3, input.position.y);
  if (inst.entityType == 0u) {
    yFactor = 0.9;
  }
  output.color = baseColor * yFactor;
  output.entityType = inst.entityType;
  output.entityFlags = inst.entityFlags;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  var color = instancedEntityLighting(N, input.worldPos, input.color, input.entityType, input.entityFlags);
  return vec4<f32>(color, 1.0);
}
`;

export const PLAYER_WGSL = /* wgsl */ `
${LIGHTING_FN}
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,${LIGHTING_UNIFORMS}
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var playerSampler: sampler;
@group(0) @binding(2) var playerTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let texColor = textureSample(playerTexture, playerSampler, input.uv);
  var color = entityLighting(N, input.worldPos, texColor.rgb * input.color);
  return vec4<f32>(color, 1.0);
}
`;

export const SKINNING_COMPUTE_WGSL = /* wgsl */ `
const MAX_CHAIN_LEN: u32 = 32u;

struct SkinningUniforms {
  boneCount: u32,
  hasNormalization: u32,
  _pad0: u32,
  _pad1: u32,
  normMatrix: mat4x4<f32>,
  invNormMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> skinUniforms: SkinningUniforms;
@group(0) @binding(1) var<storage, read> localPos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> localRot: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> localScale: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> parentIndices: array<i32>;
@group(0) @binding(5) var<storage, read> inverseBindMatrices: array<mat4x4<f32>>;
@group(0) @binding(6) var<storage, read_write> skinMatrices: array<mat4x4<f32>>;

fn buildLocalMatrix(pos: vec4<f32>, rot: vec4<f32>, scale: vec4<f32>) -> mat4x4<f32> {
  let x = rot.x; let y = rot.y; let z = rot.z; let w = rot.w;
  let x2 = x + x; let y2 = y + y; let z2 = z + z;
  let xx = x * x2; let xy = x * y2; let xz = x * z2;
  let yy = y * y2; let yz = y * z2; let zz = z * z2;
  let wx = w * x2; let wy = w * y2; let wz = w * z2;
  let sx = scale.x; let sy = scale.y; let sz = scale.z;
  let px = pos.x; let py = pos.y; let pz = pos.z;

  return mat4x4<f32>(
    vec4<f32>((1.0 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0.0),
    vec4<f32>((xy - wz) * sy, (1.0 - (xx + zz)) * sy, (yz + wx) * sy, 0.0),
    vec4<f32>((xz + wy) * sz, (yz - wx) * sz, (1.0 - (xx + yy)) * sz, 0.0),
    vec4<f32>(px, py, pz, 1.0),
  );
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let boneIdx = gid.x;
  if (boneIdx >= skinUniforms.boneCount) { return; }

  // Build chain from root to this bone by following parent indices upward
  var chain: array<u32, MAX_CHAIN_LEN>;
  var chainLen: u32 = 0u;
  var idx: i32 = i32(boneIdx);
  while (idx >= 0 && chainLen < MAX_CHAIN_LEN) {
    chain[chainLen] = u32(idx);
    chainLen++;
    idx = parentIndices[idx];
  }

  // Accumulate world matrix from root to this bone
  var worldMat = mat4x4<f32>(
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
  );
  for (var c = chainLen; c > 0u; c--) {
    let bi = chain[c - 1u];
    let localMat = buildLocalMatrix(localPos[bi], localRot[bi], localScale[bi]);
    worldMat = worldMat * localMat;
  }

  // Compute skinning matrix: world * inverseBind
  let skinMat = worldMat * inverseBindMatrices[boneIdx];

  // Apply normalization if enabled: N * (world * IBM) * N^-1
  if (skinUniforms.hasNormalization == 1u) {
    skinMatrices[boneIdx] = skinUniforms.normMatrix * (skinMat * skinUniforms.invNormMatrix);
  } else {
    skinMatrices[boneIdx] = skinMat;
  }
}
`;

export const SKINNED_PLAYER_WGSL = /* wgsl */ `
${LIGHTING_FN}
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,${LIGHTING_UNIFORMS}
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var playerSampler: sampler;
@group(0) @binding(2) var playerTexture: texture_2d<f32>;

@group(0) @binding(3) var<storage, read> boneMatrices: array<mat4x4<f32>, ${MAX_BONES}>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
  @location(4) joints: vec4<u32>,
  @location(5) weights: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Skin the vertex position and normal
  let skinMat =
    boneMatrices[input.joints.x] * input.weights.x +
    boneMatrices[input.joints.y] * input.weights.y +
    boneMatrices[input.joints.z] * input.weights.z +
    boneMatrices[input.joints.w] * input.weights.w;

  let skinnedPos = (skinMat * vec4<f32>(input.position, 1.0)).xyz;
  let skinnedNormal = mat3x3<f32>(
    skinMat[0].xyz,
    skinMat[1].xyz,
    skinMat[2].xyz,
  ) * input.normal;

  // Apply entity transform (scale, rotate, translate)
  let scaled = skinnedPos * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, normalize(skinnedNormal)));
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let texColor = textureSample(playerTexture, playerSampler, input.uv);
  var color = entityLighting(N, input.worldPos, texColor.rgb * input.color);
  return vec4<f32>(color, 1.0);
}
`;

export const BOAT_WGSL = /* wgsl */ `
${LIGHTING_FN}
struct BoatUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,${LIGHTING_UNIFORMS}
};

@group(0) @binding(0) var<uniform> uniforms: BoatUniforms;

struct BoatVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) cellColor: vec3<f32>,
};

struct BoatVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: BoatVertexInput) -> BoatVertexOutput {
  var output: BoatVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));
  output.color = input.cellColor;
  return output;
}

@fragment
fn fs_main(input: BoatVertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  var color = entityLighting(N, input.worldPos, input.color);
  return vec4<f32>(color, 1.0);
}
`;

export const ISLAND_WGSL = /* wgsl */ `
${LIGHTING_FN}
struct IslandUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,${LIGHTING_UNIFORMS}
};

@group(0) @binding(0) var<uniform> uniforms: IslandUniforms;

struct IslandVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

struct IslandVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: IslandVertexInput) -> IslandVertexOutput {
  var output: IslandVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));
  output.color = input.color;
  return output;
}

// --- Sand grain sparkle helpers ---
// 3D hash — wraps input to avoid float precision loss with large world positions.
// GPU sin() loses precision above ~10000, so we keep the dot product small.
fn hash23(p: vec3<f32>) -> f32 {
  let q = fract(p / 73.0) * 73.0;
  let h = dot(q, vec3<f32>(127.1, 311.7, 74.7)) +
          dot(q, vec3<f32>(269.5, 183.3, 246.1)) * 0.5 +
          dot(q, vec3<f32>(113.5, 271.9, 124.6)) * 0.25;
  return fract(sin(h) * 43758.5453);
}

// 3-component hash for per-cell jitter (breaks regular grid)
fn hash33(p: vec3<f32>) -> vec3<f32> {
  let q = fract(p / 73.0) * 73.0;
  return fract(sin(vec3<f32>(
    dot(q, vec3<f32>(127.1, 311.7, 74.7)),
    dot(q, vec3<f32>(269.5, 183.3, 246.1)),
    dot(q, vec3<f32>(113.5, 271.9, 124.6)),
  )) * vec3<f32>(43758.5453));
}

// Smooth trilinear-interpolated value noise — hashes 8 lattice corners and interpolates.
// Produces spatially coherent noise that stays stable under camera movement.
fn valueNoise3D(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  let c000 = hash23(i + vec3<f32>(0.0, 0.0, 0.0));
  let c100 = hash23(i + vec3<f32>(1.0, 0.0, 0.0));
  let c010 = hash23(i + vec3<f32>(0.0, 1.0, 0.0));
  let c110 = hash23(i + vec3<f32>(1.0, 1.0, 0.0));
  let c001 = hash23(i + vec3<f32>(0.0, 0.0, 1.0));
  let c101 = hash23(i + vec3<f32>(1.0, 0.0, 1.0));
  let c011 = hash23(i + vec3<f32>(0.0, 1.0, 1.0));
  let c111 = hash23(i + vec3<f32>(1.0, 1.0, 1.0));

  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);

  let y0 = mix(x00, x10, u.y);
  let y1 = mix(x01, x11, u.y);

  return mix(y0, y1, u.z);
}

// Fractal Brownian motion — sums multiple octaves of valueNoise3D for richer texture.
// Uses non-power-of-2 frequency lacunarity (2.3) to break up regular grid patterns.
fn fbm3D(p: vec3<f32>, octaves: u32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var freq = 1.0;
  for (var i = 0u; i < octaves; i++) {
    value += amplitude * valueNoise3D(p * freq);
    freq *= 2.3;
    amplitude *= 0.5;
  }
  return value;
}

// Domain-warped fBm — distorts input coordinates with a low-frequency noise layer
// before sampling, creating irregular organic patterns that avoid uniform repetition.
fn fbm3DWarp(p: vec3<f32>, octaves: u32, warpScale: f32, warpStrength: f32) -> f32 {
  let warp = vec3<f32>(
    valueNoise3D(p * warpScale + vec3<f32>(0.0, 0.0, 0.0)),
    valueNoise3D(p * warpScale + vec3<f32>(11.3, 7.1, 3.7)),
    valueNoise3D(p * warpScale + vec3<f32>(5.9, 13.2, 21.7)),
  );
  return fbm3D(p + (warp - 0.5) * warpStrength, octaves);
}

// Perturb surface normal using gradient of smooth value noise.
// Samples noise at the fragment and at small offsets along tangent/bitangent,
// then tilts the normal based on the height gradient (proper bump mapping).
fn perturbNormal(N: vec3<f32>, worldPos: vec3<f32>, scale: f32, strength: f32) -> vec3<f32> {
  let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(N.y) < 0.99);
  let T = normalize(cross(up, N));
  let B = normalize(cross(N, T));

  let eps = 0.5 / scale;
  let h0 = valueNoise3D(worldPos * scale);
  let hT = valueNoise3D((worldPos + T * eps) * scale);
  let hB = valueNoise3D((worldPos + B * eps) * scale);

  let gradT = (hT - h0) * strength;
  let gradB = (hB - h0) * strength;

  return normalize(N - T * gradT - B * gradB);
}

// Sand grain sparkle using smooth value noise for grain density.
// Multi-octave noise creates coherent bright/dark patches of sand grains,
// with a view-dependent specular glint modulated by the noise pattern.
fn sandSparkle(worldPos: vec3<f32>, N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, sandMask: f32) -> vec3<f32> {
  let H = normalize(V + L);
  let NdotH = max(dot(N, H), 0.0);

  // Smooth grain density — domain-warped for irregular coherent patches
  let grainDensity = fbm3DWarp(worldPos * 40.0, 3u, 8.0, 2.0);

  // Sharp specular glint modulated by grain density (only bright grains glint)
  let glint = pow(NdotH, 120.0) * smoothstep(0.4, 0.7, grainDensity);

  // Broader soft sheen for finer grains
  let sheen = pow(NdotH, 20.0) * 0.15 * grainDensity;

  let sparkle = (glint * 0.6 + sheen) * sandMask;

  // Warm quartz-like tint
  return sparkle * vec3<f32>(1.0, 0.95, 0.85);
}

// PBR island lighting — derives metallic/roughness from vertex color material classification.
// Sand = rough matte with sparkle, vegetation = rough organic, rock = medium rough, shoreline = smooth/wet.
fn islandLighting(N: vec3<f32>, worldPos: vec3<f32>, baseColor: vec3<f32>) -> vec3<f32> {
  let sunDir = normalize(uniforms.sunDirIntensity.xyz);
  let sunIntensity = uniforms.sunDirIntensity.w;
  let ambientLevel = uniforms.ambientParams.x;

  // --- Classify material from vertex color ---
  let r = baseColor.r;
  let g = baseColor.g;
  let b = baseColor.b;

  let sandMask = smoothstep(0.60, 0.70, r);
  let vegMask = smoothstep(0.02, 0.08, g - r) * (1.0 - sandMask);
  let wetMask = (1.0 - sandMask) * (1.0 - vegMask) * smoothstep(0.05, 0.10, r - b);
  let rockMask = (1.0 - sandMask) * (1.0 - vegMask) * (1.0 - wetMask);

  // Wet sand zone — sand near waterline (worldPos.y ≈ 0) transitions to wet
  let wetSandZoneWidth = 0.02;
  let wetSandMask = sandMask * smoothstep(wetSandZoneWidth, 0.0, worldPos.y);

  // PBR material params from classification
  var roughness = mix(0.9, 0.75, sandMask);
  roughness = mix(roughness, 0.85, vegMask);
  roughness = mix(roughness, 0.15, wetMask);
  roughness = mix(roughness, 0.85, rockMask); // dry stone: rougher (less shiny)
  // Wet sand: lower roughness for specular reflection
  roughness = mix(roughness, 0.25, wetSandMask);
  // Rain wetness — stone becomes glossy when wet
  let wetness = uniforms.wetness;
  roughness = mix(roughness, 0.4, wetness * rockMask); // wet stone: glossy but not mirror-like
  // Rain wetness — grass becomes shinier when wet
  roughness = mix(roughness, 0.4, wetness * vegMask);

  var metallic = 0.0;
  metallic = mix(metallic, 0.0, sandMask);
  metallic = mix(metallic, 0.0, vegMask);
  metallic = mix(metallic, 0.1, wetMask); // slight metal for wet specular
  metallic = mix(metallic, 0.0, rockMask);
  metallic = mix(metallic, 0.15, wetSandMask); // wet sand slight metal
  // Rain wetness — slight metallic for wet stone specular
  metallic = mix(metallic, 0.1, wetness * rockMask);
  // Rain wetness — slight metallic for wet grass specular
  metallic = mix(metallic, 0.05, wetness * vegMask);

  // Albedo with wet sand darkening and subtle color variation
  var albedo = baseColor;
  // Wet sand darkening (~45% darker)
  albedo = mix(albedo, albedo * 0.55, wetSandMask);
  // Smooth per-pixel color variation for sand — domain-warped fBm for organic patches
  let sandFine = (fbm3DWarp(worldPos * 10.0, 3u, 2.0, 3.0) - 0.5) * 0.06;
  let sandBroad = (fbm3DWarp(worldPos * 3.0, 2u, 0.8, 4.0) - 0.5) * 0.04;
  albedo = albedo + vec3<f32>(sandFine + sandBroad * 0.8, sandFine * 0.9 + sandBroad * 0.7, sandFine * 0.7 + sandBroad * 0.5) * sandMask;
  // Rain wetness — darken sand slightly when wet
  albedo = mix(albedo, albedo * 0.8, wetness * sandMask);

  // Per-pixel color variation for grass — domain-warped fBm for irregular clumps
  let grassFine = (fbm3DWarp(worldPos * 8.0, 3u, 1.5, 2.5) - 0.5) * 0.10;
  let grassBroad = (fbm3DWarp(worldPos * 2.0, 2u, 0.5, 5.0) - 0.5) * 0.06;
  albedo = albedo + vec3<f32>(grassFine * 0.6, grassFine + grassBroad, grassFine * 0.3) * vegMask;

  // Per-pixel color variation for stone — domain-warped fBm for irregular mottling
  let stoneNoise = (fbm3DWarp(worldPos * 6.0, 3u, 1.2, 3.5) - 0.5) * 0.08;
  albedo = albedo + vec3<f32>(stoneNoise + stoneNoise * 0.3, stoneNoise * 0.9, stoneNoise * 0.7) * rockMask;
  // Rain wetness — darken stone albedo when wet (water film absorbs light)
  albedo = mix(albedo, albedo * 0.6, wetness * rockMask);

  // Perturb normals for sand (fine grain ripples), grass (blade-like bumps), stone (rocky relief)
  let sandN = perturbNormal(N, worldPos, 60.0, 0.08);
  let grassN = perturbNormal(N, worldPos, 80.0, 0.15);
  let stoneN = perturbNormal(N, worldPos, 30.0, 0.2);
  var perturbedN = mix(N, sandN, sandMask);
  perturbedN = mix(perturbedN, grassN, vegMask);
  perturbedN = mix(perturbedN, stoneN, rockMask);

  // Subtle non-uniform roughness for sand/grass/stone specular
  roughness = roughness + (fbm3DWarp(worldPos * 12.0, 2u, 3.0, 2.0) - 0.5) * 0.1 * (sandMask + vegMask + rockMask);

  let V = normalize(uniforms.cameraPos - worldPos);
  let NdotV = max(dot(perturbedN, V), 0.0);
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);

  // Direct lighting (sun)
  let L = sunDir;
  let NdotL = max(dot(perturbedN, L), 0.0);
  let radiance = vec3<f32>(sunIntensity);
  let kD = (1.0 - metallic) * (1.0 / PI);
  let diffuse = albedo * kD * NdotL * radiance;
  let spec = cookTorranceSpecular(perturbedN, V, L, F0, roughness) * NdotL * radiance;
  var color = diffuse + spec;

  // IBL from captured environment
  let R = reflect(-V, perturbedN);
  let irradiance = getIBLDiffuse(perturbedN) * ambientLevel;
  let kD_ibl = (1.0 - metallic) * (1.0 / PI);
  color += albedo * kD_ibl * irradiance;

  let F_ibl = fresnelSchlickRoughness(NdotV, F0, roughness);
  let specIBL = getIBLSpecular(perturbedN, R, roughness) * F_ibl * ambientLevel;
  color += specIBL;

  // Fresnel sky reflection on wet surfaces (shoreline + wet sand)
  let skyTint = mix(vec3<f32>(0.8, 0.85, 0.9), vec3<f32>(0.25, 0.25, 0.30), wetness);
  let fresnel = pow(1.0 - NdotV, 5.0);
  color = mix(color, vec3<f32>(0.3, 0.5, 0.75), fresnel * wetMask * 0.3);
  // Wet sand sky reflection — blend toward sky tint at grazing angles
  color = mix(color, skyTint, fresnel * wetSandMask * 0.4);
  // Rain wetness — Fresnel sky reflection on wet stone
  color = mix(color, skyTint, fresnel * wetness * rockMask * 0.25);

  // Sand grain sparkle — smooth view-dependent glint modulated by grain density
  color += sandSparkle(worldPos, perturbedN, V, L, sandMask * (1.0 - wetSandMask));

  // Dynamic lights (PBR)
  color += applyPBRDynamicLights(perturbedN, worldPos, V, albedo, F0, roughness, metallic);

  let dist = length(uniforms.cameraPos - worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, uniforms.fogColor.xyz, fogFactor);

  return color;
}

@fragment
fn fs_main(input: IslandVertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  var color = islandLighting(N, input.worldPos, input.color);
  return vec4<f32>(color, 1.0);
}
`;

export const ISLAND_WIREFRAME_WGSL = /* wgsl */ `
struct IslandWireframeUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  _pad: f32,
  _pad2: f32,
  _pad3: f32,
  sunDirIntensity: vec4<f32>,
  ambientParams: vec4<f32>,
  fogColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: IslandWireframeUniforms;

struct WireframeVertexInput {
  @location(0) position: vec3<f32>,
};

struct WireframeVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: WireframeVertexInput) -> WireframeVertexOutput {
  var output: WireframeVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  return output;
}

@fragment
fn fs_main(input: WireframeVertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 1.0, 0.2, 1.0);
}
`;

export const ROPE_WGSL = /* wgsl */ `
struct RopeUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
};

@group(0) @binding(0) var<uniform> uniforms: RopeUniforms;

struct RopeVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>,
};

struct RopeVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) vColor: vec3<f32>,
};

@vertex
fn vs_main(input: RopeVertexInput) -> RopeVertexOutput {
  var output: RopeVertexOutput;
  output.clipPos = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  output.vColor = input.color;
  return output;
}

@fragment
fn fs_main(input: RopeVertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.vColor, 1.0);
}
`;

export const HOLO_WGSL = /* wgsl */ `
struct HoloUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,${LIGHTING_UNIFORMS}
};

@group(0) @binding(0) var<uniform> uniforms: HoloUniforms;

struct HoloVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

struct HoloVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: HoloVertexInput) -> HoloVertexOutput {
  var output: HoloVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: HoloVertexOutput) -> @location(0) vec4<f32> {
  // Holographic effect: tint by vertex color, pulsing alpha, fresnel rim
  let pulse = 0.5 + 0.3 * sin(uniforms.time * 4.0);
  let viewDir = normalize(uniforms.cameraPos - input.worldPos);
  let fresnel = pow(1.0 - max(dot(normalize(input.normal), viewDir), 0.0), 2.0);
  let alpha = (0.3 + fresnel * 0.5) * pulse;
  return vec4<f32>(input.color * (0.6 + fresnel * 0.4), alpha);
}
`;

export const HITBOX_WGSL = /* wgsl */ `
struct HitboxUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  halfExtent: vec3<f32>,
  entityRot: vec4<f32>,
  screenSize: vec2<f32>,
  lineWidth: f32,
  hitboxColor: vec3<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: HitboxUniforms;

struct VertexInput {
  @location(0) endpointA: vec3<f32>,
  @location(1) endpointB: vec3<f32>,
  @location(2) cornerVec: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let scaledA = input.endpointA * uniforms.halfExtent * 2.0;
  let scaledB = input.endpointB * uniforms.halfExtent * 2.0;
  let worldA = qrotate(uniforms.entityRot, scaledA) + uniforms.entityPos;
  let worldB = qrotate(uniforms.entityRot, scaledB) + uniforms.entityPos;

  let clipA = uniforms.viewProj * vec4<f32>(worldA, 1.0);
  let clipB = uniforms.viewProj * vec4<f32>(worldB, 1.0);

  let ndcA = clipA.xy / clipA.w;
  let ndcB = clipB.xy / clipB.w;

  let dir = normalize(ndcB - ndcA);
  let perp = vec2<f32>(-dir.y, dir.x);

  let halfWidthNdc = uniforms.lineWidth / uniforms.screenSize.x;
  let offset = perp * input.cornerVec.y * halfWidthNdc;

  let t = input.cornerVec.x;
  let ndcPos = mix(ndcA, ndcB, t) + offset;
  let clipW = mix(clipA.w, clipB.w, t);
  let clipZ = mix(clipA.z, clipB.z, t);

  output.clipPos = vec4<f32>(ndcPos * clipW, clipZ, clipW);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(uniforms.hitboxColor, 1.0);
}
`;

const CELL_COLORS: Record<number, [number, number, number]> = {
  [BoatCellType.HULL]: [0.45, 0.35, 0.25],
  [BoatCellType.BOW]: [0.55, 0.40, 0.28],
  [BoatCellType.CABIN]: [0.60, 0.48, 0.30],
  [BoatCellType.MAST]: [0.35, 0.25, 0.15],
  [BoatCellType.DECK]: [0.50, 0.38, 0.22],
  [BoatCellType.RAIL]: [0.40, 0.30, 0.20],
  [BoatCellType.WALL_STRAIGHT]: [0.50, 0.35, 0.20],
  [BoatCellType.WALL_CORNER]: [0.52, 0.36, 0.21],
  [BoatCellType.WALL_CURVED]: [0.48, 0.34, 0.19],
  [BoatCellType.WALL_DIAGONAL]: [0.51, 0.35, 0.20],
  [BoatCellType.HULL_CURVE_L]: [0.42, 0.32, 0.22],
  [BoatCellType.HULL_CURVE_R]: [0.42, 0.32, 0.22],
  [BoatCellType.BOW_MODERN]: [0.50, 0.38, 0.25],
  [BoatCellType.STERN]: [0.48, 0.36, 0.24],
  [BoatCellType.PONTOON]: [0.35, 0.30, 0.28],
  [BoatCellType.BRIDGE]: [0.50, 0.38, 0.22],
  [BoatCellType.HELM]: [0.55, 0.45, 0.30],
  [BoatCellType.LARGE_SAIL]: [0.85, 0.82, 0.75],
  [BoatCellType.BED]: [0.50, 0.35, 0.25],
};

interface CellInfo {
  type: number;
  rotation: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

// Direction offsets: 0=front(-Z), 1=right(+X), 2=back(+Z), 3=left(-X), 4=up(+Y), 5=down(-Y)
const DIR_OFFSETS: [number, number, number][] = [
  [0, 0, -1], // 0: front (-Z)
  [1, 0, 0],  // 1: right (+X)
  [0, 0, 1],  // 2: back (+Z)
  [-1, 0, 0], // 3: left (-X)
  [0, 1, 0],  // 4: up (+Y)
  [0, -1, 0], // 5: down (-Y)
];

// 2D polygon shape for a cell: vertices in clockwise order (viewed from top)
// plus edge info for neighbor culling (dir=-1 means always render)
interface Shape2D {
  polygon: [number, number][]; // [x, z] world coords, clockwise
  edges: { dir: number; p0: number; p1: number }[];
}

