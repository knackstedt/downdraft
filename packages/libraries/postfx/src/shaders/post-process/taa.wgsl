// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// TAA — Temporal Anti-Aliasing with YCoCg neighborhood clamp + jitter + variance.
// Upgraded with:
// - Jitter-aware reprojection (sub-pixel jitter offset for better convergence)
// - Optional variance-based clamping (reduces ghosting vs pure min/max clamp)
// - Velocity-based history reprojection (unchanged from original)
struct U {
  texelSize: vec2<f32>,
  blendFactor: f32,
  varianceClamp: f32,  // 1.0 = enable variance clamping, 0.0 = min/max only
  jitterX: f32,        // sub-pixel jitter offset X (in texels)
  jitterY: f32,        // sub-pixel jitter offset Y (in texels)
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var velocityTex: texture_2d<f32>;
@group(0) @binding(2) var historyTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> u: U;

fn rgbToYCoCg(rgb: vec3<f32>) -> vec3<f32> {
  let co = rgb.r - rgb.b;
  let tmp = rgb.b + co * 0.5;
  let cg = rgb.g - tmp;
  let y = tmp + cg * 0.5;
  return vec3<f32>(y, co, cg);
}
fn yCoCgToRGB(ycocg: vec3<f32>) -> vec3<f32> {
  let tmp = ycocg.x - ycocg.z * 0.5;
  let g = ycocg.z + tmp;
  let b = tmp - ycocg.y * 0.5;
  let r = ycocg.y + b;
  return vec3<f32>(r, g, b);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let jitter = vec2<f32>(u.jitterX, u.jitterY) * u.texelSize;
  // Current color — sample at jittered position (the scene was rendered with jitter)
  let current = textureSample(colorTex, samp, uv).rgb;
  let velocity = textureSample(velocityTex, samp, uv).rg;
  // Reproject: history UV accounts for velocity + jitter offset
  let historyUV = uv - velocity - jitter;
  let history = textureSample(historyTex, samp, historyUV).rgb;

  // 3x3 neighborhood for clamping
  let ts = u.texelSize;
  let tl = textureSample(colorTex, samp, uv + vec2<f32>(-1.0, -1.0) * ts).rgb;
  let tr = textureSample(colorTex, samp, uv + vec2<f32>( 1.0, -1.0) * ts).rgb;
  let bl = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  1.0) * ts).rgb;
  let br = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  1.0) * ts).rgb;
  let l = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  0.0) * ts).rgb;
  let r2 = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  0.0) * ts).rgb;
  let t = textureSample(colorTex, samp, uv + vec2<f32>( 0.0, -1.0) * ts).rgb;
  let b2 = textureSample(colorTex, samp, uv + vec2<f32>( 0.0,  1.0) * ts).rgb;

  let ycocgCenter = rgbToYCoCg(current);
  var minC = ycocgCenter;
  var maxC = ycocgCenter;
  var avgC = ycocgCenter;
  let neighbors = array<vec3<f32>, 8>(tl, tr, bl, br, l, r2, t, b2);
  for (var i = 0u; i < 8u; i = i + 1u) {
    let ycocg = rgbToYCoCg(neighbors[i]);
    minC = min(minC, ycocg);
    maxC = max(maxC, ycocg);
    avgC += ycocg;
  }
  avgC = avgC / 9.0;

  var clampedHistory: vec3<f32>;
  if (u.varianceClamp > 0.5) {
    // Variance-based clamping: tighten the clamp box using standard deviation
    var variance = vec3<f32>(0.0);
    for (var i = 0u; i < 8u; i = i + 1u) {
      let d = rgbToYCoCg(neighbors[i]) - avgC;
      variance += d * d;
    }
    variance = variance / 8.0;
    let stdDev = sqrt(variance);
    let tightMin = avgC - stdDev * 1.5;
    let tightMax = avgC + stdDev * 1.5;
    // Use the tighter of min/max and variance-based bounds
    let clampMin = max(minC, tightMin);
    let clampMax = min(maxC, tightMax);
    clampedHistory = yCoCgToRGB(clamp(rgbToYCoCg(history), clampMin, clampMax));
  } else {
    // Standard min/max neighborhood clamp
    clampedHistory = yCoCgToRGB(clamp(rgbToYCoCg(history), minC, maxC));
  }

  let result = mix(clampedHistory, current, u.blendFactor);
  return vec4<f32>(result, 1.0);
}
