// Toon material — quantized diffuse bands with rim light and optional outline
// Forward-rendered

struct ToonUniforms {
  baseColor: vec4<f32>,
  stepCount: f32,
  stepSmoothness: f32,
  outlineWidth: f32,
  rimColor: vec3<f32>,
  rimPower: f32,
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

@group(0) @binding(0) var<uniform> toon: ToonUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<uniform> model: ModelUniforms;
@group(0) @binding(3) var<uniform> lights: LightUniforms;
@group(0) @binding(4) var albedoMap: texture_2d<f32>;
@group(0) @binding(5) var albedoSampler: sampler;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) viewDir: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.uv = input.uv;
  output.normal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  output.viewDir = normalize(camera.cameraPos - worldPos.xyz);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let L = normalize(-lights.dirDirection.xyz);
  let V = normalize(input.viewDir);

  let NdotL = max(dot(N, L), 0.0);
  let steps = max(toon.stepCount, 1.0);
  let quantized = floor(NdotL * steps) / steps;
  let smoothStep = mix(quantized, smoothstep(0.0, 1.0, NdotL), toon.stepSmoothness);

  let albedo = textureSample(albedoMap, albedoSampler, input.uv).rgb * toon.baseColor.rgb;
  let diffuse = albedo * lights.dirColor.rgb * smoothStep;

  let rim = pow(1.0 - max(dot(N, V), 0.0), toon.rimPower);
  let rimLight = toon.rimColor * rim;

  let ambient = albedo * 0.3;
  return vec4<f32>(ambient + diffuse + rimLight, toon.baseColor.a);
}
