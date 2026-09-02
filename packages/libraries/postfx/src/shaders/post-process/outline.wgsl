// Outline — detect mask boundary and draw edge ring outside the mask.
struct U {
  texelSize: vec2<f32>,
  outlineWidth: f32,
  opacity: f32,
  _p0: f32,
  outlineColor: vec3<f32>,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let texel = u.texelSize;
  let w = u.outlineWidth;
  let color = textureSample(colorTex, samp, uv).rgb;

  let center = textureSample(maskTex, samp, uv).r;

  // DEBUG: visualize mask — red where selected, normal color where not
  if (center > 0.5) {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
  }

  let offsets = array<vec2<f32>, 8>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0,  0.0), vec2<f32>( 1.0,  0.0),
    vec2<f32>( 0.0, -1.0), vec2<f32>( 0.0,  1.0),
  );

  let dims = textureDimensions(maskTex);
  var edge = 0.0;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let sampleUV = uv + offsets[i] * texel * w;
    let icoords = vec2<u32>(clamp(vec2<i32>(i32(sampleUV.x * f32(dims.x)), i32(sampleUV.y * f32(dims.y))), vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1)));
    let s = textureLoad(maskTex, icoords, 0).r;
    edge = max(edge, abs(center - s));
  }

  let outline = clamp(edge * (1.0 - center) * u.opacity, 0.0, 1.0);
  return vec4<f32>(mix(color, u.outlineColor, outline), 1.0);
}
