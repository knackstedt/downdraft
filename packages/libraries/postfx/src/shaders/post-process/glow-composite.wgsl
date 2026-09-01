// Glow composite — add blurred glow to color.
struct U {
  intensity: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
  _p5: f32,
  _p6: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var glowBlurTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(colorTex, samp, input.uv).rgb;
  let glow = textureSample(glowBlurTex, samp, input.uv).rgb;
  return vec4<f32>(color + glow * u.intensity, 1.0);
}
