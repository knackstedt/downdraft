// Edges — normal + depth edge detection, composited via alpha blend.
struct U {
  texelSize: vec2<f32>,
  threshold: f32,
  opacity: f32,
  _p0: f32,
  edgeColor: vec3<f32>,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var normalTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> u: U;

fn decodeNormal(rgb: vec3<f32>) -> vec3<f32> {
  return normalize(rgb * 2.0 - 1.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let texel = u.texelSize;
  let color = textureSample(colorTex, samp, uv).rgb;

  let nCenter = decodeNormal(textureSample(normalTex, samp, uv).rgb);
  let nRight  = decodeNormal(textureSample(normalTex, samp, uv + vec2<f32>( 1.0, 0.0) * texel).rgb);
  let nUp     = decodeNormal(textureSample(normalTex, samp, uv + vec2<f32>( 0.0, 1.0) * texel).rgb);

  let dCenter = textureSample(depthTex, samp, uv);
  let dRight  = textureSample(depthTex, samp, uv + vec2<f32>( 1.0, 0.0) * texel);
  let dUp     = textureSample(depthTex, samp, uv + vec2<f32>( 0.0, 1.0) * texel);

  let normalEdge = max(1.0 - dot(nCenter, nRight), 1.0 - dot(nCenter, nUp));
  let depthEdge = max(abs(dCenter - dRight), abs(dCenter - dUp));

  let edge = clamp(max(normalEdge, depthEdge * 100.0) / u.threshold, 0.0, 1.0);
  let edgeColor = u.edgeColor * edge * u.opacity;
  let alpha = edge * u.opacity;
  return vec4<f32>(mix(color, edgeColor, alpha), 1.0);
}
