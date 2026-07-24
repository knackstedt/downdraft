// PBR G-Buffer pass shader
// Writes albedo+AO, normal+roughness, metallic+emissive, velocity

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;
@group(0) @binding(2) var prevModelUniform: mat4x4<f32>;

struct MaterialUniforms {
  baseColor: vec4<f32>,
  roughness: f32,
  metallic: f32,
  emissiveIntensity: f32,
  _pad0: f32,
};

@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(1) @binding(1) var albedoMap: texture_2d<f32>;
@group(1) @binding(2) var albedoSampler: sampler;
@group(1) @binding(3) var normalMap: texture_2d<f32>;
@group(1) @binding(4) var normalSampler: sampler;
@group(1) @binding(5) var metallicRoughnessMap: texture_2d<f32>;
@group(1) @binding(6) var mrSampler: sampler;
@group(1) @binding(7) var aoMap: texture_2d<f32>;
@group(1) @binding(8) var aoSampler: sampler;
@group(1) @binding(9) var emissiveMap: texture_2d<f32>;
@group(1) @binding(10) var emissiveSampler: sampler;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) worldNormal: vec3<f32>,
  @location(3) worldTangent: vec3<f32>,
  @location(4) worldBitangent: vec3<f32>,
  @location(5) prevClipPosition: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.worldPosition = worldPos.xyz;
  output.uv = input.uv;

  let normalMatrix = mat3x3<f32>(
    modelUniform[0].xyz,
    modelUniform[1].xyz,
    modelUniform[2].xyz,
  );
  output.worldNormal = normalize(normalMatrix * input.normal);
  output.worldTangent = normalize(normalMatrix * input.tangent.xyz);
  output.worldBitangent = cross(output.worldNormal, output.worldTangent) * input.tangent.w;

  let prevWorldPos = prevModelUniform * vec4<f32>(input.position, 1.0);
  output.prevClipPosition = camera.prevViewProj * prevWorldPos;

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> (
  @location(0) vec4<f32>,
  @location(1) vec4<f32>,
  @location(2) vec4<f32>,
  @location(3) vec2<f32>,
) {
  let albedo = textureSample(albedoMap, albedoSampler, input.uv) * material.baseColor;
  let mr = textureSample(metallicRoughnessMap, mrSampler, input.uv);
  let metallic = mr.b * material.metallic;
  let roughness = mr.g * material.roughness;
  let ao = textureSample(aoMap, aoSampler, input.uv).r;
  let emissive = textureSample(emissiveMap, emissiveSampler, input.uv).rgb * material.emissiveIntensity;

  // Normal mapping
  let tangentNormal = textureSample(normalMap, normalSampler, input.uv).xyz * 2.0 - 1.0;
  let TBN = mat3x3<f32>(
    input.worldTangent,
    input.worldBitangent,
    input.worldNormal,
  );
  let worldNormal = normalize(TBN * tangentNormal);

  // Encode normal to [0,1] for RGBA8
  let encodedNormal = (worldNormal * 0.5 + 0.5);

  // Velocity: screen-space motion from curr to prev frame
  let currNDC = input.clipPosition.xy / input.clipPosition.w;
  let prevNDC = input.prevClipPosition.xy / input.prevClipPosition.w;
  let velocity = (currNDC - prevNDC) * 0.5;

  // G-Buffer outputs:
  // location(0) = albedo (RGB) + AO (A)
  // location(1) = normal (RGB) + roughness (A)
  // location(2) = metallic (R) + emissive (GBA)
  // location(3) = velocity (RG)
  return (
    vec4<f32>(albedo.rgb, ao),
    vec4<f32>(encodedNormal, roughness),
    vec4<f32>(metallic, emissive.r, emissive.g, emissive.b),
    velocity,
  );
}
