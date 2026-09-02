// Bloom upsample — 9-tap bilinear-weighted upsample with additive blend + tint.
// Reads a lower-resolution MIP and adds it to the higher-res target with weight.
// Used in the upsample cascade: ⅛ → ¼ → ½ → full.
struct U {
  texelSize: vec2<f32>,   // 1/srcW, 1/srcH (source = lower-res MIP)
  weight: f32,            // blend weight for this MIP level
  _p0: f32,
  tintR: f32,
  tintG: f32,
  tintB: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;  // lower-res MIP
@group(0) @binding(1) var baseTex: texture_2d<f32>;   // higher-res target (for additive read)
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let ts = u.texelSize;

  // 9-tap tent filter for smooth upsample
  let weights = array<f32, 9>(
    0.0625, 0.125, 0.0625,
    0.125,  0.25,  0.125,
    0.0625, 0.125, 0.0625,
  );
  let offsets = array<vec2<f32>, 9>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 0.0, -1.0), vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  0.0), vec2<f32>( 0.0,  0.0), vec2<f32>( 1.0,  0.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 0.0,  1.0), vec2<f32>( 1.0,  1.0),
  );

  var upsampled = vec3<f32>(0.0);
  for (var i = 0u; i < 9u; i = i + 1u) {
    upsampled += textureSample(colorTex, samp, uv + offsets[i] * ts).rgb * weights[i];
  }

  // Apply tint + weight
  let tint = vec3<f32>(u.tintR, u.tintG, u.tintB);
  let bloom = upsampled * tint * u.weight;

  // Additive blend with base (higher-res MIP or original scene)
  let base = textureSample(baseTex, samp, uv).rgb;
  return vec4<f32>(base + bloom, 1.0);
}
