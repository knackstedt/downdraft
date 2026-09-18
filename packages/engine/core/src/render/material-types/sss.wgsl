// SSS material — subsurface scattering approximation with diffuse transmission
// Forward-rendered, wraps PBR with subsurface color and transmittance

struct SSSUniforms {
  baseColor: vec4<f32>,
  subsurfaceColor: vec3<f32>,
  scatterRadius: f32,
  transmittance: f32,
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

@group(0) @binding(0) var<uniform> sss: SSSUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<uniform> model: ModelUniforms;
@group(0) @binding(3) var<uniform> lights: LightUniforms;
@group(0) @binding(4) var albedoMap: texture_2d<f32>;
@group(0) @binding(5) var texSampler: sampler;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) worldPos: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.uv = input.uv;
  output.worldNormal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  output.worldPos = worldPos.xyz;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.worldNormal);
  let V = normalize(camera.cameraPos - input.worldPos);
  let L = normalize(-lights.dirDirection.xyz);

  let albedo = textureSample(albedoMap, texSampler, input.uv).rgb * sss.baseColor.rgb;

  let NdotL = max(dot(N, L), 0.0);
  let diffuse = albedo * lights.dirColor.rgb * NdotL;

  let backLight = max(dot(-N, L), 0.0);
  let transmittanceLight = sss.subsurfaceColor * lights.dirColor.rgb * backLight * sss.transmittance;

  let wrapLight = (dot(N, L) + sss.scatterRadius) / (1.0 + sss.scatterRadius);
  let sssDiffuse = albedo * sss.subsurfaceColor * max(wrapLight, 0.0) * 0.5;

  let ambient = albedo * 0.03;
  let color = ambient + diffuse + transmittanceLight + sssDiffuse;

  return vec4<f32>(color, sss.baseColor.a);
}
