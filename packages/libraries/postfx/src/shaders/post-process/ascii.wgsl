// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
struct U { texelSize: vec2<f32>, cellSize: f32, useColor: f32, screenW: f32, screenH: f32, _p0: f32, _p1: f32, _p2: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var glyphTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
const NUM_GLYPHS = 10.0;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let screen = vec2(u.screenW, u.screenH);
  let cellPx = u.cellSize;
  let cellCoord = floor(input.uv * screen / cellPx);
  let cellCenter = (cellCoord + vec2(0.5)) * cellPx / screen;
  let color = textureSample(colorTex, samp, cellCenter);
  let l = lum(color.rgb);
  let charIdx = clamp(floor(l * (NUM_GLYPHS - 1.0)), 0.0, NUM_GLYPHS - 1.0);
  let local = fract(input.uv * screen / cellPx);
  let glyphUV = vec2((charIdx + local.x) / NUM_GLYPHS, local.y);
  let glyph = textureSample(glyphTex, samp, glyphUV).r;
  let outColor = mix(vec3(0.0, 1.0, 0.0), color.rgb, u.useColor);
  return vec4(outColor * glyph, 1.0);
}
