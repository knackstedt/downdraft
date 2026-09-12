// Acid post-processing effect — a stylized chromatic distortion + color shift.
// The PostProcessStack prepends the fullscreen vertex shader (vs_main + VertexOutput)
// and provides the bindings:
//   binding 0: input color texture (rgba16float)
//   binding 1: dummy texture
//   binding 2: linear sampler
//   binding 3: uniform buffer (32 bytes = 8 floats)
//
// Uniform layout (set by the renderer + Mods panel):
//   offset 0: inv_w (set per-frame by renderer)
//   offset 1: inv_h (set per-frame by renderer)
//   offset 2: intensity (slider 0-3)
//   offset 3: waveScale (slider 1-50)
//   offset 4: hueShift (slider 0-1)
//   offset 5: colorBoost (slider 0-3)
//   offset 6: time (set per-frame by renderer)
//   offset 7: unused
//
// The fragment entry point must be `fs_main(input: VertexOutput)`.

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: array<vec4f, 2>;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let intensity = u[0].z;
  let waveScale = u[0].w;
  let hueShiftAmt = u[1].x;
  let colorBoost = u[1].y;
  let time = u[1].z;

  let uv = input.uv;

  // Wavy distortion — sample the input at offset UVs
  let wave = vec2f(
    sin(uv.y * waveScale + time * 3.0) * 0.005 * intensity,
    cos(uv.x * waveScale + time * 2.0) * 0.005 * intensity,
  );

  // Chromatic aberration via 3 offset samples
  let r = textureSample(colorTex, linearSampler, uv + wave * 1.5).r;
  let g = textureSample(colorTex, linearSampler, uv + wave * 1.0).g;
  let b = textureSample(colorTex, linearSampler, uv + wave * 0.5).b;

  // Acid color shift — push green/blue, reduce red, apply color boost
  let color = vec3f(r * 0.6, g * colorBoost, b * colorBoost);

  // Psychedelic hue cycling
  let hue = sin(time + uv.x * 10.0 + uv.y * 10.0) * hueShiftAmt * intensity;
  let shifted = color + vec3f(
    sin(hue) * 0.2,
    sin(hue + 2.094) * 0.2,
    sin(hue + 4.188) * 0.2,
  );

  return vec4f(shifted, 1.0);
}
