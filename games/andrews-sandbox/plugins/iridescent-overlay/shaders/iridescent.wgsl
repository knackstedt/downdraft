// Iridescent overlay — screen-space iridescence with hue cycling.
struct U {
  inv_w: f32,
  inv_h: f32,
  time: f32,
  intensity: f32,
  fresnelPower: f32,
  hueSpeed: f32,
  scale: f32,
  _pad: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let i = u32(h * 6.0);
  let f = h * 6.0 - f32(i);
  let p = v * (1.0 - s);
  let q = v * (1.0 - s * f);
  let t = v * (1.0 - s * (1.0 - f));
  if (i == 0u) { return vec3<f32>(v, t, p); }
  if (i == 1u) { return vec3<f32>(q, v, p); }
  if (i == 2u) { return vec3<f32>(p, v, t); }
  if (i == 3u) { return vec3<f32>(p, q, v); }
  if (i == 4u) { return vec3<f32>(t, p, v); }
  return vec3<f32>(v, p, q);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let center = vec2<f32>(0.5, 0.5);
  let d = uv - center;
  let dist = length(d * vec2<f32>(1.0, 0.75));

  // Iridescent hue based on position + time, visible across whole screen.
  let angle = atan2(d.y, d.x);
  let hue = fract(angle / 6.2832 + u.time * u.hueSpeed + dist * u.scale);
  // Brightness falls off from center but is still visible everywhere.
  let falloff = mix(0.3, 1.0, pow(clamp(dist * 2.0, 0.0, 1.0), u.fresnelPower));
  let iridescent = hsv2rgb(hue, 0.85, 1.0) * falloff * u.intensity;

  let base = textureSample(colorTex, samp, uv).rgb;
  // Additive blend for a glowing iridescent sheen.
  return vec4<f32>(clamp(base + iridescent, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
