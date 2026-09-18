// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// White balance — temperature (K) + tint adjustment.
// Applies a white-balance correction by shifting the color temperature
// (warm/cool) and tint (green/magenta).
struct U {
  temperature: f32,   // -1.0 (cool) to 1.0 (warm), 0 = neutral
  tint: f32,          // -1.0 (green) to 1.0 (magenta), 0 = neutral
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
  _p5: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  var color = textureSample(colorTex, samp, uv).rgb;

  // Temperature: shift warm (R+ B-) or cool (R- B+)
  let tempR = 1.0 + u.temperature * 0.1;
  let tempB = 1.0 - u.temperature * 0.1;
  // Tint: shift green (G+) or magenta (G-)
  let tintG = 1.0 - u.tint * 0.1;

  color = color * vec3<f32>(tempR, tintG, tempB);

  // Normalize luminance to avoid overall brightness shift
  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  let origLuma = dot(textureSample(colorTex, samp, uv).rgb, vec3<f32>(0.299, 0.587, 0.114));
  color = color * (origLuma / max(luma, 0.0001));

  return vec4<f32>(color, 1.0);
}
