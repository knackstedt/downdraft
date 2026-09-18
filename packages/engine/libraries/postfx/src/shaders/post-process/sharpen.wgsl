// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// Sharpen — unsharp mask (center + (center - blurred) * sharpness).
struct U {
  texelSize: vec2<f32>,
  sharpness: f32,
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
  let texel = u.texelSize;
  let center = textureSample(colorTex, samp, uv).rgb;
  let up    = textureSample(colorTex, samp, uv + vec2<f32>(0.0, -1.0) * texel).rgb;
  let down  = textureSample(colorTex, samp, uv + vec2<f32>(0.0,  1.0) * texel).rgb;
  let left  = textureSample(colorTex, samp, uv + vec2<f32>(-1.0, 0.0) * texel).rgb;
  let right = textureSample(colorTex, samp, uv + vec2<f32>( 1.0, 0.0) * texel).rgb;
  let blurred = (up + down + left + right) * 0.25;
  let result = center + (center - blurred) * u.sharpness;
  return vec4<f32>(result, 1.0);
}
