struct CameraUniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct PointVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) size: f32,
};

struct PointVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointSize: f32,
};

@vertex
fn vs_main(input: PointVertexInput) -> PointVertexOutput {
  var output: PointVertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  output.pointSize = input.size;
  return output;
}

@fragment
fn fs_main(input: PointVertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
