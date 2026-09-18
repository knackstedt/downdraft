// Matcap material — sample matcap texture by view-space normal xy
// Forward-rendered, single texture lookup

struct MatcapUniforms {
  baseColor: vec4<f32>,
};

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  view: mat4x4<f32>,
};

struct ModelUniforms {
  model: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> matcap: MatcapUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<uniform> model: ModelUniforms;
@group(0) @binding(3) var matcapMap: texture_2d<f32>;
@group(0) @binding(4) var matcapSampler: sampler;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) viewNormal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  let worldNormal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  output.viewNormal = normalize((camera.view * vec4<f32>(worldNormal, 0.0)).xyz);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let vn = normalize(input.viewNormal);
  let uv = vn.xy * 0.5 + 0.5;
  let matcapColor = textureSample(matcapMap, matcapSampler, uv);
  return matcapColor * matcap.baseColor;
}
