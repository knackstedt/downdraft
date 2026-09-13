// Acid post-processing effect — stylized chromatic distortion + hue cycling.
struct U {
  inv_w: f32,
  inv_h: f32,
  time: f32,
  intensity: f32,
  waveScale: f32,
  hueShift: f32,
  colorBoost: f32,
  _pad: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let wave = vec2<f32>(
    sin(uv.y * u.waveScale + u.time * 3.0) * 0.005 * u.intensity,
    cos(uv.x * u.waveScale + u.time * 2.0) * 0.005 * u.intensity,
  );
  let r = textureSample(colorTex, samp, uv + wave * 1.5).r;
  let g = textureSample(colorTex, samp, uv + wave * 1.0).g;
  let b = textureSample(colorTex, samp, uv + wave * 0.5).b;
  let color = vec3<f32>(r * 0.6, g * u.colorBoost, b * u.colorBoost);
  let hue = sin(u.time + uv.x * 10.0 + uv.y * 10.0) * u.hueShift * u.intensity;
  let shifted = color + vec3<f32>(sin(hue) * 0.2, sin(hue + 2.094) * 0.2, sin(hue + 4.188) * 0.2);
  return vec4<f32>(shifted, 1.0);
}
