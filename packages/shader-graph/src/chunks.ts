// ============================================================================
// WGSL Shader Chunk Library
// Reusable WGSL function/struct definitions that can be injected into
// graph-compiled shaders. Extracted from to-the-ocean's EntityRenderer.
// ============================================================================

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
`;

export const PBR_CONST = /* wgsl */ `
const PI: f32 = 3.14159265359;
`;

export const PBR_FUNCTIONS = /* wgsl */ `
${PBR_CONST}

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

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  let ggx2 = geometrySchlickGGX(NdotV, roughness);
  let ggx1 = geometrySchlickGGX(NdotL, roughness);
  return ggx1 * ggx2;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

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
`;

export const PBR_BINDINGS = /* wgsl */ `
@group(2) @binding(0) var brdfLUT: texture_2d<f32>;
@group(2) @binding(1) var brdfSampler: sampler;
`;

export const DYNAMIC_LIGHT_FUNCTIONS = /* wgsl */ `
${LIGHT_STRUCTS}

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

// Full PBR lighting function — Cook-Torrance direct + IBL + dynamic lights + fog.
// Expects a uniform struct with: sunDirIntensity, ambientParams, fogColor, cameraPos, time, entityFlags
export const PBR_LIGHTING_FUNCTION = /* wgsl */ `
${DYNAMIC_LIGHT_FUNCTIONS}
${PBR_FUNCTIONS}
${PBR_BINDINGS}

fn pbrLighting(N: vec3<f32>, worldPos: vec3<f32>, baseColor: vec3<f32>,
               metallic: f32, roughness: f32,
               sunDirIntensity: vec4<f32>, ambientParams: vec4<f32>,
               fogColor: vec4<f32>, cameraPos: vec3<f32>, time: f32,
               entityFlags: u32) -> vec3<f32> {
  let sunDir = normalize(sunDirIntensity.xyz);
  let sunIntensity = sunDirIntensity.w;
  let ambientLevel = ambientParams.x;

  let albedo = baseColor;
  let V = normalize(cameraPos - worldPos);
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

  // IBL — hemisphere ambient + BRDF LUT
  let up = vec3<f32>(0.0, 1.0, 0.0);
  let skyTint = vec3<f32>(0.8, 0.85, 0.9);
  let groundTint = vec3<f32>(0.4, 0.35, 0.3);
  let hemiAmbient = mix(groundTint, skyTint, max(dot(N, up), 0.0));
  let irradiance = hemiAmbient * ambientLevel;
  let kD_ibl = (1.0 - metallic) * (1.0 / PI);
  color += albedo * kD_ibl * irradiance;

  let F_ibl = fresnelSchlickRoughness(NdotV, F0, roughness);
  let brdf = textureSample(brdfLUT, brdfSampler, vec2<f32>(NdotV, roughness)).rg;
  let specIBL = F_ibl * (brdf.x + brdf.y) * irradiance * 0.5;
  color += specIBL;

  // Dynamic lights (PBR)
  color += applyPBRDynamicLights(N, worldPos, V, albedo, F0, roughness, metallic);

  // Bioluminescent emissive
  if ((entityFlags & 512u) != 0u) {
    let pulse = 0.6 + 0.4 * sin(time * 2.0);
    color += vec3<f32>(0.2, 0.8, 1.0) * pulse * 0.5;
  }

  // Fog
  let dist = length(cameraPos - worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, fogColor.xyz, fogFactor);

  return color;
}
`;

// Quaternion rotation helper
export const QROTATE_FN = /* wgsl */ `
fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
`;

// Noise functions for terrain/island shaders
export const NOISE_FUNCTIONS = /* wgsl */ `
fn hash23(p: vec3<f32>) -> f32 {
  let q = fract(p / 73.0) * 73.0;
  let h = dot(q, vec3<f32>(127.1, 311.7, 74.7)) +
          dot(q, vec3<f32>(269.5, 183.3, 246.1)) * 0.5 +
          dot(q, vec3<f32>(113.5, 271.9, 124.6)) * 0.25;
  return fract(sin(h) * 43758.5453);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
  let q = fract(p / 73.0) * 73.0;
  return fract(sin(vec3<f32>(
    dot(q, vec3<f32>(127.1, 311.7, 74.7)),
    dot(q, vec3<f32>(269.5, 183.3, 246.1)),
    dot(q, vec3<f32>(113.5, 271.9, 124.6)),
  )) * vec3<f32>(43758.5453));
}

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

fn fbm3DWarp(p: vec3<f32>, octaves: u32, warpScale: f32, warpStrength: f32) -> f32 {
  let warp = vec3<f32>(
    valueNoise3D(p * warpScale + vec3<f32>(0.0, 0.0, 0.0)),
    valueNoise3D(p * warpScale + vec3<f32>(11.3, 7.1, 3.7)),
    valueNoise3D(p * warpScale + vec3<f32>(5.9, 13.2, 21.7)),
  );
  return fbm3D(p + (warp - 0.5) * warpStrength, octaves);
}
`;

// Chunk registry — maps chunk names to WGSL strings
export const CHUNKS: Record<string, string> = {
  light_structs: LIGHT_STRUCTS,
  pbr_const: PBR_CONST,
  pbr_functions: PBR_FUNCTIONS,
  pbr_bindings: PBR_BINDINGS,
  dynamic_lights: DYNAMIC_LIGHT_FUNCTIONS,
  pbr_lighting: PBR_LIGHTING_FUNCTION,
  qrotate: QROTATE_FN,
  noise: NOISE_FUNCTIONS,
};

export function getChunk(name: string): string {
  const chunk = CHUNKS[name];
  if (!chunk) throw new Error(`Unknown shader chunk: ${name}`);
  return chunk;
}
