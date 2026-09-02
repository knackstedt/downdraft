struct U { texelSize: vec2<f32>, dirX: f32, dirY: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let dir = vec2(u.dirX, u.dirY) * u.texelSize;
  var sum = textureSample(colorTex, samp, uv).rgb * 0.227027;
  sum += textureSample(colorTex, samp, uv + dir * 1.0).rgb * 0.1945946;
  sum += textureSample(colorTex, samp, uv - dir * 1.0).rgb * 0.1945946;
  sum += textureSample(colorTex, samp, uv + dir * 2.0).rgb * 0.1216216;
  sum += textureSample(colorTex, samp, uv - dir * 2.0).rgb * 0.1216216;
  sum += textureSample(colorTex, samp, uv + dir * 3.0).rgb * 0.0675676;
  sum += textureSample(colorTex, samp, uv - dir * 3.0).rgb * 0.0675676;
  return vec4(sum, 1.0);
}
