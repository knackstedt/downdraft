struct CameraUniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct LineVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct LineVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: LineVertexInput) -> LineVertexOutput {
  var output: LineVertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: LineVertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
