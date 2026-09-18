// Depth material — outputs linearized depth as grayscale
// Forward-rendered

struct DepthUniforms {
  nearPlane: f32,
  farPlane: f32,
};

struct CameraUniforms {
  viewProj: mat4x4<f32>,
};

struct ModelUniforms {
  model: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> depthU: DepthUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<uniform> model: ModelUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) viewDepth: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.viewDepth = output.clipPosition.z / output.clipPosition.w;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let linearDepth = (input.viewDepth - depthU.nearPlane) / (depthU.farPlane - depthU.nearPlane);
  let gray = clamp(linearDepth, 0.0, 1.0);
  return vec4<f32>(gray, gray, gray, 1.0);
}
