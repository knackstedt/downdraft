struct Uniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) instancePos: vec3<f32>,
  @location(2) instanceRadius: f32,
  @location(3) instanceColor: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = input.position * input.instanceRadius + input.instancePos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.color = input.instanceColor;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color, 0.4);
}
