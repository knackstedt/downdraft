// Deferred lighting pass — fullscreen compute
// Reads G-Buffer and computes final lit color

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var metallicEmissiveTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_2d<f32>;
@group(0) @binding(5) var shadowMapTex: texture_2d<f32>;
@group(0) @binding(6) var shadowSampler: sampler_comparison;

struct LightUniforms {
  dirDirection: vec4<f32>,  // xyz + intensity
  dirColor: vec4<f32>,      // xyz + castShadows
  hemiDirIntensity: vec4<f32>, // xyz + intensity*hasHemisphere
  hemiSkyColor: vec4<f32>,  // xyz + hasHemisphere
  hemiGroundColor: vec4<f32>, // xyz + pad
  ambient: vec4<f32>,       // xyz + intensity
  lightCount: vec4<f32>,    // x = pointCount, y = spotCount
};

@group(0) @binding(7) var<uniform> lights: LightUniforms;

@group(0) @binding(8) var<storage> pointLights: array<vec4<f32>>;

@group(0) @binding(9) var lightViewProj: mat4x4<f32>;

@group(0) @binding(10) var<storage> spotLights: array<vec4<f32>>;

struct OutputResult {
  @location(0) color: vec4<f32>,
};

var<private> fragCoord: vec2<f32>;
var<private> texCoord: vec2<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> (
  @builtin(position) vec4<f32>,
  @location(0) vec2<f32>,
) {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  return (vec4<f32>(pos, 0.0, 1.0), pos * 0.5 + 0.5);
}

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let worldPos = camera.invViewProj * vec4<f32>(ndc, 1.0);
  return worldPos.xyz / worldPos.w;
}

fn pbrBRDF(
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  N: vec3<f32>,
  V: vec3<f32>,
  L: vec3<f32>,
  lightColor: vec3<f32>,
  intensity: f32,
) -> vec3<f32> {
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotH = max(dot(N, H), 0.0);
  let NdotV = max(dot(N, V), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  let F0 = mix(vec3<f32>(0.04, 0.04, 0.04), albedo, metallic);

  // Fresnel (Schlick)
  let fresnel = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);

  // GGX normal distribution
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
  let D = alpha2 / (3.14159265 * denom * denom);

  // Smith geometry (GGX)
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let G1V = NdotV / (NdotV * (1.0 - k) + k);
  let G1L = NdotL / (NdotL * (1.0 - k) + k);
  let G = G1V * G1L;

  let kD = (1.0 - metallic) * (1.0 - fresnel);
  let diffuse = kD * albedo / 3.14159265;
  let specular = (fresnel * D * G) / max(4.0 * NdotV * NdotL, 0.001);

  return (diffuse + specular) * lightColor * intensity * NdotL;
}

fn shadowFactor(worldPos: vec3<f32>) -> f32 {
  if (lights.dirColor.w < 0.5) { return 1.0; }
  let shadowCoord = lightViewProj * vec4<f32>(worldPos, 1.0);
  let shadowUV = shadowCoord.xy / shadowCoord.w * 0.5 + 0.5;
  let shadowDepth = shadowCoord.z / shadowCoord.w;

  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
    return 1.0;
  }

  let bias = 0.001;
  let result = textureSampleCompare(shadowMapTex, shadowSampler, shadowUV, shadowDepth - bias);
  return result;
}

fn hemisphereAmbient(N: vec3<f32>) -> vec3<f32> {
  if (lights.hemiDirIntensity.w < 0.5) {
    return lights.ambient.rgb * lights.ambient.w;
  }
  let up = normalize(lights.hemiDirIntensity.xyz);
  let hemiMix = max(dot(N, up), 0.0);
  return mix(lights.hemiGroundColor.rgb, lights.hemiSkyColor.rgb, hemiMix) * lights.hemiDirIntensity.w;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> OutputResult {
  let albedoAO = textureLoad(albedoTex, vec2<i32>(uv * vec2<f32>(1280.0, 720.0)), 0);
  let normalRough = textureLoad(normalTex, vec2<i32>(uv * vec2<f32>(1280.0, 720.0)), 0);
  let metallicEmissive = textureLoad(metallicEmissiveTex, vec2<i32>(uv * vec2<f32>(1280.0, 720.0)), 0);
  let depth = textureLoad(depthTex, vec2<i32>(uv * vec2<f32>(1280.0, 720.0)), 0).r;

  if (depth >= 1.0) {
    return OutputResult(vec4<f32>(0.0, 0.0, 0.0, 1.0));
  }

  let albedo = albedoAO.rgb;
  let ao = albedoAO.a;
  let N = normalize(normalRough.rgb * 2.0 - 1.0);
  let roughness = normalRough.a;
  let metallic = metallicEmissive.r;
  let emissive = metallicEmissive.gba;

  let worldPos = reconstructWorldPos(uv, depth);
  let V = normalize(camera.cameraPos - worldPos);

  var color = vec3<f32>(0.0);

  // Ambient / hemisphere ambient
  let ambientTerm = hemisphereAmbient(N) * ao;
  color += albedo * ambientTerm;

  // Directional light
  let L = normalize(-lights.dirDirection.xyz);
  let shadow = shadowFactor(worldPos);
  color += pbrBRDF(albedo, metallic, roughness, N, V, L, lights.dirColor.rgb, lights.dirDirection.w) * shadow;

  // Point lights
  let pointCount = u32(lights.lightCount.x);
  for (var i: u32 = 0u; i < 32u; i = i + 1u) {
    if (i >= pointCount) { break; }
    let pos = pointLights[i * 2u].xyz;
    let intensity = pointLights[i * 2u].w;
    let lightColor = pointLights[i * 2u + 1u].xyz;
    let range = pointLights[i * 2u + 1u].w;

    let toLight = pos - worldPos;
    let dist = length(toLight);
    if (dist > range) { continue; }

    let Lp = toLight / dist;
    let attenuation = 1.0 / (1.0 + 0.5 * dist * dist);
    color += pbrBRDF(albedo, metallic, roughness, N, V, Lp, lightColor, intensity) * attenuation;
  }

  // Spot lights (4 vec4s per spot light)
  let spotCount = u32(lights.lightCount.y);
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    if (i >= spotCount) { break; }
    let base = i * 4u;
    let pos = spotLights[base].xyz;
    let intensity = spotLights[base].w;
    let dir = spotLights[base + 1u].xyz;
    let range = spotLights[base + 1u].w;
    let lightColor = spotLights[base + 2u].xyz;
    let innerCos = spotLights[base + 2u].w;
    let outerCos = spotLights[base + 3u].x;
    let toLight = pos - worldPos;
    let dist = length(toLight);
    if (dist > range) { continue; }
    let Lp = toLight / dist;
    let spotCos = dot(-Lp, dir);
    if (spotCos < outerCos) { continue; }
    let spotAtten = smoothstep(outerCos, innerCos, spotCos);
    let attenuation = (1.0 / (1.0 + 0.5 * dist * dist)) * spotAtten;
    color += pbrBRDF(albedo, metallic, roughness, N, V, Lp, lightColor, intensity) * attenuation;
  }

  // Emissive
  color += emissive;

  return OutputResult(vec4<f32>(color, 1.0));
}
