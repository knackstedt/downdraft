// Bloom (soft threshold) — bright pass with soft knee + separable blur.
// When u.dirX > 1.0, performs the bright-pass extraction step.
// Otherwise, performs a directional blur pass.
struct U {
  texelSize: vec2<f32>,
  dirX: f32,
  dirY: f32,
  threshold: f32,
  softThreshold: f32,
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
  let uv = input.uv;
  let dir = vec2<f32>(u.dirX, u.dirY);

  if (u.dirX > 1.0) {
    let c = textureSample(colorTex, samp, uv).rgb;
    let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    let knee = u.threshold * u.softThreshold + 0.00001;
    let softFactor = clamp(luma - u.threshold + knee, 0.0, 2.0 * knee);
    let contribution = softFactor * softFactor / (4.0 * knee + 0.00001) + u.threshold - knee;
    let scale = max(contribution / max(luma, 0.00001), 0.0);
    return vec4<f32>(c * scale, 1.0);
  }

  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let offsets = array<f32, 5>(0.0, 1.3846154, 3.2307692, 5.176923, 7.1076923);
  var color = textureSample(colorTex, samp, uv).rgb * weights[0];
  for (var i = 1u; i < 5u; i = i + 1u) {
    let offset = dir * offsets[i] * u.texelSize;
    color += textureSample(colorTex, samp, uv + offset).rgb * weights[i];
    color += textureSample(colorTex, samp, uv - offset).rgb * weights[i];
  }
  return vec4<f32>(color, 1.0);
}
