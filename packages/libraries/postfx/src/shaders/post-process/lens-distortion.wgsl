// Lens distortion — barrel/pincushion distortion with optional chromatic split.
// Applies radial distortion: positive = barrel (fisheye), negative = pincushion.
struct U {
  texelSize: vec2<f32>,
  intensity: f32,    // -1.0 (pincushion) to 1.0 (barrel)
  scale: f32,        // zoom to compensate for distortion (1.0 = no zoom)
  chromaSplit: f32,  // chromatic aberration on distortion (0–1)
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let center = vec2<f32>(0.5, 0.5);
  let dir = uv - center;
  let r2 = dot(dir, dir);
  // Barrel/pincushion: r' = r * (1 + k * r^2)
  let distortion = 1.0 + u.intensity * r2;
  var distortedUV = center + dir * distortion * u.scale;

  // Clamp to valid range
  distortedUV = clamp(distortedUV, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));

  if (u.chromaSplit > 0.001) {
    let splitDir = normalize(dir + vec2<f32>(0.0001, 0.0001)) * u.chromaSplit * 0.01;
    let r = textureSample(colorTex, samp, distortedUV + splitDir).r;
    let g = textureSample(colorTex, samp, distortedUV).g;
    let b = textureSample(colorTex, samp, distortedUV - splitDir).b;
    return vec4<f32>(r, g, b, 1.0);
  }

  let color = textureSample(colorTex, samp, distortedUV).rgb;
  return vec4<f32>(color, 1.0);
}
