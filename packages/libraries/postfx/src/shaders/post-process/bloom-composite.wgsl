struct U { texelSize: vec2<f32>, strength: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var brightTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let c = textureSample(colorTex, samp, input.uv);
  let b = textureSample(brightTex, samp, input.uv);
  return vec4(c.rgb + b.rgb * u.strength, c.a);
}
