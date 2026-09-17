// wgsl-validate: prelude ./light-structs.wgsl
// wgsl-validate: prelude ./pbr-functions.wgsl
// wgsl-validate: prelude ./ibl-bindings.wgsl
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
