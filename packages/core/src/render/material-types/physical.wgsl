// Physical material — extends PBR with clearcoat, transmission, sheen, iridescence
// Forward-rendered, Cook-Torrance BRDF + clearcoat layer

struct PhysicalUniforms {
  baseColor: vec4<f32>,
  roughness: f32,
  metallic: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
  transmission: f32,
  ior: f32,
  thickness: f32,
  sheenColor: vec3<f32>,
  sheenRoughness: f32,
  iridescence: f32,
  iridescenceIOR: f32,
  attenuationColor: vec3<f32>,
  attenuationDistance: f32,
  envMapIntensity: f32,
  _pad: f32,
  _pad2: f32,
};

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad: f32,
};

struct ModelUniforms {
  model: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
};

struct LightUniforms {
  dirDirection: vec4<f32>,
  dirColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> mat: PhysicalUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<uniform> model: ModelUniforms;
@group(0) @binding(3) var<uniform> lights: LightUniforms;
@group(0) @binding(4) var albedoMap: texture_2d<f32>;
@group(0) @binding(5) var normalMap: texture_2d<f32>;
@group(0) @binding(6) var clearcoatNormalMap: texture_2d<f32>;
@group(0) @binding(7) var texSampler: sampler;

const PI = 3.14159265359;

fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH = max(dot(N, H), 0.0);
  let NdotH2 = NdotH * NdotH;
  let nom = a2;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return nom / (PI * denom * denom);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  let ggxV = NdotV / (NdotV * (1.0 - k) + k);
  let ggxL = NdotL / (NdotL * (1.0 - k) + k);
  return ggxV * ggxL;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) worldPos: vec3<f32>,
  @location(3) worldTangent: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.uv = input.uv;
  output.worldNormal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  output.worldPos = worldPos.xyz;
  output.worldTangent = normalize((model.normalMatrix * vec4<f32>(input.tangent, 0.0)).xyz);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.worldNormal);
  let V = normalize(camera.cameraPos - input.worldPos);

  let albedo = textureSample(albedoMap, texSampler, input.uv).rgb * mat.baseColor.rgb;
  let F0 = mix(vec3<f32>(0.04), albedo, mat.metallic);

  let L = normalize(-lights.dirDirection.xyz);
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);

  let NDF = distributionGGX(N, H, mat.roughness);
  let G = geometrySmith(N, V, L, mat.roughness);
  let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

  let numerator = NDF * G * F;
  let denominator = 4.0 * max(dot(N, V), 0.0) * NdotL + 0.0001;
  let specular = numerator / denominator;

  let kS = F;
  let kD = (vec3<f32>(1.0) - kS) * (1.0 - mat.metallic);

  let diffuse = kD * albedo / PI;
  var color = (diffuse + specular) * lights.dirColor.rgb * NdotL;

  if (mat.clearcoat > 0.0) {
    let ccN = normalize(textureSample(clearcoatNormalMap, texSampler, input.uv).xyz * 2.0 - 1.0);
    let ccF0 = vec3<f32>(0.04);
    let ccNDF = distributionGGX(ccN, H, mat.clearcoatRoughness);
    let ccG = geometrySmith(ccN, V, L, mat.clearcoatRoughness);
    let ccF = fresnelSchlick(max(dot(H, V), 0.0), ccF0);
    let ccSpec = (ccNDF * ccG * ccF) / (4.0 * max(dot(ccN, V), 0.0) * NdotL + 0.0001);
    color = mix(color, color + ccSpec * lights.dirColor.rgb * NdotL, mat.clearcoat);
  }

  if (mat.sheenRoughness < 1.0) {
    let sheenF = pow(1.0 - max(dot(N, V), 0.0), 5.0) * (1.0 - mat.sheenRoughness);
    color += mat.sheenColor * sheenF * NdotL * 0.3;
  }

  let ambient = albedo * 0.03 * mat.envMapIntensity;
  color += ambient;

  return vec4<f32>(color, mat.baseColor.a);
}
