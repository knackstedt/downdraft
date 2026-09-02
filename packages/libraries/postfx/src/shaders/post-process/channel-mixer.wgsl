// Channel mixer — per-channel R/G/B output weights + monochrome toggle.
// Allows remapping color channels: output.R = wRR*R + wRG*G + wRB*B, etc.
struct U {
  wRR: f32, wRG: f32, wRB: f32,  // red output weights
  wGR: f32, wGG: f32, wGB: f32,  // green output weights
  wBR: f32, wBG: f32, wBB: f32,  // blue output weights
  monochrome: f32,  // 1.0 = output as grayscale
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let c = textureSample(colorTex, samp, uv).rgb;

  var outR = u.wRR * c.r + u.wRG * c.g + u.wRB * c.b;
  var outG = u.wGR * c.r + u.wGG * c.g + u.wGB * c.b;
  var outB = u.wBR * c.r + u.wBG * c.g + u.wBB * c.b;

  if (u.monochrome > 0.5) {
    let luma = outR * 0.299 + outG * 0.587 + outB * 0.114;
    outR = luma; outG = luma; outB = luma;
  }

  return vec4<f32>(vec3<f32>(outR, outG, outB), 1.0);
}
