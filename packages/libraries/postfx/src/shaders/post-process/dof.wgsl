struct U { texelSize: vec2<f32>, focusDist: f32, focusRange: f32, maxBlur: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let depth = textureSample(depthTex, samp, uv);
  let coc = clamp(abs(depth - u.focusDist) / u.focusRange, 0.0, 1.0);
  let sharp = textureSample(colorTex, samp, uv);
  var color = vec3(0.0);
  let N = 16;
  for (var i = 0; i < N; i++) {
    let a = f32(i) * 6.28318 / f32(N);
    let r = coc * u.maxBlur * (0.5 + 0.5 * sin(a * 3.0));
    let off = vec2(cos(a), sin(a)) * r * u.texelSize;
    color += textureSample(colorTex, samp, uv + off).rgb;
  }
  let blurred = color / f32(N);
  return vec4(select(blurred, sharp.rgb, coc < 0.01), 1.0);
}
