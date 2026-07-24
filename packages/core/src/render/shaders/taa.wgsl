// TAA (Temporal Anti-Aliasing) — uses velocity buffer + history

struct TAAUniforms {
  blendFactor: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: TAAUniforms;
@group(0) @binding(1) var currentTex: texture_2d<f32>;
@group(0) @binding(2) var historyTex: texture_2d<f32>;
@group(0) @binding(3) var velocityTex: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

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

fn clampToNeighborhood(center: vec3<f32>, neighbors: array<vec3<f32>, 8>) -> vec3<f32> {
  let ycocgCenter = rgbToYCoCg(center);
  var minC = ycocgCenter;
  var maxC = ycocgCenter;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let ycocg = rgbToYCoCg(neighbors[i]);
    minC = min(minC, ycocg);
    maxC = max(maxC, ycocg);
  }
  return yCoCgToRGB(clamp(ycocgCenter, minC, maxC));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texelSize = vec2<f32>(1.0 / 1280.0, 1.0 / 720.0);

  let current = textureSample(currentTex, texSampler, input.uv).rgb;

  let velocity = textureSample(velocityTex, texSampler, input.uv).rg;
  let historyUV = input.uv - velocity;

  let history = textureSample(historyTex, texSampler, historyUV).rgb;

  let tl = textureSample(currentTex, texSampler, input.uv + vec2<f32>(-1.0, -1.0) * texelSize).rgb;
  let tr = textureSample(currentTex, texSampler, input.uv + vec2<f32>( 1.0, -1.0) * texelSize).rgb;
  let bl = textureSample(currentTex, texSampler, input.uv + vec2<f32>(-1.0,  1.0) * texelSize).rgb;
  let br = textureSample(currentTex, texSampler, input.uv + vec2<f32>( 1.0,  1.0) * texelSize).rgb;
  let l = textureSample(currentTex, texSampler, input.uv + vec2<f32>(-1.0,  0.0) * texelSize).rgb;
  let r = textureSample(currentTex, texSampler, input.uv + vec2<f32>( 1.0,  0.0) * texelSize).rgb;
  let t = textureSample(currentTex, texSampler, input.uv + vec2<f32>( 0.0, -1.0) * texelSize).rgb;
  let b = textureSample(currentTex, texSampler, input.uv + vec2<f32>( 0.0,  1.0) * texelSize).rgb;

  let neighbors = array<vec3<f32>, 8>(tl, tr, bl, br, l, r, t, b);
  let clampedHistory = clampToNeighborhood(history, neighbors);

  let result = mix(clampedHistory, current, u.blendFactor);
  return vec4<f32>(result, 1.0);
}
