// ACES tonemap — HDR→LDR bridge with exposure/gamma/contrast/saturation/vignette.
struct U {
  exposure: f32,
  bloomIntensity: f32,
  gamma: f32,
  contrast: f32,
  saturation: f32,
  vignette: f32,
  _p0: f32,
  _p1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

fn acesTonemap(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  var color = textureSample(colorTex, samp, input.uv).rgb;
  let bloom = textureSample(bloomTex, samp, input.uv).rgb;
  color += bloom * u.bloomIntensity;
  color *= u.exposure;
  color = acesTonemap(color);
  color = (color - 0.5) * u.contrast + 0.5;
  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  color = mix(vec3<f32>(luma), color, u.saturation);
  let center = input.uv - 0.5;
  let dist = dot(center, center);
  color *= 1.0 - dist * u.vignette;
  color = pow(color, vec3<f32>(1.0 / u.gamma));
  return vec4<f32>(color, 1.0);
}
