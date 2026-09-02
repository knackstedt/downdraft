// Highlight blur — separable Gaussian blur of the mask.
struct U {
  texelSize: vec2<f32>,
  dirX: f32,
  dirY: f32,
  blurRadius: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var maskTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let offsets = array<f32, 5>(0.0, 1.3846154, 3.2307692, 5.176923, 7.1076923);
  let dir = vec2<f32>(u.dirX, u.dirY) * u.blurRadius * u.texelSize;

  var color = textureSample(maskTex, samp, uv) * weights[0];
  for (var i = 1u; i < 5u; i = i + 1u) {
    let offset = dir * offsets[i];
    color += textureSample(maskTex, samp, uv + offset) * weights[i];
    color += textureSample(maskTex, samp, uv - offset) * weights[i];
  }
  return color;
}
