struct ScreenUniforms {
  screenSize: vec2<f32>,
  _pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> screen: ScreenUniforms;
@group(0) @binding(1) var imageTex: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;

struct ImageVertexInput {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
};

struct ImageVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(input: ImageVertexInput) -> ImageVertexOutput {
  var output: ImageVertexOutput;
  let ndcX = (input.position.x / screen.screenSize.x) * 2.0 - 1.0;
  let ndcY = 1.0 - (input.position.y / screen.screenSize.y) * 2.0;
  output.clipPosition = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: ImageVertexOutput) -> @location(0) vec4<f32> {
  let sampled = textureSample(imageTex, imageSampler, input.uv);
  return sampled * input.color;
}
