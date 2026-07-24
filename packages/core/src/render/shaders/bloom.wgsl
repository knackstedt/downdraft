// Bloom bright-pass + blur shader

struct BloomUniforms {
  threshold: f32,
  softThreshold: f32,
  direction: vec2<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> u: BloomUniforms;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

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

fn softThreshold(luma: f32, threshold: f32, soft: f32) -> f32 {
  let knee = threshold * soft + 0.00001;
  let softFactor = clamp(luma - threshold + knee, 0.0, 2.0 * knee);
  let softFactorSq = softFactor * softFactor / (4.0 * knee + 0.00001);
  return softFactorSq + threshold - knee;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texelSize = u.direction;

  // 13-tap Gaussian blur (separable)
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let offsets = array<f32, 5>(0.0, 1.3846154, 3.2307692, 5.176923, 7.1076923);

  var color = textureSample(sourceTex, texSampler, input.uv).rgb * weights[0];
  for (var i = 1u; i < 5u; i = i + 1u) {
    let offset = u.direction * offsets[i];
    color += textureSample(sourceTex, texSampler, input.uv + offset).rgb * weights[i];
    color += textureSample(sourceTex, texSampler, input.uv - offset).rgb * weights[i];
  }

  // Bright pass on first pass (direction.x > 1.0 means bright pass)
  if (u.direction.x > 1.0) {
    let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
    let contribution = softThreshold(luma, u.threshold, u.softThreshold);
    color *= max(contribution / max(luma, 0.00001), 0.0);
  }

  return vec4<f32>(color, 1.0);
}
