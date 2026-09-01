// Pixelation — blocky low-res look via nearest-neighbor UV quantization
// + depth edge detection. Samples color and depth at quantized UVs to
// emulate rendering at reduced resolution without a separate low-res target.
struct U {
  texelSize: vec2<f32>,
  pixelSize: f32,
  depthEdgeStrength: f32,
  screenW: f32,
  screenH: f32,
  _p0: f32,
  _p1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let screen = vec2(u.screenW, u.screenH);
  let px = u.pixelSize;
  let cellCoord = floor(input.uv * screen / px);
  let cellCenter = (cellCoord + vec2(0.5)) * px / screen;

  let texel = textureSample(colorTex, samp, cellCenter);
  let depth = textureSample(depthTex, samp, cellCenter);

  let texelStep = px / screen;
  let depthR = textureSample(depthTex, samp, cellCenter + vec2(texelStep.x, 0.0));
  let depthL = textureSample(depthTex, samp, cellCenter - vec2(texelStep.x, 0.0));
  let depthU = textureSample(depthTex, samp, cellCenter + vec2(0.0, texelStep.y));
  let depthD = textureSample(depthTex, samp, cellCenter - vec2(0.0, texelStep.y));

  var diff = 0.0;
  diff += clamp(depthR - depth, 0.0, 1.0);
  diff += clamp(depthL - depth, 0.0, 1.0);
  diff += clamp(depthU - depth, 0.0, 1.0);
  diff += clamp(depthD - depth, 0.0, 1.0);

  let dei = floor(smoothstep(0.01, 0.02, diff) * 2.0) / 2.0;
  let strength = select(1.0, 1.0 - dei * u.depthEdgeStrength, dei > 0.0);

  return vec4(texel.rgb * strength, texel.a);
}
