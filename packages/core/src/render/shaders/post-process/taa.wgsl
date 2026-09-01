// TAA — Temporal Anti-Aliasing with YCoCg neighborhood clamp.
struct U {
  texelSize: vec2<f32>,
  blendFactor: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
  _p5: f32,
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
  let uv = input.uv;
  let current = textureSample(colorTex, samp, uv).rgb;
  let velocity = textureSample(velocityTex, samp, uv).rg;
  let historyUV = uv - velocity;
  let history = textureSample(historyTex, samp, historyUV).rgb;

  let tl = textureSample(colorTex, samp, uv + vec2<f32>(-1.0, -1.0) * u.texelSize).rgb;
  let tr = textureSample(colorTex, samp, uv + vec2<f32>( 1.0, -1.0) * u.texelSize).rgb;
  let bl = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  1.0) * u.texelSize).rgb;
  let br = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  1.0) * u.texelSize).rgb;
  let l = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  0.0) * u.texelSize).rgb;
  let r2 = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  0.0) * u.texelSize).rgb;
  let t = textureSample(colorTex, samp, uv + vec2<f32>( 0.0, -1.0) * u.texelSize).rgb;
  let b2 = textureSample(colorTex, samp, uv + vec2<f32>( 0.0,  1.0) * u.texelSize).rgb;

  let ycocgCenter = rgbToYCoCg(current);
  var minC = ycocgCenter;
  var maxC = ycocgCenter;
  let neighbors = array<vec3<f32>, 8>(tl, tr, bl, br, l, r2, t, b2);
  for (var i = 0u; i < 8u; i = i + 1u) {
    let ycocg = rgbToYCoCg(neighbors[i]);
    minC = min(minC, ycocg);
    maxC = max(maxC, ycocg);
  }
  let clampedHistory = yCoCgToRGB(clamp(rgbToYCoCg(history), minC, maxC));
  let result = mix(clampedHistory, current, u.blendFactor);
  return vec4<f32>(result, 1.0);
}
