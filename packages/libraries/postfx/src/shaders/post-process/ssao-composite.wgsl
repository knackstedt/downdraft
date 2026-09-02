// SSAO composite — multiply color by AO factor.
struct U {
  texelSize: vec2<f32>,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
  _p5: f32,
  _p6: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var aoTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let color = textureSample(colorTex, samp, input.uv);
  let ao = textureSample(aoTex, samp, input.uv).r;
  return vec4<f32>(color.rgb * ao, color.a);
}
