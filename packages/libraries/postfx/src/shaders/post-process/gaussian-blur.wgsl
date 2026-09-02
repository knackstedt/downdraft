// Gaussian blur — two-pass separable convolution.
// 9-tap kernel with normalized weights (sum = 1.0) — fixes B1.
struct U {
  texelSize: vec2<f32>,
  dirX: f32,
  dirY: f32,
  radius: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let dir = vec2(u.dirX, u.dirY) * u.texelSize * u.radius;

  // Normalized 9-tap Gaussian: center 0.227027 + 2*(0.1945946+0.1216216+0.054054+0.016216) = 1.0
  var color = textureSample(colorTex, samp, uv) * 0.227027;
  color += textureSample(colorTex, samp, uv + dir * 1.0) * 0.1945946;
  color += textureSample(colorTex, samp, uv - dir * 1.0) * 0.1945946;
  color += textureSample(colorTex, samp, uv + dir * 2.0) * 0.1216216;
  color += textureSample(colorTex, samp, uv - dir * 2.0) * 0.1216216;
  color += textureSample(colorTex, samp, uv + dir * 3.0) * 0.054054;
  color += textureSample(colorTex, samp, uv - dir * 3.0) * 0.054054;
  color += textureSample(colorTex, samp, uv + dir * 4.0) * 0.016216;
  color += textureSample(colorTex, samp, uv - dir * 4.0) * 0.016216;

  return color;
}
