// Bloom downsample — high-quality 13-tap downsample with optional bright-pass.
// When u.brightPass > 0.5, applies soft-threshold bright extraction (first level).
// Otherwise, performs a plain downsample for subsequent MIP levels.
struct U {
  texelSize: vec2<f32>,   // 1/srcW, 1/srcH (source resolution)
  brightPass: f32,        // 1.0 = extract bright, 0.0 = plain downsample
  threshold: f32,
  softThreshold: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

fn softThreshold(color: vec3<f32>) -> vec3<f32> {
  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  let knee = u.threshold * u.softThreshold + 0.00001;
  let softFactor = clamp(luma - u.threshold + knee, 0.0, 2.0 * knee);
  let contribution = softFactor * softFactor / (4.0 * knee + 0.00001) + u.threshold - knee;
  let scale = max(contribution / max(luma, 0.00001), 0.0);
  return color * scale;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let ts = u.texelSize;

  // 13-tap downsample filter (from UE4 "Next Generation Post Processing" approach).
  // Samples a 3x3 + cross pattern for anti-aliased downsample.
  let a = textureSample(colorTex, samp, uv + vec2<f32>(-1.0, -1.0) * ts).rgb;
  let b = textureSample(colorTex, samp, uv + vec2<f32>( 0.0, -1.0) * ts).rgb;
  let c = textureSample(colorTex, samp, uv + vec2<f32>( 1.0, -1.0) * ts).rgb;
  let d = textureSample(colorTex, samp, uv + vec2<f32>(-0.5, -0.5) * ts).rgb;
  let e = textureSample(colorTex, samp, uv + vec2<f32>( 0.5, -0.5) * ts).rgb;
  let f = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  0.0) * ts).rgb;
  let g = textureSample(colorTex, samp, uv).rgb;
  let h = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  0.0) * ts).rgb;
  let i = textureSample(colorTex, samp, uv + vec2<f32>(-0.5,  0.5) * ts).rgb;
  let j = textureSample(colorTex, samp, uv + vec2<f32>( 0.5,  0.5) * ts).rgb;
  let k = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  1.0) * ts).rgb;
  let l = textureSample(colorTex, samp, uv + vec2<f32>( 0.0,  1.0) * ts).rgb;
  let m = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  1.0) * ts).rgb;

  // Weighted group downsample (2 groups of 6+1 for balanced anti-aliasing)
  let group1 = (a + c + f + h + k + m) * 0.2;
  let group2 = (b + d + e + g + i + j + l) * 0.18;
  var color = group1 + group2 + g * 0.15;

  if (u.brightPass > 0.5) {
    color = softThreshold(color);
  }
  return vec4<f32>(color, 1.0);
}
