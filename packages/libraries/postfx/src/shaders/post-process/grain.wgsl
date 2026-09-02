// Grain — film grain with optional luminance awareness.
struct U {
  texelSize: vec2<f32>,
  intensity: f32,
  size: f32,
  luminanceAware: f32,
  time: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

fn hash21(p: vec2<f32>) -> f32 {
  let p2 = fract(p * vec2<f32>(443.897, 441.423));
  let p3 = dot(p2, p2 + 19.19);
  return fract(p3);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let color = textureSample(colorTex, samp, input.uv).rgb;
  let grainUV = input.uv * u.size + u.time;
  let grain = hash21(grainUV) - 0.5;
  var amount = u.intensity;
  if (u.luminanceAware > 0.5) {
    let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
    amount *= 1.0 - luma * 0.5;
  }
  return vec4<f32>(color + grain * amount, 1.0);
}
