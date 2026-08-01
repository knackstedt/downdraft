struct RopeUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
};

@group(0) @binding(0) var<uniform> uniforms: RopeUniforms;

struct RopeVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>,
};

struct RopeVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) vColor: vec3<f32>,
};

@vertex
fn vs_main(input: RopeVertexInput) -> RopeVertexOutput {
  var output: RopeVertexOutput;
  output.clipPos = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  output.vColor = input.color;
  return output;
}

@fragment
fn fs_main(input: RopeVertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.vColor, 1.0);
}
