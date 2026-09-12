// Acid post-processing effect — a stylized chromatic distortion + color shift.
// Runs as a full-screen pass with the ccLayout bind group:
//   binding 0: input color texture (rgba16float)
//   binding 1: dummy texture
//   binding 2: linear sampler
//   binding 3: uniform buffer (16 bytes: [inv_w, inv_h, intensity, time])

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: vec4f;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // Full-screen triangle
  let x = f32(vi & 1) * 4.0 - 1.0;
  let y = f32(vi >> 1) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy * vec2f(u.x, u.y);
  let intensity = u.z;
  let time = u.w;

  // Wavy distortion — sample the input at offset UVs
  let wave = vec2f(
    sin(uv.y * 20.0 + time * 3.0) * 0.005 * intensity,
    cos(uv.x * 20.0 + time * 2.0) * 0.005 * intensity,
  );

  // Chromatic aberration via 3 offset samples
  let r = textureSample(colorTex, linearSampler, uv + wave * 1.5).r;
  let g = textureSample(colorTex, linearSampler, uv + wave * 1.0).g;
  let b = textureSample(colorTex, linearSampler, uv + wave * 0.5).b;

  // Acid color shift — push green/blue, reduce red
  let color = vec3f(r * 0.6, g * 1.4, b * 1.2);

  // Psychedelic hue cycling
  let hueShift = sin(time + uv.x * 10.0 + uv.y * 10.0) * 0.3 * intensity;
  let shifted = color + vec3f(
    sin(hueShift) * 0.2,
    sin(hueShift + 2.094) * 0.2,
    sin(hueShift + 4.188) * 0.2,
  );

  return vec4f(shifted, 1.0);
}
