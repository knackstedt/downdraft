// SSAO blur — depth-aware bilateral blur.
struct U {
  texelSize: vec2<f32>,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
  _p5: f32,
};
@group(0) @binding(0) var ssaoTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let centerDepth = textureSample(depthTex, samp, uv);
  var sum = 0.0;
  var weightSum = 0.0;

  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      let offset = vec2<f32>(f32(x), f32(y)) * u.texelSize;
      let sampleDepth = textureSample(depthTex, samp, uv + offset);
      let weight = select(0.0, 1.0, abs(sampleDepth - centerDepth) < 0.1);
      sum += textureSample(ssaoTex, samp, uv + offset).r * weight;
      weightSum += weight;
    }
  }

  let result = sum / max(weightSum, 1.0);
  return vec4<f32>(result, result, result, 1.0);
}
