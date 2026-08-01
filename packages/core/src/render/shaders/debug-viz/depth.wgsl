struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) depth: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.depth = output.clipPosition.z / output.clipPosition.w;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let d = input.depth;
  return vec4<f32>(d, d, d, 1.0);
}
