// UI blit shader — fullscreen triangle that samples the PixiJS UI texture
// and alpha-blends it over the game frame. The UI texture is premultiplied
// alpha (PixiJS configures alphaMode: "premultiplied"), so the blend is
// src*1 + dst*(1-srcAlpha).

const FULLSCREEN_VS = `
struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  // Fullscreen triangle: covers the clip space with one triangle.
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0),
  );
  var o: VertexOutput;
  o.clipPos = vec4(p[vi], 0.0, 1.0);
  // Flip Y so the UI texture (rendered top-down by PixiJS) maps upright.
  o.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}
`;

const UI_BLIT_FS = `
@group(0) @binding(0) var uiTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(uiTex, samp, input.uv);
}
`;

export const UI_BLIT_WGSL = FULLSCREEN_VS + "\n" + UI_BLIT_FS;
