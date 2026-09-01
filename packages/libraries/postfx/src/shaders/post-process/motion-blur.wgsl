// Motion blur — velocity-based, with depth-aware weighting.
struct U {
  texelSize: vec2<f32>,
  intensity: f32,
  maxSamples: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var velocityTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  // All textureSample calls must be in uniform control flow (before any branching).
  let velocity = textureSample(velocityTex, samp, uv).xy;
  let baseColor = textureSample(colorTex, samp, uv);
  let depth = textureSample(depthTex, samp, uv);
  let speed = length(velocity);

  if (speed < 0.001) { return baseColor; }

  let maxSamples = u32(u.maxSamples);
  let maxSamplesF = u.maxSamples;
  let clampedVelocity = velocity * u.intensity;
  let dims = textureDimensions(depthTex);
  let colorDims = textureDimensions(colorTex);

  var color = vec3<f32>(0.0);
  var totalWeight = 0.0;

  for (var i = 0u; i < 32u; i = i + 1u) {
    if (i >= maxSamples) { break; }
    let t = (f32(i) + 0.5) / maxSamplesF - 0.5;
    let sampleUV = uv + clampedVelocity * t;
    // Use textureLoad (works in non-uniform control flow) instead of textureSample.
    let dcoords = vec2<u32>(clamp(vec2<i32>(i32(sampleUV.x * f32(dims.x)), i32(sampleUV.y * f32(dims.y))), vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1)));
    let sampleDepth = textureLoad(depthTex, dcoords, 0);
    let weight = select(0.1, 1.0, abs(sampleDepth - depth) < 0.1);
    let ccoords = vec2<u32>(clamp(vec2<i32>(i32(sampleUV.x * f32(colorDims.x)), i32(sampleUV.y * f32(colorDims.y))), vec2<i32>(0, 0), vec2<i32>(i32(colorDims.x) - 1, i32(colorDims.y) - 1)));
    color += textureLoad(colorTex, ccoords, 0).rgb * weight;
    totalWeight += weight;
  }

  return vec4<f32>(color / max(totalWeight, 1.0), 1.0);
}
