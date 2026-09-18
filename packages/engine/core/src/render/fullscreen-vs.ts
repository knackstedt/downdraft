// ============================================================================
// Fullscreen triangle vertex shader — shared constant.
// ============================================================================
//
// A single large triangle covering the clip space, with UV output at
// @location(0). Used by fullscreen/post-process render passes that sample a
// texture across the whole screen. Games should import this instead of
// maintaining their own copies.

export const FULLSCREEN_VS = /* wgsl */ `
struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(vi & 1u) * 4.0 - 1.0;
  let y = f32((vi >> 1u) & 1u) * 4.0 - 1.0;
  output.clipPosition = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return output;
}
`;
