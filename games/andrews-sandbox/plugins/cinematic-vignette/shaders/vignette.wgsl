// Cinematic vignette + film grain.
struct U {
  inv_w: f32,
  inv_h: f32,
  time: f32,
  intensity: f32,
  radius: f32,
  softness: f32,
  grain: f32,
  _pad: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

fn hash21(p: vec2<f32>) -> f32 {
  let p2 = fract(p * vec2<f32>(443.897, 441.423));
  let p3 = dot(p2, p2 + 19.19);
  return fract(p3);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let center = vec2<f32>(0.5, 0.5);
  let d = uv - center;
  let dist = length(d * vec2<f32>(1.0, 0.75));
  let vignette = 1.0 - smoothstep(u.radius * (1.0 - u.softness), u.radius, dist) * u.intensity;

  var color = textureSample(colorTex, samp, uv).rgb;
  color = color * vignette;

  let grain = (hash21(uv * 1000.0 + u.time) - 0.5) * u.grain;
  color = color + grain;

  return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
