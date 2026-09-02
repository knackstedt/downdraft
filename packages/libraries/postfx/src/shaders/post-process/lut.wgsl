// LUT — 3D LUT color grading. Samples a 3D lookup table to apply color grading.
// Replaces the standalone frame-graph LUT3DPass with an in-chain effect.
// Uses a dedicated bind group layout with texture_3d (not the shared ccLayout).
struct U {
  enabled: f32,
  lutSize: f32,
  _p0: f32,
  _p1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var lutTex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  var color = textureSample(colorTex, samp, uv).rgb;

  if (u.enabled > 0.5) {
    let lutSize = u.lutSize;
    // Map [0,1] color to LUT 3D coordinates with proper boundary handling
    let lutCoord = color * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize;
    color = textureSample(lutTex, samp, lutCoord).rgb;
  }
  return vec4<f32>(color, 1.0);
}
