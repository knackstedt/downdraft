struct ScreenUniforms {
  screenSize: vec2<f32>,
  _pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> screen: ScreenUniforms;

struct LineVertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
};

struct LineVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: LineVertexInput) -> LineVertexOutput {
  var output: LineVertexOutput;
  let ndcX = (input.position.x / screen.screenSize.x) * 2.0 - 1.0;
  let ndcY = 1.0 - (input.position.y / screen.screenSize.y) * 2.0;
  output.clipPosition = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: LineVertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
