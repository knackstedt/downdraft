// Highlight composite — add outer glow + inner fill to color.
struct U {
  intensity: f32,
  innerOpacity: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
  _p5: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var blurTex: texture_2d<f32>;
@group(0) @binding(2) var maskTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let color = textureSample(colorTex, samp, uv).rgb;
  let blurred = textureSample(blurTex, samp, uv).rgb;
  let mask = textureSample(maskTex, samp, uv).rgb;

  let outerGlow = blurred * u.intensity;
  let inner = mask * u.innerOpacity;

  return vec4<f32>(color + outerGlow + inner, 1.0);
}
