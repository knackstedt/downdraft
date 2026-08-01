struct ScreenUniforms {
  screenSize: vec2<f32>,
  _pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> screen: ScreenUniforms;
@group(0) @binding(1) var glyphAtlas: texture_2d<f32>;
@group(0) @binding(2) var glyphSampler: sampler;

struct TextVertexInput {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
};

struct TextVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(input: TextVertexInput) -> TextVertexOutput {
  var output: TextVertexOutput;
  let ndcX = (input.position.x / screen.screenSize.x) * 2.0 - 1.0;
  let ndcY = 1.0 - (input.position.y / screen.screenSize.y) * 2.0;
  output.clipPosition = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: TextVertexOutput) -> @location(0) vec4<f32> {
  let sampled = textureSample(glyphAtlas, glyphSampler, input.uv);
  return vec4<f32>(input.color.rgb, sampled.r * input.color.a);
}
